// 12장 실습: 역압(backpressure)이 실제로 걸리는지, 감싸는 방법에 따라 비교합니다 (학습서 12-3·12-4절).
//  1) 같은 비동기 제너레이터(10ms마다 조각 하나)를 ① 그대로 for await ② ReadableStream.from
//     ③ LiveKit의 toStream(@livekit/agents)으로 감싸고, 소비자가 조각마다 100ms씩 걸리게 해서
//     "생산한 시각"과 "소비한 시각"을 찍음
//  2) toStream과 같은 모양(start 안에서 끝까지 enqueue)의 스트림에서 controller.desiredSize가 어떻게 되는지
//  3) TransformStream 기본값(쓰기 쪽 HWM 1, 읽기 쪽 HWM 0)과 LiveKit IdentityTransform(HWM 최대)에서
//     읽는 사람이 없을 때 writer.desiredSize, writer.ready, write()가 어떻게 되는지
//  4) pipeThrough(이 레포의 pronunciationTransform)는 역압을 전하나: 당기기 소스 vs toStream 소스
//
// 실행 (레포 루트에서):  node docs/1-study/lab/12-backpressure.mjs   (약 4초)
// 기준: Node 24, @livekit/agents 1.9.5 (2026-11-06 작성)
// 키·네트워크·.env.local을 쓰지 않습니다. 시각은 ms이고 컴퓨터에 따라 몇 ms씩 다릅니다.
import { initializeLogger, stream as lkStream, toStream } from '@livekit/agents';
import { ReadableStream, TransformStream } from 'node:stream/web';
import { pronunciationTransform } from '../../../src/pronunciation.ts';

initializeLogger({ pretty: false, level: 'error' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const N = 6;

/** LLM 흉내: 10ms마다 조각 하나. 내보내는(yield) 순간의 시각을 기록합니다. */
function makeProducer(t0, produced) {
  return (async function* produce() {
    for (let i = 1; i <= N; i++) {
      await sleep(10);
      produced.push(Math.round(performance.now() - t0));
      yield `조각${i} `;
    }
  })();
}

/** TTS 흉내: 조각마다 100ms 걸리는 느린 소비자. */
async function consumeSlowly(iterable, t0, consumed) {
  for await (const chunk of iterable) {
    void chunk; // 내용은 쓰지 않고 시각만 찍음
    consumed.push(Math.round(performance.now() - t0));
    await sleep(100);
  }
}

const fmt = (xs) => xs.map((x) => String(x).padStart(4)).join('');

console.log('== 1. 같은 생산자(10ms마다), 느린 소비자(조각마다 100ms) ==');
for (const [label, wrap] of [
  ['① 제너레이터 그대로 (for await)', (g) => g],
  ['② ReadableStream.from(제너레이터)', (g) => ReadableStream.from(g)],
  ['③ toStream(제너레이터) (LiveKit)', (g) => toStream(g)],
]) {
  const produced = [];
  const consumed = [];
  const t0 = performance.now();
  await consumeSlowly(wrap(makeProducer(t0, produced)), t0, consumed);
  console.log(`   ${label}`);
  console.log(`     생산 시각(ms) ${fmt(produced)}`);
  console.log(`     소비 시각(ms) ${fmt(consumed)}`);
}

// ── 2. desiredSize ────────────────────────────────────────────────
console.log(
  '\n== 2. toStream과 같은 모양(start에서 끝까지 enqueue): 매 enqueue 뒤 controller.desiredSize ==',
);
{
  const sizes = [];
  const s = new ReadableStream({
    async start(controller) {
      for await (const chunk of makeProducer(performance.now(), [])) {
        controller.enqueue(chunk); // desiredSize를 보지 않고 넣음 (agents/utils.ts toStream과 같음)
        sizes.push(controller.desiredSize);
      }
      controller.close();
    },
  });
  await sleep(100); // 아무도 읽지 않는 100ms
  console.log(`   ${sizes.join(', ')}   (HWM 1 − 큐에 쌓인 조각 수)`);
  await s.cancel();
}

// ── 3. TransformStream 기본값과 IdentityTransform ───────────────────────
console.log('\n== 3. 읽는 사람이 없을 때 조각 3개를 await 없이 write ==');
for (const [label, ts] of [
  ['new TransformStream() 기본값', new TransformStream()],
  ['LiveKit IdentityTransform (HWM MAX_SAFE_INTEGER)', new lkStream.IdentityTransform()],
]) {
  const w = ts.writable.getWriter();
  // 아래 Promise들은 마지막 abort()에서 거부됩니다. void만 붙이고 거부를 받지 않으면 처리 안 된 거부로
  // 프로세스가 끝납니다(12-2절). 이 실습을 처음 쓸 때 실제로 그렇게 죽어서 두 번째 인자를 달았습니다.
  const ignore = () => {};
  let readyNow = false;
  void w.ready.then(() => (readyNow = true), ignore);
  await sleep(0);
  const before = `${w.desiredSize}, ready ${readyNow ? '풀림' : '대기'}`;
  const settled = [];
  for (const c of ['a', 'b', 'c']) void w.write(c).then(() => settled.push(c), ignore);
  readyNow = false;
  void w.ready.then(() => (readyNow = true), ignore);
  await sleep(20);
  console.log(`   ${label}`);
  console.log(
    `     쓰기 전 desiredSize ${before} → 3개 쓴 뒤 desiredSize ${w.desiredSize}, ` +
      `ready ${readyNow ? '풀림' : '대기'}, 끝난 write: [${settled.join(', ')}]`,
  );
  if (!readyNow) {
    const r = ts.readable.getReader();
    await r.read();
    await sleep(0);
    console.log(
      `     읽기 쪽에서 한 개 읽은 뒤 → desiredSize ${w.desiredSize}, 끝난 write: [${settled.join(', ')}]`,
    );
    r.releaseLock();
  }
  // 정리: 읽기 쪽을 cancel. (쓰기 쪽 abort()는 역압에 걸려 기다리는 write가 끝나기를 기다리므로 여기서 멈춥니다)
  await ts.readable.cancel().catch(ignore);
}

// ── 4. pipeThrough는 역압을 전하나 ───────────────────────────────────
console.log('\n== 4. 소스 → pronunciationTransform(pipeThrough) → 느린 소비자 ==');
for (const [label, wrap] of [
  ['당기기 소스 ReadableStream.from', (g) => ReadableStream.from(g)],
  ['밀어내기 소스 toStream', (g) => toStream(g)],
]) {
  const produced = [];
  const consumed = [];
  const t0 = performance.now();
  await consumeSlowly(pronunciationTransform(wrap(makeProducer(t0, produced))), t0, consumed);
  console.log(`   ${label}`);
  console.log(`     생산 시각(ms) ${fmt(produced)}`);
  console.log(`     소비 시각(ms) ${fmt(consumed)}`);
}
