// 8장 실습: 어텐션과 KV 캐시를 숫자로 따라가기 (학습서 8-3·8-4절 깊이 보기).
//  1) 장난감 어텐션 한 층(d = 4, 토큰 3개): Q·K·V 만들기, QKᵀ/√d, 인과 마스크, 소프트맥스, 가중합
//  2) 토큰 하나를 덧붙여도 앞 토큰의 K·V와 출력이 그대로인 것(인과 마스크) → 캐시해도 되는 이유.
//     마스크를 빼면 앞 토큰의 출력이 바뀌어 캐시가 깨지는 것
//  3) KV 캐시 메모리 손 계산: 공개 모델 설정 예(32층 × KV 헤드 8 × 헤드 128차원 × K·V 2 × 2바이트)
//  4) 프리필은 계산 한계, 디코드는 메모리 대역폭 한계: 공개 GPU 사양 예로 본 하한
//
// 실행 (레포 루트에서):  node docs/1-study/lab/08-kv-cache.mjs
// 기준: Node 24. 외부 패키지·키·네트워크를 쓰지 않는 순수 계산입니다 (2026-11-06).
// 행렬 값은 지어낸 숫자입니다. Claude의 층 수·헤드 수·하드웨어는 공개되지 않았으므로 3·4번은 "예시 모델"입니다.

const f2 = (x) => (x >= 0 ? ' ' : '') + x.toFixed(2);
const row = (v) => `[${v.map(f2).join(' ')}]`;
const matVec = (W, x) => W.map((r) => r.reduce((s, w, j) => s + w * x[j], 0));
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
function softmax(z) {
  const m = Math.max(...z.filter((v) => v !== -Infinity));
  const e = z.map((v) => (v === -Infinity ? 0 : Math.exp(v - m)));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

// 1) 장난감 한 층. 임베딩(토큰마다 4개 숫자)과 W_Q, W_K, W_V는 지어낸 값입니다.
const D = 4;
const EMB = {
  '정확': [1.0, 0.0, 0.5, -0.5],
  '한': [0.0, 1.0, -0.5, 0.5],
  ' 금액': [0.5, 0.5, 1.0, 0.0],
  '은': [-0.5, 0.0, 0.0, 1.0],
};
const WQ = [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 1],
  [1, -1, 0, 0],
];
const WK = [
  [1, 0, 1, 0],
  [0, 1, 0, 1],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];
const WV = [
  [1, 0, 0, 0],
  [0, 0, 1, 0],
  [0, 1, 0, 0],
  [0, 0, 0, 1],
];

/** 한 층 어텐션. causal이면 i번째 토큰은 0..i만 봄(뒤는 −∞ → 소프트맥스 0). */
function attention(tokens, causal = true, verbose = false) {
  const X = tokens.map((t) => EMB[t]);
  const Q = X.map((x) => matVec(WQ, x));
  const K = X.map((x) => matVec(WK, x));
  const V = X.map((x) => matVec(WV, x));
  const out = [];
  for (let i = 0; i < X.length; i++) {
    const scores = K.map((k, j) => (causal && j > i ? -Infinity : dot(Q[i], k) / Math.sqrt(D)));
    const w = softmax(scores);
    const o = [0, 1, 2, 3].map((c) => w.reduce((s, wj, j) => s + wj * V[j][c], 0));
    out.push(o);
    if (verbose && i === X.length - 1) {
      console.log(`   마지막 토큰 "${tokens[i]}"의 점수 q·k/√${D} = [${scores.map((s) => (s === -Infinity ? '  −∞' : f2(s))).join(' ')}]`);
      console.log(`   소프트맥스 가중치 = [${w.map(f2).join(' ')}] → 출력 = Σ w·V = ${row(o)}`);
    }
  }
  return { K, V, out };
}

console.log('1) 장난감 어텐션 한 층: softmax(QKᵀ/√d)V, d = 4, 토큰 "정확", "한", " 금액"');
const three = ['정확', '한', ' 금액'];
const a3 = attention(three, true, true);
three.forEach((t, i) => console.log(`   "${t}"  K = ${row(a3.K[i])}  V = ${row(a3.V[i])}`));
console.log('   K·V는 그 토큰 자신의 입력(x)에 W를 곱한 것뿐이라, 뒤에 무엇이 오든 바뀌지 않습니다.');

