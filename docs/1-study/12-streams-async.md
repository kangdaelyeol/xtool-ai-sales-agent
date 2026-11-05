# 12장. 스트림과 비동기 — 흘러오는 데이터를 다루는 기술

음성 에이전트의 데이터는 한꺼번에 오지 않습니다. 오디오는 10ms 조각으로, STT 글은 단어 조각으로, LLM 답은 토큰 조각으로, TTS 소리는 다시 프레임 조각으로 **흘러옵니다.** 이 프로젝트의 직접 작성 코드 중 가장 까다로운 부분인 `withoutLeadingAck`(ack.ts)와 `pronunciationTransform`(pronunciation.ts)은 모두 "흘러오는 조각을 고치는" 코드입니다. 이 장은 JavaScript의 비동기·스트림 도구와, 조각 경계 문제를 푸는 일반적인 기법을 다룹니다.

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

### 기다리지 않는 호출 (fire-and-forget)

```ts
session.say(openingNotice(call), { allowInterruptions: false });   // await 없음
session.say(OPENING_QUESTION, { allowInterruptions: true });
```

`say()`는 SpeechHandle을 돌려주는데, 이 코드는 기다리지 않습니다. **대기열에 넣는 것이 목적이지 재생 완료를 기다리는 것이 목적이 아니기** 때문입니다. `onUserTurnCompleted` 안의 즉시 반응도 마찬가지입니다. 기다리면 본 답 생성이 즉시 반응 재생이 끝날 때까지 밀립니다.

기다리지 않는 호출의 주의점은 **오류가 버려질 수 있다**는 것입니다. 기다리지 않은 Promise가 실패하면 아무도 처리하지 않는 거부(unhandled rejection)가 됩니다. SDK는 발화 실패를 내부에서 로그로 처리하므로 여기서는 괜찮지만, 우리가 만든 비동기 함수를 기다리지 않고 부를 때는 `.catch()`를 붙이는 습관이 필요합니다.

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
- **게으름(laziness)**: 소비자가 값을 요구하지 않으면 제너레이터는 진행하지 않습니다. 그래서 자연스럽게 생산 속도가 소비 속도에 맞춰집니다.
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

### 둘 사이 변환

| 변환 | 방법 |
| --- | --- |
| 배열·이터러블 → ReadableStream | `ReadableStream.from(chunks)` (테스트에서 사용) |
| AsyncIterable → ReadableStream | LiveKit의 `toStream()` |
| ReadableStream → 순회 | `for await (const x of stream)` |

`Agent.create`의 노드 훅은 비동기 제너레이터(AsyncIterable)를 돌려줘도 되고, LiveKit이 알아서 ReadableStream으로 감쌉니다. 그래서 `llmNode`가 `withoutLeadingAck(stream)`(비동기 제너레이터)를 그대로 돌려줄 수 있습니다.

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
- **왜 12자인가.** 떼야 할 맞장구 중 가장 긴 조합이 "네, 감사합니다. "(공백 포함 10자 안팎)입니다. 맞장구 두 개 + 구두점 + 공백을 넉넉히 덮으면서, 보류 지연은 토큰 몇 개 수준으로 짧게 잡은 값입니다.
- **길이 단위.** JavaScript의 `length`는 UTF-16 코드 단위 수입니다. 한글 음절은 한 단위라 "글자 수"와 같지만, 이모지는 두 단위입니다. 여기서는 영향이 없습니다.

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

더 나아가면 **같은 입력을 무작위로 쪼개 여러 번 넣고 결과가 항상 같은지** 보는 속성 기반 테스트(property-based testing)도 있습니다. 12-5절의 불변식(이어 붙인 출력 = 전체 변환)을 자동으로 검사하는 방법입니다. 지금 프로젝트에는 없지만 스트림 변환이 늘어나면 고려할 만합니다.

---

## 12-8. 정리

| 개념 | 핵심 | 이 프로젝트 |
| --- | --- | --- |
| 이벤트 루프 | 스레드 하나. 동기 계산이 길면 다 멈춤 | 통화별 프로세스 분리의 이유 |
| fire-and-forget | 기다리지 않는 호출. 오류 처리 주의 | `say()` 두 번, 즉시 반응 |
| 비동기 제너레이터 | 멈췄다 이어지는 함수. 상태를 지역 변수로 | `withoutLeadingAck` |
| TransformStream | `transform` + `flush` | `pronunciationTransform` |
| 경계 문제 | 조각 경계 ≠ 의미 경계 | 보류 버퍼 네 가지 |
| 정확성 불변식 | 이어 붙인 출력 = 전체 변환 결과 | 쪼갠 입력 테스트 |

---

## 확인 문제

1. `onUserTurnCompleted`에서 즉시 반응 `say()`를 `await`하면 어떻게 됩니까?
2. TransformStream에서 `flush`를 빼먹으면 `pronunciationTransform`에 어떤 버그가 생깁니까?
3. `withoutLeadingAck`의 보류 길이를 3자로 줄이면 어떤 입력에서 실패합니까?
4. 발음표에 공백이 든 항목("F2 울트라" → "에프투울트라")을 추가하면 `pronunciationTransform`의 무엇이 깨집니까?
5. `LEADING_ACK`에서 `(?=[\s,.!?~]|$)`를 지우면 어떤 문장이 망가집니까? 두 개 이상 쓰세요.
6. `g` 플래그 정규식을 모듈 상수로 만들어 `.test()`에 반복해서 쓰면 왜 위험합니까?

<details>
<summary>답 보기</summary>

1. 즉시 반응 재생이 끝날 때까지 훅이 끝나지 않아, 본 답 생성 시작이 그만큼 늦어집니다. 즉시 반응을 둔 의미가 줄어듭니다.
2. 마지막 공백 뒤에 남은 조각(예: "이에요.")이 내보내지지 않아 답의 끝이 잘립니다.
3. 가장 흔한 "네, 예산은…"부터 실패합니다. 조각 "네"와 ", "가 모여 "네, "(3자)가 된 순간 판단하는데, 맞장구를 떼면 남는 글이 없어 원문을 그대로 내보내기 때문입니다. "네, 감사합니다. …"처럼 긴 맞장구도 일부만 보고 판단하게 됩니다.
4. 공백까지를 확정된 단어로 보고 내보내므로, "F2 "가 먼저 내보내지고 "울트라"는 다음 조각으로 넘어가 "F2 울트라"가 한 덩어리로 보이지 않습니다.
5. "아니요, 그건 아니에요" → "니요, …", "예산은 어느 정도세요?" → "산은 …", "네일 아트용인가요?" → "일 아트용인가요?"
6. `g` 정규식은 `lastIndex` 상태를 가져, 다음 `.test()`가 이전 일치 위치부터 검색하므로 같은 입력에도 결과가 번갈아 달라질 수 있습니다.

</details>
