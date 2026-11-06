// 6장 실습: 가짜 Soniox 서버(127.0.0.1)에 이 레포의 FinalizingSonioxSTT를 붙여 봅니다 (학습서 6-4·6-5절).
//  1) 서버가 받는 것: 인증 헤더, 설정 JSON, 오디오 바이너리 프레임 크기, 5초 keepalive,
//     finalize() 뒤의 {"type":"finalize"}(패치 확인), 끝의 0바이트 프레임
//  2) 선 위의 WebSocket 프레임 머리(opcode·마스크·길이)를 중간 프록시에서 바이트로 읽기
//  3) 미리 짠 Soniox 응답 5개를 돌려보내, 플러그인 processMessage가 내는 SpeechEvent 보기
//  4) flush()가 리샘플러를 비우지 않는 것: finalize 직전까지 보낸 양과 넣은 양의 차이
//
// 실행 (레포 루트에서):  node docs/1-study/lab/06-soniox-fake-server.mjs   (약 6초 걸림, keepalive를 기다림)
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/agents-plugin-soniox 1.9.5 + patches/ (2026-11-06)
// 키·.env.local·외부 네트워크를 쓰지 않습니다. apiKey는 가짜 문자열이고 baseUrl을 로컬 서버로 바꿉니다.
//
// 플러그인을 직접 쓰지 않고 src/models/soniox.ts의 FinalizingSonioxSTT를 import합니다. 플러그인도 어차피
// @livekit/agents 전체를 불러오므로 로딩 시간은 같고(이 맥에서 약 1초), 실제로 쓰는 클래스와 패치가 함께 검증됩니다.
import { initializeLogger, stt } from '@livekit/agents';
import { AudioFrame, dispose } from '@livekit/rtc-node';
import { createRequire } from 'node:module';
import { createConnection, createServer } from 'node:net';
import { KEYTERMS } from '../../../src/glossary.ts';
import { FinalizingSonioxSTT } from '../../../src/models/soniox.ts';

// 플러그인 SpeechStream이 만들 때 로거를 꺼내 쓰므로 먼저 초기화합니다(워커에서는 CLI가 해 줌).
initializeLogger({ pretty: false, level: 'error' });

// ws는 플러그인의 의존성이라 pnpm 구조상 레포 루트에서는 안 보입니다. 플러그인 위치에서 빌려 옵니다.
const { WebSocketServer } = createRequire(import.meta.resolve('@livekit/agents-plugin-soniox'))(
  'ws',
);

const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(5);
const EVENT_NAMES = Object.fromEntries(
  Object.entries(stt.SpeechEventType)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [v, k]),
);

// ── 미리 짠 Soniox 응답. 토큰을 어떻게 자르는지는 Soniox가 공개하지 않아 모양만 흉내 낸 예시입니다.
//    공백은 토큰 글자 안에 들어 있습니다(" 백", " 피"). 미확정 토큰은 메시지마다 새로 다시 옵니다.
const tok = (text, is_final, start_ms, end_ms, confidence) => ({
  text,
  is_final,
  start_ms,
  end_ms,
  confidence,
});
const SCRIPT = [
  // [보낼 때: 받은 오디오 메시지 수, 메시지]
  [
    10,
    {
      tokens: [tok('메', false, 120, 240, 0.62), tok('탈', false, 240, 420, 0.71)],
      total_audio_proc_ms: 480,
    },
  ],
  [
    17,
    {
      tokens: [
        tok('메', true, 120, 240, 0.93),
        tok('탈', true, 240, 420, 0.95),
        tok(' 백', false, 420, 600, 0.41),
      ],
      total_audio_proc_ms: 720,
    },
  ],
  [
    24,
    {
      tokens: [tok('팹', true, 420, 600, 0.88), tok('이랑', true, 600, 840, 0.97)],
      total_audio_proc_ms: 960,
    },
  ],
  [
    31,
    {
      tokens: [
        tok(' 피', false, 1000, 1150, 0.8),
        tok('쓰리', false, 1150, 1380, 0.85),
        tok('도', false, 1380, 1460, 0.9),
      ],
      total_audio_proc_ms: 1200,
    },
  ],
];
const ON_FINALIZE = {
  tokens: [
    tok(' 피', true, 1000, 1150, 0.96),
    tok('쓰리', true, 1150, 1380, 0.94),
    tok('도', true, 1380, 1460, 0.99),
    { text: '<fin>', is_final: true },
  ],
  total_audio_proc_ms: 1540,
};

// ── 가짜 Soniox 서버
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => wss.once('listening', r));
const seen = { binary: [], bytes: 0, sizes: new Map(), keepalives: [], bytesAtFinalize: undefined };

