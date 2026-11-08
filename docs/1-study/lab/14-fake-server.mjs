// 14장 실습: 가짜 서버 테스트를 넓히기. 시간·취소·바이트를 시험에 넣으면 무엇이 잡히나
// (학습서 14-3절 "깊이 보기: 가짜 서버 테스트의 한계와 확장").
//  1) 시간: 가짜 서버가 SSE 이벤트를 res.write로 하나씩 정해진 시각에 씀 → VoiceAnthropicLLM의 글 조각이 언제 나오나.
//     SDK 0.33.1의 SSE 분리기(17-2 #36) 때문에 조각이 "다음 이벤트를 쓴 시각"에 나옴.
//     같은 시각표에 이벤트마다 SSE 주석 한 줄(": k\n")만 덧붙이면 제때 나옴(원인 확인)
//  2) 취소: 첫 글 조각을 받자마자 LLMStream.close() → 서버 쪽에서 응답이 끝까지 쓰였나, 연결이 먼저 닫혔나 (17-2 #41).
//     비교: 같은 SDK 0.33.1을 직접 쓰고 for await에서 break하면
//  3) 바이트: 응답의 한글을 글자 중간에서 잘라 두 번에 씀 → res.text가 깨지지 않나.
//     요청 쪽: 본문이 커지면 서버의 data 이벤트가 몇 번으로 나뉘고, raw += chunk(anthropic.test.ts 55~56행)에서
//     U+FFFD가 생기나 (17-2 #45)
//  4) 같은 시험을 fetch 주입으로(src/models/index.test.ts 방식): 바이트 경계를 정확히 정할 수 있지만 소켓은 없음
//
// 실행 (레포 루트에서):  node docs/1-study/lab/14-fake-server.mjs   (약 6초)
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/agents-plugin-anthropic 1.9.5(@anthropic-ai/sdk 0.33.1) (2026-11-06)
// 키·.env.local·외부 네트워크를 쓰지 않습니다. apiKey는 가짜 문자열이고 baseURL은 127.0.0.1의 가짜 서버입니다.
// 가짜 서버의 SSE는 src/models/anthropic.test.ts처럼 손으로 만든 것이라, 실제 API의 형식과 같다는 보장은 없습니다.
// 시각은 ms이고 몇 ms씩 흔들립니다.
import { initializeLogger, llm } from '@livekit/agents';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { SAMPLE_CALL } from '../../../src/call-context.ts';
import { VoiceAnthropicLLM } from '../../../src/models/anthropic.ts';
import { buildInstructions } from '../../../src/prompt.ts';

initializeLogger({ pretty: false, level: 'error' });

// 플러그인이 쓰는 SDK 0.33.1은 레포 루트에서 안 보이므로(pnpm) 플러그인 위치에서 빌려 옵니다(2번 비교, 4번).
const Anthropic = (
  await import(
    pathToFileURL(
      createRequire(import.meta.resolve('@livekit/agents-plugin-anthropic')).resolve(
        '@anthropic-ai/sdk',
      ),
    ).href
  )
).default;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ms = (t) => `${String(Math.round(t)).padStart(5)}ms`;
const sse = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const START = sse({
  type: 'message_start',
  message: {
    id: 'msg_lab',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-haiku-5-5',
    stop_reason: null,
    usage: { input_tokens: 10, output_tokens: 1 },
  },
});
const BLOCK = sse({
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'text', text: '' },
});
const DELTA = (text) =>
  sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const END =
  sse({ type: 'content_block_stop', index: 0 }) +
  sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }) +
  sse({ type: 'message_stop' });

// ── 가짜 서버: 요청마다 도착 시각, data 이벤트, 응답이 끝까지 쓰였는지를 기록 ──────────────────
let respond = () => {};
let last;
const server = createServer((req, res) => {
  const info = { at: performance.now(), dataEvents: 0, sizes: [], raw: '', chunks: [], written: 0 };
  last = info;
  res.on('finish', () => (info.finishAt ??= performance.now()));
  res.on('close', () => (info.closeAt ??= performance.now()));
  req.on('data', (chunk) => {
    info.dataEvents++;
    info.sizes.push(chunk.length);
    info.raw += chunk; // anthropic.test.ts와 같은 모양: 조각마다 UTF-8 디코드
    info.chunks.push(chunk);
  });
  req.on('end', () => {
    info.body = Buffer.concat(info.chunks).toString();
    respond(req, res, info);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r)); // 포트 0: 운영체제가 빈 포트를 고름
const baseURL = `http://127.0.0.1:${server.address().port}`;

/** plan = [[요청 도착 뒤 ms, 쓸 문자열 또는 Buffer], ...]. 클라이언트가 먼저 끊으면 거기서 멈춤. */
async function play(res, info, plan) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [at, data] of plan) {
    const wait = at - (performance.now() - info.at);
    if (wait > 0) await sleep(wait);
    if (info.closeAt) break;
    res.write(data);
    info.written++;
  }
  if (!info.closeAt) res.end();
}

