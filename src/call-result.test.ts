import { llm, type metrics } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { addLatency, emptyLatency, transcriptOf } from './call-result.ts';

describe('transcriptOf', () => {
  it('고객·AI의 말만 순서대로 뽑고 지시문과 빈 말은 뺀다', () => {
    const ctx = llm.ChatContext.empty();
    ctx.addMessage({ role: 'system', content: '지시문' });
    ctx.addMessage({ role: 'assistant', content: '안녕하세요, 오리지널스 AI 상담사입니다.' });
    ctx.addMessage({ role: 'user', content: '네, 괜찮아요.' });
    ctx.addMessage({ role: 'user', content: '   ' });

    expect(transcriptOf(ctx).map(({ role, text }) => [role, text])).toEqual([
      ['agent', '안녕하세요, 오리지널스 AI 상담사입니다.'],
      ['customer', '네, 괜찮아요.'],
    ]);
  });
});

describe('addLatency', () => {
  // 테스트에 쓰는 칸만 채운 지표. 나머지 칸은 addLatency가 보지 않습니다.
  const llmMetric = (ttftMs: number, cancelled = false) =>
    ({ type: 'llm_metrics', ttftMs, cancelled }) as metrics.LLMMetrics;
  const ttsMetric = (ttfbMs: number, cancelled = false) =>
    ({ type: 'tts_metrics', ttfbMs, cancelled }) as metrics.TTSMetrics;
  const eouMetric = (endOfUtteranceDelayMs: number) =>
    ({ type: 'eou_metrics', endOfUtteranceDelayMs }) as metrics.EOUMetrics;

  it('구간별로 반올림해 쌓는다', () => {
    const latency = emptyLatency();
    addLatency(latency, eouMetric(612.4));
    addLatency(latency, llmMetric(843.6));
    addLatency(latency, ttsMetric(171.5));

    expect(latency).toEqual({ endOfUtteranceMs: [612], llmTtftMs: [844], ttsTtfbMs: [172] });
  });

  it('첫 토큰·첫 음성 전에 취소돼 값이 없는 시도(-1)는 뺀다', () => {
    const latency = emptyLatency();
    addLatency(latency, llmMetric(-1, true));
    addLatency(latency, ttsMetric(-1, true));

    expect(latency).toEqual(emptyLatency());
  });

  it('취소됐어도 값이 있으면 남긴다 (느려서 끊긴 턴이 빠지지 않게)', () => {
    const latency = emptyLatency();
    addLatency(latency, llmMetric(2400, true));
    addLatency(latency, ttsMetric(300, true));

    expect(latency.llmTtftMs).toEqual([2400]);
    expect(latency.ttsTtfbMs).toEqual([300]);
  });

  it('다른 지표는 무시한다', () => {
    const latency = emptyLatency();
    addLatency(latency, { type: 'vad_metrics' } as metrics.VADMetrics);

    expect(latency).toEqual(emptyLatency());
  });
});