wss.on('connection', (ws, req) => {
  console.log(`${ms()}ms 서버: 연결됨, Authorization 헤더 = "${req.headers.authorization}"`);
  let configured = false;
  ws.on('message', (data, isBinary) => {
    if (!configured) {
      configured = true;
      const config = JSON.parse(data.toString());
      console.log(`${ms()}ms 서버: 첫 메시지(텍스트) = 설정 JSON`);
      for (const [k, v] of Object.entries(config)) {
        const shown =
          k === 'context'
            ? `{ terms: [${v.terms.length}개: ${v.terms.slice(0, 4).join(', ')}, …] }`
            : JSON.stringify(v);
        console.log(`        ${k.padEnd(34)} ${shown}`);
      }
      return;
    }
    if (isBinary) {
      // 이 가짜 서버는 플러그인의 가정대로 "길이 0 바이너리 = 오디오 끝"으로 처리합니다. 그런데 2026-11-06에 본
      // Soniox WebSocket API 문서는 빈 "텍스트" 프레임으로 끝내라고 하고, 빈 바이너리 프레임은 끝이 아니라고 적습니다.
      if (data.length === 0) {
        console.log(`${ms()}ms 서버: 길이 0 바이너리 프레임 → finished 보내고 닫음`);
        ws.send(JSON.stringify({ finished: true, total_audio_proc_ms: 5200 }));
        ws.close();
        return;
      }
      seen.binary.push(Date.now() - t0);
      seen.bytes += data.length;
      seen.sizes.set(data.length, (seen.sizes.get(data.length) ?? 0) + 1);
      for (const [at, msg] of SCRIPT) if (seen.binary.length === at) ws.send(JSON.stringify(msg));
      return;
    }
    const text = data.toString();
    if (text === '{"type":"keepalive"}') {
      seen.keepalives.push(Date.now() - t0);
      console.log(`${ms()}ms 서버: ${text}`);
    } else if (text === '{"type":"finalize"}') {
      seen.bytesAtFinalize = seen.bytes;
      console.log(
        `${ms()}ms 서버: ${text} ← 패치가 보낸 수동 확정 요청 (그때까지 받은 오디오 ${seen.bytes}B)`,
      );
      setTimeout(() => ws.send(JSON.stringify(ON_FINALIZE)), 30); // 서버 처리 시간 흉내
    } else {
      console.log(`${ms()}ms 서버: 텍스트 ${text}`);
    }
  });
});

// ── 중간 프록시: 클라이언트 → 서버 방향 바이트를 그대로 넘기면서 WebSocket 프레임 머리를 읽습니다 (RFC 6455 5.2절).
const frames = [];
const proxy = createServer((client) => {
  const upstream = createConnection(wss.address().port, '127.0.0.1');
  client.pipe(upstream);
  upstream.pipe(client);
  let buf = Buffer.alloc(0);
  let handshakeDone = false;
  client.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (!handshakeDone) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      handshakeDone = true;
      buf = buf.subarray(end + 4); // HTTP 업그레이드 요청 머리는 건너뜀
    }
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let head = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        head = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        head = 10;
      }
      if (masked) head += 4;
      if (buf.length < head + len) return;
      // 마스크 키 4B는 프레임마다 무작위라 빼고, 고정된 앞부분(FIN·opcode, 마스크 비트·길이)만 남깁니다.
      const fixed = buf.subarray(0, head - (masked ? 4 : 0)).toString('hex');
      frames.push({ opcode, masked, len, head, first: fixed });
      buf = buf.subarray(head + len);
    }
  });
  client.on('error', () => {});
  upstream.on('error', () => {});
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const baseUrl = `ws://127.0.0.1:${proxy.address().port}`;

// ── 클라이언트: src/models/index.ts와 같은 옵션. 키만 가짜, 주소만 로컬
const sonioxStt = new FinalizingSonioxSTT({
  apiKey: 'fake-key-for-lab',
  baseUrl,
  model: 'stt-rt-v5',
  languageHints: ['ko'],
  enableLanguageIdentification: false,
  endpointLatencyAdjustmentLevel: 3,
  context: { terms: [...KEYTERMS] },
});
const stream = sonioxStt.stream({
  connOptions: { maxRetry: 0, retryIntervalMs: 1, timeoutMs: 2000 },
});

const events = [];
const consume = (async () => {
  for await (const ev of stream) {
    const a = ev.alternatives?.[0];
    const name = EVENT_NAMES[ev.type];
    events.push(name);
    if (ev.type === stt.SpeechEventType.RECOGNITION_USAGE) {
      const u = ev.recognitionUsage;
      console.log(
        `${ms()}ms 이벤트: ${name} 오디오 +${u.audioDuration}s, 확정 토큰 +${u.outputTokens}`,
      );
    } else if (a) {
      console.log(
        `${ms()}ms 이벤트: ${name.padEnd(20)} "${a.text}" ` +
          `시각 ${a.startTime.toFixed(2)}~${a.endTime.toFixed(2)}s, 신뢰도 ${a.confidence.toFixed(3)}`,
      );
    } else {
      console.log(`${ms()}ms 이벤트: ${name}`);
    }
  }
})();

