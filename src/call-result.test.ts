import { llm } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { transcriptOf } from './call-result.ts';

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
