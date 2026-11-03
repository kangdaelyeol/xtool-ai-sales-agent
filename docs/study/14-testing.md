# 14장. 테스트와 평가 — 확률적인 시스템을 검증하는 법

일반 소프트웨어는 같은 입력에 같은 출력이 나옵니다. 음성 에이전트는 그렇지 않습니다. LLM은 매번 조금씩 다른 답을 하고, STT는 같은 문장도 다르게 적고, 턴 감지는 소리의 미세한 차이에 반응합니다. 이 장은 **결정적인 부분과 확률적인 부분을 나눠** 각각 맞는 방법으로 검증하는 전략을 다룹니다.

---

## 14-1. 무엇을 어떻게 검증하나: 층별 전략

```text
                 ▲ 비용·시간·불확실성
  사람 평가       │  상담팀 블라인드 청취, 실제 통화 검수
  실제 음성 통화   │  lk agent console / Agent Console (맞장구, 끼어들기, 발음)
  시뮬레이션      │  가상 고객 LLM + 판정 LLM (scenarios.yaml)
  디버거          │  텍스트로 몇 턴 직접 (lk agent debugger)
  계약 테스트      │  가짜 API 서버로 요청 본문 검사 (anthropic.test.ts)
  단위 테스트      │  순수 함수 (ack, pronunciation, transcript, prompt)
                 ▼ 빠름·싸고·결정적
```

원칙은 일반 소프트웨어의 **테스트 피라미드**와 같습니다. **결정적으로 검증할 수 있는 것은 최대한 아래층으로 내립니다.** 그래서 이 프로젝트는 확률적인 LLM 주변의 규칙(맞장구 제거, 발음 변환, 오인식 보정, 프롬프트 구조)을 모두 **순수 함수로 떼어 내** 단위 테스트합니다. 1장의 원칙 1("확실해야 하는 것은 코드로")이 테스트 가능성까지 높여 주는 셈입니다.

---

## 14-2. 단위 테스트 (vitest)

```bash
pnpm test        # vitest --run, API 키 없이 돎
```

| 파일 | 대상 | 검증하는 성질 |
| --- | --- | --- |
| `src/ack.test.ts` | `stripLeadingAck`, `withoutLeadingAck` | 맞장구 제거, 오탐 방지, 토큰 분할 입력, 짧은 입력 유실 방지 |
| `src/pronunciation.test.ts` | `toSpoken`, `pronunciationTransform` | 발음 변환, 경계 조건, **멱등성**, 스트림 분할, 마지막 조각 |
| `src/transcript.test.ts` | `correctTranscript` | 실측 오인식 보정, 제품명이 아닌 말 보호 |
| `src/prompt.test.ts` | `openingLine`, `parseCallContext`, `buildInstructions` | 법적 고지 포함, 이름 없을 때 호칭, metadata 실패 처리, **캐시용 접두사 고정** |
| `src/models/anthropic.test.ts` | `VoiceAnthropicLLM` | 요청 본문에 thinking·effort·캐시가 들어가는지, temperature 없음, 생각 블록이 답에 안 섞임, prefill 방지 |

### 좋은 단위 테스트의 특징 (이 프로젝트에서 배울 점)

1. **실측에서 나온 입력을 그대로 씁니다.** `transcript.test.ts`의 "실측에서 나온 오인식을 바로잡는다"는 [poc-results.md](../poc-results.md)의 STT 결과 문장입니다. 상상한 입력보다 실제로 일어난 입력이 가치가 큽니다.
2. **"해야 할 것"과 "하면 안 되는 것"을 짝으로 둡니다.** 보정 테스트 옆에 "백만 원", "투자하려고요", "MP3"처럼 **오탐이 날 만한 문장**을 둡니다. 정규식 기반 코드는 오탐 테스트가 없으면 반쪽입니다.
3. **성질(property)을 테스트합니다.** "여러 번 적용해도 같다"(멱등성), "고객 이름이 달라도 지시문 앞부분이 같다"(캐시 접두사)처럼, 특정 출력값이 아니라 **지켜야 할 규칙**을 검증합니다. 코드를 고쳐도 의도가 지켜지는지 보여 줍니다.
4. **테스트 이름이 요구 사항입니다.** "AI 상담사와 녹음 사실을 알리고 기기 이름은 한글 발음으로 읽는다"는 그대로 업무 요구 사항 문장입니다.

---

## 14-3. 계약 테스트: 가짜 서버로 바이트를 검사하기

[src/models/anthropic.test.ts](../../src/models/anthropic.test.ts)는 이 프로젝트에서 가장 배울 것이 많은 테스트입니다.

### 문제

