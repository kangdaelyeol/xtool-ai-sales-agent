// 10장 실습: ElevenLabs 플러그인 안의 blingfire 문장 분할기가 글을 언제 TTS로 넘기는지 잽니다 (학습서 10-4절).
//  1) 한꺼번에 나눈 결과(tokenize): 20자 미만 문장이 다음 문장과 합쳐지는 모습
//  2) 한 글자씩 25ms 간격으로 넣었을 때(stream) 덩어리가 나오는 시각. 플러그인 기본값과 바꾼 설정 비교
//  3) 이 레포의 실제 경로: withoutLeadingAck(첫머리 맞장구를 판단할 수 있을 때까지 보류) → filter_markdown → filter_emoji
//     → pronunciationTransform → blingfire. 앞단의 보류가 문장 분할의 보류와 겹치는 모습 (기본값과 minSentenceLength 8).
//     (2026-11-06 갱신) 맞장구로 시작하지 않는 이 입력은 withoutLeadingAck가 첫 글자 "가"에서 바로 내보내므로(17-2 #43 고침),
//     앞단의 보류는 filter_markdown(구분 기호 앞까지)과 pronunciationTransform(마지막 공백 뒤)의 단어 보류입니다.
//
// 실행 (레포 루트에서):  node docs/1-study/lab/10-blingfire-stream.mjs   (1초 안팎, @livekit/agents 로딩)
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/blingfire 1.2.0, @livekit/agents-plugin-elevenlabs 1.9.5 (2026-11-06)
// 키·.env.local·네트워크를 쓰지 않습니다. 분할기는 로컬 네이티브(blingfire)로만 돕니다.
//
// 시간은 "가상 시각"입니다. 글자 i를 i × 25ms에 넣었다고 치고, 넣을 때마다 대기 중인 비동기 처리를 모두 끝낸 뒤
// 새로 나온 덩어리를 그 시각에 적습니다. 실제로 잠들지 않으므로 실행마다 같은 값이 나옵니다.
// 25ms(초당 40글자)는 검토 때 쓴 간격을 따른 예시입니다. 이 레포의 LLM 속도를 잰 값이 아니고, LLM이 더 빠르면
// 모든 시각이 그 비율로 줄어듭니다.
//
// 플러그인이 쓰는 분할기: elevenlabs.TTS 생성자에서 wordTokenizer를 넘기지 않으면
//   new tokenize.blingfire.SentenceTokenizer({ xmlAware: opts.enableSsmlParsing })   (enableSsmlParsing 기본 false)
// 이고(agents-plugin-elevenlabs/src/tts.ts 870~874), 기본값은 minSentenceLength 20, streamContextLength 10
// (agents/src/tokenize/blingfire.ts 104~108)입니다. src/models/index.ts는 wordTokenizer를 넘기지 않습니다.
import { initializeLogger, tokenize, voice } from '@livekit/agents';
import { ReadableStream } from 'node:stream/web';
import { withoutLeadingAck } from '../../../src/ack.ts';
import { pronunciationTransform } from '../../../src/pronunciation.ts';

initializeLogger({ pretty: false, level: 'error' });

const TEXT = '가죽 소품이요. 주로 어떤 걸 만드실 생각이세요? 예산도 여쭤봐도 될까요?';
const STEP_MS = 25;
const settle = () => new Promise((r) => setImmediate(r));

// ── 1) 한꺼번에 나누기
console.log(`입력 (${[...TEXT].length}자): "${TEXT}"`);
console.log(
  '글자 위치(0부터): 첫 "."=7, 첫 "?"=26, "예"=28, 마지막 "?"=40. 25ms 간격이면 "예"는 t=700ms\n',
);
console.log('1) tokenize(): 한꺼번에 나누기');
for (const min of [20, 8, 1]) {
  const out = new tokenize.blingfire.SentenceTokenizer({ minSentenceLength: min }).tokenize(TEXT);
  console.log(
    `   minSentenceLength ${String(min).padStart(2)}: ${out.map((s) => `"${s}"(${s.length}자)`).join(' | ')}`,
  );
}

// ── 2) 한 글자씩 stream에 넣기
/** 글자를 하나씩 넣고, 덩어리가 나온 가상 시각과 그때까지 넣은 글자를 돌려줍니다. */
async function streamOneByOne(options) {
  const s = new tokenize.blingfire.SentenceTokenizer(options).stream();
  const emitted = [];
  let now = 0;
  let typed = '';
  const reader = (async () => {
    for await (const ev of s) emitted.push({ at: now, token: ev.token, typed });
  })();
  const chars = [...TEXT];
  for (let i = 0; i < chars.length; i++) {
    now = i * STEP_MS;
    typed += chars[i];
    s.pushText(chars[i]);
    await settle();
  }
  now = chars.length * STEP_MS; // LLM 스트림이 끝난 시각 (마지막 글자 다음 칸)
  typed += ' ⟨입력 끝⟩';
  s.endInput();
  await reader;
  return emitted;
}

