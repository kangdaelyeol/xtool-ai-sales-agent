// 1장 실습: 연결마다 오가는 데이터 양을 손 계산과 같은 식으로 계산하고,
// Soniox로 가는 오디오 메시지 크기를 실제 리샘플러로 확인합니다 (학습서 1-5절 "깊이 보기").
//
// 실행 (레포 루트에서):  node docs/1-study/lab/01-wire-sizes.mjs
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/rtc-node 1.2.1 (2026-11-05)
// 키·네트워크·.env.local을 쓰지 않습니다. 리샘플러는 rtc-node의 네이티브 코드(로컬)로만 돕니다.
import { AudioFrame, AudioResampler, dispose } from '@livekit/rtc-node';

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pcmBytesPerSec = (sampleRate, bytesPerSample = 2, channels = 1) =>
  sampleRate * bytesPerSample * channels;
const base64Len = (bytes) => Math.ceil(bytes / 3) * 4;

// 1. PCM 손 계산: 초당 바이트 = 샘플레이트 × 샘플당 바이트 × 채널 수
console.log('1) PCM 초당 양 (16비트 모노)');
for (const [label, rate] of [
  ['워커 안 방 오디오 (RoomIO 24kHz)', 24_000],
  ['Soniox·턴 감지·VAD 입력 (16kHz)', 16_000],
  ['ElevenLabs 출력 pcm_22050', 22_050],
  ['WebRTC Opus 내부 샘플레이트 (48kHz, 참고)', 48_000],
]) {
  const b = pcmBytesPerSec(rate);
  console.log(`   ${label}: ${fmt(b)} B/s = ${fmt((b * 8) / 1000)} kbps`);
}
console.log(`   전화 G.711 (8kHz, 8비트, 참고): ${fmt(pcmBytesPerSec(8_000, 1))} B/s = 64 kbps`);

// 2. base64는 3바이트를 4글자로 바꿈 → 4/3배. ElevenLabs는 오디오를 JSON 안의 base64 문자열로 보냅니다.
const eleven = pcmBytesPerSec(22_050);
const real = Buffer.alloc(eleven).toString('base64').length;
console.log('\n2) ElevenLabs 오디오 1초 분량');
console.log(
  `   PCM ${fmt(eleven)} B → base64 ${fmt(base64Len(eleven))} 글자 (실제 Buffer 변환 ${fmt(real)})`,
);
console.log('   + JSON 키·글자별 시각(alignment)은 별도 (크기는 서버 응답에 따라 다름)');

// 3. 턴 감지 v1-mini: 잡 프로세스 → 추론 프로세스로 최근 1.2초 PCM을 base64로 IPC 전송
//    (inference/eot/transports.ts: "base64-encode ... default JSON IPC serialization")
const eotPcm = 1.2 * pcmBytesPerSec(16_000);
console.log('\n3) 턴 감지 v1-mini 추론 요청 한 번 (IPC, JSON)');
console.log(`   PCM ${fmt(eotPcm)} B → base64 ${fmt(base64Len(eotPcm))} 글자`);

// 4. Soniox로 가는 메시지: 방 오디오(24kHz, 10ms 프레임)를 코어가 16kHz로 리샘플한 결과가
//    메시지 하나가 됩니다 (stt/stt.ts pushFrame → agents-plugin-soniox stt.ts ws.send).
//    SDK와 같은 기본값(AudioResampler 기본 품질 MEDIUM)으로 3초 분량을 흘려 봅니다.
function simulate(inRate, frameMs, seconds) {
  const inSamples = (inRate * frameMs) / 1000;
  const resampler = inRate === 16_000 ? undefined : new AudioResampler(inRate, 16_000);
  const sizes = [];
  let firstAtMs;
  const frames = (seconds * 1000) / frameMs;
  for (let i = 0; i < frames; i++) {
    const data = new Int16Array(inSamples);
    for (let j = 0; j < inSamples; j++) {
      data[j] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * (i * inSamples + j)) / inRate));
    }
    const frame = new AudioFrame(data, inRate, 1, inSamples);
    const out = resampler ? resampler.push(frame) : [frame];
    for (const f of out) {
      sizes.push(f.samplesPerChannel * 2); // int16 = 2바이트
      firstAtMs ??= (i + 1) * frameMs;
    }
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  const left = 16_000 * 2 * seconds - total; // 아직 리샘플러 안에 남은 바이트
  return { sizes, total, firstAtMs, left };
}

console.log('\n4) Soniox로 가는 WebSocket 바이너리 메시지 (3초 분량)');
for (const [label, inRate] of [
  ['리샘플 없이 16kHz 10ms 프레임이라면', 16_000],
  ['실제 경로: 24kHz 10ms 프레임 → 16kHz', 24_000],
]) {
  const { sizes, total, firstAtMs, left } = simulate(inRate, 10, 3);
  const uniq = [...new Set(sizes)].sort((a, b) => a - b);
  console.log(`   ${label}`);
  console.log(
    `     메시지 ${sizes.length}개 (초당 ${fmt(sizes.length / 3)}개), 크기 ${uniq.map(fmt).join('·')} B, ` +
      `합계 ${fmt(total)} B (초당 ${fmt(total / 3)} B)`,
  );
  console.log(
    `     첫 메시지는 입력 ${firstAtMs}ms 뒤, 끝에 리샘플러 안에 ${fmt(left)} B (${fmt(left / 32)}ms 분량) 남음`,
  );
}

// 5. Anthropic SSE 이벤트 하나의 겉포장. 한국어는 UTF-8로 한 글자 3바이트입니다.
const text = '네, 가죽 지갑이시군요.';
const sse =
  'event: content_block_delta\n' +
  `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`;
console.log('\n5) Anthropic SSE text_delta 이벤트 하나');
console.log(
  `   글 "${text}" ${text.length}자 = ${Buffer.byteLength(text)} B, 이벤트 전체 ${Buffer.byteLength(sse)} B ` +
    `(겉포장 ${Buffer.byteLength(sse) - Buffer.byteLength(text)} B)`,
);

// rtc-node 네이티브 핸들을 정리해야 프로세스가 끝납니다(정리하지 않으면 이벤트 루프가 남음).
await dispose();
