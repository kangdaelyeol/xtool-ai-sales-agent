import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { inference, type llm, type stt, type tts } from '@livekit/agents';
import type * as anthropic from '@livekit/agents-plugin-anthropic';
import * as elevenlabs from '@livekit/agents-plugin-elevenlabs';
import type { LlmConfig, SttConfig, TtsConfig } from '../config.ts';
import { KEYTERMS } from '../glossary.ts';
import { VoiceAnthropicLLM } from './anthropic.ts';
import { FinalizingSonioxSTT } from './soniox.ts';

export function createSTT(config: SttConfig): stt.STT {
  switch (config.provider) {
    case 'soniox':
      // Soniox 플러그인은 세션의 keytermsOptions를 지원하지 않아 context.terms로 직접 넣습니다.
      return new FinalizingSonioxSTT({
        // 플러그인은 import 시점에 SONIOX_API_KEY를 읽어 두므로, dotenv 이후 값으로 다시 넘깁니다.
        ...(process.env.SONIOX_API_KEY ? { apiKey: process.env.SONIOX_API_KEY } : {}),
        model: config.model,
        languageHints: ['ko'],
        // 한국어만 쓰므로 언어 자동 감지를 끄고, 말 끝 판단을 가장 빠르게 합니다 (0~3).
        enableLanguageIdentification: false,
        endpointLatencyAdjustmentLevel: 3,
        context: { terms: [...KEYTERMS] },
      });
    case 'livekit':
      return new inference.STT({ model: config.model, language: 'ko' });
  }
}

export function createLLM(config: LlmConfig): llm.LLM {
  switch (config.provider) {
    case 'anthropic':
      return new VoiceAnthropicLLM({
        model: config.model,
        effort: config.effort,
        thinking: config.thinking,
        // 생각 모드를 켜면 생각 토큰도 여기에 포함됩니다.
        maxTokens: 2048,
      });
    case 'bedrock':
      // 같은 Anthropic 플러그인에 Bedrock 클라이언트만 바꿔 끼웁니다. 인증은 IAM 키(AWS_ACCESS_KEY_ID·
      // AWS_SECRET_ACCESS_KEY)입니다. Bedrock API 키는 조직 정책(SCP)이 이 경로에서 막습니다.
      return new VoiceAnthropicLLM({
        model: config.model,
        effort: config.effort,
        thinking: config.thinking,
        maxTokens: 2048,
        // 플러그인은 @anthropic-ai/sdk 0.33 타입을 기대하지만, 쓰는 것은 messages.create 스트림뿐입니다.
        client: new AnthropicBedrock({
          awsRegion: process.env.AWS_REGION || 'ap-northeast-1',
          maxRetries: 0,
        }) as unknown as NonNullable<anthropic.LLMOptions['client']>,
      });
    case 'livekit':
      return new inference.LLM({
        model: config.model,
        // OpenAI 추론 모델은 도구를 쓰려면 reasoning_effort가 none이어야 합니다.
        ...(config.model.startsWith('openai/')
          ? { modelOptions: { reasoning_effort: 'none' } }
          : {}),
      });
  }
}

export function createTTS(config: TtsConfig): tts.TTS {
  switch (config.provider) {
    case 'elevenlabs':
      return new elevenlabs.TTS({
        model: config.model,
        language: 'ko',
        ...(config.voice ? { voiceId: config.voice } : {}),
      });
    case 'livekit':
      return new inference.TTS({
        model: config.model,
        language: 'ko',
        ...(config.voice ? { voice: config.voice } : {}),
      });
  }
}
