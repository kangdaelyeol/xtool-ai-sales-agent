// 2장 실습: 스펙트로그램과 멜 대역을 손으로 계산해 ASCII로 그립니다.
// 같은 음성을 16kHz 원본과 "8kHz로 내렸다가 다시 16kHz로 올린 것"(전화 대역)으로 나란히 봅니다.
//
// 실행: 레포 루트에서  node docs/1-study/lab/02-spectrogram.mjs
// 기준: @livekit/rtc-node 1.2.1(리샘플러만 씀), @livekit/agents 1.9.5 기준 레포. 2026-11-05 작성.
//       창·홉·FFT 크기는 음성 인식에서 흔한 값입니다. 키·네트워크·.env.local을 쓰지 않습니다.
import { AudioFrame, AudioResampler, AudioResamplerQuality, dispose } from '@livekit/rtc-node';
import { koreanSpeech } from './02-wav.mjs';

const RATE = 16000;
const WIN = 400; // 25ms
const HOP = 160; // 10ms
const NFFT = 512; // 400샘플 뒤에 0을 112개 붙여 2의 거듭제곱으로
const BINS = NFFT / 2 + 1; // 257개, 간격 16000/512 = 31.25Hz
const N_MELS = 80;

function resample(pcm, from, to) {
  const r = new AudioResampler(from, to, 1, AudioResamplerQuality.VERY_HIGH);
  const out = [...r.push(new AudioFrame(pcm, from, 1, pcm.length)), ...r.flush()];
  r.close();
  return Int16Array.from(out.flatMap((f) => [...f.data]));
}

/** 제자리 반복형 radix-2 FFT. re, im은 길이 NFFT 배열. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j], im[i], im[j]] = [re[j], re[i], im[j], im[i]]; // 비트 뒤집기 순서로
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        [re[b], im[b]] = [re[a] - tr, im[a] - ti];
        [re[a], im[a]] = [re[a] + tr, im[a] + ti];
      }
    }
  }
}

const hann = Float64Array.from(
  { length: WIN },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN),
);

/** 단시간 푸리에 변환: 창마다 빈 257개의 파워. */
function stft(x) {
  const frames = [];
  for (let s = 0; s + WIN <= x.length; s += HOP) {
    const re = new Float64Array(NFFT);
    const im = new Float64Array(NFFT);
    for (let i = 0; i < WIN; i++) re[i] = (x[s + i] / 32768) * hann[i];
    fft(re, im);
    frames.push(Float64Array.from({ length: BINS }, (_, k) => re[k] ** 2 + im[k] ** 2));
  }
  return frames;
}

// 멜 필터뱅크: 멜 축에서 같은 간격으로 82개 점을 찍고, 이웃한 세 점으로 삼각형 80개를 만듭니다.
const mel = (f) => 2595 * Math.log10(1 + f / 700);
const imel = (m) => 700 * (10 ** (m / 2595) - 1);
const edges = Array.from({ length: N_MELS + 2 }, (_, i) =>
  imel((mel(RATE / 2) * i) / (N_MELS + 1)),
);
function melEnergies(power) {
  return edges.slice(1, -1).map((center, b) => {
    const [lo, hi] = [edges[b], edges[b + 2]];
    let e = 0;
    for (let k = 0; k < BINS; k++) {
      const f = (k * RATE) / NFFT;
      if (f > lo && f < hi)
        e += power[k] * (f < center ? (f - lo) / (center - lo) : (hi - f) / (hi - center));
    }
    return 10 * Math.log10(e + 1e-10); // 로그 멜
  });
}

