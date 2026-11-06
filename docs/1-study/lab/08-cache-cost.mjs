// 8장 실습: 프롬프트 캐시의 턴별 읽기·쓰기와 비용을 손으로 따라가기 (학습서 8-4절 깊이 보기).
//  1) 지금 요청의 토큰 수 어림: 글자 수 × PoC에서 얻은 비율 + 문서의 도구 사용 system 프롬프트
//  2) 8턴 통화의 턴별 표: 1턴은 거의 전부 쓰기, N턴은 직전 요청 전체를 읽고 새 끝부분만 쓰기
//  3) 캐시 없음 vs 자동 캐시 비용 (Haiku 5.5 단가, 문서 기준)
//  4) 제안 둘의 셈: 통화 사이 공유(지시문 두 블록), 고지 동안 미리 쓰기(max_tokens: 0)
//
// 실행 (레포 루트에서):  node docs/1-study/lab/08-cache-cost.mjs
// 기준: Node 24. 키·네트워크를 쓰지 않습니다 (2026-11-06). 토큰 수는 추정입니다. 실제 값은 count_tokens(무료,
// 키 필요)나 응답의 usage로 재야 합니다. 단가는 platform.claude.com 가격 문서(2026-11-06 확인)의 값입니다.
import { SAMPLE_CALL } from '../../../src/call-context.ts';
import { OPENING_QUESTION, buildInstructions, openingNotice } from '../../../src/prompt.ts';

// ── 문서 기준 값
const PRICE = { input: 0.1, write5m: 0.125, read: 0.01, output: 0.5 }; // $/백만 토큰, 프롬프트 10만 토큰 이하
const TOOL_SYSTEM_PROMPT = 286; // 도구를 쓰면 API가 넣는 도구 사용 system 프롬프트, Haiku 5.5, tool_choice auto
// ── PoC 실측에서 얻은 비율(추정의 근거): 2026-11-03 check-llm 2회차 캐시 적중 2,384토큰,
//    그때(커밋 5cb4046) 요청 글은 지시문 2,291자 + 첫 멘트 109자 + 고객 말 48자 + "(empty)" 7자 = 2,455자
const TOK_PER_CHAR = 2384 / 2455;

const instr = buildInstructions(SAMPLE_CALL);
const opening = `${openingNotice(SAMPLE_CALL)}${OPENING_QUESTION}`;
const est = (s) => Math.round(s.length * TOK_PER_CHAR);
console.log('1) 지금 요청의 토큰 어림 (추정)');
console.log(`   글자당 토큰 = 2,384 ÷ 2,455 = ${TOK_PER_CHAR.toFixed(3)} (한국어가 대부분인 글, Haiku 5.5)`);
const parts = [
  ['도구 사용 system 프롬프트 (문서 값)', TOOL_SYSTEM_PROMPT],
  // 영어 설명(LiveKit 기본) 395자 + 한국어 덧붙임 62자. 영어는 글자당 약 0.25토큰, 이름·스키마에 20을 어림
  ['end_call 정의 (영어 395자는 글자당 0.25, 한국어 62자, 이름·스키마 20)', Math.round(395 * 0.25 + 62 * TOK_PER_CHAR + 20)],
  [`지시문 ${instr.length}자`, est(instr)],
  [`"(empty)" + 첫 멘트 두 블록 ${opening.length}자`, est(opening) + 3],
];
let prefix = 0;
for (const [name, n] of parts) {
  prefix += n;
  console.log(`   ${name.padEnd(64)} ${String(n).padStart(5)}`);
}
console.log(`   ${'첫 고객 말 앞까지 (앞부분)'.padEnd(64)} ${String(prefix).padStart(5)}  → 아래 표는 3,500으로 둥글림`);

