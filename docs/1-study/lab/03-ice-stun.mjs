// 3장 실습: ICE 후보 우선순위 손 계산, STUN 메시지와 XOR-MAPPED-ADDRESS 인코딩·디코딩
//
// 실행: 레포 루트에서  node docs/1-study/lab/03-ice-stun.mjs
// 기준: Node 24, 외부 패키지 없음. RFC 8445(ICE 우선순위 식), RFC 8489(STUN),
//       RFC 7983(한 포트에서 STUN·DTLS·RTP 가르기). 2026-11-05 작성.
// STUN 서버에 실제 요청을 보내지 않습니다. 주소는 문서용 범위(203.0.113.0/24)의 가상 값입니다.

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');

// ── 1. 후보 우선순위 ─────────────────────────────────────────
// priority = 2^24·(type preference) + 2^8·(local preference) + (256 − component ID)
const TYPE_PREF = { host: 126, prflx: 110, srflx: 100, relay: 0 }; // RFC 8445 권장값
const priority = (type, localPref = 65535, component = 1) =>
  2 ** 24 * TYPE_PREF[type] + 2 ** 8 * localPref + (256 - component);

console.log('== 1. 후보 우선순위 (local preference 65535, component 1 = RTP) ==');
for (const type of ['host', 'srflx', 'relay']) {
  console.log(`${type.padEnd(5)} ${priority(type)}`);
}

// 거꾸로 풀기: 32비트 값을 8·16·8비트로 쪼갠다
const decode = (p) => ({
  typePref: p >>> 24,
  localPref: (p >>> 8) & 0xffff,
  component: 256 - (p & 0xff),
});
console.log('2122260223 풀기:', decode(2122260223));

// 후보 쌍 우선순위: 2^32·MIN(G,D) + 2·MAX(G,D) + (G>D ? 1 : 0). 64비트라 BigInt가 필요하다.
const G = BigInt(priority('host')); // 제어 쪽(controlling) 후보
const D = BigInt(priority('srflx')); // 피제어 쪽(controlled) 후보
const min = G < D ? G : D;
const max = G > D ? G : D;
const pair = (1n << 32n) * min + 2n * max + (G > D ? 1n : 0n);
const pairAsNumber = 2 ** 32 * Number(min) + 2 * Number(max) + 1;
console.log(`쌍 우선순위(BigInt) ${pair}`);
console.log(`쌍 우선순위(Number) ${BigInt(pairAsNumber)}  ← 2^53을 넘어 끝자리가 틀어짐`);

// ── 2. STUN Binding 요청: 20바이트 헤더 ────────────────────────
const MAGIC_COOKIE = 0x2112a442;
const transactionId = Buffer.from('000102030405060708090a0b', 'hex'); // 96비트 (예시라 고정값)

function stunHeader(type, bodyLength) {
  const h = Buffer.alloc(20);
  h.writeUInt16BE(type, 0); // 맨 앞 2비트는 항상 0
  h.writeUInt16BE(bodyLength, 2); // 헤더 20바이트를 뺀 길이
  h.writeUInt32BE(MAGIC_COOKIE, 4);
  transactionId.copy(h, 8);
  return h;
}

console.log('\n== 2. STUN Binding 요청 (type 0x0001, 속성 없음) ==');
const request = stunHeader(0x0001, 0);
console.log(hex(request));

// ── 3. Binding 성공 응답 + XOR-MAPPED-ADDRESS ──────────────────
const mapped = { ip: '203.0.113.7', port: 54321 }; // "바깥에서 본 내 주소" (가상)
const ipToInt = (ip) => ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
const intToIp = (n) => [24, 16, 8, 0].map((shift) => (n >>> shift) & 0xff).join('.');

function xorMappedAddress({ ip, port }) {
  const attr = Buffer.alloc(12);
  attr.writeUInt16BE(0x0020, 0); // 속성 type: XOR-MAPPED-ADDRESS
  attr.writeUInt16BE(8, 2); // 값 길이
  attr[4] = 0x00; // 예약
  attr[5] = 0x01; // 주소 family: IPv4
  attr.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 6); // X-Port = port XOR 0x2112
  attr.writeUInt32BE((ipToInt(ip) ^ MAGIC_COOKIE) >>> 0, 8); // X-Address = IP XOR 0x2112A442
  return attr;
}

const attr = xorMappedAddress(mapped);
const response = Buffer.concat([stunHeader(0x0101, attr.length), attr]);
console.log('\n== 3. Binding 성공 응답 (type 0x0101) + XOR-MAPPED-ADDRESS ==');
console.log('헤더:', hex(response.subarray(0, 20)));
console.log('속성:', hex(response.subarray(20)));

// 받는 쪽: 같은 XOR을 한 번 더 하면 원래 값
function parseResponse(buf) {
  if (buf[0] >> 6 !== 0) throw new Error('STUN이 아님: 맨 앞 2비트가 0이 아니다');
  if (buf.readUInt32BE(4) !== MAGIC_COOKIE) throw new Error('매직 쿠키가 다르다');
  let offset = 20;
  while (offset < 20 + buf.readUInt16BE(2)) {
    const type = buf.readUInt16BE(offset);
    const length = buf.readUInt16BE(offset + 2);
    if (type === 0x0020) {
      const port = buf.readUInt16BE(offset + 6) ^ (MAGIC_COOKIE >>> 16);
      const ip = intToIp((buf.readUInt32BE(offset + 8) ^ MAGIC_COOKIE) >>> 0);
      return { ip, port };
    }
    offset += 4 + Math.ceil(length / 4) * 4; // 속성은 4바이트 경계로 맞춘다
  }
  return null;
}
console.log('디코드:', parseResponse(response));

// 왜 XOR인가: 공인 IP 바이트를 그대로 찾아 고쳐 쓰는 NAT가 있었다
const rawIp = Buffer.alloc(4);
rawIp.writeUInt32BE(ipToInt(mapped.ip));
console.log(`공인 IP 바이트 ${hex(rawIp)} 가 응답 안에 그대로 있나:`, response.includes(rawIp));

// ── 4. 한 포트에 섞여 오는 패킷 가르기: 첫 바이트만 본다 ─────────
function classify(firstByte) {
  if (firstByte <= 3) return 'STUN';
  if (firstByte >= 16 && firstByte <= 19) return 'ZRTP';
  if (firstByte >= 20 && firstByte <= 63) return 'DTLS';
  if (firstByte >= 64 && firstByte <= 79) return 'TURN Channel';
  if (firstByte >= 128 && firstByte <= 191) return 'RTP/RTCP';
  return '버림';
}
console.log('\n== 4. 첫 바이트로 가르기 ==');
for (const [name, b] of [
  ['STUN 요청', request[0]],
  ['DTLS 핸드셰이크 레코드', 0x16],
  ['RTP (V=2)', 0x80],
  ['TURN ChannelData', 0x40],
]) {
  console.log(`${name.padEnd(22)} 0x${b.toString(16).padStart(2, '0')} → ${classify(b)}`);
}
