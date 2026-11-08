// 7장 실습: 말 끝 판단과 끼어들기의 "규칙"을 숫자로 확인합니다. 모델은 돌리지 않습니다.
//   1) 언어별 기준값: SDK의 ThresholdOptions를 그대로 써서 ko / 언어 모름 / 사용자 지정이 어떤 값이 되는지
//   2) 턴 확정 시각: audio_recognition.ts의 bounce 태스크 식을 옮겨, 예측·FINAL 도착 시각별로 언제 확정되는지
//   3) dynamic 모드: SDK의 DynamicEndpointing을 그대로 써서 쉼을 배울 때 minDelay가 어떻게 움직이는지
//   4) VAD 창 단위 문턱: 끼어들기(minDuration 200)와 "고객 조용함"(minDelay/2) 판정이 몇 번째 창에서 바뀌는지
//   5) minWords: SDK의 splitWords로 한국어 끼어들기 말이 몇 단어로 세지는지
//   6) 적응형 끼어들기 요청 크기: defaults.ts의 상수로 /bargein에 100ms마다 보내는 바이트 수
//
// 실행: 레포 루트에서  node docs/1-study/lab/07-turn-rules.mjs   (1초 안쪽)
// 기준: Node.js 24, @livekit/agents 1.9.5. 2026-11-06 작성. 키·네트워크·.env.local을 쓰지 않습니다.
// 출처 (node_modules/@livekit/agents/src/ 기준)
//   기준값        inference/eot/languages.ts 21~36·173~178
//   확정 시각     voice/audio_recognition.ts 1641·1690~1752·1871~1887, inference/eot/base.ts 24
//   dynamic      voice/turn_config/endpointing.ts 103~244, utils.ts 373~389 (ExpFilter.apply)
//   창 문턱       voice/agent_activity.ts 2198~2208, inference/vad.ts 345~417
//   minWords     voice/agent_activity.ts 2257~2268·2729~2751, tokenize/basic/word.ts 9~31
//   적응형        inference/interruption/defaults.ts 7~14, interruption_stream.ts 204~273·432~474, ws_transport.ts 385~420
import { inference, tokenize, voice } from '@livekit/agents';

const padW = (t, n) =>
  t +
  ' '.repeat(Math.max(0, n - [...t].reduce((w, c) => w + (c.charCodeAt(0) > 0x1100 ? 2 : 1), 0)));

// ── 1. 언어별 기준값 ────────────────────────────────────────────────────
console.log('1) 턴 감지 기준값 (unlikelyThreshold): inference.ThresholdOptions');
const mini = new inference.ThresholdOptions('turn-detector-v1-mini');
const langs = ['ko', 'ko-KR', 'Korean', undefined, '', 'xx', 'en', 'ja'];
console.log(
  `   v1-mini: ${langs.map((l) => `${l === undefined ? '(없음)' : l === '' ? "''" : l}=${mini.lookup(l)}`).join('  ')}`,
);
const cloud = new inference.ThresholdOptions('turn-detector-v1');
console.log(
  `   v1(클라우드) 서버 기준값을 받기 전: ko=${cloud.lookup('ko')}, 지원 여부=${cloud.supports('ko')} (서버가 SessionCreated로 보내면 채워짐)`,
);
const scalar = new inference.ThresholdOptions('turn-detector-v1-mini', 0.5);
const perLang = new inference.ThresholdOptions('turn-detector-v1-mini', { ko: 0.5 });
console.log(
  `   사용자 지정 숫자 0.5: ko=${scalar.lookup('ko')}, 언어 모름=${scalar.lookup(undefined)} / 언어별 {ko: 0.5}: ko=${perLang.lookup('ko')}, 언어 모름=${perLang.lookup(undefined)}`,
);

