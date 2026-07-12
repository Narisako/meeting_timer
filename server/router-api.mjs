// 会議ルーター ステートレスAPIバックエンド骨格 (v3-2 / Issue #14)
// - Node 18+ 標準ライブラリ + 組み込み fetch のみ。npm 依存ゼロ。
// - ゼロリテンション: DB・ファイル書き込み一切なし。ログはメタデータのみ（入力本文・LLM応答本文は出さない）。
// - LLMアシスト専用。MOCK_LLM=1 で決定的モック、ANTHROPIC_API_KEY で Claude API。
// - 静的配信: GET / → index.html、GET /privacy → privacy.html（ゼロリテンション方針は不変。本文は保持・記録しない）。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// リポジトリルート（server/ の一つ上）。静的ファイルはここから配信する。
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PORT = Number(process.env.PORT || 8787);
const MOCK = process.env.MOCK_LLM === '1';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 1000);

const MAX_BODY = 32 * 1024;         // 32KB
const RATE_PER_MIN = 30;            // IPごと 30req/分
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const HAIKU = 'claude-haiku-4-5';
const SONNET = 'claude-sonnet-5';

// ---- エンドポイント定義 (path -> {model, maxTokens, system, mock, validate}) ----
const ROUTES = {
  // R1 報連相仕分け
  'route': {
    model: HAIKU, maxTokens: 512,
    system: 'あなたは日本の職場の「報連相」仕分け係です。入力メッセージを report(報告)/chat(相談・雑談)/meeting(要会議) のいずれかに分類し、理由と整形済み本文を返します。必ず次のJSONのみを出力: {"kind":"report|chat|meeting","reason":"日本語の短い理由","formatted":"整形済み本文"}',
    mock(input) {
      let kind = 'report';
      if (/[?？]|相談|どう思|意見/.test(input)) kind = 'chat';
      if (/会議|議題|打ち合わせ|ミーティング|集まって/.test(input)) kind = 'meeting';
      return {
        kind,
        reason: `キーワードから ${kind} と判定しました（${input.length}字）`,
        formatted: input.trim()
      };
    },
    validate(r) {
      return r && ['report', 'chat', 'meeting'].includes(r.kind) &&
        typeof r.reason === 'string' && typeof r.formatted === 'string';
    }
  },
  // R2 議題添削
  'refine-agenda': {
    model: HAIKU, maxTokens: 512,
    system: 'あなたは会議の議題を添削する専門家です。曖昧な議題を「問い」の形に磨き、達成ゴールと一言コメントを返します。必ず次のJSONのみを出力: {"question":"問いの形にした議題","goal":"この議題で決めるべきゴール","comment":"改善の一言"}',
    mock(input) {
      const t = input.trim();
      return {
        question: /[?？]$/.test(t) ? t : `${t} をどうするか？`,
        goal: `${t} について次の一手を決める`,
        comment: '「決める問い」に言い換えると議論が締まります'
      };
    },
    validate(r) {
      return r && typeof r.question === 'string' &&
        typeof r.goal === 'string' && typeof r.comment === 'string';
    }
  },
  // R3 曖昧アクション具体化
  'concretize-action': {
    model: HAIKU, maxTokens: 768,
    system: 'あなたは曖昧なアクションを「誰が・何を・いつまで」に具体化する係です。入力から候補を抽出し配列で返します。必ず次のJSONのみを出力: {"candidates":[{"what":"具体的な作業","ownerHint":"担当の目安","dueHint":"期限の目安"}]}',
    mock(input) {
      const lines = input.split(/[\n、。]/).map(s => s.trim()).filter(Boolean).slice(0, 3);
      const src = lines.length ? lines : [input.trim()];
      return {
        candidates: src.map(s => ({
          what: s,
          ownerHint: '担当者を指名',
          dueHint: '次回会議まで'
        }))
      };
    },
    validate(r) {
      return r && Array.isArray(r.candidates) && r.candidates.every(c =>
        c && typeof c.what === 'string' &&
        typeof c.ownerHint === 'string' && typeof c.dueHint === 'string');
    }
  },
  // R4 3行要約
  'summarize-handoff': {
    model: SONNET, maxTokens: 512,
    system: 'あなたは引き継ぎ要約の専門家です。入力を3行以内の要約にまとめます。必ず次のJSONのみを出力: {"summary":"3行以内の要約（改行区切り）"}',
    mock(input) {
      const t = input.replace(/\s+/g, ' ').trim();
      const head = t.slice(0, 40);
      return { summary: `1. 要点: ${head}\n2. 状況: 入力${input.length}字を要約\n3. 次の一手: 担当と期限を確認` };
    },
    validate(r) { return r && typeof r.summary === 'string'; }
  },
  // R5 A3・1枚圧縮 (1500字以内)
  'compile-a3': {
    model: SONNET, maxTokens: 2048,
    system: 'あなたはA3一枚仕事術の編集者です。入力を1500字以内のA3ドラフト（背景/現状/目標/対策/計画）に圧縮します。必ず次のJSONのみを出力: {"a3":"1500字以内のA3本文"}',
    mock(input) {
      let a3 = `【背景】${input.trim()}\n【現状】入力${input.length}字を整理\n【目標】論点を1枚に集約\n【対策】要点を構造化\n【計画】担当と期限を割当`;
      if (a3.length > 1500) a3 = a3.slice(0, 1500);
      return { a3 };
    },
    validate(r) { return r && typeof r.a3 === 'string' && r.a3.length <= 1500; }
  },
  // R6 なぜなぜ候補
  'five-whys': {
    model: SONNET, maxTokens: 768,
    system: 'あなたは「なぜなぜ分析」のファシリテーターです。入力の事象に対し「なぜ」を掘り下げる候補を返します。必ず次のJSONのみを出力: {"whys":["なぜ1","なぜ2","なぜ3","なぜ4","なぜ5"]}',
    mock(input) {
      const t = input.trim();
      return { whys: [1, 2, 3, 4, 5].map(n => `なぜ${n}: ${t} はなぜ起きたか（第${n}層）`) };
    },
    validate(r) { return r && Array.isArray(r.whys) && r.whys.every(w => typeof w === 'string'); }
  },
  // R7 指標からの改善提案
  'diagnose': {
    model: SONNET, maxTokens: 768,
    system: 'あなたは会議指標のアナリストです。入力の指標データから改善提案を返します。必ず次のJSONのみを出力: {"advice":"具体的な改善提案の文章"}',
    mock(input) {
      return { advice: `指標（${input.length}字）を診断: 停滞の兆候があれば担当と期限を明確化し、決定ゼロ会議を減らす一手を打ちましょう。` };
    },
    validate(r) { return r && typeof r.advice === 'string'; }
  }
};

