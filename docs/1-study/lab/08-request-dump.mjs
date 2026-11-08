// 8장 실습: 플러그인이 실제로 보내는 요청과 받는 SSE를 바이트로 봅니다 (학습서 8-3·8-4·8-6·8-7절 깊이 보기).
//  1) 요청 머리글과 본문 JSON(지시문만 줄여 보임): system 배열, (empty) 턴, 첫 멘트 병합, end_call 도구, 맨 끝 옵션
//  2) 렌더 순서(tools → system → messages)로 블록을 늘어놓고, 자동 캐시 브레이크포인트 자리를 표시
//  3) 다음 턴과 다른 통화: 문서의 캐시 규칙(브레이크포인트에서만 쓰고, 읽을 때 20칸까지 거슬러 찾음)을 흉내 낸
//     장난감 모델에 넣어 어디서 읽히는지 보기. 지시문을 두 블록으로 나눈 제안 모양도 같이
//  4) 가짜 서버가 보낸 SSE 원문 그대로, 이벤트마다 시각을 찍는 법(머리글 · message_start · 첫 text_delta)
//  5) 오류와 재시도: 529, 400, 스트림 중간 error(글 전·글 뒤), 연결 거부, 머리글 지연(시간 초과),
//     Bedrock 클라이언트(SDK 1.x)의 400
//
// 실행 (레포 루트에서):  node docs/1-study/lab/08-request-dump.mjs   (약 13초, LiveKit의 재시도 간격을 기다림)
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/agents-plugin-anthropic 1.9.5(@anthropic-ai/sdk 0.33.1),
//       @anthropic-ai/bedrock-sdk 1.1.1(@anthropic-ai/sdk 1.4.0) (2026-11-06)
// 키·.env.local·외부 네트워크를 쓰지 않습니다. API 키와 AWS 키는 가짜 문자열이고 baseURL을 127.0.0.1로 바꿉니다.
// 가짜 서버의 사용량(토큰 수)과 답 글은 지어낸 값입니다. 실제 서버가 무엇을 받아 주는지는 이 실습으로 알 수 없습니다.
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { initializeLogger, llm } from '@livekit/agents';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createAgent } from '../../../src/agent.ts';
import { SAMPLE_CALL, parseCallContext } from '../../../src/call-context.ts';
import { loadKnowledge } from '../../../src/knowledge.ts';
import { VoiceAnthropicLLM } from '../../../src/models/anthropic.ts';
import { OPENING_QUESTION, openingNotice } from '../../../src/prompt.ts';

// 재시도 경고(warn)는 아래에서 'error' 이벤트로 직접 찍으므로 로그는 error만 둡니다.
initializeLogger({ pretty: false, level: 'error' });

// 플러그인이 쓰는 SDK 0.33과 Bedrock SDK가 쓰는 SDK 1.4는 레포 루트에서 안 보이므로(pnpm) 각 패키지 위치에서
// 빌려 옵니다(4번 시각 찍기와 SSE 해석 비교용).
const sdkFrom = async (pkg) =>
  (await import(pathToFileURL(createRequire(import.meta.resolve(pkg)).resolve('@anthropic-ai/sdk')).href))
    .default;
const Anthropic = await sdkFrom('@livekit/agents-plugin-anthropic');
const Anthropic14 = await sdkFrom('@anthropic-ai/bedrock-sdk');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = (s) => Buffer.byteLength(s);

