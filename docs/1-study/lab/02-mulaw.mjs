// 2장 실습: G.711 μ-law·A-law 인코더/디코더를 직접 만들고, 음성을 전화 음질로 왕복시킵니다.
//  1) μ-law 구간(segment) 표
//  2) 샘플 하나(1000)를 손으로 인코딩한 과정과 로그 공식 비교
//  3) 음성 24kHz → 8kHz → G.711 → 다시 PCM: SNR 재기, 듣기용 WAV 만들기
//
// 실행: 레포 루트에서  node docs/1-study/lab/02-mulaw.mjs
// 기준: ITU-T G.711(1988), @livekit/rtc-node 1.2.1(8kHz로 내리는 리샘플러만 씀), @livekit/agents 1.9.5 기준 레포.
//       2026-11-05 작성. 키·네트워크·.env.local을 쓰지 않습니다. 듣기용 WAV는 임시 폴더에 씁니다.
// 표준은 μ-law에 14비트, A-law에 13비트 선형 값을 넣습니다. 그래서 16비트 값의 아래 2비트(A-law는 3비트)를
// 버리고 시작합니다. 비트 단위 결과는 CCITT 참조 구현(Sun g711.c)과 같게 맞췄습니다.
import { AudioFrame, AudioResampler, AudioResamplerQuality, dispose } from '@livekit/rtc-node';
import { koreanSpeech, snrDb, writeWav } from './02-wav.mjs';

// ---- μ-law: 부호 1비트 + 구간 3비트 + 가수 4비트, 마지막에 모든 비트를 뒤집음 ----
// 표준은 14비트 값에 정의돼 있어 16비트 입력의 아래 2비트를 버립니다(>> 2).
const BIAS = 33; // 크기에 더해, 0 근처도 "가장 높은 1비트" 규칙으로 구간을 정할 수 있게 함
const CLIP = 8158; // 8191 - 33

function ulawEncode(x) {
  const v = x >> 2; // 16비트 → 14비트
  const sign = v < 0 ? 0x80 : 0;
  const mag = Math.min(Math.abs(v), CLIP) + BIAS; // 33 ~ 8191
  let seg = 7;
  while (seg > 0 && mag < 32 << seg) seg--; // 가장 높은 1비트의 자리 - 5
  const mant = (mag >> (seg + 1)) & 0x0f; // 그 바로 아래 4비트
  return ~(sign | (seg << 4) | mant) & 0xff;
}

function ulawDecode(u) {
  const v = ~u & 0xff;
  const seg = (v >> 4) & 7;
  const mag = ((((v & 0x0f) << 1) + BIAS) << seg) - BIAS; // 칸의 가운데 값(14비트)
  return (v & 0x80 ? -mag : mag) * 4; // 16비트로
}

// ---- A-law: 0 근처 두 구간이 같은 칸 크기(직선), 짝수 비트만 뒤집음(XOR 0x55) ----
function alawEncode(x) {
  let v = x >> 3; // 13비트로
  const mask = v >= 0 ? 0xd5 : 0x55; // 0x80(양수 표시) | 0x55
  if (v < 0) v = -v - 1;
  let seg = 0;
  while (seg < 7 && v >= 32 << seg) seg++;
  const mant = (seg < 2 ? v >> 1 : v >> seg) & 0x0f;
  return ((seg << 4) | mant) ^ mask;
}

function alawDecode(a) {
  const v = a ^ 0x55;
  const seg = (v >> 4) & 7;
  let t = ((v & 0x0f) << 4) + (seg === 0 ? 8 : 0x108);
  if (seg > 1) t <<= seg - 1;
  return v & 0x80 ? t : -t;
}

// 1) 구간 표: 구간이 하나 올라갈 때마다 칸 크기가 두 배
console.log('1) μ-law 구간 (16비트 값 기준)');
for (let e = 0; e < 8; e++) {
  const lo = Math.max(0, (32 << e) - BIAS) * 4; // 14비트 경계를 16비트로(×4)
  const hi = Math.min(CLIP, (64 << e) - BIAS - 1) * 4 + 3;
  console.log(
    `   구간 ${e}: ${String(lo).padStart(5)} ~ ${String(hi).padStart(5)}, 칸 크기 ${1 << (e + 3)}`,
  );
}