// ---- メモリ内カウンタ（永続化しない） ----
const rateMap = new Map();           // ip -> {window, count}
const daily = { day: -1, count: 0 };

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length) return xf.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function checkRate(ip, now) {
  const win = Math.floor(now / 60000);
  let e = rateMap.get(ip);
  if (!e || e.window !== win) { e = { window: win, count: 0 }; rateMap.set(ip, e); }
  if (e.count >= RATE_PER_MIN) return false;
  e.count++;
  return true;
}
function checkDaily(now) {
  const day = Math.floor(now / 86400000);
  if (daily.day !== day) { daily.day = day; daily.count = 0; }
  if (daily.count >= DAILY_LIMIT) return false;
  daily.count++;
  return true;
}

// ---- ユーティリティ ----
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() });
  res.end(body);
}
// メタデータのみログ出力（入力本文・応答本文は絶対に出さない）
function logMeta(path, status, inputChars, ms) {
  process.stdout.write(JSON.stringify({
    t: new Date().toISOString(), path, status, inputChars, ms
  }) + '\n');
}
function readBody(req) {
  // 上限超過時もソケットを破壊せず、本文を破棄（メモリ保護）しつつ受け切ってから 413 を返す。
  return new Promise((resolve) => {
    let size = 0; let over = false; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { over = true; chunks.length = 0; return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => resolve(over ? { over: true } : { body: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ error: true }));
  });
}
// ---- 静的配信（ホワイトリストのみ。パストラバーサル不可） ----
// キー: URLパス、値: ルート相対のファイル名。ユーザー本文は一切保持・記録しない。
const STATIC = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/privacy': 'privacy.html',
  '/privacy.html': 'privacy.html'
};
function serveStatic(res, rel) {
  try {
    const buf = readFileSync(path.join(ROOT, rel));
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders()
    });
    res.end(buf);
  } catch (e) {
    sendJson(res, 404, { ok: false, error: 'not_found' });
  }
}

