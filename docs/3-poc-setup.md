# 브라우저 PoC 준비: 구독할 서비스와 설치 순서

전화 회선 없이 **브라우저로 AI 상담원과 한국어로 통화해 보는 PoC**를 위한 준비 목록입니다. PoC(개념 검증)는 본 개발 전에 부품을 붙여 되는지 보는 단계입니다. 목표는 STT·LLM·TTS를 바꿔 끼우며 한국어 품질과 응답 지연을 비교하는 것입니다.

(2026-11-08 추가) **언제 읽나.** 어떤 서비스에 가입하고 왜 그 요금제를 고르는지 알고 싶을 때 읽습니다. 레포를 받아 실제로 따라 할 순서와 단계마다 확인하는 법은 [4-setup-checklist.md](4-setup-checklist.md)가 더 자세하고, 이 문서의 2장은 그 요약입니다. 잰 값은 [5-poc-results.md](5-poc-results.md)에 있습니다.

> - 전체 설계는 [2-tech-stack.md](2-tech-stack.md)에 있습니다.
> - 2026-11-03에 npm, 공식 문서, 가격 페이지로 확인했습니다. 가격과 무료 혜택은 바뀔 수 있습니다. LiveKit Cloud 요금은 2026-11-08에 다시 확인했습니다.
> - 처음 나오는 용어는 [학습서 17-1 용어집](1-study/17-glossary-and-next.md#17-1-용어집)에서 찾습니다.

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
| **리턴제로 (developers.rtzr.ai)** | STT 비교: 전화용 한국어 모델 `sommers_ko` | **처음 1회 600분 무료** (월 단위 아님) | **LiveKit TS 플러그인이 없습니다.** Python 플러그인을 참고해 TS로 옮겨 짜야 합니다(아직 없음). 콘솔에서 client_id / client_secret을 발급받습니다. |
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
| **합계** | **약 $10∼20** |

---

## 2. 설치 순서

(2026-11-08 추가) 단계마다 끝에 적은 **확인**이 통과하면 다음 단계로 넘어갑니다.

### 2-1. 준비물

- **Node.js 24 이상 (LTS)**: `package.json`의 `engines`가 `node >=24.0.0`을 요구하고, `.npmrc`의 `engine-strict=true` 때문에 낮은 판이면 설치가 오류로 멈춥니다. Node 24는 `.ts` 파일을 빌드 없이 바로 실행합니다([학습서 15-2](1-study/15-config-deploy-ops.md#15-2-typescript를-빌드-없이-실행하기-node-24)).
- **pnpm 12.16.1**: `package.json`의 `packageManager`로 고정했습니다. `corepack enable`을 해 두면 이 버전이 자동으로 쓰입니다. Dockerfile과 CI도 같은 버전입니다.
- **LiveKit CLI 2.18.8 이상**: 에이전트 디버거(`lk agent debugger`)가 2.18.8부터 있습니다. 2.19.0부터는 `lk agent dev`가 워커를 무작위 `dev-…` 배포로 등록하므로, Agent Console은 터미널에 나오는 링크로 엽니다([4-setup-checklist.md 5-3](4-setup-checklist.md#5-3-브라우저-agent-console)).

```bash
brew install livekit-cli      # 맥. 리눅스는 curl -sSL https://get.livekit.io/cli | bash
lk --version
```

확인: `node -v`가 `v24.x`이고, 레포 폴더에서 `pnpm -v`가 `12.16.1`이고, `lk --version`이 2.18.8 이상입니다.

### 2-2. 스타터 프로젝트

이 레포(`xtool-ai-sales-agent`)가 공식 스타터 `agent-starter-node`를 바탕으로 이미 만들어져 있습니다. `lk agent init`은 따로 하지 않습니다.

```bash
lk cloud auth                                        # 브라우저로 LiveKit Cloud 로그인
pnpm install
```

- functions와 배포 단위가 달라 별도 레포로 둡니다([2-tech-stack.md 6장](2-tech-stack.md#6-전체-아키텍처)).
- (2026-11-08 갱신) 스타터의 기본 부품은 LiveKit Inference였지만, 이 레포는 이미 Soniox·Anthropic·ElevenLabs로 바꿔 두었습니다. 그래서 그대로 돌리려면 세 공급사의 키가 필요합니다(1장, 2-4). 키를 받기 전에 동작부터 보려면 `.env.local`에서 `STT_PROVIDER`·`LLM_PROVIDER`·`TTS_PROVIDER`를 모두 `livekit`으로 둡니다. 그러면 LiveKit Inference만 써서 공급사 키 없이 돕니다(`src/models/index.ts`). 이때 한국어 목소리를 들으려면 `TTS_VOICE`에 Cartesia 한국어 voice를 넣습니다.

확인: `lk project list`에 LiveKit Cloud 프로젝트가 보이고, `pnpm install`이 오류 없이 끝나고, `pnpm test`(키 없이 도는 단위 테스트)가 모두 통과합니다.

### 2-3. 플러그인 설치

Anthropic·ElevenLabs·Soniox 플러그인(1.9.5)은 `package.json`에 이미 들어 있어 `pnpm install`이면 됩니다.

- **VAD:** Silero 플러그인을 따로 설치하지 않습니다. `AgentSession`에 VAD를 넘기지 않으면 코어에 번들된 Silero(`inference.VAD`, `@livekit/local-inference`로 로컬 실행)가 자동으로 붙습니다. VAD(음성 활동 감지)는 소리에 말소리가 있는지만 가리는 작은 모델입니다([학습서 5장](1-study/05-vad.md)).
- **턴 감지:** 코어(`@livekit/agents`)에 내장돼 별도 설치가 없습니다. 한국어를 포함한 14개 언어를 지원합니다(LiveKit 문서, 2026-11-08 확인).
- **설치 스크립트 허용:** pnpm 11 이상은 정하지 않은 설치 스크립트를 오류로 막습니다. `pnpm-workspace.yaml`의 `allowBuilds`에 정해 두었습니다(`@livekit/blingfire`는 아무것도 하지 않는 스크립트라 `false`).
- (2026-11-08 추가) **Soniox 패치:** `pnpm install`이 `patches/`의 Soniox 플러그인 패치를 자동으로 적용합니다(`pnpm-workspace.yaml`의 `patchedDependencies`). 고객이 말을 멈추면 Soniox에 확정을 바로 요청하게 하는 수정입니다([4-setup-checklist.md 9장](4-setup-checklist.md#9-알아-둘-점)).
- **노이즈 제거:** 스타터에 들어 있던 ai-coustics 플러그인을 그대로 씁니다(`src/main.ts`의 `EnhancerModel.QuailVfS`). 플러그인의 기본 인증이 LiveKit Cloud 연결 정보(`Auth.livekitCloud()`)라서, 워커가 어디서 돌든 방이 LiveKit Cloud에 있으면 동작합니다. LiveKit 서버(SFU)를 직접 운영하면 ai-coustics 라이선스 키를 `auth`로 넘기고 요금은 ai-coustics가 받습니다. (2026-11-08 추가) LiveKit 문서와 요금표는 이 모델(QUAIL_VF_S)을 추가 요금이 붙는 "목소리 분리(voice isolation)"로 분류하고, Build 요금제에 100분, Ship에 1,000분을 포함합니다. 배경 소음만 줄이는 QUAIL_L은 추가 요금이 없습니다. Build에서 포함량을 넘긴 뒤 어떻게 되는지는 확인하지 않았습니다(LiveKit 문서 "Noise & echo cancellation").

확인: `pnpm install`이 `ERR_PNPM_IGNORED_BUILDS` 같은 오류 없이 끝나고, `grep -c "xtool-ai-sales-agent 패치" node_modules/@livekit/agents-plugin-soniox/dist/stt.js`가 `1`을 출력합니다(패치 적용).

### 2-4. 키 넣기

레포 루트의 `.env.example`을 `.env.local`로 복사해 채웁니다(커밋하지 않습니다):

```bash
LIVEKIT_URL=wss://<프로젝트>.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
ANTHROPIC_API_KEY=...
ELEVEN_API_KEY=...
SONIOX_API_KEY=...
TTS_VOICE=<ElevenLabs 한국어 음성의 Voice ID>
```

- (2026-11-08 갱신) LiveKit 값 세 개는 `lk cloud auth` 뒤 `lk app env -w`로 채울 수 있습니다. 이 명령은 `.env.example`을 바탕으로 `.env.local`을 만들고, 파일이 이미 있으면 덮어쓰지 않고 합칩니다(`lk app env --help`).
- `TTS_VOICE`를 비우면 ElevenLabs 기본 음성(영어)이 나옵니다. 음성 고르는 법은 [4-setup-checklist.md 3장](4-setup-checklist.md#3-계정과-키)의 3-4에 있습니다.
- `.env.example`의 `VOICE_RESULT_URL`·`VOICE_AGENT_SECRET`은 통화 결과를 functions-xtool로 보낼 때만 씁니다. 주소·비밀키·통화 id 가운데 하나라도 없으면 보내지 않고 로그만 남기므로, PoC에서는 둘 다 비워 둡니다(`.env.example`의 기본값). 주소 꼴은 `.env.example`의 주석에 있습니다([6-web-test.md 6-1](6-web-test.md#6-1-functions-xtool)).
- `.env.local`은 `.gitignore`에 이미 들어 있습니다.

확인: `git status`에 `.env.local`이 보이지 않습니다.

### 2-5. 실행과 테스트

```bash
lk agent console     # 터미널에서 마이크로 바로 대화
lk agent dev         # 개발 모드로 워커 실행 → LiveKit Cloud의 Agent Console(브라우저)에서 대화
```

- 예전 Agents Playground 주소는 이제 LiveKit Cloud의 **Agent Console**로 연결됩니다.
- (2026-11-08 추가) Agent Console은 `lk agent dev`가 터미널에 출력하는 링크로 열고, 에이전트 이름 `xtool-sales-agent`로 연결합니다. 이 레포는 에이전트 이름을 정해 두어 자동 배정이 되지 않기 때문입니다([4-setup-checklist.md 5-3](4-setup-checklist.md#5-3-브라우저-agent-console)).

확인: 첫 멘트 "안녕하세요, 김민수 고객님. 오리지널스 AI 상담사입니다…"가 한국어 음성으로 나오면 STT·LLM·TTS가 모두 연결된 것입니다. 이런 테스트에는 통화별 고객 정보(job metadata)가 없어 가상 고객(김민수)으로 진행합니다.

---

## 3. 부품을 바꿔 끼울 때 알아둘 것

부품은 `.env.local`의 `STT_PROVIDER`, `LLM_PROVIDER`, `TTS_PROVIDER`(와 각 `_MODEL`)로 고릅니다(`src/config.ts`). `livekit`을 고르면 LiveKit Inference를 쓰므로 별도 키가 필요 없습니다. (2026-11-08 추가) LLM은 `bedrock`(Amazon Bedrock 도쿄, AWS 키 필요, [4-setup-checklist.md 3장](4-setup-checklist.md#3-계정과-키)의 3-7)도 고를 수 있습니다. 생각 모드와 effort는 `LLM_THINKING`·`LLM_EFFORT`, 음성은 `TTS_VOICE`로 바꿉니다. 변수 목록과 기본값은 `.env.example`에 있고, 값을 바꾼 뒤에는 워커를 다시 시작합니다.

| 부품 | 주의 |
|---|---|
| **Claude Haiku 5.5** | 생각 모드가 기본으로 켜져 있고 effort 기본값도 medium이라 그대로 쓰면 느립니다. 플러그인 1.9.5에는 해당 옵션이 없지만 `chat()`의 `extraKwargs`가 요청 본문에 그대로 들어가는 것을 코드로 확인했습니다(2026-11-03). `src/models/anthropic.ts`가 이 경로로 `thinking: disabled`, `output_config.effort: low`, 자동 프롬프트 캐시를 넣습니다. 요청 본문은 `src/models/anthropic.test.ts`로 검증하고, 실제 지연은 `pnpm check:llm`으로 잽니다. `temperature`는 넣지 않습니다(Haiku 5.5는 기본값이 아니면 400). |
| **ElevenLabs v4 Turbo** | 플러그인이 지원합니다(내부적으로 Text-to-Dialogue WebSocket 사용). **voice id를 넣지 않으면 영어 기본 음성**이 나오니 `TTS_VOICE`에 한국어 음성을 넣습니다. (2026-11-08 갱신) **Flash v2.5는 숫자를 읽는 말로 바꾸는 텍스트 정규화가 지연 때문에 기본으로 꺼져 있습니다.** 엔터프라이즈 요금제는 `apply_text_normalization=on`으로 켤 수 있습니다(ElevenLabs 모델 문서, 2026-11-08 확인). 그래서 가격·전화번호는 한글로 풀어서 넣습니다. 이 레포는 지시문이 LLM에게 숫자를 한글로 쓰게 하고, 플러그인은 기본값 `apply_text_normalization=auto`를 보냅니다([학습서 10-1](1-study/10-tts.md#10-1-음성-합성은-어떤-단계를-거치나)). |
| **Soniox** | 플러그인 기본값은 `stt-rt-v4`라 `stt-rt-v5`를 지정합니다. 플러그인이 세션의 `keytermsOptions`를 지원하지 않아 제품명은 `context.terms`로 넣습니다(`src/glossary.ts`). 말 끝 확정을 앞당기는 패치(2-3)가 플러그인 1.9.5에 맞춰져 있어, 플러그인 판을 올리면 패치를 다시 확인합니다. |
| **리턴제로** | TS 플러그인이 없어 직접 연결 코드가 필요합니다. Python 플러그인 기본값(`sommers_ko`, 8kHz, `CALL` 도메인)을 참고합니다. |

---

## 4. PoC에서 확인할 것

| 항목 | 기준 | 지금까지 (2026-11-08) |
|---|---|---|
| 응답 지연 | 말 끝나고 AI가 말을 시작할 때까지 1초 안팎 | 본 답 첫소리까지 약 1.4초. 즉시 반응("네네.")을 먼저 들려줘 체감은 약 0.6∼0.8초 |
| 제품명 인식 | "F2 울트라", "메탈팹", "엑스툴", "P3" | Soniox는 TTS가 읽은 5문장에서 모두 맞음. 사람 목소리·전화 음질로는 아직 |
| 숫자 발음 | 가격, 전화번호, 날짜 | 따로 재지 않음 |
| 맞장구 처리 | "네", "음"에 AI가 멈추지 않는지 | 사람 목소리로는 아직 (`lk agent console`) |
| 끼어들기 | "잠깐만요", "아니요"에 바로 멈추는지 | 최소 길이를 0.2초로 줄임. 사람 목소리로 다시 재야 함 |
| 목소리 | 상담팀이 블라인드로 듣고 고르기 | ElevenLabs 후보 6개를 골라 둠. 청취 전 |
| 비교 기준선 | vox 홈페이지 LIVE DEMO 통화와 비교 | 아직 |

잰 값과 측정 방법은 [5-poc-results.md](5-poc-results.md)에 날짜순으로 있습니다.
