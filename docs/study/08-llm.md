# 8장. LLM — 대화의 두뇌가 말을 만드는 방식

STT가 고객 말을 글로 바꾸면, LLM이 그 글과 지금까지의 대화를 읽고 다음에 할 말을 만듭니다. 이 프로젝트는 Anthropic의 **Claude Haiku 5.5**(`claude-haiku-5-5`)를 씁니다. 이 장은 LLM이 글을 만드는 원리에서 시작해, **왜 생각 모드를 껐는지, 왜 프롬프트 캐시를 켰는지, 왜 temperature를 보내지 않는지**를 원리로 설명합니다. 마지막으로 플러그인을 감싸 필요한 옵션을 넣는 기법([src/models/anthropic.ts](../../src/models/anthropic.ts))을 해부합니다.

---

## 8-1. LLM은 "다음 토큰"을 맞히는 기계다

### 토큰

LLM은 글자를 그대로 다루지 않고 **토큰**이라는 조각으로 자른 뒤 각 조각을 번호로 바꿉니다. 자주 나오는 문자열은 하나의 토큰이 되고, 드문 문자열은 여러 토큰으로 쪼개집니다(BPE 같은 하위 단어 분할 방식).

```text
"안녕하세요, 고객님."  →  [안녕] [하세요] [,] [ 고객] [님] [.]   (분할 예시일 뿐, 실제 경계는 모델마다 다름)
```

- 영어는 대략 단어 하나가 토큰 1~1.5개입니다. **한국어는 같은 의미를 담는 데 토큰이 더 많이 드는 경향**이 있습니다. 학습 데이터에 영어가 많아 영어 조각이 더 큰 단위로 묶여 있기 때문입니다.
- 비용, 속도, 길이 제한이 모두 토큰 단위로 계산됩니다. "오십 자 안팎으로 말하라"는 지시(9장)가 비용과 속도에도 직결되는 이유입니다.

### 자기회귀 생성

LLM이 하는 일은 단 하나입니다. **지금까지의 토큰을 보고, 다음 토큰의 확률 분포를 계산합니다.** 그중 하나를 뽑아 뒤에 붙이고, 다시 전체를 보고 다음 토큰을 계산합니다. 이것을 반복합니다.

```text
입력: [system 지시문 …] [user: 가격 얼마예요?] [assistant:]
 1단계 → 다음 토큰 후보: "정확" 41%, "가격" 22%, "죄송" 9% …  → "정확" 선택
 2단계 → [... assistant: 정확]  → "한" 88% …                    → "한" 선택
 3단계 → [... assistant: 정확한] → " 금액" 63% …               → " 금액" 선택
 … "담당 상담사가 안내드릴게요." 까지 반복, 끝 토큰이 나오면 멈춤
```

이 방식을 **자기회귀(autoregressive)** 생성이라고 합니다. 두 가지 결과가 따라옵니다.

1. **답은 앞에서부터 한 토큰씩 나옵니다.** 그래서 다 만들기 전에 앞부분을 먼저 TTS로 보낼 수 있습니다(스트리밍). 음성 에이전트의 지연을 줄이는 핵심 성질입니다.
2. **답이 길수록 오래 걸립니다.** 토큰 하나에 일정 시간이 드니, 길이에 비례합니다.

### 트랜스포머와 어텐션 (아주 짧게)

현대 LLM은 **트랜스포머**라는 신경망 구조입니다. 핵심 부품인 **어텐션**은 "지금 다음 토큰을 정할 때, 앞의 어떤 토큰들을 얼마나 참고할지"를 계산합니다. 예를 들어 "F2 울트라 맞으시죠?"를 만들 때 어텐션은 지시문의 "문의 기기: F2 울트라" 부분에 크게 주목합니다. 대화 기록 전체가 매번 입력으로 들어가야 하는 이유가 이것입니다. LLM에는 별도의 기억 장치가 없고, **입력 창(컨텍스트) 안에 있는 것만** 참고할 수 있습니다.

---

## 8-2. 샘플링과 temperature, 그리고 Haiku 5.5의 제약

"확률 분포에서 하나를 뽑는" 방법을 **샘플링**이라고 합니다.

