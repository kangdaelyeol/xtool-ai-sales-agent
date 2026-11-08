import { initializeLogger } from '@livekit/agents';
import { describe, expect, it } from 'vitest';
import { SAMPLE_CALL, parseCallContext } from './call-context.ts';

// parseCallContext가 남기는 경고(warn)는 테스트 출력에서 숨깁니다.
initializeLogger({ pretty: false, level: 'error' });

describe('parseCallContext', () => {
  const full = {
    callId: 'call-1',
    customerName: '김민수',
    device: 'F2 울트라',
    inquiredAt: '오늘 오후 두 시 십 분',
    installment: '희망',
    inquiryText: '가죽 지갑에 각인하고 싶어요',
  };
  const empty = {
    customerName: '',
    device: '',
    inquiredAt: '',
    installment: '미기입',
    inquiryText: '',
  };

  it('metadata가 없으면(브라우저·콘솔 테스트) 가상 고객으로 진행한다', () => {
    expect(parseCallContext(undefined)).toBe(SAMPLE_CALL);
  });

  it('계약대로 온 칸은 그대로 읽고, 빠진 칸은 기본값으로 둔다', () => {
    expect(parseCallContext(JSON.stringify(full))).toEqual(full);
    expect(parseCallContext(JSON.stringify({ callId: 'call-2' }))).toEqual({
      ...empty,
      callId: 'call-2',
    });
  });

  it('칸 하나가 틀려도 그 칸만 기본값으로 두고 이름과 callId는 살린다', () => {
    const metadata = JSON.stringify({ ...full, installment: '희망함', device: 3 });
    expect(parseCallContext(metadata)).toEqual({ ...full, installment: '미기입', device: '' });
  });

  it('JSON 객체가 아니면 고객 정보 없이 진행한다', () => {
    for (const metadata of ['{', '"문자열"', '[1]', 'null']) {
      expect(parseCallContext(metadata)).toEqual(empty);
    }
  });
});
