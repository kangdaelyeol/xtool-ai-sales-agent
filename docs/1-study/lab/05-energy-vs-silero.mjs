// 5장 실습: 에너지 기준 VAD와 Silero(이 레포의 `inference.VAD`)를 같은 녹음에서 나란히 비교합니다.
// 깨끗한 녹음과, 같은 녹음에 −30dBFS 백색 잡음을 섞은 녹음을 각각 32ms 창 단위로 판정합니다.
// 듣기용 WAV는 임시 폴더($TMPDIR/xtool-study-02/)에 씁니다(레포에는 쓰지 않음).
//
// 실행: 레포 루트에서  node docs/1-study/lab/05-energy-vs-silero.mjs   (약 5초)
// 기준: Node.js 24, @livekit/agents 1.9.5, @livekit/local-inference 0.2.7. 2026-11-06 작성.
//       음성은 macOS `say -v Yuna`(없으면 합성 신호라 숫자가 달라짐). 키·네트워크·.env.local을 쓰지 않습니다.
import { dispose } from '@livekit/rtc-node';
import { writeWav } from './02-wav.mjs';
import { paddedSpeech, runVad } from './05-vad-run.mjs';

const FULL = 32768;
const WIN_IN = 768; // 24kHz 입력 기준 창 하나(= 16kHz 512샘플, 32ms). 2-4절 프레임 지도
const s = paddedSpeech(1);

// 같은 결과가 나오도록 씨앗을 고정한 난수(mulberry32)로 백색 잡음을 만듭니다.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function withNoise(pcm, dbfs) {
  const rand = rng(5);
  const rms = FULL * 10 ** (dbfs / 20); // −30dBFS → RMS 약 1,036
  const amp = rms * Math.sqrt(3); // 균등 분포 [−a, a]의 RMS는 a/√3
  return Int16Array.from(pcm, (v) =>
    Math.max(-32768, Math.min(32767, Math.round(v + (rand() * 2 - 1) * amp))),
  );
}
const noisy = withNoise(s.pcm, -30);
writeWav('vad-clean.wav', s.rate, s.pcm);
const noisyPath = writeWav('vad-noise-30dbfs.wav', s.rate, noisy);

/** 창마다 RMS를 dBFS로: 20·log10(RMS / 32768). 2-3절의 식과 같습니다. */
const windowDb = (pcm) => {
  const out = [];
  for (let i = 0; i + WIN_IN <= pcm.length; i += WIN_IN) {
    let e = 0;
    for (let j = 0; j < WIN_IN; j++) e += pcm[i + j] ** 2;
    out.push(10 * Math.log10(e / WIN_IN / FULL ** 2 + 1e-20));
  }
  return out;
};

// 정답 구간: 파형에 소리가 있는 창(깨끗한 녹음에서 −50dBFS 초과). 앞뒤 1초 무음은 정답이 "무음"입니다.
const cleanDb = windowDb(s.pcm);
const truth = cleanDb.map((d) => d > -50);

const silero = async (pcm) => {
  const ev = await runVad(pcm, s.rate);
  return {
    p: ev.filter((e) => e.type === 'INFER').map((e) => e.p),
    events: ev.filter((e) => e.type !== 'INFER').map((e) => `${e.type}@${e.t}`),
  };
};
const clean = await silero(s.pcm);
const noisyRes = await silero(noisy);

// 창 k는 [32k, 32k+32)ms. 앞뒤 1초(진짜 무음)와 말 구간을 나눠 셉니다. 말 구간 안의 쉼(파형이 조용한 창)은 따로 셉니다.
const inPad = (k) => (k + 1) * 32 <= s.speechStartMs || k * 32 >= s.speechStartMs + s.speechMs;
const score = (decisions) => {
  const c = { fa: 0, pad: 0, miss: 0, speech: 0, fill: 0, gap: 0 };
  decisions.forEach((d, k) => {
    if (k >= truth.length) return;
    if (inPad(k)) {
      c.pad++;
      if (d) c.fa++;
    } else if (truth[k]) {
      c.speech++;
      if (!d) c.miss++;
    } else {
      c.gap++;
      if (d) c.fill++;
    }
  });
  return `앞뒤 무음 헛탐지 ${String(c.fa).padStart(2)}/${c.pad}   소리 창 놓침 ${String(c.miss).padStart(2)}/${c.speech}   말 사이 쉼을 말로 봄 ${String(c.fill).padStart(2)}/${c.gap}`;
};
// 한글은 터미널에서 두 칸을 차지하므로 칸 수를 세어 맞춥니다(02-frame-map.mjs와 같은 방법).
const width = (t) => [...t].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x1100 ? 2 : 1), 0);
const pad = (t, n) => t + ' '.repeat(Math.max(0, n - width(t)));
const strip = (decisions) => decisions.map((d) => (d ? '#' : '.')).join('');

