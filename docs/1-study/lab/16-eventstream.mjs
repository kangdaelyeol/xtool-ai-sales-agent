// 16장 실습: bedrock-runtime 스트리밍 응답의 바이트. AWS event-stream 프레임 한 개를 만들고, 손으로 읽고, CRC32를 다시 계산
// (학습서 16-6절 "깊이 보기: bedrock-runtime 응답을 바이트로 읽기").
//  1) SDK가 쓰는 코덱(@smithy/eventstream-codec)으로 chunk 프레임 하나를 만들어 hexdump
//  2) 손으로 쪼개기: 전체 길이 4B · 머리글 길이 4B · 앞부분 CRC 4B · 머리글들 · 본문 {"bytes":"<base64>"} · 메시지 CRC 4B
//  3) CRC32를 표 없이 비트 단위로 직접 계산해 프레임의 두 CRC와 node:zlib의 crc32와 비교
//  4) Bedrock SDK에 그대로 먹이기: fetch가 event-stream을 아무 데서나 잘린 조각(7바이트씩)으로 돌려줘도
//     SDK(client.js의 adaptResponse → core/streaming.js)가 Anthropic SSE로 바꿔 줌. 바뀐 SSE 원문과 이벤트
//  5) 바이트 하나가 깨지면(CRC 불일치) / 서버가 exception 프레임을 보내면 무엇이 나오나
//
// 실행: 레포 루트에서  node docs/1-study/lab/16-eventstream.mjs
// 기준: Node 24, @anthropic-ai/bedrock-sdk 1.1.1(@smithy/eventstream-codec 2.2.0, @anthropic-ai/sdk 1.4.0). 2026-11-06 작성.
// 키는 가짜이고 요청은 AWS로 나가지 않습니다(fetch를 가로챔). .env.local을 읽지 않습니다.
// 프레임 안의 머리글 순서와 본문 모양은 SDK의 해석 코드(AWS_restJson1.js)가 받아 주는 모양으로 만든 것이라,
// 실제 Bedrock 응답의 바이트와 순서·추가 칸까지 같다는 보장은 없습니다.
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { createRequire } from 'node:module';
import { crc32 as zlibCrc32 } from 'node:zlib';

const require = createRequire(import.meta.url);
// pnpm이라 코덱은 bedrock-sdk → eventstream-serde-node → eventstream-serde-universal 아래에 있습니다.
const step = (from, name) => createRequire(from).resolve(name);
const serdeNode = step(require.resolve('@anthropic-ai/bedrock-sdk'), '@smithy/eventstream-serde-node');
const serdeUniversal = step(serdeNode, '@smithy/eventstream-serde-universal');
const { EventStreamCodec } = createRequire(serdeUniversal)('@smithy/eventstream-codec');

const enc = new TextEncoder();
const dec = new TextDecoder();
const codec = new EventStreamCodec((b) => dec.decode(b), (s) => enc.encode(s));

const anthropicEvent = (text) =>
  JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const chunkFrame = (json) =>
  codec.encode({
    headers: {
      ':event-type': { type: 'string', value: 'chunk' },
      ':content-type': { type: 'string', value: 'application/json' },
      ':message-type': { type: 'string', value: 'event' },
    },
    body: enc.encode(JSON.stringify({ bytes: Buffer.from(json).toString('base64') })),
  });

// ── 1. 프레임 하나 ─────────────────────────────────────────────
const inner = anthropicEvent('네, 안녕하세요.');
const frame = chunkFrame(inner);
console.log('== 1. chunk 프레임 하나 (hexdump) ==');
for (let off = 0; off < frame.length; off += 16) {
  const row = frame.subarray(off, off + 16);
  const hex = [...row].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
  console.log(`${off.toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  ${ascii}`);
}

// ── 2. 손으로 쪼개기 ───────────────────────────────────────────
const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
const totalLength = view.getUint32(0);
const headersLength = view.getUint32(4);
const preludeCrc = view.getUint32(8);
const messageCrc = view.getUint32(frame.length - 4);
console.log('\n== 2. 칸별로 ==');
console.log(`0~3    전체 길이       ${totalLength} (= 실제 바이트 수 ${frame.length})`);
console.log(`4~7    머리글 길이     ${headersLength}`);
console.log(`8~11   앞부분 CRC32    0x${preludeCrc.toString(16).padStart(8, '0')}  (0~7바이트의 CRC)`);
let p = 12;
const TYPES = { 7: 'string' };
while (p < 12 + headersLength) {
  const nameLen = frame[p];
  const name = dec.decode(frame.subarray(p + 1, p + 1 + nameLen));
  const type = frame[p + 1 + nameLen];
  const valueLen = view.getUint16(p + 2 + nameLen);
  const value = dec.decode(frame.subarray(p + 4 + nameLen, p + 4 + nameLen + valueLen));
  const size = 1 + nameLen + 1 + 2 + valueLen;
  console.log(
    `${String(p).padStart(3)}~${String(p + size - 1).padEnd(3)} 머리글  이름 길이 ${nameLen}, "${name}", 값 종류 ${type}(${TYPES[type] ?? '?'}), 값 길이 ${valueLen}, "${value}"  → ${size}바이트`,
  );
  p += size;
}
const payload = frame.subarray(12 + headersLength, frame.length - 4);
console.log(`${12 + headersLength}~${frame.length - 5}  본문 (${payload.length}바이트) ${dec.decode(payload)}`);
console.log(`${frame.length - 4}~${frame.length - 1}  메시지 CRC32    0x${messageCrc.toString(16).padStart(8, '0')}  (0~${frame.length - 5}바이트 전체의 CRC, 앞부분 CRC 칸 포함)`);
const bytesField = JSON.parse(dec.decode(payload)).bytes;
console.log(`본문의 bytes를 base64로 풀면: ${Buffer.from(bytesField, 'base64').toString('utf8')}`);
console.log(
  `길이 손 계산: 12(앞부분) + ${headersLength}(머리글) + ${payload.length}(본문) + 4(메시지 CRC) = ${12 + headersLength + payload.length + 4}`,
);
console.log(
  `본문 부풀림: Anthropic 이벤트 JSON ${Buffer.byteLength(inner)}B → base64 ${bytesField.length}B → {"bytes":…} ${payload.length}B → 프레임 ${frame.length}B`,
);

