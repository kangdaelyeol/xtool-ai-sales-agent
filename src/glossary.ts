// 용어집: STT가 잘 알아듣게 할 단어와 TTS가 읽을 발음.
// 기기 이름은 Monday 기기별 상담 보드 기준입니다. 발음은 상담팀 확인 전 초안입니다.

/** STT 인식 강조 단어. */
export const KEYTERMS = [
  '오리지널스',
  '엑스툴',
  'xTool',
  'F2 울트라',
  'F2 울트라 UV',
  'F1 울트라',
  'P3',
  'M2',
  'F2',
  'O1',
  'DTF',
  '메탈팹',
  '방문체험',
  '할부',
] as const;

/**
 * STT가 자주 잘못 적는 제품명. LLM에 넘기기 전에 바로잡습니다 (2026-11-03 Deepgram 실측에서 나온 것 위주).
 * 프롬프트로 "바로잡아 이해하라"고만 하면 LLM이 틀린 이름을 맞장구로 따라 말해서 코드로 고칩니다.
 */
export const MISHEARD_TERMS: ReadonlyArray<readonly [pattern: RegExp, correct: string]> = [
  [/메탈\s?(백|팩|펩|뱁)/g, '메탈팹'],
  [/(?<![A-Za-z])F\s?(two|투)(?![A-Za-z])/gi, 'F2'],
  [/(?<![A-Za-z])F\s?(one|원)(?![A-Za-z])/gi, 'F1'],
  [/엑스\s툴/g, 'xTool'],
];

/**
 * TTS에 넣기 전에 바꿀 영문·숫자 표기. 앞뒤가 영문자·숫자가 아닐 때만 바꿉니다
 * ("F2가"는 바꾸고 "F20"은 그대로).
 */
export const SPOKEN_TERMS: ReadonlyArray<readonly [term: string, spoken: string]> = [
  ['xTool', '엑스툴'],
  ['F2', '에프투'],
  ['F1', '에프원'],
  ['P3', '피쓰리'],
  ['M2', '엠투'],
  ['O1', '오원'],
  ['UV', '유브이'],
  ['DTF', '디티에프'],
];
