// 9장 실습: 지시문(buildInstructions)을 해부합니다 (학습서 9-1·9-2·9-3절).
//  1) 전체 크기: 글자 수, UTF-8 바이트, 줄 수, JSON 본문에 실릴 때의 바이트
//  2) 절별 시작 위치(글자·바이트)와 크기, 한글·ASCII·기타 글자 구성
//  3) 통화 둘의 지시문이 어디서 갈라지는지(공유 접두사)와, 그 경계가 요청의 블록 경계와 맞는지
//  4) 지식 파일이 들어갈 자리, 고객 정보가 비었을 때의 모양, 첫 멘트 크기
//
// 실행 (레포 루트에서):  node docs/1-study/lab/09-prompt-anatomy.mjs
// 기준: Node 24, @livekit/agents 1.9.5 (2026-11-06). 키·.env.local·네트워크를 쓰지 않습니다.
// 레포의 src/prompt.ts, src/call-context.ts, src/knowledge.ts를 그대로 import합니다(Node 24가 TS를 직접 읽음).
// 고객은 SAMPLE_CALL의 가상 고객과 그 이름만 바꾼 가상 고객만 씁니다.
// 토큰 수는 재지 않습니다. 토큰은 모델의 토크나이저가 정하므로 count_tokens API로 재야 합니다(9-2절 깊이 보기).
import { SAMPLE_CALL, parseCallContext } from '../../../src/call-context.ts';
import { loadKnowledge } from '../../../src/knowledge.ts';
import { OPENING_QUESTION, buildInstructions, openingNotice } from '../../../src/prompt.ts';

const bytes = (s) => Buffer.byteLength(s, 'utf8');
const n = (x) => x.toLocaleString('en-US');
// 한글은 터미널에서 두 칸을 차지하므로 폭을 맞출 때 두 칸으로 셉니다.
const width = (s) => [...String(s)].reduce((a, ch) => a + (/[가-힣]/.test(ch) ? 2 : 1), 0);
const pad = (s, w) => ' '.repeat(Math.max(0, w - width(s))) + String(s);
const padEnd = (s, w) => String(s) + ' '.repeat(Math.max(0, w - width(s)));
const oneLine = (s) => s.replaceAll('\n', '⏎');

/** 글자를 종류별로 셉니다. 한글 음절(가~힣)은 UTF-8로 3바이트, ASCII는 1바이트입니다. */
function composition(s) {
  let hangul = 0;
  let ascii = 0;
  let other = 0;
  const others = new Set();
  for (const ch of s) {
    if (/[가-힣]/.test(ch)) hangul++;
    else if (ch.charCodeAt(0) < 0x80) ascii++;
    else {
      other++;
      others.add(ch);
    }
  }
  return { hangul, ascii, other, others: [...others].join('') };
}

const text = buildInstructions(SAMPLE_CALL, loadKnowledge());

// ── 1) 전체 크기
console.log('1) 지시문 전체 (SAMPLE_CALL, 지금 지식 파일)');
const codePoints = [...text].length;
const lines = text.split('\n');
const jsonBytes = bytes(JSON.stringify(text)); // 요청 본문 JSON 안의 "system":[{"text": …}] 값
const c = composition(text);
console.log(
  `  글자 수(JS length)      ${n(text.length)}  (코드 포인트 ${n(codePoints)}: 한글은 모두 BMP라 같음)`,
);
console.log(`  UTF-8 바이트            ${n(bytes(text))}`);
console.log(
  `  줄 수                   ${lines.length}  (빈 줄 ${lines.filter((l) => !l.trim()).length})`,
);
console.log(
  `  구성                    한글 음절 ${n(c.hangul)}×3B + ASCII ${n(c.ascii)}×1B + 기타 ${c.other}자("${c.others}")`,
);
console.log(
  `  JSON 문자열로 실을 때   ${n(jsonBytes)}B  (따옴표 2 + 줄바꿈 ${lines.length - 1}개가 \\n 두 바이트로, 큰따옴표 이스케이프)`,
);
const knowledge = loadKnowledge();
console.log(
  `  지식 파일(knowledge/xtool.md) 정리 뒤 ${knowledge.length}자 → ${knowledge ? '"# 회사·기기 정보" 절 있음' : '절을 만들지 않음'}`,
);

