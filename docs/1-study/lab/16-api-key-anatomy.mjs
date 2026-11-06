// 16장 실습: Bedrock 단기 API 키를 가짜 자격 증명으로 직접 만들고, 풀어서 읽고, 서명을 손으로 확인하기
// (학습서 16-3절 "깊이 보기: 단기 API 키 한 개를 풀어 보기").
//  1) aws-bedrock-token-generator-js(src/token.ts)와 같은 순서로 만듦: POST https://bedrock.amazonaws.com/?Action=CallWithBearerToken
//     을 SigV4로 미리 서명(presign, 12시간) → 주소에서 "https://"를 떼고 "&Version=1"을 붙임 → base64 → "bedrock-api-key-" 접두사
//  2) 거꾸로 풀기: 접두사 떼기 → base64 디코드 → 쿼리 칸 하나씩
//  3) 서명을 손으로 다시 계산(쿼리에 실린 서명 방식). 범위의 리전을 바꾸면(시드니 → 도쿄) 서명이 맞지 않음(#2)
//  4) 만드는 동안 네트워크를 한 번도 쓰지 않음 → "만들기는 못 막고 쓰기만 막는다"
//  5) 서명 라이브러리 자체는 7일까지 허용, 12시간 상한은 생성기의 검사
//
// 실행: 레포 루트에서  node docs/1-study/lab/16-api-key-anatomy.mjs
// 기준: Node 24, @anthropic-ai/bedrock-sdk 1.1.1이 가져온 @smithy/signature-v4 3.1.2·@aws-crypto/sha256-js 4.0.0.
//       생성기 소스는 github.com/aws/aws-bedrock-token-generator-js main(마지막 커밋 2025-07-24)의 src/token.ts를 읽고 따라 함.
//       생성기 패키지는 이 레포에 없으므로 같은 부품(SignatureV4.presign)으로 같은 모양을 만듭니다. 2026-11-06 작성.
// 자격 증명은 AWS 문서의 예시 키와 지어낸 세션 토큰입니다. AWS를 부르지 않고 .env.local을 읽지 않습니다.
// 서버가 토큰을 어떻게 검증하는지는 공개돼 있지 않아, 3번의 "서버 쪽 확인"은 SigV4 규칙으로 흉내 낸 것입니다(추정).
import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';

// SDK가 쓰는 서명 부품을 Bedrock SDK 자리에서 빌려 옵니다(pnpm이라 레포 루트에서는 안 보임).
const require = createRequire(import.meta.url);
const fromBedrock = createRequire(require.resolve('@anthropic-ai/bedrock-sdk'));
const { SignatureV4 } = fromBedrock('@smithy/signature-v4');
const { HttpRequest } = fromBedrock('@smithy/protocol-http');
const { Sha256 } = fromBedrock('@aws-crypto/sha256-js');

// 4번 확인용: 이 스크립트가 네트워크를 쓰면 바로 알 수 있게 fetch를 막아 둠
let networkCalls = 0;
globalThis.fetch = async () => {
  networkCalls++;
  throw new Error('이 실습은 네트워크를 쓰지 않아야 합니다');
};

const credentials = {
  accessKeyId: 'ASIAIOSFODNN7EXAMPLE', // 콘솔 로그인 세션(STS 임시 자격 증명)처럼 ASIA로 시작
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken: 'FAKE-SESSION-TOKEN-FROM-CONSOLE-ROLE',
};
const REGION = 'ap-southeast-2'; // 처음 받은 키처럼 시드니(16-1절 #2)
const signingDate = new Date('2026-11-05T04:00:00Z'); // 한국 13:00

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest();
const uriEncode = (s) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
// 생성기가 쓰는 formatUrl(@aws-sdk/util-format-url)은 쿼리 이름을 정렬하고 이름·값을 UriEncode로 적습니다
// (@smithy/querystring-builder의 buildQueryString). 여기서는 같은 규칙을 직접 씁니다.
const formatUrl = ({ protocol, hostname, path, query }) =>
  `${protocol}//${hostname}${path}?${Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&')}`;
const kst = (d) =>
  new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(d);

// ── 1. 만들기 (token.ts의 createToken과 같은 순서) ─────────────
const signer = new SignatureV4({ service: 'bedrock', region: REGION, credentials, sha256: Sha256 });
const request = new HttpRequest({
  method: 'POST',
  protocol: 'https:',
  hostname: 'bedrock.amazonaws.com',
  headers: { host: 'bedrock.amazonaws.com' },
  path: '/',
  query: { Action: 'CallWithBearerToken' },
});
const presigned = await signer.presign(request, { expiresIn: 43200, signingDate });
const presignedUrl = `${formatUrl(presigned).replace('https://', '')}&Version=1`;
const token = `bedrock-api-key-${Buffer.from(presignedUrl, 'utf8').toString('base64')}`;
console.log('== 1. 만든 토큰 ==');
console.log(token.replace(/(.{100})/g, '$1\n'));
console.log(`(길이 ${token.length}자, 네트워크 호출 ${networkCalls}번)`);

