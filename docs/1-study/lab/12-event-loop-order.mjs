// 12장 실습: 이벤트 루프의 단계와 큐 순서를 출력으로 봅니다 (학습서 12-2절 "깊이 보기").
//  1) 동기 코드 · process.nextTick · Promise.then · queueMicrotask · setImmediate · setTimeout 0 을
//     다섯 자리(CommonJS 맨 위, ESM 맨 위, I/O 콜백, 타이머 콜백, await 뒤)에서 걸고 실행 순서를 비교
//  2) 큐를 비우는 중에 새로 넣은 일은 언제 도나: nextTick 안의 then, then 안의 nextTick
//  3) 메인 모듈에서 setTimeout 0과 setImmediate 중 무엇이 먼저냐는 시작 시각에 달림 (자식 프로세스 20번씩)
//  4) 마이크로태스크가 루프를 굶김: 끝없는 then 사슬 200ms 동안 20ms 타이머와 I/O가 못 돎.
//     같은 일을 setImmediate로 쪼개면 타이머가 끼어듦
//  5) 기다리지 않은 Promise의 거부: 핸들러가 없으면 프로세스가 끝나고, 잡 프로세스처럼 핸들러를 달면 살아남음
//
// 실행 (레포 루트에서):  node docs/1-study/lab/12-event-loop-order.mjs   (약 3초)
// 기준: Node 24, @livekit/agents 1.9.5 (2026-11-06 작성)
// 키·네트워크·.env.local을 쓰지 않습니다. 3번은 같은 Node로 작은 자식 프로세스를 20번 띄웁니다.
// 4번의 숫자는 컴퓨터와 그때의 부하에 따라 달라집니다.
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 다섯 가지 예약을 같은 자리에서 걸고, 실행된 순서를 돌려줍니다. */
function scheduleAll(log) {
  setTimeout(() => log('setTimeout 0'), 0);
  setImmediate(() => log('setImmediate'));
  Promise.resolve().then(() => log('Promise.then'));
  queueMicrotask(() => log('queueMicrotask'));
  process.nextTick(() => log('process.nextTick'));
  log('동기 코드 (예약한 함수의 끝)');
}

function run(label, starter) {
  return new Promise((resolve) => {
    const order = [];
    const log = (name) => {
      order.push(name);
      if (order.length === 6) resolve({ label, order });
    };
    starter(() => scheduleAll(log));
  });
}

// ESM 모듈 맨 위(첫 await 전)는 여기서 바로 겁니다. 출력은 아래에서 함께 합니다.
// (자식 프로세스를 띄우는 spawnSync는 루프를 수십 ms 막으므로, 이 결과를 받은 뒤에 부릅니다.)
const esmTop = await run('ESM 모듈 맨 위 (첫 await 전)', (go) => go());

// CommonJS 메인 모듈 맨 위는 자식 프로세스로 봅니다 (.mjs 파일은 ESM이라)
function cjsTop() {
  const code = `const order = [];
const log = (s) => { order.push(s); if (order.length === 6) console.log(JSON.stringify(order)); };
${scheduleAll.toString()}
scheduleAll(log);`;
  const out = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' }).stdout;
  return { label: 'CommonJS 메인 모듈 맨 위 (node -e)', order: JSON.parse(out) };
}

console.log('== 1. 같은 다섯 가지 예약, 거는 자리만 다름 ==');
const here = fileURLToPath(import.meta.url);
for (const { label, order } of [
  cjsTop(),
  esmTop,
  // I/O 콜백(poll 단계) 안: 다음은 check(setImmediate) → timers(setTimeout) 순으로 결정적
  await run('fs.readFile 콜백 안 (poll 단계)', (go) => readFile(here, go)),
  // 타이머 콜백(timers 단계) 안: setImmediate는 다음 check, setTimeout 0은 그다음 timers
  await run('setTimeout 콜백 안 (timers 단계)', (go) => setTimeout(go, 5)),
  // await 뒤의 코드는 마이크로태스크 안에서 돈다 → 새 then이 nextTick보다 먼저
  await run('fs.readFile 콜백 안의 await 뒤 (마이크로태스크 안)', (go) =>
    readFile(here, async () => {
      await Promise.resolve();
      go();
    }),
  ),
]) {
  console.log(`   ${label}`);
  console.log(`     ${order.join(' → ')}`);
}

