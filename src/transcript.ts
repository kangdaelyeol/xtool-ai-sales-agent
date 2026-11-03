import { MISHEARD_TERMS } from './glossary.ts';

/** STT가 잘못 적은 제품명을 바로잡습니다. 예: "메탈 백" → "메탈팹", "F two 울트라" → "F2 울트라". */
export function correctTranscript(text: string): string {
  return MISHEARD_TERMS.reduce((out, [pattern, correct]) => out.replace(pattern, correct), text);
}
