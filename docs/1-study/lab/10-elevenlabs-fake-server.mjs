// 10장 실습: 가짜 ElevenLabs 서버(127.0.0.1)에 ElevenLabs 플러그인을 붙여 받는 쪽 경로를 단계별로 잽니다
// (학습서 10-2·10-3절).
//  1) 서버가 받는 것: URL 경로와 쿼리(enable_logging 포함), 인증 헤더, 컨텍스트 시작·글·끝 메시지
//  2) 가짜 오디오(base64 PCM)를 세 가지 모양으로 보내, 플러그인이 첫 프레임을 언제 내놓는지
//     (마지막 프레임 하나를 들고 있다가 다음 프레임이 생기면 내보냄 + 10ms 폴링)
//  3) TTFB 지표의 경계: 새 연결의 핸드셰이크(일부러 300ms 늦춤)와 분할기가 붙잡은 시간이 ttfbMs 밖이라는 것.
//     글을 25ms마다 한 글자씩 넣었을 때 첫 글자 → 공급사로 보냄 → 첫 프레임
//  4) 받은 프레임을 SDK처럼 24kHz(MEDIUM)로 리샘플해 200ms AudioSource에 넣기: 배압, 쌓이는 곳, clearQueue
//     (4-0: 리샘플러가 붙잡는 것이 프레임의 앞이 아니라 뒤라는 것을 임펄스 위치로 확인)
//
// 실행 (레포 루트에서):  node docs/1-study/lab/10-elevenlabs-fake-server.mjs   (약 6초)
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/agents-plugin-elevenlabs 1.9.5, @livekit/rtc-node 1.2.1 (2026-11-06)
// 키·.env.local·외부 네트워크를 쓰지 않습니다. apiKey는 가짜 문자열이고, baseURL을 로컬 가짜 서버로 바꿉니다.
// 플러그인은 baseURL의 http://를 ws://로 바꿔 WebSocket 주소를 만듭니다(agents-plugin-elevenlabs/src/tts.ts 191~205).
//
// 옵션은 src/models/index.ts의 createTTS와 같고(model, language: 'ko'), 가짜 키·주소·음성 ID만 더했습니다.
// createTTS는 baseURL을 받지 않아 직접 만듭니다. 모델은 src/config.ts 기본값 eleven_v4_turbo입니다.
// 서버가 오디오를 어떤 크기로, 얼마나 빨리 보내는지는 ElevenLabs가 공개하지 않아 세 가지 모양을 지어냈습니다.
// 메시지 칸 이름(audio, alignment.chars/char_start_times_ms/char_durations_ms, is_final)은 플러그인이 읽는 이름입니다.
//
// 4번은 세션의 forwardAudio(agents/src/voice/generation.ts 1194~1233)를 줄여 옮긴 것입니다. 방 대신 AudioSource만
// 만들어 씁니다(ParticipantAudioOutput가 감싸는 것과 같은 24kHz·200ms 큐, voice/room_io/room_io.ts 136·142).
import { initializeLogger } from '@livekit/agents';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import {
  AudioFrame,
  AudioResampler,
  AudioResamplerQuality,
  AudioSource,
  dispose,
} from '@livekit/rtc-node';
import { createRequire } from 'node:module';
import { ReadableStream } from 'node:stream/web';

initializeLogger({ pretty: false, level: 'error' });

// ws는 플러그인의 의존성이라 레포 루트에서는 안 보입니다. 플러그인 위치에서 빌려 옵니다.
const { WebSocketServer } = createRequire(import.meta.resolve('@livekit/agents-plugin-elevenlabs'))(
  'ws',
);

const RATE = 22050; // pcm_22050
let T0 = performance.now();
const now = () => performance.now() - T0;
const f1 = (n) => n.toFixed(1).padStart(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 가짜 PCM: 220Hz 사인파, 16비트 리틀 엔디언 (pcm_22050과 같은 모양)
let phase = 0;
function pcm(samples) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++, phase++) {
    buf.writeInt16LE(Math.round(4000 * Math.sin((2 * Math.PI * 220 * phase) / RATE)), i * 2);
  }
  return buf;
}

