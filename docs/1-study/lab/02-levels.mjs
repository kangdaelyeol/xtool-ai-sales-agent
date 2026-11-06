// 2장 실습: 크기(dBFS), 양자화 잡음(SQNR), 클리핑(포화 vs 랩어라운드).
// 듣기용 WAV를 임시 폴더에 만듭니다(레포에는 쓰지 않음).
//
// 실행: 레포 루트에서  node docs/1-study/lab/02-levels.mjs
// 기준: Node.js 24, @livekit/agents 1.9.5 기준 레포(SDK는 import하지 않음). 2026-11-05 작성.
//       음성은 macOS `say -v Yuna`(없으면 합성 신호). 키·네트워크·.env.local을 쓰지 않습니다.
import { koreanSpeech, writeWav } from './02-wav.mjs';

const FULL = 32768; // int16 풀스케일(0dBFS의 기준)
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const dbfs = (v) => 20 * Math.log10(v / FULL);

// 1) dBFS: 풀스케일에 대한 비율을 dB로. 0dBFS가 최대이고 그 아래는 모두 음수입니다.
console.log('1) dBFS');
console.log(`   RMS 3277  → ${dbfs(3277).toFixed(2)} dBFS (풀스케일의 1/10)`);
console.log(`   RMS 32768/√2 (풀스케일 사인파) → ${dbfs(FULL / Math.SQRT2).toFixed(2)} dBFS`);

// 2) N비트로 반올림 양자화한 풀스케일 사인파의 SQNR을 재고 6.02N + 1.76과 비교합니다.
console.log('\n2) 양자화 잡음: 실측 SQNR vs 공식 6.02N + 1.76');
for (const bits of [4, 8, 12, 16]) {
  const step = 2 / 2 ** bits; // -1..1 범위를 2^N 칸으로
  let s = 0;
  let n = 0;
  for (let i = 0; i < 100000; i++) {
    const x = Math.sin(2 * Math.PI * 0.01234 * i) * (1 - step / 2);
    const q = Math.round(x / step) * step;
    s += x * x;
    n += (x - q) ** 2;
  }
  console.log(
    `   ${String(bits).padStart(2)}비트: 실측 ${(10 * Math.log10(s / n)).toFixed(1)}dB, 공식 ${(6.02 * bits + 1.76).toFixed(1)}dB`,
  );
}

// 3) Int16Array에 범위 밖 값을 넣으면 잘리지 않고 2^16으로 나눈 나머지로 "감깁니다".
console.log('\n3) 범위 밖 값 넣기');
const values = [32767, 32770, 40000, -32770, 0.7, -0.7];
const saturate = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
console.log(`   넣은 값      : ${values.join(', ')}`);
console.log(
  `   Int16Array   : ${Array.from(Int16Array.from(values)).join(', ')}   ← 감김, 소수는 0 쪽으로 버림`,
);
console.log(`   포화(clamp)  : ${values.map(saturate).join(', ')}`);
console.log(`   float 1.0001 × 32767 → Int16Array: ${Int16Array.from([1.0001 * 32767])[0]}`);

// 4) 실제 음성을 6dB(2배) 키워 두 방식으로 int16에 담고, 들어 봅니다.
const { rate, pcm, source } = koreanSpeech();
const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
console.log(`\n4) 음성(${source}, ${rate}Hz, ${(pcm.length / rate).toFixed(2)}초)`);
console.log(`   원본: RMS ${dbfs(rms(pcm)).toFixed(1)}dBFS, 최대 ${dbfs(peak).toFixed(1)}dBFS`);
const gain = 10 ** (6 / 20);
const loud = Array.from(pcm, (v) => v * gain);
const over = loud.filter((v) => v > 32767 || v < -32768).length;
console.log(`   +6dB: 범위를 넘은 샘플 ${over}개 (${((over / pcm.length) * 100).toFixed(2)}%)`);
const saturated = Int16Array.from(loud, saturate);
const wrapped = Int16Array.from(loud);
// 이웃한 두 샘플 사이의 가장 큰 차이. 랩어라운드는 꼭대기에서 바닥으로 뛰므로 이 값이 커집니다.
const maxJump = (x) => x.reduce((m, v, i) => (i ? Math.max(m, Math.abs(v - x[i - 1])) : 0), 0);
console.log(
  `   이웃 샘플 사이 최대 차이: 포화 ${maxJump(saturated)}, 랩어라운드 ${maxJump(wrapped)}`,
);
console.log(`   들어 보기: ${writeWav('levels-original.wav', rate, pcm)}`);
console.log(`              ${writeWav('levels-plus6db-saturate.wav', rate, saturated)}`);
console.log(`              ${writeWav('levels-plus6db-wrap.wav', rate, wrapped)}`);
