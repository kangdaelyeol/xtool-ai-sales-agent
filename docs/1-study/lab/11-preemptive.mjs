// 11장 실습: 선제 생성(preemptive generation)의 상태 전이를 SDK의 실제 코드로 재현합니다 (학습서 11-4절 깊이 보기).
//   STT 이벤트 → AudioRecognition.processSTTEvent (실제)        PREFLIGHT·FINAL마다 선제 생성을 부를지
//             → AgentActivity.onPreemptiveGeneration (실제)    ① 앞 시도 취소 → ② 길이·횟수 검사 → ③ 새 시도
//   턴 확정    → AgentActivity.userTurnCompleted (실제)          훅 → 재사용 검사 → 재사용 또는 새 generateReply
// 를 SDK 자체 테스트처럼 "가짜 this"로 잇고, generateReply만 "LLM 요청 1회"를 세는 가짜로 바꿉니다.
// 훅은 이 프로젝트의 보정(src/transcript.ts의 correctTranscript)을 그대로 씁니다. 즉시 반응 say()는 뺐습니다.
// 끝의 H는 "취소된 시도의 요청이 어떻게 되는가"를 가짜 Anthropic 서버(127.0.0.1)로 봅니다(취소가 전해지는 사슬은 12장).
//
// 실행 (레포 루트에서):  node docs/1-study/lab/11-preemptive.mjs   (2초 남짓)
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/agents-plugin-anthropic 1.9.5 (2026-11-06).
// 키·.env.local·외부 네트워크를 쓰지 않습니다(H의 API 키는 가짜 문자열, baseURL은 127.0.0.1).
// 시각은 Date.now를 가상 시계로 바꿔 정합니다(마지막 말소리 = 0ms). STT 이벤트의 시각과 글은 가정입니다.
// 같은 글의 PREFLIGHT가 되풀이되는 경우(시나리오 B)는 Soniox가 새 토큰 없는 메시지를 보낼 때 생기는데,
// 서버가 실제로 그렇게 보내는지는 확인하지 않았습니다(플러그인 코드상 가능: soniox/_internal.ts 315~339).
// 내부 파일(dist/voice/*.js)을 경로로 불러오므로 SDK 버전이 바뀌면 깨질 수 있습니다.
//
// 출처 (node_modules/@livekit/agents/src/ 기준)
//   PREFLIGHT·FINAL → 선제 생성     voice/audio_recognition.ts 1347~1372·1384~1435
//   선제 생성 시작 규칙             voice/agent_activity.ts 2445~2508, 기본값 voice/turn_config/preemptive_generation.ts 38~43
//   재사용 검사                     voice/agent_activity.ts 3336·3489~3540, transcriptsEquivalent 210~228
import { initializeLogger, llm, stt, voice } from '@livekit/agents';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { VoiceAnthropicLLM } from '../../../src/models/anthropic.ts';
import { correctTranscript } from '../../../src/transcript.ts';

initializeLogger({ pretty: false, level: 'silent' });

const base = import.meta.resolve('@livekit/agents');
const { AgentActivity } = await import(new URL('./voice/agent_activity.js', base));
const { AudioRecognition, _computeEndOfTurnMetrics } = await import(
  new URL('./voice/audio_recognition.js', base)
);
const { Future } = await import(new URL('./utils.js', base));
const { Heap } = createRequire(new URL(base))('heap-js');
const { SpeechHandle } = voice;
const { SpeechEventType } = stt;

// 가상 시계: SDK가 쓰는 Date.now()를 우리가 정한 시각으로 (마지막 말소리 = 0)
const T_ZERO = 1_800_000_000_000;
let clock = T_ZERO;
const DateNow = Date.now;
Date.now = () => clock;
const rel = () => clock - T_ZERO;

class FakeLLM extends llm.LLM {
  label() {
    return 'lab.FakeLLM';
  }
  chat() {
    throw new Error('이 실습에서는 부르지 않음 (generateReply를 가짜로 바꿈)');
  }
}

