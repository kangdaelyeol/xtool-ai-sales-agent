// 16장 실습: Bedrock 요청 하나의 SigV4 서명을 실제 문자열로 보고, node:crypto로 손으로 다시 계산하기
// (학습서 16-3절 "깊이 보기: SigV4 서명을 손으로 다시 계산하기").
//  1) 운영과 같은 createBedrockClient()로 요청을 만들되 fetch를 가로채 머리글·본문을 받음(src/models/index.test.ts 방식)
//  2) 서버가 하듯 Authorization에서 범위·서명할 머리글 목록을 읽고 정규 요청 → 서명할 문자열 → 키 사슬 → 서명을
//     직접 계산해 SDK의 서명과 비교. 중간값(kDate·kRegion·kService·kSigning)을 hex로 찍음
//  3) 무엇이 서명에 묶이나: 본문 한 글자, x-stainless-retry-count를 바꾸면 틀어지고, user-agent는 바꿔도 맞음
//  4) 재시도마다 다시 서명: SDK 재시도(500 → 400)의 두 요청 비교
//  5) 콜론이 든 모델 ID: 선로의 경로와 정규 요청의 경로(한 번 더 인코딩)가 다름. 경로를 그대로 쓰는 서명자와 비교
//  6) 범위 날짜는 UTC: 한국 시각 오전 9시 전에는 "어제"
//
// 실행: 레포 루트에서  node docs/1-study/lab/16-sigv4.mjs   (1초 안쪽. --now를 붙이면 지금 시각으로 서명)
// 기준: Node 24, @anthropic-ai/bedrock-sdk 1.1.1(@anthropic-ai/sdk 1.4.0, @smithy/signature-v4 3.1.2). 2026-11-06 작성.
// 키는 AWS SigV4 문서·테스트 모음의 예시 키(AKIDEXAMPLE)이고, 요청은 AWS로 나가지 않습니다(fetch를 가로챔).
// .env.local을 읽지 않고, 이 프로세스의 AWS_* 환경변수를 모두 지운 뒤 가짜 값만 넣습니다.
// 시각은 기본으로 2026-11-05T23:30:00Z(한국 11-06 08:30)에 고정해, 돌릴 때마다 같은 중간값이 나오게 합니다.
// x-stainless-os·arch·runtime-version 머리글은 기계마다 달라서 마지막 서명 값은 기계마다 다릅니다(일치 여부는 같음).
import { createHash, createHmac } from 'node:crypto';

// ── 0. 준비: 가짜 키와 고정 시각 ─────────────────────────────
for (const name of Object.keys(process.env)) if (name.startsWith('AWS_')) delete process.env[name];
const ACCESS_KEY_ID = 'AKIDEXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
process.env.AWS_ACCESS_KEY_ID = ACCESS_KEY_ID; // 운영처럼 환경변수로 넘김(체인의 fromEnv가 읽음, 16-4절)
process.env.AWS_SECRET_ACCESS_KEY = SECRET;
process.env.AWS_REGION = 'ap-northeast-1';
process.env.AWS_BEARER_TOKEN_BEDROCK = 'leftover-api-key'; // 남은 API 키(#26). apiKey: null이 무시하게 함
process.env.AWS_CONFIG_FILE = '/nonexistent/aws-config'; // 혹시 체인이 파일까지 가도 실제 ~/.aws를 읽지 않게
process.env.AWS_SHARED_CREDENTIALS_FILE = '/nonexistent/aws-credentials';
process.env.AWS_EC2_METADATA_DISABLED = 'true';

const FIXED = Date.UTC(2026, 10, 5, 23, 30, 0);
if (!process.argv.includes('--now')) {
  const RealDate = Date;
  globalThis.Date = class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(FIXED);
      else super(...args);
    }
    static now() {
      return FIXED;
    }
  };
}

const { createBedrockClient } = await import('../../../src/models/index.ts');

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
// AWS UriEncode: A-Z a-z 0-9 - . _ ~ 만 두고 모두 %XX(대문자). encodeURIComponent는 ! ' ( ) * 를 남기므로 따로 바꿈
const uriEncode = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const kst = (d) =>
  new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(d);
const show = (title, text) =>
  console.log(
    `${title}\n${text
      .split('\n')
      .map((line, i) => `  ${String(i + 1).padStart(2)} │${line}`)
      .join('\n')}`,
  );

