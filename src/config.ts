// 부품 선택. STT·LLM·TTS를 환경변수로 바꿔 끼웁니다 (docs/poc-setup.md 3장).
// `livekit`은 LiveKit Inference(LiveKit Cloud 크레딧, 별도 키 없음)를 뜻합니다.

export type SttProvider = 'soniox' | 'livekit';
export type LlmProvider = 'anthropic' | 'bedrock' | 'livekit';
export type TtsProvider = 'elevenlabs' | 'livekit';
export type Effort = 'low' | 'medium' | 'high';
export type ThinkingMode = 'off' | 'adaptive';

export interface SttConfig {
  provider: SttProvider;
  model: string;
}

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  /** Anthropic·Bedrock 전용. Haiku 5.5 기본값은 medium이라 음성용으로 낮춥니다. */
  effort: Effort;
  /** Anthropic·Bedrock 전용. off는 thinking: { type: 'disabled' } (effort high 이하에서만 허용). */
  thinking: ThinkingMode;
}

export interface TtsConfig {
  provider: TtsProvider;
  model: string;
  /** ElevenLabs voice id 또는 LiveKit Inference voice. 비우면 공급사 기본 음성(영어)입니다. */
  voice?: string;
}

export interface Config {
  stt: SttConfig;
  llm: LlmConfig;
  tts: TtsConfig;
}

const DEFAULT_MODELS = {
  stt: { soniox: 'stt-rt-v5', livekit: 'deepgram/nova-3' },
  // Bedrock은 일본 안(도쿄·오사카)에서만 처리하는 jp. 교차 리전 프로필입니다 (docs/poc-results.md 7장).
  llm: {
    anthropic: 'claude-haiku-5-5',
    bedrock: 'jp.anthropic.claude-haiku-5-5',
    livekit: 'openai/gpt-6-luna',
  },
  tts: { elevenlabs: 'eleven_v4_turbo', livekit: 'cartesia/sonic-3.6' },
} as const;

function pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = process.env[name];
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name}=${value}: ${allowed.join(', ')} 중 하나여야 합니다`);
}

/** dotenv를 읽은 뒤에 호출합니다 (import 시점에는 .env.local이 아직 안 읽혀 있음). */
export function loadConfig(): Config {
  const stt = pick('STT_PROVIDER', ['soniox', 'livekit'], 'soniox');
  const llm = pick('LLM_PROVIDER', ['anthropic', 'bedrock', 'livekit'], 'anthropic');
  const tts = pick('TTS_PROVIDER', ['elevenlabs', 'livekit'], 'elevenlabs');
  const voice = process.env.TTS_VOICE;

  return {
    stt: { provider: stt, model: process.env.STT_MODEL || DEFAULT_MODELS.stt[stt] },
    llm: {
      provider: llm,
      model: process.env.LLM_MODEL || DEFAULT_MODELS.llm[llm],
      effort: pick('LLM_EFFORT', ['low', 'medium', 'high'], 'low'),
      thinking: pick('LLM_THINKING', ['off', 'adaptive'], 'off'),
    },
    tts: {
      provider: tts,
      model: process.env.TTS_MODEL || DEFAULT_MODELS.tts[tts],
      ...(voice ? { voice } : {}),
    },
  };
}
