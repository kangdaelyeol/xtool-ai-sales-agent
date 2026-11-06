// 5장 실습: 번들 Silero(@livekit/local-inference)를 SDK 없이 직접 불러 계약과 성질을 확인합니다.
//   1) 창 크기 계약: 정확히 512샘플(16kHz, 32ms)이 아니면 거부. 10ms 프레임 몇 개째에 창이 완성되는지
//   2) LSTM 상태: 같은 녹음을 "앞 창들을 기억하며" vs "창마다 reset()" 두 방식으로 판정
//   3) 속도: 창 하나 추론 시간과 실시간 계수, 두 핸들을 동시에 돌렸을 때
//
// 실행: 레포 루트에서  node docs/1-study/lab/05-silero-inside.mjs   (약 5초)
// 기준: Node.js 24, @livekit/agents 1.9.5, @livekit/local-inference 0.2.7, @livekit/rtc-node 1.2.1. 2026-11-06 작성.
//       키·네트워크·.env.local을 쓰지 않습니다. 속도는 실행한 컴퓨터마다 다릅니다.
import { AudioFrame, AudioResampler, AudioResamplerQuality, dispose } from '@livekit/rtc-node';
import { native, paddedSpeech } from './05-vad-run.mjs';

const W = native.VAD_WINDOW_SAMPLES;

// 1) 계약
console.log('1) 창 크기 계약');
console.log(`   VAD_WINDOW_SAMPLES = ${W} (16kHz에서 ${(W / 16000) * 1000}ms)`);
const probe = native.createVad();
for (const n of [511, 1024]) {
  try {
    await probe.predict(new Int16Array(n));
  } catch (e) {
    console.log(`   ${n}샘플 → ${e.constructor.name}: ${e.message}`);
  }
}

// SDK와 같은 방법으로 16kHz 창을 만듭니다: 24kHz 10ms 프레임 → QUICK 리샘플 → 512샘플씩 자름
const s = paddedSpeech(1);
const rs = new AudioResampler(s.rate, 16000, 1, AudioResamplerQuality.QUICK);
const parts = [];
const completedAt = []; // 창 k가 몇 번째 프레임에서 완성됐는지
let made = 0;
for (let i = 0; i + 240 <= s.pcm.length; i += 240) {
  for (const f of rs.push(new AudioFrame(s.pcm.slice(i, i + 240), s.rate, 1, 240))) {
    parts.push(f.data);
    made += f.samplesPerChannel;
  }
  while (made >= (completedAt.length + 1) * W) completedAt.push(i / 240 + 1);
}
rs.close();
console.log(
  `   창이 완성되는 프레임(10ms 프레임 번호): ${completedAt.slice(0, 10).join(', ')} … (계산 ⌈3.2k⌉ = 4, 7, 10, 13, 16 …)`,
);
const pcm16 = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
let off = 0;
for (const p of parts) {
  pcm16.set(p, off);
  off += p.length;
}
const windows = [];
for (let i = 0; i + W <= pcm16.length; i += W) windows.push(pcm16.slice(i, i + W));

// 2) LSTM 상태
const stateful = native.createVad();
const withState = [];
for (const w of windows) withState.push(await stateful.predict(w));
const fresh = native.createVad();
const noState = [];
for (const w of windows) {
  fresh.reset(); // 창마다 기억을 지움: 이 창 하나만 보고 판단
  noState.push(await fresh.predict(w));
}
const strip = (ps) =>
  ps.map((p) => (p >= 0.5 ? '#' : p > 0.35 ? '+' : p > 0.1 ? '.' : ' ')).join('');
console.log(`\n2) 같은 녹음 ${windows.length}창 (# ≥0.5, + 0.35~0.5, . 0.1~0.35)`);
console.log(`   이어서 판정 (한 핸들, 상태 유지)  |${strip(withState)}|`);
console.log(`   창마다 reset()                    |${strip(noState)}|`);
const diff = withState.map((p, i) => Math.abs(p - noState[i]));
const big = diff.filter((d) => d > 0.3).length;
console.log(
  `   두 방식의 차이: 평균 ${(diff.reduce((a, b) => a + b, 0) / diff.length).toFixed(3)}, 0.3 넘게 다른 창 ${big}개, ≥0.5인 창 ${withState.filter((p) => p >= 0.5).length}개 vs ${noState.filter((p) => p >= 0.5).length}개`,
);
const firstSpeech = withState.findIndex((p) => p >= 0.5);
console.log(
  `   말 시작 근처 창 ${firstSpeech - 1}~${firstSpeech + 2}: 이어서 ${withState
    .slice(firstSpeech - 1, firstSpeech + 3)
    .map((p) => p.toFixed(2))
    .join(' ')} / reset ${noState
    .slice(firstSpeech - 1, firstSpeech + 3)
    .map((p) => p.toFixed(2))
    .join(' ')}`,
);
// 같은 말소리 창 하나를 새 핸들에 여러 번 넣으면, 입력은 같아도 상태가 바뀌어 출력이 달라집니다.
const loud = windows[withState.indexOf(Math.max(...withState))];
const rep = native.createVad();
const reps = [];
for (let i = 0; i < 5; i++) reps.push((await rep.predict(loud)).toFixed(3));
console.log(`   같은 창을 새 핸들에 5번: ${reps.join(' ')}`);

// 3) 속도
const timer = native.createVad();
const times = [];
for (let k = 0; k < 10; k++) {
  for (const w of windows) {
    const t = performance.now();
    await timer.predict(w);
    times.push(performance.now() - t);
  }
}
times.sort((a, b) => a - b);
const med = times[Math.floor(times.length / 2)];
const p99 = times[Math.floor(times.length * 0.99)];
console.log(`\n3) 속도 (창 ${times.length}번, await 포함)`);
console.log(
  `   중앙 ${med.toFixed(3)}ms, 99% ${p99.toFixed(3)}ms, 최대 ${times[times.length - 1].toFixed(2)}ms → 실시간 계수(RTF) ${(med / 32).toFixed(4)}, 1초 분량(31창)에 약 ${(med * 31).toFixed(1)}ms`,
);
const a = native.createVad();
const b = native.createVad();
let t = performance.now();
for (const w of windows) await a.predict(w);
for (const w of windows) await b.predict(w);
const seq = performance.now() - t;
t = performance.now();
await Promise.all([
  (async () => {
    for (const w of windows) await a.predict(w);
  })(),
  (async () => {
    for (const w of windows) await b.predict(w);
  })(),
]);
const par = performance.now() - t;
console.log(
  `   두 핸들 ${windows.length}창씩: 차례로 ${seq.toFixed(1)}ms, 동시에 ${par.toFixed(1)}ms (동시가 짧으면 추론이 메인 스레드 밖에서 돈다는 뜻)`,
);

await dispose();
