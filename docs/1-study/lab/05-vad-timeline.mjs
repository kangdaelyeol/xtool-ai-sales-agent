// 5장 실습: 녹음 한 문장을 이 레포와 같은 VAD(`inference.VAD`, 기본값)에 넣고, 32ms 창마다 확률과 카운터를 찍어
// START_OF_SPEECH / END_OF_SPEECH가 어느 창에서 왜 나오는지 시간축으로 봅니다. 마지막에는 이벤트 루프가 막혔을 때
// 거꾸로 맞춘(back-dating) "마지막 말소리 시각"이 얼마나 틀어지는지 실시간으로 흘려 재 보고,
// 설정(minSilenceDuration 등)을 바꿨을 때 사건과 턴 감지 예측 요청 시점이 어떻게 바뀌는지 비교합니다.
//
// 실행: 레포 루트에서  node docs/1-study/lab/05-vad-timeline.mjs   (약 10초)
// 기준: Node.js 24, @livekit/agents 1.9.5, @livekit/local-inference 0.2.7. 2026-11-06 작성.
//       음성은 macOS `say -v Yuna`(없으면 합성 신호라 숫자가 달라짐). 키·네트워크·.env.local을 쓰지 않습니다.
//
// 규칙의 출처 (node_modules/@livekit/agents/src/ 기준)
//   창 판정·카운터     inference/vad.ts 366~417  (말 창이면 무음 카운터 0, 무음 창이면 말 카운터 0)
//   INFERENCE_DONE    inference/vad.ts 345~364  (카운터를 이번 창으로 갱신하기 "전" 값을 실음)
//   예측 요청 조건     voice/audio_recognition.ts 2196~2203, inference/eot/base.ts 23 (MIN_SILENCE_DURATION_MS = 200)
//   시각 거꾸로 맞춤   voice/audio_recognition.ts 2141·2223 (Date.now() − 길이 − inferenceDuration)
import { inference } from '@livekit/agents';
import { AudioFrame, dispose } from '@livekit/rtc-node';
import { NAME, SENTENCE, paddedSpeech, runVad } from './05-vad-run.mjs';

const ON = 0.5; // activationThreshold
const OFF = 0.35; // deactivationThreshold
const WIN = 32; // ms
const MIN_SPEECH = 50;
const MIN_SILENCE = 250;
// 한글은 터미널에서 두 칸을 차지하므로 칸 수를 세어 맞춥니다(02-frame-map.mjs와 같은 방법).
const padW = (t, n) =>
  t +
  ' '.repeat(Math.max(0, n - [...t].reduce((w, c) => w + (c.charCodeAt(0) > 0x1100 ? 2 : 1), 0)));

const s = paddedSpeech(1);
console.log(`녹음: "${SENTENCE}" (${s.source})`);
console.log(
  `      앞뒤 무음 1초 + 말 ${Math.round(s.speechMs)}ms = ${Math.round((s.pcm.length / s.rate) * 1000)}ms, 24kHz, 10ms(240샘플) 프레임으로 넣음`,
);

// 파형 기준으로 소리가 있는 구간(10ms 프레임 RMS > −50dBFS). VAD 판정과 비교하는 "정답" 역할입니다.
const f10 = s.rate / 100;
let waveOn = -1;
let waveOff = -1;
for (let i = 0; i + f10 <= s.pcm.length; i += f10) {
  let e = 0;
  for (let j = 0; j < f10; j++) e += s.pcm[i + j] ** 2;
  if (10 * Math.log10(e / f10 / 32768 ** 2 + 1e-20) > -50) {
    if (waveOn < 0) waveOn = (i / s.rate) * 1000;
    waveOff = ((i + f10) / s.rate) * 1000;
  }
}

const events = await runVad(s.pcm, s.rate);
const windows = events.filter((e) => e.type === 'INFER');

// SDK와 같은 규칙으로 창마다 "갱신 뒤" 카운터를 계산합니다. 다음 창의 INFERENCE_DONE이 싣는 값과 같아야 합니다.
let speaking = false;
let sp = 0;
let si = 0;
const rows = [];
for (const w of windows) {
  const isSpeech = w.p >= ON || (speaking && w.p > OFF);
  let ev = '';
  if (isSpeech) {
    sp += WIN;
    si = 0;
    if (!speaking && sp >= MIN_SPEECH) {
      speaking = true;
      ev = 'START';
    }
  } else {
    si += WIN;
    sp = 0;
    if (speaking && si >= MIN_SILENCE) {
      speaking = false;
      ev = 'END';
    }
  }
  // 예측 요청 조건: 실린 무음(갱신 전) ≥ 200 이고, 세션이 아직 '말하는 중'으로 알고 있음(= 이전 창까지의 상태)
  const predict = w.rawSilence >= 200 && w.speaking;
  rows.push({ ...w, isSpeech, sp, si, speaking, ev, predict });
}
let consistent = true;
for (let i = 1; i < rows.length; i++) {
  if (rows[i].rawSpeech !== rows[i - 1].sp || rows[i].rawSilence !== rows[i - 1].si)
    consistent = false;
}
const sdkEvents = events.filter((e) => e.type !== 'INFER');
const mine = rows.filter((r) => r.ev).map((r) => `${r.ev}@${r.t}`);
const theirs = sdkEvents.map((e) => `${e.type}@${e.t}`);
console.log(
  `\n창 ${windows.length}개 (32ms마다 1번). 규칙을 따라 계산한 카운터가 SDK가 다음 창에 싣는 값과 ${consistent ? '모두 일치' : '불일치'}`,
);
console.log(`사건: SDK ${theirs.join(', ')} / 직접 계산 ${mine.join(', ')}`);

