# xtool-ai-sales-agent

주식회사 오리지널스(xTool 레이저 장비 판매)의 **AI 음성 영업 상담원** 워커입니다.
웹사이트에서 상담을 신청한 고객에게 AI가 바로 전화해 1차 판정(용도·예산·할부·도입 시기)을 하고, 방문체험 예약이나 상담사 인계로 넘깁니다.

업체 서비스(vox.ai, ElevenLabs Agents)를 쓰지 않고 STT → LLM → TTS를 [LiveKit Agents](https://docs.livekit.io/agents/)(TypeScript)로 직접 조합합니다. 공식 스타터 [agent-starter-node](https://github.com/livekit-examples/agent-starter-node)(2026-10-22 커밋 `3715649`)를 바탕으로 했습니다.

## 레포 역할

| 레포        | 담당                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------- |
| **이 레포** | 음성 에이전트 워커, 배포 설정, 기술 문서                                                  |
| originalshq | 업무 연동(functions-xtool의 발신 요청·통화 결과 처리·Monday·Solapi), 검수 화면, 업무 문서 |

두 레포는 같은 Firebase 프로젝트의 Firestore(예: `calls/{id}`)와, 에이전트가 부르는 functions-xtool API(공유 비밀키 인증)로 연결합니다.

## 문서

| 문서                                                             | 내용                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [docs/setup-checklist.md](docs/setup-checklist.md)               | **지금까지 한 일과 직접 해야 할 세팅 (여기서 시작)**                             |
| [docs/web-test.md](docs/web-test.md)                             | 관리 화면(/log)에서 브라우저로 통화하는 웹 테스트: 세션 API 명세, 배포 순서      |
| [docs/poc-results.md](docs/poc-results.md)                       | PoC 측정 기록 (지연, STT 인식, 음성 후보)                                        |
| [docs/study/](docs/study/README.md)                              | 학습서: 이 레포로 배우는 음성 AI 에이전트의 개념·이론·기법 (16장)                |
| [docs/tech-stack.md](docs/tech-stack.md)                         | 업체 기술 분석, 부품 선택, 아키텍처, 개발 단계                                   |
| [docs/poc-setup.md](docs/poc-setup.md)                           | 브라우저 PoC용 구독 서비스와 설치 순서                                           |
| [docs/telephony-setup.md](docs/telephony-setup.md)               | 국내 SIP 회선 요구 사항과 Asterisk 세팅 (프로덕션 단계)                          |
| [업무 문서 README](../originalshq/docs/ai-sales-agent/README.md) | 적용 업무, 판정 기준, 대화 설계, 법무 (originalshq, git에 올리지 않는 로컬 문서) |

> 업무 문서 링크는 두 레포를 같은 폴더(`~/projects/`)에 나란히 둔다는 전제의 상대경로입니다.

## 시작하기

준비물: Node.js 24 이상, pnpm 12.16.1(`package.json`의 `packageManager`로 고정, `corepack enable`이면 자동), LiveKit CLI 2.18.8 이상 ([poc-setup.md 2장](docs/poc-setup.md#2-설치-순서))

```bash
pnpm install
lk cloud auth                  # LiveKit Cloud 로그인
cp .env.example .env.local     # 키 채우기 (커밋하지 않음)
pnpm test                      # 키 없이 도는 단위 테스트
pnpm check:llm                 # Haiku 5.5 생각 모드·effort별 응답 지연 (ANTHROPIC_API_KEY 필요)

lk agent console               # 터미널에서 마이크로 바로 대화
lk agent dev                   # 워커 실행 → LiveKit Cloud Agent Console(브라우저)에서 대화
```

## 구조

```text
src/
  main.ts           워커 진입점: AgentSession 구성, 고정 첫 멘트
  agent.ts          에이전트: 지시문 + LLM (통화 중 도구는 functions-xtool API가 생기면 추가)
  prompt.ts         상담 프롬프트 초안과 첫 멘트 (AI·녹음 고지)
  call-context.ts   통화별 고객 정보 (job metadata JSON, originalshq와의 계약)
  config.ts         부품 선택 (STT_/LLM_/TTS_PROVIDER 환경변수)
  models/           부품 생성, Haiku 5.5용 LLM 래퍼(생각 모드·effort·캐시), Soniox 수동 확정
  glossary.ts       STT 강조 단어, TTS 발음표
  pronunciation.ts  TTS 앞 발음 변환 (F2 울트라 → 에프투 울트라)
scripts/check-llm.ts  LLM 지연 측정
patches/            외부 패키지 패치 (Soniox: flush → finalize). LiveKit 업그레이드 때 다시 확인
docs/               기술 문서
scenarios.yaml      시뮬레이션 시나리오 (lk agent simulate text --scenarios scenarios.yaml)
Dockerfile          배포 이미지 (GKE Autopilot 또는 GCE 서울 예정)
```

## 명령

| 명령                        | 내용                      |
| --------------------------- | ------------------------- |
| `pnpm typecheck`            | 타입 검사                 |
| `pnpm lint` / `pnpm format` | 린트 / 포맷               |
| `pnpm test`                 | 단위 테스트 (vitest)      |
| `pnpm check:llm`            | LLM 지연 측정             |
| `pnpm start`                | 프로덕션 모드로 워커 실행 |
