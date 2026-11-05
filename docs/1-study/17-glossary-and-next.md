# 17장. 용어집, 발견 사항, 더 공부할 거리

---

## 17-1. 용어집

가나다·ABC 순입니다. 괄호 안은 주로 다루는 장입니다.

| 용어 | 뜻 |
| --- | --- |
| 강제 선택 (forced choice) | 고를 값이 정해져 있으면 모델은 그중 하나를 고를 수밖에 없는 상황. "미확인" 같은 출구로 지어내기를 막음 (8) |
| 거짓 끼어들기 (false interruption) | 소리 때문에 에이전트가 멈췄는데 실제 말(글)은 없던 경우. 2초 뒤 이어서 말함 (7) |
| 계약 테스트 | 외부와 주고받는 형식을 검증하는 테스트. 가짜 서버로 요청 본문 검사 (14) |
| 관리 계정 / 멤버 계정 | AWS 조직의 주인 계정 / 그 아래 계정. SCP는 멤버 계정에만 적용 (16) |
| 구조화 출력 (structured outputs) | 스키마에 맞는 JSON만 내게 하는 API 기능. 원리는 제약 디코딩 (8) |
| 끝점 검출 (endpointing) | "말 한 덩어리가 끝났다"는 판단. STT도, 세션도 각자 함 (6, 7) |
| 끼어들기 (barge-in, interruption) | 에이전트가 말하는 중 고객이 말을 끊는 것 (7) |
| 나이퀴스트 주파수 | 샘플레이트의 절반. 담을 수 있는 최대 주파수 (2) |
| 다단계 빌드 (multi-stage build) | 빌드용 이미지와 실행용 이미지를 나누는 Docker 기법 (15) |
| 단계 연결형 (cascaded) | STT → LLM → TTS를 이어 붙인 구조 (1) |
| 디스패치 (dispatch) | 방에 어떤 에이전트를 투입할지 정하는 것. 자동/명시 (4) |
| 멱등성 (idempotence) | 여러 번 적용해도 결과가 같은 성질. `toSpoken` (10, 12) |
| 멱등 키 (idempotency key) | 같은 요청인지 가르는 값. 다시 보내도 결과가 한 번만 남게 함. 통화 결과의 `callId` (15) |
| 명시적 거부 (explicit deny) | IAM 평가에서 어떤 허용보다 먼저 이기는 거부 규칙 (16) |
| 방 유예 시간 (departure_timeout) | 에이전트가 아닌 마지막 참가자가 나간 뒤 방을 닫기까지 기다리는 시간 (4, 15) |
| 배포 (deployment) | 같은 에이전트 이름 안의 워커 무리. `production`, `staging`, `lk agent dev`의 `dev-…`. 배정에서 생략하면 `production` (4) |
| 베어러 토큰 (bearer token) | 가진 사람이 곧 주인인 토큰. 요청에 그대로 실음. Bedrock API 키 (16) |
| 문맥 편향 (contextual biasing) | STT가 특정 단어를 잘 알아듣게 기울이는 기법. `context.terms` (6) |
| 미확정/확정 (interim/final) | 스트리밍 STT의 바뀔 수 있는 결과 / 바뀌지 않는 결과 (6) |
| 변경 감지 테스트 (change-detector test) | 동작이 아니라 지금 상태를 고정해, 고칠 것이 없는데도 실패하는 테스트. 피할 모양 (14) |
| 보류 버퍼 (holdback buffer) | 판단에 필요한 만큼 조각을 모았다가 내보내는 스트림 기법 (12) |
| 불변식 (invariant) | 입력·데이터가 무엇이든 항상 성립해야 하는 성질. 테스트하기 좋은 대상 (14) |
| 부수 효과의 주인 | 외부 상태를 바꾸는 일(방 삭제 등)을 부르는 곳을 하나로 두는 원칙. 멱등하지 않은 연산일수록 중요 (4) |
| 상수 시간 비교 | 어디서 달라지든 같은 시간을 들이는 비교. 타이밍 공격 방어. `timingSafeEqual` (15) |
| 생존자 편향 (survivorship bias) | 끝까지 남은 것만 보고 판단해 생기는 치우침. 느려서 취소된 턴을 빼면 평균이 좋아 보임 (13) |
| 서비스 계정 / 서비스 에이전트 | GCP에서 프로그램의 신원 / 구글 서비스가 내 프로젝트에서 쓰는 신원 (16) |
| 선제 생성 (preemptive generation) | 턴 확정 전에 LLM을 미리 돌리는 투기적 실행 (11) |
| 세션 재개 (TLS session resumption) | 전에 받은 세션 티켓으로 TLS 핸드셰이크를 줄여 다시 연결하는 것. 연결이 닫혀도 미리 연결의 이득 일부가 남는 이유 (8) |
| 스펙트로그램 | 시간×주파수×세기로 소리를 그린 그림. 모델의 입력 (2) |
| 역 텍스트 정규화 (ITN) | "이백구십만" → "2,900,000"처럼 말한 형식을 쓰는 형식으로 (6) |
| 역압 (backpressure) | 소비가 느릴 때 생산을 늦추는 스트림 흐름 제어 (12) |
| 오디오 턴 감지 모델 | 소리(의미+운율)로 말 끝 확률을 내는 모델. `inference.TurnDetector` (7) |
| 워크로드 아이덴티티 연동 | 한 클라우드가 발급한 ID 토큰을 다른 클라우드의 임시 자격 증명으로 바꿔 장기 키 없이 인증 (16) |
| 유휴 연결 종료 (keep-alive timeout) | 쉬는 연결을 정한 시간 뒤 닫는 것. Node 내장 fetch와 `agentkeepalive` 기본 4초라, 턴 사이가 길면 매 턴 다시 연결 (8, 13) |
| 유휴 프로세스 프리워밍 | 잡이 오기 전에 자식 프로세스를 미리 띄워 두는 것 (4) |
| 음성 직통형 (speech-to-speech) | 소리를 받아 바로 소리를 내는 단일 모델 구조 (1) |
| 자격 증명 체인 (credential provider chain) | SDK가 환경변수 → 파일 → 메타데이터 순으로 키를 찾는 규칙. 앞에서 찾으면 끝 (16) |
| 잡 (job) | 통화 하나에 해당하는 일 단위. 자식 프로세스에서 실행 (4) |
| 접속 토큰 (access token) | 방 입장권. 서버가 비밀키로 서명한 JWT. 에이전트 배정(`roomConfig`)과 고객 정보까지 실을 수 있음 (3, 4) |
| 적응형 끼어들기 (adaptive interruption) | 겹친 소리를 모델로 판정해 맞장구와 끼어들기를 구분 (7) |
| 전환 적합 지점 (TRP) | 대화에서 다른 사람이 말을 이어받을 수 있는 지점 (7) |
| 제약 디코딩 (constrained decoding) | 문법(스키마)을 어기게 되는 토큰을 후보에서 지우며 생성하는 방식 (8) |
| 중도 절단 (censoring) | 값은 모르지만 "어느 값보다 크다"는 것만 아는 관측. 첫 토큰 전에 취소된 시도의 `-1` (13) |
| 즉시 반응 (ack) | 턴 직후 고정 문장("네네.")을 먼저 말해 침묵을 메우는 기법 (11) |
| 지터 / 지터 버퍼 | 패킷 도착 간격의 흔들림 / 그것을 고르게 하는 대기열 (2) |
| 최소 권한 (least privilege) | 하는 일에 꼭 필요한 동작·자원만 허용하는 원칙 (16) |
| 최소 한 번 전달 (at-least-once) | 이벤트가 빠지지는 않지만 두 번 올 수 있는 전달 보장. 받는 쪽이 멱등해야 함 (15) |
| 최종 일관성 (eventual consistency) | 변경이 결국에는 모든 곳에 반영되지만 바로는 아닐 수 있는 성질. 권한 변경 직후의 실패 (16) |
| 추론 프로필 (inference profile) | Bedrock에서 요청을 보낼 리전들을 정한 이름. `jp.`(일본 안)·`global.`(어디든) (16) |
| 텍스트 정규화 | "290만" → "이백구십만"처럼 읽는 말로 바꾸기 (10) |
| 프롬프트 캐시 | 요청 사이에 같은 앞부분의 계산을 재사용. 접두사 일치 (8) |
| 프리필 / 디코드 | LLM이 입력을 한꺼번에 처리하는 단계 / 토큰을 하나씩 만드는 단계 (8) |
| 히스테리시스 | 켜는 기준과 끄는 기준을 다르게 둬 깜빡임을 막는 것 (5) |
| AEC | 음향 에코 제거. 스피커 소리가 마이크로 되돌아오는 것을 지움 (2, 7) |
| AgentSession | 통화 하나를 지휘하는 LiveKit 객체 (11) |
| ARN | AWS 자원 이름. `arn:aws:서비스:리전:계정:자원` (16) |
| BPE | 자주 나오는 문자열을 토큰으로 묶는 분할 방식 (8) |
| CER / WER | 글자 / 단어 오류율. 편집 거리 기반 (6) |
| CTC / RNN-T | 음성 인식의 끝-끝 학습 방식들. RNN-T가 스트리밍에 적합 (6) |
| e2eLatency | 고객 말 멈춤 → 에이전트 첫 소리 재생. 체감 지연에 가장 가까운 값 (13) |
| EOU (end of utterance) | 말 끝. `EOUMetrics`의 대상 (7, 13) |
| G.711 (μ-law, A-law) | 전화망 표준 코덱. 8kHz, 8비트 로그 압축 (2) |
| G2P | 글자를 발음으로 바꾸기 (10) |
| IAM | 클라우드의 신원과 권한 관리. AWS에서는 사용자·역할·정책, GCP에서는 주체·역할·바인딩 (16) |
| ICE / STUN / TURN | NAT 너머 상대를 찾는 WebRTC 절차와 서버들 (3) |
| job metadata | 디스패치 때 실어 보내는 통화별 정보 문자열 (4) |
| JWT | 내용(JSON)에 서명을 붙인 토큰 형식. 서명 키가 없으면 내용을 바꿀 수 없음 (3) |
| livekit.toml | `lk agent create`가 만드는 LiveKit Cloud 프로젝트·에이전트 정보 파일. 커밋함 (15) |
| RoomAgentDispatch | 토큰의 방 설정 안에 넣는 "이 에이전트를 배정하라" 항목 (4) |
| LLM-as-a-judge | LLM으로 다른 LLM의 출력을 채점하는 평가 방식 (14) |
| MOS | 사람이 1~5점으로 매긴 음성 품질 평균 (10) |
| Opus | 인터넷 음성 표준 코덱. WebRTC 필수 (2) |
| PCM | 압축하지 않은 샘플 배열. int16 (2) |
| RoomIO | 방의 오디오·자막을 세션 입출력에 잇는 LiveKit 부품 (4) |
| RTP / SRTP | 실시간 미디어 전송 규약 / 그 암호화 버전 (3) |
| SBC | 통신사·기업의 SIP 경계 관문 (3) |
| SCP | AWS 조직이 계정에 거는 권한 상한. 권한을 주지 않고 막기만 함 (16) |
| SDP | 코덱·주소를 적은 미디어 명세서. offer/answer (3) |
| SFU | 미디어를 섞지 않고 골라 전달하는 서버. LiveKit (3) |
| SIP / SIP 트렁크 | 통화 신호 규약 / 통신사가 열어 주는 인터넷 전화 회선 묶음 (3) |
| SigV4 | 비밀 키를 보내지 않고 요청마다 서명하는 AWS 인증 방식. 날짜·리전·서비스로 좁힌 키로 서명 (16) |
| SpeechHandle | 에이전트가 말할 것 하나를 나타내는 객체. 대기열의 단위 (11) |
| STS | AWS 임시 자격 증명 발급 서비스. 역할 맡기, 웹 ID 연동 (16) |
| SSE | HTTP 응답을 끊지 않고 이벤트를 흘려보내는 형식 (8) |
| TCU | 턴 구성 단위. 문장·구·단어 (7) |
| TTFB / TTFT | 첫 오디오까지 / 첫 토큰까지 시간 (8, 10, 13) |
| VAD | 음성 활동 감지. 말소리 유무 (5) |
| zod | 스키마로 타입과 검증을 함께 정의하는 라이브러리 (4) |

