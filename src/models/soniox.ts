import type { APIConnectOptions } from '@livekit/agents';
import * as soniox from '@livekit/agents-plugin-soniox';

/**
 * 말이 끝나면 바로 확정 결과를 받는 Soniox STT.
 *
 * Soniox는 스스로 끝점을 정할 때까지 최종 결과를 보내지 않아, 가끔 말이 끝나고 1.3초 뒤에야 확정됩니다
 * (2026-11-03 실측). LiveKit 코어는 VAD가 말 끝을 감지해도 STT에 알리지 않으므로, 고객이 말을 멈출 때
 * `finalize()`를 불러 스트림에 flush를 보냅니다. 플러그인 패치
 * (patches/@livekit__agents-plugin-soniox@1.9.5.patch)가 flush를 Soniox `finalize` 요청으로 바꿉니다.
 */
export class FinalizingSonioxSTT extends soniox.STT {
  #current: soniox.SpeechStream | undefined;

  override stream(options?: { connOptions?: APIConnectOptions }): soniox.SpeechStream {
    this.#current = super.stream(options);
    return this.#current;
  }

  /** 지금까지 들은 말을 바로 확정하게 합니다. 스트림이 이미 닫혔으면 무시합니다. */
  finalize(): void {
    try {
      this.#current?.flush();
    } catch {
      // 닫힌 스트림의 flush는 던질 수 있음
    }
  }
}
