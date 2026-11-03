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
  const maxTimer = setTimeout(() => void endCall(MAX_LENGTH_BYE, 'max_duration'), MAX_CALL_MS);

  session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
    if (ev.newState === 'speaking') {
      clearTimeout(noResponseTimer);
      noResponseTimer = undefined;
      return;
    }
    if (ev.newState !== 'away' || noResponseTimer) return;
    const prompt = session.say(STILL_THERE, { allowInterruptions: true });
    void prompt.waitForPlayout().then(() => {
      // "여보세요?" 도중에 대답했으면 재생은 끼어들기로 끝났고 고객은 이미 away가 아닙니다.
      if (session.userState !== 'away') return;
      noResponseTimer = setTimeout(
        () => void endCall(NO_RESPONSE_BYE, 'no_response'),
        NO_RESPONSE_END_MS,
      );
    });
  });

  session.on(voice.AgentSessionEventTypes.Close, () => {
    clearTimeout(maxTimer);
    clearTimeout(noResponseTimer);
  });
}
