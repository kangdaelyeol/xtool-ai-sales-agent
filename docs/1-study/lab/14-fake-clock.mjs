// 14장 실습: 가짜 시계의 내부. vitest 4.1.12의 vi.useFakeTimers 아래에서 Promise 사슬과 타이머가 도는 순서
// (학습서 14-3절 "깊이 보기: 가짜 시계는 이벤트 루프의 어디를 바꾸나").
//  1) 기본 설정이 무엇을 가짜로 바꾸나: setTimeout·setImmediate·Date·performance.now·process.hrtime은 가짜,
//     process.nextTick·queueMicrotask는 진짜
//  2) src/call-guard.test.ts 첫 테스트를 단계별로: 실제 guardCall(src/call-guard.ts) + 가짜 세션.
//     단계마다 가짜 타이머 수·가짜 시각·endCall 횟수. advanceTimersByTimeAsync 판과 동기 advanceTimersByTime 판
//  3) "가짜 타이머 하나마다 진짜 setImmediate로 한 번 양보": 1초마다 await하는 루프를 5초 흘려보내면
//  4) 가짜 시계 아래의 setImmediate 양보와 performance.now() 측정
//
// 실행 (레포 루트에서):  node docs/1-study/lab/14-fake-clock.mjs   (약 1초, 대부분 vitest·SDK를 불러오는 시간)
// 기준: Node 24, vitest 4.1.12, @livekit/agents 1.9.5 (2026-11-06)
// 키·.env.local·네트워크를 쓰지 않습니다.
// vitest를 테스트 실행기 없이 불러 씁니다. vi는 첫 사용 때 실행기의 작업자 상태(globalThis.__vitest_worker__)에서
// 가짜 시계 설정을 읽으므로, 그 자리에 vitest 기본값(loopLimit 10000, shouldClearNativeTimers true,
// vitest/dist/chunks/defaults.*.js)만 넣어 둡니다. 공식 사용법이 아니므로 vitest를 올리면 깨질 수 있습니다.
// 실행기 안에서는 node:timers 모듈의 함수도 함께 바뀌지만, 여기서는 전역 함수만 바뀝니다.
// 같은 결과를 실제 vitest로도 확인했습니다(학습서 14-3절: 테스트를 레포 밖에 복사해 동기 판이 "Number of calls: 0"으로 실패).
import { EventEmitter } from 'node:events';
import { guardCall } from '../../../src/call-guard.ts';

globalThis.__vitest_worker__ = {
  config: { fakeTimers: { loopLimit: 10_000, shouldClearNativeTimers: true } },
};
const { vi } = await import('vitest');

// 가짜 시계를 켜기 전에 진짜를 잡아 둡니다(4번에서 "진짜 50ms"를 재려고).
const realSetTimeout = setTimeout;
const realSetImmediate = setImmediate;
const realPerformance = performance; // 가짜 시계는 전역 performance 객체를 통째로 바꿉니다
const realNow = () => realPerformance.now();
const realWait = (ms) => new Promise((r) => realSetTimeout(r, ms));

// ── 1. 무엇이 가짜가 되나 ─────────────────────────────────────────────
console.log('== 1. vi.useFakeTimers() 기본값이 바꾸는 것 ==');
const before = {
  setTimeout,
  setImmediate,
  setInterval,
  Date,
  'performance.now': performance.now,
  'process.hrtime': process.hrtime,
  'process.nextTick': process.nextTick,
  queueMicrotask,
};
vi.useFakeTimers();
const after = {
  setTimeout,
  setImmediate,
  setInterval,
  Date,
  'performance.now': performance.now,
  'process.hrtime': process.hrtime,
  'process.nextTick': process.nextTick,
  queueMicrotask,
};
for (const name of Object.keys(before)) {
  console.log(
    `   ${name.padEnd(17)} ${before[name] === after[name] ? '진짜 그대로' : '가짜로 바뀜'}`,
  );
}
const d0 = Date.now();
const p0 = performance.now();
await realWait(30);
console.log(
  `   진짜 30ms를 기다린 뒤: Date.now() 차 ${Date.now() - d0}ms, performance.now() 차 ${performance.now() - p0}ms` +
    ` (가짜 시계는 흘려보내기 전까지 멈춰 있음)`,
);
vi.useRealTimers();

// ── 2. call-guard 첫 테스트를 단계별로 ──────────────────────────────────
/** src/call-guard.test.ts의 fakeSession에서 이 흐름에 필요한 것만(on·say·userState). agentState가 없으면 guardCall은 "말하는 중 아님"으로 봅니다. */
function fakeSession() {
  const emitter = new EventEmitter();
  let finishPlayout = () => {};
  const session = Object.assign(emitter, {
    userState: 'listening',
    say() {
      const played = new Promise((resolve) => (finishPlayout = resolve));
      return { waitForPlayout: () => played };
    },
  });
  const calls = [];
  const endCall = async (_goodbye, reason) => void calls.push(reason);
  guardCall(session, endCall);
  return {
    calls,
    setUserState(newState) {
      const oldState = session.userState;
      session.userState = newState;
      emitter.emit('user_state_changed', { oldState, newState });
    },
    finishPlayout: () => finishPlayout(),
  };
}

