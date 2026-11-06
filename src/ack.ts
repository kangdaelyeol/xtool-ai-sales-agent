import type { llm } from '@livekit/agents';

/**
 * 고객 말이 끝나자마자 하는 짧은 반응. LLM 답(약 0.8초)을 기다리는 동안 침묵을 메웁니다.
 * 같은 말이 연달아 나오지 않게 돌아가며 씁니다.
 */
export const ACKS = ['네네.', '네.', '아, 네.'] as const;

// 즉시 반응을 하지 않을 말: 수신 거부, 불만, 사람 상담사 요청. "네네"가 가볍게 들려 거슬립니다.
const NO_ACK =
  /(전화|연락)\s*(하지|안\s*하|말)|그만\s*(하|좀)|필요\s*없|짜증|화가|불쾌|기분\s*나|사람(이랑|하고|과|한테)?\s*(통화|연결|바꿔)|상담(사|원)(이랑|하고|과|한테|으로|로)?\s*(통화|연결|바꿔)|AI\s*(말고|싫)/i;

/** 즉시 반응("네네")을 해도 되는 말인지. 수신 거부·불만·사람 요청에는 하지 않습니다. */
export function shouldAck(userText: string): boolean {
  return !NO_ACK.test(userText);
}

// 답 첫머리의 맞장구. "아니요", "예산", "네일"처럼 뒤에 글자가 바로 붙으면 맞장구가 아닙니다.
const LEADING_ACK =
  /^\s*(?:(?:네네|네|예|아|음)(?=[\s,.!?~]|$)|감사합니다|알겠습니다|그렇군요)[\s,.!?~]*/;

// 맞장구는 두 개까지 뗍니다 ("네, 감사합니다. 도입은…").
const MAX_ACKS = 2;

/** 첫머리 맞장구를 MAX_ACKS개까지 떼고, 남은 글과 뗀 개수를 돌려줍니다. */
function stripAcks(text: string): { rest: string; count: number } {
  let rest = text;
  let count = 0;
  while (count < MAX_ACKS) {
    const next = rest.replace(LEADING_ACK, '');
    if (next === rest) break;
    rest = next;
    count++;
  }
  return { rest, count };
}

/**
 * 답 첫머리의 맞장구를 뗍니다 ("네, 예산은…" → "예산은…"). 즉시 반응("네네")을 이미 말했으므로
 * 겹치지 않게 하려는 것입니다. 떼고 나면 남는 말이 없으면 그대로 둡니다.
 */
export function stripLeadingAck(text: string): string {
  const { rest } = stripAcks(text);
  return rest.trim() ? rest : text;
}

// LEADING_ACK가 떼는 말. 모은 글이 이 말의 앞부분("감사합", "네")이면 아직 판단할 수 없습니다.
const ACK_WORDS = ['네네', '네', '예', '아', '음', '감사합니다', '알겠습니다', '그렇군요'];

/**
 * 맞장구가 토큰 여러 개로 나뉘어 오므로, 모은 글만으로 첫머리를 판단할 수 있을 때까지 기다립니다.
 * 떼고 남은 것이 없거나 남은 것이 맞장구의 앞부분일 수 있으면 아직입니다. 글자 수로 끊으면
 * "알겠습니다. 감사합|니다."처럼 둘째 맞장구가 잘릴 수 있습니다(학습서 17-2 #43).
 */
function undecided(held: string): boolean {
  const { rest, count } = stripAcks(held);
  const head = rest.trimStart();
  if (head === '') return true;
  return count < MAX_ACKS && ACK_WORDS.some((word) => word.startsWith(head));
}

/** LLM 출력 스트림에서 답 첫머리의 맞장구를 뗍니다. 도구 호출·사용량 청크는 그대로 통과합니다. */
export async function* withoutLeadingAck(
  stream: AsyncIterable<llm.ChatChunk | string>,
): AsyncGenerator<llm.ChatChunk | string> {
  let held = '';
  let passing = false;
  for await (const chunk of stream) {
    if (passing) {
      yield chunk;
      continue;
    }
    const text = typeof chunk === 'string' ? chunk : chunk.delta?.content;
    if (!text) {
      // 도구 호출이 오면 모아 둔 글을 먼저 내보냅니다.
      if (typeof chunk !== 'string' && chunk.delta?.toolCalls?.length && held) {
        yield stripLeadingAck(held);
        held = '';
        passing = true;
      }
      yield chunk;
      continue;
    }
    held += text;
    if (!undecided(held)) {
      yield stripLeadingAck(held);
      held = '';
      passing = true;
    }
  }
  if (held) yield stripLeadingAck(held);
}