// ── 1. 요청을 만들고 가로채기 ──────────────────────────────────
const captured = [];
let replies = [];
const client = createBedrockClient().withOptions({
  maxRetries: 1, // 운영은 0(재시도는 LiveKit이 함). 4번을 보려고 SDK 재시도를 한 번 켬
  fetch: async (input, init) => {
    const req = new Request(input, init);
    captured.push({
      method: req.method,
      url: req.url,
      headers: Object.fromEntries(req.headers),
      body: await req.text(),
    });
    const reply = replies.shift() ?? { status: 400 };
    return new Response('{"message":"fake"}', {
      status: reply.status,
      headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
    });
  },
});
console.log(`client.apiKey = ${client.apiKey} (남은 AWS_BEARER_TOKEN_BEDROCK을 쓰지 않음)`);

async function send(model, firstReplies) {
  captured.length = 0;
  replies = firstReplies;
  await client.messages
    .create(
      {
        model,
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: '안녕하세요' }],
      },
      { timeout: 10_000 }, // 플러그인이 넘기는 시간 제한(connOptions.timeoutMs)과 같게
    )
    .catch(() => {});
  return captured.slice();
}

// 첫 시도는 500(바로 다시 보내라는 retry-after-ms: 0), 두 번째는 400
const [first, second] = await send('jp.anthropic.claude-haiku-5-5', [
  { status: 500, headers: { 'retry-after-ms': '0' } },
  { status: 400 },
]);

console.log('\n== 1. 선로에 나간 요청 (첫 시도) ==');
console.log(`${first.method} ${first.url}`);
for (const [name, value] of Object.entries(first.headers)) {
  const shown = name === 'authorization' ? value.replace(/, /g, ',\n               ') : value;
  console.log(`${name}: ${shown}`);
}
console.log(`(본문 ${Buffer.byteLength(first.body)}바이트) ${first.body}`);

// ── 2. 서버가 하는 검증을 손으로 ───────────────────────────────
function verify(req, secret = SECRET) {
  const auth = req.headers.authorization;
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      auth,
    );
  if (!m) throw new Error(`Authorization 모양이 다름: ${auth}`);
  const [, keyId, date, region, service, signedHeaders, signature] = m;
  const url = new URL(req.url);
  // 경로: 선로의 경로 조각마다 UriEncode를 한 번 더(S3가 아닌 서비스의 규칙, @smithy/signature-v4 getCanonicalPath)
  const canonicalPath = url.pathname.split('/').map(uriEncode).join('/');
  const canonicalQuery = [...url.searchParams]
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .sort()
    .join('&');
  // 머리글: 서명 목록에 있는 것만, 이름은 소문자, 값은 앞뒤 공백 제거·연속 공백 하나로
  const names = signedHeaders.split(';');
  const canonicalHeaders = names
    .map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const payloadHash = sha256hex(req.body);
  const canonicalRequest = [
    req.method,
    canonicalPath,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    req.headers['x-amz-date'],
    scope,
    sha256hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const recomputed = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return {
    keyId,
    date,
    region,
    service,
    names,
    canonicalPath,
    canonicalRequest,
    stringToSign,
    keys: { kDate, kRegion, kService, kSigning },
    signature,
    recomputed,
    payloadHash,
  };
}

const v = verify(first);
console.log('\n== 2. 손으로 다시 계산 ==');
show('정규 요청 (canonical request):', v.canonicalRequest);
console.log(
  `  (2번 줄 경로, 3번 줄 빈 쿼리, 4~${3 + v.names.length}번 줄 머리글 ${v.names.length}개, 그다음 빈 줄, 서명할 머리글 목록, 본문 해시)`,
);
console.log(`본문 SHA-256 = ${v.payloadHash}`);
console.log(`x-amz-content-sha256 머리글과 같나: ${v.payloadHash === first.headers['x-amz-content-sha256']}`);
show('\n서명할 문자열 (string to sign):', v.stringToSign);
console.log('\n키 사슬 (HMAC-SHA256을 네 번, 앞 결과가 다음 키):');
console.log(`  kDate    = HMAC("AWS4" + 비밀 키, "${v.date}")     = ${v.keys.kDate.toString('hex')}`);
console.log(`  kRegion  = HMAC(kDate, "${v.region}")          = ${v.keys.kRegion.toString('hex')}`);
console.log(`  kService = HMAC(kRegion, "${v.service}")              = ${v.keys.kService.toString('hex')}`);
console.log(`  kSigning = HMAC(kService, "aws4_request")       = ${v.keys.kSigning.toString('hex')}`);
console.log(`\nSDK의 서명     : ${v.signature}`);
console.log(`다시 계산한 값 : ${v.recomputed}`);
console.log(`일치: ${v.signature === v.recomputed}`);

