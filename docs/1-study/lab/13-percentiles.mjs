// 13장 실습: 지연을 백분위로 읽을 때의 손 계산을 코드로 확인합니다 (학습서 13-6절).
//   1) 백분위 정의: scripts/compare-llm.ts의 방식(정렬 뒤 floor(n·p)번 칸)이 12회·10회·20회에서 몇 번째 값을 고르는지,
//      가장 가까운 순위(ceil(n·p)번째)·선형 보간(R-7, 스프레드시트 PERCENTILE.INC와 같은 방식)과 비교
//   2) 꼬리 증폭: 턴의 q가 느릴 때 T턴짜리 통화가 적어도 한 번 느린 턴을 겪을 확률 1 − (1 − q)^T
//   3) 구간별 p95의 합 ≠ 전체 p95: 가정한 분포로 만든 가상 표본(시드 고정)으로 세 구간을 더해 봄
//   4) 0.11초 차이가 우연인가: 2026-11-05 A/B의 요약(p50·p90·최소)에 똑같이 맞는 가상 원 값을 만들어
//      순열 검정(중앙값 차, Mann–Whitney U)·부트스트랩을 돌림. 손으로 만든 두 극단 + 무작위 1,000벌.
//      원 값이 남아 있지 않아서 "요약만으로 무엇까지 말할 수 있나"를 보이는 시연이고, 실제 A/B의 검정이 아닙니다.
//      A/B가 compare-llm과 같은 백분위 식으로 요약됐다고 가정합니다(그날은 임시 스크립트로 쟀음, 8-9절).
//
// 실행: 레포 루트에서  node docs/1-study/lab/13-percentiles.mjs   (4초 남짓)
// 기준: Node.js 24. 2026-11-06 작성. 키·네트워크·.env.local을 쓰지 않고, SDK도 불러오지 않습니다.
// 3)·4)의 값은 모두 가상입니다(실측 아님). 4)는 실제 A/B의 원 값이 아니라, 그 요약에 맞게 일부러 만든 두 극단입니다.
// 출처
//   compare-llm의 백분위     scripts/compare-llm.ts 67~70 (sorted[min(n − 1, floor(n·p))])
//   A/B 요약                 docs/5-poc-results.md "Bedrock 도쿄 A/B" (Haiku 4.5, 12회씩 번갈아)
//   말 끝 2.5초 대기 (#39)    학습서 7-4절, 17-2 #39

// ── 공통 도구 ──────────────────────────────────────────────────────────
// 시드 고정 난수 (mulberry32). 실행마다 같은 값이 나오게 합니다.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sortNum = (xs) => [...xs].sort((a, b) => a - b);
// compare-llm.ts와 같은 식 (0부터 센 칸 번호)
const pFloor = (xs, p) => {
  const s = sortNum(xs);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
// 가장 가까운 순위: 1부터 센 ceil(n·p)번째 (p = 0이면 첫째)
const pNearest = (xs, p) => {
  const s = sortNum(xs);
  return s[Math.max(0, Math.ceil(s.length * p) - 1)];
};
// 선형 보간 R-7: h = (n − 1)·p (0부터), 이웃 두 값 사이를 비율로
const pLinear = (xs, p) => {
  const s = sortNum(xs);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  return s[lo] + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)] ?? s[lo]) - s[lo]);
};
const median = (xs) => pLinear(xs, 0.5);
const fmt = (x, d = 0) => x.toFixed(d).padStart(7);

