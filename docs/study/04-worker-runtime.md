# 4장. 워커와 잡 — 에이전트 프로그램은 어떻게 실행되는가

[src/main.ts](../../src/main.ts)를 처음 보면 이상한 점이 있습니다. 서버를 띄우는 코드(`listen(8080)`)가 없고, `entry` 함수를 정의해서 `defineAgent()`에 넘긴 뒤 `cli.runApp()`만 부릅니다. 그런데 이 `entry`는 **누가, 언제, 어디서** 부를까요? 이 장은 LiveKit Agents의 실행 구조(워커, 잡, 프로세스)를 SDK 코드 기준으로 설명합니다. 배포·운영(15장)을 이해하는 바탕이 됩니다.

> 이 장의 SDK 경로는 `node_modules/@livekit/agents/src/` 기준입니다. 실제로 실행되는 것은 같은 패키지의 `dist/*.js`입니다.

---

## 4-1. 왜 "상주 워커"인가

웹 서비스에서 익숙한 구조는 요청이 오면 처리하고 응답을 돌려주는 방식입니다. Cloud Functions 같은 서버리스가 대표적입니다. 음성 통화는 이 모델과 맞지 않습니다.

| | 웹 요청 / 서버리스 | 음성 통화 |
| --- | --- | --- |
| 길이 | 수십 ms~수 초 | 수 분 |
| 연결 | 요청-응답 후 끊음 | 방(WebRTC), STT·TTS(WebSocket)와 **계속 연결** |
| 상태 | 요청마다 독립 | 대화 기록, 오디오 버퍼, 모델 상태를 통화 내내 유지 |
| 자원 | 짧게 씀 | CPU(VAD, 노이즈 제거, 오디오 변환)를 계속 씀 |

그래서 에이전트는 **상주 워커(worker)** 프로세스로 돕니다. 워커는 LiveKit 서버에 먼저 접속해 "나 일할 수 있어"라고 등록하고, 서버가 일(잡, job)을 나눠 주기를 기다립니다. **우리가 요청을 받는 서버가 아니라, 일을 받으러 가는 클라이언트**입니다. 그래서 공개 포트를 열 필요가 없습니다(상태 확인용 HTTP 포트만 있음).

