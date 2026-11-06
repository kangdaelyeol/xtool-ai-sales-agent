# 4장. 워커와 잡 — 에이전트 프로그램은 어떻게 실행되는가

[src/main.ts](../../src/main.ts)를 처음 보면 이상한 점이 있습니다. 서버를 띄우는 코드(`listen(8080)`)가 없고, `entry` 함수를 정의해서 `defineAgent()`에 넘긴 뒤 `cli.runApp()`만 부릅니다. 그런데 이 `entry`는 **누가, 언제, 어디서** 부를까요? 이 장은 LiveKit Agents의 실행 구조(워커, 잡, 프로세스)를 SDK 코드 기준으로 설명합니다. 배포·운영(15장)을 이해하는 바탕이 됩니다.

> 이 장의 SDK 경로는 `node_modules/@livekit/agents/src/` 기준입니다. 실제로 실행되는 것은 같은 패키지의 `dist/*.js`입니다.

(2026-11-06 추가) 이번 판에서는 "선 위로 실제로 무엇이 지나가는가"와 "어느 스레드에서 도는가"를 더했습니다. 워커가 LiveKit에 보내는 protobuf 메시지를 바이트 단위로 풀고(4-2절), 부하 숫자를 cgroup 식으로 계산하고(4-2절), 디스패치 2.8초를 단계별로 나누고(4-3절), 이벤트 루프가 막힐 때의 숫자와 스레드 지도를 그리고(4-4절), 턴 감지 요청 하나의 크기를 셉니다(4-5절). 1장처럼 숫자마다 코드로 확인했는지, 잰 값인지, 추정인지를 적었습니다. 실습 스크립트 세 개는 키 없이 돕니다([lab/04-protobuf-bytes.mjs](lab/04-protobuf-bytes.mjs), [lab/04-loop-block.mjs](lab/04-loop-block.mjs), [lab/04-ipc-json.mjs](lab/04-ipc-json.mjs)). 깊은 내용은 "깊이 보기"에 두었으니 처음에는 건너뛰어도 됩니다.

---

## 이 장에서 쓰는 말 (2026-11-06 추가)

처음 보면 막히는 말만 모았습니다. 전체 용어집은 [17장](17-glossary-and-next.md)입니다.

| 말 | 뜻 |
| --- | --- |
| fork / IPC | fork는 Node가 같은 프로그램의 자식 프로세스를 띄우면서 부모와 이어진 통로를 함께 여는 것(`child_process.fork`)입니다. 그 통로로 메시지를 주고받는 것이 IPC(프로세스 간 통신)이고, 기본 형식은 JSON 한 줄입니다(4-5절) |
| protobuf 태그·와이어 타입 | protobuf는 칸마다 "몇 번 칸, 어떤 모양"을 1바이트 남짓의 태그로 앞에 붙입니다. 태그 = (필드 번호 << 3) \| 와이어 타입. 와이어 타입은 0 = varint, 2 = 길이 접두(문자열·하위 메시지), 5 = 4바이트 고정(float) 등입니다(4-2절) |
| varint | 정수를 7비트씩 끊어 아래 자리부터 적고, 뒤에 바이트가 더 있으면 맨 위 비트를 1로 두는 가변 길이 정수입니다. 작은 수는 1바이트입니다 |
| cgroup | 리눅스가 프로세스 묶음(컨테이너)의 CPU·메모리를 재고 제한하는 장치입니다. 컨테이너 안에서 `/sys/fs/cgroup/cpu.max`(한도)와 `cpu.stat`(쓴 시간)으로 보입니다(4-2절) |
| SIGTERM / SIGKILL | 프로세스에 보내는 종료 신호입니다. SIGTERM은 "정리하고 끝내라"(프로그램이 받아서 처리 가능), SIGKILL은 운영체제가 즉시 죽임(받을 수 없음)입니다 |
| PID 1 | 컨테이너 안에서 처음 실행된 프로세스입니다. 신호가 이 프로세스로 가므로, 셸이 PID 1이면 node가 SIGTERM을 못 받을 수 있습니다(4-7절) |
| drain | "새 일은 안 받고, 하던 일은 끝까지" 하는 종료 방식입니다(4-7절) |
| preload / prewarm | preload는 SDK가 자식 프로세스마다 네이티브 바인딩을 미리 올리는 준비, prewarm은 사용자가 정의하는 같은 성격의 준비 함수입니다(4-4절) |
| 네이티브 바인딩 | C++·Rust로 컴파일한 `.node` 파일을 JS에서 부르는 것입니다. rtc-node(WebRTC), local-inference(VAD·턴 감지 모델), ai-coustics(노이즈 제거)가 이것입니다(3-3절) |
| libuv 스레드 풀 | Node가 파일 읽기 같은 막히는 일을 메인 스레드 밖에서 처리하려고 둔 작업 스레드 묶음(기본 4개)입니다. 네이티브 바인딩도 계산을 여기로 넘기고 Promise로 결과를 줄 수 있습니다(4-4절) |
| 이벤트 루프 | Node가 메인 스레드 하나에서 타이머·네트워크·메시지 콜백을 차례로 돌리는 고리입니다. 동기 코드가 오래 돌면 그동안 다른 콜백이 모두 기다립니다(4-4절) |

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

