// 11장 실습: 첫머리 맞장구 떼기(withoutLeadingAck)의 보류가 얼마나 늦추는지 재 봅니다 (학습서 11-7절 깊이 보기).
// (2026-11-06 갱신) 지금 방식(판단할 수 있을 때까지만 모음, 17-2 #43 고침)과 고치기 전 방식(처음 12자를 모아 한 번 판단,
// 331c151 앞 src/ack.ts를 이 파일 안에 옮긴 사본)을 나란히 잽니다.
//   1) 실제 경로로 재기: 이 프로젝트의 에이전트(src/agent.ts의 createAgent)에 토큰 간격을 흉내 낸 가짜 LLM을 꽂고,
//      SDK의 performLLMInference로 llmNode를 돌려 LLMMetrics.ttftMs(LLM 스트림 쪽)와 llmNodeTtft(노드 출력 쪽)를 비교.
//      옛 방식은 같은 기본 llmNode에 사본을 씌운 노드로 잼
//   2) 그 늦어짐이 TTS 첫 글까지 이어지나: 노드 출력을 SDK의 blingfire 문장 분할기(ElevenLabs 플러그인 기본)에
//      넣었을 때 첫 문장이 나가는 시각을, 보류가 없을 때·지금 방식·옛 방식으로 비교 (가상 시계, 결정적)
//
// 실행 (레포 루트에서):  node docs/1-study/lab/11-ack-hold.mjs   (4초 남짓)
// 기준: Node 24, @livekit/agents 1.9.5 (2026-11-06). 키·네트워크·.env.local을 쓰지 않습니다.
// 가정: Claude의 한국어는 글자당 약 1토큰(8-1절 추정 0.97)이라 보고, 토큰 하나에 글자 하나(앞 공백은 붙임)씩 보냅니다.
//       실제 SSE 조각(text_delta)은 여러 토큰을 묶어 올 수 있어 이 실습보다 덜 늦을 수 있습니다(8-6절).
// 내부 파일(dist/voice/generation.js)을 경로로 불러오므로 SDK 버전이 바뀌면 깨질 수 있습니다.
//
// 출처 (node_modules/@livekit/agents/src/ 기준)
//   ttftMs (LLM 스트림 생성 → 첫 응답 청크)        llm/llm.ts 381~404·424
//   llmNodeTtft (노드 호출 직전 → 노드가 낸 첫 글)  voice/generation.ts 731·755~767, voice/agent_activity.ts 4277~4279
//   Agent.create의 llmNode 훅 → toStream            voice/agent_v2.ts 403~419
//   blingfire 문장 분할 (minSentenceLength 20)      tokenize/blingfire.ts 104~138, tokenize/token_stream.ts 227~271
import {
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
  llm,
  toStream,
  tokenize,
  voice,
} from '@livekit/agents';
import { stripLeadingAck, withoutLeadingAck } from '../../../src/ack.ts';
import { createAgent } from '../../../src/agent.ts';
import { SAMPLE_CALL } from '../../../src/call-context.ts';

initializeLogger({ pretty: false, level: 'silent' });
const base = import.meta.resolve('@livekit/agents');
const { performLLMInference } = await import(new URL('./voice/generation.js', base));

const ANSWERS = {
  '맞장구로 시작': '네, 가죽 지갑 각인이시군요. 예산은 어느 정도 생각하세요?',
  '바로 본론': '가죽 지갑 각인이시군요. 예산은 어느 정도 생각하세요?',
};
/** 글자 하나 = 토큰 하나. 앞 공백은 다음 글자에 붙입니다(BPE 토큰이 흔히 " 가"처럼 공백을 앞에 달고 옴). */
const toTokens = (text) => text.match(/\s?\S/gu);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TTFT_MS = 300; // 가짜 LLM의 첫 토큰 시각 (실제 약 800ms. 보류 몫을 보려는 것이라 짧게 둠)

// 고치기 전(331c151 앞) src/ack.ts의 withoutLeadingAck 사본: 처음 12자를 모은 뒤 한 번 판단. 맞장구 떼기는 지금과 같음
async function* withoutLeadingAckOld(stream) {
  let held = '';
  let passing = false;
  for await (const chunk of stream) {
    if (passing) {
      yield chunk;
      continue;
    }
    const text = typeof chunk === 'string' ? chunk : chunk.delta?.content;
    if (!text) {
      if (typeof chunk !== 'string' && chunk.delta?.toolCalls?.length && held) {
        yield stripLeadingAck(held);
        held = '';
        passing = true;
      }
      yield chunk;
      continue;
    }
    held += text;
    if (held.length >= 12) {
      yield stripLeadingAck(held);
      held = '';
      passing = true;
    }
  }
  if (held) yield stripLeadingAck(held);
}

