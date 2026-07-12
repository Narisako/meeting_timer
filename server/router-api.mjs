// 会議招集の前に ステートレスAPIバックエンド骨格 (v3-2 / Issue #14)
// - Node 18+ 標準ライブラリ + 組み込み fetch のみ。npm 依存ゼロ。
// - ゼロリテンション: DB・ファイル書き込み一切なし。ログはメタデータのみ（入力本文・LLM応答本文は出さない）。
// - LLMアシスト専用。MOCK_LLM=1 で決定的モック、OpenAI API (gpt-4o) で実行。
// - OPENAI_BASE_URL は必須の環境変数（デフォルト値なし）。宛先は運用者が明示的に指定すること。
//   未設定（空文字）の場合、非MOCK時のLLM呼び出しは 503 llm_unavailable を返す（SSRF対策）。
// - 静的配信: GET / → index.html、GET /privacy → privacy.html（ゼロリテンション方針は不変。本文は保持・記録しない）。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// リポジトリルート（server/ の一つ上）。静的ファイルはここから配信する。
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const PORT = Number(process.env.PORT || 8787);
const MOCK = process.env.MOCK_LLM === '1';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
// SSRF対策: デフォルト値なし。運用者が明示的に指定する必須環境変数。未設定なら非MOCK時 503。
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 1000);

const MAX_BODY = 32 * 1024;         // 32KB
const RATE_PER_MIN = 30;            // IPごと 30req/分

// 全ルートで同一モデルを使用（環境変数で切替）
const MODEL = OPENAI_MODEL;