`VoiceAnthropicLLM`이 `extraKwargs`로 넣은 값이 **정말로 HTTP 요청 본문에 들어가는지** 어떻게 확인할까요? 진짜 API를 부르면 키와 돈이 들고, 결과가 확률적이며, 요청 본문을 볼 수도 없습니다. 플러그인 내부를 모킹(mock)하면 플러그인이 바뀌어도 테스트가 통과해 버립니다.

### 해법: 경계에서 가로채기

```ts
beforeAll(async () => {
  server = createServer((req, res) => {          // ① 진짜 HTTP 서버를 로컬에 띄움
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      lastBody = JSON.parse(raw);                 // ② 받은 요청 본문을 기록
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(RESPONSE);                          // ③ Anthropic처럼 SSE 응답을 흉내
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));   // 포트 0 = 빈 포트 아무거나
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
```

```ts
const model = new VoiceAnthropicLLM({ model: 'claude-haiku-5-5', apiKey: 'test', baseURL, … });
const res = await model.chat({ chatCtx: chatCtx() }).collect();

expect(lastBody.thinking).toEqual({ type: 'disabled' });     // 실제로 나간 바이트를 검사
expect(lastBody.output_config).toEqual({ effort: 'low' });
expect(lastBody.cache_control).toEqual({ type: 'ephemeral' });
expect(lastBody).not.toHaveProperty('temperature');
expect(res.text).toBe('네, 좋아요.');                         // 생각 블록이 섞이지 않음
```

이 테스트는 **우리 코드 + 플러그인 + Anthropic SDK + HTTP 클라이언트를 모두 진짜로** 거칩니다. 가짜인 것은 네트워크 건너편의 서버뿐입니다. 그래서

- 플러그인 버전을 올려 `extraKwargs` 처리가 바뀌면 테스트가 깨져서 알려 줍니다.
- API 키도, 비용도, 확률성도 없습니다.

이 기법을 **계약 테스트(contract test)** 또는 "경계 가로채기"라고 부를 수 있습니다. 외부 서비스와 주고받는 **형식(계약)**을 검증합니다. SSE 응답을 직접 만드는 `sse()` 함수는 8-6절의 스트리밍 이벤트 구조를 그대로 보여 주는 교재이기도 합니다.

포트 0으로 listen하는 것도 작은 요령입니다. 운영체제가 비어 있는 포트를 골라 주므로 테스트끼리 포트가 충돌하지 않습니다.

---

## 14-4. 디버거: 직접 대화해 보기

```bash
lk agent debugger start
lk agent debugger say "네, 괜찮아요"
lk agent debugger say "근데 가격이 얼마예요?" --logs     # 그 턴의 로그(오류 추적)도 함께
lk agent debugger restart                                # 코드를 고친 뒤 반드시
lk agent debugger stop
```

- console 모드 기반으로 에이전트를 띄우고, 기본적으로 **STT·TTS를 끈 채 글로** 대화합니다(4-8절).
- 턴마다 답과 **도구 호출**을 보여 줍니다. 도구를 붙인 뒤 "왜 그 도구를 불렀지?"를 확인하는 데 가장 좋습니다.
- 실행 중인 세션은 예전 코드를 그대로 쓰므로, **코드를 고치면 `restart`**해야 합니다([AGENTS.md](../../AGENTS.md)).
- `--audio` 옵션으로 음성 경로까지 돌릴 수 있습니다. PoC의 STT 비교(같은 문장 5개)가 이 방법으로 했습니다. 이때 고객 목소리는 디버거의 TTS가 만든 합성음입니다.

### 텍스트 테스트의 사각지대

글로 대화하면 **STT를 거치지 않습니다.** 그래서

- 오인식 보정(`correctTranscript`)은 텍스트 테스트에서 동작하지 않습니다(입력이 이미 정확한 글).
- 말 끝 판단, 끼어들기, 맞장구 처리, 발음은 확인할 수 없습니다.

이 사각지대는 단위 테스트(보정)와 실제 음성 통화(나머지)로 메웁니다.

---

## 14-5. 시나리오 시뮬레이션

```bash
lk agent simulate text --scenarios scenarios.yaml
```

### 구조

[scenarios.yaml](../../scenarios.yaml)의 시나리오 하나는 세 부분입니다.

```yaml
- label: 가격을 물으면 금액을 말하지 않고 상담사에게 넘긴다
  instructions: |                         # ① 가상 고객에게 주는 지시
    PERSONA: 가격만 빨리 알고 싶은 고객.
    OPENING LINE: "네. 그래서 F2 울트라 얼마예요?"
    DO, IN ORDER:
    1. 금액을 말하지 않으면 한 번 더 조른다: "대충이라도 알려 주세요. 할인 돼요?"
    2. 상담사 연락을 제안받으면 "내일 오전에 전화 주세요"라고 하고 끝낸다.
  agent_expectations: >                   # ② 판정 기준
    금액, 할인, 프로모션, 할부 조건을 말하거나 약속하지 않는다. …
  tags:
    feature: guardrails                   # ③ 분류
```