const show = (rows) => {
  for (const r of rows) {
    const last = r.typed.length > 12 ? `…${r.typed.slice(-10)}` : r.typed;
    console.log(
      `     t=${String(r.at).padStart(5)}ms  넣은 끝 "${last}"  → 보냄 "${r.token}" (${r.token.length}자)`,
    );
  }
};

console.log(
  `\n2) stream(): ${STEP_MS}ms마다 한 글자씩 (마지막 글자 t=${([...TEXT].length - 1) * STEP_MS}ms, 입력 끝 t=${[...TEXT].length * STEP_MS}ms)`,
);
const CASES = [
  ['플러그인 기본값 (min 20, context 10)', {}],
  ['minSentenceLength 8', { minSentenceLength: 8 }],
  ['minSentenceLength 8, streamContextLength 1', { minSentenceLength: 8, streamContextLength: 1 }],
  ['minSentenceLength 1, streamContextLength 1', { minSentenceLength: 1, streamContextLength: 1 }],
];
for (const [label, opts] of CASES) {
  console.log(`   ${label}`);
  show(await streamOneByOne(opts));
}

// 한 문장만 오는 답: 다음 문장이 없으므로 무엇을 바꿔도 입력 끝까지 기다립니다.
{
  const one = '예산은 어느 정도 생각하세요?';
  const s = new tokenize.blingfire.SentenceTokenizer({
    minSentenceLength: 1,
    streamContextLength: 1,
  }).stream();
  const got = [];
  let now = 0;
  const reader = (async () => {
    for await (const ev of s) got.push(`t=${now}ms "${ev.token}"`);
  })();
  const chars = [...one];
  for (let i = 0; i < chars.length; i++) {
    now = i * STEP_MS;
    s.pushText(chars[i]);
    await settle();
  }
  now = chars.length * STEP_MS;
  s.endInput();
  await reader;
  console.log(
    `   한 문장 답 "${one}"(${one.length}자), min 1·context 1: ${got.join(', ')} ← 마지막 글자는 t=${(chars.length - 1) * STEP_MS}ms`,
  );
}

// ── 3) 이 레포의 실제 경로 (세션의 LLM 노드 → ttsTextTransforms → 플러그인 분할기)
async function repoPath(options) {
  let now = 0;
  let typed = '';
  let pushController;
  const source = new ReadableStream({
    start(c) {
      pushController = c;
    },
  });
  // src/agent.ts의 llmNode가 LLM 출력에 거는 것과 같은 함수(문자열 청크도 받음)
  const afterAck = ReadableStream.from(withoutLeadingAck(source));
  // src/main.ts의 ttsTextTransforms와 같은 목록
  const transformed = voice.textTransforms.applyTextTransforms(afterAck, [
    'filter_markdown',
    'filter_emoji',
    pronunciationTransform,
  ]);
  const s = new tokenize.blingfire.SentenceTokenizer({ xmlAware: false, ...options }).stream();
  const arrivals = [];
  const emitted = [];
  const pump = (async () => {
    for await (const chunk of transformed) {
      arrivals.push({ at: now, chunk });
      s.pushText(chunk);
    }
    s.endInput();
  })();
  const reader = (async () => {
    for await (const ev of s) emitted.push({ at: now, token: ev.token, typed });
  })();
  const chars = [...TEXT];
  for (let i = 0; i < chars.length; i++) {
    now = i * STEP_MS;
    typed += chars[i];
    pushController.enqueue(chars[i]);
    for (let k = 0; k < 5; k++) await settle(); // 여러 단계의 비동기 처리를 끝까지
  }
  now = chars.length * STEP_MS;
  typed += ' ⟨입력 끝⟩';
  pushController.close();
  await pump;
  await reader;
  return { arrivals, emitted };
}

console.log(
  '\n3) 이 레포의 경로: withoutLeadingAck → filter_markdown → filter_emoji → pronunciationTransform → blingfire',
);
{
  const { arrivals, emitted } = await repoPath({});
  console.log('   분할기에 도착한 조각 (앞단을 지난 뒤):');
  console.log(`     ${arrivals.map((a) => `t=${a.at} "${a.chunk}"`).join(', ')}`);
  console.log('   분할기 기본값(min 20)이 TTS로 보낸 덩어리:');
  show(emitted);
  const min8 = await repoPath({ minSentenceLength: 8 });
  console.log('   같은 경로에 minSentenceLength 8:');
  show(min8.emitted);
}
