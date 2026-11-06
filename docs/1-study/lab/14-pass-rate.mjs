// 14장 실습: 시나리오 통과율의 통계 — "6/6 통과"는 무엇을 말해 주나 (학습서 14-5절 "깊이 보기: 통과율의 통계").
//  1) n번 모두 통과했을 때 실패율의 95% 상한: 정확한 값 1 − 0.05^(1/n)과 3의 규칙(3/n)
//  2) 실패가 k번 섞였을 때의 상한 (Clopper–Pearson 한쪽 95%, 이분 탐색)
//  3) 묶음 전체가 초록일 확률: 시나리오마다 통과율 p일 때 p^6, --samples 3과 --pass-rate 0.75(3번 중 2번)일 때
//  4) 회귀를 잡으려면 몇 번 돌려야 하나: 실패율 q로 나빠진 시나리오에서 "한 번이라도 실패"를 볼 확률
//  5) 평소에도 가끔 실패하는 시나리오(p0)와 나빠진 시나리오(p1)를 "n번 중 c번 넘게 실패하면 경보"로 가를 때
//     거짓 경보와 놓침
//  6) 위 계산을 시드 고정 무작위 시험(몬테카를로)으로 확인
//  7) 두 모델(또는 두 지시문)의 통과율 차이를 가르려면 한쪽마다 몇 번: 두 비율 비교의 정규 근사 표본 크기
//     (유의수준 양쪽 5%, 검정력 80%)
//
// 실행 (레포 루트에서):  node docs/1-study/lab/14-pass-rate.mjs   (1초 안쪽)
// 기준: Node 24 (2026-11-06). 키·네트워크를 쓰지 않는 순수 계산입니다.
// lk agent simulate는 돌리지 않습니다(과금). --samples·--pass-rate의 규칙은 `lk agent simulate --help`(CLI 2.19.3)의
// 설명입니다: "LiveKit Cloud accepts 1 or 3", "0.75 of 3 samples needs 2 passes".
// 모든 확률은 "각 실행이 서로 독립이고 통과율이 일정하다"는 가정 위의 값입니다(같은 날 같은 모델이면 대략 맞고,
// 모델·판정 LLM이 바뀌면 깨집니다).

const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;

/** 이항분포 P(X ≤ k), X ~ B(n, p). */
function binomCdf(k, n, p) {
  let sum = 0;
  let term = (1 - p) ** n; // P(X = 0)
  for (let i = 0; i <= k; i++) {
    sum += term;
    term *= ((n - i) / (i + 1)) * (p / (1 - p));
  }
  return Math.min(1, sum);
}

/** 실패 k번 / n번일 때 실패율의 한쪽 (1−alpha) 상한 (Clopper–Pearson). P(X ≤ k | p) = alpha인 p. */
function upperBound(k, n, alpha = 0.05) {
  if (k >= n) return 1;
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (binomCdf(k, n, mid) > alpha) lo = mid;
    else hi = mid;
  }
  return hi;
}

// ── 1. 0번 실패 ─────────────────────────────────────────────────────────
console.log('== 1. n번 돌려 n번 모두 통과했을 때, 실패율의 95% 상한 ==');
console.log('    n   정확한 값 1 − 0.05^(1/n)   3의 규칙 3/n   (양쪽 95%일 때 1 − 0.025^(1/n))');
for (const n of [1, 3, 5, 6, 10, 12, 18, 20, 30, 60, 100]) {
  const exact = 1 - 0.05 ** (1 / n);
  const two = 1 - 0.025 ** (1 / n);
  console.log(
    `  ${String(n).padStart(3)}   ${pct(exact).padStart(8)}                ${pct(Math.min(1, 3 / n)).padStart(7)}        ${pct(two).padStart(7)}`,
  );
}
const u6 = 1 - 0.05 ** (1 / 6);
console.log(
  `  확인: 실패율이 정확히 ${pct(u6, 2)}인 시나리오가 6번 모두 통과할 확률 = (1 − ${u6.toFixed(4)})^6 = ${pct((1 - u6) ** 6, 2)}`,
);

// ── 2. 실패가 섞였을 때 ──────────────────────────────────────────────────
console.log('\n== 2. 실패가 섞였을 때 실패율의 95% 상한 (Clopper–Pearson 한쪽) ==');
for (const [k, n] of [
  [0, 6],
  [1, 6],
  [2, 6],
  [0, 18],
  [1, 18],
  [1, 30],
  [3, 30],
]) {
  console.log(
    `  ${String(n - k).padStart(2)}/${String(n).padEnd(2)} 통과 (실패 ${k}번): 관측 실패율 ${pct(k / n).padStart(6)}, 95% 상한 ${pct(upperBound(k, n)).padStart(6)}`,
  );
}

console.log(
  `  참고: 진짜 통과율이 4/6(66.7%) 그대로여도 다음 회차에 6개 중 3개 이하만 통과할 확률 ${pct(binomCdf(3, 6, 2 / 3))}` +
    ' (5-poc-results의 1회차 4/6 → 2회차 3/6)',
);

