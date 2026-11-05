# 학습서 변경 이력

이 학습서는 레포가 바뀔 때마다 따라 고칩니다. 갱신할 때마다 아래 세 가지를 남깁니다.

1. **기준**: 어떤 커밋·작업 트리와 어떤 SDK 버전을 보고 썼나
2. **레포에서 바뀐 것**: 이번에 반영한 코드·문서 변경
3. **학습서에서 고친 곳**: 장·절 단위

최신 항목이 위에 옵니다. 본문에서 새로 넣은 절은 "(YYYY-MM-DD 추가)" 또는 "(YYYY-MM-DD 갱신)"으로 표시해, 이 파일과 본문을 오가며 찾을 수 있게 합니다.

---

## 갱신 절차

다음에 "바뀐 사항 반영"을 할 때는 이 순서로 합니다.

```bash
# 1. 마지막 기준 이후 바뀐 것 (기준 커밋은 아래 최신 항목의 "기준")
git log --oneline <기준 커밋>..HEAD
git diff --stat <기준 커밋> -- . ':!docs/1-study'
git status --short                     # 아직 커밋 안 된 변경
# 지난 기준에 미커밋 작업 트리가 있었으면, 커밋되기 전에 더 바뀌었을 수 있음 (7차에서 놓친 끼어들기 로그)
git log -p <기준 커밋>..HEAD -- src    # 커밋마다 지난번 본 것과 다른 줄이 있는지

# 2. SDK·플러그인 버전이 바뀌었나 (바뀌면 SDK 내부 설명 장을 다시 확인)
grep -E '"@livekit/' package.json
lk --version

# 3. 연결된 originalshq 쪽이 바뀌었나 (받는 쪽 함수, 관리 화면. 기준 커밋은 최신 항목의 "기준")
git -C ../originalshq log --oneline <기준 커밋>..HEAD -- \
  functions-xtool/src/endpoints/voice-agent.ts functions-xtool/src/voice-call src/screens/log
```

바뀐 파일에 따라 다시 볼 장입니다.

| 바뀐 것 | 다시 볼 장 |
| --- | --- |
| `src/main.ts` (세션 설정, 턴·끼어들기 옵션, 첫 멘트) | 4, 7, 11, 13 |
| `src/agent.ts`, `src/ack.ts` (훅, llmNode, 즉시 반응) | 11, 12 |
| `src/prompt.ts` (지시문, 첫 멘트) | 9 |
| `src/models/*` (공급사 래퍼, STT 확정, Bedrock 클라이언트) | 6, 8, 15, 16 |
| `src/glossary.ts`, `src/transcript.ts`, `src/pronunciation.ts` | 6, 10, 12 |
| `src/call-context.ts` (metadata 계약) | 4 |
| `src/config.ts` | 15 |
| `*.test.ts`, `scenarios.yaml`, `.github/workflows/` | 14 |
| `package.json`·`pnpm-lock.yaml`의 `@livekit/*` 버전, `patches/` | 4, 5, 6, 7, 10, 11 (SDK 내부 동작), 15 |
| `Dockerfile`, `pnpm-workspace.yaml`, `.gitignore` | 15 |
| `.env.example`의 인증 변수, `@anthropic-ai/bedrock-sdk` 버전, 배포 비밀값 목록 | 15-5, 16 |
| `scripts/*` (측정 스크립트) | 8-9, 13 |
| `docs/5-poc-results.md` 새 측정 | 수치를 인용한 장 (6, 7, 8, 9, 11, 13) |
| `docs/*.md` 새 설계 문서 | 1(전체 그림) + 해당 주제 장 |
| originalshq `functions-xtool/src/endpoints/voice-agent.ts`, `voice-call/*` | 3-7, 4-3(계약 사본), 8-11(판정), 15-6(저장·트리거) |
| originalshq `src/screens/log/` (AI 상담원 탭) | 3-7, 4-3, 15-6 |

마무리할 때:

- 17-2 발견 사항 표의 상태(확인 필요 → 확인됨·고침)를 갱신합니다.
- 링크 검사: 모든 상대 링크와 `#앵커`가 실제로 있는지 확인합니다.
- 이 파일에 항목을 추가합니다.

---

## 이력

### 2026-11-05 (11차): #26·#27 고침, #28(LLM 연결 4초 유휴 종료) 발견

#### 기준

- 이 레포: 커밋 `6e11225`. 9차 문서는 `faccdf0`, 10차 이름 바꾸기는 `b63bed0`으로 들어감
- originalshq: `6a35817`. 지난 기준(`5da425a`) 이후 받는 쪽(voice-agent·voice-call·관리 화면)에는 변경 없음. 이번에 `voice-call/analyze.ts` 주석의 문서 이름만 고침(10차 확인 필요 해소)
- 버전: 9차와 같음 (`@livekit/agents` 1.9.5, `@anthropic-ai/bedrock-sdk` 1.1.1)

#### 레포에서 바뀐 것

| 커밋 | 내용 | 학습서 반영 |
| --- | --- | --- |
| `ae92c72` #26 | `createBedrockClient()`가 `apiKey: null`로 Bedrock API 키 환경변수를 읽지 않음. `index.test.ts`가 남은 변수를 흉내 내고 SigV4 서명 확인 | 8-8 코드·설명, 16-4 "함정"에 고친 뒤, 16장 확인 문제 5번, 17-2 #26 |
| `6e11225` #27 | `VoiceAnthropicLLM`의 `prewarmUrl` 옵션: Bedrock일 때 같은 호스트에 HEAD로 미리 연결. 테스트 추가 | 8-8 "미리 연결 대신 하기" 신설, 17-2 #27 |

#### 실험으로 확인한 것 (가짜 키, 거절 응답만 받음, 맥 서울)

- Bedrock 주소에 HEAD → 404와 `connection: close`. 서버가 연결을 닫지만, 6초 뒤 첫 요청이 짝지은 6번 모두 미리 연결 없이 보낸 것보다 빠름(중앙값 약 0.165초 vs 0.21초). DNS·TLS 세션 재개 몫
- 서명한 요청 뒤 쉬는 시간별 연결 재사용: Bedrock 0·3초 재사용, 5·10초 새 연결. Anthropic 경로(SDK 0.33, `agentkeepalive`) 0·3초 재사용, 6초 새 연결
- → **17-2 #28 (새로)**: 클라이언트가 쉬는 연결을 4초 뒤 닫음(undici `keepAliveTimeout`, `agentkeepalive` `freeSocketTimeout` 기본값). 턴 사이가 4초를 넘으면 매 턴 다시 연결할 수 있고, A/B(`compare-llm`)는 재사용된 연결로 잰 값
- 실제 IAM 키에 가짜 `AWS_BEARER_TOKEN_BEDROCK`을 넣고 한 번 호출: 인증 통과, Haiku 5.5는 여전히 모델 사용 자격 403. `.env.local`의 그 줄은 이미 지워져 있었음

