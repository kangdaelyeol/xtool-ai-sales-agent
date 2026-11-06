// 14장 실습: SDK의 테스트 도구로 방 없이 세션을 한 턴씩 돌리기 (학습서 14-6절 "실제로 돌려 보기").
//  1) 이 레포의 실제 에이전트(src/agent.ts의 createAgent: 지시문·llmNode의 맞장구 제거·end_call 도구)를
//     voice.testing.FakeLLM과 AgentSession에 얹고 session.run({ userInput })으로 한 턴씩 돌림
//  2) result.expect로 사건 순서를 검사: 메시지 → 도구 호출 → 도구 결과. end_call은 withMockTools로 가짜로 바꿈
//     (2026-11-06 갱신) 사건은 createdAt(ms) 순으로 끼워지므로, 메시지와 도구 호출이 같은 ms에 찍히면 순서가 바뀝니다.
//     그래서 이 답에만 FakeLLM의 ttft 5ms를 줍니다(아래 2번 주석).
//  3) 겹친 맞장구(17-2 #43, 2026-11-06 고침)가 세션 안에서 떼어지는지: FakeLLM은 답을 3글자씩 잘라 흘림.
//     같은 조각을 고치기 전 방식(처음 12자를 모아 판단, 스크립트 안의 사본)에 넣은 결과도 함께 보임
//  4) session.run이 거치지 않는 것: onUserTurnCompleted(오인식 보정·즉시 반응), TTS 쪽(발음 변환)
//  5) 단언이 실패하면 어떤 메시지가 나오나
//
// 실행 (레포 루트에서):  node docs/1-study/lab/14-sdk-session.mjs   (약 3초: SDK 불러오기 약 0.9초, 한 턴은 수 ms,
//   세션 닫기 약 0.5초, 그 뒤 SDK의 남은 타이머가 끝날 때까지 1.5초 남짓)
// 기준: Node 24, @livekit/agents 1.9.5 (2026-11-06)
// 키·.env.local·네트워크를 쓰지 않습니다. LLM은 정해진 입력에 정해진 답을 내는 FakeLLM이고, STT·TTS·VAD·방이 없습니다.
// FakeLLM의 답 조각 나누기(3글자씩)는 agents/voice/testing/fake_llm.ts 89~96, 입력 찾기는 119~148입니다.
import { initializeLogger, voice } from '@livekit/agents';
import { stripLeadingAck, withoutLeadingAck } from '../../../src/ack.ts';
import { createAgent } from '../../../src/agent.ts';
import { SAMPLE_CALL } from '../../../src/call-context.ts';

initializeLogger({ pretty: false, level: 'error' });
const { FakeLLM, withMockTools } = voice.testing;

const llm = new FakeLLM([
  { input: '네, 괜찮아요', content: '네, 예산은 어느 정도 생각하세요?' },
  { input: '삼백만 원 안쪽이요', content: '알겠습니다. 감사합니다. 예산은요?' },
  { input: 'F two 울트라 얼마예요', content: '가격은 상담사가 안내해 드려요.' },
  {
    input: '그냥 전화하지 마세요',
    content: '네, 감사합니다.',
    // 사건은 createdAt(ms) 순으로 끼워집니다(agents/voice/testing/run_result.ts 358~365). 메시지는 재생 허가 시각
    // (agent_activity.ts 4061), 도구 호출은 도구 실행을 시작한 시각(같은 파일 4230~4236)이라, 가짜 LLM이 지연 없이
    // 답하면 둘이 같은 ms에 찍혀 도구 호출이 앞에 끼는 일이 있습니다(실측: 40번 중 6번). 5ms 늦추면 늘 메시지가 앞입니다.
    ttft: 5,
    toolCalls: [{ name: 'end_call', args: {} }],
  },
]);

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

/** 조각 배열을 필터에 넣어 결과와, 처음 내보낼 때까지 받은 조각 수를 돌려줍니다. */
async function runFilter(filter, parts) {
  let pulled = 0;
  let firstAt;
  async function* src() {
    for (const p of parts) {
      pulled++;
      yield p;
    }
  }
  let out = '';
  for await (const x of filter(src())) {
    firstAt ??= pulled;
    out += x;
  }
  return { out, firstAt, held: parts.slice(0, firstAt).join('') };
}

const session = new voice.AgentSession({ llm });
const agent = createAgent({ call: SAMPLE_CALL, llm });
await session.start({ agent });

const describe = (ev) => {
  const it = ev.item;
  if (ev.type === 'message') return `message(${it.role}) ${JSON.stringify(it.textContent)}`;
  if (ev.type === 'function_call') return `function_call ${it.name}(${it.args})`;
  if (ev.type === 'function_call_output')
    return `function_call_output ${JSON.stringify(it.output)}`;
  return ev.type;
};

async function turn(userInput) {
  const t0 = performance.now();
  const result = session.run({ userInput });
  await result.wait();
  console.log(`   사용자: "${userInput}"  (${(performance.now() - t0).toFixed(1)}ms)`);
  for (const ev of result.events) console.log(`     ${describe(ev)}`);
  return result;
}

// ── 1·3. 맞장구 제거가 세션 안에서 도나 ─────────────────────────────────────
console.log('== 1. llmNode(맞장구 제거)가 세션 안에서 ==');
const r1 = await turn('네, 괜찮아요');
const said1 = r1.expect.nextEvent().isMessage({ role: 'assistant' }).event().item.textContent;
r1.expect.noMoreEvents();
console.log(`   → FakeLLM 답 "네, 예산은 어느 정도 생각하세요?" → 세션이 남긴 답 "${said1}"`);

