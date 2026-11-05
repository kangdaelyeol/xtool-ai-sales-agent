# 브라우저 PoC 준비 — 구독할 서비스와 설치 순서

전화 회선 없이 **브라우저로 AI 상담원과 한국어로 통화해 보는 PoC**를 위한 준비 목록입니다. 목표는 STT·LLM·TTS를 바꿔 끼우며 한국어 품질과 응답 지연을 비교하는 것입니다.

> - 전체 설계는 [2-tech-stack.md](2-tech-stack.md)에 있습니다.
> - 2026-11-03에 npm, 공식 문서, 가격 페이지로 확인했습니다. 가격과 무료 혜택은 바뀔 수 있습니다.

---

## 1. 구독 목록

### 지금 가입할 것 (필수)

| 서비스 | 용도 | 요금제 | 결제 | 받을 값 (환경변수) |
|---|---|---|---|---|
| **LiveKit Cloud** | 실시간 음성 연결, 에이전트 실행, 브라우저 테스트 화면(Agent Console) | **Build (무료)**: 에이전트 1,000분, 동시 5세션, 모델 크레딧 $2.50 | **카드 불필요** | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| **Anthropic Console** | LLM: Claude Haiku 5.5 (`claude-haiku-5-5`) | 사용량 과금. 입력 $0.10 / 출력 $0.50 (1M 토큰당) | 크레딧 선결제. PoC는 $5 정도면 충분 | `ANTHROPIC_API_KEY` |
| **ElevenLabs** | TTS: v4 Turbo, Flash v2.5 (한국어 지원) | **Starter $6/월 (첫 달 $1)** | 카드 | `ELEVEN_API_KEY` |
| **Soniox** | STT: `stt-rt-v5` (한국어 지원, LiveKit TS 플러그인 있음) | 사용량 과금. 실시간 시간당 $0.12 | 충전식. 가입 무료 크레딧 없음 | `SONIOX_API_KEY` |

**ElevenLabs를 Starter로 하는 이유:** 무료 플랜은 음성 라이브러리의 많은 목소리를 API로 쓰면 `402 paid_plan_required` 오류가 납니다. 한국어 목소리를 고르려면 Starter가 필요합니다. 즉석 음성 복제도 Starter부터 됩니다.

### 비교용 (무료라 같이 가입해 두면 좋음)

| 서비스 | 용도 | 무료 혜택 | 주의 |
|---|---|---|---|
| **리턴제로 (developers.rtzr.ai)** | STT 비교: 전화용 한국어 모델 `sommers_ko` | **처음 1회 600분 무료** (월 단위 아님) | **LiveKit TS 플러그인이 없습니다.** Python 플러그인을 참고해 TS로 옮기는 작업이 필요합니다(제가 작성 가능). 콘솔에서 client_id / client_secret을 발급받습니다. |
| **Typecast** | TTS 비교: 국산 한국어 음성 | 월 15,000자 무료, **결제 정보 불필요** | 플러그인이 없어 TS 연결 코드를 따로 짜야 합니다. |
| **LiveKit Inference** (LiveKit Cloud 안에 포함) | 키 없이 쓰는 모델 모음. GPT-6 Luna(LLM), Deepgram Nova-3·Cartesia(한국어 STT), Cartesia·Gemini TTS 등 | Build 크레딧 $2.50 (약 50분) | Claude와 ElevenLabs는 없습니다. 비교용으로 짧게 써 보는 정도입니다. |

### 지금은 필요 없는 것

- **OpenAI 계정:** GPT-6 Luna는 LiveKit Inference로 키 없이 비교할 수 있습니다. 본격적으로 쓸 때 가입합니다(최소 선결제 $5).
  - 주의: GPT-6 Luna로 도구를 쓰려면 Chat Completions에서 `reasoning_effort: none`이어야 합니다.
- **전화 회선:** 프로덕션 단계에서 준비합니다([7-telephony-setup.md](7-telephony-setup.md)).

### PoC 예상 비용

| 항목 | 금액 |
|---|---|
| ElevenLabs | $1 (첫 달) |
| Anthropic | 약 $5 |
| Soniox | 충전 최소 금액 (확인 필요, 사용량은 몇 달러 이하) |
| LiveKit, 리턴제로, Typecast | 무료 |
| **합계** | **약 $10~20** |

---

## 2. 설치 순서

### 2-1. 준비물

- **Node.js 24 LTS**: 공식 스타터가 `node >=24`를 요구합니다(`.ts`를 바로 실행).
- **pnpm 12.16.1**: `package.json`의 `packageManager`로 고정했습니다. `corepack enable`을 해 두면 이 버전이 자동으로 쓰입니다. Dockerfile과 CI도 같은 버전입니다.
- **LiveKit CLI 2.18.8 이상**

```bash
brew install livekit-cli
lk --version
```

### 2-2. 스타터 프로젝트

이 레포(`xtool-ai-sales-agent`)가 공식 스타터 `agent-starter-node`를 바탕으로 이미 만들어져 있습니다. `lk agent init`은 따로 하지 않습니다.

```bash
lk cloud auth                                        # 브라우저로 LiveKit Cloud 로그인
pnpm install
```

