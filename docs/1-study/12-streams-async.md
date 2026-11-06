# 12장. 스트림과 비동기 — 흘러오는 데이터를 다루는 기술

음성 에이전트의 데이터는 한꺼번에 오지 않습니다. 오디오는 10ms 조각으로, STT 글은 단어 조각으로, LLM 답은 토큰 조각으로, TTS 소리는 다시 프레임 조각으로 **흘러옵니다.** 이 프로젝트의 직접 작성 코드 중 가장 까다로운 부분인 `withoutLeadingAck`([src/ack.ts](../../src/ack.ts))와 `pronunciationTransform`([src/pronunciation.ts](../../src/pronunciation.ts))은 모두 "흘러오는 조각을 고치는" 코드입니다. 이 장은 JavaScript의 비동기·스트림 도구와, 조각 경계 문제를 푸는 일반적인 기법을 다룹니다.

> (2026-11-06 추가) 이 장의 SDK 경로는 `agents/` = `node_modules/@livekit/agents/src/`(1.9.5), `plugin/` = `node_modules/@livekit/agents-plugin-anthropic/src/`(1.9.5), `sdk/` = 플러그인이 쓰는 `@anthropic-ai/sdk` 0.33.1의 `src/`(`node_modules/.pnpm/@anthropic-ai+sdk@0.33.1/node_modules/@anthropic-ai/sdk/src/`)입니다. 8장과 같은 약칭입니다.

(2026-11-06 추가) 이번 판에서는 "한 줄 아래에서 실제로 무슨 일이 일어나는가"를 더했습니다. 이벤트 루프의 단계와 두 개의 작은 큐가 도는 순서(12-2절), 역압이 LiveKit의 텍스트 경로 어디서 끊기는지(12-3·12-4절), UTF-8 바이트가 청크 사이에서 갈릴 때(12-5절), 끼어들었을 때 스트림 사슬이 **어떤 순서로, 언제** 멈추는지(12-8절, 새 절), 조각 나누기를 전부 넣어 보는 검사(12-7절)입니다. 그 과정에서 두 군데를 바로잡았습니다. 12-3절의 "게으름 덕분에 생산 속도가 소비 속도에 맞춰진다"는 LiveKit의 운영 경로에서는 성립하지 않고, 12-6절의 "가장 긴 맞장구 조합은 10자 안팎"은 정규식이 실제로 떼는 조합(14자)보다 짧았습니다. 1장·4장처럼 코드로 확인한 것, 잰 것(실측), 추정을 구분해 적었습니다. 실습 스크립트 다섯 개는 키 없이 돕니다([lab/12-event-loop-order.mjs](lab/12-event-loop-order.mjs), [lab/12-backpressure.mjs](lab/12-backpressure.mjs), [lab/12-utf8-boundary.mjs](lab/12-utf8-boundary.mjs), [lab/12-split-property.mjs](lab/12-split-property.mjs), [lab/12-cancel.mjs](lab/12-cancel.mjs)). 이 장의 실측은 모두 Apple M1 Pro, Node 24.22, libuv 1.52.1에서 낸 값입니다. 깊은 내용은 "깊이 보기"에 두었으니 처음에는 건너뛰어도 됩니다.

---

## 이 장에서 쓰는 말 (2026-11-06 추가)

