// 4장 실습: 이벤트 루프가 막히면 타이머가 얼마나 늦는가, 네이티브 Promise는 왜 루프를 막지 않는가
//
// 실행: 레포 루트에서  node docs/1-study/lab/04-loop-block.mjs   (pnpm install 뒤)
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/local-inference 0.2.7. 2026-11-06 작성.
// 키·네트워크·.env.local을 쓰지 않습니다. 3번은 로컬 턴 감지·VAD 모델(네이티브 바인딩)을 이 컴퓨터에서 돌립니다.
// 측정값은 컴퓨터와 그때의 부하에 따라 달라집니다.
import { createRequire } from 'node:module';

const TICK = 20; // SDK 루프 감시와 같은 간격 (agents/telemetry/loop_monitor.ts DEFAULT_TICK_INTERVAL)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SDK와 같은 방식의 심장 박동: setTimeout을 이어 걸고, 예정보다 늦은 만큼을 지각(lag)으로 잰다
function startHeartbeat() {
  const lags = [];
  let last = performance.now();
  let timer;
  const tick = () => {
    const now = performance.now();
    lags.push(now - (last + TICK));
    last = now;
    timer = setTimeout(tick, TICK);
  };
  timer = setTimeout(tick, TICK);
  return () => {
    clearTimeout(timer);
    return lags;
  };
}
const max = (xs) => Math.max(0, ...xs);
const threadCpuMs = () => {
  const u = process.threadCpuUsage(); // 이 스레드(메인 = 이벤트 루프)만의 CPU 시간
  return (u.user + u.system) / 1000;
};
const processCpuMs = () => {
  const u = process.cpuUsage(); // 프로세스 전체(다른 스레드 포함)의 CPU 시간
  return (u.user + u.system) / 1000;
};

// ── 1. 아무 일도 없을 때 ──────────────────────────────────────────
let stop = startHeartbeat();
await sleep(500);
let lags = stop();
console.log(`== 1. 평상시: 20ms 박동 ${lags.length}번, 최대 지각 ${max(lags).toFixed(1)}ms ==`);

// ── 2. 300ms 바쁜 루프 (동기 CPU 작업) ───────────────────────────
stop = startHeartbeat();
await sleep(100);
const t0 = performance.now();
while (performance.now() - t0 < 300) {
  // 아무 일도 안 하고 CPU만 쓴다 (예: 메인 스레드에서 도는 무거운 계산)
}
await sleep(100);
lags = stop();
const worst = max(lags);
console.log(`\n== 2. 300ms 동기 작업: 최대 지각 ${worst.toFixed(1)}ms ==`);
console.log(`   그동안 10ms 오디오 프레임 ${Math.round(worst / 10)}개가 처리되지 못하고 쌓임`);
console.log(
  `   SDK 기준으로는 ${worst >= 500 ? '오류(500ms 이상)' : worst >= 100 ? '경고(100ms 이상)' : '보고 안 함'}`,
);

// ── 3. 네이티브 Promise: 계산은 다른 스레드에서 ─────────────────────
const require = createRequire(import.meta.url);
const fromAgents = createRequire(require.resolve('@livekit/agents'));
let li;
try {
  li = fromAgents('@livekit/local-inference');
} catch (error) {
  console.log(`\n3번 건너뜀: 이 플랫폼에서 @livekit/local-inference를 못 올림 (${error.message})`);
  process.exit(0);
}
li.initEot(); // 턴 감지 모델 적재 (추론 프로세스가 시작할 때 하는 일)

// 1.2초 분량 16kHz PCM (19,200샘플 = 38,400B). 내용은 의미 없는 사인파
const pcm = new Int16Array(19_200).map((_, i) => Math.round(3000 * Math.sin(i / 10)));
await li.predict(pcm); // 첫 호출 준비

stop = startHeartbeat();
let c0 = threadCpuMs();
let p0 = processCpuMs();
const times = [];
const w0 = performance.now();
for (let i = 0; i < 20; i++) {
  const t = performance.now();
  await li.predict(pcm);
  times.push(performance.now() - t);
}
const wall = performance.now() - w0;
lags = stop();
times.sort((a, b) => a - b);
console.log('\n== 3. 턴 감지 v1-mini predict() 20번 (네이티브 Promise) ==');
console.log(
  `   한 번: 중앙값 ${times[10].toFixed(1)}ms (최소 ${times[0].toFixed(1)}, 최대 ${times[19].toFixed(1)})`,
);
console.log(
  `   벽시계 ${wall.toFixed(0)}ms 동안 메인 스레드 CPU ${(threadCpuMs() - c0).toFixed(0)}ms, 프로세스 CPU ${(processCpuMs() - p0).toFixed(0)}ms`,
);
console.log(`   그동안 20ms 박동의 최대 지각 ${max(lags).toFixed(1)}ms`);

const vad = li.createVad();
const win = new Int16Array(li.VAD_WINDOW_SAMPLES).map((_, i) => Math.round(3000 * Math.sin(i / 10)));
c0 = threadCpuMs();
p0 = processCpuMs();
const v0 = performance.now();
for (let i = 0; i < 2000; i++) await vad.predict(win); // 32ms 창 2,000개 = 소리 64초 분량
const vWall = performance.now() - v0;
console.log(`\n== 4. Silero VAD predict() 2,000번 (창 ${li.VAD_WINDOW_SAMPLES}샘플 = 32ms) ==`);
console.log(
  `   벽시계 ${vWall.toFixed(0)}ms (한 번 ${((vWall / 2000) * 1000).toFixed(0)}µs), 메인 스레드 CPU ${(threadCpuMs() - c0).toFixed(0)}ms, 프로세스 CPU ${(processCpuMs() - p0).toFixed(0)}ms`,
);
