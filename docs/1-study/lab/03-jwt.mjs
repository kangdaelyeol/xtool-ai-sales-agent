// 3장 실습: LiveKit 접속 토큰(JWT)을 가짜 키로 만들고, 세 부분을 풀고, 서명을 손으로 다시 계산하기
//
// 실행: 레포 루트에서  node docs/1-study/lab/03-jwt.mjs   (pnpm install 뒤)
// 기준: Node 24, livekit-server-sdk 2.19.2(@livekit/agents 1.9.5가 의존하는 판). 2026-11-05 작성.
// 키는 가짜(devkey/secret)이고 고객 정보도 가상입니다. 네트워크를 쓰지 않고 .env.local을 읽지 않습니다.
// 토큰 모양은 originalshq functions-xtool의 createVoiceAgentSession과 같게 만들었습니다.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';

// livekit-server-sdk는 이 레포가 직접 설치하지 않고 @livekit/agents가 의존성으로 가져옵니다.
// 그래서 @livekit/agents가 있는 자리에서 찾습니다(pnpm은 의존성을 그 패키지 옆에 둡니다).
const require = createRequire(import.meta.url);
const fromAgents = createRequire(require.resolve('@livekit/agents'));
const { AccessToken, RoomAgentDispatch, RoomConfiguration, TokenVerifier } =
  fromAgents('livekit-server-sdk');

const API_KEY = 'devkey';
const API_SECRET = 'secret';

// ── 1. 웹 테스트와 같은 모양의 토큰 만들기 ───────────────────
const roomName = 'voice-test-1700000000000-abcd1234';
const call = { callId: roomName, customerName: '홍길동', device: 'F2 울트라', installment: '희망' };
const token = new AccessToken(API_KEY, API_SECRET, { identity: 'tester-0000abcd', ttl: '10m' });
token.addGrant({
  room: roomName,
  roomJoin: true,
  canPublish: true,
  canSubscribe: true,
  canPublishData: true,
});
token.roomConfig = new RoomConfiguration({
  agents: [
    new RoomAgentDispatch({ agentName: 'xtool-sales-agent', metadata: JSON.stringify(call) }),
  ],
});
const jwt = await token.toJwt();
console.log('== 1. 토큰 (점 두 개로 나뉜 세 부분) ==');
console.log(jwt);

// ── 2. 세 부분을 base64url로 풀기: 비밀키 없이 누구나 할 수 있다 ──
const [headerB64, payloadB64, signatureB64] = jwt.split('.');
const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
console.log('\n== 2. header ==');
console.log(header);
console.log('\n== 2. payload ==');
console.log(JSON.stringify(payload, null, 2));
console.log(`유효 시간 exp − nbf = ${payload.exp - payload.nbf}초`);
console.log(
  'metadata 안의 고객 이름:',
  JSON.parse(payload.roomConfig.agents[0].metadata).customerName,
);

// ── 3. 서명을 손으로 다시 계산: HS256 = HMAC-SHA256(비밀키, "header.payload") ──
const recomputed = createHmac('sha256', API_SECRET)
  .update(`${headerB64}.${payloadB64}`)
  .digest('base64url');
console.log('\n== 3. 서명 다시 계산 ==');
console.log('토큰의 서명  :', signatureB64);
console.log('다시 계산한 값:', recomputed);
console.log(
  '일치:',
  timingSafeEqual(Buffer.from(signatureB64, 'base64url'), Buffer.from(recomputed, 'base64url')),
);

// ── 4. payload를 바꿔 치기: 서명이 맞지 않아 거절된다 ──────────
const forged = structuredClone(payload);
forged.roomConfig.agents[0].metadata = JSON.stringify({ ...call, customerName: '임꺽정' });
const forgedB64 = Buffer.from(JSON.stringify(forged)).toString('base64url');
const forgedJwt = `${headerB64}.${forgedB64}.${signatureB64}`; // 서명은 원래 것을 그대로 붙임
const verifier = new TokenVerifier(API_KEY, API_SECRET);
console.log('\n== 4. 검증 ==');
console.log('원래 토큰  :', (await verifier.verify(jwt)).sub, '통과');
try {
  await verifier.verify(forgedJwt);
  console.log('바꾼 토큰  : 통과 (이러면 안 됨)');
} catch (error) {
  console.log('바꾼 토큰  : 거절 →', error.code ?? error.message);
}
try {
  await new TokenVerifier(API_KEY, 'other-secret').verify(jwt);
} catch (error) {
  console.log('다른 비밀키: 거절 →', error.code ?? error.message);
}

// ── 5. 워커가 LiveKit에 등록할 때 쓰는 토큰 (agents의 worker.ts와 같은 호출) ──
const workerToken = new AccessToken(API_KEY, API_SECRET);
workerToken.addGrant({ agent: true });
const workerPayload = JSON.parse(
  Buffer.from((await workerToken.toJwt()).split('.')[1], 'base64url').toString('utf8'),
);
console.log('\n== 5. 워커 토큰 payload ==');
console.log(workerPayload, `유효 ${(workerPayload.exp - workerPayload.nbf) / 3600}시간`);
