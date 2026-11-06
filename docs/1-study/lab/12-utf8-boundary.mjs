// 12장 실습: 바이트 층의 조각 경계 — UTF-8 한글이 청크 사이에서 끊기면 (학습서 12-5절 "깊이 보기: 바이트 층").
//  1) '네'의 UTF-8 바이트와, 바이트 사이에서 자른 두 조각을 따로 디코드하면 나오는 것
//  2) 한글 문장을 모든 바이트 위치에서 둘로 잘라 디코드: 조각마다 toString / TextDecoder {stream: true} /
//     Buffer.concat 뒤 한 번 / StringDecoder 를 비교해 U+FFFD(�) 개수를 셈
//  3) 로컬 HTTP 서버에서 본문을 글자 중간에서 끊어 보내면: `raw += chunk`(src/models/anthropic.test.ts와 같은 모양)
//     vs req.setEncoding('utf8') vs Buffer.concat
//  4) SSE: 구분자(\n\n)까지 바이트로 모은 뒤 디코드하는 @anthropic-ai/sdk 0.33.1의 방식은 어디서 잘라도 안전.
//     같은 함수의 구분자 검사 off-by-one(i < length - 2)도 같이 (17-2 #36)
//  5) JS 문자열 길이(UTF-16 코드 단위)와 서로게이트 쌍
//
// 실행 (레포 루트에서):  node docs/1-study/lab/12-utf8-boundary.mjs   (1초 안쪽)
// 기준: Node 24 (2026-11-06 작성)
// 키·.env.local·외부 네트워크를 쓰지 않습니다. 3번은 127.0.0.1에 잠깐 서버를 띄웁니다.
// 4번의 findDoubleNewlineIndex는 SDK가 내보내지 않는 함수라 node_modules/.pnpm/@anthropic-ai+sdk@0.33.1/
// node_modules/@anthropic-ai/sdk/src/streaming.ts 263~291의 코드를 그대로 옮겼습니다.
import { createServer, request } from 'node:http';
import { StringDecoder } from 'node:string_decoder';

const hex = (u8) => [...u8].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const fffd = (s) => [...s].filter((c) => c === '�').length;

// ── 1. '네' ─────────────────────────────────────────────────────────
console.log('== 1. "네"의 UTF-8 ==');
const ne = Buffer.from('네');
console.log(
  `   "네" = U+${'네'.codePointAt(0).toString(16).toUpperCase()} → ${ne.length}바이트 ${hex(ne)}`,
);
console.log(
  `   비트: ${[...ne].map((b) => b.toString(2).padStart(8, '0')).join(' ')}  (1110xxxx 10xxxxxx 10xxxxxx)`,
);
for (const cut of [1, 2]) {
  const a = ne.subarray(0, cut);
  const b = ne.subarray(cut);
  console.log(
    `   ${cut}바이트 뒤에서 자름: [${hex(a)}] + [${hex(b)}] → 따로 디코드 ${JSON.stringify(a.toString() + b.toString())}`,
  );
}

// ── 2. 모든 위치에서 자르기 ────────────────────────────────────────────
console.log('\n== 2. "네, 예산은요?"를 모든 바이트 위치에서 둘로 자름 ==');
const text = '네, 예산은요?';
const bytes = Buffer.from(text);
console.log(
  `   ${text.length}글자(UTF-16 코드 단위) = ${bytes.length}바이트, 자를 곳 ${bytes.length - 1}군데`,
);
const ways = {
  '조각마다 Buffer.toString()': (parts) => parts.map((p) => p.toString()).join(''),
  'TextDecoder, stream 옵션 없음': (parts) => {
    const d = new TextDecoder();
    return parts.map((p) => d.decode(p)).join('');
  },
  'TextDecoder, {stream: true}': (parts) => {
    const d = new TextDecoder();
    return parts.map((p) => d.decode(p, { stream: true })).join('') + d.decode();
  },
  'StringDecoder (setEncoding이 쓰는 것)': (parts) => {
    const d = new StringDecoder('utf8');
    return parts.map((p) => d.write(p)).join('') + d.end();
  },
  'Buffer.concat 뒤 한 번': (parts) => Buffer.concat(parts).toString(),
};
for (const [label, decode] of Object.entries(ways)) {
  let broken = 0;
  let marks = 0;
  for (let cut = 1; cut < bytes.length; cut++) {
    const out = decode([bytes.subarray(0, cut), bytes.subarray(cut)]);
    if (out !== text) broken++;
    marks += fffd(out);
  }
  console.log(`   ${label}: 깨짐 ${broken}/${bytes.length - 1}, U+FFFD 합계 ${marks}`);
}
// "네, "(5바이트) 뒤 "예"(EC 98 88)의 첫 바이트까지 = 6바이트에서 자름
const d = new TextDecoder();
const first = d.decode(bytes.subarray(0, 6), { stream: true });
const second = d.decode(bytes.subarray(6), { stream: true });
const last = d.decode();
console.log(
  `   예: 6바이트 뒤 자름 [${hex(bytes.subarray(0, 6))}] + [${hex(bytes.subarray(6, 8))} …]` +
    ` → {stream: true}의 첫 decode ${JSON.stringify(first)}, 둘째 ${JSON.stringify(second)}, 마지막 decode() ${JSON.stringify(last)}`,
);
console.log('      (첫 호출이 못 끝낸 EC를 안에 남겨 두었다가 둘째 호출 앞에 붙임)');