// 1) 전체 시간축. 창 하나 = 글자 하나(32ms).
console.log('\n1) 시간축 (글자 하나 = 32ms 창)');
console.log('   확률: # ≥0.5   + 0.35~0.5   . 0.1~0.35   (빈칸) <0.1');
console.log('   상태: S 말하는 중   - 조용함      사건: ^ START   v END   p 턴 감지 예측 요청');
const PER_LINE = 64;
for (let i = 0; i < rows.length; i += PER_LINE) {
  const part = rows.slice(i, i + PER_LINE);
  const prob = part
    .map((r) => (r.p >= ON ? '#' : r.p > OFF ? '+' : r.p > 0.1 ? '.' : ' '))
    .join('');
  const state = part.map((r) => (r.speaking ? 'S' : '-')).join('');
  const mark = part
    .map((r) => (r.ev === 'START' ? '^' : r.ev === 'END' ? 'v' : r.predict ? 'p' : ' '))
    .join('');
  const t0 = part[0].t - WIN;
  console.log(`   ${String(t0).padStart(5)}ms |${prob}|`);
  console.log(`           |${state}|`);
  if (mark.trim()) console.log(`           |${mark}|`);
}

// 2) 사건 근처를 창 단위로 펼칩니다.
const table = (title, from, to) => {
  console.log(`\n${title}`);
  console.log('   창 구간(ms)   확률   판정  말카운터 무음카운터  실린raw무음  상태  사건');
  for (const r of rows.filter((x) => x.t > from && x.t <= to)) {
    console.log(
      `   ${String(r.t - WIN).padStart(5)}~${String(r.t).padEnd(5)}  ${r.p.toFixed(2)}   ${r.isSpeech ? '말 ' : '무음'}  ${String(r.sp).padStart(6)}  ${String(r.si).padStart(8)}  ${String(r.rawSilence).padStart(10)}    ${r.speaking ? 'S' : '-'}   ${r.ev}${r.predict ? (r.ev ? ' + ' : '') + '예측 요청' : ''}`,
    );
  }
};
const start = sdkEvents.find((e) => e.type === 'START');
const end = sdkEvents.find((e) => e.type === 'END');
table('2) 말 시작 근처', start.t - 5 * WIN, start.t + 2 * WIN);

// 말하는 중에 무음 창이 이어진 구간(말 중간 쉼)을 찾습니다.
const pauses = [];
let run = [];
for (const r of rows) {
  if (r.speaking && !r.isSpeech) run.push(r);
  else {
    // 말 창이 다시 와서 끝난 쉼만 셉니다. END로 끝난 마지막 무음은 쉼이 아닙니다.
    if (run.length && r.ev !== 'END') pauses.push(run);
    run = [];
  }
}
const longest = pauses.reduce((a, b) => (b.length > a.length ? b : a), []);
console.log(
  `\n3) 말 중간 쉼: 말하는 중 무음 창이 이어진 구간 ${pauses.length}곳, 길이(창) ${pauses.map((p) => p.length).join(', ')}. 모두 8창(256ms)에 못 미쳐 END 없음`,
);
table('   가장 긴 쉼 근처', longest[0].t - 2 * WIN, longest[longest.length - 1].t + 2 * WIN);
table('4) 말 끝 근처', end.t - 10 * WIN, end.t + WIN);

// 5) 사건이 싣는 값
console.log('\n5) 사건이 싣는 값');
console.log(
  `   START t=${start.t}ms  speechDuration=${start.speechDuration}ms  버퍼 ${start.frameSamples}샘플 = 프리픽스 ${0.5 * s.rate} + 768 × ${(start.frameSamples - 0.5 * s.rate) / 768}창`,
);
console.log(
  `   END   t=${end.t}ms  silenceDuration=${end.silenceDuration}ms  speechDuration=${end.speechDuration}ms  버퍼 ${end.frameSamples}샘플 = 프리픽스 ${0.5 * s.rate} + 768 × ${(end.frameSamples - 0.5 * s.rate) / 768}창`,
);
console.log(
  `   거꾸로 맞춘 시각(스트림 기준): 말 시작 ${start.t - start.speechDuration}ms, 마지막 말소리 ${end.t - end.silenceDuration}ms`,
);
console.log(`   파형 기준(10ms RMS > −50dBFS): 소리 시작 ${waveOn}ms, 소리 끝 ${waveOff}ms`);

