// 4장 실습: 워커가 LiveKit 서버에 보내는 protobuf 메시지를 바이트 단위로 풀어 보기
//
// 실행: 레포 루트에서  node docs/1-study/lab/04-protobuf-bytes.mjs   (pnpm install 뒤)
// 기준: Node 24, @livekit/agents 1.9.5, @livekit/protocol 1.53.1(@bufbuild/protobuf 1.10.1). 2026-11-06 작성.
// 서버에 접속하지 않습니다. worker.ts가 만드는 것과 같은 메시지를 로컬에서 만들어 toBinary()만 합니다.
// 잡 ID는 가짜 값입니다. 키·네트워크·.env.local을 쓰지 않습니다.
import { createRequire } from 'node:module';

// @livekit/protocol은 이 레포가 직접 설치하지 않고 @livekit/agents가 의존성으로 가져옵니다.
const require = createRequire(import.meta.url);
const fromAgents = createRequire(require.resolve('@livekit/agents'));
const { WorkerMessage, ParticipantPermission, JobType, WorkerStatus } =
  fromAgents('@livekit/protocol');
const { version } = fromAgents('@livekit/agents');

const hex = (bytes) => Buffer.from(bytes).toString('hex').replace(/(..)/g, '$1 ').trim();

// ── 손으로 푸는 디코더: 태그 = (필드 번호 << 3) | 와이어 타입 ──────────
const WIRE = { 0: 'varint', 1: 'fixed64', 2: '길이 접두', 5: 'fixed32' };

function readVarint(buf, pos) {
  let value = 0;
  let shift = 0;
  let n = 0;
  for (;;) {
    const b = buf[pos + n];
    value += (b & 0x7f) * 2 ** shift; // 아래 7비트가 값, 맨 위 비트는 "다음 바이트도 있음"
    n += 1;
    if ((b & 0x80) === 0) return { value, n };
    shift += 7;
  }
}

// nested: 필드 번호 → 그 안을 다시 풀 메시지 이름 (길이 접두 필드 중 메시지인 것)
function walk(buf, nested = {}, indent = '') {
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    const field = Math.floor(tag.value / 8); // tag >> 3
    const wire = tag.value & 7;
    const tagHex = hex(buf.subarray(pos, pos + tag.n));
    pos += tag.n;
    const head = `${indent}${tagHex.padEnd(3)} = 필드 ${field}, ${WIRE[wire]}`;
    if (wire === 0) {
      const v = readVarint(buf, pos);
      console.log(`${head} → ${hex(buf.subarray(pos, pos + v.n))} = ${v.value}`);
      pos += v.n;
    } else if (wire === 5) {
      const raw = buf.subarray(pos, pos + 4);
      const f = Buffer.from(raw).readFloatLE(0);
      console.log(`${head} → ${hex(raw)} (리틀 엔디언 float32) = ${f}`);
      pos += 4;
    } else if (wire === 2) {
      const len = readVarint(buf, pos);
      pos += len.n;
      const body = buf.subarray(pos, pos + len.value);
      if (nested[field]) {
        console.log(`${head}, 길이 ${len.value} → ${nested[field].name}`);
        walk(body, nested[field].fields ?? {}, indent + '    ');
      } else {
        console.log(`${head}, 길이 ${len.value} → "${Buffer.from(body).toString('utf8')}"`);
      }
      pos += len.value;
    } else {
      throw new Error(`이 실습에서 다루지 않는 와이어 타입 ${wire}`);
    }
  }
}

// ── 1. register: worker.ts #runWS가 보내는 그대로 ────────────────────
// (agents/worker.ts 786~806: type, agentName, deployment, allowedPermissions, version)
const register = new WorkerMessage({
  message: {
    case: 'register',
    value: {
      type: JobType.JT_ROOM,
      agentName: 'xtool-sales-agent',
      deployment: '', // LIVEKIT_AGENT_DEPLOYMENT가 없을 때 (pnpm start)
      allowedPermissions: new ParticipantPermission({
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canUpdateMetadata: true,
        hidden: false,
        agent: true,
      }),
      version,
    },
  },
});
const regBin = register.toBinary();
console.log(`== 1. register (SDK ${version}에서 실제로 보내는 모양) ==`);
console.log(`${regBin.length}바이트: ${hex(regBin)}`);
walk(regBin, {
  1: {
    name: 'RegisterWorkerRequest',
    fields: { 7: { name: 'ParticipantPermission' } },
  },
});
const regJson = register.toJsonString();
console.log(`같은 내용의 protobuf JSON: ${Buffer.byteLength(regJson)}바이트`);
console.log(regJson);

// 권한 칸을 뺀 최소형: 이름과 판만 실으면 얼마인가
const minimal = new WorkerMessage({
  message: { case: 'register', value: { agentName: 'xtool-sales-agent', version } },
});
console.log(
  `(비교) 권한 칸을 뺀 최소형: ${minimal.toBinary().length}바이트, JSON ${Buffer.byteLength(minimal.toJsonString())}바이트`,
);

// ── 2. updateWorker: 2.5초마다 보내는 부하 보고 ─────────────────────
// (agents/worker.ts 849~861: load, status)
const update = new WorkerMessage({
  message: { case: 'updateWorker', value: { load: 0.42, status: WorkerStatus.WS_AVAILABLE } },
});
const updBin = update.toBinary();
console.log('\n== 2. updateWorker (load 0.42, 가용) ==');
console.log(`${updBin.length}바이트: ${hex(updBin)}`);
walk(updBin, { 3: { name: 'UpdateWorkerStatus' } });
console.log(`JSON: ${Buffer.byteLength(update.toJsonString())}바이트 ${update.toJsonString()}`);
console.log(
  `load 칸은 float32라 0.42가 정확히 담기지 않음: ${Math.fround(0.42)} (Math.fround)`,
);
const full = new WorkerMessage({
  message: { case: 'updateWorker', value: { load: 0.7, status: WorkerStatus.WS_FULL } },
});
console.log(`(비교) load 0.7, 가득 참: ${hex(full.toBinary())}`);

// ── 3. availability 응답: 잡을 받겠다고 할 때 ───────────────────────
// (agents/worker.ts 897~918, 기본 identity는 job.ts 847의 'agent-' + 잡 ID)
const jobId = 'AJ_abcdefgh1234'; // 가짜 잡 ID
const accept = new WorkerMessage({
  message: {
    case: 'availability',
    value: {
      jobId,
      available: true,
      participantIdentity: `agent-${jobId}`,
      participantName: '',
      participantMetadata: '',
      participantAttributes: { 'lk.agent.name': 'xtool-sales-agent' },
    },
  },
});
const accBin = accept.toBinary();
console.log('\n== 3. availability 응답 (수락) ==');
console.log(`${accBin.length}바이트: ${hex(accBin)}`);
walk(accBin, {
  2: { name: 'AvailabilityResponse', fields: { 7: { name: 'map 항목 (key=1, value=2)' } } },
});

// ── 4. varint 손 계산 ─────────────────────────────────────────────
console.log('\n== 4. varint: 7비트씩 끊어 아래부터, 이어지면 맨 위 비트 1 ==');
for (const n of [1, 17, 127, 128, 300, 51_200]) {
  const bytes = [];
  let v = n;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    bytes.push(b);
  } while (v > 0);
  console.log(`${String(n).padStart(6)} → ${hex(bytes)}`);
}