// ── 3. HTTP 본문 ────────────────────────────────────────────────────
console.log('\n== 3. 로컬 HTTP 서버: 본문을 "네"의 1바이트 뒤에서 끊어 두 번에 보냄 ==');
const body = Buffer.from(JSON.stringify({ content: '네, 괜찮아요.' }));
const cutAt = body.indexOf(ne) + 1;
const results = {};
const server = createServer((req, res) => {
  const mode = req.url.slice(1);
  if (mode === 'setEncoding') req.setEncoding('utf8');
  let raw = '';
  const chunks = [];
  let events = 0;
  req.on('data', (chunk) => {
    events++;
    if (mode === 'concat') chunks.push(chunk);
    else raw += chunk; // Buffer를 문자열에 더하면 그 조각만 toString()
  });
  req.on('end', () => {
    const got = mode === 'concat' ? Buffer.concat(chunks).toString() : raw;
    results[mode] = { events, got };
    res.end();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();
for (const mode of ['plus', 'setEncoding', 'concat']) {
  await new Promise((resolve) => {
    const req = request({ port, host: '127.0.0.1', path: `/${mode}`, method: 'POST' }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.write(body.subarray(0, cutAt));
    setTimeout(() => req.end(body.subarray(cutAt)), 30); // 30ms 뒤 나머지
  });
}
server.close();
for (const [mode, label] of [
  ['plus', 'raw += chunk'],
  ['setEncoding', "req.setEncoding('utf8')"],
  ['concat', 'Buffer.concat 뒤 한 번'],
]) {
  const { events, got } = results[mode];
  console.log(`   ${label}: data 이벤트 ${events}번 → ${got}  (JSON.parse ${tryParse(got)})`);
}
function tryParse(s) {
  try {
    return `→ content ${JSON.stringify(JSON.parse(s).content)}`;
  } catch (e) {
    return `실패: ${e.message}`;
  }
}

// ── 4. SSE: 구분자까지 모으기 ──────────────────────────────────────────
console.log('\n== 4. SSE 이벤트를 구분자(\\n\\n)까지 바이트로 모은 뒤 디코드 (SDK 0.33.1 방식) ==');
// streaming.ts 263~291 그대로 (bug 포함)
function findDoubleNewlineIndex(buffer) {
  const newline = 0x0a;
  const carriage = 0x0d;
  for (let i = 0; i < buffer.length - 2; i++) {
    if (buffer[i] === newline && buffer[i + 1] === newline) return i + 2;
    if (buffer[i] === carriage && buffer[i + 1] === carriage) return i + 2;
    if (
      buffer[i] === carriage &&
      buffer[i + 1] === newline &&
      i + 3 < buffer.length &&
      buffer[i + 2] === carriage &&
      buffer[i + 3] === newline
    ) {
      return i + 4;
    }
  }
  return -1;
}
// iterSSEChunks(streaming.ts 233~261)와 같은 일: 바이트를 이어 붙이고 구분자마다 잘라 냄. 디코드는 그 뒤에
function* iterSSEChunks(parts, find) {
  let data = new Uint8Array();
  for (const chunk of parts) {
    const next = new Uint8Array(data.length + chunk.length);
    next.set(data);
    next.set(chunk, data.length);
    data = next;
    let idx;
    while ((idx = find(data)) !== -1) {
      yield { at: 'mid', bytes: data.slice(0, idx) };
      data = data.slice(idx);
    }
  }
  if (data.length > 0) yield { at: 'end', bytes: data };
}
const events = ['네, ', '예산은요?'].map(
  (t) =>
    `event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: 'text_delta', text: t } })}\n\n`,
);
const sseBytes = Buffer.from(events.join(''));
let bad = 0;
for (let cut = 1; cut < sseBytes.length; cut++) {
  const parts = [sseBytes.subarray(0, cut), sseBytes.subarray(cut)];
  const decoded = [...iterSSEChunks(parts, findDoubleNewlineIndex)].map((e) =>
    Buffer.from(e.bytes).toString(),
  );
  if (decoded.join('') !== events.join('') || decoded.some((s) => s.includes('�'))) bad++;
}
console.log(
  `   ${sseBytes.length}바이트를 ${sseBytes.length - 1}군데에서 둘로 잘라 넣음 → 깨진 경우 ${bad}번 (구분자 \\n은 ASCII라 글자 중간에 올 수 없음)`,
);
// off-by-one: 받은 조각이 정확히 이벤트 끝(\n\n)에서 끝나면
const one = Buffer.from(events[0]);
const fixed = (buf) => {
  for (let i = 0; i < buf.length - 1; i++) if (buf[i] === 0x0a && buf[i + 1] === 0x0a) return i + 2;
  return -1;
};
const seen = (find) =>
  [...iterSSEChunks([one], find)]
    .map((e) => (e.at === 'mid' ? '바로 냄' : '다음 바이트가 올 때까지(여기서는 스트림 끝) 붙잡음'))
    .join(', ');
console.log('   이벤트 하나가 \\n\\n로 정확히 끝나는 조각 하나를 넣으면');
console.log(`     0.33.1 검사(i < length - 2): ${seen(findDoubleNewlineIndex)}`);
console.log(`     고친 검사(i < length - 1):   ${seen(fixed)}`);

// ── 5. UTF-16 ───────────────────────────────────────────────────────
console.log('\n== 5. JS 문자열 길이는 UTF-16 코드 단위 ==');
for (const s of ['네', 'F2', '😀', '네😀']) {
  console.log(
    `   ${JSON.stringify(s).padEnd(6)} length ${s.length}, 코드 포인트 ${[...s].length}개, UTF-8 ${Buffer.byteLength(s)}바이트`,
  );
}
const smile = '😀';
const half = smile.slice(0, 1);
console.log(
  `   "😀".slice(0, 1) = \\u${half.charCodeAt(0).toString(16).toUpperCase()} (홀로 남은 서로게이트) → UTF-8로 바꾸면 ${hex(Buffer.from(half))} = U+FFFD`,
);