// 6) 실시간으로 흘리면서 이벤트 루프를 막아 봅니다. 세션처럼 사건을 받는 순간의 Date.now()로 거꾸로 맞춥니다.
//    말 끝 직전(4.5초)까지는 빨리 넣고, 그 뒤는 10ms마다 실제 시간에 맞춰 넣습니다.
async function realtimeTail(blockAtMs, blockMs) {
  const vad = new inference.VAD();
  const stream = vad.stream();
  const frame = s.rate / 100;
  const fast = Math.round((4500 / 1000) * s.rate);
  for (let i = 0; i < fast; i += frame)
    stream.pushFrame(new AudioFrame(s.pcm.slice(i, i + frame), s.rate, 1, frame));
  const got = [];
  got.maxInf = 0;
  let t0 = 0;
  const consume = (async () => {
    for await (const ev of stream) {
      if (NAME[ev.type] === 'END') {
        const now = Date.now();
        got.push({ now, ev, backdated: now - ev.silenceDuration - ev.inferenceDuration });
        return;
      }
      if (NAME[ev.type] === 'INFER' && ev.inferenceDuration > got.maxInf)
        got.maxInf = ev.inferenceDuration;
    }
  })();
  await new Promise((r) => setTimeout(r, 300)); // 앞부분 처리가 끝나기를 기다림
  t0 = Date.now() - 4500; // 녹음 4.5초 지점 = 지금
  let blocked = false;
  for (let i = fast; i + frame <= s.pcm.length; i += frame) {
    const due = t0 + ((i + frame) / s.rate) * 1000; // 이 프레임의 끝이 "도착"할 시각
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (!blocked && blockMs > 0 && ((i + frame) / s.rate) * 1000 >= blockAtMs) {
      blocked = true;
      const until = Date.now() + blockMs;
      while (Date.now() < until); // 동기 작업이 이벤트 루프를 붙잡는 상황
    }
    stream.pushFrame(new AudioFrame(s.pcm.slice(i, i + frame), s.rate, 1, frame));
    if (got.length) break;
  }
  await Promise.race([consume, new Promise((r) => setTimeout(r, 1000))]);
  stream.close();
  const g = got[0];
  return {
    backdatedMs: g.backdated - t0,
    eventAtMs: g.now - t0,
    inf: g.ev.inferenceDuration,
    maxInf: got.maxInf,
  };
}

console.log(
  '\n6) 실시간으로 흘리며 거꾸로 맞춘 "마지막 말소리" 시각 (녹음 시각 기준, 창 기준 정답 = END − 256)',
);
const truth = end.t - end.silenceDuration;
for (const [label, at, ms] of [
  ['막힘 없음', 0, 0],
  ['4,950ms에 300ms 막힘', 4950, 300],
]) {
  const r = await realtimeTail(at, ms);
  console.log(
    `   ${padW(label, 22)} END 처리 ${Math.round(r.eventAtMs)}ms → 거꾸로 맞춘 값 ${Math.round(r.backdatedMs)}ms (정답 ${truth}ms, 오차 ${Math.round(r.backdatedMs - truth) >= 0 ? '+' : ''}${Math.round(r.backdatedMs - truth)}ms), END 창 inferenceDuration ${r.inf.toFixed(2)}ms, 창 하나 최대 ${r.maxInf.toFixed(2)}ms`,
  );
}

// 7) 설정을 바꾸면 사건과 예측 요청 시점이 어떻게 달라지는지 같은 녹음으로 봅니다.
//    예측 요청은 조건이 처음 참이 되는 창 하나에서만 나갑니다(요청 중이면 다시 안 냄).
console.log('\n7) 설정별 사건과 예측 요청 (같은 녹음)');
for (const opts of [
  {},
  { minSilenceDuration: 400 },
  { minSilenceDuration: 200 },
  { minSpeechDuration: 100 },
  { prefixPaddingDuration: 0 },
]) {
  const ev = await runVad(s.pcm, s.rate, opts);
  const st = ev.find((e) => e.type === 'START');
  const en = ev.find((e) => e.type === 'END');
  const req = ev.find((e) => e.type === 'INFER' && e.rawSilence >= 200 && e.speaking);
  const label = Object.keys(opts).length ? JSON.stringify(opts).replace(/[{}"]/g, '') : '기본값';
  console.log(
    `   ${padW(label, 26)} START@${st.t}(버퍼 ${st.frameSamples})  END@${en.t}(무음 ${en.silenceDuration})  예측 요청 ${req ? `@${req.t} (END보다 ${en.t - req.t}ms 앞)` : '없음'}`,
  );
}

await dispose();