| 파라미터 | 뜻 |
| --- | --- |
| `temperature` | 분포를 뾰족하게(낮을수록 항상 1등만) 또는 평평하게(높을수록 다양하게) 만듭니다 |
| `top_p` | 누적 확률 p 안에 드는 후보들 중에서만 뽑습니다 |
| `top_k` | 상위 k개 후보 중에서만 뽑습니다 |

예전에는 "정확한 답이 필요하면 temperature를 0으로"가 흔한 요령이었습니다. 그런데 **Claude Haiku 5.5는 기본값이 아닌 sampling 값을 보내면 400 오류로 거절합니다.** 그래서 [src/models/anthropic.ts](../../src/models/anthropic.ts)는 `temperature`를 아예 보내지 않고, 테스트가 이를 확인합니다.

```ts
// src/models/anthropic.test.ts
expect(lastBody).not.toHaveProperty('temperature');
```

출력의 일관성은 샘플링 파라미터 대신 **지시문과 예시**(9장), 그리고 **코드 후처리**(`withoutLeadingAck`, 12장)로 확보합니다.

---

## 8-3. 추론의 두 단계: 프리필과 디코드

LLM 서버가 요청 하나를 처리하는 과정은 두 단계로 나뉩니다. 이 구분을 알아야 "첫 토큰 지연(TTFT)"을 이해할 수 있습니다.

```text
요청 도착
  │
  ├─ [대기열] 서버가 바쁘면 차례를 기다림
  │
  ├─ [프리필 prefill]  입력 토큰 전체(지시문 2천여 개 + 대화 기록)를 한꺼번에 처리
  │                     → 병렬 계산이라 빠르지만, 입력이 길수록 오래 걸림
  │                     → 이 단계에서 각 토큰의 "KV" 값을 계산해 둠 (8-4절)
  │
  ├─ (생각 모드라면) [생각 토큰 생성]  보이지 않는 추론 토큰을 수백 개 만듦  ← 8-5절
  │
  ├─ 첫 번째 답 토큰 출력   ◀── 여기까지가 TTFT (Time To First Token)
  │
  └─ [디코드 decode]   토큰을 하나씩 생성 (초당 수십~수백 개, TPS)
                        → 앞 토큰이 나와야 다음을 계산하므로 순차적
```

| 지표 | 뜻 | 음성 에이전트에서의 중요도 |
| --- | --- | --- |
| **TTFT** | 요청부터 첫 답 토큰까지 | **가장 중요.** 첫 토큰이 나와야 TTS가 시작할 수 있음 |
| **TPS** | 디코드 속도(초당 토큰) | 중요도 중간. 답이 짧고(50자), TTS가 말하는 속도가 더 느리므로 대개 따라잡음 |
| 전체 시간 | TTFT + 출력 토큰 수 / TPS | 채팅에선 중요하지만 음성에선 덜 중요 |

음성에서는 TTS가 사람 말 속도(초당 몇 글자)로 재생하므로, LLM이 그보다 빨리 토큰을 만들기만 하면 뒤쪽 생성 시간은 재생에 가려집니다. 그래서 **음성 에이전트의 LLM 선택 기준 1순위는 TTFT**입니다.

PoC 측정에서 한 턴 지연(약 1.4~1.6초) 중 LLM 첫 토큰이 약 0.8~1.0초로 가장 큰 몫이었습니다([poc-results.md](../poc-results.md)). 서울↔미국 왕복 네트워크 시간도 여기에 들어 있습니다.

---

## 8-4. KV 캐시와 프롬프트 캐시

### 요청 안에서의 KV 캐시

어텐션 계산에는 앞 토큰마다 계산한 **키(K)와 값(V)** 벡터가 필요합니다. 디코드 단계에서 토큰을 하나 만들 때마다 앞의 모든 K, V를 다시 계산하면 낭비이므로, 한 번 계산한 것을 메모리에 저장해 둡니다. 이것이 **KV 캐시**입니다. 모든 LLM 서버가 요청 하나 안에서 당연히 씁니다.

### 요청 사이의 프롬프트 캐시