/** 세로 = 주파수(500Hz 칸 16줄), 가로 = 시간(60ms 칸). 가장 센 칸 대비 dB를 글자 농도로. */
function draw(title, frames) {
  const shades = ' .:-=+*#%@';
  const rows = 16;
  const group = 6;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    cells.push([]);
    for (let t = 0; t + group <= frames.length; t += group) {
      let e = 0;
      for (let g = 0; g < group; g++)
        for (let k = r * 16; k < (r + 1) * 16; k++) e += frames[t + g][k];
      cells[r].push(10 * Math.log10(e + 1e-12));
    }
  }
  const top = Math.max(...cells.flat());
  console.log(`\n${title}`);
  for (let r = rows - 1; r >= 0; r--) {
    const line = cells[r]
      .map((db) => shades[Math.max(0, Math.min(9, Math.floor((db - top + 60) / 6)))])
      .join('');
    console.log(`${String(r * 500).padStart(5)}Hz |${line}`);
  }
}

const { rate, pcm, source } = koreanSpeech();
const wide = resample(pcm, rate, RATE);
const phone = resample(resample(pcm, rate, 8000), 8000, RATE);
// 기준선: 값이 모두 0인 소리(디지털 무음)를 같은 길로 왕복한 것. 리샘플러가 16비트로 반올림하며
// 섞는 디더(±1)만 남으므로, 왕복본의 4kHz 위가 이 값과 같으면 "말소리가 전혀 남지 않았다"는 뜻입니다.
const silence = resample(resample(new Int16Array(pcm.length), rate, 8000), 8000, RATE);

console.log(
  `설정: 창 ${WIN}샘플(${(WIN / RATE) * 1000}ms) Hann, 홉 ${HOP}(${(HOP / RATE) * 1000}ms), ` +
    `FFT ${NFFT}점 → 빈 ${BINS}개, 간격 ${RATE / NFFT}Hz`,
);
console.log(
  `멜: m(1000Hz) = ${mel(1000).toFixed(0)}, m(4000Hz) = ${mel(4000).toFixed(0)}, m(8000Hz) = ${mel(8000).toFixed(0)}`,
);
const firstAbove4k = edges.slice(1, -1).findIndex((c) => c >= 4000);
console.log(
  `80개 대역의 중심: 1번 ${edges[1].toFixed(0)}Hz, 40번 ${edges[40].toFixed(0)}Hz, 80번 ${edges[80].toFixed(0)}Hz` +
    ` → 4kHz 위 대역은 ${firstAbove4k + 1}번부터 ${N_MELS - firstAbove4k}개`,
);
console.log(`음성: ${source}`);

for (const [name, x, picture] of [
  ['16kHz 원본', wide, true],
  ['8kHz 왕복본(전화 대역)', phone, true],
  ['디지털 무음을 같은 길로 왕복한 것(기준선)', silence, false],
]) {
  const frames = stft(x);
  if (picture) draw(`${name}: 창 ${frames.length}개`, frames);
  else console.log(`\n${name}: 창 ${frames.length}개 (그림은 빈칸뿐이라 생략)`);
  const logMel = frames.map(melEnergies);
  const avg = (from, to) =>
    logMel.reduce((s, m) => s + m.slice(from, to).reduce((a, b) => a + b, 0) / (to - from), 0) /
    logMel.length;
  console.log(
    `   로그 멜 평균: 4kHz 아래 대역 ${avg(0, firstAbove4k).toFixed(1)}dB, 4kHz 위 대역 ${avg(firstAbove4k, N_MELS).toFixed(1)}dB`,
  );
}

// 원본에서 4kHz 위 성분이 차지하는 에너지. 빈 1~128(31.25~4,000Hz)과 129~256(4,031~8,000Hz)을 견줍니다.
let below = 0;
let above = 0;
for (const power of stft(wide)) {
  for (let k = 1; k <= 128; k++) below += power[k];
  for (let k = 129; k < BINS; k++) above += power[k];
}
console.log(
  `\n원본에서 4kHz 위 성분의 에너지: 아래의 ${((above / below) * 100).toFixed(1)}%` +
    ` (${(10 * Math.log10(above / below)).toFixed(1)}dB). 이것이 빠지면 전체 크기가` +
    ` ${(10 * Math.log10((below + above) / below)).toFixed(2)}dB 줄어듭니다.`,
);

await dispose();
