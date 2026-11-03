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

/**
 * 답 첫머리의 맞장구를 뗍니다 ("네, 예산은…" → "예산은…"). 즉시 반응("네네")을 이미 말했으므로
 * 겹치지 않게 하려는 것입니다. 떼고 나면 남는 말이 없으면 그대로 둡니다.
 */
export function stripLeadingAck(text: string): string {
  let out = text;
  for (let i = 0; i < 2; i++) {
    const next = out.replace(LEADING_ACK, '');
    if (next === out) break;
    out = next;
  }
  return out.trim() ? out : text;
}

// 맞장구가 토큰 여러 개로 나뉘어 올 수 있어 처음 몇 글자를 모았다가 판단합니다.
const HOLD_CHARS = 12;

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
    if (held.length >= HOLD_CHARS) {
      yield stripLeadingAck(held);
      held = '';
      passing = true;
    }
  }
  if (held) yield stripLeadingAck(held);
}