const pad = (s, n) =>
  s + ' '.repeat(Math.max(0, n - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 0x1100 ? 2 : 1), 0)));

function makeTurn({ speechStartedAt = -2000, currentSpeech } = {}) {
  const logs = [];
  const requests = [];
  const logger = {
    debug: (a, b) => logs.push([rel(), typeof a === 'string' ? a : b, typeof a === 'string' ? {} : a]),
    trace() {},
    error() {},
  };
  logger.info = logger.debug;
  logger.warn = logger.debug;
  const emitted = [];
  const agentChatCtx = llm.ChatContext.empty();
  agentChatCtx.addMessage({ role: 'assistant', content: '이삼 분 정도 통화 괜찮으실까요?' });

  const act = {
    _preemptiveGenerationCount: 0,
    _preemptiveGeneration: undefined,
    _currentSpeech: currentSpeech,
    _schedulingPaused: false,
    newTurnsBlocked: false,
    llm: new FakeLLM(),
    tools: llm.ToolContext.empty(),
    toolChoice: null,
    realtimeSession: undefined,
    rtTurnDetectionEnabled: false,
    speechQueue: new Heap(([p1, t1], [p2, t2]) => (p1 === p2 ? t1 - t2 : p2 - p1)),
    q_updated: new Future(),
    _mainTask: undefined,
    agent: {
      id: 'lab',
      chatCtx: agentChatCtx,
      // 이 프로젝트의 훅에서 보정 부분만 (src/agent.ts)
      onUserTurnCompleted: async (_chatCtx, newMessage) => {
        newMessage.content = newMessage.content.map((p) =>
          typeof p === 'string' ? correctTranscript(p) : p,
        );
      },
    },
    agentSession: {
      sessionOptions: {
        turnHandling: {
          preemptiveGeneration: { enabled: true, preemptiveTts: false, maxSpeechDuration: 10_000, maxRetries: 3 },
        },
      },
      emit: (_type, ev) => emitted.push(ev),
      rootSpanContext: undefined,
      _redactionEnabled: false,
      _closing: false,
    },
    logger,
    cancelSpeechPause: async () => {},
    // LLM 요청 1회 = generateReply 1회 (실제로는 llm.chat() → messages.create 한 번)
    generateReply: (opts) => {
      const handle = SpeechHandle.create();
      requests.push({
        at: rel(),
        text: opts.userMessage?.textContent, // 요청을 보낸 순간의 글
        message: opts.userMessage, // 나중에 SDK가 내용을 바꿔 끼우는지 보려고 객체도 둠
        preemptive: opts.scheduleSpeech === false,
        handle,
      });
      if (opts.scheduleSpeech !== false) {
        AgentActivity.prototype.scheduleSpeech.call(act, handle, SpeechHandle.SPEECH_PRIORITY_NORMAL);
      }
      return handle;
    },
  };
  Object.setPrototypeOf(act, AgentActivity.prototype);

  const ar = {
    inputStartedAt: undefined,
    sttAlignedTranscript: false,
    vad: {},
    lastSpeakingTime: T_ZERO, // VAD가 거꾸로 맞춘 마지막 말소리 (7장)
    turnDetectionMode: undefined, // 오디오 턴 감지 모델 객체를 쓰면 문자열 모드는 undefined (agent_activity.ts 691~692)
    speaking: true,
    isAgentSpeaking: false,
    hooks: {
      onFinalTranscript() {},
      onInterimTranscript() {},
      onPreemptiveGeneration: (info) => AgentActivity.prototype.onPreemptiveGeneration.call(act, info),
      retrieveChatCtx: () => agentChatCtx,
    },
    logger,
    lastFinalTranscriptTime: 0,
    audioTranscript: '',
    audioInterimTranscript: '',
    audioPreflightTranscript: '',
    finalTranscriptConfidence: [],
    userTurnLimit: undefined,
    speechStartTime: T_ZERO + speechStartedAt,
    userTurnCommitted: false,
    lastLanguage: undefined,
    runEOUDetection: () => logs.push([rel(), '(말 끝 판정 시작: runEOUDetection)', {}]),
  };
  Object.setPrototypeOf(ar, AudioRecognition.prototype);

  const sttEvent = (type, text) =>
    AudioRecognition.prototype.processSTTEvent.call(ar, {
      type,
      alternatives: [{ text, confidence: 0.9, language: 'ko', startTime: 0, endTime: 0, speakerId: null }],
    });

  return {
    act,
    ar,
    logs,
    requests,
    emitted,
    at(ms) {
      clock = T_ZERO + ms;
    },
    preflight: (text) => sttEvent(SpeechEventType.PREFLIGHT_TRANSCRIPT, text),
    interim: (text) => sttEvent(SpeechEventType.INTERIM_TRANSCRIPT, text),
    final: (text) => {
      ar.speaking = false; // VAD 말 끝(256ms) 뒤에 FINAL이 옴
      sttEvent(SpeechEventType.FINAL_TRANSCRIPT, text);
    },
    /** audio_recognition의 확정 경로(1904~1950)처럼 EndOfTurnInfo를 만들어 넘깁니다. */
    async commit() {
      const m = _computeEndOfTurnMetrics({
        speechStartTime: ar.speechStartTime,
        lastSpeakingTime: ar.lastSpeakingTime,
        lastFinalTranscriptTime: ar.lastFinalTranscriptTime,
        now: Date.now(),
      });
      const info = {
        newTranscript: ar.audioTranscript,
        transcriptConfidence: 0.9,
        transcriptionDelay: m.transcriptionDelay,
        endOfUtteranceDelay: m.endOfUtteranceDelay,
        startedSpeakingAt: m.startedSpeakingAt,
        stoppedSpeakingAt: m.stoppedSpeakingAt,
        skipReply: false,
      };
      logs.push([rel(), '턴 확정 → userTurnCompleted', {}]);
      await AgentActivity.prototype.userTurnCompleted.call(act, info);
      ar.audioTranscript = '';
      ar.finalTranscriptConfidence = [];
    },
  };
}

