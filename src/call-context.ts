import { log } from '@livekit/agents';
import { z } from 'zod';

/**
 * 통화마다 달라지는 고객 정보. functions-xtool이 에이전트를 배정할 때 job metadata(JSON)로 넣습니다.
 * 필드 이름은 originalshq와 맞춰야 하는 계약입니다.
 */
const CallContextSchema = z.object({
  /** Firestore calls/{id}의 id. 브라우저 테스트에서는 없습니다. */
  callId: z.string().optional(),
  customerName: z.string().default(''),
  /** Monday 기기별 상담 보드 이름 그대로 (예: "F2 울트라"). */
  device: z.string().default(''),
  /** 사람이 읽는 형식 (예: "오늘 오후 두 시 십 분"). */
  inquiredAt: z.string().default(''),
  installment: z.enum(['희망', '희망 안 함', '미기입']).default('미기입'),
  inquiryText: z.string().default(''),
});

export type CallContext = z.infer<typeof CallContextSchema>;

/** metadata가 없을 때(브라우저·콘솔 테스트) 쓰는 가상 고객. */
export const SAMPLE_CALL: CallContext = {
  customerName: '김민수',
  device: 'F2 울트라',
  inquiredAt: '오늘 오후',
  installment: '희망',
  inquiryText: '가죽 지갑에 각인하고 싶은데 가능한가요?',
};

export function parseCallContext(metadata: string | undefined): CallContext {
  if (!metadata) return SAMPLE_CALL;
  try {
    const fields = z.record(z.string(), z.unknown()).parse(JSON.parse(metadata));
    const result = CallContextSchema.safeParse(fields);
    if (result.success) return result.data;
    // 칸 하나만 틀려도(예: installment "희망함") 전부 버리면 맞게 온 이름과 callId까지 잃어 통화 결과를
    // 보내지 못합니다. 틀린 칸만 빼고 다시 읽어 그 칸만 기본값으로 둡니다.
    const invalid = result.error.issues.map((issue) => String(issue.path[0]));
    log().warn({ invalid }, '통화 metadata의 일부 칸이 계약과 달라 그 칸은 기본값으로 진행합니다');
    return CallContextSchema.parse(
      Object.fromEntries(Object.entries(fields).filter(([key]) => !invalid.includes(key))),
    );
  } catch (error) {
    // 실제 통화일 수 있으므로 가상 고객 대신 빈 정보로 진행합니다 ("고객님"으로 부름).
    log().warn({ error }, '통화 metadata를 읽지 못해 고객 정보 없이 진행합니다');
    return CallContextSchema.parse({});
  }
}