const chatCtx = (system = '당신은 상담사입니다.') => {
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ role: 'system', content: system });
  ctx.addMessage({ role: 'user', content: '네' });
  return ctx;
};
const model = (extra = {}) =>
  new VoiceAnthropicLLM({
    model: 'claude-haiku-5-5',
    apiKey: 'test',
    baseURL,
    effort: 'low',
    thinking: 'off',
    ...extra,
  });

// ── 1. 시간 ───────────────────────────────────────────────────────────
console.log('== 1. 서버가 쓴 시각 vs 플러그인이 글 조각을 내놓은 시각 (요청 도착 기준) ==');
for (const [label, tail] of [
  ['이벤트를 하나씩 씀', ''],
  ['이벤트마다 SSE 주석 ": k\\n"을 덧붙임', ': k\n'],
]) {
  const plan = [
    [0, START + BLOCK + tail],
    [200, DELTA('네, ') + tail],
    [400, DELTA('예산은 어느 정도 생각하세요?') + tail],
    [600, END],
  ];
  respond = (_req, res, info) => void play(res, info, plan);
  const got = [];
  for await (const chunk of model().chat({ chatCtx: chatCtx() })) {
    if (chunk.delta?.content)
      got.push(`"${chunk.delta.content}" ${ms(performance.now() - last.at)}`);
  }
  console.log(`   ${label}`);
  console.log(`     서버가 쓴 시각: "네, " 200ms, "예산은…" 400ms, 끝 600ms`);
  console.log(`     받은 시각:     ${got.join(',  ')}`);
}

// ── 2. 취소 ───────────────────────────────────────────────────────────
console.log('\n== 2. 첫 글 조각을 받자마자 취소: 서버는 끝까지 썼나 ==');
const cancelPlan = [[0, START + BLOCK]];
for (let i = 0; i < 8; i++) cancelPlan.push([100 + i * 100, DELTA(`조각${i + 1} `)]);
cancelPlan.push([950, END]);
const report = (label, cancelAt, info) => {
  const closedEarly = info.closeAt !== undefined && info.finishAt === undefined;
  console.log(
    `   ${label}\n     취소 ${ms(cancelAt - info.at)} → 서버가 쓴 묶음 ${info.written}/${cancelPlan.length}, ` +
      `finish ${info.finishAt ? ms(info.finishAt - info.at) : '없음'}, close ${info.closeAt ? ms(info.closeAt - info.at) : '없음'}` +
      ` → ${closedEarly ? '클라이언트가 연결을 먼저 끊음' : '응답을 끝까지 씀'}`,
  );
};
{
  respond = (_req, res, info) => void play(res, info, cancelPlan);
  const stream = model().chat({ chatCtx: chatCtx() });
  let cancelAt;
  for await (const chunk of stream) {
    if (chunk.delta?.content) {
      cancelAt = performance.now();
      stream.close(); // 끼어들기·선제 생성 취소 때 SDK가 부르는 것과 같은 메서드 (12-8절 ⑦)
      break;
    }
  }
  const info = last;
  await sleep(1200);
  report('플러그인 경로 (VoiceAnthropicLLM → LLMStream.close())', cancelAt, info);
}
{
  respond = (_req, res, info) => void play(res, info, cancelPlan);
  const client = new Anthropic({ apiKey: 'test', baseURL, maxRetries: 0 });
  const s = await client.messages.create({
    model: 'claude-haiku-5-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: '네' }],
    stream: true,
  });
  let cancelAt;
  for await (const ev of s) {
    if (ev.type === 'content_block_delta') {
      cancelAt = performance.now();
      break; // SDK의 Stream은 finally에서 controller.abort() (sdk/streaming.ts 83~84)
    }
  }
  const info = last;
  await sleep(1200);
  report('비교: SDK 0.33.1을 직접 쓰고 for await에서 break', cancelAt, info);
}

// ── 3. 바이트 ─────────────────────────────────────────────────────────
console.log('\n== 3-A. 응답의 한글을 글자 중간에서 잘라 두 번에 씀 (20ms 간격) ==');
const RESPONSE = Buffer.from(START + BLOCK + DELTA('네, 좋아요.') + END);
const textAt = RESPONSE.indexOf(Buffer.from('네, 좋아요.'));
const cuts = [];
for (const [i, ch] of [...'네, 좋아요.'].entries()) {
  const off = textAt + Buffer.byteLength([...'네, 좋아요.'].slice(0, i).join(''));
  if (Buffer.byteLength(ch) === 3)
    cuts.push([`"${ch}" 1바이트 뒤`, off + 1], [`"${ch}" 2바이트 뒤`, off + 2]);
}
let okCount = 0;
for (const [, cut] of cuts) {
  respond = (_req, res, info) =>
    void play(res, info, [
      [0, RESPONSE.subarray(0, cut)],
      [20, RESPONSE.subarray(cut)],
    ]);
  const r = await model().chat({ chatCtx: chatCtx() }).collect();
  if (r.text === '네, 좋아요.') okCount++;
  else console.log(`     틀림: ${JSON.stringify(r.text)}`);
}
console.log(
  `   자른 자리 ${cuts.length}곳(${cuts.map(([l]) => l).join(', ')}) 중 res.text가 "네, 좋아요."인 경우 ${okCount}/${cuts.length}`,
);