// ── 가짜 서버: 받은 요청을 그대로 기록하고, 경우마다 정한 응답을 돌려줍니다.
const seen = [];
let respond = () => {};
const server = createServer((req, res) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => {
    const rec = { t: performance.now(), method: req.method, url: req.url, headers: req.headers };
    rec.body = Buffer.concat(parts);
    seen.push(rec);
    respond(req, res, rec);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// SSE 한 이벤트. 실제 API처럼 이벤트 이름 줄과 data 줄, 빈 줄로 끝납니다.
const sse = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
const START = (id, usage) =>
  sse({
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-5-5',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
const TEXT = (text) =>
  sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const ERROR = sse({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });

/** [기다릴 ms, 보낼 글] 목록대로 SSE를 흘려보내고, 보낸 시각을 기록합니다. */
async function stream(res, steps, sent) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'request-id': 'req_lab' });
  res.flushHeaders();
  sent?.push([performance.now(), '(응답 머리글)']);
  for (const [wait, chunk] of steps) {
    if (wait) await sleep(wait);
    res.write(chunk);
    sent?.push([performance.now(), chunk]);
  }
  res.end();
}

// 1턴 응답. 머리글 → 120ms 뒤 message_start(대기열·프리필 흉내) → 40ms 뒤 첫 글 → …
const TURN1_ANSWER = ['스테인리스 텀블러도', ' 각인할 수 있어요.', ' 정확한 금액은 담당 상담사가 안내드릴게요.'];
const TURN1_SSE = [
  [
    120,
    START('msg_lab_01', {
      input_tokens: 0,
      cache_creation_input_tokens: 3530,
      cache_read_input_tokens: 0,
      output_tokens: 1,
    }),
  ],
  [0, sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })],
  [0, 'event: ping\ndata: {"type": "ping"}\n\n'],
  [40, TEXT(TURN1_ANSWER[0])],
  [30, TEXT(TURN1_ANSWER[1])],
  [30, TEXT(TURN1_ANSWER[2])],
  [0, sse({ type: 'content_block_stop', index: 0 })],
  [
    0,
    sse({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 42 },
    }),
  ],
  [0, sse({ type: 'message_stop' })],
];

// ── 운영과 같은 모양으로 LLM·에이전트·대화를 만듭니다 (src/models/index.ts의 'anthropic', src/main.ts).
function voiceLLM(extra = {}) {
  return new VoiceAnthropicLLM({
    model: 'claude-haiku-5-5',
    effort: 'low',
    thinking: 'off',
    maxTokens: 2048,
    apiKey: 'sk-ant-fake-key-for-lab',
    baseURL: BASE,
    ...extra,
  });
}
const USER_1 = '네, 괜찮아요. 근데 이거 가죽 말고 스테인리스 텀블러에도 각인돼요? 가격은 얼마예요?';
const USER_2 = '창업 준비 중이라 소량으로 만들어 팔아 보려고요.';

/** 세션이 LLM에 넘기는 대화 기록과 같은 모양. 지시문은 맨 앞 system 메시지(agents/voice/generation.ts 535~565),
 *  첫 멘트는 main.ts가 say를 두 번 하므로 assistant 메시지 둘입니다. */
function callCtx(agent, call, turns) {
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ role: 'system', content: agent.instructions });
  ctx.addMessage({ role: 'assistant', content: openingNotice(call) });
  ctx.addMessage({ role: 'assistant', content: OPENING_QUESTION });
  for (const [role, content] of turns) ctx.addMessage({ role, content });
  return ctx;
}

/** 한 번 부르고 ChatChunk, 'error' 이벤트, 지표를 모읍니다. */
async function run(model, chatCtx, toolCtx, connOptions) {
  const chunks = [];
  const errors = [];
  const metrics = [];
  const onError = (e) => errors.push({ t: performance.now(), ...e });
  const onMetrics = (m) => metrics.push(m);
  model.on('error', onError);
  model.on('metrics_collected', onMetrics);
  const started = performance.now();
  for await (const c of model.chat({ chatCtx, toolCtx, ...(connOptions ? { connOptions } : {}) })) {
    chunks.push({ t: performance.now(), c });
  }
  await sleep(0);
  model.off('error', onError);
  model.off('metrics_collected', onMetrics);
  return { started, chunks, errors, metrics };
}

const shorten = (text, head = 48, tail = 0) =>
  text.length <= head + tail + 10
    ? text
    : `${text.slice(0, head)} … (${text.length - head - tail}자 줄임) …${tail ? ` ${text.slice(-tail)}` : ''}`;

const knowledge = loadKnowledge();
const model = voiceLLM();
const agent = createAgent({ call: SAMPLE_CALL, llm: model, knowledge });
const toolCtx = agent.toolCtx;

// ════════════════════════════════════════════════════════════════════
console.log('━━ 1) 요청 머리글과 본문 ━━');
let sent1 = [];
respond = (_req, res) => void stream(res, TURN1_SSE, sent1);
const r1 = await run(model, callCtx(agent, SAMPLE_CALL, [['user', USER_1]]), toolCtx);
const req1 = seen.at(-1);
const body1 = JSON.parse(req1.body.toString('utf8'));