// ── 1. 백분위 정의 ────────────────────────────────────────────────────
console.log('1) 백분위 정의별로 "몇 번째 값"을 고르나 (정렬한 뒤 작은 쪽부터 1번째)');
for (const n of [10, 12, 20]) {
  const parts = [0.5, 0.9, 0.95].map((p) => {
    const floorRank = Math.min(n - 1, Math.floor(n * p)) + 1;
    const nearRank = Math.max(1, Math.ceil(n * p));
    const h = (n - 1) * p + 1; // 1부터 센 보간 위치
    return `p${Math.round(p * 100)}: compare-llm ${floorRank}번째 / 가까운 순위 ${nearRank}번째 / 보간 ${h.toFixed(2)}번째`;
  });
  console.log(`   n=${String(n).padStart(2)}  ${parts.join('   ')}`);
}
// 예시 값 12개 (가상, ms). 꼬리가 하나 튄 모양
const ex = [612, 640, 655, 671, 688, 702, 719, 735, 760, 798, 905, 1340];
console.log(`   예시 12개 (가상, ms, 정렬됨): ${ex.join(' ')}`);
for (const p of [0.5, 0.9]) {
  console.log(
    `     p${p * 100}: compare-llm ${pFloor(ex, p)}  가까운 순위 ${pNearest(ex, p)}  보간 ${pLinear(ex, p).toFixed(1)}`,
  );
}
const mean = ex.reduce((a, b) => a + b, 0) / ex.length;
console.log(
  `     평균 ${mean.toFixed(1)} (튄 값 1,340 하나가 평균을 ${(mean - median(ex)).toFixed(1)}ms 끌어올림)`,
);

// ── 2. 꼬리 증폭 ──────────────────────────────────────────────────────
console.log(
  '\n2) 꼬리 증폭: 턴마다 q의 확률로 느리면, T턴 통화가 적어도 한 번 느린 턴을 겪을 확률 1 − (1 − q)^T',
);
const Ts = [1, 5, 8, 15, 30];
console.log(`        q \\ T ${Ts.map((t) => String(t).padStart(7)).join('')}`);
for (const q of [0.01, 0.05, 0.1, 0.2]) {
  const row = Ts.map((t) => `${((1 - (1 - q) ** t) * 100).toFixed(1)}%`.padStart(7)).join('');
  console.log(`     ${q.toFixed(2).padStart(6)}  ${row}`);
}
console.log(
  `   q = 0.10, T = 15: 1 − 0.9^15 = ${(1 - 0.9 ** 15).toFixed(4)}, 통화당 느린 턴의 기댓값 q·T = 1.5개`,
);
console.log(
  `   "통화의 90%가 느린 턴 없이" 끝나려면 턴당 q ≤ 1 − 0.9^(1/15) = ${(1 - 0.9 ** (1 / 15)).toFixed(4)} (약 p99.3)`,
);

