// 11장 실습: 발화 대기열(힙)과 mainTask 루프, SpeechHandle의 상태를 SDK의 실제 코드로 돌려 봅니다 (학습서 11-2절 깊이 보기).
//   1) scheduleSpeech가 힙에 넣는 값 [우선순위, hrtime]과 꺼내는 순서
//   2) mainTask 루프: 한 번에 하나씩 재생 허가 → 끝날 때까지 기다림.
//      say(그때 합성) / say(미리 합성) / LLM 답에서 TTS가 언제 시작하는지에 따라 생기는 틈
//   3) SpeechHandle 상태: 대기 중 중단, 끼어들 수 없는 발화의 interrupt(), 재생 중 중단과 감시 타이머(5초)
//
// 실행 (레포 루트에서):  node docs/1-study/lab/11-speech-queue.mjs   (약 11초, 3-2의 감시 타이머 5초 포함)
// 기준: Node 24, @livekit/agents 1.9.5 (2026-11-06). 키·네트워크·.env.local을 쓰지 않습니다.
// AgentActivity의 메서드(scheduleSpeech, mainTask)를 "가짜 this"로 부릅니다. SDK 자체 테스트
// (voice/agent_activity.test.ts, agent_activity_interrupt.test.ts)가 쓰는 방식과 같습니다. 발화마다 도는 작업
// (ttsTask, pipelineReplyTask)은 너무 많은 부품이 필요해, 기다리는 순서만 SDK와 같게 옮긴 짧은 함수로 대신합니다.
// 내부 파일(dist/voice/agent_activity.js, dist/utils.js)을 경로로 불러오므로 SDK 버전이 바뀌면 깨질 수 있습니다.
//
// 출처 (node_modules/@livekit/agents/src/ 기준)
//   힙 비교 함수          voice/agent_activity.ts 651~658 (아래 SDK_CMP로 그대로 옮김: 생성자 안에 있어 꺼낼 수 없음)
//   scheduleSpeech        voice/agent_activity.ts 5444~5468
//   mainTask              voice/agent_activity.ts 2919~2988
//   say의 대기            voice/agent_activity.ts 3601~3605 (재생 허가 + 끼어들 수 있으면 고객 조용함) → 그 뒤 TTS
//   LLM 답의 대기         voice/agent_activity.ts 4023~4057 (대기열에 들어감 → TTS 시작 4042~4049 → 재생 허가 + 조용함)
//   SpeechHandle          voice/speech_handle.ts 161~749, INTERRUPTION_TIMEOUT 56
import { createRequire } from 'node:module';
import { initializeLogger, voice } from '@livekit/agents';

initializeLogger({ pretty: false, level: 'silent' });

const base = import.meta.resolve('@livekit/agents'); // .../dist/index.js
const { AgentActivity } = await import(new URL('./voice/agent_activity.js', base));
const { Future, Event, Task } = await import(new URL('./utils.js', base));
const { Heap } = createRequire(new URL(base))('heap-js'); // SDK가 쓰는 힙 라이브러리 (pnpm이라 SDK 위치에서 빌려 옴)
const { SpeechHandle } = voice;
const { SPEECH_PRIORITY_LOW: LOW, SPEECH_PRIORITY_NORMAL: NORMAL, SPEECH_PRIORITY_HIGH: HIGH } =
  SpeechHandle;

// agent_activity.ts 656~658과 같은 비교 함수: 우선순위가 높은 쪽, 같으면 시각이 이른 쪽이 먼저.
const SDK_CMP = ([p1, t1], [p2, t2]) => (p1 === p2 ? t1 - t2 : p2 - p1);
const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (s, n) =>
  s + ' '.repeat(Math.max(0, n - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0x1100 ? 2 : 1), 0)));