// ── 3. 묶음 전체가 초록일 확률 ─────────────────────────────────────────────
console.log('\n== 3. 시나리오 6개가 모두 초록일 확률 (시나리오마다 통과율 p) ==');
console.log(
  '    p      한 번씩(--samples 1)   3번 모두 통과(pass^3)   3번 중 2번 이상(--pass-rate 0.75)',
);
for (const p of [0.99, 0.95, 0.9, 0.8]) {
  const one = p ** 6;
  const all3 = p ** 18;
  const twoOf3 = p ** 3 + 3 * p ** 2 * (1 - p);
  console.log(
    `  ${p.toFixed(2)}   ${pct(one).padStart(8)}               ${pct(all3).padStart(8)}               ${pct(twoOf3 ** 6).padStart(8)}  (시나리오 하나는 ${pct(twoOf3, 2)})`,
  );
}

// ── 4. 회귀를 잡으려면 ───────────────────────────────────────────────────
console.log(
  '\n== 4. 실패율 q로 나빠진 시나리오에서 "한 번이라도 실패"를 볼 확률 ≥ 목표가 되는 최소 실행 수 n ==',
);
console.log('    q      목표 80%   목표 95%   목표 99%   (n = ⌈ln(1 − 목표) / ln(1 − q)⌉)');
for (const q of [0.5, 0.3, 0.2, 0.1, 0.05]) {
  const need = (power) => Math.ceil(Math.log(1 - power) / Math.log(1 - q));
  console.log(
    `  ${q.toFixed(2)}   ${String(need(0.8)).padStart(6)}     ${String(need(0.95)).padStart(6)}     ${String(need(0.99)).padStart(6)}`,
  );
}
console.log('  참고: --samples 3 한 번(3회)으로 잡을 확률');
for (const q of [0.5, 0.3, 0.2, 0.1, 0.05]) {
  console.log(
    `    q=${q.toFixed(2)}: 한 번이라도 실패 ${pct(1 - (1 - q) ** 3).padStart(6)},  --pass-rate 0.75(2번 이상 실패해야 시나리오 실패) ${pct(1 - binomCdf(1, 3, q)).padStart(6)}`,
  );
}

// ── 5. 평소에도 흔들리는 시나리오 ──────────────────────────────────────────
console.log('\n== 5. 평소 실패율 p0 = 5%, 나빠진 뒤 p1 = 30%. "n번 중 c번 넘게 실패하면 경보" ==');
console.log('    n   c   거짓 경보 P(X > c | p0)   잡을 확률 P(X > c | p1)');
for (const [n, c] of [
  [3, 0],
  [3, 1],
  [6, 0],
  [6, 1],
  [10, 1],
  [20, 2],
  [30, 4],
]) {
  console.log(
    `  ${String(n).padStart(3)}  ${String(c).padStart(2)}   ${pct(1 - binomCdf(c, n, 0.05)).padStart(8)}                ${pct(1 - binomCdf(c, n, 0.3)).padStart(8)}`,
  );
}

// ── 6. 몬테카를로 확인 ───────────────────────────────────────────────────
console.log('\n== 6. 시드 고정 무작위 시험으로 확인 (시드 20261106, 묶음 200,000번) ==');
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261106);
const TRIALS = 200_000;
let allGreen = 0;
let sixOfSixAtBound = 0;
let caught = 0;
for (let t = 0; t < TRIALS; t++) {
  let ok = true;
  for (let s = 0; s < 6; s++) if (rand() >= 0.95) ok = false;
  if (ok) allGreen++;
  let pass6 = true;
  for (let s = 0; s < 6; s++) if (rand() < u6) pass6 = false;
  if (pass6) sixOfSixAtBound++;
  let fails = 0;
  for (let s = 0; s < 10; s++) if (rand() < 0.3) fails++;
  if (fails > 1) caught++;
}
console.log(
  `  p = 0.95 시나리오 6개가 모두 통과: ${pct(allGreen / TRIALS, 2)}  (계산 ${pct(0.95 ** 6, 2)})`,
);
console.log(
  `  실패율 ${pct(u6, 2)} 시나리오가 6번 모두 통과: ${pct(sixOfSixAtBound / TRIALS, 2)}  (계산 5.00%)`,
);
console.log(
  `  실패율 30% 시나리오를 10번 돌려 2번 이상 실패: ${pct(caught / TRIALS, 2)}  (계산 ${pct(1 - binomCdf(1, 10, 0.3), 2)})`,
);

// ── 7. 두 통과율을 가르려면 ───────────────────────────────────────────────
console.log(
  '\n== 7. 통과율 p1 대 p2를 가르는 데 필요한 실행 수 (한쪽마다, 양쪽 5%, 검정력 80%, 정규 근사) ==',
);
const Z_ALPHA = 1.959964; // 양쪽 5%
const Z_BETA = 0.841621; // 검정력 80%
for (const [p1, p2] of [
  [0.95, 0.85],
  [0.9, 0.8],
  [0.9, 0.7],
  [0.8, 0.6],
]) {
  const pbar = (p1 + p2) / 2;
  const n =
    (Z_ALPHA * Math.sqrt(2 * pbar * (1 - pbar)) +
      Z_BETA * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) **
      2 /
    (p1 - p2) ** 2;
  console.log(`  ${pct(p1, 0)} 대 ${pct(p2, 0)}: 한쪽마다 약 ${Math.ceil(n)}번`);
}