async function scenario(title, opts, steps) {
  const turn = makeTurn(opts);
  const timeline = [];
  for (const [ms, kind, text] of steps) {
    turn.at(ms);
    const before = turn.requests.length;
    const prev = turn.act._preemptiveGeneration?.speechHandle;
    const countBefore = turn.act._preemptiveGenerationCount;
    if (kind === 'commit') await turn.commit();
    else turn[kind](text);
    const made = turn.requests.length - before;
    const cancelledPrev = prev !== undefined && prev.interrupted;
    let note = '';
    if (kind === 'preflight' || kind === 'final') {
      const triggered = turn.logs.some(
        ([t, msg]) => t === ms && msg?.startsWith('triggering preemptive generation'),
      );
      if (!triggered) note = '선제 생성 안 부름 (FINAL 글 = 마지막 PREFLIGHT 글)';
      else if (made) note = `시도 ${turn.act._preemptiveGenerationCount} 시작${cancelledPrev ? ', 앞 시도 취소' : ''}`;
      else if (turn.act._preemptiveGenerationCount === countBefore && turn.act._currentSpeech && !cancelledPrev)
        note = '재생 중인 발화가 있어 아무것도 안 함 (앞 시도도 그대로)';
      else {
        const why =
          countBefore >= 3 ? `횟수 ${countBefore}/3 소진` : `말 시작부터 ${ms - (opts.speechStartedAt ?? -2000)}ms > 10,000ms`;
        note = `새 시도 없음 (${why})${cancelledPrev ? ', 그런데 앞 시도는 취소됨' : ''}`;
      }
    } else if (kind === 'commit') {
      const used = turn.logs.find(([t, msg]) => t === ms && msg === 'using preemptive generation');
      const invalid = turn.logs.find(([t, msg]) => t === ms && msg?.startsWith('preemptive generation invalidated'));
      if (used) note = `선제 결과 재사용 (preemptiveLeadTime ${used[2].preemptiveLeadTime}ms)`;
      else if (invalid) note = '재사용 검사 실패 → 선제 결과 취소, 새 generateReply';
      else note = '쓸 선제 결과 없음 → 새 generateReply';
    }
    const label = kind === 'commit' ? '턴 확정' : kind.toUpperCase();
    timeline.push(`   ${String(ms).padStart(6)}ms  ${pad(label, 9)} ${pad(text ? `"${text}"` : '', 40)} ${note}`);
  }
  const reqs = turn.requests;
  const cancelled = reqs.filter((r) => r.handle.interrupted).length;
  const answering = reqs.find((r) => !r.handle.interrupted);
  console.log(`\n${title}`);
  for (const line of timeline) console.log(line);
  console.log(
    `   → LLM 요청 ${reqs.length}회 (선제 ${reqs.filter((r) => r.preemptive).length}, 취소 ${cancelled}). ` +
      `답을 만드는 요청: ${answering ? `${answering.at}ms에 시작, 글 "${answering.text}"` : '없음'}`,
  );
  return turn;
}

