// 12장 실습: 취소가 스트림 사슬을 따라 거꾸로 올라가는 순서와 시각을 찍습니다 (학습서 12-8절 "취소의 전파").
//  1) 비동기 제너레이터에 return()을 보내는 두 경우: yield에서 멈춰 있을 때 / 상류를 await하는 중일 때
//  2) toStream(@livekit/agents)으로 감싼 스트림을 cancel하면: cancel()은 바로 끝나지만 상류는 다음 조각까지 돎.
//     ReadableStream.from으로 감싸면 cancel()이 return()이 끝날 때까지 기다림
//  3) ReadableStream을 for await로 읽다 break: 기본은 cancel, values({ preventCancel: true })면 안 함
//  4) SDK의 글 변환(voice.textTransforms.filterEmoji)처럼 cancel 처리기 없이 start에서 미는 스트림을 cancel하면
//  5) 실제 사슬: 가짜 Anthropic 서버 → VoiceAnthropicLLM → Agent.default.llmNode → withoutLeadingAck(src/ack.ts)
//     → toStream → generation.ts처럼 읽다가 끼어들기. 각 단계가 멈춘 시각과, 서버가 끝까지 썼는지
//
// 실행 (레포 루트에서):  node docs/1-study/lab/12-cancel.mjs   (약 11초)
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/agents-plugin-anthropic 1.9.5(@anthropic-ai/sdk 0.33.1) (2026-11-06)
// 키·.env.local·외부 네트워크를 쓰지 않습니다. apiKey는 가짜 문자열이고 baseURL을 127.0.0.1의 가짜 서버로 바꿉니다.
// 5번의 읽기 루프는 agents/voice/generation.ts performLLMInference(745~870)를 줄여 옮긴 것입니다(같은 순서로 부름).
// 시각은 ms이고 몇 ms씩 흔들립니다.
import { initializeLogger, llm, toStream, voice, waitForAbort } from '@livekit/agents';
import { createServer } from 'node:http';
import { ReadableStream } from 'node:stream/web';
import { withoutLeadingAck } from '../../../src/ack.ts';
import { VoiceAnthropicLLM } from '../../../src/models/anthropic.ts';

