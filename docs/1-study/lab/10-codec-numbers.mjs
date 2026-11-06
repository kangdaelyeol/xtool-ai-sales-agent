// 10장 실습: 음향 모델·보코더·오디오 코덱 토큰의 숫자를 손 계산과 같은 식으로 확인하고,
// 잔차 벡터 양자화(RVQ)를 작은 장난감으로 직접 돌려 봅니다 (학습서 10-1절 ③~⑤ 깊이 보기).
//  1) 멜 보코더: hop 256 @ 22.05kHz의 프레임 길이·초당 프레임·업샘플 사슬(8×8×2×2), STT 앞단(2-8절)과 비교
//  2) EnCodec 24kHz: 보폭 2·4·5·8 → hop 320 → 초당 75프레임, 코드북 1024(10비트) × 개수 = 비트레이트
//  3) 장난감 RVQ: 8차원 벡터를 16칸 코드북 4단으로 차례로 양자화. 단마다 남는 오차(잔차)가 줄어드는 모습
//
// 실행 (레포 루트에서):  node docs/1-study/lab/10-codec-numbers.mjs   (1초 안팎)
// 기준: Node 24 (2026-11-06). 외부 패키지·키·네트워크를 쓰지 않습니다. 난수는 씨앗을 고정해 실행마다 같습니다.
//
// 숫자의 출처는 공개 논문과 공개 코드의 설정입니다. ElevenLabs의 내부 구조는 공개되지 않았으므로 이 숫자와 같다는 뜻이
// 아닙니다.
//   HiFi-GAN V1 (Kong 외, 2020) LJSpeech 설정: 22,050Hz, n_fft 1024, 창 1024, hop 256, 멜 80, 업샘플 [8, 8, 2, 2]
//   EnCodec (Défossez 외, 2022) 24kHz 모델: 인코더 보폭 [2, 4, 5, 8], 코드북 1024, 대역폭 1.5/3/6/12/24kbps
//   VALL-E (Wang 외, 2023): EnCodec 6kbps(코드북 8개)의 토큰을 예측. 첫 코드북은 자기회귀, 나머지 7개는 비자기회귀

// ── 1) 멜 보코더의 숫자
console.log('1) 멜 스펙트로그램 → 보코더 (HiFi-GAN V1 공개 설정)');
const SR = 22050;
const HOP = 256;
const WIN = 1024;
const MELS = 80;
const ups = [8, 8, 2, 2];
console.log(
  `   hop ${HOP}샘플 ÷ ${SR}Hz = ${((HOP / SR) * 1000).toFixed(2)}ms, 초당 ${(SR / HOP).toFixed(2)}프레임`,
);
console.log(
  `   창 ${WIN}샘플 = ${((WIN / SR) * 1000).toFixed(1)}ms (창이 hop의 ${WIN / HOP}배라 겹침 75%)`,
);
console.log(
  `   업샘플 사슬 ${ups.join(' × ')} = ${ups.reduce((a, b) => a * b, 1)} = hop. 멜 프레임 하나가 샘플 ${HOP}개가 됨`,
);
let len = 1;
console.log(
  `   한 프레임을 따라가면: ${[1, ...ups.map((u) => (len *= u))].join(' → ')}샘플 (단마다 전치 합성곱)`,
);
const frames1s = Math.floor(SR / HOP) + 1; // 가운데 맞춤(center) 패딩 기준
console.log(
  `   소리 1초(${SR}샘플) = 멜 ${frames1s}프레임 × ${MELS}칸 = ${frames1s * MELS}개 숫자 → 보코더 → ${SR}샘플`,
);
console.log(
  `   ElevenLabs 수신 프레임 100ms(2205샘플)는 이 설정의 멜 ${(2205 / HOP).toFixed(1)}프레임에 해당 (비교용 계산)`,
);
console.log(
  '   비교: STT 앞단(2-8절) 16kHz, 창 400(25ms), hop 160(10ms), 초당 100프레임, 멜 80칸. 둘 다 멜 80칸이지만',
);
console.log(
  '         STT는 "읽기"용이라 버리는 정보(위상)를 신경 쓰지 않고, TTS는 그 그림에서 파형을 다시 만들어야 함',
);