처음 보면 막히는 말만 모았습니다. 전체 용어집은 [17장](17-glossary-and-next.md)이고, 이미 거기 있는 말(역압, 보류 버퍼, 둘러보기, libuv 스레드 풀)은 [17-1절](17-glossary-and-next.md#17-1-용어집)을 봅니다.

| 말 | 뜻 |
| --- | --- |
| 이벤트 루프 단계 (phase) | libuv가 루프 한 바퀴를 도는 차례입니다. timers(만료된 `setTimeout`) → pending(미뤄 둔 일부 I/O 콜백) → idle·prepare(내부용) → poll(소켓·파일 I/O 완료를 기다리고 처리) → check(`setImmediate`) → close(닫힌 핸들의 `close` 콜백)입니다(12-2절) |
| libuv | Node가 쓰는 C 라이브러리로, 이벤트 루프 자체와 스레드 풀을 제공합니다. 스레드 풀은 [17-1절](17-glossary-and-next.md#17-1-용어집)·4-4절 |
| 마이크로태스크 (microtask) | Promise의 후속 처리(`.then`, `await` 다음 줄)와 `queueMicrotask`가 들어가는 V8의 큐입니다. 지금 돌고 있는 콜백이 끝나면 루프의 다음 단계로 가기 **전에** 다 비웁니다(12-2절) |
| `process.nextTick` | Node만의 별도 큐입니다. 콜백이 끝날 때 마이크로태스크보다 **먼저** 비웁니다. 단, 이미 마이크로태스크를 비우는 중이면 그 뒤로 밀립니다(12-2절 실측) |
| 처리 안 된 거부 (unhandled rejection) | 거부(reject)된 Promise에 아무도 `.catch`나 두 번째 `then` 인자를 달지 않은 상태입니다. Node 15부터 기본값은 프로세스를 끝내는 것입니다(12-2절) |
| 이터레이터 `return()` | `next()` 말고 이터레이터가 가진 "이제 그만" 메서드입니다. `for await` 안에서 `break`·`throw`·`return`이 나면 언어가 자동으로 부릅니다. 비동기 제너레이터는 이것을 받으면 `finally`를 돌고 끝납니다(12-8절) |
| controller | `ReadableStream`·`TransformStream`의 원천 함수(`start`·`pull`·`transform`)가 받는 손잡이입니다. `enqueue`(넣기), `close`(끝), `error`(실패), `desiredSize`(남은 자리)가 있습니다(12-4절) |
| highWaterMark (HWM) / `desiredSize` | 스트림 큐가 "이만큼은 미리 쌓아도 된다"는 기준 크기 / 그 기준에서 지금 쌓인 양을 뺀 값입니다. `desiredSize ≤ 0`이 "그만 넣어"라는 역압 신호입니다(12-4절) |
| `writer.ready` | 쓰기 쪽의 `desiredSize`가 0보다 커질 때 풀리는 Promise입니다. 예의 바른 생산자는 이것을 기다린 뒤 씁니다(12-4절) |
| `pipeThrough` / `pipeTo` | 읽기 스트림을 변환·쓰기 스트림에 이어 붙입니다. 내부에서 `writer.ready`를 기다리므로 **역압을 전합니다**(12-4절 실측) |
| 당기기 / 밀어내기 (pull / push) | 소비자가 달라고 할 때만 만드는 방식 / 소비자와 상관없이 만드는 대로 큐에 넣는 방식입니다. 제너레이터와 `ReadableStream.from`은 당기기, LiveKit의 `toStream`은 밀어내기입니다(12-3·12-4절) |
| 앞보기 (lookahead) | 정규식에서 글자를 먹지 않고 바로 뒤만 검사하는 조건 `(?=…)`입니다. 17-1절 "둘러보기"(12-6절) |
| UTF-8 / U+FFFD | 글자를 1~4바이트로 적는 방식(한글 음절은 3바이트) / 디코더가 잘못되거나 덜 온 바이트 자리에 넣는 대체 문자 `�`입니다(12-5절) |
| UTF-16 코드 단위 · 서로게이트 쌍 | JavaScript 문자열의 한 칸(16비트)입니다. `length`는 이 칸 수입니다. U+FFFF를 넘는 글자(이모지 등)는 두 칸(서로게이트 쌍)을 씁니다(12-5·12-6절) |
| `lastIndex` | `g`·`y` 플래그 정규식 객체가 가진 "다음 검색 시작 위치" 상태입니다(12-6절) |
| 속성 기반 테스트 (property-based testing) | 사례 몇 개 대신 "어떤 입력에도 성립해야 할 성질"을 정하고 입력을 많이(또는 전부) 만들어 검사하는 방법입니다(12-7절) |

---

## 12-1. 왜 스트림인가

```text
한꺼번에:  [LLM 답 전체 생성 1.2초] → [변환] → [TTS 전체] → 재생      첫 소리까지 2초+
스트림:    [토큰][토큰][토큰]…
              └→[변환]→[TTS]→ 재생                                   첫 소리까지 1초 안팎
```

스트림은 **"전체가 준비되기 전에 앞부분부터 처리"**하는 방식입니다. 지연을 줄이는 대신, 코드가 **"아직 뒤가 안 왔다"는 불확실성**을 다뤄야 합니다. 이 장의 모든 기법은 이 불확실성을 다루는 방법입니다.

---

## 12-2. 비동기의 기초: Promise와 이벤트 루프

### 이벤트 루프 한 장 요약

Node.js는 **스레드 하나**에서 이벤트 루프를 돌립니다.

```text
┌─▶ 타이머 / 네트워크·파일 I/O 완료 콜백 / setImmediate …
│      └ 각 콜백이 끝날 때마다 → 마이크로태스크 큐(Promise 후속 처리)를 비움
└──────────────────────────────────────────────
```

- `await`는 스레드를 멈추지 않습니다. "이 Promise가 끝나면 이어서 해 줘"라고 예약하고 다른 일을 하러 갑니다.
- 반대로 **동기 코드가 오래 돌면 모든 것이 멈춥니다.** 노이즈 제거(`process(frame)`)처럼 프레임마다 동기로 도는 계산이 길어지면 그 프로세스의 오디오 전송, WebSocket 수신, 타이머가 모두 밀립니다. 4장에서 통화마다 프로세스를 나누는 이유와 연결됩니다.
- (2026-11-06 추가) 위 그림의 "비움"은 사실 큐 **두 개**입니다. Node만의 `process.nextTick` 큐와 V8의 마이크로태스크 큐(Promise)이고, 둘을 번갈아 다 비울 때까지 루프가 다음 단계로 가지 않습니다. 그래서 끝없이 이어지는 `.then` 사슬도 바쁜 루프와 똑같이 모든 것을 멈춥니다(아래 깊이 보기의 실측).

#### 깊이 보기: 루프의 여섯 단계와 두 개의 작은 큐 (2026-11-06 추가)

4-4절 깊이 보기는 "루프가 막히면 무엇이 얼마나 늦나"를 쟀습니다. 여기서는 루프 **안**에서 일이 어떤 차례로 도는지를 봅니다.

**여섯 단계.** Node 문서가 그리는 한 바퀴는 이렇습니다(Node 공식 문서 "The Node.js Event Loop"의 그림).

```text
   ┌──────────────────────────┐
┌─▶│ timers                   │  만료된 setTimeout·setInterval 콜백
│  ├──────────────────────────┤
│  │ pending callbacks        │  지난 바퀴에서 미뤄 둔 일부 시스템 콜백 (예: 몇몇 TCP 오류)
│  ├──────────────────────────┤
│  │ idle, prepare            │  libuv·Node 내부용
│  ├──────────────────────────┤
│  │ poll                     │  I/O 완료를 기다리고 그 콜백을 돌림 (소켓 데이터, 파일, IPC 메시지)
│  ├──────────────────────────┤
│  │ check                    │  setImmediate 콜백
│  ├──────────────────────────┤
└──┤ close callbacks          │  socket.on('close') 같은 닫힘 콜백
   └──────────────────────────┘
   각 콜백 하나가 끝날 때마다: nextTick 큐 → 마이크로태스크 큐 → (둘 다 빌 때까지 반복)
```

- 이 프로젝트에 대 보면, Soniox·ElevenLabs WebSocket에서 오는 메시지, Anthropic SSE의 바이트, 부모 워커가 보낸 IPC 메시지는 모두 **poll** 단계의 콜백으로 들어옵니다. 4-4절의 루프 감시 박동(20ms `setTimeout`)은 **timers** 단계에서 돕니다.
- (코드로 확인, 외부 저장소) libuv 1.52.1의 `uv_run`(`src/unix/core.c`)은 타이머를 바퀴의 **끝**에서 돌립니다. 기본 모드에서는 루프에 들어가기 전에 한 번 돌리고, 그 뒤 매 바퀴 pending → idle → prepare → poll → check → close → timers 순서입니다. 고리를 어디서 끊어 그리느냐의 차이일 뿐 차례는 위 그림과 같습니다.
- poll 단계는 "다음 타이머까지" 기다릴 수 있지만, `setImmediate`가 걸려 있으면 기다리지 않고 바로 check로 갑니다(libuv 문서의 설계 설명 기준, Node 내부 코드는 확인하지 않음).

**두 개의 작은 큐.** 단계와 별개로, 콜백 하나가 끝날 때마다 Node는 `processTicksAndRejections`를 돕니다. nextTick 큐를 끝까지 비우고, V8의 마이크로태스크 큐를 끝까지 비우고, 그사이 새로 들어온 것이 있으면 다시 반복합니다. 마지막에 처리 안 된 거부도 여기서 검사합니다. 이 함수 이름은 아래 12-4절 실습을 쓰다가 프로세스가 죽었을 때 스택에 그대로 찍혀 나왔습니다(`process.processTicksAndRejections (node:internal/process/task_queues:106:37)` → `processPromiseRejections`, 실측).

**실습 1: 같은 다섯 예약, 거는 자리만 다르게.** [lab/12-event-loop-order.mjs](lab/12-event-loop-order.mjs)는 `setTimeout(0)`, `setImmediate`, `Promise.then`, `queueMicrotask`, `process.nextTick`을 같은 함수 안에서 걸고, 그 함수를 부르는 자리만 바꿉니다(실측).

```text
CommonJS 메인 모듈 맨 위 (node -e)
  동기 코드 → process.nextTick → Promise.then → queueMicrotask → setImmediate → setTimeout 0
ESM 모듈 맨 위 (첫 await 전)
  동기 코드 → Promise.then → queueMicrotask → process.nextTick → setImmediate → setTimeout 0
fs.readFile 콜백 안 (poll 단계)
  동기 코드 → process.nextTick → Promise.then → queueMicrotask → setImmediate → setTimeout 0
setTimeout 콜백 안 (timers 단계)
  동기 코드 → process.nextTick → Promise.then → queueMicrotask → setImmediate → setTimeout 0
fs.readFile 콜백 안의 await 뒤 (마이크로태스크 안)
  동기 코드 → Promise.then → queueMicrotask → process.nextTick → setImmediate → setTimeout 0
```

- **"nextTick이 Promise보다 먼저"는 콜백에서 시작할 때만 맞습니다.** `await` 다음 줄은 그 자체가 마이크로태스크로 돕니다. V8이 마이크로태스크 큐를 비우는 도중에 새로 넣은 `then`은 같은 비우기에서 바로 돌고, nextTick은 그 비우기가 끝난 뒤에야 차례가 옵니다. ESM 모듈 맨 위도 같은 결과가 나오는 것은 모듈 평가가 Promise 작업 안에서 돌기 때문으로 봅니다(관찰과 맞는 해석, Node 로더 코드는 확인하지 않아 **추정**). 이 프로젝트의 코드는 거의 다 `async` 함수 안이므로, 실제로는 아래쪽 줄이 흔한 경우입니다.
- **I/O 콜백과 타이머 콜백 안에서는 `setImmediate`가 `setTimeout 0`보다 늘 먼저입니다.** 다음 차례가 check(같은 바퀴)이고 timers는 그 뒤이기 때문입니다.
- `queueMicrotask`와 `then`은 같은 V8 큐라 넣은 순서대로 돕니다.

**실습 2: 비우는 도중에 새로 넣으면.** I/O 콜백 안에서 nextTick A가 then과 nextTick B를 넣고, then 1이 nextTick C와 then 2를 넣게 했습니다(실측).

```text
1. tick A   2. tick B (A가 넣음)   3. then 1   4. then (A가 넣음)   5. then 2 (then 1이 넣음)   6. tick C (then 1이 넣음)
```

nextTick 큐를 **끝까지**(B 포함) 비운 뒤 마이크로태스크 큐를 **끝까지**(then 2 포함) 비우고, 그다음에야 C가 돕니다.

**실습 3: 메인 모듈의 경주.** 메인 모듈에서 `setTimeout(0)`과 `setImmediate` 중 무엇이 먼저냐는 Node 문서도 "보장되지 않는다"고 합니다. `setTimeout`의 0은 실제로 1ms로 바뀌고(Node 문서), 루프가 처음 타이머를 볼 때 그 1ms가 이미 지났느냐에 달렸기 때문입니다. 자식 프로세스를 20번씩 띄워 셌습니다(실측).

```text
그대로:                setTimeout 먼저 2번, setImmediate 먼저 18번
예약 뒤 2ms 바쁜 루프:   setTimeout 먼저 20번, setImmediate 먼저 0번
```

같은 스크립트를 처음 쓸 때는 ESM 맨 위에서 `setTimeout`이 계속 먼저 나왔는데, 원인은 바로 다음 줄의 `spawnSync`(자식 프로세스를 띄우는 동안 루프를 수십 ms 막음)였습니다. 실험 장치가 결과를 바꾼 예라 스크립트에 주석으로 남겨 두었습니다.

**실습 4: 마이크로태스크가 루프를 굶긴다.** 50µs짜리 일 조각을 200ms 동안 계속 다음 조각으로 예약하면서, 20ms 박동과 파일 읽기 하나를 같이 걸었습니다(실측).

```text
then 사슬     : 조각 3,980개, 20ms 박동 3번, 최대 지각 180.2ms, 파일 읽기 콜백 200.3ms
nextTick 사슬 : 조각 3,907개, 20ms 박동 3번, 최대 지각 180.1ms, 파일 읽기 콜백 200.2ms
setImmediate  : 조각 3,100개, 20ms 박동 12번, 최대 지각 2.3ms, 파일 읽기 콜백 0.3ms
```

- `then`·nextTick 사슬은 한 번도 루프의 다음 단계로 넘어가지 못합니다. 200ms 내내 타이머도, 0.3ms면 끝날 파일 읽기 콜백도 기다렸습니다. 소켓으로 들어온 오디오·STT 메시지도 똑같이 기다렸을 것입니다.
- `setImmediate`로 쪼개면 조각마다 check 단계로 돌아가므로 그사이 timers·poll이 돕니다. 대신 같은 200ms에 해낸 조각 수가 22% 줄었습니다(한 바퀴를 도는 비용. 여러 번 돌려 보면 22~27%). "긴 계산을 잘게 쪼개 루프에 숨 쉴 틈을 준다"는 말은 **매크로태스크(setImmediate·setTimeout)로 쪼갠다**는 뜻이고, `await Promise.resolve()`로 쪼개면 아무 효과가 없습니다.

**4-4절의 루프 감시와의 관계.** SDK의 루프 감시는 20ms `setTimeout`을 이어 걸고 예정보다 늦은 만큼을 지각으로 잽니다(`agents/telemetry/loop_monitor.ts`, [4-4절 깊이 보기](04-worker-runtime.md#깊이-보기-이벤트-루프-격리를-숫자로--스레드-지도와-루프-감시-2026-11-06-추가)). 위 구조에서 보면 이 지각은 "timers 단계에 다시 오기까지 걸린 시간 − 20ms"입니다. 그사이의 동기 코드, 콜백마다 딸린 nextTick·마이크로태스크 비우기, poll 단계의 긴 콜백, GC가 모두 합쳐져 나타납니다. 실습 4의 `then` 사슬은 메인 스레드가 내내 CPU를 쓰므로 SDK 분류로는 "code" 막힘으로 보일 것입니다(4-4절의 분류 규칙에 비춘 **추정**).

### 기다리지 않는 호출 (fire-and-forget)

```ts
session.say(openingNotice(call), { allowInterruptions: false });   // await 없음
session.say(OPENING_QUESTION, { allowInterruptions: true });
```

`say()`는 SpeechHandle을 돌려주는데, 이 코드는 기다리지 않습니다. **대기열에 넣는 것이 목적이지 재생 완료를 기다리는 것이 목적이 아니기** 때문입니다. `onUserTurnCompleted` 안의 즉시 반응도 마찬가지입니다. 기다리면 본 답 생성이 즉시 반응 재생이 끝날 때까지 밀립니다.

기다리지 않는 호출의 주의점은 **오류가 버려질 수 있다**는 것입니다. 기다리지 않은 Promise가 실패하면 아무도 처리하지 않는 거부(unhandled rejection)가 됩니다. (2026-11-06 갱신) `say()`가 여기서 괜찮은 진짜 이유는 돌려주는 SpeechHandle이 **Promise가 아니라는** 데 있습니다. SpeechHandle은 `then` 메서드만 가진 thenable이고, 누군가 `then`을 부르거나 `await`할 때 비로소 `waitForPlayout()`의 Promise를 만듭니다(`agents/voice/speech_handle.ts` 435~473, 코드로 확인). 아무도 기다리지 않으면 거부될 Promise 자체가 생기지 않습니다. 반면 우리가 만든 `async` 함수는 부르는 순간 Promise가 생기므로, 기다리지 않고 부를 때는 `.catch()`를 붙여야 합니다. [src/main.ts](../../src/main.ts)의 즉시 반응 음성 준비(38~41행)와 통화 결과 전송(127행)이 그렇게 되어 있습니다.

#### 깊이 보기: 처리 안 된 거부는 어디로 가나 (2026-11-06 추가)

**Node의 기본값.** Node 15부터 `--unhandled-rejections`의 기본값은 `throw`입니다. 처리 안 된 거부가 생기면 먼저 `unhandledRejection` 이벤트를 내고, **듣는 사람이 없으면** 잡히지 않은 예외로 바꿔 프로세스를 끝냅니다(Node 문서). [lab/12-event-loop-order.mjs](lab/12-event-loop-order.mjs) 5번이 `await`도 `.catch()`도 없이 실패하는 `async` 함수를 불러 봅니다(실측).

```text
핸들러 없음 (Node 기본값): 종료 코드 1
   stderr: Error: 결과 전송 실패
잡 프로세스처럼 핸들러를 담 (agents/ipc/job_proc_lazy_main.ts 326): 종료 코드 0
   [debug] Unhandled promise rejection: 결과 전송 실패
   (100ms 뒤에도 살아 있음)
```

이 장의 실습을 쓰면서도 한 번 이렇게 죽었습니다. `void w.write(c).then(...)`처럼 `void`를 붙였는데, `void`는 "결과를 일부러 버린다"는 표시일 뿐 거부를 받아 주지 않습니다. 스트림을 정리할 때 그 write들이 거부되자 프로세스가 `ERR_UNHANDLED_REJECTION`으로 끝났습니다(`lab/12-backpressure.mjs` 3번의 주석).

**잡 프로세스에서는 죽지 않고 숨는다.** LiveKit은 잡 프로세스(통화 하나를 맡는 자식)가 시작할 때 이렇게 핸들러를 답니다(코드로 확인).

```ts
// agents/ipc/job_proc_lazy_main.ts 326~328
process.on('unhandledRejection', (reason) => {
  logger.debug({ error: reason }, 'Unhandled promise rejection in job process');
});
```

- 듣는 사람이 있으므로 Node의 `throw` 모드가 프로세스를 끝내지 않습니다. 통화 하나가 처리 안 된 거부 하나로 끊기지 않게 하는 안전장치입니다.
- 대신 **debug** 수준으로만 남습니다. `node src/main.ts start`(운영)의 기본 로그 수준은 info이고 `dev`는 debug입니다(`agents/cli.ts` 173·204). 그래서 운영 로그에서는 이 실패가 **보이지 않습니다.** 결과 전송 같은 일을 기다리지 않고 부르면서 `.catch()`를 빼먹으면, 실패가 아무 흔적 없이 사라집니다.
- SDK 안에서 이런 핸들러는 이 한 곳뿐입니다(`agents/` 전체 검색). 워커 프로세스(부모)와 추론 프로세스에는 없으므로, 거기서 생긴 처리 안 된 거부는 Node 기본대로 그 프로세스를 끝냅니다(코드 검색 기준, 실제로 일으켜 보지는 않음).

**미리 막는 도구: `no-floating-promises`.** typescript-eslint의 `@typescript-eslint/no-floating-promises` 규칙은 기다리지도, `.catch()`도, `void`도 붙이지 않은 Promise를 오류로 잡습니다. 타입 정보가 필요한 규칙이라 `recommendedTypeChecked` 설정과 `parserOptions.projectService`가 있어야 켜집니다. 이 레포의 [eslint.config.ts](../../eslint.config.ts)는 `tseslint.configs.recommended`(타입 정보 없음)만 써서 **켜져 있지 않습니다**(`eslint --print-config`로 확인). 임시 설정(레포 밖 파일)으로 이 규칙만 켜고 `src/`·`scripts/`를 돌려 보니 위반은 0건이었습니다(실측). 테스트 파일은 `tsconfig.json`에 들어 있지 않아 검사되지 않았습니다. 참고로 이 규칙도 `void`는 허용하므로, 위 실습의 `void … .then(…)` 같은 실수는 잡지 못합니다. SpeechHandle 같은 thenable은 기본 설정(`checkThenables: false`)에서는 검사하지 않습니다.

### 이벤트 이미터

```ts
session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => { … });
model.on('error', ({ error }) => { … });   // scripts/check-llm.ts
```

Node의 `EventEmitter`는 "이 이름의 사건이 나면 이 함수를 불러 달라"는 구독 방식입니다. 스트림이 "순서 있는 데이터의 흐름"이라면, 이벤트는 "언제 올지 모르는 개별 사건"입니다. check-llm이 오류를 스트림이 아니라 `error` 이벤트로 받는 이유는 LiveKit LLM이 API 오류를 그렇게 알리기 때문입니다. **어느 통로로 오류가 오는지**를 모르면 오류를 놓칩니다.

---

## 12-3. 이터레이터와 제너레이터

### 이터레이션 프로토콜

`for…of`는 객체의 `[Symbol.iterator]()`가 돌려주는 이터레이터의 `next()`를 반복 호출합니다. 비동기 버전은 `[Symbol.asyncIterator]()`와 `for await…of`입니다.

```ts
for await (const chunk of model.chat({ chatCtx })) {   // LLMStream은 AsyncIterable<ChatChunk>
  if (chunk.delta?.content) text += chunk.delta.content;
}
```

`next()`는 `{ value, done }`(비동기면 그 Promise)을 돌려줍니다. 핵심은 **당기기(pull) 방식**이라는 점입니다. 소비자가 `next()`를 부를 때 다음 값을 가져옵니다.

(2026-11-06 추가) 이터레이터에는 `next()` 말고 `return()`도 있습니다. `for await` 몸통에서 `break`·`throw`·`return`이 나면 언어가 자동으로 상류 이터레이터의 `return()`을 불러 "이제 그만"을 알립니다(ECMA-262의 `AsyncIteratorClose`). 끼어들기 때 이 신호가 사슬을 거꾸로 타고 올라가는 순서는 12-8절에서 봅니다.

### 제너레이터: 이터레이터를 쉽게 만드는 문법

```ts
async function* withoutLeadingAck(stream) {   // async function* = 비동기 제너레이터
  for await (const chunk of stream) {
    …
    yield chunk;                                // 값을 하나 내보내고, 다음 next()까지 여기서 멈춤
  }
}
```

- `function*`는 실행 도중 `yield`에서 **멈췄다가 다시 이어지는** 함수입니다. 지역 변수(`held`, `passing`)가 멈춘 동안에도 유지됩니다. 상태를 가진 스트림 변환을 클래스 없이 쓸 수 있는 이유입니다.
- **게으름(laziness)**: 소비자가 값을 요구하지 않으면 제너레이터는 진행하지 않습니다. (2026-11-06 갱신) 그래서 제너레이터를 **직접** `for await`로 읽으면 생산 속도가 소비 속도에 맞춰집니다. 하지만 LiveKit의 운영 경로에서는 그렇지 않습니다. `llmNode`가 돌려준 제너레이터를 SDK가 `toStream()`으로 감싸는데(`agents/voice/agent_v2.ts` 419), `toStream`은 `start()` 안에서 이터레이터를 끝까지 당겨 `enqueue`합니다(`agents/utils.ts` 1444~1476, 아래 12-4절 깊이 보기). 소비자가 느려도 `withoutLeadingAck`는 상류가 주는 대로 계속 진행합니다. 실습에서 같은 제너레이터(10ms마다 조각 하나)를 느린 소비자(조각마다 100ms)가 읽게 했더니, 직접 읽을 때는 조각이 약 115ms 간격으로 만들어졌고 `toStream`으로 감싸면 67ms 만에 여섯 개를 다 만들었습니다(실측, [lab/12-backpressure.mjs](lab/12-backpressure.mjs) 1번).
- `yield* chunks`는 다른 이터러블의 값을 하나씩 그대로 내보냅니다(테스트의 `source()` 함수).

---

## 12-4. Web Streams

LiveKit Agents의 노드들은 **Web Streams**(`ReadableStream`, `TransformStream`)로 데이터를 주고받습니다. 브라우저 표준이고 Node에서는 `node:stream/web`에 있습니다. Node의 옛 스트림(`stream.Readable`)과는 다른 API입니다.

| 구성 | 역할 |
| --- | --- |
| `ReadableStream<T>` | 데이터를 내보내는 쪽. Node에서는 `for await`로 읽을 수 있음(async iterable) |
| `WritableStream<T>` | 데이터를 받는 쪽 |
| `TransformStream<I, O>` | 한쪽으로 받아 변환해 다른 쪽으로 내보내는 쌍 |
| `readable.pipeThrough(transform)` | 변환을 이어 붙여 새 ReadableStream을 얻음 |

### TransformStream의 두 메서드

```ts
new TransformStream<string, string>({
  transform(chunk, controller) {   // 조각이 들어올 때마다
    controller.enqueue(…);         // 0개, 1개, 여러 개를 내보낼 수 있음
  },
  flush(controller) {              // 입력이 끝났을 때 한 번
    controller.enqueue(…);         // 남은 것을 마저 내보냄
  },
});
```

**`flush`를 빼먹는 것이 스트림 변환의 가장 흔한 버그**입니다. 무언가를 모아 두는 변환은 반드시 끝에서 남은 것을 내보내야 합니다. `pronunciation.test.ts`의 "마지막 조각도 빠짐없이 내보낸다", `ack.test.ts`의 "짧은 답도 빠짐없이 내보낸다"가 정확히 이 버그를 막는 테스트입니다.

### 역압(backpressure)

생산자가 소비자보다 빠르면 데이터가 어딘가에 쌓입니다. Web Streams는 각 단계에 **큐**와 **기준 크기(highWaterMark)**를 두고, 큐가 차면 생산자에게 "잠깐 멈춰"라는 신호를 보냅니다. 이것이 역압입니다. 음성 파이프라인에서는 LLM(빠름) → TTS(재생 속도) 사이에서 이 문제가 생기는데, LiveKit은 LLM 출력 버퍼를 사실상 무제한으로 두어 LLM이 끝까지 먼저 생성하게 합니다(11장 선제 생성). 텍스트는 작아서 쌓여도 문제가 없기 때문입니다.

(2026-11-06 갱신) "사실상 무제한"의 근거는 코드에 그대로 있습니다. 세션이 LLM 글을 흘려보내는 통로는 `IdentityTransform`이고(`agents/voice/generation.ts` 687), 이 클래스는 양쪽 HWM을 `Number.MAX_SAFE_INTEGER`로 바꿉니다. 주석이 이유를 적고 있습니다.

```ts
// agents/stream/identity_transform.ts 6~17
export class IdentityTransform<T> extends TransformStream<T, T> {
  constructor() {
    super(
      { transform: (chunk, controller) => controller.enqueue(chunk) },
      // By default the transfor stream will buffer only one chunk at a time.
      // In order to follow the python agents channel.py, we set set the capaciy to be effectively infinite.
      { highWaterMark: Number.MAX_SAFE_INTEGER },
      { highWaterMark: Number.MAX_SAFE_INTEGER },
    );
  }
}
```

그리고 이 통로 **앞**도 역압을 받지 않습니다. 사슬의 대부분이 "start에서 끝까지 밀어 넣는" 감싸기이기 때문입니다(아래 깊이 보기).

#### 깊이 보기: 역압은 어디서 끊기나 — HWM, desiredSize, 밀어내기 감싸기 (2026-11-06 추가)

**스펙의 장치.** Web Streams(WHATWG Streams 표준)에서 역압은 숫자 하나로 움직입니다.

- 각 스트림의 큐에는 HWM이 있고, `desiredSize = HWM − 큐에 쌓인 양`입니다(조각 개수로 셀 때 한 조각 = 1).
- 읽기 쪽(`ReadableStream`)은 `desiredSize > 0`이거나 기다리는 `read()`가 있을 때만 원천의 `pull()`을 부릅니다. 원천이 `pull()` 안에서 한 조각씩 넣으면 소비 속도에 맞춰집니다.
- 쓰기 쪽(`WritableStream`)은 `writer.desiredSize`와 `writer.ready`를 보여 줍니다. `desiredSize ≤ 0`이면 `ready`가 풀리지 않고, 각 `write()`의 Promise는 그 조각이 실제로 처리될 때 풀립니다.
- 기본값: `new ReadableStream()`은 HWM 1, `new TransformStream()`은 **쓰기 쪽 1, 읽기 쪽 0**, `ReadableStream.from(iterable)`은 **0**(읽기 요청이 있을 때만 다음 값을 당김)입니다(표준).
- `pipeTo`·`pipeThrough`는 대상의 `writer.ready`를 기다리며 읽으므로 역압을 앞 단계로 전합니다.

중요한 점은 이것이 **협조 방식**이라는 것입니다. 표준은 신호(`desiredSize`)를 줄 뿐이고, 원천이 무시하고 `enqueue`하면 큐는 그냥 늘어납니다. LiveKit의 `toStream`이 그런 원천입니다.

```ts
// agents/utils.ts 1444~1476 (toStream, 줄임)
return new ReadableStream<T>({
  async start(controller) {
    iterator = iterable[Symbol.asyncIterator]();
    while (true) {
      const { done, value } = await iterator.next();   // 소비자와 상관없이 다음 값을 당김
      if (done || cancelled) break;
      controller.enqueue(value);                         // desiredSize를 보지 않음
    }
    if (!cancelled) controller.close();
  },
  cancel(reason) {
    cancelled = true;
    void iterator?.return?.(reason).catch(() => {});    // 12-8절
  },
});
```

**실측: 같은 생산자, 다른 감싸기.** [lab/12-backpressure.mjs](lab/12-backpressure.mjs)는 10ms마다 조각을 내는 제너레이터를 세 가지로 감싸고, 조각마다 100ms 걸리는 소비자가 읽게 합니다.

```text
① 제너레이터 그대로 (for await)       생산   11 124 239 354 469 582   소비   11 124 239 354 469 583
② ReadableStream.from(제너레이터)     생산   15 129 244 358 472 586   소비   15 129 244 358 472 586
③ toStream(제너레이터) (LiveKit)      생산   13  25  37  48  58  67   소비   13 114 216 319 421 523
```

②는 HWM 0이라 소비자가 읽을 때만 당기므로 ①과 똑같이 맞춰집니다. 테스트([src/pronunciation.test.ts](../../src/pronunciation.test.ts))가 쓰는 것이 이쪽입니다. ③은 67ms 만에 여섯 개를 다 만들고 큐에 쌓아 둡니다. `toStream`과 같은 모양의 스트림에서 매 `enqueue` 뒤 `controller.desiredSize`를 찍으면 `0, -1, -2, -3, -4, -5`로 계속 내려갑니다(실습 2번). 신호는 나오는데 아무도 보지 않는 것입니다.

쓰기 쪽도 재 봤습니다(실습 3번). 읽는 사람이 없을 때 조각 세 개를 `await` 없이 `write`했습니다.

```text
new TransformStream() 기본값
  쓰기 전 desiredSize 1, ready 풀림 → 3개 쓴 뒤 desiredSize -2, ready 대기, 끝난 write: []
  읽기 쪽에서 한 개 읽은 뒤 → desiredSize -1, 끝난 write: [a]
LiveKit IdentityTransform (HWM MAX_SAFE_INTEGER)
  쓰기 전 desiredSize 9007199254740991 → 3개 쓴 뒤 desiredSize 9007199254740991, ready 풀림, 끝난 write: [a, b, c]
```

기본값에서는 `await writer.write()`가 읽는 쪽이 가져갈 때까지 멈추고, `IdentityTransform`에서는 즉시 끝납니다. `generation.ts`가 LLM 글마다 `await textWriter.write(…)`를 하는데(770·773·805) 이 줄이 TTS를 기다리지 않는 이유입니다.

**`pipeThrough`는 역압을 전한다, 단 원천이 들어 줄 때만.** 실습 4번은 원천을 [src/pronunciation.ts](../../src/pronunciation.ts)의 `pronunciationTransform`(기본 HWM의 `TransformStream` + `pipeThrough`)에 통과시킵니다.

```text
당기기 소스 ReadableStream.from   생산   13  25 128 229 332 432   소비   13 116 218 319 420 523
밀어내기 소스 toStream            생산   13  24  36  49  60  71   소비   13 115 216 319 421 523
```

당기기 원천은 한 조각만 앞서 만든 뒤(그 조각은 변환의 쓰기 쪽 큐에서 기다림, HWM 1) 소비 속도에 맞춰집니다. 밀어내기 원천은 파이프가 아무리 기다려도 자기 큐에 계속 쌓습니다. 역압은 사슬에서 **하나라도 밀어내기 단계가 있으면 거기서 끊깁니다.**

**이 레포의 LLM 글 경로를 단계별로.** 코드로 확인한 것입니다.

| 단계 | 코드 | 방식 | 큐 |
| --- | --- | --- | --- |
| ① 플러그인 → `LLMStream` | `agents/llm/llm.ts` 189~190, 391~395 (`AsyncIterableQueue`) | 밀어내기 (`put`) | 무제한 |
| ② 기본 `llmNode`의 ReadableStream | `agents/voice/agent.ts` 577~591 (`start`에서 `for await` → `enqueue`) | 밀어내기 | 무제한 (HWM 1을 무시) |
| ③ `withoutLeadingAck` | [src/ack.ts](../../src/ack.ts) | 당기기 (제너레이터) | 보류 12자 |
| ④ `toStream` | `agents/voice/agent_v2.ts` 419, `agents/utils.ts` 1444 | 밀어내기 | 무제한 (HWM 1을 무시) |
| ⑤ 읽기 루프 → 텍스트 통로 | `agents/voice/generation.ts` 745~806 → 687 `IdentityTransform` | 쓰기, 기다려도 즉시 끝남 | HWM 최대 |
| ⑥ TTS 쪽 통로들 | `agents/voice/agent_activity.ts` 3949·3956, `generation.ts` 914 (`IdentityTransform`) | 같음 | HWM 최대 |
| ⑦ `filter_markdown` → `filter_emoji` | `agents/voice/transcription/text_transforms.ts` 59~72 (`streamFromAsyncIterable`: `start`에서 밀어 넣기) | 밀어내기 | 무제한 |
| ⑧ `pronunciationTransform` | [src/pronunciation.ts](../../src/pronunciation.ts) (`pipeThrough`, 기본 HWM) | 역압 지킴 | 쓰기 1 / 읽기 0 |

- 역압을 지키는 단계는 ⑧ 하나이고, 그 앞 ⑦이 밀어내기이므로 TTS가 느려도 신호는 ⑦의 큐에서 멈춥니다. **LLM은 어떤 경우에도 느려지지 않습니다.** 설계 의도와 같습니다(`identity_transform.ts` 12~13의 주석: Python의 `channel.py`를 따름).
- 그래서 ③의 게으름은 의미가 없습니다. `withoutLeadingAck`는 ④가 당기는 대로 진행합니다.
- 쌓이는 양: 답 하나는 많아야 수백 자이고 한글 한 글자는 JS 문자열로 2바이트이므로 수 KB 안쪽입니다(추정). 메모리 문제는 없습니다. TTS 오디오 쪽 통로도 `IdentityTransform`(`generation.ts` 905)이라 TTS가 재생보다 빨리 합성하면 프레임이 메모리에 쌓입니다. 22,050Hz 16비트면 10초에 약 441KB입니다(계산, ElevenLabs가 실제로 재생보다 얼마나 빨리 보내는지는 재지 않음).
- 이 구조의 대가는 12-8절에서 봅니다. 쌓아 둔 것을 버릴 때, 즉 **취소**할 때 각 단계가 언제 멈추는지가 단계마다 다릅니다.

### 둘 사이 변환

| 변환 | 방법 | 역압·취소 (2026-11-06 추가) |
| --- | --- | --- |
| 배열·이터러블 → ReadableStream | `ReadableStream.from(chunks)` (테스트에서 사용) | 당기기(HWM 0). cancel하면 이터레이터의 `return()`을 부르고 **끝날 때까지 기다림** |
| AsyncIterable → ReadableStream | LiveKit의 `toStream()` | 밀어내기(`start`에서 끝까지). cancel하면 `return()`을 부르되 **기다리지 않음**(12-8절) |
| ReadableStream → 순회 | `for await (const x of stream)` | 도중에 `break`하면 그 스트림을 **cancel**함. 안 하려면 `stream.values({ preventCancel: true })` |

`Agent.create`의 노드 훅은 비동기 제너레이터(AsyncIterable)를 돌려줘도 되고, LiveKit이 알아서 ReadableStream으로 감쌉니다(2026-11-06 갱신: 감싸는 함수가 `toStream`, `agents/voice/agent_v2.ts` 400~461의 노드마다 `toStream(result)`). 그래서 `llmNode`가 `withoutLeadingAck(stream)`(비동기 제너레이터)를 그대로 돌려줄 수 있습니다.

---

## 12-5. 조각 경계 문제와 네 가지 해법

### 문제

LLM은 토큰 단위로 글을 내보내고, **토큰 경계는 우리가 원하는 단위(단어, 문장)와 맞지 않습니다.**

```text
원하는 처리: "F2" → "에프투",  첫머리 "네, " 제거
실제 조각:   ["F", "2 울", "트라는 x", "Tool 제품", "이에요."]
             ["네", ", ", "예산", "은 어느", " 정도", " 생각하세요?"]
```

조각 하나만 보고는 판단할 수 없습니다. "F"만 보고는 "F2"인지 "F20"인지 "Fine"인지 모릅니다.

### 정확성의 기준

스트림 변환이 맞는지 판단하는 기준은 하나입니다.

> **조각을 어떻게 나눠 넣든, 출력을 이어 붙인 결과가 "전체를 한 번에 변환한 결과"와 같아야 한다.**

`출력.join('') === 변환(입력.join(''))` — 이 불변식을 테스트로 확인합니다.

### 해법 1: 구분자까지 보류 (pronunciationTransform)

"공백이 나오면 그 앞 단어는 완성됐다"는 성질을 이용합니다. 마지막 공백까지는 변환해 내보내고, 그 뒤 꼬리는 다음 조각과 합칠 때까지 잡아 둡니다(10-6절).

- 장점: 지연이 단어 하나 수준으로 작음
- 조건: 변환 대상(제품명)이 **구분자를 포함하지 않아야** 함. 만약 발음표에 "F2 울트라"처럼 공백이 든 항목을 추가하면 이 방법이 깨집니다. 그런 항목은 "F2"와 "울트라"로 나눠 처리하거나 보류 기준을 바꿔야 합니다.

### 해법 2: 앞부분 고정 길이 보류 후 통과 (withoutLeadingAck)

"처리 대상이 **맨 앞에만** 있다"는 성질을 이용합니다. 처음 N자를 모아 한 번 판단한 뒤로는 그냥 통과시킵니다.

- 장점: 판단 후에는 추가 비용·지연이 0
- 조건: N이 처리 대상의 최대 길이보다 커야 함
- (2026-11-06 추가) 이 레포는 이 조건을 다 지키지 못합니다. `stripLeadingAck`는 맞장구를 두 번까지 떼므로 처리 대상의 최대 길이가 "알겠습니다. 감사합니다. "(14자) 이상인데 N은 12입니다. 실측에서 나온 조합(10자)은 덮지만, 긴 맞장구 둘이 겹치면 분할에 따라 실패합니다(12-7절 깊이 보기).

### 해법 3: 상태 기계 (filter_markdown)

`**`를 만나면 "강조 중" 상태로 바꾸고, 닫는 `**`가 올지 모르니 공백·구두점까지 모았다가 판단합니다. 패턴이 복잡할 때 씁니다.

### 해법 4: 마지막 하나 보류 (ElevenLabs alignment)

TTS가 돌려주는 글자별 시각을 단어로 묶을 때, **마지막 단어는 아직 완성되지 않았을 수 있으므로** 다음 메시지가 올 때까지 보류합니다(10장).

### 공통 원칙

| 원칙 | 이유 |
| --- | --- |
| 확실한 부분만 내보낸다 | 내보낸 것은 되돌릴 수 없음 (이미 TTS로 감) |
| 끝에서 반드시 비운다 (`flush`) | 데이터 유실 방지 |
| 보류량을 최소로 | 보류 = 지연 |
| 판단과 무관한 데이터는 그대로 통과 | 도구 호출·사용량 청크를 망가뜨리지 않기 |

#### 깊이 보기: 바이트 층의 경계 — UTF-8 한 글자가 둘로 갈릴 때 (2026-11-06 추가)

위의 경계 문제는 **글자** 단위였습니다. 그 아래, 네트워크에서 바이트를 받아 글자로 바꾸는 층에도 똑같은 문제가 있습니다. TCP는 바이트의 흐름일 뿐이라 `data` 이벤트 하나가 어디서 끊길지 정하지 않습니다.

**한글은 3바이트.** UTF-8은 U+0800~U+FFFF 글자를 `1110xxxx 10xxxxxx 10xxxxxx` 세 바이트로 적습니다. [lab/12-utf8-boundary.mjs](lab/12-utf8-boundary.mjs) 1번(실측)입니다.

```text
"네" = U+B124 → 3바이트 EB 84 A4
비트: 11101011 10000100 10100100  (1110xxxx 10xxxxxx 10xxxxxx)
1바이트 뒤에서 자름: [EB] + [84 A4] → 따로 디코드 "���"
2바이트 뒤에서 자름: [EB 84] + [A4] → 따로 디코드 "��"
```

조각마다 따로 디코드하면 디코더는 앞 조각 끝의 "덜 끝난 글자"를 U+FFFD 하나로, 뒤 조각 앞의 "앞이 없는 이어짐 바이트"를 하나씩 U+FFFD로 바꿉니다(WHATWG Encoding 표준의 대체 규칙과 같은 결과). 한 글자가 `�` 두세 개가 됩니다.

**해법 세 가지.** "네, 예산은요?"(18바이트)를 가능한 17군데에서 모두 둘로 잘라 넣었습니다(실습 2번, 실측).

| 디코드 방법 | 깨진 경우 | U+FFFD 합계 |
| --- | --- | --- |
| 조각마다 `Buffer.toString()` | 10/17 | 25 |
| `TextDecoder`, stream 옵션 없음 | 10/17 | 25 |
| `TextDecoder`, `{stream: true}` | 0/17 | 0 |
| `StringDecoder` (`req.setEncoding('utf8')`이 쓰는 것) | 0/17 | 0 |
| `Buffer.concat` 뒤 한 번 | 0/17 | 0 |

- 10/17은 글자 다섯 개(네·예·산·은·요) × 글자 안쪽 자리 두 곳입니다. 쉼표·공백·물음표 뒤에서 자르면 멀쩡합니다.
- `{stream: true}`는 덜 끝난 바이트를 디코더 안에 남겨 두었다가 다음 호출 앞에 붙입니다. 6바이트 뒤(`EB 84 A4 2C 20 EC` | `98 88 …`, "예"의 첫 바이트 뒤)에서 자르면 첫 호출은 `"네, "`만 돌려주고 `EC`를 안에 남기며, 둘째 호출이 `"예산은요?"`를 냅니다(실측). 이 장의 **해법 1(확실한 부분만 내보내고 꼬리는 보류)**을 바이트 층에서 한 것입니다. 끝에 인자 없이 `decode()`를 한 번 더 불러 남은 바이트를 비웁니다(`flush`와 같은 역할, 덜 끝난 바이트가 남아 있었다면 여기서 U+FFFD로 나옴).
- `Buffer.concat` 뒤 한 번은 "끝까지 다 모은 뒤 처리"이므로 스트리밍이 아닐 때만 씁니다.

**SDK의 SSE는 구분자까지 모은 뒤 디코드한다 (코드로 확인).** Anthropic SDK 0.33.1은 받은 바이트를 `Uint8Array`에 이어 붙이고, 빈 줄(`\n\n`)을 찾을 때마다 그 앞까지를 잘라 냅니다(`sdk/streaming.ts` 233~261 `iterSSEChunks`). 글자로 바꾸는 것은 그다음, 잘라 낸 이벤트 하나씩입니다(`sdk/internal/decoders/line.ts` 67~79, Node에서는 `Buffer.from(bytes).toString()`). 구분자 `\n`(0x0A)은 ASCII라 UTF-8 여러 바이트 글자의 중간에 나올 수 없으므로(이어짐 바이트는 모두 0x80 이상), 이벤트 경계에서 자른 바이트는 늘 완전한 글자로 끝납니다. 실습 4번에서 SSE 이벤트 두 개(170바이트)를 169군데에서 잘라 같은 방식으로 넣었더니 깨진 경우가 0번이었습니다(실측).

**같은 함수의 off-by-one.** 그런데 이 "구분자 찾기"가 버퍼의 맨 끝 두 바이트를 보지 않습니다(`i < buffer.length - 2`). 받은 조각이 이벤트 끝 `\n\n`으로 **정확히** 끝나면 그 이벤트를 다음 바이트가 올 때까지 붙잡습니다. 같은 코드를 옮겨 이벤트 하나짜리 조각을 넣으면 0.33.1 식은 "다음 바이트가 올 때까지(여기서는 스트림 끝) 붙잡음", 검사를 `i < length - 1`로 고친 식은 "바로 냄"이었습니다(실습 4번). 영향과 측정은 [8-6절 깊이 보기](08-llm.md)와 [17-2절](17-glossary-and-next.md#17-2-이-책을-쓰며-코드에서-발견한-사항) #36에 있습니다. 보류 버퍼의 함정은 "덜 붙잡기"(글자가 깨짐)만이 아니라 "더 붙잡기"(구분자 검사가 한 칸 짧아 지연)도 있다는 사례입니다.

**이 레포의 같은 함정: `raw += chunk`.** [src/models/anthropic.test.ts](../../src/models/anthropic.test.ts) 55~56행의 가짜 서버는 요청 본문을 이렇게 모읍니다.

```ts
let raw = '';
req.on('data', (chunk) => (raw += chunk));   // chunk는 Buffer → 조각마다 toString()
```

문자열에 `Buffer`를 더하면 그 조각만 `toString()`(UTF-8)되므로, 위 표의 첫 줄과 같은 방법입니다. 지금 테스트의 본문은 수백 바이트라 `data` 이벤트가 한 번에 오므로 드러나지 않을 뿐입니다. 실습 3번은 로컬 HTTP 서버에 같은 본문 모양(`{"content":"네, 괜찮아요."}`)을 "네"의 1바이트 뒤에서 끊어 30ms 간격으로 두 번에 보냈습니다(실측).

```text
raw += chunk:            data 이벤트 2번 → {"content":"���, 괜찮아요."}  (JSON.parse → content "���, 괜찮아요.")
req.setEncoding('utf8'): data 이벤트 2번 → {"content":"네, 괜찮아요."}
Buffer.concat 뒤 한 번:  data 이벤트 2번 → {"content":"네, 괜찮아요."}
```

`JSON.parse`가 **실패하지 않고** 깨진 글을 그대로 돌려준다는 점이 위험합니다. 요청 본문에 실제 지시문처럼 긴 한글(8장 실습의 1턴 본문이 약 8.9KB)을 실은 테스트로 바뀌면, 본문이 여러 `data` 이벤트로 나뉘어 조용히 틀린 값을 검사하게 될 수 있습니다((2026-11-06 갱신) 14장 실습에서는 7,365바이트가 `data` 한 번으로 왔고, 64KiB를 넘자 나뉘어 U+FFFD가 생겼습니다. `lab/14-fake-server.mjs`). 정석은 `req.setEncoding('utf8')`(내부에서 `StringDecoder`로 덜 끝난 바이트를 넘김)이나, `Buffer`를 배열에 모아 `end`에서 `Buffer.concat(chunks).toString()`입니다. 이 장에서는 코드를 고치지 않고 사례로만 둡니다.

**JS 문자열 층: UTF-16 코드 단위.** 디코드가 끝난 뒤에도 경계는 한 번 더 있습니다. JavaScript 문자열의 `length`와 `slice`는 UTF-16 **코드 단위**를 셉니다(실습 5번, 실측).

```text
"네"    length 1, 코드 포인트 1개, UTF-8 3바이트
"😀"   length 2, 코드 포인트 1개, UTF-8 4바이트
"😀".slice(0, 1) = \uD83D (홀로 남은 서로게이트) → UTF-8로 바꾸면 EF BF BD = U+FFFD
```

U+FFFF를 넘는 글자는 두 칸(서로게이트 쌍)이라, 아무 자리에서나 `slice`하면 반쪽이 남고 그것을 바이트로 내보내는 순간 `�`가 됩니다. 이 레포의 두 변환은 안전합니다. `pronunciationTransform`은 공백·줄바꿈 **바로 뒤**에서만 자르고(둘 다 한 칸 글자), `withoutLeadingAck`는 `length`로 길이만 재고 자르지 않습니다. 게다가 `ttsTextTransforms`의 순서상 `filter_emoji`가 발음 변환보다 먼저 돕니다([src/main.ts](../../src/main.ts) 57). 앞으로 "앞 N자만 보류"를 `slice(0, N)`로 짜려면 `[...text]`(코드 포인트 단위)나 `Intl.Segmenter`(사람이 보는 글자 단위)를 생각해야 합니다.

---

## 12-6. withoutLeadingAck 해부

```ts
// src/ack.ts
const HOLD_CHARS = 12;

export async function* withoutLeadingAck(
  stream: AsyncIterable<llm.ChatChunk | string>,
): AsyncGenerator<llm.ChatChunk | string> {
  let held = '';
  let passing = false;
  for await (const chunk of stream) {
    if (passing) {                      // ③ 판단이 끝난 뒤: 그대로 통과
      yield chunk;
      continue;
    }
    const text = typeof chunk === 'string' ? chunk : chunk.delta?.content;
    if (!text) {                        // 글이 없는 청크 (도구 호출, 사용량)
      if (typeof chunk !== 'string' && chunk.delta?.toolCalls?.length && held) {
        yield stripLeadingAck(held);    //   도구 호출이 오면 모아 둔 글을 먼저 내보내고 통과 모드로
        held = '';
        passing = true;
      }
      yield chunk;
      continue;
    }
    held += text;                       // ① 글 조각 모으기
    if (held.length >= HOLD_CHARS) {    // ② 12자 이상 모이면 한 번 판단
      yield stripLeadingAck(held);
      held = '';
      passing = true;
    }
  }
  if (held) yield stripLeadingAck(held);   // ④ 스트림이 12자 전에 끝나면 남은 것 판단 (flush 역할)
}
```

### 상태 기계로 보기

```text
          글 조각 (누적 < 12자)
          ┌──────┐
          ▼      │
     ┌─────────┐ │           12자 이상 / 도구 호출
 ──▶ │ 모으는 중 │─┴──────────────────────────────▶ ┌─────────┐
     └─────────┘     stripLeadingAck(held) 내보냄    │ 통과 중  │──┐ 모든 청크
          │                                          └─────────┘◀─┘ 그대로
          │ 스트림 끝
          ▼
     stripLeadingAck(held) 내보냄
```

### 설계 포인트

- **입력 타입이 둘**입니다. LLM 노드는 글(`string`)이나 `ChatChunk`(글 조각, 도구 호출, 사용량)를 내보낼 수 있으므로 둘 다 처리합니다.
- **모은 글은 `string`으로 내보냅니다.** 원래 `ChatChunk`였던 조각들이 하나의 문자열로 바뀌지만, 노드 출력은 둘 다 허용하므로 문제없습니다.
- **글 없는 청크는 기다리지 않고 바로 내보냅니다.** 사용량 청크가 모아 둔 글보다 먼저 나갈 수 있지만, 사용량은 순서와 무관하므로 괜찮습니다.
- **도구 호출이 오면 모아 둔 글을 먼저** 내보냅니다. "잠시만요, 확인해 볼게요" 같은 글 다음에 도구 호출이 오는 순서를 지키기 위해서입니다. 지금은 도구가 없지만 미리 대비한 코드입니다.
- **왜 12자인가.** 실측에서 나온 겹친 맞장구 중 가장 긴 것이 "네, 감사합니다. "(공백 포함 10자)입니다([src/ack.test.ts](../../src/ack.test.ts)의 "실측에서 나온 첫머리 맞장구", [5장 PoC 기록](../5-poc-results.md)). 이것을 덮으면서 보류 지연은 토큰 몇 개 수준으로 짧게 잡은 값입니다(지연을 ms로 잰 것은 11-7절 깊이 보기 "12자 보류의 값"). (2026-11-06 갱신) 처음에는 "떼야 할 맞장구 중 가장 긴 조합이 10자 안팎"이라고 적었는데, 정규식이 실제로 떼는 조합은 더 깁니다. 긴 맞장구 셋(`감사합니다`·`알겠습니다`·`그렇군요`) 중 둘이 겹치면 "알겠습니다. 감사합니다. "처럼 **14자**가 됩니다. 이때는 조각이 어떻게 나뉘었느냐에 따라 맞장구가 떼어지지 않습니다. 12-7절 깊이 보기에서 분할을 전부 넣어 찾은 사례입니다. 모델이 실제로 이런 답을 내는지는 재지 않았습니다.
- **길이 단위.** JavaScript의 `length`는 UTF-16 코드 단위 수입니다. 한글 음절은 한 단위라 "글자 수"와 같지만, 이모지는 두 단위입니다. 여기서는 영향이 없습니다(자르지 않고 길이만 재므로, 12-5절 깊이 보기의 끝 문단).

### stripLeadingAck의 정규식

```ts
const LEADING_ACK =
  /^\s*(?:(?:네네|네|예|아|음)(?=[\s,.!?~]|$)|감사합니다|알겠습니다|그렇군요)[\s,.!?~]*/;

export function stripLeadingAck(text: string): string {
  let out = text;
  for (let i = 0; i < 2; i++) {              // 최대 두 번: "네, 감사합니다. …"
    const next = out.replace(LEADING_ACK, '');
    if (next === out) break;
    out = next;
  }
  return out.trim() ? out : text;            // 다 지우면 아무것도 안 남으면 원문 유지
}
```

| 부분 | 의미 | 지키는 것 |
| --- | --- | --- |
| `^\s*` | 맨 앞에서만 | 문장 중간의 "네"는 건드리지 않음 |
| `네네\|네` 순서 | 긴 것부터 | "네네"를 "네" + "네"로 나눠 먹지 않음 |
| `(?=[\s,.!?~]\|$)` | **앞보기**: 바로 뒤가 공백·구두점·끝일 때만 | "**네**일 아트", "**아**니요", "**예**산은" 보호 |
| `감사합니다\|알겠습니다\|그렇군요` | 앞보기 없음 | 이 단어들 뒤에 바로 글자가 붙는 경우가 드물어서 |
| `[\s,.!?~]*` | 뒤따르는 구두점·공백까지 함께 제거 | "네, " 전체 제거 |
| 두 번 반복 | 맞장구가 겹친 경우 | "네, 감사합니다. 도입은…" → "도입은…" |
| 빈 결과면 원문 | 답 전체가 맞장구인 경우 | "네, 감사합니다."만 있는 마무리 인사는 살림 |

테스트가 이 표의 각 줄을 확인합니다(`src/ack.test.ts`). "맞장구가 아닌 말은 건드리지 않는다"의 "아니요, 그건 아니에요", "예산은 어느 정도세요?", "네일 아트용인가요?"는 앞보기 조건이 없으면 깨지는 사례입니다.

### 정규식 상식: 전역 플래그의 함정

이 정규식에는 `g` 플래그가 없고, `replace`로만 씁니다. 반면 6장·10장의 보정·발음 정규식은 `g` 플래그를 쓰는데, 역시 `replace`로만 씁니다. 이것이 안전한 이유가 있습니다. **`g` 플래그가 붙은 정규식 객체는 `lastIndex`라는 상태를 가지므로**, 같은 객체로 `.test()`나 `.exec()`를 반복 호출하면 이전 호출 위치부터 검색해 엉뚱한 결과가 나옵니다. 모듈 상수로 만든 `g` 정규식을 `.test()`에 쓰는 것은 유명한 버그 패턴입니다. `String.prototype.replace`는 `g` 정규식의 `lastIndex`를 0에서 시작하고 끝나면 되돌리므로 안전합니다.

---

## 12-7. 스트림 코드를 테스트하는 법

스트림 변환은 **조각을 나누는 방법을 바꿔 가며** 테스트해야 합니다.

```ts
// src/ack.test.ts — 비동기 제너레이터로 가짜 입력을 만듦
async function collect(chunks: string[]): Promise<string> {
  async function* source() {
    yield* chunks;
  }
  let out = '';
  for await (const part of withoutLeadingAck(source())) out += part as string;
  return out;
}

it('토큰으로 나뉘어 와도 첫머리 맞장구만 뗀다', async () => {
  expect(await collect(['네', ', ', '예산', '은 어느', ' 정도', ' 생각하세요?'])).toBe(
    '예산은 어느 정도 생각하세요?',
  );
});
```

```ts
// src/pronunciation.test.ts — ReadableStream.from으로 가짜 입력을 만듦
async function run(chunks: string[]): Promise<string> {
  const input = ReadableStream.from(chunks);
  let out = '';
  for await (const part of pronunciationTransform(input)) out += part;
  return out;
}
```

좋은 테스트 사례를 고르는 기준:

| 사례 | 확인하는 것 |
| --- | --- |
| 단어 중간에서 끊긴 조각 (`'F'`, `'2 울'`) | 경계 처리 |
| 보류 기준보다 짧게 끝나는 입력 (`['네', '.']`) | 끝에서 비우기(flush) |
| 처리 대상이 없는 입력 | 원문 보존 |
| 처리 대상과 비슷하지만 다른 입력 ("네일", "F20") | 오탐 방지 |
| 한 조각에 전부 들어 있는 입력 | 기본 동작 |

### 한 걸음 더: 속성 기반 테스트 (2026-11-06 추가, 제목만)

더 나아가면 **같은 입력을 무작위로 쪼개 여러 번 넣고 결과가 항상 같은지** 보는 속성 기반 테스트(property-based testing)도 있습니다. 12-5절의 불변식(이어 붙인 출력 = 전체 변환)을 자동으로 검사하는 방법입니다. 지금 프로젝트에는 없지만 스트림 변환이 늘어나면 고려할 만합니다. (2026-11-06 갱신) 아래 깊이 보기에서 실제로 해 보니, 손으로 고른 사례가 놓친 실패가 하나 나왔습니다.

#### 깊이 보기: 분할을 전부 넣어 보기 — 전수 검사와 시드 고정 무작위 분할 (2026-11-06 추가)

**경우의 수.** n글자 입력에는 글자 사이 자리가 n − 1곳 있고, 각 자리마다 "자른다/안 자른다" 두 가지이므로 나누는 방법은 2^(n−1)가지입니다. 7글자("네, 예산은?")면 분할점 6곳, 2^6 = 64가지입니다. 12글자면 2,048가지, 19글자면 262,144가지입니다. 스트림 변환 하나를 한 번 돌리는 데 수 µs이므로 20글자 안팎까지는 **전부** 넣어 볼 수 있습니다. [lab/12-split-property.mjs](lab/12-split-property.mjs)에서 19글자 전수 검사가 약 1.0초(1,014ms)였습니다(실측).

**지금의 테스트와 비교.** [src/ack.test.ts](../../src/ack.test.ts)의 스트림 테스트는 2개, [src/pronunciation.test.ts](../../src/pronunciation.test.ts)는 2개이고, 각각 **분할 하나**를 손으로 골라 넣습니다(`['네', ', ', '예산', …]`, `['F', '2 울', …]`). 고른 분할은 "단어 중간에서 끊김"처럼 아는 위험을 겨냥하므로 읽기 쉽고 의도가 분명합니다. 반면 성질 검사는 "어떻게 나눠도 `출력.join('') === 변환(입력)`"이라는 불변식 하나를 모든(또는 많은) 분할에 대 봅니다. 모르는 위험을 찾는 쪽입니다. 둘은 대신하는 관계가 아니라 같이 쓰는 관계입니다.

**실측: 검사기가 무엇을 잡나.**

```text
withoutLeadingAck  "네, 예산은?": 7글자, 분할점 6곳, 64가지 중 실패 0
pronunciationTransform "F2 울트라": 6글자, 분할점 5곳, 32가지 중 실패 0
flush를 뺀 판            "F2 울트라": 6글자, 분할점 5곳, 32가지 중 실패 32
  첫 실패 ["F2 울트라"] → "에프투 "
pronunciationTransform "xTool F2 쓰세요": 12글자, 분할점 11곳, 2,048가지 중 실패 0
flush를 뺀 판            "xTool F2 쓰세요": 12글자, 분할점 11곳, 2,048가지 중 실패 2,048
```

일부러 `flush`를 뺀 판(12-4절의 "가장 흔한 버그")은 모든 분할에서 잡힙니다. 실제 `pronunciationTransform`은 2,048가지 모두 통과합니다. 발음표 항목에 공백이 없고, 규칙의 둘러보기(`(?<![A-Za-z0-9])`)가 "공백 바로 뒤"와 "문자열 처음"을 똑같이 보기 때문입니다(10-6절).

**찾은 실패: 맞장구 두 개가 겹친 답.**

```text
입력 "알겠습니다. 감사합니다. 예산은요?" (19글자) → 한 번에 변환 "예산은요?"
시드 20261106, 무작위 분할 2,000번 중 실패 1,275번
["알겠습니다",". ","감사합니다",". ","예산은요?"] → "알겠습니다. 감사합니다. 예산은요?" 틀림
["알겠습니다. ","감사합니다. ","예산은요?"] → "알겠습니다. 감사합니다. 예산은요?" 틀림
전수: 19글자, 분할점 18곳, 262,144가지 중 실패 229,376
```

원인은 12-6절의 상태 기계에 있습니다. `withoutLeadingAck`는 누적이 **처음 12자 이상이 된 순간** 한 번만 판단하므로, 결과를 가르는 것은 그 순간의 길이 k 하나뿐입니다(실습 4번).

```text
k=12 보류 "알겠습니다. 감사합니다"     → 틀림
k=13 보류 "알겠습니다. 감사합니다."    → 틀림
k=14 보류 "알겠습니다. 감사합니다. "   → 틀림
k=15 보류 "알겠습니다. 감사합니다. 예"  → 맞음   (k=16~19도 맞음)
```

k = 12~14이면 보류한 글이 전부 맞장구라 `stripLeadingAck`가 지우고 나면 빈 글이 됩니다. 그러면 "다 지우면 원문 유지" 규칙(마무리 인사 "네, 감사합니다."를 살리려는 규칙)이 걸려 **맞장구를 하나도 떼지 않고** 통과 모드로 넘어갑니다. 12·13·14번째 글자 뒤 세 자리 중 한 곳이라도 잘리면 k가 그 안에 들어오므로, 실패 비율은 1 − (1/2)^3 = 7/8입니다. 전수 결과 229,376 / 262,144 = 0.875와 맞습니다. 단어·구두점 경계에서 자른 "토큰다운" 두 분할도 모두 틀렸습니다(실제 모델의 토큰 경계는 재지 않음). 반면 실측에서 나온 "네, 감사합니다. 도입은 언제쯤이세요?"는 맞장구가 10자라 k = 12~21 어디서도 틀리지 않습니다(실습 4번 끝 줄).

- 영향: 즉시 반응 "네네." 뒤에 "알겠습니다. 감사합니다. 예산은요?"가 그대로 나가고, 대화 기록에도 남습니다(11-7절). 이런 겹친 맞장구가 실제로 얼마나 나오는지는 재지 않았습니다.
- 고치는 방향(제안, 이 장에서는 코드를 바꾸지 않음): 보류를 "12자 이상"이 아니라 "떼고 나서 맞장구가 아닌 글이 남을 때까지(또는 상한까지)"로 바꾸거나, `HOLD_CHARS`를 두 맞장구의 최대 길이(맞장구 뒤 구두점·공백이 몇 개 붙느냐에 따라 15자 이상)보다 크게 잡습니다. 고친 뒤에는 위 입력을 테스트로 남깁니다.
- 구조를 알면 검사를 줄일 수 있다는 점도 보입니다. 26만 가지 분할이 결국 k 8가지로 모입니다. 속성 기반 테스트 도구(예: fast-check)는 실패를 찾으면 그것을 가장 작은 꼴로 줄여(shrinking) 보여 주는데, 위 k 표가 손으로 한 줄이기입니다.

**시드 고정 무작위 분할 예.** 전수 검사가 너무 커지는 긴 입력은 무작위로 나눕니다. 시드를 고정하면 실패한 분할을 다음에도 똑같이 다시 만들 수 있습니다. 이 레포에 넣는다면 이런 모양입니다(예시이며 이 레포에는 아직 없음, `collect`는 위 `ack.test.ts`의 것).

```ts
// 시드 고정 난수 (mulberry32): 같은 시드면 같은 수열
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function randomSplit(text: string, rand: () => number): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const ch of text) {            // 코드 포인트 단위라 서로게이트 쌍을 가르지 않음 (12-5절)
    cur += ch;
    if (rand() < 0.3) {
      parts.push(cur);
      cur = '';
    }
  }
  return cur ? [...parts, cur] : parts;
}
const TEXTS = ['네, 예산은 어느 정도세요?', '알겠습니다. 감사합니다. 예산은요?'];
it.each(TEXTS)('어떻게 쪼개도 한 번에 뗀 것과 같다: %s', async (text) => {
  const rand = mulberry32(20261106);
  for (let i = 0; i < 200; i++) {
    const parts = randomSplit(text, rand);
    expect(await collect(parts), JSON.stringify(parts)).toBe(stripLeadingAck(text));
  }
});
```

이 코드를 레포 밖 임시 파일에 두고 vitest 4.1.12로 돌려 보니 첫 입력은 통과하고, 두 번째 입력은 첫 분할 `["알","겠습니","다. 감","사합니","다. ","예산은요","?"]`에서 `expected '알겠습니다. 감사합니다. 예산은요?' to be '예산은요?'`로 실패했습니다(실측). 실습 스크립트와 같은 시드·같은 나누기 방식이라 실습 3번의 첫 실패와 같은 분할입니다. 실패 메시지에 분할(`JSON.stringify(parts)`)을 넣어 두면 어떤 조각에서 틀렸는지 바로 보입니다.

---

## 12-8. 취소의 전파: 끼어들면 사슬이 어떤 순서로 멈추나 (2026-11-06 추가)

고객이 끼어들면 세션은 하던 답을 버립니다. 언제 끼어들기로 판정하고 SpeechHandle이 어떻게 바뀌는지는 11장(11-2·11-3절)의 몫입니다. 이 절은 그 판정이 난 **다음**, 스트림 사슬에서 무엇이 어떤 순서로 멈추는지를 봅니다. 12-4절 깊이 보기의 표에서 본 그 사슬을 거꾸로 거슬러 올라가는 길입니다.

### 단계별 위치

| 순서 | 일어나는 일 | 코드 (확인) |
| --- | --- | --- |
| ① | 끼어들기가 확정되면 그 답의 `replyAbortController.abort()`, 작업들을 `cancelAndWait(tasks, 2000)` | `agents/voice/agent_activity.ts` 4035~4039(재생 전)·4310~4317(재생 중), 시한 `agents/voice/speech_handle.ts` 43 (11장) |
| ② | LLM 읽기 루프가 `ThrowsPromise.race([reader.read(), abortPromise])`에서 abort 쪽이 이겨 `break` → `finally` | `agents/voice/generation.ts` 741~750, 823 |
| ③ | `reader.releaseLock()` 뒤 `await llmStream.cancel()` | 같은 파일 869~870 |
| ④ | `toStream`의 `cancel`: `cancelled = true`, `void iterator.return(reason)` (**기다리지 않음**). 그래서 ③의 `await`는 곧바로 끝나고 생성 작업도 끝남 | `agents/utils.ts` 1470~1473 |
| ⑤ | `withoutLeadingAck.return()`이 불렸지만, 제너레이터가 상류를 `await`하는 중이면 요청이 **큐에서 기다림** | ECMA-262 비동기 제너레이터 규칙 (아래) |
| ⑥ | 상류 조각이 와서 제너레이터가 다음 `yield`에 닿으면 큐의 `return`이 처리됨 → `for await`가 상류(기본 `llmNode` 스트림)의 이터레이터 `return()`을 부름 → 그 스트림을 cancel | [src/ack.ts](../../src/ack.ts), WHATWG Streams의 async iterator `return` |
| ⑦ | 기본 `llmNode` 스트림의 `cancel` → `cleanup()` → `LLMStream.close()` → `abortController.abort()` → **`LLMStream`의 출력 큐만 닫힘**(`this.output.close(); this.closed = true;`, 주석 "TODO (AJS-37)") | `agents/voice/agent.ts` 570~575·588~590, `agents/llm/llm.ts` 221~225·505~507 |
| ⑧ | **멈추지 않는 것**: fetch, 곧 플러그인의 HTTP 응답 읽기. 요청에 `signal`을 넘기지 않으므로 사슬은 HTTP 앞에서 끊기고, 모델은 답을 끝까지 만들며 플러그인은 서버가 다 쓸 때까지 읽음 | `plugin/llm.ts` 358~361 (아래) |

### 실측: 가짜 서버로 사슬 전체를 돌리기

[lab/12-cancel.mjs](lab/12-cancel.mjs) 5번은 이 레포의 실제 부품을 그대로 잇습니다. 127.0.0.1의 가짜 Anthropic 서버 → [VoiceAnthropicLLM](../../src/models/anthropic.ts) → `voice.Agent.default.llmNode`(SDK 코드) → `withoutLeadingAck` → `toStream` → `generation.ts`의 읽기 루프를 줄여 옮긴 것. 그리고 정해진 시각에 `abort()`합니다.

```text
== 통과 모드에서 끼어들기 (첫 조각 100ms, 이후 200ms 간격, 끼어들기 750ms) ==
   326ms  읽음: "예산은 어느 정도로 "
   527ms  읽음: "생각하세요? "
   730ms  읽음: "할부도 "
   755ms  끼어들기: replyAbortController.abort()
   755ms  finally: llmStream.cancel() 보냄
   756ms  withoutLeadingAck.return() 호출 (toStream의 cancel이 부름)
   756ms  finally: llmStream.cancel() 끝남 → 생성 작업 끝
   932ms  LLMStream.close() (기본 llmNode 스트림의 cancel → abortController.abort)
   932ms  withoutLeadingAck.return() 끝남 (for await가 상류 return()을 부른 뒤)
  1332ms  서버: 조각 7개를 끝까지 쓰고 응답을 마침

== 첫 글 전에 끼어들기 (첫 조각 800ms, 이후 150ms 간격, 끼어들기 300ms) ==
   302ms  끼어들기: replyAbortController.abort()
   303ms  finally: llmStream.cancel() 보냄
   303ms  withoutLeadingAck.return() 호출 (toStream의 cancel이 부름)
   303ms  finally: llmStream.cancel() 끝남 → 생성 작업 끝
  1117ms  LLMStream.close() (기본 llmNode 스트림의 cancel → abortController.abort)
  1117ms  withoutLeadingAck.return() 끝남 (for await가 상류 return()을 부른 뒤)
  1576ms  서버: 조각 6개를 끝까지 쓰고 응답을 마침
```

- 생성 작업은 끼어든 그 ms 안에 끝납니다(①~④). 고객 귀에 더 나갈 글은 여기서 끊깁니다.
- 그 위의 상류는 **다음 조각이 올 때까지** 돕니다. 통과 모드에서는 다음 조각이 올 때까지 177ms였습니다.
- 첫 글 전에 끼어들면 훨씬 깁니다. `withoutLeadingAck`는 12자가 모이기 전에는 `yield`하지 않으므로, 첫 조각(800ms)과 그 뒤 두 조각이 와서 "네, 알겠습니다. 예산"(12자)이 모인 1117ms에야 `return`이 처리됐습니다. 끼어든 뒤 **815ms**입니다.
- 두 경우 모두 서버는 응답을 **끝까지** 썼고, 클라이언트가 연결을 끊었다는 기록(`res`의 `close`가 `finish`보다 먼저)은 없었습니다.

### 함정 1: 비동기 제너레이터는 `await` 중에 받은 `return()`을 미룬다

비동기 제너레이터는 받은 요청(`next`·`return`·`throw`)을 큐에 넣고 하나씩 처리합니다. 몸통이 `await`로 멈춰 있는 동안(상태 executing) 들어온 `return()`은 큐에서 기다리다가, 몸통이 다음 `yield`에 닿아 앞선 `next()`를 채운 직후에 처리됩니다(ECMA-262의 `AsyncGenerator.prototype.return`, `AsyncGeneratorEnqueue`, `AsyncGeneratorYield`). 바깥에서 `await`를 깨울 방법은 없습니다. [lab/12-cancel.mjs](lab/12-cancel.mjs) 1번이 300ms마다 조각을 내는 상류로 확인합니다(실측).

```text
1-A. yield에서 멈춰 있을 때 return()        1-B. 상류를 await하는 중에 return()
  302ms 상류: "네, " 내보냄                     50ms return() 보냄
  302ms next() → "네, "                        301ms 상류: "네, " 내보냄
  302ms return() 보냄                          302ms 걸려 있던 next() → "네, "   ← return을 보낸 뒤에도 값을 받음
  302ms   상류: finally                        302ms   상류: finally
  302ms   중간: finally                        302ms   중간: finally
  302ms return() 끝남                          302ms return() 끝남

1-C. withoutLeadingAck: 12자를 모으는 동안 return()
   53ms return() 보냄
  304ms 상류: "네, "   607ms 상류: "예산"   909ms 상류: "은 어느 정도"
  909ms 걸려 있던 next() → "예산은 어느 정도"
  909ms   상류: finally
  909ms return() 끝남
```

- `return()`을 받은 제너레이터의 `for await`는 상류의 `return()`을 부르고 **그것이 끝나기를 기다린 뒤** 자기 `finally`를 돕니다(1-A·1-B에서 상류 finally가 먼저). 취소는 이렇게 한 단계씩 위로 올라갑니다.
- `toStream`은 `start` 루프에서 값을 받자마자 다음 `next()`를 다시 걸어 둡니다. 그래서 cancel이 오는 순간 제너레이터는 **거의 언제나 상류를 `await`하는 중**이고, 1-B·1-C의 경우가 됩니다. 같은 제너레이터를 `ReadableStream.from`(당기기)으로 감싸면, 읽기 요청이 없을 때는 제너레이터가 `yield`에서 쉬고 있으므로 cancel이 즉시 처리됩니다(실습 2번).

```text
toStream으로 감싼 스트림            711ms cancel 보냄 → 711ms cancel 끝남 → 909ms 상류 finally (다음 조각 때)
ReadableStream.from으로 감싼 스트림 708ms cancel 보냄 → 709ms 상류 finally → 709ms cancel 끝남
```

  `ReadableStream.from`의 cancel은 `return()`이 끝날 때까지 **기다리고**, `toStream`의 cancel은 기다리지 않습니다. 기다리지 않는 쪽이 세션에는 안전합니다. 기다렸다면 첫 글 전 끼어들기에서 생성 작업이 815ms를 붙잡혔을 것이고, 상류가 몇 초 멈춰 있으면 `cancelAndWait`의 2초 시한(`Task cancellation timed out`)에 걸렸을 것입니다(코드에 비춘 해석, SDK 주석에 이유는 적혀 있지 않음).

### 함정 2: 끊긴 것은 JS 객체뿐, HTTP 요청은 계속된다

정확히 말하면 **`LLMStream`의 출력은 닫히지만 fetch는 계속됩니다.** ⑦에서 `LLMStream.close()`가 하는 일은 `abortController.abort()`이고, 이 신호를 듣는 것은 출력 큐를 닫는 리스너와 지표 루프(391~395)뿐입니다. 리스너 자체에도 임시 처리라는 주석이 붙어 있습니다.

```ts
// agents/llm/llm.ts 221~225
this.abortController.signal.addEventListener('abort', () => {
  // TODO (AJS-37) clean this up when we refactor with streams
  this.output.close();
  this.closed = true;
});
```

실제 요청을 보내는 플러그인 코드는 이렇습니다.

```ts
// plugin/llm.ts 358~361 (Anthropic 플러그인 1.9.5)
const stream = await this.#client.messages.create(this.#requestParams, {
  timeout: this.connOptions.timeoutMs,          // signal이 없음
});
for await (const event of stream) {             // abort를 검사하지 않고 끝까지 읽음
```

- SDK 0.33.1 자체는 취소를 지원합니다. `messages.create(…, { signal })`을 받으면 fetch를 끊고(`sdk/core.ts` 357), 소비자가 `for await`를 `break`해도 `finally`에서 `controller.abort()`를 부릅니다(`sdk/streaming.ts` 83~84). 플러그인이 둘 다 하지 않을 뿐입니다.
- LiveKit Inference LLM(`LLM_PROVIDER=livekit`)은 `signal: this.abortController.signal`을 넘기고 루프에서 `aborted`를 검사합니다(`agents/inference/llm.ts` 509~522). Anthropic 플러그인만 다릅니다. LiveKit의 GitHub `main`에 있는 Anthropic 플러그인도 같은 모양이었습니다(2026-11-06 확인).
- 이 레포의 기본값(`anthropic`)과 `bedrock`은 둘 다 이 플러그인을 쓰므로(`src/models/index.ts`) 둘 다 해당합니다.
- 11장 담당이 선제 생성 쪽에서 따로 잰 결과도 같습니다. [lab/11-preemptive.mjs](lab/11-preemptive.mjs)의 시나리오 H는 첫 글 조각을 받자마자 `LLMStream.close()`를 불렀는데, 가짜 서버는 글 조각 20/20개를 다 보냈고 응답은 1,055ms에 정상 종료했습니다(11-4절 깊이 보기 H). 이 장의 실습 5번(서버가 조각 7/7·6/6개를 끝까지 씀)과 합치면, 끼어들기든 선제 생성 취소든 취소 뒤에도 연결은 응답이 끝날 때까지 붙잡히고 모델은 답을 끝까지 생성합니다.
- 영향(추정): 끼어든 답도 모델이 끝까지 생성하므로 그만큼 출력 토큰이 과금되고, 다음 턴 요청과 잠깐 연결이 두 개가 됩니다. 음성 답은 짧아(수십 토큰) 비용은 작을 것으로 봅니다. 11장은 버려진 선제 생성 시도에서 같은 현상을 따로 재고 비용을 손 계산했습니다([11-4절 깊이 보기의 H](11-session-pipeline.md#깊이-보기-선제-생성의-상태-기계-2026-11-06-추가)). 고객에게 들리는 것에는 영향이 없습니다(④에서 이미 끊김). 서버가 연결이 끊긴 요청의 생성을 멈추는지, 과금이 어떻게 되는지는 이 실습으로 알 수 없습니다.

### 함정 3: `for await`의 `break`는 스트림을 cancel한다, cancel 처리기가 없으면 늦게 전해진다

- `ReadableStream`을 `for await`로 읽다 `break`하면 그 스트림이 **cancel**됩니다. 비동기 반복의 `return`이 `preventCancel`(기본 `false`)이 아니면 `reader.cancel()`을 부르기 때문입니다. 상류를 살려 두려면 `stream.values({ preventCancel: true })`로 읽습니다(실습 3번: 앞은 "원천 cancel 불림", 뒤는 "안 불림"). ⑥이 이 경로입니다.
- SDK의 글 변환(`filter_markdown`·`filter_emoji`)을 감싸는 `streamFromAsyncIterable`에는 `cancel` 처리기가 없습니다(`agents/voice/transcription/text_transforms.ts` 59~72). 이런 스트림을 cancel하면 스트림은 닫히지만 안쪽 루프는 모릅니다. 다음 조각이 와서 `enqueue`가 TypeError를 던질 때에야 루프가 멈추고, 그 안의 `readStream`은 상류를 cancel하지 않고 **잠금만 풉니다**(`agents/utils.ts` 1406~1441). 실습 4번(실측):

```text
   706ms  stream.cancel() 보냄
   706ms  stream.cancel() 끝남, 원천 잠김 true
   907ms    원천: 조각3 넣음           ← 다음 조각이 와서 enqueue가 실패
  1108ms  400ms 뒤 원천 잠김 false     ← 잠금만 풀림. 원천의 cancel은 끝내 불리지 않음
```

  TTS 쪽 글 통로의 원천은 `IdentityTransform`이라 잠금이 풀린 채 남아도 아무도 기다리지 않으므로 문제는 없습니다(코드에 비춘 해석).

### 정리: 취소의 지연은 어디서 생기나

| 층 | 멈추는 때 | 지연의 원인 |
| --- | --- | --- |
| 생성 작업(고객에게 가는 글) | 끼어든 즉시 | 없음 (`race` + 기다리지 않는 cancel) |
| `withoutLeadingAck`와 그 상류의 JS 스트림 | 다음 `yield` 때 | 비동기 제너레이터의 요청 큐 + `toStream`이 늘 `next()`를 걸어 둠. 보류 중이면 12자가 모일 때까지 |
| `LLMStream`의 출력 큐 | 위와 같은 때 | 위에서 전해짐 |
| fetch (HTTP 응답) | 서버가 다 쓸 때 (사슬이 여기 앞에서 끊김) | 플러그인이 `signal`을 넘기지 않고, `close()`는 출력 쪽만 닫음 |

이 레포에서 고칠 수 있는 것은 둘째 줄입니다. 예를 들어 `withoutLeadingAck`가 상류의 `next()`를 기다릴 때 `generation.ts`처럼 취소 신호와 경주시키면 보류 중에도 바로 멈출 수 있습니다(제안, 이 장에서는 코드를 바꾸지 않음). 다만 고객에게 들리는 것은 이미 첫째 줄에서 끊기므로, 얻는 것은 자원 정리가 빨라지는 것뿐입니다. 넷째 줄은 플러그인의 문제라 LiveKit에 알릴 거리입니다.

---

## 12-9. 정리 (2026-11-06 갱신: 12-8에서 번호 이동)

| 개념 | 핵심 | 이 프로젝트 |
| --- | --- | --- |
| 이벤트 루프 | 스레드 하나. 동기 계산이 길면 다 멈춤 | 통화별 프로세스 분리의 이유 |
| fire-and-forget | 기다리지 않는 호출. 오류 처리 주의 | `say()` 두 번, 즉시 반응 |
| 비동기 제너레이터 | 멈췄다 이어지는 함수. 상태를 지역 변수로 | `withoutLeadingAck` |
| TransformStream | `transform` + `flush` | `pronunciationTransform` |
| 경계 문제 | 조각 경계 ≠ 의미 경계 | 보류 버퍼 네 가지 |
| 정확성 불변식 | 이어 붙인 출력 = 전체 변환 결과 | 쪼갠 입력 테스트 |
| 루프 단계와 두 큐 (2026-11-06 추가) | 콜백마다 nextTick → 마이크로태스크를 다 비움. 끝없는 `then`은 루프를 굶김 | 루프 감시의 지각에 그대로 잡힘 (4-4) |
| 처리 안 된 거부 (2026-11-06 추가) | Node 기본은 종료. 잡 프로세스는 debug 로그만 | 운영(info)에서 안 보임. `.catch()` 필수 |
| 역압 (2026-11-06 추가) | 협조 방식. 밀어내기 단계 하나에서 끊김 | `toStream`·기본 `llmNode`·`IdentityTransform` → LLM은 안 느려짐 |
| 바이트 경계 (2026-11-06 추가) | UTF-8 한 글자가 청크 사이에서 갈림 | SDK SSE는 구분자까지 모아 안전. `raw += chunk`는 함정 |
| 분할 전수 검사 (2026-11-06 추가) | 2^(n−1)가지. 20자 안팎은 전부 가능 | 겹친 맞장구 14자에서 `withoutLeadingAck` 실패 발견 |
| 취소의 전파 (2026-11-06 추가) | `return()`은 제너레이터의 다음 `yield`까지 미뤄짐 | 생성은 즉시 멈추나 상류는 다음 조각까지, HTTP는 끝까지 |

---

## 확인 문제

1. `onUserTurnCompleted`에서 즉시 반응 `say()`를 `await`하면 어떻게 됩니까?
2. TransformStream에서 `flush`를 빼먹으면 `pronunciationTransform`에 어떤 버그가 생깁니까?
3. `withoutLeadingAck`의 보류 길이를 3자로 줄이면 어떤 입력에서 실패합니까?
4. 발음표에 공백이 든 항목("F2 울트라" → "에프투울트라")을 추가하면 `pronunciationTransform`의 무엇이 깨집니까?
5. `LEADING_ACK`에서 `(?=[\s,.!?~]|$)`를 지우면 어떤 문장이 망가집니까? 두 개 이상 쓰세요.
6. `g` 플래그 정규식을 모듈 상수로 만들어 `.test()`에 반복해서 쓰면 왜 위험합니까?
7. (2026-11-06 추가, 실행 순서 맞히기) 아래 함수 `f`를 ⓐ `fs.readFile`의 콜백 안에서 바로 부를 때와 ⓑ 같은 콜백 안에서 `(async () => { await Promise.resolve(); f(); })()`로 부를 때, 출력 순서를 각각 쓰세요.

   ```js
   function f() {
     setTimeout(() => log('T'), 0);
     setImmediate(() => log('I'));
     Promise.resolve().then(() => log('P'));
     process.nextTick(() => log('N'));
     log('S');
   }
   ```

8. (2026-11-06 추가, 손 계산) ① "네, 감사합니다."(9글자)를 나누는 방법은 몇 가지입니까? ② "알겠습니다. 감사합니다. 예산은요?"(19글자)를 나누는 262,144가지 중 `withoutLeadingAck`가 틀리는 것은 몇 가지이고, 왜 그 수가 나옵니까?
9. (2026-11-06 추가) LLM의 첫 글이 오기 전(첫 토큰 대기 중)에 고객이 끼어들었습니다. 이 레포의 사슬에서 ㉠ 생성 작업, ㉡ `LLMStream.close()`, ㉢ Anthropic으로 가는 HTTP 응답은 각각 언제 멈춥니까? 첫 조각은 800ms 뒤에 오고, 그 뒤 150ms마다 "네, ", "알겠습니다. ", "예산", …이 온다고 합시다(끼어들기는 300ms).
10. (2026-11-06 추가) ① HTTP 본문의 "네"(EB 84 A4)가 첫 바이트 뒤에서 두 `data` 이벤트로 나뉘었습니다. `raw += chunk`로 모으면 U+FFFD가 몇 개 생깁니까? ② Anthropic SDK 0.33.1의 SSE 처리는 바이트를 `\n\n`까지 모은 뒤 디코드합니다. 이 방식이 글자 중간에서 자르지 않는다고 장담할 수 있는 이유는 무엇입니까?

<details>
<summary>답 보기</summary>

1. 즉시 반응 재생이 끝날 때까지 훅이 끝나지 않아, 본 답 생성 시작이 그만큼 늦어집니다. 즉시 반응을 둔 의미가 줄어듭니다.
2. 마지막 공백 뒤에 남은 조각(예: "이에요.")이 내보내지지 않아 답의 끝이 잘립니다.
3. 가장 흔한 "네, 예산은…"부터 실패합니다. 조각 "네"와 ", "가 모여 "네, "(3자)가 된 순간 판단하는데, 맞장구를 떼면 남는 글이 없어 원문을 그대로 내보내기 때문입니다. "네, 감사합니다. …"처럼 긴 맞장구도 일부만 보고 판단하게 됩니다.
4. 공백까지를 확정된 단어로 보고 내보내므로, "F2 "가 먼저 내보내지고 "울트라"는 다음 조각으로 넘어가 "F2 울트라"가 한 덩어리로 보이지 않습니다.
5. "아니요, 그건 아니에요" → "니요, …", "예산은 어느 정도세요?" → "산은 …", "네일 아트용인가요?" → "일 아트용인가요?"
6. `g` 정규식은 `lastIndex` 상태를 가져, 다음 `.test()`가 이전 일치 위치부터 검색하므로 같은 입력에도 결과가 번갈아 달라질 수 있습니다.
7. ⓐ S → N → P → I → T. 콜백이 끝나면 nextTick 큐, 마이크로태스크 큐 순으로 비우고, poll 다음은 check(`setImmediate`)이며 timers는 그 뒤입니다. ⓑ S → P → N → I → T. `await` 다음 줄은 이미 마이크로태스크를 비우는 중이라 새 `then`이 같은 비우기에서 먼저 돌고, nextTick은 그 뒤입니다. I와 T는 둘 다 poll 단계(파일 읽기 콜백) 안에서 걸었으므로 같은 바퀴의 check가 다음 timers보다 먼저입니다. `await`가 check 단계(setImmediate 콜백) 안에서 풀렸다면 I와 T의 순서는 보장되지 않습니다(12-2절 깊이 보기 실습 1·3).
8. ① 분할점 8곳, 2^8 = 256가지. ② 2^18 − 2^15 = 229,376가지. `withoutLeadingAck`는 누적이 처음 12자 이상이 된 길이 k에서 한 번 판단하는데, k가 12·13·14이면 보류한 글 전체가 맞장구라 지우면 빈 글이 되고 "원문 유지"가 걸려 아무것도 떼지 않습니다. 12·13·14번째 글자 뒤 세 자리를 하나도 자르지 않는 분할만 맞으므로 맞는 것은 2^18 × (1/2)^3 = 2^15 = 32,768가지입니다(12-7절 깊이 보기).
9. ㉠ 끼어든 즉시(약 300ms). 읽기 루프가 abort와 경주하고, `toStream`의 cancel이 `return()`을 기다리지 않기 때문입니다. ㉡ 12자가 모여 `withoutLeadingAck`가 처음 `yield`할 때. "네, "(800ms) + "알겠습니다. "(950ms) + "예산"(1,100ms)이 12자이므로 약 1.1초, 끼어든 뒤 약 0.8초입니다(실측 1,117ms). ㉢ 멈추지 않습니다. 플러그인이 `signal`을 넘기지 않아 서버가 답을 다 쓸 때까지 읽습니다(12-8절).
10. ① 3개. 첫 조각 끝의 `EB`가 하나, 다음 조각 앞의 `84`·`A4`가 하나씩입니다(12-5절 깊이 보기 실습 1). ② UTF-8에서 여러 바이트 글자의 바이트는 모두 0x80 이상이고, 구분자 `\n`(0x0A)은 한 바이트 ASCII라 글자 안에 나타날 수 없기 때문입니다. 구분자에서 자르면 늘 글자 경계입니다.

</details>
