import { describe, expect, it } from 'vitest';
import { stripLeadingAck, withoutLeadingAck } from './ack.ts';

async function collect(chunks: string[]): Promise<string> {
  async function* source() {
    yield* chunks;
  }
  let out = '';
  for await (const part of withoutLeadingAck(source())) out += part as string;
  return out;
}

describe('stripLeadingAck', () => {
  it('실측에서 나온 첫머리 맞장구를 뗀다', () => {
    expect(stripLeadingAck('감사합니다. 문의 주신 게 에프투 울트라 맞으시죠?')).toBe(
      '문의 주신 게 에프투 울트라 맞으시죠?',
    );
    expect(stripLeadingAck('아, 가죽 소품을 직접 만드시는군요.')).toBe(
      '가죽 소품을 직접 만드시는군요.',
    );
    expect(stripLeadingAck('네, 예산과 할부 희망 잘 알겠습니다.')).toBe(
      '예산과 할부 희망 잘 알겠습니다.',
    );
    expect(stripLeadingAck('네, 감사합니다. 도입은 언제쯤이세요?')).toBe('도입은 언제쯤이세요?');
  });

  it('맞장구가 아닌 말은 건드리지 않는다', () => {
    expect(stripLeadingAck('아니요, 그건 아니에요.')).toBe('아니요, 그건 아니에요.');
    expect(stripLeadingAck('예산은 어느 정도세요?')).toBe('예산은 어느 정도세요?');
    expect(stripLeadingAck('네일 아트용인가요?')).toBe('네일 아트용인가요?');
  });

  it('떼고 나면 남는 말이 없으면 그대로 둔다', () => {
    expect(stripLeadingAck('네, 감사합니다.')).toBe('네, 감사합니다.');
  });
});

describe('withoutLeadingAck', () => {
  it('토큰으로 나뉘어 와도 첫머리 맞장구만 뗀다', async () => {
    expect(await collect(['네', ', ', '예산', '은 어느', ' 정도', ' 생각하세요?'])).toBe(
      '예산은 어느 정도 생각하세요?',
    );
  });

  it('짧은 답도 빠짐없이 내보낸다', async () => {
    expect(await collect(['네', '.'])).toBe('네.');
  });
});