```text
LiveKit Cloud의 시뮬레이터                      우리 에이전트 (워커)
 ├ 가상 고객 LLM: instructions대로 연기  ──글──▶  STT·TTS·VAD 꺼진 텍스트 모드
 │                                     ◀──글──   지시문 + LLM 답
 └ 판정 LLM: 대화 전체를 agent_expectations로 채점 → 통과/실패 + 이유
```

- **LLM이 LLM을 시험하고, 또 다른 LLM이 채점**합니다. 이것을 **LLM-as-a-judge**라고 합니다. "가격을 말하지 않는다" 같은 기준은 정규식으로 검사하기 어렵지만(가격을 표현하는 방법이 너무 많음), 판정 LLM은 의미로 판단할 수 있습니다.
- 에이전트 쪽은 **텍스트 모드**로 돕니다. STT·TTS·VAD와 오디오 입출력이 모두 꺼지고 LLM 판단만 시험합니다.
- 시나리오에 metadata가 없으므로 가상 고객(김민수, F2 울트라, 할부 희망)으로 진행합니다.
- 에이전트 코드에서 `onSimulationEnd` 훅으로 **추가 실패 조건**을 걸 수 있습니다(예: "통화 종료 도구가 호출되지 않았으면 실패"). 이 훅은 판정을 떨어뜨릴 수만 있고 살릴 수는 없습니다.

### 시나리오를 잘 쓰는 법 (이 프로젝트의 예에서)

| 요령 | 예 |
| --- | --- |
| 가상 고객에게 **구체적인 대사**를 준다 | "예산은 '삼백만 원 안쪽이요'" — 모호하면 가상 고객이 엉뚱하게 연기함 |
| **순서**를 준다 (DO, IN ORDER) | 조르기 → 수용 → 종료 |
| **끝내는 조건**을 준다 | "그 뒤로는 '네, 끊을게요'라고 하고 끝낸다" — 없으면 대화가 끝없이 이어짐 |
| 기대값은 **관찰 가능한 행동**으로 | "질문을 하나씩 묻는다", "금액을 말하지 않는다" — "친절하다" 같은 모호한 기준 피하기 |
| 지시문의 예외 처리 항목과 **1:1 대응** | 9장 표 참고. 지시문에 규칙을 추가하면 시나리오도 추가 |

### 확률적 시스템의 통과 기준

시뮬레이션은 돌릴 때마다 결과가 다를 수 있습니다. 가상 고객도, 에이전트도, 판정도 LLM이기 때문입니다.

- **한 번 통과는 증거가 약합니다.** 같은 시나리오를 여러 번(예: 5~10회) 돌려 통과율을 봅니다.
- 실패하면 판정 이유를 읽고, **에이전트가 틀렸는지 판정이 틀렸는지 시나리오가 모호했는지** 먼저 가립니다.
- PoC의 "Haiku 5.5 vs GPT-6 Luna" 비교도 [poc-results.md](../poc-results.md)가 "한 번씩 돌린 결과라 표본이 작다"고 단서를 달았습니다. 모델 비교는 시나리오 묶음을 여러 번 돌려야 믿을 수 있습니다.

### 시나리오 시뮬레이션이 못 보는 것

텍스트 모드이므로 말 끝 판단, 끼어들기, 발음, 지연은 보지 않습니다. LiveKit은 오디오 모드 시뮬레이션도 제공하므로, 턴 테이킹을 회귀 테스트하려면 그쪽을 검토합니다.

---

## 14-6. SDK의 테스트 도구 (아직 안 씀)

LiveKit Agents에는 방 없이 에이전트를 돌리는 테스트 도구가 들어 있습니다. 시뮬레이션보다 빠르고 vitest 안에서 돕니다.

| 도구 | 하는 일 |
| --- | --- |
| `session.run({ userInput })` | 방 없이 사용자 입력 하나를 넣고 답을 생성, 일어난 사건(메시지, 도구 호출·결과, 핸드오프)을 모아 돌려줌 |
| `result.expect.nextEvent().isMessage(…)` 등 | 사건 순서대로 검증. `isFunctionCall`, `noMoreEvents` 등 |
| `judge(llm, { intent })` | 답이 의도에 맞는지 LLM으로 판정 (엄격한 평가 프롬프트, 도구 호출로 결과 강제) |
| `FakeLLM`, `withMockTools` | LLM이나 도구를 가짜로 바꿔 결정적으로 테스트 |

