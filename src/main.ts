import { ServerOptions, cli, defineAgent, inference, log, metrics, voice } from '@livekit/agents';
import { EnhancerModel, audioEnhancement } from '@livekit/plugins-ai-coustics';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createAgent } from './agent.ts';
import { parseCallContext } from './call-context.ts';
import { loadConfig } from './config.ts';
import { KEYTERMS } from './glossary.ts';
import { createLLM, createSTT, createTTS } from './models/index.ts';
import { FinalizingSonioxSTT } from './models/soniox.ts';
import { openingLine } from './prompt.ts';
import { pronunciationTransform } from './pronunciation.ts';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

export default defineAgent({
  entry: async (ctx) => {
    const config = loadConfig();
    const call = parseCallContext(ctx.job.metadata);
    log().info({ config, callId: call.callId }, '통화 시작');

    const stt = createSTT(config.stt);
    const session = new voice.AgentSession({
      stt,
      tts: createTTS(config.tts),

      // VAD는 넘기지 않으면 번들된 Silero(로컬 실행)가 자동으로 붙습니다.

      // Soniox는 자체 context.terms로 넣으므로 LiveKit Inference STT일 때만 씁니다.
      ...(config.stt.provider === 'livekit'
        ? { keytermsOptions: { keyterms: [...KEYTERMS] } }
        : {}),

      // 제품명을 한글 발음으로 바꾼 뒤 TTS에 넣습니다 (예: F2 울트라 → 에프투 울트라).
      ttsTextTransforms: ['filter_markdown', 'filter_emoji', pronunciationTransform],

      turnHandling: {
        // The LiveKit audio turn detector is built into the SDK (no extra plugin) and supports Korean.
        // See more at https://docs.livekit.io/agents/logic/turns/turn-detector/
        turnDetection: new inference.TurnDetector(),
        // Adaptive interruptions tell a real interruption from a backchannel like "네" or "음".
        // On by default on LiveKit Cloud and in dev mode; uncomment for self-hosted usage.
        // interruption: { mode: 'adaptive' },
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: { enabled: true },
      },
    });

    // 고객이 말을 멈추면(VAD) Soniox에 바로 확정을 요청합니다. 기다리지 않으면 가끔 1초 넘게 늦습니다.
    if (stt instanceof FinalizingSonioxSTT) {
      session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
        if (ev.oldState === 'speaking' && ev.newState === 'listening') stt.finalize();
      });
    }

    // 구간별 지연(STT 확정, LLM 첫 토큰, TTS 첫 음성, 말 끝 판단)을 통화마다 로그에 남깁니다.
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) =>
      metrics.logMetrics(ev.metrics),
    );

    await session.start({
      agent: createAgent({ call, llm: createLLM(config.llm) }),
      room: ctx.room,
      inputOptions: {
        // ai-coustics QUAIL audio enhancement for noise cancellation
        // Works for both WebRTC and telephony (SIP) participants
        noiseCancellation: audioEnhancement({ model: EnhancerModel.QuailVfS }),
      },
    });

    await ctx.connect();

    // AI·녹음 고지가 들어 있어 끝까지 들리도록 끼어들기를 막습니다.
    session.say(openingLine(call), { allowInterruptions: false });
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'xtool-sales-agent',
  }),
);
