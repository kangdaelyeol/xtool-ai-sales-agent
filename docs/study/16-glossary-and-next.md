# 16장. 용어집, 발견 사항, 더 공부할 거리

---

## 16-1. 용어집

가나다·ABC 순입니다. 괄호 안은 주로 다루는 장입니다.

| 용어 | 뜻 |
| --- | --- |
| 거짓 끼어들기 (false interruption) | 소리 때문에 에이전트가 멈췄는데 실제 말(글)은 없던 경우. 2초 뒤 이어서 말함 (7) |
| 계약 테스트 | 외부와 주고받는 형식을 검증하는 테스트. 가짜 서버로 요청 본문 검사 (14) |
| 끝점 검출 (endpointing) | "말 한 덩어리가 끝났다"는 판단. STT도, 세션도 각자 함 (6, 7) |
| 끼어들기 (barge-in, interruption) | 에이전트가 말하는 중 고객이 말을 끊는 것 (7) |
| 나이퀴스트 주파수 | 샘플레이트의 절반. 담을 수 있는 최대 주파수 (2) |
| 다단계 빌드 (multi-stage build) | 빌드용 이미지와 실행용 이미지를 나누는 Docker 기법 (15) |
| 단계 연결형 (cascaded) | STT → LLM → TTS를 이어 붙인 구조 (1) |
| 디스패치 (dispatch) | 방에 어떤 에이전트를 투입할지 정하는 것. 자동/명시 (4) |
| 멱등성 (idempotence) | 여러 번 적용해도 결과가 같은 성질. `toSpoken` (10, 12) |
| 배포 (deployment) | 같은 에이전트 이름 안의 워커 무리. `production`, `staging`, `lk agent dev`의 `dev-…`. 배정에서 생략하면 `production` (4) |
| 문맥 편향 (contextual biasing) | STT가 특정 단어를 잘 알아듣게 기울이는 기법. `context.terms` (6) |
| 미확정/확정 (interim/final) | 스트리밍 STT의 바뀔 수 있는 결과 / 바뀌지 않는 결과 (6) |
| 보류 버퍼 (holdback buffer) | 판단에 필요한 만큼 조각을 모았다가 내보내는 스트림 기법 (12) |
| 선제 생성 (preemptive generation) | 턴 확정 전에 LLM을 미리 돌리는 투기적 실행 (11) |
| 스펙트로그램 | 시간×주파수×세기로 소리를 그린 그림. 모델의 입력 (2) |
| 역 텍스트 정규화 (ITN) | "이백구십만" → "2,900,000"처럼 말한 형식을 쓰는 형식으로 (6) |
| 역압 (backpressure) | 소비가 느릴 때 생산을 늦추는 스트림 흐름 제어 (12) |
| 오디오 턴 감지 모델 | 소리(의미+운율)로 말 끝 확률을 내는 모델. `inference.TurnDetector` (7) |
| 유휴 프로세스 프리워밍 | 잡이 오기 전에 자식 프로세스를 미리 띄워 두는 것 (4) |
| 음성 직통형 (speech-to-speech) | 소리를 받아 바로 소리를 내는 단일 모델 구조 (1) |
| 잡 (job) | 통화 하나에 해당하는 일 단위. 자식 프로세스에서 실행 (4) |
| 접속 토큰 (access token) | 방 입장권. 서버가 비밀키로 서명한 JWT. 에이전트 배정(`roomConfig`)과 고객 정보까지 실을 수 있음 (3, 4) |
| 적응형 끼어들기 (adaptive interruption) | 겹친 소리를 모델로 판정해 맞장구와 끼어들기를 구분 (7) |
| 전환 적합 지점 (TRP) | 대화에서 다른 사람이 말을 이어받을 수 있는 지점 (7) |
| 즉시 반응 (ack) | 턴 직후 고정 문장("네네.")을 먼저 말해 침묵을 메우는 기법 (11) |
| 지터 / 지터 버퍼 | 패킷 도착 간격의 흔들림 / 그것을 고르게 하는 대기열 (2) |
| 텍스트 정규화 | "290만" → "이백구십만"처럼 읽는 말로 바꾸기 (10) |
| 프롬프트 캐시 | 요청 사이에 같은 앞부분의 계산을 재사용. 접두사 일치 (8) |
| 프리필 / 디코드 | LLM이 입력을 한꺼번에 처리하는 단계 / 토큰을 하나씩 만드는 단계 (8) |
| 히스테리시스 | 켜는 기준과 끄는 기준을 다르게 둬 깜빡임을 막는 것 (5) |
| AEC | 음향 에코 제거. 스피커 소리가 마이크로 되돌아오는 것을 지움 (2, 7) |
| AgentSession | 통화 하나를 지휘하는 LiveKit 객체 (11) |
| BPE | 자주 나오는 문자열을 토큰으로 묶는 분할 방식 (8) |
| CER / WER | 글자 / 단어 오류율. 편집 거리 기반 (6) |
| CTC / RNN-T | 음성 인식의 끝-끝 학습 방식들. RNN-T가 스트리밍에 적합 (6) |
| e2eLatency | 고객 말 멈춤 → 에이전트 첫 소리 재생. 체감 지연에 가장 가까운 값 (13) |
| EOU (end of utterance) | 말 끝. `EOUMetrics`의 대상 (7, 13) |
| G.711 (μ-law, A-law) | 전화망 표준 코덱. 8kHz, 8비트 로그 압축 (2) |
| G2P | 글자를 발음으로 바꾸기 (10) |
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
| SDP | 코덱·주소를 적은 미디어 명세서. offer/answer (3) |
| SFU | 미디어를 섞지 않고 골라 전달하는 서버. LiveKit (3) |
| SIP / SIP 트렁크 | 통화 신호 규약 / 통신사가 열어 주는 인터넷 전화 회선 묶음 (3) |
| SpeechHandle | 에이전트가 말할 것 하나를 나타내는 객체. 대기열의 단위 (11) |
| SSE | HTTP 응답을 끊지 않고 이벤트를 흘려보내는 형식 (8) |
| TCU | 턴 구성 단위. 문장·구·단어 (7) |
| TTFB / TTFT | 첫 오디오까지 / 첫 토큰까지 시간 (8, 10, 13) |
| VAD | 음성 활동 감지. 말소리 유무 (5) |
| zod | 스키마로 타입과 검증을 함께 정의하는 라이브러리 (4) |

