// 3장 실습: RTP 패킷을 바이트로 만들고 손으로 파싱하기 (+ 대역폭 손 계산, SRTP 모양)
//
// 실행: 레포 루트에서  node docs/1-study/lab/03-rtp-parse.mjs
// 기준: Node 24, 외부 패키지 없음. RFC 3550(RTP 고정 헤더), RFC 3551(정적 payload type),
//       RFC 7587(Opus의 RTP 클록 48kHz), RFC 3711(SRTP). 2026-11-05 작성.
// 네트워크를 쓰지 않습니다. 패킷은 모두 이 파일이 만든 가상 값입니다.
import { createCipheriv, createHmac } from 'node:crypto';

const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
const bits = (byte) => byte.toString(2).padStart(8, '0');

// ── 1. 12바이트 고정 헤더 만들기 ─────────────────────────────
function buildRtp({ marker, payloadType, seq, timestamp, ssrc, payload }) {
  const h = Buffer.alloc(12);
  h[0] = (2 << 6) | (0 << 5) | (0 << 4) | 0; // V=2, P=0, X=0, CC=0
  h[1] = (marker << 7) | payloadType; // M(1비트) + PT(7비트)
  h.writeUInt16BE(seq & 0xffff, 2); // 순서 번호 16비트 (네트워크 바이트 순서 = 빅 엔디언)
  h.writeUInt32BE(timestamp >>> 0, 4); // 타임스탬프 32비트
  h.writeUInt32BE(ssrc >>> 0, 8); // SSRC 32비트
  return Buffer.concat([h, payload]);
}

// ── 2. 손으로 파싱하기: 비트를 밀고(>>) 가려(&) 꺼낸다 ────────
function parseRtp(buf) {
  const b0 = buf[0];
  const b1 = buf[1];
  const csrcCount = b0 & 0x0f;
  return {
    version: b0 >> 6,
    padding: (b0 >> 5) & 1,
    extension: (b0 >> 4) & 1,
    csrcCount,
    marker: b1 >> 7,
    payloadType: b1 & 0x7f,
    sequence: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8).toString(16).padStart(8, '0'),
    payloadBytes: buf.length - 12 - 4 * csrcCount, // 이 예에서는 X=0, P=0
  };
}

console.log('== 1. Opus 20ms 패킷 두 개 (PT 111은 SDP가 정한 동적 번호) ==');
const opusPayload = Buffer.alloc(120, 0xaa); // 48kbps × 20ms = 960비트 = 120바이트라고 가정
const ssrc = 0x5eed1234;
const first = buildRtp({
  marker: 1, // 말소리 덩어리(talkspurt)의 첫 패킷
  payloadType: 111,
  seq: 65535, // 일부러 끝 값에서 시작해 넘어가는(wrap) 모습을 본다
  timestamp: 3_000_000_000,
  ssrc,
  payload: opusPayload,
});
const second = buildRtp({
  marker: 0,
  payloadType: 111,
  seq: 65535 + 1,
  timestamp: 3_000_000_000 + 960, // Opus는 언제나 48kHz 클록: 20ms = 960틱
  ssrc,
  payload: opusPayload,
});
console.log('헤더 12바이트:', hex(first.subarray(0, 12)));
console.log(`첫 바이트 ${bits(first[0])} → V=${first[0] >> 6} P=0 X=0 CC=0`);
console.log(`둘째 바이트 ${bits(first[1])} → M=${first[1] >> 7} PT=${first[1] & 0x7f}`);
console.log('첫 패킷:', JSON.stringify(parseRtp(first)));
console.log('둘째 패킷:', JSON.stringify(parseRtp(second)));
const p1 = parseRtp(first);
const p2 = parseRtp(second);
console.log(
  `순서 번호 ${p1.sequence} → ${p2.sequence} (16비트라 넘어감), 타임스탬프 차이 ${p2.timestamp - p1.timestamp}`,
);

