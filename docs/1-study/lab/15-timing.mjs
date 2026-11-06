// 15장 실습: 타이밍 공격의 숫자 감 — 비교 시간 차(ns)와 네트워크 흔들림(µs~ms)
//  1) 64자 비밀값을 ===로 비교할 때 첫 글자에서 다른 경우와 마지막 글자에서 다른 경우의 시간 차
//  2) crypto.timingSafeEqual은 어디서 달라지든 같은 시간인지
//  3) 같은 컴퓨터 안(127.0.0.1)의 HTTP 왕복조차 얼마나 흔들리는지
//  4) 그 흔들림 속에서 차이를 가려내려면 요청이 몇 번 필요한지 (손 계산 식에 실측값 대입)
//
// 실행: 레포 루트에서  node docs/1-study/lab/15-timing.mjs   (약 5초)
// 기준: Node 24. 2026-11-06 작성. 비밀값은 실행할 때마다 만드는 무작위 값입니다.
// 키·.env.local·외부 네트워크를 쓰지 않습니다. 3번은 127.0.0.1에 잠깐 HTTP 서버를 띄웁니다.
// ns 단위 측정은 JIT·CPU 주파수·다른 부하에 따라 크게 흔들립니다. 자릿수만 보세요.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';

const secret = randomBytes(32).toString('hex'); // functions-xtool 비밀키처럼 긴 무작위 문자열(64자)
// 같은 길이, 한 글자만 다른 추측값. 문자열을 실행 중에 새로 만들어 V8의 문자열 내부화(포인터 비교)를 피한다
const guess = (pos) => {
  const a = [...secret];
  a[pos] = a[pos] === '0' ? '1' : '0';
  return Buffer.from(a.join('')).toString();
};
const S = Buffer.from(secret).toString();
const early = guess(0);
const late = guess(63);
const [sb, eb, lb] = [S, early, late].map((s) => Buffer.from(s));

function nsPerCall(fn, n) {
  let sink = 0;
  const t = process.hrtime.bigint();
  for (let i = 0; i < n; i++) sink += fn() ? 1 : 0;
  const ns = Number(process.hrtime.bigint() - t) / n;
  if (sink < 0) console.log(sink); // 최적화로 없어지지 않게
  return ns;
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ── 1·2. 비교 시간 ───────────────────────────────────────────
nsPerCall(() => S === early, 1e6); // 데우기
const rounds = { eqEarly: [], eqLate: [], tseEarly: [], tseLate: [] };
for (let r = 0; r < 7; r++) {
  rounds.eqEarly.push(nsPerCall(() => S === early, 2e6));
  rounds.eqLate.push(nsPerCall(() => S === late, 2e6));
  rounds.tseEarly.push(nsPerCall(() => timingSafeEqual(sb, eb), 3e5));
  rounds.tseLate.push(nsPerCall(() => timingSafeEqual(sb, lb), 3e5));
}
const m = Object.fromEntries(Object.entries(rounds).map(([k, v]) => [k, median(v)]));
const deltaAll = m.eqLate - m.eqEarly;
const deltaPerChar = deltaAll / 63;
console.log('== 1·2. 비교 한 번의 시간 (7회 중앙값) ==');
console.log(
  `   ===            첫 글자 다름 ${m.eqEarly.toFixed(2)}ns, 마지막 글자 다름 ${m.eqLate.toFixed(2)}ns → 차이 ${deltaAll.toFixed(2)}ns (글자당 약 ${deltaPerChar.toFixed(3)}ns)`,
);
console.log(
  `   timingSafeEqual 첫 글자 다름 ${m.tseEarly.toFixed(1)}ns, 마지막 글자 다름 ${m.tseLate.toFixed(1)}ns → 차이 ${(m.tseLate - m.tseEarly).toFixed(1)}ns (잡음 수준)`,
);

// ── 3. 127.0.0.1 HTTP 왕복의 흔들림 ──────────────────────────
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => res.end(S === req.headers['x-secret'] ? 'ok' : 'no'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
const once = () =>
  new Promise((resolve, reject) => {
    const t = process.hrtime.bigint();
    const rq = request(
      { host: '127.0.0.1', port, method: 'POST', headers: { 'x-secret': early } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(Number(process.hrtime.bigint() - t) / 1000)); // µs
      },
    );
    rq.on('error', reject);
    rq.end();
  });
for (let i = 0; i < 200; i++) await once(); // 데우기
const rtts = [];
for (let i = 0; i < 2000; i++) rtts.push(await once());
server.close();
const mean = rtts.reduce((a, b) => a + b, 0) / rtts.length;
const sd = Math.sqrt(rtts.reduce((a, b) => a + (b - mean) ** 2, 0) / (rtts.length - 1));
const sorted = [...rtts].sort((a, b) => a - b);
const pct = (p) => sorted[Math.floor((p / 100) * (sorted.length - 1))];
console.log('\n== 3. 127.0.0.1 HTTP 왕복 2,000번 ==');
console.log(
  `   평균 ${mean.toFixed(0)}µs, 표준편차 σ ${sd.toFixed(0)}µs, p50 ${pct(50).toFixed(0)}µs, p99 ${pct(99).toFixed(0)}µs`,
);

// ── 4. 필요한 요청 수 ────────────────────────────────────────
// 두 무리(맞은 추측 / 틀린 추측)의 평균 차 δ를 잡음 σ 속에서 z배 확신으로 가르려면
// 무리마다 n ≥ 2·(z·σ/δ)²  (두 평균 차의 표준오차 = σ·√(2/n))
const need = (sigmaNs, deltaNs, z = 3) => 2 * ((z * sigmaNs) / deltaNs) ** 2;
const fmt = (x) => x.toExponential(1).replace('e+', '×10^');
const sigmaLocal = sd * 1000; // ns
const sigmaNet = 1e6; // 가정: 인터넷 경유 1ms
console.log('\n== 4. 한 글자를 가려내는 데 필요한 요청 수 (z = 3, 무리마다) ==');
for (const [label, sigma] of [
  [`같은 컴퓨터 σ ${sd.toFixed(0)}µs (실측)`, sigmaLocal],
  ['인터넷 σ 1ms (가정)', sigmaNet],
]) {
  const n = need(sigma, deltaPerChar);
  const years = (n * 16) / 1000 / 86400 / 365; // 후보 16개(hex), 초당 1,000번 보낸다고 치면
  console.log(
    `   ${label}: n ≈ ${fmt(n)}번  → 후보 16개를 초당 1,000번씩 시험하면 약 ${fmt(years)}년`,
  );
}