#### 학습서에서 고친 곳

| 장 | 내용 |
| --- | --- |
| 8 | 8-8 표·코드·인증 설명, "미리 연결 대신 하기"(prewarm의 원리, 실험 표, 세션 재개, 4초 유휴 종료), Haiku 5.5 확인 순서에서 #26 조건 뺌, 8-9 compare-llm 주의를 "재사용된 연결로 잰 값"으로 |
| 13 | 13-5 남은 확인을 "실제 통화의 턴별 첫 토큰"으로, 작은 지연 표에 "LLM 연결 유휴 종료" |
| 15 | 15-5 배포 비밀값: Bedrock API 키는 코드가 읽지 않음 |
| 16 | 16-4 함정을 고친 뒤 기준으로, 확인 문제 5번 |
| 17 | 17-1 용어 2개 (세션 재개, 유휴 연결 종료), 17-2 #26·#27 → 고침, **#28 추가** |
| 세팅 문서 | 4-setup-checklist 3-7, 6-web-test 배포 목록의 API 키 설명 |

#### 새 확인 필요

- 17-2 #28: 실제 통화(웹 테스트)에서 턴 사이 간격과 턴별 LLM 첫 토큰. 다시 맺는 몫이 크면 고객 말이 끝날 무렵 다시 데우기를 검토
- Haiku 5.5가 열리면 `LLM_PROVIDER=bedrock pnpm check:llm`으로 운영 옵션 확인, A/B 다시 재기

### 2026-11-05 (10차): 문서 이름에 읽는 순서 번호, 16장·17장 맞바꿈

#### 기준

- 9차와 같음 (이 레포 `7b4feeb` + 미커밋 9차 작업). 코드 동작은 바뀌지 않음

#### 바꾼 것

`docs/`에 문서가 많아 무엇부터 읽을지 모르겠다는 요청으로, 파일 이름 앞 번호를 읽는 순서에 맞췄습니다.

| 전 | 후 |
| --- | --- |
| `docs/study/` | `docs/1-study/` |
| `docs/tech-stack.md` | `docs/2-tech-stack.md` |
| `docs/poc-setup.md` | `docs/3-poc-setup.md` |
| `docs/setup-checklist.md` | `docs/4-setup-checklist.md` |
| `docs/poc-results.md` | `docs/5-poc-results.md` |
| `docs/web-test.md` | `docs/6-web-test.md` |
| `docs/telephony-setup.md` | `docs/7-telephony-setup.md` |
| `16-glossary-and-next.md` (16장) | `17-glossary-and-next.md` (17장) |
| `17-cloud-accounts-iam.md` (17장) | `16-cloud-accounts-iam.md` (16장) |

- 학습서의 권장 순서가 "… 15 → 17 → 16"이라 번호와 어긋나 있었습니다. 용어집·발견 사항 장이 맨 뒤에 오도록 두 장을 맞바꿔, 이제 번호 순서가 곧 읽는 순서입니다. 절 번호도 따라 바뀌었습니다(발견 사항 표 16-2 → **17-2**, 클라우드 권한 17-x → 16-x).
- 이 파일의 이전 기록(1차~9차)에 있는 장·절 번호와 경로도 새 이름으로 바꿨습니다. 기록에서 바로 본문을 찾아가게 하려는 것입니다. "초판 16장", "1~16장"처럼 그때의 장 개수는 그대로 두었습니다. 옛 이름의 git 이력은 `git log --follow`로 봅니다.

#### 고친 곳

| 곳 | 내용 |
| --- | --- |
| 모든 장 | 2~7번 문서로 가는 링크, 16·17장 번호·링크·앵커 |
| 17 | 17-1 용어집의 장 표시 `(17)` → `(16)` 14곳. 숫자만 적혀 있어 처음 일괄 변경에서 빠졌던 곳 |
| README | 목차의 16·17장, 읽는 순서(처음부터 = 번호 순서, **5시간 핵심** 추가), 걸리는 시간, 다른 문서 표를 번호 순서로 |
| 15 | 첫머리 "마지막 기술 장" → 클라우드 권한은 다음 16장으로 안내 |
| 이 파일 | 갱신 절차의 경로·장 번호, 이전 기록의 번호 |
| 레포 | `README.md` 문서 표(번호 순서), `AGENTS.md`, `src/config.ts`·`.env.example` 주석의 문서 경로 |

#### 확인 필요

- originalshq `functions-xtool/src/voice-call/analyze.ts`의 주석이 옛 이름(`docs/tech-stack.md 4-3`)을 가리킴. originalshq 코드라 고치지 않음

### 2026-11-05 (9차): 16장 신설(클라우드 계정과 권한), Bedrock 클라이언트·A/B 반영, #26·#27, 배포 비밀값 목록 바로잡기

#### 기준

- 이 레포: 커밋 `7b4feeb`. 8차 작업은 커밋 5개(`cae674f`~`bddb617`)로 들어갔고, 이번 작업 중에 다른 작업이 Bedrock을 커밋 2개로 올림(`144d25b` 공급자·측정 스크립트, `7b4feeb` A/B 결과). 처음에는 그 작업이 미커밋으로 진행 중이라 16장(권한)부터 쓰고, 커밋된 뒤 8·13장과 세팅 문서를 이어서 반영함
- originalshq: `5da425a`. 받는 쪽 변경은 `918c50a`의 `voice-agent.ts` 하나(비밀키 확인을 입력 검사보다 먼저)
- AWS 과정의 사실관계: 다른 작업의 대화 기록(오류 본문, 순서, 시각, A/B에 쓴 임시 스크립트)과 AWS 공식 문서(Bedrock API 키·권한, 예시 SCP, 모델 사용 신청, 교차 리전 추론 IAM)
- 확인 당시 상태: 사용 목적 양식은 처리됨(같은 IAM 키로 Haiku 4.5·Sonnet 4.6 응답). **Haiku 5.5만 이 계정에 열리지 않아** AWS 지원에 요청하는 단계. A/B는 양쪽 Haiku 4.5로 측정
- 버전: `@livekit/agents` 1.9.5, `@anthropic-ai/bedrock-sdk` 1.1.1

#### 레포에서 바뀐 것 (반영 대상)