음성 통화에서는 매 턴 요청을 새로 보냅니다. 그런데 입력의 앞부분(지시문 + 이전 대화)은 직전 턴과 똑같습니다. 그렇다면 **이전 요청에서 계산한 KV를 다음 요청이 재사용**할 수 있지 않을까요? 이것이 **프롬프트 캐시**입니다.

```text
턴 1 요청: [지시문 2,384토큰][첫 멘트][user1]
           └──── 캐시에 저장(write) ────┘
턴 2 요청: [지시문 2,384토큰][첫 멘트][user1][assistant1][user2]
           └──── 캐시에서 읽음(read) ───┘└── 새로 계산 ──┘
```

- **접두사(prefix) 일치**: 앞에서부터 **바이트 하나까지 같은 부분**만 재사용됩니다. 중간에 한 글자라도 다르면 그 뒤는 전부 새로 계산합니다. 9장에서 고객 정보를 지시문 맨 뒤에 둔 이유입니다.
- **효과**: 프리필 계산을 건너뛰므로 TTFT가 줄고, 캐시에서 읽은 입력 토큰은 기본 입력 단가의 약 **0.1배**만 냅니다. 처음 쓸 때(write)는 약 1.25배를 냅니다(5분 보관 기준). 두 번째 요청부터 이득입니다.
- **보관 시간(TTL)**: 기본 5분이고, 읽을 때마다 타이머가 다시 시작됩니다. 통화 중에는 턴이 몇 초 간격으로 이어지니 계속 살아 있습니다. 통화와 통화 사이도 5분 안에 다음 통화가 시작되면 지시문 부분을 공유합니다.
- **최소 길이**: 모델마다 캐시 가능한 최소 길이가 있고, Haiku 5.5는 512토큰입니다. 그보다 짧으면 오류 없이 **조용히 캐시되지 않습니다.** 이 프로젝트의 지시문은 그보다 충분히 깁니다.

### 이 프로젝트의 설정: 자동 캐시

Anthropic API에는 캐시 지점을 블록마다 지정하는 방식과, **요청 최상위에 `cache_control` 하나만 두면 마지막 블록까지 자동으로 캐시하는 방식**이 있습니다. 이 프로젝트는 후자를 씁니다.

```ts
// src/models/anthropic.ts (요청 본문에 추가되는 값)
cache_control: { type: 'ephemeral' },
```

자동 캐시는 대화가 길어질 때마다 캐시 지점을 마지막 블록으로 옮겨 줍니다. 그래서 턴 N의 요청은 턴 N-1까지의 대화 전체를 캐시에서 읽습니다.

### 캐시가 동작하는지 확인하는 법

응답의 사용량(usage)에 캐시 정보가 옵니다.

| 필드 (Anthropic API) | 뜻 |
| --- | --- |
| `cache_creation_input_tokens` | 이번에 캐시에 쓴 토큰 |
| `cache_read_input_tokens` | 이번에 캐시에서 읽은 토큰 |
| `input_tokens` | 캐시를 안 거친 입력 토큰 |

LiveKit은 이를 `ChatChunk.usage.promptCachedTokens` 같은 이름으로 옮겨 줍니다. [scripts/check-llm.ts](../../scripts/check-llm.ts)가 `cached tokens` 열에 찍는 값이 이것입니다. PoC에서 2회차부터 2,384토큰이 캐시 적중했습니다. **같은 요청을 반복했는데 이 값이 0이면** 앞부분 어딘가가 매번 바뀌고 있다는 뜻입니다(현재 시각, 무작위 id 등).

---

## 8-5. 생각 모드와 effort: 왜 껐는가

### 생각(추론) 모드란

최신 LLM은 답을 바로 쓰지 않고, 먼저 **보이지 않는 추론 토큰**을 생성한 뒤 답을 쓸 수 있습니다. 어려운 수학이나 코딩에서 정확도를 크게 올립니다. Claude에서는 이를 `thinking` 설정으로 제어합니다.

- `thinking: { type: 'adaptive' }`: 모델이 문제 난이도를 보고 얼마나 생각할지 스스로 정합니다.
- `thinking: { type: 'disabled' }`: 생각하지 않고 바로 답합니다.
- `output_config: { effort: 'low' | 'medium' | 'high' | … }`: 생각의 깊이와 전체 토큰 사용량의 수준을 조절합니다.