// ── 3. 구간 p95의 합 vs 전체 p95 ──────────────────────────────────────
console.log(
  '\n3) 구간별 p95를 더한 값과 한 턴 전체의 p95 (가정한 분포의 가상 표본 100,000턴, 시드 고정)',
);
const N = 100_000;
const r3 = rng(13);
const gauss = () => {
  // 박스–뮬러
  const u = 1 - r3();
  const v = r3();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const lognormal = (med, sigma) => med * Math.exp(sigma * gauss());
function simulate(slowProb) {
  const eou = [];
  const ttft = [];
  const ttfb = [];
  const total = [];
  for (let i = 0; i < N; i++) {
    // 말 끝 판단: 확신하면 380~540ms(PoC 범위에 고르게), slowProb의 확률로 p < 기준 → 2,500ms (#39)
    const a = r3() < slowProb ? 2500 : 380 + 160 * r3();
    const b = lognormal(800, 0.15); // LLM 첫 토큰: 중앙 800ms
    const c = lognormal(170, 0.2); // TTS 첫 음성: 중앙 170ms
    eou.push(a);
    ttft.push(b);
    ttfb.push(c);
    total.push(a + b + c);
  }
  return { eou, ttft, ttfb, total };
}
for (const [label, slow] of [
  ['(a) 말 끝 판단이 늘 확신', 0],
  ['(b) 말 끝 판단이 8% 턴에서 2.5초 대기', 0.08],
]) {
  const s = simulate(slow);
  const row = (name, xs) =>
    `     ${name.padEnd(12)} p50 ${fmt(pLinear(xs, 0.5))}  p95 ${fmt(pLinear(xs, 0.95))}  평균 ${fmt(xs.reduce((x, y) => x + y, 0) / xs.length)}`;
  console.log(`   ${label}`);
  console.log(row('말 끝 판단', s.eou));
  console.log(row('LLM 첫 토큰', s.ttft));
  console.log(row('TTS 첫 음성', s.ttfb));
  console.log(row('한 턴 합', s.total));
  const sumP95 = pLinear(s.eou, 0.95) + pLinear(s.ttft, 0.95) + pLinear(s.ttfb, 0.95);
  const sumP50 = pLinear(s.eou, 0.5) + pLinear(s.ttft, 0.5) + pLinear(s.ttfb, 0.5);
  console.log(
    `     구간 p95의 합 ${sumP95.toFixed(0)} vs 전체 p95 ${pLinear(s.total, 0.95).toFixed(0)} (차 ${(sumP95 - pLinear(s.total, 0.95)).toFixed(0)}ms) / 구간 p50의 합 ${sumP50.toFixed(0)} vs 전체 p50 ${pLinear(s.total, 0.5).toFixed(0)}`,
  );
}

// ── 4. 0.11초 차이가 우연인가 (방법 시연) ─────────────────────────────
console.log('\n4) A/B 요약(p50·p90·최소)에 똑같이 맞는 가상 원 값 두 벌 (ms, 실측 아님)');
const sets = {
  '분리가 큰 경우': {
    A: [740, 762, 764, 765, 767, 768, 770, 862, 864, 866, 870, 905],
    B: [530, 560, 585, 605, 625, 645, 660, 662, 664, 668, 790, 792],
  },
  '겹침이 큰 경우': {
    A: [740, 741, 742, 743, 744, 745, 770, 771, 772, 773, 870, 880],
    B: [530, 640, 645, 650, 655, 658, 660, 786, 787, 788, 790, 1500],
  },
};
// 순열 검정: 두 묶음을 섞어 12·12로 다시 나눌 때 |중앙값 차|가 관측값 이상인 비율
function permutationP(A, B, stat, iters, seed) {
  const r = rng(seed);
  const pool = [...A, ...B];
  const obs = Math.abs(stat(A, B));
  let hit = 0;
  for (let i = 0; i < iters; i++) {
    for (let j = pool.length - 1; j > 0; j--) {
      const k = Math.floor(r() * (j + 1));
      [pool[j], pool[k]] = [pool[k], pool[j]];
    }
    if (Math.abs(stat(pool.slice(0, A.length), pool.slice(A.length))) >= obs - 1e-9) hit++;
  }
  return (hit + 1) / (iters + 1);
}
const medDiff = (A, B) => median(A) - median(B);
// Mann–Whitney U: B의 값이 A의 값보다 작은 짝의 수 (같으면 0.5)
const mannWhitneyU = (A, B) => {
  let u = 0;
  for (const b of B) for (const a of A) u += b < a ? 1 : b === a ? 0.5 : 0;
  return u;
};
// 부트스트랩: 각 묶음을 복원 추출로 다시 뽑아 중앙값 차의 2.5%·97.5% 백분위
function bootstrapCI(A, B, iters, seed) {
  const r = rng(seed);
  const draw = (xs) => xs.map(() => xs[Math.floor(r() * xs.length)]);
  const diffs = [];
  for (let i = 0; i < iters; i++) diffs.push(medDiff(draw(A), draw(B)));
  return [pLinear(diffs, 0.025), pLinear(diffs, 0.975)];
}
const uCentered = (x, y) => mannWhitneyU(x, y) - (x.length * y.length) / 2;
for (const [name, { A, B }] of Object.entries(sets)) {
  const summary = (xs) => `p50 ${pFloor(xs, 0.5)} p90 ${pFloor(xs, 0.9)} 최소 ${pFloor(xs, 0)}`;
  const u = mannWhitneyU(A, B);
  const n1 = A.length;
  const n2 = B.length;
  const z = (u - (n1 * n2) / 2) / Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  const pPermU = permutationP(A, B, uCentered, 20_000, 7);
  const pPermMed = permutationP(A, B, medDiff, 20_000, 11);
  const [lo, hi] = bootstrapCI(A, B, 10_000, 5);
  console.log(`   ${name}`);
  console.log(`     Anthropic: ${summary(A)}   (compare-llm 방식으로 센 요약)`);
  console.log(`     Bedrock:   ${summary(B)}`);
  console.log(
    `     중앙값(보간) 차 ${medDiff(A, B).toFixed(1)}ms, 중앙값 차 순열 검정 p = ${pPermMed.toFixed(4)} (20,000번 섞음)`,
  );
  console.log(
    `     Mann–Whitney U = ${u} / ${n1 * n2} (z = ${z.toFixed(2)}), U 순열 p = ${pPermU.toFixed(4)}   중앙값 차 부트스트랩 95% 구간 [${lo.toFixed(1)}, ${hi.toFixed(1)}]ms`,
  );
}
// 요약에 맞는 원 값을 무작위로 많이 만들어 p의 범위를 봄. 빈칸은 허용 범위 안에서 고르게, 가장 느린 값은 1,600ms까지(가정)
console.log('   요약에 맞는 가상 원 값 1,000벌을 무작위로 만들어 본 p의 범위 (각 1,000번 섞음)');
{
  const r = rng(99);
  const uni = (lo, hi) => Math.round(lo + (hi - lo) * r());
  const make = (min, p50, p90) => [
    min,
    ...Array.from({ length: 5 }, () => uni(min, p50)),
    p50,
    ...Array.from({ length: 3 }, () => uni(p50, p90)),
    p90,
    uni(p90, 1600),
  ];
  const pm = [];
  const pu = [];
  const diffs = [];
  for (let i = 0; i < 1000; i++) {
    const A = make(740, 770, 870);
    const B = make(530, 660, 790);
    diffs.push(medDiff(A, B));
    pm.push(permutationP(A, B, medDiff, 1000, 1000 + i));
    pu.push(permutationP(A, B, uCentered, 1000, 5000 + i));
  }
  const range = (xs, d = 4) => `${Math.min(...xs).toFixed(d)} ~ ${Math.max(...xs).toFixed(d)}`;
  console.log(`     중앙값(보간) 차 ${range(diffs, 1)}ms`);
  console.log(
    `     중앙값 차 순열 p ${range(pm)}  (0.05 이상인 벌: ${pm.filter((p) => p >= 0.05).length}/1000)`,
  );
  console.log(
    `     U 순열 p        ${range(pu)}  (0.05 이상인 벌: ${pu.filter((p) => p >= 0.05).length}/1000)`,
  );
}
console.log(
  '   → 요약만으로도 "중앙값이 다르다"는 매번 p < 0.05였지만, 분포 전체(U)와 차이의 크기(구간)는 원 값에 따라 갈립니다.',
);
// 짝지은 부호 검정 (번갈아 부른 회차끼리): 12쌍 중 B가 빠른 쌍이 k개일 때 양쪽 p
const choose = (n, k) => {
  let c = 1;
  for (let i = 1; i <= k; i++) c = (c * (n - k + i)) / i;
  return c;
};
const signP = (n, k) => {
  let tail = 0;
  for (let i = k; i <= n; i++) tail += choose(n, i);
  return Math.min(1, (2 * tail) / 2 ** n);
};
console.log(
  `   짝지은 부호 검정 (12쌍): B가 빠른 쌍 9개 p = ${signP(12, 9).toFixed(4)}, 10개 p = ${signP(12, 10).toFixed(4)}, 11개 p = ${signP(12, 11).toFixed(4)}`,
);