// ── 2. 턴 확정 시각 ─────────────────────────────────────────────────────
// bounce 태스크: (1) 걸어 둔 예측을 최대 1초 기다림 → (2) p < 기준이면 maxDelay, 아니면 minDelay
//               → (3) "마지막 말소리 + 대기"까지 잠. 이 레포는 VAD 말 끝에 글이 아직 없어 FINAL 도착이 bounce를 시작함.
function commitAt({ final, pred, p, minDelay = 300, maxDelay = 2500, threshold = 0.4 }) {
  const lastSpeaking = 0; // 모든 시각은 VAD가 거꾸로 맞춘 마지막 말소리부터 잰 ms
  const start = final; // trigger 'stt'
  const fromCache = pred <= start;
  const timedOut = !fromCache && pred - start > 1000; // DEFAULT_PREDICTION_TIMEOUT_MS
  const afterPred = fromCache ? start : timedOut ? start + 1000 : pred;
  const prob = timedOut ? undefined : p;
  const delay = prob !== undefined && prob < threshold ? maxDelay : minDelay;
  return { commit: Math.max(afterPred, lastSpeaking + delay), delay, fromCache, timedOut };
}
console.log('\n2) 턴 확정 시각 (마지막 말소리 = 0ms, VAD 말 끝·예측 요청·finalize = 256ms)');
console.log('   경우                                           예측 도착  FINAL 도착  p      대기   fromCache  확정');
const END = 256;
for (const [label, c] of [
  ['v1-mini, 확신 (FINAL 왕복 150ms 가정)', { pred: END + 30, final: END + 150, p: 0.65 }],
  ['v1-mini, 확신 없음', { pred: END + 30, final: END + 150, p: 0.15 }],
  ['FINAL이 아주 빨리 옴 (왕복 20ms)', { pred: END + 30, final: END + 20, p: 0.65 }],
  ['클라우드 예측이 FINAL보다 1.2초 늦음', { pred: END + 150 + 1200, final: END + 150, p: 0.65 }],
  ['finalize 없던 시절 (FINAL 1,260ms)', { pred: END + 30, final: 1260, p: 0.65 }],
  ['minDelay 400으로 올림', { pred: END + 30, final: END + 150, p: 0.65, minDelay: 400 }],
  ['minDelay 600으로 올림', { pred: END + 30, final: END + 150, p: 0.65, minDelay: 600 }],
]) {
  const r = commitAt(c);
  console.log(
    `   ${padW(label, 46)} ${String(c.pred).padStart(6)}ms  ${String(c.final).padStart(7)}ms  ${c.p.toFixed(2)}  ${String(r.delay).padStart(5)}  ${String(r.fromCache).padEnd(9)}  ${r.commit}ms${r.timedOut ? ' (시간 초과 → 예측 없이 minDelay, 클라우드면 v1-mini로 영구 전환)' : ''}`,
  );
}

// ── 3. dynamic 모드 ────────────────────────────────────────────────────
console.log("\n3) endpointing.mode 'dynamic': voice.DynamicEndpointing (minDelay 300, maxDelay 2500, alpha 0.9)");
const show = (ep, label) => console.log(`   ${padW(label, 56)} minDelay ${ep.minDelay.toFixed(1)}`);
let ep = new voice.DynamicEndpointing({ minDelay: 300, maxDelay: 2500, alpha: 0.9 });
ep.onStartOfSpeech(0);
ep.onEndOfSpeech(2000);
show(ep, '고객 말 0~2,000ms');
ep.onStartOfSpeech(2700);
ep.onEndOfSpeech(4000);
show(ep, '700ms 쉬고 이어 말함 (2,700~4,000)');
ep.onStartOfSpeech(4800);
ep.onEndOfSpeech(6000);
show(ep, '800ms 쉬고 이어 말함 (4,800~6,000)');
ep.onStartOfAgentSpeech(6500);
ep.onEndOfAgentSpeech(9000);
ep.onStartOfSpeech(9500);
ep.onEndOfSpeech(10500);
show(ep, '에이전트가 답한 뒤 고객이 말함 (쉼 사이에 에이전트 말)');
ep.onStartOfSpeech(10760);
ep.onEndOfSpeech(11500);
show(ep, '260ms 쉬고 이어 말함 (0.9 × 386 + 0.1 × 260)');
const mk = () => {
  const e = new voice.DynamicEndpointing({ minDelay: 300, maxDelay: 2500, alpha: 0.9 });
  e.onStartOfSpeech(0);
  e.onEndOfSpeech(2000);
  e.onStartOfAgentSpeech(2600); // 말 끝 600ms 뒤 에이전트가 말을 시작
  e.onStartOfSpeech(2700, true); // 고객이 700ms 쉬고(에이전트 시작 100ms 뒤) 이어 말함
  return e;
};
ep = mk();
ep.onEndOfSpeech(3500);
show(ep, '에이전트 시작 100ms 뒤 이어 말함, 에이전트 계속 말함');
ep = mk();
ep.onEndOfAgentSpeech(2950); // 끼어들기로 에이전트가 먼저 멈춤(일시정지)
ep.onEndOfSpeech(3500);
show(ep, '같은 상황, 끼어들기로 에이전트가 먼저 멈춤');
ep = new voice.DynamicEndpointing({ minDelay: 300, maxDelay: 2500, alpha: 0.9 });
ep.onStartOfSpeech(0);
let t = 1000;
ep.onEndOfSpeech(t);
const series = [];
for (let i = 0; i < 12; i++) {
  t += 2000;
  ep.onStartOfSpeech(t);
  t += 1000;
  ep.onEndOfSpeech(t);
  series.push(Math.round(ep.minDelay));
}
console.log(`   2,000ms 쉼을 12번 배우면: ${series.join(' → ')}`);