| 바뀐 것 | 내용 | 반영 |
| --- | --- | --- |
| `144d25b` Bedrock LLM 공급자 | `LLM_PROVIDER=bedrock`, 기본 모델 `jp.anthropic.claude-haiku-5-5`, `VoiceAnthropicLLM`에 `AnthropicBedrock` 클라이언트를 강제 변환으로 끼움, `pnpm compare:llm`, `.env.example` AWS 변수 | 8-8 "연결만 바꿔 끼우기", 8-9 "A/B 도구", 16-4 |
| `7b4feeb` A/B 결과 | Anthropic API p50 0.77초 vs Bedrock `jp.` 0.66초 (Haiku 4.5, 12회 번갈아), 계정 설정에서 겪은 것 | 13-5 "Bedrock 도쿄 A/B 결과", 16-1 |
| AWS 계정 준비 (코드 밖) | 무료 → 유료 플랜, 도쿄 API 키(SCP에 막힘) → IAM 사용자 액세스 키, Anthropic 첫 사용 양식을 관리 계정에서 제출, Haiku 5.5만 계속 막힘 | 16-1(거절 표), 16-2, 16-5, 16-6, 16-8 |
| originalshq `918c50a` | `submitVoiceCallResult`가 비밀키(401)를 본문 검사(400)보다 먼저 확인 | 15-6 |

#### 코드·문서로 확인한 것

- Bedrock SDK의 인증 우선순위: `apiKey` 인자 > `AWS_BEARER_TOKEN_BEDROCK` > 생성자의 AWS 키 > `AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY` > 기본 체인(`client.js` 생성자, `core/auth.js`). `apiKey: null`이면 환경변수 토큰을 보지 않음. `ANTHROPIC_API_KEY`는 일부러 읽지 않음
- → **17-2 #26 (새로)**: `.env.local`에 남은 단기 API 키가 IAM 키보다 먼저 쓰임. 커밋된 코드에도 그대로이고, 확인용 `curl`과 A/B 임시 스크립트는 변수를 지워 우회함
- 플러그인은 끼운 클라이언트로 `messages.create`, `models.list`(미리 연결), `baseURL`(지표 라벨)만 씀(`dist/llm.js`). `AnthropicBedrock`에는 `models`가 없음
- → **17-2 #27 (새로)**: Bedrock 경로의 LLM 미리 연결이 TypeError로 실패하고 SDK `LLM.prewarm()`이 삼킴. 가짜 키로 오프라인 재현함. 강제 변환 때문에 컴파일러도 못 잡음
- 플러그인의 `maxRetries` 기본 0은 "the framework owns retries"(`dist/llm.d.ts`)
- SDK가 Messages 요청을 `/model/{id}/invoke-with-response-stream`으로 다시 쓰고 `anthropic_version`을 넣음(`client.js`), 응답의 AWS 이진 이벤트 스트림을 SSE로 바꿈(`core/streaming.js`). `thinking`·`output_config`·맨 위 `cache_control`은 본문에 그대로 남음 → Bedrock이 받는지 미확인
- A/B 측정은 운영 경로가 아니라 기본 `anthropic.LLM` + Haiku 4.5 + `maxTokens: 300`으로 함(다른 작업의 임시 스크립트)
- AWS 문서: API 키 사용은 `bedrock:CallWithBearerToken`과 `bedrock-mantle:CallWithBearerToken`이 따로 → 같은 키가 Mantle에서는 통과한 이유. Anthropic 첫 사용 양식은 계정마다 또는 관리 계정에서 한 번. 서버리스 모델 첫 호출의 자동 구독에는 `aws-marketplace:*` 권한 필요, 최대 15분
- 학습서 15-5의 LiveKit Cloud 비밀값 명령이 [6-web-test.md](../6-web-test.md) 6장보다 낡아 `VOICE_RESULT_URL`·`VOICE_AGENT_SECRET`이 빠져 있었음. 그대로 배포하면 통화 결과를 보내지 않음

#### 학습서·문서에서 고친 곳