async function walk(label, advance) {
  console.log(`\n   -- ${label} --`);
  vi.useFakeTimers();
  const t0 = Date.now();
  const row = (step) =>
    console.log(
      `   ${step.padEnd(52)} 타이머 ${vi.getTimerCount()}개, 가짜 시각 +${String(Date.now() - t0).padStart(5)}ms, endCall ${call.calls.length}번`,
    );
  const call = fakeSession();
  row('① fakeSession() → guardCall이 최대 길이 타이머(8분)를 검');
  call.setUserState('away');
  row("② setUserState('away') → say('여보세요?'), .then을 걺");
  call.finishPlayout();
  // guardCall의 .then 콜백은 resolve 순간 마이크로태스크 큐에 들어갔습니다. 그 뒤에 하나를 더 넣어 차례를 봅니다.
  queueMicrotask(() =>
    console.log(
      `   (마이크로태스크) 내 queueMicrotask가 돎. 그 앞에서 guardCall의 .then이 먼저 돌아 타이머 ${vi.getTimerCount()}개`,
    ),
  );
  row('③ finishPlayout() → .then은 아직 큐에 (안 돎)');
  const pending = advance();
  row('④ 흘려보내기를 부른 직후 (await 전)');
  await pending;
  row('⑤ 테스트가 await한 뒤');
  await realWait(5);
  row('⑥ 진짜 5ms 뒤 (큐가 다 빈 뒤)');
  vi.useRealTimers();
  return call.calls.length;
}

console.log('\n== 2. call-guard 첫 테스트: "여보세요?" 뒤 10초 무응답이면 끊는다 ==');
const asyncCalls = await walk('advanceTimersByTimeAsync(10_000) (테스트 원본)', () =>
  vi.advanceTimersByTimeAsync(10_000),
);
const syncCalls = await walk('advanceTimersByTime(10_000) (동기 판, 돌려주는 값은 숫자)', () =>
  vi.advanceTimersByTime(10_000),
);
console.log(
  `\n   결과: Async 판 endCall ${asyncCalls}번 → 통과,  동기 판 endCall ${syncCalls}번 → expect(...).toHaveBeenCalledWith 실패`,
);

// ── 3. 타이머 하나마다 한 번 양보 ────────────────────────────────────────
console.log('\n== 3. 1초마다 await하는 루프를 5초 흘려보내기 ==');
async function poller(ticks) {
  for (let i = 1; i <= 5; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ticks.push(i);
  }
}
for (const [label, advance] of [
  ['advanceTimersByTime(5000)', () => vi.advanceTimersByTime(5000)],
  ['advanceTimersByTimeAsync(5000)', () => vi.advanceTimersByTimeAsync(5000)],
]) {
  vi.useFakeTimers();
  const t0 = Date.now();
  const ticks = [];
  void poller(ticks);
  const r = advance();
  const right = ticks.length;
  await r;
  const afterAwait = ticks.length;
  await realWait(5);
  console.log(
    `   ${label.padEnd(32)} 부른 직후 ${right}번, 돌려준 값을 await한 뒤 ${afterAwait}번, 진짜 5ms 뒤 ${ticks.length}번 (가짜 시각 +${vi.getMockedSystemTime() - t0}ms, 남은 타이머 ${vi.getTimerCount()}개)`,
  );
  vi.useRealTimers();
}

// ── 4. setImmediate 양보와 performance.now ───────────────────────────────
console.log('\n== 4. 가짜 시계 아래의 setImmediate 양보와 지연 측정 ==');
vi.useFakeTimers();
let yielded = false;
const yieldOnce = new Promise((r) => setImmediate(r)).then(() => (yielded = true));
await realWait(50);
console.log(
  `   "await new Promise(r => setImmediate(r))"로 양보하는 코드: 진짜 50ms 뒤 풀림? ${yielded}  (setImmediate도 가짜)`,
);
await vi.advanceTimersByTimeAsync(0);
await yieldOnce;
console.log(
  `   advanceTimersByTimeAsync(0) 뒤 풀림? ${yielded}  (그래도 흘려보내기는 됨: 내부에서 설치 전의 진짜 setImmediate로 양보)`,
);
console.log(
  `   설치 전 setImmediate와 지금 setImmediate가 같은가? ${realSetImmediate === setImmediate}`,
);

async function measuredWork(waitMs) {
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, waitMs));
  return performance.now() - t0;
}
const r0 = realNow();
const m = measuredWork(300);
await vi.advanceTimersByTimeAsync(300);
console.log(
  `   performance.now()로 잰 "300ms 걸리는 일": 코드가 잰 값 ${await m}ms, 실제로 걸린 시간 ${(realNow() - r0).toFixed(1)}ms`,
);
vi.useRealTimers();