console.log('\n== 2. G.711 μ-law(PCMU) 20ms 패킷: PT 0은 RFC 3551이 정한 고정 번호 ==');
const pcmu = buildRtp({
  marker: 0,
  payloadType: 0,
  seq: 1000,
  timestamp: 160_000,
  ssrc: 0x0badcafe,
  payload: Buffer.alloc(160, 0xff), // 8kHz × 20ms = 160샘플, 샘플당 1바이트
});
const pcmuNext = buildRtp({
  marker: 0,
  payloadType: 0,
  seq: 1001,
  timestamp: 160_000 + 160,
  ssrc: 0x0badcafe,
  payload: Buffer.alloc(160, 0xff),
});
console.log('헤더:', hex(pcmu.subarray(0, 12)));
console.log(
  `PT=${parseRtp(pcmu).payloadType}, 페이로드 ${parseRtp(pcmu).payloadBytes}B, 타임스탬프 차이 ${
    parseRtp(pcmuNext).timestamp - parseRtp(pcmu).timestamp
  }`,
);

console.log('\n== 3. 넘어가는 시간 (손 계산 확인) ==');
console.log(`순서 번호(16비트), 초당 50패킷: ${(65536 / 50 / 60).toFixed(1)}분마다 0으로`);
console.log(`타임스탬프(32비트), 48kHz: ${(2 ** 32 / 48000 / 3600).toFixed(1)}시간마다 0으로`);

console.log('\n== 4. 대역폭 손 계산: 페이로드 + RTP 12 + UDP 8 + IPv4 20 (+ SRTP 태그) ==');
function bandwidth(name, payloadBytes, ptimeMs, srtpTag = 0) {
  const packet = payloadBytes + 12 + 8 + 20 + srtpTag;
  const perSecond = 1000 / ptimeMs;
  const kbps = (packet * perSecond * 8) / 1000;
  const overhead = Math.round(((packet - payloadBytes) / packet) * 100);
  console.log(
    `${name.padEnd(30)} ${String(packet).padStart(3)}B × ${perSecond}/초 = ${kbps}kbps (페이로드 밖 ${overhead}%)`,
  );
}
bandwidth('G.711 20ms, RTP', 160, 20);
bandwidth('G.711 20ms, SRTP(태그 10B)', 160, 20, 10);
bandwidth('G.711 10ms, RTP', 80, 10);
bandwidth('Opus 48kbps 20ms, SRTP', 120, 20, 10);
bandwidth('Opus 24kbps 20ms, SRTP', 60, 20, 10);

console.log('\n== 5. SRTP 모양: 헤더는 평문, 페이로드는 암호문, 끝에 인증 태그 ==');
// 실제로는 DTLS 핸드셰이크에서 얻은 마스터 키로 세션 키를 유도합니다(이 단계는 생략).
// 아래 세 키는 가상의 세션 키이고, 변환 자체는 RFC 3711의 기본값(AES-CM + HMAC-SHA1-80)을 따릅니다.
const encKey = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'); // 128비트
const salt = Buffer.from('a0a1a2a3a4a5a6a7a8a9aaabacad', 'hex'); // 112비트
const authKey = Buffer.alloc(20, 0x42); // 160비트

function srtpProtect(packet, roc = 0) {
  const header = packet.subarray(0, 12);
  const payload = packet.subarray(12);
  const seq = packet.readUInt16BE(2);
  const pktSsrc = packet.readUInt32BE(8);
  // IV = (k_s · 2^16) XOR (SSRC · 2^64) XOR (i · 2^16),  i = ROC · 2^16 + SEQ
  const iv = Buffer.alloc(16);
  salt.copy(iv, 0);
  const x = Buffer.alloc(16);
  x.writeUInt32BE(pktSsrc, 4);
  x.writeUInt32BE(roc, 8);
  x.writeUInt16BE(seq, 12);
  for (let k = 0; k < 16; k++) iv[k] ^= x[k];
  const cipher = createCipheriv('aes-128-ctr', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  const rocBytes = Buffer.alloc(4);
  rocBytes.writeUInt32BE(roc);
  const tag = createHmac('sha1', authKey)
    .update(Buffer.concat([header, encrypted, rocBytes]))
    .digest()
    .subarray(0, 10); // 80비트로 자름
  return Buffer.concat([header, encrypted, tag]);
}
const protectedPcmu = srtpProtect(pcmu);
console.log('RTP  앞 16바이트:', hex(pcmu.subarray(0, 16)));
console.log('SRTP 앞 16바이트:', hex(protectedPcmu.subarray(0, 16)));
console.log('SRTP 끝 10바이트(태그):', hex(protectedPcmu.subarray(-10)));
console.log(`길이 ${pcmu.length}B → ${protectedPcmu.length}B, 헤더를 그대로 읽으면:`, {
  sequence: parseRtp(protectedPcmu).sequence,
  ssrc: parseRtp(protectedPcmu).ssrc,
});