**Claude Haiku 5.5의 기본값은 "생각 켬(adaptive), effort medium"**입니다. 그리고 생각을 끄는 `disabled`는 effort가 `high` 이하일 때만 허용됩니다. 그 위의 effort와 같이 보내면 400입니다.

### 생각 토큰은 TTFT에 그대로 더해진다

8-3절의 그림에서 생각 토큰은 **첫 답 토큰보다 먼저** 생성됩니다. 생각 토큰이 400개면, 디코드 속도가 초당 200토큰이라 해도 첫 답 토큰이 2초 늦어집니다. PoC 측정이 정확히 이것을 보여 줍니다.

| 설정 | 첫 토큰 (캐시 후) | 출력 토큰 | 해석 |
| --- | --- | --- | --- |
| **생각 끔 / low** | **0.78~0.84초** | 220개 안팎 | 답 토큰만 |
| 생각 켬 / low | 2.5~3.0초 | 440~540개 | 생각 토큰 200~300개가 앞에 붙음 |
| 생각 켬 / medium | 2.1~3.0초 | 410~530개 | 위와 같음 |

출력 토큰이 두 배가 된 것이 "보이지 않는 생각 토큰"의 흔적입니다. 그리고 **답 품질은 세 설정이 거의 같았습니다.** 상담 첫 통화의 대화는 깊은 추론이 필요한 문제가 아니기 때문입니다. 그래서 기본값을 **생각 끔 + effort low**로 정했습니다([src/config.ts](../../src/config.ts)의 `LLM_THINKING=off`, `LLM_EFFORT=low`).

### 끄는 것의 대가

Anthropic은 일반적으로 "생각을 끄기보다 effort를 낮추라"고 권합니다. 생각을 끈 모델에서 알려진 문제 두 가지가 있습니다.

1. **도구 호출을 말로 흘리는 경우.** 도구 호출 블록 대신 본문에 도구 호출 같은 글을 써서, 실제로는 호출이 안 되고 오류도 나지 않는 경우가 있습니다. [src/agent.ts](../../src/agent.ts) 주석이 이를 대비한 지시문 문장을 미리 적어 두었습니다(9-6절).
2. **생각 블록과 대화 기록.** 생각을 켜면 응답에 생각 블록이 붙는데, LiveKit 플러그인은 대화 기록을 만들 때 이 블록을 버립니다. 도구를 쓰는 대화에서는 이전 생각 블록을 그대로 돌려줘야 하는 경우가 있어, 생각을 켠 채 도구를 붙이면 동작을 보장하기 어렵습니다. 그래서 [src/models/anthropic.ts](../../src/models/anthropic.ts) 주석이 "도구를 붙이면 `off`가 안전하다"고 적어 둔 것입니다.

결론: **지금은 지연 때문에 끄고, 도구를 붙일 때 다시 측정해서 정합니다.** 설정이 환경변수로 열려 있어(`LLM_THINKING`, `LLM_EFFORT`) 코드 수정 없이 비교할 수 있습니다.

---

## 8-6. Messages API의 모양

Anthropic의 대화 API는 대략 이렇게 생겼습니다.

```json
{
  "model": "claude-haiku-5-5",
  "max_tokens": 2048,
  "system": "당신은 주식회사 오리지널스의 AI 상담사입니다. …",
  "messages": [
    { "role": "assistant", "content": "안녕하세요, 김민수 고객님. …" },
    { "role": "user", "content": "네, 괜찮아요." }
  ],
  "thinking": { "type": "disabled" },
  "output_config": { "effort": "low" },
  "cache_control": { "type": "ephemeral" },
  "stream": true
}
```

- **system은 따로**: 지시문은 `messages` 안이 아니라 최상위 `system` 필드에 들어갑니다. LiveKit의 대화 기록(`ChatContext`)에는 지시문이 `system` 역할 메시지로 들어 있고, 플러그인이 이를 꺼내 최상위로 옮깁니다. 대화 중간에 있던 system 메시지도 위치와 상관없이 모두 최상위로 올라갑니다.
- **user와 assistant**: 고객 말은 `user`, 에이전트 말은 `assistant`입니다.
- **`max_tokens: 2048`**: 응답 길이 상한입니다. 답은 50자 안팎이라 한참 남지만, 생각 모드를 켜면 생각 토큰도 여기에 포함되므로 여유를 둡니다([src/models/index.ts](../../src/models/index.ts) 주석).

