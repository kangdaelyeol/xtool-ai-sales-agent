// 7장 실습: 로컬 턴 감지 모델(v1-mini)이 쉼 동안 내는 "말이 끝났을 확률"을 100ms마다 찍어 곡선으로 보고,
// 이 레포와 같은 VAD로 SDK가 실제로 예측을 묻는 순간(무음 8창째)의 확률과 그 결과(300ms / 2,500ms 대기)를 봅니다.
// 문장이 끝난 쉼("…하려고요.")과 생각하는 쉼("예산은", "…하는데", "음")을 비교하고, 요청 근처를 10ms 단위로 봐서
// 창 위치와 리샘플 디더가 p를 얼마나 흔드는지 잽니다. 마지막으로 SDK의 TurnDetector 스트림(LocalTransport)을
// 가짜 실행기로 돌려, SDK 경로에서도 같은 범위의 확률이 나오는지 확인합니다.
//
// 실행: 레포 루트에서  node docs/1-study/lab/07-eot-curve.mjs   (약 20초, 대부분 `say` 합성)
//       리샘플러 디더와 VAD 창 위치가 실행마다 달라, 3)~5)의 숫자는 실행마다 조금씩(경계 근처는 판정까지) 달라집니다.
// 기준: Node.js 24, @livekit/agents 1.9.5, @livekit/local-inference 0.2.7. 2026-11-06 작성.
//       음성은 macOS `say -v Yuna`(합성 음성이라 사람 말과 운율이 다름). 키·네트워크·.env.local을 쓰지 않습니다.
//       모델은 네이티브 모듈 안에서 로컬로 돕니다(클라우드 v1은 부르지 않음).
//
// SDK에서 따라 한 곳 (node_modules/@livekit/agents/src/ 기준)
//   입력 준비     inference/eot/base.ts 332~363 (QUICK 리샘플로 16kHz), transports.ts 85~133 (최근 1.2초 고리 버퍼)
//   요청          transports.ts 170~219 (스냅숏 → base64 → executor.doInference), runner.ts 55~71 (base64 → predict)
//   요청 시점     voice/audio_recognition.ts 2197~2204 (실린 무음 ≥ 200ms이고 말하는 중), inference/eot/base.ts 23
//   판정          voice/audio_recognition.ts 1746~1752 (p < 기준이면 maxDelay, 아니면 minDelay)
import { inference } from '@livekit/agents';
import { AudioFrame, AudioResampler, AudioResamplerQuality, dispose } from '@livekit/rtc-node';
import { koreanSpeech } from './02-wav.mjs';
import { native, runVad } from './05-vad-run.mjs';

const RATE = 24000; // 방에서 워커로 들어오는 소리 (2장)
const EOT_RATE = 16000;
const EOT_SAMPLES = 19200; // 1.2초 (transports.ts 86~87)
const KO = 0.4; // v1-mini 한국어 기준 (inference/eot/languages.ts 31)
const MIN_DELAY = 300; // 턴 감지 모델과 함께일 때의 기본값 (voice/turn_config/endpointing.ts 50~55)
const MAX_DELAY = 2500;
const PAUSE_MS = 1500;
const padW = (t, n) =>
  t +
  ' '.repeat(Math.max(0, n - [...t].reduce((w, c) => w + (c.charCodeAt(0) > 0x1100 ? 2 : 1), 0)));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** 합성한 말의 앞뒤 무음을 파형 기준(10ms RMS > −50dBFS)으로 잘라, "말 끝" 시각을 파형으로 정합니다. */
function speechOnly(text) {
  const { pcm, source } = koreanSpeech(text);
  const f = RATE / 100;
  let on = -1;
  let off = -1;
  for (let i = 0; i + f <= pcm.length; i += f) {
    let e = 0;
    for (let j = 0; j < f; j++) e += pcm[i + j] ** 2;
    if (10 * Math.log10(e / f / 32768 ** 2 + 1e-20) > -50) {
      if (on < 0) on = i;
      off = i + f;
    }
  }
  return { pcm: pcm.slice(on, off), source };
}

