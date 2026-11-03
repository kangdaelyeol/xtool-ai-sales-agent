import { type llm, log, type metrics } from '@livekit/agents';
import type { CallContext } from './call-context.ts';

/** functions-xtool submitVoiceCallResult가 받는 대화 한 줄 (originalshq voice-call/types.ts CallTurn). */
export interface CallTurn {
  role: 'agent' | 'customer';
  text: string;
  /** ms */
  at: number;
}

/** 통화 중 구간별 지연(ms). 턴마다 하나씩 쌓입니다 (TTS는 즉시 반응과 본 답이 따로 잡힘). */
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

/** 세션 지표 하나를 지연 기록에 더합니다. */
export function addLatency(latency: CallLatency, metric: metrics.AgentMetrics): void {
  const round = (ms: number) => Math.round(ms);
  if (metric.type === 'eou_metrics')
    latency.endOfUtteranceMs.push(round(metric.endOfUtteranceDelayMs));
  if (metric.type === 'llm_metrics') latency.llmTtftMs.push(round(metric.ttftMs));
  if (metric.type === 'tts_metrics') latency.ttsTtfbMs.push(round(metric.ttfbMs));
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