/** SDK 테스트처럼 객체를 먼저 만들고 프로토타입만 AgentActivity로 바꿉니다(겟터를 자기 칸이 가리도록). */
function fakeActivity() {
  const act = {
    speechQueue: new Heap(SDK_CMP),
    q_updated: new Future(),
    _authorizationPaused: false,
    _currentSpeech: undefined,
    pausedSpeech: undefined,
    currentSpeechCleared: new Future(),
    _schedulingPaused: false,
    _mainTask: undefined,
    logger: silentLogger,
    getDrainPendingSpeechTasks: () => [],
  };
  Object.setPrototypeOf(act, AgentActivity.prototype);
  return act;
}
const schedule = (act, handle, priority) =>
  AgentActivity.prototype.scheduleSpeech.call(act, handle, priority);

// ── 1. 힙에 들어가는 값과 꺼내는 순서 ─────────────────────────────────────
console.log('1) scheduleSpeech가 힙에 넣는 [우선순위, hrtime]과 꺼내는 순서');
{
  const act = fakeActivity();
  const items = [
    ['고지 say()', NORMAL],
    ['질문 say()', NORMAL],
    ['(가정) LOW 안내', LOW],
    ['(가정) HIGH 긴급 안내', HIGH],
    ['즉시 반응 say()', NORMAL],
  ];
  const names = new Map();
  for (const [name, priority] of items) {
    const h = SpeechHandle.create();
    names.set(h, name);
    schedule(act, h, priority);
  }
  const all = act.speechQueue.toArray();
  const t0 = Math.min(...all.map(([, t]) => t));
  console.log('   넣은 순서대로:');
  for (const [p, t, h] of [...all].sort((a, b) => a[1] - b[1])) {
    console.log(`     ${pad(names.get(h), 24)} 우선순위 ${String(p).padStart(2)}  hrtime +${t - t0}ns`);
  }
  console.log('   꺼내는 순서: ' + all.map(() => names.get(act.speechQueue.pop()[2])).join(' → '));
  const now = Number(process.hrtime.bigint());
  console.log(
    `   hrtime을 Number로 바꿔 넣음: 지금 값이 안전한 정수인가 ${Number.isSafeInteger(now)} ` +
      `(2^53ns ≈ ${(2 ** 53 / 1e9 / 86400).toFixed(1)}일까지 ns 단위가 정확)`,
  );
}

// ── 2. mainTask 루프와 TTS 시작 시각 ─────────────────────────────────────
// 발화 작업을 흉내 냅니다. 기다리는 순서는 SDK와 같고, TTS·재생은 sleep으로 대신합니다.
let T0 = 0;
const log = [];
const at = (what) => log.push([Math.round(performance.now() - T0), what]);

/** say(): 재생 허가(+조용함)를 받은 뒤에야 TTS를 시작 (ttsTask 3601~3605). audio를 주면 TTS 없이 바로 재생. */
async function sayTask(h, name, { ttsMs, playMs, silence }) {
  const waits = [h._waitForAuthorization()];
  if (h.allowInterruptions && silence) waits.push(silence.wait());
  await h.waitIfNotInterrupted(waits);
  if (h.interrupted) {
    at(`${name}: 중단된 채 허가 대기에서 빠짐`);
    return h._markDone();
  }
  at(`${name}: 재생 허가${ttsMs ? ' → 이제 TTS 시작' : ' (미리 합성한 소리, TTS 없음)'}`);
  if (ttsMs) await sleep(ttsMs);
  at(`${name}: 첫 소리`);
  await sleep(playMs);
  at(`${name}: 재생 끝`);
  h._markDone();
}

