# 웹 테스트 — 관리 화면에서 AI 상담원과 브라우저로 통화하기

내부 직원이 originalshq 관리 화면(`/log` → **AI 상담원** 탭)에서 AI 음성 상담원과 브라우저로 통화해 보는 기능입니다. 전화 회선 없이 실제 배포 환경(LiveKit Cloud + functions-xtool + 웹)에서 상담 흐름을 시험합니다.

> - 대상: **xtool 관리자로 로그인한 직원만** (기존 `/log` 로그인과 관리자 확인을 그대로 씀). 외부 고객 공개는 아직 하지 않습니다.
> - 2026-11-03 작성. 토큰 발급 → 에이전트 배정 → 첫 멘트까지 끝에서 끝으로 확인했습니다(아래 5장).

---

## 1. 구조

```
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

- **음성은 functions-xtool을 거치지 않습니다.** 함수는 접속 토큰만 만들고 끝납니다(짧은 요청이라 Cloud Functions에 맞음).
- 에이전트 배정은 토큰의 `roomConfig`(`RoomAgentDispatch`)로 합니다. 따로 배정 API를 부르지 않습니다.
- 나중에 전화 발신(SIP)으로 바꿔도 **metadata 모양(3장)은 그대로** 씁니다.

## 2. API: `createVoiceAgentSession`

| 항목 | 값 |
|---|---|
| 위치 | originalshq `functions-xtool/src/endpoints/voice-agent.ts` |
| 주소 | `https://us-central1-xtool-63b29.cloudfunctions.net/createVoiceAgentSession` |
| 메서드 | `POST` (그 밖은 405) |
| 인증 | `Authorization: Bearer <Firebase ID 토큰>` — 등록된 xtool 관리자(`checkAdmin`). 없으면 401, 관리자가 아니면 403 |
| 시크릿 | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` (Secret Manager) |

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

- `installment`는 `희망` / `희망 안 함` / `미기입` 중 하나. 다른 값이면 400.
- 문자열이 아닌 값이 오면 400 `{ "error": "<필드> must be a string" }`.

**응답 200**:

```json
{
  "serverUrl": "wss://xtool-ai-agent-cloud-p6d4uekt.livekit.cloud",
  "roomName": "voice-test-1793706903057-5974b0fd",
  "participantToken": "<JWT>"
}
```

- 토큰 유효 시간은 10분입니다. 접속을 시작할 때까지의 시간이고 통화 길이 제한이 아닙니다.
- 방 이름은 요청마다 새로 만듭니다(`voice-test-<시각>-<무작위>`). 방 이름이 곧 `callId`입니다.

## 3. 에이전트에 넘기는 고객 정보 (metadata 계약)

에이전트 `src/call-context.ts`의 `CallContextSchema`와 functions-xtool `voice-agent.ts`의 `CallContext`가 **같은 모양이어야 합니다.** 한쪽을 바꾸면 다른 쪽도 바꿉니다.

| 필드 | 뜻 | 비었을 때 |
|---|---|---|
| `callId` | 통화 id (웹 테스트는 방 이름, 나중에 Firestore `calls/{id}`) | 없음 |
| `customerName` | 호칭에 쓰는 이름 | "고객님" |
| `device` | Monday 기기별 보드 이름 그대로 | 첫 멘트에서 기기 이름 생략 |
| `inquiredAt` | 사람이 읽는 신청 시각 | "미기입" |
| `installment` | `희망` / `희망 안 함` / `미기입` | `미기입` |
| `inquiryText` | 문의 내용 | "없음" |

metadata가 깨져 있으면 에이전트는 가상 고객이 아니라 빈 정보("고객님")로 진행합니다.

## 4. 웹 화면

- 위치: originalshq `src/screens/log/components/voice-agent-panel.tsx` (API 호출은 `client/voice-agent-client.ts`, 모양은 `styles/_voice-agent.scss`)
- `@livekit/components-react`의 `LiveKitRoom`, `RoomAudioRenderer`, `useVoiceAssistant`(상담원 상태), `useTranscriptions`(대화 자막)를 씁니다.
- LiveKit 라이브러리는 `/log` 전용 조각에만 들어갑니다(지연 로딩). **일반 방문자 페이지 번들에는 들어가지 않습니다**(빌드 결과로 확인).
- 마이크 권한이 필요합니다. 배포 주소는 HTTPS라 문제없고, 로컬은 `localhost`에서 됩니다.

## 4-1. 통화 결과 (저장·판정·조회)

```
[에이전트] 통화가 끝나면(shutdown 콜백) ─X-Voice-Agent-Secret─▶ submitVoiceCallResult ─▶ Firestore calls/{callId}
                                                                            │ (문서 생성 트리거)
                                                         extractVoiceCallJudgment: Opus 5.5로 요약·판정 칸 추출
