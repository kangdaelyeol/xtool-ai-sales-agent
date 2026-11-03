import { initializeLogger } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { SAMPLE_CALL, parseCallContext } from './call-context.ts';
import { buildInstructions, openingLine } from './prompt.ts';

initializeLogger({ pretty: false, level: 'error' });

describe('openingLine', () => {
  it('AI 상담사와 녹음 사실을 알리고 기기 이름은 한글 발음으로 읽는다', () => {
    const line = openingLine(SAMPLE_CALL);
    expect(line).toContain('AI 상담사');
    expect(line).toContain('녹음');
    expect(line).toContain('에프투 울트라');
    expect(line).toContain('김민수 고객님');
  });

  it('고객 정보가 없으면 "고객님"으로 부른다', () => {
    expect(openingLine(parseCallContext('{"device":""}'))).toContain('안녕하세요, 고객님.');
  });
});

describe('parseCallContext', () => {
  it('metadata가 없으면 가상 고객, 깨졌으면 빈 정보로 진행한다', () => {
    expect(parseCallContext(undefined)).toEqual(SAMPLE_CALL);
    expect(parseCallContext('not json').customerName).toBe('');
  });
});

describe('buildInstructions', () => {
  it('통화별 고객 정보는 프롬프트 맨 뒤에 둔다 (앞부분 캐시 유지)', () => {
    const a = buildInstructions(SAMPLE_CALL);
    const b = buildInstructions({ ...SAMPLE_CALL, customerName: '이영희' });
    const sharedPrefix = a.slice(0, a.indexOf('# 고객 정보'));
    expect(b.startsWith(sharedPrefix)).toBe(true);
  });
});

describe('knowledge', () => {
  it('지식이 있으면 고객 정보 앞에 넣고, 없으면 칸을 만들지 않는다', () => {
    const withKnowledge = buildInstructions(SAMPLE_CALL, '## 방문체험\n- 매장 위치: 서울');
    expect(withKnowledge).toContain('# 회사·기기 정보');
    expect(withKnowledge.indexOf('매장 위치')).toBeLessThan(withKnowledge.indexOf('# 고객 정보'));
    expect(buildInstructions(SAMPLE_CALL)).not.toContain('# 회사·기기 정보');
  });

  it('작성 안내 주석만 있는 템플릿은 빈 지식이다', async () => {
    const { cleanKnowledge, loadKnowledge } = await import('./knowledge.ts');
    expect(cleanKnowledge('<!-- 안내 -->\n\n## 기기\n- F2 울트라: 각인')).toBe(
      '## 기기\n- F2 울트라: 각인',
    );
    expect(loadKnowledge()).toBe('');
  });
});