/** LLM 답: 만들 때 LLM 시작, 대기열에 들어가면 TTS 시작, 재생은 허가(+조용함) 뒤 (pipelineReplyTask 4023~4057). */
async function replyTask(h, name, { llmTextAtMs, ttsMs, playMs, silence }) {
  const created = performance.now();
  await h.waitIfNotInterrupted([h._waitForScheduled()]);
  at(`${name}: 대기열에 들어감 → TTS 시작(첫 글이 오는 대로)`);
  const firstText = Math.max(performance.now(), created + llmTextAtMs);
  const audioReady = sleep(firstText + ttsMs - performance.now()).then(() =>
    at(`${name}: TTS 첫 음성 준비됨`),
  );
  const waits = [h._waitForAuthorization()];
  if (h.allowInterruptions && silence) waits.push(silence.wait());
  await h.waitIfNotInterrupted(waits);
  at(`${name}: 재생 허가`);
  await audioReady;
  at(`${name}: 첫 소리`);
  await sleep(playMs);
  at(`${name}: 재생 끝`);
  h._markDone();
}

async function runScenario(title, setup) {
  const act = fakeActivity();
  const ac = new AbortController();
  const loop = AgentActivity.prototype.mainTask.call(act, ac.signal); // SDK의 실제 루프
  log.length = 0;
  T0 = performance.now();
  const tasks = await setup(act);
  await Promise.all(tasks);
  ac.abort();
  await loop;
  console.log(`\n   ${title}`);
  for (const [t, what] of log) console.log(`   ${String(t).padStart(6)}ms  ${what}`);
}

console.log('\n2) mainTask 루프 (SDK 코드) + 발화 작업 흉내. TTS 첫 음성 170ms(13장), 시각은 실행마다 몇 ms 다름');

await runScenario('2-1. 첫 멘트 두 개: 고지(끼어들 수 없음, 800ms) → 질문(끼어들 수 있음, 그때 합성)', async (act) => {
  const silence = new Event();
  silence.set(); // 고객은 조용함
  const notice = SpeechHandle.create({ allowInterruptions: false });
  const question = SpeechHandle.create({ allowInterruptions: true });
  const tasks = [
    sayTask(notice, '고지', { ttsMs: 170, playMs: 800, silence }),
    sayTask(question, '질문', { ttsMs: 170, playMs: 300, silence }),
  ];
  schedule(act, notice, NORMAL);
  schedule(act, question, NORMAL);
  return tasks;
});

await runScenario('2-2. 같은 첫 멘트, 고객이 고지 위에 말하다가 1,100ms에 멈춤 (조용함은 그 192ms 뒤)', async (act) => {
  const silence = new Event(); // 고객이 말하는 중: 꺼져 있음
  const notice = SpeechHandle.create({ allowInterruptions: false });
  const question = SpeechHandle.create({ allowInterruptions: true });
  const tasks = [
    sayTask(notice, '고지', { ttsMs: 170, playMs: 800, silence }),
    sayTask(question, '질문', { ttsMs: 170, playMs: 300, silence }),
    sleep(1100 + 192).then(() => {
      at('고객 조용함 (userSilenceEvent 켜짐)');
      silence.set();
    }),
  ];
  schedule(act, notice, NORMAL);
  schedule(act, question, NORMAL);
  return tasks;
});

await runScenario(
  '2-3. 턴 확정 뒤: 즉시 반응(미리 합성, 400ms) → 본 답(선제 생성 재사용이라 글이 이미 있음)',
  async (act) => {
    const silence = new Event();
    silence.set();
    const ack = SpeechHandle.create({ allowInterruptions: true });
    const reply = SpeechHandle.create({ allowInterruptions: true });
    const tasks = [
      sayTask(ack, '즉시 반응', { ttsMs: 0, playMs: 400, silence }),
      replyTask(reply, '본 답', { llmTextAtMs: 0, ttsMs: 170, playMs: 300, silence }),
    ];
    schedule(act, ack, NORMAL); // 훅 안에서 먼저
    schedule(act, reply, NORMAL); // 훅이 끝난 뒤
    return tasks;
  },
);

