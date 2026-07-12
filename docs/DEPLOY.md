# デプロイ手順（会議招集の前に）

> 旧称の履歴: 社内版「会議関所」／公開版「会議ルーター」を、現在は「会議招集の前に」に統一しています（同一アプリ）。

「会議招集の前に」は、単一の静的ページ（`index.html`）と、AIアシスト用のステートレスAPI（`server/router-api.mjs`）で構成されます。サーバーは npm 依存ゼロ・Node 標準ライブラリのみで動作し、**ユーザー本文を保存・記録しない（ゼロリテンション）** 設計です。

このドキュメントは、人間の運用担当者がそのままデプロイできることを目的としています。

---

## 1. 構成

- `index.html` — アプリ本体（HTML/CSS/JS、依存なし）。データはブラウザの localStorage に保存。
- `privacy.html` — プライバシー方針（ゼロリテンションの説明）。
- `server/router-api.mjs` — AIアシストAPI ＋ 静的配信。
  - `GET /` → `index.html`
  - `GET /privacy` → `privacy.html`
  - `GET /healthz` → `{ ok: true, mock: <bool> }`
  - `POST /api/v1/<route>` → AIアシスト（R1〜R7）

サーバーは静的配信も兼ねるため、これ1つを起動すればアプリとAPIの両方が提供されます。

---

## 2. ローカル起動

### 2-1. モックで起動（APIキー不要・外部送信なし）

動作確認や開発時は `MOCK_LLM=1` を使います。外部AIには一切送信せず、決定的なモック応答を返します。

```sh
MOCK_LLM=1 PORT=8787 node server/router-api.mjs
```

- ブラウザで `http://localhost:8787/` を開くとアプリが表示されます。
- `http://localhost:8787/privacy` でプライバシー方針を表示。
- `curl http://localhost:8787/healthz` で `{"ok":true,"mock":true}` を確認。

### 2-2. 実キーで起動（Claude API を利用）

```sh
ANTHROPIC_API_KEY=sk-ant-... PORT=8787 DAILY_LIMIT=1000 node server/router-api.mjs
```

- `MOCK_LLM` を設定しない（または `MOCK_LLM=0`）と実APIを呼びます。
- `ANTHROPIC_API_KEY` が未設定かつモックでもない場合、AIアシストは `503 llm_unavailable` を返します（静的配信は動作します）。

---

## 3. Docker build & run

### build

```sh
docker build -t meeting-router:latest .
```

### run（モック）

```sh
docker run --rm -p 8787:8787 -e MOCK_LLM=1 meeting-router:latest
```

### run（実キー）

```sh
docker run --rm -p 8787:8787 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e DAILY_LIMIT=1000 \
  meeting-router:latest
```

`http://localhost:8787/` にアクセスして動作を確認します。

---

## 4. 環境変数一覧

| 変数 | 既定 | 意味 |
|------|------|------|
| `ANTHROPIC_API_KEY` | （空） | Claude API キー。未設定かつ非モックだと AI アシストは 503。 |
| `PORT` | `8787` | 待受ポート。 |
| `DAILY_LIMIT` | `1000` | 1日あたりの LLM 呼び出し上限。超過で `503 daily_limit`。 |
| `MOCK_LLM` | （空） | `1` で外部送信せず決定的モック応答（キー不要）。 |

その他、サーバー内蔵の固定的な保護:

- リクエストボディ上限 32KB（超過で `413`）。
- IP あたり 30 リクエスト/分のレート制限（超過で `429`）。
- CORS は `*`（プリフライト `OPTIONS` は 204）。

---

## 5. コスト管理

AIアシストはエンドポイントごとにモデルを使い分けています。

| 用途 | モデル | 考え方 |
|------|--------|--------|
| 軽い分類・添削・具体化（R1〜R3） | `claude-haiku-4-5` | 短く高頻度な処理は安価な Haiku で。 |
| 要約・A3圧縮・なぜなぜ・診断（R4〜R7） | `claude-sonnet-5` | 構造化・要約の品質が要る処理は Sonnet で。 |

コストを抑える運用:

- `DAILY_LIMIT` を組織の想定利用量に合わせて設定し、暴走課金を防ぐ。
- まずは `MOCK_LLM=1` で UI とフローを検証し、実キーは本番のみで使う。
- レート制限（30 req/min/IP）はそのまま乱用抑止として機能します。

---

## 6. ゼロリテンションの運用注意

サーバーは設計上、ユーザー本文をどこにも保存しません。運用で崩さないための注意:

- **アプリのログには本文を出さない。** サーバーのログはメタデータ（日時・エンドポイント・ステータス・入力文字数・処理時間）のみで、入力本文・AI応答本文は出力しません。この方針を変更しないでください。
- **リバースプロキシのアクセスログに本文を残さない。** nginx などを前段に置く場合、リクエストボディをログに書き出す設定（`echo`/`lua` 等でのボディロギング）を有効にしないでください。標準のアクセスログはメソッド・パス・ステータス程度に留めます。
- **HTTPS を終端する。** 公開時は前段でTLSを終端し、APIキーや本文が平文で流れないようにします。
- **APIキーは環境変数で注入する。** イメージやリポジトリにキーを焼き込まないでください。
- **データの保管場所はブラウザのみ。** ユーザーの作業データは各自のブラウザ localStorage にあります。サーバー移行・再起動でユーザーデータは失われません（そもそも持っていないため）。

---

## 7. 動作確認チェックリスト

```sh
# 1. モック起動
MOCK_LLM=1 PORT=8787 node server/router-api.mjs &

# 2. 静的配信
curl -s http://localhost:8787/          | head -1   # index.html
curl -s http://localhost:8787/privacy   | head -1   # privacy.html
curl -s http://localhost:8787/healthz               # {"ok":true,"mock":true}

# 3. AIアシスト（モック）
curl -s -X POST http://localhost:8787/api/v1/route \
  -H 'Content-Type: application/json' \
  -d '{"input":"来週の方針を相談したい"}'

# 4. 後片付け（必ず停止）
kill %1
```