// ── 3. CRC32 손 계산 ───────────────────────────────────────────
// CRC-32/IEEE(이더넷·zip과 같은 것): 반사형 다항식 0xEDB88320, 시작값 0xFFFFFFFF, 끝에 다시 XOR
function crc32ByHand(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
console.log('\n== 3. CRC32 다시 계산 ==');
const hex = (n) => `0x${n.toString(16).padStart(8, '0')}`;
const preludeByHand = crc32ByHand(frame.subarray(0, 8));
const messageByHand = crc32ByHand(frame.subarray(0, frame.length - 4));
console.log(`앞부분: 프레임 ${hex(preludeCrc)} / 손 계산 ${hex(preludeByHand)} / zlib ${hex(zlibCrc32(frame.subarray(0, 8)))}`);
console.log(
  `메시지: 프레임 ${hex(messageCrc)} / 손 계산 ${hex(messageByHand)} / zlib ${hex(zlibCrc32(frame.subarray(0, frame.length - 4)))}`,
);
console.log(`손 계산 일치: ${preludeByHand === preludeCrc && messageByHand === messageCrc}`);
console.log(`CRC32("123456789") = ${hex(crc32ByHand(enc.encode('123456789')))} (표준 검사값 0xcbf43926)`);

// ── 4. SDK에 먹이기 ────────────────────────────────────────────
const sseEvents = [
  { type: 'message_start', message: { id: 'msg_fake', type: 'message', role: 'assistant', content: [], model: 'claude-haiku-5-5', usage: { input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  JSON.parse(anthropicEvent('네, 안녕하세요.')),
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } },
  { type: 'message_stop' },
];
const joinBytes = (frames) => {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) out.set(f, (o += f.length) - f.length);
  return out;
};
const streamBody = (bytes, chunk) =>
  new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    },
  });

function clientReturning(bytes, chunk = 7) {
  return new AnthropicBedrock({
    awsRegion: 'ap-northeast-1',
    apiKey: null,
    awsAccessKey: 'AKIDEXAMPLE',
    awsSecretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    maxRetries: 0,
    fetch: async () =>
      new Response(streamBody(bytes, chunk), {
        status: 200,
        headers: { 'content-type': 'application/vnd.amazon.eventstream' },
      }),
  });
}
const params = { model: 'jp.anthropic.claude-haiku-5-5', max_tokens: 64, stream: true, messages: [{ role: 'user', content: '안녕' }] };

const wire = joinBytes(sseEvents.map((e) => chunkFrame(JSON.stringify(e))));
console.log(`\n== 4. 프레임 ${sseEvents.length}개(${wire.length}바이트)를 7바이트 조각으로 잘라 SDK에 먹이면 ==`);
const raw = await clientReturning(wire).messages.create(params).asResponse();
console.log(`SDK가 돌려준 응답의 content-type: ${raw.headers.get('content-type')}`);
const sseText = await raw.text();
console.log(sseText.replace(/^/gm, '  │').trimEnd());
const events = [];
for await (const event of await clientReturning(wire, 5).messages.create(params)) events.push(event.type);
console.log(`같은 바이트를 5바이트 조각으로 → SDK 이벤트: ${events.join(' → ')}`);

// ── 5. 깨진 바이트, exception 프레임 ───────────────────────────
console.log('\n== 5. 프레임이 깨지거나 서버가 오류 프레임을 보내면 ==');
const corrupted = wire.slice();
corrupted[40] ^= 0x01; // 첫 프레임 본문의 비트 하나
try {
  for await (const event of await clientReturning(corrupted).messages.create(params)) void event;
  console.log('깨진 프레임: 오류 없음 (이러면 안 됨)');
} catch (error) {
  console.log(`비트 하나 뒤집기 → ${error.constructor.name}: ${error.message}`);
}
const exceptionFrame = codec.encode({
  headers: {
    ':message-type': { type: 'string', value: 'exception' },
    ':exception-type': { type: 'string', value: 'throttlingException' },
    ':content-type': { type: 'string', value: 'application/json' },
  },
  body: enc.encode(JSON.stringify({ message: 'Too many requests, please wait before trying again.' })),
});
const withException = joinBytes([...sseEvents.slice(0, 2).map((e) => chunkFrame(JSON.stringify(e))), exceptionFrame]);
const exRaw = await clientReturning(withException).messages.create(params).asResponse();
console.log('exception 프레임 → SSE:');
console.log((await exRaw.text()).replace(/^/gm, '  │').trimEnd());
try {
  for await (const event of await clientReturning(withException).messages.create(params)) void event;
} catch (error) {
  console.log(`SDK 이벤트로 읽으면 → ${error.constructor.name} (status ${error.status}): ${error.message.slice(0, 80)}`);
}
