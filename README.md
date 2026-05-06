# AI SIM バックエンド

Node.js + Express によるストリーミング対応AIプロキシサーバー

## ディレクトリ構成

```
ai-sim-backend/
├── server.js          ← メインサーバー
├── package.json
├── .env               ← 自分で作成 (下記参照)
├── .env.example       ← 環境変数のテンプレート
└── frontend_patch.js  ← フロントに貼るコード (解説用)
```

## セットアップ手順

### 1. 依存パッケージをインストール
```bash
cd ai-sim-backend
npm install
```

### 2. .env を作成
```bash
cp .env.example .env
```
`.env` を開いて各APIキーを記入する。

### 3. Firebase サービスアカウントキーを取得
1. Firebaseコンソール → ⚙️プロジェクトの設定
2. 「サービスアカウント」タブ
3. 「新しい秘密鍵を生成」→ JSONをダウンロード
4. そのJSONの中身を丸ごと `FIREBASE_SERVICE_ACCOUNT_JSON=` に貼る

### 4. 起動
```bash
npm run dev    # 開発 (ファイル変更で自動再起動)
npm start      # 本番
```

## フロントエンドの変更点

`ai_sim_chat.html` の `<script>` 内で以下を変更:

### (A) Firebase初期化を追加
ランディングページと同じ Firebase 初期化コードをscriptタグに追加。

### (B) callAPI 関数を置き換え
`frontend_patch.js` の `callAPI` 関数で既存の関数を丸ごと置き換え。

### (C) sendMessage 内のループを置き換え
```js
// 変更前: 既存のfor awaitループ
for await (const chunk of response) { ... }

// 変更後:
await sendMessageLoop(response, bubbleEl, msgEl, currentModel);
```

## API エンドポイント

| エンドポイント | 説明 |
|---|---|
| `POST /api/chat` | ストリーミングチャット (SSE) |
| `GET /api/usage` | 月次トークン使用量・料金 |

## Firestoreのデータ構造

```
users/{uid}
  monthly:
    "2025-05":
      inputTokens: 12345
      outputTokens: 45678
      costUSD: 0.892

usage_logs/{auto-id}
  uid, modelId, inputTokens, outputTokens, costUSD, createdAt, monthKey
```

## 本番デプロイ (Railway / Render など)

1. GitHubにpush
2. RailwayやRenderでリポジトリを接続
3. 環境変数を設定画面から追加
4. フロントの `API_BASE` を本番URLに変更して `firebase deploy`
