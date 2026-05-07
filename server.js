import { readFileSync } from 'fs';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import admin from 'firebase-admin';
import 'dotenv/config';

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://simai-f8efb.web.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use(express.json());

// ── ServiceAccount & Firebase Admin ──
let projectId, clientEmail, privateKey;
try {
  const raw = readFileSync('/etc/secrets/serviceAccount.json', 'utf8');
  const parsed = JSON.parse(raw);
  projectId   = parsed.project_id;
  clientEmail = parsed.client_email;
  privateKey  = parsed.private_key.replace(/\\n/g, '\n');
  console.log('✅ ServiceAccount 読み込み成功 project_id:', projectId);
  console.log('🔍 privateKey先頭:', privateKey.substring(0, 40));
} catch (e) {
  console.error('❌ ServiceAccount 読み込み失敗:', e.message);
  process.exit(1); // 失敗したら起動しない
}

admin.initializeApp({
  credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
  projectId,
});
const db = admin.firestore();
console.log('✅ Firebase Admin 初期化成功');

// ── Firestore接続テスト（起動2秒後）──
setTimeout(async () => {
  try {
    const token = await admin.credential.cert({ projectId, clientEmail, privateKey }).getAccessToken();
    console.log('✅ アクセストークン取得成功:', token.access_token.substring(0, 30) + '...');
  } catch (e) {
    console.error('❌ アクセストークン取得失敗:', e.message);
  }

  try {
    await db.collection('_health').limit(1).get();
    console.log('✅ Firestore接続テスト成功');
  } catch (e) {
    console.error('❌ Firestore接続テスト失敗 code:', e.code);
    console.error('❌ Firestore接続テスト失敗 message:', e.message.substring(0, 150));
  }
}, 2000);

// ── Anthropic ──
console.log('🔍 ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? '✅ あり' : '❌ なし');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── モデル設定 (API料金 × 1.22) ──
const MODEL_CONFIG = {
  'claude-sonnet-4-6': { provider: 'anthropic', apiModel: 'claude-sonnet-4-6', inputPer1M: 3.66,  outputPer1M: 18.30 },
  'claude-opus-4-6':   { provider: 'anthropic', apiModel: 'claude-opus-4-6',   inputPer1M: 18.36, outputPer1M: 91.68 },
};

// ── Firebase ID トークン検証 ──
async function verifyAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: '認証トークンがありません' });
  }
  try {
    const decoded = await admin.auth().verifyIdToken(auth.split('Bearer ')[1]);
    req.uid   = decoded.uid;
    req.email = decoded.email;
    next();
  } catch {
    res.status(401).json({ error: '認証トークンが無効です' });
  }
}

// ── コスト計算 ──
function calcCost(modelId, inputTokens, outputTokens) {
  const cfg = MODEL_CONFIG[modelId];
  return (inputTokens / 1e6) * cfg.inputPer1M + (outputTokens / 1e6) * cfg.outputPer1M;
}

// ── Firestore に使用量を記録 ──
async function recordUsage(uid, modelId, inputTokens, outputTokens, costUSD) {
  const now      = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ref      = db.collection('users').doc(uid);

  await db.runTransaction(async t => {
    const data    = (await t.get(ref)).data() || {};
    const monthly = data.monthly || {};
    const m       = monthly[monthKey] || { inputTokens: 0, outputTokens: 0, costUSD: 0 };
    t.set(ref, {
      monthly: {
        ...monthly,
        [monthKey]: {
          inputTokens:  m.inputTokens  + inputTokens,
          outputTokens: m.outputTokens + outputTokens,
          costUSD:      m.costUSD      + costUSD,
        },
      },
      updatedAt: now.toISOString(),
    }, { merge: true });
  });

  await db.collection('usage_logs').add({
    uid, modelId, inputTokens, outputTokens, costUSD,
    createdAt: now.toISOString(),
    monthKey,
  });
}

// ── SSE 書き込みヘルパー ──
function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ══════════════════════════════════════════════════════
//  POST /api/chat  — ストリーミングチャット
// ══════════════════════════════════════════════════════
app.post('/api/chat', verifyAuth, async (req, res) => {
  const { messages, model: modelId } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messagesが必要です' });
  }
  const cfg = MODEL_CONFIG[modelId];
  if (!cfg) {
    return res.status(400).json({ error: `未対応のモデル: ${modelId}` });
  }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  let inputTokens  = 0;
  let outputTokens = 0;

  try {
    if (cfg.provider === 'anthropic') {
      const stream = await anthropic.messages.stream({
        model:      cfg.apiModel,
        max_tokens: 4096,
        messages:   messages.map(m => ({ role: m.role, content: m.content })),
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          sseWrite(res, { type: 'delta', text: event.delta.text });
        }
      }

      const finalMsg = await stream.finalMessage();
      inputTokens  = finalMsg.usage.input_tokens;
      outputTokens = finalMsg.usage.output_tokens;
    }

    const costUSD = calcCost(modelId, inputTokens, outputTokens);

    // Firestore記録（失敗してもチャットは継続）
    try {
      await recordUsage(req.uid, modelId, inputTokens, outputTokens, costUSD);
      console.log('✅ Firestore記録成功 uid:', req.uid);
    } catch (fsErr) {
      console.error('⚠️ Firestore記録失敗（チャットは継続）:', fsErr.message);
    }

    sseWrite(res, { type: 'done', inputTokens, outputTokens, costUSD });

  } catch (err) {
    console.error('[/api/chat error]', err.message);
    sseWrite(res, { type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

// ══════════════════════════════════════════════════════
//  GET /api/usage  — 月次利用額取得
// ══════════════════════════════════════════════════════
app.get('/api/usage', verifyAuth, async (req, res) => {
  try {
    const snap = await db.collection('users').doc(req.uid).get();
    res.json({ monthly: snap.exists ? snap.data().monthly || {} : {} });
  } catch (err) {
    console.error('[/api/usage error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── 起動 ──
app.listen(PORT, () => {
  console.log(`✅ AI SIM backend listening on http://localhost:${PORT}`);
});
