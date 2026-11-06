// 9장 실습: 도구 호출이 선 위에서 어떤 모양인지 봅니다 (학습서 9-1·9-6절).
//  1) 요청: 이 레포의 VoiceAnthropicLLM + 실제 end_call 도구로 만든 요청 본문(tools·system·messages의 모양)
//  2) 응답: 인사 text 블록 → tool_use 블록(input_json_delta) → message_delta(stop_reason "tool_use")를
//     가짜 서버가 SSE로 흘리면, 플러그인이 내는 ChatChunk 순서
//  3) 같은 청크가 이 레포의 withoutLeadingAck(src/ack.ts)를 지난 뒤의 순서 (긴 인사, 짧은 인사, 맞장구뿐인 인사).
//     (2026-11-06 갱신) 필터가 입력 몇 번째를 받은 뒤 내보냈는지도 적어, 판단이 서서 나간 글과 도구 호출이 풀어 준 글을 구별
//  4) 도구 결과가 다음 요청에서 tool_use / tool_result 블록이 되는 모양
//     (이 레포는 endInstructions: null이라 다음 요청이 없습니다. SDK 기본값이었다면 생길 요청을 만들어 봅니다)
//
// 실행 (레포 루트에서):  node docs/1-study/lab/09-tool-call-sse.mjs   (약 1~2초, @livekit/agents 로딩)
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/agents-plugin-anthropic 1.9.5 (2026-11-06)
// 키·.env.local·외부 네트워크를 쓰지 않습니다. apiKey는 가짜 문자열이고 baseURL을 127.0.0.1의 가짜 서버로 바꿉니다.
// 가짜 서버 방식은 src/models/anthropic.test.ts와 같습니다. SSE 이벤트의 순서와 칸 이름은 Claude API 문서를 따랐지만,
// 실제 모델이 텍스트를 어떤 크기로 자르는지, 인자 없는 도구의 input_json_delta를 어떻게 보내는지는 흉내 낸 예시입니다.
import { beta, initializeLogger, llm } from '@livekit/agents';
import { createServer } from 'node:http';
import { withoutLeadingAck } from '../../../src/ack.ts';
import { SAMPLE_CALL } from '../../../src/call-context.ts';
import { VoiceAnthropicLLM } from '../../../src/models/anthropic.ts';
import { OPENING_QUESTION, buildInstructions, openingNotice } from '../../../src/prompt.ts';

initializeLogger({ pretty: false, level: 'error' });

// ── 가짜 Messages API. 받은 요청 본문(바이트 그대로)을 남기고, 미리 짠 SSE를 차례로 돌려줍니다.
const sse = (events) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const messageStart = (id) => ({
  type: 'message_start',
  message: {
    id,
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-haiku-5-5',
    stop_reason: null,
    usage: {
      input_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 3200, // 숫자는 가짜입니다(모양만)
      output_tokens: 1,
    },
  },
});

/** 인사 text 블록(index 0) + end_call tool_use 블록(index 1). */
function greetingThenEndCall(id, textPieces) {
  return [
    messageStart(id),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ...textPieces.map((text) => ({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    })),
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: `toolu_${id}`, name: 'end_call', input: {} },
    },
    // end_call은 인자가 없어 입력이 {}입니다. 인자 있는 도구라면 JSON 조각이 여러 개로 옵니다(아래 4번 뒤 참고).
    {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '' },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 38 } },
    { type: 'message_stop' },
  ];
}

const RESPONSES = [
  // 1) 긴 인사: 첫머리 맞장구("네, 감사합니다.")가 두 조각에 걸쳐 옴
  greetingThenEndCall('lab_1', [
    '네, ',
    '감사합니다. ',
    '토요일 오후 방문체험 희망하신 걸로 ',
    '담당 상담사가 확정 연락드릴게요. 좋은 하루 보내세요.',
  ]),
  // 2) 짧은 인사: "네, " 뒤 "안녕히 계세요."가 와서 도구 호출 전에 판단이 섬
  greetingThenEndCall('lab_2', ['네, ', '안녕히 계세요.']),
  // 3) 도구 결과를 받은 다음 요청에 대한 답(가정)
  [
    messageStart('lab_3'),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '안녕히 계세요.' },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
    { type: 'message_stop' },
  ],
];

