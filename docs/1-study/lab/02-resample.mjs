// 2장 실습: 리샘플러(soxr) 들여다보기.
//  1) 변환 비율을 정수비 L/M으로 줄이기
//  2) 품질 단계마다 push 한 번에 몇 샘플이 나오나 (출력이 몰려 나오는 모양)
//  3) 필터가 붙잡아 두는 양 = 리샘플러가 더하는 지연
//  4) 앨리어싱: 새 나이퀴스트 위의 소리가 접혀 들어오는지
//  5) 디더: 디지털 0을 넣어도 ±1이 나오고, 같은 입력도 리샘플러마다 결과가 조금 다른지
//
// 실행: 레포 루트에서  node docs/1-study/lab/02-resample.mjs
// 기준: @livekit/rtc-node 1.2.1 (AudioResampler = 네이티브 libsoxr, rtc-node/src/audio_resampler.ts),
//       @livekit/agents 1.9.5 (어느 단계가 어느 품질을 쓰는지의 출처). 2026-11-05 작성.
// 키·네트워크·.env.local을 쓰지 않습니다.
import { AudioFrame, AudioResampler, AudioResamplerQuality as Q, dispose } from '@livekit/rtc-node';

const QUALITIES = {
  QUICK: Q.QUICK,
  LOW: Q.LOW,
  MEDIUM: Q.MEDIUM,
  HIGH: Q.HIGH,
  VERY_HIGH: Q.VERY_HIGH,
};

// 1) 정수비. 24000→16000은 "2배로 늘리고 3개 중 1개만 남기기"와 같습니다.
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
console.log('1) 변환 비율 L/M (L배 늘리고 M개 중 하나 남김)');
for (const [a, b] of [
  [24000, 16000],
  [22050, 24000],
  [48000, 24000],
  [8000, 16000],
]) {
  const g = gcd(a, b);
  console.log(`   ${a} → ${b}: L=${b / g}, M=${a / g}`);
}

/** frames개 프레임(각 n샘플)을 넣고 push마다 나온 샘플 수, 붙잡힌 양(ms), 결과 신호를 돌려줍니다. */
function run(inRate, outRate, quality, n, frames, makeInput = () => new Int16Array(n)) {
  const r = new AudioResampler(inRate, outRate, 1, quality);
  const sizes = [];
  const out = [];
  let heldSum = 0;
  let heldMax = 0;
  for (let i = 0; i < frames; i++) {
    for (const f of r.push(new AudioFrame(makeInput(i), inRate, 1, n))) out.push(...f.data);
    sizes.push(out.length - sizes.reduce((a, b) => a + b, 0));
    const heldMs = ((((i + 1) * n * outRate) / inRate - out.length) / outRate) * 1000; // 들어간 만큼 안 나온 몫
    heldSum += heldMs;
    heldMax = Math.max(heldMax, heldMs);
  }
  for (const f of r.flush()) out.push(...f.data);
  r.close();
  return { sizes, heldAvg: heldSum / frames, heldMax, out: Int16Array.from(out) };
}

// 2), 3) VAD·턴 감지(QUICK)와 STT(MEDIUM)가 쓰는 24k→16k, TTS 출력의 22.05k→24k
console.log('\n2) push마다 나온 샘플 수   3) 붙잡아 둔 양(평균/최대)');
for (const [name, q] of Object.entries(QUALITIES)) {
  const a = run(24000, 16000, q, 240, 100);
  const b = run(22050, 24000, q, 2205, 10);
  console.log(
    `   ${name.padEnd(9)} 24k→16k 240×5: ${a.sizes.slice(0, 5).join('|').padEnd(17)} ` +
      `${a.heldAvg.toFixed(1)}/${a.heldMax.toFixed(1)}ms   ` +
      `22.05k→24k 2205×3: ${b.sizes.slice(0, 3).join('|').padEnd(14)} ${b.heldAvg.toFixed(1)}/${b.heldMax.toFixed(1)}ms`,
  );
}

// 늦게 나와도 시간은 맞습니다. 입력 1,200번째 샘플의 임펄스는 출력 800번째(×2/3)에 봉우리로 나오고,
// flush까지 하면 출력 개수가 정확히 입력×2/3입니다. soxr가 필터 지연만큼을 스스로 잘라 내기 때문입니다.
const impulse = (i) => {
  const d = new Int16Array(240);
  if (i === 5) d[0] = 20000; // 5 × 240 = 1,200번째 샘플
  return d;
};
for (const name of ['QUICK', 'MEDIUM']) {
  const { out } = run(24000, 16000, QUALITIES[name], 240, 20, impulse);
  const peak = out.reduce((best, v, k) => (Math.abs(v) > Math.abs(out[best]) ? k : best), 0);
  console.log(
    `   ${name.padEnd(9)} 임펄스 1200번 → 봉우리 ${peak}번(기대 800), flush 후 출력 ${out.length}개(기대 3200)`,
  );
}