/** SDK의 턴 감지 스트림과 같은 방법(QUICK, 10ms 프레임)으로 24kHz → 16kHz. */
function to16k(pcm24) {
  const rs = new AudioResampler(RATE, EOT_RATE, 1, AudioResamplerQuality.QUICK);
  const parts = [];
  const f = RATE / 100;
  for (let i = 0; i + f <= pcm24.length; i += f)
    for (const fr of rs.push(new AudioFrame(pcm24.slice(i, i + f), RATE, 1, f)))
      parts.push(fr.data.slice());
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const times = [];
/** 스트림 시각 tMs까지 들어온 16kHz 소리 중 최근 1.2초로 예측합니다. LocalTransport의 스냅숏과 같은 창입니다. */
async function predictAt(p16, tMs) {
  const end = Math.min(p16.length, Math.round((tMs / 1000) * EOT_RATE));
  const win = p16.slice(Math.max(0, end - EOT_SAMPLES), end);
  const t0 = performance.now();
  const p = await native.predict(win);
  times.push(performance.now() - t0);
  return p;
}

// ── 0. 모델의 계약 ─────────────────────────────────────────────────────
const rss0 = process.memoryUsage().rss;
native.initEot(); // 추론 프로세스가 시작할 때 하는 일 (runner.ts 41~53)
const rss1 = process.memoryUsage().rss;
console.log('0) 모델의 계약 (@livekit/local-inference predict)');
console.log(
  `   initEot() 전후 RSS ${Math.round(rss0 / 2 ** 20)} → ${Math.round(rss1 / 2 ** 20)}MB (+${Math.round((rss1 - rss0) / 2 ** 20)}MB)`,
);
const zeros = new Int16Array(EOT_SAMPLES);
const long = new Int16Array(40000);
let tooLong = '';
try {
  await native.predict(long);
} catch (error) {
  tooLong = `${error.constructor.name}: ${error.message}`;
}
console.log(`   40,000샘플 → ${tooLong}`);
const pZero = await native.predict(zeros);
const pShortZero = await native.predict(new Int16Array(8000));
console.log(
  `   디지털 0 19,200샘플 ${pZero.toFixed(4)} / 8,000샘플 ${pShortZero.toFixed(4)} (짧으면 앞을 0으로 채움 → 같은 값)`,
);
const sine = new Int16Array(EOT_SAMPLES).map((_, i) => Math.round(3000 * Math.sin(i / 10)));
const again = [];
for (let i = 0; i < 3; i++) again.push((await native.predict(sine)).toFixed(6));
console.log(`   같은 입력 3번: ${again.join(' ')} (상태 없음. VAD와 달리 핸들도 없음)`);
// 방의 무음을 SDK처럼 리샘플하면 디지털 0이 아니게 됩니다(rtc-node 리샘플러가 ±1 디더를 더함).
const roomSilence16 = to16k(new Int16Array(RATE * 1.3)).slice(-EOT_SAMPLES);
const hist = { '-1': 0, 0: 0, 1: 0, other: 0 };
for (const v of roomSilence16) hist[v in hist ? v : 'other']++;
const pDither = await native.predict(roomSilence16);
const again16 = to16k(new Int16Array(RATE * 1.3)).slice(-EOT_SAMPLES);
let differ = 0;
for (let i = 0; i < EOT_SAMPLES; i++) if (again16[i] !== roomSilence16[i]) differ++;
console.log(
  `   24kHz 디지털 0을 QUICK으로 16kHz로 바꾼 1.2초: 값 −1 ${hist['-1']}개, 0 ${hist[0]}개, +1 ${hist[1]}개 → p ${pDither.toFixed(4)}`,
);
console.log(
  `   같은 무음을 한 번 더 바꾸면 ${differ.toLocaleString()}샘플이 다름 → p ${(await native.predict(again16)).toFixed(4)} (디더가 실행마다 무작위)`,
);

// ── 1. 녹음 만들기 ──────────────────────────────────────────────────────
const CASES = [
  ['①', '가죽 지갑에 각인하려고요.', '문장 끝'],
  ['②', '그리고 예산은', '조사에서 쉼'],
  ['③', '백만 원 정도로 생각하는데', '연결 어미'],
  ['④', '에프투 울트라로 할지, 음', '"음"'],
  ['⑤', '방문 체험도 되나요?', '질문 끝'],
  ['⑥', '네.', '짧은 대답'],
];
const LEAD_MS = 1000;
const parts = [new Int16Array((RATE * LEAD_MS) / 1000)];
const pauses = [];
let cursor = LEAD_MS;
let source = '';
for (const [mark, text, kind] of CASES) {
  const s = speechOnly(text);
  source = s.source;
  const ms = (s.pcm.length / RATE) * 1000;
  parts.push(s.pcm, new Int16Array((RATE * PAUSE_MS) / 1000));
  pauses.push({ mark, text, kind, startMs: cursor, endMs: cursor + ms });
  cursor += ms + PAUSE_MS;
}
const pcm24 = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
let off = 0;
for (const p of parts) {
  pcm24.set(p, off);
  off += p.length;
}
const p16 = to16k(pcm24);
console.log(`\n1) 녹음 (${source}, 24kHz): 앞 무음 ${LEAD_MS}ms 뒤에 여섯 마디, 마디마다 쉼 ${PAUSE_MS}ms`);
for (const c of pauses)
  console.log(
    `   ${c.mark} ${padW(`"${c.text}"`, 30)} ${padW(c.kind, 12)} 소리 ${Math.round(c.startMs)}~${Math.round(c.endMs)}ms`,
  );

// ── 2. 쉼 동안의 확률 곡선 ──────────────────────────────────────────────
const OFFSETS = [];
for (let d = 0; d <= PAUSE_MS; d += 100) OFFSETS.push(d);
const curve = [];
for (const c of pauses) {
  const row = [];
  for (const d of OFFSETS) row.push(await predictAt(p16, c.endMs + d));
  curve.push(row);
}
console.log(
  `\n2) 쉼 동안의 확률 (그 시각까지 들어온 최근 1.2초로 예측. # = ko 기준 ${KO} 이상, . = 미만)`,
);
const COL = 14;
console.log(
  `   소리 끝 뒤   ${pauses.map((c) => padW(c.mark + c.kind, COL)).join('')}`.trimEnd(),
);
for (let i = 0; i < OFFSETS.length; i++) {
  const cells = curve.map((row) => padW(`${row[i].toFixed(2)} ${row[i] >= KO ? '#' : '.'}`, COL));
  console.log(`   ${String(`+${OFFSETS[i]}ms`).padStart(9)}    ${cells.join('')}`.trimEnd());
}
// 곡선을 한 줄로: 높이 8단계(0.125마다) ▁▂▃▄▅▆▇█
const BLOCKS = '▁▂▃▄▅▆▇█';
console.log('   한 줄 곡선 (+0 → +1,500ms, 칸 하나 100ms, 높이 = 확률)');
for (let k = 0; k < pauses.length; k++) {
  const line = curve[k].map((p) => BLOCKS[Math.min(7, Math.floor(p * 8))]).join('');
  const firstAbove = OFFSETS.find((_, i) => curve[k][i] >= KO);
  console.log(
    `     ${pauses[k].mark} ${line}   처음 ${KO} 이상: ${firstAbove === undefined ? '없음' : `+${firstAbove}ms`}`,
  );
}

// ── 3. 요청 근처를 10ms 단위로 ─────────────────────────────────────────
// VAD는 32ms 창 단위로 말 끝을 정하고, 창의 위치는 소리·디더에 따라 한 창쯤 움직입니다. 그 사이에서 p가 얼마나 흔들리는지 봅니다.
// 칸마다 새로 리샘플한 3번(디더만 다름)을 찍습니다. 칸 안의 차이 = 디더, 칸 사이의 차이 = 창 위치.
const FRAME = RATE / 100;
/** 스트림 시각 tMs를 덮는 10ms 프레임까지 자른 24kHz 소리를 새 리샘플러로 바꿔 예측합니다(앞 0.3초는 리샘플러 길들이기). */
async function freshAt(tMs) {
  const upto = Math.ceil(((tMs / 1000) * RATE) / FRAME) * FRAME;
  const from = Math.max(0, upto - RATE * 1.5);
  const win = to16k(pcm24.slice(from, upto)).slice(-EOT_SAMPLES);
  const t0 = performance.now();
  const p = await native.predict(win);
  times.push(performance.now() - t0);
  return p;
}
console.log('\n3) 요청이 나가는 근처(소리 끝 뒤 +260~+400ms)를 10ms마다, 칸마다 리샘플 3번');
for (const c of pauses.slice(0, 2)) {
  const cells = [];
  for (let d = 260; d <= 400; d += 10) {
    const ps = [];
    for (let k = 0; k < 3; k++) ps.push(await freshAt(c.endMs + d));
    cells.push(`+${d} ${ps.map((p) => p.toFixed(2)).join('/')}`);
  }
  console.log(`   ${c.mark}${c.kind}`);
  for (let i = 0; i < cells.length; i += 5) console.log(`     ${cells.slice(i, i + 5).join('   ')}`);
}

// ── 4. SDK가 실제로 묻는 순간 ───────────────────────────────────────────
// 이 레포와 같은 VAD(기본값)를 같은 녹음에 돌려, "실린 무음 ≥ 200 이고 말하는 중"인 창을 찾습니다(5-4절).
// 리샘플러의 디더가 실행마다 달라(0번 참고) 같은 녹음도 p가 조금씩 다르므로, 요청 창을 10번 새로 리샘플해 봅니다.
const events = await runVad(pcm24, RATE);
const ends = events.filter((e) => e.type === 'END');
const requests = events.filter((e) => e.type === 'INFER' && e.rawSilence >= 200 && e.speaking);
const N = 10;
const spread = {};
console.log(
  `\n4) SDK가 예측을 묻는 순간 (같은 녹음을 이 레포의 VAD에 넣음: END ${ends.length}번, 예측 요청 ${requests.length}번, 리샘플 ${N}번씩)`,
);
console.log(
  '   마디  VAD 마지막 말소리  요청(창 끝)   p 최소~최대   0.4 이상   대기      턴 확정 (소리 끝부터, 예측·FINAL이 바로 왔다고 칠 때)',
);
for (const c of pauses) {
  const req = requests.find((r) => r.t > c.endMs && r.t < c.endMs + PAUSE_MS);
  const end = ends.find((e) => e.t > c.endMs && e.t < c.endMs + PAUSE_MS);
  if (!req || !end) {
    console.log(`   ${c.mark}    요청 없음`);
    continue;
  }
  const ps = [];
  for (let k = 0; k < N; k++) ps.push(await freshAt(req.t));
  spread[c.mark] = ps;
  const above = ps.filter((p) => p >= KO).length;
  const lastSpeaking = end.t - end.silenceDuration; // 세션이 거꾸로 맞춘 마지막 말소리 (스트림 시각)
  const rel = (ms) => `+${Math.round(ms - c.endMs)}ms`;
  // 확정 = max(마지막 말소리 + 대기, 예측 도착, FINAL 도착) (voice/audio_recognition.ts 1690~1752·1871~1887)
  const commitShort = Math.max(lastSpeaking + MIN_DELAY, req.t);
  const commitLong = lastSpeaking + MAX_DELAY;
  const wait = above === N ? '  300ms' : above === 0 ? '2,500ms' : `갈림   `;
  const commit =
    above === N
      ? `${rel(commitShort)} (다음 말 전에 확정)`
      : above === 0
        ? `${rel(commitLong)} → 쉼 ${PAUSE_MS}ms 뒤 다시 말하면 취소, 같은 턴`
        : `${rel(commitShort)} 또는 ${rel(commitLong)}`;
  console.log(
    `   ${c.mark}   ${padW(rel(lastSpeaking), 16)} ${padW(rel(req.t), 12)} ${Math.min(...ps).toFixed(2)}~${Math.max(...ps).toFixed(2)}   ${String(above).padStart(2)}/${N}     ${wait}   ${commit}`,
  );
}
const inside = requests.filter((r) => !pauses.some((c) => r.t > c.endMs && r.t < c.endMs + PAUSE_MS));
if (inside.length)
  console.log(`   마디 안의 쉼에서 나간 요청: ${inside.map((r) => `${r.t}ms`).join(', ')}`);

// ── 5. SDK 경로로 한 번 더: TurnDetector 스트림 + 가짜 실행기 ─────────────
// 실행기는 추론 프로세스(EotRunner.run)가 하는 일을 그대로 합니다: base64 → Int16Array → predict.
// 잡 컨텍스트 밖이라 executor를 직접 넘깁니다(detector.ts 59~66: "Mainly an override seam for tests").
const seen = [];
const executor = {
  doInference: async (method, data) => {
    const bytes = Buffer.from(data.pcm, 'base64');
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    seen.push({ method, chars: data.pcm.length, bytes: bytes.byteLength, samples: pcm.length });
    const t0 = performance.now();
    const probability = await native.predict(pcm);
    return { probability, inferenceDurationMs: performance.now() - t0 };
  },
};
const detector = new inference.TurnDetector({ version: 'v1-mini', executor });
const stream = detector.stream();
const first = pauses[0];
const req1 = requests.find((r) => r.t > first.endMs);
const upto = Math.ceil(((req1.t / 1000) * RATE) / FRAME) * FRAME; // 요청 창을 채운 10ms 프레임까지
for (let i = 0; i + FRAME <= upto; i += FRAME)
  stream.pushAudio(new AudioFrame(pcm24.slice(i, i + FRAME), RATE, 1, FRAME));
await new Promise((r) => setTimeout(r, 100)); // 오디오 채널이 고리 버퍼까지 흘러가기를 기다림
const ev = await stream.predict().await;
const r1 = spread[first.mark];
console.log('\n5) SDK 경로(TurnDetector v1-mini 스트림 → LocalTransport → 가짜 실행기)로 ①의 요청을 재현');
console.log(
  `   실행기가 받은 것: method ${seen[0].method}, base64 ${seen[0].chars.toLocaleString()}자 → ${seen[0].bytes.toLocaleString()}B = ${seen[0].samples.toLocaleString()}샘플`,
);
console.log(
  `   SDK 경로 p ${ev.endOfTurnProbability.toFixed(4)} (inferenceDuration ${ev.inferenceDuration.toFixed(1)}ms) / 4)의 ① ${N}번 범위 ${Math.min(...r1).toFixed(4)}~${Math.max(...r1).toFixed(4)}`,
);
console.log(
  `   기준값: ko ${await stream.unlikelyThreshold('ko')}, ko-KR ${await stream.unlikelyThreshold('ko-KR')}, 언어 모름 ${await stream.unlikelyThreshold(undefined)}`,
);
await stream.aclose();

console.log(
  `\n6) 예측 한 번의 시간 (이 실습의 ${times.length}번, 메인 스레드 밖 libuv 스레드): 중앙 ${median(times).toFixed(1)}ms, 최소 ${Math.min(...times).toFixed(1)}ms, 최대 ${Math.max(...times).toFixed(1)}ms`,
);

await dispose();
process.exit(0); // 네이티브 모듈이 이벤트 루프를 붙잡아 저절로 끝나지 않습니다