[2-tech-stack.md 6장](../2-tech-stack.md#6-전체-아키텍처)이 "에이전트 워커는 Cloud Functions/Cloud Run이 아니라 GKE Autopilot 또는 GCE"라고 정한 이유가 이것입니다.

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

(2026-11-06 추가) 두 가지를 덧붙입니다.

- **이 WebSocket은 JS가 엽니다.** 워커 등록 연결은 `ws` 라이브러리(8.22.1)로 여는 순수 JS 연결입니다(`worker.ts` 480~491). 3-3절에서 본 **방 시그널링**(`/rtc`)과 WebRTC 미디어는 잡 프로세스 안의 네이티브 rtc-node(Rust)가 따로 엽니다. 그래서 워커 프로세스에는 네이티브 WebRTC가 없고, 잡 프로세스마다 하나씩 있습니다. 두 연결 모두 protobuf를 쓰지만 메시지 종류(`WorkerMessage`와 `SignalRequest`)가 다릅니다.
- **재접속 간격**은 `min(시도 횟수 × 2, 10)`초입니다(`worker.ts` 505~514). 2, 4, 6, 8, 10초, 그 뒤로 10초씩, 열 번 다시 시도하면 모두 합쳐 약 80초를 기다린 셈이고, 그래도 안 되면 `WorkerError`로 끝납니다. LiveKit 장애가 1~2분 넘게 이어지면 워커가 스스로 종료하고, 쿠버네티스가 다시 띄웁니다.

#### 깊이 보기: 선 위의 메시지 — 종류와 바이트 (2026-11-06 추가)

워커와 서버가 주고받는 메시지는 각각 하나의 봉투 메시지(`WorkerMessage`, `ServerMessage`) 안에 **oneof**(여러 칸 중 하나만 채우는 칸)로 들어갑니다. 정의는 `@livekit/protocol` 1.53.1의 `src/gen/livekit_agent_pb.js` 119~147행이고, 아래 "Node SDK 1.9.5"는 `worker.ts`에서 그 칸을 실제로 쓰는지 찾아본 결과입니다(코드).

| 방향 | 칸 번호 · 이름 | 내용 | Node SDK 1.9.5 |
| --- | --- | --- | --- |
| 워커 → 서버 | 1 `register` | 이름·판·권한·배포 이름으로 등록 | 연결마다 첫 메시지 (786~806) |
| | 2 `availability` | 일 제안에 대한 수락/거절, 방에 들어갈 identity | 수락 893~918, 거절 877~891 |
| | 3 `updateWorker` | 부하(`load`, float32)와 상태(가용/가득 참) | 2.5초마다 (810~865), drain 때 (582~592, 그 뒤 816~830) |
| | 4 `updateJob` | 잡 상태 보고 | **안 씀** |
| | 5 `ping` | 응용 계층 ping | **안 씀** |
| | 6 `simulateJob` | 서버에 가짜 잡 요청 | `connect --room` 명령 (`cli.ts` 57 → `worker.ts` 619~652) |
| | 7 `migrateJob` | 재접속 뒤 "아직 이 잡들을 돌리고 있음" | 등록 응답 직후 (551~571) |
| 서버 → 워커 | 1 `register` | 등록 응답: `workerId`, 서버 정보 | 723~741. 첫 메시지가 이것이 아니면 오류 (717~720) |
| | 2 `availability` | 일 제안: `Job`(방, metadata, 에이전트 이름…) | 743~757 → `#availability` |
| | 3 `assignment` | 배정: `Job` + 방 URL + **방 접속 토큰(JWT, 3-7절)** | 758~769 |
| | 5 `termination` | 이 잡을 끝내라 | 770~781 → 잡 프로세스 닫기 |
| | 4 `pong`, 6 `go_away` | ping 응답, 연결 이전 안내 | **처리 안 함** (switch에 없음) |

연결이 살아 있는지는 응용 계층 ping 대신 WebSocket 자체의 ping/pong 프레임에 맡기는 것으로 보입니다(`ws`는 서버의 ping 프레임에 자동으로 pong을 보냄). 서버가 실제로 ping 프레임을 보내는지는 **확인하지 않았습니다**.

**바이트를 손으로 풀기.** protobuf는 칸마다 **태그**를 앞에 붙입니다. 태그 = (필드 번호 << 3) | 와이어 타입이고, 태그 자체도 varint입니다. 와이어 타입 0은 varint 값, 2는 "길이(varint) + 그만큼의 바이트"(문자열·하위 메시지), 5는 4바이트 고정 길이(float32, 리틀 엔디언)입니다. proto3는 **기본값(0, false, 빈 문자열)인 칸을 아예 보내지 않습니다.** 칸 이름도 보내지 않습니다. 이름은 양쪽이 가진 스키마에만 있습니다.

[lab/04-protobuf-bytes.mjs](lab/04-protobuf-bytes.mjs)는 `worker.ts`가 만드는 것과 같은 메시지를 `@livekit/protocol` 클래스로 만들어 `toBinary()`를 찍고, 직접 짠 작은 디코더(`readVarint`, `walk`)로 한 칸씩 풉니다(서버 접속 없음). 실제 출력입니다.

```text
== 1. register (SDK 1.9.5에서 실제로 보내는 모양) ==
40바이트: 0a 26 1a 05 31 2e 39 2e 35 3a 0a 08 01 10 01 18 01 50 01 58 01 42 11 78 74 6f 6f 6c 2d 73 61 6c 65 73 2d 61 67 65 6e 74
0a  = 필드 1, 길이 접두, 길이 38 → RegisterWorkerRequest
    1a  = 필드 3, 길이 접두, 길이 5 → "1.9.5"
    3a  = 필드 7, 길이 접두, 길이 10 → ParticipantPermission
        08  = 필드 1, varint → 01 = 1
        10  = 필드 2, varint → 01 = 1
        18  = 필드 3, varint → 01 = 1
        50  = 필드 10, varint → 01 = 1
        58  = 필드 11, varint → 01 = 1
    42  = 필드 8, 길이 접두, 길이 17 → "xtool-sales-agent"
같은 내용의 protobuf JSON: 185바이트
(비교) 권한 칸을 뺀 최소형: 28바이트, JSON 64바이트

== 2. updateWorker (load 0.42, 가용) ==
9바이트: 1a 07 08 00 1d 3d 0a d7 3e
1a  = 필드 3, 길이 접두, 길이 7 → UpdateWorkerStatus
    08  = 필드 1, varint → 00 = 0
    1d  = 필드 3, fixed32 → 3d 0a d7 3e (리틀 엔디언 float32) = 0.41999998688697815
JSON: 54바이트 {"updateWorker":{"status":"WS_AVAILABLE","load":0.42}}
```

register 40바이트를 한 바이트씩 읽으면 이렇습니다.

| 바이트 | 계산 | 뜻 |
| --- | --- | --- |
| `0a` | 0x0a = 10 = (1 << 3) \| 2 | `WorkerMessage`의 1번 칸(`register`), 길이 접두 |
| `26` | 38 | 뒤 38바이트가 `RegisterWorkerRequest` |
| `1a 05` + 5바이트 | 0x1a = (3 << 3) \| 2 | 3번 칸 `version`, 길이 5: `31 2e 39 2e 35` = "1.9.5" (ASCII) |
| `3a 0a` + 10바이트 | 0x3a = (7 << 3) \| 2 | 7번 칸 `allowed_permissions`, 길이 10짜리 하위 메시지 |
| `08 01` `10 01` `18 01` | (1 << 3) \| 0 = 8, 16, 24 | `can_subscribe`, `can_publish`, `can_publish_data` = true |
| `50 01` `58 01` | (10 << 3) \| 0 = 80 = 0x50, 88 = 0x58 | `can_update_metadata`, `agent` = true. `hidden`(false)은 기본값이라 없음 |
| `42 11` + 17바이트 | 0x42 = (8 << 3) \| 2, 0x11 = 17 | 8번 칸 `agent_name` = "xtool-sales-agent" |

빠진 칸도 읽을거리입니다. `type`(JT_ROOM = 0)은 기본값이라 보내지 않고, `deployment`도 `LIVEKIT_AGENT_DEPLOYMENT` 환경변수가 없으면(`worker.ts` 343) 빈 문자열이라 보내지 않습니다. 배포 이름이 있으면 9번 칸(`4a` + 길이 + 이름)이 붙습니다. `lk agent dev`가 `dev-…` 이름을 이 환경변수로 넘기는지는 이 레포에서 확인하지 않았습니다(**추정**). 칸은 코드에 적은 순서가 아니라 **번호 순**(3 → 7 → 8)으로 나옵니다. 이 판의 protobuf-es가 그렇게 쓸 뿐이고, 받는 쪽은 순서와 상관없이 읽습니다.

updateWorker는 더 짧습니다. `08 00`은 `status` = 0(가용)입니다. 0이 기본값인데도 실리는 이유는 이 칸이 `optional`로 선언되어 "값이 있음"을 따로 표시하기 때문입니다(`opt: true`, 같은 파일 267~278행). `1d`는 (3 << 3) | 5, 즉 3번 칸 `load`가 float32라는 뜻이고, 뒤 4바이트 `3d 0a d7 3e`를 리틀 엔디언으로 읽은 0x3ED70A3D가 0.42에 가장 가까운 float32입니다. 그래서 서버가 받는 값은 0.41999998688697815입니다. 부하가 0이면 `load` 칸이 통째로 빠져 `1a 02 08 00` 4바이트가 되고, drain 때 보내는 "가득 참"은 `1a 02 08 01`입니다(같은 방법으로 확인).

| 메시지 | protobuf | 같은 내용의 JSON | 비율 |
| --- | --- | --- | --- |
| register (실제) | 40B | 185B | 4.6배 |
| register (권한 칸 없는 최소형) | 28B | 64B | 2.3배 |
| updateWorker | 9B | 54B | 6배 |
| availability 수락 (가짜 잡 ID, identity, `lk.agent.name` 속성) | 80B | | |

**선 위에서는 조금 더 붙습니다(계산).** WebSocket은 메시지마다 프레임 머리를 붙입니다(RFC 6455). 클라이언트(워커)가 보내는 프레임은 2바이트 머리 + 4바이트 마스킹 키가 붙으므로, 9바이트 updateWorker는 15바이트 프레임이 됩니다. TLS 1.3 레코드 하나(머리 5 + 내용 형식 1 + 인증 태그 16 = 22바이트)에 실리면 37바이트이고, TCP·IP 머리는 따로입니다. 2.5초에 한 번이니 초당 15바이트 정도입니다. 압축 확장(permessage-deflate)은 따지지 않았습니다. 워커 제어 연결은 1장 표 ①의 말대로 **양이 아니라 순서와 지연이 중요한 연결**입니다.

#### 깊이 보기: 부하 숫자는 어떻게 나오나 — cgroup 식과 동시 통화 손 계산 (2026-11-06 추가)

`load`는 SDK의 `cpuMonitor.cpuPercent(2500)`가 냅니다(`worker.ts` 127~132, `cpu.ts`). 실행 환경에 따라 셋 중 하나를 고릅니다(`cpu.ts` 169~173).

| 환경 | 고르는 조건 | 식 |
| --- | --- | --- |
| cgroup v2 (요즘 쿠버네티스·Docker) | `/sys/fs/cgroup/cpu.stat`이 있음 | Δ`usage_usec` ÷ (Δt × 허용 CPU 수) (`cpu.ts` 53~101) |
| cgroup v1 (옛 리눅스) | `/sys/fs/cgroup/cpuacct/cpuacct.usage`가 있음 | 같은 식, 단위만 ns. 한도를 못 읽으면 CPU 2개로 가정 (105~150) |
| 그 밖 (내 맥) | 위 둘 다 없음 | `os.cpus()`의 코어별 시간으로 1 − (쉰 시간 ÷ 전체 시간) (25~50) |

cgroup v2 쪽을 풀면 이렇습니다.

```text
허용 CPU 수 = cpu.max의 quota ÷ period        예: "200000 100000" → 2 (CPU 2개)
                                              "max 100000"이면 한도 없음 → 호스트 코어 수
load = (2.5초 뒤 usage_usec − 지금 usage_usec) ÷ (2,500,000µs × 허용 CPU 수), 0~1로 자름

예: 2 vCPU에서 2.5초 동안 컨테이너가 CPU를 3,500,000µs(3.5 CPU초) 썼다
    → 3,500,000 ÷ (2,500,000 × 2) = 0.70 → 임계값 0.7 이상이라 "가득 참" (worker.ts 836, >= 비교)
```

- `usage_usec`은 **컨테이너 전체**(워커, 추론 프로세스, 유휴·통화 중 잡 프로세스 모두)가 쓴 CPU 시간입니다. 통화 하나가 아니라 묶음 전체의 부하입니다.
- 쿠버네티스에서 CPU limit을 2로 주면 `cpu.max`가 "200000 100000"이 되는 것이 일반적인 동작입니다. GKE Autopilot에서 실제 값은 **확인 필요**입니다. `NUM_CPUS` 환경변수가 있으면 CPU 수를 그 값으로 덮습니다(`cpu.ts` 13~22).
- 내 맥(`dev`)은 맥 전체 CPU를 잽니다. 다른 앱이 바쁘면 워커 부하도 높게 나옵니다. dev의 임계값은 무한대라 거절은 없습니다.
- LiveKit Cloud에 배포한 에이전트는 사용자 지정 `loadFunc`·`loadThreshold`를 무시하고 기본값을 씁니다(`worker.ts` 378~397).

**늦게 반응한다는 점**이 0.7의 여유와 이어집니다. 값은 지난 2.5초의 평균이고, 워커는 일 제안을 받을 때 부하를 다시 보지 않습니다(`#availability`는 drain 여부만 봄, 963~974). 그래서 2.5초 안에 몰려 온 통화는 "가득 참"이 서버에 닿기 전에 다 받을 수 있고, 갓 시작한 통화의 CPU는 다음 창에야 잡힙니다. 30%의 여유는 이렇게 넘쳐 들어오는 몫을 위한 자리로 볼 수 있습니다(해석). 서버가 워커별 잡 수를 따로 세어 조절하는지는 확인하지 않았습니다.

**2 vCPU에서 동시 통화는 몇 개?** 손으로 계산하는 틀입니다. 숫자는 **가정**이고, 실제 값은 이 프로젝트의 통화로 재야 합니다.

```text
C = 허용 CPU 수, B = 통화가 없을 때의 기본 사용량(CPU 개 단위), c = 통화 하나의 평균 사용량
"가득 참"이 되지 않는 동시 통화 수 N:  B + N·c < 0.7·C  →  N < (0.7·C − B) ÷ c

가정: C = 2, B = 0.10 (워커·추론·유휴 프로세스가 노는 동안), c = 0.25 (노이즈 제거·VAD·리샘플·JSON 처리)
      N < (1.4 − 0.10) ÷ 0.25 = 5.2  →  5통화. 여섯 번째가 들어오는 창에서 0.7을 넘음
```

c를 재는 방법: 통화 하나를 건 채로 컨테이너 안에서 `cat /sys/fs/cgroup/cpu.stat`을 2.5초 간격으로 두 번 읽어 위 식에 넣거나, 맥에서는 `ps -o pid,%cpu,command`로 잡 프로세스의 CPU 사용률을 봅니다(4-4절 "프로세스 트리"). 직접 운영에서 턴 감지가 `v1-mini`면(4-5절) 추론 한 번이 이 맥에서 프로세스 CPU 약 70ms를 썼습니다(4-4절 실습: 20번에 1,402ms). 2 vCPU의 2.5초 창(5 CPU초)에서 한 번에 약 1.4%입니다. 예측을 몇 번 부르는지에 따라 c에 더해집니다.

---

## 4-3. 디스패치: 어떤 방에 어떤 에이전트를 보낼까

**디스패치(dispatch)**는 "이 방에 이 에이전트를 투입하라"는 결정입니다. 두 가지 방식이 있습니다.

| 방식 | 조건 | 동작 |
| --- | --- | --- |
| 자동 디스패치 | 워커의 `agentName`이 **비어 있음** | 방이 생기면 자동으로 에이전트가 들어감 |
| **명시 디스패치** | 워커에 `agentName`이 **있음** | 누군가 API로 "이 방에 `xtool-sales-agent`를 보내라"고 요청할 때만 들어감 |

이 프로젝트는 `agentName: 'xtool-sales-agent'`를 정했으므로 **명시 디스패치만** 받습니다. 그래서 브라우저 Agent Console에서 테스트할 때 에이전트 이름을 지정해야 합니다([4-setup-checklist.md 5-3](../4-setup-checklist.md#5-3-브라우저-agent-console)). 운영에서 이것이 맞는 선택인 이유는, 아무 방에나 영업 상담원이 들어가면 안 되기 때문입니다. 통화를 걸기로 결정한 functions-xtool만 에이전트를 부릅니다.

명시 디스패치를 요청하는 통로는 세 가지입니다.

| 통로 | 방법 | 이 프로젝트 |
| --- | --- | --- |
| **접속 토큰의 방 설정** | 토큰의 `roomConfig`에 배정할 에이전트(`RoomAgentDispatch`)를 넣음. 그 토큰으로 누가 방에 들어오면 배정됨 | **웹 테스트가 이 방식** (3-7절) |
| 배정 API | 서버 SDK의 `AgentDispatchClient.createDispatch(방, 에이전트 이름, { metadata })` | 전화 발신에서 쓸 수 있는 후보 |
| SIP 배정 규칙 | 걸려 온 전화를 방으로 넣으면서 에이전트 배정 | 대표번호 수신(나중) |

토큰 방식은 **배정 API를 따로 부르지 않아도 된다**는 장점이 있습니다. 토큰을 발급하는 순간 "이 방에는 이 에이전트가 이 고객 정보로 들어간다"가 함께 정해지므로, 방 접속과 에이전트 배정이 어긋날 일이 없습니다.

### job metadata: 통화별 정보를 실어 보내는 통로

디스패치를 요청할 때 **metadata**(문자열)를 함께 보낼 수 있습니다. 웹 테스트에서는 functions-xtool(`createVoiceAgentSession`)이 관리 화면에서 받은 가상 고객 정보를 JSON 문자열로 만들어 토큰의 에이전트 배정 정보에 넣습니다. 배정 API를 쓴다면 같은 문자열을 `createDispatch`의 `metadata`로 넘기면 됩니다.

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

### 계약이 두 곳에 적혀 있다는 위험

웹 테스트가 생기면서 같은 계약이 **두 레포에 따로** 적히게 됐습니다.

| 위치 | 정의 |
| --- | --- |
| 이 레포 [src/call-context.ts](../../src/call-context.ts) | `CallContextSchema` (zod, 받는 쪽 검증) |
| originalshq `functions-xtool/src/endpoints/voice-agent.ts` | `CallContext` (보내는 쪽 모양, `installment` 값 검사) |

(2026-11-03 갱신) 통화 결과 전송(15-6절)이 생기면서 반대 방향의 계약도 하나 늘었습니다. 에이전트가 보내는 대화록 한 줄(`CallTurn`, [src/call-result.ts](../../src/call-result.ts))은 originalshq의 `voice-call/types.ts`와 모양이 같아야 합니다. 이번에는 이 레포가 **보내는 쪽**입니다.

(2026-11-04 갱신) originalshq 쪽 코드(커밋 `a7687d0`·`d57c577`·`d7054a1`)를 읽어 보니, 같은 모양이 관리 화면에도 손으로 옮겨 적혀 있습니다. 지금 있는 사본을 모두 모으면 이렇습니다.

| 계약 | 이 레포 | functions-xtool | 관리 화면 |
| --- | --- | --- | --- |
| 고객 정보 (metadata) | `call-context.ts` `CallContextSchema` (zod, `callId`는 선택) | `voice-call/types.ts` `CallContext` (`callId` 필수) | `voice-agent-client.ts` `TestCallInput` |
| 가상 고객 예시 | `call-context.ts` `SAMPLE_CALL` | | `voice-agent-panel.tsx` `SAMPLE_CALL` ("에이전트 레포와 같다"는 주석) |
| 대화록·지연 기록 | `call-result.ts` `CallTurn`, `CallLatency` | `types.ts` 같은 이름 | `VoiceCallRecord` 안에 다시 적음 |
| 판정 칸 | | `analyze.ts` `CallJudgmentSchema` (zod) | `VoiceCallJudgment` |
| 에이전트 이름 | `main.ts` `agentName: 'xtool-sales-agent'` | `voice-agent.ts` `AGENT_NAME` | |

한 레포 안에서는 사본을 줄였습니다. functions-xtool은 엔드포인트와 판정이 `types.ts` 하나를 같이 쓰고, 판정 칸 타입은 zod 스키마에서 뽑습니다(`z.infer`). 사본이 생기는 곳은 **레포 경계**와 **서버·브라우저 경계**입니다. 서버·브라우저 사이는 같은 레포라도 빌드가 따로라 타입을 그대로 가져다 쓰기 어렵습니다.

대부분 고쳐도 조용합니다. 판정 칸 이름을 바꾸면 화면의 그 칸이 "—"로 보일 뿐이고, 에이전트 이름이 어긋나면 "에이전트가 방에 안 들어옴"으로만 드러납니다.

[6-web-test.md 3장](../6-web-test.md#3-에이전트에-넘기는-고객-정보-metadata-계약)은 "한쪽을 바꾸면 다른 쪽도 바꾼다"고 적어 두었습니다. 사람의 기억에 기대는 규칙이라, 한쪽만 바뀌면 에이전트가 깨진 metadata로 보고 "고객님"으로 진행하거나(③), 새 필드를 조용히 무시합니다. 오류가 나지 않으니 늦게 발견됩니다. 줄이는 방법은 다음과 같습니다.

- **보내는 쪽도 검증**: functions-xtool이 이미 `installment` 값을 검사하는 것처럼, 보내기 전에 모양을 확인합니다(지금 하고 있음).
- **계약 테스트**: 한쪽 레포에 "상대가 보내는 예시 JSON"을 두고, 이 레포의 `parseCallContext`가 그것을 기본값 없이 그대로 읽는지 테스트합니다(14-3절의 생각과 같음).
- **스키마 공유**: 두 레포가 같은 스키마 파일(예: JSON Schema)을 참조하게 합니다. 레포가 둘이라 설정 비용이 있습니다.

### 개발 워커와 운영 워커 분리: 배포 이름

LiveKit은 같은 에이전트 이름 안에서도 **배포(deployment)** 이름으로 워커 무리를 나눕니다.

| 실행 방법 | 워커가 등록되는 배포 |
| --- | --- |
| LiveKit Cloud에 배포한 에이전트 | `production` (또는 따로 만든 `staging` 등) |
| `lk agent dev` (CLI 2.19.0 이상, 지금 설치된 것은 2.19.3) | **무작위 `dev-…`** |
| `lk agent dev --deployment production` | `production` |

그리고 **디스패치 요청(토큰·배정 API)에서 배포 이름을 생략하면 `production`으로 갑니다.** 그래서 운영 트래픽이 개발자 노트북으로 새지 않습니다. 반대로 말하면, **배포 이름 없이 만든 토큰은 `lk agent dev`로 띄운 개발 워커에 닿지 않습니다.** `lk agent dev`가 출력하는 Agent Console 링크는 그 `dev-` 배포를 지정하므로 콘솔 테스트는 잘 되지만, 다른 경로로 배정하려면 배포 이름을 맞춰야 합니다.

[6-web-test.md 6-3](../6-web-test.md#6-3-에이전트-워커--둘-중-하나)의 A안("내 맥에서 `lk agent dev`")은 functions-xtool이 만든 토큰으로 배정하므로 이 규칙에 걸릴 수 있습니다. 같은 문서의 확인 결과(접속 2.8초 뒤 에이전트 참가)는 어떤 방식으로 띄운 워커였는지 적혀 있지 않습니다. 실제 웹 화면으로 통화가 안 되면 첫 의심 지점이고, `lk agent dev --deployment production`으로 띄우거나 토큰에 배포 이름을 넣는 것이 해결책입니다. LiveKit Cloud에 `production`이 배포된 상태에서 개발 워커도 `production`으로 띄우면 두 워커가 같은 트래픽을 나눠 받는다는 점도 주의합니다. (CLI 도움말과 LiveKit 문서로 확인한 규칙이며, 웹 테스트 A안에서 실제로 어떻게 되는지는 **확인 필요**입니다.)

#### 깊이 보기: 2.8초를 쪼개기 — 디스패치 시각표 (2026-11-06 추가)

3-7절의 웹 테스트 확인 결과는 "방에 접속하고 2.8초 뒤 에이전트가 참가"였습니다. 이 2.8초 안에서 워커 쪽이 맡는 구간은 SDK가 시각을 찍어 둡니다. `#availability`가 받은 시각부터 차례로 `RunningJobInfo`에 실어 잡 프로세스로 넘기고(`worker.ts` 874~944, `job.ts` 161~169), 잡 프로세스가 트레이스에 기록합니다(`ipc/job_trace.ts` 46~76). 코드로 확인한 순서입니다.

```text
브라우저: 토큰으로 방 접속 (roomConfig.agents에 xtool-sales-agent, deployment "")
  │  서버: 방 생성 → 배포 "production"의 워커 하나를 골라 일 제안          ← 워커가 볼 수 없는 구간
  ▼
receivedAt   ServerMessage.availability 도착 (worker.ts 746, 로그 "received job request")
  │  requestFunc: 기본값은 바로 accept() (worker.ts 123~125)
acceptedAt   WorkerMessage.availability{available: true} 보냄 (895)
  │  서버 왕복 1번: 서버가 방 접속 토큰을 만들어 보냄
  │  7.5초 안에 안 오면 경고 "assignment for job … timed out" (ASSIGNMENT_TIMEOUT, 921~925)
assignedAt   ServerMessage.assignment 도착 (943)
  │  프로세스 풀에서 잡 프로세스 얻기 (ipc/proc_pool.ts 71~97)
  │    start: 유휴 프로세스를 꺼냄 (거의 0)
  │    dev:   유휴 프로세스가 0개라 이때 fork → main.ts import → preload → prewarm → 초기화 응답
launchedAt   잡 프로세스에 startJobRequest 보냄 (proc_pool.ts 95)
  │  잡 프로세스: 트레이스 준비 (_prepareTelemetry)
entrypoint   entry(ctx) 시작 (job_proc_lazy_main.ts 178)
  │  session.start → 방 접속: 시그널링 WebSocket, ICE·DTLS (3장)
  ▼
브라우저: 에이전트 참가자가 보임
```

- **7.5초 제한은 경고뿐입니다.** 타이머가 끝나도 기다림을 멈추지 않습니다. 배정이 늦게라도 오면 그대로 잡을 띄웁니다(`worker.ts` 921~929).
- **트레이스 속성 이름**: 이웃한 두 시각의 차이를 초 단위로 `lk.job.accept_latency`(받음 → 수락), `lk.job.assignment_latency`(수락 → 배정), `lk.job.launch_latency`(배정 → 프로세스), `lk.job.entrypoint_latency`(프로세스 → entry), 그리고 합계 `lk.job.dispatch_latency`로 남깁니다(`telemetry/trace_types.ts` 64~72). 서버가 잡을 시작한 시각(`job_started_on_server`)도 같은 span에 이벤트로 붙습니다. 이 트레이스는 LiveKit Cloud URL일 때 LiveKit Cloud 관측 기능으로 올라갑니다(`job.ts` 55~75, 388~402).

**어느 구간이 클까(추정).** `dev`에서는 유휴 프로세스가 없으므로 배정 → 프로세스 구간에 fork와 모듈 불러오기가 통째로 들어갑니다. 받음 → 수락은 기본 `requestFunc`가 바로 수락하므로 1ms 안팎, 수락 → 배정은 LiveKit 서버까지의 왕복 한 번입니다(SDK 주석도 "a server round trip", `telemetry/trace_types.ts` 65). 그래서 2.8초의 대부분은 **잡 프로세스 준비(dev의 fork)와 방 접속**일 것으로 봅니다. 3-7절이 이 2.8초를 어느 모드의 워커로 쟀는지 적혀 있지 않아, 이 나눔은 아직 재지 않은 **추정**입니다.

**직접 쪼개 보는 방법.** 키가 있는 사용자 환경에서 `lk agent dev --log-level DEBUG`로 워커를 띄우고 한 번 통화한 뒤, 로그에서 아래 줄들의 시각을 뽑습니다. 개발 모드 로그는 pino-pretty(11.3.0)로 찍히고, 기본값(`translateTime: true`)이라 줄 앞에 `[시:분:초.밀리초]`가 붙습니다. `lk agent dev`가 출력을 다른 모양으로 바꿔 보여 주는지는 확인하지 않았습니다.

| 로그 메시지 | 프로세스·수준 | 시각표의 자리 |
| --- | --- | --- |
| `received job request` | 워커, info | receivedAt |
| `initializing job runner` | 잡, debug | dev에서 fork 직후 (`job_proc_lazy_main.ts` 330) |
| `preloaded the local inference binding` (`elapsed` ms 포함) | 잡, debug | preload (`ipc/_preload.ts` 26·40) |
| `job runner initialized` | 잡, debug | 초기화 끝 (335) |
| `job started` | 잡, debug | launchedAt 직후 (382) |
| `Auto-connecting to room via job context` | 잡, debug | entry 안에서 방 접속 시작 (`voice/agent_session.ts` 1003) |

```bash
# 로그를 파일로 남겨 두고 (터미널에도 보이게)
lk agent dev --log-level DEBUG 2>&1 | tee /tmp/agent-dev.log
# 통화 한 번 뒤, 시각표의 줄만 고르기
grep -E "received job request|initializing job runner|preloaded|job runner initialized|job started|Auto-connecting" /tmp/agent-dev.log
```

받음 → 수락 → 배정의 정확한 값은 로그에 따로 찍히지 않으므로, LiveKit Cloud 관측 화면의 트레이스(`job_entrypoint` span의 이벤트 `job_received`·`job_accepted`·`job_assigned`·`process_assigned`·`entrypoint_started`)에서 봅니다.

**3-7절 토큰과의 연결.** 3-7절에서 디코드한 웹 테스트 토큰은 `deployment: ""`였습니다. 그러면 서버는 `production` 배포의 워커에게 일 제안을 보냅니다(4-3절 위 표). `lk agent dev`의 워커가 `dev-…`로 등록되어 있다면 이 워커의 로그에는 `received job request`가 **아예 찍히지 않습니다.** 시각표의 첫 줄이 없다는 것 자체가 "배포 이름이 어긋났다"는 진단이 됩니다.

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
2. **이벤트 루프 격리.** Node.js는 기본적으로 **스레드 하나에서 이벤트 루프**를 돌립니다. (2026-11-06 갱신) 노이즈 제거처럼 메인 스레드에서 CPU를 쓰는 동기 작업이 길어지면 그 프로세스의 모든 일이 멈춥니다. 처음에는 VAD 추론도 이런 동기 작업으로 적었는데, VAD의 `predict()`는 Promise를 돌려주는 네이티브 호출이고 계산 대부분이 메인 스레드 밖에서 돕니다(아래 "깊이 보기"의 실측). 통화마다 프로세스가 다르면 한 통화의 무거운 계산이 다른 통화의 오디오를 막지 않습니다.
3. **자원 관리.** 잡이 끝나면 프로세스를 통째로 버립니다(`process.exit(0)`, 재사용 안 함). 메모리 누수가 쌓일 틈이 없습니다.

#### 깊이 보기: 이벤트 루프 격리를 숫자로 — 스레드 지도와 루프 감시 (2026-11-06 추가)

**막힘을 프레임 수로 바꾸기.** 방에서 오는 고객 소리는 10ms 프레임으로 들어온다고 봅니다(2장 프레임 지도, 10ms는 추정). 잡 프로세스의 메인 스레드가 100ms 동안 동기 코드에 붙잡히면 그동안 도착한 프레임 10개가 처리되지 못하고 쌓입니다. 소리를 바로 잃지는 않을 것으로 봅니다. 네이티브 쪽은 자기 스레드에서 프레임을 계속 받아 이벤트로 쌓고, 루프가 풀리면 JS가 한꺼번에 처리하기 때문입니다(네이티브 대기열에 한도가 있는지는 확인하지 않아 **추정**). 하지만 VAD·STT·턴 감지가 그 100ms를 늦게 보고, 말 끝 판단과 끼어들기 반응이 그만큼 밀립니다. 1장에서 본 말 끝 판단 0.38~0.54초에 비하면 100ms는 작지 않습니다.

**스레드 지도.** 잡 프로세스 하나 안에서 각 일이 어느 스레드에서 도는지 정리했습니다. 경로 약칭은 `agents/` = `node_modules/@livekit/agents/src/`, `rtc/` = `node_modules/@livekit/rtc-node/src/`입니다.

| 일 | 스레드 | 메인 루프를 막나 | 근거 (확인 수준) |
| --- | --- | --- | --- |
| 노이즈 제거 (ai-coustics `process()`) | **메인 스레드, 동기** | 막음 (프레임마다 처리 시간만큼) | `rtc/audio_stream.ts` 100~124: 네이티브 이벤트 콜백 `onEvent` 안에서 `frameProcessor.process(frame)`을 바로 부름. 플러그인 0.3.5 `dist/index.js` 1525행 `process()` → 1033행의 Rust 동기 호출(uniffi) (코드) |
| VAD (Silero) `predict()` | 계산은 메인 스레드 밖 | 거의 안 막음 | `agents/inference/vad.ts` 301 `await this._nativeVad.predict(…)`(Promise). local-inference 선언 파일은 VAD 쪽 스레드를 적지 않음. 실습에서 2,000번 부른 동안 메인 스레드 CPU 20ms, 프로세스 CPU 77ms (실측). 어느 스레드인지는 **확인 못 함** |
| 턴 감지 v1-mini `predict()` | **libuv 스레드 풀** (추론 프로세스 안) | 안 막음 | `@livekit/local-inference` 0.2.7 `index.d.ts`: "Runs on libuv's worker thread pool" (문서 주석). 실습 실측도 같음 (아래) |
| Opus 디코드, 지터 버퍼, 리샘플(방 입력) | rtc-node 네이티브(Rust·libwebrtc) 스레드 | 안 막음 | 3-3절 "JS와 Rust 사이". 결과 프레임을 JS로 복사하는 일만 메인 스레드. 네이티브 스레드가 따로 돈다는 것은 종료 코드 주석("tokio runtimes, libwebrtc … native threads are still running", `agents/ipc/job_proc_lazy_main.ts` 406~410)으로 확인 |
| 리샘플(STT로 가는 24→16kHz 등) | 메인 스레드에서 부르는 네이티브 동기 호출 | 짧게 막음 | 2장 프레임 지도. `AudioResampler.push()`는 FFI 동기 요청 (`rtc/audio_resampler.ts` 119~131, 코드) |
| JSON 파싱, protobuf, base64, 로그 | 메인 스레드 | 막음 (작음) | 4-5절 실습: 51KB 요청 하나에 0.1ms 안팎 |
| 루프 감시 watchdog | 별도 worker thread | 안 막음 | `agents/telemetry/loop_monitor.ts` 346~379 |

노이즈 제거가 동기라는 것은 설계상 자연스럽습니다. 소리 프레임을 바꿔 다음 단계로 넘기는 필터라서 결과를 기다리지 않고는 진행할 수 없습니다. 프레임 하나에 걸리는 시간이 프레임 길이(10ms)보다 충분히 짧으면 문제가 없고, 길어지면 바로 루프 막힘으로 드러납니다. 처리 시간은 재지 않았습니다(**확인 필요**). 개발 모드 통화 중 잡 프로세스의 루프 감시 로그(`event loop blocked …`)가 없으면, 적어도 100ms를 넘는 막힘은 없었다고 볼 수 있습니다.

**실습: 막힘과 비켜 가기.** [lab/04-loop-block.mjs](lab/04-loop-block.mjs)는 SDK 루프 감시와 같은 방식(20ms마다 setTimeout을 다시 걸고, 예정보다 늦은 만큼을 잼)으로 박동을 돌리면서 (2) 300ms 바쁜 루프와 (3) 턴 감지 모델 `predict()` 20번, (4) VAD `predict()` 2,000번을 넣습니다. 이 맥(Apple M1 Pro, 코어 8개, Node 24.22)에서 실제로 나온 값입니다.

```text
== 1. 평상시: 20ms 박동 23번, 최대 지각 5.1ms ==

== 2. 300ms 동기 작업: 최대 지각 295.9ms ==
   그동안 10ms 오디오 프레임 30개가 처리되지 못하고 쌓임
   SDK 기준으로는 경고(100ms 이상)

== 3. 턴 감지 v1-mini predict() 20번 (네이티브 Promise) ==
   한 번: 중앙값 33.8ms (최소 30.1, 최대 48.6)
   벽시계 680ms 동안 메인 스레드 CPU 4ms, 프로세스 CPU 1402ms
   그동안 20ms 박동의 최대 지각 2.0ms

== 4. Silero VAD predict() 2,000번 (창 512샘플 = 32ms) ==
   벽시계 79ms (한 번 40µs), 메인 스레드 CPU 20ms, 프로세스 CPU 77ms
```

- 같은 "CPU를 쓰는 일"이라도 메인 스레드에서 돌면 박동이 296ms 늦고(2), 네이티브가 다른 스레드로 넘기면 680ms 동안 계산해도 2ms밖에 늦지 않습니다(3). `process.threadCpuUsage()`(메인 스레드만)와 `process.cpuUsage()`(프로세스 전체)를 나란히 재면 어디서 돌았는지 보입니다.
- 턴 감지는 벽시계 680ms 동안 CPU를 1,402ms 썼습니다. 여러 스레드가 동시에 계산했다는 뜻입니다. 한 번에 약 34ms가 걸렸는데, 선언 파일 주석은 "~10ms inference"라고 적고 있습니다. 이 맥에서는 그보다 3배쯤 느렸습니다(실측, 다른 부하가 있었을 수 있음).
- VAD는 한 번에 40µs로 32ms 창보다 800배 짧습니다. 통화 하나에서 초당 약 31번 부르므로 1초에 약 1.2ms입니다.

**SDK의 루프 감시.** 워커 프로세스와 잡 프로세스는 각자 루프 감시를 켭니다(워커 `worker.ts` 472, 잡 `ipc/job_proc_lazy_main.ts` 336, 잡 쪽은 초기화가 끝난 뒤부터). 코드(`agents/telemetry/loop_monitor.ts`)에서 확인한 동작입니다.

| 항목 | 값 | 위치 |
| --- | --- | --- |
| 박동 간격 | 경고 기준 ÷ 5를 20~50ms로 자른 값. 기본 100ms면 **20ms** | 45~50, 684~689 |
| 경고 / 오류 기준 | **100ms / 500ms** | 45~46 |
| 바꾸는 법 | `LIVEKIT_AGENTS_LOOP_BLOCK_WARN_MS`, `LIVEKIT_AGENTS_LOOP_BLOCK_ERROR_MS`. 경고 기준을 0으로 두면 감시를 끔 | 52~53, 128~141 |
| 원인 가르기 | **code**(메인 스레드가 동기 코드를 돌림) / **host**(프로세스 전체가 CPU를 못 받음: 호스트 경쟁, 컨테이너 CPU 한도) | 62~66, 496~527 |
| 가르는 방법 | 별도 worker thread(watchdog)도 같이 늦게 깼고(지각의 절반 이상) 메인 스레드 CPU가 지각의 절반에 못 미치면 host | 508~510 |
| GC 시간 | `PerformanceObserver`의 `gc` 항목을 모아 보고에 붙임. 그래서 보고는 한 박동 늦게 나감 | 334~344, 447~470 |
| 로그 양 | 원인별로 분당 5줄. span은 분당 6개 | 54~55, 529~559 |

- 로그는 기준을 넘으면 **둘 다 warn 수준**입니다. "오류"(500ms 이상)는 트레이스 span의 상태(ERROR)와 지표의 severity에만 나타납니다(636~644, 662~680). 로그 문구는 원인에 따라 `event loop blocked …`(code) 또는 `process not scheduled …`(host)입니다.
- host로 나온 막힘은 코드가 아니라 **CPU 한도**를 보라는 신호입니다. 4-2절의 cgroup 한도를 꽉 채우면 리눅스가 컨테이너를 주기마다 멈추게 하는데(CPU 스로틀링), 이것이 host 막힘으로 보입니다(해석).
- 막힌 곳의 스택을 찍는 기능(`LIVEKIT_AGENTS_LOOP_BLOCK_STACKS`)은 기본이 꺼짐이고, 소스 주석이 "Node 22, 24, 25에서는 V8이 죽는다"고 적고 있습니다(`telemetry/loop_stack_sampler.ts` 29~33). 이 프로젝트는 Node 24라 켜지 않습니다.

**부모의 ping은 자식의 막힘을 재지 못한다.** 부모(워커)는 2.5초마다 자식에게 ping을 보내고(`ipc/supervised_proc.ts` 95~99), 60초 동안 pong이 없으면 자식을 SIGKILL합니다(101~107, 로그 `job is unresponsive`). pong이 오면 지연이 500ms를 넘는지 보고 `job executor is unresponsive`를 남깁니다(146~152). 그런데 그 지연을 `Date.now() − pong.timestamp`로 계산하고, 자식은 pong을 **보내는 순간의** 시각을 `timestamp`에 넣습니다(`ipc/job_proc_lazy_main.ts` 349~356). 그러면 재는 것은 "자식이 보낸 뒤 부모가 처리하기까지"입니다. 자식 루프가 막혀 ping을 늦게 처리해도, 처리하는 순간의 시각을 찍으므로 지연이 작게 나옵니다. [lab/04-ipc-json.mjs](lab/04-ipc-json.mjs)의 4번이 같은 계산을 해 봅니다.

```text
== 4. 자식 루프가 800ms 막힌 동안 보낸 ping ==
SDK 식 (받은 시각 − pong의 timestamp)   0ms  ← 500ms를 넘어야 경고
왕복 (받은 시각 − pong의 lastTimestamp) 800ms
```

그래서 잡 프로세스의 막힘은 이 경고가 아니라 **잡 프로세스 자신의 루프 감시 로그**로 찾아야 합니다. 이 경고는 부모 쪽이 늦게 처리했거나 IPC 통로가 밀렸을 때 뜹니다. 왕복을 재려면 `lastTimestamp`를 써야 하는데, SDK가 의도한 것인지는 **확인 필요**입니다(코드 읽기와 재현 실습 결과이며, 실제 워커에서 본 것은 아님).

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

(2026-11-06 추가) 몇 가지를 풀어 둡니다.

- **preload**(3번)는 SDK가 잡 프로세스마다 로컬 추론 네이티브 바인딩(`@livekit/local-inference`, VAD가 씀)을 미리 올리는 준비입니다(`ipc/_preload.ts` 37~44). 파이썬 SDK는 워커에서 한 번 올리고 자식이 물려받게(copy-on-write) 하지만, Node의 fork는 새 프로세스를 처음부터 띄우므로 자식마다 비용을 냅니다(같은 파일 8~11행 주석). 그래도 잡 배정 **전에** 내므로 통화 시작이 늦어지지 않습니다. rtc-node 바인딩은 `@livekit/rtc-node`를 import하는 순간 올라갑니다(같은 파일 41~43행 주석).
- **IPC 메시지 모양**은 `{ case: '…', value: … }` 객체이고, 종류는 `ipc/message.ts`의 12가지입니다(initializeRequest/Response, pingRequest/pongResponse, startJobRequest, shutdownRequest/Ack, shuttingDown, inferenceRequest/Response, exiting, done). fork할 때 직렬화 옵션을 주지 않으므로(`ipc/job_proc_executor.ts` 61~70) Node 기본값인 **JSON**으로 오갑니다. 크기와 대가는 4-5절에서 셉니다.
- **신호**: 자식은 SIGINT·SIGTERM을 받아도 로그만 남기고 무시합니다(`ipc/job_proc_lazy_main.ts` 303~313). 종료는 부모의 `shutdownRequest`로만 합니다(4-7절 drain). 부모가 강제로 끝낼 때만 SIGKILL을 씁니다.

### 함정: main.ts는 자식에서도 다시 실행된다

2번에서 자식이 `main.ts`를 import하므로, **파일 최상위 코드가 자식 프로세스에서도 실행됩니다.** `dotenv.config()`와 `cli.runApp()`이 자식에서도 돕니다. `cli.runApp`은 자식의 명령줄 인자로는 아무 하위 명령에도 걸리지 않아 조용히 끝나므로 지금은 무해합니다. 하지만 최상위에 무거운 초기화(모델 로딩, DB 연결)를 쓰면 **모든 프로세스가 그 비용을 냅니다.** 그런 일은 `prewarm` 함수에 넣어야 합니다. `prewarm`은 프로세스마다 한 번 실행되고, 결과는 `ctx.proc.userData`로 entry에 전달됩니다. (2026-11-06 갱신) 지금 [src/main.ts](../../src/main.ts) 최상위에는 `loadKnowledge()`(지식 파일 하나를 동기로 읽음)도 있습니다. 가벼운 일이라 문제는 없지만, 워커와 잡 프로세스마다 한 번씩 읽는다는 점은 같습니다. 추론 프로세스는 `main.ts`가 아니라 등록된 runner 파일만 불러오므로 해당하지 않습니다(`ipc/inference_proc_executor.ts` 71~80).

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

#### 깊이 보기: 프로세스 트리와 메모리 직접 보기 (2026-11-06 추가)

**SDK가 메모리를 재는 방법(코드).** 부모는 5초마다 `pidusage`로 자식의 **RSS**(실제로 RAM에 올라 있는 크기)를 읽습니다(`ipc/supervised_proc.ts` 12·109~142·345~360). 경고 기준(1,000MB)을 넘으면 `job process memory usage is above the warning threshold (advisory only, …)`를 남기고, 같은 경고는 2분이 지났거나 50MB 넘게 더 늘었을 때만 다시 남깁니다(13~14·369~378). 강제 종료 한도는 기본 0이라 꺼져 있습니다. 추론 프로세스는 기준이 따로입니다(`ipc/inference_proc_executor.ts` 53~69).

| 항목 | 잡 프로세스 | 추론 프로세스 |
| --- | --- | --- |
| 초기화 제한 시간 | 10초 | 5분 (처음 모델 파일을 올리는 시간) |
| 종료 단계별 제한 시간 | 60초 | 5초 |
| ping 간격 / 느린 pong 경고 / 강제 종료 | 2.5초 / 500ms / 60초 | 5초 / 2.5초 / 60초 |
| 메모리 경고 | 1,000MB | 2,000MB |

**대략의 크기(실측, 근사).** 키 없이 잴 수 있는 부분만 이 맥에서 재 봤습니다. `main.ts`는 `.env.local`을 읽으므로 불러오지 않았고, 방·세션도 없는 상태라 실제 잡 프로세스보다 작게 나옵니다. MB는 2^20바이트 기준입니다.

| 상태 | RSS |
| --- | --- |
| 빈 Node 24 프로세스 | 45MB |
| `@livekit/agents`와 이 레포의 플러그인 4개(ai-coustics, Anthropic, ElevenLabs, Soniox)를 불러온 뒤 | 약 183MB |
| 빈 프로세스에서 턴 감지 모델만 올린 뒤(`initEot()`) | 약 290MB |

이 숫자로 8코어 맥의 `start`를 어림하면, 통화가 하나도 없을 때 워커(약 180) + 추론 프로세스(약 290) + 유휴 프로세스 4개(4 × 약 180) ≈ **1.2GB**입니다(**추정**). 통화마다 세션·버퍼·네이티브 WebRTC가 더해지는 몫은 재지 않았습니다. 2 vCPU 컨테이너라면 유휴 프로세스는 `min(2, 4)` = 2개라 그만큼 줄어듭니다((2026-11-06 갱신) `availableParallelism()`은 컨테이너 CPU 한도(cgroup `cpu.max`)를 **내림**으로 반영합니다. 1.5 CPU면 1입니다. libuv 1.52.1 코드로 확인, 15-5절 깊이 보기).

**직접 보기(사용자가 돌릴 것).** `start`는 LiveKit에 진짜로 등록하므로 `.env.local`의 키가 필요하고, 배포 이름 없이 `production`으로 등록된다는 점에 주의합니다(4-3절). 그동안 배포 이름 없는 웹 테스트 토큰이 이 워커로 올 수 있습니다.

```bash
# 터미널 1 (레포 루트)
node src/main.ts start

# 터미널 2: 워커와 자식들의 PID, 부모 PID, RSS(KB), CPU, 명령
ps -o pid,ppid,rss,%cpu,command -p "$(pgrep -d, -f 'main.ts start|job_proc_lazy_main|inference_proc_lazy_main')"
```

예상되는 모양입니다(숫자는 넣지 않았습니다).

```text
  PID  PPID     RSS %CPU COMMAND
  W    셸         …       node src/main.ts start                                   ← 워커
  I    W          …       node …/ipc/inference_proc_lazy_main.js {"lk_eot_audio":…}  ← 추론 프로세스 1개
  J1   W          …       node …/ipc/job_proc_lazy_main.js /…/src/main.ts           ← 유휴 프로세스
  …    W                  (min(CPU 수, 4)개)
```

- 모든 자식의 PPID가 워커 PID인지, 추론 프로세스가 하나뿐인지, 유휴 프로세스 수가 맞는지 봅니다.
- Agent Console로 통화를 하나 걸면 유휴 프로세스 하나의 RSS와 CPU가 늘고, 곧 새 유휴 프로세스가 하나 더 뜹니다(빈자리 채우기).
- 통화를 끝내면 그 프로세스가 사라집니다(재사용 안 함).
- 워커에 `kill -TERM <워커 PID>`를 보내면 drain이 시작되어 유휴 프로세스부터 닫히고, 통화가 없으면 워커가 종료 코드 143으로 끝납니다(`cli.ts` 87~106). 터미널의 Ctrl+C(SIGINT)도 `start`에서는 drain하고, 두 번 누르면 바로 끝납니다(61~85).

---

## 4-5. 추론 프로세스와 턴 감지 모델의 위치

턴 감지 모델(7장)은 두 가지 버전이 있습니다.

| 버전 | 어디서 도나 | 크기 |
| --- | --- | --- |
| `v1` (전체 모델) | LiveKit Inference (클라우드) | — |
| `v1-mini` | **워커의 추론 프로세스 (로컬 CPU)** | 약 138MB |

로컬 모델은 통화마다 올리면 메모리가 낭비되므로, **호스트당 하나의 공유 추론 프로세스**에서 돌립니다. 잡 프로세스가 추론을 요청하면 `잡 프로세스 → 부모 워커 → 추론 프로세스`로 IPC를 두 번 건너갑니다. 입력은 16kHz 오디오 최대 1.2초 분량입니다. Silero VAD(약 2MB)는 가벼워서 각 잡 프로세스 안에서 돕니다.

#### 깊이 보기: 추론 요청 하나의 크기와 길 (2026-11-06 추가)

1장 1-5절 표의 ③(워커 ↔ 잡 ↔ 추론, Node IPC, JSON)을 요청 하나로 따라갑니다. 코드로 확인한 경로입니다(경로는 `node_modules/@livekit/agents/src/` 기준).

```text
잡 프로세스   LocalTransport._predict (inference/eot/transports.ts 177~219)
              최근 1.2초 고리 버퍼 → Int16Array 19,200샘플 = 38,400B → base64 51,200자
              process.send({ case: 'inferenceRequest',
                             value: { requestId, method: 'lk_eot_audio', data: { pcm } } })
                                                          (ipc/job_proc_lazy_main.ts 103~119)
   │ ① IPC 한 구간: JSON 한 줄 약 51,321B
   ▼
워커          JobProcExecutor.#doInferenceTask (ipc/job_proc_executor.ts 72~100)
              → InferenceProcExecutor.doInference: 받은 data를 그대로, requestId만 새로 붙여 다시 보냄
                                                          (ipc/inference_proc_executor.ts 101~112)
   │ ② IPC 한 구간: 다시 JSON 한 줄 약 51KB
   ▼
추론 프로세스 EotRunner.run (inference/eot/runner.ts 55~71)
              base64 → Buffer → Int16Array 뷰 → mod.predict(pcm)   ← libuv 스레드 풀
              응답 { probability, inferenceDurationMs } (수십 바이트) → 워커 → 잡 (같은 두 구간)
```

**왜 base64인가.** fork에 직렬화 옵션을 주지 않으므로 IPC는 Node 기본값인 JSON으로 갑니다(4-4절). SDK 주석도 "기본 JSON IPC 직렬화를 작게 통과하도록 base64로 바꾼다, `Int16Array`를 그대로 보내면 숫자 배열로 부풀어 오른다"고 적고 있습니다(`inference/eot/transports.ts` 193~195). [lab/04-ipc-json.mjs](lab/04-ipc-json.mjs)로 이 말을 확인했습니다(실측).

```text
== 1. 크기 ==
PCM 38,400B → base64 51,200자
IPC 한 줄(JSON + 줄바꿈) 51,321B
(비교) Int16Array를 그대로 JSON에 넣으면 243,482B: {"pcm":{"0":0,"1":300,"2":596,"3":887,"4":1168,"5":1438,"6":…
기본 직렬화로 Int16Array [1,2,3]을 보내면 자식이 받는 것: {"pcm":{"0":1,"1":2,"2":3}}

== 2. 한 구간 왕복 50번 (요청 51KB → 응답 수십 B) ==
중앙값 0.17ms, 최소 0.11ms, 최대 1.21ms

== 3. 한 번에 드는 CPU (메인 스레드) ==
JSON 직렬화 + 파싱 0.094ms, base64 인코딩 + 디코딩 0.015ms
```

- 기본 직렬화가 JSON이라는 것은 자식이 받은 모양으로 확인됩니다. `Int16Array`가 배열이 아니라 `{"0":1,"1":2,…}` 객체로 도착합니다. 타입 정보가 사라지고, 샘플 하나가 `"1234":5678,`처럼 10글자 안팎이 되어 2바이트짜리 데이터가 6배 넘게 커집니다.
- base64의 대가는 4/3배(38,400 → 51,200)와 양쪽의 인코딩·디코딩입니다. JSON 직렬화와 파싱도 51KB 문자열을 한 번 더 훑습니다. 둘 다 0.1ms 안팎이라, 한 구간 왕복(0.17ms)과 합쳐도 모델 계산(이 맥에서 약 34ms, 4-4절 실습)에 비하면 작습니다. 다만 이 일은 잡·워커·추론 프로세스 모두 **메인 스레드**에서 합니다. 워커 메인 스레드는 동시 통화 수만큼 요청을 중계합니다.
- 다른 선택지: `fork(…, { serialization: 'advanced' })`는 구조화 복제(structured clone)라 `Int16Array`를 그대로 보낼 수 있습니다. SDK는 이 옵션을 쓰지 않습니다(코드). 바꾸면 어떻게 되는지는 재지 않았습니다.
- 덤으로 생기는 일: `Error` 객체를 JSON으로 바꾸면 `{}`가 됩니다(메시지·스택이 열거되지 않는 속성이라서). 추론 프로세스가 실패를 `error` 칸에 실어 보내면(`ipc/inference_proc_lazy_main.ts` 86~88) 받는 쪽에서는 내용이 비어 있을 수 있습니다(JS 동작으로 본 **추정**, 실제 실패 로그는 보지 않음).

**시간 예산.** 예측 하나는 1초 안에 끝나야 합니다(`DEFAULT_PREDICTION_TIMEOUT_MS = 1000`, `inference/eot/base.ts` 24). IPC 네 번(요청 두 구간, 응답 두 구간)이 1ms 안쪽이고 계산이 수십 ms이므로 여유가 큽니다. 여유가 줄어드는 경우는 추론 프로세스 하나에 여러 통화의 요청이 몰려 libuv 스레드 풀(기본 4개)이 차거나, 컨테이너 CPU 한도에 걸릴 때입니다(**추정**).

**모델 크기 표기.** 이 절의 표와 SDK 주석은 "약 138MB"(`inference/eot/runner.ts` 7·48)인데, `@livekit/local-inference`의 선언 파일은 `initEot()`에 "~108 MB"라고 적습니다. 4-4절에서 잰 RSS 약 290MB는 네이티브 라이브러리와 런타임까지 포함한 값입니다. 어느 주석이 최신인지는 **확인 필요**입니다. (2026-11-06 추가) 7장 실습에서는 `initEot()` 전후 RSS가 233~243MB 늘었고, 디스크의 `.node` 파일은 35MB였습니다. 실제 녹음 창 하나의 추론은 중앙값 27.3~27.7ms였습니다(4-4절의 사인파 입력은 약 34ms).

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
| 방이 아직 연결 안 됐으면 | 세션이 잡 문맥으로 직접 `ctx.connect()`를 부름 (`voice/agent_session.ts`, 로그 "Auto-connecting to room via job context") |

마지막 줄 때문에, 그 뒤의 이 코드는 사실상 아무 일도 하지 않습니다(이미 연결돼 있으면 바로 반환).

```ts
  await ctx.connect();
```

스타터 템플릿에서 내려온 줄로 보이며, 지워도 동작은 같습니다. 순서를 `ctx.connect()` → `session.start()`로 바꾸는 것도 흔한 패턴입니다.

(2026-11-04 고침) 이 줄을 지우고, 그 자리에 "방 연결은 `session.start()`가 한다"는 주석을 남겼습니다(17-2 #11). 스타터 코드에는 이 줄이 있어서, 주석이 없으면 나중에 읽는 사람이 "연결을 빠뜨렸다"고 다시 넣을 수 있기 때문입니다. 지운 뒤 디버거 로그에서 세션이 스스로 연결하는 줄을 확인했습니다.

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
 → room.disconnect()
 → 종료 콜백들 (서로는 병렬, Promise.allSettled: 하나가 실패해도 나머지는 돎)
 → 로그·트레이스 플러시
 → 부모에게 done → 네이티브 자원 정리 → exit(0)
```

(2026-11-04 추가) 이 순서에서 이 프로젝트가 기대는 성질이 두 가지 있습니다.

- **종료 콜백은 세션이 닫힌 뒤에 돕니다.** 그래서 결과 전송 콜백이 읽는 `session.history`는 완성된 대화 기록입니다(15-6절).
- **종료 콜백끼리는 기다리지 않습니다.** 하나가 느리거나 실패해도 나머지 콜백을 붙잡지 않습니다. 처음에는 `endCall`이 방 삭제를 종료 콜백으로 등록해 결과 전송(최대 10초)과 함께 돌렸습니다. (2026-11-04 갱신) 지금은 방 삭제가 그보다 앞선 `session.close()` 단계에서 일어나므로, 전화는 결과 전송이 시작되기 전에 끊깁니다(아래 "방 삭제를 한곳으로 모으기").

부모 워커가 잡 프로세스를 닫을 때는 단계마다 `shutdownProcessTimeout`만큼 기다리고, 넘으면 강제로 끝냅니다(SIGKILL, `ipc/supervised_proc.ts`). **Node SDK의 기본값은 60초**입니다(`worker.ts`). LiveKit 문서의 "기본 10초"는 Python의 `shutdown_process_timeout` 이야기라, Node에서는 결과 전송의 10초 제한이 충분히 안에 들어갑니다.

### 고객이 전화를 끊으면

RoomIO는 고객의 연결이 끊긴 사유가 "클라이언트가 끊음", "방 삭제", "사용자 거절"일 때 **세션을 닫습니다.** 그런데 세션이 닫힌다고 잡이 자동으로 끝나는 것은 아닙니다. SDK 안에서 세션 종료를 `ctx.shutdown()`으로 잇는 코드는 베타 통화 종료 도구에만 있습니다. 그 외에는 서버가 빈 방을 정리할 때까지 잡 프로세스가 남을 수 있습니다.

통화 종료 도구를 붙일 때(9장) 함께 정리할 부분입니다. 선택지는 세션의 `Close` 이벤트에서 `ctx.shutdown()`을 부르거나, RoomIO의 `deleteRoomOnClose: true`를 쓰는 것입니다. 또 SIP 쪽에서 끊긴 사유가 위 세 가지가 아니면 세션이 닫히지 않을 수 있어, 전화 연결 단계에서 실제 사유 값을 확인해야 합니다.

(2026-11-04 확인) "서버가 빈 방을 정리할 때"가 언제인지 LiveKit 문서로 확인했습니다.

- 방은 **에이전트가 아닌 마지막 참가자**가 나가면 닫힙니다. 에이전트만 남은 방은 빈 방으로 칩니다.
- 다만 바로 닫지 않고 방 설정의 유예 시간(`departure_timeout`)을 기다립니다. 방이 닫히면 에이전트도 연결이 끊기고, 그때 잡이 끝납니다.
- `deleteRoomOnClose: true`는 이 유예 시간을 건너뛰게 합니다. 문서는 Python 전용으로 표시하지만 Node SDK 1.9.5에도 공개 옵션으로 있습니다(17-2 #23).

통화 결과 전송이 이 시점에 묶여 있어 실제 영향이 생겼습니다(15-6절 "끝나는 경로별 시간표", 17-2 #21).

(2026-11-04 고침) 지금은 [src/main.ts](../../src/main.ts)의 `inputOptions`에 `deleteRoomOnClose: true`가 들어가 있습니다. 고객이 나가면 다음 순서로 바로 끝납니다.

```text
고객 나감 (CLIENT_INITIATED)
 → RoomIO가 세션을 닫음 → Close 이벤트
 → RoomIO가 방 삭제를 시작하고, 자기를 닫을 때 그 삭제를 최대 10초 기다림
 → 방이 지워져 에이전트 연결도 끊김 → 잡 종료 (위 네 가지 중 1번)
 → room.disconnect() → 종료 콜백 (결과 전송)
```

유예 시간을 기다리던 단계가 사라져, 고객이 먼저 끊어도 잡과 결과 전송이 곧바로 이어집니다.

SIP 참가자의 끊김 사유도 문서에 표로 정리돼 있습니다. 발신 통화를 하는 이 프로젝트에 중요한 부분입니다.

| 사유 | 언제 | 세션 자동 닫힘 |
| --- | --- | --- |
| `CLIENT_INITIATED` | 연결된 뒤 어느 쪽이든 정상적으로 끊음 (상대의 BYE) | 예 |
| `ROOM_DELETED` | 방 삭제 (이 프로젝트에서는 세션이 닫힐 때 `deleteRoomOnClose`) | 예 |
| `USER_REJECTED` | 받기 전에 받는 사람이 거절 (SIP 486 통화 중, 603 거부. 발신만) | 예 |
| `USER_UNAVAILABLE` | 받지 않음, 연결 불가 (발신만) | **아니요**: 코드가 `ctx.shutdown()`을 직접 불러야 함 |
| `SIP_TRUNK_FAILURE` | 회선·프로토콜 오류 (발신만) | **아니요**: 위와 같음 |

고객이 전화를 받지 않으면(`USER_UNAVAILABLE`) 세션이 저절로 닫히지 않습니다. 발신을 붙일 때 이 경우의 종료와 "부재" 결과 기록을 따로 처리해야 합니다.

#### 깊이 보기: 아무도 끊지 않았는데 연결이 사라지면 — 동의 갱신 30초와 방 정리 (2026-11-06 추가)

위 표의 사유는 누군가 "끊는다"고 알린 경우입니다. 브라우저 탭이 죽거나 와이파이가 끊기면 아무 메시지도 오지 않습니다. 이때 쓰이는 시계는 3장에 있습니다.

| 시계 | 값 | 출처 |
| --- | --- | --- |
| WebRTC 동의 갱신 | 4~6초마다 STUN 확인, **30초** 응답이 없으면 그 경로로 보내기 중단 | RFC 7675, 3-2절 깊이 보기 |
| LiveKit의 참가자 정리 | `disconnect()` 없이 앱이 끝나면 **15초** 뒤 참가자가 사라짐 | LiveKit 문서, 3-2절 |
| 방 유예 시간 | 에이전트가 아닌 마지막 참가자가 나간 뒤 `departure_timeout` | 위 "서버가 빈 방을 정리할 때" |

**고객 쪽이 사라질 때(추정).** SFU가 약 15초 뒤 고객 참가자를 내보냅니다. 그때 RoomIO가 받는 끊김 사유가 위 세 가지(세션을 닫는 사유) 중 하나인지는 **확인 필요**입니다. 세션이 닫히면 `deleteRoomOnClose`로 곧바로 끝나고, 닫히지 않더라도 "에이전트가 아닌 마지막 참가자가 나감" → 유예 시간 → 방 닫힘 → 잡 종료(위 네 가지 중 1번)로 결국 끝납니다. 어느 쪽이든 통화 결과 전송은 이 시각에 묶입니다(15-6절).

**에이전트 쪽이 끊길 때(추정).** 워커 호스트의 네트워크가 끊기면 연결 두 개가 **따로** 영향을 받습니다(4-2절, 3-3절).

- 방 연결(잡 프로세스 안의 네이티브 rtc-node): 미디어는 동의 갱신이 30초 안에 실패하고, 시그널링 WebSocket도 끊깁니다. rtc-node가 다시 붙지 못하면 `RoomEvent.Disconnected`가 오고, 잡 프로세스는 이를 "room disconnected" 종료로 처리합니다(`ipc/job_proc_lazy_main.ts` 139~144, 코드). rtc-node 안의 재연결 시도와 그 시간은 네이티브 코드라 확인하지 않았습니다.
- 워커 연결(JS `ws`): 끊기면 재접속 고리(2, 4, 6…초)가 돌고, 다시 등록되면 아직 돌고 있는 잡을 `migrateJob`으로 다시 알립니다(`worker.ts` 551~571, 코드). 즉 워커 연결이 잠깐 끊겨도 **진행 중인 통화의 소리는 계속 흐를 수 있습니다.** 반대로 워커 연결은 멀쩡한데 방 연결만 끊길 수도 있습니다.

### 에이전트가 먼저 끊을 때 (2026-11-03 추가)

처음에는 커밋 전 작업 트리를 보고 썼고, 이 코드는 커밋 `5585080`으로 들어갔습니다. 끊는 경로가 두 개 생겼습니다.

| 경로 | 언제 | 하는 일 |
| --- | --- | --- |
| **`end_call` 도구** ([src/agent.ts](../../src/agent.ts)) | LLM이 "통화를 마칠 때"라고 판단 (마무리 인사, 수신 거부 등, 9-6절) | 도구를 부른 답(작별 인사)이 **끝까지 재생된 뒤** 세션 종료 → `Close` 이벤트 → `ctx.shutdown()` |
| **`endCall` 함수** ([src/main.ts](../../src/main.ts)) | 코드가 정한 조건 (무응답, 최대 통화 길이, 5-5절의 `call-guard.ts`) | 정해진 작별 인사를 끼어들기 막고 끝까지 재생 → `ctx.shutdown(사유)` |

두 경로 모두 세션이 닫히는 순간 RoomIO가 방을 지웁니다(`deleteRoomOnClose`, 2026-11-04 갱신).

```ts
// src/main.ts
let ending = false;
const endCall = async (goodbye: string, reason: string) => {
  if (ending) return;                     // 두 번 끊지 않기 (무응답과 최대 길이가 겹쳐도 한 번만)
  ending = true;
  endReason = reason;
  log().info({ callId: call.callId, reason }, '통화 종료');
  await session.say(goodbye, { allowInterruptions: false }).waitForPlayout();   // 인사가 다 들린 뒤
  ctx.shutdown(reason);                   // 세션이 닫히며 방도 지워짐
};
```

두 경로 모두 **"작별 인사가 끝까지 들린 뒤에 끊는다"**는 순서를 지킵니다. 인사 도중에 방을 지우면 고객은 말이 뚝 끊긴 전화를 받게 됩니다. 그리고 **방을 지우는 것**이 핵심입니다. 방이 지워지면 SIP 참가자는 전화가 끊기고, 잡도 `ctx.shutdown()`으로 확실히 끝나므로 앞에서 걱정한 "잡 프로세스가 남는" 문제(17-2절 #12)가 해결됩니다.

방 삭제가 실패해도 종료는 계속됩니다. 이것도 실패해도 안전한 쪽으로 가는 설계입니다(1장 원칙 5).

- `JobContext.deleteRoom()`은 오류를 안에서 받아 경고 로그("error while deleting room")만 남깁니다.
- RoomIO는 삭제를 최대 10초만 기다리고, 넘으면 "automatic room deletion timed out" 경고를 남깁니다.

### 방 삭제를 한곳으로 모으기 (2026-11-04 추가)

처음 코드에는 방을 지우는 곳이 두 군데였습니다. `endCall`은 종료 콜백에 `ctx.deleteRoom()`을 등록했고, `end_call` 도구도 기본값(`deleteRoom: true`)으로 같은 일을 했습니다. 고객이 먼저 끊는 경로에는 지우는 곳이 없었습니다(#21). 그래서 `deleteRoomOnClose: true`를 켜면서 나머지 둘을 걷어 냈습니다.

- `endCall`에서 종료 콜백 등록을 지웠습니다.
- `end_call` 도구에 `deleteRoom: false`를 넘겼습니다.

남겨 두면 한 통화에 방을 두 번 지우게 됩니다. 두 번째 호출은 이미 없는 방이라 실패하고, 통화마다 경고 로그가 한 줄씩 쌓입니다. 동작은 맞지만 이런 "늘 나는 경고"가 쌓이면 진짜 경고가 묻힙니다.

여기서 일반 원칙 하나를 끌어낼 수 있습니다. **부수 효과(외부 상태를 바꾸는 일)는 주인을 하나로 둡니다.** 방 삭제는 같은 요청을 두 번 보내면 결과가 달라지는 연산입니다. 첫 번째는 성공하고 두 번째는 "없음" 오류가 납니다. 이런 연산을 여러 곳에서 부르려면 15-6절의 결과 저장처럼 중복을 견디게(멱등하게) 만들어야 합니다. 그보다 간단한 길은 부르는 곳을 하나로 모으는 것입니다. 이번에 고른 주인은 "세션이 닫히는 순간"입니다. 끊는 경로가 셋(AI가 끊음, 코드 안전장치가 끊음, 고객이 끊음)이어도 모두 이 한 지점을 지나므로, 경로를 새로 더해도 방 삭제를 잊을 수 없습니다.

### 배포할 때: drain

새 버전을 배포하면 쿠버네티스가 기존 워커에 SIGTERM을 보냅니다. production 워커는

1. 서버에 "가득 참"을 알려 **새 잡을 받지 않고**,
2. 유휴 프로세스는 닫고,
3. **진행 중인 통화가 자연스럽게 끝날 때까지** 기다립니다(drain, 기본 최대 60분).
4. 그 뒤 남은 프로세스를 정리하고 종료합니다.

그런데 쿠버네티스는 기본적으로 SIGTERM 후 **30초**가 지나면 SIGKILL로 강제 종료합니다. 그러면 통화가 뚝 끊깁니다. `terminationGracePeriodSeconds`를 "최장 통화 길이 + 여유"로 늘려야 합니다(15장). 이것이 [2-tech-stack.md 6장](../2-tech-stack.md#6-전체-아키텍처)이 말한 "배포할 때 진행 중인 통화가 끝날 때까지 기다리는 설정"입니다.

자식 프로세스는 SIGTERM을 무시하고 부모의 지시로만 종료합니다. 그래서 Dockerfile이 `CMD ["node", "src/main.ts", "start"]`처럼 **node를 PID 1로 직접** 실행하는 것이 중요합니다. `sh -c`로 감싸면 셸이 신호를 node에 전달하지 않아 drain이 일어나지 않을 수 있습니다. (2026-11-06 갱신) 정확히는 명령이 하나면 셸이 node로 exec되어 문제가 없을 수 있고(맥의 sh·dash 실측), 명령이 둘 이상이면 셸이 남아 셸만 죽고 node는 고아가 됩니다(15-4절 깊이 보기 "PID 1, 신호, 종료 순서", `lab/15-signals.mjs`).

#### 깊이 보기: drain을 코드와 바이트로 따라가기 (2026-11-06 추가)

**신호부터.** SIGTERM은 "정리하고 끝내라"는 요청이라 프로그램이 받아서 처리할 수 있고, SIGKILL은 운영체제가 즉시 죽이는 것이라 받을 수 없습니다. 컨테이너 안에서 처음 실행된 프로세스(PID 1)는 리눅스가 특별히 다룹니다. 처리기를 걸지 않은 신호의 기본 동작(종료)이 적용되지 않습니다. node는 SIGTERM 처리기를 직접 걸므로(`cli.ts` 101~106) PID 1이어도 받고, 셸이 PID 1이면 셸이 받고 node에 넘기지 않는 것이 문제입니다(일반론). 쿠버네티스는 유예 시간이 끝나면 컨테이너에 SIGKILL을 보내고, 그때 자식 프로세스까지 모두 끝납니다.

**`start` 워커가 SIGTERM을 받은 뒤(코드).**

```text
cli.ts 87~99    onSigterm: production이면 server.drain()
worker.ts 574~616  drain()
   ├ WorkerMessage.updateWorker { status: WS_FULL }  → 선 위로 4바이트: 1a 02 08 01
   │   (load 칸이 없어 짧음. 이어서 2.5초 고리도 { load: 1, status: WS_FULL }을 한 번 보냄, 816~830)
   ├ 프로세스마다: 잡이 없으면 close() (유휴 프로세스 정리), 모두 join() 기다림
   └ DRAIN_TIMEOUT 60분(worker.ts 46)과 경주. 넘으면 "timed out draining" 오류 로그
 → server.close(): 추론 프로세스·풀·HTTP 서버 닫기, WebSocket 닫기 (1014~1033)
 → process.exit(143)   ← 128 + 15(SIGTERM 번호)
```

- drain 중에 서버가 일을 제안하더라도 `#availability`가 바로 거절합니다(`worker.ts` 963~974).
- 통화 중인 잡 프로세스는 drain이 닫지 않고 끝나기만 기다립니다. 통화가 끝나 잡 프로세스가 스스로 나가면 `join()`이 풀립니다.
- 종료 코드 143(SIGTERM), 130(SIGINT)은 "128 + 신호 번호"라는 셸 관례입니다. 쿠버네티스 이벤트에서 이 숫자를 보면 정상적인 drain 종료인지 구분할 수 있습니다. SIGKILL로 끝났다면 137(128 + 9)이 보입니다.

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
8. (2026-11-06 추가, 손 계산) 워커가 보낸 WebSocket 메시지가 `1a 07 08 01 1d 33 33 33 3f`입니다. 태그 식으로 한 칸씩 풀어 무슨 메시지인지, 상태와 부하 값이 무엇인지 쓰세요. 부하가 0일 때는 왜 메시지가 더 짧아집니까?
9. (2026-11-06 추가, 손 계산) CPU 한도 2개(cgroup v2 `cpu.max` = "200000 100000")인 컨테이너에서 2.5초 사이 `cpu.stat`의 `usage_usec`이 12,000,000에서 14,900,000으로 늘었습니다. (가) 워커가 보고하는 `load`는 얼마이고, 새 잡을 받습니까? (나) 통화가 없을 때 0.12 CPU, 통화 하나가 평균 0.3 CPU를 쓴다면 "가득 참"이 되지 않는 동시 통화는 몇 개입니까?
10. (2026-11-06 추가) 잡 프로세스에서 (가) 노이즈 제거가 10ms 프레임마다 12ms씩 걸리게 되면, (나) 턴 감지 `v1-mini`의 예측 한 번이 40ms 걸리면 각각 잡 프로세스의 이벤트 루프에 무슨 일이 생깁니까? (다) 잡 프로세스의 루프가 800ms 막혔을 때 워커 로그에 `job executor is unresponsive`가 뜹니까? 이 막힘은 무엇으로 찾습니까?
11. (2026-11-06 추가, 손 계산) 로컬 턴 감지 요청 하나에 실리는 1.2초 분량 16kHz int16 PCM은 몇 바이트이고, base64로 몇 글자입니까? base64로 바꾸지 않고 `Int16Array`를 그대로 `process.send()`하면 어떻게 됩니까? 이 요청은 IPC를 몇 구간 건너갑니까?

<details>
<summary>답 보기</summary>

1. 통화가 수 분씩 이어지고, 방·STT·TTS와 연결을 계속 유지하며 상태를 들고 있어야 하기 때문입니다.
2. 명시 디스패치로 자기 이름이 지정된 방에만 들어갑니다. 브라우저 테스트 때는 에이전트 이름 `xtool-sales-agent`를 지정해 연결해야 합니다.
3. metadata가 있었다면 실제 통화일 가능성이 높아, 가상 이름을 부르면 실제 고객에게 남의 이름을 부르게 되기 때문입니다.
4. Node는 프로세스당 이벤트 루프 하나에서 돌기 때문에, 노이즈 제거처럼 메인 스레드에서 도는 동기 CPU 작업이 길어지면 그 프로세스의 모든 일이 멈춥니다. 통화마다 프로세스를 나누면 서로 막지 않고, 장애와 메모리도 격리됩니다. (2026-11-06 갱신) VAD와 턴 감지의 `predict()`는 Promise를 돌려주는 네이티브 호출이라 계산이 메인 스레드 밖에서 돕니다(4-4절 스레드 지도).
5. 잡 프로세스마다 main.ts를 다시 import하므로 모든 프로세스가 그 비용을 냅니다. `prewarm` 함수에 넣고 `ctx.proc.userData`로 넘깁니다.
6. 버전을 지정하지 않으면 개발 모드는 클라우드 `v1`, 직접 운영의 `start`는 로컬 `v1-mini`를 기본으로 고르기 때문입니다.
7. SIGTERM 후 30초가 지나면 SIGKILL되어 drain 중인 통화가 끊깁니다. `terminationGracePeriodSeconds`를 최장 통화 길이 이상으로 늘립니다.
8. `1a` = (3 << 3) | 2 → `WorkerMessage`의 3번 칸 `updateWorker`, 길이 접두이고 `07`은 길이 7입니다. 안쪽 `08 01`은 (1 << 3) | 0 → 1번 칸 `status` = 1(`WS_FULL`, 가득 참), `1d`는 (3 << 3) | 5 → 3번 칸 `load`, float32입니다. 뒤 4바이트를 리틀 엔디언으로 읽으면 0x3F333333 = 0.699999988…(약 0.7)입니다. 임계값 0.7을 넘어 가득 참을 알리는 부하 보고입니다. 부하가 0이면 proto3는 기본값인 칸을 보내지 않으므로 `load` 칸(5바이트)이 빠져 `1a 02 08 00`이 됩니다. `status`는 `optional`이라 0이어도 실립니다.
9. (가) Δ = 2,900,000µs, load = 2,900,000 ÷ (2,500,000 × 2) = **0.58**. 0.7 미만이라 가용(`WS_AVAILABLE`)으로 보고하고 새 잡을 받습니다. (나) N < (0.7 × 2 − 0.12) ÷ 0.3 = 1.28 ÷ 0.3 ≈ 4.27이므로 **4통화**입니다. 다섯 번째 통화가 들어오면 0.12 + 1.5 = 1.62 CPU, load 0.81이 되어 가득 참으로 바뀝니다. 다만 부하는 지난 2.5초의 평균이라, 그 창 안에 몰려 온 통화는 더 들어올 수 있습니다.
10. (가) 노이즈 제거는 메인 스레드에서 동기로 돌므로, 10ms마다 오는 프레임을 12ms씩 붙잡으면 처리가 도착보다 느려 일이 계속 밀립니다. 루프가 쉬지 못하고 VAD·STT·턴 감지 입력이 점점 늦어지며, 루프 감시가 막힘 경고를 남깁니다. (나) 턴 감지 `v1-mini`는 추론 프로세스에서 libuv 스레드 풀로 돌고, 잡 프로세스는 IPC로 결과를 기다리기만 하므로 잡의 이벤트 루프는 막히지 않습니다. 결과만 40ms 늦게 옵니다(1초 제한 안). (다) 뜨지 않습니다. SDK는 "자식이 pong을 보낸 시각"부터 잰 지연을 보므로, 자식이 늦게 처리해도 지연이 작게 나옵니다. 잡 프로세스 자신의 루프 감시 로그(`event loop blocked`, cause `code`)로 찾고, 60초 동안 pong이 아예 없으면 부모가 SIGKILL합니다.
11. 16,000 × 1.2 × 2 = **38,400바이트**, base64는 ⌈38,400 ÷ 3⌉ × 4 = **51,200글자**입니다. fork의 기본 직렬화가 JSON이라 `Int16Array`는 `{"0":…, "1":…}` 객체로 바뀌어 약 243KB(6배 넘게)가 되고, 받는 쪽에서는 타입 배열도 아닙니다. 요청은 잡 → 워커 → 추론 프로세스로 **두 구간**을 건너고, 응답도 같은 두 구간으로 돌아옵니다.

</details>