---

## 17-2. 이 책을 쓰며 코드에서 발견한 사항

SDK·플러그인 코드를 읽고 일부를 재현하면서 찾은 것들입니다. **확인됨**은 직접 재현했거나 코드가 명확한 것, **확인 필요**는 코드 흐름으로 추론했으나 실측이나 서버 동작 확인이 필요한 것입니다.

| # | 발견 | 상태 | 영향 | 장 |
| --- | --- | --- | --- | --- |
| 1 | Dockerfile이 `pnpm-workspace.yaml`·`.npmrc`·`patches/`를 설치 **뒤에** 복사 → `--frozen-lockfile`이 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`로 실패 | **고침** (`d3a605b`, 빌드 단계 재현으로 검증) | 이미지 빌드 실패, 또는 패치 누락 시 말 끝 판단 회귀 | 15-4 |
| 2 | CI가 `pnpm test`를 돌리지 않음 | **고침** (워크플로에 단계 추가) | 단위 테스트 회귀를 못 잡음 | 14-7 |
| 3 | 직접 운영(`start`)에서는 적응형 끼어들기가 꺼지고, 턴 감지가 로컬 `v1-mini`가 됨 | 확인됨 (코드) | PoC(dev)와 운영의 턴 테이킹이 달라짐. **LiveKit Cloud 배포(웹 테스트 B안)는 해당 없음**, GKE 직접 운영일 때만 | 4-5, 7-5, 15-5 |
| 4 | VAD 방식에서는 finalize 패치가 맞장구 "네"의 FINAL을 앞당겨 에이전트 말을 끊을 수 있음 | 확인 필요 (실통화) | 맞장구에 답이 끊기고 새 답. 3번과 같은 조건(직접 운영)에서만 | 7-5 |
| 5 | 고지(끼어들기 막음) 중 고객 말은 STT에 무음이 들어가 **버려짐** — setup-checklist의 "끝난 뒤 반영"과 다름 | **일부 대응** (`discardAudioIfUninterruptible: false`). 고지 도중 말을 마치면 확정된 턴이 여전히 버려질 수 있음. **시뮬레이션 2회차에서 "설정만으로는 해결 안 됨" 확인**(텍스트 경로), 시나리오는 핵심 대사를 첫 질문 뒤로 옮겨 우회. 음성 경로는 확인 필요 | 고지 중 "전화하지 마세요" 같은 짧은 말 유실 | 7-6, 14-5 |
| 6 | Soniox 언어 감지를 끄면 토큰에 언어가 안 올 수 있고, 그러면 턴 감지가 영어 임계값을 씀 | 확인 필요 (Soniox 서버 동작) | 한국어 말 끝 판단 기준이 달라짐 | 7-4 |
| 7 | 오인식 보정이 일어난 턴은 선제 생성 결과가 무효 → LLM 재호출 | 확인됨 (코드) | 보정 턴이 오히려 느려짐. `sttNode`로 옮기면 해결 | 6-8, 11-4 |
| 8 | blingfire 문장 분할기의 20자 기준 → 짧은 한국어 답은 LLM이 끝날 때까지 TTS로 안 감 | 확인 필요 (지연 측정) | 수십~수백 ms 지연 | 10-4 |
| 9 | ElevenLabs 플러그인에 prewarm이 없어 첫 발화(고지)가 연결 비용을 냄 | 확인됨 (코드). 디버거 로그(2026-11-04)에서 첫 멘트의 TTS 첫 음성 0.78~0.84초, 다음 말 0.18~0.23초 | 첫 멘트 지연 | 10-3 |
| 10 | TTS alignment 때문에 대화 기록에 발음 변환된 글("에프투 울트라")이 남을 수 있음 | 확인 필요 | 대화록·판정 추출 표기 | 10-6 |
| 11 | `await ctx.connect()`는 `session.start()`가 이미 연결해서 아무 일도 안 함 | **고침** (2026-11-04: 줄을 지우고 "연결은 `session.start()`가 함" 주석. 디버거 로그로 세션의 자동 연결 확인) | 무해했음 | 4-6 |
| 12 | 고객이 끊어도 잡 프로세스가 바로 끝나지 않을 수 있음 (`ctx.shutdown()` 연결 없음) | **대응** (2026-11-04). AI가 끊는 경우는 `end_call` 도구·`endCall`이 `ctx.shutdown`을 부름. 고객이 먼저 끊는 경우는 에이전트만 남은 방이 유예 시간(`departure_timeout`) 뒤 닫힐 때 잡이 끝났는데(문서·코드로 확인), `deleteRoomOnClose: true`로 세션이 닫힐 때 방을 지워 바로 끝나게 함(#21) | 자원 점유 | 4-7 |
| 13 | SIP 발신에서 받기 전에 고지가 재생될 수 있음 | 확인 필요 (전화 연결 단계) | 법적 고지 누락 위험 | 4-6 |
| 14 | `say()` TTS는 재생 허가 후 시작 → 즉시 반응도 TTS 첫 음성만큼 기다림. 미리 합성(`say(text, { audio })`)으로 줄일 수 있음 | **대응** (`ack-audio.ts`). 실측 전 | 체감 지연 | 11-6, 13-5 |
| 15 | 세션 리포트에 SIP 전화번호가 트레이스 속성으로 기록되고, 업로드는 환경변수 키로만 인증 | 확인됨 (코드) | 개인정보 검토, 키 설정 방식 | 15-6 |
| 16 | 웹 테스트 A안(`lk agent dev`)은 무작위 `dev-` 배포로 등록되는데, functions-xtool 토큰은 배포 이름이 없어 `production`으로 배정됨 → 개발 워커에 안 닿을 수 있음 | **문서 고침** (6-web-test.md A안·setup-checklist 5-3에 `--deployment production`과 이유 추가). 실제 웹 통화로는 미확인 | 웹 테스트가 "에이전트가 안 들어옴"으로 실패 | 4-3 |
| 17 | 두 레포와 관리 화면 사이의 계약이 손으로 옮겨 적은 사본으로 유지됨: 고객 정보(3곳, 가상 고객 예시 2곳), 대화록·지연 기록(3곳), 판정 칸(2곳), 에이전트 이름(2곳) | 확인됨 (코드, 2026-11-04 사본 목록 갱신) | 한쪽만 바뀌면 조용히 "고객님"으로 진행, 화면 칸이 "—", 에이전트 이름이면 "에이전트가 안 들어옴". 계약 테스트·스키마 공유 검토 | 4-3 |
| 18 | 즉시 반응을 붙인 뒤 본 답이 다시 길어지는 경향 (고객 말 되풀이 + 질문 두 개) | 확인됨 (PoC 측정) | 통화가 길어짐. 지시문·시나리오로 다시 잡기 | 9-2, 11-6 |
| 19 | 무응답 안전장치: 고객이 "여보세요?" 도중에 대답하면, 재생이 끝난 뒤 무응답 타이머가 시작되어 10초 뒤 통화가 끊길 수 있음 (`call-guard.ts`) | **고침** (테스트로 재현 후 `session.userState === 'away'` 확인 추가, `call-guard.test.ts`) | 대화 중인 고객의 통화가 "통화가 어려우신 것 같아요"로 끊김 | 5-5 |
| 20 | 통화 결과로 보내는 지연 기록에 첫 토큰·첫 음성 전에 취소된 시도의 `-1`과 취소된 선제 생성의 LLM 지표(`cancelled: true`)가 섞이고, 즉시 반응 미리 합성 3건의 TTS 지표도 섞일 수 있음 (`call-result.ts`) | **고침** (2026-11-04: `addLatency`가 0 미만(`-1`)을 뺌. 미리 합성은 세션과 다른 TTS 객체로 해 처음부터 섞이지 않음. `cancelled`는 값이 실제로 잰 시간이고, 빼면 느린 턴이 골라 빠져(생존자 편향) **남김**. 테스트 4개 추가) | 관리 화면의 평균 지연이 틀어졌음(`-1`은 낮추고, 첫 음성 약 1.1초인 미리 합성 3건은 TTS 평균을 높임). `-1`을 빼도 가장 느린 시도 일부는 빠지므로(중도 절단) 평균은 여전히 약간 낙관적. 건수를 세려면 originalshq와 기록 모양을 바꿔야 함 | 13-5, 15-6 |
| 21 | 통화 결과 전송은 잡 종료 콜백에서 함 → 고객이 먼저 끊으면 세션만 닫히고, 에이전트만 남은 방이 유예 시간(`departure_timeout`) 뒤 닫힐 때에야 잡이 끝나 전송됨 (#12와 같은 원인) | **고침** (2026-11-04: `inputOptions.deleteRoomOnClose: true`. 방 삭제를 이 한곳으로 모아 `endCall`의 종료 콜백 삭제와 `end_call`의 `deleteRoom`을 끔. 원인은 SDK 코드 + LiveKit 문서로 확인). 실제 웹 통화로는 미확인 | 결과 반영이 방 유예 시간만큼 늦었음. 웹 테스트 화면은 2분 기다려 유실은 없었음 | 4-7, 15-6 |
| 22 | `prompt.test.ts`가 `expect(loadKnowledge()).toBe('')`로 **지금 지식 파일이 비어 있음**을 단언 | **고침** (2026-11-04: 템플릿 모양 입력으로 `cleanKnowledge`를 시험하고, 실제 파일은 작성 안내가 새지 않는지만 확인. 채운 파일은 통과, 닫히지 않은 주석은 실패함을 직접 확인) | 상담팀이 `knowledge/xtool.md`를 채우면 코드 변경 없이 CI 실패. `cleanKnowledge` 동작만 시험하거나 "문자열을 돌려준다"만 확인 | 9-2⑨, 14-2 |
| 23 | LiveKit 문서가 `delete_room_on_close`(세션이 닫히면 방 삭제)를 Python 전용으로 표시하지만, Node SDK 1.9.5에도 공개 옵션 `RoomInputOptions.deleteRoomOnClose`로 있음 | 확인됨 (SDK 타입·코드). LiveKit에 문서 피드백 보냄 | Node에서 #21의 한 줄 해결을 문서만 보고는 찾기 어려움 | 4-7, 15-6 |
| 24 | (originalshq) 판정 트리거가 시간 제한(120초)으로 강제 종료되면 `catch`가 돌지 않아 문서가 `saved`에 머물고, 관리 화면은 2분 뒤 "전송 설정(VOICE_RESULT_URL)을 확인하라"고 안내함 | 확인됨 (코드) | 전송은 성공했는데 엉뚱한 곳을 보게 됨. 문서가 `saved`인 채 시간이 지났으면 "판정이 멈춤, functions 로그 확인"으로 안내를 나누기 | 15-6 |
| 25 | 끼어들기 판정 로그가 AI 말이 먼저 끝나 판정이 없던 겹침(`agentEnded: true`, `isInterruption`은 늘 false)도 "맞장구로 판단"으로 적음 (`main.ts`) | **고침** (2026-11-04: 끼어들기·맞장구·판단 없음 셋으로 나눠 적음. SDK 통계와 같은 기준) | "안 끊길 때 원인"을 볼 때 판정이 없던 겹침이 모델 오판처럼 보임 | 7-5 |
| 26 | (2026-11-05) Bedrock 클라이언트가 `.env.local`에 남은 `AWS_BEARER_TOKEN_BEDROCK`(SCP가 막은 단기 API 키)을 IAM 액세스 키보다 먼저 씀. `new AnthropicBedrock({ awsRegion })`이 환경변수 토큰을 읽고, SDK 우선순위가 토큰 > 액세스 키 (`models/index.ts`, `@anthropic-ai/bedrock-sdk` `client.js`) | **고침** (2026-11-05: `createBedrockClient()`가 `apiKey: null`로 만듦. `index.test.ts`가 남은 변수를 흉내 내고 SigV4 서명을 확인하며, `apiKey: null`을 빼면 실패함을 확인. 실제 IAM 키에 가짜 남은 변수를 넣고 한 번 불러 인증 통과, 모델 사용 자격 403(16-1 #7)까지 감. `.env.local`의 그 줄도 지워짐) | 고치기 전: `LLM_PROVIDER=bedrock` 워커와 `pnpm compare:llm`이 `explicit deny`로 403 | 16-4, 8-8 |
| 27 | (2026-11-05) Bedrock 경로에서는 LLM 미리 연결이 조용히 빠짐. 플러그인의 `_prewarmImpl`이 `client.models.list`를 부르는데 `AnthropicBedrock`에는 `models`가 없어 TypeError, SDK `LLM.prewarm()`이 오류를 삼킴. 타입 강제 변환(`as unknown as`) 때문에 컴파일러도 못 잡음 | **고침** (2026-11-05: Bedrock일 때 `VoiceAnthropicLLM`이 같은 호스트(`prewarmUrl`)에 서명 없는 HEAD를 보냄. 테스트 추가. 가짜 키 실험에서 6초 쉰 뒤의 첫 요청이 6쌍 모두 빨라짐, 중앙값 약 0.21초 → 0.165초. 서버가 그 연결은 닫아(404, `connection: close`) DNS·TLS 세션만 남음) | 첫 LLM 요청의 연결 비용 약 0.05초. Anthropic 경로의 미리 연결도 #28 때문에 실제로는 이 정도만 남으므로 두 경로가 같아짐 | 8-8, 13-5 |
| 28 | (2026-11-05) LLM 연결이 **4초 넘게 쉬면 클라이언트가 닫음** → 미리 연결은 4초 안에 첫 요청이 와야 쓰이고, 통화 중에도 턴 사이가 4초를 넘으면 매 턴 TCP·TLS를 다시 맺음. Anthropic 경로는 SDK 0.33의 `agentkeepalive`(`freeSocketTimeout` 기본 4000ms), Bedrock 경로는 Node 내장 fetch(undici `keepAliveTimeout` 기본 4초, AWS가 `Keep-Alive` 헤더를 안 보냄) | 확인됨 (코드 + 가짜 키 실험: 0·3초 쉬면 연결 재사용, 5·6·10초면 새 연결). 실제 통화의 턴 간격과 지연은 미측정 | 다시 맺는 비용 약 0.07~0.1초(TLS 세션 재개 포함)가 턴마다 첫 토큰에 더해질 수 있음. `compare-llm`의 A/B는 호출 사이가 짧아 재사용된 연결로 잰 값. 대응 후보: 고객 말이 끝날 무렵 다시 데우기, 유휴 시간 늘리기(서버가 먼저 끊으면 요청 실패라 재시도 설계 필요) | 8-8, 13-5 |

---

## 17-3. 더 공부할 거리

### 이 레포 안에서

| 읽을 것 | 왜 |
| --- | --- |
| [2-tech-stack.md](../2-tech-stack.md) | 업체 분석, 부품 선택 근거, 비용, 개발 단계 |
| [5-poc-results.md](../5-poc-results.md) | 이 책의 수치들의 원본. 측정 방법과 판단 과정 |
| [4-setup-checklist.md](../4-setup-checklist.md) | 실제로 돌려 보기 위한 순서 |
| [7-telephony-setup.md](../7-telephony-setup.md) | 전화 연결 단계의 실무 |
| `node_modules/@livekit/agents/src/voice/agent_activity.ts` | 세션의 심장. 11장을 읽은 뒤 `userTurnCompletedImpl`, `pipelineReplyTask`부터 |
| `node_modules/@livekit/agents/src/voice/audio_recognition.ts` | 말 끝 판단. `runEOUDetection` |
| originalshq `functions-xtool/src/voice-call/analyze.ts` | 구조화 출력, 거절 대비, 스키마 설계 (8-11절) |
| originalshq `functions-xtool/src/endpoints/voice-agent.ts` | 토큰 발급, 비밀키 비교, 멱등 저장, 문서 생성 트리거 (3-7, 15-6절) |
| `node_modules/@anthropic-ai/bedrock-sdk/client.js`, `core/auth.js`, `core/streaming.js` | 인증 우선순위, 요청 다시 쓰기, 이벤트 스트림 → SSE 변환 (16-4, 16-6절) |

### LiveKit 문서

`lk docs` 명령이나 LiveKit Docs MCP로 최신 문서를 봅니다. 특히 다음 주제가 이 책과 직접 이어집니다.

- Turn detection & interruptions (턴 감지, 적응형 끼어들기, 튜닝)
- Pipeline nodes & hooks (노드 재정의)
- Workflows (핸드오프, 태스크)
- Tools (도구 정의)
- Testing (시뮬레이션, 디버거, 테스트 도구)
- Telephony (SIP 트렁크, 발신, 자동응답 감지)

### 이론 (검색어)

| 주제 | 검색어 |
| --- | --- |
| 턴 테이킹 | Sacks Schegloff Jefferson 1974 turn-taking, Stivers 2009 universals and cultural variation in turn-taking, Levinson Torreira 2015 timing in turn-taking |
| 음성 인식 | CTC Graves 2006, RNN-Transducer, Conformer, Whisper, contextual biasing ASR |
| 음성 합성 | Tacotron 2, FastSpeech 2, HiFi-GAN, VITS, VALL-E neural codec language model |
| VAD | Silero VAD, WebRTC VAD |
| LLM 추론 | prefill decode, KV cache, prompt caching, speculative decoding |
| 실시간 전송 | WebRTC ICE, SFU vs MCU, RTP RFC 3550, SIP RFC 3261, SDP offer/answer RFC 3264 |
| 스트림 | WHATWG Streams, backpressure, async iterators |
| 클라우드 권한 | AWS IAM policy evaluation logic, service control policies, Signature Version 4, STS AssumeRoleWithWebIdentity, Bedrock cross-Region inference, GCP IAM service agents, workload identity federation |

---

## 17-4. 직접 해 보면 좋은 실습

이해를 굳히는 가장 좋은 방법은 손으로 바꿔 보고 결과를 재는 것입니다. 쉬운 것부터 순서대로입니다.

1. **단위 테스트 추가.** `stripLeadingAck`에 "음, 그러니까요" 같은 사례를 넣고 기대 결과를 정해 보세요. 실패하면 정규식을 고칩니다. (12장)
2. **발음 하나 추가.** `SPOKEN_TERMS`에 새 항목을 넣고 `toSpoken`·스트림 테스트를 추가합니다. 공백이 든 항목을 넣으면 무엇이 깨지는지 확인합니다. (10장, 12장)
3. **시나리오 하나 추가.** "상담을 신청한 적이 없다"는 고객 시나리오를 `scenarios.yaml`에 쓰고 시뮬레이션을 돌립니다. (14장)
4. **메트릭 읽기.** `lk agent console`로 다섯 턴을 말하고, 로그의 EOU·LLM·TTS 메트릭으로 13장의 지연 표를 직접 채웁니다.
5. **설정 비교.** `LLM_THINKING=adaptive`로 바꿔 `pnpm check:llm`을 돌리고 첫 토큰·출력 토큰 변화를 확인합니다. (8장)
6. **보정 위치 옮기기.** `correctTranscript`를 `sttNode`로 옮겨 보고, 보정이 일어나는 턴에서 "preemptive generation invalidated" 경고가 사라지는지 확인합니다. (11장)
7. **이미지 빌드 확인.** Docker가 있는 환경에서 `docker build`를 돌리고, 이미지 안의 Soniox 플러그인 `dist/stt.js`에 `finalize`가 들어 있는지 확인합니다. 15-4절의 수정 전후로 Dockerfile을 바꿔 가며 lockfile 검사가 무엇을 잡는지도 봅니다. (15장)
8. **운영 모드로 재기.** `pnpm start`로 띄웠을 때(턴 감지 `v1-mini`, VAD 끼어들기) 맞장구 "네"에 에이전트가 멈추는지 확인하고, `interruption.mode: 'adaptive'`를 넣었을 때와 비교합니다. (7장)
9. **권한 정책 시험.** 16-5절의 예시 정책을 AWS IAM 정책 시뮬레이터에 넣고, `jp.` 프로필 ARN과 오사카 기본 모델 ARN에 대한 `bedrock:InvokeModelWithResponseStream`이 허용되는지, 프로필을 거치지 않고 오사카 모델을 바로 부르면 거부되는지 확인합니다. (16장)