// ── 가짜 서버. plan = { delayMs: 글을 받고 첫 오디오까지, chunks: [[오디오 ms, 다음 조각까지 ms], ...] }
let plan;
const serverLog = [];
const sent = []; // 서버가 보낸 오디오 메시지 { at, ms, bytes, jsonChars }
// 첫 연결의 업그레이드 응답을 300ms 늦춥니다. 실제 첫 연결의 TCP·TLS 핸드셰이크와 왕복을 흉내 낸 값입니다.
const HANDSHAKE_MS = 300;
let handshakes = 0;
const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: 0,
  verifyClient: (_info, done) =>
    setTimeout(() => done(true), handshakes++ === 0 ? HANDSHAKE_MS : 0),
});
await new Promise((r) => wss.once('listening', r));
let connections = 0;

wss.on('connection', (ws, req) => {
  connections += 1;
  const url = new URL(req.url, 'ws://x');
  serverLog.push(`연결 #${connections}: 경로 ${url.pathname}`);
  for (const [k, v] of url.searchParams) serverLog.push(`   쿼리 ${k.padEnd(26)} = ${v}`);
  serverLog.push(`   헤더 xi-api-key = "${req.headers['xi-api-key']}" (가짜 키)`);
  const contexts = new Map();

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const id = msg.context_id;
    if (!contexts.has(id)) contexts.set(id, { chain: Promise.resolve(), n: 0 });
    const ctx = contexts.get(id);
    const shown = JSON.stringify(msg).replace(id, '<ctx>');
    serverLog.push(`${f1(now())}ms 받음 ${shown}`);
    const text = msg.inputs?.[0]?.text;
    if (text && text.trim()) {
      const p = plan;
      ctx.chain = ctx.chain.then(async () => {
        await sleep(p.delayMs);
        let cumMs = 0;
        for (const [i, [ms, gapMs]] of p.chunks.entries()) {
          // 누적 시각으로 샘플 수를 정해 50ms 조각(1,102.5샘플)도 합계가 정확히 맞게 합니다.
          const samples =
            Math.round(((cumMs + ms) * RATE) / 1000) - Math.round((cumMs * RATE) / 1000);
          cumMs += ms;
          const audio = pcm(samples).toString('base64');
          const body = { context_id: id, audio };
          if (i === 0) {
            // 글자별 재생 시각(alignment). 대화형 경로는 snake_case 칸 이름을 씁니다(tts.ts 666~675).
            const chars = [...text];
            body.alignment = {
              chars,
              char_start_times_ms: chars.map((_, k) => k * 60),
              char_durations_ms: chars.map(() => 60),
            };
          }
          const json = JSON.stringify(body);
          ws.send(json);
          sent.push({ at: now(), ms, bytes: samples * 2, b64: audio.length, json: json.length });
          if (gapMs) await sleep(gapMs);
        }
      });
    }
    if (msg.close_context) {
      ctx.chain = ctx.chain.then(() => ws.send(JSON.stringify({ context_id: id, is_final: true })));
    }
  });
});

// ── 클라이언트: 플러그인 그대로
const tts = new elevenlabs.TTS({
  apiKey: 'fake-key-for-lab',
  baseURL: `http://127.0.0.1:${wss.address().port}/v1`,
  voiceId: 'lab-voice-id',
  model: 'eleven_v4_turbo',
  language: 'ko',
});
const metrics = [];
tts.on('metrics_collected', (m) => metrics.push({ at: now(), ...m }));

/**
 * 글을 넣고, 플러그인이 내놓는 프레임마다 시각·크기를 적습니다.
 * 세션처럼 두 단계로 나눕니다. ① 플러그인 스트림을 곧바로 읽어 ReadableStream에 enqueue(ttsNode, agents/src/voice/
 * agent.ts 641~652. enqueue는 기다리지 않음) ② 그 스트림을 읽어 onFrame을 기다림(forwardAudio의 captureFrame).
 */
