# 세팅 체크리스트 — 지금까지 한 일과 직접 해야 할 세팅

2026-11-03 기준입니다. 실제로 잰 값은 [poc-results.md](poc-results.md)에 쌓습니다. 레포 구조 잡기, 문서 이동, Haiku 5.5 설정 확인, 부품 교체 구조, 상담 프롬프트 초안까지 끝났습니다. 이 문서는 **사람이 직접 해야 하는 세팅**을 순서대로 정리합니다. 각 단계에 끝났다는 기준을 적었습니다.

> - 설치·구독 배경은 [poc-setup.md](poc-setup.md), 전체 설계는 [tech-stack.md](tech-stack.md)에 있습니다.
> - 키·비밀값은 `.env.local`에만 넣습니다. git에 올라가지 않습니다(`.gitignore` 등록 확인함).

---

## 목차

1. [지금까지 한 일](#1-지금까지-한-일)
2. [로컬 개발 환경](#2-로컬-개발-환경)
3. [계정과 키](#3-계정과-키)
4. [.env.local 채우기](#4-envlocal-채우기)
5. [검증 순서](#5-검증-순서)
6. [부품 비교 측정 (PoC)](#6-부품-비교-측정-poc)
7. [상담팀·업무 쪽에서 정해 줄 것](#7-상담팀업무-쪽에서-정해-줄-것)
8. [originalshq와 맞출 계약](#8-originalshq와-맞출-계약)
9. [알아 둘 점](#9-알아-둘-점)
10. [커밋 전 확인](#10-커밋-전-확인)

---

## 1. 지금까지 한 일

### 1-1. 레포 구조

| 항목 | 내용 |
|---|---|
| 바탕 | 공식 스타터 `agent-starter-node`(2026-10-22 커밋 `3715649`)를 레포 루트에 펼침 |
| 이름 | 패키지 `xtool-ai-sales-agent`, 에이전트 `xtool-sales-agent` |
| `.gitignore` | 스타터가 `docs`를 무시하던 줄을 지움 |
| CI | 타입·린트·포맷 검사만 남김. 템플릿 전용 검사와 비용이 드는 시뮬레이션 CI는 뺌 |
| prettier | `docs/`는 대상에서 뺌 (표 서식 유지) |

### 1-2. 설치 문제 해결

| 문제 | 원인 | 조치 |
|---|---|---|
| `ERR_PNPM_IGNORED_BUILDS` (`@livekit/blingfire`) | pnpm 11 이상은 정하지 않은 설치 스크립트를 오류로 막음 | 스크립트가 `node -e ""`(아무것도 안 함)라 `pnpm-workspace.yaml`에 `false`로 정함 |
| 피어 경고 `@livekit/rtc-node` | 스타터가 `^0.13.35`를 고정. agents 1.9.5와 ai-coustics는 `^1.1.0` 요구 | `^1.2.1`로 올림 |
| 피어 경고 `@opentelemetry/api` | agents가 1.10.0을 받았지만 OpenTelemetry SDK는 1.10 미만 요구 | `overrides`로 `~1.9.0` 고정 |
| pnpm 버전 엇갈림 | corepack이 최신 12.16.1을 받음. Dockerfile은 10, CI는 10.15.0 | `packageManager: pnpm@12.16.1`로 고정하고 Dockerfile·CI를 맞춤 |
| Silero 플러그인 | `AgentSession`이 VAD를 넘기지 않으면 번들된 Silero를 로컬에서 자동으로 씀 | 플러그인과 onnxruntime 제거 |

결과: 피어 경고 0건, `pnpm typecheck`·`pnpm lint`·`pnpm format:check` 통과, 워커 CLI 정상 기동.

### 1-3. Haiku 5.5 생각 모드 확인

| 질문 | 확인 결과 |
|---|---|
| 플러그인으로 생각 모드·effort를 넘길 수 있나 | 생성자 옵션은 없음. 대신 `chat()`의 `extraKwargs`가 요청 본문에 그대로 펼쳐짐 (플러그인 1.9.5 코드 확인) |
| 그래서 어떻게 했나 | `src/models/anthropic.ts`의 `VoiceAnthropicLLM`이 매 요청에 `thinking: {type: "disabled"}`, `output_config: {effort: "low"}`, 자동 프롬프트 캐시를 넣음 |
| 실제로 요청에 들어가나 | **확인함.** 로컬 가짜 API 서버로 플러그인이 보내는 요청 본문을 받아 검사 (`src/models/anthropic.test.ts`) |
| `temperature` | 보내지 않음 (Haiku 5.5는 기본값이 아니면 400). 테스트로 확인 |
| assistant prefill (400) | 대화가 assistant로 끝나면 플러그인이 `"."` user 턴을 붙임. 테스트로 확인 |
| 생각 블록 | 생각 모드를 켜도 생각 내용은 음성으로 나가지 않음. 테스트로 확인 |
| 아직 못 한 것 | **실제 API로 잰 지연.** 키가 필요해 5장에서 `pnpm check:llm`으로 잽니다 |

기본값을 생각 모드 **끔** + effort **low**로 둔 이유:
- 음성은 첫 토큰 지연이 가장 중요합니다.
- 플러그인이 대화 기록을 만들 때 생각 블록을 버립니다. 그래서 생각 모드를 켠 채 도구를 붙이면 동작을 보장하기 어렵습니다.
- Anthropic은 "끄기보다 effort를 낮추라"고 권장합니다. 그래서 켠 상태(`adaptive`)와 끈 상태를 `pnpm check:llm`으로 비교해 정합니다.

### 1-4. 부품 교체 구조

`.env.local`의 환경변수로 부품을 바꿉니다(`src/config.ts`, `src/models/index.ts`).

| 부품 | 기본 | 대안 (`livekit` = LiveKit Inference, 별도 키 없음) |
|---|---|---|
| STT | `soniox` / `stt-rt-v5` | `livekit` / `deepgram/nova-3` |
| LLM | `anthropic` / `claude-haiku-5-5` | `livekit` / `openai/gpt-6-luna` |
| TTS | `elevenlabs` / `eleven_v4_turbo` | `livekit` / `cartesia/sonic-3.6` |

- 리턴제로·Typecast는 TS 플러그인이 없습니다. 같은 자리(`src/models/index.ts`의 `switch`)에 공급사를 하나씩 추가하면 됩니다.
- **발음 변환:** TTS에 넣기 전에 제품명을 한글 발음으로 바꿉니다(`src/pronunciation.ts`, 발음표는 `src/glossary.ts`). 예: F2 울트라 → 에프투 울트라.
- **STT 강조 단어:** 같은 용어집을 Soniox `context.terms`로 넣습니다.

### 1-5. 상담 프롬프트 초안

- `src/prompt.ts`: 업무 문서 README 6-1·6-2·6-3·6-6장을 바탕으로 썼습니다.
  - 판정 질문 8개를 한 번에 하나씩 묻습니다.
  - 상황별 대응(통화 곤란, 사람 요청, 가격, 수신 거부, AI 여부, AS 문의 등)을 넣었습니다.
  - 금지 사항(가격·할인·납기 약속, 지어내기, 금융정보 요청)을 넣었습니다.
- 첫 멘트는 LLM을 거치지 않는 고정 문장입니다. AI·녹음 고지가 끝까지 들리도록 끼어들기를 막았습니다.
- 정하지 않은 것은 보수적으로 두었습니다: 가격은 말하지 않음, 체험은 희망 일시만 받음, AI 이름 없음 (7장).
- `scenarios.yaml`: 한국어 시뮬레이션 시나리오 6개 (판정 흐름, 가격 질문, 통화 곤란, 사람 요청, 수신 거부, AI 여부·주민번호).

### 1-6. 문서

- tech-stack, poc-setup, telephony-setup 문서를 originalshq에서 이 레포 `docs/`로 옮겼습니다.
- 옮기면서 두 레포 사이의 링크를 고쳤습니다.
- originalshq 업무 README에서 "업체 API"를 쓰던 시절의 표현 두 곳을 고쳤습니다.

---

## 2. 로컬 개발 환경

| # | 할 일 | 명령 | 끝났다는 기준 |
|---|---|---|---|
| 2-1 | 새 터미널에서도 Node 24가 잡히게 하기 | `nvm alias default 24` | 새 터미널에서 `node -v`가 `v24.x` |
| 2-2 | corepack 켜기 (pnpm 버전 자동 고정) | `corepack enable` | 레포에서 `pnpm -v`가 `12.16.1` |
| 2-3 | 의존성 설치 | `pnpm install` | 오류 없이 끝남 (피어 경고 없음) |
| 2-4 | 키 없이 도는 검사 | `pnpm typecheck && pnpm lint && pnpm test` | 테스트 12개 통과 |

- 설치 끝에 나오는 `Agent skills awaiting approval: dotenv.`는 무시해도 됩니다. pnpm 12가 패키지에 들어 있는 코딩 에이전트용 스킬을 설치할지 묻는 것이고, 실행에는 필요 없습니다.
- 지금 셸 기본값이 Node 22라서, 2-1을 하지 않으면 `pnpm`이 안 잡히거나 `engine-strict` 오류가 납니다.

---

## 3. 계정과 키

| # | 서비스 | 할 일 | `.env.local`에 넣을 값 |
|---|---|---|---|
| 3-1 | **LiveKit Cloud** | Build(무료) 프로젝트 만들기 → `lk cloud auth`로 로그인 | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (`lk app env -w`가 자동으로 채움) |
| 3-2 | **Anthropic Console** | API 키 발급, 크레딧 $5 충전, **월 사용 한도(Spend limit) 설정**(예: $20) | `ANTHROPIC_API_KEY` |
| 3-3 | **ElevenLabs** | **Starter** 가입 (무료 플랜은 라이브러리 음성 API가 402) | `ELEVEN_API_KEY` |
| 3-4 | ElevenLabs 한국어 음성 | Voice Library에서 언어 Korean으로 걸러 후보 2~3개를 My Voices에 추가 → 각 음성의 Voice ID 복사 | `TTS_VOICE` |
| 3-5 | **Soniox** | 가입, 최소 금액 충전, API 키 발급 | `SONIOX_API_KEY` |
| 3-6 | (비교용) 리턴제로·Typecast | 무료 가입만 해 둡니다. 연결 코드는 아직 없습니다 | — |

- **`TTS_VOICE`를 비우면 ElevenLabs 기본 음성(영어)이 나옵니다.** 3-4는 꼭 해야 합니다.
- 음성 후보는 상담팀이 블라인드로 듣고 고르게 합니다(6장).

---

## 4. .env.local 채우기

```bash
lk cloud auth          # 3-1을 했으면 생략
lk app env -w          # .env.example을 바탕으로 .env.local을 만들고 LiveKit 키를 채움
```

그다음 `.env.local`을 열어 나머지를 채웁니다.

```bash
ANTHROPIC_API_KEY=sk-ant-...
ELEVEN_API_KEY=...
SONIOX_API_KEY=...
TTS_VOICE=<3-4에서 고른 Voice ID>

# 나머지(STT_/LLM_/TTS_ 변수)는 비워 두면 기본 구성입니다.
```

---

## 5. 검증 순서

순서대로 합니다. 앞 단계가 통과해야 다음 단계의 결과를 믿을 수 있습니다.

### 5-1. LLM 단독 측정 (Anthropic 키만 필요)

```bash
pnpm check:llm        # 조합마다 3회. pnpm check:llm -- 5 처럼 횟수 지정 가능
```

| 볼 것 | 기대 |
|---|---|
| 오류 | 없음. `요청 실패: 400 ...`이 나오면 그 문장 그대로 알려 주세요 (설정 거절) |
| `first token ms` | `off/low`가 가장 낮음. 목표는 서울에서 0.4초 안팎 |
| `cached tokens` | 2회차부터 0보다 큼 (프롬프트 캐시 동작) |
| `output tokens` | `off`는 답 길이 수준. `adaptive`가 훨씬 크면 생각 토큰이 섞인 것 |
| 답 내용 | 가격을 묻는 질문에 금액을 말하지 않고 상담사 안내를 해야 함 |

→ 결과 표를 남겨 두면 `LLM_THINKING`·`LLM_EFFORT` 기본값을 정합니다.

### 5-2. 터미널에서 음성 대화

```bash
lk agent console
```

- 맥 마이크로 바로 대화합니다. 첫 멘트("안녕하세요, 김민수 고객님. 오리지널스 AI 상담사입니다…")가 한국어 음성으로 나오면 STT·LLM·TTS가 모두 연결된 것입니다.
- 브라우저·콘솔 테스트에서는 job metadata가 없어 **가상 고객(김민수, F2 울트라, 할부 희망)**으로 진행합니다.
- 텍스트로만 빠르게 볼 때는 `lk agent debugger start` → `lk agent debugger say "네, 괜찮아요"`를 씁니다.

### 5-3. 브라우저 Agent Console

```bash
lk agent dev
```

- LiveKit Cloud의 Agent Console을 엽니다. 주소는 `https://cloud.livekit.io/projects/p_/agents/console/?autoStart=true&agentName=xtool-sales-agent`입니다.
- **에이전트 이름을 정해 두었기 때문에 자동 배정이 되지 않습니다.** 콘솔에서 에이전트 이름 `xtool-sales-agent`로 연결해야 합니다.
- 맞장구("네", "음")에 멈추지 않는지, "잠깐만요"에 바로 멈추는지 확인합니다(끼어들기 구분 모델은 LiveKit Cloud와 dev 모드에서 기본으로 켜짐).

### 5-4. 시나리오 시뮬레이션 (LiveKit Cloud 사용량 소모)

```bash
lk agent simulate text --scenarios scenarios.yaml
```

- 처음 실행하면 CLI가 시나리오 id를 채우겠다고 묻습니다. 승인하고, 바뀐 `scenarios.yaml`을 커밋합니다.
- 6개 모두 통과가 목표입니다. 실패한 시나리오는 `src/prompt.ts`를 고치고 다시 돌립니다.

---

## 6. 부품 비교 측정 (PoC)

`.env.local`에서 한 부품씩 바꾸며 같은 대본으로 통화합니다. 바꾼 뒤에는 워커를 다시 시작합니다.

| 비교 | 바꿀 값 |
|---|---|
| STT: Soniox ↔ Deepgram(LiveKit Inference) | `STT_PROVIDER=livekit` |
| LLM: Haiku 5.5 ↔ GPT-6 Luna | `LLM_PROVIDER=livekit` |
| LLM: 생각 모드 | `LLM_THINKING=adaptive`, `LLM_EFFORT=low` 또는 `medium` |
| TTS: ElevenLabs 음성 후보 | `TTS_VOICE=<다른 Voice ID>` |
| TTS: ElevenLabs ↔ Cartesia(LiveKit Inference) | `TTS_PROVIDER=livekit` (+ Cartesia 한국어 voice) |

기록할 것 (poc-setup.md 4장 기준):

| 항목 | 기준 |
|---|---|
| 응답 지연 | 말이 끝나고 AI가 말을 시작할 때까지 1초 안팎. Agent Console의 모델 타이밍을 봅니다 |
| 제품명 인식 | "F2 울트라", "메탈팹", "엑스툴", "P3"가 대화록에 맞게 찍히는지 |
| 제품명·숫자 발음 | "에프투 울트라", "이백구십만 원", "오후 세 시" |
| 맞장구·끼어들기 | "네", "음"에 멈추지 않고, "잠깐만요"·"아니요"에는 바로 멈추는지 |
| 목소리 | 상담팀 블라인드 청취 |
| 기준선 | vox 홈페이지 LIVE DEMO 통화 |

---

## 7. 상담팀·업무 쪽에서 정해 줄 것

프롬프트(`src/prompt.ts`)와 발음표(`src/glossary.ts`)가 아래 답을 기다립니다. 업무 문서 README 12장과 겹칩니다.

| # | 정할 것 | 지금 프롬프트의 임시값 |
|---|---|---|
| 7-1 | AI가 말해도 되는 가격·할부·프로모션 범위 | 아무것도 말하지 않고 상담사에게 넘김 |
| 7-2 | 방문체험을 AI가 확정할지 | 희망 일시만 받고 상담사가 확정 |
| 7-3 | AI 상담사 이름(페르소나)과 음성 | 이름 없음 ("오리지널스 AI 상담사") |
| 7-4 | 기기 이름 발음 | F2=에프투, F1=에프원, P3=피쓰리, M2=엠투, **O1=오원**, UV=유브이, DTF=디티에프. 상담팀이 실제로 부르는 이름인지 확인 필요 |
| 7-5 | 방문체험 매장 위치·운영 시간 | 프롬프트에 없음 → "상담사가 안내" |
| 7-6 | 반론 대응 문구 ("비싸요", "알아볼게요", "상의할게요") | 원칙만 넣음. 우수 상담 녹취 10~20건에서 실제 문구를 뽑으면 품질이 오름 |
| 7-7 | 첫 멘트 문구 | "웹사이트에서 ○○ 상담 신청해 주셔서 연락드렸어요. 통화 내용은 상담 품질을 위해 녹음됩니다." 법무 확인 필요 (README 6-6) |
| 7-8 | 녹음을 **음성 모델 학습**에 써도 되는지 | 지금 고지는 "상담 품질" 목적만 말함. 나중에 STT를 우리 녹음으로 미세 조정하려면(tech-stack 10장) 학습 용도를 동의 문구·첫 멘트·처리방침에 넣어야 하는지 법무 확인. **파일럿 전에 정해야** 파일럿 녹음을 학습에 쓸 수 있음 |

---

## 8. originalshq와 맞출 계약

functions-xtool이 에이전트를 배정할 때 job metadata에 아래 JSON을 넣습니다(`src/call-context.ts`). 지금은 브라우저 테스트라 비어 있고, 전화 연결 단계에서 맞춥니다.

```json
{
  "callId": "Firestore calls/{id}의 id",
  "customerName": "김민수",
  "device": "F2 울트라",
  "inquiredAt": "오늘 오후 두 시 십 분",
  "installment": "희망 | 희망 안 함 | 미기입",
  "inquiryText": "문의 내용"
}
```

- `device`는 Monday 기기별 보드 이름 그대로 넣습니다.
- `inquiredAt`은 사람이 읽는 형식으로 넣습니다. 숫자를 한글로 풀어 쓰면 발음이 안정적입니다.
- JSON이 깨져 있으면 가상 고객이 아니라 **빈 정보("고객님")**로 진행합니다. 실제 고객에게 엉뚱한 이름을 부르지 않게 하려는 것입니다.

---

## 9. 알아 둘 점

| 항목 | 내용 |
|---|---|
| GPT-6 Luna 모델 id | SDK 1.9.5의 LiveKit Inference 모델 목록에는 `openai/gpt-5.6-luna`만 있습니다. 기본값 `openai/gpt-6-luna`가 LiveKit Cloud 모델 목록에 있는지 확인하고, 다르면 `LLM_MODEL`로 바꿉니다 |
| 노이즈 제거 | 스타터 기본값인 ai-coustics QUAIL을 그대로 씁니다 |
| 끼어들기 구분 모델 | LiveKit Cloud와 dev 모드에서는 기본으로 켜집니다. 직접 운영(self-hosted)하면 `src/main.ts`의 `interruption` 줄을 켭니다 |
| ElevenLabs `language: 'ko'` | v4 Turbo는 Text-to-Dialogue API를 거쳐서, 언어 지정이 무시될 수 있습니다. 한국어 음성을 고르면 문제없습니다 |
| 통화 중 도구 | 아직 없습니다(통화 종료, 체험 빈 시간 조회, 수신 거부). functions-xtool API가 생기면 붙이고, 그때 `src/agent.ts` 주석의 문장을 지시문에 넣습니다 |
| 통화 후 판정 추출 | 이 레포가 아니라 functions-xtool에서 더 좋은 모델로 돌릴 예정입니다(tech-stack 6장) |
| Soniox 플러그인 패치 | `patches/@livekit__agents-plugin-soniox@1.9.5.patch`가 flush를 Soniox `finalize`로 바꿉니다(말 끝 판단 단축). `@livekit/agents-plugin-soniox` 버전을 올리면 패치가 맞지 않을 수 있으니 `pnpm install` 오류와 `poc-results.md`의 지연을 다시 확인합니다 |
| 첫 멘트 끼어들기 | 고지가 끝까지 들리도록 막아 두었습니다. 고객이 첫 멘트 중에 말하면 첫 멘트가 끝난 뒤에 반영됩니다 |

---

## 10. 커밋 전 확인

- `git status`에 `.env.local`이 없어야 합니다.
- `pnpm-lock.yaml`은 커밋합니다. 스타터 템플릿 검사는 지웠고, 재현 가능한 설치를 위해 필요합니다.
- `lk agent simulate`가 시나리오 id를 채웠다면 `scenarios.yaml`도 커밋합니다.
- originalshq 쪽은 `docs/`가 `.gitignore`에 있어 문서 변경이 git에 잡히지 않습니다. 업무 문서를 공유하려면 따로 정해야 합니다.