// ---- エンドポイント定義 (path -> {model, maxTokens, system, mock, validate}) ----
const ROUTES = {
  // R1 報連相仕分け
  'route': {
    model: MODEL, maxTokens: 512,
    // フロントのレーン(報告=過去/連絡=現在/相談=未来)と整合させる。
    // report=報告(すでに済んだ過去の事実), chat=連絡(いま知らせたい現在の共有), meeting=相談(これから決めたい未来の要決定=要会議)。
    system: 'あなたは日本の職場の「報連相」仕分け係です。入力メッセージを report(報告=すでに済んだ過去の事実や結果の報告)/chat(連絡=いま知らせたい現在の共有・連絡事項)/meeting(相談=これから決めたい未来の要決定事項＝要会議) のいずれかに分類し、理由と整形済み本文を返します。必ず次のJSONのみを出力: {"kind":"report|chat|meeting","reason":"日本語の短い理由","formatted":"整形済み本文"}',
    mock(input) {
      // report=報告(過去) / chat=連絡(現在の共有) / meeting=相談(未来の要決定)。相談・意見・疑問は「相談」=meeting へ寄せる。
      let kind = 'report';
      if (/連絡|お知らせ|周知|展開|通知/.test(input)) kind = 'chat';
      if (/[?？]|相談|どう思|意見|会議|議題|打ち合わせ|ミーティング|集まって|決めた/.test(input)) kind = 'meeting';
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
    model: MODEL, maxTokens: 512,
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
    model: MODEL, maxTokens: 768,
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
    model: MODEL, maxTokens: 512,
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
    model: MODEL, maxTokens: 2048,
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
    model: MODEL, maxTokens: 768,
    system: 'あなたは「なぜなぜ分析」のファシリテーターです。入力の事象に対し「なぜ」を掘り下げる候補を返します。必ず次のJSONのみを出力: {"whys":["なぜ1","なぜ2","なぜ3","なぜ4","なぜ5"]}',
    mock(input) {
      const t = input.trim();
      return { whys: [1, 2, 3, 4, 5].map(n => `なぜ${n}: ${t} はなぜ起きたか（第${n}層）`) };
    },
    validate(r) { return r && Array.isArray(r.whys) && r.whys.every(w => typeof w === 'string'); }
  },
  // R7 指標からの改善提案
  'diagnose': {
    model: MODEL, maxTokens: 768,
    system: 'あなたは会議指標のアナリストです。入力の指標データから改善提案を返します。必ず次のJSONのみを出力: {"advice":"具体的な改善提案の文章"}',
    mock(input) {
      return { advice: `指標（${input.length}字）を診断: 停滞の兆候があれば担当と期限を明確化し、決定ゼロ会議を減らす一手を打ちましょう。` };
    },
    validate(r) { return r && typeof r.advice === 'string'; }
  },
  // v5-2 AIインテーク（ステートレス対話）。他ルートと異なり {messages, state} を受け、
  //   {reply, choices?, actions?, state?} を返す。chat:true でハンドラ側の分岐を切り替える。
  'intake': {
    model: MODEL, maxTokens: 1024, chat: true,
    system: [
      'あなたは「会議招集の前に」という報連相トリアージ・システムの対話ガイドです。',
      'ユーザーとの短い対話で「会議招集の文面に足る情報」を最短で集めることがゴールです。',
      '思想を厳守してください:',
      '(1) 報連相を仕分け、原則はメール/チャット/レポートで済ませ、例外理由があるときだけ会議を開く。',
      '(2) 決めるための事実（数字・現状・原因）が揃うまで会議は開かない。先に現状把握レポートで事実を共有する。',
      '(3) 会議は最小メンバー（決裁者＋意見・情報を持つ人）に絞る。',
      '(4) 「聞くだけ」の人は招集せず、レポート送付に回す。',
      '【5問設計】最初の5問で会議招集文面の骨格が揃うよう、次の優先順位で1問ずつ質問してください:',
      '  ① 案件名（最初の問いは必ず「案件名を教えてください。」）',
      '  ② 何を決めたいか・その背景',
      '  ③ 決めるための事実は揃っているか（足りない報告・連絡は何か）',
      '  ④ 決裁者は誰か・最小メンバー（意見／情報を持つ人）は誰か',
      '  ⑤ 選択肢・判断基準や、今日の会議の終了条件',
      '6問目以降は任意の深掘りです（続けるかはユーザー次第）。深掘りでも常に「次の一問」を1つだけ返してください。',
      'ユーザーの自由入力を理解し、トヨタA3の8ステップ（背景/現状/目標/要因/対策/計画/実施/評価）を埋めるのに必要なことを対話で深掘りし、会議要否と最小メンバーを見極めます。',
      '常に「次の一問」を1つだけ返し、構造化された actions と extract を添えてください。',
      'actions の各タイプのフィールド仕様（厳守）:',
      '- add_member: {"type":"add_member","name":"氏名","role":"decider|opinion|info|listener"}。name は必ず1人のフルネームのみ。複数人を招集する場合は add_member を人数分だけ繰り返す（1 action = 1人）。1つの name に「成迫,森,広瀬」のように複数名を詰め込んではならない。role は必ず decider / opinion / info / listener のいずれか一つ。決裁者は role を必ず "decider" とし、最低1人は含めること。',
      '- set_question: {"type":"set_question","question":"決める問い"}。question にはあなた自身の質問文（例「何を決めますか？」）を入れてはならない。ユーザーが実際に答えた「決めること」の要約（1つの問い）だけを入れる。',
      '- propose_meeting: {"type":"propose_meeting","question":"決める問い"}。question は set_question と同様、あなたの質問文ではなくユーザーが答えた決定事項の要約を入れる。',
      '【構造化抽出 extract】対話から分かった範囲だけで、裏側のトヨタA3・7つのムダ・報連相の3フレームワークへ反映するための抽出を返してください。分かった範囲だけでよく、完璧を期す必要はありません（分からなければ空でよい）。形式:',
      '  "extract": {',
      '    "a3": { "該当ステップ番号(1〜8の文字列)": "その断片（1=背景/2=現状/3=目標/4=要因/5=対策/6=計画/7=実施/8=評価）" },',
      '    "horenso": [ { "kind":"report|chat|meeting", "text":"内容の要約", "presend": true|false } ],',
      '    "muda": { "ムダ番号(1〜7の文字列)": { "status":"ok|warn", "note":"根拠の一言" } }',
      '  }',
      '  ・presend は「会議までに事前送付すべき資料（例: 現状把握レポート）」のとき true。',
      '  ・a3/muda のキーは文字列の番号。分かった項目だけ入れ、埋まらない項目は省略してよい。',
      '必ず次のJSONのみを出力: {"reply":"次の一問（日本語）","choices":["選択肢",...],"actions":[{"type":"set_title|set_route|fill_step|set_question|add_member|propose_meeting|suggest_report",...}],"extract":{"a3":{},"horenso":[],"muda":{}},"state":{"phase":"次の局面",...}}'
    ].join('\n'),
    // MOCK: v5-1 の質問ツリーを決定的になぞる。state.phase で局面を進める。
    mock(messages, state) {
      const st = (state && typeof state === 'object') ? state : {};
      const phase = st.phase || 'askName';
      const users = messages.filter(m => m && m.role === 'user');
      const text = users.length ? String(users[users.length - 1].text || '') : '';
      const EXC = ['判断が必要', '関係者間に認識差がある', '不確実性が高い', '緊急性が高い', '判断が不可逆', '部門横断の調整が必要', '決定権者の判断が必要'];
      const next = (extra) => Object.assign({}, st, extra);
      switch (phase) {
        case 'askName': {
          const title = text.trim() || '無題の案件';
          return {
            reply: `案件「${title}」を下書きとして作成しました。この件で、いま一番したいことは何ですか？`,
            choices: ['過去の結果・経緯を伝えたい', 'いま起きていることを知らせたい', 'これから何かを決めたい・相談したい'],
            actions: [{ type: 'set_title', title }],
            extract: { a3: { '1': `背景: ${title}` }, horenso: [], muda: {} },
            state: next({ phase: 'want', title })
          };
        }
        case 'want': {
          let tense = 'future';
          if (/過去|報告|結果|経緯|実績/.test(text)) tense = 'past';
          else if (/いま|連絡|知らせ|共有|周知/.test(text)) tense = 'present';
          if (tense === 'future') {
            return {
              reply: '決めるために、事実（数字・現状・原因）は揃っていますか？',
              choices: ['揃っている', '揃っていない', 'わからない'],
              actions: [{ type: 'set_route', route: 'meeting', tense }],
              extract: { a3: {}, horenso: [{ kind: 'meeting', text: st.title || '', presend: false }], muda: {} },
              state: next({ phase: 'facts', tense })
            };
          }
          return {
            reply: '会議が必要になりやすい例外条件に当てはまるものはありますか？無ければ「該当なし」を選んでください。',
            choices: EXC.concat(['該当なし']),
            actions: [{ type: 'set_route', route: tense === 'present' ? 'chat' : 'report', tense }],
            extract: { a3: {}, horenso: [{ kind: tense === 'present' ? 'chat' : 'report', text: st.title || '', presend: false }], muda: {} },
            state: next({ phase: 'exception', tense })
          };
        }
        case 'exception': {
          if (/該当なし|無し|ない$/.test(text.trim())) {
            const kind = st.tense === 'present' ? 'chat' : 'report';
            return {
              reply: `会議は不要です。${kind === 'chat' ? 'チャット' : 'レポート'}で済ませましょう。テンプレートを用意します。`,
              choices: ['テンプレートを開く', '対話をやり直す'],
              actions: [{ type: 'suggest_report', kind }],
              state: next({ phase: 'doneNoMeeting' })
            };
          }
          return {
            reply: '例外条件に該当します。では、決めるための事実（数字・現状・原因）は揃っていますか？',
            choices: ['揃っている', '揃っていない', 'わからない'],
            actions: [{ type: 'set_route', route: 'meeting', tense: 'future' }],
            state: next({ phase: 'facts', tense: 'future', exception: text.trim() })
          };
        }
        case 'facts': {
          if (/揃っている|ある|はい/.test(text) && !/いない|揃っていない/.test(text)) {
            return {
              reply: 'では、この会議で何を決めますか？1つの問いにしてください。',
              choices: [],
              actions: [],
              extract: { a3: { '2': '判断に必要な事実は揃っている' }, horenso: [], muda: { '3': { status: 'ok', note: '事実が揃っており報告のためだけの資料作りを避けられる' } } },
              state: next({ phase: 'decisionQ' })
            };
          }
          return {
            reply: '先に現状把握レポート（Step2）で事実を共有しましょう。会議はそれからでも遅くありません。',
            choices: ['現状把握レポート（Step2）を開く', 'それでも今すぐ会議が必要'],
            actions: [{ type: 'suggest_report', kind: 'report', step: 2 }],
            extract: { a3: { '2': '判断に必要な事実が未収集。現状把握レポートで先に共有する' }, horenso: [{ kind: 'report', text: '現状把握レポート（Step2）', presend: true }], muda: {} },
            state: next({ phase: 'factsNotReady' })
          };
        }
        case 'factsNotReady': {
          if (/今すぐ|それでも|必要/.test(text)) {
            return {
              reply: 'わかりました。では、この会議で何を決めますか？1つの問いにしてください。',
              choices: [],
              actions: [],
              state: next({ phase: 'decisionQ' })
            };
          }
          return {
            reply: '現状把握レポート（Step2）を開きます。事実が揃ってから会議を検討しましょう。',
            choices: [],
            actions: [{ type: 'suggest_report', kind: 'report', step: 2 }],
            state: next({ phase: 'doneReport' })
          };
        }
        case 'decisionQ': {
          const q = text.trim();
          return {
            reply: 'それを決められる人（決裁者）は誰ですか？',
            choices: [],
            actions: [{ type: 'set_question', question: q }],
            extract: { a3: { '3': `決める問い（目標）: ${q}` }, horenso: [], muda: {} },
            state: next({ phase: 'decider', decisionQuestion: q })
          };
        }
        case 'decider': {
          const name = text.trim();
          return {
            reply: '意見や情報が必要な人はいますか？名前を入力してください。「聞くだけ」の人は招集せずレポート送付に回します。いなければ「まとめへ」を選んでください。',
            choices: ['まとめへ'],
            actions: [{ type: 'add_member', name, role: 'decider' }],
            extract: { a3: {}, horenso: [], muda: { '1': { status: 'ok', note: `決める人が明確（${name}）` } } },
            state: next({ phase: 'participants', decider: name })
          };
        }
        case 'participants': {
          if (/まとめ|完了|いない|なし/.test(text)) {
            return {
              reply: '【まとめ】必要な事実が揃い、決裁者と最小メンバーが決まりました。判断セッション（会議）の設計に進みましょう。',
              choices: ['判断セッション設計へ進む'],
              actions: [],
              state: next({ phase: 'summary' })
            };
          }
          return {
            reply: `「${text.trim()}」さんの役割を選んでください。`,
            choices: ['意見を出す人', '情報を持っている人', '聞くだけ（レポート送付）'],
            actions: [],
            state: next({ phase: 'partRole', pendingName: text.trim() })
          };
        }
        case 'partRole': {
          let role = 'opinion';
          if (/情報/.test(text)) role = 'info';
          else if (/聞くだけ|レポート|送付/.test(text)) role = 'listener';
          const name = st.pendingName || '';
          const note = role === 'listener'
            ? `「${name}」さんはレポート送付に回します。他にいますか？いなければ「まとめへ」を選んでください。`
            : `「${name}」さんを追加しました。他にいますか？いなければ「まとめへ」を選んでください。`;
          return {
            reply: note,
            choices: ['まとめへ'],
            actions: [{ type: 'add_member', name, role }],
            state: next({ phase: 'participants', pendingName: '' })
          };
        }
        case 'summary': {
          return {
            reply: '判断セッション設計へプリフィルします。決める問い・背景・最小メンバーを引き継ぎます。',
            choices: [],
            actions: [{ type: 'propose_meeting', question: st.decisionQuestion || '' }],
            state: next({ phase: 'done' })
          };
        }
        default:
          return { reply: '案件名を教えてください。', choices: [], actions: [], state: { phase: 'askName' } };
      }
    },
    validate(r) {
      return r && typeof r.reply === 'string' &&
        (r.choices === undefined || Array.isArray(r.choices)) &&
        (r.actions === undefined || Array.isArray(r.actions)) &&
        (r.extract === undefined || (r.extract && typeof r.extract === 'object' && !Array.isArray(r.extract))) &&
        (r.state === undefined || (r.state && typeof r.state === 'object'));
    }
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

// ---- Codex モデル判定 ----
function isCodexModel(model) {
  return model.toLowerCase().includes('codex');
}

// ---- OpenAI 呼び出し共通ヘルパー (Chat Completions / Responses API) ----
// system: system prompt 文字列。messages: [{role:'user'|'assistant', content}] の会話配列。
// Codex モデルは Responses API、それ以外は Chat Completions API を使う。応答テキストを返す。
async function openaiComplete({ model, maxTokens, system, messages }) {
  const headers = { 'content-type': 'application/json' };
  if (OPENAI_API_KEY) headers['authorization'] = `Bearer ${OPENAI_API_KEY}`;

  if (isCodexModel(model)) {
    // Responses API for codex models（system は instructions、会話は input に連結）
    const input = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');
    const url = `${OPENAI_BASE_URL}/responses`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        instructions: system,
        input,
        stream: false
      })
    });
    if (!res.ok) throw new apiError(res.status, await res.text());
    const data = await res.json();
    // Extract text from output[].type=="message" -> content[].type=="output_text"
    let text = '';
    if (Array.isArray(data.output)) {
      for (const out of data.output) {
        if (out.type === 'message' && Array.isArray(out.content)) {
          for (const c of out.content) {
            if (c.type === 'output_text') text += c.text;
          }
        }
      }
    }
    return text;
  }

  // Chat Completions API
  const url = `${OPENAI_BASE_URL}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages]
    })
  });
  if (!res.ok) throw new apiError(res.status, await res.text());
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ---- 実LLM呼び出し (OpenAI Chat Completions / Responses API) ----
async function callLlm(route, input, context) {
  const userContent = context && Object.keys(context).length
    ? `${input}\n\n# context\n${JSON.stringify(context)}`
    : input;
  const text = await openaiComplete({
    model: route.model,
    maxTokens: route.maxTokens,
    system: route.system,
    messages: [{ role: 'user', content: userContent }]
  });
  const parsed = extractJson(text);
  if (!route.validate(parsed)) throw new Error('invalid_llm_shape');
  return parsed;
}

