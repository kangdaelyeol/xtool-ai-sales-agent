// 12장 실습: 조각을 어떻게 나눠 넣어도 결과가 같은가. 분할 전수 검사와 시드 고정 무작위 분할 (학습서 12-7절 "깊이 보기").
//  1) n글자 입력의 분할은 2^(n-1)가지. 짧은 입력은 전부 넣어 봄 (7글자 = 분할점 6곳 = 64가지)
//  2) pronunciationTransform(src/pronunciation.ts)과, 일부러 flush를 뺀 판을 같은 검사기에 넣기
//  3) 맞장구가 두 개 겹친 긴 입력에 시드 고정 무작위 분할 2,000번 + 전수. 지금의 withoutLeadingAck(src/ack.ts)와
//     고치기 전 방식(처음 12자를 모아 한 번 판단, 17-2 #43. 331c151 앞 src/ack.ts를 이 파일 안에 옮긴 사본)을 나란히
//  4) 실패의 모양: 옛 방식은 첫 판단(12자 이상이 처음 모인 때)이 몇 글자에서 일어났나.
//     지금 방식은 한 글자씩 넣을 때 몇 글자째에 처음 내보내나(판단할 수 있을 때까지만 모음)
//
// 실행 (레포 루트에서):  node docs/1-study/lab/12-split-property.mjs   (약 3초: 19글자 전수 검사 두 번)
// 기준: Node 24, @livekit/agents 1.9.5 (2026-11-06 작성, 같은 날 #43 고침에 맞춰 갱신)
// 키·네트워크·.env.local을 쓰지 않습니다. 같은 시드면 같은 분할이 나옵니다.
import { ReadableStream, TransformStream } from 'node:stream/web';
import { stripLeadingAck, withoutLeadingAck } from '../../../src/ack.ts';
import { pronunciationTransform, toSpoken } from '../../../src/pronunciation.ts';

/** 분할점 비트마스크로 문자열을 조각냅니다. 비트 i가 1이면 i+1번째 글자 뒤에서 자릅니다. */
function splitByMask(text, mask) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (mask & (1 << i)) {
      parts.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** 시드 고정 난수 (mulberry32). 실패를 다시 재현할 수 있게 시드를 남깁니다. */
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomSplit(text, rand) {
  const parts = [];
  let cur = '';
  for (const ch of text) {
    cur += ch;
    if (rand() < 0.3) {
      parts.push(cur);
      cur = '';
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

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

// 검사 대상들: 조각 배열 → 이어 붙인 출력
const viaStream = (transform) => async (parts) => {
  let out = '';
  for await (const x of transform(ReadableStream.from(parts))) out += x;
  return out;
};
const viaGenerator = (gen) => async (parts) => {
  async function* source() {
    yield* parts;
  }
  let out = '';
  for await (const x of gen(source())) out += x;
  return out;
};
// 일부러 flush를 뺀 pronunciationTransform (12-4절에서 말한 "가장 흔한 버그")
function noFlush(text) {
  let pending = '';
  return text.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        pending += chunk;
        const cut = Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\n')) + 1;
        if (cut > 0) {
          controller.enqueue(toSpoken(pending.slice(0, cut)));
          pending = pending.slice(cut);
        }
      },
    }),
  );
}

async function exhaustive(label, run, text, expected) {
  const total = 2 ** (text.length - 1);
  let fails = 0;
  let first;
  for (let mask = 0; mask < total; mask++) {
    const parts = splitByMask(text, mask);
    const got = await run(parts);
    if (got !== expected) {
      fails++;
      first ??= { parts, got };
    }
  }
  console.log(
    `   ${label}: ${text.length}글자, 분할점 ${text.length - 1}곳, ${total.toLocaleString('en-US')}가지 중 실패 ${fails.toLocaleString('en-US')}`,
  );
  if (first)
    console.log(`     첫 실패 ${JSON.stringify(first.parts)} → ${JSON.stringify(first.got)}`);
  return fails;
}

console.log('== 1·2. 전수 검사: 출력.join("") === 전체를 한 번에 변환한 결과 ==');
await exhaustive(
  'withoutLeadingAck  "네, 예산은?"',
  viaGenerator(withoutLeadingAck),
  '네, 예산은?',
  stripLeadingAck('네, 예산은?'),
);
for (const text of ['F2 울트라', 'xTool F2 쓰세요']) {
  await exhaustive(
    `pronunciationTransform "${text}"`,
    viaStream(pronunciationTransform),
    text,
    toSpoken(text),
  );
  await exhaustive(`flush를 뺀 판            "${text}"`, viaStream(noFlush), text, toSpoken(text));
}

