import * as anthropic from '@livekit/agents-plugin-anthropic';
import type { Effort, ThinkingMode } from '../config.ts';

export interface VoiceAnthropicOptions extends Partial<anthropic.LLMOptions> {
  effort: Effort;
  thinking: ThinkingMode;
  /**
   * 미리 연결 때 HEAD를 보낼 주소. 플러그인의 미리 연결은 `models.list`를 부르는데 Bedrock
   * 클라이언트에는 없어 조용히 실패합니다. 주면 그 대신 이 주소로 DNS·TLS 세션을 데웁니다.
   */
  prewarmUrl?: string;
}

/**
 * 음성 통화용 Anthropic LLM (Claude Haiku 5.5 기준).
 *
 * 플러그인 1.9.5에는 thinking·effort 옵션이 없지만, `chat()`의 `extraKwargs`를 요청 본문에
 * 그대로 펼칩니다. 그 경로로 매 요청에 아래 값을 넣습니다.
 * - `thinking`: Haiku 5.5는 생각 모드가 기본으로 켜져 있습니다. `off`면 `{ type: 'disabled' }`이고,
 *   effort `high` 이하에서만 허용됩니다. 플러그인이 대화 기록을 만들 때 생각 블록을 버리므로
 *   도구를 붙이면 `off`가 안전합니다.
 * - `output_config.effort`: Haiku 5.5 기본값은 `medium`입니다.
 * - `cache_control`: 자동 프롬프트 캐시. Haiku 5.5는 512토큰 이상이면 캐시됩니다.
 *
 * `temperature`는 넣지 않습니다. Haiku 5.5는 기본값이 아닌 sampling 값을 400으로 거절합니다.
 */
export class VoiceAnthropicLLM extends anthropic.LLM {
  #extra: Record<string, unknown>;
  #prewarmUrl: string | undefined;

  constructor({ effort, thinking, prewarmUrl, ...opts }: VoiceAnthropicOptions) {
    // 플러그인은 import 시점에 ANTHROPIC_API_KEY를 읽어 두므로, dotenv 이후 값으로 다시 넘깁니다.
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    super({ ...opts, ...(apiKey ? { apiKey } : {}) });
    this.#extra = {
      thinking: thinking === 'off' ? { type: 'disabled' } : { type: 'adaptive' },
      output_config: { effort },
      cache_control: { type: 'ephemeral' },
    };
    this.#prewarmUrl = prewarmUrl;
  }

  protected override async _prewarmImpl(signal: AbortSignal): Promise<void> {
    if (!this.#prewarmUrl) return super._prewarmImpl(signal);
    // Bedrock은 이 연결을 닫지만(404, connection: close) DNS·TLS 세션이 남아 첫 요청의 연결이
    // 빨라집니다. SDK와 같은 전역 fetch라 TLS 세션 캐시를 같이 씁니다.
    await fetch(this.#prewarmUrl, { method: 'HEAD', signal });
  }

  override chat(args: Parameters<anthropic.LLM['chat']>[0]) {
    return super.chat({ ...args, extraKwargs: { ...this.#extra, ...args.extraKwargs } });
  }
}
