// 6장 실습: 음성 인식 디코딩을 숫자로 따라가기 (학습서 6-2·6-6절 깊이 보기).
//  1) 전형적인 프런트엔드: 1초가 몇 프레임, 몇 스텝이 되나
//  2) CTC: 3프레임 확률표에서 P("네") = 모든 정렬의 합 (전부 나열 + 앞쪽 알고리즘 α표)
//  3) 탐욕 탐색 vs 접두사 빔 탐색: 프레임마다 최고만 고르면 "네"를 놓치는 예
//  4) 로그 확률이 필요한 이유: 확률을 1,500번 곱하면 0이 됨
//  5) RNN-T 격자: T×U 칸, blank는 시간을 한 칸, 글자는 출력을 한 칸
//  6) 얕은 융합 + 키워드 가산점: "메탈 백" ↔ "메탈팹" 순위가 뒤집히는 구간
//
// 실행 (레포 루트에서):  node docs/1-study/lab/06-decoding.mjs
// 기준: Node 24. 외부 패키지·키·네트워크를 쓰지 않는 순수 계산입니다 (2026-11-06).
// 확률표와 점수는 설명용으로 지어낸 숫자입니다. Soniox 내부 구조와 값은 공개되지 않았습니다.

const f3 = (x) => x.toFixed(3);

// 1) 프런트엔드: 25ms 창, 10ms 홉(2-8절과 같은 전형값), 인코더가 시간축을 4배 줄인다고 가정
console.log('1) 전형적인 프런트엔드 (16kHz, 25ms 창, 10ms 홉, log-mel 80차원, 4배 줄임)');
const SR = 16000;
const WIN = 400;
const HOP = 160;
const noPad = Math.floor((SR - WIN) / HOP) + 1;
console.log(
  `   1초 = 창 ${noPad}개(패딩 없음) / ${SR / HOP}개(앞뒤를 채우면) → 숫자 ${SR / HOP}×80 = ${(SR / HOP) * 80}개`,
);
console.log(`   4배 줄이면 1초 = ${SR / HOP / 4}스텝, 스텝 하나 = ${(1000 * 4 * HOP) / SR}ms`);
console.log(
  `   "네, 괜찮아요"(1.2초, 글자 6개) → ${1.2 * (SR / HOP / 4)}스텝. 스텝이 글자보다 훨씬 많아 대부분 blank`,
);

// 2) CTC. 어휘는 blank(_)와 '네' 둘뿐. 프레임마다 확률의 합은 1.
const V = ['_', '네'];
const Y = [
  [0.6, 0.4], // t1: P(_), P(네)
  [0.6, 0.4], // t2
  [0.6, 0.4], // t3
];
/** CTC 접기: 연속 반복을 하나로 합친 뒤 blank를 지웁니다. */
const collapse = (path) =>
  path
    .filter((s, i) => i === 0 || s !== path[i - 1])
    .filter((s) => s !== '_')
    .join('');

console.log('\n2) CTC 확률표 (프레임마다 P(_)=0.6, P(네)=0.4)');
const byLabel = new Map();
for (let mask = 0; mask < 2 ** Y.length; mask++) {
  const path = Y.map((_, t) => V[(mask >> (Y.length - 1 - t)) & 1]);
  const p = path.reduce((acc, s, t) => acc * Y[t][V.indexOf(s)], 1);
  const label = collapse(path) || '(빈 글)';
  byLabel.set(label, (byLabel.get(label) ?? 0) + p);
  console.log(`   경로 ${path.join('')} → 접으면 ${label.padEnd(5)}  확률 ${f3(p)}`);
}
console.log(`   글별 합: ${[...byLabel].map(([l, p]) => `P(${l}) = ${f3(p)}`).join(', ')}`);

