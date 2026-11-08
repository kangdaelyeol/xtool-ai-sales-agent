# 웹 테스트: 관리 화면에서 AI 상담원과 브라우저로 통화하기

내부 직원이 originalshq 관리 화면(`/log` → **AI 상담원** 탭)에서 AI 음성 상담원과 브라우저로 통화해 보는 기능입니다. 전화 회선 없이 실제 배포 환경(LiveKit Cloud + functions-xtool + 웹)에서 상담 흐름을 시험합니다.

이 문서는 그 기능의 명세이자 작업 기록입니다. 웹 테스트를 배포할 때(6장), 세션 API나 고객 정보(metadata)의 모양을 바꿀 때(2∼3장), 통화가 끝났는데 결과가 화면에 뜨지 않을 때(4-1장, 5장의 "볼 것" 표) 읽습니다. 접속 토큰과 디스패치(방에 에이전트를 배정하는 일)의 원리는 학습서 [3-7절](1-study/03-transport.md#3-7-브라우저-쪽에서-본-연결-접속-토큰과-클라이언트-웹-테스트)과 [4-3절](1-study/04-worker-runtime.md#4-3-디스패치-어떤-방에-어떤-에이전트를-보낼까)에 있습니다.

> - 대상: **xtool 관리자로 로그인한 직원만** (기존 `/log` 로그인과 관리자 확인을 그대로 씀). 외부 고객 공개는 아직 하지 않습니다.
> - 2026-11-03 작성. 토큰 발급 → 에이전트 배정 → 첫 멘트까지 끝에서 끝으로 확인했습니다(아래 5장). 다만 브라우저가 아니라 같은 방식의 토큰을 쓴 Node 클라이언트로 확인했습니다. 배포한 함수와 실제 브라우저로 하는 통화는 5장의 "아직 못 한 것"에 있습니다.

---

## 1. 구조

```text
[originalshq 웹 /log "AI 상담원" 탭]  가상 고객 정보 입력 → "통화 시작"
   │ ① POST createVoiceAgentSession  (Authorization: Bearer <Firebase ID 토큰>)
   ▼
[functions-xtool createVoiceAgentSession]
   │  관리자 확인 → 새 방 이름 → 접속 토큰 발급
   │  토큰 안에 "이 방에 xtool-sales-agent를 보내라 + 고객 정보(metadata)"를 넣음
   │ ② { serverUrl, roomName, participantToken }
   ▼
[브라우저] ──③ WebRTC 음성──▶ [LiveKit Cloud] ──배정──▶ [에이전트 워커 (이 레포)]
                                                      metadata → src/call-context.ts
```

(2026-11-08 추가) 그림은 위에서 아래로 차례이고, 동그라미 숫자가 순서입니다. ①은 화면이 functions-xtool에 보내는 HTTPS 요청, ②는 그 응답, ③부터가 WebRTC 음성입니다. 토큰은 두 종류입니다. ①의 Firebase ID 토큰은 "이 직원이 관리 화면에 로그인했다"는 증명이라 functions-xtool이 확인합니다. ②의 접속 토큰(`participantToken`, JWT)은 "LiveKit의 이 방에 들어가도 된다"는 입장권이라 LiveKit이 확인합니다.

- **음성은 functions-xtool을 거치지 않습니다.** 함수는 접속 토큰만 만들고 끝납니다(짧은 요청이라 Cloud Functions에 맞음).
- 에이전트 배정은 토큰의 `roomConfig`(`RoomAgentDispatch`)로 합니다. 따로 배정 API를 부르지 않습니다.
- 나중에 전화 발신(SIP)으로 바꿔도 **metadata 모양(3장)은 그대로** 씁니다.

## 2. API: `createVoiceAgentSession`

| 항목 | 값 |
|---|---|
| 위치 | originalshq `functions-xtool/src/endpoints/voice-agent.ts` |
| 주소 | `https://us-central1-<Firebase 프로젝트 ID>.cloudfunctions.net/createVoiceAgentSession` (실제 값은 Firebase 콘솔의 Functions 목록). functions-xtool은 리전을 따로 정하지 않아 기본값 `us-central1`에서 돕니다 |
| 메서드 | `POST` (그 밖은 405) |
| 인증 | `Authorization: Bearer <Firebase ID 토큰>`. 등록된 xtool 관리자(`checkAdmin`)만 부를 수 있습니다. 토큰이 없거나 만료면 401, 관리자가 아니면 403 |
| 그 밖의 오류 | 본문이 객체가 아니면 400 `invalid request body`, 처리 중 예외는 500 `서버 오류` (공통 껍데기 `functions-xtool/src/http.ts`) |
| 시크릿 | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (GCP Secret Manager, [학습서 16-7절](1-study/16-cloud-accounts-iam.md#비밀값)) |

**요청 본문** (모두 선택값):

```json
{
  "customerName": "김민수",
  "device": "F2 울트라",
  "inquiredAt": "오늘 오후",
  "installment": "희망",
  "inquiryText": "가죽 지갑에 각인하고 싶은데 가능한가요?"
}
```

- `installment`는 `희망` / `희망 안 함` / `미기입` 중 하나. 다른 값이면 400 `{ "error": "installment must be one of: 희망, 희망 안 함, 미기입" }`.
- 문자열이 아닌 값이 오면 400 `{ "error": "<필드> must be a string" }`.
- 보내지 않은 칸은 빈 문자열로, `installment`는 `미기입`으로 채워 에이전트에 넘깁니다.

**응답 200**:

```json
{
  "serverUrl": "wss://<프로젝트>.livekit.cloud",
  "roomName": "voice-test-1793706903057-5974b0fd",
  "participantToken": "<JWT>"
}
```

- 토큰 유효 시간은 10분입니다. 접속을 시작할 때까지의 시간이고 통화 길이 제한이 아닙니다.
- 방 이름은 요청마다 새로 만듭니다(`voice-test-<시각>-<무작위>`). `<시각>`은 `Date.now()`의 밀리초 값, `<무작위>`는 UUID 앞 8자입니다. 방 이름이 곧 `callId`이고, 이름이 `voice-test-`로 시작하면 통화 기록의 `source`가 `web-test`가 됩니다(4-1).
- 토큰의 참가자 identity는 `tester-<무작위 8자>`이고, 권한은 그 방에 들어가 발행·구독·데이터 발행을 하는 것입니다. 토큰을 열어 본 모습은 [학습서 3-7절 깊이 보기](1-study/03-transport.md#깊이-보기-토큰을-열어-보기jwt의-실물-2026-11-05-추가)에 있습니다.

## 3. 에이전트에 넘기는 고객 정보 (metadata 계약)

에이전트 `src/call-context.ts`의 `CallContextSchema`와 functions-xtool `voice-agent.ts`의 `CallContext`가 **같은 모양이어야 합니다.** 한쪽을 바꾸면 다른 쪽도 바꿉니다.

| 필드 | 뜻 | 비었을 때 |
|---|---|---|
| `callId` | 통화 id (웹 테스트는 방 이름, 나중에 Firestore `calls/{id}`) | 통화 결과를 보내지 않음 (4-1) |
| `customerName` | 호칭에 쓰는 이름 | "고객님" |
| `device` | Monday 기기별 보드 이름 그대로 | 첫 멘트에서 기기 이름 생략 (지시문에는 "미기입") |
| `inquiredAt` | 사람이 읽는 신청 시각 | "미기입" |
| `installment` | `희망` / `희망 안 함` / `미기입` | `미기입` |
| `inquiryText` | 문의 내용 | "없음" |

metadata가 깨져 있으면 에이전트는 가상 고객이 아니라 빈 정보("고객님")로 진행합니다. metadata가 아예 없으면(콘솔·디버거) 가상 고객 `SAMPLE_CALL`(위 요청 예와 같은 김민수)로 진행합니다(`src/call-context.ts`). 이 계약을 코드로 지키는 방법은 [학습서 4-3절](1-study/04-worker-runtime.md#계약을-코드로-zod-스키마)에 있습니다.

## 4. 웹 화면

- 위치: originalshq `src/screens/log/components/voice-agent-panel.tsx` (API 호출은 `client/voice-agent-client.ts`, 통화 결과 표시는 `components/voice-call-result.tsx`, 모양은 `styles/_voice-agent.scss`)
- `@livekit/components-react`의 `LiveKitRoom`, `RoomAudioRenderer`, `useVoiceAssistant`(상담원 상태), `useTranscriptions`(대화 자막)를 씁니다.
- LiveKit 라이브러리는 `/log` 전용 조각에만 들어갑니다(지연 로딩). **일반 방문자 페이지 번들에는 들어가지 않습니다**(빌드 결과로 확인).
- 마이크 권한이 필요합니다. 배포 주소는 HTTPS라 문제없고, 로컬은 `localhost`에서 됩니다.

## 4-1. 통화 결과 (저장·판정·조회)

```text
[에이전트] 통화가 끝나면(shutdown 콜백) ─X-Voice-Agent-Secret─▶ submitVoiceCallResult ─▶ Firestore calls/{callId}
                                                                            │ (문서 생성 트리거)
                                                         extractVoiceCallJudgment: Opus 5.5로 요약·판정 칸 추출
[웹 "AI 상담원" 탭] 통화 끝 → getVoiceCall?callId= 을 3초마다 (최대 2분) → 요약·판정·지연·대화록 표시
```

| 함수 | 종류 | 인증 | 하는 일 |
|---|---|---|---|
| `submitVoiceCallResult` | POST | 헤더 `X-Voice-Agent-Secret` = 시크릿 `VOICE_AGENT_SECRET` | 대화록·고객 정보·종료 사유·구간별 지연을 `calls/{callId}`에 저장. 같은 통화를 다시 보내면 덮어쓰지 않음. 새로 저장하면 201, 이미 있으면 200(`{ callId, created }`). 비밀키가 틀리면 입력 검사보다 먼저 401, 본문이 틀리면 400 |
| `extractVoiceCallJudgment` | Firestore 트리거 (`calls/{callId}` 생성) | 해당 없음 (HTTP 요청이 아니라 문서 생성으로 실행) | `claude-opus-5-5`(effort low, 거절 시 서버 측 대체)로 요약과 판정 칸(README 6-2)을 뽑아 `result`에 붙이고 `status: analyzed`. 실패하면 `status: analysis_failed`와 이유(`analysisError`) |
| `getVoiceCall` | GET `?callId=` | 관리자 | 통화 기록 한 건. `callId` 형식이 틀리면 400, 아직 저장되지 않았으면 404 |

- 에이전트는 `VOICE_RESULT_URL`·`VOICE_AGENT_SECRET`이 있을 때만 보냅니다. 없거나 `callId`가 없으면(콘솔·디버거) 건너뜁니다.
- 판정 칸: 요약, 통화 결과, 관심도(근거 포함), 관심 기기, 용도, 다룰 소재, 예산대, 결제 방식, 도입 시기, 방문체험(지역·일시), 결정권, 연락 희망 시각, 사람 확인 필요. 값 이름은 [업무 문서 README 6-2](../../originalshq/docs/ai-sales-agent/README.md#6-2-리드-판정-기준) 표와 같습니다. 확인 못 한 칸은 "미확인"입니다. 단, 받아 적는 칸(방문 지역·일시, 연락 희망 시각)은 빈 문자열로 두고, 관심도와 통화 결과에는 "미확인"이 없어 늘 값을 고릅니다(`functions-xtool/src/voice-call/analyze.ts`의 `CallJudgmentSchema`).
- 판정 비용은 통화당 약 20∼30원(3천 토큰 기준)입니다. 더 낮추려면 `functions-xtool/src/voice-call/analyze.ts`의 `ANALYSIS_MODEL`을 Sonnet 5.5로 바꿉니다.

## 5. 확인한 것 (2026-11-03)

| 확인 | 결과 |
|---|---|
| functions-xtool 빌드·린트 | 통과 |
| 웹 타입 검사·린트·포맷·빌드 | 통과 |
| 토큰 발급 → 방 접속 → 에이전트 배정 | 접속 2.8초 뒤 에이전트 참가 (Node 클라이언트로 같은 방식의 토큰 사용. 2.8초를 단계별로 쪼개는 법은 [학습서 4-3절 깊이 보기](1-study/04-worker-runtime.md#깊이-보기-28초를-쪼개기디스패치-시각표-2026-11-06-추가)) |
| metadata 전달 | 첫 멘트가 보낸 정보대로 나옴: "안녕하세요, 이영희 고객님. … 메탈팹 상담 신청해 주셔서 …" |
| 배포 이미지 설치 단계 | Dockerfile과 같은 파일만 둔 빈 폴더에서 `pnpm install --frozen-lockfile` 통과, Soniox 패치 적용 확인 |
| 통화 결과 전송 | `callId`가 든 토큰으로 접속했다 나가자 에이전트가 비밀키·고객 정보·종료 사유(`participant_disconnected`)·대화록을 보냄 (로컬 가짜 서버로 확인) |
| 판정 추출 | 실제 API로 판정 대화 1건: 결과 "체험 예약", 관심도 "높음", 예산·할부·시기·체험 일시가 대화대로 채워짐 (8.5초) |

**아직 못 한 것:** 배포된 함수와 실제 브라우저로 통화(배포 후 6장 순서로 확인), Docker 이미지 빌드 자체(이 맥에 Docker 없음, `lk agent create`가 원격에서 빌드).

**2026-11-04 코드 변경 뒤 첫 웹 통화에서 볼 것:**

| 확인 | 기대 |
| --- | --- |
| "통화 끝내기"를 누른 뒤 결과 표시 | 에이전트 로그에 `deleting room on agent session close`(SDK `voice/room_io/room_io.ts`), 결과가 몇 초 안에 뜸 (예전에는 방 유예 시간(`departure_timeout`)만큼 늦었음) |
| AI가 끊는 경우 (`end_call`, 무응답) | 위와 같고, `error while deleting room` 경고(SDK `job.ts`)가 없음 (방 삭제를 한곳으로 모음) |
| 즉시 반응 미리 합성 | "즉시 반응 음성을 미리 만들지 못했습니다" 경고(`src/ack-audio.ts`)가 없음. 통화 결과의 TTS 지연(`latency.ttsTtfbMs`) 첫 값이 첫 멘트(약 0.8초)로 시작 |
| 끼어들기 로그 | 겹친 말마다 `겹친 말: 끼어들기로 판단(멈춤)`, `겹친 말: 맞장구로 판단(계속 말함)`, `겹친 말: AI 말이 먼저 끝나 판단 없음` 중 하나 (`src/main.ts`) |

## 6. 배포 순서 (직접 실행)

### 6-1. functions-xtool

```bash
cd ~/projects/originalshq
firebase functions:secrets:set LIVEKIT_URL         # wss://<프로젝트>.livekit.cloud (에이전트 레포 .env.local의 LIVEKIT_URL과 같은 값)
firebase functions:secrets:set LIVEKIT_API_KEY     # 에이전트 레포 .env.local의 값
firebase functions:secrets:set LIVEKIT_API_SECRET
firebase functions:secrets:set VOICE_AGENT_SECRET  # 새로 만든 긴 무작위 값 (예: openssl rand -hex 32)
firebase functions:secrets:set ANTHROPIC_API_KEY   # 판정 추출용
firebase deploy --only functions:xtool:createVoiceAgentSession,functions:xtool:submitVoiceCallResult,functions:xtool:getVoiceCall,functions:xtool:extractVoiceCallJudgment
```

- 에이전트 레포 `.env.local`에도 같은 `VOICE_AGENT_SECRET`과 `VOICE_RESULT_URL`을 넣습니다. `VOICE_RESULT_URL`은 `https://us-central1-<Firebase 프로젝트 ID>.cloudfunctions.net/submitVoiceCallResult` 꼴입니다(2장 주소와 같은 규칙).
- (2026-11-08 갱신) `extractVoiceCallJudgment`는 Firestore(`xtool-read` 데이터베이스)의 문서 생성 트리거라 Eventarc(구글 서비스에서 생긴 사건을 함수로 전달하는 서비스)를 거칩니다. 프로젝트에서 Eventarc를 처음 쓰는 배포라면 다른 함수는 배포되고 이 함수만 실패할 수 있습니다. 2026-11-03에 실제로 그랬고, Firebase CLI는 Eventarc 서비스 에이전트의 권한이 아직 준비되지 않았을 수 있으니 몇 분 뒤 다시 배포하라고 안내했습니다. 몇 분 기다려 이 함수만 다시 배포하고(`firebase deploy --only functions:xtool:extractVoiceCallJudgment`), 그래도 실패하면 Eventarc 서비스 에이전트에 `roles/eventarc.serviceAgent`를 줍니다(명령은 [학습서 16-7절](1-study/16-cloud-accounts-iam.md#사례-판정-트리거의-첫-배포-실패-2026-11-03)).

### 6-2. 웹

평소처럼 빌드·배포합니다. `/log?tab=agent`가 새 탭입니다.

### 6-3. 에이전트 워커: 둘 중 하나

| 방식 | 명령 | 쓸 때 |
|---|---|---|
| **A. 내 맥에서 실행** (처음 테스트에 추천) | 에이전트 레포에서 `lk agent dev --deployment production` | 켜 둔 동안만 통화됩니다. 코드를 바로 고쳐 보며 시험할 때 |
| B. LiveKit Cloud에 배포 | 아래 | 맥을 꺼도 언제든 통화되게 할 때 |

- A안에 `--deployment production`을 붙이는 이유: LiveKit CLI 2.19.0 이상의 `lk agent dev`는 운영 트래픽과 섞이지 않게 워커를 무작위 `dev-…` 배포로 등록합니다. 그런데 `createVoiceAgentSession`이 만드는 토큰은 배포 이름을 지정하지 않으므로 `production`으로 배정됩니다. 붙이지 않으면 에이전트가 방에 들어오지 않을 수 있습니다(CLI 도움말·LiveKit 문서 "Non-production deployments" 기준, 2026-11-03). 설치된 CLI 2.19.3의 `lk agent dev --help`도 "기본은 무작위 `dev-` ID, 운영 트래픽을 받으려면 `production`을 넘긴다"고 설명합니다(2026-11-08 확인).
- B안을 배포한 뒤에 A안을 같이 켜 두면 맥과 LiveKit Cloud가 같은 `production` 통화를 나눠 받습니다. 둘 중 하나만 켭니다.

B안:

```bash
cd ~/projects/xtool-ai-sales-agent
# 부품 키만 담은 파일 (LIVEKIT_* 는 LiveKit Cloud가 넣어 주므로 빼고, 커밋하지 않음)
grep -E '^(ANTHROPIC_API_KEY|ELEVEN_API_KEY|SONIOX_API_KEY|TTS_VOICE|VOICE_RESULT_URL|VOICE_AGENT_SECRET)=' .env.local > .env.agent-secrets
lk agent create --secrets-file .env.agent-secrets
rm .env.agent-secrets
```

- (2026-11-08 추가) 비밀값 파일에 값이 빈 줄(예: 비워 둔 `TTS_VOICE=`)이 있으면 `lk agent create`가 실패합니다. 값을 채우거나, 그 줄을 빼거나, `--ignore-empty-secrets`를 붙입니다(CLI 2.19.3 도움말).
- LLM을 Bedrock으로 바꿔 배포한다면 목록에 `LLM_PROVIDER|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION`을 더합니다. `AWS_BEARER_TOKEN_BEDROCK`은 넣지 않습니다. 코드는 이 값을 읽지 않고, 조직 정책도 막습니다([학습서 16-4절](1-study/16-cloud-accounts-iam.md#16-4-sdk는-자격-증명을-어디서-찾나)). 미국 리전에 올리면 도쿄 Bedrock의 이점은 사라집니다.
- 처음 실행하면 `livekit.toml`이 생깁니다. 커밋합니다.
- 리전은 LiveKit Cloud 에이전트 리전(미국·유럽·뭄바이) 중에서 고릅니다. 서울은 없습니다([2-tech-stack.md 4-1](2-tech-stack.md#4-1-프레임워크)). LLM이 미국에 있으니 처음에는 미국 리전이 무난합니다. 지연은 [5-poc-results.md](5-poc-results.md) 방식으로 다시 잽니다.
  - (2026-11-08 추가) `lk agent create`는 리전을 묻는 창을 띄우고, 비대화형으로 돌릴 때는 `--region`이 꼭 있어야 합니다. 지금 고를 수 있는 코드는 `us-east`(미국 버지니아), `eu-central`(독일 프랑크푸르트), `ap-south`(인도 뭄바이)입니다(LiveKit 문서 "Regions, regional endpoints, and static IPs", CLI 2.19.3 도움말).
- 이후 코드 변경은 `lk agent deploy`로 올립니다.

## 7. 주의

- **비용:** 통화마다 STT·LLM·TTS·LiveKit 사용량이 나갑니다. 관리자만 열 수 있어 남용 위험은 낮지만, 공개하려면 횟수 제한·봇 차단·동의 문구가 먼저 필요합니다.
- **녹음·국외 이전:** 내부 테스트라도 실제 음성이 해외 API(Anthropic·ElevenLabs·Soniox)로 갑니다. 테스트하는 직원에게 알립니다.
- **에이전트 이름:** `xtool-sales-agent`로 등록돼 있어 자동 배정되지 않고, 토큰의 배정 정보로만 들어옵니다. 이름을 바꾸면 functions-xtool의 `AGENT_NAME`도 바꿉니다.