// 방 오디오처럼 24kHz 10ms(240샘플) 프레임을 실시간 속도로 넣습니다. 앞 1.3초는 220Hz 소리, 나머지는 무음.
// setTimeout(10)을 이어 붙이면 오차가 쌓여 느려지므로, 시작 시각 + 10ms × 프레임 번호까지 기다립니다.
let pushed24k = 0;
const sleep = (n) => new Promise((r) => setTimeout(r, n));
const audioStart = Date.now();
async function pushFor(totalMs, loud) {
  for (let i = 0; i < totalMs / 10; i++) {
    const data = new Int16Array(240);
    if (loud)
      for (let j = 0; j < 240; j++)
        data[j] = Math.round(6000 * Math.sin((2 * Math.PI * 220 * (pushed24k + j)) / 24000));
    stream.pushFrame(new AudioFrame(data, 24000, 1, 240));
    pushed24k += 240;
    await sleep(Math.max(0, audioStart + (pushed24k / 24000) * 1000 - Date.now()));
  }
}

await pushFor(1300, true); // "말하는 중"
await pushFor(260, false); // VAD가 무음 256ms를 확인하는 동안
const expectedAtFinalize = ((pushed24k * 2) / 3) * 2; // 16kHz로 바뀐 뒤의 바이트
console.log(
  `${ms()}ms 클라이언트: finalize() 호출 (24kHz로 넣은 ${pushed24k}샘플 = 16kHz로 ${expectedAtFinalize}B)`,
);
sonioxStt.finalize(); // main.ts에서 UserStateChanged(speaking → listening) 때 부르는 것과 같음
await sleep(100);
console.log(
  `        서버가 finalize 앞에서 받은 오디오 ${seen.bytesAtFinalize}B → 리샘플러에 남아 finalize 뒤로 밀린 몫 ` +
    `${expectedAtFinalize - seen.bytesAtFinalize}B = ${(expectedAtFinalize - seen.bytesAtFinalize) / 32}ms`,
);

// keepalive(5초 간격)가 보일 때까지 무음을 계속 보냅니다. finalize 뒤에도 스트림은 그대로 이어집니다.
while (seen.keepalives.length === 0) await pushFor(100, false);
stream.endInput(); // 입력 끝 → 플러그인이 길이 0 프레임을 보냄
await consume;
stream.close();

// ── 정리
const gaps = seen.binary.slice(1).map((t, i) => t - seen.binary[i]);
console.log('\n요약');
console.log(
  `  오디오 메시지 ${seen.binary.length}개, 크기별 ${[...seen.sizes].map(([s, n]) => `${s}B×${n}`).join(', ')}, ` +
    `평균 간격 ${(gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1)}ms`,
);
const finalBytes = ((pushed24k * 2) / 3) * 2;
console.log(
  `  넣은 오디오 16kHz 환산 ${finalBytes}B, 서버가 받은 오디오 ${seen.bytes}B → 끝내 안 간 몫 ${finalBytes - seen.bytes}B ` +
    `(endInput은 리샘플러를 비우지 않음)`,
);
console.log(`  keepalive 시각: ${seen.keepalives.join(', ')}ms (연결 뒤 5초 간격 타이머)`);
console.log(`  이벤트 순서: ${events.filter((e) => e !== 'RECOGNITION_USAGE').join(' → ')}`);

// 같은 종류·길이의 프레임을 묶어 셉니다. 머리 = 2B + (길이 126~65535면 2B 더) + (클라이언트 프레임이면 마스크 키 4B)
const OPS = { 0x1: '텍스트', 0x2: '바이너리', 0x8: '닫기', 0x9: '핑', 0xa: '퐁' };
const groups = new Map();
for (const f of frames) {
  const key = `${f.opcode}/${f.len}`;
  const g = groups.get(key) ?? { ...f, n: 0 };
  g.n += 1;
  groups.set(key, g);
}
console.log('\n선 위의 WebSocket 프레임 (클라이언트 → 서버, 프록시에서 바이트로 읽음)');
console.log('  종류(opcode)       내용 길이  개수  머리  마스크  머리 바이트(16진)');
for (const g of [...groups.values()].sort((a, b) => a.opcode - b.opcode || a.len - b.len)) {
  console.log(
    `  ${`${OPS[g.opcode] ?? '?'}(0x${g.opcode.toString(16)})`.padEnd(17)} ${String(g.len).padStart(7)}B ` +
      `${String(g.n).padStart(5)} ${String(g.head).padStart(4)}B  ${g.masked ? '있음' : '없음'}    ${g.first}`,
  );
}

await new Promise((r) => wss.close(r));
proxy.close();
await dispose();
