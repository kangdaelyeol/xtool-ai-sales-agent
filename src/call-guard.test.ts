import { voice } from '@livekit/agents';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guardCall } from './call-guard.ts';

/** guardCall이 보는 만큼만 흉내 낸 LLM 답(SpeechHandle). 끝나는 시점은 테스트가 정합니다. */
function fakeReply() {
  const doneCallbacks: (() => void)[] = [];
  let interrupted = false;
  return {
    handle: {
      get interrupted() {
        return interrupted;
      },
      addDoneCallback: (callback: () => void) => void doneCallbacks.push(callback),
    },
    /** 답을 다 말했거나 실패했습니다. */
    finish() {
      for (const callback of doneCallbacks) callback();
    },
    /** 고객이 끼어들었거나 버려진 선제 생성입니다. 끝 표시는 나중에 옵니다. */
    interrupt() {
      interrupted = true;
    },
  };
}

/** guardCall이 쓰는 만큼만 흉내 낸 세션. "여보세요?" 재생이 끝나는 시점은 테스트가 정합니다. */
function fakeSession() {
  const emitter = new EventEmitter();
  const said: string[] = [];
  let finishPlayout = () => {};
  const session = Object.assign(emitter, {
    userState: 'listening' as voice.UserState,
    agentState: 'listening' as voice.AgentState,
    say(text: string) {
      said.push(text);
      const played = new Promise<void>((resolve) => (finishPlayout = resolve));
      return { waitForPlayout: () => played };
    },
  });
  const endCall = vi.fn(async () => {});
  guardCall(session as unknown as voice.AgentSession, endCall);
  return {
    endCall,
    said,
    setUserState(newState: voice.UserState) {
      const oldState = session.userState;
      session.userState = newState;
      emitter.emit(voice.AgentSessionEventTypes.UserStateChanged, { oldState, newState });
    },
    setAgentState(newState: voice.AgentState) {
      const oldState = session.agentState;
      session.agentState = newState;
      emitter.emit(voice.AgentSessionEventTypes.AgentStateChanged, { oldState, newState });
    },
    /** 고객 말에 대한 LLM 답이 생깁니다 (SDK의 SpeechCreated, source generate_reply). */
    startReply() {
      const reply = fakeReply();
      emitter.emit(voice.AgentSessionEventTypes.SpeechCreated, {
        source: 'generate_reply',
        speechHandle: reply.handle,
      });
      return reply;
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
    expect(call.said).toHaveLength(1);
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

  it('VAD가 놓치고 STT로만 잡힌 대답(away → listening)도 대답으로 센다', async () => {
    const call = fakeSession();
    call.setUserState('away');
    call.finishPlayout();
    await vi.advanceTimersByTimeAsync(3_000); // "여보세요?"가 끝나고 3초 뒤에 작게 "네"
    call.setUserState('listening'); // SDK는 away 중 STT 확정 글이 오면 speaking 없이 listening으로 돌림
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

// 즉시 반응("네네.")이 끝나면 SDK는 본 답을 만드는 중에도 away까지 10초를 셉니다.
describe('guardCall: 본 답을 기다리는 동안', () => {
  /** 즉시 반응을 0~0.5초에 말하고 본 답을 기다리는 상태로 만듭니다. */
  async function afterAck() {
    const call = fakeSession();
    const reply = call.startReply();
    call.setAgentState('speaking');
    await vi.advanceTimersByTimeAsync(500);
    call.setAgentState('listening');
    return { call, reply };
  }

  it('답을 만드는 중에 away가 오면 묻지 않고, 늦게 온 답을 말한 뒤 10초를 준다', async () => {
    const { call, reply } = await afterAck();
    await vi.advanceTimersByTimeAsync(10_000);
    call.setUserState('away'); // 즉시 반응이 끝나고 10초
    expect(call.said).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_500);
    call.setAgentState('speaking'); // 12초에 답이 와서 말함
    await vi.advanceTimersByTimeAsync(3_000);
    call.setAgentState('listening');
    reply.finish();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(call.said).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(call.said).toHaveLength(1);
  });

  it('답이 실패하면 기다리지 않고 묻는다 (즉시 반응 뒤로 이미 10초 넘게 조용함)', async () => {
    const { call, reply } = await afterAck();
    await vi.advanceTimersByTimeAsync(10_000);
    call.setUserState('away');
    await vi.advanceTimersByTimeAsync(24_000);
    expect(call.said).toHaveLength(0);
    reply.finish(); // 34.5초에 재시도까지 실패
    expect(call.said).toHaveLength(1);
  });

  it('답이 away보다 먼저 실패했으면 away에 바로 묻는다', async () => {
    const { call, reply } = await afterAck();
    await vi.advanceTimersByTimeAsync(4_800);
    reply.finish(); // 5.3초에 실패
    await vi.advanceTimersByTimeAsync(5_200);
    call.setUserState('away'); // 10.5초
    expect(call.said).toHaveLength(1);
  });

  it('기다리는 사이에 고객이 말하면 묻지 않는다', async () => {
    const { call, reply } = await afterAck();
    await vi.advanceTimersByTimeAsync(10_000);
    call.setUserState('away');
    call.setUserState('speaking');
    call.setAgentState('speaking');
    await vi.advanceTimersByTimeAsync(2_000);
    call.setAgentState('listening');
    reply.finish();
    call.setUserState('listening');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(call.said).toHaveLength(0);
    expect(call.endCall).not.toHaveBeenCalled();
  });

  it('끊긴 답(버려진 선제 생성)은 기다리지 않는다', async () => {
    const { call, reply } = await afterAck();
    reply.interrupt(); // 끝 표시는 SDK가 최대 5초 뒤에 함
    await vi.advanceTimersByTimeAsync(10_000);
    call.setUserState('away');
    expect(call.said).toHaveLength(1);
  });
});
