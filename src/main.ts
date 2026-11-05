import { ServerOptions, cli, defineAgent, inference, log, metrics, voice } from '@livekit/agents';
import { EnhancerModel, audioEnhancement } from '@livekit/plugins-ai-coustics';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { AckAudioCache } from './ack-audio.ts';
import { createAgent } from './agent.ts';
import { parseCallContext } from './call-context.ts';
import { USER_AWAY_TIMEOUT_SEC, guardCall } from './call-guard.ts';
import { addLatency, emptyLatency, submitCallResult, transcriptOf } from './call-result.ts';
import { loadConfig } from './config.ts';
import { KEYTERMS } from './glossary.ts';
import { loadKnowledge } from './knowledge.ts';
import { createLLM, createSTT, createTTS } from './models/index.ts';
import { FinalizingSonioxSTT } from './models/soniox.ts';
import { OPENING_QUESTION, openingNotice } from './prompt.ts';
import { pronunciationTransform } from './pronunciation.ts';

// Load environment variables from a local file.
// Make sure to set LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET
// when running locally or self-hosting your agent server.
dotenv.config({ path: '.env.local' });

// 상담팀이 채우는 회사·기기 정보. 워커가 뜰 때 한 번 읽습니다(바꾸면 워커를 다시 시작).
const knowledge = loadKnowledge();