function extractJson(text) {
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

// ---- 実LLM呼び出し ----
async function callLlm(route, input, context) {
  const userContent = context && Object.keys(context).length
    ? `${input}\n\n# context\n${JSON.stringify(context)}`
    : input;
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: route.model,
      max_tokens: route.maxTokens,
      system: route.system,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  if (!res.ok) throw new Error('anthropic_status_' + res.status);
  const data = await res.json();
  const text = Array.isArray(data.content)
    ? data.content.filter(p => p.type === 'text').map(p => p.text).join('')
    : '';
  const parsed = extractJson(text);
  if (!route.validate(parsed)) throw new Error('invalid_llm_shape');
  return parsed;
}

// ---- リクエスト処理 ----
const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // CORS プリフライト
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // ヘルスチェック
  if (req.method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true, mock: MOCK });
    return;
  }

  // 静的配信（index.html / privacy.html のみ）。本文を扱わないためログもメタ含め出さない。
  if ((req.method === 'GET' || req.method === 'HEAD') && Object.prototype.hasOwnProperty.call(STATIC, path)) {
    serveStatic(res, STATIC[path]);
    return;
  }

  const m = path.match(/^\/api\/v1\/([a-z0-9-]+)$/);
  if (req.method === 'POST' && m && ROUTES[m[1]]) {
    const route = ROUTES[m[1]];
    let inputChars = 0;
    let status = 200;
    try {
      // 乱用対策: レート制限 → 日次上限
      const now = Date.now();
      const ip = clientIp(req);
      if (!checkRate(ip, now)) {
        status = 429;
        sendJson(res, 429, { ok: false, error: 'rate_limited' });
        return;
      }
      if (!checkDaily(now)) {
        status = 503;
        sendJson(res, 503, { ok: false, error: 'daily_limit' });
        return;
      }

      // ボディ読み取り（32KB上限）
      const rb = await readBody(req);
      if (rb.over) { status = 413; sendJson(res, 413, { ok: false, error: 'payload_too_large' }); return; }
      if (rb.error) { status = 400; sendJson(res, 400, { ok: false, error: 'bad_request' }); return; }
      const raw = rb.body;

      let parsedReq;
      try { parsedReq = JSON.parse(raw || '{}'); } catch (e) {
        status = 400; sendJson(res, 400, { ok: false, error: 'bad_request' }); return;
      }
      const input = parsedReq && typeof parsedReq.input === 'string' ? parsedReq.input : '';
      const context = parsedReq && parsedReq.context && typeof parsedReq.context === 'object' ? parsedReq.context : undefined;
      if (!input) {
        status = 400; sendJson(res, 400, { ok: false, error: 'bad_request' }); return;
      }
      inputChars = input.length;

      // LLM 実行
      let result;
      if (MOCK) {
        result = route.mock(input, context);
      } else if (!API_KEY) {
        status = 503; sendJson(res, 503, { ok: false, error: 'llm_unavailable' }); return;
      } else {
        try {
          result = await callLlm(route, input, context);
        } catch (e) {
          status = 502; sendJson(res, 502, { ok: false, error: 'llm_error' }); return;
        }
      }

      sendJson(res, 200, {
        ok: true,
        result,
        meta: { model: route.model, inputChars }
      });
    } catch (e) {
      // 例外内容に入力本文が含まれ得るためログには出さない
      if (!res.headersSent) { status = 500; sendJson(res, 500, { ok: false, error: 'internal_error' }); }
    } finally {
      logMeta(path, status, inputChars, Date.now() - started);
    }
    return;
  }

  // 未定義ルート
  sendJson(res, 404, { ok: false, error: 'not_found' });
});

server.listen(PORT, () => {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), msg: 'router-api listening', port: PORT, mock: MOCK }) + '\n');
});

export { server };
