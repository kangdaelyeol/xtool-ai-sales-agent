// 6장 실습: 레벤슈타인 DP 표로 CER과 WER 손 계산하기 (학습서 6-9절 깊이 보기).
//  1) 정답 "메탈팹이랑 피쓰리도" vs Deepgram 결과 "메탈 팩이랑 P 3도"의 글자 DP 표
//  2) 표를 거꾸로 따라가 치환(S)·삭제(D)·삽입(I) 찾기
//  3) 공백 포함·제외 CER, 단어 WER 비교
//  4) 코드 보정(src/transcript.ts) 뒤와, 정답을 "쓰는 형식"으로 적었을 때
//
// 실행 (레포 루트에서):  node docs/1-study/lab/06-cer.mjs
// 기준: Node 24 (2026-11-06). 키·네트워크를 쓰지 않습니다. 보정 함수만 레포의 src/transcript.ts를 그대로 씁니다.
import { correctTranscript } from '../../../src/transcript.ts';

/** 레벤슈타인 DP. d[i][j] = 정답 앞 i개를 결과 앞 j개로 바꾸는 최소 편집 수. */
function dp(ref, hyp) {
  const d = Array.from({ length: ref.length + 1 }, (_, i) =>
    Array.from({ length: hyp.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= ref.length; i++)
    for (let j = 1; j <= hyp.length; j++)
      d[i][j] = Math.min(
        d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1), // 같음 또는 치환 (대각선)
        d[i - 1][j] + 1, // 삭제: 정답 글자가 결과에 없음 (위에서)
        d[i][j - 1] + 1, // 삽입: 결과에 없던 글자가 끼어듦 (왼쪽에서)
      );
  return d;
}

/** 오른쪽 아래에서 왼쪽 위로 거꾸로 따라가며 편집을 복원합니다. 동점이면 대각선 → 삭제 → 삽입 순. */
function backtrace(ref, hyp, d) {
  const ops = [];
  let i = ref.length;
  let j = hyp.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push(
        ref[i - 1] === hyp[j - 1] ? ['=', ref[i - 1], hyp[j - 1]] : ['S', ref[i - 1], hyp[j - 1]],
      );
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push(['D', ref[i - 1], '']);
      i--;
    } else {
      ops.push(['I', '', hyp[j - 1]]);
      j--;
    }
  }
  return ops.reverse();
}

// 터미널에서 한글은 두 칸을 차지하므로 칸을 맞출 때 너비를 따로 셉니다.
const width = (s) => [...s].reduce((w, c) => w + (/[ᄀ-ᇿ가-힣]/.test(c) ? 2 : 1), 0);
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)));
const show = (c) => (c === ' ' ? '␣' : c);

function report(title, refText, hypText, { table = false, unit = 'char' } = {}) {
  const ref = unit === 'char' ? [...refText] : refText.split(/\s+/).filter(Boolean);
  const hyp = unit === 'char' ? [...hypText] : hypText.split(/\s+/).filter(Boolean);
  const d = dp(ref, hyp);
  const ops = backtrace(ref, hyp, d);
  const count = (k) => ops.filter(([o]) => o === k).length;
  const [S, D, I] = ['S', 'D', 'I'].map(count);
  console.log(`\n${title}`);
  console.log(`   정답 "${refText}" (${ref.length}개) / 결과 "${hypText}" (${hyp.length}개)`);
  if (table) {
    console.log(`   DP 표 (행: 정답, 열: 결과, ␣ = 공백)`);
    console.log(`        ${pad('ε', 3)}${hyp.map((c) => pad(show(c), 3)).join('')}`);
    d.forEach((row, i) =>
      console.log(
        `   ${pad(i === 0 ? 'ε' : show(ref[i - 1]), 4)} ${row.map((v) => pad(String(v), 3)).join('')}`,
      ),
    );
  }
  const shown = ops
    .filter(([o]) => o !== '=')
    .map(([o, r, h]) =>
      o === 'S' ? `S(${show(r)}→${show(h)})` : o === 'D' ? `D(${show(r)})` : `I(${show(h)})`,
    );
  console.log(`   편집: ${shown.join(' ') || '없음'}`);
  console.log(
    `   S=${S} D=${D} I=${I}, 거리 ${d[ref.length][hyp.length]} → ${unit === 'char' ? 'CER' : 'WER'} = ${S + D + I}/${ref.length} = ${((100 * (S + D + I)) / ref.length).toFixed(1)}%`,
  );
}

const REF = '메탈팹이랑 피쓰리도';
const HYP = '메탈 팩이랑 P 3도'; // 6-6절 표의 Deepgram nova-3 결과
const noSpace = (s) => s.replace(/\s+/g, '');

report('1) 글자 단위, 공백 포함', REF, HYP, { table: true });
report('2) 글자 단위, 공백 제외', noSpace(REF), noSpace(HYP), { table: true });
report('3) 단어 단위 (WER)', REF, HYP, { unit: 'word' });

const fixed = correctTranscript(HYP);
report(`4) 코드 보정 뒤: correctTranscript("${HYP}") = "${fixed}"`, REF, fixed);
report('5) 정답을 쓰는 형식(P3)으로 적으면', '메탈팹이랑 P3도', fixed);
