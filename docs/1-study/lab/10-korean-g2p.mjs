// 10장 실습: 한국어 TTS 앞단의 두 단계를 장난감으로 직접 짜 봅니다 (학습서 10-1절 ①② 깊이 보기).
//  1) 텍스트 정규화: 한자어 수사(만 단위), 고유어 수사(관형사형), 단위 명사에 따라 고르기, 전화번호
//  2) 한글 음절을 초성·중성·종성 번호로 쪼개고 다시 합치기 (유니코드 산술)
//  3) 발음 변환(G2P): 표준 발음법 규칙 몇 개를 차례로 적용하며 단계별로 보기 ("이백구십만" → [이백꾸심만])
//  4) 규칙만으로는 틀리는 말: 형태소·어종·문법을 알아야 하는 경우
//  5) 이 레포가 대신하는 단계: src/pronunciation.ts의 toSpoken → 장난감 정규화 → 장난감 G2P
//
// 실행 (레포 루트에서):  node docs/1-study/lab/10-korean-g2p.mjs   (1초 안)
// 기준: Node 24 (2026-11-06). 키·네트워크·.env.local을 쓰지 않습니다.
//
// 규칙은 국립국어원 「표준어 규정」 제2부 표준 발음법의 조항 번호를 따랐습니다. 장난감이라 각 조항의 조건(조사·어미·
// 접미사와 결합할 때만, 한자어일 때만 등)을 대부분 무시합니다. 실제 G2P는 형태소 분석이나 사전, 또는 학습한 모델이
// 그 조건을 채웁니다. 이 레포의 TTS(ElevenLabs)가 어떻게 하는지는 공개되지 않았습니다.
import { toSpoken } from '../../../src/pronunciation.ts';

