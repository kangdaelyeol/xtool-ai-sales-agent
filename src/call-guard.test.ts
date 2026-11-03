import { voice } from '@livekit/agents';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardCall } from './call-guard.ts';

/** guardCall이 쓰는 만큼만 흉내 낸 세션. "여보세요?" 재생이 끝나는 시점은 테스트가 정합니다. */
function fakeSession() {
  const emitter = new EventEmitter();
  let finishPlayout = () => {};
  const session = Object.assign(emitter, {
    userState: 'listening' as voice.UserState,
    say() {
      const played = new Promise<void>((resolve) => (finishPlayout = resolve));
      return { waitForPlayout: () => played };
    },
  });
  const endCall = vi.fn(async () => {});
  guardCall(session as unknown as voice.AgentSession, endCall);
  return {
    endCall,
    setUserState(newState: voice.UserState) {
      const oldState = session.userState;
      session.userState = newState;
      emitter.emit(voice.AgentSessionEventTypes.UserStateChanged, { oldState, newState });
    },
    finishPlayout: () => finishPlayout(),
    close: () => emitter.emit(voice.AgentSessionEventTypes.Close, {}),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('guardCall', () => {
  it('"여보세요?" 뒤에도 말이 없으면 10초 뒤 끊는다', async () => {
    const call = fakeSession();
    call.setUserState('away');
    call.finishPlayout();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(call.endCall).toHaveBeenCalledWith(expect.any(String), 'no_response');
  });

  it('"여보세요?" 도중에 대답하면 무응답으로 세지 않는다', async () => {
    const call = fakeSession();
    call.setUserState('away');
    call.setUserState('speaking'); // "네, 들려요"
    call.finishPlayout(); // 끼어들기로 "여보세요?"가 끝남
    call.setUserState('listening');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(call.endCall).not.toHaveBeenCalled();
  });

  it('최대 통화 길이가 지나면 끊고, 통화가 닫히면 타이머를 멈춘다', async () => {
    const long = fakeSession();
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(long.endCall).toHaveBeenCalledWith(expect.any(String), 'max_duration');

    const closed = fakeSession();
    closed.close();
    await vi.advanceTimersByTimeAsync(8 * 60_000);
    expect(closed.endCall).not.toHaveBeenCalled();
  });
});