[웹 "AI 상담원" 탭] 통화 끝 → getVoiceCall?callId= 을 3초마다 (최대 2분) → 요약·판정·지연·대화록 표시
```

| 함수 | 종류 | 인증 | 하는 일 |
|---|---|---|---|
| `submitVoiceCallResult` | POST | 헤더 `X-Voice-Agent-Secret` = 시크릿 `VOICE_AGENT_SECRET` | 대화록·고객 정보·종료 사유·구간별 지연을 `calls/{callId}`에 저장. 같은 통화를 다시 보내면 덮어쓰지 않음 |
| `extractVoiceCallJudgment` | Firestore 트리거 (`calls/{callId}` 생성) | — | `claude-opus-5-5`(effort low, 거절 시 서버 측 대체)로 요약과 판정 칸(README 6-2)을 뽑아 `result`에 붙임. 실패하면 `status: analysis_failed` |
| `getVoiceCall` | GET `?callId=` | 관리자 | 통화 기록 한 건 |

- 에이전트는 `VOICE_RESULT_URL`·`VOICE_AGENT_SECRET`이 있을 때만 보냅니다. 없거나 `callId`가 없으면(콘솔·디버거) 건너뜁니다.
- 판정 칸: 통화 결과, 관심도(근거 포함), 관심 기기, 용도, 다룰 소재, 예산대, 결제 방식, 도입 시기, 방문체험(지역·일시), 결정권, 연락 희망 시각, 사람 확인 필요. 값 이름은 README 6-2 표와 같고, 확인 못 한 칸은 "미확인"입니다.
- 판정 비용은 통화당 약 20~30원(3천 토큰 기준)입니다. 더 낮추려면 `functions-xtool/src/voice-call/analyze.ts`의 `ANALYSIS_MODEL`을 Sonnet 5.5로 바꿉니다.

## 5. 확인한 것 (2026-11-03)

| 확인 | 결과 |
|---|---|
| functions-xtool 빌드·린트 | 통과 |
| 웹 타입 검사·린트·포맷·빌드 | 통과 |
| 토큰 발급 → 방 접속 → 에이전트 배정 | 접속 2.8초 뒤 에이전트 참가 (Node 클라이언트로 같은 방식의 토큰 사용) |
| metadata 전달 | 첫 멘트가 보낸 정보대로 나옴: "안녕하세요, 이영희 고객님. … 메탈팹 상담 신청해 주셔서 …" |
| 배포 이미지 설치 단계 | Dockerfile과 같은 파일만 둔 빈 폴더에서 `pnpm install --frozen-lockfile` 통과, Soniox 패치 적용 확인 |
| 통화 결과 전송 | `callId`가 든 토큰으로 접속했다 나가자 에이전트가 비밀키·고객 정보·종료 사유(`participant_disconnected`)·대화록을 보냄 (로컬 가짜 서버로 확인) |
| 판정 추출 | 실제 API로 판정 대화 1건: 결과 "체험 예약", 관심도 "높음", 예산·할부·시기·체험 일시가 대화대로 채워짐 (8.5초) |

**아직 못 한 것:** 배포된 함수와 실제 브라우저로 통화(배포 후 6장 순서로 확인), Docker 이미지 빌드 자체(이 맥에 Docker 없음, `lk agent create`가 원격에서 빌드).

**2026-11-04 코드 변경 뒤 첫 웹 통화에서 볼 것:**

| 확인 | 기대 |
| --- | --- |
| "통화 끝내기"를 누른 뒤 결과 표시 | 에이전트 로그에 `deleting room on agent session close`, 결과가 몇 초 안에 뜸 (예전에는 방 유예 시간만큼 늦었음) |
| AI가 끊는 경우 (`end_call`, 무응답) | 위와 같고, `error while deleting room` 경고가 없음 (방 삭제를 한곳으로 모음) |
| 즉시 반응 미리 합성 | "즉시 반응 음성을 미리 만들지 못했습니다" 경고가 없음. 결과의 TTS 지연 첫 값이 첫 멘트(약 0.8초)로 시작 |
| 끼어들기 로그 | 겹친 말마다 "끼어들기로 판단 / 맞장구로 판단 / AI 말이 먼저 끝나 판단 없음" 중 하나 |

## 6. 배포 순서 (직접 실행)

### 6-1. functions-xtool

```bash
cd ~/projects/originalshq
firebase functions:secrets:set LIVEKIT_URL         # wss://xtool-ai-agent-cloud-p6d4uekt.livekit.cloud
firebase functions:secrets:set LIVEKIT_API_KEY     # 에이전트 레포 .env.local의 값
firebase functions:secrets:set LIVEKIT_API_SECRET
firebase functions:secrets:set VOICE_AGENT_SECRET  # 새로 만든 긴 무작위 값 (예: openssl rand -hex 32)
firebase functions:secrets:set ANTHROPIC_API_KEY   # 판정 추출용
firebase deploy --only functions:xtool:createVoiceAgentSession,functions:xtool:submitVoiceCallResult,functions:xtool:getVoiceCall,functions:xtool:extractVoiceCallJudgment
```

- 에이전트 레포 `.env.local`에도 같은 `VOICE_AGENT_SECRET`과 `VOICE_RESULT_URL`(`.env.example`에 주소가 적혀 있음)을 넣습니다.
- `extractVoiceCallJudgment`는 Firestore(`xtool-read`) 트리거라 처음 배포할 때 Eventarc 권한을 묻는 경우가 있습니다. 안내대로 허용합니다.

### 6-2. 웹

평소처럼 빌드·배포합니다. `/log?tab=agent`가 새 탭입니다.

### 6-3. 에이전트 워커 — 둘 중 하나

| 방식 | 명령 | 쓸 때 |
|---|---|---|
| **A. 내 맥에서 실행** (처음 테스트에 추천) | 에이전트 레포에서 `lk agent dev --deployment production` | 켜 둔 동안만 통화됩니다. 코드를 바로 고쳐 보며 시험할 때 |
| B. LiveKit Cloud에 배포 | 아래 | 맥을 꺼도 언제든 통화되게 할 때 |

- A안에 `--deployment production`을 붙이는 이유: LiveKit CLI 2.19.0 이상의 `lk agent dev`는 운영 트래픽과 섞이지 않게 워커를 무작위 `dev-…` 배포로 등록합니다. 그런데 `createVoiceAgentSession`이 만드는 토큰은 배포 이름을 지정하지 않으므로 `production`으로 배정됩니다. 붙이지 않으면 에이전트가 방에 들어오지 않을 수 있습니다(CLI 도움말·LiveKit 문서 "Non-production deployments" 기준, 2026-11-03).
- B안을 배포한 뒤에 A안을 같이 켜 두면 맥과 LiveKit Cloud가 같은 `production` 통화를 나눠 받습니다. 둘 중 하나만 켭니다.

B안:

```bash
cd ~/projects/xtool-ai-sales-agent
# 부품 키만 담은 파일 (LIVEKIT_* 는 LiveKit Cloud가 넣어 주므로 빼고, 커밋하지 않음)
grep -E '^(ANTHROPIC_API_KEY|ELEVEN_API_KEY|SONIOX_API_KEY|TTS_VOICE|VOICE_RESULT_URL|VOICE_AGENT_SECRET)=' .env.local > .env.agent-secrets
lk agent create --secrets-file .env.agent-secrets
rm .env.agent-secrets
```

- LLM을 Bedrock으로 바꿔 배포한다면 목록에 `LLM_PROVIDER|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_REGION`을 더합니다. `AWS_BEARER_TOKEN_BEDROCK`은 넣지 않습니다. 있으면 IAM 키보다 먼저 쓰여 조직 정책에 막힙니다(학습서 16-4절). 미국 리전에 올리면 도쿄 Bedrock의 이점은 사라집니다.
- 처음 실행하면 `livekit.toml`이 생깁니다. 커밋합니다.
- 리전은 LiveKit Cloud 에이전트 리전(미국·유럽·뭄바이) 중에서 고릅니다. 서울은 없습니다(tech-stack 4-1). LLM이 미국에 있으니 처음에는 미국 리전이 무난합니다. 지연은 `docs/5-poc-results.md` 방식으로 다시 잽니다.
- 이후 코드 변경은 `lk agent deploy`로 올립니다.

## 7. 주의

- **비용:** 통화마다 STT·LLM·TTS·LiveKit 사용량이 나갑니다. 관리자만 열 수 있어 남용 위험은 낮지만, 공개하려면 횟수 제한·봇 차단·동의 문구가 먼저 필요합니다.
- **녹음·국외 이전:** 내부 테스트라도 실제 음성이 해외 API(Anthropic·ElevenLabs·Soniox)로 갑니다. 테스트하는 직원에게 알립니다.
- **에이전트 이름:** `xtool-sales-agent`로 등록돼 있어 자동 배정되지 않고, 토큰의 배정 정보로만 들어옵니다. 이름을 바꾸면 functions-xtool의 `AGENT_NAME`도 바꿉니다.
