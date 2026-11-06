// 8장 실습: 로짓 → 확률을 손으로 따라가기 (학습서 8-1·8-2절 깊이 보기).
//  1) 소프트맥스: e^z를 구해 합으로 나누기. T = 1, 0.5, 2와 T → 0(탐욕)
//  2) 최댓값 빼기: 로짓에 같은 수를 더해도 확률은 같고, 그래서 큰 로짓의 넘침을 막을 수 있음
//  3) top-p(0.9)와 top-k(2): 어떤 후보가 남고, 남은 확률을 어떻게 다시 나누나
//  4) 뽑기 1만 번: 확률대로 나오는지 (시드 고정 난수)
//  5) 문장의 확률 = 토큰 확률의 곱 → 로그의 합. 길이가 길수록 작아짐
//
// 실행 (레포 루트에서):  node docs/1-study/lab/08-softmax.mjs
// 기준: Node 24. 외부 패키지·키·네트워크를 쓰지 않는 순수 계산입니다 (2026-11-06).
// 로짓 값은 설명용으로 지어낸 숫자입니다. Claude의 실제 로짓과 샘플링 구현은 공개되지 않았습니다.

const f3 = (x) => x.toFixed(3);
const f4 = (x) => x.toFixed(4);
const TOKENS = ['정확', '가격', '죄송'];
const LOGITS = [3.0, 2.5, 1.5];

