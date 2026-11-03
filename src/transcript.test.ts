import { describe, expect, it } from 'vitest';
import { correctTranscript } from './transcript.ts';

describe('correctTranscript', () => {
  it('실측에서 나온 오인식을 바로잡는다', () => {
    expect(correctTranscript('근데 메탈 백도 같이 보고 있어요.')).toBe(
      '근데 메탈팹도 같이 보고 있어요.',
    );
    expect(correctTranscript('F two 울트라로 가죽 지갑에')).toBe('F2 울트라로 가죽 지갑에');
    expect(correctTranscript('엑스 툴 제품이요')).toBe('xTool 제품이요');
  });

  it('제품명이 아닌 말은 건드리지 않는다', () => {
    expect(correctTranscript('백만 원 정도요. 메탈 소재도 돼요?')).toBe(
      '백만 원 정도요. 메탈 소재도 돼요?',
    );
    expect(correctTranscript('투자하려고요')).toBe('투자하려고요');
  });
});