console.log('\n== 3. 겹친 맞장구 (17-2 #43, 2026-11-06 고침) ==');
const chunks = [];
for (let i = 0; i < '알겠습니다. 감사합니다. 예산은요?'.length; i += 3)
  chunks.push('알겠습니다. 감사합니다. 예산은요?'.slice(i, i + 3));
const now = await runFilter(withoutLeadingAck, chunks);
const old = await runFilter(withoutLeadingAckOld, chunks);
console.log(`   FakeLLM이 흘리는 조각: ${JSON.stringify(chunks)}`);
console.log(
  `   지금 방식: 조각 ${now.firstAt}개 ${JSON.stringify(now.held)}(${now.held.length}자)까지 모아 판단 → ${JSON.stringify(now.out)}`,
);
console.log(
  `   옛 방식(12자, 사본): 조각 ${old.firstAt}개 ${JSON.stringify(old.held)}(${old.held.length}자)에서 판단 → ${JSON.stringify(old.out)}`,
);
const r2 = await turn('삼백만 원 안쪽이요');
const said2 = r2.expect.nextEvent().isMessage({ role: 'assistant' }).event().item.textContent;
console.log(
  `   → 세션이 남긴 답: 기대 "예산은요?", 실제 "${said2}" ${said2 === '예산은요?' ? '(맞음)' : '(틀림: #43이 세션에서 재현)'}`,
);

// ── 2. 도구 호출 순서 ───────────────────────────────────────────────────
console.log('\n== 2. 마지막 인사 + end_call (도구는 withMockTools로 가짜) ==');
// mock은 "에이전트 생성자"로 찾습니다(agent.constructor === 넘긴 생성자, agents/voice/testing/run_result.ts 1050~1058).
// Agent.create는 부를 때마다 익명 하위 클래스 AgentV2를 새로 만들므로(agents/voice/agent_v2.ts 129~133)
// voice.Agent를 넘기면 맞지 않습니다. 그 인스턴스의 constructor를 넘겨야 합니다.
console.log(
  `   agent.constructor.name = ${agent.constructor.name}, voice.Agent와 같은가? ${agent.constructor === voice.Agent}`,
);
const mockCalls = [];
const fakeEndCall = () => {
  mockCalls.push('end_call');
  return '통화 종료 (가짜)';
};
const probe = new voice.AgentSession({ llm });
await probe.start({ agent: createAgent({ call: SAMPLE_CALL, llm }) });
// SDK 예시는 `using _mock = withMockTools(…)`(블록을 나갈 때 자동 해제)이고, 아래 try/finally가 같은 일입니다.
const wrongMock = withMockTools(voice.Agent, { end_call: fakeEndCall });
try {
  const r = probe.run({ userInput: '그냥 전화하지 마세요' });
  await r.wait();
  console.log(
    `   withMockTools(voice.Agent, …): mock 불린 횟수 ${mockCalls.length} → 진짜 end_call이 돎 (도구 결과 ${JSON.stringify(r.events.at(-1)?.item.output)})`,
  );
} finally {
  wrongMock[Symbol.dispose]();
}
await probe.close().catch(() => {});
let r3;
const mock = withMockTools(agent.constructor, { end_call: fakeEndCall });
try {
  r3 = await turn('그냥 전화하지 마세요');
} finally {
  mock[Symbol.dispose]();
}
console.log(`   withMockTools(agent.constructor, …): mock 불린 횟수 ${mockCalls.length}`);
const bye = r3.expect.nextEvent().isMessage({ role: 'assistant' }).event().item.textContent;
r3.expect.nextEvent().isFunctionCall({ name: 'end_call' });
r3.expect.nextEvent().isFunctionCallOutput();
r3.expect.noMoreEvents();
console.log(
  `   → 사건 순서 단언 통과. 인사 "${bye}"는 맞장구뿐이라 판단하지 못한 채 도구 호출이 와서 보류분을 먼저 내보냈고, 다 떼면 빈 글이라 원문 유지`,
);

// ── 4. 거치지 않는 것 ───────────────────────────────────────────────────
console.log('\n== 4. session.run이 거치지 않는 것 ==');
await turn('F two 울트라 얼마예요');
const users = session.history.items.filter((i) => i.type === 'message' && i.role === 'user');
console.log(
  `   대화 기록의 사용자 말: ${users.map((i) => JSON.stringify(i.textContent)).join(', ')}` +
    '\n   → "F two"가 "F2"로 고쳐지지 않음: onUserTurnCompleted(오인식 보정·즉시 반응)는 STT 턴 확정 경로에서만 불림' +
    `\n   → 세션에 TTS가 없으므로 발음 변환(ttsTextTransforms)도 돌지 않음: tts ${session.tts ?? '없음'}`,
);

// ── 5. 실패 메시지 ─────────────────────────────────────────────────────
console.log('\n== 5. 단언이 실패하면 ==');
try {
  r1.expect.at(0).isFunctionCall({ name: 'end_call' });
} catch (error) {
  console.log(
    `   ${error.constructor.name}: ${String(error.message).split('\n').slice(0, 6).join('\n   ')}`,
  );
}

await session.close();