const bodies = [];
const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    bodies.push(Buffer.concat(chunks));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(RESPONSES[bodies.length - 1]));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${server.address().port}`;

const model = new VoiceAnthropicLLM({
  model: 'claude-haiku-5-5',
  apiKey: 'fake-key-for-lab',
  baseURL,
  effort: 'low',
  thinking: 'off',
});
// src/agent.ts와 같은 옵션의 실제 도구
const tools = [
  beta.createEndCallTool({
    deleteRoom: false,
    endInstructions: null,
    extraDescription:
      '마지막 인사를 말한 같은 답에서 부릅니다. 통화 곤란, 수신 거부, 신청한 적 없음, 마무리 인사 뒤에 씁니다.',
  }),
];

// 세션이 만드는 대화 기록 흉내: 지시문(system) → 첫 멘트 두 번의 say(assistant 둘) → 고객 말들
function callHistory() {
  const ctx = llm.ChatContext.empty();
  ctx.addMessage({ role: 'system', content: buildInstructions(SAMPLE_CALL) });
  ctx.addMessage({ role: 'assistant', content: openingNotice(SAMPLE_CALL) });
  ctx.addMessage({ role: 'assistant', content: OPENING_QUESTION });
  ctx.addMessage({ role: 'user', content: '네, 괜찮아요.' });
  ctx.addMessage({ role: 'assistant', content: '방문체험은 언제쯤 생각하세요?' });
  ctx.addMessage({
    role: 'user',
    content: '이번 주 토요일 오후요. 그럼 그렇게 해 주세요. 감사합니다.',
  });
  return ctx;
}

const show = (chunk) => {
  if (typeof chunk === 'string') return `글(string)   ${JSON.stringify(chunk)}`;
  if (chunk.delta?.toolCalls?.length) {
    const f = chunk.delta.toolCalls[0];
    return `도구 호출    FunctionCall{ name: ${f.name}, callId: ${f.callId}, args: ${JSON.stringify(f.args)} }`;
  }
  if (chunk.delta?.content) return `글 조각      ${JSON.stringify(chunk.delta.content)}`;
  if (chunk.usage) {
    const u = chunk.usage;
    return `사용량       promptTokens ${u.promptTokens} (캐시 읽기 ${u.promptCachedTokens}), completionTokens ${u.completionTokens}`;
  }
  return JSON.stringify(chunk);
};

/** 스트림을 한 번 받아 원본 청크를 모읍니다. */
async function collect(stream) {
  const out = [];
  for await (const c of stream) out.push(c);
  return out;
}
/** 필터를 지나며, 출력마다 그때까지 받은 입력 수를 함께 모읍니다. */
async function collectAfterAck(chunks) {
  let pulled = 0;
  async function* src() {
    for (const c of chunks) {
      pulled++;
      yield c;
    }
  }
  const out = [];
  for await (const c of withoutLeadingAck(src())) out.push([c, pulled]);
  return out;
}
const kind = (c) =>
  typeof c === 'string'
    ? '글'
    : c.delta?.toolCalls?.length
      ? '도구 호출'
      : c.delta?.content
        ? '글 조각'
        : '사용량';
const showAfter = (pairs, input) =>
  pairs.forEach(([c, n], i) =>
    console.log(`  ${i}. ${show(c)}   ← 입력 ${n}번째(${kind(input[n - 1])})를 받고 냄`),
  );

// ── 1) 요청 본문
const raw1 = await collect(model.chat({ chatCtx: callHistory(), toolCtx: tools }));
const body1 = bodies[0];
const json1 = JSON.parse(body1.toString('utf8'));
console.log('1) 요청 본문 (POST /v1/messages)');
console.log(
  `  본문 ${body1.length.toLocaleString('en-US')}B, JSON 최상위 칸 순서: ${Object.keys(json1).join(', ')}`,
);
const at = (key) => body1.indexOf(Buffer.from(`"${key}":`));
console.log(
  `  JSON 안 위치(바이트): messages ${at('messages')}, system ${at('system')}, tools ${at('tools')}  ← JSON 순서일 뿐, 모델 입력의 렌더 순서는 tools → system → messages`,
);
const t = json1.tools[0];
console.log(`  tools: ${json1.tools.length}개`);
console.log(`    name          ${t.name}`);
console.log(
  `    description   ${t.description.length}자: ${JSON.stringify(t.description.slice(0, 60))}…`,
);
console.log(`                  …${JSON.stringify(t.description.slice(-45))}`);
console.log(`    input_schema  ${JSON.stringify(t.input_schema)}`);
console.log(`  tool_choice     ${JSON.stringify(json1.tool_choice)}`);
console.log(
  `  system: 블록 ${json1.system.length}개, [0].text ${json1.system[0].text.length}자, cache_control ${json1.system[0].cache_control ? '있음' : '없음'}`,
);
console.log(
  `  최상위 cache_control ${JSON.stringify(json1.cache_control)}, thinking ${JSON.stringify(json1.thinking)}, output_config ${JSON.stringify(json1.output_config)}`,
);
console.log('  messages:');
for (const [i, m] of json1.messages.entries()) {
  const parts =
    typeof m.content === 'string'
      ? `"${m.content}"`
      : m.content.map((b) => `${b.type}(${b.text?.length ?? ''}자)`).join(' + ');
  console.log(`    [${i}] ${m.role.padEnd(9)} ${parts}`);
}

// ── 2) 응답 SSE와 플러그인 청크
console.log('\n2) 가짜 서버가 보낸 SSE (첫 응답) → 플러그인이 낸 ChatChunk');
for (const e of RESPONSES[0]) {
  const d = e.delta ?? e.content_block ?? {};
  const detail =
    e.type === 'content_block_start'
      ? `${d.type}${d.name ? ` name=${d.name} id=${d.id}` : ''}`
      : e.type === 'content_block_delta'
        ? `${d.type} ${JSON.stringify(d.text ?? d.partial_json)}`
        : e.type === 'message_delta'
          ? `stop_reason=${d.stop_reason}`
          : '';
  console.log(`  event: ${e.type.padEnd(20)} ${e.index ?? ''} ${detail}`);
}
console.log('  ── 플러그인 출력 순서');
raw1.forEach((c, i) => console.log(`  ${i}. ${show(c)}`));

// ── 3) withoutLeadingAck를 지난 뒤
console.log('\n3) withoutLeadingAck(src/ack.ts)를 지난 뒤');
console.log('  긴 인사:');
const after1 = await collectAfterAck(raw1);
showAfter(after1, raw1);
const acked1 = after1.map(([c]) => c);
const raw2 = await collect(model.chat({ chatCtx: callHistory(), toolCtx: tools }));
console.log('  짧은 인사(플러그인 출력):');
raw2.forEach((c, i) => console.log(`  ${i}. ${show(c)}`));
console.log('  짧은 인사(withoutLeadingAck 뒤):');
showAfter(await collectAfterAck(raw2), raw2);
// 3) 맞장구뿐인 인사: 짧은 인사의 청크에서 둘째 글 조각만 "감사합니다."로 바꿈(서버를 다시 부르지 않음).
//    맞장구를 다 떼면 남는 글이 없어 판단이 서지 않으므로, 도구 호출 청크가 와야 보류가 풀립니다.
const raw3 = raw2.map((c) =>
  c.delta?.content === '안녕히 계세요.'
    ? { ...c, delta: { ...c.delta, content: '감사합니다.' } }
    : c,
);
console.log('  맞장구뿐인 인사 "네, 감사합니다."(withoutLeadingAck 뒤):');
showAfter(await collectAfterAck(raw3), raw3);

// ── 4) 다음 요청에서 tool_use / tool_result가 되는 모양
console.log(
  '\n4) 도구 결과를 실은 다음 요청 (가정: endInstructions가 SDK 기본값 "say goodbye to the user"였다면)',
);
const call = acked1.find((c) => typeof c !== 'string' && c.delta?.toolCalls?.length).delta
  .toolCalls[0];
const spoken = acked1.map((c) => (typeof c === 'string' ? c : (c.delta?.content ?? ''))).join('');
const next = callHistory();
const reply = next.addMessage({ role: 'assistant', content: spoken });
// 대화 기록은 createdAt 순으로 정렬됩니다. 실제 세션은 도구 실행이 시작될 때 FunctionCall의 createdAt을
// 그 시각으로 다시 적고 기록 끝에 넣습니다(agents/voice/agent_activity.ts 4229~4236). 같은 순서를 만듭니다.
call.createdAt = reply.createdAt + 1;
next.items.push(call);
next.items.push(
  llm.FunctionCallOutput.create({
    callId: call.callId,
    name: call.name,
    // SDK는 도구가 돌려준 값을 JSON.stringify로 글로 바꿉니다(agents/voice/generation.ts). 문자열이면 따옴표가 붙습니다.
    output: JSON.stringify('say goodbye to the user'),
    isError: false,
    createdAt: reply.createdAt + 2,
  }),
);
await collect(model.chat({ chatCtx: next, toolCtx: tools }));
const json3 = JSON.parse(bodies[2].toString('utf8'));
for (const m of json3.messages.slice(-3))
  console.log(`  ${m.role.padEnd(9)} ${JSON.stringify(m.content)}`);
console.log(`  (messages ${json3.messages.length}개, 마지막이 user라 "." 턴은 붙지 않음)`);

// 인자 있는 도구라면: input_json_delta 조각을 이어 붙인 문자열이 args가 됩니다(플러그인 llm.ts 417~421).
const fragments = ['{"ti', 'me": "토요일 ', '오후 세 시"}'];
console.log(
  `\n  (참고) 인자 있는 도구의 조각 ${JSON.stringify(fragments)} → args ${JSON.stringify(fragments.join(''))}`,
);
console.log(
  `         다음 요청에서는 JSON.parse해 input ${JSON.stringify(JSON.parse(fragments.join('')))}으로 갑니다(llm.ts 150).`,
);

server.close();
