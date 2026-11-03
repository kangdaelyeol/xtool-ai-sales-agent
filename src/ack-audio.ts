import { log, type tts } from '@livekit/agents';
import type { AudioFrame } from '@livekit/rtc-node';
import { ReadableStream } from 'node:stream/web';
import { ACKS } from './ack.ts';

/**
 * 즉시 반응("네네") 음성을 통화 시작 때 한 번 합성해 두고 재생합니다.
 * 턴마다 TTS를 다시 부르지 않아 첫소리가 약 0.17초 빨라지고 TTS 비용도 줄어듭니다.
 * 아직 준비되지 않았거나 합성에 실패한 반응은 `audio()`가 undefined를 돌려줘 평소처럼 합성합니다.
 */
export class AckAudioCache {
  #frames = new Map<string, AudioFrame[]>();

  async preload(engine: tts.TTS): Promise<void> {
    await Promise.all(
      ACKS.map(async (text) => {
        try {
          const frames: AudioFrame[] = [];
          for await (const audio of engine.synthesize(text)) frames.push(audio.frame);
          if (frames.length) this.#frames.set(text, frames);
        } catch (error) {
          log().warn({ error, text }, '즉시 반응 음성을 미리 만들지 못했습니다');
        }
      }),
    );
  }

  audio(text: string): ReadableStream<AudioFrame> | undefined {
    const frames = this.#frames.get(text);
    return frames ? ReadableStream.from(frames) : undefined;
  }
}