class FakeStream extends llm.LLMStream {
  constructor(owner, opts, tokens, gapMs) {
    super(owner, opts);
    this.tokens = tokens;
    this.gapMs = gapMs;
  }
  async run() {
    await sleep(TTFT_MS);
    for (const [i, t] of this.tokens.entries()) {
      if (i > 0) await sleep(this.gapMs);
      this.queue.put({ id: 'lab', delta: { role: 'assistant', content: t } });
    }
  }
}
class FakeLLM extends llm.LLM {
  next = { tokens: [], gapMs: 10 };
  label() {
    return 'lab.FakeLLM';
  }
  chat({ chatCtx, toolCtx, connOptions }) {
    return new FakeStream(this, { chatCtx, toolCtx, connOptions }, this.next.tokens, this.next.gapMs);
  }
}

// ── 1. 실제 경로: 프로젝트 에이전트의 llmNode + SDK performLLMInference ─────────────────
const fakeLLM = new FakeLLM();
const agent = createAgent({ call: SAMPLE_CALL, llm: fakeLLM }); // src/agent.ts 그대로 (도구·훅 포함)
// Agent.default.llmNode가 찾는 활동(activity) 자리에 LLM과 연결 옵션만 넣어 둡니다.
agent._agentActivity = {
  llm: fakeLLM,
  agentSession: { connOptions: { llmConnOptions: DEFAULT_API_CONNECT_OPTIONS } },
};

// 노드 둘: 지금 = src/agent.ts의 llmNode 그대로, 옛 방식 = 같은 기본 llmNode에 사본을 씌우고 toStream으로 감쌈
// (Agent.create의 llmNode 훅도 toStream으로 감싸짐, agents/voice/agent_v2.ts 403~419)
const NODES = {
  지금: (...args) => agent.llmNode(...args),
  '옛 12자': async (chatCtx, toolCtx, modelSettings) => {
    const s = await voice.Agent.default.llmNode(agent, chatCtx, toolCtx, modelSettings);
    return s ? toStream(withoutLeadingAckOld(s)) : null;
  },
};

async function measure(text, gapMs, node) {
  fakeLLM.next = { tokens: toTokens(text), gapMs };
  const metrics = new Promise((r) => fakeLLM.once('metrics_collected', r));
  const chatCtx = llm.ChatContext.empty();
  chatCtx.addMessage({ role: 'user', content: '가죽 지갑에 각인하려고요.' });
  const t0 = performance.now();
  const [task, gen] = performLLMInference(
    node,
    chatCtx,
    agent.toolCtx,
    { toolChoice: undefined },
    new AbortController(),
  );
  const reader = gen.textStream.getReader();
  let first;
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (typeof value === 'string' && value) {
      first ??= { atMs: performance.now() - t0, text: value };
      out += value;
    }
  }
  await task.result;
  const m = await metrics;
  return { ttftMs: m.ttftMs, llmNodeTtftMs: gen.ttft * 1000, first, out };
}

console.log('1) 실제 경로로 잰 값 (가짜 LLM 첫 토큰 300ms, 이후 토큰 간격 고정. 실측이라 실행마다 몇 ms 다름)');
console.log(
  '   답의 시작        토큰 간격       방식       ttftMs  llmNodeTtft  차이(보류 몫)  노드가 처음 낸 글',
);
for (const [label, text] of Object.entries(ANSWERS)) {
  for (const [rate, gap] of [
    ['100 tok/s', 10],
    ['50 tok/s', 20],
  ]) {
    for (const [how, node] of Object.entries(NODES)) {
      const r = await measure(text, gap, node);
      console.log(
        `   ${label.padEnd(8)}  ${rate.padEnd(9)} ${String(gap).padStart(2)}ms  ${how.padEnd(6)}` +
          `${String(r.ttftMs).padStart(8)}  ${r.llmNodeTtftMs.toFixed(0).padStart(11)}  ` +
          `${(r.llmNodeTtftMs - r.ttftMs).toFixed(0).padStart(13)}  ${JSON.stringify(r.first.text)}`,
      );
    }
  }
}