### prefill 금지와 "." 턴

예전 Claude는 `messages`가 `assistant`로 끝나면 "답을 이 문장으로 시작하라"는 뜻(**prefill**)으로 받아 이어 썼습니다. **Haiku 5.5는 prefill을 지원하지 않아 400을 돌려줍니다.**

음성 에이전트에서는 대화가 assistant로 끝나는 상황이 생길 수 있습니다. 예를 들어 에이전트가 말한 직후 코드가 다시 답을 생성하라고 요청하는 경우입니다. LiveKit Anthropic 플러그인은 이때 끝에 `"."`만 담은 user 턴을 붙여 prefill이 되지 않게 합니다. 프로젝트 테스트가 이 동작을 고정합니다.

```ts
// src/models/anthropic.test.ts
it('대화가 assistant로 끝나도 prefill이 되지 않게 user 턴으로 끝난다', async () => {
  // system + assistant만 있는 대화로 요청
  const messages = lastBody.messages as { role: string }[];
  expect(messages.at(-1)?.role).toBe('user');
});
```

### 플러그인이 실제로 만드는 요청의 모양

플러그인 코드(`agents-plugin-anthropic/src/llm.ts`)를 따라가면, 이 프로젝트의 요청은 위 예시와 조금 다릅니다.

| 플러그인 동작 | 이 프로젝트에서 일어나는 일 |
| --- | --- |
| 첫 메시지가 user가 아니면 맨 앞에 `{role: 'user', content: '(empty)'}`를 넣음 | 첫 멘트(`session.say`)가 assistant로 먼저 기록되므로 **매 요청이 `(empty)` user 턴으로 시작**합니다 |
| 같은 역할이 연속되면 하나로 합침 | 첫 멘트 두 문장(고지 + 질문)이 assistant 메시지 하나로 합쳐집니다 |
| 마지막이 assistant면 `"."` user 턴을 붙임 | prefill 400 방지 |
| user·assistant 메시지는 글(`rawTextContent`)만 씀 | 이미지·오디오 내용은 조용히 버려집니다 (이 프로젝트는 글만 쓰므로 영향 없음) |
| 도구 호출은 `tool_use`, 도구 결과는 `tool_result` 블록으로 변환 | 도구를 붙이면 쓰입니다 |
| 최종 본문 = `{model, messages, system, tools, stream: true, max_tokens, ...extraKwargs}` | **extraKwargs가 맨 마지막에 펼쳐져서** `thinking`·`output_config`·`cache_control`이 그대로 들어갑니다. 반대로 말하면 extraKwargs로 `model`이나 `max_tokens`까지 덮어쓸 수 있으니 조심해야 합니다 |

`(empty)` 턴은 이상해 보이지만 대화 기록 맨 앞에 고정되어 매번 같으므로, 프롬프트 캐시를 깨지는 않습니다.

### 스트리밍 응답: SSE 이벤트

`stream: true`면 응답이 한 번에 오지 않고 **SSE(Server-Sent Events)**로 조각조각 옵니다. SSE는 HTTP 응답을 끊지 않고 `event:`/`data:` 줄을 계속 흘려보내는 단순한 형식입니다.

```text
event: message_start          ← 메시지 시작, 입력 토큰 사용량
event: content_block_start    ← 블록 시작 (thinking 또는 text 또는 tool_use)
event: content_block_delta    ← 조각: text_delta / thinking_delta / signature_delta / input_json_delta
event: content_block_delta
…
event: content_block_stop
event: message_delta          ← stop_reason(end_turn 등), 출력 토큰 사용량
event: message_stop
```

플러그인은 이 이벤트를 다음과 같이 LiveKit의 `ChatChunk`로 바꿉니다.

