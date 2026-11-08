# 세팅 체크리스트: 지금까지 한 일과 직접 해야 할 세팅

(2026-11-08 갱신) 이 문서는 **사람이 직접 해야 하는 세팅**을 순서대로 정리합니다. 레포를 처음 받아 직접 돌려 볼 때 2장부터 차례로 따라 하고, 단계마다 적은 "끝났다는 기준"으로 확인합니다. 1장은 지금까지 한 일의 기록입니다. 처음 쓴 날은 2026-11-03이고, 2026-11-08에 지금 레포 상태와 대조해 고쳤습니다(그 사이에 한 일은 1-7절). 실제로 잰 값은 [5-poc-results.md](5-poc-results.md)에 쌓습니다.

> - 설치·구독 배경은 [3-poc-setup.md](3-poc-setup.md), 전체 설계는 [2-tech-stack.md](2-tech-stack.md)에 있습니다.
> - 키·비밀값은 `.env.local`에만 넣습니다. git에 올라가지 않습니다(`.gitignore` 등록 확인함).
> - 처음 나오는 용어는 [학습서 17-1 용어집](1-study/17-glossary-and-next.md#17-1-용어집)에서 찾습니다.

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
| `.gitignore` | 스타터가 `docs`를 무시하던 줄을 지움. 그 뒤 편집기 기록 폴더 `.history/`(키가 든 `.env.local` 사본이 쌓임)와 배포 때 쓰는 임시 파일 `.env.agent-secrets`도 무시하게 함 |
| CI | 타입·린트·포맷 검사와 단위 테스트(`pnpm test`, 키 불필요, `.github/workflows/tests.yml`). 템플릿 전용 검사와 비용이 드는 시뮬레이션 CI는 뺌 |
| prettier | `docs/`는 대상에서 뺌 (표 서식 유지) |

### 1-2. 설치 문제 해결

| 문제 | 원인 | 조치 |
|---|---|---|
| `ERR_PNPM_IGNORED_BUILDS` (`@livekit/blingfire`) | pnpm 11 이상은 정하지 않은 설치 스크립트를 오류로 막음 | 스크립트가 `node -e ""`(아무것도 안 함)라 `pnpm-workspace.yaml`에 `false`로 정함 |
| 피어 경고 `@livekit/rtc-node` | 스타터가 `^0.13.35`를 고정. agents 1.9.5와 ai-coustics는 `^1.1.0` 요구 | `^1.2.1`로 올림 |
| 피어 경고 `@opentelemetry/api` | agents가 1.10.0을 받았지만 OpenTelemetry SDK는 1.10 미만 요구 | `pnpm-workspace.yaml`의 `overrides`로 `~1.9.0` 고정 |
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
| 실제 API로 잰 지연 | 2026-11-03에 `pnpm check:llm`으로 쟀습니다(5-1). 첫 토큰이 생각 끔·low 0.78∼0.84초, 생각 켬 2.1∼3.0초였습니다([5-poc-results.md](5-poc-results.md)) |

기본값을 생각 모드 **끔** + effort **low**로 둔 이유:
- 음성은 첫 토큰 지연이 가장 중요합니다.
- 플러그인이 대화 기록을 만들 때 생각 블록을 버립니다. 그래서 생각 모드를 켠 채 도구를 붙이면 동작을 보장하기 어렵습니다.
- Anthropic은 "끄기보다 effort를 낮추라"고 권장합니다. 그래서 켠 상태(`adaptive`)와 끈 상태를 `pnpm check:llm`으로 비교했고, 켠 상태가 3배 이상 느려 끔으로 정했습니다. 답 품질은 세 설정이 거의 같았습니다.

### 1-4. 부품 교체 구조

`.env.local`의 환경변수로 부품을 바꿉니다(`src/config.ts`, `src/models/index.ts`).

| 부품 | 기본 | 대안 (`livekit` = LiveKit Inference, 별도 키 없음) |
|---|---|---|
| STT | `soniox` / `stt-rt-v5` | `livekit` / `deepgram/nova-3` |
| LLM | `anthropic` / `claude-haiku-5-5` | `livekit` / `openai/gpt-6-luna`. 그 뒤 `bedrock` / `jp.anthropic.claude-haiku-5-5`(Amazon Bedrock 도쿄, AWS 키 필요, 3-7)를 더함 |
| TTS | `elevenlabs` / `eleven_v4_turbo` | `livekit` / `cartesia/sonic-3.6` |

- 리턴제로·Typecast는 TS 플러그인이 없습니다. 같은 자리(`src/models/index.ts`의 `switch`)에 공급사를 하나씩 추가하면 됩니다. 공급사 이름과 기본 모델은 `src/config.ts`에도 더합니다(`SttProvider` 같은 타입, `pick`의 허용 목록, `DEFAULT_MODELS`).
- **발음 변환:** TTS에 넣기 전에 제품명을 한글 발음으로 바꿉니다(`src/pronunciation.ts`, 발음표는 `src/glossary.ts`). 예: F2 울트라 → 에프투 울트라.
- **STT 강조 단어:** 같은 용어집을 Soniox `context.terms`로 넣습니다. LiveKit Inference STT일 때는 세션의 `keytermsOptions`로 넣습니다(`src/main.ts`).

### 1-5. 상담 프롬프트 초안

- `src/prompt.ts`: 업무 문서 README 6-1·6-2·6-3·6-6장을 바탕으로 썼습니다.
  - 판정 질문 8개를 한 번에 하나씩 묻습니다.
  - 상황별 대응(통화 곤란, 사람 요청, 가격, 수신 거부, AI 여부, AS 문의 등)을 넣었습니다.
  - 금지 사항(가격·할인·납기 약속, 지어내기, 금융정보 요청)을 넣었습니다.
- 첫 멘트는 LLM을 거치지 않는 고정 문장 두 개입니다(`src/main.ts`). AI·녹음 고지(`openingNotice`)는 끝까지 들리도록 끼어들기를 막았고, 이어지는 질문 "이삼 분 정도 통화 괜찮으실까요?"(`OPENING_QUESTION`)는 고객이 바로 답할 수 있게 열어 두었습니다. 고지 중에 고객이 한 말이 어떻게 되는지는 9장 "첫 멘트 끼어들기"에 있습니다.
- 정하지 않은 것은 보수적으로 두었습니다: 가격은 말하지 않음, 체험은 희망 일시만 받음, AI 이름 없음 (7장).
- `scenarios.yaml`: 한국어 시뮬레이션 시나리오 6개 (판정 흐름, 가격 질문, 통화 곤란, 사람 요청, 수신 거부, AI 여부·주민번호).

### 1-6. 문서

- tech-stack, poc-setup, telephony-setup 문서를 originalshq에서 이 레포 `docs/`로 옮겼습니다. 지금 이름은 읽는 순서 번호를 붙인 `2-tech-stack.md`, `3-poc-setup.md`, `7-telephony-setup.md`입니다.
- 옮기면서 두 레포 사이의 링크를 고쳤습니다.
- originalshq 업무 README에서 "업체 API"를 쓰던 시절의 표현 두 곳을 고쳤습니다.

### 1-7. 그 뒤에 한 일 (2026-11-08 추가)

2026-11-03 이후 2026-11-08까지 레포에 들어간 것입니다. 자세한 내용은 오른쪽 칸의 문서에 있습니다.

| 항목 | 내용 | 자세히 |
|---|---|---|
| 말 끝 확정 앞당기기 | 고객이 말을 멈추면 Soniox에 확정을 바로 요청합니다(플러그인 패치, `src/models/soniox.ts`, `src/main.ts`의 리스너). 말 끝 판단이 0.57∼1.42초에서 0.38∼0.54초로 줄었습니다 | [5-poc-results.md](5-poc-results.md), 9장, [학습서 6-5](1-study/06-stt.md#6-5-사례-연구-13초-늦던-턴을-05초로수동-확정-패치) |
| 오인식 보정 | STT가 잘못 적은 제품명을 LLM에 넘기기 전에 고칩니다(`src/transcript.ts`, 표는 `src/glossary.ts`의 `MISHEARD_TERMS`). 예: 메탈 백 → 메탈팹 | [학습서 6-8](1-study/06-stt.md#6-8-마지막-방어선-코드로-오인식-보정) |
| 즉시 반응과 맞장구 떼기 | 고객 말이 끝나면 "네네." 같은 짧은 반응을 먼저 말합니다. 통화 시작 때 미리 합성해 두고(`src/ack-audio.ts`), 수신 거부·불만·사람 요청에는 하지 않습니다. 본 답 첫머리의 "네," 같은 맞장구는 뗍니다(`src/ack.ts`) | [학습서 11-6](1-study/11-session-pipeline.md#11-6-즉시-반응네네-기법-해부) |
| 통화 끝내기 | AI가 마지막 인사와 함께 부르는 통화 종료 도구(`end_call`, `src/agent.ts`), 무응답 재촉·종료와 통화 8분 상한(`src/call-guard.ts`) | [2-tech-stack.md 7장](2-tech-stack.md#7-우리가-직접-만들-기능-목록) |
| 고지 중 고객 말 | 끼어들기를 막은 고지 중의 고객 소리도 STT로 보냅니다(`discardAudioIfUninterruptible: false`). 한계가 있습니다 | 9장 |
| 끼어들기 | 최소 길이를 0.5초에서 0.2초로 줄이고, 겹친 말마다 판정(끼어들기·맞장구·판단 없음)을 로그에 남깁니다 | [학습서 7-5](1-study/07-turn-taking.md#7-5-끼어들기-에이전트가-말하는-중에-고객이-말하면) |
| 통화 결과 전송 | 통화가 끝나면 대화록과 구간별 지연을 functions-xtool로 보냅니다(`src/call-result.ts`). 세션이 닫히면 방을 지워(`deleteRoomOnClose`) 결과가 바로 갑니다 | [6-web-test.md 4-1](6-web-test.md#4-1-통화-결과-저장판정조회) |
| 웹 테스트 | originalshq 관리 화면(/log)의 "AI 상담원" 탭에서 브라우저로 통화합니다. 토큰 발급 → 에이전트 배정 → 첫 멘트, 결과 전송(가짜 서버), 판정 추출 1건까지 확인했습니다. 배포한 함수와 실제 브라우저로 하는 통화는 아직입니다 | [6-web-test.md](6-web-test.md) |
| 지식 자료 파일 | `knowledge/xtool.md`를 상담팀이 채우면 지시문에 들어갑니다(`src/knowledge.ts`). 지금은 작성 안내 주석뿐이라 들어가는 내용이 없습니다 | 7장, [학습서 9-2](1-study/09-prompt-design.md#9-2-섹션별-해부) |
| Bedrock 도쿄 경로 | `LLM_PROVIDER=bedrock`. IAM 키로만 서명하고, 미리 연결은 같은 호스트에 HEAD를 보냅니다. 2026-11-05 기준 계정에 Haiku 5.5가 열리지 않아 기본값은 Anthropic API입니다 | 3-7, [학습서 16장](1-study/16-cloud-accounts-iam.md) |
| 빌드·CI 정비 | Dockerfile이 설치 전에 `pnpm-workspace.yaml`·`.npmrc`·`patches/`를 복사합니다. CI가 `pnpm test`도 돌립니다. `.dockerignore`가 하위 폴더의 `.env` 사본(`**/.env*`)과 `.history/`를 뺍니다 | [학습서 17-2](1-study/17-glossary-and-next.md#17-2-이-책을-쓰며-코드에서-발견한-사항) #1·#2·#46 |

---

## 2. 로컬 개발 환경

| # | 할 일 | 왜 | 명령 | 끝났다는 기준 |
|---|---|---|---|---|
| 2-1 | 새 터미널에서도 Node 24가 잡히게 하기 | `package.json`이 Node 24 이상을 요구하고, `.npmrc`의 `engine-strict=true` 때문에 낮은 판이면 설치가 오류로 멈춤 | `nvm alias default 24` (nvm을 쓸 때. 레포의 `.nvmrc`도 24) | 새 터미널에서 `node -v`가 `v24.x` |
| 2-2 | corepack 켜기 | `package.json`의 `packageManager`에 적힌 pnpm 12.16.1을 자동으로 받아 씀. Dockerfile·CI와 같은 판 | `corepack enable` | 레포에서 `pnpm -v`가 `12.16.1` |
| 2-3 | 의존성 설치 | `pnpm-lock.yaml` 그대로 설치하고 Soniox 패치(`patches/`)를 적용함 | `pnpm install` | 오류 없이 끝남 (피어 경고 없음) |
| 2-4 | 키 없이 도는 검사 | CI와 같은 검사. 처음부터 고장 난 상태가 아닌지 봄 | `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` | 모두 통과. 2026-11-08 기준 테스트 파일 8개, 테스트 36개 |

- 설치 끝에 나오는 `Agent skills awaiting approval: dotenv.`는 무시해도 됩니다. pnpm 12가 패키지에 들어 있는 코딩 에이전트용 스킬을 설치할지 묻는 것이고, 실행에는 필요 없습니다.
- 셸의 기본 Node가 24보다 낮으면(처음 작업한 맥은 Node 22였음) 2-1을 하지 않았을 때 `pnpm`이 안 잡히거나 `engine-strict` 오류가 납니다.

---

## 3. 계정과 키

| # | 서비스 | 할 일 | `.env.local`에 넣을 값 |
|---|---|---|---|
| 3-1 | **LiveKit Cloud** | Build(무료) 프로젝트 만들기 → `lk cloud auth`로 로그인 | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (`lk app env -w`가 자동으로 채움) |
| 3-2 | **Anthropic Console** | API 키 발급, 크레딧 $5 충전, **월 사용 한도(Spend limit) 설정**(예: $20) | `ANTHROPIC_API_KEY` |
| 3-3 | **ElevenLabs** | **Starter** 가입 (무료 플랜은 라이브러리 음성 API가 402) | `ELEVEN_API_KEY` |
| 3-4 | ElevenLabs 한국어 음성 | Voice Library에서 언어 Korean으로 걸러 후보 2∼3개를 고름 → 각 음성의 Voice ID 복사. Starter에서는 My Voices에 추가하지 않아도 Voice ID만으로 합성됐습니다. PoC에서 고른 후보 6개의 ID는 [5-poc-results.md](5-poc-results.md)에 있습니다 | `TTS_VOICE` |
| 3-5 | **Soniox** | 가입, 최소 금액 충전, API 키 발급 | `SONIOX_API_KEY` |
| 3-6 | (비교용) 리턴제로·Typecast | 무료 가입만 해 둡니다. 연결 코드는 아직 없습니다 | 아직 없음 (연결 코드를 만들 때 정함) |
| 3-7 | (선택) **AWS Bedrock** (LLM을 도쿄에서 처리) | 유료 플랜 전환 → 예산 알림(월 $10 등) → 도쿄 리전에서 Anthropic 첫 사용 양식 제출(조직이면 관리 계정에서) → IAM 사용자(콘솔 접근 없음)에 Bedrock 호출 정책 → 액세스 키 발급(용도: AWS 외부 애플리케이션) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION=ap-northeast-1` |

- **`TTS_VOICE`를 비우면 ElevenLabs 기본 음성(영어)이 나옵니다.** 3-4는 꼭 해야 합니다.
- 음성 후보는 상담팀이 블라인드로 듣고 고르게 합니다(6장).
- 3-7은 `LLM_PROVIDER=bedrock`을 쓸 때만 필요합니다. 2026-11-05 현재 이 계정에는 Haiku 5.5가 열리지 않아(AWS 지원에 요청) 기본값은 Anthropic API입니다.
- 3-7에서 **Bedrock API 키는 쓰지 않습니다.** 조직 정책(SCP)이 막습니다. 코드도 IAM 키로만 인증하도록 `AWS_BEARER_TOKEN_BEDROCK`을 읽지 않습니다(`apiKey: null`, 2026-11-05). 각 단계의 이유와 겪은 오류는 [학습서 16장](1-study/16-cloud-accounts-iam.md)에 있습니다.

(2026-11-08 추가) **끝났다는 기준.** 키는 실제로 써 봐야 맞는지 알 수 있으므로, 대부분 5장의 검증에서 확인합니다.

- 3-1: `lk project list`에 만든 프로젝트가 보입니다.
- 3-2: 5-1의 `pnpm check:llm`이 `요청 실패` 없이 끝납니다.
- 3-3·3-4·3-5: 5-2의 `lk agent console`에서 첫 멘트가 고른 한국어 음성으로 나오고, 내가 한 말이 글로 적힙니다.
- 3-7: `pnpm compare:llm 3`이 Anthropic API와 Bedrock 두 경로 모두 답을 냅니다. 스크립트가 `jp.anthropic.claude-haiku-5-5`를 쓰므로 계정에 Haiku 5.5가 열려 있어야 합니다.

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

# LLM을 Bedrock 도쿄로 쓸 때만 (3-7)
# LLM_PROVIDER=bedrock
# AWS_ACCESS_KEY_ID=AKIA...
# AWS_SECRET_ACCESS_KEY=...
# AWS_REGION=ap-northeast-1

# 나머지(STT_/LLM_/TTS_ 변수)는 비워 두면 기본 구성입니다.
```

- (2026-11-08 추가) `lk app env -w`는 `.env.local`이 이미 있으면 덮어쓰지 않고 합칩니다(`-o`를 주면 새로 씀, `lk app env --help`).
- `.env.example`에서 넘어온 `VOICE_RESULT_URL`·`VOICE_AGENT_SECRET`은 통화 결과를 functions-xtool로 보낼 때만 씁니다. 둘 다 빈 값으로 넘어오고, 하나라도 비어 있으면 보내지 않고 로그만 남깁니다. 그래서 웹 테스트를 배포할 때 채웁니다. 주소 꼴은 `.env.example`의 주석에 있습니다([6-web-test.md 6-1](6-web-test.md#6-1-functions-xtool)).

끝났다는 기준: `.env.local`에 위 값이 모두 들어 있고, `git status`에 `.env.local`이 보이지 않습니다. 키가 맞는지는 5장에서 확인합니다.

---

## 5. 검증 순서

순서대로 합니다. 앞 단계가 통과해야 다음 단계의 결과를 믿을 수 있습니다.

### 5-1. LLM 단독 측정 (Anthropic 키만 필요)

```bash
pnpm check:llm        # 조합마다 3회. pnpm check:llm 5 처럼 횟수 지정 가능
```

- (2026-11-08 갱신) 횟수는 `pnpm check:llm 5`처럼 바로 붙입니다. pnpm 12는 `--`도 스크립트에 그대로 넘기므로, `pnpm check:llm -- 5`라고 쓰면 횟수가 `NaN`이 되어 한 번도 재지 않고 빈 표만 나옵니다(pnpm 12.16.1로 확인).
- 이 스크립트는 `LLM_PROVIDER`와 상관없이 Anthropic API로만 잽니다. 생각 모드·effort 조합 세 가지(`off/low`, `adaptive/low`, `adaptive/medium`)를 차례로 부릅니다. Bedrock은 `pnpm compare:llm`으로 잽니다(6장).

| 볼 것 | 기대 |
|---|---|
| 오류 | 없음. `요청 실패: 400 ...`이 나오면 API가 요청 설정(생각 모드·effort 등)을 거절한 것입니다. 오류 문장을 그대로 기록해 원인을 찾습니다([학습서 8-5](1-study/08-llm.md#8-5-생각-모드와-effort-왜-껐는가)) |
| `first token ms` | `off/low`가 가장 낮음. 목표는 서울에서 0.4초 안팎이지만, 2026-11-03 PoC에서는 0.78∼0.84초였습니다 |
| `cached tokens` | 2회차부터 0보다 큼 (프롬프트 캐시 동작) |
| `output tokens` | `off`는 답 길이 수준. `adaptive`가 훨씬 크면 생각 토큰이 섞인 것 |
| 답 내용 | 가격을 묻는 질문에 금액을 말하지 않고 상담사 안내를 해야 함 |

→ 결과 표는 [5-poc-results.md](5-poc-results.md)에 남깁니다. 2026-11-03 결과로 기본값을 `LLM_THINKING=off`, `LLM_EFFORT=low`로 정했습니다(`src/config.ts`).

### 5-2. 터미널에서 음성 대화

```bash
lk agent console
```

- 맥 마이크로 바로 대화합니다. 첫 멘트("안녕하세요, 김민수 고객님. 오리지널스 AI 상담사입니다…")가 한국어 음성으로 나오면 STT·LLM·TTS가 모두 연결된 것입니다.
- 콘솔과 Agent Console 테스트에서는 job metadata가 없어 **가상 고객**(김민수, F2 울트라, 할부 희망)으로 진행합니다. 관리 화면의 웹 테스트는 입력한 고객 정보를 넣어 보냅니다(8장).
- 텍스트로만 빠르게 볼 때는 `lk agent debugger start` → `lk agent debugger say "네, 괜찮아요"`를 씁니다. 실행 중인 디버거 세션은 옛 코드를 쥐고 있으므로 코드를 고친 뒤에는 `lk agent debugger restart`를, 다 쓰면 `lk agent debugger stop`을 합니다. 텍스트 디버거는 STT를 거치지 않으므로, STT가 잘못 적은 제품명을 고치는 오인식 보정도 타지 않습니다([5-poc-results.md](5-poc-results.md)).
- (2026-11-08 추가) 말없이 있으면 약 10초 뒤 "여보세요? 제 목소리 잘 들리세요?"가 나오고, 그 뒤 10초 안에 말하지 않으면 작별 인사 후 통화가 끝납니다(9장 "무응답 종료").

### 5-3. 브라우저 Agent Console

```bash
lk agent dev
```

- LiveKit Cloud의 Agent Console을 엽니다. **`lk agent dev`가 터미널에 출력하는 콘솔 링크로 여는 것이 가장 확실합니다.** CLI 2.19.0 이상의 `lk agent dev`는 워커를 무작위 `dev-…` 배포로 등록하고, 출력되는 링크가 그 배포를 가리킵니다. 아래처럼 주소를 직접 열면 `production`으로 배정되어 에이전트가 안 들어올 수 있습니다(그때는 `lk agent dev --deployment production`으로 띄움). 직접 여는 주소: `https://cloud.livekit.io/projects/p_/agents/console/?autoStart=true&agentName=xtool-sales-agent`
- **에이전트 이름을 정해 두었기 때문에 자동 배정이 되지 않습니다.** 콘솔에서 에이전트 이름 `xtool-sales-agent`로 연결해야 합니다.
- 맞장구("네", "음")에 멈추지 않는지, "잠깐만요"에 바로 멈추는지 확인합니다(끼어들기 구분 모델은 LiveKit Cloud와 dev 모드에서 기본으로 켜짐).

### 5-4. 시나리오 시뮬레이션 (LiveKit Cloud 사용량 소모)

```bash
lk agent simulate text --scenarios scenarios.yaml
```

- (2026-11-08 갱신) 지금 `scenarios.yaml`의 id는 이미 채워져 커밋돼 있습니다. 새 시나리오를 id 없이 더하면 CLI가 id를 채우겠다고 묻습니다. 승인하고, 바뀐 `scenarios.yaml`을 커밋합니다.
- 6개 모두 통과가 목표입니다. 실패한 시나리오는 `src/prompt.ts`를 고치고 다시 돌립니다. 2026-11-03 회귀 실행에서 6/6이 통과했지만 한 번씩 돌린 결과라, 파일럿 전에 `--samples 3`(시나리오마다 세 번)으로 다시 봅니다([5-poc-results.md](5-poc-results.md), [학습서 14-5](1-study/14-testing.md#14-5-시나리오-시뮬레이션)).
- 비용: Build 요금제는 텍스트 시뮬레이션 350턴까지 포함입니다(LiveKit 요금표, 2026-11-08 확인).

---

## 6. 부품 비교 측정 (PoC)

`.env.local`에서 한 부품씩 바꾸며 같은 대본으로 통화합니다. 바꾼 뒤에는 워커를 다시 시작합니다.

| 비교 | 바꿀 값 | 지금까지 (2026-11-08) |
|---|---|---|
| STT: Soniox ↔ Deepgram(LiveKit Inference) | `STT_PROVIDER=livekit` | TTS가 읽은 5문장에서 Soniox는 모두 맞고, Deepgram은 제품명·"할부"를 놓침. Soniox 유지 |
| LLM: Haiku 5.5 ↔ GPT-6 Luna | `LLM_PROVIDER=livekit` | 첫 토큰 0.77∼0.92초 대 0.72∼1.37초. Luna는 이미 답한 질문을 되물어 Haiku 유지 (한 차례씩) |
| LLM: Anthropic API ↔ Bedrock 도쿄 | `LLM_PROVIDER=bedrock` (3-7). LLM만 떼어 번갈아 재려면 `pnpm compare:llm` | 계정에 Haiku 5.5가 열리지 않아 Haiku 4.5로 잼. 첫 토큰 p50 0.77초 대 0.66초 |
| LLM: 생각 모드 | `LLM_THINKING=adaptive`, `LLM_EFFORT=low` 또는 `medium` | 켜면 첫 토큰 2.1∼3.0초로 3배 이상 느림. 끔 유지 |
| TTS: ElevenLabs 음성 후보 | `TTS_VOICE=<다른 Voice ID>` | 후보 6개를 골라 둠. 블라인드 청취 전 |
| TTS: ElevenLabs ↔ Cartesia(LiveKit Inference) | `TTS_PROVIDER=livekit` (+ Cartesia 한국어 voice) | 아직 |

"지금까지" 칸은 [5-poc-results.md](5-poc-results.md)를 줄인 것입니다. (2026-11-08 추가) 워커의 LLM을 Bedrock으로 바꿔 배포하기 전에는 [학습서 15-5](1-study/15-config-deploy-ops.md#15-5-워커를-어디에-띄우나-livekit-cloud-또는-gke)의 주의(이 레포의 Bedrock 연동 경로와 자동 캐시, 워커 리전)를 먼저 봅니다.

기록할 것 (3-poc-setup.md 4장 기준):

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

프롬프트(`src/prompt.ts`), 발음표(`src/glossary.ts`), 지식 파일(`knowledge/xtool.md`)이 아래 답을 기다립니다. 업무 문서 README 12장과 겹칩니다.

| # | 정할 것 | 지금 프롬프트의 임시값 |
|---|---|---|
| 7-1 | AI가 말해도 되는 가격·할부·프로모션 범위 | 아무것도 말하지 않고 상담사에게 넘김. 정해지기 전까지는 지식 파일에도 적지 않음 |
| 7-2 | 방문체험을 AI가 확정할지 | 희망 일시만 받고 상담사가 확정 |
| 7-3 | AI 상담사 이름(페르소나)과 음성 | 이름 없음 ("오리지널스 AI 상담사") |
| 7-4 | 기기 이름 발음 | F2=에프투, F1=에프원, P3=피쓰리, M2=엠투, **O1=오원**, UV=유브이, DTF=디티에프. 상담팀이 실제로 부르는 이름인지 확인 필요 |
| 7-5 | 방문체험 매장 위치·운영 시간 | 프롬프트에 없음 → "상담사가 안내". 상담팀이 `knowledge/xtool.md`의 "방문체험" 칸에 채우면 지시문에 들어감 |
| 7-6 | 반론 대응 문구 ("비싸요", "알아볼게요", "상의할게요") | 원칙만 넣음. 우수 상담 녹취 10∼20건에서 실제 문구를 뽑으면 품질이 오름 |
| 7-7 | 첫 멘트 문구 | "웹사이트에서 ○○ 상담 신청해 주셔서 연락드렸어요. 통화 내용은 상담 품질을 위해 녹음됩니다." 법무 확인 필요 (README 6-6) |
| 7-8 | 녹음을 **음성 모델 학습**에 써도 되는지 | 지금 고지는 "상담 품질" 목적만 말함. 나중에 STT를 우리 녹음으로 미세 조정하려면(tech-stack 10장) 학습 용도를 동의 문구·첫 멘트·처리방침에 넣어야 하는지 법무 확인. **파일럿 전에 정해야** 파일럿 녹음을 학습에 쓸 수 있음 |

---

## 8. originalshq와 맞출 계약

(2026-11-08 갱신) functions-xtool이 에이전트를 배정할 때 job metadata(배정과 함께 보내는 통화별 정보 문자열)에 아래 JSON을 넣습니다(`src/call-context.ts`). 웹 테스트에서는 functions-xtool `createVoiceAgentSession`이 브라우저용 접속 토큰의 배정 정보에 이 JSON을 넣고, 이때 `callId`는 방 이름입니다([6-web-test.md 3장](6-web-test.md#3-에이전트에-넘기는-고객-정보-metadata-계약)). Agent Console·콘솔·디버거에는 metadata가 없어 가상 고객으로 진행합니다. 전화 발신 단계에서도 같은 모양을 씁니다.

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
- JSON이 깨져 있으면 가상 고객이 아니라 **빈 정보**("고객님")로 진행합니다. 실제 고객에게 엉뚱한 이름을 부르지 않게 하려는 것입니다.
- 필드 이름을 바꾸면 functions-xtool `voice-agent.ts`의 `CallContext`도 같이 바꿉니다. 두 레포가 같은 모양을 손으로 맞춰 둔 사본이라, 한쪽만 바꾸면 오류 없이 "고객님"으로 진행합니다([학습서 17-2](1-study/17-glossary-and-next.md#17-2-이-책을-쓰며-코드에서-발견한-사항) #17).

---

## 9. 알아 둘 점

| 항목 | 내용 |
|---|---|
| GPT-6 Luna 모델 id | SDK 1.9.5 타입 목록에는 `openai/gpt-5.6-luna`만 있지만, `openai/gpt-6-luna`도 LiveKit Inference에서 정상 동작함을 확인했습니다(2026-11-03) |
| 노이즈 제거 | 스타터 기본값인 ai-coustics `QuailVfS`(Voice Focus)를 그대로 씁니다(`src/main.ts`). 플러그인의 기본 인증이 LiveKit Cloud라서, 방이 LiveKit Cloud에 있으면 워커 위치와 상관없이 동작합니다. LiveKit 요금표는 이 모델을 "목소리 분리(voice isolation)"로 분류해 Build는 100분, Ship은 1,000분까지 포함하고, Ship은 그 뒤 분당 $0.0012입니다(2026-11-08 확인). LiveKit 문서는 이 모델이 헤드셋 같은 가까운 마이크에 맞춰져 있다고 적고, SIP 참가자용으로는 Krisp VIVA(telephony)를 따로 둡니다. 전화 연결 단계에서 비교할 거리입니다 |
| 끼어들기 구분 모델 | LiveKit Cloud 배포와 개발 모드(`lk agent dev`)에서는 기본으로 켜집니다. 직접 운영(`start`)에서는 꺼지므로 `src/main.ts`의 `interruption` 옵션에 `mode: 'adaptive'`를 더합니다. 직접 운영에서는 턴 감지 모델도 클라우드 `v1`이 아니라 로컬 `v1-mini`가 됩니다([학습서 17-2](1-study/17-glossary-and-next.md#17-2-이-책을-쓰며-코드에서-발견한-사항) #3) |
| ElevenLabs `language: 'ko'` | v4 Turbo는 Text-to-Dialogue API를 거쳐서, 언어 지정이 무시될 수 있습니다. 한국어 음성을 고르면 문제없습니다 |
| 통화 중 도구 | 통화 종료(`end_call`, SDK의 `beta.createEndCallTool`)만 있습니다. AI가 마지막 인사를 말한 같은 답에서 부르고, 인사가 다 재생된 뒤 세션이 닫힙니다. 체험 빈 시간 조회·수신 거부 등록은 functions-xtool API가 생기면 붙입니다(`src/agent.ts`). 생각 모드를 끈 채 도구를 쓰므로, 도구 호출을 말로 흘리지 않게 하는 문장을 지시문의 "통화 끝내기"에 넣어 두었습니다 |
| 통화 후 판정 추출 | 이 레포가 아니라 functions-xtool이 합니다. 워커가 통화 결과를 보내면 저장 트리거(`extractVoiceCallJudgment`)가 `claude-opus-5-5`로 요약과 판정 칸을 뽑습니다([6-web-test.md 4-1](6-web-test.md#4-1-통화-결과-저장판정조회)) |
| Soniox 플러그인 패치 | `patches/@livekit__agents-plugin-soniox@1.9.5.patch`가 flush를 Soniox `finalize`로 바꿉니다(말 끝 판단 단축). `@livekit/agents-plugin-soniox` 버전을 올리면 패치가 맞지 않을 수 있으니 `pnpm install` 오류와 `5-poc-results.md`의 지연을 다시 확인합니다 |
| (2026-11-08 추가) SDK의 `manualFlush` | LiveKit Agents의 GitHub 기본 브랜치에 STT 능력 표시 `manualFlush`가 생겼습니다. 이 표시를 켠 STT에는 코어가 턴 경계에서 스트림을 직접 flush합니다. 아직 출시 전이고 설치된 1.9.5에는 없습니다. SDK와 Soniox 플러그인을 이 기능이 들어간 판으로 올리면, `src/main.ts`의 리스너가 보내는 flush와 코어가 보내는 flush가 겹쳐 말 끝마다 finalize가 두 번 갈 수 있고 패치(`patches/`)도 맞지 않게 됩니다. 업그레이드 때 확인하고, 겹치면 패치와 리스너를 빼고 지연을 다시 잽니다([학습서 6-5](1-study/06-stt.md#이-해결책의-주의점)) |
| 첫 멘트 끼어들기 | (2026-11-08 갱신) AI·녹음 고지는 끝까지 들리도록 끼어들기를 막았고, 이어지는 질문은 열어 두었습니다. 고지 중의 고객 소리도 STT로 보내지만(`discardAudioIfUninterruptible: false`), 고객이 고지 도중에 말을 마쳐 턴이 고지 재생 중에 확정되면 그 턴은 버려집니다(로그에 "skipping user input" 경고). 고객 말이 고지가 끝날 때까지 이어진 경우에만 고지 뒤에 처리됩니다. 또 브라우저 테스트에서는 AI가 처음 말하기 시작한 뒤 3초 동안(AEC 워밍업) 이 설정과 상관없이 STT에 무음이 들어갑니다. 발신 전화에서는 이 워밍업이 꺼집니다. 그래서 "첫 멘트가 끝난 뒤 반영"은 보장되지 않습니다([학습서 7-6](1-study/07-turn-taking.md#7-6-끼어들-수-없는-말-ai녹음-고지)) |
| (2026-11-08 추가) 무응답 종료 | 고객이 말하지 않고 AI도 말하거나 답을 준비하지 않는 채로 10초가 지나면 "여보세요? 제 목소리 잘 들리세요?"를 하고, 재생이 끝난 뒤 10초 안에 고객이 말하지 않으면 작별 인사 후 끊습니다(`src/call-guard.ts`). 통화 최대 길이는 8분입니다. 즉시 반응 "네네." 뒤 본 답을 기다리는 동안에도 이 시계가 돕니다([2-tech-stack.md 7장](2-tech-stack.md#7-우리가-직접-만들-기능-목록)) |

---

## 10. 커밋 전 확인

- `git status`에 `.env.local`이 없어야 합니다. (2026-11-08 추가) 배포 때 만드는 임시 파일 `.env.agent-secrets`와 편집기 기록 폴더 `.history/`도 `.gitignore`에 있어 잡히지 않아야 정상입니다. `.env.agent-secrets`가 남아 있으면 지웁니다.
- (2026-11-08 추가) CI와 같은 검사를 먼저 돌립니다: `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`. `docs/`는 `.prettierignore`로 prettier 대상에서 빠져 있으므로(1-1), 문서 서식은 이 검사가 보지 않습니다.
- `pnpm-lock.yaml`은 커밋합니다. 스타터 템플릿 검사는 지웠고, 재현 가능한 설치를 위해 필요합니다.
- `lk agent simulate`가 시나리오 id를 채웠다면 `scenarios.yaml`도 커밋합니다.
- originalshq 쪽은 `docs/`가 `.gitignore`에 있어 문서 변경이 git에 잡히지 않습니다. 업무 문서를 공유하려면 따로 정해야 합니다.
