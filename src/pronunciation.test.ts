import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { pronunciationTransform, toSpoken } from './pronunciation.ts';

async function run(chunks: string[]): Promise<string> {
  const input = ReadableStream.from(chunks);
  let out = '';
  for await (const part of pronunciationTransform(input)) out += part;
  return out;
}

describe('toSpoken', () => {
  it('제품명을 한글 발음으로 바꾼다', () => {
    expect(toSpoken('xTool F2 울트라 UV와 P3, M2')).toBe(
      '엑스툴 에프투 울트라 유브이와 피쓰리, 엠투',
    );
  });

  it('조사가 붙어도 바꾸고, 더 긴 영문·숫자 안에서는 바꾸지 않는다', () => {
    expect(toSpoken('F2가 좋아요')).toBe('에프투가 좋아요');
    expect(toSpoken('F20, MP3')).toBe('F20, MP3');
  });

  it('여러 번 적용해도 결과가 같다', () => {
    const once = toSpoken('F1 울트라');
    expect(toSpoken(once)).toBe(once);
  });
});

describe('pronunciationTransform', () => {
  it('토큰이 단어 중간에서 끊겨 와도 바꾼다', async () => {
    expect(await run(['F', '2 울', '트라는 x', 'Tool 제품', '이에요.'])).toBe(
      '에프투 울트라는 엑스툴 제품이에요.',
    );
  });

  it('마지막 조각도 빠짐없이 내보낸다', async () => {
    expect(await run(['메탈팹', ' DTF'])).toBe('메탈팹 디티에프');
  });
});