[tech-stack.md 6장](../tech-stack.md#6-전체-아키텍처)이 "에이전트 워커는 Cloud Functions/Cloud Run이 아니라 GKE Autopilot 또는 GCE"라고 정한 이유가 이것입니다.

---

## 4-2. 워커의 일생

### 시작: `cli.runApp`

```ts
// src/main.ts
cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),   // 이 파일 자신의 경로
    agentName: 'xtool-sales-agent',
  }),
);
```

`cli.runApp`은 명령줄 인자를 읽어 하위 명령을 실행합니다(`cli.ts`).

| 명령 | 누가 쓰나 | 특징 |
| --- | --- | --- |
| `start` | 운영 (`pnpm start`, Dockerfile) | production 모드. JSON 로그, 유휴 프로세스 미리 준비, SIGTERM 시 drain |
| `dev` | 개발 (`lk agent dev`가 내부적으로) | 개발 모드. 보기 좋은 로그, debug 레벨, `LIVEKIT_DEV_MODE=1` |
| `console` | `lk agent console` | 방 없이 내 마이크로 대화 (4-8절) |
| `connect --room` | 디버깅 | 지정한 방에 바로 잡을 만듦 |
| `download-files` | 이미지 빌드 | 플러그인 모델 파일 미리 받기 (15장) |

`agent`에 **파일 경로**를 넘기는 이유는 4-4절에서 나옵니다. 잡마다 새 프로세스가 이 파일을 다시 불러오기 때문입니다.

production 여부에 따라 기본값이 꽤 달라집니다(`worker.ts`).

| 항목 | `start` (production) | `dev` |
| --- | --- | --- |
| 부하 임계값(이 이상이면 잡 거절) | 0.7 | 무한대 (항상 받음) |
| 미리 준비해 두는 유휴 프로세스 | `min(CPU 수, 4)`개 | 0개 |
| 상태 확인 HTTP 포트 | 8081 | 무작위 |
| SIGTERM 받으면 | 진행 중 통화가 끝날 때까지 기다림(drain) | 바로 닫음 |

SDK는 `NODE_ENV`를 보지 않습니다. Dockerfile의 `ENV NODE_ENV=production`은 다른 라이브러리를 위한 관례일 뿐이고, SDK의 production 여부는 **`start` 명령**이 정합니다.

### 등록: LiveKit 서버와 WebSocket

```text
워커                                         LiveKit 서버
 │── WebSocket 연결 (wss://<프로젝트>/agent) ──▶│   헤더: Bearer <API 키로 서명한 JWT, agent 권한>
 │── register { type, agentName, version… } ──▶│   (protobuf 바이너리)
 │◀──────────── register 응답 { workerId } ────│
 │── 2.5초마다 updateWorker { load, status } ──▶│   load = CPU 사용률
 │                    …
 │◀──── availability (이 잡 할 수 있어?) ────────│   ← 디스패치 (4-3절)
 │── availability 응답 (accept) ───────────────▶│
 │◀──── assignment (방 토큰, URL) ─────────────│
 │      → 프로세스 풀에서 잡 실행 (4-4절)
```

- 메시지는 JSON이 아니라 **protobuf** 바이너리입니다(`@livekit/protocol`). 스키마가 정해진 이진 형식이라 작고 빠릅니다.
- **부하 보고**: 기본적으로 CPU 사용률을 2.5초마다 보냅니다. 컨테이너의 cgroup 한도도 인식합니다. 임계값을 넘으면 "가득 참" 상태가 되어 서버가 새 잡을 다른 워커에 줍니다. 이것이 워커 여러 대에 통화를 나누는 **부하 분산**입니다.
- **재접속**: 연결이 끊기면 최대 10회까지 다시 붙고, 실행 중인 잡은 다시 보고합니다. 10회를 넘기면 프로세스가 종료됩니다(쿠버네티스가 다시 띄우게 됨).
- **상태 확인**: HTTP `/`는 WebSocket이 열려 있고 추론 프로세스가 살아 있을 때만 200을 줍니다. 쿠버네티스 헬스 체크(probe)를 여기에 걸면 됩니다.

---

## 4-3. 디스패치: 어떤 방에 어떤 에이전트를 보낼까

**디스패치(dispatch)**는 "이 방에 이 에이전트를 투입하라"는 결정입니다. 두 가지 방식이 있습니다.

| 방식 | 조건 | 동작 |
| --- | --- | --- |
| 자동 디스패치 | 워커의 `agentName`이 **비어 있음** | 방이 생기면 자동으로 에이전트가 들어감 |
| **명시 디스패치** | 워커에 `agentName`이 **있음** | 누군가 API로 "이 방에 `xtool-sales-agent`를 보내라"고 요청할 때만 들어감 |

이 프로젝트는 `agentName: 'xtool-sales-agent'`를 정했으므로 **명시 디스패치만** 받습니다. 그래서 브라우저 Agent Console에서 테스트할 때 에이전트 이름을 지정해야 합니다([setup-checklist.md 5-3](../setup-checklist.md#5-3-브라우저-agent-console)). 운영에서 이것이 맞는 선택인 이유는, 아무 방에나 영업 상담원이 들어가면 안 되기 때문입니다. 통화를 걸기로 결정한 functions-xtool만 에이전트를 부릅니다.

### job metadata: 통화별 정보를 실어 보내는 통로

명시 디스패치를 요청할 때 **metadata**(문자열)를 함께 보낼 수 있습니다. LiveKit 서버 SDK로는 이런 모양입니다.

```ts
// functions-xtool 쪽 (예정, 개념 예시)
await agentDispatchClient.createDispatch(roomName, 'xtool-sales-agent', {
  metadata: JSON.stringify({ callId, customerName: '김민수', device: 'F2 울트라', … }),
});
```

이 문자열은 서버의 Job 정보에 담겨 워커 → 잡 프로세스로 전달되고, 에이전트 코드에서 `ctx.job.metadata`로 읽힙니다.

```ts
// src/main.ts
const call = parseCallContext(ctx.job.metadata);
```

### 계약을 코드로: zod 스키마

두 레포가 주고받는 데이터는 **계약**입니다. 한쪽이 필드 이름을 바꾸면 다른 쪽이 조용히 깨집니다. [src/call-context.ts](../../src/call-context.ts)는 이 계약을 zod 스키마로 적어 두고, 들어오는 값을 **검증하면서 기본값을 채웁니다.**

```ts
const CallContextSchema = z.object({
  callId: z.string().optional(),
  customerName: z.string().default(''),
  device: z.string().default(''),
  inquiredAt: z.string().default(''),
  installment: z.enum(['희망', '희망 안 함', '미기입']).default('미기입'),
  inquiryText: z.string().default(''),
});
export type CallContext = z.infer<typeof CallContextSchema>;   // 타입을 스키마에서 뽑아냄
```

- `z.infer`로 **타입과 검증 규칙을 한곳에서** 정의합니다. 타입 따로, 검증 따로 쓰면 둘이 어긋나기 쉽습니다.
- `installment`는 `z.enum`이라 "희망함" 같은 오타가 오면 검증에 실패합니다.

그리고 실패했을 때의 처리가 세 갈래입니다.

```ts
export function parseCallContext(metadata: string | undefined): CallContext {
  if (!metadata) return SAMPLE_CALL;              // ① metadata 없음 → 테스트 환경 → 가상 고객 "김민수"
  try {
    return CallContextSchema.parse(JSON.parse(metadata));   // ② 정상
  } catch (error) {
    log().warn({ error }, '통화 metadata를 읽지 못해 고객 정보 없이 진행합니다');
    return CallContextSchema.parse({});           // ③ 깨짐 → 실제 통화일 수 있음 → 빈 정보("고객님")
  }
}
```

③에서 가상 고객을 쓰지 않는 이유가 중요합니다. metadata가 있었다는 것은 **실제 통화일 가능성**이 높다는 뜻입니다. 이때 "김민수 고객님"이라고 부르면 실제 고객에게 남의 이름을 부르게 됩니다. 이름을 안 부르는 쪽이 훨씬 안전합니다(1장 원칙 5). 테스트가 이 동작을 고정합니다(`prompt.test.ts`의 "metadata가 없으면 가상 고객, 깨졌으면 빈 정보").

### 개발 워커와 운영 워커 분리

`lk agent dev`는 워커를 `dev-…`라는 무작위 배포 이름으로 등록합니다. 그래서 운영 트래픽이 개발자 노트북으로 가지 않습니다. 반대로, 디스패치 요청에 배포 이름을 지정하지 않으면 개발 워커에 도달하지 않는다는 점도 기억해 둡니다.

---

## 4-4. 프로세스 모델: 통화마다 새 프로세스

### 구조

```text
워커 프로세스 (main.ts start)  ← LiveKit과 WebSocket, 부하 보고, 잡 분배
 ├─ 추론 프로세스 (1개, 공유)    ← 로컬 턴 감지 모델 (4-5절)
 ├─ 잡 프로세스 A (통화 1)       ← entry() 실행, VAD, 노이즈 제거, STT·LLM·TTS 연결
 ├─ 잡 프로세스 B (통화 2)
 └─ 유휴 프로세스 ×N             ← 미리 띄워 초기화까지 끝낸 대기 프로세스
```

잡 하나(통화 하나)마다 **자식 프로세스**가 따로 뜹니다(`ipc/job_proc_executor.ts`에서 Node의 `fork()`).

### 왜 스레드가 아니라 프로세스인가

1. **장애 격리.** 한 통화에서 예외나 메모리 폭주가 나도 다른 통화는 멀쩡합니다.
2. **이벤트 루프 격리.** Node.js는 기본적으로 **스레드 하나에서 이벤트 루프**를 돌립니다. VAD 추론이나 노이즈 제거처럼 CPU를 쓰는 동기 작업이 길어지면 그 프로세스의 모든 일이 멈춥니다. 통화마다 프로세스가 다르면 한 통화의 무거운 계산이 다른 통화의 오디오를 막지 않습니다.
3. **자원 관리.** 잡이 끝나면 프로세스를 통째로 버립니다(`process.exit(0)`, 재사용 안 함). 메모리 누수가 쌓일 틈이 없습니다.

### 자식 프로세스가 하는 일

```text
1. fork(job_proc_lazy_main.js, [에이전트 파일 경로])
2. 에이전트 파일(main.ts)을 동적 import → default export가 defineAgent 결과인지 확인
3. 프레임워크 preload: 로컬 추론 네이티브 바인딩을 미리 올림
4. 사용자 prewarm(proc) 실행 (이 프로젝트는 정의하지 않음)
5. 부모에게 "준비 완료" → 유휴 대기열에 들어감
6. 잡 배정 → entry(ctx) 실행
7. 통화 종료 → 정리 → exit(0)
```

부모와 자식은 Node의 IPC 채널로 메시지(initialize, ping/pong, startJob, shutdownRequest, done…)를 주고받습니다. 자식은 15초 동안 ping이 없으면 부모가 죽었다고 보고 스스로 종료합니다(고아 프로세스 방지).

### 함정: main.ts는 자식에서도 다시 실행된다

2번에서 자식이 `main.ts`를 import하므로, **파일 최상위 코드가 자식 프로세스에서도 실행됩니다.** `dotenv.config()`와 `cli.runApp()`이 자식에서도 돕니다. `cli.runApp`은 자식의 명령줄 인자로는 아무 하위 명령에도 걸리지 않아 조용히 끝나므로 지금은 무해합니다. 하지만 최상위에 무거운 초기화(모델 로딩, DB 연결)를 쓰면 **모든 프로세스가 그 비용을 냅니다.** 그런 일은 `prewarm` 함수에 넣어야 합니다. `prewarm`은 프로세스마다 한 번 실행되고, 결과는 `ctx.proc.userData`로 entry에 전달됩니다.

### 미리 띄워 두기 (프리워밍)

새 프로세스를 띄우고 모듈을 불러오고 네이티브 바인딩을 올리는 데는 시간이 걸립니다. 전화를 받았는데 그동안 침묵이면 안 되므로, production에서는 **유휴 프로세스를 미리 N개 준비**해 둡니다.

- 잡이 오면 대기열에서 하나 꺼내 바로 쓰고, 빈자리에 새 프로세스를 다시 데웁니다.
- 이 숫자는 **동시 통화 상한이 아니라 대기 인원**입니다. 동시 통화 상한은 부하 임계값(CPU 0.7)이 정합니다.
- dev 모드는 0개라서 잡이 올 때 그제야 fork합니다. **개발 중 첫 응답이 느린 이유**입니다.

### 기본 타임아웃과 메모리

| 항목 | 기본값 |
| --- | --- |
| 프로세스 초기화 제한 시간 | 10초 (넘으면 강제 종료) |
| 종료 단계별 제한 시간 | 60초 |
| ping 간격 / 응답 없을 때 강제 종료 | 2.5초 / 60초 |
| 잡 메모리 경고 | 1,000MB |
| 잡 메모리 강제 종료 한도 | 0 (끔) |

쿠버네티스에 올릴 때는 "유휴 프로세스 수 × 프로세스당 메모리 + 통화 수 × 통화당 메모리"로 메모리 요청량을 잡아야 합니다. 프로세스마다 rtc-node 네이티브 라이브러리와 VAD를 따로 올리기 때문입니다.

---

## 4-5. 추론 프로세스와 턴 감지 모델의 위치

턴 감지 모델(7장)은 두 가지 버전이 있습니다.

| 버전 | 어디서 도나 | 크기 |
| --- | --- | --- |
| `v1` (전체 모델) | LiveKit Inference (클라우드) | — |
| `v1-mini` | **워커의 추론 프로세스 (로컬 CPU)** | 약 138MB |

로컬 모델은 통화마다 올리면 메모리가 낭비되므로, **호스트당 하나의 공유 추론 프로세스**에서 돌립니다. 잡 프로세스가 추론을 요청하면 `잡 프로세스 → 부모 워커 → 추론 프로세스`로 IPC를 두 번 건너갑니다. 입력은 16kHz 오디오 최대 1.2초 분량입니다. Silero VAD(약 2MB)는 가벼워서 각 잡 프로세스 안에서 돕니다.

### 중요: 개발과 운영에서 기본 모델이 다르다

`new inference.TurnDetector()`처럼 버전을 지정하지 않으면 SDK가 환경을 보고 고릅니다(`inference/eot/detector.ts`).

| 환경 | 기본 버전 |
| --- | --- |
| LiveKit Cloud에 배포된 에이전트 | `v1` (클라우드) |
| `dev`, `console`, `connect` (개발 모드) | `v1` (클라우드) |
| **직접 운영(GKE 등)에서 `start`** | **`v1-mini` (로컬)** |

이 프로젝트는 워커를 GCP 서울에 직접 띄울 계획입니다. 그러면 **PoC에서 들어 본 턴 감지(v1)와 운영의 턴 감지(v1-mini)가 다른 모델**이 됩니다. 턴 감지 품질을 운영과 같게 재려면 `version: 'v1'`을 명시하거나, 운영 설정 그대로 측정해야 합니다. 같은 이유로 적응형 끼어들기 모델도 직접 운영 시에는 `mode: 'adaptive'`를 명시해야 켜집니다([src/main.ts](../../src/main.ts) 주석, 7장).

---

## 4-6. entry 함수 한 줄씩 읽기

이제 [src/main.ts](../../src/main.ts)의 `entry`를 위에서부터 따라갑니다.

```ts
dotenv.config({ path: '.env.local' });   // 최상위: 워커·자식 프로세스 모두에서 실행
```

로컬 개발에서는 `.env.local`의 키를 읽습니다. Docker 이미지에는 `.dockerignore`가 `.env.*`를 빼므로 아무것도 읽지 않고, 비밀값은 쿠버네티스 Secret 같은 **진짜 환경변수**로 넣어야 합니다.

```ts
entry: async (ctx) => {
  const config = loadConfig();                         // ① 부품 선택 (15장)
  const call = parseCallContext(ctx.job.metadata);     // ② 고객 정보 (4-3절)
  log().info({ config, callId: call.callId }, '통화 시작');
```

로그에 `callId`를 남기는 것은 나중에 Firestore 기록과 로그를 맞춰 보기 위해서입니다. 고객 이름 같은 개인정보는 로그에 넣지 않았습니다.

```ts
  const stt = createSTT(config.stt);
  const session = new voice.AgentSession({ stt, tts: …, ttsTextTransforms: …, turnHandling: … });
```

`AgentSession`은 한 통화의 **오케스트라 지휘자**입니다. VAD·STT·턴 감지·LLM·TTS를 연결하고 순서를 정합니다. 설정 하나하나는 7장(턴), 10장(TTS 변환), 11장(세션 내부)에서 다룹니다. LLM이 세션이 아니라 에이전트(`createAgent`)에 들어가는 점에 주목하세요. 세션은 통화 전체에 하나이고, 에이전트는 핸드오프로 바뀔 수 있는 "현재 상담원 역할"이라서, 에이전트마다 다른 LLM과 지시문을 줄 수 있게 나뉘어 있습니다.

```ts
  if (stt instanceof FinalizingSonioxSTT) {
    session.on(voice.AgentSessionEventTypes.UserStateChanged, …);   // 6장
  }
  session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => metrics.logMetrics(ev.metrics));  // 13장
```

이벤트 구독은 `session.start()` **전에** 겁니다. 시작 직후의 이벤트를 놓치지 않기 위해서입니다.

```ts
  await session.start({
    agent: createAgent({ call, llm: createLLM(config.llm) }),
    room: ctx.room,
    inputOptions: { noiseCancellation: audioEnhancement({ model: EnhancerModel.QuailVfS }) },
  });
```

`session.start()`는 내부에서 **RoomIO**를 만들어 방과 세션을 잇습니다(`voice/room_io/`).

| RoomIO가 하는 일 | 기본값·동작 |
| --- | --- |
| 연결할 고객 고르기 | 종류가 STANDARD(브라우저), SIP(전화), CONNECTOR인 참가자 중 **처음 들어온 사람**. 다른 에이전트는 제외 |
| 입력 | 그 참가자의 마이크 트랙을 `AudioStream(24kHz, 모노, 노이즈 제거 끼움)`으로 구독 |
| 출력 | `AudioSource(24kHz, 모노)`로 에이전트 오디오 트랙을 만들어 **발행**하고, 상대가 구독할 때까지 기다린 뒤 재생 시작 |
| 자막 | 고객·에이전트 말을 `lk.transcription` 텍스트 스트림으로 방에 보냄 (Agent Console 화면의 자막) |
| 상태 알림 | 에이전트 상태(듣는 중·생각 중·말하는 중)를 참가자 속성 `lk.agent.state`로 알림 |
| 방이 아직 연결 안 됐으면 | 직접 `ctx.connect()`를 부름 |

마지막 줄 때문에, 그 뒤의 이 코드는 사실상 아무 일도 하지 않습니다(이미 연결돼 있으면 바로 반환).

```ts
  await ctx.connect();
```

스타터 템플릿에서 내려온 줄로 보이며, 지워도 동작은 같습니다. 순서를 `ctx.connect()` → `session.start()`로 바꾸는 것도 흔한 패턴입니다.

```ts
  session.say(openingNotice(call), { allowInterruptions: false });
  session.say(OPENING_QUESTION, { allowInterruptions: true });
},
```

첫 멘트 두 개를 **대기열에 넣고 바로 반환**합니다(`await` 없음). 재생은 세션이 순서대로 합니다(11장). 그리고 `entry`가 반환되어도 **통화는 끝나지 않습니다.** 잡 프로세스는 계속 살아서 세션을 돌립니다.

### 전화 연결 단계에서 확인할 점: 받기 전에 말하기

SIP 발신에서는 고객이 전화를 **받기 전부터** SIP 참가자가 방에 들어와 있을 수 있습니다. 그러면 RoomIO가 그 참가자에게 연결되고, 첫 멘트가 벨이 울리는 동안 재생되어 **고객이 받았을 때는 고지가 이미 지나가 버릴** 수 있습니다. 법적 고지라 특히 위험합니다. 발신 API에서 "받을 때까지 기다리기"(`waitUntilAnswered`) 옵션을 쓰거나, 참가자 속성 `sip.callStatus`가 `active`가 될 때까지 기다린 뒤 `say()`를 부르는 처리가 필요합니다. SDK의 자동응답 감지 코드도 이 속성을 봅니다. (SDK 코드로 본 동작 흐름이며, 실제 회선에서 확인해야 합니다.)

---

## 4-7. 통화가 끝날 때

### entry 반환 ≠ 잡 종료

잡을 끝내는 것은 다음 네 가지뿐입니다(`ipc/job_proc_lazy_main.ts`).

1. 방 연결이 끊김
2. 코드에서 `ctx.shutdown()` 호출
3. 부모 워커의 종료 요청
4. entry에서 예외 발생

### 종료 순서

```text
entry 종료 대기 (최대 15초)
 → session.close() (최대 60초)
 → 세션 리포트 업로드 (LiveKit Cloud 관측 기능)
 → room.disconnect(), 종료 콜백들 병렬 실행
 → 로그·트레이스 플러시
 → 부모에게 done → 네이티브 자원 정리 → exit(0)
```

### 고객이 전화를 끊으면

RoomIO는 고객의 연결이 끊긴 사유가 "클라이언트가 끊음", "방 삭제", "사용자 거절"일 때 **세션을 닫습니다.** 그런데 세션이 닫힌다고 잡이 자동으로 끝나는 것은 아닙니다. SDK 안에서 세션 종료를 `ctx.shutdown()`으로 잇는 코드는 베타 통화 종료 도구에만 있습니다. 그 외에는 서버가 빈 방을 정리할 때까지 잡 프로세스가 남을 수 있습니다.

통화 종료 도구를 붙일 때(9장) 함께 정리할 부분입니다. 선택지는 세션의 `Close` 이벤트에서 `ctx.shutdown()`을 부르거나, RoomIO의 `deleteRoomOnClose: true`를 쓰는 것입니다. 또 SIP 쪽에서 끊긴 사유가 위 세 가지가 아니면 세션이 닫히지 않을 수 있어, 전화 연결 단계에서 실제 사유 값을 확인해야 합니다.

### 배포할 때: drain

새 버전을 배포하면 쿠버네티스가 기존 워커에 SIGTERM을 보냅니다. production 워커는

1. 서버에 "가득 참"을 알려 **새 잡을 받지 않고**,
2. 유휴 프로세스는 닫고,
3. **진행 중인 통화가 자연스럽게 끝날 때까지** 기다립니다(drain, 기본 최대 60분).
4. 그 뒤 남은 프로세스를 정리하고 종료합니다.

그런데 쿠버네티스는 기본적으로 SIGTERM 후 **30초**가 지나면 SIGKILL로 강제 종료합니다. 그러면 통화가 뚝 끊깁니다. `terminationGracePeriodSeconds`를 "최장 통화 길이 + 여유"로 늘려야 합니다(15장). 이것이 [tech-stack.md 6장](../tech-stack.md#6-전체-아키텍처)이 말한 "배포할 때 진행 중인 통화가 끝날 때까지 기다리는 설정"입니다.

자식 프로세스는 SIGTERM을 무시하고 부모의 지시로만 종료합니다. 그래서 Dockerfile이 `CMD ["node", "src/main.ts", "start"]`처럼 **node를 PID 1로 직접** 실행하는 것이 중요합니다. `sh -c`로 감싸면 셸이 신호를 node에 전달하지 않아 drain이 일어나지 않습니다.

---

## 4-8. 방 없이 실행하기: console과 debugger

| 도구 | 동작 |
| --- | --- |
| `lk agent console` | 워커 등록·프로세스 풀·방 연결 없이, **같은 프로세스**에서 가짜 잡(metadata 없음 → 가상 고객)으로 entry를 실행. 맥 마이크 오디오가 TCP로 들어오고(48kHz → 24kHz), 출력은 반대로 나감. RoomIO 대신 콘솔 입출력을 쓰므로 **노이즈 제거는 적용되지 않음** |
| `lk agent debugger` | console 모드를 기반으로, 기본적으로 STT·TTS를 끄고 글로 대화. 턴마다 도구 호출과 답을 보여 줌 (14장) |
| `lk agent dev` + Agent Console | 진짜 워커로 등록하고 진짜 방에서 브라우저로 대화. 운영과 가장 비슷한 PoC 환경 |

console 모드에서 들은 소리는 노이즈 제거 없이 맥 마이크를 그대로 쓴 결과라는 점, 그리고 개발 모드라 턴 감지가 클라우드 `v1`이라는 점(4-5절)을 기억해 두면 측정값을 해석할 때 도움이 됩니다.

---

## 4-9. 정리

```text
cli.runApp ─▶ 워커: LiveKit에 WebSocket 등록 (agentName = 명시 디스패치만)
                │  functions-xtool: createDispatch(room, 'xtool-sales-agent', metadata)
                ▼
              잡 배정 ─▶ 유휴 자식 프로세스에서 entry(ctx)
                          ├ parseCallContext(ctx.job.metadata)  (zod 계약, 실패 시 안전한 기본값)
                          ├ AgentSession 구성 + 이벤트 구독
                          ├ session.start → RoomIO (24kHz 입출력, 노이즈 제거, 자막)
                          └ say ×2 → 반환 (통화는 계속)
              종료: 방 끊김 / ctx.shutdown / 워커 종료 요청 / 예외
              배포: SIGTERM → drain → (grace period 안에) 종료
```

---

## 확인 문제

1. 에이전트 워커가 Cloud Functions에 맞지 않는 이유 두 가지를 쓰세요.
2. `agentName`을 정한 워커는 어떤 방에 들어갑니까? 브라우저 테스트 때 무엇을 해야 합니까?
3. metadata JSON이 깨졌을 때 가상 고객 대신 빈 정보를 쓰는 이유는?
4. 통화마다 스레드가 아니라 프로세스를 쓰는 이유를 Node.js의 이벤트 루프와 연결해 설명하세요.
5. `main.ts` 최상위에 무거운 초기화 코드를 넣으면 어떤 문제가 생기고, 대신 어디에 넣어야 합니까?
6. GKE에서 `start`로 운영하면 턴 감지 모델이 PoC 때와 달라질 수 있는 이유는?
7. 쿠버네티스 기본 설정으로 배포하면 통화가 끊길 수 있는 이유와 해결책은?

<details>
<summary>답 보기</summary>

1. 통화가 수 분씩 이어지고, 방·STT·TTS와 연결을 계속 유지하며 상태를 들고 있어야 하기 때문입니다.
2. 명시 디스패치로 자기 이름이 지정된 방에만 들어갑니다. 브라우저 테스트 때는 에이전트 이름 `xtool-sales-agent`를 지정해 연결해야 합니다.
3. metadata가 있었다면 실제 통화일 가능성이 높아, 가상 이름을 부르면 실제 고객에게 남의 이름을 부르게 되기 때문입니다.
4. Node는 프로세스당 이벤트 루프 하나에서 돌기 때문에, VAD·노이즈 제거 같은 동기 CPU 작업이 길어지면 그 프로세스의 모든 일이 멈춥니다. 통화마다 프로세스를 나누면 서로 막지 않고, 장애와 메모리도 격리됩니다.
5. 잡 프로세스마다 main.ts를 다시 import하므로 모든 프로세스가 그 비용을 냅니다. `prewarm` 함수에 넣고 `ctx.proc.userData`로 넘깁니다.
6. 버전을 지정하지 않으면 개발 모드는 클라우드 `v1`, 직접 운영의 `start`는 로컬 `v1-mini`를 기본으로 고르기 때문입니다.
7. SIGTERM 후 30초가 지나면 SIGKILL되어 drain 중인 통화가 끊깁니다. `terminationGracePeriodSeconds`를 최장 통화 길이 이상으로 늘립니다.

</details>