export default defineAgent({
  entry: async (ctx) => {
    const config = loadConfig();
    const call = parseCallContext(ctx.job.metadata);
    log().info({ config, callId: call.callId }, '통화 시작');

    const stt = createSTT(config.stt);
    const tts = createTTS(config.tts);
    // 즉시 반응 음성을 첫 멘트와 함께 미리 만들어 둡니다(약 1초). 그 전에 필요하면 평소처럼 합성합니다.
    // 세션과 다른 TTS 객체로 만들어, 미리 합성한 몫이 통화 지연 기록(call-result.ts)에 섞이지 않게 합니다.
    const ackAudio = new AckAudioCache();
    const ackTts = createTTS(config.tts);
    void ackAudio
      .preload(ackTts)
      .then(() => ackTts.close())
      .catch((error) => log().warn({ error }, '즉시 반응용 TTS를 닫지 못했습니다'));
    const session = new voice.AgentSession({
      stt,
      tts,

      // VAD는 넘기지 않으면 번들된 Silero(로컬 실행)가 자동으로 붙습니다.

      // 이만큼 조용하면 고객 상태가 away가 되고, call-guard.ts가 "여보세요?"를 합니다.
      userAwayTimeout: USER_AWAY_TIMEOUT_SEC,

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
        // On by default on LiveKit Cloud and in dev mode; for self-hosted usage add mode: 'adaptive'
        // to the interruption options below.
        // Allow the LLM to generate a response while waiting for the end of turn
        preemptiveGeneration: { enabled: true },
        // 끼어들기로 인정하는 최소 길이 (기본 0.5초). "아니요", "잠깐만요"에 빨리 멈추도록 0.2초로 둡니다
        // (0.3초에서 멈추기까지 약 0.4초 걸려 2026-11-04 줄임). 맞장구("네", "음")는 끼어들기 구분 모델이
        // 거르지만, 맞장구에도 자꾸 멈추면 250으로 올립니다. 0.2초 아래는 기침·숨소리에도 끊깁니다.
        // 끼어들기를 막은 말(AI·녹음 고지) 중에 고객이 한 말은 버리지 않고 고지가 끝난 뒤 처리합니다.
        // 기본값(버림)이면 고지 중의 "전화하지 마세요"를 못 듣습니다 (2026-11-03 시뮬레이션에서 발견).
        interruption: { minDuration: 200, discardAudioIfUninterruptible: false },
      },
    });

    // 고객이 말을 멈추면(VAD) Soniox에 바로 확정을 요청합니다. 기다리지 않으면 가끔 1초 넘게 늦습니다.
    if (stt instanceof FinalizingSonioxSTT) {
      session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
        if (ev.oldState === 'speaking' && ev.newState === 'listening') stt.finalize();
      });
    }

    // 끼어들기 판단을 남깁니다. AI가 말할 때 고객 말이 겹치면 맞장구인지 끼어들기인지 모델이 가르고,
    // 끼어들었는데 고객 말이 이어지지 않으면(잡음·숨소리) 하던 말을 다시 잇습니다. 안 끊길 때 원인을 봅니다.
    session.on(voice.AgentSessionEventTypes.OverlappingSpeech, (ev) => {
      log().info(
        {
          probability: Number(ev.probability.toFixed(2)),
          detectionDelayMs: Math.round(ev.detectionDelayInS * 1000),
        },
        ev.isInterruption ? '겹친 말: 끼어들기로 판단(멈춤)' : '겹친 말: 맞장구로 판단(계속 말함)',
      );
    });
    session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, (ev) => {
      log().info({ resumed: ev.resumed }, '끼어들기 취소: 고객 말이 이어지지 않아 하던 말을 이음');
    });

    // 구간별 지연(STT 확정, LLM 첫 토큰, TTS 첫 음성, 말 끝 판단)을 통화마다 로그에 남깁니다.
    // 통화 결과에도 실어 보내 Firestore에 남깁니다(통화별 병목 확인).
    const latency = emptyLatency();
    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      metrics.logMetrics(ev.metrics);
      addLatency(latency, ev.metrics);
    });

    // 통화가 끝나면 대화록을 functions-xtool에 보냅니다(요약·판정은 거기서). 끝난 이유는 종료 경로마다 남깁니다.
    const startedAt = Date.now();
    let endReason = 'disconnected';
    session.on(voice.AgentSessionEventTypes.Close, (ev) => {
      if (endReason === 'disconnected' && ev.reason) endReason = String(ev.reason);
    });
    ctx.addShutdownCallback(async () => {
      await submitCallResult({
        call,
        startedAt,
        endedAt: Date.now(),
        endReason,
        transcript: transcriptOf(session.history),
        latency,
      }).catch((error) => log().error({ error }, '통화 결과를 보내지 못했습니다'));
    });

    await session.start({
      agent: createAgent({ call, llm: createLLM(config.llm), ackAudio, knowledge }),
      room: ctx.room,
      inputOptions: {
        // ai-coustics QUAIL audio enhancement for noise cancellation
        // Works for both WebRTC and telephony (SIP) participants
        noiseCancellation: audioEnhancement({ model: EnhancerModel.QuailVfS }),
        // 세션이 닫히면 어떤 경로든 방을 지웁니다(전화면 끊김). 고객이 먼저 나갔을 때 에이전트만 남은 방이
        // 유예 시간 뒤에 닫히기를 기다리지 않고 잡이 바로 끝나, 통화 결과도 바로 보냅니다.
        deleteRoomOnClose: true,
      },
    });

    await ctx.connect();

    // 정해진 멘트를 끝까지 말한 뒤 통화를 끝냅니다. 방은 세션이 닫힐 때 지워집니다(deleteRoomOnClose).
    // AI가 스스로 끊을 때는 end_call 도구(agent.ts)가 같은 일을 합니다.
    let ending = false;
    const endCall = async (goodbye: string, reason: string) => {
      if (ending) return;
      ending = true;
      endReason = reason;
      log().info({ callId: call.callId, reason }, '통화 종료');
      await session.say(goodbye, { allowInterruptions: false }).waitForPlayout();
      ctx.shutdown(reason);
    };
    guardCall(session, endCall);

    // AI·녹음 고지는 끝까지 들리도록 끼어들기를 막고, 이어지는 질문은 바로 답할 수 있게 엽니다.
    session.say(openingNotice(call), { allowInterruptions: false });
    session.say(OPENING_QUESTION, { allowInterruptions: true });
  },
});

// Run the agent server
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: 'xtool-sales-agent',
  }),
);
