// 5장 실습 공용 도구: 이 레포와 같은 VAD(`inference.VAD`, 번들 Silero)에 녹음을 흘려 넣고 사건을 모읍니다.
// 직접 실행하는 파일이 아니라 05-*.mjs 실습들이 불러 씁니다.
// 기준: Node.js 24, @livekit/agents 1.9.5, @livekit/local-inference 0.2.7. 2026-11-06 작성.
//       키·네트워크·.env.local을 쓰지 않습니다. 모델은 네이티브 모듈 안에서 로컬로 돕니다.
import { VADEventType, inference, initializeLogger } from '@livekit/agents';
import { AudioFrame } from '@livekit/rtc-node';
import { createRequire } from 'node:module';
import { koreanSpeech } from './02-wav.mjs';

// VAD 스트림이 log()를 부르므로 로거를 먼저 만들어야 합니다(안 하면 "logger not initialized").
initializeLogger({ pretty: false, level: 'warn' });

/** SDK가 쓰는 네이티브 모듈. pnpm은 레포 루트에 올려 두지 않으므로 agents 패키지 기준으로 찾습니다. */
export const native = createRequire(import.meta.resolve('@livekit/agents'))(
  '@livekit/local-inference',
);

/** 실습에 쓰는 문장. 중간의 "음..."에서 말이 잠깐 끊깁니다. */
export const SENTENCE = '네, 에프투 울트라요. 음... 가죽 지갑 만들려고요.';

/** 24kHz 한국어 녹음 앞뒤에 무음을 붙입니다. 실제 통화에서 고객이 말하기 전후의 조용한 구간 역할입니다. */
export function paddedSpeech(padSec = 1) {
  const { rate, pcm, source } = koreanSpeech(SENTENCE);
  const pad = Math.round(rate * padSec);
  const out = new Int16Array(pad + pcm.length + pad);
  out.set(pcm, pad);
  return {
    rate,
    pcm: out,
    source,
    speechStartMs: (pad / rate) * 1000,
    speechMs: (pcm.length / rate) * 1000,
  };
}

/** 사건 이름 */
export const NAME = {
  [VADEventType.START_OF_SPEECH]: 'START',
  [VADEventType.INFERENCE_DONE]: 'INFER',
  [VADEventType.END_OF_SPEECH]: 'END',
};

/**
 * pcm을 10ms 프레임(24kHz면 240샘플)으로 잘라 VAD 스트림에 넣고, 사건이 더 오지 않을 때까지 모읍니다.
 * 방 입력과 같은 프레임 크기입니다(2-4절 프레임 지도). `endInput()`은 이 버전에서 잠긴 writable을 닫으려다
 * Promise 거부(WritableStream is locked)가 나서 부르지 않고, 사건이 멈추면 `close()`합니다.
 * 세션은 `updateInputStream()`으로 오디오 스트림을 잇지만, 실습은 간단히 `pushFrame()`(deprecated)을 씁니다.
 * 둘 다 같은 입력 큐로 들어갑니다(node_modules/@livekit/agents/src/vad.ts 217~235).
 */
export async function runVad(pcm, rate, opts = {}) {
  const vad = new inference.VAD(opts);
  const stream = vad.stream();
  const frame = rate / 100;
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    stream.pushFrame(new AudioFrame(pcm.slice(i, i + frame), rate, 1, frame));
  }
  const events = [];
  const it = stream[Symbol.asyncIterator]();
  for (;;) {
    const next = await Promise.race([
      it.next(),
      new Promise((r) => setTimeout(() => r('idle'), 500)),
    ]);
    if (next === 'idle' || next.done) break;
    const ev = next.value;
    events.push({
      type: NAME[ev.type],
      t: ev.timestamp,
      p: ev.probability,
      speaking: ev.speaking,
      rawSilence: ev.rawAccumulatedSilence,
      rawSpeech: ev.rawAccumulatedSpeech,
      speechDuration: ev.speechDuration,
      silenceDuration: ev.silenceDuration,
      inferenceDuration: ev.inferenceDuration,
      frameSamples: ev.frames.reduce((n, f) => n + f.samplesPerChannel, 0),
    });
  }
  stream.close();
  return events;
}