// ── 2. 풀기 ────────────────────────────────────────────────────
console.log('\n== 2. 접두사를 떼고 base64를 풀면 ==');
const decoded = Buffer.from(token.slice('bedrock-api-key-'.length), 'base64').toString('utf8');
console.log(decoded.replace(/&/g, '\n  &'));
const url = new URL(`https://${decoded}`);
const q = Object.fromEntries(url.searchParams);
const amz = q['X-Amz-Date'];
const issued = new Date(
  `${amz.slice(0, 4)}-${amz.slice(4, 6)}-${amz.slice(6, 8)}T${amz.slice(9, 11)}:${amz.slice(11, 13)}:${amz.slice(13, 15)}Z`,
);
const expires = new Date(issued.getTime() + Number(q['X-Amz-Expires']) * 1000);
console.log('\n칸별로 읽기:');
console.log(`  호스트·경로        ${url.host}${url.pathname}  (리전이 없는 이름)`);
console.log(`  Action             ${q.Action}  (이 토큰을 쓸 때 정책이 보는 동작 이름과 같음)`);
console.log(`  X-Amz-Credential   ${q['X-Amz-Credential']}`);
console.log(`                     → 키 ID / 날짜 / 리전 ${q['X-Amz-Credential'].split('/')[2]} / 서비스 bedrock / aws4_request`);
console.log(`  X-Amz-Date         ${amz}  (한국 ${kst(issued)})`);
console.log(`  X-Amz-Expires      ${q['X-Amz-Expires']}초 = ${q['X-Amz-Expires'] / 3600}시간 → 만료 한국 ${kst(expires)}`);
console.log(`  X-Amz-Security-Token ${q['X-Amz-Security-Token']}  (세션 토큰이 그대로 실림)`);
console.log(`  X-Amz-SignedHeaders ${q['X-Amz-SignedHeaders']}`);
console.log(`  X-Amz-Signature    ${q['X-Amz-Signature']}`);
console.log(`  Version            ${q.Version}  (서명 뒤에 붙여서 서명 대상이 아님)`);
console.log('  비밀 키는 어디에도 없음. 있는 것은 그 키로 만든 서명뿐');

// ── 3. 서명을 손으로 다시 계산 ─────────────────────────────────
function check(query, endpointRegion) {
  const [keyId, date, region, service] = query['X-Amz-Credential'].split('/');
  const canonicalQuery = Object.keys(query)
    .filter((k) => k !== 'X-Amz-Signature' && k !== 'Version')
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&');
  const canonicalRequest = [
    'POST',
    '/',
    canonicalQuery,
    'host:bedrock.amazonaws.com\n',
    'host',
    sha256hex(''), // 본문 없음 → 빈 문자열의 SHA-256
  ].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', query['X-Amz-Date'], scope, sha256hex(canonicalRequest)].join('\n');
  // 서버는 키 ID로 비밀 키를 찾고, 자기 리전으로 키 사슬을 만든다고 보고 흉내 냄(추정)
  let k = hmac(`AWS4${credentials.secretAccessKey}`, date);
  for (const part of [endpointRegion, service, 'aws4_request']) k = hmac(k, part);
  const recomputed = createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex');
  return { keyId, region, canonicalRequest, stringToSign, ok: recomputed === query['X-Amz-Signature'] };
}
console.log('\n== 3. 서명 확인 ==');
const sydney = check(q, 'ap-southeast-2');
console.log('정규 요청:');
console.log(sydney.canonicalRequest.replace(/^/gm, '  │'));
console.log('서명할 문자열:');
console.log(sydney.stringToSign.replace(/^/gm, '  │'));
console.log(`시드니 창구가 확인하면: ${sydney.ok ? '서명 맞음' : '서명 틀림'}`);
const tokyo = check(q, 'ap-northeast-1');
console.log(
  `도쿄 창구가 자기 리전으로 키 사슬을 만들면: ${tokyo.ok ? '서명 맞음' : '서명 틀림'} (범위의 리전 ${tokyo.region} ≠ ap-northeast-1, #2)`,
);
const forged = { ...q, 'X-Amz-Expires': '604800' };
console.log(`만료를 7일로 고쳐 쓰면: ${check(forged, 'ap-southeast-2').ok ? '서명 맞음' : '서명 틀림'} (만료 칸도 서명 대상)`);

// ── 5. 12시간 상한은 어디서 오나 ───────────────────────────────
console.log('\n== 5. 만료 상한 ==');
try {
  await signer.presign(request, { expiresIn: 8 * 24 * 3600, signingDate });
} catch (error) {
  console.log(`8일로 presign: 서명 라이브러리가 거절 → "${error}"`);
}
const week = await signer.presign(request, { expiresIn: 7 * 24 * 3600, signingDate });
console.log(
  `7일로 presign: 만들어짐(X-Amz-Expires=${week.query['X-Amz-Expires']}). 12시간 상한은 생성기의 validateTokenExpiryInput 검사`,
);
console.log('  (서버가 12시간을 넘는 토큰을 받는지는 공개 자료로 확인하지 못함, 확인 필요)');
console.log(`\n네트워크 호출 합계: ${networkCalls}번 → 토큰은 비밀 키만 있으면 어디서든 만들 수 있음. 정책은 쓰는 순간에만 막음`);