console.log(`${req1.method} ${req1.url}   (본문 ${req1.body.length}B)`);
for (const [k, v] of Object.entries(req1.headers)) {
  if (k.startsWith('x-stainless-') && !['x-stainless-retry-count', 'x-stainless-timeout'].includes(k))
    continue;
  console.log(`  ${k}: ${k === 'x-api-key' ? '(가림)' : v}`);
}
console.log('  (x-stainless-os·arch·runtime 등 SDK 환경 머리글 몇 개는 줄임)');
console.log(`\n본문 최상위 키 순서: ${Object.keys(body1).join(', ')}`);

// 지시문만 줄여서 본문을 그대로 보입니다.
const view = structuredClone(body1);
const instr = view.system[0].text;
view.system[0].text = `${shorten(instr, 34)} [전체 ${instr.length}자, ${bytes(instr)}B]`;
console.log(JSON.stringify(view, null, 2));
console.log(`\n지시문의 끝(고객 정보, 통화마다 다름):\n${instr.slice(instr.indexOf('# 고객 정보'))}`);

// ════════════════════════════════════════════════════════════════════
console.log('\n━━ 2) 렌더 순서로 본 블록과 자동 캐시 자리 ━━');
/** 문서의 렌더 순서(tools → system → messages)대로 캐시 자리(블록)를 늘어놓습니다.
 *  메시지의 문자열 content는 글 블록 하나로 칩니다. 크기는 요청 JSON 조각의 바이트입니다(토큰화는 비공개). */
function positions(body) {
  const out = [];
  for (const t of body.tools ?? []) out.push({ name: `tools[${t.name}]`, json: JSON.stringify(t) });
  (body.system ?? []).forEach((b, i) =>
    out.push({ name: `system[${i}]`, json: JSON.stringify({ ...b, cache_control: undefined }) }),
  );
  body.messages.forEach((m, i) => {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    blocks.forEach((b, j) =>
      out.push({ name: `messages[${i}] ${m.role} 블록${j}`, json: JSON.stringify({ role: m.role, ...b }) }),
    );
  });
  return out;
}
const p1 = positions(body1);
let cum = 0;
console.log(' 자리  블록                              크기(B)  누적(B)');
p1.forEach((p, i) => {
  cum += bytes(p.json);
  const mark = i === p1.length - 1 ? '  ← 자동 캐시 브레이크포인트 (마지막 블록)' : '';
  console.log(`  ${String(i + 1).padStart(2)}  ${p.name.padEnd(32)} ${String(bytes(p.json)).padStart(6)} ${String(cum).padStart(8)}${mark}`);
});
console.log(`  본문 맨 끝: ${JSON.stringify({ thinking: body1.thinking, output_config: body1.output_config, cache_control: body1.cache_control, tool_choice: body1.tool_choice })}`);

// ════════════════════════════════════════════════════════════════════
console.log('\n━━ 3) 다음 턴과 다른 통화: 캐시 규칙 장난감 모델 ━━');
console.log('  규칙(문서 기준): 브레이크포인트 자리에만 "그 자리까지의 앞부분" 항목을 씀. 읽을 때는 브레이크포인트에서');
console.log('  거꾸로 최대 20자리까지, 앞선 요청이 써 둔 항목을 찾음. 아래 해시는 그 규칙을 흉내 낸 것일 뿐입니다.');
const hashAt = (pos, n) =>
  createHash('sha256')
    .update(pos.slice(0, n).map((p) => p.json).join('\u0000'))
    .digest('hex')
    .slice(0, 12);
const store = new Map(); // 해시 → 쓴 요청 이름
/** 장난감 캐시에 요청 하나를 통과시킵니다. bps는 브레이크포인트 자리(1부터). */
function simulate(label, pos, bps = [pos.length]) {
  let best = 0;
  for (const bp of bps) {
    for (let n = bp; n >= Math.max(1, bp - 19); n--) {
      if (store.has(hashAt(pos, n))) {
        best = Math.max(best, n);
        break;
      }
    }
  }
  for (const bp of bps) store.set(hashAt(pos, bp), label);
  const sizeTo = (n) => pos.slice(0, n).reduce((s, p) => s + bytes(p.json), 0);
  const total = sizeTo(pos.length);
  const read = sizeTo(best);
  console.log(
    `  ${label.padEnd(30)} 자리 ${String(pos.length).padStart(2)}개, 브레이크포인트 ${bps.join('·').padEnd(5)}` +
      ` 읽음 ${best ? `자리 1~${best} (${read}B)` : '없음'.padEnd(14)}  쓴 몫 ${total - read}B`,
  );
}