- functions와 배포 단위가 달라 별도 레포로 둡니다([2-tech-stack.md 6장](2-tech-stack.md#6-전체-아키텍처)).
- 스타터에는 기본 모델 설정(LiveKit Inference)이 들어 있습니다. 먼저 그대로 돌려 동작을 확인한 뒤 부품을 바꿉니다.

### 2-3. 플러그인 설치

Anthropic·ElevenLabs·Soniox 플러그인(1.9.5)은 `package.json`에 이미 들어 있어 `pnpm install`이면 됩니다.

- **VAD:** Silero 플러그인을 따로 설치하지 않습니다. `AgentSession`에 VAD를 넘기지 않으면 코어에 번들된 Silero(`inference.VAD`, `@livekit/local-inference`로 로컬 실행)가 자동으로 붙습니다.
- **턴 감지:** 코어(`@livekit/agents`)에 내장돼 별도 설치가 없습니다. 한국어를 포함한 14개 언어를 지원합니다.
- **설치 스크립트 허용:** pnpm 11 이상은 정하지 않은 설치 스크립트를 오류로 막습니다. `pnpm-workspace.yaml`의 `allowBuilds`에 정해 두었습니다(`@livekit/blingfire`는 아무것도 하지 않는 스크립트라 `false`).
- **노이즈 제거:** 스타터에 들어 있는 기본값을 그대로 씁니다. LiveKit Cloud 연결에서만 동작합니다.

### 2-4. 키 넣기

레포 루트의 `.env.example`을 `.env.local`로 복사해 채웁니다(커밋하지 않습니다):

```bash
LIVEKIT_URL=wss://<프로젝트>.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
ANTHROPIC_API_KEY=...
ELEVEN_API_KEY=...
SONIOX_API_KEY=...
```

- LiveKit 값은 `lk cloud auth` 후 스타터가 자동으로 채워 주기도 합니다.
- `.env.local`은 `.gitignore`에 이미 들어 있습니다.

### 2-5. 실행과 테스트

```bash
lk agent console     # 터미널에서 마이크로 바로 대화
lk agent dev         # 개발 모드로 워커 실행 → LiveKit Cloud의 Agent Console(브라우저)에서 대화
```

- 예전 Agents Playground 주소는 이제 LiveKit Cloud의 **Agent Console**로 연결됩니다.

---

## 3. 부품을 바꿔 끼울 때 알아둘 것

부품은 `.env.local`의 `STT_PROVIDER`, `LLM_PROVIDER`, `TTS_PROVIDER`(와 각 `_MODEL`)로 고릅니다(`src/config.ts`). `livekit`을 고르면 LiveKit Inference를 쓰므로 별도 키가 필요 없습니다.

| 부품 | 주의 |
|---|---|
| **Claude Haiku 5.5** | 생각 모드가 기본으로 켜져 있어(effort medium) 그대로 쓰면 느립니다. 플러그인 1.9.5에는 해당 옵션이 없지만 `chat()`의 `extraKwargs`가 요청 본문에 그대로 들어가는 것을 코드로 확인했습니다(2026-11-03). `src/models/anthropic.ts`가 이 경로로 `thinking: disabled`, `output_config.effort: low`, 자동 프롬프트 캐시를 넣습니다. 요청 본문은 `src/models/anthropic.test.ts`로 검증하고, 실제 지연은 `pnpm check:llm`으로 잽니다. `temperature`는 넣지 않습니다(Haiku 5.5는 기본값이 아니면 400). |
| **ElevenLabs v4 Turbo** | 플러그인이 지원합니다(내부적으로 Text-to-Dialogue WebSocket 사용). **voice id를 넣지 않으면 영어 기본 음성**이 나오니 `TTS_VOICE`에 한국어 음성을 넣습니다. **Flash v2.5는 숫자를 자동 변환하지 않으니** 가격·전화번호는 한글로 풀어서 넣습니다. |
| **Soniox** | 플러그인 기본값은 `stt-rt-v4`라 `stt-rt-v5`를 지정합니다. 플러그인이 세션의 `keytermsOptions`를 지원하지 않아 제품명은 `context.terms`로 넣습니다(`src/glossary.ts`). |
| **리턴제로** | TS 플러그인이 없어 직접 연결 코드가 필요합니다. Python 플러그인 기본값(`sommers_ko`, 8kHz, `CALL` 도메인)을 참고합니다. |

---

## 4. PoC에서 확인할 것

| 항목 | 기준 |
|---|---|
| 응답 지연 | 말 끝나고 AI가 말을 시작할 때까지 1초 안팎 |
| 제품명 인식 | "F2 울트라", "메탈팹", "엑스툴", "P3" |
| 숫자 발음 | 가격, 전화번호, 날짜 |
| 맞장구 처리 | "네", "음"에 AI가 멈추지 않는지 |
| 끼어들기 | "잠깐만요", "아니요"에 바로 멈추는지 |
| 목소리 | 상담팀이 블라인드로 듣고 고르기 |
| 비교 기준선 | vox 홈페이지 LIVE DEMO 통화와 비교 |