// ---- apiError 型 ----
class apiError extends Error {
  constructor(statusCode, body) {
    super(`openai_status_${statusCode}`);
    this.statusCode = statusCode;
    this.body = body;
  }
}

// ---- 実LLM呼び出し（対話ルート: messages + state → {reply, choices?, actions?, state?}） ----
// v5 対話インテーク特有の要件（会話履歴を {role,content} に変換し、system prompt に現在の状態を
// JSON 埋め込みする）を維持しつつ、HTTP 呼び出しは OpenAI 共通ヘルパー（openaiComplete）に委譲する。
async function callLlmChat(route, messages, state) {
  const convo = messages.map(m => ({
    role: m && m.role === 'assistant' ? 'assistant' : 'user',
    content: String((m && m.text) || '')
  }));
  if (!convo.length) convo.push({ role: 'user', content: '（開始）' });
  const system = route.system + '\n\n# 現在の状態\n' + JSON.stringify(state || {});
  const text = await openaiComplete({
    model: route.model,
    maxTokens: route.maxTokens,
    system,
    messages: convo
  });
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

      let result;
      if (route.chat) {
        // 対話ルート: {messages:[{role,text}...], state:{...}} を受ける（ステートレス）
        const messages = Array.isArray(parsedReq && parsedReq.messages)
          ? parsedReq.messages.filter(m => m && typeof m.text === 'string')
          : null;
        const state = parsedReq && parsedReq.state && typeof parsedReq.state === 'object' ? parsedReq.state : {};
        if (!messages) {
          status = 400; sendJson(res, 400, { ok: false, error: 'bad_request' }); return;
        }
        inputChars = messages.reduce((n, m) => n + m.text.length, 0);
        if (MOCK) {
          result = route.mock(messages, state);
        } else if (!OPENAI_BASE_URL) {
          // SSRF対策: OPENAI_BASE_URL は必須。未設定なら実LLM呼び出しを行わず 503。
          status = 503; sendJson(res, 503, { ok: false, error: 'llm_unavailable' }); return;
        } else {
          try {
            result = await callLlmChat(route, messages, state);
          } catch (e) {
            status = 502; sendJson(res, 502, { ok: false, error: 'llm_error' }); return;
          }
        }
      } else {
        const input = parsedReq && typeof parsedReq.input === 'string' ? parsedReq.input : '';
        const context = parsedReq && parsedReq.context && typeof parsedReq.context === 'object' ? parsedReq.context : undefined;
        if (!input) {
          status = 400; sendJson(res, 400, { ok: false, error: 'bad_request' }); return;
        }
        inputChars = input.length;

        // LLM 実行
        if (MOCK) {
          result = route.mock(input, context);
        } else if (!OPENAI_BASE_URL) {
          // SSRF対策: OPENAI_BASE_URL は必須。未設定なら実LLM呼び出しを行わず 503。
          status = 503; sendJson(res, 503, { ok: false, error: 'llm_unavailable' }); return;
        } else {
          try {
            result = await callLlm(route, input, context);
          } catch (e) {
            status = 502; sendJson(res, 502, { ok: false, error: 'llm_error' }); return;
          }
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