// 앞쪽 알고리즘(forward). 확장 라벨 l' = _ 네 _ 위에서 α(t, s)를 채웁니다.
//   α(t,s) = (α(t-1,s) + α(t-1,s-1) [+ α(t-1,s-2): l'(s)가 blank가 아니고 l'(s-2)와 다를 때]) × y_t(l'(s))
const target = ['네'];
const ext = ['_', ...target.flatMap((c) => [c, '_'])];
const alpha = Y.map(() => ext.map(() => 0));
alpha[0][0] = Y[0][V.indexOf('_')];
alpha[0][1] = Y[0][V.indexOf(ext[1])];
for (let t = 1; t < Y.length; t++) {
  for (let s = 0; s < ext.length; s++) {
    let sum = alpha[t - 1][s] + (s >= 1 ? alpha[t - 1][s - 1] : 0);
    if (s >= 2 && ext[s] !== '_' && ext[s] !== ext[s - 2]) sum += alpha[t - 1][s - 2];
    alpha[t][s] = sum * Y[t][V.indexOf(ext[s])];
  }
}
console.log(`   앞쪽 알고리즘 α표 (열: 확장 라벨 ${ext.join(' ')})`);
alpha.forEach((row, t) => console.log(`     t${t + 1}: ${row.map(f3).join('  ')}`));
const last = alpha[Y.length - 1];
console.log(
  `   P(네) = α(t3, 네) + α(t3, 끝 _) = ${f3(last[ext.length - 2])} + ${f3(last[ext.length - 1])} = ${f3(last[ext.length - 2] + last[ext.length - 1])}`,
);

// 3) 탐욕 탐색과 접두사 빔 탐색
const greedy = Y.map((row) => V[row.indexOf(Math.max(...row))]);
console.log('\n3) 탐욕 탐색 vs 빔 탐색');
console.log(
  `   탐욕(프레임마다 최고): ${greedy.join('')} → "${collapse(greedy)}" (경로 확률 ${f3(0.6 ** 3)})`,
);
/** CTC 접두사 빔 탐색. 접두사마다 "blank로 끝난 확률 pb"와 "글자로 끝난 확률 pnb"를 따로 들고 갑니다. */
function prefixBeam(width) {
  let beam = new Map([['', { pb: 1, pnb: 0 }]]);
  const trace = [];
  for (const row of Y) {
    const next = new Map();
    const add = (prefix, pb, pnb) => {
      const e = next.get(prefix) ?? { pb: 0, pnb: 0 };
      e.pb += pb;
      e.pnb += pnb;
      next.set(prefix, e);
    };
    for (const [prefix, { pb, pnb }] of beam) {
      add(prefix, (pb + pnb) * row[0], 0); // blank: 접두사 그대로
      for (let k = 1; k < V.length; k++) {
        const c = V[k];
        const lastChar = prefix.at(-1);
        if (c === lastChar) {
          add(prefix, 0, pnb * row[k]); // 같은 글자 반복: 합쳐짐
          add(prefix + c, 0, pb * row[k]); // blank를 사이에 둔 반복: 새 글자
        } else {
          add(prefix + c, 0, (pb + pnb) * row[k]);
        }
      }
    }
    beam = new Map(
      [...next].sort((a, b) => b[1].pb + b[1].pnb - (a[1].pb + a[1].pnb)).slice(0, width),
    );
    trace.push([...beam].map(([p, e]) => `"${p}" ${f3(e.pb + e.pnb)}`).join(', '));
  }
  return trace;
}
for (const width of [1, 2]) {
  const trace = prefixBeam(width);
  console.log(`   빔 폭 ${width}: ${trace.map((s, t) => `t${t + 1}[${s}]`).join(' → ')}`);
}

// 4) 로그 확률
console.log('\n4) 왜 로그 확률인가 (15초 = 1,500프레임, 프레임마다 0.6)');
console.log(
  `   0.6을 1,500번 곱하면: ${0.6 ** 1500}  ← double의 가장 작은 수(약 5e-324)보다 작아 0이 됨`,
);
console.log(`   로그로 더하면: 1500 × ln 0.6 = ${(1500 * Math.log(0.6)).toFixed(1)}  ← 문제없음`);
const lse = (a, b) => Math.max(a, b) + Math.log1p(Math.exp(-Math.abs(a - b)));
console.log(
  `   로그끼리 "더하기"(합 확률)는 log-sum-exp: ln(0.304 + 0.384) = ${lse(Math.log(0.304), Math.log(0.384)).toFixed(4)} = ln ${f3(Math.exp(lse(Math.log(0.304), Math.log(0.384))))}`,
);