---

## 16-2. 이 책을 쓰며 코드에서 발견한 사항

SDK·플러그인 코드를 읽고 일부를 재현하면서 찾은 것들입니다. **확인됨**은 직접 재현했거나 코드가 명확한 것, **확인 필요**는 코드 흐름으로 추론했으나 실측이나 서버 동작 확인이 필요한 것입니다.

| # | 발견 | 상태 | 영향 | 장 |
| --- | --- | --- | --- | --- |
| 1 | Dockerfile이 `pnpm-workspace.yaml`·`.npmrc`·`patches/`를 설치 **뒤에** 복사 → `--frozen-lockfile`이 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`로 실패 | **고침** (`d3a605b`, 빌드 단계 재현으로 검증) | 이미지 빌드 실패, 또는 패치 누락 시 말 끝 판단 회귀 | 15-4 |
| 2 | CI가 `pnpm test`를 돌리지 않음 | **고침** (워크플로에 단계 추가) | 단위 테스트 회귀를 못 잡음 | 14-7 |
| 3 | 직접 운영(`start`)에서는 적응형 끼어들기가 꺼지고, 턴 감지가 로컬 `v1-mini`가 됨 | 확인됨 (코드) | PoC(dev)와 운영의 턴 테이킹이 달라짐. **LiveKit Cloud 배포(웹 테스트 B안)는 해당 없음**, GKE 직접 운영일 때만 | 4-5, 7-5, 15-5 |
| 4 | VAD 방식에서는 finalize 패치가 맞장구 "네"의 FINAL을 앞당겨 에이전트 말을 끊을 수 있음 | 확인 필요 (실통화) | 맞장구에 답이 끊기고 새 답. 3번과 같은 조건(직접 운영)에서만 | 7-5 |
| 5 | 고지(끼어들기 막음) 중 고객 말은 STT에 무음이 들어가 **버려짐** — setup-checklist의 "끝난 뒤 반영"과 다름 | **일부 대응** (작업 중: `discardAudioIfUninterruptible: false`). 고지 도중 말을 마치면 확정된 턴이 여전히 버려질 수 있음. **시뮬레이션 2회차에서 "설정만으로는 해결 안 됨" 확인**(텍스트 경로), 시나리오는 핵심 대사를 첫 질문 뒤로 옮겨 우회. 음성 경로는 확인 필요 | 고지 중 "전화하지 마세요" 같은 짧은 말 유실 | 7-6, 14-5 |
| 6 | Soniox 언어 감지를 끄면 토큰에 언어가 안 올 수 있고, 그러면 턴 감지가 영어 임계값을 씀 | 확인 필요 (Soniox 서버 동작) | 한국어 말 끝 판단 기준이 달라짐 | 7-4 |
| 7 | 오인식 보정이 일어난 턴은 선제 생성 결과가 무효 → LLM 재호출 | 확인됨 (코드) | 보정 턴이 오히려 느려짐. `sttNode`로 옮기면 해결 | 6-8, 11-4 |
| 8 | blingfire 문장 분할기의 20자 기준 → 짧은 한국어 답은 LLM이 끝날 때까지 TTS로 안 감 | 확인 필요 (지연 측정) | 수십~수백 ms 지연 | 10-4 |
| 9 | ElevenLabs 플러그인에 prewarm이 없어 첫 발화(고지)가 연결 비용을 냄 | 확인됨 (코드) | 첫 멘트 지연 | 10-3 |
| 10 | TTS alignment 때문에 대화 기록에 발음 변환된 글("에프투 울트라")이 남을 수 있음 | 확인 필요 | 대화록·판정 추출 표기 | 10-6 |
| 11 | `await ctx.connect()`는 `session.start()`가 이미 연결해서 아무 일도 안 함 | 확인됨 (코드) | 무해. 정리 대상 | 4-6 |
| 12 | 고객이 끊어도 잡 프로세스가 바로 끝나지 않을 수 있음 (`ctx.shutdown()` 연결 없음) | **AI가 끊는 경우는 대응** (작업 중: `end_call` 도구, `endCall`이 방 삭제 + `ctx.shutdown`). 고객이 먼저 끊는 경우는 확인 필요 | 자원 점유 | 4-7 |
| 13 | SIP 발신에서 받기 전에 고지가 재생될 수 있음 | 확인 필요 (전화 연결 단계) | 법적 고지 누락 위험 | 4-6 |
| 14 | `say()` TTS는 재생 허가 후 시작 → 즉시 반응도 TTS 첫 음성만큼 기다림. 미리 합성(`say(text, { audio })`)으로 줄일 수 있음 | **대응** (작업 중: `ack-audio.ts`). 실측 전 | 체감 지연 | 11-6, 13-5 |
| 15 | 세션 리포트에 SIP 전화번호가 트레이스 속성으로 기록되고, 업로드는 환경변수 키로만 인증 | 확인됨 (코드) | 개인정보 검토, 키 설정 방식 | 15-6 |
| 16 | 웹 테스트 A안(`lk agent dev`)은 무작위 `dev-` 배포로 등록되는데, functions-xtool 토큰은 배포 이름이 없어 `production`으로 배정됨 → 개발 워커에 안 닿을 수 있음 | **문서 고침** (web-test.md A안·setup-checklist 5-3에 `--deployment production`과 이유 추가). 실제 웹 통화로는 미확인 | 웹 테스트가 "에이전트가 안 들어옴"으로 실패 | 4-3 |
| 17 | 고객 정보(metadata) 계약이 두 레포에 따로 정의됨 (`call-context.ts`, functions-xtool `voice-agent.ts`) | 확인됨 (문서) | 한쪽만 바뀌면 조용히 "고객님"으로 진행. 계약 테스트·스키마 공유 검토 | 4-3 |
| 18 | 즉시 반응을 붙인 뒤 본 답이 다시 길어지는 경향 (고객 말 되풀이 + 질문 두 개) | 확인됨 (PoC 측정) | 통화가 길어짐. 지시문·시나리오로 다시 잡기 | 9-2, 11-6 |
| 19 | 무응답 안전장치: 고객이 "여보세요?" 도중에 대답하면, 재생이 끝난 뒤 무응답 타이머가 시작되어 10초 뒤 통화가 끊길 수 있음 (`call-guard.ts`, 작업 중) | **고침** (테스트로 재현 후 `session.userState === 'away'` 확인 추가, `call-guard.test.ts`) | 대화 중인 고객의 통화가 "통화가 어려우신 것 같아요"로 끊김 | 5-5 |
| 20 | 통화 결과로 보내는 지연 기록에 취소된 선제 생성의 LLM 지표(`cancelled: true`)와 즉시 반응 미리 합성 3건의 TTS 지표가 섞일 수 있음 (`call-result.ts`, 작업 중) | 확인 필요 (코드 흐름) | 통화별 병목 해석이 틀어짐. `cancelled` 거르기, 미리 합성용 TTS 객체 분리 | 13-5 |
| 21 | 통화 결과 전송은 잡 종료 콜백에서 함 → 고객이 먼저 끊으면 잡이 끝날 때까지 전송이 늦어질 수 있음 (#12와 같은 원인) | 확인 필요 (서버 정리 시점) | 결과 반영 지연. 세션 `Close`에서 `ctx.shutdown()` 호출로 경로 통일 | 15-6 |
| 22 | `prompt.test.ts`가 `expect(loadKnowledge()).toBe('')`로 **지금 지식 파일이 비어 있음**을 단언 (작업 중) | 확인됨 (코드) | 상담팀이 `knowledge/xtool.md`를 채우면 코드 변경 없이 CI 실패. `cleanKnowledge` 동작만 시험하거나 "문자열을 돌려준다"만 확인 | 9-2⑨, 14 |

---

## 16-3. 더 공부할 거리

### 이 레포 안에서

| 읽을 것 | 왜 |
| --- | --- |
| [tech-stack.md](../tech-stack.md) | 업체 분석, 부품 선택 근거, 비용, 개발 단계 |
| [poc-results.md](../poc-results.md) | 이 책의 수치들의 원본. 측정 방법과 판단 과정 |
| [setup-checklist.md](../setup-checklist.md) | 실제로 돌려 보기 위한 순서 |
| [telephony-setup.md](../telephony-setup.md) | 전화 연결 단계의 실무 |
| `node_modules/@livekit/agents/src/voice/agent_activity.ts` | 세션의 심장. 11장을 읽은 뒤 `userTurnCompletedImpl`, `pipelineReplyTask`부터 |
| `node_modules/@livekit/agents/src/voice/audio_recognition.ts` | 말 끝 판단. `runEOUDetection` |

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

---

## 16-4. 직접 해 보면 좋은 실습

이해를 굳히는 가장 좋은 방법은 손으로 바꿔 보고 결과를 재는 것입니다. 쉬운 것부터 순서대로입니다.

1. **단위 테스트 추가.** `stripLeadingAck`에 "음, 그러니까요" 같은 사례를 넣고 기대 결과를 정해 보세요. 실패하면 정규식을 고칩니다. (12장)
2. **발음 하나 추가.** `SPOKEN_TERMS`에 새 항목을 넣고 `toSpoken`·스트림 테스트를 추가합니다. 공백이 든 항목을 넣으면 무엇이 깨지는지 확인합니다. (10장, 12장)
3. **시나리오 하나 추가.** "상담을 신청한 적이 없다"는 고객 시나리오를 `scenarios.yaml`에 쓰고 시뮬레이션을 돌립니다. (14장)
4. **메트릭 읽기.** `lk agent console`로 다섯 턴을 말하고, 로그의 EOU·LLM·TTS 메트릭으로 13장의 지연 표를 직접 채웁니다.
5. **설정 비교.** `LLM_THINKING=adaptive`로 바꿔 `pnpm check:llm`을 돌리고 첫 토큰·출력 토큰 변화를 확인합니다. (8장)
6. **보정 위치 옮기기.** `correctTranscript`를 `sttNode`로 옮겨 보고, 보정이 일어나는 턴에서 "preemptive generation invalidated" 경고가 사라지는지 확인합니다. (11장)
7. **이미지 빌드 확인.** Docker가 있는 환경에서 `docker build`를 돌리고, 이미지 안의 Soniox 플러그인 `dist/stt.js`에 `finalize`가 들어 있는지 확인합니다. 15-4절의 수정 전후로 Dockerfile을 바꿔 가며 lockfile 검사가 무엇을 잡는지도 봅니다. (15장)
8. **운영 모드로 재기.** `pnpm start`로 띄웠을 때(턴 감지 `v1-mini`, VAD 끼어들기) 맞장구 "네"에 에이전트가 멈추는지 확인하고, `interruption.mode: 'adaptive'`를 넣었을 때와 비교합니다. (7장)
