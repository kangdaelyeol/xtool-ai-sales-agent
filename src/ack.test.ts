import { describe, expect, it } from 'vitest';
import { shouldAck, stripLeadingAck, withoutLeadingAck } from './ack.ts';

describe('shouldAck', () => {
  it('수신 거부·불만·사람 요청에는 즉시 반응을 하지 않는다', () => {
    for (const text of [
      '그냥 전화하지 마세요.',
      '다시는 연락하지 마세요',
      '필요 없어요',
      '아 짜증나네',
      'AI 말고 사람이랑 통화하고 싶어요.',
      '상담사 연결해 주세요',
    ]) {
      expect(shouldAck(text), text).toBe(false);
    }
  });

  it('보통 대답에는 즉시 반응을 한다', () => {
    for (const text of ['네, 괜찮아요.', '부업으로 가죽 소품 만들려고요.', '전화 상담도 되나요?']) {
      expect(shouldAck(text), text).toBe(true);
    }
  });
});

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

  it('어디서 나뉘어 와도 결과가 같다 (맞장구 둘이 겹친 답 포함)', async () => {
    const cases: [string, string][] = [
      ['알겠습니다. 감사합니다. 예산은요?', '예산은요?'],
      ['네, 감사합니다. 도입은 언제쯤이세요?', '도입은 언제쯤이세요?'],
      ['아, 네. 예산은요?', '예산은요?'],
      ['네일 아트용인가요?', '네일 아트용인가요?'],
      ['아니요, 괜찮아요.', '아니요, 괜찮아요.'],
      ['음성 안내를 들으셨나요?', '음성 안내를 들으셨나요?'],
    ];
    for (const [input, expected] of cases) {
      const chars = [...input];
      // 판단은 첫머리에서 끝나므로 앞 15글자 안의 분할점을 모두 시험합니다 (최대 2^14가지).
      const cuts = Math.min(chars.length - 1, 14);
      for (let mask = 0; mask < 2 ** cuts; mask++) {
        const chunks: string[] = [];
        let piece = chars[0] ?? '';
        for (let i = 1; i < chars.length; i++) {
          if (mask & (1 << (i - 1))) {
            chunks.push(piece);
            piece = '';
          }
          piece += chars[i];
        }
        chunks.push(piece);
        expect(await collect(chunks), chunks.join('|')).toBe(expected);
      }
    }
  });

  it('맞장구가 아니면 첫 두 글자 안에 내보낸다', async () => {
    async function* source() {
      yield '예';
      yield '산';
      throw new Error('여기까지 왔으면 이미 내보냈어야 함');
    }
    const out: string[] = [];
    await expect(async () => {
      for await (const part of withoutLeadingAck(source())) out.push(part as string);
    }).rejects.toThrow();
    expect(out).toEqual(['예산']);
  });
});