initializeLogger({ pretty: false, level: 'error' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clock() {
  const t0 = performance.now();
  const lines = [];
  const log = (s) =>
    lines.push(`${String(Math.round(performance.now() - t0)).padStart(6)}ms  ${s}`);
  return { log, print: () => lines.forEach((l) => console.log(`   ${l}`)) };
}

/** 300ms마다 조각을 내는 느린 상류. finally가 언제 도는지 기록합니다. */
async function* slowSource(log, pieces = ['네, ', '예산', '은 어느 정도', ' 생각하세요?']) {
  try {
    for (const p of pieces) {
      await sleep(300);
      log(`  상류: "${p}" 내보냄`);
      yield p;
    }
  } finally {
    log('  상류: finally (멈춤)');
  }
}

/** 상류를 for await로 읽어 그대로 내보내는 중간 단계. */
async function* passThrough(src, log) {
  try {
    for await (const x of src) yield x;
  } finally {
    log('  중간: finally (for await가 상류의 return()을 부른 뒤)');
  }
}

// ── 1. return()을 보내는 때 ────────────────────────────────────────────
console.log('== 1-A. 중간 단계가 yield에서 멈춰 있을 때 return() ==');
{
  const { log, print } = clock();
  const g = passThrough(slowSource(log), log);
  log(`next() → ${JSON.stringify((await g.next()).value)}`);
  log('return() 보냄');
  await g.return();
  log('return() 끝남');
  print();
}

console.log('\n== 1-B. 중간 단계가 상류를 await하는 중에 return() (next()가 걸려 있음) ==');
{
  const { log, print } = clock();
  const g = passThrough(slowSource(log), log);
  const pending = g.next().then((r) => log(`걸려 있던 next() → ${JSON.stringify(r.value)}`));
  await sleep(50);
  log('return() 보냄');
  await g.return();
  log('return() 끝남');
  await pending;
  print();
}

console.log('\n== 1-C. 이 레포의 withoutLeadingAck: 12자를 모으는 동안 return() ==');
{
  const { log, print } = clock();
  const g = withoutLeadingAck(slowSource(log));
  const pending = g.next().then((r) => log(`걸려 있던 next() → ${JSON.stringify(r.value)}`));
  await sleep(50);
  log('return() 보냄');
  await g.return();
  log('return() 끝남');
  await pending;
  print();
}

// ── 2. toStream의 cancel ────────────────────────────────────────────
for (const [label, wrap, who] of [
  ['toStream(@livekit/agents)', (g) => toStream(g), 'toStream의 cancel'],
  ['ReadableStream.from', (g) => ReadableStream.from(g), 'ReadableStream.from의 cancel'],
]) {
  console.log(`\n== 2. ${label}으로 감싼 스트림: 한 조각 읽고 400ms 뒤 cancel ==`);
  const { log, print } = clock();
  const g = passThrough(slowSource(log), log);
  const origReturn = g.return.bind(g);
  g.return = (v) => {
    log(`${who} → 제너레이터 return() 호출`);
    const p = origReturn(v);
    void p.then(() => log('제너레이터 return() 끝남'));
    return p;
  };
  const s = wrap(g);
  const reader = s.getReader();
  log(`read() → ${JSON.stringify((await reader.read()).value)}`);
  // generation.ts처럼 다음 read()를 걸어 둡니다. 잠금을 풀 때까지 채워지지 않으면 TypeError로 거부되므로
  // 받아 줍니다 (generation.ts에서는 ThrowsPromise.race가 받아 줌). 여기서는 둘째 조각이 먼저 채웁니다.
  reader.read().catch((e) => log(`걸려 있던 read() 거부: ${e.code ?? e.name}`));
  await sleep(400);
  reader.releaseLock();
  log('stream.cancel() 보냄');
  await s.cancel();
  log('stream.cancel() 끝남');
  await sleep(400);
  print();
}

// ── 3. for await + break ──────────────────────────────────────────
console.log('\n== 3. ReadableStream을 for await로 읽다 break ==');
for (const [label, iterate] of [
  ['for await (const x of stream)', (s) => s],
  [
    'for await (const x of stream.values({ preventCancel: true }))',
    (s) => s.values({ preventCancel: true }),
  ],
]) {
  let cancelled = false;
  const s = new ReadableStream({
    pull(c) {
      c.enqueue('조각');
    },
    cancel() {
      cancelled = true;
    },
  });
  for await (const chunk of iterate(s)) {
    void chunk;
    break;
  }
  console.log(
    `   ${label}: 원천 cancel ${cancelled ? '불림' : '안 불림'}, 스트림 잠김 ${s.locked}`,
  );
}

// ── 4. cancel 처리기가 없는 밀어내기 스트림 ─────────────────────────────
console.log('\n== 4. filterEmoji(SDK 글 변환)로 감싼 스트림: 한 조각 읽고 400ms 뒤 cancel ==');
{
  const { log, print } = clock();
  let n = 0;
  const source = new ReadableStream({
    async pull(c) {
      await sleep(300);
      n++;
      log(`  원천: 조각${n} 넣음`);
      c.enqueue(`조각${n} `);
    },
    cancel() {
      log('  원천: cancel 불림');
    },
  });
  const out = voice.textTransforms.filterEmoji(source); // text_transforms.ts 59~72의 감싸기를 씀
  const reader = out.getReader();
  log(`read() → ${JSON.stringify((await reader.read()).value)}`);
  await sleep(400);
  reader.releaseLock();
  log('stream.cancel() 보냄');
  await out.cancel();
  log(`stream.cancel() 끝남, 원천 잠김 ${source.locked}`);
  await sleep(400);
  log(`400ms 뒤 원천 잠김 ${source.locked}`);
  await sleep(400);
  print();
  await source.cancel();
}

// ── 5. 실제 사슬 ───────────────────────────────────────────────────
const sse = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
const head = [
  {
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
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
];
const tail = [
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
  { type: 'message_stop' },
];
const delta = (text) => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text },
});

let serverLog;
let script; // { firstDelayMs, gapMs, pieces }
const server = createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(head.map(sse).join(''));
    let closedEarly = false;
    res.on('close', () => {
      if (!res.writableFinished) {
        closedEarly = true;
        serverLog('서버: 클라이언트가 연결을 끊음');
      }
    });
    await sleep(script.firstDelayMs);
    for (const [i, p] of script.pieces.entries()) {
      if (closedEarly) return;
      if (i > 0) await sleep(script.gapMs);
      res.write(sse(delta(p)));
      // 첫 조각이 끝까지 붙잡히지 않게 ping을 덧붙임 (17-2 #36: SDK 0.33.1은 버퍼가 \n\n로 끝나면 이벤트를 붙잡음)
      res.write(sse({ type: 'ping' }));
    }
    res.end(tail.map(sse).join(''));
    serverLog(`서버: 조각 ${script.pieces.length}개를 끝까지 쓰고 응답을 마침`);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