console.log('\n관찰:');
console.log(`- 선로의 머리글 ${Object.keys(first.headers).length}개 중 서명된 것 ${v.names.length}개: ${v.names.join(';')}`);
const unsigned = Object.keys(first.headers).filter((n) => !v.names.includes(n));
console.log(`- 서명에서 빠진 머리글: ${unsigned.join(', ')} (authorization은 서명 자신, user-agent는 SDK가 늘 뺌)`);
console.log(
  `- 호스트는 ${new URL(first.url).host}인데 범위의 서비스 이름은 "${v.service}" (auth.js가 service: 'bedrock'으로 서명)`,
);

// ── 3. 무엇이 서명에 묶이나 ────────────────────────────────────
console.log('\n== 3. 한 곳씩 바꿔서 다시 검증 ==');
const tamper = (label, change) => {
  const req = structuredClone(first);
  change(req);
  const r = verify(req);
  console.log(`${label.padEnd(36)} → ${r.recomputed === r.signature ? '서명 맞음 (통과)' : '서명 틀림 (거절)'}`);
};
tamper('본문 "안녕하세요" → "안녕하세여"', (r) => (r.body = r.body.replace('안녕하세요', '안녕하세여')));
tamper('x-stainless-retry-count 0 → 1', (r) => (r.headers['x-stainless-retry-count'] = '1'));
tamper('x-amz-date를 1초 뒤로', (r) => (r.headers['x-amz-date'] = r.headers['x-amz-date'].replace(/00Z$/, '01Z')));
tamper('user-agent를 "curl/8.7.1"로', (r) => (r.headers['user-agent'] = 'curl/8.7.1'));
{
  const r = verify(first, 'wrong-secret');
  console.log(`${'서버가 가진 비밀 키가 다르면'.padEnd(36)} → ${r.recomputed === r.signature ? '서명 맞음' : '서명 틀림 (거절)'}`);
}

// ── 4. 재시도마다 다시 서명 ────────────────────────────────────
console.log('\n== 4. SDK 재시도: 같은 요청을 두 번 보냈을 때 ==');
const v2 = verify(second);
for (const [label, req, r] of [
  ['첫 시도', first, v],
  ['재시도', second, v2],
]) {
  console.log(
    `${label}: x-amz-date ${req.headers['x-amz-date']}, retry-count ${req.headers['x-stainless-retry-count']}, 서명 ${r.signature.slice(0, 16)}…, 다시 계산과 일치 ${r.signature === r.recomputed}`,
  );
}
console.log('→ 시각이 같아도 retry-count가 서명된 머리글이라 재시도는 새 서명. 받은 서명을 그대로 다시 쓰는 일은 없음');

// ── 5. 콜론이 든 모델 ID ───────────────────────────────────────
console.log('\n== 5. 경로 인코딩: 콜론이 든 모델 ID ==');
const [colon] = await send('jp.anthropic.claude-haiku-4-5-20251001-v1:0', [{ status: 400 }]);
const vc = verify(colon);
const wirePath = new URL(colon.url).pathname;
console.log(`선로의 경로      : ${wirePath}   (SDK의 path 태그는 RFC 3986 pchar인 ':'를 그대로 둠)`);
console.log(`정규 요청의 경로 : ${vc.canonicalPath}   (조각마다 한 번 더 UriEncode)`);
console.log(`SDK 서명과 일치  : ${vc.signature === vc.recomputed}`);
// 경로를 받은 그대로 정규 요청에 넣는 서명자(curl 8.7.1 --aws-sigv4로 실측한 방식)가 만들었다면
const rawCanonical = vc.canonicalRequest.replace(vc.canonicalPath, wirePath);
console.log(
  `경로를 그대로 쓰면: 정규 요청 해시 ${sha256hex(rawCanonical).slice(0, 16)}… ≠ ${sha256hex(vc.canonicalRequest).slice(0, 16)}… → 서버와 다른 서명`,
);
console.log(
  `미리 %3A로 바꿔 보내면: 선로 v1%3A0 → 서버의 정규 경로 ${uriEncode('v1%3A0')} (curl은 v1%3A0 그대로 서명 → 또 불일치)`,
);

// ── 6. 범위 날짜는 UTC ─────────────────────────────────────────
console.log('\n== 6. 범위 날짜 = x-amz-date의 UTC 날짜 ==');
const amzDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
for (const iso of ['2026-11-05T23:30:00Z', '2026-11-05T23:59:59Z', '2026-11-06T00:00:00Z']) {
  const d = new Date(iso);
  console.log(`한국 ${kst(d).padEnd(24)} → x-amz-date ${amzDate(d)}, 범위 날짜 ${amzDate(d).slice(0, 8)}`);
}
console.log('→ 서버는 범위 날짜와 x-amz-date 날짜가 다르거나, 요청 시각이 서버 시각과 약 5분 넘게 어긋나면 거절(AWS 문서)');