async function run({ text, typeMs = 0, onFrame }) {
  const stream = tts.stream();
  const frames = [];
  let ctrl;
  const buffered = new ReadableStream({ start: (c) => (ctrl = c) }, { highWaterMark: Infinity });
  const consumer = (async () => {
    for await (const ev of stream) {
      if (typeof ev === 'symbol') continue; // END_OF_STREAM
      frames.push({ at: now(), samples: ev.frame.samplesPerChannel, final: ev.final });
      ctrl.enqueue(ev.frame);
    }
    ctrl.close();
  })();
  const forwarded = { n: 0 };
  const forwarder = (async () => {
    for await (const frame of buffered) {
      forwarded.n += 1;
      if (onFrame && (await onFrame(frame, forwarded.n, frames.length)) === 'stop') {
        stream.close(); // 끼어들기: 세션은 TTS 스트림을 닫고 남은 프레임을 버림
        break;
      }
    }
  })();
  let typedFirstAt;
  if (typeMs) {
    for (const ch of [...text]) {
      typedFirstAt ??= now();
      stream.pushText(ch);
      await sleep(typeMs);
    }
  } else {
    typedFirstAt = now();
    stream.pushText(text);
  }
  stream.endInput();
  await consumer;
  await forwarder;
  return { frames, typedFirstAt, forwarded };
}

function reset(p) {
  plan = p;
  sent.length = 0;
  serverLog.length = 0;
  metrics.length = 0;
  T0 = performance.now();
}

// ── 1)·2) 오디오 모양 세 가지
const SHAPES = [
  [
    'A. 100ms 조각 하나 → 300ms 쉼 → 100ms 조각 하나',
    {
      delayMs: 50,
      chunks: [
        [100, 300],
        [100, 0],
      ],
    },
  ],
  [
    'B. 50ms 조각을 25ms마다 (실시간의 2배), 모두 1초',
    { delayMs: 50, chunks: Array.from({ length: 20 }, () => [50, 25]) },
  ],
  ['C. 1초를 한 번에', { delayMs: 50, chunks: [[1000, 0]] }],
];
for (const [i, [label, p]] of SHAPES.entries()) {
  reset(p);
  const { frames, typedFirstAt } = await run({ text: '문의 주신 게 에프투 울트라 맞으시죠?' });
  if (i === 0) {
    console.log(`1) 서버가 받은 것 (첫 연결은 업그레이드 응답을 ${HANDSHAKE_MS}ms 늦춤)`);
    for (const line of serverLog) console.log(`   ${line}`);
    const a = sent[0];
    console.log(
      `   보낸 오디오 메시지 예(100ms): PCM ${a.bytes}B → base64 ${a.b64}자, alignment 포함 JSON ${a.json}자\n`,
    );
    console.log('2) 오디오 모양에 따른 첫 프레임 (시각은 서버가 첫 오디오를 보낸 때부터 ms)');
  }
  const s0 = sent[0].at;
  const m = metrics[0];
  console.log(`   ${label}`);
  console.log(
    `     서버 오디오 보낸 시각: ${sent
      .map((s) => (s.at - s0).toFixed(0))
      .slice(0, 8)
      .join(', ')}${sent.length > 8 ? ', …' : ''}`,
  );
  console.log(
    `     플러그인 프레임:        ${frames
      .map((f) => `${(f.at - s0).toFixed(0)}(${f.samples}${f.final ? ', 마지막' : ''})`)
      .slice(0, 6)
      .join(', ')}${frames.length > 6 ? `, … 모두 ${frames.length}개` : ''}`,
  );
  console.log(
    `     첫 프레임: 첫 오디오 뒤 ${(frames[0].at - s0).toFixed(1)}ms. ` +
      `그때까지 받은 오디오 ${sent.filter((s) => s.at <= frames[0].at).reduce((n, s) => n + s.ms, 0)}ms분. ` +
      `ttfbMs ${m.ttfbMs}, 지표 ${metrics.length}건`,
  );
  if (i === 0) {
    console.log(
      `     (새 연결) 글을 넣은 때부터 첫 프레임까지 ${(frames[0].at - typedFirstAt).toFixed(0)}ms인데 ttfbMs는 ${m.ttfbMs}ms ` +
        `→ 연결 ${HANDSHAKE_MS}ms는 지표 밖`,
    );
  }
}

