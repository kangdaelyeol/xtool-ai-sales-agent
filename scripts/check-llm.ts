// Haiku 5.5 생각 모드·effort 조합별 응답 지연을 잽니다. ANTHROPIC_API_KEY가 필요합니다.
//   pnpm check:llm            # 조합마다 3회
//   pnpm check:llm -- 5       # 조합마다 5회
// 첫 회는 프롬프트 캐시를 쓰고(write) 다음 회부터 읽습니다(cached). 출력 토큰이 답 길이보다 훨씬 많으면
// 생각 토큰이 섞인 것입니다.
import { initializeLogger, llm } from '@livekit/agents';
import dotenv from 'dotenv';
import { SAMPLE_CALL } from '../src/call-context.ts';
import type { Effort, ThinkingMode } from '../src/config.ts';
import { VoiceAnthropicLLM } from '../src/models/anthropic.ts';
import { buildInstructions, openingLine } from '../src/prompt.ts';

dotenv.config({ path: '.env.local' });
initializeLogger({ pretty: true, level: 'warn' });

const MODEL = process.env.LLM_MODEL || 'claude-haiku-5-5';
const RUNS = Number(process.argv[2] ?? 3);
const CASES: [ThinkingMode, Effort][] = [
  ['off', 'low'],
  ['adaptive', 'low'],
  ['adaptive', 'medium'],
];
const USER_TURN =
  '네, 괜찮아요. 근데 이거 가죽 말고 스테인리스 텀블러에도 각인돼요? 가격은 얼마예요?';

function chatCtx() {
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ role: 'system', content: buildInstructions(SAMPLE_CALL) });
  ctx.addMessage({ role: 'assistant', content: openingLine(SAMPLE_CALL) });
  ctx.addMessage({ role: 'user', content: USER_TURN });
  return ctx;
}

const rows: Record<string, string | number>[] = [];
for (const [thinking, effort] of CASES) {
  const model = new VoiceAnthropicLLM({ model: MODEL, thinking, effort, maxTokens: 2048 });
  // API 오류는 스트림이 아니라 error 이벤트로 옵니다. 400(설정 거절)·401(키) 등을 여기서 잡습니다.
  model.on('error', ({ error }) => {
    console.error(`\n[${thinking}/${effort}] 요청 실패: ${error.message}`);
    process.exit(1);
  });
  for (let run = 1; run <= RUNS; run++) {
    const started = performance.now();
    let firstToken: number | undefined;
    let text = '';
    let usage: llm.CompletionUsage | undefined;
    for await (const chunk of model.chat({ chatCtx: chatCtx() })) {
      if (chunk.delta?.content) {
        firstToken ??= performance.now() - started;
        text += chunk.delta.content;
      }
      if (chunk.usage) usage = chunk.usage;
    }
    rows.push({
      case: `${thinking}/${effort}`,
      run,
      'first token ms': Math.round(firstToken ?? NaN),
      'total ms': Math.round(performance.now() - started),
      'output tokens': usage?.completionTokens ?? NaN,
      'cached tokens': usage?.promptCachedTokens ?? NaN,
      chars: text.length,
    });
    if (run === 1) console.log(`\n[${thinking}/${effort}] ${text}`);
  }
}
console.table(rows);