await runScenario('2-4. (비교) 본 답을 say()처럼 허가 뒤에 합성했다면', async (act) => {
  const silence = new Event();
  silence.set();
  const ack = SpeechHandle.create({ allowInterruptions: true });
  const reply = SpeechHandle.create({ allowInterruptions: true });
  const tasks = [
    sayTask(ack, '즉시 반응', { ttsMs: 0, playMs: 400, silence }),
    sayTask(reply, '본 답(가정)', { ttsMs: 170, playMs: 300, silence }),
  ];
  schedule(act, ack, NORMAL);
  schedule(act, reply, NORMAL);
  return tasks;
});

// ── 3. SpeechHandle 상태 ────────────────────────────────────────────────
console.log('\n3) SpeechHandle 상태 (scheduled / 허가 / interrupted / done)');
const state = (h) =>
  `scheduled=${h.scheduled} 허가=${h._authorizedAt !== undefined} interrupted=${h.interrupted} done=${h.done()}`;
{
  const h = SpeechHandle.create();
  console.log(`   만든 직후              ${state(h)}`);
  const act = fakeActivity();
  schedule(act, h, NORMAL);
  console.log(`   scheduleSpeech 뒤      ${state(h)}`);
  h._authorizeGeneration(); // mainTask가 하는 일
  console.log(`   재생 허가 뒤           ${state(h)}`);
  h._markDone();
  console.log(`   _markDone 뒤           ${state(h)}`);

  const locked = SpeechHandle.create({ allowInterruptions: false });
  try {
    locked.interrupt();
  } catch (e) {
    console.log(`   끼어들 수 없는 발화 interrupt(): 예외 "${e.message}"`);
  }
  locked.interrupt(true);
  console.log(`   interrupt(true) 뒤     ${state(locked)}`);
  locked._markDone();
}

await runScenario('3-1. 대기 중에 중단된 발화: mainTask가 꺼내도 허가하지 않고 건너뜀', async (act) => {
  const silence = new Event();
  silence.set();
  const a = SpeechHandle.create({ allowInterruptions: true });
  const b = SpeechHandle.create({ allowInterruptions: true });
  const tasks = [
    sayTask(a, 'A', { ttsMs: 0, playMs: 300, silence }),
    sayTask(b, 'B', { ttsMs: 0, playMs: 300, silence }),
    sleep(100).then(() => {
      b.interrupt();
      at(`B.interrupt() → ${state(b)}`);
    }),
    sleep(450).then(() => at(`A가 끝나고 mainTask가 B를 꺼낸 뒤 → B ${state(b)}`)),
  ];
  schedule(act, a, NORMAL);
  schedule(act, b, NORMAL);
  return tasks;
});

await runScenario(
  '3-2. 재생 중 중단했는데 작업이 신호를 무시하면: 감시 타이머가 5초 뒤 끝낸 것으로 침',
  async (act) => {
    const c = SpeechHandle.create({ allowInterruptions: true });
    const d = SpeechHandle.create({ allowInterruptions: true });
    // 실제 SDK처럼 발화에 작업(Task)을 달아 둡니다(createSpeechTask 2686~2691). mainTask는 중단된 발화에
    // 작업이 남아 있으면 그 생성이 끝날 때까지 기다립니다(2959~2961). 이 작업은 취소 신호를 무시합니다.
    const stubborn = Task.from(async () => {
      await c._waitForAuthorization();
      at('C: 재생 허가 (이 작업은 중단·취소 신호를 보지 않고 10초 동안 붙잡음)');
      await sleep(10_000);
    });
    c._tasks.push(stubborn);
    const tasks = [
      sleep(100).then(() => {
        c.interrupt();
        at(`C.interrupt() → ${state(c)}`);
      }),
      (async () => {
        await c.waitForPlayout();
        at(`C: done (감시 타이머) → ${state(c)}`);
      })(),
      sayTask(d, 'D (C 뒤 대기)', { ttsMs: 0, playMs: 100 }),
    ];
    schedule(act, c, NORMAL);
    schedule(act, d, NORMAL);
    return tasks;
  },
);
process.exit(0); // 3-2의 10초짜리 sleep을 기다리지 않고 끝냄