// ── 3) TTFB 지표의 경계: 글자를 25ms마다 넣음
reset({ delayMs: 120, chunks: Array.from({ length: 8 }, () => [50, 25]) });
const TEXT3 = '가죽 소품이요. 주로 어떤 걸 만드실 생각이세요? 예산도 여쭤봐도 될까요?';
const r3 = await run({ text: TEXT3, typeMs: 25 });
console.log(
  `\n3) TTFB 지표의 경계: "${TEXT3}"를 25ms마다 한 글자씩 (시각은 첫 글자를 넣은 때부터 ms)`,
);
const recvText = serverLog.filter((l) => l.includes('"inputs"'));
for (const l of recvText) console.log(`   서버 ${l.trim()}`);
const firstSent = sent[0].at - r3.typedFirstAt;
const firstFrame = r3.frames[0].at - r3.typedFirstAt;
const firstTextAt = Number(recvText[0].trim().split('ms')[0]) - r3.typedFirstAt;
console.log(
  `   첫 글을 서버가 받은 시각 ${firstTextAt.toFixed(1)}  (분할기가 셋째 문장 시작 "예"까지 붙잡은 시간)`,
);
console.log(`   서버 첫 오디오          ${firstSent.toFixed(1)}  (가짜 서버의 생각 시간 120ms)`);
console.log(`   플러그인 첫 프레임      ${firstFrame.toFixed(1)}`);
console.log(
  `   ttfbMs = ${metrics[0].ttfbMs}  → 시작점 ≈ 첫 프레임 − ttfbMs = ${(firstFrame - metrics[0].ttfbMs).toFixed(1)}ms ` +
    `(첫 글자부터 따지면 ${firstFrame.toFixed(0)}ms)`,
);
console.log(`   지표 ${metrics.length}건 (말 하나에 하나), 글자 수 ${metrics[0].charactersCount}`);

// ── 4-0) 리샘플러가 붙잡는 것은 프레임의 앞이 아니라 뒤: 입력 100번·2000번 샘플에 임펄스를 넣고 위치를 봄
{
  const probe = new AudioResampler(RATE, 24000, 1, AudioResamplerQuality.MEDIUM);
  const d = new Int16Array(2205);
  d[100] = 20000;
  d[2000] = 20000;
  const peaksOf = (xs) =>
    xs.flatMap((v, i) => (v > 5000 && v >= (xs[i - 1] ?? 0) && v >= (xs[i + 1] ?? 0) ? [i] : []));
  const first = probe.push(new AudioFrame(d, RATE, 1, 2205)).flatMap((f) => [...f.data]);
  const second = probe
    .push(new AudioFrame(new Int16Array(2205), RATE, 1, 2205))
    .flatMap((f) => [...f.data]);
  probe.close();
  console.log(
    '\n4-0) 22.05kHz → 24kHz(MEDIUM) 임펄스: 입력 100번·2000번 샘플 (24kHz 기대 위치 108.8, 2176.9)',
  );
  console.log(
    `   첫 push: ${first.length}샘플 나옴, 봉우리 ${peaksOf(first).join(', ')}  /  ` +
      `둘째 push 뒤: ${first.length + second.length}샘플, 봉우리 ${peaksOf([...first, ...second]).join(', ')}`,
  );
}