// ── 2) 턴별 표
const P = 3500; // 앞부분
const U = 30; // 고객 말 한 번
const A = 70; // AI 답 한 번(출력 토큰이자 다음 요청의 입력)
const TURNS = 8;
const usd = (x) => `$${x.toFixed(6)}`;
console.log(`\n2) ${TURNS}턴 통화 (앞부분 ${P}, 고객 말 ${U}, AI 답 ${A}토큰으로 가정). 자동 캐시는 마지막 블록에 브레이크포인트`);
console.log('   턴  요청 입력   읽기(0.1×)  쓰기(1.25×)  출력   이 턴 비용       캐시 없을 때');
let reqPrev = 0;
const sum = { in: 0, read: 0, write: 0, out: 0, cost: 0, nocache: 0 };
for (let n = 1; n <= TURNS; n++) {
  const req = P + (n - 1) * (U + A) + U;
  const read = n === 1 ? 0 : reqPrev; // 직전 요청의 브레이크포인트까지 = 직전 요청 전체
  const write = req - read; // 나머지는 이번 브레이크포인트까지라 전부 씀 (input_tokens는 꼬리 몇 개라 0으로 둠)
  const cost = (read * PRICE.read + write * PRICE.write5m + A * PRICE.output) / 1e6;
  const nocache = (req * PRICE.input + A * PRICE.output) / 1e6;
  console.log(
    `   ${String(n).padStart(2)}  ${String(req).padStart(8)}  ${String(read).padStart(10)}  ${String(write).padStart(11)}  ${String(A).padStart(4)}   ${usd(cost)}    ${usd(nocache)}`,
  );
  Object.assign(sum, {
    in: sum.in + req,
    read: sum.read + read,
    write: sum.write + write,
    out: sum.out + A,
    cost: sum.cost + cost,
    nocache: sum.nocache + nocache,
  });
  reqPrev = req;
}
console.log(`   합  ${String(sum.in).padStart(8)}  ${String(sum.read).padStart(10)}  ${String(sum.write).padStart(11)}  ${String(sum.out).padStart(4)}   ${usd(sum.cost)}    ${usd(sum.nocache)}`);

// ── 3) 비교
const inCache = (sum.read * PRICE.read + sum.write * PRICE.write5m) / 1e6;
const inNo = (sum.in * PRICE.input) / 1e6;
console.log('\n3) 입력 비용만 보면');
console.log(`   캐시 없음: ${sum.in.toLocaleString()} × $0.10/M = ${usd(inNo)}`);
console.log(
  `   자동 캐시: 읽기 ${sum.read.toLocaleString()} × $0.01/M + 쓰기 ${sum.write.toLocaleString()} × $0.125/M = ${usd(inCache)}  (${((1 - inCache / inNo) * 100).toFixed(0)}% 줄어듦)`,
);
console.log(`   1턴만 보면 쓰기 1.25배라 캐시 없을 때보다 ${(((P + U) * (PRICE.write5m - PRICE.input)) / 1e6).toFixed(6)}달러 더 냄. 2턴부터 이득`);
console.log(`   통화 하나 전체(출력 포함) ${usd(sum.cost)} ≈ ${(sum.cost * 1400).toFixed(1)}원 (1달러 1,400원으로 가정)`);

// ── 4) 제안의 셈
const SHARED = 286 + parts[1][1] + Math.round((instr.indexOf('# 고객 정보') + 0) * TOK_PER_CHAR); // 도구 + 공통 지시
console.log('\n4) 제안 둘의 셈 (추정)');
console.log(`   ① 통화 사이 공유: 공통 앞부분(도구 + 고객 정보 앞까지의 지시문) 약 ${SHARED}토큰을 다음 통화가 5분 안에 시작하면 읽음`);
console.log(
  `      1턴에서 아끼는 돈 ${SHARED} × ($0.125 − $0.01)/M = ${usd((SHARED * (PRICE.write5m - PRICE.read)) / 1e6)} / 통화. 돈보다는 1턴 프리필을 건너뛰는 지연 쪽이 목적`,
);
console.log(
  `   ② 고지 동안 미리 쓰기: max_tokens 0 요청이 도구 + 지시문(약 ${P - est(opening) - 3}토큰)을 써 두면, 1턴 요청은 그것을 읽고 나머지만 씀`,
);
const warm = P - est(opening) - 3;
console.log(
  `      쓰기 총량은 같고 더 드는 것은 1턴의 읽기 ${warm} × $0.01/M = ${usd((warm * PRICE.read) / 1e6)} + 미리 쓰기 요청의 자리표시 user 몇 토큰`,
);