/** 소프트맥스. 최댓값을 빼고 지수를 취해 넘침을 막습니다(결과는 같음, 2번). */
function softmax(z, T = 1) {
  const s = z.map((v) => v / T);
  const m = Math.max(...s);
  const e = s.map((v) => Math.exp(v - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

// 1) 손 계산 그대로
console.log('1) 소프트맥스 손 계산: p_i = e^(z_i/T) / Σ e^(z_j/T)');
for (const T of [1, 0.5, 2]) {
  const scaled = LOGITS.map((z) => z / T);
  const ex = scaled.map(Math.exp);
  const sum = ex.reduce((a, b) => a + b, 0);
  console.log(`   T = ${T}: z/T = (${scaled.join(', ')})`);
  console.log(`          e^(z/T) = ${ex.map(f4).join(' + ')} = ${f4(sum)}`);
  console.log(
    `          p = ${ex.map((v, i) => `${TOKENS[i]} ${f3(v / sum)}`).join(', ')}   (합 ${f3(ex.reduce((a, b) => a + b / sum, 0))})`,
  );
}
const ratio = Math.exp(LOGITS[0] - LOGITS[1]);
console.log(
  `   1등과 2등의 비 = e^(Δz/T): T=1이면 e^0.5 = ${f3(ratio)}배, T=0.5면 e^1 = ${f3(Math.exp(1))}배, T=2면 e^0.25 = ${f3(Math.exp(0.25))}배`,
);
console.log(
  `   T → 0이면 비가 무한대로 커져 1등만 남음(탐욕). 예: T = 0.05 → ${softmax(LOGITS, 0.05).map(f4).join(' / ')}`,
);

// 2) 최댓값 빼기
console.log('\n2) 로짓에 같은 수를 더해도 확률은 같다: e^(z+c) = e^c · e^z, e^c는 분모·분자에서 약분');
const big = LOGITS.map((z) => z + 1000);
const naive = big.map(Math.exp);
console.log(`   로짓 + 1000을 그대로 지수로: ${naive.join(', ')} → 나누면 ${naive.map((v) => v / (naive[0] + naive[1] + naive[2])).join(', ')}`);
console.log(`   최댓값(1003)을 빼고 계산:    ${softmax(big).map(f3).join(', ')}  (원래와 같음)`);
console.log('   (float64로 e^x가 넘치는 경계는 x ≈ 709.78. 실제 모델의 로짓은 이보다 작지만, 반정밀도에서는 훨씬 일찍 넘침)');

// 3) top-p, top-k
function topP(p, cut) {
  const order = p.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const keep = [];
  let cum = 0;
  for (const [v, i] of order) {
    keep.push(i);
    cum += v;
    if (cum >= cut) break; // 누적이 cut 이상이 되는 가장 작은 집합
  }
  return keep;
}
function renorm(p, keep) {
  const s = keep.reduce((a, i) => a + p[i], 0);
  return p.map((v, i) => (keep.includes(i) ? v / s : 0));
}
console.log('\n3) top-p 0.9: 확률 큰 순으로 더해 0.9 이상이 되는 가장 작은 집합만 남기고 다시 나눔');
for (const T of [1, 0.5]) {
  const p = softmax(LOGITS, T);
  const keep = topP(p, 0.9);
  let cum = 0;
  const steps = p
    .map((v, i) => [v, i])
    .sort((a, b) => b[0] - a[0])
    .map(([v, i]) => `${TOKENS[i]} ${f3(v)} → 누적 ${f3((cum += v))}`);
  console.log(`   T = ${T}: ${steps.join(', ')}`);
  console.log(
    `          남는 후보 ${keep.length}개 (${keep.map((i) => TOKENS[i]).join(', ')}) → 다시 나눈 확률 ${renorm(p, keep).map(f3).join(' / ')}`,
  );
}
const p1 = softmax(LOGITS);
const k2 = [0, 1];
console.log(`   top-k 2 (T = 1): 위 2개만 → ${renorm(p1, k2).map(f3).join(' / ')}  (20.09 / (20.09 + 12.18) = 0.622)`);
console.log('   (temperature를 먼저 적용하고 top-p·top-k를 거는 순서가 흔한 구현입니다. 순서를 바꾸면 결과가 달라질 수 있음)');

// 4) 뽑기
/** 시드 고정 난수(mulberry32). 실행마다 같은 결과가 나오게 합니다. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 누적 확률표에 0~1 난수를 떨어뜨려 고르는 역변환 뽑기. */
function sample(p, r) {
  let cum = 0;
  for (let i = 0; i < p.length; i++) {
    cum += p[i];
    if (r < cum) return i;
  }
  return p.length - 1;
}
console.log('\n4) 확률대로 1만 번 뽑기 (누적표 [0, 0.547) → 정확, [0.547, 0.878) → 가격, 나머지 → 죄송)');
for (const T of [1, 0.5]) {
  const rand = mulberry32(42);
  const p = softmax(LOGITS, T);
  const count = [0, 0, 0];
  for (let n = 0; n < 10000; n++) count[sample(p, rand())]++;
  console.log(
    `   T = ${T}: ${count.map((c, i) => `${TOKENS[i]} ${c}회(${(c / 100).toFixed(1)}%, 기대 ${(p[i] * 100).toFixed(1)}%)`).join(', ')}`,
  );
}
console.log('   탐욕(가장 큰 것만)은 늘 "정확". 같은 입력에 같은 답이 나오지만, 단계마다 1등이 문장 전체로도 1등이라는 보장은 없음');

// 5) 문장 확률
console.log('\n5) 문장의 확률 = 각 단계 확률의 곱 (8-1절 그림의 "정확" 0.41 × "한" 0.88 × " 금액" 0.63)');
const steps = [0.41, 0.88, 0.63];
const prod = steps.reduce((a, b) => a * b, 1);
const logSum = steps.reduce((a, b) => a + Math.log(b), 0);
console.log(`   곱 = ${f4(prod)}, 로그 합 = ${steps.map((v) => f3(Math.log(v))).join(' + ')} = ${f3(logSum)} → e^${f3(logSum)} = ${f4(Math.exp(logSum))}`);
console.log(
  `   토큰 60개가 모두 0.9라도 0.9^60 = ${(0.9 ** 60).toExponential(2)}. 그래서 모델·디코더는 확률 대신 로그 확률을 더함(6장 CTC와 같은 이유)`,
);