| 이벤트 | 플러그인 처리 |
| --- | --- |
| `message_start` | 입력 토큰, 캐시 쓰기·읽기 토큰을 기억 |
| `text_delta` | `{ delta: { role: 'assistant', content } }` 청크로 내보냄 → TTS로 흘러감 |
| `content_block_start(tool_use)` + `input_json_delta` | JSON 조각을 모았다가 블록이 끝나면 도구 호출 청크 하나로 내보냄 |
| 생각 블록(`thinking_delta`, `signature_delta`) | **어느 분기에도 걸리지 않아 버려짐.** 내보내지도, 대화 기록에 저장하지도 않음 |
| 스트림 끝 | 사용량 청크 하나: `promptTokens = 입력 + 캐시 쓰기 + 캐시 읽기`, `promptCachedTokens = 캐시 읽기`, `completionTokens = 출력(생각 토큰 포함)` |

생각 블록이 버려진다는 사실이 8-5절의 "도구를 붙이면 생각 끔이 안전하다"는 판단의 코드상 근거입니다.

[src/models/anthropic.test.ts](../../src/models/anthropic.test.ts)는 이 이벤트들을 **직접 만들어 돌려주는 가짜 서버**를 띄웁니다. 생각 블록(thinking + signature) 다음에 텍스트 블록이 오는 응답을 흉내 내고, 플러그인이 **텍스트만 꺼내 "네, 좋아요."를 돌려주는지** 확인합니다. 생각 내용이 음성으로 새어 나가지 않는다는 보장입니다. 이 테스트 기법은 14장에서 다시 다룹니다.

---

## 8-7. LiveKit의 LLM 추상화

LiveKit Agents는 공급사마다 다른 API를 하나의 인터페이스로 감쌉니다.

```text
llm.LLM (추상 클래스)
 ├─ chat({ chatCtx, toolCtx, extraKwargs, … }) → LLMStream
 │
 ├─ @livekit/agents-plugin-anthropic 의 LLM   ← Anthropic Messages API
 ├─ inference.LLM                              ← LiveKit Inference (GPT-6 Luna 등)
 └─ … (OpenAI, Google 등 플러그인)

LLMStream = AsyncIterable<ChatChunk>
ChatChunk = {
  id,
  delta?: { role, content?: string, toolCalls?: FunctionCall[] },   ← 글 조각 / 도구 호출
  usage?: { promptTokens, completionTokens, promptCachedTokens, … } ← 사용량
}
```

- **`ChatContext`**: 대화 기록입니다. `ChatMessage`(role, content 배열), 도구 호출, 도구 결과 같은 항목의 목록입니다.
- **`LLMStream`**: `for await`로 순회하는 비동기 스트림입니다(12장). 한 조각씩 받아서 바로 TTS 쪽으로 넘깁니다.
- 공급사를 바꿔도 에이전트 코드는 그대로입니다. [src/models/index.ts](../../src/models/index.ts)의 `createLLM()`이 환경변수에 따라 Anthropic 플러그인 또는 LiveKit Inference를 고를 뿐입니다(15장).

---

## 8-8. 기법: 플러그인이 지원하지 않는 옵션을 넣는 법

### 문제

Anthropic 플러그인 1.9.5의 생성자에는 `thinking`, `effort`, 자동 캐시 옵션이 없습니다. 그런데 Haiku 5.5를 음성용으로 쓰려면 셋 다 필요합니다.

### 발견

플러그인 코드를 읽어 보니, `chat()`이 받는 `extraKwargs`를 **요청 본문에 그대로 펼쳐 넣습니다.** 원래는 공급사별 추가 옵션을 넘기라고 열어 둔 통로입니다.

### 해결: 상속으로 감싸기

```ts
// src/models/anthropic.ts
export class VoiceAnthropicLLM extends anthropic.LLM {
  #extra: Record<string, unknown>;

  constructor({ effort, thinking, ...opts }: VoiceAnthropicOptions) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    super({ ...opts, ...(apiKey ? { apiKey } : {}) });
    this.#extra = {
      thinking: thinking === 'off' ? { type: 'disabled' } : { type: 'adaptive' },
      output_config: { effort },
      cache_control: { type: 'ephemeral' },
    };
  }

  override chat(args: Parameters<anthropic.LLM['chat']>[0]) {
    return super.chat({ ...args, extraKwargs: { ...this.#extra, ...args.extraKwargs } });
  }
}
```