console.log('\n2) 토큰 "은"을 덧붙여 다시 계산하면');
const four = [...three, '은'];
const a4 = attention(four, true, true);
const same = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-12);
three.forEach((t, i) =>
  console.log(
    `   "${t}"  K·V 같음: ${same(a3.K[i], a4.K[i]) && same(a3.V[i], a4.V[i]) ? '예' : '아니요'}, 출력 같음: ${same(a3.out[i], a4.out[i]) ? '예' : '아니요'}`,
  ),
);
console.log('   → 앞 토큰들의 K·V(와 출력)는 다시 계산할 필요가 없음. 새 토큰의 q 하나로 저장된 K·V를 읽으면 됨 = KV 캐시');
console.log('     층이 여러 개여도 같음: 다음 층의 입력(이 층의 출력)이 앞 토큰에서 바뀌지 않으므로 그 층의 K·V도 그대로');
const b3 = attention(three, false);
const b4 = attention(four, false);
console.log('   인과 마스크를 빼면(모든 토큰이 서로를 봄):');
three.forEach((t, i) =>
  console.log(`   "${t}"  출력 같음: ${same(b3.out[i], b4.out[i]) ? '예' : '아니요'}  ${row(b3.out[i])} → ${row(b4.out[i])}`),
);
console.log('   → 앞 토큰의 출력이 뒤 토큰 때문에 바뀌고, 2층부터는 K·V까지 바뀌므로 캐시를 쓸 수 없음');

// 3) KV 메모리
console.log('\n3) KV 캐시 메모리 = 층 × KV 헤드 × 헤드 차원 × 2(K와 V) × 바이트');
const MiB = 1024 * 1024;
const configs = [
  ['예시 A: 32층, KV 헤드 8(GQA), 128차원, 16비트', 32, 8, 128, 2],
  ['예시 B: 같은 모델을 KV 헤드 32(MHA)로', 32, 32, 128, 2],
  ['예시 C: 예시 A를 8비트로 저장', 32, 8, 128, 1],
];
for (const [name, L, H, d, b] of configs) {
  const perTok = L * H * d * 2 * b;
  console.log(
    `   ${name}: ${L}×${H}×${d}×2×${b} = ${perTok.toLocaleString()}B = ${perTok / 1024}KiB/토큰` +
      ` → 3,300토큰 ${((perTok * 3300) / MiB).toFixed(1)}MiB, 1만 토큰 ${((perTok * 10000) / MiB / 1024).toFixed(2)}GiB`,
  );
}
console.log('   (예시 A는 Llama 3 8B 같은 공개 설정과 같은 모양. Claude의 구조는 공개되지 않았습니다)');

// 4) 프리필 vs 디코드
console.log('\n4) 프리필은 계산 한계, 디코드는 메모리 대역폭 한계 (예시: 파라미터 80억, 16비트, 공개 GPU 사양 하나)');
const P = 8e9;
const BYTES = 2;
const FLOPS = 989e12; // 16비트 밀집 연산 최대치(공개 사양 예)
const BW = 3.35e12; // 메모리 대역폭 B/s (공개 사양 예)
const weightBytes = P * BYTES;
const perTokFlops = 2 * P; // 곱셈 + 덧셈
console.log(`   가중치 ${weightBytes / 1e9}GB, 토큰 하나 지나는 데 약 2×파라미터 = ${(perTokFlops / 1e9).toFixed(0)} GFLOP`);
const n = 3300;
const prefillCompute = (perTokFlops * n) / FLOPS;
const prefillRead = weightBytes / BW;
console.log(
  `   프리필 ${n.toLocaleString()}토큰: 계산 ${(perTokFlops * n / 1e12).toFixed(1)} TFLOP ÷ ${FLOPS / 1e12} TFLOP/s = ${(prefillCompute * 1000).toFixed(1)}ms,` +
    ` 가중치 읽기 ${(prefillRead * 1000).toFixed(1)}ms(한 번만) → 계산이 김 = 계산 한계`,
);
const decodeRead = weightBytes / BW;
const decodeCompute = perTokFlops / FLOPS;
const kvRead = (32 * 8 * 128 * 2 * 2 * n) / BW;
console.log(
  `   디코드 토큰 1개: 가중치 전부 읽기 ${(decodeRead * 1000).toFixed(2)}ms + KV ${n}토큰 읽기 ${(kvRead * 1000).toFixed(2)}ms,` +
    ` 계산은 ${(decodeCompute * 1000).toFixed(3)}ms → 읽기가 김 = 대역폭 한계`,
);
console.log(
  `   → 사용자 하나만 처리하면 초당 최대 약 ${Math.floor(1 / (decodeRead + kvRead))}토큰. 서버는 여러 요청을 묶어(배치) 한 번 읽은 가중치를 나눠 씀`,
);
console.log(
  `   산술 강도(바이트당 연산): 디코드 ${(perTokFlops / weightBytes).toFixed(0)} FLOP/B, 프리필 ${((perTokFlops * n) / weightBytes).toFixed(0)} FLOP/B, GPU 균형점 ${(FLOPS / BW).toFixed(0)} FLOP/B`,
);
console.log('   (이 값들은 이상적인 하한입니다. 실제 TTFT에는 대기열, 네트워크, 여러 GPU 사이 통신, 효율 손실이 더해짐)');
