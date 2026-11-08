import { voice } from '@livekit/agents';

// 무응답·통화 길이 안전장치 (tech-stack 7장 "무응답 재촉과 종료, 통화 최대 길이").

/** 고객과 AI가 모두 이만큼 조용하면 "여보세요?"를 합니다 (AgentSession userAwayTimeout, 초). */
export const USER_AWAY_TIMEOUT_SEC = 10;
/** "여보세요?" 뒤에도 이만큼 말이 없으면 끊습니다. */
const NO_RESPONSE_END_MS = 10_000;
/** 통화 최대 길이. 판정 통화 목표는 2~4분입니다. */
const MAX_CALL_MS = 8 * 60_000;

const STILL_THERE = '여보세요? 제 목소리 잘 들리세요?';
const NO_RESPONSE_BYE = '통화가 어려우신 것 같아요. 나중에 다시 연락드릴게요. 감사합니다.';
const MAX_LENGTH_BYE =
  '오늘 말씀해 주신 내용은 담당 상담사에게 전달해서 다시 연락드릴게요. 감사합니다.';

/**
 * 무응답과 통화 길이를 지켜보다가 정해진 멘트를 하고 `endCall`을 부릅니다.
 * "away" 상태는 고객이 다시 말할 때까지 이어져 두 번째 이벤트가 오지 않으므로, 재촉 뒤 종료는
 * 직접 타이머로 셉니다.
 */
export function guardCall(
  session: voice.AgentSession,
  endCall: (goodbye: string, reason: string) => Promise<void>,
): void {
  let noResponseTimer: NodeJS.Timeout | undefined;
  let stillThereTimer: NodeJS.Timeout | undefined;
  let asking = false;
  // 아직 끝나지 않은 LLM 답과, AI가 마지막으로 말을 마친 시각
  const replies = new Set<voice.SpeechHandle>();
  let agentSpokeAt = 0;
  const maxTimer = setTimeout(() => void endCall(MAX_LENGTH_BYE, 'max_duration'), MAX_CALL_MS);

  // 즉시 반응("네네.")이 끝나면 SDK는 본 답을 만드는 중에도 에이전트를 listening으로 돌려 away까지
  // 셉니다. 그래서 답을 만드는 동안은 묻지 않고, 늦게 온 답을 말했으면 그 뒤로 10초를 다시 줍니다.
  // 답이 실패했으면 즉시 반응 뒤로 이미 10초 넘게 조용했을 수 있어 바로 묻습니다.
  const askIfStillAway = () => {
    clearTimeout(stillThereTimer);
    stillThereTimer = undefined;
    if (session.userState !== 'away' || asking || noResponseTimer) return;
    if (session.agentState === 'speaking') return; // 말을 마치면 다시 불립니다.
    // 끊긴 답(끼어들기, 버려진 선제 생성)은 말하지 않으므로 기다리지 않습니다. 답이 끝나면 다시 불립니다.
    if ([...replies].some((reply) => !reply.interrupted)) return;
    const wait = agentSpokeAt + USER_AWAY_TIMEOUT_SEC * 1000 - Date.now();
    if (wait > 0) {
      stillThereTimer = setTimeout(askIfStillAway, wait);
      return;
    }
    asking = true;
    const prompt = session.say(STILL_THERE, { allowInterruptions: true });
    void prompt.waitForPlayout().then(() => {
      asking = false;
      // "여보세요?" 도중에 대답했으면 재생은 끼어들기로 끝났고 고객은 이미 away가 아닙니다.
      if (session.userState !== 'away') return;
      noResponseTimer = setTimeout(
        () => void endCall(NO_RESPONSE_BYE, 'no_response'),
        NO_RESPONSE_END_MS,
      );
    });
  };

  session.on(voice.AgentSessionEventTypes.SpeechCreated, (ev) => {
    if (ev.source === 'say') return;
    const reply = ev.speechHandle;
    replies.add(reply);
    reply.addDoneCallback(() => {
      replies.delete(reply);
      askIfStillAway();
    });
  });

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    if (ev.oldState !== 'speaking') return;
    agentSpokeAt = Date.now();
    askIfStillAway();
  });

  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    if (ev.newState === 'away') {
      askIfStillAway();
      return;
    }
    // VAD가 놓친 작은 대답은 STT 확정 글만으로 speaking 없이 away → listening이 되므로,
    // speaking만이 아니라 away가 아닌 모든 상태를 대답으로 봅니다.
    clearTimeout(stillThereTimer);
    stillThereTimer = undefined;
    clearTimeout(noResponseTimer);
    noResponseTimer = undefined;
  });

  session.on(voice.AgentSessionEventTypes.Close, () => {
    clearTimeout(maxTimer);
    clearTimeout(stillThereTimer);
    clearTimeout(noResponseTimer);
  });
}
