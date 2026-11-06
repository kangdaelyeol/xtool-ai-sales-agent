# 11장. AgentSession 내부 — 한 턴이 흘러가는 길

5~10장에서 부품 하나하나를 봤습니다. 이 장은 그 부품들을 엮는 **지휘자 `AgentSession`**의 내부를 봅니다. 발화 대기열(speech queue)과 `SpeechHandle`, `say()`와 LLM 답의 차이, 선제 생성, `onUserTurnCompleted` 훅의 정확한 위치, 그리고 이 프로젝트의 **즉시 반응("네네") 기법**을 SDK 코드 수준에서 해부합니다.

> SDK 경로는 `node_modules/@livekit/agents/src/` 기준입니다. 핵심 파일은 `voice/agent_session.ts`, `voice/agent_activity.ts`(6천 줄이 넘는 세션의 심장), `voice/audio_recognition.ts`, `voice/generation.ts`입니다.

(2026-11-06 추가) 이 장의 실습 세 개는 키 없이 레포 루트에서 돕니다. SDK 자체 테스트(`voice/agent_activity.test.ts` 등)처럼 `AgentActivity`의 실제 메서드를 "가짜 `this`"(필요한 칸만 채운 객체의 프로토타입을 `AgentActivity.prototype`으로 바꾼 것)로 불러, 세션 없이 상태 전이만 재현합니다.

| 실습 | 보는 것 | 절 |
| --- | --- | --- |
| [lab/11-speech-queue.mjs](lab/11-speech-queue.mjs) | 대기열 힙, `mainTask` 루프, `SpeechHandle` 상태, `say()`와 LLM 답의 TTS 시작 시각 | 11-2 |
| [lab/11-preemptive.mjs](lab/11-preemptive.mjs) | STT 이벤트 → 선제 생성 → 재사용 검사, 취소된 시도의 요청 | 11-3, 11-4 |
| [lab/11-ack-hold.mjs](lab/11-ack-hold.mjs) | 첫머리 맞장구 보류(12자)가 `llmNodeTtft`와 TTS 첫 글을 얼마나 늦추나 | 11-7 |

---

## 11-1. 세 개의 층: Session, Activity, Agent

```text
AgentSession          통화 하나에 하나. 입출력(RoomIO), 부품(STT·TTS·VAD·턴 감지), 이벤트, 대화 기록 전체
  └─ AgentActivity    "지금 활성화된 에이전트"의 실행 상태. 발화 대기열, 턴 처리, 끼어들기
       └─ Agent       지시문, LLM, 도구, 훅(onUserTurnCompleted, llmNode…)  ← 우리가 정의하는 부분
```

이 프로젝트에는 에이전트가 하나뿐이지만, 핸드오프(9장)를 쓰면 Activity가 바뀌면서 Agent가 교체됩니다. 세션(통화)과 대화 기록은 그대로 이어집니다. LLM을 세션이 아니라 에이전트에 준 이유가 이것입니다(4장).

---

## 11-2. 발화 대기열과 SpeechHandle

에이전트가 "말할 것"은 모두 **SpeechHandle**이라는 객체로 표현되어 하나의 대기열에 들어갑니다.

| 말의 출처 | 만드는 곳 |
| --- | --- |
| 고정 문장 | `session.say(text)` |
| LLM 답 | 턴 확정 후 세션이 자동으로 `generateReply` |
| 직접 요청한 LLM 답 | `session.generateReply({ instructions })` |

### 대기열 규칙

- 우선순위: LOW 0, NORMAL 5, HIGH 10. `say()`와 `generateReply()`는 모두 **NORMAL**입니다.
- **우선순위가 높은 순, 같으면 먼저 들어온 순**입니다.
- 메인 루프는 **한 번에 하나씩**만 재생을 허가합니다. 앞 발화의 재생이 끝나야 다음 발화가 허가를 받습니다.

### SpeechHandle이 들고 있는 것

| 속성 | 의미 |
| --- | --- |
| `allowInterruptions` | 고객이 끊을 수 있나. 지정하지 않으면 세션 설정(`interruption.enabled`, 기본 true)을 따름 |
| `addToChatCtx` (`say` 옵션) | 다 말한 뒤 대화 기록에 assistant 메시지로 남길까 (기본 true) |
| 재생 허가 / 완료 / 중단 상태 | `await handle`로 끝날 때까지 기다릴 수 있음 |
| `interrupt(force?)` | 코드로 중단. 끼어들 수 없는 발화는 `force` 없이 부르면 예외 |

### 첫 멘트 두 개는 이렇게 흘러간다

```ts
session.say(openingNotice(call), { allowInterruptions: false });  // ① 고지
session.say(OPENING_QUESTION, { allowInterruptions: true });      // ② 질문
```

```text
① 고지: 대기열에 들어감 → 바로 재생 허가 → 이때 TTS 시작 → 재생
② 질문: 대기열에서 대기 ……………………………………………………→ ① 재생 끝 → 재생 허가 → 이때 TTS 시작 → 재생
                                                               └── 이 사이에 TTS 첫 음성만큼 공백
```

`say()`의 TTS는 **재생 허가를 받은 뒤에야** 시작합니다(`voice/agent_activity.ts`의 `ttsTask`). 그래서 고지와 질문 사이에 ElevenLabs 첫 음성 시간(약 0.17초 + 연결 상태에 따라 더)만큼 틈이 생깁니다. 두 문장을 굳이 나눈 것은 끼어들기를 따로 제어하기 위해서였고(7-6절), 이 짧은 틈은 그 대가입니다. 자연스러운 숨 정도로 들리면 괜찮고, 어색하면 측정 후 조정합니다.

또 질문(②)은 끼어들 수 있는 발화라서, 재생 전에 **고객이 조용해질 때까지(userSilenceEvent)** 기다립니다. 고객이 고지 직후 말하고 있으면 질문이 잠깐 보류됩니다.