// ── 4) 24kHz 리샘플 + 200ms AudioSource (세션의 forwardAudio를 줄인 것)
reset({ delayMs: 50, chunks: Array.from({ length: 20 }, () => [50, 25]) });
const source = new AudioSource(24000, 1, 200);
let resampler;
const caps = [];
const r4 = await run({
  text: '문의 주신 게 에프투 울트라 맞으시죠?',
  onFrame: async (frame) => {
    resampler ??= new AudioResampler(frame.sampleRate, 24000, 1, AudioResamplerQuality.MEDIUM);
    for (const f of resampler.push(frame)) {
      const t = now();
      await source.captureFrame(f);
      caps.push({
        at: t,
        wait: now() - t,
        samples: f.samplesPerChannel,
        queued: source.queuedDuration,
      });
    }
  },
});
for (const f of resampler.flush()) {
  const t = now();
  await source.captureFrame(f);
  caps.push({
    at: t,
    wait: now() - t,
    samples: f.samplesPerChannel,
    queued: source.queuedDuration,
  });
}
const s4 = sent[0].at;
console.log('\n4) 24kHz(MEDIUM) 리샘플 → AudioSource(200ms) (시각은 서버 첫 오디오부터 ms)');
console.log(
  `   플러그인 첫 프레임 ${(r4.frames[0].at - s4).toFixed(1)}, 첫 captureFrame ${(caps[0].at - s4).toFixed(1)}`,
);
console.log(
  `   서버가 1초 분량을 다 보낸 시각 ${(sent.at(-1).at - s4).toFixed(0)}, 플러그인이 마지막 프레임을 내놓은 시각 ` +
    `${(r4.frames.at(-1).at - s4).toFixed(0)} (프레임 ${r4.frames.length}개)`,
);
console.log('   captureFrame마다: 시작 시각 / 기다린 ms / 24kHz 샘플 수 / 끝난 뒤 큐에 든 ms');
for (const c of caps) {
  console.log(
    `     ${f1(c.at - s4)}  기다림 ${f1(c.wait)}  ${String(c.samples).padStart(5)}샘플  큐 ${String(Math.round(c.queued)).padStart(3)}ms`,
  );
}
const last = caps.at(-1);
console.log(
  `   마지막 captureFrame이 끝난 시각 ${(last.at + last.wait - s4).toFixed(0)}ms, 큐에 남은 ${Math.round(source.queuedDuration)}ms`,
);

// 끼어들기: 1초를 한 번에 받은 뒤, 넷째 프레임을 넣고 나서 끊음.
// 세션은 ParticipantAudioOutput가 audioSource.clearQueue()를 부르고(_output.ts 742) TTS·전달 작업을 멈춥니다.
reset({ delayMs: 50, chunks: [[1000, 0]] });
const resampler5 = new AudioResampler(RATE, 24000, 1, AudioResamplerQuality.MEDIUM);
let cleared;
const r5 = await run({
  text: '문의 주신 게 에프투 울트라 맞으시죠?',
  onFrame: async (frame, n, produced) => {
    for (const f of resampler5.push(frame)) await source.captureFrame(f);
    if (n < 4) return;
    const before = source.queuedDuration;
    source.clearQueue();
    cleared = { before, after: source.queuedDuration, waiting: produced - n };
    return 'stop';
  },
});
console.log(
  `   끼어들기 흉내: 1초를 한 번에 받고 넷째 프레임을 넣은 뒤 clearQueue() → AudioSource 큐 ` +
    `${Math.round(cleared.before)}ms → ${Math.round(cleared.after)}ms. ` +
    `그때 앞 단계 버퍼에 아직 안 넣은 프레임 ${cleared.waiting}개(${cleared.waiting * 100}ms) → 스트림을 닫아 버림 ` +
    `(받은 프레임 ${r5.frames.length}개 중 ${r5.forwarded.n}개만 넣음)`,
);

resampler.close();
resampler5.close();
await source.close();
await tts.close();
console.log(
  `\n연결 수: ${connections} (같은 TTS 인스턴스는 WebSocket 하나를 컨텍스트별로 나눠 씀)`,
);
await new Promise((r) => wss.close(r));
await dispose();