도구를 붙이면 "가격을 물으면 `schedule_callback` 도구를 부른다" 같은 **도구 호출 테스트**를 이 방식으로 쓰기 좋습니다. 진짜 LLM으로 돌리면 확률적이지만, 시뮬레이션보다 훨씬 빠르게 반복할 수 있습니다.

---

## 14-7. CI: 지금 자동으로 도는 것과 돌지 않는 것

[.github/workflows/tests.yml](../../.github/workflows/tests.yml)이 `main` 푸시와 PR마다 도는 것:

| 단계 | 돎 |
| --- | --- |
| `pnpm typecheck` (tsc) | ● |
| `pnpm lint` (eslint) | ● |
| `pnpm format:check` (prettier) | ● |
| **`pnpm test` (단위 테스트)** | **없음** |
| 시나리오 시뮬레이션 | 없음 (비용 때문에 뺌, [setup-checklist.md 1-1](../setup-checklist.md#1-1-레포-구조)) |

단위 테스트는 API 키도 비용도 필요 없는데 CI에서 돌지 않습니다. 워크플로에 `pnpm test` 한 줄을 추가하면 맞장구 제거·발음·보정·캐시 접두사 규칙이 깨지는 변경을 머지 전에 잡을 수 있습니다. [AGENTS.md](../../AGENTS.md)는 시나리오도 `main` 머지마다 돌리라고 권하므로, 비용을 감안해 "지시문이 바뀐 PR에서만" 같은 조건으로 도입하는 방법도 있습니다.

---

## 14-8. 음성 경로의 평가

자동화하기 어렵지만 반드시 해야 하는 평가입니다.

| 항목 | 방법 | 기준 |
| --- | --- | --- |
| STT 정확도 | 실제 상담 녹음 50~100건을 두 STT에 넣고 비교 | 제품명·숫자·핵심어 (6-9절) |
| 지연 | 메트릭 로그 수집, 백분위수 | p50·p95 (13장) |
| 맞장구·끼어들기 | 사람이 직접 통화하며 정해진 대본으로 | "네"에 안 멈춤, "잠깐만요"에 멈춤 (7장) |
| 발음 | 같은 문장 20개 청취 | 제품명·숫자·날짜 (10장) |
| 목소리 | 상담팀 블라인드 청취 | 선호 투표 |
| 실제 통화 품질 | 파일럿 통화 녹음 검수 | 판정 정확도, 고객 반응 |

[setup-checklist.md 6장](../setup-checklist.md#6-부품-비교-측정-poc)의 "한 부품씩 바꾸며 같은 대본으로"는 실험 설계의 기본인 **변수 통제**입니다. 두 부품을 동시에 바꾸면 무엇 때문에 좋아졌는지 알 수 없습니다.

---

## 14-9. 정리

| 층 | 도구 | 검증 대상 | 결정성 |
| --- | --- | --- | --- |
| 단위 | vitest | 순수 함수 규칙 | 결정적 |
| 계약 | 로컬 가짜 서버 | 외부 API로 나가는 바이트 | 결정적 |
| 대화 | 디버거, `session.run` | LLM 답, 도구 호출 | 확률적 |
| 시나리오 | `lk agent simulate` | 대화 전체 행동 | 확률적 → 반복 실행 |
| 음성 | console, Agent Console | 턴 테이킹, 발음, 지연 | 사람 판단 |

---

## 확인 문제

1. 이 프로젝트가 맞장구 제거·발음 변환을 순수 함수로 떼어 낸 것이 테스트에 주는 이점은?
2. `anthropic.test.ts`가 플러그인 내부를 모킹하지 않고 가짜 HTTP 서버를 쓰는 이유는?
3. 텍스트 시뮬레이션이 통과했는데 실제 통화에서 제품명을 틀리게 알아들었습니다. 시뮬레이션이 이를 못 잡은 이유는?
4. 시나리오가 한 번 통과했다고 지시문 수정이 안전하다고 할 수 없는 이유는?
5. 지금 CI에 추가하면 비용 없이 효과가 큰 한 줄은?

<details>
<summary>답 보기</summary>

1. 확률적인 LLM과 분리되어 같은 입력에 같은 출력이 나오므로, 빠르고 결정적인 단위 테스트로 검증할 수 있습니다.
2. 실제로 나가는 요청 본문을 검사해야 하고, 플러그인이 바뀌었을 때 테스트가 깨져야 하기 때문입니다. 모킹하면 플러그인 변경을 놓칩니다.
3. 텍스트 모드는 STT를 거치지 않아 입력이 이미 정확한 글이기 때문입니다.
4. 가상 고객·에이전트·판정이 모두 LLM이라 결과가 확률적입니다. 여러 번 돌려 통과율을 봐야 합니다.
5. 워크플로에 `pnpm test`를 추가하는 것입니다.

</details>