/** 토큰을 하나씩 넣어, 필터가 처음 무엇을 내보낼 때까지 토큰을 몇 개 받았나 셉니다. */
async function tokensUntilFirst(filter, tokens) {
  let pulled = 0;
  async function* src() {
    for (const t of tokens) {
      pulled++;
      yield t;
    }
  }
  for await (const piece of filter(src())) if (piece) return pulled;
  return pulled;
}
for (const [label, text] of Object.entries(ANSWERS)) {
  const toks = toTokens(text);
  const parts = [];
  for (const [how, filter] of [
    ['지금', withoutLeadingAck],
    ['옛 12자', withoutLeadingAckOld],
  ]) {
    const n = await tokensUntilFirst(filter, toks);
    parts.push(
      `${how} 토큰 ${n}개 ${JSON.stringify(toks.slice(0, n).join(''))} → ${(n - 1) * 10}ms / ${(n - 1) * 20}ms`,
    );
  }
  console.log(`   손 계산 (${label}): 처음 내보낼 때까지 ${parts.join(', ')} (100 / 50 tok/s)`);
}
console.log(
  '   손 계산은 첫 토큰 뒤 (N − 1)개 간격. 실측과의 차이는 setTimeout이 매번 1~3ms 늦게 깨는 몫',
);

// ── 2. TTS 쪽 문장 분할기까지 (가상 시계) ───────────────────────────────────
// 토큰 i가 오는 시각 = TTFT + i × 간격. withoutLeadingAck는 받은 조각 때문에 내보내므로, 내보낸 시각 = 그 입력의 시각.
async function nodeOutputTimes(text, gapMs, hold) {
  const toks = toTokens(text);
  let vt = 0;
  async function* src() {
    for (const [i, t] of toks.entries()) {
      vt = TTFT_MS + i * gapMs;
      yield t;
    }
  }
  const out = [];
  for await (const piece of hold ? hold(src()) : src()) out.push([vt, piece]);
  return { out, endMs: vt };
}

async function firstSentence(pieces, endMs, minSentenceLength) {
  const s = new tokenize.blingfire.SentenceTokenizer({ minSentenceLength }).stream();
  const emitted = [];
  const reading = (async () => {
    for await (const ev of s) emitted.push(ev.token);
  })();
  const tick = () => new Promise((r) => setImmediate(r));
  for (const [t, piece] of pieces) {
    s.pushText(piece);
    await tick();
    if (emitted.length) return { atMs: t, token: emitted[0], how: '다음 문장이 시작돼 내보냄' };
  }
  s.endInput(); // LLM 스트림 끝 → 남은 것 전부
  await reading;
  return { atMs: endMs, token: emitted[0], how: 'LLM 스트림이 끝나서 내보냄' };
}

console.log('\n2) TTS로 첫 글이 넘어가는 시각 (가상 시계, 100 tok/s, LLM 첫 토큰 = 300ms)');
const LONG = '네, 가죽 지갑 각인이시군요. 예산은 어느 정도 생각하세요? 할부도 가능합니다.';
for (const [label, text] of [
  ['두 문장 답 (맞장구로 시작)', ANSWERS['맞장구로 시작']],
  ['세 문장 답 (맞장구로 시작)', LONG],
]) {
  for (const minLen of [20, 8]) {
    const raw = await nodeOutputTimes(text, 10, null);
    const now = await nodeOutputTimes(text, 10, withoutLeadingAck);
    const old = await nodeOutputTimes(text, 10, withoutLeadingAckOld);
    const a = await firstSentence(raw.out, raw.endMs, minLen);
    const b = await firstSentence(now.out, now.endMs, minLen);
    const c = await firstSentence(old.out, old.endMs, minLen);
    console.log(
      `   ${label}, minSentenceLength ${String(minLen).padStart(2)}: ` +
        `보류 없음 ${a.atMs}ms / 지금 ${b.atMs}ms (보류가 풀린 시각 ${now.out[0][0]}ms) / ` +
        `옛 12자 ${c.atMs}ms (${old.out[0][0]}ms): ${b.how}`,
    );
    console.log(`      지금 방식의 첫 TTS 글: ${JSON.stringify(b.token)}`);
  }
}
