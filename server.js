import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import admin from 'firebase-admin';
import { createRequire } from 'module';
import 'dotenv/config';

const require = createRequire(import.meta.url);
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
if (serviceAccount.private_key) {
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
}

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json());

// ── Firebase Admin ──
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

// ── Anthropic クライアント ──
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── モデル設定 (API料金 × 1.22) ──
const MODEL_CONFIG = {
  'claude-sonnet-4-6': { provider: 'anthropic', apiModel: 'claude-sonnet-4-6', inputPer1M: 3.66,  outputPer1M: 18.30 },
  'claude-opus-4-6':   { provider: 'anthropic', apiModel: 'claude-opus-4-6',             inputPer1M: 18.36, outputPer1M: 91.68 },
  // GPT・Geminiは追加APIキー取得後に有効化
  // 'gpt-5':          { provider: 'openai',    apiModel: 'gpt-4o',           inputPer1M: 24.40, outputPer1M: 97.60 },
  // 'gpt-4-1':        { provider: 'openai',    apiModel: 'gpt-4-turbo',      inputPer1M: 2.44,  outputPer1M: 9.76  },
  // 'gemini-3-2':     { provider: 'google',    apiModel: 'gemini-1.5-pro',   inputPer1M: 1.95,  outputPer1M: 7.80  },
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

  // SSE ヘッダー
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  let inputTokens  = 0;
  let outputTokens = 0;

  try {
    // ── Anthropic (Claude) ──
    if (cfg.provider === 'anthropic') {
      const stream = await anthropic.messages.stream({
        model:      cfg.apiModel,
        max_tokens: 4096,
        messages:   messages.map(m => ({ role: m.role, content: m.content })),
      });

      // 文字が来るたびにクライアントへ送信
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          sseWrite(res, { type: 'delta', text: event.delta.text });
        }
      }

      // 会話終了後に実際のトークン数を取得
      const finalMsg = await stream.finalMessage();
      inputTokens  = finalMsg.usage.input_tokens;
      outputTokens = finalMsg.usage.output_tokens;
    }

    // ── コスト計算・Firestore保存 ──

    const costUSD = calcCost(modelId, inputTokens, outputTokens);
    try {
      await recordUsage(req.uid, modelId, inputTokens, outputTokens, costUSD);
      console.log('✅ Firestore記録成功');
    } catch (fsErr) {
      console.error('⚠️ Firestore記録失敗（チャットは継続）:', fsErr.message);
    }
    sseWrite(res, { type: 'done', inputTokens, outputTokens, costUSD });
    //const costUSD = calcCost(modelId, inputTokens, outputTokens);
    //await recordUsage(req.uid, modelId, inputTokens, outputTokens, costUSD);

    // 会話終了イベント: 実トークン数とコストをフロントへ送信
    //sseWrite(res, { type: 'done', inputTokens, outputTokens, costUSD });

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
    res.status(500).json({ error: err.message });
  }
});

// ── 起動 ──
app.listen(PORT, () => {
  console.log(`✅ AI SIM backend listening on http://localhost:${PORT}`);
});