한 줄씩 보면 배울 것이 많습니다.

| 코드 | 의미 |
| --- | --- |
| `extends anthropic.LLM` | 플러그인을 고치지 않고 **바깥에서** 동작을 덧붙입니다. 플러그인을 업그레이드해도 이 클래스는 그대로입니다 |
| `{ effort, thinking, ...opts }` | 우리만 쓰는 옵션 둘을 떼고 나머지는 부모에게 그대로 넘깁니다 |
| `#extra` | JavaScript의 **진짜 private 필드**입니다(`private` 키워드와 달리 런타임에도 밖에서 접근 불가). 부모 클래스의 필드 이름과 충돌할 걱정도 없습니다 |
| `override chat(...)` | tsconfig의 `noImplicitOverride` 때문에 `override`를 명시해야 합니다. 부모 메서드 이름이 바뀌면 컴파일 오류로 알려 줍니다 |
| `Parameters<anthropic.LLM['chat']>[0]` | 부모 `chat`의 첫 인자 타입을 **그대로 가져옵니다.** 타입을 직접 다시 쓰지 않아 플러그인이 바뀌어도 따라갑니다 |
| `{ ...this.#extra, ...args.extraKwargs }` | 순서가 중요합니다. 호출하는 쪽이 같은 키를 주면 **호출자가 이깁니다.** 기본값은 우리가, 예외는 호출자가 정하는 구조입니다 |

이 클래스는 LiveKit의 `llm.LLM` 인터페이스를 그대로 만족하므로, 세션 입장에서는 일반 Anthropic LLM과 구분되지 않습니다. 그리고 **정말로 요청 본문에 값이 들어가는지**는 가짜 서버 테스트(8-6절)로 확인합니다. 문서를 믿지 않고 실제 바이트를 검사하는 것이 핵심입니다.

### 함정: import 시점에 읽는 환경변수

생성자의 이 줄에 주목하세요.

```ts
// 플러그인은 import 시점에 ANTHROPIC_API_KEY를 읽어 두므로, dotenv 이후 값으로 다시 넘깁니다.
const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
```

왜 이런 문제가 생길까요? **ES 모듈의 평가 순서** 때문입니다.

```ts
// src/main.ts
import ... from '@livekit/agents';          // ← 1. import된 모듈이 먼저 전부 평가됨
import { createLLM, ... } from './models/index.ts';   //    (플러그인 모듈의 최상위 코드도 이때 실행)
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });      // ← 2. 그다음에야 본문 실행: .env.local을 읽음
```

`import` 문은 파일 어디에 쓰든 **본문 코드보다 먼저** 처리됩니다(호이스팅). 그래서 플러그인 모듈이 최상위에서 `process.env.ANTHROPIC_API_KEY`를 읽어 기본값으로 저장해 두면, 그 시점에는 아직 `.env.local`이 읽히지 않아 값이 비어 있습니다. 해결은 **값이 채워진 뒤(생성자 호출 시점)에 다시 읽어서 명시적으로 넘기는 것**입니다. Soniox 플러그인도 같은 문제가 있어 같은 방법으로 고쳤습니다([poc-results.md](../poc-results.md) "고친 버그", [src/models/index.ts](../../src/models/index.ts)). [src/config.ts](../../src/config.ts)의 `loadConfig()`가 "dotenv를 읽은 뒤에 호출합니다"라고 주석을 단 것도 같은 이유입니다.

---

## 8-9. 측정 도구: check-llm

[scripts/check-llm.ts](../../scripts/check-llm.ts)는 LLM 하나만 떼어 지연을 잽니다. 음성 전체를 돌리지 않고 LLM만 재는 이유는 **변수를 하나로 줄이기 위해서**입니다.

- 실제 지시문(`buildInstructions(SAMPLE_CALL)`)과 첫 멘트, 가격을 묻는 고객 대사로 대화를 만듭니다.
- 생각 모드·effort 조합 세 가지를 각각 N번 돌립니다.
- 측정 항목: 첫 토큰 시간, 전체 시간, 출력 토큰 수, 캐시 토큰 수, 답 길이.
- 첫 회는 캐시를 쓰는(write) 회차라 느리고, 2회차부터가 실제 통화 중 상황에 가깝습니다.
- API 오류는 스트림이 아니라 `error` 이벤트로 오기 때문에 `model.on('error', …)`로 잡아 바로 종료합니다. 400(설정 거절)을 놓치지 않기 위해서입니다.