// ── 2) 절별 위치와 크기
console.log('\n2) 절별 시작 위치와 크기 (위치는 지시문 첫 글자부터 0으로 셈)');
const starts = [{ title: '(역할과 맥락)', at: 0 }];
for (let at = text.indexOf('# '); at >= 0; at = text.indexOf('\n# ', at + 1)) {
  const lineStart = text[at] === '\n' ? at + 1 : at;
  starts.push({ title: text.slice(lineStart, text.indexOf('\n', lineStart)), at: lineStart });
}
const header = `  ${padEnd('절', 34)}${pad('시작(자)', 9)}${pad('시작(B)', 9)}${pad('글자', 7)}${pad('바이트', 8)}${pad('한글', 6)}${pad('ASCII', 7)}${pad('기타', 5)}`;
console.log(header);
for (let i = 0; i < starts.length; i++) {
  const { title, at } = starts[i];
  const end = i + 1 < starts.length ? starts[i + 1].at : text.length;
  const part = text.slice(at, end);
  const k = composition(part);
  console.log(
    `  ${padEnd(title.length > 30 ? `${title.slice(0, 29)}…` : title, 34)}${pad(n(at), 9)}${pad(n(bytes(text.slice(0, at))), 9)}${pad(n(part.length), 7)}${pad(n(bytes(part)), 8)}${pad(k.hangul, 6)}${pad(k.ascii, 7)}${pad(k.other, 5)}`,
  );
}

// ── 3) 두 통화의 지시문이 갈라지는 곳
console.log('\n3) 통화 둘의 지시문이 갈라지는 곳 (공유 접두사)');
const firstDiff = (a, b) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const variants = [
  ['이름만 다름', { ...SAMPLE_CALL, customerName: '이영희' }],
  ['기기만 다름', { ...SAMPLE_CALL, device: '메탈팹' }],
  ['할부만 다름', { ...SAMPLE_CALL, installment: '희망 안 함' }],
  ['신청서가 빔', parseCallContext('{}')],
];
const customerAt = text.indexOf('# 고객 정보');
console.log(`  "# 고객 정보" 시작 = ${n(customerAt)}자 (${n(bytes(text.slice(0, customerAt)))}B)`);
for (const [label, ctx] of variants) {
  const other = buildInstructions(ctx, knowledge);
  const d = firstDiff(text, other);
  const lineStart = text.lastIndexOf('\n', d - 1) + 1;
  console.log(
    `  ${padEnd(label, 14)} 첫 차이 ${pad(n(d), 5)}자 = ${pad(n(bytes(text.slice(0, d))), 5)}B  ` +
      `"${oneLine(text.slice(lineStart, d))}|${oneLine(text.slice(d, d + 6))}…" ↔ "|${oneLine(other.slice(d, d + 6))}…"  (전체 ${n(other.length)}자)`,
  );
}

// 요청 안에서 캐시가 걸 수 있는 자리(블록 경계)를 그립니다. 렌더 순서는 tools → system → messages.
console.log('\n  요청 안의 블록(캐시 위치가 될 수 있는 경계)과 갈라지는 곳');
console.log('    지금 구조: 지시문 전체가 system 블록 하나');
console.log(
  '      [tools: end_call] | [system[0]: 지시문 ' +
    n(text.length) +
    '자] | [messages …] ← 최상위 자동 캐시는 맨 끝 블록에',
);
console.log(
  `                           ${' '.repeat(10)}↑ ${n(customerAt)}자에서 갈라짐: 블록 안이라 이 자리에 캐시 위치를 둘 수 없음`,
);
const guidePart = text.slice(0, customerAt).replace(/\n+$/, '');
const customerPart = text.slice(customerAt);
console.log('    블록을 나누면 (제안, 코드는 그대로):');
console.log(
  `      [tools: end_call] | [system[0]: 지시+지식 ${n(guidePart.length)}자 ★cache_control] | [system[1]: 고객 정보 ${customerPart.length}자] | [messages …]`,
);
console.log(
  '      ★ 통화가 달라도 여기까지는 바이트가 같으므로 다른 통화의 첫 요청이 읽을 수 있는 자리',
);

// ── 4) 지식·빈 신청서·첫 멘트
console.log('\n4) 지식이 들어갈 자리, 빈 신청서, 첫 멘트');
const withKnowledge = buildInstructions(SAMPLE_CALL, '## 방문체험\n- 매장 위치: (예시)');
const kAt = withKnowledge.indexOf('# 회사·기기 정보');
console.log(
  `  예시 지식을 넣으면 "# 회사·기기 정보" 시작 ${n(kAt)}자, "# 고객 정보" 시작 ${n(withKnowledge.indexOf('# 고객 정보'))}자 (지식은 공유 접두사 안)`,
);
const empty = buildInstructions(parseCallContext('{}'), knowledge);
console.log('  신청서가 빈 통화의 고객 정보 절:');
for (const line of empty.slice(empty.indexOf('# 고객 정보')).split('\n'))
  console.log(`    ${line}`);
const notice = openingNotice(SAMPLE_CALL);
console.log(`  첫 멘트 고지  ${notice.length}자 ${bytes(notice)}B: "${notice}"`);
console.log(
  `  첫 멘트 질문  ${OPENING_QUESTION.length}자 ${bytes(OPENING_QUESTION)}B: "${OPENING_QUESTION}"`,
);
