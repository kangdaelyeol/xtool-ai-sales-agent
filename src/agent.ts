import { Agent, beta, type llm } from '@livekit/agents';
import type { AckAudioCache } from './ack-audio.ts';
import { ACKS, shouldAck, withoutLeadingAck } from './ack.ts';
import type { CallContext } from './call-context.ts';
import { buildInstructions } from './prompt.ts';
import { correctTranscript } from './transcript.ts';

// 통화 중 도구. 방문체험 빈 시간 조회, 수신 거부 등록은 functions-xtool API가 생기면 붙입니다.
// 생각 모드를 끈 채 도구를 쓰므로 지시문(prompt.ts "통화 끝내기")에 도구를 말로 흘리지 않게 하는
// 문장을 넣어 두었습니다.
export function createAgent({
  call,
  llm,
  ackAudio,
  knowledge,
}: {
  call: CallContext;
  /** 회사·기기 정보 (knowledge/xtool.md). */
  knowledge?: string;
  llm: llm.LLM;
  /** 미리 합성한 즉시 반응 음성. 없으면 그때그때 합성합니다. */
  ackAudio?: AckAudioCache;
}) {
  let turn = 0;
  return Agent.create({
    instructions: buildInstructions(call, knowledge),
    llm,
    tools: [
      // 작별 인사를 말한 답이 끝까지 재생된 뒤 세션을 닫습니다. 방은 세션이 닫힐 때 지워지므로
      // (main.ts의 deleteRoomOnClose) 도구가 한 번 더 지우지 않게 deleteRoom을 끕니다.
      // 인사는 도구를 부르는 답에서 하므로, 도구 뒤에 한 번 더 말하지 않게 endInstructions를 비웁니다.
      beta.createEndCallTool({
        deleteRoom: false,
        endInstructions: null,
        extraDescription:
          '마지막 인사를 말한 같은 답에서 부릅니다. 통화 곤란, 수신 거부, 신청한 적 없음, 마무리 인사 뒤에 씁니다.',
      }),
    ],
    onUserTurnCompleted: (ctx, _chatCtx, newMessage) => {
      // LLM에 넘기기 전에 STT가 잘못 적은 제품명을 바로잡습니다 (대화록에도 고친 글이 남음).
      newMessage.content = newMessage.content.map((part) =>
        typeof part === 'string' ? correctTranscript(part) : part,
      );
      // 즉시 반응("네네"). 본 답보다 먼저 재생됩니다. 대화 기록에는 넣지 않아 LLM이 따라 하지 않고
      // 프롬프트 캐시도 유지됩니다. 수신 거부·불만·사람 요청에는 하지 않습니다.
      if (!shouldAck(newMessage.textContent ?? '')) return;
      const ack = ACKS[turn++ % ACKS.length]!;
      const audio = ackAudio?.audio(ack);
      ctx.agent.session.say(ack, {
        ...(audio ? { audio } : {}),
        addToChatCtx: false,
        allowInterruptions: true,
      });
    },
    // 즉시 반응과 겹치지 않게 본 답 첫머리의 "네,", "감사합니다." 같은 맞장구를 뗍니다.
    llmNode: async (ctx, chatCtx, toolCtx, modelSettings) => {
      const stream = await Agent.default.llmNode(ctx.agent, chatCtx, toolCtx, modelSettings);
      return stream ? withoutLeadingAck(stream) : null;
    },
  });
}