// ── 2) EnCodec의 숫자
console.log('\n2) 오디오 코덱 토큰 (EnCodec 24kHz 공개 설정)');
const strides = [2, 4, 5, 8];
const hop = strides.reduce((a, b) => a * b, 1);
const fps = 24000 / hop;
const bitsPerCode = Math.log2(1024);
console.log(
  `   보폭 ${strides.join(' × ')} = ${hop}샘플 → 24000 ÷ ${hop} = 초당 ${fps}프레임 (${(1000 / fps).toFixed(2)}ms마다)`,
);
console.log(
  `   코드북 1024칸 = ${bitsPerCode}비트. 코드북 하나의 비트레이트 = ${fps} × ${bitsPerCode} = ${fps * bitsPerCode}bps`,
);
console.log('   코드북 수  비트레이트  1초당 토큰  1초당 바이트  PCM 24kHz 16비트(48,000B/s) 대비');
for (const n of [2, 4, 8, 16, 32]) {
  const bps = fps * bitsPerCode * n;
  console.log(
    `   ${String(n).padStart(6)}     ${String(bps / 1000).padStart(5)}kbps  ${String(fps * n).padStart(8)}개  ${String(bps / 8).padStart(9)}B      1/${48000 / (bps / 8)}`,
  );
}
console.log(
  `   VALL-E식(6kbps, 코드북 8개): 1초 = ${fps}프레임 × 8 = ${fps * 8}토큰. 첫 코드북 ${fps}개를 자기회귀로 하나씩,`,
);
console.log('   나머지 7개 코드북은 비자기회귀로 한 번에 한 층씩(7번) 채움');
console.log(
  `   코드북 하나로 같은 80비트를 내려면 2^80 ≈ ${(2 ** 80).toExponential(2)}칸이 필요. RVQ는 8 × 1024 = 8,192칸으로 해결`,
);

// ── 3) 장난감 RVQ
console.log(
  '\n3) 장난감 RVQ: 8차원 벡터 4,000개, 코드북 16칸(4비트) × 4단, 단마다 k-평균으로 학습',
);
let seed = 20261106;
const rand = () => {
  // mulberry32: 씨앗 고정 난수
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
const D = 8;
const N = 4000;
const K = 16;
const STAGES = 4;
// 데이터: 중심 12개 주변에 퍼진 점들(소리 프레임의 특징 벡터를 흉내 낸 것일 뿐, 실제 소리가 아님)
const centers = Array.from({ length: 12 }, () => Array.from({ length: D }, () => 3 * gauss()));
const data = Array.from({ length: N }, () => {
  const c = centers[Math.floor(rand() * centers.length)];
  return c.map((v) => v + 0.8 * gauss());
});
const dist2 = (a, b) => a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0);
const nearest = (cb, x) => {
  let best = 0;
  let bd = Infinity;
  for (let k = 0; k < cb.length; k++) {
    const d = dist2(cb[k], x);
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  return best;
};
function kmeans(points, k, iters = 25) {
  const cb = Array.from({ length: k }, (_, i) => [...points[Math.floor((i * points.length) / k)]]);
  for (let it = 0; it < iters; it++) {
    const sum = Array.from({ length: k }, () => new Array(D).fill(0));
    const cnt = new Array(k).fill(0);
    for (const p of points) {
      const j = nearest(cb, p);
      cnt[j] += 1;
      for (let d = 0; d < D; d++) sum[j][d] += p[d];
    }
    for (let j = 0; j < k; j++) if (cnt[j]) cb[j] = sum[j].map((v) => v / cnt[j]);
  }
  return cb;
}
const energy = data.reduce((s, x) => s + dist2(x, new Array(D).fill(0)), 0) / N;
let residual = data.map((x) => [...x]);
const codebooks = [];
console.log('   단  누적 비트  남은 오차(MSE)  신호 대비 오차');
console.log(
  `    0       0    ${energy.toFixed(3).padStart(8)}       0.0dB (양자화 전 = 신호 에너지)`,
);
for (let s = 0; s < STAGES; s++) {
  const cb = kmeans(residual, K);
  codebooks.push(cb);
  residual = residual.map((r) => {
    const q = cb[nearest(cb, r)];
    return r.map((v, d) => v - q[d]);
  });
  const mse = residual.reduce((acc, r) => acc + dist2(r, new Array(D).fill(0)), 0) / N;
  console.log(
    `   ${String(s + 1).padStart(2)}  ${String((s + 1) * Math.log2(K)).padStart(6)}    ${mse.toFixed(3).padStart(8)}     ${(10 * Math.log10(mse / energy)).toFixed(1).padStart(6)}dB`,
  );
}
// 벡터 하나를 인코딩·디코딩
const x = data[2026]; // 아무 벡터 하나
let r = [...x];
const idx = [];
const recon = new Array(D).fill(0);
console.log('   벡터 하나를 따라가기 (앞 3차원만 표시)');
console.log(
  `     원래 값           [${x
    .slice(0, 3)
    .map((v) => v.toFixed(2))
    .join(', ')}, …]`,
);
for (const [s, cb] of codebooks.entries()) {
  const j = nearest(cb, r);
  idx.push(j);
  for (let d = 0; d < D; d++) {
    recon[d] += cb[j][d];
    r[d] -= cb[j][d];
  }
  console.log(
    `     ${s + 1}단: 번호 ${String(j).padStart(2)} → 복원 [${recon
      .slice(0, 3)
      .map((v) => v.toFixed(2))
      .join(', ')}, …], 남은 오차 ${dist2(x, recon).toFixed(3)}`,
  );
}
console.log(
  `     보내는 것은 번호 ${STAGES}개 [${idx.join(', ')}] = ${STAGES * Math.log2(K)}비트. 실수 8개(32비트 × 8 = 256비트) 대신`,
);
console.log(
  `   이 장난감을 초당 75프레임으로 보낸다면 75 × ${STAGES}단 × ${Math.log2(K)}비트 = ${75 * STAGES * Math.log2(K)}bps`,
);