const model = new VoiceAnthropicLLM({
  model: 'claude-haiku-5-5',
  apiKey: 'fake-key-for-lab',
  baseURL: `http://127.0.0.1:${server.address().port}`,
  effort: 'low',
  thinking: 'off',
});

async function interruptRun(label, s, interruptAtMs) {
  script = s;
  const { log, print } = clock();
  serverLog = log;
  console.log(`\n== 5. ${label} ==`);

  // LLMStream.close()가 불린 시각을 찍기 위해 chat()이 만든 스트림의 close만 감쌉니다.
  const origChat = model.chat.bind(model);
  model.chat = (args) => {
    const st = origChat(args);
    const close = st.close.bind(st);
    st.close = () => {
      log('LLMStream.close() (기본 llmNode 스트림의 cancel → abortController.abort)');
      close();
    };
    return st;
  };
  // Agent.default.llmNode가 쓰는 만큼만 흉내 낸 에이전트
  const fakeAgent = {
    getActivityOrThrow: () => ({
      llm: model,
      agentSession: {
        connOptions: { llmConnOptions: { maxRetry: 0, retryIntervalMs: 0, timeoutMs: 10_000 } },
      },
    }),
  };
  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({ role: 'system', content: '당신은 상담사입니다.' });
  chatCtx.addMessage({ role: 'user', content: '네, 괜찮아요.' });

  const nodeStream = await voice.Agent.default.llmNode(fakeAgent, chatCtx, undefined, {});
  const g = withoutLeadingAck(nodeStream);
  const origReturn = g.return.bind(g);
  g.return = (v) => {
    log('withoutLeadingAck.return() 호출 (toStream의 cancel이 부름)');
    const p = origReturn(v);
    void p.then(() => log('withoutLeadingAck.return() 끝남 (for await가 상류 return()을 부른 뒤)'));
    return p;
  };
  const llmStream = toStream(g); // agent_v2.ts 419: 사용자 llmNode의 반환값을 이렇게 감쌈

  // ── generation.ts performLLMInference의 읽기 루프 (줄임) ──
  const controller = new AbortController();
  setTimeout(() => {
    log('끼어들기: replyAbortController.abort()');
    controller.abort();
  }, interruptAtMs);
  const abortPromise = waitForAbort(controller.signal);
  const reader = llmStream.getReader();
  try {
    while (true) {
      if (controller.signal.aborted) break;
      const result = await Promise.race([reader.read(), abortPromise]);
      if (result === undefined) break;
      if (result.done) break;
      const chunk = result.value;
      log(`읽음: ${JSON.stringify(typeof chunk === 'string' ? chunk : chunk.delta?.content)}`);
    }
  } finally {
    reader.releaseLock();
    log('finally: llmStream.cancel() 보냄');
    await llmStream.cancel();
    log('finally: llmStream.cancel() 끝남 → 생성 작업 끝');
  }
  await sleep(s.firstDelayMs + s.gapMs * s.pieces.length + 300);
  model.chat = origChat;
  print();
}

// A: 통과 모드(12자 판단 뒤)에서 끼어들기. 조각 간격 200ms
await interruptRun(
  '통과 모드에서 끼어들기 (첫 조각 100ms, 이후 200ms 간격, 끼어들기 750ms)',
  {
    firstDelayMs: 100,
    gapMs: 200,
    pieces: [
      '네, ',
      '예산은 어느 정도로 ',
      '생각하세요? ',
      '할부도 ',
      '가능해요. ',
      '편하게 ',
      '말씀해 주세요.',
    ],
  },
  750,
);
// B: 첫 글이 나오기 전(TTFT) 끼어들기. 첫 조각이 800ms에 오고, 12자가 모이는 데 조각 3개
await interruptRun(
  '첫 글 전에 끼어들기 (첫 조각 800ms, 이후 150ms 간격, 끼어들기 300ms)',
  {
    firstDelayMs: 800,
    gapMs: 150,
    pieces: ['네, ', '알겠습니다. ', '예산', '은 어느 정도세요?', ' 편하게 ', '말씀해 주세요.'],
  },
  300,
);

server.close();
server.closeAllConnections();