// ── 4. VAD 창 단위 문턱 ─────────────────────────────────────────────────
console.log('\n4) 32ms 창 단위로 본 문턱 (말 시작 = 말소리 창 연속 2개째 START, 5-4절)');
for (let k = 0; ; k++) {
  const speechDuration = 64 + 32 * k; // START 창부터 창마다 +32 (inference/vad.ts)
  if (speechDuration >= 200) {
    console.log(
      `   끼어들기 minDuration 200: START 뒤 ${k}번째 창에서 speechDuration ${speechDuration} ≥ 200 → 말소리 첫 창부터 ${speechDuration}ms째`,
    );
    break;
  }
}
for (let n = 1; ; n++) {
  const carried = (n - 1) * 32; // n번째 무음 창이 싣는 무음(이번 창을 더하기 전)
  if (carried > 300 / 2) {
    console.log(
      `   "고객 조용함" (실린 무음 > minDelay/2 = 150): ${n}번째 무음 창(실린 값 ${carried})에서 조용함 → 마지막 말소리 창 뒤 ${n * 32}ms`,
    );
    break;
  }
}

// ── 5. minWords ────────────────────────────────────────────────────────
console.log('\n5) minWords의 단어 세기 (tokenize.basic.splitWords(text, true): 공백으로 자르고 구두점을 뺌)');
for (const s of ['네', '아니요', '잠깐만요', '아니요.', '음...', '아니 잠깐만요', '네, 네.', '잠깐만요, 그게 아니라']) {
  const words = tokenize.basic.splitWords(s, true).map((w) => w[0]);
  console.log(
    `   ${padW(JSON.stringify(s), 26)} ${words.length}단어 ${JSON.stringify(words)}  minWords 2면 ${words.length < 2 ? '막힘' : '통과'}`,
  );
}

// ── 6. 적응형 끼어들기 요청 크기 ─────────────────────────────────────────
const SR = 16000;
const prefix = 1.0 * SR; // AUDIO_PREFIX_DURATION_IN_S
const maxSamples = 3.0 * SR; // MAX_AUDIO_DURATION_IN_S
const step = 0.1 * SR; // DETECTION_INTERVAL_IN_S
const startSpeech = Math.round(0.064 * SR); // VAD START 때 speechDuration 64ms
let window = startSpeech + prefix;
const sizes = [];
for (let i = 0; i < 25; i++) {
  window = Math.min(maxSamples, window + step);
  sizes.push(8 + window * 2); // 머리 8B(createdAt) + int16 PCM
}
const firstCap = sizes.findIndex((b) => b === 8 + maxSamples * 2);
const oneSec = sizes.slice(0, 10).reduce((a, b) => a + b, 0);
console.log('\n6) 적응형 끼어들기 /bargein 요청 크기 (16kHz int16, 100ms마다 그때까지의 창 전체를 보냄)');
console.log(
  `   첫 요청: (START 64ms ${startSpeech} + 앞 1초 ${prefix} + 100ms ${step})샘플 × 2B + 머리 8B = ${sizes[0].toLocaleString()}B`,
);
console.log(
  `   요청마다 +${(step * 2).toLocaleString()}B, ${firstCap + 1}번째 요청(겹침 약 ${((firstCap + 1) * 0.1).toFixed(1)}초)부터 3초 창 ${sizes[firstCap].toLocaleString()}B로 고정`,
);
console.log(`   겹침 1초(요청 10번) 동안 올려 보내는 양: ${oneSec.toLocaleString()}B`);
console.log(
  `   모델 프레임 25ms, 최소 ${Math.ceil(0.05 * 40)}프레임(50ms)을 min_frames로 서버에 보냄, 응답이 0.7초 넘게 없으면 다음 전송 때 408 오류`,
);