console.log('\n== 3-B. 요청 본문이 커지면: 서버의 data 이벤트와 raw += chunk ==');
respond = (_req, res, info) => void play(res, info, [[0, RESPONSE]]);
const instructions = buildInstructions(SAMPLE_CALL);
const filler = '예산은 어느 정도 생각하세요? 할부도 가능합니다. ';
for (const [label, system] of [
  ['실제 지시문 (buildInstructions, 지식 없음)', instructions],
  ['지시문 + 한글 약 64KB', instructions + filler.repeat(1000)],
  ['지시문 + 한글 약 256KB', instructions + filler.repeat(4200)],
  ['지시문 + 한글 약 1MB', instructions + filler.repeat(17000)],
]) {
  await model()
    .chat({ chatCtx: chatCtx(system) })
    .collect();
  const info = last;
  const fffd = [...info.raw].filter((c) => c === '�').length;
  let parsed = 'JSON.parse 성공';
  try {
    JSON.parse(info.raw);
  } catch {
    parsed = 'JSON.parse 실패';
  }
  const sizes =
    info.sizes.length <= 4
      ? info.sizes.join(', ')
      : `${info.sizes.slice(0, 3).join(', ')}, … (${info.sizes.length}개)`;
  console.log(
    `   ${label.padEnd(30)} 본문 ${String(Buffer.byteLength(info.body)).padStart(7)}바이트, data ${String(info.dataEvents).padStart(2)}번 [${sizes}]` +
      `  raw += chunk: U+FFFD ${fffd}개, ${parsed}`,
  );
}

// ── 4. fetch 주입 ─────────────────────────────────────────────────────
console.log('\n== 4. 같은 시험을 fetch 주입으로 (네트워크 없음) ==');
function fakeFetch(plan, record) {
  return async (url, init) => {
    record.url = String(url);
    record.bodyType = typeof init.body;
    record.body = JSON.parse(init.body);
    record.signal = init.signal;
    const t0 = performance.now();
    let i = 0;
    const body = new ReadableStream({
      async pull(controller) {
        if (i >= plan.length) return controller.close();
        const [at, bytes] = plan[i++];
        const wait = at - (performance.now() - t0);
        if (wait > 0) await sleep(wait);
        record.pulled = i;
        controller.enqueue(bytes);
      },
      cancel() {
        record.cancelled = true;
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}
{
  // 4-A. 응답을 1바이트씩 쪼개 흘림: TCP라면 합쳐질 수 있는 경계를 정확히 정할 수 있음
  const plan = [...RESPONSE].map((b) => [0, new Uint8Array([b])]);
  const record = {};
  const m = model({
    client: new Anthropic({ apiKey: 'test', fetch: fakeFetch(plan, record), maxRetries: 0 }),
  });
  const r = await m.chat({ chatCtx: chatCtx() }).collect();
  console.log(
    `   4-A. 응답 ${RESPONSE.length}바이트를 1바이트 조각 ${plan.length}개로: res.text ${JSON.stringify(r.text)}`,
  );
  console.log(
    `        요청 본문은 fetch에 문자열(typeof ${record.bodyType})로 넘어옴 → 바이트로 나뉘는 일 자체가 없음 (thinking=${JSON.stringify(record.body.thinking)})`,
  );
}
{
  // 4-B. 취소: 첫 글 뒤 close() → 응답 스트림의 cancel이 불리나, fetch에 넘어온 signal이 abort되나
  const plan = cancelPlan.map(([at, s]) => [at, new TextEncoder().encode(s)]);
  const record = {};
  const m = model({
    client: new Anthropic({ apiKey: 'test', fetch: fakeFetch(plan, record), maxRetries: 0 }),
  });
  const stream = m.chat({ chatCtx: chatCtx() });
  for await (const chunk of stream) {
    if (chunk.delta?.content) {
      stream.close();
      break;
    }
  }
  await sleep(1200);
  console.log(
    `   4-B. 첫 글 뒤 LLMStream.close(): 응답 스트림 pull ${record.pulled}/${plan.length}번, cancel 불림 ${record.cancelled === true}, ` +
      `fetch에 넘어온 signal.aborted ${record.signal?.aborted}`,
  );
}

server.close();
