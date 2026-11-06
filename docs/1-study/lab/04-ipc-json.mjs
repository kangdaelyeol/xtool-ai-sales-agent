// 4장 실습: 턴 감지 추론 요청 하나가 Node IPC(JSON 직렬화)로 건너갈 때의 크기와 시간,
//          그리고 부모가 자식의 ping 응답 지연을 재는 방식
//
// 실행: 레포 루트에서  node docs/1-study/lab/04-ipc-json.mjs
// 기준: Node 24, 외부 패키지 없음. @livekit/agents 1.9.5의 메시지 모양을 따랐습니다. 2026-11-06 작성.
// 이 파일이 자기 자신을 fork해서 부모·자식 사이에 메시지를 주고받습니다. 키·네트워크·.env.local을 쓰지 않습니다.
// 메시지 모양: agents/ipc/job_proc_lazy_main.ts doInference()·pingRequest 처리,
//             agents/inference/eot/transports.ts _predict(), agents/ipc/supervised_proc.ts pongResponse 처리
import { fork } from 'node:child_process';

if (process.argv[2] === 'child') {
  // 자식: 추론 프로세스 흉내. 받은 base64를 풀고 작은 응답만 돌려준다
  process.on('message', (msg) => {
    if (msg.case === 'bye') process.exit(0);
    if (msg.case === 'pingRequest') {
      // 잡 프로세스 흉내: 루프가 800ms 막혀 있다가 ping을 처리한다
      const t0 = Date.now();
      while (Date.now() - t0 < 800) {
        // 바쁜 루프
      }
      // job_proc_lazy_main.ts와 같은 응답: 받은 시각은 lastTimestamp, 보내는 지금은 timestamp
      process.send({
        case: 'pongResponse',
        value: { lastTimestamp: msg.value.timestamp, timestamp: Date.now() },
      });
      return;
    }
    if (msg.case === 'probe') {
      // 받은 모양을 그대로 돌려보낸다: JSON이면 Int16Array가 평범한 객체로 바뀌어 있다
      process.send({ case: 'probe', value: JSON.stringify(msg.value).slice(0, 40) });
      return;
    }
    const bytes = Buffer.from(msg.value.data.pcm, 'base64');
    process.send({
      case: 'inferenceResponse',
      value: { requestId: msg.value.requestId, data: { probability: bytes.length, inferenceDurationMs: 0 } },
    });
  });
} else {
  const SAMPLES = 19_200; // 16kHz × 1.2초 (transports.ts CLIENT_BUFFER_SAMPLES)
  const pcm = new Int16Array(SAMPLES).map((_, i) => Math.round(3000 * Math.sin(i / 10)));
  const b64 = Buffer.from(pcm.buffer).toString('base64');

  const request = (id) => ({
    case: 'inferenceRequest',
    value: { requestId: `inference_job_${id}`, method: 'lk_eot_audio', data: { pcm: b64 } },
  });

  console.log('== 1. 크기 ==');
  console.log(`PCM ${pcm.byteLength.toLocaleString('en-US')}B → base64 ${b64.length.toLocaleString('en-US')}자`);
  const line = JSON.stringify(request('XXXXXXXXXXXX'));
  console.log(`IPC 한 줄(JSON + 줄바꿈) ${(Buffer.byteLength(line) + 1).toLocaleString('en-US')}B`);
  // base64 없이 Int16Array를 그대로 실으면? JSON.stringify는 {"0":…, "1":…} 객체로 만든다
  const naive = JSON.stringify({ pcm });
  console.log(
    `(비교) Int16Array를 그대로 JSON에 넣으면 ${Buffer.byteLength(naive).toLocaleString('en-US')}B: ${naive.slice(0, 60)}…`,
  );

  // ── 2. 왕복 시간: 부모 → 자식 (큰 요청), 자식 → 부모 (작은 응답) ─────
  const child = fork(new URL(import.meta.url), ['child']); // serialization 옵션 없음 = 기본 'json'
  const probed = await new Promise((resolve) => {
    child.once('message', (m) => resolve(m.value));
    child.send({ case: 'probe', value: { pcm: new Int16Array([1, 2, 3]) } });
  });
  console.log(`기본 직렬화로 Int16Array [1,2,3]을 보내면 자식이 받는 것: ${probed}`);

  const roundTrip = (id) =>
    new Promise((resolve) => {
      const t = performance.now();
      child.once('message', () => resolve(performance.now() - t));
      child.send(request(id));
    });
  for (let i = 0; i < 5; i++) await roundTrip(`warm${i}`); // 준비 운동
  const times = [];
  for (let i = 0; i < 50; i++) times.push(await roundTrip(i));
  times.sort((a, b) => a - b);
  console.log('\n== 2. 한 구간 왕복 50번 (요청 51KB → 응답 수십 B) ==');
  console.log(
    `중앙값 ${times[25].toFixed(2)}ms, 최소 ${times[0].toFixed(2)}ms, 최대 ${times[49].toFixed(2)}ms`,
  );
  console.log(
    `실제 경로는 잡 → 워커 → 추론 프로세스로 두 구간이라 대략 이 값의 두 배 + 모델 계산 시간`,
  );

  // ── 3. 직렬화 비용만 따로: JSON.stringify + JSON.parse ─────────────
  const N = 200;
  let t = performance.now();
  for (let i = 0; i < N; i++) JSON.parse(JSON.stringify(request(i)));
  const jsonMs = (performance.now() - t) / N;
  t = performance.now();
  for (let i = 0; i < N; i++) Buffer.from(Buffer.from(pcm.buffer).toString('base64'), 'base64');
  const b64Ms = (performance.now() - t) / N;
  console.log('\n== 3. 한 번에 드는 CPU (메인 스레드) ==');
  console.log(`JSON 직렬화 + 파싱 ${jsonMs.toFixed(3)}ms, base64 인코딩 + 디코딩 ${b64Ms.toFixed(3)}ms`);

  // ── 4. ping/pong: SDK가 재는 지연은 무엇인가 ────────────────────
  const pong = await new Promise((resolve) => {
    child.once('message', (m) => resolve({ msg: m.value, at: Date.now() }));
    child.send({ case: 'pingRequest', value: { timestamp: Date.now() } });
  });
  console.log('\n== 4. 자식 루프가 800ms 막힌 동안 보낸 ping ==');
  console.log(
    `SDK 식 (받은 시각 − pong의 timestamp)   ${pong.at - pong.msg.timestamp}ms  ← 500ms를 넘어야 경고`,
  );
  console.log(`왕복 (받은 시각 − pong의 lastTimestamp) ${pong.at - pong.msg.lastTimestamp}ms`);

  child.send({ case: 'bye' });
}