console.log('선제 생성 상태 전이 (SDK 코드, 가상 시계: 마지막 말소리 = 0ms, VAD 말 끝·finalize = 256ms, FINAL = 406ms 가정)');

await scenario('A. 글이 자라다가 마지막 PREFLIGHT와 FINAL이 같은 턴 (가장 이득이 큰 경우)', {}, [
  [-1400, 'preflight', '네 맞아요.'],
  [-700, 'interim', '네 맞아요. 가죽 지갑에'],
  [-150, 'preflight', '네 맞아요. 가죽 지갑에 각인하려고요.'],
  [406, 'final', '네 맞아요. 가죽 지갑에 각인하려고요.'],
  [406, 'commit'],
]);

await scenario('B. 같은 글의 PREFLIGHT가 세 번 온 뒤 FINAL 글이 다른 턴 (시도 소진)', {}, [
  [-500, 'preflight', '네 맞아요. 가죽 지갑에'],
  [-400, 'preflight', '네 맞아요. 가죽 지갑에'],
  [-300, 'preflight', '네 맞아요. 가죽 지갑에'],
  [406, 'final', '네 맞아요. 가죽 지갑에 각인하려고요.'],
  [406, 'commit'],
]);

await scenario('C. 마지막 PREFLIGHT와 FINAL이 다른 턴 (FINAL이 새 시도를 띄움, 리드 타임 0)', {}, [
  [-1400, 'preflight', '네 맞아요.'],
  [406, 'final', '네 맞아요. 가죽 지갑에 각인하려고요.'],
  [406, 'commit'],
]);

await scenario('D. 훅의 보정이 글자를 바꾸는 턴 (메탈 백 → 메탈팹)', {}, [
  [-150, 'preflight', '메탈 백이랑 피쓰리도 보고 있어요.'],
  [406, 'final', '메탈 백이랑 피쓰리도 보고 있어요.'],
  [406, 'commit'],
]);

const e = await scenario('E. 훅의 보정이 대소문자만 바꾸는 턴 (p3 → P3)', {}, [
  [-150, 'preflight', 'p3도 보고 있어요.'],
  [406, 'final', 'p3도 보고 있어요.'],
  [406, 'commit'],
]);
const reused = e.requests[0];
console.log(
  `   요청에 실린 글 "${reused.text}" / 그 메시지 객체의 지금 글 "${reused.message.textContent}"` +
    ' (재사용 때 SDK가 내용을 훅이 고친 글로 바꿔 끼우고, 이 객체가 대화 기록에 들어감: agent_activity.ts 3504~3511·4028~4031)',
);

