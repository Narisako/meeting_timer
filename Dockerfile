# 会議ルーター（Meeting Router）— 公開Webサービス用イメージ
# npm 依存ゼロ。Node 標準ライブラリのみで動作する。
# ゼロリテンション: サーバーはユーザー本文を保存・記録しない（docs/DEPLOY.md 参照）。
FROM node:22-slim

# 非rootユーザーで実行（node:22-slim に同梱の node ユーザーを利用）
WORKDIR /app

# アプリ本体（サーバー）と静的ファイルのみをコピーする。
COPY server/ ./server/
COPY index.html ./index.html
COPY privacy.html ./privacy.html

# 環境変数（実行時に上書き可能）
#   ANTHROPIC_API_KEY : Claude API キー（未設定かつ MOCK_LLM 無効なら AI アシストは 503 を返す）
#   PORT              : 待受ポート（既定 8787）
#   DAILY_LIMIT       : 1日あたりの LLM 呼び出し上限（既定 1000）
#   MOCK_LLM          : "1" で外部送信せず決定的モック応答
ENV PORT=8787 \
    DAILY_LIMIT=1000

EXPOSE 8787

USER node

CMD ["node", "server/router-api.mjs"]