// 2) 샘플 하나를 손으로 따라가기
const x = 1000;
const bits = (n) => n.toString(2).padStart(8, '0');
const u = ulawEncode(x);
const a = alawEncode(x);
console.log(`\n2) x = ${x}`);
const mag = (x >> 2) + BIAS;
console.log(
  `   μ-law: ${x} >> 2 = ${x >> 2}, +${BIAS} = ${mag} = 0b${mag.toString(2)} → 구간 3, 가수 0001`,
);
console.log(
  `          뒤집기 전 0b${bits(~u & 0xff)}, 보내는 바이트 0b${bits(u)} (0x${u.toString(16)}) → 복원 ${ulawDecode(u)}`,
);
console.log(`   A-law: 보내는 바이트 0b${bits(a)} (0x${a.toString(16)}) → 복원 ${alawDecode(a)}`);
const F = (v, mu = 255) => (Math.sign(v) * Math.log(1 + mu * Math.abs(v))) / Math.log(1 + mu);
console.log(
  `   공식 F(${x}/32768) = ${F(x / 32768).toFixed(4)} → ×127 = ${(F(x / 32768) * 127).toFixed(1)}` +
    ` (구간 방식의 크기 코드: 3×16+1 = 49)`,
);

// 3) 음성 왕복: 24kHz → 8kHz(전화 대역) → 8비트 → 다시 16비트
const { rate, pcm, source } = koreanSpeech();
const down = new AudioResampler(rate, 8000, 1, AudioResamplerQuality.VERY_HIGH);
const pcm8 = Int16Array.from([
  ...down.push(new AudioFrame(pcm, rate, 1, pcm.length)).flatMap((f) => [...f.data]),
  ...down.flush().flatMap((f) => [...f.data]),
]);
down.close();
const linear8bit = (v) => Math.max(-32768, Math.min(32767, Math.round(v / 256) * 256)); // 압신 없이 8비트

console.log(
  `\n3) 음성(${source}) ${rate}Hz → 8000Hz, ${pcm8.length}샘플 = ${pcm8.length}바이트(G.711) = 64kbps`,
);
console.log('   SNR(8kHz 16비트 PCM 대비)   보통 크기   30dB 작게');
const label = { 'μ-law': 'μ-law     ', 'A-law': 'A-law     ', '8비트 선형': '8비트 선형' }; // 한글은 두 칸
const quiet = Int16Array.from(pcm8, (v) => Math.round(v / 10 ** (30 / 20)));
for (const [name, codec] of [
  ['μ-law', (v) => ulawDecode(ulawEncode(v))],
  ['A-law', (v) => alawDecode(alawEncode(v))],
  ['8비트 선형', linear8bit],
]) {
  const loud = snrDb(pcm8, Int16Array.from(pcm8, codec));
  const soft = snrDb(quiet, Int16Array.from(quiet, codec));
  console.log(
    `   ${label[name]}                  ${loud.toFixed(1).padStart(5)}dB    ${soft.toFixed(1).padStart(5)}dB`,
  );
}

const ulawBytes = Uint8Array.from(pcm8, ulawEncode);
console.log('   들어 보기:');
console.log(`     ${writeWav('mulaw-0-original-24k.wav', rate, pcm)}`);
console.log(`     ${writeWav('mulaw-1-band-8k.wav', 8000, pcm8)}`);
console.log(
  `     ${writeWav('mulaw-2-ulaw-8k.wav', 8000, Int16Array.from(ulawBytes, ulawDecode))}`,
);
console.log(
  `     ${writeWav(
    'mulaw-3-linear8bit-quiet-8k.wav',
    8000,
    Int16Array.from(quiet, (v) => linear8bit(v) * 31),
  )}`,
);
console.log(
  `     ${writeWav(
    'mulaw-4-ulaw-quiet-8k.wav',
    8000,
    Int16Array.from(quiet, (v) => ulawDecode(ulawEncode(v)) * 31),
  )}`,
);

await dispose();