await scenario('F. 말을 시작한 지 10초가 넘은 턴 (maxSpeechDuration)', { speechStartedAt: -10_500 }, [
  [-1400, 'preflight', '그러니까 저희가 작년부터'],
  [-150, 'preflight', '그러니까 저희가 작년부터 가죽 공방을 하는데요.'],
  [406, 'final', '그러니까 저희가 작년부터 가죽 공방을 하는데요.'],
  [406, 'commit'],
]);

const playing = SpeechHandle.create({ allowInterruptions: true });
await scenario(
  'G. 에이전트 발화가 재생 중(끼어들기로 일시정지 포함, 중단 아님)인 턴',
  { currentSpeech: playing },
  [
    [-300, 'preflight', '아니 잠깐만요.'],
    [406, 'final', '아니 잠깐만요.'],
  ],
);

console.log('\nEOU 지표 (시나리오 A의 확정에서 세션이 낸 값, ms)');
const a = makeTurn();
a.at(-150);
a.preflight('네 맞아요.');
a.at(406);
a.final('네 맞아요.');
await a.commit();
const eou = a.emitted.find((ev) => ev.metrics?.type === 'eou_metrics')?.metrics;
console.log(
  `   endOfUtteranceDelayMs ${eou.endOfUtteranceDelayMs}, transcriptionDelayMs ${eou.transcriptionDelayMs}, ` +
    `onUserTurnCompletedDelayMs ${eou.onUserTurnCompletedDelayMs}`,
);

// ── H. 취소된 시도의 HTTP 요청은 어떻게 되나 (가짜 Anthropic 서버) ─────────────────
// 선제 시도를 버릴 때 SDK는 결국 LLMStream.close()에 닿습니다(Agent.default.llmNode의 cleanup, voice/agent.ts 570~589).
// 그 순간 서버 쪽 응답이 끊기는지 봅니다. 서버는 50ms마다 글 조각을 20개 보냅니다.
Date.now = DateNow;
const sse = (o) => `event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h0 = performance.now();
const H = () => Math.round(performance.now() - h0);
const srv = { written: 0, finishedAt: null, closedAt: null };
const server = createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    res.on('close', () => (srv.closedAt ??= H()));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      sse({
        type: 'message_start',
        message: { id: 'msg_lab', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [],
          stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } },
      }),
    );
    res.write(sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    for (let i = 0; i < 20; i++) {
      await sleep(50);
      if (res.destroyed) return;
      res.write(sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `조각${i} ` } }));
      srv.written += 1;
    }
    res.write(sse({ type: 'content_block_stop', index: 0 }));
    res.write(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } }));
    res.write(sse({ type: 'message_stop' }));
    res.end();
    srv.finishedAt = H();
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const real = new VoiceAnthropicLLM({
  model: 'claude-haiku-5-5',
  effort: 'low',
  thinking: 'off',
  apiKey: 'sk-ant-fake-key-for-lab',
  baseURL: `http://127.0.0.1:${server.address().port}`,
});
const gotMetrics = new Promise((r) => real.once('metrics_collected', (m) => r({ m, at: H() })));
const hctx = llm.ChatContext.empty();
hctx.addMessage({ role: 'user', content: '네 맞아요.' });
const llmStream = real.chat({ chatCtx: hctx });
console.log('\nH. 취소된 시도의 요청 (가짜 서버: 50ms마다 글 조각, 모두 20개)');
for await (const c of llmStream) {
  console.log(`   ${String(H()).padStart(5)}ms  첫 글 조각 ${JSON.stringify(c.delta?.content)} → 바로 LLMStream.close() (시도 취소)`);
  break;
}
llmStream.close();
const { m: hm, at: hmAt } = await gotMetrics;
await sleep(1300);
console.log(`   ${String(hmAt).padStart(5)}ms  LLMMetrics 나옴: cancelled ${hm.cancelled}, ttftMs ${hm.ttftMs}`);
console.log(
  `   서버가 보낸 글 조각 ${srv.written}/20, 응답을 끝까지 쓴 시각 ${srv.finishedAt}ms, 연결이 닫힌 시각 ${srv.closedAt}ms`,
);
server.close();