console.log('\n== 3. 맞장구 두 개가 겹친 답: 지금 방식과 옛 방식(12자) ==');
const long = '알겠습니다. 감사합니다. 예산은요?';
const expected = stripLeadingAck(long);
console.log(
  `   입력 ${JSON.stringify(long)} (${long.length}글자) → 한 번에 변환 ${JSON.stringify(expected)}`,
);
const exhaustiveFails = {};
for (const [label, gen] of [
  ['지금 방식', withoutLeadingAck],
  ['옛 방식(12자, 사본)', withoutLeadingAckOld],
]) {
  console.log(`   ── ${label}`);
  const seed = 20261106;
  const rand = mulberry32(seed);
  let fails = 0;
  let firstFail;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    const parts = randomSplit(long, rand);
    const got = await viaGenerator(gen)(parts);
    if (got !== expected) {
      fails++;
      firstFail ??= { i, parts, got };
    }
  }
  console.log(
    `   시드 ${seed}, 무작위 분할 ${N.toLocaleString('en-US')}번 중 실패 ${fails.toLocaleString('en-US')}번`,
  );
  if (firstFail) {
    console.log(`     첫 실패 (${firstFail.i + 1}번째) ${JSON.stringify(firstFail.parts)}`);
    console.log(`       → ${JSON.stringify(firstFail.got)}`);
  }
  for (const parts of [
    ['알겠습니다', '. ', '감사합니다', '. ', '예산은요?'], // 단어·구두점 경계에서 자른 모양 (실제 토큰 경계는 재지 않음)
    ['알겠습니다. ', '감사합니다. ', '예산은요?'],
  ]) {
    const got = await viaGenerator(gen)(parts);
    console.log(
      `   ${JSON.stringify(parts)} → ${JSON.stringify(got)} ${got === expected ? '맞음' : '틀림'}`,
    );
  }
  const t0 = performance.now();
  exhaustiveFails[label] = await exhaustive('전수', viaGenerator(gen), long, expected);
  console.log(`     (${Math.round(performance.now() - t0)}ms)`);
}

// ── 4. 실패의 모양 ──────────────────────────────────────────────────
console.log('\n== 4-A. 옛 방식: 첫 판단이 일어난 글자 수별 결과 ==');
// 옛 방식은 누적이 처음 12자 이상이 되는 조각에서 한 번 판단합니다. 그 길이 k만 결과를 가릅니다.
for (let k = 12; k <= long.length; k++) {
  const held = long.slice(0, k);
  const got = stripLeadingAck(held) + long.slice(k);
  console.log(
    `   k=${String(k).padStart(2)} 보류 ${JSON.stringify(held).padEnd(20)} → ${got === expected ? '맞음' : `틀림 ${JSON.stringify(got)}`}`,
  );
}
const oldFails = exhaustiveFails['옛 방식(12자, 사본)'];
console.log(
  `   전수 실패 ${oldFails.toLocaleString('en-US')} / ${(2 ** (long.length - 1)).toLocaleString('en-US')} = ${(oldFails / 2 ** (long.length - 1)).toFixed(3)} (= 1 − 1/8: 12·13·14번째 글자 뒤 중 한 곳이라도 잘리면 실패)`,
);

// 실측에서 나온 겹친 맞장구(ack.test.ts "네, 감사합니다. 도입은…")는 10자라 12자 보류 안에 다 들어옴
const seen = '네, 감사합니다. 도입은 언제쯤이세요?';
const seenExpected = stripLeadingAck(seen);
const wrongK = [];
for (let k = 12; k <= seen.length; k++) {
  if (stripLeadingAck(seen.slice(0, k)) + seen.slice(k) !== seenExpected) wrongK.push(k);
}
console.log(
  `   ${JSON.stringify(seen)} (${seen.length}글자): k=12~${seen.length} 중 틀리는 k ${wrongK.length ? wrongK.join(', ') : '없음'} → 어떤 분할이든 ${JSON.stringify(seenExpected)}`,
);

console.log('\n== 4-B. 지금 방식: 한 글자씩 넣을 때 처음 내보내는 글자 수 ==');
// 지금 방식은 "맞장구를 두 개까지 떼고 남은 글이 비어 있지 않고, 그 글이 맞장구 말의 앞부분일 수 없을 때" 내보냅니다.
// 판단이 서는 첫 글자에서 바로 내보내므로, 보류 길이는 입력마다 다릅니다.
for (const text of [
  long,
  seen,
  '네, 예산은?',
  '예산은요?',
  '네일 아트용인가요?',
  '아니요, 괜찮아요.',
  '가죽 소품이요.',
  '네, 감사합니다.',
]) {
  let pulled = 0;
  let firstAt;
  let first;
  async function* source() {
    for (const ch of text) {
      pulled++;
      yield ch;
    }
  }
  let out = '';
  for await (const x of withoutLeadingAck(source())) {
    if (firstAt === undefined) {
      firstAt = pulled;
      first = x;
    }
    out += x;
  }
  const at =
    firstAt === text.length && first === out
      ? `끝까지 판단 못 함 → 스트림 끝에 ${JSON.stringify(first)}`
      : `${firstAt}글자째 ${JSON.stringify(text.slice(0, firstAt))} → ${JSON.stringify(first)}`;
  console.log(`   ${JSON.stringify(text).padEnd(26)} ${at}`);
}