// ── 1) 텍스트 정규화
const SINO = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
function sino4(n) {
  // 0~9999. 십·백·천 앞의 "일"은 읽지 않음 (십, 백, 천)
  const units = ['천', '백', '십', ''];
  return [...String(n).padStart(4, '0')]
    .map(Number)
    .map((d, i) => (d === 0 ? '' : (d === 1 && units[i] ? '' : SINO[d]) + units[i]))
    .join('');
}
/** 한자어 수사. 네 자리(만 단위)로 끊고 만 단위로 띄어 씀(한글 맞춤법 제44항). 1만은 "만", 1억은 "일억". */
function readSino(n) {
  if (n === 0) return '영';
  const big = ['', '만', '억', '조'];
  const groups = [];
  for (let i = 0; n > 0; i++, n = Math.floor(n / 10000)) {
    const g = n % 10000;
    if (g) groups.unshift((i === 1 && g === 1 ? '' : sino4(g)) + big[i]);
  }
  return groups.join(' ');
}
const NATIVE = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉'];
const NATIVE_DET = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉'];
const TENS = ['', '열', '스물', '서른', '마흔', '쉰', '예순', '일흔', '여든', '아흔'];
/** 고유어 수사(1~99). 단위 명사 앞에서는 관형사형(한, 두, 세, 네, 스무). 100부터는 한자어로 읽음. */
function readNative(n, beforeCounter = true) {
  if (n >= 100) return readSino(n);
  if (beforeCounter && n === 20) return '스무';
  return TENS[Math.floor(n / 10)] + (beforeCounter ? NATIVE_DET : NATIVE)[n % 10];
}
// 단위 명사 → 어느 수사를 쓰는가 (흔한 쓰임 기준. "번"처럼 뜻에 따라 갈리는 말은 일부러 뺌)
const COUNTERS = {
  시: 'native',
  분: 'sino',
  초: 'sino',
  개: 'native',
  명: 'native',
  대: 'native',
  살: 'native',
  세: 'sino',
  원: 'sino',
  월: 'month',
  일: 'day',
  개월: 'sino',
  층: 'sino',
};
function readWithCounter(n, counter) {
  const kind = COUNTERS[counter];
  if (kind === 'native') return `${readNative(n)} ${counter}`;
  if (kind === 'month') return `${n === 6 ? '유' : n === 10 ? '시' : readSino(n)}월`; // 유월·시월
  if (kind === 'day') return `${readSino(n)}일`; // 날짜는 붙여 읽음(소리는 같음)
  return `${readSino(n)} ${counter}`;
}
const DIGIT = ['공', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
/** 장난감 정규화기: 전화번호, "숫자(만·억)? 단위", %, W */
function normalize(text) {
  return text
    .replace(/\b(\d{2,3})-(\d{3,4})-(\d{4})\b/g, (_, ...g) =>
      g
        .slice(0, 3)
        .map((p) => [...p].map((d) => DIGIT[d]).join(''))
        .join(', '),
    )
    .replace(
      /(\d[\d,]*)\s?(만|억)?\s?(개월|시|분|초|개|명|대|살|세|원|월|일|층)?/g,
      (m, num, big, unit) => {
        let n = Number(num.replaceAll(',', ''));
        if (big) n *= big === '만' ? 1e4 : 1e8;
        return unit ? readWithCounter(n, unit) : readSino(n);
      },
    )
    .replace(/(\S+?)\s?%/g, '$1 퍼센트')
    .replace(/(\S+?)\s?W\b/g, '$1 와트');
}
console.log('1) 텍스트 정규화 (장난감)');
for (const s of [
  '3시',
  '3분',
  '2개',
  '2대',
  '20개',
  '21명',
  '100개',
  '290만 원',
  '1,234,567원',
  '10000원',
  '1억 원',
  '11월 5일',
  '6월',
  '10월',
  '15%',
  '40W',
  '010-1234-5678',
]) {
  console.log(`   ${s.padEnd(15)} → ${normalize(s)}`);
}

// ── 2) 음절 쪼개기·합치기: 음절 = 0xAC00 + (초성 × 21 + 중성) × 28 + 종성
const L = [...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'];
const V = [...'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'];
const T = ['', ...'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ'];
const isSyllable = (c) => c >= '가' && c <= '힣';
function split(c) {
  const s = c.codePointAt(0) - 0xac00;
  return { l: L[Math.floor(s / 588)], v: V[Math.floor((s % 588) / 28)], t: T[s % 28] };
}
const join = ({ l, v, t }) =>
  String.fromCodePoint(0xac00 + (L.indexOf(l) * 21 + V.indexOf(v)) * 28 + T.indexOf(t));
console.log('\n2) 음절 쪼개기: 0xAC00 + (초성 × 21 + 중성) × 28 + 종성');
for (const c of ['백', '구', '십', '만']) {
  const s = c.codePointAt(0) - 0xac00;
  const p = split(c);
  console.log(
    `   "${c}" U+${c.codePointAt(0).toString(16).toUpperCase()} − AC00 = ${s} = (${L.indexOf(p.l)} × 21 + ${V.indexOf(p.v)}) × 28 + ${T.indexOf(p.t)}` +
      ` → 초성 ${p.l}, 중성 ${p.v}, 종성 ${p.t || '없음'}`,
  );
}

// ── 3) 규칙 (앞 음절 a의 종성, 뒤 음절 b의 초성을 봄). 순서가 중요: 연음 → 거센소리 → 끝소리 → 비음·유음 → 된소리
const CLUSTER = { ㄳ: ['ㄱ', 'ㅅ'], ㄵ: ['ㄴ', 'ㅈ'], ㄶ: ['ㄴ', 'ㅎ'], ㄺ: ['ㄹ', 'ㄱ'], ㄻ: ['ㄹ', 'ㅁ'],
  ㄼ: ['ㄹ', 'ㅂ'], ㄽ: ['ㄹ', 'ㅅ'], ㄾ: ['ㄹ', 'ㅌ'], ㄿ: ['ㄹ', 'ㅍ'], ㅀ: ['ㄹ', 'ㅎ'], ㅄ: ['ㅂ', 'ㅅ'] }; // prettier-ignore
const NEUTRAL = { ㄲ: 'ㄱ', ㅋ: 'ㄱ', ㅅ: 'ㄷ', ㅆ: 'ㄷ', ㅈ: 'ㄷ', ㅊ: 'ㄷ', ㅌ: 'ㄷ', ㅎ: 'ㄷ', ㅍ: 'ㅂ',
  ㄳ: 'ㄱ', ㄺ: 'ㄱ', ㄵ: 'ㄴ', ㄶ: 'ㄴ', ㄼ: 'ㄹ', ㄽ: 'ㄹ', ㄾ: 'ㄹ', ㅀ: 'ㄹ', ㄻ: 'ㅁ', ㄿ: 'ㅂ', ㅄ: 'ㅂ' }; // prettier-ignore
const ASPIRATE = { ㄱ: 'ㅋ', ㄷ: 'ㅌ', ㅂ: 'ㅍ', ㅈ: 'ㅊ' };
const TENSE = { ㄱ: 'ㄲ', ㄷ: 'ㄸ', ㅂ: 'ㅃ', ㅅ: 'ㅆ', ㅈ: 'ㅉ' };
const NASAL = { ㄱ: 'ㅇ', ㄷ: 'ㄴ', ㅂ: 'ㅁ' };
const RULES = [
  [
    '구개음화 17항',
    (a, b) => {
      if ((a.t === 'ㄷ' || a.t === 'ㅌ') && b.l === 'ㅇ' && b.v === 'ㅣ') {
        b.l = a.t === 'ㄷ' ? 'ㅈ' : 'ㅊ';
        a.t = '';
        return true;
      }
    },
  ],
  [
    '연음 13·14항, ㅎ 탈락 12항',
    (a, b) => {
      if (!a.t || a.t === 'ㅇ' || b.l !== 'ㅇ') return;
      if (a.t === 'ㅎ') a.t = '';
      else if (CLUSTER[a.t] && CLUSTER[a.t][1] === 'ㅎ') a.t = CLUSTER[a.t][0];
      else if (CLUSTER[a.t]) [a.t, b.l] = CLUSTER[a.t];
      else [a.t, b.l] = ['', a.t];
      return true;
    },
  ],
  [
    '거센소리 12항',
    (a, b) => {
      if ((a.t === 'ㅎ' || a.t === 'ㄶ' || a.t === 'ㅀ') && ASPIRATE[b.l]) {
        b.l = ASPIRATE[b.l];
        a.t = a.t === 'ㅎ' ? '' : CLUSTER[a.t][0];
        return true;
      }
      const n = NEUTRAL[a.t] ?? a.t;
      if (b.l === 'ㅎ' && ASPIRATE[n]) {
        b.l = ASPIRATE[n];
        a.t = '';
        return true;
      }
    },
  ],
  [
    '음절 끝소리 9~11항',
    (a) => {
      if (NEUTRAL[a.t]) {
        a.t = NEUTRAL[a.t];
        return true;
      }
    },
  ],
  [
    'ㄹ의 비음화 19항',
    (a, b) => {
      if (b.l === 'ㄹ' && ['ㅁ', 'ㅇ', 'ㄱ', 'ㅂ'].includes(a.t)) {
        b.l = 'ㄴ';
        return true;
      }
    },
  ],
  [
    '비음화 18항',
    (a, b) => {
      if (NASAL[a.t] && (b.l === 'ㄴ' || b.l === 'ㅁ')) {
        a.t = NASAL[a.t];
        return true;
      }
    },
  ],
  [
    '유음화 20항',
    (a, b) => {
      if (a.t === 'ㄴ' && b.l === 'ㄹ') a.t = 'ㄹ';
      else if (a.t === 'ㄹ' && b.l === 'ㄴ') b.l = 'ㄹ';
      else return;
      return true;
    },
  ],
  [
    '된소리 23항',
    (a, b) => {
      if (NASAL[a.t] && TENSE[b.l]) {
        b.l = TENSE[b.l];
        return true;
      }
    },
  ],
]; // 음절 끝소리 규칙은 마지막 음절(어말)에도 적용합니다.

/** 어절(띄어쓰기 단위) 하나에 규칙을 차례로 적용하고, 바뀐 단계를 기록합니다. */
function g2pWord(word, trace) {
  const syl = [...word].map((c) => (isSyllable(c) ? split(c) : c));
  for (const [name, rule] of RULES) {
    const before = syl.map((s) => (typeof s === 'string' ? s : join(s))).join('');
    let hit = false;
    for (let i = 0; i < syl.length; i++) {
      const a = syl[i];
      const b = syl[i + 1];
      if (typeof a === 'string') continue;
      if (b && typeof b !== 'string') hit = rule(a, b) || hit;
      else if (name.startsWith('음절 끝소리')) hit = rule(a) || hit; // 어말
    }
    const after = syl.map((s) => (typeof s === 'string' ? s : join(s))).join('');
    if (hit && before !== after) trace?.push(`${name}: ${before} → ${after}`);
  }
  return syl.map((s) => (typeof s === 'string' ? s : join(s))).join('');
}
const g2p = (text, trace) =>
  text
    .split(' ')
    .map((w) => g2pWord(w, trace))
    .join(' ');

console.log('\n3) 발음 변환 (장난감 G2P), 바뀐 단계만 표시');
for (const w of [
  '이백구십만',
  '원이에요',
  '합니다',
  '같이',
  '생각이세요',
  '국물',
  '신라',
  '축하해요',
  '닭이',
  '막론',
  '칠백십만', // 확인 문제용
]) {
  const trace = [];
  const out = g2p(w, trace);
  console.log(`   ${w} → [${out}]`);
  for (const t of trace) console.log(`        ${t}`);
}

// ── 4) 규칙만으로는 틀리는 말
console.log('\n4) 규칙만으로는 틀리는 말 (장난감 결과 → 표준 발음)');
for (const [w, right, why] of [
  ['꽃잎', '꼰닙', '합성어라 연음 대신 ㄴ 첨가(29항) → 끝소리 → 비음화. 형태소 경계를 알아야 함'],
  [
    '겉옷',
    '거돋',
    '실질 형태소 앞에서는 대표음으로 바꾼 뒤 연음(15항). 13항 연음은 조사·어미·접미사 앞에서만',
  ],
  ['갈등', '갈뜽', '한자어에서 ㄹ 뒤 ㄷ·ㅅ·ㅈ은 된소리(26항). 어종(한자어인가)을 알아야 함'],
  [
    '만드실 생각',
    '만드실쌩각',
    '관형사형 -(으)ㄹ 뒤 된소리(27항). 문법(관형사형인가)과 어절 너머를 봐야 함',
  ],
]) {
  console.log(`   ${w} → 장난감 [${g2p(w)}], 표준 [${right}]  ${why}`);
}

// ── 5) 이 레포가 대신하는 단계
console.log('\n5) 이 레포의 경로와 장난감을 이어 보기');
const raw = 'F2 울트라는 290만 원이에요.';
const spoken = toSpoken(raw);
const normalized = normalize(spoken);
console.log(`   원문                         ${raw}`);
console.log(`   ① 일부: toSpoken (이 레포)   ${spoken}   ← 제품명 8개만. 숫자는 그대로`);
console.log(
  `   ① 나머지: 정규화 (장난감)     ${normalized}   ← 이 레포는 LLM 지시문(9장)과 공급사 정규화(auto)에 맡김`,
);
console.log(
  `   ② G2P (장난감)                [${g2p(normalized.replace(/\./g, ''))}]   ← 이 레포는 TTS 모델에 맡김`,
);
console.log(
  `   참고: 발음표의 "피쓰리"(P3)는 표기를 소리 쪽으로 당겨 ②의 판단을 덜어 주는 쓰기입니다 → [${g2p('피쓰리')}]`,
);