// 4) 앨리어싱. 24kHz에 담긴 순음을 16kHz로 내립니다. 8kHz(새 나이퀴스트) 위의 f는 16000-f로 접힙니다.
const tone = (f, rate, len) => (i) =>
  Int16Array.from({ length: len }, (_, k) =>
    Math.round(16000 * Math.sin((2 * Math.PI * f * (i * len + k)) / rate)),
  );
/** 신호 x에서 주파수 f 성분의 크기(dBFS). 앞뒤 20%는 필터가 자리 잡는 구간이라 뺍니다. */
function levelDb(x, f, rate) {
  let re = 0;
  let im = 0;
  const s = Math.floor(x.length * 0.2);
  const e = Math.floor(x.length * 0.8);
  for (let i = s; i < e; i++) {
    re += x[i] * Math.cos((2 * Math.PI * f * i) / rate);
    im += x[i] * Math.sin((2 * Math.PI * f * i) / rate);
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / (e - s) / 32768);
}
console.log('\n4) 24kHz 순음(-6.2dBFS)을 16kHz로 내렸을 때 남은 크기(dBFS)');
console.log('   입력    → 보이는 곳   QUICK   LOW     MEDIUM  VERY_HIGH');
for (const f of [3400, 7000, 7600, 10000]) {
  const seen = f > 8000 ? 16000 - f : f;
  const cells = ['QUICK', 'LOW', 'MEDIUM', 'VERY_HIGH'].map((name) => {
    const { out } = run(24000, 16000, QUALITIES[name], 240, 100, tone(f, 24000, 240));
    return levelDb(out, seen, 16000).toFixed(1).padStart(7);
  });
  console.log(`   ${String(f).padStart(5)}Hz → ${String(seen).padStart(5)}Hz  ${cells.join(' ')}`);
}

// 덤: 필터 없이 3개 중 1개만 남기면(24k→8k) 6kHz가 2kHz로 그대로 접힙니다.
const six = tone(6000, 24000, 24000)(0);
const naive = six.filter((_, i) => i % 3 === 0);
const filtered = run(24000, 8000, Q.MEDIUM, 240, 100, tone(6000, 24000, 240)).out;
console.log(
  `\n   6kHz를 8kHz로: 그냥 솎아 내면 2kHz에 ${levelDb(naive, 2000, 8000).toFixed(1)}dBFS, ` +
    `MEDIUM이면 ${levelDb(filtered, 2000, 8000).toFixed(1)}dBFS`,
);

// 5) 디더. 출력이 16비트 정수이면 soxr가 TPDF 디더를 기본으로 섞습니다(soxr.h의 SOXR_NO_DITHER로 끔).
//    난수 씨앗은 "현재 시각(초) XOR 리샘플러 객체 주소"(soxr.c의 soxr_create)입니다. 그래서 동시에 살아 있는
//    두 리샘플러는 같은 입력에도 ±1이 붙는 자리가 다릅니다. 하나를 닫고 같은 초에 새로 만들면 주소가 재사용되어
//    결과가 똑같이 나오기도 합니다(마지막 칸).
console.log('\n5) 디더: 24k→16k, 1초씩. 디지털 0 입력 / 같은 1kHz 순음을 리샘플러 둘로 바꿨을 때 다른 샘플 수');
function twice(quality, together) {
  const make = () => new AudioResampler(24000, 16000, 1, quality);
  const outs = [[], []];
  const rs = together ? [make(), make()] : [make()];
  const frames = (i) => new AudioFrame(tone(1000, 24000, 240)(i), 24000, 1, 240);
  for (let i = 0; i < 100; i++) rs.forEach((r, j) => r.push(frames(i)).forEach((f) => outs[j].push(...f.data)));
  rs.forEach((r, j) => r.flush().forEach((f) => outs[j].push(...f.data)));
  rs.forEach((r) => r.close());
  if (!together) {
    const r = make(); // 앞의 것을 닫은 뒤 만듦
    for (let i = 0; i < 100; i++) r.push(frames(i)).forEach((f) => outs[1].push(...f.data));
    r.flush().forEach((f) => outs[1].push(...f.data));
    r.close();
  }
  return outs[0].filter((v, i) => v !== outs[1][i]).length;
}
for (const name of ['QUICK', 'MEDIUM', 'VERY_HIGH']) {
  const zeros = run(24000, 16000, QUALITIES[name], 240, 100).out;
  const nonzero = zeros.filter((v) => v !== 0);
  console.log(
    `   ${name.padEnd(9)} 0 입력: ${((nonzero.length / zeros.length) * 100).toFixed(0)}%가 ±${Math.max(...nonzero.map(Math.abs))}` +
      `   동시에 둘: ${twice(QUALITIES[name], true)}/16000 다름   닫고 다시: ${twice(QUALITIES[name], false)}/16000 다름`,
  );
}

await dispose();
