// 2장 실습: 이 레포의 프레임 지도.
// 방에서 받은 1초 분량 오디오를 SDK와 같은 설정의 리샘플러에 넣어, 단계마다 프레임이 몇 샘플·몇 바이트로
// 바뀌는지 셉니다. 방·키·외부 서버 없이 로컬 리샘플러(soxr, rtc-node 네이티브)만 씁니다.
//
// 실행: 레포 루트에서  node docs/1-study/lab/02-frame-map.mjs
// 기준: @livekit/agents 1.9.5, @livekit/rtc-node 1.2.1. 2026-11-05 작성. 키·네트워크·.env.local을 쓰지 않습니다.
//
// 숫자의 출처(SDK 코드, 경로는 node_modules/@livekit/agents/src/ 기준)
//   방 입력 24kHz 모노            voice/room_io/room_io.ts  DEFAULT_ROOM_INPUT_OPTIONS
//   방 입력 10ms                  rtc-node 네이티브(libwebrtc) 수신 프레임. 코드가 아니라 FFI 주석 근거라 추정
//   VAD 16kHz, 512샘플, QUICK     inference/vad.ts  MODEL_SAMPLE_RATE, VAD_WINDOW_SAMPLES, AudioResamplerQuality.QUICK
//   STT 16kHz, MEDIUM(기본값)     stt/stt.ts pushFrame → new AudioResampler(입력, 16000)
//   턴 감지 16kHz, QUICK, 1.2초   inference/eot/base.ts, inference/eot/transports.ts  CLIENT_BUFFER_SAMPLES
//   TTS 22.05kHz, 100ms           agents-plugin-elevenlabs 'pcm_22050' + AudioByteStream(기본 sampleRate/10)
//   TTS → 24kHz, MEDIUM           voice/generation.ts  new AudioResampler(frame.sampleRate, 출력 sampleRate)
//   출력 큐 200ms                 voice/room_io/room_io.ts  queueSizeMs: 200
import { AudioByteStream, initializeLogger } from '@livekit/agents';
import { AudioFrame, AudioResampler, AudioResamplerQuality, dispose } from '@livekit/rtc-node';

initializeLogger({ pretty: false, level: 'warn' });

const IN_RATE = 24000;
const IN_FRAME = IN_RATE / 100; // 10ms = 240샘플

/** 1초 분량 10ms 프레임을 리샘플러에 넣고, push마다 나온 샘플 수를 돌려줍니다. */
function pushOneSecond(outRate, quality) {
  const r = new AudioResampler(IN_RATE, outRate, 1, quality);
  const sizes = [];
  for (let i = 0; i < 100; i++) {
    const out = r.push(new AudioFrame(new Int16Array(IN_FRAME), IN_RATE, 1, IN_FRAME));
    sizes.push(out.reduce((n, f) => n + f.samplesPerChannel, 0));
  }
  r.close();
  return sizes;
}

// 한글은 터미널에서 두 칸을 차지하므로 칸 수를 세어 맞춥니다.
const width = (s) => [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0x1100 ? 2 : 1), 0);
const row = (stage, detail) => console.log(`${stage}${' '.repeat(24 - width(stage))}${detail}`);
row('단계', '1초 동안 실제로 일어나는 일');
console.log('-'.repeat(78));

row('방 입력 (24kHz)', `프레임 ${IN_FRAME}샘플 = ${IN_FRAME * 2}B = 10ms, 초당 100개`);

// VAD: QUICK으로 16kHz. 512샘플이 모일 때마다 한 번 추론하고, 입력 쪽에서는 512×1.5 = 768샘플을 넘깁니다.
const vad = pushOneSecond(16000, AudioResamplerQuality.QUICK);
const vadTotal = vad.reduce((a, b) => a + b, 0);
row('VAD (16kHz, QUICK)', `push마다 ${[...new Set(vad)].join('/')}샘플, 합 ${vadTotal}`);
row(
  '',
  `512샘플 창 ${Math.floor(vadTotal / 512)}번 추론(32ms마다), 창 하나 = 입력 ${512 * 1.5}샘플`,
);

// STT: 기본값 MEDIUM. 리샘플러가 낸 덩어리 하나가 그대로 Soniox WebSocket 메시지 하나가 됩니다.
const stt = pushOneSecond(16000, AudioResamplerQuality.MEDIUM);
const msgs = stt.filter((n) => n > 0);
row('STT (16kHz, MEDIUM)', `처음 10번 push: ${stt.slice(0, 10).join(' ')}`);
row(
  '',
  `WS 메시지 ${msgs.length}개, ${Math.min(...msgs)}~${Math.max(...msgs)}샘플(` +
    `${Math.min(...msgs) * 2}~${Math.max(...msgs) * 2}B), 1초 안에 보낸 샘플 ${msgs.reduce((a, b) => a + b, 0)}`,
);

// 턴 감지: QUICK으로 16kHz. 로컬 모델(v1-mini)은 최근 1.2초를 base64로 묶어 추론 프로세스에 보냅니다.
const eot = pushOneSecond(16000, AudioResamplerQuality.QUICK);
const ring = Math.floor(1.2 * 16000);
const b64 = Buffer.alloc(ring * 2).toString('base64').length;
row(
  '턴 감지 (16kHz, QUICK)',
  `push마다 ${[...new Set(eot)].join('/')}샘플 (클라우드 v1은 이 프레임을 그대로 WS로)`,
);
row('', `로컬 v1-mini: 최대 ${ring}샘플 = ${ring * 2}B → base64 ${b64}자`);

// TTS: ElevenLabs pcm_22050 바이트를 AudioByteStream이 100ms 프레임으로 자릅니다.
const bytes = new AudioByteStream(22050, 1);
const ttsFrames = bytes.write(new Uint8Array(22050 * 2)); // 1초 분량 바이트
row(
  'TTS (22.05kHz)',
  `${ttsFrames.length}개 프레임 × ${ttsFrames[0].samplesPerChannel}샘플(${ttsFrames[0].samplesPerChannel * 2}B, 100ms)`,
);

// 출력: 22.05kHz → 24kHz, MEDIUM(기본값). 첫 프레임이 짧은 것은 필터가 뒤 샘플을 볼 때까지 이번 입력의 끝부분을
// 붙잡아 두기 때문입니다. 소리의 시작은 늦추지 않습니다(2-2절 깊이 보기 ⑤).
const up = new AudioResampler(22050, 24000, 1, AudioResamplerQuality.MEDIUM);
const upSizes = ttsFrames.map((f) => up.push(f).reduce((n, o) => n + o.samplesPerChannel, 0));
const held = 24000 - upSizes.reduce((a, b) => a + b, 0);
up.close();
row('출력 (24kHz, MEDIUM)', `프레임마다 ${upSizes.slice(0, 5).join(' ')} ...`);
row('', `1초 넣은 뒤 리샘플러 안에 남은 샘플 ${held}개 = ${((held / 24000) * 1000).toFixed(1)}ms`);
row('출력 큐 (AudioSource)', `200ms = ${0.2 * 24000}샘플 = ${0.2 * 24000 * 2}B`);

await dispose();
