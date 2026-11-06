// 3장 실습: SIP 다이제스트 인증(401/407) 응답값 계산, INVITE 재전송 시각(Timer A·B), DTMF 패킷
//
// 실행: 레포 루트에서  node docs/1-study/lab/03-sip-digest.mjs
// 기준: Node 24, 외부 패키지 없음. RFC 3261(SIP, 타이머), RFC 2617(다이제스트 계산식),
//       RFC 4733(telephone-event). 2026-11-05 작성.
// 네트워크를 쓰지 않습니다. 번호·도메인·비밀번호는 모두 가상 값입니다.
import { createHash } from 'node:crypto';

const md5 = (s) => createHash('md5').update(s).digest('hex');

// ── 1. 다이제스트 응답값 ──────────────────────────────────────
// HA1 = MD5(사용자:realm:비밀번호), HA2 = MD5(메서드:요청 URI)
// qop=auth이면 response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
function digestResponse({ username, realm, password, method, uri, nonce, nc, cnonce, qop }) {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  return md5([ha1, nonce, nc, cnonce, qop, ha2].join(':'));
}

// 먼저 RFC 2617에 실린 HTTP 예로 계산식이 맞는지 확인한다
const rfcExample = digestResponse({
  username: 'Mufasa',
  realm: 'testrealm@host.com',
  password: 'Circle Of Life',
  method: 'GET',
  uri: '/dir/index.html',
  nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
  nc: '00000001',
  cnonce: '0a4f113b',
  qop: 'auth',
});
console.log('== 1. RFC 2617 예 ==');
console.log(
  rfcExample,
  rfcExample === '6629fae49393a05397450978507c4ef1' ? '(RFC의 값과 같음)' : '(다름!)',
);

// 같은 식을 SIP INVITE에 쓴다: 통신사 SBC가 407과 함께 realm·nonce를 줬다고 하자
const challenge = { realm: 'sbc.example.com', nonce: '5f2c9e0a1b3d4c6e', qop: 'auth' };
const invite = {
  username: '07000000000',
  password: 'not-a-real-password',
  method: 'INVITE',
  uri: 'sip:01000000000@sbc.example.com',
  nc: '00000001',
  cnonce: '8d1f0c2b',
};
const response = digestResponse({ ...challenge, ...invite });
console.log('\n== 1. 두 번째 INVITE에 붙일 헤더 ==');
console.log(
  `Proxy-Authorization: Digest username="${invite.username}", realm="${challenge.realm}", ` +
    `nonce="${challenge.nonce}", uri="${invite.uri}", response="${response}", ` +
    `algorithm=MD5, qop=auth, nc=${invite.nc}, cnonce="${invite.cnonce}"`,
);

// ── 2. UDP에서 INVITE 재전송 시각: Timer A는 T1에서 시작해 두 배씩, Timer B = 64·T1 ──
const T1 = 0.5; // 초
const timerB = 64 * T1;
const sends = [];
for (let t = 0, interval = T1; t < timerB; t += interval, interval *= 2) sends.push(t);
console.log('\n== 2. 응답이 하나도 없을 때 INVITE를 보내는 시각(초) ==');
console.log(sends.join(', '), `→ ${sends.length}번 보내고 ${timerB}초에 Timer B 만료`);

// ── 3. DTMF "5"를 누름: telephone-event 페이로드 4바이트 ────────
// event(8비트) | E(1) R(1) volume(6) | duration(16, 8kHz 틱)
function dtmfPayload({ event, end, volume, duration }) {
  const p = Buffer.alloc(4);
  p[0] = event;
  p[1] = (end ? 0x80 : 0) | (volume & 0x3f);
  p.writeUInt16BE(duration, 2);
  return p;
}
const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
console.log('\n== 3. DTMF "5" (같은 RTP 타임스탬프로 여러 번 보냄, 마지막 패킷은 E=1로 세 번) ==');
for (const [label, duration, end] of [
  ['시작 (M=1)', 160, false],
  ['진행', 320, false],
  ['끝', 800, true],
]) {
  const p = dtmfPayload({ event: 5, end, volume: 10, duration });
  console.log(
    `${label.padEnd(9)} ${hex(p)}  duration ${duration}틱 = ${(duration / 8).toFixed(0)}ms`,
  );
}