// 5) RNN-T 격자. 프레임 T=3, 글 "네요"(U=2). 칸 (t,u) = "t번째 프레임까지 보고 글자 u개를 냄".
//    칸마다 예측 네트워크가 지금까지 낸 글자를 보므로, 같은 프레임이라도 u에 따라 확률이 다릅니다.
const T = 3;
const LBL = ['네', '요'];
const P_LABEL = [
  [0.5, 0.3, 0.1], // u=0에서 '네'를 낼 확률 (t1, t2, t3)
  [0.3, 0.6, 0.2], // u=1에서 '요'를 낼 확률 ('네' 다음이라 t2에서 높음)
];
const P_BLANK = [
  [0.4, 0.6, 0.8], // u=0
  [0.6, 0.3, 0.7], // u=1
  [0.9, 0.9, 0.95], // u=2 (다 냄)
];
console.log(`\n5) RNN-T 격자 (T=${T}프레임, 글 "${LBL.join('')}", U=${LBL.length})`);
const paths = [];
(function walk(t, u, moves, p) {
  if (t === T - 1 && u === LBL.length) {
    paths.push({ moves: [...moves, `t${t + 1}:∅`], p: p * P_BLANK[u][t] });
    return;
  }
  if (u < LBL.length) walk(t, u + 1, [...moves, `t${t + 1}:${LBL[u]}`], p * P_LABEL[u][t]); // 글자: 위로
  if (t < T - 1) walk(t + 1, u, [...moves, `t${t + 1}:∅`], p * P_BLANK[u][t]); // blank: 오른쪽으로
})(0, 0, [], 1);
for (const { moves, p } of paths)
  console.log(`   ${moves.join(' ').padEnd(30)} 확률 ${p.toFixed(4)}`);
const total = paths.reduce((a, b) => a + b.p, 0);
console.log(
  `   경로 ${paths.length}개 (= C(T+U-1, U) = C(4,2) = 6), P("네요") = 합 ${total.toFixed(4)}`,
);

// 6) 얕은 융합: 점수 = ln P_AM + λ·ln P_LM + μ·[키워드 수]
console.log('\n6) 얕은 융합 점수 = ln P_AM + λ·ln P_LM + μ·[키워드]   (λ = 0.3)');
const LAMBDA = 0.3;
const LM = { '메탈 백': 1e-4, 메탈팹: 1e-7 }; // 흔한 말 vs 학습 데이터에 드문 말
const KEYWORD = { '메탈 백': 0, 메탈팹: 1 };
const cases = [
  ['고객이 "메탈팹"이라고 말함', { '메탈 백': 0.35, 메탈팹: 0.4 }],
  ['고객이 정말 "메탈 백"(금속 가방)이라고 말함', { '메탈 백': 0.6, 메탈팹: 0.15 }],
];
for (const [title, am] of cases) {
  console.log(`   ${title}: P_AM 메탈 백 ${am['메탈 백']}, 메탈팹 ${am['메탈팹']}`);
  const base = (y) => Math.log(am[y]) + LAMBDA * Math.log(LM[y]);
  for (const mu of [0, 3, 4]) {
    const s = (y) => base(y) + mu * KEYWORD[y];
    const win = s('메탈 백') > s('메탈팹') ? '메탈 백' : '메탈팹';
    console.log(
      `     μ=${mu}: 메탈 백 ${s('메탈 백').toFixed(3)}, 메탈팹 ${s('메탈팹').toFixed(3)} → "${win}"`,
    );
  }
  console.log(`     뒤집히는 μ = ${(base('메탈 백') - base('메탈팹')).toFixed(3)}`);
}