// ── 2. 큐 안에서 새로 넣은 일 ───────────────────────────────────────
console.log('\n== 2. 큐를 비우는 중에 새로 넣으면 (I/O 콜백 안에서 시작) ==');
await new Promise((resolve) => {
  readFile(here, () => {
    const out = [];
    const log = (s) => out.push(s);
    process.nextTick(() => {
      log('tick A');
      Promise.resolve().then(() => log('then (tick A가 넣음)'));
      process.nextTick(() => log('tick B (tick A가 넣음)'));
    });
    Promise.resolve().then(() => {
      log('then 1');
      process.nextTick(() => log('tick C (then 1이 넣음)'));
      Promise.resolve().then(() => log('then 2 (then 1이 넣음)'));
    });
    setImmediate(() => {
      out.forEach((s, i) => console.log(`     ${i + 1}. ${s}`));
      resolve();
    });
  });
});
console.log('   → nextTick 큐를 다 비우고, 마이크로태스크 큐를 다 비우고, 둘 다 빌 때까지 반복');

// ── 3. 메인 모듈에서의 경주 ─────────────────────────────────────────
console.log('\n== 3. CommonJS 메인 모듈에서 setTimeout 0 vs setImmediate, 각 20번 실행 ==');
const race =
  "setTimeout(() => process.stdout.write('T'), 0); setImmediate(() => process.stdout.write('I'));";
// 2ms 바쁜 루프: 루프가 처음 타이머를 볼 때 1ms(setTimeout 0의 실제 최소값)가 이미 지나 있게 함
const busy = 'const s = performance.now(); while (performance.now() - s < 2) {}';
for (const [label, code] of [
  ['그대로', race],
  ['예약 뒤 2ms 바쁜 루프', `${race} ${busy}`],
]) {
  const tally = { TI: 0, IT: 0 };
  for (let i = 0; i < 20; i++) {
    tally[spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' }).stdout]++;
  }
  console.log(`   ${label}: setTimeout 먼저 ${tally.TI}번, setImmediate 먼저 ${tally.IT}번`);
}
console.log(
  '   → 루프가 처음 타이머를 확인할 때 1ms가 지났는지에 달림 (Node 문서: 순서 보장 없음)',
);

// ── 4. 마이크로태스크 굶김 ──────────────────────────────────────────
console.log('\n== 4. 200ms 동안 일을 잘게 나눠 계속 예약하기 ==');
async function starve(label, scheduleNext) {
  const lags = [];
  let last = performance.now();
  let timer;
  const tick = () => {
    const now = performance.now();
    lags.push(now - (last + 20));
    last = now;
    timer = setTimeout(tick, 20);
  };
  timer = setTimeout(tick, 20);
  let ioDoneAt;
  const t0 = performance.now();
  readFile(here, () => (ioDoneAt = performance.now() - t0)); // 파일 읽기 완료 콜백(poll 단계)
  let steps = 0;
  await new Promise((resolve) => {
    const step = () => {
      steps++;
      const s = performance.now();
      while (performance.now() - s < 0.05) {
        // 한 조각 = 50µs 계산
      }
      if (performance.now() - t0 < 200) scheduleNext(step);
      else resolve();
    };
    scheduleNext(step);
  });
  const endAt = performance.now() - t0;
  await sleep(60);
  clearTimeout(timer);
  console.log(
    `   ${label}: 조각 ${steps.toLocaleString('en-US')}개, 20ms 박동 ${lags.length}번, 최대 지각 ${Math.max(0, ...lags).toFixed(1)}ms, ` +
      `파일 읽기 콜백 ${ioDoneAt.toFixed(1)}ms (일이 끝난 시각 ${endAt.toFixed(1)}ms)`,
  );
}
await starve('then 사슬     ', (f) => Promise.resolve().then(f));
await starve('nextTick 사슬 ', (f) => process.nextTick(f));
await starve('setImmediate  ', (f) => setImmediate(f));
console.log(
  '   → 마이크로태스크·nextTick은 "지금 단계가 끝나기 전"에 다 비우므로 끝없이 넣으면 루프가 못 넘어감',
);

// ── 5. 처리 안 된 거부 ─────────────────────────────────────────────────
console.log('\n== 5. 기다리지 않은 Promise가 거부되면 (자식 프로세스) ==');
const fireAndForget = `
async function sendResult() { throw new Error('결과 전송 실패'); }
sendResult(); // await도 .catch()도 없음
setTimeout(() => console.log('   (100ms 뒤에도 살아 있음)'), 100);`;
for (const [label, prelude] of [
  ['핸들러 없음 (Node 기본값)', ''],
  [
    '잡 프로세스처럼 핸들러를 담 (agents/ipc/job_proc_lazy_main.ts 326)',
    "process.on('unhandledRejection', (r) => console.log('   [debug] Unhandled promise rejection:', r.message));",
  ],
]) {
  const r = spawnSync(process.execPath, ['-e', prelude + fireAndForget], { encoding: 'utf8' });
  const firstErr = r.stderr.split('\n').find((l) => /^Error\b/.test(l)) ?? '';
  console.log(`   ${label}: 종료 코드 ${r.status}`);
  if (r.stdout.trim()) console.log(r.stdout.trimEnd());
  if (firstErr) console.log(`   stderr: ${firstErr.trim()}`);
}