// 다음 턴 요청: 1턴 답과 고객의 다음 말이 붙은 대화
respond = (_req, res) => void stream(res, TURN1_SSE);
await run(
  model,
  callCtx(agent, SAMPLE_CALL, [
    ['user', USER_1],
    ['assistant', TURN1_ANSWER.join('')],
    ['user', USER_2],
  ]),
  toolCtx,
);
const body2 = JSON.parse(seen.at(-1).body.toString('utf8'));
const p2 = positions(body2);
const firstDiff = (a, b) => a.findIndex((p, i) => !b[i] || b[i].json !== p.json);
console.log(`  1턴의 자리 ${p1.length}개가 2턴 요청의 앞 ${p1.length}자리와 같은가: ${firstDiff(p1, p2) === -1 ? '예 (바이트까지 같음)' : `아니요, 자리 ${firstDiff(p1, p2) + 1}에서 다름`}`);

// 다른 통화: 신청서 칸이 모두 빈 통화(metadata '{}'). 가상 고객 외의 이름은 쓰지 않습니다.
const otherCall = parseCallContext('{}');
const otherAgent = createAgent({ call: otherCall, llm: model, knowledge });
await run(model, callCtx(otherAgent, otherCall, [['user', USER_1]]), otherAgent.toolCtx);
const body3 = JSON.parse(seen.at(-1).body.toString('utf8'));
const p3 = positions(body3);
const d = firstDiff(p3, p1);
const a = body1.system[0].text;
const b = body3.system[0].text;
let k = 0;
while (k < a.length && a[k] === b[k]) k++;
console.log(`  다른 통화의 1턴 요청이 처음 달라지는 자리: ${d + 1} (${p3[d].name}), 지시문 ${k}번째 글자(${bytes(a.slice(0, k))}B), "${a.slice(k - 8, k + 6).replace(/\n/g, '⏎')}" 부근`);
console.log(`  지시문 전체 ${a.length}자 중 앞 ${k}자는 두 통화가 같음. 그러나 그 경계에는 브레이크포인트가 없음.\n`);

simulate('통화 A 1턴', p1);
simulate('통화 A 2턴', p2);
simulate('통화 B 1턴 (다른 고객)', p3);

// 제안 모양: 지시문을 [공통 지시][고객 정보] 두 블록으로 나누고 앞 블록에 명시 브레이크포인트를 더함.
// 플러그인은 system 메시지마다 블록을 하나 만들지만 cache_control은 붙이지 않으므로, 코드로 하려면 감싸는 클래스가
// 필요합니다(학습서 9장). 여기서는 자리 목록만 손으로 만듭니다.
function splitSystem(pos, body) {
  const text = body.system[0].text;
  const cut = text.indexOf('# 고객 정보');
  const head = { name: 'system[0] 공통 지시', json: JSON.stringify({ type: 'text', text: text.slice(0, cut) }) };
  const tail = { name: 'system[1] 고객 정보', json: JSON.stringify({ type: 'text', text: text.slice(cut) }) };
  const i = pos.findIndex((p) => p.name === 'system[0]');
  return [...pos.slice(0, i), head, tail, ...pos.slice(i + 1)];
}
store.clear();
console.log('  (제안) 지시문을 두 블록으로 나누고 공통 지시 끝에 명시 브레이크포인트를 둔 경우:');
const s1 = splitSystem(p1, body1);
const s3 = splitSystem(p3, body3);
const sysEnd = (pos) => pos.findIndex((p) => p.name === 'system[0] 공통 지시') + 1;
simulate('통화 A 1턴', s1, [sysEnd(s1), s1.length]);
simulate('통화 B 1턴 (다른 고객)', s3, [sysEnd(s3), s3.length]);

// ════════════════════════════════════════════════════════════════════
console.log('\n━━ 4) 응답: SSE 원문과 플러그인이 낸 ChatChunk (1번 요청의 응답) ━━');
console.log('  서버가 보낸 바이트 그대로 (왼쪽은 서버가 쓴 시각 ms, 요청 도착 기준):');
const reqT = req1.t;
for (const [t, chunk] of sent1) {
  const lines = chunk.split('\n');
  lines.forEach((line, i) => {
    if (i === lines.length - 1 && line === '') return;
    console.log(`  ${i === 0 ? String(Math.round(t - reqT)).padStart(5) : '     '} │ ${line}`);
  });
}
console.log('\n  플러그인이 낸 ChatChunk (왼쪽은 chat() 호출부터 ms):');
for (const { t, c } of r1.chunks) {
  console.log(`  ${String(Math.round(t - r1.started)).padStart(5)} │ ${JSON.stringify(c)}`);
}
const m1 = r1.metrics[0];
console.log(`  LiveKit 지표: ttftMs ${m1.ttftMs}, durationMs ${m1.durationMs}, promptTokens ${m1.promptTokens} (= input 0 + 쓰기 3530 + 읽기 0), promptCachedTokens ${m1.promptCachedTokens}, cacheCreationTokens ${m1.cacheCreationTokens}, completionTokens ${m1.completionTokens}`);