(2026-11-06 갱신) 더 정확히는 **재생 허가와 "고객 조용함"을 함께** 기다리고, 둘 다 된 뒤에야 TTS를 시작합니다(`agent_activity.ts` 3601~3605). "조용함"은 VAD의 마지막 말소리 창 뒤 192ms에 켜집니다([7-5절](07-turn-taking.md#다시-말하기-전에-고객이-조용한지-본다-2026-11-06-추가)). 그래서 고객이 고지 위에 말하고 있었다면 질문의 첫 소리는 "고지 끝"이 아니라 "고객 말 끝 + 192ms + TTS 첫 음성"입니다(아래 깊이 보기의 실습 2-2). 끼어들 수 없는 고지는 조용함을 기다리지 않습니다.

#### 깊이 보기: 힙, mainTask 루프, SpeechHandle의 상태 (2026-11-06 추가)

직접 돌려 보기: [lab/11-speech-queue.mjs](lab/11-speech-queue.mjs) (약 11초). `scheduleSpeech`와 `mainTask`는 SDK 코드 그대로이고, 발화마다 도는 작업(`ttsTask`, `pipelineReplyTask`)은 부품이 너무 많아 **기다리는 순서만 SDK와 같게 옮긴 짧은 함수**로 대신했습니다. TTS 첫 음성은 13장의 0.17초, 재생 길이는 짧게 줄인 가정 값입니다.

**① 대기열은 힙입니다 (코드).** **힙(heap)**은 "지금 가장 앞인 원소"를 늘 맨 위에 두는 이진 트리이고, 배열 하나로 구현합니다. 넣기와 꺼내기가 원소 n개에 대해 O(log n)이라, 전부 정렬해 두는 것보다 쌉니다. SDK는 `heap-js` 라이브러리의 힙에 `[우선순위, 시각, SpeechHandle]` 세 칸짜리 항목을 넣습니다(`agent_activity.ts` 548·656~658).

```ts
// 비교 함수: 음수면 a가 앞. 우선순위가 다르면 큰 쪽이, 같으면 시각이 이른 쪽이 앞
([p1, t1], [p2, t2]) => (p1 === p2 ? t1 - t2 : p2 - p1)
// scheduleSpeech (5444~5468): 넣고, "대기열에 들어감" 표시, 루프 깨우기
this.speechQueue.push([priority, Number(process.hrtime.bigint()), speechHandle]);
speechHandle._markScheduled();
this.wakeupMainTask();
```

시각을 `Date.now()`가 아니라 `process.hrtime.bigint()`로 찍는 이유는 둘입니다. `Date.now()`는 ms 단위라 같은 ms에 두 발화가 들어오면 순서를 가를 수 없고, 벽시계라서 시간 동기화(NTP)로 뒤로 갈 수도 있습니다. hrtime은 나노초 단위의 **단조 시계**(monotonic clock, 컴퓨터가 켜진 뒤 늘기만 하는 시계)입니다. 코드 주석도 "Monotonic time to avoid near 0 collisions"라고 적습니다. `Number`로 바꾸면 2^53ns(약 104.2일)까지는 나노초가 정확합니다.

```text
1) scheduleSpeech가 힙에 넣는 [우선순위, hrtime]과 꺼내는 순서
     고지 say()               우선순위  5  hrtime +0ns
     질문 say()               우선순위  5  hrtime +81667ns
     (가정) LOW 안내          우선순위  0  hrtime +120834ns
     (가정) HIGH 긴급 안내    우선순위 10  hrtime +128750ns
     즉시 반응 say()          우선순위  5  hrtime +135584ns
   꺼내는 순서: (가정) HIGH 긴급 안내 → 고지 say() → 질문 say() → 즉시 반응 say() → (가정) LOW 안내
```

**② mainTask 루프 (코드, `agent_activity.ts` 2919~2988).**

```text
반복:
  깨우기 신호(q_updated)를 기다림                       ← scheduleSpeech, 발화 작업 끝이 깨움
  대기열이 빌 때까지:
    h = 힙에서 꺼냄
    재생 허가가 잠시 멈춤(_authorizationPaused)이면 → 다시 넣고 멈춤
    h가 이미 중단됐거나 끝났으면 → 허가 없이 건너뜀 (2949~2952)
    _currentSpeech = h; h._authorizeGeneration()        ← 재생 허가
    (h의 이번 생성이 끝남) 또는 (h가 중단됨)을 기다림
    중단됐는데 작업이 남아 있으면 → 그 생성이 끝날 때까지 더 기다림 (2959~2961)
    _currentSpeech = undefined
```

- **재생 허가(authorization)**는 루프가 발화에게 "이제 네 차례, 소리를 내보내도 된다"고 알리는 신호입니다. 코드로는 `_authorizeGeneration()`이 **Future**(나중에 값이 채워지는 약속 객체. 보통의 Promise와 달리 `resolve()`를 바깥에서 부를 수 있음, `utils.ts`) 하나를 "생성(generation)" 목록에 넣고, **Event**(asyncio의 Event를 흉내 낸 켜고 끄는 신호. `set()`·`clear()`·`wait()`)를 켭니다(`speech_handle.ts` 557~563). 발화 작업은 그 Event를 기다렸다가 출력을 시작하고, 끝나면 그 Future를 채웁니다. 도구 호출 뒤의 답처럼 한 발화가 여러 단계로 말하면 생성이 하나씩 늘어납니다.
- 루프는 **허가 하나 → 그 생성의 끝**을 기다리므로, 소리가 겹쳐 나가는 일이 없습니다. 오디오 출력이 하나이기 때문입니다.
- 끊긴 발화라도 정리 작업이 남아 있으면 그것이 끝날 때까지 다음 허가를 미룹니다. 정리 중의 출력(버퍼 비우기, 대화 기록 넣기)도 한 줄로 세우려는 것입니다.

**③ say()와 LLM 답은 TTS를 시작하는 때가 다릅니다 (코드).**

| | 기다리는 것 | TTS 시작 | 근거 |
| --- | --- | --- | --- |
| `say(text)` | 재생 허가 + (끼어들 수 있으면) 조용함 | **둘 다 된 뒤** | `ttsTask` 3601~3605 → 그 뒤 `performTTSInference` |
| `say(text, { audio })` | 같음 | 없음 (받은 소리를 바로 내보냄) | 3691~3701 |
| LLM 답 (`generateReply`) | 대기열에 들어감 → (TTS 시작) → 재생 허가 + 조용함 | **대기열에 들어가자마자**, 첫 글이 오는 대로 | `pipelineReplyTask` 4023·4042~4049·4053~4057 |

LLM은 그보다 앞서, 답을 만드는 순간(선제 생성이면 턴 확정 전) 시작합니다. 실습 2번이 이 차이를 시각으로 보여 줍니다(실측, 실행마다 몇 ms 다름).

```text
2-1. 첫 멘트 두 개: 고지(끼어들 수 없음, 800ms) → 질문(끼어들 수 있음, 그때 합성)
     0ms  고지: 재생 허가 → 이제 TTS 시작
   172ms  고지: 첫 소리
   974ms  고지: 재생 끝
   974ms  질문: 재생 허가 → 이제 TTS 시작
  1146ms  질문: 첫 소리                          ← 고지 끝과 질문 사이 172ms 틈

2-2. 같은 첫 멘트, 고객이 고지 위에 말하다가 1,100ms에 멈춤 (조용함은 그 192ms 뒤)
   973ms  고지: 재생 끝
  1296ms  고객 조용함 (userSilenceEvent 켜짐)
  1296ms  질문: 재생 허가 → 이제 TTS 시작        ← 허가는 973ms에 났지만 조용함을 같이 기다림
  1469ms  질문: 첫 소리

2-3. 턴 확정 뒤: 즉시 반응(미리 합성, 400ms) → 본 답(선제 생성 재사용이라 글이 이미 있음)
     2ms  본 답: 대기열에 들어감 → TTS 시작(첫 글이 오는 대로)
     2ms  즉시 반응: 재생 허가 (미리 합성한 소리, TTS 없음)
     2ms  즉시 반응: 첫 소리
   172ms  본 답: TTS 첫 음성 준비됨                ← 즉시 반응이 나가는 동안 미리 합성
   402ms  즉시 반응: 재생 끝
   402ms  본 답: 재생 허가
   402ms  본 답: 첫 소리                          ← 틈 없음

2-4. (비교) 본 답을 say()처럼 허가 뒤에 합성했다면
   403ms  본 답(가정): 재생 허가 → 이제 TTS 시작
   573ms  본 답(가정): 첫 소리                    ← 170ms 틈
```

- 2-1의 172ms가 위 "첫 멘트 두 개" 그림의 틈입니다.
- 2-3과 2-4의 차이(402 대 573ms)가 11-6절의 "비대칭"입니다. 본 답은 대기열에 들어가자마자 합성하므로 즉시 반응 뒤에 바로 이어지고, `say()`였다면 즉시 반응이 끝난 뒤에야 합성을 시작해 그만큼 틈이 생깁니다. 즉시 반응 자신도 `say()`라서 같은 문제를 겪으므로 **미리 합성해 `audio`로 넘깁니다**(2-3의 2ms 첫 소리, 13-5절 `AckAudioCache`).

**④ SpeechHandle의 상태 (코드 + 실측).**

```text
               scheduleSpeech            mainTask의 재생 허가          작업이 모두 끝남
  만듦 ──────────────────────▶ 대기열 ──────────────────────▶ 재생 중 ────────────────────▶ 끝(done)
   │  (scheduled=false)        (scheduled)                  (허가)
   │                              │                            │
   │ interrupt()                  │ interrupt()                │ interrupt()
   ▼                              ▼                            ▼
  중단(interrupted) ───── 작업이 신호를 보고 정리하고 끝냄 ─────▶ 끝(done)
                          5초 안에 안 끝나면 감시 타이머가 작업을 취소하고 끝으로 침
```

- `interrupt()`는 "중단" Future를 채우고 5초 감시 타이머(watchdog)를 겁니다(`speech_handle.ts` 391~403·499~542, `INTERRUPTION_TIMEOUT` 56). 끝(done)은 그 발화가 가진 작업이 모두 끝날 때 옵니다(`agent_activity.ts` 2686~2691).
- 끼어들 수 없는 발화에 `interrupt()`를 부르면 예외가 납니다. `interrupt(true)`(force)만 통합니다.
- **선제 생성의 시도는 대기열에 들어가지 않은 채** 만들어집니다(`scheduleSpeech: false`). 재사용되면 그때 대기열에 들어가고, 버려지면 `_cancel()`로 중단 → 끝입니다(11-4절).

```text
3) SpeechHandle 상태 (scheduled / 허가 / interrupted / done)
   만든 직후              scheduled=false 허가=false interrupted=false done=false
   scheduleSpeech 뒤      scheduled=true 허가=false interrupted=false done=false
   재생 허가 뒤           scheduled=true 허가=true interrupted=false done=false
   _markDone 뒤           scheduled=true 허가=true interrupted=false done=true
   끼어들 수 없는 발화 interrupt(): 예외 "This generation handle does not allow interruptions"

3-1. 대기 중에 중단된 발화: mainTask가 꺼내도 허가하지 않고 건너뜀
   103ms  B.interrupt() → scheduled=true 허가=false interrupted=true done=false
   453ms  A가 끝나고 mainTask가 B를 꺼낸 뒤 → B scheduled=true 허가=false interrupted=true done=true

3-2. 재생 중 중단했는데 작업이 신호를 무시하면: 감시 타이머가 5초 뒤 끝낸 것으로 침
     2ms  C: 재생 허가 (이 작업은 중단·취소 신호를 보지 않고 10초 동안 붙잡음)
   104ms  C.interrupt() → scheduled=true 허가=true interrupted=true done=false
  5108ms  C: done (감시 타이머) → scheduled=true 허가=true interrupted=true done=true
  5108ms  D (C 뒤 대기): 재생 허가 (미리 합성한 소리, TTS 없음)
```

3-2가 감시 타이머의 존재 이유입니다. 끊긴 발화의 작업이 정리를 못 하고 멈추면, ②의 "작업이 남아 있으면 더 기다림" 때문에 **그 뒤 모든 발화가 막힙니다.** SDK 주석은 이 타이머가 없으면 세션이 남은 통화 내내 조용해진다고 적습니다(#2065, `speech_handle.ts` 515~526). 5초는 그때 고객이 듣는 침묵의 상한입니다. 정상적인 작업은 중단 신호를 보고 곧 정리하므로 보통은 이 타이머까지 가지 않습니다(추정).

---

## 11-3. 한 턴의 전체 타임라인

고객이 "네 맞아요. 가죽 지갑에 각인하려고요."라고 말했을 때를 처음부터 끝까지 따라갑니다.

```text
[듣기]
 고객 소리 → RoomIO(24kHz) → 노이즈 제거 → ┬→ VAD (16kHz)
                                            ├→ 턴 감지 모델 (16kHz)
                                            ├→ (적응형 끼어들기 채널)
                                            └→ STT (Soniox, 16kHz)
 VAD START_OF_SPEECH → 사용자 'speaking'
 STT: INTERIM "네 맞아" … PREFLIGHT "네 맞아요." → ★선제 생성 시작 (11-4절)
 VAD END_OF_SPEECH(+256ms) → 'listening' → finalize, 턴 감지 예측 요청
     (말 끝 판정 시도 → 아직 FINAL 글이 없어 건너뜀)
 FINAL "네 맞아요. 가죽 지갑에 각인하려고요." → 글이 마지막 PREFLIGHT와 다르면 ★선제 생성 다시 시작
     → 말 끝 판정 시작 (이 프로젝트에서는 FINAL이 판정을 시작함, 7-4절)
 턴 감지: p ≥ 0.4 → 300ms 대기(대개 이미 지남) → 턴 확정
         p < 0.4 → 마지막 말소리 + 2,500ms까지 대기 (이 문장 끝은 실습에서 0.38~0.45로 기준 근처)

[턴 확정 처리: userTurnCompletedImpl]
 ① 선제 생성 재시도 횟수 초기화
 ② 지금 재생 중인 발화가 끼어들 수 없으면 → 경고 후 이 턴을 버림 (7-6절)
 ③ 대기 중인 발화들 중단, 재생 중인 발화 중단
 ④ 사용자 메시지(newMessage) 생성
 ⑤ ★ onUserTurnCompleted 훅 실행 (await) ← 이 프로젝트: 보정 + 즉시 반응 "네네."
 ⑥ 선제 생성 결과를 쓸 수 있는지 검사 → 쓰면 재사용, 아니면 새로 generateReply
 ⑦ 말 끝 판단 메트릭(EOUMetrics) 발행

[답하기]
 LLM 응답 발화가 대기열에 들어감 → 에이전트 상태 'thinking'
 대기열: [즉시 반응 "네네."] [LLM 답]  ← 같은 NORMAL, 먼저 들어온 즉시 반응이 앞
 즉시 반응: 재생 허가 → (미리 합성했으면 바로, 아니면 TTS 시작) → 재생 → 'speaking' → 끝 → 'listening'
 LLM 답:    (즉시 반응이 재생되는 동안 이미 LLM 생성 + TTS 합성 진행)
           재생 허가와 "고객 조용함"을 함께 기다림 → 재생 → 'speaking'
           llmNode(withoutLeadingAck) → ttsTextTransforms → TTS → 오디오 → 방
 재생 끝 → 대화 기록에 assistant 메시지 (끊겼으면 들은 데까지)
```

(2026-11-06 갱신) 처음 판은 "p ≥ 0.4 → 턴 확정"만 그렸습니다. 이 문장 끝 "…각인하려고요."는 7장 실습(합성 음성 `say -v Yuna`)에서 p가 0.38~0.45로 기준 0.4를 사이에 두고 갈렸습니다. 같은 소리라도 통화마다 300ms 대기와 2,500ms 대기로 나뉠 수 있다는 뜻입니다([7-4절 깊이 보기 "쉼 동안의 확률을 직접 그려 보기"](07-turn-taking.md#깊이-보기-쉼-동안의-확률을-직접-그려-보기-2026-11-06-추가)). 아래 ms 표는 확신하는 경우(p ≥ 0.4)입니다. 또 "재생 허가 → 고객이 조용한지 확인"이라고 차례로 그렸던 줄은, 실제로는 둘을 함께 기다립니다(11-2절 깊이 보기 ③).

#### 깊이 보기: 한 턴을 ms로, 세션 쪽에서 (2026-11-06 추가)

말 끝 판단까지는 [7-4절 깊이 보기 "한 턴을 ms로"](07-turn-taking.md#깊이-보기-한-턴을-ms로-2026-11-06-추가)가 이미 나눴습니다. 여기서는 같은 숫자를 이어받아 **턴 확정 뒤**(훅, 대기열, 즉시 반응, 재생 허가, 본 답)를 붙입니다. 시각은 마지막 말소리(`lastSpeakingTime`) = 0입니다. 7장 실습의 "FINAL 왕복 150ms 가정"(FINAL 406ms)을 그대로 쓰고, 나머지 가정 값은 표 아래에 적었습니다.

| 시각 | 일 | 세션에서 보는 곳 (메트릭·로그·이벤트) | 근거 |
| --- | --- | --- | --- |
| −150 | 마지막 PREFLIGHT(문장 전체) → 선제 시도 시작, **LLM 요청이 이때 나감** | info 로그 `starting preemptive generation`, `SpeechCreated`(source `generate_reply`) | 시각은 가정, 동작은 코드·실습 A |
| 0 | 마지막 말소리 | `EOUMetrics.lastSpeakingTimeMs` (절대 시각) | 7장 |
| +192 | 고객 조용함(`userSilenceEvent` 켜짐) | 이벤트 없음 | 7장 계산 |
| +256 | VAD 말 끝 → `listening` → finalize, 예측 요청, 판정 건너뜀 | `UserStateChanged`, debug `skipping EOU detection` | 7장 실측 |
| 약 +285 | `v1-mini` 예측 도착 | (`EotPrediction`은 판정이 예측을 쥘 때 나옴, 아래) | 7장 추정 |
| +406 | FINAL 도착 → 판정 시작 → p ≥ 0.4면 대기 0 → **턴 확정** | `transcriptionDelayMs` 406, `endOfUtteranceDelayMs` 406, `EotPrediction.delayMs` ≈ 406 | 7장 식 + 실습(아래) |
| +406 | 훅: 보정 + `say("네네.")` (기다리지 않음) | `onUserTurnCompletedDelayMs` ≈ 0 | 코드(정규식과 `say()` 호출뿐, 11-5절) |
| +406 | 재사용 검사 통과 → 선제 시도를 대기열에 넣음 | debug `using preemptive generation` `{ preemptiveLeadTime: 556 }` | 실습 A |
| 약 +406 | 즉시 반응: 재생 허가(앞에 재생 중인 것 없음) + 조용함(이미 켜짐) → 미리 합성한 소리 첫 프레임 | `AgentStateChanged` → `speaking`의 `createdAt` | 코드 + 11-2 실습 2-3 (추정: 수 ms) |
| +650 | 본 답 LLM 첫 토큰 (−150 + `ttftMs` 800) | `LLMMetrics.ttftMs` ≈ 800 (**선제 시도 시작부터** 잰 값) | PoC 값을 가정 |
| 약 +730~830 | 노드가 첫 글을 냄 (12자 보류 80~180ms) | 본 답 메시지의 `metrics.llmNodeTtft` ≈ 0.88~0.98초 | 11-7절 실습 |
| 약 +906 | 즉시 반응 끝 → `listening` | `AgentStateChanged` | "네네." 0.5초 가정 |
| 약 +950 | TTS가 첫 글을 받음 (두 문장 답은 LLM 스트림이 끝날 때) | 없음 (`ttfbMs`의 시작점) | 10-4절, 11-7절 실습 (답 30자, 100 tok/s 가정) |
| 약 +1,120 | 본 답 첫 음성 (`ttfbMs` 170) → 허가는 이미 받음 → **본 답 첫 소리** | `TTSMetrics.ttfbMs`, 메시지의 `ttsNodeTtfb`, `e2eLatency` ≈ 1.12초 | 13장 값을 가정 |

같은 턴을 식으로 쓰면 이렇습니다.

```text
턴 확정       = max(마지막 말소리 + 대기, 판정 시작(FINAL 도착), 예측 도착)                 (7-4절)
즉시 반응 첫 소리 ≈ 턴 확정 (+ TTS 첫 음성, 미리 합성이 안 됐을 때)
본 답 첫 소리 = max( 즉시 반응 끝,  LLM 시작 + ttftMs + 보류·문장 모으기 + ttfbMs )
  LLM 시작    = 재사용이면 선제 시도 시작 (= 턴 확정 − preemptiveLeadTime), 아니면 턴 확정
e2eLatency    = 본 답 첫 소리 − 마지막 말소리          ← 즉시 반응은 들어가지 않음
```

- **선제 생성을 못 쓴 턴**이면 LLM이 +406에 시작하므로 본 답 첫 소리는 약 +1,676(406 + 800 + 300 + 170)으로, `preemptiveLeadTime`(556ms)만큼 늦습니다. 선제 생성의 이득은 정확히 이 리드 타임입니다(단, 즉시 반응 끝보다 앞당길 수는 없음).
- **`e2eLatency`는 본 답의 첫 프레임 기준입니다**(코드). LLM 답 작업(`pipelineReplyTask`)만 이 값을 계산하고(`agent_activity.ts` 4290~4296), `say()`는 계산하지 않으며(3740~3764), 즉시 반응은 `addToChatCtx: false`라 메시지조차 남기지 않습니다. 즉시 반응의 첫 소리는 `AgentStateChanged`(`speaking`)의 `createdAt`에서 `EOUMetrics.lastSpeakingTimeMs`를 빼서 잽니다.
- **이 프로젝트에서는 `endOfUtteranceDelayMs` ≈ `transcriptionDelayMs`입니다.** 둘 다 마지막 말소리부터 재는데, 판정을 FINAL이 시작하고 확신하면 기다리지 않기 때문입니다. 둘의 차가 약 2,094ms(= 2,500 − 406)면 p < 기준으로 2.5초를 기다린 턴입니다. 사용자 메시지의 `metrics`에는 같은 값이 초 단위로 `endOfTurnDelay`, `transcriptionDelay`라는 이름으로 붙습니다(`agent_activity.ts` 3473~3487).
- `EotPrediction.delayMs`는 대기 시간이 아니라 **마지막 말소리부터 판정이 예측을 손에 쥔 순간까지**입니다(7-4절). 예측이 FINAL보다 먼저 와 있었으면(`fromCache`) 사실상 FINAL 도착 시각이라 위 표에서 약 406입니다.
- 가정 값: PREFLIGHT −150ms(Soniox가 언제 문장 전체를 확정하는지는 서버 동작이라 모름), LLM `ttftMs` 800ms와 TTS `ttfbMs` 170ms(5-poc-results), "네네." 길이 0.5초, 답 30자를 100 tok/s로 생성. 실측으로 바꿀 칸입니다.

[lab/11-preemptive.mjs](lab/11-preemptive.mjs)의 끝 줄은 위 +406 확정에서 세션이 실제로 낸 EOU 지표입니다(가상 시계라 훅 시간은 0).

```text
EOU 지표 (시나리오 A의 확정에서 세션이 낸 값, ms)
   endOfUtteranceDelayMs 406, transcriptionDelayMs 406, onUserTurnCompletedDelayMs 0
```

이제 별표(★) 붙은 부분을 하나씩 봅니다.

---

## 11-4. 선제 생성 (Preemptive Generation)

### 아이디어

7-1절에서 사람은 상대 말이 끝나기 전에 대답을 준비한다고 했습니다. 선제 생성은 그것을 흉내 냅니다. **턴이 확정되기 전에, 지금까지 확정된 글로 LLM을 미리 돌려 둡니다.** 턴이 확정되었을 때 고객 글이 그대로라면, 이미 만들어 둔 답을 바로 씁니다.

```text
선제 생성 없음:   [말 끝 판단 300ms+]──▶[LLM 첫 토큰 0.8초]──▶[TTS]
선제 생성 있음:   [말 끝 판단 300ms+]
                  [LLM 미리 시작 ─────────▶]──▶[TTS]      ← 겹친 만큼 이득
```

컴퓨터 구조의 **투기적 실행(speculative execution)**과 같은 생각입니다. CPU가 분기 결과를 기다리지 않고 예측한 쪽을 먼저 실행해 두었다가, 예측이 틀리면 결과를 버리는 것과 같습니다.

### 언제 시작하나

- Soniox가 **PREFLIGHT**(지금까지 들은 것이 모두 확정)를 보낼 때마다
- **FINAL**이 왔는데 내용이 PREFLIGHT와 다를 때

시작 조건: 기능이 켜져 있고, **지금 재생 중인 발화가 없고**, 이번 턴 시도 횟수가 `maxRetries`(기본 3) 미만이고, 고객이 말을 시작한 지 `maxSpeechDuration`(기본 10초) 이내일 때입니다. 긴 독백은 끝까지 바뀔 가능성이 크니 건너뜁니다.

(2026-11-06 갱신) 이전 선제 생성은 새 시도를 만들기 **전에**, 새 시도를 만들 수 있든 없든 취소합니다. 처음 판은 "새로 시작할 때마다 취소"라고 적어, 횟수를 다 쓴 뒤에도 마지막 결과가 남는 것처럼 읽혔습니다. 코드로 확인한 정확한 규칙은 이렇습니다.

- **PREFLIGHT는 글을 비교하지 않고 올 때마다** 선제 생성을 부릅니다(`audio_recognition.ts` 1418~1435). **FINAL은** 지금까지의 턴 글(`audioTranscript`)이 마지막 PREFLIGHT 글과 **문자열로 다를 때만** 부릅니다(1349·1360~1373). 여기서는 `transcriptsEquivalent`가 아니라 `!==`로 비교합니다.
- 부름을 받은 쪽(`onPreemptiveGeneration`, `agent_activity.ts` 2445~2508)은 **① 문 → ② 앞 시도 취소 → ③ 길이 → ④ 횟수 → ⑤ 새 시도** 순서로 갑니다. ①을 통과하면 **새 시도를 만들든 못 만들든 앞 시도부터 취소**하므로, 횟수를 다 쓴 뒤의 트리거는 마지막 남은 결과까지 지웁니다(아래 깊이 보기).
- ①의 "재생 중인 발화"는 `_currentSpeech`가 있고 **중단되지 않은** 것입니다. 끼어들기로 **일시정지된** 발화(7-5절)도 중단이 아니라서 여기에 걸립니다. ①에 걸리면 앞 시도도 그대로 둡니다.
- 횟수(`_preemptiveGenerationCount`)는 턴이 확정될 때만 0으로 돌아갑니다(3336). 말 시작 시각(`speechStartTime`)도 턴 단위라, 쉼을 두고 길게 이어 말하는 턴은 횟수와 10초를 함께 씁니다.

### 무엇을 미리 하나

- **LLM은 끝까지 미리 생성합니다.** 출력 버퍼에 쌓아 둡니다.
- **TTS는 기본적으로 미리 하지 않습니다**(`preemptiveTts: false`). 버려질 수 있는 합성에 비용을 쓰지 않기 위해서입니다. 켜면 더 빠르지만 낭비가 생깁니다.
- **도구 실행은 하지 않습니다.** 도구는 재생 허가 이후에 실행되므로, 버려질 예측이 예약을 잡거나 수신 거부를 등록하는 일은 없습니다. 투기적 실행에서 **부수 효과가 있는 일은 확정 후로 미루는** 원칙 그대로입니다.

(2026-11-06 추가) 코드 위치입니다. LLM 출력은 `IdentityTransform`(기준 크기를 `Number.MAX_SAFE_INTEGER`로 둔 사실상 무제한 큐, `stream/identity_transform.ts` 6~17)에 쌓이므로 아무도 읽지 않아도 생성이 멈추지 않습니다(역압이 걸리지 않는 이유는 12장). 시도의 작업은 `_waitForScheduled()`에서 멈춰 있다가(`agent_activity.ts` 4023), 재사용되어 대기열에 들어가야 TTS(4042~4049), 재생 허가(4053~4057), 도구 실행(4243)으로 갑니다. 대기열에 안 들어간 시도는 상태를 `thinking`으로 바꾸지도 않습니다(4051).

### 쓸지 버릴지 검사

턴 확정 후(⑥) 다음 네 가지가 모두 같아야 재사용합니다. (2026-11-06 갱신: 고객 글 칸을 고침, 나머지 칸에 방식을 더함)

| 비교 | 방식 |
| --- | --- |
| 고객 글 | 선제 시도의 글과 **훅이 고친 뒤**의 사용자 메시지 글(`rawTextContent`)을 `transcriptsEquivalent`로 비교. 구두점·대소문자·**공백 개수**는 무시. 태국 문자·가나·한자만 한 글자씩 비교하고, **한글은 그 범위에 없어 공백으로 자른 덩어리끼리** 비교 → 띄어쓰기 위치가 다르면 다른 글("방문 체험" ≠ "방문체험") |
| 대화 기록 | `chatCtx.isEquivalent`: 항목 수가 같고, 같은 자리 항목의 id·종류와 핵심 칸(메시지면 역할·`interrupted`·내용)이 같은가. 시각·메트릭은 안 봄(`llm/chat_context.ts` 761~776·1183~1207) |
| 도구 목록 | `ToolContext.equals`: 같은 도구들인가 |
| 도구 선택 설정 | `isSameToolChoice`: 같은가 |

처음 판의 "한중일 문자는 글자 단위 비교"는 틀렸습니다. 정규식(`agent_activity.ts` 210~228)에 한글 음절 범위(U+AC00~D7A3)가 없어서, 한국어는 영어처럼 공백 단위로 비교됩니다. 함수 해부와 실습은 [6-8절 깊이 보기](06-stt.md#깊이-보기-선제-생성-재사용-검사가-한국어를-비교하는-법-2026-11-06-추가)와 [lab/06-transcripts-equivalent.mjs](lab/06-transcripts-equivalent.mjs)에 있습니다. 결론만 옮기면, 이 프로젝트에서 재사용을 깨는 것은 **글을 바꾸는 코드 보정**이고, 공백 정리("방문 체험" → "방문체험")도 한국어에서는 글을 바꾸는 보정입니다.

### 이 프로젝트에서 주의할 점

1. **오인식 보정이 일어난 턴은 선제 결과를 버립니다.** 훅(⑤)에서 "메탈 백"을 "메탈팹"으로 고치면 고객 글이 달라져 재사용 검사에 실패하고 LLM을 처음부터 다시 부릅니다(6-8절). 보정을 `sttNode`로 옮기면 해결됩니다. (2026-11-06 추가) 대소문자만 바꾸는 보정("p3" → "P3")은 비교에서 무시되므로 재사용됩니다(아래 깊이 보기 E).
2. **시도 횟수가 빨리 소진될 수 있습니다.** PREFLIGHT는 글이 같은지 보지 않고 올 때마다 재시작하며 횟수를 셉니다. finalize로 FINAL도 늘어납니다. 한 턴에 3회를 먼저 다 써 버리면 최종 글로는 선제 생성을 못 합니다. 로그의 "starting preemptive generation" 횟수로 확인할 수 있습니다. (2026-11-06 갱신) 더 나쁜 점이 있습니다. 앞 시도 취소가 횟수 검사보다 **먼저**이므로, 3회를 다 쓴 뒤 4번째 트리거(대개 글이 바뀐 FINAL)가 오면 **3번째 시도의 결과까지 취소되고 새 시도는 생기지 않습니다.** 턴이 확정될 때 쓸 것이 하나도 없어, 선제 생성을 끈 것과 같은 시각에 LLM을 새로 부르면서 요청은 네 번 나갑니다(깊이 보기 B). 3이 아니라 4번째 트리거부터 손해라는 뜻입니다.
3. **즉시 반응이 재생 중이면 선제 생성을 하지 않습니다.** 고객이 연달아 말하는 경우에 해당합니다. (2026-11-06 갱신) 즉시 반응만이 아니라 **중단되지 않은 발화가 재생 중이면 모두**입니다. 고객이 본 답을 끊은 턴은 그 답이 "일시정지"(중단 아님) 상태라 PREFLIGHT가 와도 아무것도 하지 않고, 그 PREFLIGHT 글은 기록되므로 같은 글의 FINAL도 트리거가 되지 않습니다(깊이 보기 G). 끼어든 턴은 선제 생성의 이득을 거의 보지 못한다고 봐야 합니다(코드에서 따라간 추론).
4. **LLM 첫 토큰 메트릭이 달라 보입니다.** `LLMMetrics.ttftMs`는 LLM 스트림을 만든 시점부터 잽니다. 선제 생성이면 턴 확정 **전부터** 잰 값이고, 취소된 시도도 `cancelled: true`로 메트릭이 나옵니다. 통화 결과의 지연 기록은 이 값을 일부러 남깁니다(13-5절). (2026-11-06 추가) 취소된 시도의 요청은 끊기지 않고 **서버가 답을 끝까지 만듭니다**(깊이 보기 H). 시도 하나가 보통 턴 하나만큼의 비용입니다.

#### 깊이 보기: 선제 생성의 상태 기계 (2026-11-06 추가)

직접 돌려 보기: [lab/11-preemptive.mjs](lab/11-preemptive.mjs) (2초 남짓). STT 이벤트를 받는 `AudioRecognition.processSTTEvent`, `AgentActivity.onPreemptiveGeneration`, 턴 확정 뒤의 `userTurnCompleted`(재사용 검사 포함)는 **SDK 코드 그대로**이고, 훅은 이 프로젝트의 보정([src/transcript.ts](../../src/transcript.ts))을 씁니다. 바꾼 것은 둘입니다. `generateReply`를 "LLM 요청 1회"를 세는 가짜로 바꿨고, `Date.now`를 가상 시계로 바꿔 마지막 말소리를 0ms로 맞췄습니다. STT 이벤트의 시각과 글은 가정입니다.

```text
트리거: PREFLIGHT (늘), FINAL (턴 글 ≠ 마지막 PREFLIGHT 글일 때만)
  │
  ▼
① 문: 기능 꺼짐 · 스케줄 멈춤 · 새 턴 막힘 · 중단 안 된 발화가 재생 중 · LLM이 아님 ── 걸림 ──▶ 아무것도 안 함 (앞 시도 유지)
  │ 통과
  ▼
② 앞 시도가 있으면 취소 (_cancel('user_turn'))
  ▼
③ 말 시작부터 10초 넘음? ── 예 ──▶ 끝 (남은 시도 없음)
  ▼ 아니오
④ 이번 턴 시도 3회 다 씀? ── 예 ──▶ 끝 (남은 시도 없음)
  ▼ 아니오
⑤ 횟수 +1, 새 시도 = generateReply({ scheduleSpeech: false }) → LLM 요청 1회가 바로 나감

턴 확정 → 훅 → 남은 시도가 있나?
  ├ 없음 → 새 generateReply (LLM 요청 1회, 확정 시각에 시작)
  └ 있음 → 글·기록·도구·도구 선택이 같은가?
            ├ 같음 → 그 시도를 대기열에 넣음        debug "using preemptive generation" { preemptiveLeadTime }
            └ 다름 → 그 시도 취소, 새 generateReply  warn  "preemptive generation invalidated after `onUserTurnCompleted` …"
```

실행 결과입니다(실측, 가상 시계라 매번 같음). 마지막 말소리 = 0ms, FINAL = 406ms로 7장의 예와 맞췄습니다.

```text
A. 글이 자라다가 마지막 PREFLIGHT와 FINAL이 같은 턴 (가장 이득이 큰 경우)
    -1400ms  PREFLIGHT "네 맞아요."                             시도 1 시작
     -700ms  INTERIM   "네 맞아요. 가죽 지갑에"
     -150ms  PREFLIGHT "네 맞아요. 가죽 지갑에 각인하려고요."   시도 2 시작, 앞 시도 취소
      406ms  FINAL     "네 맞아요. 가죽 지갑에 각인하려고요."   선제 생성 안 부름 (FINAL 글 = 마지막 PREFLIGHT 글)
      406ms  턴 확정                                            선제 결과 재사용 (preemptiveLeadTime 556ms)
   → LLM 요청 2회 (선제 2, 취소 1). 답을 만드는 요청: -150ms에 시작

B. 같은 글의 PREFLIGHT가 세 번 온 뒤 FINAL 글이 다른 턴 (시도 소진)
     -500ms  PREFLIGHT "네 맞아요. 가죽 지갑에"                 시도 1 시작
     -400ms  PREFLIGHT "네 맞아요. 가죽 지갑에"                 시도 2 시작, 앞 시도 취소
     -300ms  PREFLIGHT "네 맞아요. 가죽 지갑에"                 시도 3 시작, 앞 시도 취소
      406ms  FINAL     "네 맞아요. 가죽 지갑에 각인하려고요."   새 시도 없음 (횟수 3/3 소진), 그런데 앞 시도는 취소됨
      406ms  턴 확정                                            쓸 선제 결과 없음 → 새 generateReply
   → LLM 요청 4회 (선제 3, 취소 3). 답을 만드는 요청: 406ms에 시작

C. 마지막 PREFLIGHT와 FINAL이 다른 턴 (FINAL이 새 시도를 띄움, 리드 타임 0)
    -1400ms  PREFLIGHT "네 맞아요."                             시도 1 시작
      406ms  FINAL     "네 맞아요. 가죽 지갑에 각인하려고요."   시도 2 시작, 앞 시도 취소
      406ms  턴 확정                                            선제 결과 재사용 (preemptiveLeadTime 0ms)
   → LLM 요청 2회 (선제 2, 취소 1). 답을 만드는 요청: 406ms에 시작

D. 훅의 보정이 글자를 바꾸는 턴 (메탈 백 → 메탈팹)
     -150ms  PREFLIGHT "메탈 백이랑 피쓰리도 보고 있어요."      시도 1 시작
      406ms  턴 확정                                            재사용 검사 실패 → 선제 결과 취소, 새 generateReply
   → LLM 요청 2회 (선제 1, 취소 1). 답을 만드는 요청: 406ms에 시작, 글 "메탈팹이랑 피쓰리도 보고 있어요."

E. 훅의 보정이 대소문자만 바꾸는 턴 (p3 → P3)
      406ms  턴 확정                                            선제 결과 재사용 (preemptiveLeadTime 556ms)
   요청에 실린 글 "p3도 보고 있어요." / 그 메시지 객체의 지금 글 "P3도 보고 있어요."

F. 말을 시작한 지 10초가 넘은 턴 (maxSpeechDuration)
    -1400ms  PREFLIGHT "그러니까 저희가 작년부터"               시도 1 시작
     -150ms  PREFLIGHT "그러니까 저희가 작년부터 가죽 공방을 하는데요." 새 시도 없음 (말 시작부터 10350ms > 10,000ms), 그런데 앞 시도는 취소됨
      406ms  턴 확정                                            쓸 선제 결과 없음 → 새 generateReply

G. 에이전트 발화가 재생 중(끼어들기로 일시정지 포함, 중단 아님)인 턴
     -300ms  PREFLIGHT "아니 잠깐만요."                         재생 중인 발화가 있어 아무것도 안 함 (앞 시도도 그대로)
      406ms  FINAL     "아니 잠깐만요."                         선제 생성 안 부름 (FINAL 글 = 마지막 PREFLIGHT 글)
```

(A·B·C 요약 줄 끝의 글, D·E·F의 일부 줄은 줄였습니다.)

읽을 점입니다.

- **이득은 "마지막 PREFLIGHT = FINAL"일 때만 납니다(A).** FINAL 글이 다르면 FINAL이 새 시도를 띄우는데, 확정이 FINAL과 거의 같은 순간이라 리드 타임이 0입니다(C). 그런데도 로그는 `using preemptive generation`이라 "재사용"으로 보입니다. 효과는 이 줄의 `preemptiveLeadTime`으로 봐야 합니다.
- **같은 글의 PREFLIGHT가 되풀이되면 소진이 빨라집니다(B).** Soniox 플러그인은 메시지마다 "확정 글이 있고 미확정 글이 없으면" PREFLIGHT를 냅니다. **새 토큰이 하나도 없는 메시지에도** 그렇습니다(`agents-plugin-soniox/src/_internal.ts` 315~339, 코드). 그래서 고객이 말을 멈춘 뒤 Soniox가 토큰 없는 진행 메시지를 보내면, 같은 글로 시도가 다시 시작되고 횟수가 줄어듭니다. 서버가 실제로 그런 메시지를 보내는지는 서버 동작이라 **확인하지 않았습니다**(확인 필요). 디버그 로그 `received user preflight transcript`가 한 턴에 같은 글로 여러 번 찍히는지 보면 압니다.
- **취소는 맨 앞에 있습니다(B·F).** 횟수나 10초에 걸려 새 시도를 못 만들어도, 그 직전에 앞 시도를 지웁니다. B의 4번째 트리거, F의 10초 뒤 PREFLIGHT가 그렇습니다. Python SDK와 같은 순서인지는 확인하지 않았습니다.
- **대소문자만 고치면 재사용되지만, 요청과 기록의 글이 갈립니다(E).** 재사용 때 SDK는 시도가 들고 있던 메시지 객체의 내용을 훅이 고친 글로 바꿔 끼우고(`agent_activity.ts` 3504~3511), 대화 기록에는 그 객체가 들어갑니다(4028~4031). 그래서 LLM이 본 글은 "p3", 기록은 "P3"입니다. 다음 턴 요청의 앞부분이 이번 요청과 그 칸에서 바이트가 달라지므로, 8장의 캐시 규칙대로라면 다음 턴은 이번 요청이 쓴 캐시 항목을 못 읽고 한 턴 앞의 항목까지만 읽어 약 한 턴 몫(어림 100토큰)을 더 씁니다(문서 규칙에서 끌어낸 추론, 실측 아님. [8-4절 깊이 보기](08-llm.md#깊이-보기-캐시-항목은-어디에-생기고-어떻게-찾나-2026-11-06-추가)).
- **10초는 턴의 첫 말소리부터입니다(F).** 쉼을 두고 이어 말해도 `speechStartTime`은 그대로라, 긴 턴의 뒷부분은 선제 생성을 못 합니다.

**취소된 시도의 요청은 끝까지 갑니다 (H, 실측).** 같은 실습 끝에서, 이 프로젝트의 LLM 클래스([src/models/anthropic.ts](../../src/models/anthropic.ts))를 127.0.0.1의 가짜 Anthropic 서버에 붙이고, 첫 글 조각을 받자마자 `LLMStream.close()`를 불렀습니다. 선제 시도를 버릴 때 SDK가 결국 닿는 곳입니다(`voice/agent.ts` 570~589의 cleanup).

```text
H. 취소된 시도의 요청 (가짜 서버: 50ms마다 글 조각, 모두 20개)
     118ms  첫 글 조각 "조각0 " → 바로 LLMStream.close() (시도 취소)
     170ms  LLMMetrics 나옴: cancelled true, ttftMs 113
   서버가 보낸 글 조각 20/20, 응답을 끝까지 쓴 시각 1055ms, 연결이 닫힌 시각 1055ms
```

워커 쪽은 170ms에 "취소됨" 지표를 내고 끝난 것처럼 보이지만, HTTP 응답은 서버가 끝까지 써서 정상 종료됐습니다. 플러그인이 `messages.create`에 취소 신호(`signal`)를 넘기지 않고(`agents-plugin-anthropic/src/llm.ts` 358~360), `close()`는 출력 쪽만 닫기 때문입니다(`llm/llm.ts` 220~224). 취소가 어디까지 전해지는지의 사슬은 [12장](12-streams-async.md)에서 봅니다. 실제 API도 같다면, 버린 시도도 **완료된 요청 하나로** 과금됩니다(입력·캐시 쓰기·출력 전부. 추정).

**손 계산: 시도 하나의 값.** 8장 손 계산의 가정(직전 요청 R ≈ 3,530토큰을 캐시에서 읽고, assistant 한 번 + 고객 말 한 번 ≈ 100토큰을 쓰고, 답 70토큰)을 쓰면 시도 하나는 다음과 같습니다([8-4절 깊이 보기 "턴별 읽기·쓰기와 비용 손 계산"](08-llm.md#깊이-보기-턴별-읽기쓰기와-비용-손-계산-2026-11-06-추가)).

```text
시도 1회 ≈ 3,530 × $0.01/M + 100 × $0.125/M + 70 × $0.50/M = 35.3 + 12.5 + 35.0 = 82.8 백만분의 1달러
B처럼 3회를 버린 턴: 82.8 × 3 ≈ $0.00025 더 듦 (그 턴 본래 비용의 3배)
8턴이 모두 B라면: ≈ $0.002 (1달러 1,400원이면 약 2.8원)
```

돈으로는 작습니다. 더 볼 것은 두 가지입니다. 버린 시도의 요청도 분당 요청 수 한도에 들어가고, 취소된 응답이 끝날 때까지(위 H에서 약 1초) 요청이 두 개씩 동시에 열려 있을 수 있습니다. 그리고 B가 실제로 일어나면 손해는 돈보다 **지연**입니다. 선제 생성의 이득(A의 556ms)이 통째로 사라집니다.

**운영에서 세는 법 (코드로 확인한 메시지).**

| 보는 것 | 수준 | 뜻 |
| --- | --- | --- |
| `starting preemptive generation` | info | 시도 하나 = LLM 요청 하나. 턴과 턴 사이의 줄 수가 그 턴의 시도 수. 턴 경계는 debug `end of user turn`, 운영에서는 이 프로젝트가 턴 확정마다 남기는 info `EOU metrics` 줄(`metrics.logMetrics`)로 잡음. 그 줄 앞에 찍힌 시도들이 그 턴 몫 |
| `using preemptive generation` `{ preemptiveLeadTime }` | debug | 재사용. 리드 타임이 0 근처면 C처럼 이득 없음 |
| `preemptive generation invalidated after …` | warn | 재사용 검사 실패 (D) |
| `SpeechCreated` 이벤트 (`source: 'generate_reply'`) | 이벤트 | 시도마다 하나, 일반 답에도 하나. 즉시 반응은 `'say'` |
| `LLMMetrics.cancelled === true` | 지표 | 버려진 시도(와 끼어들기로 끊긴 답) |

운영(`start`)은 info 수준이라 `using …` 줄은 안 보입니다(7-4절). info의 시도 수와 warn을 세고, 리드 타임은 개발 모드에서 봅니다.

---

## 11-5. onUserTurnCompleted 훅

```ts
// src/agent.ts
onUserTurnCompleted: (ctx, _chatCtx, newMessage) => {
  newMessage.content = newMessage.content.map((part) =>
    typeof part === 'string' ? correctTranscript(part) : part,
  );
  ctx.agent.session.say(ACKS[turn++ % ACKS.length]!, {
    addToChatCtx: false,
    allowInterruptions: true,
  });
},
```

### 훅이 받는 세 인자

| 인자 | 무엇 | 바꾸면 |
| --- | --- | --- |
| `ctx` | 에이전트·세션 접근 (`Agent.create` 방식의 첫 인자) | — |
| `chatCtx` (`_chatCtx`) | 이번 사용자 메시지 **직전까지**의 대화 기록 복사본 | **이번 답 생성에만** 반영, 저장 안 됨. 대신 선제 결과는 무효 |
| `newMessage` | 이번 사용자 메시지 | 그 객체가 그대로 LLM 입력과 **영구 대화 기록**에 들어감 |

이 프로젝트는 `newMessage`만 고칩니다. 보정된 글이 다음 턴에도 남아야 하기 때문입니다. 반면 "이번 턴에만 참고 자료를 끼워 넣는" RAG 같은 기법은 `chatCtx`에 메시지를 추가합니다. 언더스코어(`_chatCtx`)는 "쓰지 않는 인자"라는 관례 표시입니다.

몇 가지 세부 사항이 있습니다.

- 훅은 `await`됩니다. **훅이 오래 걸리면 그만큼 응답이 늦어집니다**(`onUserTurnCompletedDelayMs` 메트릭). 이 훅은 정규식 몇 개와 `say()` 호출뿐이라 거의 0입니다.
- 훅에서 `throw new voice.StopResponse()`를 던지면 답을 만들지 않습니다(빈 입력 무시 등에 씀).
  - (2026-11-06 추가) `StopResponse`는 SDK가 내보내는 `Error`의 하위 클래스입니다(`voice/stop_response.ts`). 세션이 훅의 예외를 잡아 이 클래스면 "이 턴에는 답하지 않음"으로 처리합니다(`agent_activity.ts` 3432~3450). 다른 예외는 오류 로그만 남기고 답을 그대로 만듭니다.
  - 이때 `return`이 재사용 검사보다 앞이라, **이미 띄운 선제 시도를 취소하지 않고 남깁니다.** 다음 턴의 첫 트리거가 11-4절 ②에서 지우므로 보통 문제는 없지만 요청 하나는 헛돕니다. 또 사용자 메시지는 답 작업이 대기열에 들어갈 때 기록에 들어가므로(4028~4031), **그 턴의 고객 말은 대화 기록에 남지 않습니다**(둘 다 코드에서 따라간 추론, 실행해 보지 않음).
- 자막·이벤트(`UserInputTranscribed`)에는 **보정 전 STT 원문**이 남습니다. 대화 기록과 자막이 다를 수 있습니다.

### `turn++ % ACKS.length`와 클로저

```ts
export function createAgent({ call, llm }: { … }) {
  let turn = 0;                  // createAgent가 불릴 때 한 번 생김
  return Agent.create({
    onUserTurnCompleted: (…) => { … ACKS[turn++ % ACKS.length]! … },
  });
}
```

`turn`은 `createAgent` 함수 안의 지역 변수인데, 훅 함수가 이를 **붙잡고(클로저)** 있어 통화 내내 값이 유지됩니다. 통화마다 `createAgent`가 새로 불리므로 통화끼리 섞이지 않습니다. `% ACKS.length`로 0, 1, 2, 0, 1, 2…를 돌며 "네네." → "네." → "아, 네."를 번갈아 씁니다. 같은 말이 연달아 나오면 기계처럼 들리기 때문입니다.

끝의 `!`는 TypeScript의 "이 값은 undefined가 아니다" 단언입니다. tsconfig의 `noUncheckedIndexedAccess`가 배열 인덱스 접근의 결과를 `string | undefined`로 보기 때문에 필요합니다. 나머지 연산으로 범위 안이 보장되므로 안전한 단언입니다.

---

## 11-6. 즉시 반응("네네") 기법 해부

### 왜 필요한가

PoC 측정에서 한 턴의 지연은 약 1.4초였고, 그중 LLM 첫 토큰이 약 0.8초였습니다(13장). 고객이 말을 마치고 1.4초 동안 침묵이 흐르면 "전화가 끊겼나?" 싶습니다. LLM을 당장 더 빠르게 할 수 없다면, **기다리는 동안 무언가를 들려주는** 방법이 있습니다. 사람 상담원도 생각하는 동안 "네네", "아 네"를 먼저 합니다.

### 설계 결정 하나하나

| 결정 | 이유 |
| --- | --- |
| **고정 문장 목록** (`ACKS`) | LLM을 기다리지 않음. 작은 LLM으로 즉석 반응을 만드는 방법(LiveKit 문서의 "fast pre-response")도 있지만, 그것도 첫 토큰을 기다려야 함 |
| 짧고 중립적인 말 ("네네.", "네.", "아, 네.") | 고객이 무슨 말을 했든 어울림. "좋네요"처럼 평가가 들어간 말은 거절·불만 뒤에 어색함 |
| **`addToChatCtx: false`** | ① LLM이 기록에서 이 말투를 보고 따라 하지 않음 ② 대화 기록이 매 턴 같은 구조로 쌓여 **프롬프트 캐시가 유지됨**(8장) |
| `allowInterruptions: true` | 고객이 이어서 말하면 바로 멈춤 |
| 훅에서 `say()` 호출, `await` 안 함 | 대기열에 넣기만 하고 바로 돌아가야 본 답 생성이 늦어지지 않음 |
| 지시문에 "시스템이 '네네'를 먼저 말한다" (9장) | LLM은 기록에 없는 즉시 반응을 모르므로 글로 알려 줌 |
| `llmNode`에서 첫머리 맞장구 제거 | 그래도 LLM이 "네,"로 시작하면 "네네. 네, …"가 되므로 코드로 뗌 (11-7절) |

### 대기열에서 일어나는 일

훅 안의 `say()`는 NORMAL 우선순위로 대기열에 들어가고, 본 답은 **훅이 끝난 뒤** 같은 NORMAL로 들어갑니다. 같은 우선순위면 먼저 들어온 순이므로 **즉시 반응이 반드시 먼저** 재생됩니다. ③단계의 "대기 중 발화 중단"은 훅보다 먼저 일어나므로 즉시 반응을 지우지 않습니다.

```text
시간 →
즉시 반응:  [재생 허가][TTS 첫 음성 ~0.17초][ "네네." 재생 ]
본 답:      [LLM 생성 ────────────][TTS 합성 ──────]  [재생 허가][ 본 답 재생 … ]
                                                    ↑ 즉시 반응이 끝나야 허가
```

여기서 중요한 비대칭이 있습니다.

- **즉시 반응(`say`)의 TTS는 재생 허가를 받은 뒤에야 시작합니다.** 그래서 "고객 말 끝 → 첫 소리"의 최소 시간은 "턴 확정 + ElevenLabs 첫 음성"입니다. 즉시 반응의 TTFB가 체감 지연의 하한입니다.
- **본 답의 TTS는 대기열에 들어가자마자 합성을 시작합니다.** 즉시 반응이 재생되는 동안 본 답이 미리 준비됩니다.

(2026-11-03 갱신) 첫째 비대칭은 코드에서 해소됐습니다. 즉시 반응 세 문장을 통화 시작 때 미리 합성해 두고 `say(ack, { audio })`로 소리를 직접 넘기므로, 재생 허가가 나면 TTS를 기다리지 않고 바로 재생합니다(13-5절 `AckAudioCache`). 그러면 체감 지연의 하한이 "턴 확정"까지 내려갑니다. 미리 합성이 끝나기 전의 첫 턴이나 합성에 실패한 경우는 이전처럼 그때 합성합니다.

(2026-11-06 추가) 두 비대칭을 시각으로 재현한 것이 11-2절 깊이 보기의 실습 2-3(미리 합성한 즉시 반응 2ms, 본 답 402ms에 틈 없이 이어짐)과 2-4(본 답을 `say()`처럼 합성했다면 573ms)입니다. 아래 표의 "첫소리까지"는 즉시 반응 기준이라 SDK의 `e2eLatency`(본 답 기준)로는 잴 수 없습니다. 재는 법은 11-3절 깊이 보기에 있습니다. 미리 합성한 뒤의 즉시 반응 첫 소리는 아직 실측하지 않았습니다(17-2 #14).

체감 지연이 "말 끝 판단 + LLM 첫 토큰 + TTS"에서 "말 끝 판단 + TTS 첫 음성"으로 줄어드는 구조입니다. 측정 결과도 이 계산과 맞습니다([5-poc-results.md](../5-poc-results.md) "즉시 반응", 2026-11-03).

| | 고객 말이 끝나고 첫소리까지 |
| --- | --- |
| 이전 (본 답만) | 약 1.4~1.6초 |
| **즉시 반응 적용** | **약 0.6~0.8초** (말 끝 판단 0.41~0.64초 + TTS 0.17초) |
| 본 답 시작 | 약 1.4초 (즉시 반응 뒤에 이어짐) |

본 답이 시작되는 시각 자체는 그대로입니다. 줄어든 것은 **침묵의 길이**입니다. 13장의 표현으로는 "숨기기"입니다.

같은 측정에서 지시문의 한계도 다시 확인됐습니다. 지시문에 "답을 '네'로 시작하지 말라"고만 했을 때는 **3번 중 3번** "감사합니다", "아,", "네,"로 시작해 "네네. 네, …"처럼 겹쳤고, `llmNode`에서 코드로 떼고 나서는 **4번 중 4번** 깨끗했습니다(11-7절). 6장의 오인식 보정과 똑같은 패턴입니다. "하지 말라"는 지시가 잘 안 먹히는 버릇은 코드가 맡습니다.

### 에이전트 상태의 흐름

코드 흐름으로 보면 상태가 이렇게 바뀔 것으로 예상됩니다.

```text
본 답 대기열 진입 → 'thinking' → 즉시 반응 첫 음 → 'speaking' → 즉시 반응 끝 → 'listening'
                 → 본 답 첫 음 → 'speaking' → 끝 → 'listening'
```

즉시 반응과 본 답 사이에 잠깐 `listening`이 끼는 셈입니다. 이 상태로 화면 표시(Agent Console의 상태 표시)나 다른 로직을 만들 때는 이 깜빡임을 고려해야 합니다.

(2026-11-06 추가) 왜 `listening`이 끼는지는 **상태 임대(state lease)**로 설명됩니다. 에이전트 상태를 바꿀 권한은 발화마다 하나씩 받는 "임대"(`AgentStateLease`, `agent_activity.ts` 302~305)이고, 한 번에 하나만 유효합니다(`activeAgentStateLease`). 규칙은 셋입니다(3027~3089).

| 동작 | 조건 | 결과 |
| --- | --- | --- |
| 쥐기 (`acquire`) | 그 발화가 중단·완료되지 않음 | 이 임대가 유효해지고 상태를 바꿈 (`thinking`이나 `speaking`) |
| 말 시작 (`tryStartAgentSpeech`) | 그 발화가 지금 재생 허가를 받은 발화(`_currentSpeech`)임 | 쥐고 `speaking` |
| 놓기 (`release`) | 이 임대가 지금 유효한 것이고, 기대한 상태(대개 `speaking`)임 | `listening`, 유효한 임대 없음 |

본 답은 대기열에 들어갈 때 `thinking`으로 임대를 쥐지만(4051), 즉시 반응이 첫 소리에서 임대를 가져가고(`speaking`), 끝날 때 놓으면서 `listening`으로 바꿉니다. 본 답은 다시 쥐지 않고 자기 첫 소리에서야 `speaking`을 쥡니다. 그래서 `thinking → speaking → listening → speaking`입니다. 끝난 발화나 다른 활동(핸드오프 전 에이전트)의 늦은 작업이 상태를 덮어쓰지 못하게 하려는 장치입니다. 다만 본 답의 `thinking`이 즉시 반응의 첫 소리보다 늦게 오면 순서가 바뀔 수 있고(즉시 반응 재생 중 `thinking` → 즉시 반응이 끝나도 임대가 남의 것이라 `listening`으로 안 바뀜), 어느 쪽이 먼저인지는 실행해 보지 않았습니다(코드에서 따라간 추론). 화면 표시는 `AgentStateChanged`를 그대로 믿기보다 짧은 깜빡임을 걸러 쓰는 편이 안전합니다.

### 대가와 위험

| 대가 | 설명 |
| --- | --- |
| 맞지 않는 상황 | "전화하지 마세요" → "네네." → "죄송합니다…"처럼 어색할 수 있음. **`shouldAck`로 대응** (아래) |
| 즉시 반응 중 끼어들기 | 즉시 반응도 끼어들 수 있는 발화라 고객이 이어 말하면 끼어들기 처리를 거침 |
| 즉시 반응과 본 답 사이 틈 | 본 답 준비가 즉시 반응보다 늦으면 "네네." 뒤에 다시 침묵. 측정상 즉시 반응은 약 0.6~0.8초, 본 답은 약 1.4초에 시작해 그 사이가 수백 ms. 사람 귀로 자연스러운지 들어 봐야 함 (`lk agent console`) |
| 본 답이 다시 길어짐 | 측정 중 "~하시는군요"로 고객 말을 되풀이한 뒤 질문을 두 개 붙이는 경향이 다시 보임. 즉시 반응이 맞장구를 맡은 만큼 본 답이 그 자리를 되풀이로 채우는 것으로 보이며, 지시문(9장)과 시나리오로 다시 잡아야 함 |

### 즉시 반응을 하지 않을 때: shouldAck (2026-11-03 추가)

"네네."는 가볍고 긍정적인 소리라, 화난 고객이나 거절하는 고객에게는 거슬립니다. 그래서 코드는 고객 말을 보고 즉시 반응을 건너뜁니다.

```ts
// src/ack.ts
const NO_ACK =
  /(전화|연락)\s*(하지|안\s*하|말)|그만\s*(하|좀)|필요\s*없|짜증|화가|불쾌|기분\s*나|사람(이랑|하고|과|한테)?\s*(통화|연결|바꿔)|상담(사|원)(이랑|하고|과|한테|으로|로)?\s*(통화|연결|바꿔)|AI\s*(말고|싫)/i;

export function shouldAck(userText: string): boolean {
  return !NO_ACK.test(userText);
}

// src/agent.ts의 onUserTurnCompleted
if (!shouldAck(newMessage.textContent ?? '')) return;   // 보정은 이미 끝났으니 반응만 건너뜀
```

| 정규식 묶음 | 잡는 말 |
| --- | --- |
| `(전화\|연락)\s*(하지\|안\s*하\|말)` | "전화하지 마세요", "연락 안 하셨으면", "전화 말고" |
| `그만\s*(하\|좀)`, `필요\s*없` | "그만하세요", "필요 없어요" |
| `짜증\|화가\|불쾌\|기분\s*나` | 불만 표현 |
| `사람…(통화\|연결\|바꿔)`, `상담(사\|원)…(통화\|연결\|바꿔)`, `AI\s*(말고\|싫)` | 사람 상담사 요청 |

몇 가지 볼 점이 있습니다.

- **판단 순서.** 보정(`correctTranscript`)을 먼저 하고 그 결과로 판단합니다. `return`은 즉시 반응만 건너뛰고 LLM 답은 그대로 나갑니다. 훅이 끝나면 세션이 답을 생성하기 때문입니다(11-5절).
- **`.test()`와 `g` 플래그.** 이 정규식은 `.test()`로 반복 호출되는데 `g` 플래그가 없습니다. 12-6절에서 본 `lastIndex` 함정을 피한 올바른 형태입니다. `g`를 붙이면 같은 문장에 번갈아 다른 결과가 나올 수 있습니다.
- **틀렸을 때의 비용이 비대칭.** 거절인데 반응을 하면 거슬리고, 보통 대답인데 반응을 빼면 조금 느리게 느껴질 뿐입니다. 그래서 넓게 잡는 편이 안전합니다. 예를 들어 "전화 말고 문자로 주세요"도 걸려서 반응이 빠지는데, 이 정도 오탐은 감수할 만합니다.
- **테스트가 짝으로** 있습니다(14장). "하지 않는다" 6문장과 "한다" 3문장("전화 상담도 되나요?"처럼 '전화'가 들어가도 거절이 아닌 문장 포함)입니다.
- **판정은 고객 말 전체**를 봅니다. "네, 근데 다시는 전화하지 마세요"처럼 앞이 긍정이어도 거절이 들어 있으면 반응을 뺍니다.

---

## 11-7. llmNode 재정의: 첫머리 맞장구 떼기

```ts
// src/agent.ts
llmNode: async (ctx, chatCtx, toolCtx, modelSettings) => {
  const stream = await Agent.default.llmNode(ctx.agent, chatCtx, toolCtx, modelSettings);
  return stream ? withoutLeadingAck(stream) : null;
},
```

### 노드란

LiveKit은 파이프라인의 각 단계를 **노드**라는 함수로 열어 둡니다. 기본 구현을 감싸서 앞뒤에 처리를 끼울 수 있습니다.

| 노드 | 입력 → 출력 | 기본 동작 |
| --- | --- | --- |
| `sttNode` | 오디오 프레임 스트림 → STT 이벤트 스트림 | STT 스트림에 연결 |
| `llmNode` | 대화 기록 + 도구 → 글 조각·도구 호출 스트림 | `llm.chat()` 결과를 그대로 전달 |
| `ttsNode` | 글 스트림 → 오디오 프레임 스트림 | TTS에 연결 (스트리밍이 아니면 문장 분할기를 씌움) |
| `transcriptionNode` | 글 스트림 → 자막 글 스트림 | 그대로 통과 |

`Agent.default.llmNode(...)`를 불러 **기본 동작을 먼저 얻고**, 그 결과 스트림을 `withoutLeadingAck`로 감싸 돌려줍니다. 기본 동작을 다시 짜지 않고 **꾸미기(decorator)**만 하는 패턴이라, SDK가 기본 동작을 개선하면 그대로 혜택을 받습니다. LLM이 아무것도 돌려주지 않는 경우(`null`)도 그대로 전달합니다.

### 세 가지 연결 지점의 차이

이 프로젝트는 세 곳에서 글을 고칩니다. 위치에 따라 영향 범위가 다릅니다.

| 위치 | 무엇을 | 영향 범위 |
| --- | --- | --- |
| `onUserTurnCompleted` (`newMessage`) | 고객 글 보정 | LLM 입력 + 대화 기록 |
| `llmNode` (`withoutLeadingAck`) | LLM 답 첫머리 | TTS + **자막 + 대화 기록** (노드 출력이 이후 모든 경로의 원본) |
| `ttsTextTransforms` (`pronunciationTransform`) | 발음 | **TTS 입력만** (단, TTS alignment를 쓰면 기록에도 반영될 수 있음, 10-6절) |

맞장구 제거를 `ttsTextTransforms`가 아니라 `llmNode`에 둔 것은 **대화 기록에서도 지워야** LLM이 다음 턴에 "네,"로 시작하는 버릇을 이어 가지 않기 때문입니다. 발음 변환을 `ttsTextTransforms`에 둔 것은 기록에는 "F2"라는 올바른 표기가 남아야 하기 때문입니다.

`withoutLeadingAck`의 스트림 처리 기법은 12장에서 자세히 봅니다. 여기서는 "처음 12자를 모았다가 판단한다"는 점만 기억해 두면 됩니다.

(2026-11-06 갱신) 이 12자 보류는 **노드의 첫 출력**을 늦추고, 그 몫은 `LLMMetrics.ttftMs`에는 안 잡히지만 본 답 메시지의 `llmNodeTtft`에는 잡힙니다. 그런데 지금 설정에서는 **TTS가 첫 글을 받는 시각은 늦추지 않습니다.** ElevenLabs 플러그인의 문장 분할기가 어차피 12자보다 훨씬 늦게 첫 덩어리를 내보내기 때문입니다(아래 깊이 보기). 처음 판은 "이 12자만큼 TTS 시작이 늦어진다"고 적었습니다.

#### 깊이 보기: 12자 보류의 값 (2026-11-06 추가)

**손 계산.** 보류는 "첫 토큰이 온 뒤 모은 글이 12자가 될 때까지"입니다. 한국어는 글자당 약 1토큰(8-1절 추정 0.97)이고, 토큰은 흔히 앞 공백을 달고 옵니다(" 가"). 공백도 한 글자로 세므로 12자는 토큰 9~10개이고, 첫 토큰은 이미 와 있으니 **더 기다리는 것은 (N − 1)개 간격**입니다.

```text
"네, 가죽 지갑 각인이…"     12자에 닿는 토큰 9개  → 8 × 10ms = 80ms (100 tok/s) / 8 × 20ms = 160ms (50 tok/s)
"가죽 지갑 각인이시군요…"   12자에 닿는 토큰 10개 → 9 × 10ms = 90ms (100 tok/s) / 9 × 20ms = 180ms (50 tok/s)
```

디코드 속도(초당 토큰)는 8-3절처럼 서버 사정에 따라 흔들립니다. 또 Anthropic의 SSE `text_delta` 하나에는 토큰 여러 개가 들어 올 수 있어, 조각 수로는 이보다 적게 기다릴 수 있습니다(8-6절).

**재는 법 (코드).** 두 지표의 시작점과 끝점이 다릅니다.

| 지표 | 재는 곳 | 시작 → 끝 | 단위 |
| --- | --- | --- | --- |
| `LLMMetrics.ttftMs` | `LLMStream` 안 (`llm/llm.ts` 382·402~404·424) | LLM 스트림 생성 → 첫 응답 청크. 노드 래퍼(`withoutLeadingAck`)를 거치기 **전** | ms (정수로 버림) |
| `llmNodeTtft` (본 답 메시지의 `metrics`) | `performLLMInference` (`voice/generation.ts` 731·755~767), 메시지에 붙임(`agent_activity.ts` 4277~4279) | `llmNode` 호출 직전 → 노드가 낸 첫 비어 있지 않은 글. 래퍼를 거친 **뒤** | 초 |

그래서 `llmNodeTtft × 1000 − ttftMs` ≈ 보류 몫(+ 노드를 준비하는 1ms 미만)입니다. 두 값 모두 같은 시도에서 시작하므로 선제 생성이어도 차이는 그대로 보류 몫입니다.

직접 돌려 보기: [lab/11-ack-hold.mjs](lab/11-ack-hold.mjs) (2초 남짓). 1번은 이 프로젝트의 에이전트(`createAgent`, [src/agent.ts](../../src/agent.ts))에 토큰 간격을 흉내 낸 가짜 LLM을 꽂고, SDK의 `performLLMInference`로 실제 `llmNode` 경로를 돌려 두 지표를 받은 것입니다(실측, 실행마다 몇 ms 다름).

```text
1) 실제 경로로 잰 값 (가짜 LLM 첫 토큰 300ms, 이후 토큰 간격 고정)
   답의 시작        토큰 간격       ttftMs  llmNodeTtft  차이(보류 몫)  노드가 처음 낸 글
   맞장구로 시작   100 tok/s 10ms      302          410            108  "가죽 지갑 각인이"
   맞장구로 시작   50 tok/s  20ms      302          475            173  "가죽 지갑 각인이"
   바로 본론     100 tok/s 10ms      303          412            109  "가죽 지갑 각인이시군요"
   바로 본론     50 tok/s  20ms      304          512            208  "가죽 지갑 각인이시군요"
```

손 계산(80·160·90·180ms)과의 차이는 `setTimeout`이 매번 1~3ms 늦게 깨는 몫입니다. "맞장구로 시작"의 첫 출력에서 "네, "가 떨어져 나간 것도 보입니다.

**그런데 TTS 첫 글은 늦어지지 않습니다 (코드 + 실습).** ElevenLabs 플러그인은 `chunkLengthSchedule`을 주지 않으면 autoMode라서 blingfire 문장 분할기로 글을 모아 보냅니다(`agents-plugin-elevenlabs/src/tts.ts` 853·870~874, 10-4절). 분할기는 **완성된 문장이 20자 이상 모이고 다음 문장이 시작돼야** 첫 덩어리를 내보냅니다(`tokenize/blingfire.ts` 104~107, `tokenize/token_stream.ts` 227~271). 첫 글은 빨라야 21자째 뒤에 나가므로, 그때는 12자 보류가 이미 풀려 있습니다. 2번은 노드 출력을 SDK의 분할기에 그대로 넣어 첫 덩어리가 나가는 시각을 본 것입니다(가상 시계라 매번 같음, 100 tok/s, 첫 토큰 300ms).

```text
2) TTS로 첫 글이 넘어가는 시각
   두 문장 답 (맞장구로 시작), minSentenceLength 20: 보류 없음 550ms / 보류 있음 550ms (보류가 풀린 시각 380ms) — LLM 스트림이 끝나서 내보냄
      보류 있음의 첫 TTS 글: "가죽 지갑 각인이시군요. 예산은 어느 정도 생각하세요?"
   두 문장 답 (맞장구로 시작), minSentenceLength  8: 보류 없음 430ms / 보류 있음 430ms (보류가 풀린 시각 380ms) — 다음 문장이 시작돼 내보냄
   세 문장 답 (맞장구로 시작), minSentenceLength 20: 보류 없음 560ms / 보류 있음 560ms (보류가 풀린 시각 380ms) — 다음 문장이 시작돼 내보냄
   세 문장 답 (맞장구로 시작), minSentenceLength  8: 보류 없음 430ms / 보류 있음 430ms (보류가 풀린 시각 380ms) — 다음 문장이 시작돼 내보냄
```

- 기본값(20)에서 두 문장 답은 **LLM 스트림이 끝나야** TTS로 넘어갑니다(10-4절의 지적 그대로). 보류가 있든 없든 같습니다.
- 10-4절의 제안처럼 8로 낮춰도, 첫 문장 "가죽 지갑 각인이시군요."가 끝나고 다음 토큰이 오는 430ms가 보류가 풀리는 380ms보다 늦습니다.
- 보류가 TTS 첫 글을 늦추는 것은 첫 덩어리가 12자 전에 나갈 수 있을 때뿐입니다. 분할기의 최소 길이를 12보다 작게 두고 첫 문장이 그보다 짧을 때, 또는 문장을 모으지 않는 설정(`chunkLengthSchedule`을 주면 단어 분할기를 씀, 같은 파일 873~874)일 때입니다. LiveKit Inference TTS(`TTS_PROVIDER=livekit`) 경로는 확인하지 않았습니다.
- 보류는 TTS 스트림을 여는 시각(첫 글 조각이 올 때 `produceSegments`가 엶, `agent_activity.ts` 3939~3978)도 늦추지만, ElevenLabs 플러그인은 통화 중 WebSocket 하나를 다시 쓰므로(`tts.ts` 1001~1018) 연결 비용이 끼지 않습니다(코드. 연결이 닫힌 뒤라면 다를 수 있음).
- 그래서 **`llmNodeTtft − ttftMs`가 0.1~0.2초로 보여도 그만큼 체감이 늦어진 것은 아닙니다.** 체감에 실제로 큰 것은 분할기의 "20자 + 다음 문장" 규칙이고, 그것은 TTS 쪽 지표로 봐야 합니다(13장).

**운영에서 남기기 (제안, 적용하지 않음).** 본 답 메시지가 기록에 들어갈 때 같은 시도의 `ttftMs`와 빼면 됩니다. 메시지는 재생이 끝난 뒤 들어오고, 그 시도의 LLM 지표는 스트림이 끝날 때 나오므로 보통 먼저 와 있습니다.

```ts
let lastTtftMs: number | undefined;
session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
  if (ev.metrics.type === 'llm_metrics' && !ev.metrics.cancelled) lastTtftMs = ev.metrics.ttftMs;
});
session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
  if (item.type !== 'message' || item.role !== 'assistant') return;
  const nodeTtft = item.metrics?.llmNodeTtft; // 초
  if (nodeTtft === undefined || lastTtftMs === undefined) return;
  log().info({ holdMs: Math.round(nodeTtft * 1000 - lastTtftMs) }, '첫머리 맞장구 보류');
});
```

---

## 11-8. 대화 기록(ChatContext)의 일생

통화가 진행되면서 대화 기록이 어떻게 쌓이는지 정리합니다.

```text
[system]    buildInstructions(call)                       ← Agent.create의 instructions
[assistant] (고지) 안녕하세요, 김민수 고객님. …              ← say(), addToChatCtx 기본 true
[assistant] (질문) 이삼 분 정도 통화 괜찮으실까요?
[user]      네, 괜찮아요.                                   ← 턴 확정 + 보정 후 newMessage
            (즉시 반응 "네네."는 기록 안 됨)
[assistant] 문의 주신 게 에프투 울트라 맞으시죠?             ← LLM 답 (맞장구 제거 후, 실제 재생된 만큼)
[user]      …
```

- `say()`로 말한 문장도 기본적으로 기록에 남습니다. 그래서 LLM은 자기가 고지를 했다는 것을 압니다(지시문에도 "이미 했다"고 적어 둠).
- 끊긴 LLM 답은 **들은 데까지만**, 끊긴 `say()`는 **전체 문장**이 `interrupted: true`로 남습니다(7-5절).
- 고객이 말했지만 턴이 버려진 경우(고지 중)에는 기록에 아무것도 남지 않습니다.
- Anthropic 플러그인은 이 기록을 Messages API 형식으로 바꿀 때 연속된 assistant 두 개를 합치고, 맨 앞에 `(empty)` user 턴을 붙입니다(8-6절).

대화가 길어지면 기록도 길어지지만, 이 프로젝트는 2~3분 통화라 문제가 되지 않습니다. 긴 통화라면 `chatCtx.truncate(n)` 같은 정리나 요약이 필요합니다.

---

## 11-9. 이벤트로 세션 들여다보기

세션은 거의 모든 일을 이벤트로 알립니다. (2026-11-06 갱신) 이 프로젝트는 "이 프로젝트의 사용" 칸이 찬 다섯 개(`UserStateChanged`, `MetricsCollected`, `OverlappingSpeech`, `AgentFalseInterruption`, `Close`)를 씁니다([src/main.ts](../../src/main.ts), [src/call-guard.ts](../../src/call-guard.ts)). 처음 판의 "두 개"는 그 뒤 늘어난 것을 반영하지 못한 말이었습니다.

| 이벤트 | 이 프로젝트의 사용 | 다른 쓰임 |
| --- | --- | --- |
| `UserStateChanged` | `speaking → listening`에 Soniox finalize. `away`에 "여보세요?" 재촉, `speaking`에 무응답 타이머 해제 (5-5절) | — |
| `MetricsCollected` | 구간별 지연 로그 (13장) | 대시보드 |
| `AgentStateChanged` | — | 화면 상태 표시, 통화 녹음 표시 |
| `UserInputTranscribed` | — | 실시간 자막, 키워드 감지 |
| `ConversationItemAdded` | — | 대화 기록 실시간 저장 (Firestore) |
| `OverlappingSpeech` (2026-11-04) | 겹친 말의 판정 로그: 끼어들기·맞장구·판단 없음(AI 말이 먼저 끝남), 확률, 판정까지 걸린 시간 (7-5절) | 맞장구·끼어들기 표본 모으기 |
| `AgentFalseInterruption` | 끼어들기 취소 로그(`resumed`) (7-5절, 2026-11-04) | 거짓 끼어들기 통계 |
| `Close` | 무응답·최대 길이 타이머 정리, 끝난 이유 기록. RoomIO가 이 이벤트로 방 삭제(`deleteRoomOnClose`), `end_call` 도구가 잡 종료 (4-7절) | 통화 결과 저장 |
| `SpeechCreated` (2026-11-06 추가) | — | 발화가 만들어질 때마다 한 번(`source`: `say`, `generate_reply` 등). 선제 생성의 시도도 하나씩 나오므로 턴별 시도 수를 셀 수 있음 (11-4절 깊이 보기) |
| `EotPrediction` (2026-11-06 추가) | — (남기기 제안은 7-4절) | 판정이 쓴 p와 기준값, `delayMs`. `delayMs`는 대기 시간이 아니라 **마지막 말소리부터 판정이 예측을 손에 쥔 때까지**. 예측 요청 하나에 한 번, 시간 초과면 안 옴 (7-4절 깊이 보기 "로그와 이벤트로…") |
| `UserTranscriptionTimeout` (2026-11-06 추가) | — (세션 옵션 `transcriptionTimeout`, ms, 기본 끔) | VAD가 말소리를 봤는데 말 끝 뒤 그 시간 안에 비어 있지 않은 FINAL이 없을 때. 이벤트만 내고 턴은 확정하지 않음. "FINAL 없이는 턴이 안 끝남" 함정을 알아채는 용도 (7-4절 함정 표) |

통화 결과를 Firestore에 남기거나 통화 후 처리를 부르는 기능은 앞으로 이 이벤트들 위에 만들게 됩니다.

---

## 11-10. 정리

```text
턴 확정 ─▶ ① 재시도 횟수 초기화 ② 끼어들 수 없는 발화 중이면 버림 ③ 기존 발화 중단 ④ newMessage
        ─▶ ⑤ onUserTurnCompleted: correctTranscript + say("네네.", 기록 안 함)
        ─▶ ⑥ 선제 결과 재사용? (글·기록·도구 동일) : 새로 생성
대기열:  [즉시 반응] → [본 답]   (같은 NORMAL, 먼저 들어온 순, 한 번에 하나)
본 답:   llmNode = 기본 + withoutLeadingAck → ttsTextTransforms → TTS → 방
기록:    고객(보정) / 에이전트(맞장구 제거, 들은 만큼) / 즉시 반응은 없음
```

(2026-11-06 추가) 이 장에서 코드와 실습으로 더한 것입니다.

```text
대기열:  힙 [우선순위, hrtime]. mainTask가 꺼내 재생 허가 → 그 생성이 끝날 때까지 기다림. 끊긴 발화가 안 끝나면 5초 감시 타이머
TTS 시작: say() = 허가(+조용함) 뒤, LLM 답 = 대기열에 들어가자마자 → 즉시 반응은 미리 합성
선제 생성: 트리거마다 ① 문 ② 앞 시도 취소 ③ 10초 ④ 3회 ⑤ 새 시도(LLM 요청 1회, 버려도 끝까지 감)
          이득 = preemptiveLeadTime. "마지막 PREFLIGHT = FINAL"일 때만 남. 한글은 띄어쓰기 위치까지 비교
지표:    e2eLatency = 본 답 첫 소리(즉시 반응 아님). llmNodeTtft − ttftMs = 12자 보류 몫(지금 설정에선 TTS 첫 글을 안 늦춤)
```

---

## 확인 문제

1. LLM을 세션이 아니라 에이전트에 넣는 구조적 이유는?
2. 첫 멘트의 고지와 질문 사이에 틈이 생기는 이유를 `say()`의 TTS 시작 시점으로 설명하세요.
3. 선제 생성이 TTS와 도구 실행은 미리 하지 않는 이유는 각각 무엇입니까?
4. 오인식 보정이 일어난 턴이 오히려 느려지는 이유와 해결책은?
5. 즉시 반응을 `addToChatCtx: false`로 둔 이유 두 가지는?
6. 맞장구 제거는 `llmNode`에, 발음 변환은 `ttsTextTransforms`에 둔 이유를 "영향 범위"로 설명하세요.
7. 즉시 반응이 본 답보다 반드시 먼저 재생되는 이유는?
8. (2026-11-06 추가, 손 계산) 한 턴에 같은 글의 PREFLIGHT가 세 번 오고, 이어서 글이 더 늘어난 FINAL이 왔습니다. 설정은 기본값(`maxRetries` 3)입니다. ⓐ LLM 요청은 모두 몇 번 나갑니까? ⓑ 턴이 확정될 때 재사용할 결과가 남아 있습니까? ⓒ 8장의 가정(시도 1회 ≈ 82.8 백만분의 1달러)으로 버려진 몫은 얼마입니까?
9. (2026-11-06 추가, 손 계산) 본 답이 "네, 가죽 지갑 각인이시군요. 예산은 어느 정도 생각하세요?"이고, 토큰은 글자 하나씩(앞 공백은 붙여서) 50 tok/s로 옵니다. ⓐ 12자 보류는 노드의 첫 출력을 몇 ms 늦춥니까? ⓑ ElevenLabs 플러그인 기본 설정에서 이 보류가 TTS 첫 글 시각을 늦춥니까? 이유는?
10. (2026-11-06 추가) 고객이 AI·녹음 고지 위에서 말하다가 고지가 끝나고 300ms 뒤에 말을 멈췄습니다. 질문(`say()`, 끼어들 수 있음, 그때 합성)의 첫 소리는 고지가 끝나고 몇 ms 뒤입니까? TTS 첫 음성은 170ms로 봅니다.
11. (2026-11-06 추가) 통화 결과의 `e2eLatency`로 "즉시 반응까지의 침묵"을 잴 수 없는 이유와, 대신 잴 방법은?

<details>
<summary>답 보기</summary>

1. 세션(통화)은 하나지만 에이전트는 핸드오프로 바뀔 수 있어, 단계마다 다른 지시문·LLM·도구를 쓸 수 있게 하려는 것입니다.
2. `say()`의 TTS는 재생 허가를 받은 뒤 시작하는데, 질문은 고지 재생이 끝나야 허가를 받으므로 그때부터 TTS 첫 음성 시간만큼 틈이 생깁니다.
3. TTS는 버려질 수 있는 합성에 비용을 쓰지 않기 위해(옵션으로 켤 수 있음), 도구는 버려질 예측이 예약·기록 같은 부수 효과를 일으키지 않게 하기 위해서입니다.
4. 훅에서 고객 글이 바뀌면 선제 생성 때의 글과 달라 재사용 검사에 실패하고 LLM을 처음부터 다시 부르기 때문입니다. 보정을 `sttNode`로 옮기면 선제 생성 입력부터 보정됩니다.
5. LLM이 기록을 보고 그 말투를 따라 하지 않게 하고, 대화 기록 구조를 일정하게 유지해 프롬프트 캐시를 지키기 위해서입니다.
6. `llmNode` 출력은 TTS·자막·대화 기록 모두의 원본이라 기록에서도 맞장구를 지울 수 있습니다. `ttsTextTransforms`는 TTS 입력에만 적용되어 기록에는 올바른 표기("F2")가 남습니다.
7. 둘 다 NORMAL 우선순위이고, 즉시 반응은 훅 안에서 먼저 대기열에 들어가며, 본 답은 훅이 끝난 뒤 들어가기 때문입니다. 같은 우선순위는 먼저 들어온 순입니다.
8. ⓐ 4번입니다. PREFLIGHT 세 번이 시도 1·2·3을 만들고(만들 때마다 앞 시도 취소), FINAL은 글이 마지막 PREFLIGHT와 다르므로 트리거가 됩니다. 이 4번째 트리거는 ② 앞 시도(3번째) 취소 → ④ 횟수 3/3이라 새 시도 없음으로 끝납니다. 턴이 확정되면 남은 것이 없어 새 `generateReply`가 나갑니다. 3 + 1 = 4번입니다. ⓑ 없습니다. 선제 생성을 끈 것과 같은 시각(턴 확정)에 LLM이 시작합니다. ⓒ 버려진 시도 3번이 모두 끝까지 가므로(11-4절 깊이 보기 H) 82.8 × 3 ≈ 248 백만분의 1달러, 약 $0.00025입니다. 돈보다 큰 손해는 리드 타임을 통째로 잃는 것입니다.
9. ⓐ 공백을 포함해 12자에 닿는 토큰은 9개("네", ",", " 가", "죽", " 지", "갑", " 각", "인", "이")입니다. 첫 토큰 뒤 8개를 더 기다리므로 8 × 20ms = 160ms입니다. ⓑ 늦추지 않습니다. 기본 분할기는 완성된 문장이 20자 이상 모이고 다음 문장이 시작돼야 첫 덩어리를 내보내는데, 이 답은 첫 문장이 13자라 둘째 문장과 합쳐지고 뒤에 문장이 없어 LLM 스트림이 끝날 때 나갑니다. 그때는 보류가 이미 풀려 있습니다(실습 11-ack-hold 2번).
10. 662ms입니다. 질문은 고지가 끝날 때 재생 허가를 받지만 "고객 조용함"을 함께 기다립니다. 조용함은 고객의 마지막 말소리 창 뒤 192ms에 켜지므로 고지 끝 + 300 + 192 = 492ms에 TTS가 시작되고, 170ms 뒤인 662ms에 첫 소리가 납니다(실습 11-speech-queue 2-2와 같은 구조). 다만 고객이 한 말도 턴이 되므로, 확신하는 판정이면 말 끝 약 406ms 뒤(고지 끝 + 706ms)에 확정되어 막 시작한 질문은 끊기고 그 말에 대한 답이 나갑니다(11-3절 ③).
11. `e2eLatency`는 LLM 답 작업만 계산하고, 그 값은 본 답의 첫 프레임 기준입니다. `say()`로 낸 즉시 반응은 계산하지 않고 기록에도 남기지 않습니다. 대신 `AgentStateChanged`(`speaking`) 이벤트의 `createdAt`에서 `EOUMetrics.lastSpeakingTimeMs`를 빼면 즉시 반응의 첫 소리까지를 잴 수 있습니다.

</details>
