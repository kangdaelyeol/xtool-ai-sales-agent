// Anthropic API와 Bedrock(jp.)의 첫 토큰 지연을 같은 프롬프트로 번갈아 잽니다 (A/B).
//   pnpm compare:llm          # 공급자마다 10회
//   pnpm compare:llm -- 20    # 공급자마다 20회
// ANTHROPIC_API_KEY와 AWS_ACCESS_KEY_ID·AWS_SECRET_ACCESS_KEY가 필요합니다. 운영 설정과 같게 생각 모드 끔,
// effort low로 잽니다. 번갈아 부르므로 시간대에 따른 서버 혼잡은 양쪽에 비슷하게 섞입니다.
import { initializeLogger, llm } from '@livekit/agents';
import dotenv from 'dotenv';
import { SAMPLE_CALL } from '../src/call-context.ts';
import { loadConfig } from '../src/config.ts';
import { loadKnowledge } from '../src/knowledge.ts';
import { createLLM } from '../src/models/index.ts';
import { buildInstructions, openingLine } from '../src/prompt.ts';

dotenv.config({ path: '.env.local' });
initializeLogger({ pretty: true, level: 'warn' });

const RUNS = Number(process.argv[2] ?? 10);
const USER_TURN = '네, 괜찮아요. 가죽 지갑에 이름 각인하려고 하는데 이거 기계로 돼요?';
const PROVIDERS = ['anthropic', 'bedrock'] as const;

const base = loadConfig().llm;
const models = Object.fromEntries(
  PROVIDERS.map((provider) => {
    const model = createLLM({
      ...base,
      provider,
      model: provider === 'bedrock' ? 'jp.anthropic.claude-haiku-5-5' : 'claude-haiku-5-5',
    });
    model.on('error', ({ error }) => {
      console.error(`\n[${provider}] 요청 실패: ${error.message}`);
      process.exit(1);
    });
    return [provider, model];
  }),
) as Record<(typeof PROVIDERS)[number], llm.LLM>;

function chatCtx() {
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ role: 'system', content: buildInstructions(SAMPLE_CALL, loadKnowledge()) });
  ctx.addMessage({ role: 'assistant', content: openingLine(SAMPLE_CALL) });
  ctx.addMessage({ role: 'user', content: USER_TURN });
  return ctx;
}

async function measure(model: llm.LLM) {
  const started = performance.now();
  let firstToken: number | undefined;
  let text = '';
  for await (const chunk of model.chat({ chatCtx: chatCtx() })) {
    if (chunk.delta?.content) {
      firstToken ??= performance.now() - started;
      text += chunk.delta.content;
    }
  }
  return { firstToken: firstToken ?? NaN, total: performance.now() - started, text };
}

const results: Record<string, number[]> = { anthropic: [], bedrock: [] };
for (let run = 1; run <= RUNS; run++) {
  for (const provider of PROVIDERS) {
    const { firstToken, text } = await measure(models[provider]);
    results[provider]!.push(firstToken);
    if (run === 1) console.log(`[${provider}] ${text}`);
  }
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!);
};
console.table(
  PROVIDERS.map((provider) => ({
    provider,
    runs: results[provider]!.length,
    'first token p50 ms': percentile(results[provider]!, 0.5),
    'first token p90 ms': percentile(results[provider]!, 0.9),
    'min ms': percentile(results[provider]!, 0),
  })),
);