`performance.now()`로 시간을 재고 `??=`(값이 없을 때만 대입)로 첫 토큰 시각을 한 번만 기록하는 패턴도 눈여겨볼 만합니다.

```ts
if (chunk.delta?.content) {
  firstToken ??= performance.now() - started;
  text += chunk.delta.content;
}
```

---

## 8-10. 모델 선택과 역할 분리

### Haiku 5.5 vs GPT-6 Luna

| | Haiku 5.5 (생각 끔, low) | GPT-6 Luna |
| --- | --- | --- |
| 첫 토큰 | 0.77~0.92초 | 0.72~1.37초 |
| 평균 답 길이 | 77자 | 54자 |
| 대화 품질 | 순서대로 진행 | 이미 답한 질문을 반복 |

가격은 둘 다 입력 $0.10 / 출력 $0.50(1M 토큰당)으로 같습니다. 더 빠르고 **지시를 일관되게 지키는** Haiku 5.5를 골랐습니다. 다만 한 번씩 돌린 결과라 표본이 작다는 점을 문서에 적어 두었습니다. LLM 비교는 출력이 확률적이라 **여러 번, 여러 시나리오로** 돌려야 믿을 수 있습니다(14장).

### 통화 중 모델과 통화 후 모델

| | 통화 중 | 통화 후 (요약·판정 추출) |
| --- | --- | --- |
| 우선순위 | 지연 | 정확도 |
| 모델 | 작고 빠른 모델, 생각 끔 | 더 크고 똑똑한 모델, 생각 켬 가능 |
| 위치 | 이 레포 (워커) | functions-xtool (예정) |

통화 후 처리는 고객이 기다리지 않으므로 몇 초 걸려도 됩니다. 한 모델로 두 일을 다 하려고 타협하지 않고 **일의 성격에 따라 모델을 나누는 것**이 비용과 품질을 모두 잡는 방법입니다([tech-stack.md 4-3](../tech-stack.md#4-3-llm-대화-두뇌)).

---

## 확인 문제

1. 음성 에이전트에서 LLM의 TTFT가 전체 생성 시간보다 중요한 이유는 무엇입니까?
2. 생각 모드를 켰을 때 출력 토큰이 220개에서 500개 안팎으로 늘었습니다. 이것이 첫 토큰 지연과 어떤 관계가 있습니까?
3. 프롬프트 캐시가 "접두사 일치"라는 것은 무슨 뜻이며, 지시문 설계에 어떤 제약을 줍니까?
4. `VoiceAnthropicLLM.chat()`에서 `{ ...this.#extra, ...args.extraKwargs }`의 순서를 반대로 쓰면 무엇이 달라집니까?
5. 플러그인이 import 시점에 API 키를 읽으면 왜 키를 못 찾습니까? `main.ts`의 코드 순서로 설명해 보세요.
6. Haiku 5.5에 `temperature: 0`을 보내면 어떻게 됩니까?

<details>
<summary>답 보기</summary>

1. 첫 토큰이 나와야 TTS가 소리를 만들기 시작하고, 이후 생성은 TTS 재생 속도보다 빨라 재생 시간에 가려지기 때문입니다.
2. 생각 토큰은 첫 답 토큰보다 먼저 생성되므로, 늘어난 토큰 수만큼 첫 토큰이 늦어집니다(0.8초 → 2.5~3.0초).
3. 앞부분이 바이트 단위로 같아야 재사용됩니다. 그래서 바뀌지 않는 내용을 앞에, 통화마다 바뀌는 내용을 뒤에 두어야 합니다.
4. 우리 기본값이 호출자가 준 값을 덮어쓰게 됩니다. 지금 순서는 호출자가 이깁니다.
5. import는 본문보다 먼저 평가되어 플러그인 모듈의 최상위 코드가 `dotenv.config()` 전에 실행되기 때문입니다.
6. 기본값이 아닌 sampling 값이라 400 오류로 거절됩니다.

</details>
