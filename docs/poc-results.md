# PoC 측정 기록

브라우저 PoC에서 잰 값을 날짜순으로 쌓습니다. 기준은 [poc-setup.md 4장](poc-setup.md#4-poc에서-확인할-것)이고, 측정 방법은 [setup-checklist.md 5장](setup-checklist.md#5-검증-순서)에 있습니다.

> 측정 환경: 맥(M1 Pro, 서울) → 해외 API. 서버를 GCP 서울에 두면 값이 달라질 수 있습니다.

---

## 2026-11-03 첫 측정

### 구성

| 부품 | 사용한 것 |
|---|---|
| STT | LiveKit Inference `deepgram/nova-3` (Soniox 키 받기 전 임시) |
| LLM | `claude-haiku-5-5`, 생각 모드 끔, effort low |
| TTS | ElevenLabs `eleven_v4_turbo`, 음성 Rosa Oh (`sf8Bpb1IU97NI9BHSMRf`) |
| 턴 감지 | `inference.TurnDetector`, 번들 Silero VAD |

### LLM 단독 (`pnpm check:llm`, 조합마다 3회)

| 설정 | 첫 토큰 (2·3회차, 캐시 후) | 출력 토큰 | 판단 |
|---|---|---|---|
| **생각 끔 / low** | **0.78~0.84초** | 220개 안팎 | **기본값으로 확정** |
| 생각 켬 / low | 2.5~3.0초 | 440~540개 | 생각 토큰 때문에 3배 이상 느림 |
| 생각 켬 / medium | 2.1~3.0초 | 410~530개 | 위와 같음 |

- 프롬프트 캐시: 2회차부터 2,384토큰 캐시 적중.
- 답 품질은 세 설정이 거의 같았습니다. 가격 질문에 금액을 말하지 않고 담당 상담사에게 넘겼습니다.

### 음성 전체 경로 (`lk agent debugger --audio`, 한 턴)

| 구간 | 값 | 목표 |
|---|---|---|
| 말 끝 판단 (STT 확정 포함) | 0.47초 | 0.3~0.5초 |
| LLM 첫 토큰 | 0.96초 | 0.2~0.4초 |
| TTS 첫 음성 | 0.17초 | 0.1~0.2초 |
| **합계** | **약 1.6초** | 1초 안팎 |

→ **병목은 LLM 첫 토큰**입니다. 줄일 후보:
- GPT-6 Luna와 비교 (`LLM_PROVIDER=livekit`)
- 워커를 GCP 서울에 두고 재기
- 답을 짧게 (아래 대화 품질 참고)

### 대화 품질 (텍스트, 판정 흐름 한 통화)

- 첫 멘트(고정 문장, AI·녹음 고지)부터 판정 질문 8개, 마무리 요약까지 끝까지 진행됐습니다.
- 질문은 한 번에 하나씩 묻고, 고객이 답한 것은 다시 묻지 않았습니다. 가격·할인은 상담사에게 넘겼고, 방문체험은 희망 일시만 받았습니다.
- **고칠 점:**
  - 한 번에 3~4문장으로 말할 때가 있습니다(지시는 한두 문장).
  - 마무리 요약이 한 문장으로 깁니다.
  - 통화 종료 도구가 없어 AI가 스스로 전화를 끊지 못합니다. 도구 단계에서 붙입니다.

### STT 제품명 인식 (Deepgram)

| 고객이 한 말 | STT 결과 |
|---|---|
| 에프투 울트라 | `F two 울트라` |
| 각인하려고요 | `가긴 하려고요` |
| 메탈팹 | `메탈 백`, `메탈팩` |

- 프롬프트로 "바로잡아 이해하라"고 해도 LLM이 틀린 이름을 맞장구로 따라 말했습니다(3/3회).
- 그래서 **LLM에 넘기기 전에 코드로 고칩니다** (`src/transcript.ts`, 표는 `src/glossary.ts`의 `MISHEARD_TERMS`). 음성 경로에서 "메탈팩" → "메탈팹" 보정을 확인했습니다.
- 텍스트 디버거와 텍스트 시뮬레이션은 STT를 거치지 않아 이 보정도 타지 않습니다. 단위 테스트로 확인합니다.
- **Soniox(`stt-rt-v5` + context.terms)와 같은 문장으로 비교해야 합니다.** STT 선택의 핵심 지표입니다.

### 턴 감지

- 고객이 두 문장을 말하며 사이에 쉬면, 첫 문장("…하려고요.")에서 턴이 끝났다고 보고 AI가 답을 시작했다가 끊기는 경우가 있었습니다.
- 문법적으로 끝난 문장이라 턴 감지 판단 자체는 이상하지 않습니다. 실제 마이크 통화(`lk agent console`)에서 자주 나오면 `turnHandling.endpointing.minDelay`(기본 0.5초)를 늘려 봅니다.
- 로그에 `VAD inference is slower than realtime` 경고가 두 번 나왔습니다. 맥에서 디버거 TTS와 같이 돌 때 생긴 것으로 보이며, 서버에서 다시 확인합니다.

### TTS 음성 후보 (같은 첫 멘트, `eleven_v4_turbo`)

| 후보 | Voice ID | 비고 |
|---|---|---|
| 여 Rosa Oh | `sf8Bpb1IU97NI9BHSMRf` | 대화형, 깔끔함 (현재 기본) |
| 여 Han | `8jHHF8rMqMlg8if2mOUe` | 대화형, 편한 말투 |
| 여 Jiyoung | `AW5wrnG1jVizOYY7R1Oo` | 따뜻하고 또렷함 |
| 남 Yohan Koo | `4JJwo477JUAx3HV0T7n7` | 대화형, 신뢰감 |
| 남 Harry Kim | `pb3lVZVjdFWbkhPKlelB` | 대화형, 차분함 |
| 남 Theo | `CxErO97xpQgQXYmapDKX` | 대화형, 부드러움 |

- 라이브러리 음성은 My Voices에 추가하지 않아도 Voice ID만으로 API 합성이 됐습니다(Starter).
- 상담팀 블라인드 청취로 고를 예정입니다.