console.log(
  `녹음: 앞뒤 무음 1초 + 말 ${Math.round(s.speechMs)}ms (${s.source}), 32ms 창 ${truth.length}개`,
);
console.log(
  `정답(파형 −50dBFS 초과) 말소리 창 ${truth.filter(Boolean).length}개, 조용한 창 ${truth.filter((x) => !x).length}개`,
);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
for (const [label, db] of [
  ['깨끗함', cleanDb],
  ['−30dBFS 잡음', windowDb(noisy)],
]) {
  const q = db.filter((_, k) => inPad(k));
  const l = db.filter((_, k) => !inPad(k) && truth[k]).sort((a, b) => a - b);
  const quiet = avg(q) < -150 ? '디지털 0(−∞)' : `${avg(q).toFixed(1)}dBFS`;
  console.log(
    `  ${pad(label, 12)} 앞뒤 무음 창 평균 ${quiet}, 말소리 창 하위 10% ${l[Math.floor(l.length * 0.1)].toFixed(1)} / 중앙 ${l[Math.floor(l.length / 2)].toFixed(1)} / 최대 ${l[l.length - 1].toFixed(1)}dBFS`,
  );
}

console.log('\n창별 판정 (# 말소리, . 무음). 맨 앞 31창과 맨 뒤 30창이 붙인 무음 1초');
console.log(`  ${pad('정답(파형)', 24)} ${strip(truth)}`);
const noisyDb = windowDb(noisy);
const rows = [
  ['깨끗함 에너지 −45dBFS', cleanDb.map((d) => d > -45)],
  ['깨끗함 Silero ≥0.5', clean.p.map((p) => p >= 0.5)],
  ['잡음 에너지 −45dBFS', noisyDb.map((d) => d > -45)],
  ['잡음 에너지 −25dBFS', noisyDb.map((d) => d > -25)],
  ['잡음 Silero ≥0.5', noisyRes.p.map((p) => p >= 0.5)],
];
for (const [label, d] of rows) console.log(`  ${pad(label, 24)} ${strip(d)}`);
console.log('\n점수 (창 수)');
for (const [label, d] of rows) console.log(`  ${pad(label, 24)} ${score(d)}`);

console.log('\nSilero 사건 (히스테리시스·지속 시간 규칙까지 적용)');
console.log(`  깨끗함: ${clean.events.join(', ')}`);
console.log(`  잡음  : ${noisyRes.events.join(', ')}`);
// 앞 1초는 말이 오기 전의 잡음뿐입니다. 뒤 1초의 첫 창은 말 끝의 여운(모델이 한두 창 늦게 내려옴)이 섞입니다.
const lead = noisyRes.p.filter((_, k) => (k + 1) * 32 <= s.speechStartMs);
const tail = noisyRes.p.filter(
  (_, k) => k < truth.length && k * 32 >= s.speechStartMs + s.speechMs,
);
console.log(
  `  잡음 녹음의 Silero 확률: 앞 1초(잡음뿐) 최대 ${Math.max(...lead).toFixed(3)}, 뒤 1초 처음 3창 ${tail
    .slice(0, 3)
    .map((p) => p.toFixed(2))
    .join(' ')}, 그 뒤 최대 ${Math.max(...tail.slice(3)).toFixed(3)}`,
);
console.log(`\n들어 보기: ${noisyPath}`);

await dispose();