// 이벤트마다 시각 찍기: SDK 클라이언트를 Proxy로 감싸 messages.create의 스트림을 지나가며 기록합니다.
// 실제 API에 쓰면 머리글·message_start·첫 글 사이를 나눠 잴 수 있습니다(과금이라 이 실습은 가짜 서버만).
function timedClient(client, marks) {
  return new Proxy(client, {
    get(target, prop, recv) {
      if (prop !== 'messages') return Reflect.get(target, prop, recv);
      return {
        create: async (params, opts) => {
          const t0 = performance.now();
          const s = await target.messages.create(params, opts); // 응답 머리글이 오면 풀림
          marks.push(['응답 머리글', performance.now() - t0]);
          let firstText = true;
          return (async function* () {
            for await (const ev of s) {
              if (ev.type === 'message_start') marks.push(['message_start', performance.now() - t0]);
              if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && firstText) {
                marks.push(['첫 text_delta', performance.now() - t0]);
                firstText = false;
              }
              if (ev.type === 'message_stop') marks.push(['message_stop', performance.now() - t0]);
              yield ev;
            }
          })();
        },
      };
    },
  });
}
const marks = [];
const timed = voiceLLM({
  client: timedClient(new Anthropic({ apiKey: 'sk-ant-fake', baseURL: BASE, maxRetries: 0 }), marks),
});
respond = (_req, res) => void stream(res, TURN1_SSE);
const rt = await run(timed, callCtx(agent, SAMPLE_CALL, [['user', USER_1]]), toolCtx);
console.log('\n  시각 찍기 (messages.create 호출부터 ms):');
for (const [name, t] of marks) console.log(`    ${name.padEnd(14)} ${t.toFixed(1).padStart(7)}`);
console.log(`    LiveKit ttftMs ${rt.metrics[0].ttftMs} (LLMStream을 만든 순간부터 첫 글 청크까지, 재시도 대기도 포함)`);

// SDK의 SSE 해석: 이벤트 하나를 보내고 300ms 쉰 뒤 다음 이벤트를 보내면, 첫 이벤트는 언제 나오나.
// 0.33.1의 findDoubleNewlineIndex는 `i < buffer.length - 2`라 버퍼 맨 끝의 \n\n을 못 보고, 1.4.0은 `- 1`입니다.
console.log('\n  SSE 해석 비교: 서버가 이벤트 1개를 쓰고 300ms 쉰 뒤 다음 이벤트를 씀 (요청 도착부터 ms)');
for (const [label, Sdk] of [
  ['SDK 0.33.1 (Anthropic 플러그인)', Anthropic],
  ['SDK 1.4.0 (Bedrock SDK 밑)', Anthropic14],
]) {
  let reqAt = 0;
  respond = (_q, res) => {
    reqAt = performance.now();
    void stream(res, [
      [0, START('msg_lab_gap', { input_tokens: 9, output_tokens: 1 })],
      [300, sse({ type: 'message_stop' })],
    ]);
  };
  const client = new Sdk({ apiKey: 'sk-ant-fake', baseURL: BASE, maxRetries: 0 });
  const s = await client.messages.create({
    model: 'claude-haiku-5-5',
    max_tokens: 16,
    messages: [{ role: 'user', content: '(empty)' }],
    stream: true,
  });
  const got = [];
  for await (const ev of s) got.push(`${ev.type} ${Math.round(performance.now() - reqAt)}`);
  console.log(`    ${label.padEnd(32)} 서버가 쓴 시각: message_start 0, message_stop 300 → 받은 시각: ${got.join(', ')}`);
}

