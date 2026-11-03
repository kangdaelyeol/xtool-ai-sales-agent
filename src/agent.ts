import { Agent, type llm } from '@livekit/agents';
import type { CallContext } from './call-context.ts';
import { buildInstructions } from './prompt.ts';
import { correctTranscript } from './transcript.ts';

// 통화 중 도구(통화 종료, 방문체험 빈 시간 조회, 수신 거부 등)는 functions-xtool API가 생기면 붙입니다.
// 도구를 붙일 때 생각 모드를 끈 상태라면 지시문에 다음 문장을 넣습니다 (생각 모드를 끄면 도구 호출을
// 말로 흘리는 경우가 있음): "도구를 쓸 때는 짧게 한 문장 말한 뒤 호출해도 됩니다. 도구로 할 수 없는
// 일이면 추측하지 말고 그렇다고 말합니다."
export function createAgent({ call, llm }: { call: CallContext; llm: llm.LLM }) {
  return Agent.create({
    instructions: buildInstructions(call),
    llm,
    // LLM에 넘기기 전에 STT가 잘못 적은 제품명을 바로잡습니다 (대화록에도 고친 글이 남음).
    onUserTurnCompleted: (_ctx, _chatCtx, newMessage) => {
      newMessage.content = newMessage.content.map((part) =>
        typeof part === 'string' ? correctTranscript(part) : part,
      );
    },
  });
}
