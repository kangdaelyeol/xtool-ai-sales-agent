import { type llm, log, type metrics } from '@livekit/agents';
import type { CallContext } from './call-context.ts';

/** functions-xtool submitVoiceCallResult가 받는 대화 한 줄 (originalshq voice-call/types.ts CallTurn). */
export interface CallTurn {
  role: 'agent' | 'customer';
  text: string;
  /** ms */
  at: number;
}

/**
 * 통화 중 구간별 지연(ms). 턴마다 하나씩 쌓입니다. 선제 생성이 버려지면 LLM이, 즉시 반응을 미리
 * 합성하지 못했으면 그 TTS가 한 턴에 하나 더 잡힐 수 있습니다.
 */
export interface CallLatency {
  /** 고객 말이 끝나고 턴이 끝났다고 판단하기까지 (STT 확정 포함). */
  endOfUtteranceMs: number[];
  /** LLM 첫 토큰. */
  llmTtftMs: number[];
  /** TTS 첫 음성. */
  ttsTtfbMs: number[];
}

export const emptyLatency = (): CallLatency => ({
  endOfUtteranceMs: [],
  llmTtftMs: [],
  ttsTtfbMs: [],
});

/**
 * 세션 지표 하나를 지연 기록에 더합니다. 첫 토큰·첫 음성 전에 취소돼 값이 없는 시도(SDK가 -1을 넣음)는
 * 평균을 낮추므로 뺍니다. 취소됐어도 값이 있으면 실제로 잰 시간이라 남깁니다. 느려서 고객이 끼어든 턴이
 * 빠지면 평균이 실제보다 좋아 보입니다.
 */
export function addLatency(latency: CallLatency, metric: metrics.AgentMetrics): void {
  const add = (list: number[], ms: number) => {
    if (ms >= 0) list.push(Math.round(ms));
  };
  if (metric.type === 'eou_metrics') add(latency.endOfUtteranceMs, metric.endOfUtteranceDelayMs);
  if (metric.type === 'llm_metrics') add(latency.llmTtftMs, metric.ttftMs);
  if (metric.type === 'tts_metrics') add(latency.ttsTtfbMs, metric.ttfbMs);
}

/** 대화 기록에서 말한 내용만 뽑습니다. 즉시 반응("네네")은 기록에 넣지 않으므로 빠집니다. */
export function transcriptOf(history: llm.ChatContext): CallTurn[] {
  const turns: CallTurn[] = [];
  for (const item of history.items) {
    if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) continue;
    const text = item.textContent?.trim();
    if (!text) continue;
    turns.push({ role: item.role === 'user' ? 'customer' : 'agent', text, at: item.createdAt });
  }
  return turns;
}

/**
 * 통화가 끝나면 대화록을 functions-xtool에 보냅니다. 요약·판정은 functions-xtool이 따로 뽑습니다.
 * VOICE_RESULT_URL·VOICE_AGENT_SECRET이 없으면(로컬 개발) 보내지 않고 로그만 남깁니다.
 */
export async function submitCallResult(result: {
  call: CallContext;
  startedAt: number;
  endedAt: number;
  endReason: string;
  transcript: CallTurn[];
  latency: CallLatency;
}): Promise<void> {
  const url = process.env.VOICE_RESULT_URL;
  const secret = process.env.VOICE_AGENT_SECRET;
  if (!url || !secret || !result.call.callId) {
    log().info({ turns: result.transcript.length }, '통화 결과 전송 생략 (설정 또는 callId 없음)');
    return;
  }
  const { call, ...rest } = result;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Voice-Agent-Secret': secret },
    body: JSON.stringify({ callId: call.callId, customer: call, ...rest }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`통화 결과 전송 실패: HTTP ${response.status} ${await response.text()}`);
  }
  log().info({ callId: call.callId, turns: result.transcript.length }, '통화 결과 전송');
}