// ════════════════════════════════════════════════════════════════════
console.log('\n━━ 5) 오류와 재시도 (LiveKit 기본 연결 옵션: 최대 3회 재시도, 간격 0.1초 → 2초, 시도당 10초) ━━');
const CASES = [
  {
    name: 'HTTP 529 (과부하, 스트림 전)',
    respond: (_q, res) => {
      res.writeHead(529, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
    },
  },
  {
    name: 'HTTP 400 (요청 거절)',
    respond: (_q, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad field' } }));
    },
  },
  {
    name: '200 + SSE error (글 전)',
    respond: (_q, res) =>
      void stream(res, [
        [0, START('msg_lab_e', { input_tokens: 9, output_tokens: 1 })],
        [20, ERROR],
      ]),
  },
  {
    name: '200 + SSE error (글 뒤)',
    respond: (_q, res) =>
      void stream(res, [
        [0, START('msg_lab_e', { input_tokens: 9, output_tokens: 1 })],
        [0, sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })],
        [10, TEXT('스테인리스 텀블러도')],
        [20, ERROR],
      ]),
  },
  {
    name: '머리글 지연 1.5초 (시간 초과 0.5초로 줄여 실행)',
    conn: { maxRetry: 3, retryIntervalMs: 2000, timeoutMs: 500 },
    respond: (_q, res) => setTimeout(() => void stream(res, TURN1_SSE).catch(() => {}), 1500),
  },
  {
    name: '머리글 뒤 1.5초 멈춤 (시간 초과 0.5초로 줄여 실행)',
    conn: { maxRetry: 3, retryIntervalMs: 2000, timeoutMs: 500 },
    respond: (_q, res) =>
      void stream(res, [
        [0, START('msg_lab_s', { input_tokens: 9, output_tokens: 1 })],
        [0, sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })],
        [1500, TEXT('스테인리스 텀블러도')],
        [0, sse({ type: 'content_block_stop', index: 0 })],
        [0, sse({ type: 'message_stop' })],
      ]),
  },
  { name: '연결 거부 (닫힌 포트)', closedPort: true },
  {
    name: 'Bedrock 클라이언트 + HTTP 400',
    bedrock: true,
    respond: (_q, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'The model returned the following errors: bad field' }));
    },
  },
];

// 닫힌 포트: 잠깐 열었다 닫아 아무도 듣지 않는 포트 번호를 얻습니다.
const closedPort = await new Promise((r) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => r(port));
  });
});

for (const c of CASES) {
  respond = c.respond ?? (() => {});
  const before = seen.length;
  let m;
  if (c.bedrock) {
    const client = new AnthropicBedrock({
      awsRegion: 'ap-northeast-1',
      apiKey: null,
      maxRetries: 0,
      baseURL: BASE,
      awsAccessKey: 'AKIAFAKEFORLAB000000',
      awsSecretKey: 'fake-secret-for-lab',
    });
    m = voiceLLM({ model: 'jp.anthropic.claude-haiku-5-5', apiKey: undefined, client, prewarmUrl: BASE });
  } else {
    m = voiceLLM(c.closedPort ? { baseURL: `http://127.0.0.1:${closedPort}` } : {});
  }
  const r = await run(m, callCtx(agent, SAMPLE_CALL, [['user', USER_1]]), toolCtx, c.conn);
  const reqs = seen.slice(before).map((q) => Math.round(q.t - r.started));
  const text = r.chunks.map(({ c: ch }) => ch.delta?.content ?? '').join('');
  console.log(`\n  ▸ ${c.name}`);
  console.log(`    서버가 받은 요청 ${reqs.length}개, 시각(ms): ${reqs.join(', ') || '-'}${reqs[0] && seen.at(-1).url.startsWith('/model/') ? `  경로 ${seen.at(-1).url}` : ''}`);
  for (const e of r.errors) {
    const err = e.error;
    console.log(
      `    ${String(Math.round(e.t - r.started)).padStart(5)}ms 'error' 이벤트: ${err.name}` +
        `${err.statusCode !== undefined ? ` statusCode=${err.statusCode}` : ''} retryable=${err.retryable}` +
        ` recoverable=${e.recoverable}: ${String(err.message).slice(0, 70)}`,
    );
  }
  if (text) console.log(`    고객 쪽으로 이미 나간 글: "${text}"`);
  console.log(`    끝난 시각 ${Math.round(r.metrics[0]?.durationMs ?? NaN)}ms, ttftMs ${r.metrics[0]?.ttftMs}`);
}

server.close();
console.log('\n끝.');
