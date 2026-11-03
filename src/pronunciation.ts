import { type ReadableStream, TransformStream } from 'node:stream/web';
import { SPOKEN_TERMS } from './glossary.ts';

const RULES = SPOKEN_TERMS.map(
  ([term, spoken]) => [new RegExp(`(?<![A-Za-z0-9])${term}(?![A-Za-z0-9])`, 'gi'), spoken] as const,
);

/** 제품명 같은 영문·숫자 표기를 한글 발음으로 바꿉니다. 여러 번 적용해도 결과가 같습니다. */
export function toSpoken(text: string): string {
  return RULES.reduce((out, [pattern, spoken]) => out.replace(pattern, spoken), text);
}

/**
 * AgentSession `ttsTextTransforms`용 스트림 변환.
 * LLM 출력은 토큰 단위로 끊겨 오므로("F" + "2 울트라") 마지막 공백 뒤는 다음 조각과 합칠 때까지 남겨 둡니다.
 */
export function pronunciationTransform(text: ReadableStream<string>): ReadableStream<string> {
  let pending = '';
  return text.pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        pending += chunk;
        const cut = Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\n')) + 1;
        if (cut > 0) {
          controller.enqueue(toSpoken(pending.slice(0, cut)));
          pending = pending.slice(cut);
        }
      },
      flush(controller) {
        if (pending) controller.enqueue(toSpoken(pending));
      },
    }),
  );
}
