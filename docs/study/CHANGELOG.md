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
git diff --stat <기준 커밋> -- . ':!docs/study'
git status --short                     # 아직 커밋 안 된 변경

# 2. SDK·플러그인 버전이 바뀌었나 (바뀌면 SDK 내부 설명 장을 다시 확인)
grep -E '"@livekit/' package.json
lk --version
```

바뀐 파일에 따라 다시 볼 장입니다.

| 바뀐 것 | 다시 볼 장 |
| --- | --- |
| `src/main.ts` (세션 설정, 턴·끼어들기 옵션, 첫 멘트) | 4, 7, 11, 13 |
| `src/agent.ts`, `src/ack.ts` (훅, llmNode, 즉시 반응) | 11, 12 |
| `src/prompt.ts` (지시문, 첫 멘트) | 9 |
| `src/models/*` (공급사 래퍼, STT 확정) | 6, 8, 15 |
| `src/glossary.ts`, `src/transcript.ts`, `src/pronunciation.ts` | 6, 10, 12 |
| `src/call-context.ts` (metadata 계약) | 4 |
| `src/config.ts` | 15 |
| `*.test.ts`, `scenarios.yaml`, `.github/workflows/` | 14 |
| `package.json`·`pnpm-lock.yaml`의 `@livekit/*` 버전, `patches/` | 4, 5, 6, 7, 10, 11 (SDK 내부 동작), 15 |
| `Dockerfile`, `pnpm-workspace.yaml`, `.gitignore` | 15 |
| `docs/poc-results.md` 새 측정 | 수치를 인용한 장 (6, 7, 8, 9, 11, 13) |
| `docs/*.md` 새 설계 문서 | 1(전체 그림) + 해당 주제 장 |

마무리할 때:

- 16-2 발견 사항 표의 상태(확인 필요 → 확인됨·고침)를 갱신합니다.
- 링크 검사: 모든 상대 링크와 `#앵커`가 실제로 있는지 확인합니다.
- 이 파일에 항목을 추가합니다.

---

## 이력

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
| `docs/poc-results.md` "개선 묶음" | 바꾼 것 표, 시뮬레이션 4/6 → 3/6 → 6/6 → 6/6(회귀), LLM 아시아 처리 조사(Bedrock `jp.`만) |

#### 학습서에서 고친 곳

| 장 | 고친 곳 |
| --- | --- |
| 9 | **9-2⑨ "회사·기기 정보: 지식 자료" 신설** (RAG 없이 통째로, 근거 제한, 캐시 위치, 소스 기준 경로, `dedent` 함정) |
| 13 | 13-5 LLM 첫 토큰 후보에 **"LLM을 아시아에서 처리할 수 있나"** 조사 결과 (접속 지점 ≠ 처리 위치) |
| 14 | 14-5에 **"실제 기록: 4/6 → 3/6 → 6/6"** 절 신설 |
| 16 | #5에 시뮬레이션 2회차 근거 추가, **#22 추가** |

#### 새로 남긴 확인 필요

- 16-2 #22는 코드로 확인됨(확인 필요 아님). 고칠지는 사용자 판단.

### 2026-11-03 (5차): 확인 필요 2건 수정, 즉시 반응 미리 합성, 통화 결과 전송 반영

#### 기준

- 커밋 `d3a605b` + 미커밋 작업 트리 (4차 이후 사용자가 추가한 변경 + 이번 수정)
- 확인 당시 상태: `pnpm typecheck`·`pnpm lint`·`format:check` 통과, `pnpm test` **27개** 통과 (파일 7개)
- 버전: 3차와 같음

#### 이번에 고친 것 (이 작업)

| 파일 | 변경 | 관련 |
| --- | --- | --- |
| `src/call-guard.ts` | "여보세요?" 재생이 끝난 뒤 고객이 아직 `away`일 때만 무응답 타이머 시작 | 16-2 #19 → 고침 |
| `src/call-guard.test.ts` 신규 | 가짜 세션·가짜 시계로 무응답 종료, **도중 대답 시 끊지 않음**(고치기 전 실패 확인), 최대 길이, 닫힘 뒤 정지 | 14-3 |
| `docs/web-test.md` 6-3 | A안을 `lk agent dev --deployment production`으로, 이유와 B안 동시 실행 주의 추가 | 16-2 #16 → 문서 고침 |
| `docs/setup-checklist.md` 5-3 | Agent Console은 `lk agent dev`가 출력하는 링크로 열기 (직접 주소는 `production`으로 감) | 같은 원인 |

#### 레포에서 바뀐 것 (사용자 작업, 미커밋)

| 파일 | 변경 |
| --- | --- |
| `src/ack-audio.ts` 신규 | `AckAudioCache`: 즉시 반응 3문장을 통화 시작 때 HTTP 합성으로 미리 만들어 `say(text, { audio })`로 재생 |
| `src/call-result.ts`, `src/call-result.test.ts` 신규 | 통화 종료 시 대화록·지연 기록·종료 사유를 functions-xtool `submitVoiceCallResult`로 전송 (공유 비밀키 헤더, 10초 제한) |
| `src/main.ts`, `src/agent.ts` | 위 둘 연결, `endCall`이 종료 사유 기록 |
| `.env.example` | `VOICE_RESULT_URL`, `VOICE_AGENT_SECRET` |
| `docs/web-test.md` 4-1 | 받는 쪽: Firestore 저장(재전송 덮어쓰지 않음) → Opus 5.5 판정 추출 트리거 → 관리 화면 조회 |
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
| 16 | #14 대응, #16 문서 고침, #19 고침, **#20·#21 추가** |

#### 새로 남긴 확인 필요

- 16-2 #20: 통화 결과의 지연 기록에 취소된 LLM 지표·미리 합성 TTS 지표가 실제로 섞이는지 (결과 몇 건 확인)
- 16-2 #21: 고객이 먼저 끊었을 때 결과 전송이 언제 일어나는지
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
| 16 | 발견 사항 #5 → 일부 대응, #12 → AI가 끊는 경우 대응, **#19 추가** |

#### 새로 남긴 확인 필요

- 16-2 #5: 고지 도중에 말을 마친 고객의 턴이 여전히 버려지는지 (음성으로 고지 중 짧게 말해 보고 "skipping user input, current speech generation cannot be interrupted" 경고 확인)
- 16-2 #19: "여보세요?" 도중에 대답하면 무응답 타이머가 잘못 시작되는지

### 2026-11-03 (3차): 웹 테스트, 즉시 반응 측정 반영

#### 기준

- 커밋 `d3a605b` + 작업 트리(2차의 CI 수정, 미커밋)
- 버전: `@livekit/agents` 1.9.5, 플러그인(anthropic·elevenlabs·soniox) 1.9.5, `@livekit/plugins-ai-coustics` 0.3.5, `@livekit/rtc-node` 1.2.1, Node 24.22.2, LiveKit CLI 2.19.3

#### 레포에서 바뀐 것

| 변경 | 내용 |
| --- | --- |
| `docs/web-test.md` 신규 | 관리 화면(`/log`)에서 브라우저로 통화. functions-xtool이 접속 토큰에 에이전트 배정과 고객 정보를 넣음. 워커는 `lk agent dev` 또는 LiveKit Cloud 배포(`lk agent create`) |
| `docs/poc-results.md` "즉시 반응" 절 | 첫소리 1.4~1.6초 → 0.6~0.8초. 지시문만으로 첫머리 맞장구 금지 3/3 실패, 코드 제거 후 4/4 성공. 본 답이 다시 길어지는 경향 |
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
| 16 | 발견 사항 3·4번에 "직접 운영에서만" 조건, **16·17·18번 추가**, 용어 5개 추가 |

#### 새로 남긴 확인 필요

- 16-2 #16: 웹 테스트 A안(`lk agent dev`)에서 functions-xtool 토큰이 개발 워커에 닿는지. 안 닿으면 `lk agent dev --deployment production`.

### 2026-11-03 (2차): CI 단위 테스트, Dockerfile 수정 사례

**기준**: 커밋 `d3a605b` (사용자 커밋, Dockerfile 수정과 학습서 초판 포함)

#### 레포에서 바뀐 것

| 변경 | 내용 |
| --- | --- |
| `Dockerfile` (`d3a605b`) | 설치 전에 `pnpm-workspace.yaml`·`.npmrc`·`patches/` 복사 |
| `.github/workflows/tests.yml` | `pnpm test` 단계 추가 (미커밋) |
| `docs/setup-checklist.md` 1-1 | CI 설명에 단위 테스트 추가 (미커밋) |

**검증**: Docker 없이 빌드 단계를 임시 폴더에서 재현. 설치 통과, Soniox 패치 적용, `download-files` 통과, `prune --prod` 뒤 패치 유지·개발 도구 제거, 운영 의존성만으로 `node src/main.ts --help` 실행. 실제 `docker build`는 미실행.

**학습서에서 고친 곳**: 14-7(CI 표, 확인 문제 5번), 15-4("문제" → "수정 사례"), 15-9, 15장 확인 문제 6번, 16-2 #1·#2 → 고침, 실습 7번, README 목차 설명

### 2026-11-03 (1차): 초판 16장

#### 기준

- 커밋 `646d35d` 위의 작업 트리 (이 `src/`는 이후 `d3a605b`로 그대로 커밋됨)
- 버전: 3차와 같음

#### 출처

- 프로젝트 코드·테스트·설정·문서 전체
- 설치된 `@livekit/agents` 1.9.5와 플러그인 소스 (`node_modules/@livekit/*/src`, Soniox 패치는 `dist`)
- LiveKit 문서 (turn detector, adaptive interruption, turns, VAD, tuning, nodes)
- Claude API 문서 (Haiku 5.5 생각 모드·effort·캐시·sampling·prefill)

**내용**: 1~16장, README. 발견 사항 15개(16-2). 분량 약 19만 자.