| 장·문서 | 고친 곳 |
| --- | --- |
| 16 | **새 장**: 인증과 인가, 실제로 받은 거절 여섯 번과 전파 대기 표(같은 문구 다른 원인을 대조 비교로 가르기), AWS 계정·조직·리전, 자격 증명 종류(액세스 키·STS·Bedrock API 키), SigV4, 자격 증명 체인과 Bedrock SDK 우선순위(#26), IAM 평가 순서와 SCP, 최소 권한 예시 정책, 모델 사용 신청·추론 프로필·두 창구, GCP 서비스 계정·서비스 에이전트(Eventarc 사례), 권한 전파 지연, 운영에서 키 다루기, 확인 문제 9개 |
| 8 | 8-8 **"응용: 연결만 바꿔 끼우기, Bedrock 클라이언트" 신설** (플러그인이 클라이언트로 하는 일 세 가지, 타입 강제 변환의 대가, 옵션이 그대로 흘러감, `maxRetries: 0`), 8-9 **"A/B 도구: compare-llm" 신설** (번갈아 재기, p50·p90·최소의 뜻, 작은 표본) |
| 13 | 13-5 16장 연결, **"Bedrock 도쿄 A/B 결과" 신설** (최소와 중앙값의 차이로 거리 몫과 서버 대기 가르기, 운영에 옮기기 전 남은 확인 세 가지) |
| 15 | 15-5 비밀값 명령에 `VOICE_RESULT_URL`·`VOICE_AGENT_SECRET` 추가, Bedrock 배포 때 넣을 것·넣지 말 것, 15-6 결과 함수의 인증 순서 갱신, 15-8 "클라우드 자격 증명" 줄 |
| 17 | 17-1 용어 14개 추가 (관리 계정, 명시적 거부, 베어러 토큰, 서비스 계정·에이전트, 워크로드 아이덴티티 연동, 자격 증명 체인, 최소 권한, 최종 일관성, 추론 프로필, ARN, IAM, SCP, SigV4, STS), 17-2 #26·#27 추가, 17-3 읽을 코드·검색어, 17-4 실습 9 |
| README | 목차에 16장, 8장 설명, 분량, 읽는 순서(처음부터, 운영 준비, 클라우드 권한만) |
| [4-setup-checklist.md](../4-setup-checklist.md) | 3-7 AWS Bedrock 계정·키, 4장 `.env.local`의 Bedrock 변수, 6장 비교표에 Anthropic API ↔ Bedrock |
| [6-web-test.md](../6-web-test.md) | 6장 LiveKit Cloud 배포에 Bedrock 변수 안내 |

#### 새로 남긴 확인 필요

- Haiku 5.5가 열리면: #26을 정리한 뒤 `LLM_PROVIDER=bedrock pnpm check:llm`으로 운영 경로가 Bedrock에서 400 없이 도는지(특히 맨 위 `cache_control` 자동 캐시), 그다음 `pnpm compare:llm`으로 Haiku 5.5끼리 A/B
- #27의 영향: Bedrock 경로에서 통화의 첫 LLM 요청 첫 토큰이 두 번째 요청보다 얼마나 느린지
- `AmazonBedrockLimitedAccess`가 첫 호출의 Marketplace 구독 권한을 포함하는지 (좁은 정책으로 바꿀 때 빠뜨리기 쉬움)
- 16-5절 예시 정책을 실제 호출(또는 정책 시뮬레이터)로 검증
- GKE에 올릴 경우 워크로드 아이덴티티 연동으로 AWS 장기 키 없이 Bedrock을 부를 수 있는지

### 2026-11-04 (8차): #21·#20·#11·#25 수정, 방 삭제를 한곳으로, 지연 기록 거르기, 7차 누락 보충

#### 기준

- 이 레포: 커밋 `354eca6` (7차 작업이 커밋 3개 `ce8c7c7`·`71a435d`·`354eca6`로 들어감) + 이번 미커밋 수정 (`src/main.ts`, `src/agent.ts`, `src/call-result.ts`, `src/call-result.test.ts`)
- originalshq: `d7054a1` (7차와 같음, 받는 쪽 변경 없음)
- 7차에서 빠뜨린 것: 커밋 `ce8c7c7`의 끼어들기 판정 로그. 7차는 작업 트리의 `minDuration` 변경만 봤고, 로그는 커밋되기 전에 더해져 같은 커밋에 들어감 → 이번에 7장·11장에 보충. 갱신 절차 1단계에 `git log -p` 확인을 더함
- 확인 당시 상태: `pnpm test` **32개** 통과(`addLatency` 4개 추가, `-1` 거르기를 빼면 실패함을 확인), `typecheck`·`lint`·`format:check` 통과. `lk agent debugger`로 "운전 중이라 통화 곤란 → 내일 다시" 대화에서 `end_call` 호출 뒤 세션이 오류 없이 닫힘을 확인 (텍스트 모드라 방 삭제 경로는 지나지 않음)
- 버전: `@livekit/agents` 1.9.5

#### 이번에 고친 것 (이 작업)

| 파일 | 변경 | 관련 |
| --- | --- | --- |
| `src/main.ts` | `inputOptions.deleteRoomOnClose: true`. `endCall`이 종료 콜백에 등록하던 `ctx.deleteRoom()`을 지움 | 17-2 #21 → 고침, #12 → 대응 |
| `src/agent.ts` | `createEndCallTool({ deleteRoom: false })`. 방은 세션이 닫힐 때 한 번만 지움 | 4-7, 9-6 |
| `src/call-result.ts` | `addLatency`가 0 미만(`-1`, 값 없음)을 뺌. `cancelled`는 남김(빼면 느린 턴이 골라 빠짐) | 17-2 #20 → 고침, 13-5 |
| `src/main.ts` | 즉시 반응 미리 합성에 세션과 다른 TTS 객체(`ackTts`)를 쓰고, 다 만든 뒤 닫음. 미리 합성 몫이 지연 기록에 섞이지 않음 | #20, 13-5 |
| `src/call-result.test.ts` | `addLatency` 테스트 4개 (반올림, `-1` 제외, 취소돼도 값 유지, 다른 지표 무시) | 14-2 |
| `src/main.ts` | 끼어들기 판정 로그를 끼어들기·맞장구·**판단 없음**(`agentEnded`) 셋으로 나눔 | 17-2 #25 (새로, 고침), 7-5 |
| `src/main.ts` | 아무 일도 안 하던 `await ctx.connect()`를 지우고 "연결은 `session.start()`가 함" 주석 | 17-2 #11 → 고침, 4-6 |
| `docs/5-poc-results.md`, `docs/6-web-test.md` | 끼어들기 최소 길이 0.2초 기록, 웹 테스트 5장에 "코드 변경 뒤 첫 웹 통화에서 볼 것" 표 | — |

#### SDK 코드로 확인한 것

- RoomIO는 세션의 `Close` 이벤트에서 방 삭제를 시작하고, 자기를 닫을 때 그 삭제를 최대 10초(`DEFAULT_API_CONNECT_OPTIONS.timeoutMs`) 기다림(`voice/room_io/room_io.ts`). 넘으면 경고만 남김.
- 방이 지워지면 에이전트 쪽 `RoomEvent.Disconnected`로 잡이 끝남(`ipc/job_proc_lazy_main.ts`). 그래서 고객이 먼저 끊어도 유예 시간을 기다리지 않음.
- `JobContext.deleteRoom()`은 오류를 안에서 받아 경고("error while deleting room")만 남김. 방을 두 곳에서 지우면 두 번째가 통화마다 이 경고를 냄 → 한곳으로 모은 이유.
- `end_call` 도구의 `deleteRoom` 기본값은 `true`(`beta/tools/end_call.ts`).
- LLM·TTS 지표의 `cancelled`는 요청의 abort 여부(`llm/llm.ts`, `tts/tts.ts`). SDK도 이것을 "끊김(interrupted)"으로 기록함. 첫 토큰이 나온 뒤 취소됐으면 `ttftMs`는 실제 값.
- 디버거 로그 비교: 고치기 전(`13:10` 실행)에는 첫 멘트 앞에 TTS 지표 3건(소리 0.64·0.88·1.28초, 첫 음성 약 1.1초)이 미리 합성 몫으로 들어갔고, 고친 뒤에는 첫 멘트·첫 질문 2건만 남음.
- `OverlappingSpeech`는 겹침마다 끼어들기(겹치는 중 판정)·맞장구(고객 소리가 먼저 그침)·판단 없음(`agentEnded`: 에이전트 말이 먼저 끝남, `isInterruption`은 늘 false)으로 옴(`inference/interruption/interruption_stream.ts`). SDK 통계는 판단 없음을 맞장구 수에서 뺌.
- `session.start()`는 방이 연결되지 않았으면 잡 문맥으로 `ctx.connect()`를 부름(`voice/agent_session.ts`). 디버거 로그 "Auto-connecting to room via job context"로도 확인. 스타터 첫 판의 `main.ts`에 뒤이은 `ctx.connect()`가 있었음.
- 디버거 로그에서 첫 멘트의 TTS 첫 음성 0.78~0.84초, 다음 말 0.18~0.23초 → 17-2 #9의 실측 단서.
- 세션은 자기 TTS 객체의 `metrics_collected`만 구독(`voice/agent_activity.ts`). 발화 안의 지표에는 `speechId`가 붙음(`AsyncLocalStorage`). ElevenLabs `synthesize()`는 HTTP 요청이라 세션의 웹소켓 연결과 무관(플러그인 `tts.ts`).

#### 학습서에서 고친 곳

| 장 | 고친 곳 |
| --- | --- |
| 3 | 3-7 "통화가 끝난 뒤 화면" 단락: 두 경로 모두 바로 끝남 |
| 4 | 4-6 RoomIO 표의 연결 줄(연결하는 것은 세션)과 `ctx.connect()` 정리, 4-7 종료 콜백 단락, "고객이 전화를 끊으면"에 고친 뒤 순서, SIP 사유 표 `ROOM_DELETED` 줄, "에이전트가 먼저 끊을 때" 표·코드 갱신, **"방 삭제를 한곳으로 모으기" 신설** (부수 효과의 주인은 하나, 멱등하지 않은 연산) |
| 7 | 7-5 **"판정을 로그로 보기" 신설** (7차에서 빠진 `ce8c7c7`의 판정 로그: 이벤트 세 경우, 값의 뜻, "안 끊김" 증상 가르기, "아니다"와 "모른다" 나누기) |
| 9 | 9-6 `end_call` 코드와 설계 표에 `deleteRoom: false` |
| 11 | 이벤트 표 `Close` 줄과 `OverlappingSpeech`·`AgentFalseInterruption` 줄, 11-4 선제 생성 4번(취소된 시도 지표를 일부러 남김) |
| 13 | 13-5 **"지연 기록에 섞이는 값"을 고친 뒤 기준으로 다시 씀**, **"무엇을 빼면 안 되나: 중도 절단과 생존자 편향" 신설** (`cancelled`를 빼려던 이전 판을 뒤집은 이유, `speechId` 거르기 대신 객체 분리를 고른 이유) |
| 14 | 14-2 표 `call-result.test.ts` 줄 |
| 15 | 15-5 "고객이 먼저 끊으면", 15-6 **"끝나는 경로별 시간표"를 고친 뒤 기준으로 다시 씀** (고치기 전 순서는 인용으로 남김), 입력 상한·평균 지연 단락 |
| 17 | 17-2 #12 → 대응, #11·#20·#21 → 고침, #25 추가(고침), #9에 실측 단서. 용어 3개 추가 (부수 효과의 주인, 생존자 편향, 중도 절단) |

#### 새로 남긴 확인 필요

- 실제 웹 통화에서 "통화 끝내기"를 누른 뒤 에이전트 로그에 `deleting room on agent session close`가 찍히고, 결과가 몇 초 안에 뜨는지 (7차의 "#21 지연 실측"을 대신함)
- AI가 끊는 경로에서 `error while deleting room` 경고가 더는 나지 않는지
- 실제 통화에서 즉시 반응 미리 합성이 여전히 첫 턴 전에 끝나는지(디버거에서는 경고 "즉시 반응 음성을 미리 만들지 못했습니다" 없음)
- 실제 통화의 끼어들기 로그에서 세 판정이 어떤 비율로 나오는지, "맞장구로 판단" 중 확률이 기준 근처인 경우가 얼마나 되는지 (한국어 맞장구 표본)
- `-1`(값 없음) 건수: 기록 모양을 바꾸지 않아 Firestore에는 없음. 필요하면 `metrics.logMetrics` 로그로 세거나 originalshq와 `CallLatency`에 칸을 더할지 정하기

### 2026-11-04 (7차): #22 수정, 받는 쪽 코드 읽기, 끼어들기 200ms, 발견 사항 확인

#### 기준

- 이 레포: 커밋 `4ecef6d` + 미커밋 작업 트리 (`src/main.ts`의 `minDuration` 200, 이번 `src/prompt.test.ts` 수정)
- 6차의 미커밋 작업 트리는 `feat/voice-agent-tuning` 브랜치에서 커밋 7개(`5585080`~`4ecef6d`)로 나뉘어 main에 fast-forward로 합쳐짐. 내용은 6차 때 본 것과 같음
- originalshq: `d7054a1` (음성 에이전트 관련 커밋 `a7687d0`, `d57c577`, `d7054a1`)
- 확인 당시 상태: `pnpm test` **28개** 통과 (파일 7개), `typecheck`·`lint`·`format:check` 통과, functions-xtool `tsc --noEmit` 통과
- 버전: `@livekit/agents` 1.9.5 (3차와 같음), originalshq functions-xtool `@anthropic-ai/sdk` 1.4.0

#### 이번에 고친 것 (이 작업)

| 파일 | 변경 | 관련 |
| --- | --- | --- |
| `src/prompt.test.ts` | `expect(loadKnowledge()).toBe('')`를 두 테스트로 나눔: 템플릿 모양 입력으로 `cleanKnowledge` 시험, 실제 파일은 작성 안내 주석이 새지 않는지만 확인. 채운 파일은 통과하고 닫히지 않은 주석은 실패함을 직접 확인 | 17-2 #22 → 고침, 14-2 |

#### 레포에서 바뀐 것

| 파일 | 변경 |
| --- | --- |
| `src/main.ts` (사용자, 미커밋) | 끼어들기 최소 길이 `minDuration` 300 → **200**ms. 300에서 멈추기까지 약 0.4초. 맞장구에 자꾸 멈추면 250으로 올림 |
| originalshq `functions-xtool/src/endpoints/voice-agent.ts` | `createVoiceAgentSession`(토큰), `submitVoiceCallResult`(비밀키 상수 시간 비교, `create()`로 처음 것만 저장), `extractVoiceCallJudgment`(`xtool-read` DB 문서 생성 트리거), `getVoiceCall`(관리자 조회) |
| originalshq `functions-xtool/src/voice-call/analyze.ts`, `types.ts` | Opus 5.5 구조화 출력(zod), `'미확인'` 선택지, effort low, 서버 측 대체 모델(`fallbacks: 'default'`), 거절·파싱 실패 검사 |
| originalshq `src/screens/log/` | AI 상담원 탭: `LiveKitRoom`로 통화, 끝나면 3초마다 최대 2분 결과 조회, 요약·판정 칸·평균 지연·대화록 표시 |

#### SDK 코드·문서로 확인한 것

- 종료 콜백은 `room.disconnect()` 뒤에 `Promise.allSettled`로 서로 병렬 실행. Node `shutdownProcessTimeout` 기본값은 60초(문서의 10초는 Python).
- 고객이 나가면 RoomIO가 세션만 닫고 잡은 남음. 방은 에이전트가 아닌 마지막 참가자가 나간 뒤 `departure_timeout`이 지나야 닫힘 → #21 확인.
- `RoomInputOptions.deleteRoomOnClose`가 Node 1.9.5 공개 타입에 있음. 문서는 Python 전용으로 표시 → #23, LiveKit에 문서 피드백 보냄.
- LLM·TTS 지표는 첫 토큰·첫 음성이 없으면 `-1`. SDK 자체 텔레메트리는 `ttftMs >= 0`만 씀 → #20 확인.
- 적응형 끼어들기에서 `minDuration`은 발화 첫 1초(`backchannelBoundary`)에만 쓰이고, 그 뒤 판정 모델 경로(`onOverlapSpeech`)에는 길이 검사가 없음.
- SIP 끊김 사유 중 `USER_UNAVAILABLE`·`SIP_TRUNK_FAILURE`는 세션을 자동으로 닫지 않음(발신 단계 주의).
- `analyze.ts`의 API 모양(`fallbacks: 'default'`와 `server-side-fallback-2026-07-01` 짝, Opus 5.5 생각 모드 항상 켜짐·기본 effort medium, 베타 경로의 `betaZodOutputFormat`)이 Claude API 참고 자료와 맞음.

#### 학습서에서 고친 곳

| 장 | 고친 곳 |
| --- | --- |
| 1 | 결과 경로 그림에 8-11·15-6절 연결 |
| 3 | 3-7에 "통화가 끝난 뒤 화면" 한 단락 |
| 4 | 4-3 **계약 사본 전체 표**, 4-7 종료 순서(콜백 병렬, 60초), 방이 닫히는 규칙, **SIP 끊김 사유 표** |
| 5 | 끼어들기 감지 값 200ms |
| 7 | **`minDuration` 500 → 300 → 200 절 다시 씀** (멈추기까지 시간의 구성, 방식별 효과, 대가), 수치·확인 문제 답 갱신 |
| 8 | **8-11 "통화 후 판정 코드 읽기: 구조화 출력" 신설** (제약 디코딩, 스키마도 지시문, 강제 선택과 `'미확인'`, 거절과 대체 모델), 확인 문제 7·8 |
| 9 | 9-2⑨에 지식 파일 주석 누출 테스트 |
| 13 | 13-5 지연 기록 표에 `-1` 표지값, 거르는 코드 예 |
| 14 | 14-2 표 갱신, **"데이터의 지금 상태를 고정한 테스트" 사례 신설** (변경 감지 테스트, 불변식, 테스트가 실패할 수 있는지 확인) |
| 15 | **15-6 "받는 쪽 코드 읽기" 신설** (상수 시간 비교, `create()`와 멱등 키, 이벤트로 잇기와 최소 한 번 전달, 이름 있는 DB와 트리거, **끝나는 경로별 시간표**, 조회 화면) |
| 17 | #12·#17·#20·#21 확인됨으로, #22 고침, **#23·#24 추가**. 용어 9개, 읽을거리 2줄 |
| 여러 장 | 커밋됐으므로 "작업 중인 코드" 표시 30여 곳 정리 |

#### 새로 남긴 확인 필요

- #21의 실제 지연 시간(방 유예 시간 값)은 재 보지 않음. 웹 테스트에서 "통화 끝내기"를 눌러 결과가 뜨기까지 시간을 재면 됨.
- `minDuration` 200의 효과는 적응형 방식에서 발화 첫 1초 안의 끼어들기에만 나타남. 나눠서 재 봐야 함(7-5).

### 2026-11-03 (6차): 지식 자료, 시뮬레이션 회차 기록, LLM 지역 조사 반영

5차를 마무리하며 `git status`를 다시 보니 새 변경이 있어 바로 이어서 반영했습니다.

#### 기준

- 커밋 `d3a605b` + 미커밋 작업 트리 (5차와 같은 작업 트리에 이후 변경 추가)
- 확인 당시 상태: `pnpm test` 27개 통과 (지식 테스트 포함)

#### 레포에서 바뀐 것 (사용자 작업, 미커밋)

| 파일 | 변경 |
| --- | --- |
| `knowledge/xtool.md` 신규 | 상담팀이 채우는 회사·기기 정보 템플릿. 지금은 작성 안내 주석뿐(빈 지식) |
| `src/knowledge.ts` 신규 | `cleanKnowledge`(주석·빈 줄 제거), `loadKnowledge`(소스 위치 기준 경로로 한 번 읽기) |
| `src/prompt.ts` | `buildInstructions(ctx, knowledge)`: 지시 → "# 회사·기기 정보" → 고객 정보. `dedent`를 두 덩어리로 나눔 |
| `src/main.ts`, `src/agent.ts` | 최상위에서 지식 로드 → 에이전트에 전달 |
| `src/prompt.test.ts` | 지식 위치(고객 정보 앞), 빈 지식이면 칸 없음, 주석 제거 테스트 |
| `docs/5-poc-results.md` "개선 묶음" | 바꾼 것 표, 시뮬레이션 4/6 → 3/6 → 6/6 → 6/6(회귀), LLM 아시아 처리 조사(Bedrock `jp.`만) |

#### 학습서에서 고친 곳

| 장 | 고친 곳 |
| --- | --- |
| 9 | **9-2⑨ "회사·기기 정보: 지식 자료" 신설** (RAG 없이 통째로, 근거 제한, 캐시 위치, 소스 기준 경로, `dedent` 함정) |
| 13 | 13-5 LLM 첫 토큰 후보에 **"LLM을 아시아에서 처리할 수 있나"** 조사 결과 (접속 지점 ≠ 처리 위치) |
| 14 | 14-5에 **"실제 기록: 4/6 → 3/6 → 6/6"** 절 신설 |
| 17 | #5에 시뮬레이션 2회차 근거 추가, **#22 추가** |

#### 새로 남긴 확인 필요

- 17-2 #22는 코드로 확인됨(확인 필요 아님). 고칠지는 사용자 판단.

### 2026-11-03 (5차): 확인 필요 2건 수정, 즉시 반응 미리 합성, 통화 결과 전송 반영

#### 기준

- 커밋 `d3a605b` + 미커밋 작업 트리 (4차 이후 사용자가 추가한 변경 + 이번 수정)
- 확인 당시 상태: `pnpm typecheck`·`pnpm lint`·`format:check` 통과, `pnpm test` **27개** 통과 (파일 7개)
- 버전: 3차와 같음

#### 이번에 고친 것 (이 작업)

| 파일 | 변경 | 관련 |
| --- | --- | --- |
| `src/call-guard.ts` | "여보세요?" 재생이 끝난 뒤 고객이 아직 `away`일 때만 무응답 타이머 시작 | 17-2 #19 → 고침 |
| `src/call-guard.test.ts` 신규 | 가짜 세션·가짜 시계로 무응답 종료, **도중 대답 시 끊지 않음**(고치기 전 실패 확인), 최대 길이, 닫힘 뒤 정지 | 14-3 |
| `docs/6-web-test.md` 6-3 | A안을 `lk agent dev --deployment production`으로, 이유와 B안 동시 실행 주의 추가 | 17-2 #16 → 문서 고침 |
| `docs/4-setup-checklist.md` 5-3 | Agent Console은 `lk agent dev`가 출력하는 링크로 열기 (직접 주소는 `production`으로 감) | 같은 원인 |

#### 레포에서 바뀐 것 (사용자 작업, 미커밋)

| 파일 | 변경 |
| --- | --- |
| `src/ack-audio.ts` 신규 | `AckAudioCache`: 즉시 반응 3문장을 통화 시작 때 HTTP 합성으로 미리 만들어 `say(text, { audio })`로 재생 |
| `src/call-result.ts`, `src/call-result.test.ts` 신규 | 통화 종료 시 대화록·지연 기록·종료 사유를 functions-xtool `submitVoiceCallResult`로 전송 (공유 비밀키 헤더, 10초 제한) |
| `src/main.ts`, `src/agent.ts` | 위 둘 연결, `endCall`이 종료 사유 기록 |
| `.env.example` | `VOICE_RESULT_URL`, `VOICE_AGENT_SECRET` |
| `docs/6-web-test.md` 4-1 | 받는 쪽: Firestore 저장(재전송 덮어쓰지 않음) → Opus 5.5 판정 추출 트리거 → 관리 화면 조회 |
| `test/test.html` | 사용자 테스트용 파일. **무시** |

#### SDK 코드로 확인한 것

- 세션은 TTS 객체의 `metrics_collected`를 구독하고, ElevenLabs `synthesize()`(HTTP `ChunkedStream`)도 같은 객체로 지표를 냄 → 미리 합성 지표가 통화 지연 기록에 섞일 수 있음.
- `LLMMetrics`에 `cancelled` 필드가 있음 → 취소된 선제 생성도 기록됨.

#### 학습서에서 고친 곳

| 장 | 고친 곳 |
| --- | --- |
| 1 | 1-5 웹 테스트 경로에 통화 후 경로(전송 → 저장 → 판정 → 조회) |
| 4 | 4-3 계약 위험에 세 번째 계약(`CallTurn`, 이 레포가 보내는 쪽) |
| 5 | 5-5 경쟁 조건 → 고침, 고친 코드와 "기다리는 동안 세상이 바뀐다" 원칙 |
| 8 | 8-10에 통화 중(Haiku 5.5) vs 통화 후 판정(Opus 5.5 effort low) 비교표 |
| 11 | 11-6 비대칭 설명에 미리 합성으로 하한이 내려간다는 갱신 |
| 13 | 13-5 표 갱신, "즉시 반응 미리 합성" 절을 구현 해설로 교체, **"지연 기록에 섞이는 값" 절 신설** |
| 14 | 14-2 표에 테스트 2개, 14-3에 **"가짜 세션과 가짜 시계" 절 신설** |
| 15 | 15-1 표에 결과 전송 변수, 15-6에 **"통화 결과 전송" 절 신설**(받는 쪽·멱등성 포함), 앞으로 필요한 것 표 갱신 |
| 17 | #14 대응, #16 문서 고침, #19 고침, **#20·#21 추가** |

#### 새로 남긴 확인 필요

- 17-2 #20: 통화 결과의 지연 기록에 취소된 LLM 지표·미리 합성 TTS 지표가 실제로 섞이는지 (결과 몇 건 확인)
- 17-2 #21: 고객이 먼저 끊었을 때 결과 전송이 언제 일어나는지
- 즉시 반응 미리 합성 후 실제 첫소리 지연 (실측 없음)

### 2026-11-03 (4차): 작업 중인 코드 변경 반영 (통화 종료, 무응답 안전장치, 즉시 반응 생략, 고지 처리)

#### 기준

- 커밋 `d3a605b` + **미커밋 작업 트리** (3차 반영 중에 새로 생긴 변경). 다음 갱신 때는 이 변경이 들어간 커밋을 찾아 기준으로 삼습니다.
- 확인 당시 상태: `pnpm typecheck`·`pnpm lint` 통과, `pnpm test` 21개 통과
- 버전: 3차와 같음

#### 레포에서 바뀐 것 (미커밋)

| 파일 | 변경 |
| --- | --- |
| `src/agent.ts` | 첫 도구 `beta.createEndCallTool` (`endInstructions: null`, 업무용 설명 추가). 즉시 반응 전에 `shouldAck` 검사 |
| `src/ack.ts`, `src/ack.test.ts` | `shouldAck`: 수신 거부·불만·사람 요청이면 "네네" 생략. 테스트 2개 |
| `src/call-guard.ts` 신규 | 무응답 안전장치(`userAwayTimeout` 10초 → "여보세요?" → 10초 뒤 종료), 최대 통화 8분 |
| `src/main.ts` | `userAwayTimeout`, `interruption.discardAudioIfUninterruptible: false`, `endCall`(작별 인사 → 방 삭제 → `ctx.shutdown`), `guardCall` 연결 |
| `src/prompt.ts` | "통화 끝내기" 절(end_call 사용법, 도구를 말로 흘리지 않기), 물어볼 것에 규칙 2줄(끝내려 하면 마무리, 두 번 물어도 답 없으면 넘어감) |
| `scenarios.yaml` | CLI가 채운 시나리오 `id`. 모든 첫마디를 "여보세요?"로, 시험 대사는 첫 질문 뒤로 (준비 전 첫마디가 버려지는 문제) |
| `test/test.html` 신규 | 카페24 구매 모듈 마크업. 음성 에이전트와 무관해 **학습서에 반영하지 않음** |

#### SDK 코드로 확인한 것

- `userAwayTimeout`은 초 단위(`agent_session.ts`에서 ×1000).
- `beta.createEndCallTool`: 도구를 부른 답이 끝나면 세션 종료 → `Close` → 방 삭제(기본) → `jobCtx.shutdown`. `endInstructions`가 있으면 도구 결과로 돌려줘 답이 한 번 더 생성됨.
- 턴 확정(`onEndOfTurn`)에는 끼어들 수 없는 발화를 보는 검사가 없고, 확정된 턴은 `userTurnCompletedImpl`에서 끼어들 수 없는 발화가 재생 중이면 버려짐 → `discardAudioIfUninterruptible: false`만으로는 "고지 끝난 뒤 처리"가 보장되지 않음.
- "skipping user input, speech scheduling is paused"는 `onEndOfTurn`의 대기열 멈춤 검사에서 나옴.

#### 학습서에서 고친 곳

| 장 | 고친 곳 |
| --- | --- |
| 1 | 1-6 통화의 끝에 "AI가 끊음" 경로 |
| 4 | 4-7에 "에이전트가 먼저 끊을 때" 절 신설 |
| 5 | 5-5에 "away를 쓰는 무응답 안전장치" 절 신설 (경쟁 조건 포함) |
| 7 | 7-6에 "`discardAudioIfUninterruptible: false`를 넣은 뒤" 절 신설 |
| 8 | 8-5 결론에 도구가 붙은 뒤의 상태 |
| 9 | 9-2③에 새 규칙 2줄 해설, 9-6에 "첫 도구: end_call" 절 신설 |
| 11 | 11-6에 "즉시 반응을 하지 않을 때: shouldAck" 절 신설, 대가 표 갱신, 11-9 이벤트 표 갱신 |
| 14 | 14-2 표(`shouldAck`), 14-5에 시나리오 id 설명과 "에이전트가 준비되기 전의 첫마디" 함정 절 신설 |
| 17 | 발견 사항 #5 → 일부 대응, #12 → AI가 끊는 경우 대응, **#19 추가** |

#### 새로 남긴 확인 필요

- 17-2 #5: 고지 도중에 말을 마친 고객의 턴이 여전히 버려지는지 (음성으로 고지 중 짧게 말해 보고 "skipping user input, current speech generation cannot be interrupted" 경고 확인)
- 17-2 #19: "여보세요?" 도중에 대답하면 무응답 타이머가 잘못 시작되는지

### 2026-11-03 (3차): 웹 테스트, 즉시 반응 측정 반영

#### 기준

- 커밋 `d3a605b` + 작업 트리(2차의 CI 수정, 미커밋)
- 버전: `@livekit/agents` 1.9.5, 플러그인(anthropic·elevenlabs·soniox) 1.9.5, `@livekit/plugins-ai-coustics` 0.3.5, `@livekit/rtc-node` 1.2.1, Node 24.22.2, LiveKit CLI 2.19.3

#### 레포에서 바뀐 것

| 변경 | 내용 |
| --- | --- |
| `docs/6-web-test.md` 신규 | 관리 화면(`/log`)에서 브라우저로 통화. functions-xtool이 접속 토큰에 에이전트 배정과 고객 정보를 넣음. 워커는 `lk agent dev` 또는 LiveKit Cloud 배포(`lk agent create`) |
| `docs/5-poc-results.md` "즉시 반응" 절 | 첫소리 1.4~1.6초 → 0.6~0.8초. 지시문만으로 첫머리 맞장구 금지 3/3 실패, 코드 제거 후 4/4 성공. 본 답이 다시 길어지는 경향 |
| `.gitignore` | `.env.agent-secrets` (LiveKit Cloud 비밀값 임시 파일) |

#### 추가로 확인한 것

- `lk agent dev --help`(CLI 2.19.3)와 LiveKit 문서 "Non-production deployments": `lk agent dev`는 무작위 `dev-` 배포로 등록되고, 배포 이름 없는 배정은 `production`으로 감. LiveKit Cloud production 재배포는 진행 중 세션을 최대 1시간 기다리고, 무료 요금제에서는 production도 쉬면 0대로 줄어듦.

#### 학습서에서 고친 곳

| 장 | 고친 곳 |
| --- | --- |
| 1 | 1-5에 "지금 실제로 도는 경로: 웹 테스트" 추가 |
| 3 | **3-7 신설** "브라우저 쪽에서 본 연결: 접속 토큰과 클라이언트". 기존 3-7·3-8은 3-8·3-9로 번호 이동. 정리 표 2줄, 확인 문제 6번 추가 |
| 4 | 4-3: 디스패치 통로 세 가지(토큰·배정 API·SIP 규칙), 웹 테스트의 실제 metadata 전달 방식, "계약이 두 곳에 적혀 있다는 위험", 배포 이름 라우팅 규칙 |
| 9 | 9-2 "수치로 본 효과"에 본 답이 다시 길어진 관찰, 9-5 표에 맞장구 금지 측정(3/3 실패 → 4/4) |
| 11 | 11-6에 즉시 반응 측정표, 지시문 한계 측정, 대가 표에 "본 답이 다시 길어짐" |
| 13 | 13-4 흐름도에 즉시 반응 결과와 "체감 vs 실제" 설명, 13-5에 poc-results의 미리 합성 제안 연결 |
| 15 | **15-5 재구성** "워커를 어디에 띄우나: LiveKit Cloud 또는 GKE" (비교표, `--secrets-file` 절차), 15-8 보안표 3줄, 15-9 정리 |
| 17 | 발견 사항 3·4번에 "직접 운영에서만" 조건, **16·17·18번 추가**, 용어 5개 추가 |

#### 새로 남긴 확인 필요

- 17-2 #16: 웹 테스트 A안(`lk agent dev`)에서 functions-xtool 토큰이 개발 워커에 닿는지. 안 닿으면 `lk agent dev --deployment production`.

### 2026-11-03 (2차): CI 단위 테스트, Dockerfile 수정 사례

**기준**: 커밋 `d3a605b` (사용자 커밋, Dockerfile 수정과 학습서 초판 포함)

#### 레포에서 바뀐 것

| 변경 | 내용 |
| --- | --- |
| `Dockerfile` (`d3a605b`) | 설치 전에 `pnpm-workspace.yaml`·`.npmrc`·`patches/` 복사 |
| `.github/workflows/tests.yml` | `pnpm test` 단계 추가 (미커밋) |
| `docs/4-setup-checklist.md` 1-1 | CI 설명에 단위 테스트 추가 (미커밋) |

**검증**: Docker 없이 빌드 단계를 임시 폴더에서 재현. 설치 통과, Soniox 패치 적용, `download-files` 통과, `prune --prod` 뒤 패치 유지·개발 도구 제거, 운영 의존성만으로 `node src/main.ts --help` 실행. 실제 `docker build`는 미실행.

**학습서에서 고친 곳**: 14-7(CI 표, 확인 문제 5번), 15-4("문제" → "수정 사례"), 15-9, 15장 확인 문제 6번, 17-2 #1·#2 → 고침, 실습 7번, README 목차 설명

### 2026-11-03 (1차): 초판 16장

#### 기준

- 커밋 `646d35d` 위의 작업 트리 (이 `src/`는 이후 `d3a605b`로 그대로 커밋됨)
- 버전: 3차와 같음

#### 출처

- 프로젝트 코드·테스트·설정·문서 전체
- 설치된 `@livekit/agents` 1.9.5와 플러그인 소스 (`node_modules/@livekit/*/src`, Soniox 패치는 `dist`)
- LiveKit 문서 (turn detector, adaptive interruption, turns, VAD, tuning, nodes)
- Claude API 문서 (Haiku 5.5 생각 모드·effort·캐시·sampling·prefill)

**내용**: 1~16장, README. 발견 사항 15개(17-2). 분량 약 19만 자.
