# 15장. 설정·빌드·배포·운영

코드가 **어떻게 설정되고, 어떤 도구로 검사·실행되고, 어떻게 이미지로 묶여 서버에 올라가며, 운영 중 무엇을 지켜봐야 하는지**를 다룹니다. 이 프로젝트는 아직 PoC 단계라 배포 설정이 Dockerfile까지만 있으므로, 앞으로 할 일도 함께 정리합니다. 클라우드 계정과 권한(AWS·GCP)은 다음 16장에서 따로 다룹니다.

(2026-11-06 추가) 이번 판에서는 **이미지·컨테이너·배포·운영 쪽을 로우레벨까지** 내려갔습니다. tsc가 실제로 무엇을 잡는지(15-1·15-2절), Node가 `.ts`를 어떻게 지우는지(15-2절), lockfile의 해시가 무엇을 지키는지(15-3절), Docker 레이어와 캐시 키, PID 1과 신호, 쿠버네티스 종료 순서(15-4절), CPU 한도에서 유휴 프로세스 수까지, 메모리와 OOM(15-5절), 운영 로그와 타이밍 공격의 숫자(15-6절), 최악의 침묵(15-7절)을 더했습니다. 워커 내부의 루프 감시, 프로세스 트리와 RSS, drain과 종료 코드 143·137, cgroup 부하 식은 [4장](04-worker-runtime.md)에 이미 있으므로 다시 쓰지 않고 링크합니다. 숫자마다 코드로 확인했는지, 잰 값인지, 추정인지를 적었습니다. 실습 스크립트 다섯 개는 키 없이 돕니다([lab/15-tsc-checks.mjs](lab/15-tsc-checks.mjs), [lab/15-type-stripping.mjs](lab/15-type-stripping.mjs), [lab/15-docker-cache.mjs](lab/15-docker-cache.mjs), [lab/15-signals.mjs](lab/15-signals.mjs), [lab/15-timing.mjs](lab/15-timing.mjs)). 이 맥에는 Docker가 없어 이미지를 실제로 빌드하지는 못했습니다. Docker가 필요한 확인은 직접 돌릴 명령으로 적었습니다.

(2026-11-08 추가) **이 장의 지도.** 이 장은 코드 한 줄이 고객의 전화에 닿기까지 거치는 차례를 따라갑니다. 아래 그림은 위에서 아래로 그 차례입니다. `[ ]`는 그 일이 일어나는 곳, `→`는 값이나 파일이 넘어가는 방향, `│`·`▼`는 다음 차례로 넘어감, 오른쪽 숫자는 그 내용을 다루는 절입니다.

```text
[개발 맥]
  .env.local → process.env → loadConfig() → Config 객체 → 팩토리가 STT·LLM·TTS 생성   15-1
  src/*.ts: tsc는 타입 검사만, 실행은 node가 타입 표기를 지우고 바로                  15-2
  package.json·pnpm-lock.yaml → pnpm install (판과 해시 고정, Soniox 패치 적용)        15-3
     │ docker build (Dockerfile, .dockerignore)
     ▼
[이미지]  node:24-slim + node_modules + src, 실행 명령 node src/main.ts start         15-4
     │ 종료: SIGTERM → drain → 종료 코드 143 (유예 시간을 넘기면 SIGKILL → 137)
     ├→ LiveKit Cloud 배포: lk agent create·deploy, LiveKit이 원격 빌드하고 실행     15-5
     └→ 직접 운영: GKE 파드 (헬스 체크, CPU·메모리 한도, 유휴 프로세스 수)            15-5
[운영 중]
  JSON 로그, 세션 리포트, 통화 결과 전송                                            15-6
  공급사 장애 때 고객이 듣는 침묵과 대체 경로                                       15-7
  비밀값·개인정보 점검표                                                           15-8
```

15-1∼15-3은 지금 맥에서 매일 쓰는 것입니다. 15-4∼15-5는 아직 실제로 배포하기 전이라(이미지를 빌드하지 않았고, LiveKit Cloud 배포도 만들지 않음) Dockerfile·SDK 코드·공식 문서로 확인한 내용입니다. 15-6∼15-8은 운영을 시작하면 지켜볼 것입니다. 처음 읽을 때는 각 절의 본문과 표만 따라가고, `#### 깊이 보기`는 배포를 준비할 때 돌아와 읽어도 흐름을 잃지 않습니다.

---

## 이 장에서 쓰는 말 (2026-11-06 추가)

처음 보면 막히는 말만 모았습니다. (2026-11-08 갱신) 본문에 처음 나오는 차례로 다시 늘어놓고, 설정·빌드·컨테이너·배포·자원·관측의 기본 낱말을 더했습니다. 4장에서 정의한 말(PID 1, SIGTERM/SIGKILL, drain, cgroup, RSS)도 이 장에서 자주 쓰므로 한 줄씩 다시 적었습니다. 자세한 뜻은 괄호 안의 절에 있고, 전체 용어집은 [17-1절](17-glossary-and-next.md#17-1-용어집)입니다.

| 말 | 뜻 |
| --- | --- |
| 설정 (config) | 코드를 고치지 않고 실행할 때마다 바꿀 수 있는 값입니다. 이 레포에서는 API 키, 공급사·모델 선택, 결과를 보낼 주소입니다. `src/config.ts`의 `loadConfig()`가 환경변수를 읽어 `Config` 객체로 만듭니다(15-1절) |
| 환경변수 | 운영체제가 프로세스를 띄울 때 함께 넘기는 `이름=값` 문자열 목록입니다. Node에서는 `process.env.이름`으로 읽습니다. 값은 늘 문자열이고, 없으면 `undefined`입니다(15-1절) |
| `.env.local` / dotenv | 개발 맥에서 환경변수를 줄마다 적어 두는 파일(커밋하지 않음) / 워커가 시작할 때 그 파일을 읽어 `process.env`에 채우는 라이브러리입니다(`src/main.ts` 21행). 이미 있는 환경변수는 덮어쓰지 않습니다(15-1절) |
| 12-Factor | 클라우드에서 돌릴 앱을 만드는 열두 가지 원칙 모음입니다. 이 장에서 쓰는 것은 셋째 "설정은 환경변수에"(같은 이미지, 다른 환경변수)와 아홉째 "빨리 시작하고 정상 종료하기"(SIGTERM을 받으면 새 일은 받지 않고 하던 일을 마친 뒤 끝냄, drain)입니다(15-1·15-4절) |
| 빨리 실패하기 (fail fast) | 잘못된 값을 받으면 기본값으로 조용히 넘어가지 않고, 시작할 때 바로 오류를 내는 원칙입니다. `pick()`이 이렇게 합니다(15-1절) |
| 전략 패턴 | 같은 일(음성 → 글)을 하는 방법 여러 개를 같은 인터페이스(`stt.STT`) 뒤에 두고 실행 중에 고르는 설계입니다. 고르는 함수가 팩토리(`createSTT`)입니다(15-1절) |
| 완전성 검사 / `never` | 유니온의 모든 경우를 다뤘는지 컴파일러가 확인하게 하는 기법입니다. `never`는 "값이 있을 수 없는 타입"이라, 모든 경우를 지운 뒤 남은 값을 `never`에 넣으면 빠뜨린 경우가 있을 때만 오류가 납니다(15-1절) |
| tsc / tsconfig.json | TypeScript 컴파일러 / 그 설정 파일입니다. 이 레포는 tsc를 타입 검사에만 쓰고(`noEmit`, `pnpm typecheck`) JS 파일은 만들지 않습니다(15-2절) |
| 트랜스파일 vs 타입 지우기 | 트랜스파일은 TS를 다른 JS로 **다시 써서** 내보내는 것(tsc, esbuild), 타입 지우기는 타입 표기 자리를 **공백으로 덮기만** 하는 것입니다. 지우기는 줄·열이 그대로라 소스맵이 필요 없지만, `enum`처럼 JS 코드를 새로 만들어야 하는 문법은 못 다룹니다(15-2절) |
| 소스맵 (source map) | 변환된 JS의 줄·열을 원래 TS의 줄·열로 되돌리는 대응표 파일입니다. 오류의 스택 추적을 원본 위치로 보여 줄 때 씁니다. 타입 지우기는 위치를 바꾸지 않으므로 필요 없습니다(15-2절) |
| ESM 해석 규칙 | `import './x'`의 `./x`를 파일로 바꾸는 규칙입니다. Node의 ESM은 확장자를 추측하지 않고 쓴 그대로 찾습니다(`require`와 다름). tsc의 `moduleResolution`은 이 규칙을 어느 쪽에 맞춰 흉내 낼지 고르는 옵션입니다(15-2절) |
| 패키지 관리자 / lockfile | 의존성 패키지를 레지스트리(npm 저장소)에서 받아 `node_modules/`에 까는 도구(이 레포는 pnpm) / 실제로 고른 판과 파일 해시를 모두 적어 커밋하는 파일(`pnpm-lock.yaml`)입니다(15-3절) |
| corepack | Node에 딸려 오는 "패키지 관리자 관리자"입니다. `package.json`의 `packageManager`를 읽고 그 판의 pnpm·yarn을 받아 실행합니다. 이 맥의 `pnpm` 명령이 corepack의 대리 실행 파일입니다(15-3절) |
| integrity (SRI) | lockfile에 패키지마다 적힌 `sha512-…` 값입니다. 받은 압축 파일의 SHA-512를 base64로 적은 것이라, 내용이 한 바이트라도 다르면 설치가 멈춥니다. 브라우저의 Subresource Integrity와 같은 표기입니다(15-3절) |
| 피어 의존성 (peer dependency) | "나를 쓰는 쪽이 이 패키지를 함께 깔아 달라"는 선언입니다. 플러그인과 본체가 같은 사본을 쓰게 하려는 장치입니다. lockfile에서 `1.9.5(@livekit/rtc-node@1.2.1)`처럼 괄호로 붙습니다(15-3절) |
| overrides | 의존성 트리 어디에 있든 특정 패키지의 판을 강제로 바꾸는 설정입니다(15-3절) |
| Docker 이미지 / 컨테이너 | 실행에 필요한 파일(리눅스의 최소 파일, node, `node_modules`, 소스)과 실행 명령을 묶은 읽기 전용 꾸러미 / 그 이미지를 띄운 격리된 프로세스입니다. 컨테이너 안의 프로세스는 자기만의 파일시스템과 PID 번호를 봅니다(15-4절) |
| Dockerfile / 다단계 빌드 | 이미지를 만드는 순서를 적은 파일 / 한 Dockerfile에 `FROM`을 여러 번 써서, 앞 단계의 결과 중 필요한 것만 최종 이미지로 옮기는 방법입니다. 이 레포는 base·build·최종 세 단계입니다(15-4절) |
| 레이어 / overlayfs | 이미지는 Dockerfile 한 줄이 만든 변경분(tar 파일)을 쌓은 것이고, 각 변경분이 레이어입니다. 실행할 때는 overlayfs가 레이어들을 겹쳐 하나의 파일시스템처럼 보여 줍니다(15-4절) |
| 빌드 컨텍스트 | `docker build`가 Docker에 넘기는 폴더 내용입니다. `COPY . .`는 git이 아니라 **이 폴더**를 봅니다. `.dockerignore`에 적은 것만 빠집니다(15-4절) |
| 캐시 마운트 | BuildKit의 `RUN --mount=type=cache`로 그 한 줄에만 붙이는 폴더입니다. 내용은 빌드 사이에 남지만 이미지 레이어에는 들어가지 않습니다(15-4절, 제안) |
| PID 1 | 컨테이너 안에서 처음 실행된 프로세스입니다. 처리기를 건 신호만 받고, 부모를 잃은 프로세스를 넘겨받아 거둬야 합니다. 이 레포는 node 워커가 PID 1입니다(15-4절, 4-7절) |
| 좀비 프로세스 / tini | 이미 끝났지만 부모가 종료 상태를 읽어 가지(거두지) 않아 프로세스 표에 한 칸이 남은 것 / PID 1 자리에서 신호를 자식에게 넘기고 좀비를 거두는 일만 하는 작은 init 프로그램입니다(15-4절) |
| SIGTERM / SIGKILL | 프로세스에 보내는 종료 신호입니다. SIGTERM은 "마무리하고 끝내라"는 요청이라 프로그램이 받아 처리할 수 있고, SIGKILL은 운영체제가 즉시 끝내는 것이라 받을 수 없습니다(4-7절, 15-4절) |
| drain | "새 일은 안 받고, 하던 통화는 끝까지" 하는 종료 방식입니다. SDK의 상한은 60분이고, 끝나면 종료 코드 143으로 나갑니다(4-7절, 15-4절) |
| 유예 시간 (`terminationGracePeriodSeconds`) | 쿠버네티스가 SIGTERM을 보낸 뒤 SIGKILL까지 기다려 주는 시간입니다. 기본 30초이고, 넘기면 남은 프로세스가 SIGKILL로 끝나 종료 코드 137이 남습니다(15-4절) |
| LiveKit Cloud 배포 | LiveKit이 이 레포의 Dockerfile로 이미지를 원격 빌드하고 자기 서버에서 워커를 돌려 주는 방식입니다. 처음은 `lk agent create`, 새 판은 `lk agent deploy`로 올립니다(15-5절) |
| 쿠버네티스 / 파드 / 노드 | 컨테이너를 여러 서버에 배치하고 끝나면 다시 띄우는 시스템 / 쿠버네티스가 함께 배치하는 컨테이너 묶음의 단위 / 파드가 올라가는 서버 한 대입니다(15-4·15-5절) |
| GKE / GCE | 구글 클라우드가 운영해 주는 쿠버네티스(Autopilot 방식이면 노드 관리까지 맡김) / 구글 클라우드의 가상 머신입니다. 직접 운영 후보는 서울 리전입니다(15-5절) |
| readiness / liveness / startup probe | 쿠버네티스의 상태 검사 셋입니다. readiness는 "일을 받아도 되나", liveness는 "살아 있나(아니면 재시작)", startup은 "아직 켜지는 중인가"입니다(15-5절) |
| emptyDir | 파드가 살아 있는 동안만 있는 빈 임시 폴더입니다. 루트 파일시스템을 읽기 전용으로 둘 때 쓰기 자리로 붙입니다(15-5절) |
| 콜드 스타트 | 쉬고 있던 인스턴스가 0대여서, 요청이 온 뒤에야 컨테이너를 띄우느라 생기는 지연입니다(15-5절) |
| cgroup | 리눅스가 프로세스 묶음(컨테이너)의 CPU·메모리를 재고 제한하는 장치입니다. 컨테이너 안에서는 `/sys/fs/cgroup/cpu.max`(CPU 한도), `memory.current`(지금 쓰는 메모리) 같은 파일로 보입니다(15-5절, 4-2절) |
| vCPU / CPU 한도 | 클라우드가 빌려주는 가상 CPU 하나(흔히 물리 코어의 하드웨어 스레드 하나) / cgroup `cpu.max`에 거는 상한입니다. `150000 100000`은 0.1초마다 CPU 시간을 0.15초까지 쓸 수 있다는 뜻이라 1.5 CPU입니다(15-5절) |
| RSS | 프로세스가 지금 실제 RAM에 올려 둔 메모리 크기입니다. 이 레포의 유휴 잡 프로세스는 약 236MB입니다(4-4절, 15-5절) |
| OOM / OOM killer | 메모리가 한도를 넘은 상태(Out Of Memory) / 그때 커널이 프로세스를 SIGKILL로 끝내는 장치입니다. 파드에 `OOMKilled`, 종료 코드 137이 남습니다(15-5절) |
| 관측 (observability) / 구조화 로그 | 운영 중에 안에서 무슨 일이 있었는지 밖에서 알 수 있게 남기는 것(로그·지표·트레이스) / 한 줄을 JSON 객체로 남겨 필드로 검색할 수 있게 한 로그입니다. `start`의 로그가 이것입니다(15-6절) |
| OTel 트레이스 / 스팬 | OpenTelemetry의 기록 단위입니다. 스팬은 이름·시작·끝·속성이 있는 한 구간(예: `room_disconnect`), 트레이스는 한 통화의 스팬들을 부모-자식으로 엮은 나무입니다(15-6절) |
| 타이밍 공격 | 비교에 걸리는 시간 차이로 비밀값을 한 글자씩 알아내는 공격입니다. 어디서 달라지든 같은 시간이 걸리는 비교(`timingSafeEqual`)로 막습니다(15-6절) |
| FallbackAdapter | 같은 종류의 부품(STT·LLM·TTS) 여러 개를 순서대로 두고, 앞의 것이 실패하면 다음 것으로 넘기는 LiveKit의 감싸기 클래스입니다. Node SDK에도 있습니다(15-7절) |

---

## 15-1. 설정: 환경변수로 부품 바꾸기

(2026-11-08 추가) **설정**(config)은 코드를 고치지 않고 실행할 때마다 바꿀 수 있는 값입니다. 이 레포에서는 API 키, 어느 공급사의 STT·LLM·TTS를 쓸지, 모델 이름, 통화 결과를 보낼 주소가 여기에 듭니다. 이 값들은 **환경변수**로 들어옵니다. 환경변수는 운영체제가 프로세스를 띄울 때 함께 넘겨주는 `이름=값` 문자열 목록이고, Node에서는 `process.env.LLM_PROVIDER`처럼 읽습니다. 값은 늘 문자열이며, 없으면 `undefined`입니다.

개발할 때 키를 셸에 일일이 넣기는 번거로우므로, `이름=값`을 줄마다 적은 **`.env.local`** 파일을 레포 루트에 둡니다(커밋하지 않음, `.gitignore`). 워커가 시작할 때 dotenv 라이브러리가 이 파일을 읽어 `process.env`에 채웁니다([src/main.ts](../../src/main.ts) 21행 `dotenv.config({ path: '.env.local' })`). 이미 같은 이름의 환경변수가 있으면 파일 값으로 덮어쓰지 않습니다(dotenv 17.4.2의 기본값 `override: false`, `lib/main.js` 372행). 운영 이미지에는 이 파일이 없습니다(15-4절). 대신 컨테이너를 띄우는 쪽(LiveKit Cloud의 비밀값 저장소, 쿠버네티스 Secret)이 환경변수를 직접 넣습니다. 값 하나가 부품이 되기까지의 길은 이렇습니다.

```text
.env.local       LLM_PROVIDER=bedrock          ← 개발 맥. 운영에서는 비밀값 저장소·Secret이 대신 넣음
   │ dotenv.config (src/main.ts 21행, 프로세스가 뜰 때 한 번)
process.env      { LLM_PROVIDER: 'bedrock', … }  ← 모든 값은 문자열
   │ loadConfig() (src/config.ts 56~76행, entry 안에서 통화마다 한 번)
Config 객체      { llm: { provider: 'bedrock', model: 'jp.anthropic.claude-haiku-5-5', effort: 'low', … } }
   │ createLLM(config.llm) (src/models/index.ts 29~61행)
부품             VoiceAnthropicLLM + Bedrock 클라이언트
```

그림의 세로줄 옆 괄호는 그 단계가 일어나는 파일과 시점입니다. 예로 든 Bedrock은 설정 한 줄로 바뀌지만, 실제로 바꾸기 전에 자동 캐시가 그 경로에서 통하는지부터 봐야 합니다(15-5절 "LiveKit Cloud 배포: 비밀값을 넘기는 방법", 8-8절). 이 절은 이 길을 차례로 봅니다. 먼저 왜 설정을 환경변수로 두는지(12-Factor), 그다음 `loadConfig()`가 값을 검사하는 방법, 마지막으로 팩토리가 `Config`를 보고 부품을 고르는 방법입니다.

### 12-Factor의 "설정은 환경에"

코드와 설정을 분리하는 원칙입니다. 같은 이미지를 개발·운영에서 쓰고, 다른 것은 **환경변수**뿐이어야 합니다. 그래야 맥에서 시험한 이미지를 그대로 운영에 올리고, 키나 모델을 바꿀 때 이미지를 다시 빌드하지 않습니다. 이 프로젝트의 환경변수는 세 종류입니다([.env.example](../../.env.example)).

| 종류 | 예 | 성격 |
| --- | --- | --- |
| 비밀값 | `LIVEKIT_API_SECRET`, `ANTHROPIC_API_KEY`, `ELEVEN_API_KEY`, `SONIOX_API_KEY`, `VOICE_AGENT_SECRET`(결과 전송, 15-6절). Bedrock을 쓰면 `AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY` | 절대 커밋 안 함. 로컬은 `.env.local`, 운영은 Secret |
| 연동 주소 | `LIVEKIT_URL`(워커가 붙을 LiveKit 서버), `VOICE_RESULT_URL` | `VOICE_RESULT_URL`을 비우면 결과를 보내지 않음 (로컬 개발 기본) |
| 동작 선택 | `STT_PROVIDER`, `LLM_MODEL`, `LLM_THINKING`, `TTS_VOICE`… | 비워 두면 기본값 |

### loadConfig 해부

```ts
// src/config.ts
function pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = process.env[name];
  if (!value) return fallback;                                      // 없으면 기본값
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name}=${value}: ${allowed.join(', ')} 중 하나여야 합니다`);  // 틀리면 즉시 실패
}
```

- **빨리 실패하기(fail fast).** `LLM_THINKING=of`처럼 오타를 내면 조용히 기본값으로 가지 않고 `LLM_THINKING=of: off, adaptive 중 하나여야 합니다` 오류를 냅니다. 운영에서 "설정이 안 먹었는데 아무도 몰랐다"는 사고를 막습니다.
  - (2026-11-08 추가) 다만 오류가 나는 때는 워커가 뜰 때가 아니라 **통화가 시작될 때**입니다. `loadConfig()`는 `entry` 안([src/main.ts](../../src/main.ts) 28행)에서 통화마다 불리기 때문입니다. 그래서 오타가 있어도 워커는 정상으로 떠서 LiveKit에 등록되고, 헬스 체크(`GET :8081/`, 15-5절)도 200입니다. 첫 통화가 배정되면 entry 첫 줄에서 예외가 나 그 잡이 `jobCrashed`로 끝납니다(`agents/ipc/job_proc_lazy_main.ts` 210∼222, 로그 `error in entry function`). 세션도 종료 콜백도 만들기 전이라 에이전트는 방에 들어가지 않고 통화 결과도 가지 않습니다.
  - LiveKit Cloud의 롤링 배포는 새 인스턴스의 헬스 체크만 보고 옛 인스턴스를 내리므로(15-5절 표), 설정이 틀린 새 판이 멀쩡한 옛 판을 밀어낼 수 있습니다. `main.ts` 최상위의 `dotenv.config` 바로 뒤에서 `loadConfig()`를 한 번 더 불러 두면, 틀린 설정으로는 워커 프로세스가 뜨자마자 끝나 헬스 체크가 통과하지 못하고 배포가 멈춥니다(제안, 코드는 고치지 않음). 최상위 코드는 잡 프로세스마다 다시 돌지만(4-4절) 이 검사는 환경변수 몇 개를 읽는 정도라 가볍습니다.
- **제네릭 `T extends string`** 덕분에 반환 타입이 `string`이 아니라 `'off' | 'adaptive'` 같은 정확한 유니온이 됩니다. 이후 코드에서 `switch`가 모든 경우를 다뤘는지 컴파일러가 확인할 수 있습니다.
- `DEFAULT_MODELS`를 `as const`로 선언해 공급사별 기본 모델 표를 타입 수준의 상수로 둡니다.
- 주석 "dotenv를 읽은 뒤에 호출합니다"는 8-8절의 import 시점 문제를 피하기 위한 것입니다. 그래서 `config.ts`는 모듈 최상위에서 환경변수를 읽지 않고, 부르는 쪽이 정한 때에 함수로 읽습니다. (2026-11-08 추가) ES 모듈은 `import`한 파일을 모두 먼저 실행한 뒤에 `main.ts` 본문을 실행합니다. 만약 `config.ts` 최상위에서 `process.env`를 읽었다면 `main.ts` 21행의 `dotenv.config`보다 먼저 돌아 `.env.local`의 값을 못 봅니다. 위 제안처럼 `main.ts` 본문에서 `dotenv.config` **뒤에** 부르는 것은 괜찮습니다.

### 팩토리: 부품 생성 한곳에 모으기

(2026-11-08 추가) **팩토리**는 "어떤 클래스의 객체를 만들지"를 정하는 일을 한 함수에 모아 둔 것입니다. `createSTT(config)`는 `config.provider` 값이 `'soniox'`면 Soniox 플러그인을, `'livekit'`이면 LiveKit Inference STT를 만들어 돌려줍니다. LLM(`createLLM`)과 TTS(`createTTS`)도 같은 모양입니다.

```ts
// src/models/index.ts
export function createSTT(config: SttConfig): stt.STT {
  switch (config.provider) {
    case 'soniox':  return new FinalizingSonioxSTT({ … });
    case 'livekit': return new inference.STT({ model: config.model, language: 'ko' });
  }
}
```

- **팩토리 + 전략 패턴**입니다. 호출하는 쪽(`main.ts`)은 `stt.STT`라는 공통 인터페이스만 알고, 어떤 공급사인지는 몰라도 됩니다. 새 공급사(리턴제로 등)를 붙일 때 `case` 하나와 플러그인 연결만 추가하면 됩니다([4-setup-checklist.md 1-4](../4-setup-checklist.md#1-4-부품-교체-구조)).
- (2026-11-06 갱신) `switch`에 `default`가 없습니다. 그런데도 컴파일이 되는 이유는 `provider`의 타입이 `'soniox' | 'livekit'`이고 두 경우를 모두 `return`하기 때문입니다. tsc는 두 `case`가 유니온을 다 덮었으니 `switch` 뒤는 닿을 수 없다고 판단합니다. 나중에 `SttProvider`에 `'rtzr'`을 추가하고 `case`를 빼먹으면 **컴파일 오류**가 납니다. 다만 이 오류를 내는 것은 처음 판에 적은 `noImplicitReturns`가 아닙니다. 함수에 **반환 타입 `stt.STT`를 적었고** `strict`에 든 `strictNullChecks`가 켜져 있어서 나는 **TS2366**("Function lacks ending return statement and return type does not include 'undefined'")입니다. `noImplicitReturns`를 꺼도 똑같이 실패합니다(아래 깊이 보기의 실측). 타입 시스템으로 "빠뜨림"을 막는 기법이라는 점은 같습니다(완전성 검사).
- 공급사마다 다른 함정을 이곳에 모았습니다. Soniox는 API 키를 다시 넘기고 강조 단어를 `context.terms`로, LiveKit Inference의 OpenAI 모델은 `reasoning_effort: 'none'`(도구 사용 조건), ElevenLabs는 voice id가 있을 때만 넘깁니다.

#### 깊이 보기: 완전성 검사는 어느 규칙이 잡나(TS2366, TS7030, `never`) (2026-11-06 추가)

[lab/15-tsc-checks.mjs](lab/15-tsc-checks.mjs) 1번은 `createSTT`와 같은 모양에 `'rtzr'`을 더하고 `case`를 빼먹은 함수 넷을 임시 폴더에 만들어, 이 레포의 tsc 5.9.3으로 옵션을 바꿔 가며 검사합니다(실측).

```ts
export function createSTT(p: SttProvider): STT { switch (p) { … } }        // 3행: 반환 타입을 적음 (이 레포와 같음)
export function inferred(p: SttProvider) { switch (p) { … } }               // 9행: 반환 타입을 추론에 맡김
export function withNever(p: SttProvider): STT {                           // 15행
  switch (p) {
    …
    default: { const unhandled: never = p; throw new Error(…); }           // 20행
  }
}
export function logOnly(p: SttProvider): void { switch (p) { … break; } }  // 25행: 값을 돌려주지 않는 switch
```

```text
noImplicitReturns=true, strictNullChecks=true  ← 이 레포 설정
   factory.ts(3,44): error TS2366: Function lacks ending return statement and return type does not include 'undefined'.
   factory.ts(9,17): error TS7030: Not all code paths return a value.
   factory.ts(20,13): error TS2322: Type '"rtzr"' is not assignable to type 'never'.
noImplicitReturns=false, strictNullChecks=true
   factory.ts(3,44): error TS2366: …
   factory.ts(20,13): error TS2322: …
noImplicitReturns=true, strictNullChecks=false
   factory.ts(3,44): error TS7030: …
   factory.ts(9,17): error TS7030: …
   factory.ts(20,13): error TS2322: …
noImplicitReturns=false, strictNullChecks=false
   factory.ts(20,13): error TS2322: Type '"rtzr"' is not assignable to type 'never'.
```

- **반환 타입을 적은 함수(3행)는 `strictNullChecks`가 잡습니다.** `switch` 뒤로 빠져나가면 암묵적으로 `undefined`를 돌려주는데, 적은 반환 타입 `STT`에 `undefined`가 없으니 TS2366입니다. `noImplicitReturns`는 이 경우 따로 할 일이 없습니다. `strictNullChecks`까지 꺼야 비로소 `noImplicitReturns`의 TS7030이 대신 뜹니다.
- **반환 타입을 추론에 맡긴 함수(9행)는 `noImplicitReturns`만 잡습니다.** 추론된 타입이 `{ name: string } | undefined`가 되어 타입 오류는 없고, "경로 중 하나가 값을 안 돌려준다"는 규칙(TS7030)만 걸립니다. 이 옵션을 끄면 오류 없이 지나가고, 문제는 이 함수를 `STT`가 필요한 곳에 넘길 때 **다른 파일에서** 드러납니다.
- **값을 돌려주지 않는 `switch`(25행)는 어떤 설정에서도 오류가 없습니다.** 로그만 남기거나 상태만 바꾸는 `switch`는 빠뜨려도 컴파일러가 모릅니다.
- **`never` 관용구(20행)는 네 설정 모두에서 잡습니다.** `case`를 다 지나 `default`에 온 `p`의 타입은 "아직 안 다룬 것"(`'rtzr'`)으로 좁혀져 있습니다. 다 다뤘다면 `never`라 대입이 되고, 빠뜨렸다면 대입이 실패합니다. 오류가 **`switch` 안에, 빠뜨린 값의 이름(`"rtzr"`)과 함께** 뜨므로 3행의 TS2366(함수 머리에서 "끝에 return이 없다")보다 읽기 쉽습니다. `throw`는 런타임 방어입니다. 설정 값이 `as` 같은 강제 변환으로 들어와 유니온 밖의 문자열이 되더라도 `undefined`를 돌려주지 않고 그 자리에서 실패합니다.

정리하면, 이 레포의 팩토리는 반환 타입을 적었으므로 `strict`만 켜져 있어도 안전합니다. 그래도 `void` `switch`까지 같은 방식으로 지키려면 `default`에 `never` 관용구를 두는 편이 낫습니다(제안, `src/`는 고치지 않았습니다). 이 장의 15-2절 표도 같은 내용으로 고쳤습니다.

### `...(조건 ? { x } : {})` 패턴이 많은 이유

```ts
...(config.voice ? { voiceId: config.voice } : {}),
...(apiKey ? { apiKey } : {}),
```

tsconfig의 **`exactOptionalPropertyTypes`** 때문입니다. 이 옵션이 켜져 있으면 `voiceId?: string`인 자리에 `voiceId: undefined`를 **명시적으로** 넣는 것이 타입 오류입니다. "속성이 없음"과 "속성이 있는데 값이 undefined"를 구분하기 때문입니다. 라이브러리 중에는 `'voiceId' in opts`로 검사하거나 `{ ...defaults, ...opts }`로 합치는 곳이 있어서, `undefined`를 넣으면 기본값을 덮어써 버리는 버그가 생깁니다. 조건부 스프레드는 **값이 있을 때만 속성 자체를 만드는** 관용구입니다.

---

## 15-2. TypeScript를 빌드 없이 실행하기 (Node 24)

이 프로젝트에는 `dist/` 빌드 단계가 없습니다. `node src/main.ts`로 TypeScript 파일을 **바로** 실행합니다.

(2026-11-08 추가) 여기서 **빌드**는 실행하기 전에 소스를 다른 모양으로 바꿔 두는 단계입니다. 보통의 TypeScript 프로젝트는 tsc(TypeScript 컴파일러)나 esbuild로 `.ts`를 `.js`로 바꿔 `dist/` 폴더에 내보낸 뒤, 그 `.js`를 실행합니다. 이 레포는 그 단계를 없앴습니다. Node 24가 `.ts`를 읽으면서 타입 표기만 지우고 실행하고, tsc는 오류를 찾는 검사기로만 씁니다(`pnpm typecheck` = `tsc --noEmit`). tsc가 무엇을 검사하고 무엇을 허용할지는 [tsconfig.json](../../tsconfig.json)이 정하며, 이 절의 표 두 개가 그 옵션들입니다. 빌드가 없으니 Dockerfile에도 컴파일 단계가 없고(15-4절), 운영 이미지에서 tsc를 실행할 일도 없습니다.

### 타입 지우기 (type stripping)

Node 24는 `.ts` 파일을 읽을 때 **타입 표기만 지우고** JavaScript로 실행합니다. 예를 들어 `(name: string)`은 `(name        )`처럼 `: string` 자리가 같은 길이의 공백으로 바뀝니다(아래 깊이 보기). 변환(transpile)이 아니라 지우기라서 빠르고 단순하지만, 지우기만으로는 처리할 수 없는 문법은 쓸 수 없습니다. 그래서 tsconfig에 짝이 되는 옵션들이 있습니다.

| 옵션 | 이유 |
| --- | --- |
| `noEmit: true` | tsc는 **타입 검사만** 함 (`pnpm typecheck`). 실행은 Node가 직접 |
| `allowImportingTsExtensions` | Node는 확장자 없는 import(`./agent`)를 못 찾음 → `./agent.ts`처럼 확장자를 쓰고, tsc가 그것을 허용하게 함 |
| `erasableSyntaxOnly` | `enum`, `namespace`, 생성자 매개변수 속성처럼 **지우기만으로 안 되는 문법 금지**. Node에서 실행하면 문법 오류가 나므로 미리 막음 |
| `verbatimModuleSyntax` | import를 쓴 그대로 남김. 타입만 가져올 때는 반드시 `import type`을 쓰게 강제함. Node는 `import type`만 지우므로, 타입을 일반 import로 가져오면 런타임에 "export가 없다" 오류가 남 |
| `isolatedModules` | 파일 하나만 보고 처리할 수 있는 코드만 허용 (지우기 방식의 전제) |

그래서 코드 곳곳에 `import type { CallContext } from './call-context.ts'`, `import { Agent, type llm } from '@livekit/agents'` 같은 표기가 있습니다. 타입과 값을 import 단계에서 구분하는 것입니다.

(2026-11-06 추가) 이 표는 **허용과 금지**일 뿐, 실수를 다 잡아 주는 안전망은 아닙니다. `allowImportingTsExtensions`는 `./agent.ts`라고 쓰는 것을 **허용**할 뿐이고, 확장자를 빼먹은 `./agent`를 **막지는 않습니다.** 이 레포의 `moduleResolution: "bundler"`에서는 tsc가 `./agent`도 통과시키고, Node는 실행할 때 `ERR_MODULE_NOT_FOUND`로 멈춥니다(아래 깊이 보기에서 재현). 지금 `src/`·`scripts/`에는 확장자 없는 상대 import가 없습니다(검색으로 확인). 타입을 일반 import로 가져오는 실수는 `verbatimModuleSyntax`가 tsc 단계에서 잡습니다.

#### 깊이 보기: 타입 지우기의 안쪽(공백으로 덮기) (2026-11-06 추가)

Node 24.22는 Amaro 1.1.11(SWC 기반 라이브러리, `process.versions.amaro`)로 `.ts`를 읽습니다. Node 문서(Modules: TypeScript)가 적은 동작과 [lab/15-type-stripping.mjs](lab/15-type-stripping.mjs)로 확인한 것입니다.

**타입 자리를 공백으로 바꿉니다.** `node:module`의 `stripTypeScriptTypes()`(실험 기능)로 Node가 실제로 만드는 JS를 볼 수 있습니다. `|` 사이가 한 줄입니다(실측).

```text
원본  import type { CallContext } from './call-context.ts';
      interface SttConfig { provider: 'soniox' | 'livekit' }
      function pick<T extends string>(name: string, fallback: T): T {
        const v = process.env[name] as T | undefined; if (!v) throw new Error('no ' + name);

지움  |                                                     |
      |                                                      |
      |function pick                  (name        , fallback   )    {|
      |  const v = process.env[name]                 ; if (!v) throw new Error('no ' + name);|

글자 수: 원본 324, 지운 뒤 324 (줄 수 8 → 8)
```

- `import type` 줄과 `interface`는 줄 전체가 공백이 되고, `<T extends string>`, `: string`, `as T | undefined`도 같은 길이의 공백이 됩니다. 줄 수와 글자 위치가 원본과 같습니다.
- 그래서 **소스맵 없이도 스택 추적이 맞습니다.** 위 파일을 실행하면 오류가 `pos.ts:4:63`에서 나고, 원본 4행에서 `new Error`가 시작하는 열도 63입니다(실측). 트랜스파일(tsc, esbuild)은 코드를 다시 쓰므로 소스맵이 있어야 원본 위치를 찾습니다. Node 문서도 "인라인 타입을 공백으로 바꾸므로 소스맵이 필요 없고 만들지도 않는다"고 적습니다.
- **한글이 든 타입은 EN SPACE(U+2002)로 덮습니다.** `'고객님' as '고객님' | '사장님'`에서 `as` 뒤를 지운 자리는 `U+0020×5 U+2002×3 U+0020×5 U+2002×3 U+0020×1`이었습니다(실측). 한글 한 글자는 UTF-16으로 1칸, UTF-8로 3바이트이고, U+2002도 1칸·3바이트입니다. 그래서 UTF-16 길이(60 → 60)도 UTF-8 바이트 수(78 → 78)도 그대로입니다. 열 번호(JS는 UTF-16 칸으로 셈)와 바이트 위치를 함께 지키려는 선택으로 보입니다(해석). 이 레포는 타입에 한글을 거의 쓰지 않지만, 한국어 프로젝트라 알아 둘 만합니다.

**지우기만으로 안 되는 문법은 시작할 때 실패합니다(실측).**

```text
node enum.ts:     SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript enum is not supported in strip-only mode
node ns.ts:       … TypeScript namespace declaration is not supported in strip-only mode
node param.ts:    … TypeScript parameter property is not supported in strip-only mode
node const-object.ts: 실행됨   ← enum 대신 as const 객체 + 타입
node --experimental-transform-types enum.ts: 실행됨
```

- `enum Mode { Off, Adaptive }`는 JS에 없는 객체(`Mode[0] = 'Off'`…)를 **새로 만들어야** 합니다. 지우기로는 만들 수 없으니 거절합니다. `erasableSyntaxOnly`가 tsc 단계에서 같은 것을 막습니다(15-2절 표). 대안은 `as const` 객체와 그 값들의 유니온 타입이고, `DEFAULT_MODELS`(15-1절)가 이 모양입니다.
- `--experimental-transform-types`를 주면 Node가 변환까지 해서 `enum`도 돕니다. Node 문서의 변경 기록상 이 플래그는 v26에서 없어졌으므로 기대지 않는 것이 맞습니다.

**그 밖의 규칙(실측).**

| 시도 | 결과 | 이유 (Node 문서) |
| --- | --- | --- |
| `node_modules/dep/index.ts`를 import | `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` | TS로 된 패키지 배포를 막으려고 `node_modules` 아래 `.ts`는 처리하지 않음. 그래서 SDK는 `dist/*.js`로 실행됨 (4장 머리말) |
| 타입을 `import { CallContext }`로 | `SyntaxError: … does not provide an export named 'CallContext'` | Node는 `type`이 붙은 것만 지움. 타입은 JS에 없으니 값 import가 실패 |
| 같은 것을 `import type`으로 | 실행됨 | |
| 확장자 없는 `'./call-context'` | `ERR_MODULE_NOT_FOUND` | ESM은 확장자를 추측하지 않음 |
| tsconfig `paths`의 `'@/…'` 별칭 | `ERR_MODULE_NOT_FOUND` | Node는 **tsconfig.json을 읽지 않음**. `paths`, `target` 같은 설정은 tsc에만 의미가 있음 |

- 같은 `.ts`라도 ESM인지 CommonJS인지는 `.js`처럼 가장 가까운 `package.json`의 `"type"`으로 정합니다(Node 문서). 이 레포는 `"type": "module"`이라 `.ts`가 모두 ESM입니다. `.mts`는 늘 ESM, `.cts`는 늘 CommonJS, `.tsx`는 지원하지 않습니다.
- Node 24.3부터 실험 기능 경고가 사라졌고, 24.12에서 안정(Stability 2)으로 바뀌었습니다(Node 문서 변경 기록). `process.features.typescript`는 이 맥에서 `'strip'`입니다.

#### 깊이 보기: 확장자 없는 import(bundler와 nodenext) (2026-11-06 추가)

**왜 tsc는 통과시키나.** `moduleResolution`은 "import 문자열을 파일로 바꾸는 규칙을 누구에게 맞출지"입니다. `bundler`는 Vite·esbuild 같은 번들러를 흉내 내서 `./b`에 `.ts`·`.js`를 붙여 보며 찾습니다. Node의 ESM은 그렇게 추측하지 않습니다. 검사하는 쪽과 실행하는 쪽의 규칙이 다르니 틈이 생깁니다. [lab/15-tsc-checks.mjs](lab/15-tsc-checks.mjs) 2번이 `a.ts`(`'./b'`)와 `c.ts`(`'./b.ts'`)로 확인합니다(실측).

```text
tsc: module es2022 + moduleResolution bundler + allowImportingTsExtensions  ← 이 레포 설정
   (오류 없음)
tsc: bundler + rewriteRelativeImportExtensions
   (오류 없음)
tsc: module nodenext + allowImportingTsExtensions
   a.ts(1,19): error TS2835: Relative import paths need explicit file extensions in ECMAScript imports
               when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean './b.js'?
tsc: module nodenext + rewriteRelativeImportExtensions  ← Node 문서의 권장 조합
   a.ts(1,19): error TS2835: …
node a.ts: 실패 ERR_MODULE_NOT_FOUND
node c.ts: 실행됨 (출력 1)
```

- **잡는 것은 `nodenext`입니다.** Node의 해석 규칙을 그대로 흉내 내므로 확장자 없는 상대 경로를 TS2835로 막습니다. 오류 문구가 `./b.js`를 권하는 것은 tsc가 JS를 내보내는 경우를 기준으로 말하기 때문이고, 이 레포처럼 `.ts`를 바로 실행할 때는 `./b.ts`로 고치면 됩니다(`c.ts`는 통과).
- **`rewriteRelativeImportExtensions`만으로는 잡지 못합니다.** 이 옵션(TS 5.7)은 JS를 내보낼 때 `./b.ts`를 `./b.js`로 바꿔 적어 주고, 그래서 `.ts` 확장자 import를 허용하는 옵션입니다. `bundler`와 함께 쓰면 확장자 없는 `./b`는 여전히 통과합니다. 처음 검토에서 대안으로 함께 적힌 것과 달리, 역할은 `allowImportingTsExtensions`와 같은 "허용" 쪽입니다.
- **이 레포를 `nodenext`로 바꾸면 오류는 0개입니다.** 같은 실습 3번이 레포의 `tsconfig.json`을 `extends`하고 `module`·`moduleResolution`만 `nodenext`로 바꾼 임시 설정으로 `src/`·`scripts/` 전체를 검사했습니다(실측). Node 문서가 타입 지우기에 권하는 설정도 `"module": "nodenext"`, `rewriteRelativeImportExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`입니다. 바꾸는 비용이 작으니 `tsconfig.json`을 `nodenext`로 옮기는 것을 제안합니다(이 장에서는 고치지 않음).

### 엄격 옵션들

(2026-11-08 추가) 아래 옵션들은 tsc가 더 많은 실수를 오류로 보게 하는 스위치입니다. 실행에는 영향이 없고(Node는 tsconfig를 읽지 않음, 위 깊이 보기), `pnpm typecheck`에서만 효과가 있습니다. 표의 셋째 칸은 그 옵션 때문에 이 레포 코드에 생긴 표기입니다.

| 옵션 | 효과 | 코드에 보이는 흔적 |
| --- | --- | --- |
| `strict` | null 검사 등 엄격 모드 묶음 | (2026-11-06 갱신) 반환 타입을 적은 팩토리의 완전성 검사(TS2366, 15-1절) |
| `noUncheckedIndexedAccess` | 배열·객체 인덱스 결과를 `T \| undefined`로 | `ACKS[…]!` (11-5절) |
| `exactOptionalPropertyTypes` | 선택 속성에 `undefined` 명시 금지 | 조건부 스프레드 (15-1절) |
| `noImplicitOverride` | 부모 메서드 재정의에 `override` 필수 | `override chat`, `override stream` |
| `noImplicitReturns` | 모든 경로에서 반환 | (2026-11-06 갱신) 반환 타입을 **적지 않은** 함수에서만 따로 잡음(TS7030). 이 레포 팩토리는 `strict`가 먼저 잡음 |
| `noFallthroughCasesInSwitch` | 내용이 있는 `case`가 `break`·`return` 없이 다음 `case`로 이어 실행되는 것(흘러내림)을 오류로 봄 | 지금은 걸릴 곳 없음. `src/models/index.ts`의 `switch` 셋은 모든 `case`가 `return`으로 끝남 |

테스트 파일(`*.test.ts`)은 tsconfig의 `exclude`에 있어 `pnpm typecheck` 대상이 아니고, vitest가 따로 실행합니다.

---

## 15-3. 패키지 관리: pnpm

(2026-11-08 추가) **패키지 관리자**는 `package.json`에 적힌 의존성(남이 만든 패키지)을 레지스트리(npm 저장소)에서 받아 `node_modules/`에 까는 도구입니다. 이 레포는 pnpm을 씁니다. `package.json`에는 `"@livekit/agents": "^1.9.3"`처럼 판의 범위만 적으므로(`^`는 "1.x 중 이 판 이상"), 같은 명령이라도 언제 설치하느냐에 따라 다른 판이 깔릴 수 있습니다. 그래서 실제로 고른 판과 파일 해시를 모두 **lockfile**([pnpm-lock.yaml](../../pnpm-lock.yaml))에 적어 커밋하고, 설치할 때 그대로 따르게 합니다. 이 프로젝트에서 이것이 중요한 이유는 둘입니다. Docker 이미지가 개발 맥과 같은 판으로 설치돼야 하고(15-4절), Soniox 플러그인에 덧댄 패치(6-5절)가 정확히 1.9.5에 맞춰 만든 것이라 판이 바뀌면 들어맞지 않기 때문입니다.

### 버전 고정

| 설정 | 위치 | 효과 |
| --- | --- | --- |
| `"packageManager": "pnpm@12.16.1"` | package.json | corepack이 정확히 이 버전을 씀. (2026-11-06 갱신) 이 맥의 `pnpm`은 Node 24에 딸린 corepack 0.36.0의 대리 실행 파일(`…/corepack/dist/pnpm.js`)이라 이 값을 따름. **Docker는 corepack을 쓰지 않고** `npm install -g pnpm@12.16.1`로 따로 고정하므로, 판을 올릴 때 두 곳을 함께 바꿔야 함 |
| `"engines": { "node": ">=24" }` + `engine-strict=true` | package.json, .npmrc | Node 22로 설치하면 **경고가 아니라 오류** ([4-setup-checklist.md 2장](../4-setup-checklist.md#2-로컬-개발-환경)) |
| `pnpm-lock.yaml` | 커밋함 | 모든 의존성의 정확한 버전·해시. `--frozen-lockfile`로 이와 다르면 실패. (2026-11-06 추가) 해시가 무엇을 지키는지는 아래 깊이 보기 |

### pnpm-workspace.yaml의 세 가지 설정

(2026-11-08 추가) [pnpm-workspace.yaml](../../pnpm-workspace.yaml)은 pnpm 전용 설정을 담는 파일입니다. 이름은 한 저장소에 패키지 여러 개를 두는 작업 공간(workspace)에서 왔지만, 이 레포처럼 패키지가 하나뿐이어도 설치 규칙을 여기에 적습니다. npm은 이 파일을 모르므로, 이 레포를 `npm install`로 설치하면 아래 세 설정이 모두 빠집니다.

```yaml
allowBuilds:                       # ① 설치 스크립트 허용 목록
  '@livekit/blingfire': false
  '@livekit/local-inference': true
  protobufjs: true
  sharp: true

overrides:                         # ② 의존성 버전 강제
  '@opentelemetry/api': ~1.9.0

patchedDependencies:               # ③ 외부 패키지 패치
  '@livekit/agents-plugin-soniox@1.9.5': patches/@livekit__agents-plugin-soniox@1.9.5.patch
```

1. **allowBuilds**: npm 패키지는 설치할 때 임의의 스크립트를 실행할 수 있어 **공급망 공격**의 통로가 됩니다. pnpm은 최근 버전부터 허용하지 않은 설치 스크립트를 막습니다. 어떤 패키지의 스크립트를 실행할지 명시적으로 적는 목록입니다. 조사해 보면 `@livekit/blingfire`와 `@livekit/local-inference`의 설치 스크립트는 둘 다 아무 일도 하지 않는 `node -e ""`라서, 실질적인 효과는 경고·오류를 없애는 것입니다.
2. **overrides**: 의존성 트리 깊은 곳의 버전을 강제합니다. `@livekit/agents`는 `@opentelemetry/api` 1.10을 받아들이지만 OpenTelemetry SDK 2.x는 1.10 미만을 요구해서, 피어 의존성 경고가 났습니다. 1.9로 고정해 해결했습니다.
3. **patchedDependencies**: 6-5절의 Soniox 패치입니다. `pnpm install` 때 패치 파일을 플러그인의 `dist/` 파일에 적용하고, lockfile에 패치 해시를 기록합니다.

#### 깊이 보기: lockfile 한 장 읽기(integrity, 패치 해시, 피어 의존성) (2026-11-06 추가)

[pnpm-lock.yaml](../../pnpm-lock.yaml)은 `---`로 나뉜 YAML 문서 **두 개**입니다(파일을 읽어 확인).

```text
1번 문서  importers.packageManagerDependencies: pnpm 12.16.1
          packages: '@pnpm/exe.darwin-arm64@12.16.1' 등 플랫폼별 pnpm 실행 파일 → integrity 15개
2번 문서  settings: autoInstallPeers: true …
          overrides: '@opentelemetry/api': ~1.9.0
          patchedDependencies: '@livekit/agents-plugin-soniox@1.9.5': b4840a46…ee7c
          importers: 이 레포가 직접 쓰는 의존성과 실제로 고른 판
          packages / snapshots: 모든 패키지 → integrity 493개
```

첫 문서는 pnpm 자신의 판과 플랫폼별 실행 파일의 해시입니다. pnpm이 `packageManager`의 판을 스스로 받아 쓸 때 쓰는 기록으로 보입니다(구조로 본 해석).

**integrity.** 패키지마다 `resolution: {integrity: sha512-…}`가 있습니다. 레지스트리에서 받은 압축 파일(.tgz)의 SHA-512 다이제스트를 base64로 적은 것이고, 브라우저의 Subresource Integrity(SRI)와 같은 "알고리즘-값" 표기입니다. 이 lockfile의 508개는 모두 `sha512`였고, base64를 풀면 모두 64바이트(= 512비트)였습니다(실측, 한 줄짜리 스크립트로 셈).

- 지키는 것: 같은 판 번호인데 내용이 바뀐 경우(레지스트리·중간 프록시·캐시가 바뀐 파일을 준 경우)입니다. 해시가 다르면 설치가 멈춥니다.
- 못 지키는 것: 공격자가 **정상 절차로 새 판을 올리고** 누군가 lockfile을 그 판으로 갱신한 경우입니다. 해시는 "lockfile을 만든 그때와 같은 파일"만 보장합니다. 그래서 `--frozen-lockfile`(lockfile을 고치지 않음)과 `allowBuilds`(설치 스크립트 제한)가 짝으로 필요합니다.

**패치 해시.** `patchedDependencies`의 `b4840a46…`은 패치 파일 내용의 SHA-256입니다. `shasum -a 256 patches/@livekit__agents-plugin-soniox@1.9.5.patch`의 결과와 정확히 같았습니다(실측). 패치 파일 끝에 빈 줄 하나만 더해도 `--frozen-lockfile`이 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`("The current "patchedDependencies" configuration doesn't match the value found in the lockfile")로 멈췄습니다(실측, 레포 밖 사본에서). 그래서 패치를 고친 사람은 반드시 lockfile도 함께 커밋하게 됩니다. 이 해시는 `node_modules/.pnpm/` 폴더 이름(`…soniox@1.9.5_patch_hash=b4840a46…`)에도 들어가, 패치가 다르면 다른 폴더에 설치됩니다.

**피어 의존성의 흔적.** `importers`에서 `@livekit/agents`의 판은 `1.9.5(@livekit/rtc-node@1.2.1)(…)(typescript@5.9.3)(zod@4.6.7)`처럼 괄호가 붙어 있습니다. 괄호는 그 패키지의 피어 의존성이 **무엇으로 채워졌는지**입니다. 같은 `@livekit/agents@1.9.5`라도 피어가 다르게 채워지면 pnpm은 다른 사본으로 설치합니다. 플러그인(`agents-plugin-anthropic` 등)의 판에도 같은 `@livekit/agents@1.9.5(…)`가 붙어 있어, 플러그인과 본체가 **같은 사본**을 쓴다는 것을 lockfile에서 읽을 수 있습니다. 사본이 둘이면 같은 이름의 클래스가 둘이 되어 `instanceof`가 어긋납니다. 8-7절에서 Bedrock 클라이언트(SDK 1.x)의 오류가 플러그인이 가진 SDK 0.33의 `APIError`로 인정되지 않던 것이 바로 그 모양입니다(그쪽은 판이 달라 피어로 묶을 수 없는 경우). 피어 의존성은 이런 갈라짐을 막는 장치입니다.

**피어가 이미지에 남기는 것.** `autoInstallPeers: true`이면 pnpm이 피어 의존성을 알아서 설치합니다. 그래서 운영 의존성만 설치해도 `typescript`(23MB)가 남습니다. 레포 밖 임시 폴더에 설정 파일만 복사해 `pnpm install --frozen-lockfile --prod --offline`을 돌리고 `pnpm why typescript --prod`로 보니, `@livekit/agents` → `@livekit/throws-transformer@0.1.8`(피어 `typescript: '>=4.7.0'`) 경로였습니다(실측). `pnpm prune --prod` 뒤 이미지에서도 같을 것으로 봅니다(추정, 이미지는 못 빌드함). `tsc` 실행 파일이 루트 `node_modules/.bin`에 걸리지 않을 뿐 패키지는 들어갑니다. 같은 실측에서 운영 의존성만의 `node_modules`는 이 맥 기준 **389MB**였습니다(`du -sh`, 맥용 네이티브 바이너리 기준이라 리눅스 이미지와는 다름). 큰 것은 ai-coustics 네이티브(75MB), `@livekit/agents`(38MB), local-inference 네이티브(33MB), `@anthropic-ai/sdk` 1.4(24MB)였습니다. 15-4절 레이어 크기의 감을 잡는 숫자입니다.

### 패키지 패치라는 기법

다른 사람의 패키지를 고치는 방법은 여러 가지입니다.

| 방법 | 장점 | 단점 |
| --- | --- | --- |
| 업스트림에 PR | 모두가 혜택, 유지 보수 부담 없음 | 반영까지 시간이 걸림 |
| 포크해서 배포 | 자유로움 | 포크를 계속 따라잡아야 함 |
| 상속·감싸기 (`FinalizingSonioxSTT`) | 원본을 안 건드림 | 원본이 막아 둔 부분은 못 고침 |
| **패치 파일** (`pnpm patch`) | 고친 줄만 관리, lockfile로 재현 | **버전 고정**, 업그레이드 때 다시 맞춰야 함 |

이 프로젝트는 감싸기로 할 수 있는 부분(스트림 기억, `finalize()` 메서드)은 감싸고, 감싸기로 못 하는 부분(플러그인 내부 루프에서 flush 표식 처리)만 패치했습니다. **변경을 가장 작게** 하는 선택입니다. 그리고 [4-setup-checklist.md 9장](../4-setup-checklist.md#9-알아-둘-점)에 "버전을 올리면 다시 확인"이라고 남겨 두었습니다. 장기적으로는 같은 수정을 LiveKit에 제안(PR·피드백)하는 것이 좋습니다. [AGENTS.md](../../AGENTS.md)도 LiveKit 문제를 발견하면 `lk docs submit-feedback`으로 알리라고 권합니다.

---

## 15-4. Docker 이미지

(2026-11-08 추가) **Docker 이미지**는 프로그램을 실행하는 데 필요한 파일 전부(리눅스 배포판의 최소 파일, node 실행 파일, `node_modules`, 소스)와 실행 명령(`CMD`)을 한데 묶은 읽기 전용 꾸러미입니다. 이 이미지를 띄운 것이 **컨테이너**입니다. 컨테이너 안의 프로세스는 리눅스의 격리 기능(네임스페이스, cgroup) 덕분에 자기만의 파일시스템과 PID 번호를 보고, 정해진 CPU·메모리 한도 안에서만 돕니다. 이미지를 만드는 순서를 적은 파일이 **Dockerfile**이고, `docker build`가 이 파일을 한 줄씩 실행해 이미지를 만듭니다.

이 프로젝트에 이미지가 필요한 이유는 두 배포 경로가 모두 이미지를 돌리기 때문입니다. LiveKit Cloud는 이 Dockerfile로 이미지를 원격 빌드하고, GKE는 우리가 빌드해 올린 이미지를 파드로 띄웁니다(15-5절). 맥에서는 `node src/main.ts start`가 작업 폴더의 파일을 그대로 쓰지만, 이미지는 빌드한 순간의 파일만 들고 갑니다. 그래서 무엇이 들어가고 무엇이 빠지는지(아래 `.dockerignore`)와, 컨테이너가 끝날 때 신호가 어떻게 전달되는지(아래 PID 1)가 중요해집니다.

[Dockerfile](../../Dockerfile)은 **다단계 빌드**(multi-stage build)입니다. 한 Dockerfile에 `FROM`을 여러 번 써서 단계를 나누고, 앞 단계에서 만든 결과 중 필요한 것만 다음 단계로 복사하는 방법입니다.

```text
base   node:24-slim + ca-certificates + pnpm 12.16.1
  │
build  ① package.json, pnpm-lock.yaml, pnpm-workspace.yaml, .npmrc, patches/ 복사 → pnpm install --frozen-lockfile
  │    ② npx livekit-agents download-files
  │    ③ COPY . .  (나머지 소스)
  │    ④ pnpm prune --prod  (개발 의존성 제거)
  ▼
최종   base + 비루트 사용자(UID 10001) + build 결과 복사 → CMD ["node", "src/main.ts", "start"]
```

(2026-11-08 추가) 그림 읽는 법입니다. 왼쪽 이름(base·build·최종)이 단계이고, `│`·`▼`는 위 단계 위에 이어 쌓는다는 뜻입니다. build와 최종은 둘 다 base에서 출발합니다(Dockerfile 24·55행의 `FROM base`). build 단계에서 설치한 개발 도구(tsc·vitest·eslint)는 ④에서 지운 뒤 `/app` 폴더만 최종 단계로 복사하므로, 최종 이미지에는 들어가지 않습니다. "지운 뒤 복사"여야 하는 이유는 아래 깊이 보기 "레이어와 캐시"에 있습니다.

### 각 결정의 이유

| 결정 | 이유 |
| --- | --- |
| `-slim` 이미지 | 크기 감소. 대신 필요한 것을 직접 설치 |
| `ca-certificates` 설치 | LiveKit의 Rust 네이티브 코어가 **시스템 인증서 저장소**를 읽음. slim 이미지에는 없어 방 연결(TLS)이 실패함. Node 자체는 내장 인증서를 쓰므로 Node만 보면 놓치기 쉬운 함정 |
| 의존성 파일 먼저 복사 → 설치 → 그다음 소스 복사 | **레이어 캐시.** 소스만 바뀌면 설치 단계를 건너뜀. (2026-11-06 추가) 다만 최종 단계의 `COPY --from=build /app /app`은 다시 만들어짐(아래 깊이 보기) |
| `download-files`를 소스 복사 전에 | 모델 다운로드도 캐시되게. 이 프로젝트에서는 실제로 받는 파일이 없음(아래 "download-files는 지금 무엇을 받나") |
| `prune --prod` | 실행에 tsc·vitest·eslint가 필요 없음 (Node가 TS를 직접 실행) |
| 비루트 사용자 | 공격자가 코드의 허점으로 컨테이너 안에서 명령을 실행하게 되더라도 root가 아니라 UID 10001(`appuser`)의 권한만 얻음. 시스템 파일을 바꾸거나 패키지를 깔 수 없음. LiveKit 문서도 root로 돌리지 말라고 요구함 |
| `COPY --chown` | 따로 `chown -R`을 돌리면 node_modules 전체를 복사한 레이어가 하나 더 생김. (2026-11-06 추가) 이 레포 Dockerfile에는 따로 도는 `chown`이 없음(파일로 확인). 왜 "복사한 레이어"가 되는지는 아래 깊이 보기 |
| **exec 형식 `CMD [...]`** | exec 형식은 명령을 JSON 배열로 적어 셸 없이 그 프로그램을 바로 실행하는 형식임. node가 PID 1(컨테이너의 첫 프로세스)이 되어 SIGTERM을 직접 받음 → drain 동작 (4-7절). (2026-11-06 갱신) 이 레포의 `CMD [ "node", "src/main.ts", "start" ]`는 exec 형식임(파일로 확인). 셸 형식 `CMD node src/main.ts start`는 `/bin/sh -c "…"`로 바뀌어 셸이 먼저 PID 1이 됨. 셸이 명령 하나를 자기 자리에 exec하면 node가 PID 1을 물려받지만, 명령이 둘 이상이면 셸이 남아 신호가 node에 안 감. 이미지의 셸이 어느 쪽인지는 **확인 필요**(아래 깊이 보기) |
| `.dockerignore`에 `.env`·`.env.*`·`**/.env*`·`.history/` | 비밀값 파일이 빌드 컨텍스트에, 그래서 이미지에 들어가지 않음([.dockerignore](../../.dockerignore) 26∼31행). 이미지 안의 `dotenv`는 읽을 파일이 없어 아무것도 넣지 않으므로, 운영 비밀값은 진짜 환경변수로 넣어야 함. (2026-11-06 갱신) 처음에는 `.env`·`.env.*`뿐이라 **루트의** 이름만 막았고, 편집기 로컬 기록 폴더 `.history/`에 쌓인 `.env` 사본은 그대로 들어갔음. `**/.env*`(어느 폴더에 있든 `.env`로 시작하는 이름)와 `.history/`를 더해 고침(17-2 #46, 커밋 `4bc8d72`, 아래 깊이 보기) |

### download-files는 지금 무엇을 받나

`npx livekit-agents download-files`는 설치된 `@livekit/agents-plugin-*` 패키지를 찾아 각 플러그인의 모델 파일을 미리 받습니다. 그런데 이 프로젝트에서는 **받는 파일이 없습니다.**

- Anthropic·ElevenLabs·Soniox 플러그인은 클라우드 API라 받을 모델이 없습니다.
- ai-coustics 패키지는 이름이 `agents-plugin-`으로 시작하지 않아 아예 탐색되지 않습니다.
- Silero VAD와 턴 감지 mini 모델은 `@livekit/local-inference` 네이티브 바이너리 안에 내장되어 `pnpm install` 때 이미 들어옵니다.

나중에 모델을 받는 플러그인을 추가했을 때를 위한 안전망으로 두는 것은 괜찮습니다.

(2026-11-08 추가) 명령의 모양도 볼 만합니다. 예전에는 워커 파일에 하위 명령을 붙여 `node src/main.ts download-files`로 불렀습니다. 이 길은 SDK 1.4.4부터 사용 중단이라, 지금 부르면 "deprecated as of 1.4.4" 경고를 찍고 `npx livekit-agents download-files`를 쓰라고 안내합니다(`agents/cli.ts` 273∼286). Dockerfile 44행이 쓰는 `npx livekit-agents`는 `@livekit/agents` 패키지에 든 독립 CLI(`agents/bin/livekit-agents.ts`)입니다. 설치된 `@livekit/agents-plugin-*` 패키지를 찾아 각자의 `downloadFiles()`만 부르고, **에이전트 코드(`main.ts`)는 불러오지 않습니다.** 그래서 소스를 복사하기 전(`COPY . .`보다 위)에 둘 수 있고, 소스만 바뀐 빌드에서는 이 줄이 캐시로 건너뛰어집니다.

### 사례: 설치 단계에 워크스페이스 설정이 없던 문제 (고침)

스타터에서 가져온 처음 Dockerfile은 ①에서 `package.json`과 `pnpm-lock.yaml`만 복사하고 설치했습니다. 그런데 이 프로젝트의 lockfile에는 `pnpm-workspace.yaml`의 `overrides`와 `patchedDependencies` 정보가 기록되어 있습니다. 설치 시점에 그 설정 파일이 없으면 lockfile과 설정이 어긋납니다. 프로젝트에서 overrides와 패치를 추가하면서 lockfile에 그 정보가 기록됐는데, Dockerfile의 복사 순서는 그대로였던 것이 원인입니다.

같은 조건(두 파일만 있는 빈 폴더)에서 `pnpm install --frozen-lockfile`을 실행하면 다음 오류로 멈춥니다.

```text
ERR_PNPM_LOCKFILE_CONFIG_MISMATCH
Cannot proceed with the frozen installation. The current "overrides"
configuration doesn't match the value found in the lockfile
```

그래서 설치 전에 설정 파일과 패치를 함께 복사하도록 고쳤습니다(커밋 `d3a605b`).

```dockerfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile
```

고친 뒤에는 Docker 없이 빌드 단계를 그대로 따라 해 확인했습니다. 설치가 통과하고, Soniox 플러그인 `dist/stt.js`와 `dist/stt.cjs`에 `{"type":"finalize"}` 패치가 들어가며, `pnpm prune --prod` 뒤에도 패치가 남고 tsc·vitest·eslint는 빠지며, 운영 의존성만으로 `node src/main.ts --help`가 모든 플러그인을 불러 정상 실행됐습니다. 실제 `docker build`는 아직 돌려 보지 않았습니다. (2026-11-06 갱신) "tsc가 빠진다"는 `tsc` 실행 파일 이야기이고, `typescript` 패키지(23MB) 자체는 `@livekit/throws-transformer`의 피어 의존성으로 운영 설치에도 남습니다(15-3절 깊이 보기).

이 사례에서 배울 점은 **패치가 빠져도 오류가 나지 않는 경로가 가장 위험하다**는 것입니다. lockfile 검사가 없었다면 패치 없는 이미지가 조용히 만들어지고, 운영에서 **말 끝 판단만 다시 느려지는**(6장) 찾기 어려운 회귀가 생겼을 것입니다. `--frozen-lockfile`이 설정 불일치를 오류로 잡아 준 덕분에 빌드 시점에 드러난 것입니다.

#### 깊이 보기: 레이어와 캐시(tar 변경분, overlayfs, 캐시 키) (2026-11-06 추가)

**레이어의 실체(일반론).** Dockerfile의 `RUN`·`COPY` 한 줄은 이미지에 **레이어** 하나를 더합니다. 레이어는 "그 줄을 실행하기 전과 후의 파일시스템 차이"를 담은 tar 파일(보통 gzip 압축)이고, 내용의 SHA-256(digest)으로 이름이 붙습니다. 이미지는 이 레이어 digest의 목록(manifest)과 설정 JSON(`ENV`, `WORKDIR`, `USER`, `CMD`)으로 이루어집니다. 그래서 `ENV`·`USER`·`CMD`는 레이어를 만들지 않고 설정만 바꿉니다. 레지스트리에 올리고 받을 때도 레이어 단위이고, 이미 있는 digest는 건너뜁니다.

```text
레이어 tar에 들어가는 것
  새로 생기거나 바뀐 파일  → 파일 전체 (한 바이트만 바뀌어도, 권한·소유자만 바뀌어도 전체)
  지운 파일               → 빈 표시 파일 ".wh.<이름>"(whiteout). 아래 레이어의 원본은 그대로 남음
```

**실행할 때: overlayfs(일반론).** 컨테이너를 띄우면 리눅스의 overlayfs가 레이어들을 겹쳐 하나의 폴더처럼 보여 줍니다.

```text
merged   /app …            ← 프로세스가 보는 하나의 파일시스템
  ▲ 위에서부터 찾음
upper    (컨테이너 전용, 쓰기 가능)   ← 실행 중 쓴 것. 빌드 중 RUN이라면 이것이 곧 새 레이어
lower    COPY --from=build … /app    ← 읽기 전용 레이어들
         RUN adduser …
         RUN apt-get … (base)
```

아래 층의 파일을 고치면 overlayfs는 먼저 그 파일을 **통째로 위 층에 복사**(copy-up)한 뒤 고칩니다. 소유자만 바꾸는 `chown`도 마찬가지입니다. 그래서 `COPY . /app` 다음 줄에 `RUN chown -R appuser /app`을 두면, node_modules의 모든 파일이 위 층으로 복사되고 그 층이 새 레이어가 됩니다. 아래 레이어의 원본은 지워지지 않으므로(레이어는 바꿀 수 없음) `/app` 크기만큼이 **한 번 더** 이미지에 실립니다. tar 형식에는 "소유자만 바뀜"을 적을 방법이 없다는 것도 같은 결론으로 갑니다. `COPY --chown`은 파일을 쓰는 그 순간 소유자를 정하므로 레이어가 하나입니다. 이 레포 Dockerfile은 이 방식이고 따로 도는 `chown`은 없습니다(파일로 확인).

같은 이유로 **지우기는 이미지를 줄이지 못합니다.** `pnpm prune --prod`가 개발 의존성을 지워도 build 단계의 아래 레이어(`pnpm install`)에는 그대로 있습니다. 이 레포가 다단계 빌드로 최종 단계에 `/app`의 **결과만** 복사하는 것이 그래서 효과가 있습니다. 한 단계짜리 Dockerfile에서 `prune`을 했다면 whiteout만 늘고 크기는 그대로였을 것입니다.

**캐시 키(BuildKit, 단순화).** 빌드는 줄마다 "이 줄을 전에 같은 조건으로 실행한 적이 있나"를 키로 찾습니다.

```text
키(n) = 해시( 키(n-1), 이 줄의 명령 문자열, [COPY라면] 복사할 파일들의 내용 체크섬 )
          │            │                     └ 파일 이름·내용(과 권한). 수정 시각은 안 봄
          │            └ RUN은 "문자열"만 봄. 실행 결과나 네트워크 상태는 보지 않음
          └ 앞 줄의 키가 바뀌면 이 줄도 바뀜 → 한 줄이 무효가 되면 그 아래 줄은 모두 무효
```

[lab/15-docker-cache.mjs](lab/15-docker-cache.mjs)는 이 레포의 Dockerfile과 `.dockerignore`를 읽어 이 식대로 키 사슬을 만들고, 파일 하나를 바꾼 시나리오마다 어느 줄이 다시 도는지 표시합니다(Docker 없이 흉내 낸 모형이고, 아래 표는 그 실행 결과입니다).

```text
단계   명령                                              src 한 줄  lockfile  학습서 문서  apt 줄 수정
base   (설정) ENV PNPM_HOME / PATH / HOME                ○          ○         ○            ○
base   RUN apt-get … ca-certificates                     ○          ○         ○            ●
base   RUN npm install -g pnpm@12.16.1                   ○          ○         ○            ●
build  (설정) WORKDIR /app                                ○          ○         ○            ●
build  COPY package.json pnpm-lock.yaml …                ○          ●         ○            ●
build  COPY patches ./patches                            ○          ●         ○            ●
build  RUN pnpm install --frozen-lockfile                ○          ●         ○            ●
build  RUN npx livekit-agents download-files             ○          ●         ○            ●
build  COPY . .                                          ●          ●         ●            ●
build  RUN pnpm prune --prod                             ●          ●         ●            ●
final  RUN adduser …                                     ○          ○         ○            ●
final  COPY --from=build --chown=appuser:appuser /app    ●          ●         ●            ●
final  (설정) USER / ENV NODE_ENV / CMD                   ●          ●         ●            ●
○ 캐시 재사용, ● 다시 실행 (실습 출력에서 줄을 몇 개 합침)
```

- **소스 한 줄**: 의존성 설치는 캐시로 건너뛰지만, 최종 단계의 `COPY --from=build /app /app`이 다시 만들어집니다. 이 레이어에는 **소스와 node_modules가 함께** 들어 있으므로, 코드 한 줄을 고칠 때마다 node_modules 전체(15-3절 실측으로 맥 기준 약 389MB)가 든 새 레이어가 생기고 레지스트리에도 통째로 올라갑니다. 최종 단계에서 node_modules를 먼저(설치 결과만 따로 담은 단계에서) 복사하고 소스를 나중에 복사하면 코드 변경은 작은 레이어만 바뀝니다(제안, 검증하지 않은 설계).
- **lockfile**: 설치부터 아래가 모두 다시 돕니다. 의도한 동작입니다.
- **학습서 문서**: `docs/`가 `.dockerignore`에 없어서 `COPY . .`가 학습서도 이미지에 넣습니다(빌드 컨텍스트 172개 파일 중 77개, 약 1.7MB. 2026-11-06 갱신: #46을 고치고 실습을 더한 뒤 다시 세면 116개 중 83개, 약 2.1MB로 컨텍스트의 90%. 2026-11-08에 다시 세면 116개 중 83개, 약 2.9MB로 컨텍스트 크기의 약 92%이고, 학습서를 보강할수록 계속 늘어납니다). 문서만 고쳐도 소스 한 줄과 같은 범위가 다시 돌고 큰 레이어가 다시 올라갑니다. `docs/`를 `.dockerignore`에 넣는 것을 제안합니다.
- **apt 줄 수정**: base가 바뀌면 build와 최종 단계 모두가 무효입니다. 거꾸로, 이 줄을 **고치지 않으면** 몇 달이 지나도 캐시가 그대로 쓰입니다. 키가 명령 문자열이라 Debian에 보안 업데이트가 나와도 모릅니다. 가끔 `docker build --pull --no-cache`로 새로 빌드하거나, 베이스 이미지를 digest(`node:24-slim@sha256:…`)로 고정하고 갱신 도구로 올리는 방법이 있습니다. `FROM node:24-slim`의 태그는 움직이는 이름이라, 로컬에 받아 둔 옛 이미지를 그대로 쓸 수 있습니다(`--pull`로 새로 확인).

**pnpm 저장소를 캐시 마운트로(제안).** 지금은 lockfile이 조금만 바뀌어도 `pnpm install`이 모든 패키지를 처음부터 받습니다. BuildKit의 캐시 마운트를 쓰면 pnpm 저장소가 빌드 사이에 남습니다. (2026-11-08 추가) BuildKit은 요즘 `docker build`가 기본으로 쓰는 빌드 엔진이고, **캐시 마운트**는 BuildKit이 `RUN` 한 줄을 실행하는 동안에만 붙여 주는 폴더입니다. 그 폴더의 내용은 빌드가 끝나도 BuildKit이 따로 보관했다가 다음 빌드의 같은 줄에 다시 붙여 주지만, 이미지 레이어에는 들어가지 않습니다. pnpm 저장소는 받은 패키지 파일을 한 벌씩 모아 두는 폴더라, 여기에 붙이면 lockfile에서 바뀐 패키지만 새로 받습니다.

```dockerfile
# 제안 (Dockerfile은 고치지 않았음). PNPM_HOME=/pnpm이면 pnpm 저장소 기본 위치가 /pnpm/store
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
```

- 마운트한 폴더의 내용은 레이어에 들어가지 않습니다. 레이어에는 node_modules만 남습니다.
- pnpm은 평소 저장소에서 node_modules로 하드 링크를 거는데, 마운트 경계를 넘는 하드 링크는 안 되므로 복사로 바뀝니다. 설치는 조금 느려질 수 있지만 내려받기가 사라지는 이득이 큽니다(일반론).
- Dockerfile 첫 줄의 `# syntax=docker/dockerfile:1`이 이런 BuildKit 문법을 켭니다. LiveKit Cloud의 원격 빌드가 캐시 마운트를 빌드 사이에 남기는지는 **확인 필요**입니다. LiveKit 문서상 원격 빌드는 10분 제한이 있고, 업로드하는 빌드 컨텍스트는 1GB 이하여야 합니다.

**사례: 작업 폴더의 `.env` 사본이 빌드 컨텍스트에 들어갔다 (2026-11-06 고침).** 실습 1번은 `.dockerignore`를 적용한 뒤 `COPY . .`가 보는 파일을 셉니다. 고치기 전에 이 맥에서 돌리자 경고가 나왔습니다(파일 내용은 열지 않고 이름과 크기만 셈).

```text
== 1. 빌드 컨텍스트 (.dockerignore 적용 뒤, COPY . .이 보는 파일) ==
   파일 172개, 2463.7KB
   docs/                      77개  1748.4KB
   .history/                  62개   481.7KB
   …
   ⚠ .dockerignore에 걸리지 않은 .env 계열 파일 47개 (내용은 열지 않음):
      .history/.env_<시각>.example  ×3
      .history/.env_<시각>.local  ×44

== 4. 같은 폴더를 lk agent deploy로 올리면 (.gitignore·.env.*도 뺌) ==
   파일 172개 → 110개, .env 계열 0개
   .gitignore 때문에 더 빠지는 것: .history/
```

- `.history/`는 편집기 확장(VS Code의 Local History 류)이 파일을 저장할 때마다 남기는 사본 폴더입니다. 그 안에 시각을 붙인 `.env_<시각>.local` 파일이 44개 쌓여 있었습니다. 내용은 열지 않았지만, 이름으로 보아 `.env.local`(API 키가 든 파일)을 저장할 때마다 남은 사본입니다. `.gitignore`에는 있어 git에는 안 올라갔지만, 그때의 `.dockerignore`에는 없었습니다.
- `.dockerignore`의 `.env.*`는 **컨텍스트 루트에서** `.env.`으로 시작하는 이름만 막습니다(Docker 규칙에서 `*`는 `/`를 넘지 않음). 하위 폴더의 `.env_…` 파일은 그대로 통과합니다.
- 그래서 고치기 전에는 이 폴더에서 **로컬 `docker build`(GKE 경로)를 하면** 사본이 build 단계의 `/app/.history/`에 들어가고, 최종 단계가 `/app`을 통째로 복사하므로 **최종 이미지에 API 키가 실릴 수 있었습니다**(사본이 위 추정대로라면). 이미지를 받을 수 있는 사람은 누구나 꺼내 볼 수 있습니다.
- **LiveKit Cloud 배포(`lk agent deploy`)는 그때도 안전했습니다.** LiveKit 문서에 따르면 CLI가 빌드 컨텍스트를 올릴 때 `.env.*` 파일과 `.dockerignore`·**`.gitignore`에** 걸린 파일을 뺍니다. `.gitignore`에 `.history/`가 있으므로 실습 4번처럼 빠집니다. 두 경로의 제외 규칙이 다르다는 것이 함정입니다.
- 대응(2026-11-06 고침, 커밋 `4bc8d72`): `.dockerignore`에 `**/.env*`(어느 폴더에 있든 `.env`로 시작하는 이름)와 `.history/`를 더했습니다. 다시 돌린 실습 1번에는 `.history/`가 사라지고 경고 대신 0개가 나옵니다(실측).

```text
== 1. 빌드 컨텍스트 (.dockerignore 적용 뒤, COPY . .이 보는 파일) ==
   파일 116개, 2424.1KB
   docs/                      83개  2189.3KB
   …
   .dockerignore에 걸리지 않은 .env 계열 파일: 0개

== 4. 같은 폴더를 lk agent deploy로 올리면 (.gitignore·.env.*도 뺌) ==
   파일 116개 → 116개, .env 계열 0개
   .gitignore 때문에 더 빠지는 것: 없음
```

- 172개 → 116개는 `.history/` 62개가 빠지고 그사이 실습 파일이 늘어난 몫입니다(docs/ 77개 → 83개). 4번의 "더 빠지는 것: 없음"은 이제 로컬 `docker build`와 `lk agent deploy`가 같은 파일을 본다는 뜻입니다. 크기는 학습서를 고칠 때마다 달라집니다. (2026-11-08 추가) 같은 실습을 다시 돌리면 파일 수는 116개 그대로이고 크기는 3,144.5KB(docs/ 2,909.7KB)였습니다. `.env` 계열은 여전히 0개입니다.
- 이미지를 빌드할 때마다 실습 1번처럼 컨텍스트를 확인하는 습관은 그대로 남깁니다. 배울 점은 **`COPY . .`는 git이 아니라 작업 폴더를 본다**는 것입니다. 15-8절 표에도 넣었습니다.

**직접 확인(Docker가 있을 때, 사용자가 돌릴 것).** 이 맥에는 Docker가 없어(`docker --version` 실패) 아래는 돌리지 못했습니다. 베이스 이미지를 받으므로 네트워크가 필요하고 처음 빌드는 몇 분 걸립니다. **실습 1번에서 `.env` 계열이 0개인지 먼저 확인한 뒤에** 하고(2026-11-06 갱신: `.dockerignore`는 고쳤음), 만든 이미지를 어디에도 올리지 않습니다.

```bash
docker --version
docker build --progress=plain -t xtool-agent:lab . 2>&1 | tail -30   # 첫 빌드: 모든 줄이 실제로 돎
docker build --progress=plain -t xtool-agent:lab . 2>&1 | grep -E 'CACHED|DONE'   # 두 번째: 거의 모든 줄이 CACHED
touch src/prompt.ts && docker build --progress=plain -t xtool-agent:lab . 2>&1 | grep -E 'CACHED|DONE'   # 수정 시각만 바뀜: 여전히 CACHED
echo test > cache-test.txt && docker build --progress=plain -t xtool-agent:lab . 2>&1 | grep -E 'CACHED|DONE'; rm cache-test.txt   # 새 파일: COPY . .부터 다시
docker history --format '{{.Size}}\t{{.CreatedBy}}' xtool-agent:lab   # 레이어별 크기. COPY --from=build 줄이 가장 큼
docker run --rm --entrypoint sh xtool-agent:lab -c 'ls -A /app; du -sh /app/node_modules'
```

예상: `touch` 뒤의 빌드는 모두 CACHED입니다. Docker 문서상 `COPY`의 체크섬은 파일 내용만 보고 수정·접근 시각은 보지 않기 때문입니다. 새 파일을 만든 뒤의 빌드는 `COPY . .`부터 아래만 다시 돌고, `docker history`에서 `COPY --from=build` 레이어가 수백 MB입니다. 마지막 줄의 `ls -A`에 `docs`가 보이면 학습서가 이미지에 들어간 것입니다.

#### 깊이 보기: PID 1, 신호, 종료 순서 (2026-11-06 추가)

SDK 쪽 흐름(SIGTERM → `drain()` → 종료 코드 143)은 [4-7절 깊이 보기](04-worker-runtime.md#깊이-보기-drain을-코드와-바이트로-따라가기-2026-11-06-추가)에 있습니다. 숫자만 다시 확인하면 `cli.ts` 87∼99의 `onSigterm`이 `production`일 때 `server.drain()`을 부르고 `process.exit(143)`으로 끝나며, 처리기는 101행에서 `process.once`로 겁니다. drain 상한 `DRAIN_TIMEOUT`은 60분입니다(`worker.ts` 46). 여기서는 그 바깥, **컨테이너와 쿠버네티스 쪽**을 봅니다.

**PID 1이 특별한 세 가지(리눅스, `pid_namespaces(7)` 등 일반론).**

1. **처리기를 건 신호만 받습니다.** 보통 프로세스는 처리기가 없으면 SIGTERM의 기본 동작(종료)을 따르지만, PID 네임스페이스의 첫 프로세스는 처리기가 없는 신호를 그냥 받지 않습니다. 네임스페이스 밖(컨테이너 런타임)에서 보낸 SIGKILL·SIGSTOP만 예외입니다. node는 `process.once('SIGTERM', …)`로 처리기를 걸므로 첫 SIGTERM은 받습니다.
2. **고아를 거둬야 합니다.** 부모가 먼저 끝난 프로세스(고아)는 PID 1의 자식으로 넘어갑니다. 끝난 자식은 부모가 `wait()`로 거둘 때까지 좀비로 남습니다. (2026-11-08 추가) **좀비**는 이미 끝난 프로세스가 남긴 종료 기록입니다. 프로세스가 끝나면 커널은 메모리를 바로 돌려받지만, 부모가 `wait()`로 종료 코드를 읽어 갈 때까지 프로세스 표의 한 칸(PID 번호 하나)은 남겨 둡니다. 메모리는 거의 쓰지 않지만, 쌓이면 PID 번호가 모자라 새 프로세스를 못 만들 수 있습니다. 그런데 node(libuv)는 **자기가 띄운 자식의 PID만** `waitpid()`로 거둡니다(libuv 1.52.1 `src/unix/process.c` 101∼150의 `uv__wait_children`가 자기 프로세스 목록만 돎, 코드 확인). 남이 맡긴 고아는 거두지 않으므로 좀비가 쌓일 수 있습니다.
3. **PID 1이 끝나면 커널이 네임스페이스 안의 모든 프로세스를 SIGKILL합니다.** 워커(PID 1)가 처리 안 된 예외로 끝나면(Node는 잡히지 않은 예외나 처리 안 된 Promise 거부를 만나면 오류를 찍고 종료 코드 1로 끝남) 통화 중인 잡 프로세스도 그 순간 끝납니다. 맥에서 `lk agent dev`로 돌릴 때는 자식이 부모의 ping이 15초 없을 때 스스로 끝나지만(4-4절), 컨테이너에서는 그 15초도 없습니다.

**이 프로젝트의 프로세스 나무에 대입하면(코드 확인 + 추론).**

```text
PID 1  node src/main.ts start          ← 워커. SIGTERM은 여기로만 옴
 ├─ 추론 프로세스 (fork)
 ├─ 잡 프로세스 × (통화 수 + 유휴 수)   (fork, SIGTERM·SIGINT는 무시하고 부모 지시로만 끝남, 4-4절)
 │   └─ ffmpeg                         ← 세션 녹음이 켜진 통화만. 녹음을 Opus로 인코딩 (2026-11-08 추가, 아래)
 └─ /bin/sh -c "getconf CLK_TCK" 등     ← 리눅스에서 pidusage가 메모리 측정 준비로 exec (pidusage 4.1.0 lib/helpers/cpu.js 69~92)
```

(2026-11-08 추가) 그림 읽는 법입니다. `├─`·`└─`는 바로 위 프로세스가 띄운 자식이고, 들여 쓴 `│   └─`는 자식의 자식(손자)입니다. `←` 뒤는 설명입니다.

- SDK 코드가 `child_process`를 직접 쓰는 곳은 `fork` 두 곳(`ipc/job_proc_executor.ts` 69행, `ipc/inference_proc_executor.ts` 79행)이고, 플러그인 넷과 rtc-node의 dist에는 `child_process`가 없습니다(검색으로 확인). pidusage는 리눅스에서 `/proc`를 읽고 `getconf`만 셸로 부르는데, 이것도 워커의 직속 자식이라 node가 거둡니다.
- (2026-11-08 갱신) 처음 판은 여기서 "자식을 만드는 곳은 fork 두 곳뿐"이라 적었는데, `child_process`만 검색해서 의존성 안의 경로를 놓쳤습니다. SDK는 의존성 `fluent-ffmpeg` 2.1.3을 통해 ffmpeg를 띄웁니다. 이 레포에 해당하는 것은 **세션 녹음**입니다. LiveKit Cloud 프로젝트의 녹음 설정이 켜져 있으면(`session.start`에 `record`를 주지 않은 이 레포는 서버 설정 `ctx.job.enableRecording`을 따름, `voice/agent_session.ts` 1108∼1115) 잡 프로세스가 고객·에이전트 소리를 PCM으로 ffmpeg의 입력 파이프에 흘려 `audio.ogg`로 인코딩합니다(`voice/recorder_io/recorder_io.ts` 376∼404, ffmpeg 실행 파일은 `@livekit/av`가 플랫폼별로 깔아 줌). 다른 하나인 `audio.ts`(오디오 파일 디코드, 배경음 등)는 이 레포가 쓰지 않습니다.
- 그래서 **좀비가 생길 경로가 하나 있습니다**(코드 확인 + 추론, 컨테이너에서 재현하지 않음). 녹음 중인 잡 프로세스가 SIGKILL로 끝나면(메모리 한도 `jobMemoryLimitMB`, ping 무응답 60초, 15-5·15-6절) 손자였던 ffmpeg가 고아가 되어 PID 1인 워커에게 넘어갑니다. ffmpeg는 입력 파이프가 닫히면 곧 끝나는데, 워커(node)는 남이 맡긴 자식을 거두지 않으므로 그 ffmpeg는 좀비로 남습니다. 정상 종료에서는 잡 프로세스가 ffmpeg가 끝나기를 기다려(`'end'` 이벤트) 직접 거두므로 생기지 않습니다. 비정상 종료 한 번에 좀비 하나라 빨리 쌓이지는 않지만, 파드가 오래 살수록 늘어납니다.
- tini나 `docker run --init` 같은 작은 init을 PID 1에 두면 이 좀비를 거둡니다. 그래서 tini는 "나중에 누가 손자 프로세스를 만들 때"를 위한 것이 아니라, 지금도 드문 경우를 막는 값싼 방어입니다. 쿠버네티스에는 `--init`이 없으므로 이미지에 tini를 넣거나(`ENTRYPOINT ["/usr/bin/tini", "--"]`), 파드에 `shareProcessNamespace: true`를 주어 pause 컨테이너가 PID 1을 맡게 합니다(일반론, 제안). LiveKit 문서는 "래퍼 스크립트 없이 `start`를 바로 실행하는 고정 CMD"를 요구하므로, LiveKit Cloud 배포에서는 지금의 exec 형식이 맞습니다. tini를 `ENTRYPOINT`로 두는 것이 이 요구에 어긋나는지는 문서에 없어 **확인 필요**입니다.

**실습: 신호가 닿는 길.** [lab/15-signals.mjs](lab/15-signals.mjs)는 `cli.ts`처럼 `process.once('SIGTERM')` → drain → `exit(143)`을 하는 워커 흉내를 띄우고 신호를 보냅니다(이 맥, 실측. 출력은 일부 줄였습니다).

```text
== 1. node를 직접 (exec 형식) ==
     271ms  [워커] SIGTERM 받음 → drain 시작 (통화 끝날 때까지 400ms)
     673ms  [워커] drain 끝 → process.exit(143)
   → 종료 코드 143

== 2. drain 중에 SIGTERM 한 번 더 ==
     267ms  [워커] SIGTERM 받음 → drain 시작 (통화 끝날 때까지 400ms)
   → 신호 SIGTERM로 죽음 (셸 관례로는 143)  ← 처리기가 once라 두 번째는 기본 동작(종료)

== 3. 셸이 감쌀 때 (셸에 SIGTERM) ==
   -- /bin/sh -c 'node …'
   셸 PID 27900의 현재 정체: 27900 27889 …/bin/node      ← 셸이 node로 바뀜(exec)
   → 셸: 종료 코드 143  (node가 SIGTERM을 받아 drain)
   -- /bin/sh -c 'node …; echo …'
   셸 PID 27937의 현재 정체: 27937 27889 /bin/sh          ← 셸이 남아 있음
   → 셸: 신호 SIGTERM로 죽음
   → node 27938는 SIGTERM을 못 받고 살아 있음(고아)
   (/bin/dash도 같은 결과)
```

- **2번은 PID 1에서 달라집니다.** 맥에서는 두 번째 SIGTERM이 drain 중인 node를 그 자리에서 끝냈습니다(SIGTERM의 기본 동작). 처리기가 `once`라 첫 신호 뒤에 빠졌기 때문입니다. 컨테이너의 PID 1이라면 처리기가 없는 신호는 받지 않으므로 무시됩니다(위 1번 특성에서 추론, 컨테이너에서 실측하지 않음). 쿠버네티스는 SIGTERM을 한 번만 보내므로 보통은 상관없지만, 사람이 `kill`을 두 번 보내도 drain이 끊기지 않는다는 뜻입니다. 반대로 tini를 두면 node가 PID 1이 아니게 되어 맥과 같아집니다.
- **3번이 셸 형식의 실체입니다.** `CMD node src/main.ts start`는 `/bin/sh -c "node src/main.ts start"`가 됩니다. 이 맥의 `/bin/sh`(bash 3.2)와 `/bin/dash`는 명령이 하나뿐이면 셸 자신을 node로 바꿔(exec) node가 셸의 PID를 물려받았습니다. 그러면 신호도 node에 갑니다. 명령이 둘 이상이면(`…; echo`, `&&`, 파이프) 셸이 남고, SIGTERM은 셸만 끝내고 node는 신호를 받지 못한 채 고아가 됩니다. 컨테이너에서 셸이 PID 1이면 셸에 SIGTERM 처리기가 없으므로 아무 일도 일어나지 않다가, 유예 시간이 끝날 때 SIGKILL로 함께 끝납니다(추론).
- **이미지 안의 셸은 확인 필요입니다.** `node:24-slim`의 `/bin/sh`는 Debian의 dash인데, 이 맥의 dash와 판이 같은지, 명령 하나를 exec하는 최적화가 있는지는 확인하지 못했습니다. Docker가 있으면 `docker run --rm node:24-slim sh -c 'node -p process.pid'`로 봅니다. `1`이 찍히면 셸이 node를 exec한 것입니다(`docker run --rm node:24-slim node -p process.pid`는 늘 `1`). 셸에 기대지 않으려면 지금처럼 exec 형식을 씁니다.
- **`pnpm start`로 감싸는 것도 래퍼입니다.** LiveKit 문서의 Node 템플릿은 `CMD [ "pnpm", "start" ]`를 쓰는데, 그러면 PID 1은 pnpm(node 프로세스)이고 그 아래에 셸과 워커가 생깁니다. pnpm이 SIGTERM을 워커에 넘기는지는 확인하지 않았습니다(**확인 필요**). 이 레포 Dockerfile의 주석("Run Node as PID 1 so SIGTERM reaches the worker")처럼 node를 바로 띄우는 쪽이 불확실성이 없습니다.

**쿠버네티스의 종료 순서(쿠버네티스 문서 기준 일반론).**

```text
t = 0      파드 종료 시작 (배포 교체, 노드 축소·업그레이드, kubectl delete)
           ├ 서비스 엔드포인트에서 빠짐   ← 이 워커는 서비스로 일을 받지 않음(LiveKit에 먼저 연결함). 상관없음
           └ preStop 훅 실행 (있으면)
t = p      SIGTERM → 컨테이너의 PID 1(node 워커)에게만. 자식들은 받지 않음
           워커: WS_FULL 알림 → 유휴 프로세스 닫기 → 통화 끝날 때까지 기다림 (4-7절)
           통화가 다 끝나면 exit(143)  ← 파드 이벤트에 종료 코드 143
t = G      terminationGracePeriodSeconds(G, 기본 30초)가 다 됨 → 남은 모든 프로세스에 SIGKILL
           ← 종료 코드 137. 통화 중이었다면 그 자리에서 끊김
```

- `G`는 preStop이 시작될 때부터 셉니다. preStop에 쓴 시간만큼 drain 시간이 줄어듭니다. 웹 서버는 엔드포인트가 빠지기를 기다리려 `preStop: sleep 5`를 흔히 두지만, 이 워커는 들어오는 트래픽이 없어 필요 없습니다.
- `docker stop`도 같은 모양이고 기본 유예가 10초입니다(`-t`로 바꿈). 로컬에서 Docker로 drain을 시험할 때 10초 뒤에 끊기는 것이 정상입니다.
- 실습 4번이 1분을 100ms로 줄여 흉내 냅니다(실측): 남은 통화 8.5분(850ms)에 유예 30초(50ms)면 `신호 SIGKILL로 죽음 (셸 관례로는 137) ← 통화 중에 끊김`, 유예 600초(1000ms)면 `종료 코드 143 ← 통화를 끝까지 마침`.

**유예 시간 손 계산(코드의 상수 + 추정).** SIGTERM이 막 시작한 통화 하나가 있을 때 들어왔다고 봅니다. drain이 시작되면 새 통화는 안 오지만, 이미 받은 통화는 끝까지 갑니다.

| 구간 | 시간 | 근거 |
| --- | --- | --- |
| 배정 → 세션 시작 → `guardCall` | 약 3초 | 디스패치 시각표 2.8초(4-3절 깊이 보기) |
| 통화 최대 길이 | 480초 | `MAX_CALL_MS = 8 * 60_000` ([src/call-guard.ts](../../src/call-guard.ts), `guardCall`을 부른 때부터) |
| 끝인사 `MAX_LENGTH_BYE` 재생 | 약 6초 | 문장 약 35음절 ÷ 초당 6∼7음절 (추정) |
| 종료 절차 (보통) | 약 5∼15초 | 세션 닫기, 세션 리포트 업로드, 결과 전송(제한 10초, `src/call-result.ts`), 로그·트레이스 내보내기 (추정) |
| 종료 절차 (SDK 제한을 다 씀) | 115초 + 업로드 | entry 15초, 세션 닫기 60초(`job_lifecycle.ts` 19∼20), 종료 콜백(SDK 제한 없음, 이 레포는 10초), 로그·지표·트레이스 내보내기 각 10초(21∼23). 순서는 `ipc/job_proc_lazy_main.ts` 224∼275. 세션 리포트·녹음 업로드(`session_end_upload`)에는 SDK 제한이 없음(`job_lifecycle.ts` 122∼132) |

```text
보통:  3 + 480 + 6 + 15          = 504초  → G = 600초면 약 96초 여유
최악:  3 + 480 + 6 + 115 + 업로드 = 604초 + 업로드 → G = 600초로는 모자람
제안:  G = 660~720초. preStop을 두면 그 시간만큼 더함
```

- SDK의 drain 상한(60분)은 이보다 훨씬 길어서, 실제로 통화를 끊는 것은 쿠버네티스의 `G`입니다.
- **GKE는 경우에 따라 `G`를 자릅니다.** GKE 문서는 노드 자동 업그레이드 때 유예가 최대 1시간, **노드 축소(scale-down) 때는 최대 10분**이라고 적습니다. 그래서 `G`를 720초로 두어도 축소 때는 600초에서 잘릴 수 있습니다. 통화 중인 파드를 축소 대상에서 빼려면 Autopilot의 확장 실행 시간(`cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` 주석, 최대 7일, Spot 파드는 불가)을 검토합니다(문서 기준, 직접 해 보지 않음).
- LiveKit Cloud는 재배포 때 기존 인스턴스에 최대 1시간을 줍니다(15-5절 표). 이 계산은 직접 운영(GKE)에서만 필요합니다.

---

## 15-5. 워커를 어디에 띄우나: LiveKit Cloud 또는 GKE

> 2026-11-03 갱신. 웹 테스트([6-web-test.md 6-3](../6-web-test.md#6-3-에이전트-워커-둘-중-하나))에서 LiveKit Cloud 배포안이 구체화되어 이 절을 둘로 나눴습니다.

(2026-11-08 추가) 이미지를 실제로 돌릴 곳은 두 갈래입니다.

- **LiveKit Cloud 배포**는 LiveKit이 이 레포의 Dockerfile로 이미지를 원격 빌드하고, 자기 서버에서 워커 컨테이너를 띄우고, 새 판으로 바꾸거나 쉴 때 대수를 줄이는 일까지 맡는 방식입니다. 처음에 `lk agent create`로 만들고, 그 뒤로는 `lk agent deploy`로 새 판을 올립니다.
- **직접 운영**은 우리가 이미지를 빌드해 이미지 저장소(레지스트리)에 올리고 우리 클라우드에서 돌리는 방식입니다. 후보는 구글 클라우드 서울 리전의 **GKE**(Google Kubernetes Engine)와 **GCE**(Google Compute Engine)입니다. GKE는 구글이 운영해 주는 **쿠버네티스**입니다. 쿠버네티스는 "이 이미지로 컨테이너를 몇 개 띄워 두라"는 선언을 받아 여러 서버(**노드**)에 배치하고, 끝나면 다시 띄우고, 새 판으로 바꿀 때 차례로 교체하는 시스템입니다. 함께 배치하는 컨테이너 묶음의 단위를 **파드**라고 하며, 이 워커는 파드 하나에 컨테이너 하나면 됩니다. GKE의 Autopilot 방식은 노드 관리까지 구글이 맡습니다. GCE는 가상 머신 한 대를 빌려 그 위에서 컨테이너를 직접 돌리는 방식입니다. 이 절의 직접 운영 이야기는 GKE를 기준으로 합니다.

2026-11-08 기준으로는 어느 쪽도 아직 만들지 않았습니다. 웹 테스트의 워커는 맥에서 `lk agent dev --deployment production`으로 띄웁니다(6-3 A안). LiveKit Cloud 배포(B안)는 명령만 정리돼 있고 실행하지 않아서, 레포에 `livekit.toml`이 아직 없습니다.

| | LiveKit Cloud 배포 (`lk agent create`) | 직접 운영 (GKE·GCE 서울) |
| --- | --- | --- |
| 빌드 | LiveKit이 **이 레포의 Dockerfile로 원격 빌드** | 우리가 빌드·푸시 |
| 리전 | 미국 동부(`us-east`, 애슈번)·유럽(`eu-central`, 프랑크푸르트)·인도(`ap-south`, 뭄바이). 서울·도쿄는 없음 (LiveKit 문서 "Agent deployment regions", 2026-11-08 확인) | 서울 가능 |
| 턴 감지 기본값 | 클라우드 `v1` | 로컬 `v1-mini`(ko 기준값 0.4, 4-5절) |
| 적응형 끼어들기 기본값 | **켜짐** | 꺼짐 (`mode: 'adaptive'` 명시 필요, 7-5절) |
| 배포 시 진행 중 통화 | production 재배포는 진행 중 세션을 최대 1시간 기다림 (LiveKit 문서) | grace period를 직접 설정 |
| 부하 기준 | LiveKit Cloud가 정함 (코드의 임계값 설정은 무시됨) | 코드 기본값 0.7 |
| 무료(Build) 요금제 | production도 쉬고 있으면 0대로 줄어 **첫 통화에 콜드 스타트**. (2026-11-06 추가) LiveKit 문서상 에이전트가 방에 들어오기까지 10∼20초가 더 걸림. 유료 요금제(Ship·Scale)는 production 인스턴스를 0대로 줄이지 않고 늘 1대 이상 띄워 둠. production이 아닌 배포는 요금제와 상관없이 쉬면 0대로 줄고 다음 요청 때 콜드 스타트 (LiveKit 문서 "Deployment management") | 해당 없음 (최소 파드 수를 1 이상으로 두면 콜드 스타트 없음) |
| 새 판이 일을 받기 시작하는 조건 (2026-11-06 추가) | 새 인스턴스의 헬스 체크가 통과한 뒤. 통과까지 5분을 기다림 (LiveKit 문서) | readiness probe로 직접 정함 (아래) |
| 운영 부담 | 작음 | 큼 |

[2-tech-stack.md](../2-tech-stack.md)는 지연 때문에 서울 직접 운영을 추천했고, 웹 테스트는 상시 운영 경로로 우선 LiveKit Cloud 배포를 택했습니다. 4·7장에서 "개발 모드와 운영이 다르다"고 지적한 턴 감지·끼어들기 차이는 **직접 운영할 때의 이야기**이고, LiveKit Cloud에 배포하면 개발 모드(`lk agent dev`)와 같은 쪽(클라우드 `v1`, 적응형 끼어들기 켜짐)으로 갑니다. 대신 서울 리전이 없으므로, LLM이 미국에 있다는 점을 보고 미국 리전이 무난하다고 판단했습니다. 그러면 서울↔미국 왕복(재지 않았고 대략 130∼200ms)이 LLM 요청 경로에서 고객 음성 경로로 옮겨 갑니다. 지연은 [5-poc-results.md](../5-poc-results.md) 방식으로 다시 재야 합니다.

(2026-11-08 추가) SDK가 두 쪽을 가르는 조건은 `isHosted() || isDevMode()`입니다(`agents/inference/eot/detector.ts` 80, `agents/voice/agent_activity.ts` 5872∼5879). `isHosted()`는 LiveKit Cloud가 넣어 주는 환경변수 `LIVEKIT_REMOTE_EOT_URL`이 있으면 참이고, `isDevMode()`는 `lk agent dev`가 넣는 `LIVEKIT_DEV_MODE=1`이면 참입니다(`agents/utils.ts` 1535∼1543). 직접 운영의 `start`는 둘 다 거짓이라 로컬 `v1-mini`와 꺼진 적응형 끼어들기로 갑니다.

### LiveKit Cloud 배포: 비밀값을 넘기는 방법

(2026-11-08 추가) LiveKit Cloud 배포에서는 API 키 같은 비밀값을 이미지에 넣지 않고, LiveKit Cloud의 **비밀값 저장소**(secrets)에 따로 올립니다. 올린 값은 워커 컨테이너가 뜰 때 환경변수로 들어가므로, 코드에서는 `.env.local`로 읽던 때와 똑같이 `process.env`로 보입니다. 처음 값은 `lk agent create --secrets-file`로 넣고, 나중에 바꾸면(`lk agent update-secrets`) 새 값으로 세션을 받도록 워커가 차례로 다시 시작합니다(LiveKit 문서 "Secrets management"). 아래 명령은 `.env.local`에서 필요한 줄만 골라 그 파일을 만듭니다.

```bash
# 부품 키와 결과 전송 설정만 담은 임시 파일 (LIVEKIT_* 는 LiveKit Cloud가 넣어 주므로 뺌)
grep -E '^(ANTHROPIC_API_KEY|ELEVEN_API_KEY|SONIOX_API_KEY|TTS_VOICE|VOICE_RESULT_URL|VOICE_AGENT_SECRET)=' .env.local > .env.agent-secrets
lk agent create --secrets-file .env.agent-secrets
rm .env.agent-secrets
```

- (2026-11-05 갱신) 목록은 [6-web-test.md 6장](../6-web-test.md)의 배포 명령과 같습니다. 이전 판에는 `VOICE_RESULT_URL`·`VOICE_AGENT_SECRET`이 빠져 있었습니다. 그대로 배포하면 워커가 "통화 결과 전송 생략"만 남기고 결과를 보내지 않습니다(15-6절).
- LLM을 Bedrock으로 바꿔 배포한다면 `LLM_PROVIDER`와 `AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`·`AWS_REGION`도 넣습니다. `AWS_BEARER_TOKEN_BEDROCK`은 넣지 않습니다. 코드는 이 값을 읽지 않습니다(16-4절).
  - (2026-11-08 추가) 바꾸기 전에 알아 둘 전제가 있습니다. 이 레포의 Bedrock 클라이언트(`AnthropicBedrock`)는 Anthropic 문서가 "예전 연동"(InvokeModel)이라 부르는 경로이고, 그 문서의 "지원하지 않는 기능" 목록에 최상위 `cache_control`(이 레포가 쓰는 자동 캐시, 8-4절)이 있습니다(2026-11-08 확인). 그대로 바꾸면 매 턴 캐시를 못 써 첫 토큰이 느려지고 비용이 늘 수 있고, 400으로 거절되는지 조용히 무시되는지는 확인되지 않았습니다. 바꾸기 전에 400이 나는지와 2회차 `cached tokens`가 0인지를 봅니다. `pnpm check:llm`은 `LLM_PROVIDER`를 읽지 않고 늘 Anthropic API로 재므로(`scripts/check-llm.ts`) 이 확인에 쓸 수 없습니다([8-8절 "응용: 연결만 바꿔 끼우기"](08-llm.md#응용-연결만-바꿔-끼우기-bedrock-클라이언트-2026-11-05-추가)).
  - 리전도 맞춰 봐야 합니다. 이 레포의 Bedrock 기본 모델은 일본 안에서만 처리하는 `jp.` 프로필이라, 워커를 미국 리전에 올리면 워커↔도쿄 왕복이 생겨 Bedrock을 쓰는 이점(LLM이 서울 가까이 있음)이 사라집니다(6-3 B안의 주의).
- 이미지에는 `.env` 계열 파일이 들어가지 않으므로(15-4절) 비밀값은 **LiveKit Cloud의 비밀값 저장소**로 따로 넘깁니다. 컨테이너에서는 환경변수로 보입니다. (2026-11-06 추가) LiveKit CLI는 업로드할 때 `.dockerignore`에 더해 `.gitignore`와 `.env.*`도 빼지만, 로컬 `docker build`는 `.dockerignore`만 봅니다. 그래서 하위 폴더의 `.env` 사본이 로컬 빌드에만 들어가던 일이 있었습니다(15-4절 깊이 보기). 지금은 `.dockerignore`도 `**/.env*`·`.history/`를 빼므로 두 경로가 같은 파일을 봅니다.
- 임시 파일 `.env.agent-secrets`는 `.gitignore`에 추가되어 있습니다. 명령이 중간에 실패해 `rm`이 안 돌아도 실수로 커밋되지 않게 하는 **이중 안전장치**입니다.
- `LIVEKIT_URL`·키는 LiveKit Cloud가 넣어 주므로 빼는 것입니다. 세션 리포트 업로드(15-6절)도 이 값으로 인증됩니다.
- 처음 만들면 `livekit.toml`(프로젝트·에이전트 정보)이 생기고, 커밋합니다. 이후 코드 변경은 `lk agent deploy`로 올립니다. (2026-11-08 추가) 이 파일에는 `[project]`의 `subdomain`(LiveKit Cloud 프로젝트 주소)과 `[agent]`의 `id`가 들고, `lk agent` 명령은 현재 폴더의 이 파일을 보고 어느 에이전트를 다룰지 정합니다(LiveKit 문서 "Deployment management"). 비밀값은 들지 않습니다. 앞에서 적었듯 아직 `lk agent create`를 돌리지 않아 레포에는 없습니다.
- 원격 빌드가 Dockerfile을 쓰므로, 15-4절의 설치 단계 수정이 **이 배포의 전제 조건**입니다.

### 직접 운영(GKE)에 올릴 때 챙길 것

배포 설정은 아직 없습니다. 4장의 실행 구조에서 나오는 요구 사항을 정리합니다.

| 항목 | 설정 | 이유 |
| --- | --- | --- |
| 종료 유예 | `terminationGracePeriodSeconds`를 최장 통화 길이 + 여유 (예: 600초 이상). (2026-11-06 갱신) 손 계산으로는 660∼720초 제안, GKE 노드 축소는 10분에서 자름 | 기본 30초면 drain 중인 통화가 SIGKILL로 끊김 (4-7절, 15-4절 "유예 시간 손 계산") |
| 헬스 체크 | `GET :8081/` | WebSocket 연결·추론 프로세스가 살아 있을 때만 200. (2026-11-06 추가) readiness·liveness·startup에 어떻게 나눠 쓸지는 아래 깊이 보기 |
| CPU | 계산 최적화형, 버스트형(크레딧) 피하기 | 로컬 턴 감지 mini 모델이 CPU 크레딧이 떨어지면 시간 초과 (LiveKit 문서 권고) |
| 메모리 | 워커 + 추론 프로세스 + (유휴 프로세스 수 + 통화 수) × 잡 프로세스 메모리 + 통화 수 × 통화 하나가 더하는 몫 | 프로세스마다 네이티브 라이브러리를 따로 올림 (4-4절). (2026-11-08 갱신) 추론 프로세스는 RSS 약 290MB(모델 파일 크기는 SDK 주석상 약 138MB이고, RSS에는 추론 런타임과 작업 메모리가 더해짐, 7장), 잡 프로세스는 약 236MB. 계산과 OOM은 아래 깊이 보기 |
| 유휴 프로세스 | 기본 `min(CPU 수, 4)` | (2026-11-06 갱신) "CPU 수"는 libuv가 cgroup `cpu.max`를 읽어 **내림**한 값(코드 확인). CPU 한도 1.5면 1개 → 아래 깊이 보기 |
| 비밀값 | Secret → 환경변수 | 이미지에 `.env` 계열 파일이 없음(`.dockerignore`의 `**/.env*`, 15-4절). (2026-11-06 갱신) 하위 폴더의 사본까지 막은 것은 커밋 `4bc8d72`부터 |
| `/tmp` 쓰기 | 읽기 전용 루트 파일시스템이면 emptyDir 마운트. (2026-11-08 추가) 녹음 파일이 쌓이므로 emptyDir에 `sizeLimit`을 두거나 오래된 폴더를 지우는 장치를 둠 | 세션 녹음이 켜져 있으면 잡 프로세스가 `os.tmpdir()/livekit-agents/job-<잡 id>/audio.ogg`에 씀(`agents/job.ts` 269∼271). 세션 리포트는 파일로 쓰지 않고 바로 올림(파일은 console 모드에서만). SDK 1.9.5에는 녹음 파일을 올린 뒤 지우는 코드가 없어 통화마다 남음(15-6절 "LiveKit Cloud 세션 리포트") |
| 턴 감지·끼어들기 | `TurnDetector({ version })`, `interruption.mode` 명시 여부 결정 | 직접 운영 `start`에서는 개발 모드·LiveKit Cloud와 기본값이 다름: 로컬 `v1-mini`, 적응형 끼어들기 꺼짐 (위 표 아래 문단, 4-5절, 7장) |
| 리전 | 워커 GCP 서울, 미디어·SIP는 LiveKit Cloud 일본 | [2-tech-stack.md 4-1](../2-tech-stack.md#4-1-프레임워크) |

#### 깊이 보기: CPU 한도에서 유휴 프로세스 수까지 (2026-11-06 추가)

(2026-11-08 추가) 먼저 낱말입니다. 클라우드가 파는 CPU 단위가 **vCPU**(가상 CPU 하나, 흔히 물리 코어의 하드웨어 스레드 하나)이고, 쿠버네티스에서 파드에 CPU limit `1.5`를 주면 컨테이너의 cgroup 파일 `cpu.max`에 `150000 100000`이 적힙니다. 앞 숫자가 쓸 수 있는 CPU 시간(quota, µs), 뒤 숫자가 그 시간을 세는 주기(period, µs)라서 "0.1초마다 CPU 시간을 0.15초까지", 곧 코어 1.5개분입니다. 다 쓰면 그 주기의 나머지 동안 컨테이너의 모든 프로세스가 멈춥니다(CPU 스로틀링, 4-4절 깊이 보기의 host 막힘). 한도가 없으면 앞 숫자 자리에 `max`가 적힙니다.

컨테이너의 CPU 한도 하나(cgroup v2의 `/sys/fs/cgroup/cpu.max`, 4-2절 깊이 보기)를 SDK의 두 곳이 **서로 다르게** 읽습니다(코드 확인).

| 쓰는 곳 | 읽는 법 | 근거 |
| --- | --- | --- |
| 부하 계산(`load`, 0.7 기준) | `quota ÷ period`를 **소수 그대로**. `max`면 `os.cpus().length`(호스트 코어 수). `NUM_CPUS` 환경변수가 있으면 그 값 | `agents/cpu.ts` 13∼22·53∼60 |
| 유휴 프로세스 수 | `min(os.availableParallelism(), 4)` | `agents/worker.ts` 88∼94 |

`os.availableParallelism()`은 libuv의 `uv_available_parallelism()`입니다. Node 24.22에 든 libuv 1.52.1(`process.versions.uv`)의 소스를 읽어 보면 이렇습니다.

```text
src/unix/core.c (uv_available_parallelism)
  rc = sched_getaffinity로 이 프로세스가 쓸 수 있는 코어 수 (실패하면 켜진 코어 수)
  리눅스면 uv__get_constrained_cpu(&quota) → 0 < quota < rc 이면 rc = quota
  rc < 1 이면 1
src/unix/linux.c (uv__get_cgroupv2_constrained_cpu)
  /proc/self/cgroup이 "0::/…"(cgroup v2)이면 자기 cgroup 폴더에서 위로 올라가며 cpu.max를 읽음
  quota = limit / period   ← 정수 나눗셈(내림). 0이면 1
  cgroup v1이면 cpu.cfs_quota_us / cpu.cfs_period_us (역시 내림)
```

그래서 CPU 한도별로 이렇게 갈립니다(코드로 계산한 예상값, 컨테이너에서 실측하지 않음. "한도 없음"의 16코어는 가정).

| `cpu.max` | 뜻 | `availableParallelism()` | 유휴 프로세스 | 부하 계산의 CPU 수 |
| --- | --- | --- | --- | --- |
| `max 100000` | 한도 없음(노드 16코어) | 16 | 4 | 16 |
| `50000 100000` | 0.5 CPU | 1 (0 → 1) | 1 | 0.5 |
| `150000 100000` | 1.5 CPU | **1** (내림) | 1 | 1.5 |
| `200000 100000` | 2 CPU | 2 | 2 | 2 |
| `800000 100000` | 8 CPU | 8 | 4 | 8 |

- 4장에서 "**확인 필요**"로 남긴 "`availableParallelism()`이 컨테이너 CPU 한도를 반영하나"의 답은 **반영한다, 다만 내림으로**입니다(libuv 1.52.1 코드 기준). 이 맥은 cgroup이 없어 8(코어 수)이 나옵니다(실측).
- 쿠버네티스에서 CPU **limit**을 주면 `cpu.max`에 한도가 생기고, request만 주면 `max`라 호스트 코어 수를 봅니다. request만 준 파드는 노드 코어가 4개 이상이면 request와 상관없이 유휴 프로세스가 4개가 되고, 부하 계산은 노드 전체 코어를 분모로 써서 실제보다 낮게 나옵니다. GKE Autopilot이 limit을 request와 같게 거는지는 **확인 필요**입니다.
- **1.5 같은 소수 한도는 손해입니다.** 유휴 프로세스는 1개뿐인데 부하 계산은 1.5를 분모로 씁니다. (2026-11-08 갱신) 통화 둘이 거의 동시에 오면 첫 통화가 유휴 프로세스를 가져가고, 두 번째는 빈자리에 새 잡 프로세스가 준비될 때까지 기다립니다(`agents/ipc/proc_pool.ts` 71∼77, `warmedProcQueue.get()`). 준비("데우기")는 fork, `main.ts`와 SDK·플러그인 모듈 불러오기, 네이티브 바인딩 올리기, prewarm이고, 이 맥(Apple M1 Pro)에서 fork부터 준비 완료까지 608∼891ms, 중앙값 625ms였습니다(실측, [4-4절 깊이 보기 "잡 프로세스 하나를 데우는 데 드는 시간"](04-worker-runtime.md#깊이-보기-잡-프로세스-하나를-데우는-데-드는-시간-2026-11-08-추가)). 그러니 두 번째 통화는 약 0.6초 늦게 시작합니다. 데우기는 `initMutex`로 한 번에 하나씩 차례로 하고(`proc_pool.ts` 115∼131), 유휴 자리가 하나뿐이면 다음 데우기는 앞서 데운 프로세스가 일을 맡은 뒤에야 시작합니다. 그래서 세 번째 통화까지 겹치면 약 1.2초(0.6초 × 2)를 기다립니다(코드에서 따라간 추정). 컨테이너는 CPU가 1.5로 묶여 있어 모듈 불러오기가 맥보다 느릴 수 있습니다. 한도를 정수로 두거나, `ServerOptions`의 `numIdleProcesses`를 직접 정하는 것을 제안합니다(코드는 고치지 않음). `numIdleProcesses`에 0을 주면 `||` 때문에 기본값으로 돌아가므로(`worker.ts` 282), 유휴 프로세스를 아예 끄는 데는 쓸 수 없습니다.
- 곁가지: 같은 libuv 함수가 조상 cgroup을 올라가며 `min_quota`를 계산하지만 그 값을 쓰지 않아, 여러 단계에 한도가 있으면 가장 작은 값이 아니라 가장 위 단계의 값이 남는 것으로 읽힙니다. 컨테이너 안에서는 보통 자기 cgroup만 보이므로 영향은 없을 것으로 봅니다(코드 읽기와 추정).

**직접 확인(Docker가 있을 때, 사용자가 돌릴 것).** 예상은 `1`과 `150000 100000`입니다.

```bash
docker run --rm --cpus=1.5 node:24-slim \
  node -p "os.availableParallelism() + ' | ' + require('fs').readFileSync('/sys/fs/cgroup/cpu.max', 'utf8')"
```

#### 깊이 보기: 메모리 산정과 OOM (2026-11-06 추가)

**4장 실측을 넣은 손 계산.** (2026-11-08 갱신) 키 없이 잰 RSS([4-4절 깊이 보기 "프로세스 트리와 메모리 직접 보기"](04-worker-runtime.md#깊이-보기-프로세스-트리와-메모리-직접-보기-2026-11-06-추가)의 "대략의 크기")는 이렇습니다. MB는 2^20바이트입니다.

| 상태 | RSS | 이 계산에서 |
| --- | --- | --- |
| 빈 Node 24 프로세스 | 45MB | 쓰지 않음 |
| `@livekit/agents`와 플러그인 넷만 불러온 프로세스 | 약 183MB | 쓰지 않음 (처음 판은 이 값으로 셈) |
| 이 레포의 `src/main.ts`까지 불러온 프로세스 = 유휴 잡 프로세스 | 약 236MB | 잡 프로세스 하나 |
| 위에 LiveKit 등록 연결과 HTTP 서버가 더해진 워커 | 약 240MB (4장의 어림) | 워커 |
| 빈 프로세스에서 턴 감지 모델만 올린 추론 프로세스 | 약 290MB (모델을 올리며 +233∼243MB, 7장) | 추론 프로세스 |

처음 판은 플러그인까지만 불러온 183MB로 셈했는데, 워커와 잡 프로세스는 모두 `main.ts`를 불러오므로 236MB 쪽이 실제에 가깝습니다(4장 글쓴이의 실측). 통화 하나가 더하는 몫(`x`, 세션·버퍼·WebRTC)은 아직 재지 않았습니다.

```text
메모리 ≈ 워커 240 + 추론 290 + (유휴 수 + 통화 수) × 236 + 통화 수 × x      (MB, 유휴는 쓰는 만큼 다시 채움)

2 CPU 한도(유휴 2), 통화 0:           240 + 290 + 2 × 236         ≈ 1,000MB (약 1.0GB)
CPU 한도 4 이상이나 한도 없음(유휴 4), 통화 0:
                                      240 + 290 + 4 × 236         ≈ 1,470MB (약 1.5GB)
2 CPU 한도, 통화 5(4-2절 손 계산), x = 100MB 가정:
                                      1,002 + 5 × 236 + 5 × 100   ≈ 2,680MB (약 2.6GiB)
```

- 첫째·둘째 줄은 4장의 어림(2 vCPU 약 1.0GB, 8코어 맥 약 1.5GB)과 같은 계산입니다. 처음 판의 840MB, 2,250MB는 각각 약 1,000MB, 2,680MB로 고칩니다.
- 이 합은 **넉넉한 쪽**입니다. RSS는 node 실행 파일이나 `.node` 네이티브 라이브러리처럼 여러 프로세스가 같은 파일을 매핑한 페이지를 프로세스마다 셉니다. cgroup은 한 물리 페이지를 한 번만 셉니다. 그래서 RSS를 더한 값은 실제 컨테이너 사용량(`/sys/fs/cgroup/memory.current`)보다 클 수 있습니다(일반론).
- 위 숫자로는 2 CPU 파드에 메모리 request 3GiB, limit 3.5GiB 정도가 출발점입니다(추정. 처음 판은 183MB로 셈해 2.5GiB/3GiB를 적었습니다). 통화 몇 개를 건 상태에서 `memory.current`를 재서 `x`를 채우고, 그 값에 맞춰 줄여 나갑니다.
- 녹음 파일을 쓰는 임시 폴더를 `medium: Memory`인 emptyDir(메모리 위의 임시 파일시스템)로 두면, 그 파일이 컨테이너의 메모리 사용량에 들어갑니다(쿠버네티스 일반론). SDK가 녹음 파일을 지우지 않으므로(15-6절) 통화가 쌓일수록 메모리가 늘어 OOM으로 갈 수 있습니다. 이 워커에는 디스크 위의 emptyDir이 맞습니다.

**OOM은 통화 하나가 아니라 파드 전체를 끊을 수 있다.** 컨테이너가 메모리 limit을 넘으면 리눅스 OOM killer(메모리가 모자랄 때 커널이 고른 프로세스를 SIGKILL로 끝내는 장치)가 그 cgroup 안의 프로세스를 끝냅니다. 쿠버네티스 1.28부터 cgroup v2 노드에서는 kubelet이 컨테이너 cgroup에 `memory.oom.group=1`을 걸어, **컨테이너 안의 모든 프로세스를 함께** SIGKILL로 끝냅니다(쿠버네티스 블로그 "The Shift to cgroup v2", kubelet 설정 `singleProcessOOMKill`의 기본값 false. 문서 기준, GKE에서 직접 보지 않음). 이 워커에서는 잡 프로세스 하나가 누수 등으로 메모리를 계속 늘려 컨테이너 limit을 넘기기만 해도 **진행 중인 모든 통화가 한꺼번에** 끊긴다는 뜻입니다. 파드 상태에는 `OOMKilled`, 종료 코드 137이 남습니다.

- SDK에는 잡 하나만 끊는 장치가 있습니다. `ServerOptions`의 `jobMemoryLimitMB`(기본 0 = 끔)를 주면, 부모가 5초마다 자식 RSS를 재다가 넘은 잡 프로세스만 SIGKILL합니다(`agents/ipc/supervised_proc.ts` 108∼126, 로그 `job process exceeded memory limit, killing it`). 컨테이너 limit보다 충분히 낮게 두면 OOM의 피해를 통화 하나로 줄일 수 있습니다(제안). 5초 간격이라 순간적인 급증은 못 잡습니다.
- 경고만 하는 `jobMemoryWarnMB`(1,000MB)는 지금도 켜져 있습니다(4-4절).

#### 깊이 보기: 헬스 체크를 probe 셋에 나눠 쓰기 (2026-11-06 추가)

**SDK의 헬스 서버(코드 확인).** `start`에서 워커는 `0.0.0.0:8081`에 작은 HTTP 서버를 띄웁니다(`agents/worker.ts` 96∼101·219, `agents/http_server.ts`).

| 경로 | 응답 | 조건 |
| --- | --- | --- |
| `GET /` | 200 `OK` | 추론 프로세스가 살아 있고, LiveKit WebSocket이 열려 있음 |
| `GET /` | 503 `inference process not running` / `not connected to livekit` | 위가 아닐 때(재연결 중 포함) (`worker.ts` 425∼441) |
| `GET /worker` | 200 JSON | `agent_name`, `deployment`, `active_jobs`, `sdk_version` 등 |

- drain 중에도 WebSocket은 열려 있으므로 `/`는 계속 200입니다. "drain 중"을 알리는 신호는 아닙니다.
- 이 서버는 워커의 이벤트 루프에서 돕니다. 워커 루프가 probe 시간 제한(쿠버네티스 기본 1초)보다 오래 막히면 probe가 실패합니다. 막힘은 워커의 루프 감시 로그로 봅니다(4-4절).

**probe 셋에 어떻게 쓰나(제안, 쿠버네티스 일반론).** (2026-11-08 추가) probe는 쿠버네티스의 노드 쪽 관리 프로그램(kubelet)이 정해진 간격으로 컨테이너에 보내는 상태 검사입니다. 이 워커라면 HTTP `GET :8081/`이고, 응답 코드가 200∼399면 성공, 시간 제한 안에 답이 없거나 그 밖의 코드면 실패로 셉니다. "10초 × 30번"은 10초마다 묻고 30번 연속 실패하면 실패로 본다는 뜻입니다. 셋은 실패했을 때 하는 일이 다릅니다.

| probe | 실패하면 | 이 워커에서 |
| --- | --- | --- |
| startup | 다른 probe를 미룸. 끝내 실패하면 재시작 | 첫 기동은 추론 프로세스 초기화 한도가 5분(4-4절 표)이라 넉넉히(예: 10초 × 30번). LiveKit Cloud도 새 인스턴스에 5분을 줌 |
| readiness | 서비스 엔드포인트에서 뺌 | 이 워커는 서비스로 일을 받지 않으므로 의미는 **롤링 배포의 진행 조건**입니다. 새 파드가 `/` 200(LiveKit에 등록됨)이 되어야 옛 파드를 내림. LiveKit Cloud의 "새 인스턴스 헬스 체크 통과 뒤 교체"와 같은 효과 |
| liveness | 컨테이너 재시작(= SIGTERM → 유예 → SIGKILL) | 추론 프로세스가 끝나 버려(`isAlive` 거짓) 503이 나는 경우는 재시작이 맞음. 하지만 LiveKit 쪽 장애로 재연결 중일 때도 503이라, 기준을 짧게 두면 장애 때 모든 파드가 재시작을 돌림. 재시작해도 고쳐지지 않으므로 넉넉하게(예: 10초 × 6번 = 60초) |

- liveness 실패로 재시작될 때도 SIGTERM부터 시작하므로, 유예 시간이 길면 진행 중인 통화는 끝까지 갑니다(15-4절).
- 읽기 전용 루트 파일시스템을 쓰면 세션 녹음을 쓰는 임시 폴더(`os.tmpdir()`, 보통 `/tmp`, 15-6절)에 emptyDir을 붙입니다. emptyDir은 노드 디스크(또는 `medium: Memory`면 메모리)에 생기고 파드와 함께 사라지므로, 녹음 파일이 업로드 전에 파드가 끝나면 남지 않습니다(일반론). (2026-11-08 추가) 거꾸로 파드가 오래 살면 SDK가 지우지 않은 녹음 파일이 통화마다 쌓입니다(15-6절). emptyDir에 `sizeLimit`을 주면 넘었을 때 kubelet이 파드를 내보내므로(쿠버네티스 일반론), 한도에 닿기 전에 오래된 `job-*` 폴더를 지우는 장치와 함께 둡니다.

---

## 15-6. 관측(observability)

(2026-11-08 추가) **관측**은 운영 중인 시스템 안에서 무슨 일이 있었는지를 밖에서 알 수 있게 남기는 일입니다. 남기는 모양은 셋입니다. **로그**는 사건 하나를 한 줄로 적은 기록("통화 시작", "결과 전송 실패"), **지표**는 시간에 따라 재는 숫자(턴마다 LLM 첫 토큰 시간), **트레이스**는 한 일의 구간들이 언제 시작해 언제 끝났는지 엮은 나무입니다(아래 깊이 보기). 통화는 사람이 옆에서 지켜보지 않으므로, 고객이 "말이 끊겼다"고 해도 기록이 없으면 원인을 가릴 길이 없습니다. 이 절은 지금 남기는 것, LiveKit Cloud가 모아 주는 것, 운영 로그에서 지켜볼 줄, 통화 결과를 functions-xtool로 보내는 길과 받는 쪽 코드를 차례로 봅니다.

### 지금 있는 것

```ts
// src/main.ts 30행
log().info({ config, callId: call.callId }, '통화 시작');

// src/main.ts 107~111행
const latency = emptyLatency();
session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
  metrics.logMetrics(ev.metrics);   // 구간별 지연을 로그에 남김 (13장)
  addLatency(latency, ev.metrics);  // 같은 값을 통화 결과에 실을 배열에 쌓음 (아래 "통화 결과 전송")
});
```

- (2026-11-08 갱신) 구간별 지연 메트릭을 **로그**에 남기고(`logMetrics`), 같은 값을 통화 결과의 `latency`에도 쌓습니다(`addLatency`, 13-5절). 처음 판의 인용은 `logMetrics` 한 줄뿐인 옛 코드였습니다.
- `start` 모드의 로그는 JSON 형식이라 Cloud Logging 같은 곳에서 필드로 검색할 수 있습니다.
- 통화 시작 로그에 `callId`를 남겨 Firestore 기록과 연결합니다.
- (2026-11-08 추가) 이 레포가 쓰는 세션 단위 `MetricsCollected`(`metrics_collected`) 이벤트는 LiveKit 문서 "Data hooks"에서 사용 중단(deprecated)으로 표시돼 있습니다. 문서는 사용량은 `session_usage_updated` 이벤트로, 턴별 지연은 `ChatMessage.metrics`로 받으라고 하고, 플러그인 단위 `metrics_collected`는 사용 중단이 아니라고 적습니다(2026-11-08 확인). 설치된 1.9.5 코드에는 그런 표시가 없습니다(`agents/voice/events.ts` 32행에 `@deprecated` 없음). 대체 수단은 이미 들어 있습니다(`SessionUsageUpdated` 이벤트 33행, `ChatMessage`의 `metrics` 칸 `agents/llm/chat_context.ts` 321행). SDK를 올릴 때 이 이벤트가 경고를 내거나 사라지지 않는지 확인하고, 옮길지 정합니다.

(2026-11-08 추가) **JSON 로그 한 줄의 실물.** SDK는 pino라는 로그 라이브러리를 쓰고, `start`에서는 사람이 읽기 좋게 꾸미지 않은 JSON 한 줄씩을 표준 출력(stdout)에 씁니다(`agents/cli.ts` 31행 `pretty: !args.production`, `agents/log.ts` 78∼85). 12-Factor의 열한째 원칙("로그는 흘려보내기만 하고, 모으는 일은 실행 환경이 맡는다")과 같은 방식이라, GKE나 LiveKit Cloud가 표준 출력을 모아 갑니다. 같은 설정(`pretty: false`, `info`)으로 레포 밖에서 `log().info({ callId: 'call-123', … }, '통화 시작')`을 한 번 찍어 본 결과입니다(실측, 호스트 이름과 경로는 줄임).

```text
{"level":30,"time":1794075855060,"pid":64745,"hostname":"…","code.file.path":"…/log-line.mjs","code.function.name":"<anonymous>","code.line.number":4,"callId":"call-123","config":{"stt":{"provider":"soniox"}},"msg":"통화 시작"}
```

| 필드 | 뜻 |
| --- | --- |
| `level` | 수준 번호. pino는 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal. `start`의 기본은 info라 30 미만은 아예 찍지 않음(같은 실험에서 debug 줄은 나오지 않음) |
| `time` | 1970-01-01부터 잰 ms |
| `pid` | 이 줄을 찍은 프로세스. 워커인지 어느 잡 프로세스인지 가를 때 씀 |
| `code.*` | 로그를 부른 파일·함수·행. SDK가 붙임(`agents/log.ts` 29∼50) |
| `callId`, `config` | 우리 코드가 첫 인자로 넘긴 필드 |
| `msg` | 문구 |

실제 잡 프로세스 안에서는 SDK가 `jobID`·`room_id`·`agent_name`도 붙입니다(`agents/ipc/job_proc_lazy_main.ts` 362∼369). 그래서 우리 쪽 `callId`와 LiveKit 쪽 `jobID`로 한 통화의 줄을 모두 모을 수 있습니다.

### LiveKit Cloud 세션 리포트

워커가 LiveKit Cloud 프로젝트(`*.livekit.cloud`)에 붙어 있으면, **워커를 GKE에 두더라도** 세션이 끝날 때 리포트를 LiveKit Cloud로 올립니다(`voice/report.ts`, `telemetry/`).

| 내용 | 비고 |
| --- | --- |
| 이벤트 목록, 대화 기록, 모델 사용량, 세션 설정 | Agent Observability 화면에서 확인 |
| 트레이스·로그 (OpenTelemetry) | 구간별 시간 |
| 녹음 (고객·에이전트 채널 분리, Opus 48kHz) | 프로젝트 설정의 녹음 옵션을 따름. 잡 프로세스가 띄운 ffmpeg가 `os.tmpdir()/livekit-agents/job-<잡 id>/audio.ogg`로 쓴 뒤 업로드 (`agents/job.ts` 269∼271, 15-4절 깊이 보기의 프로세스 나무) |

알아 둘 점:

- 업로드 인증은 **환경변수 `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`에서만** 만듭니다. 명령줄 플래그로만 키를 넘기면 업로드가 실패합니다.
- (2026-11-08 추가) **녹음 파일은 올린 뒤에도 남습니다.** 업로드는 파일을 읽어 보낼 뿐이고(`agents/telemetry/traces.ts` 1196∼1198), SDK 1.9.5에서 이 폴더를 지우는 코드는 찾지 못했습니다(`job.ts`·`voice/report.ts`·`telemetry/`를 검색, agents-js 기본 브랜치도 같음). 파이썬 SDK는 잡마다 `tempfile.TemporaryDirectory()`를 쓰므로 잡 프로세스가 끝날 때 지워질 것으로 보여(코드 검색, 추정) Node SDK만의 차이로 보입니다. 크기는 같은 ffmpeg 옵션(48kHz 스테레오 PCM → Opus)으로 30초짜리 합성 신호를 인코딩해 어림했습니다. 무음은 약 1kbps, 잡음은 86kbps, 두 채널이 2초씩 번갈아 말하는 합성음은 128kbps였습니다(실측, `@livekit/av`에 든 ffmpeg 9.0.2). 실제 통화가 86∼128kbps 사이라면 8분 통화 하나에 약 5∼8MB, 3분이면 약 2∼3MB가 컨테이너의 임시 폴더에 쌓입니다(추정). LiveKit Cloud 배포의 인스턴스 디스크 한도는 문서에서 찾지 못해 **확인 필요**이고, 직접 운영이라면 15-5절 표처럼 emptyDir 한도와 정리 장치를 둡니다. 고객 음성이 파드 디스크에 남는 개인정보 문제는 15-8절 표에도 넣었습니다. 이 동작은 LiveKit에 피드백으로 보냈습니다.
- **개인정보**: 녹음과 대화 기록이 LiveKit Cloud로 갑니다. SIP 참가자의 **전화번호가 트레이스 속성으로 기록**됩니다. 녹음 고지·처리방침·국외 이전 동의([2-tech-stack.md 11장](../2-tech-stack.md#11-직접-재-봐야-할-것))와 함께, 리포트의 마스킹(redaction) 옵션을 검토해야 합니다.

#### 깊이 보기: 트레이스와 스팬(통화 끝의 막대들) (2026-11-06 추가)

OpenTelemetry(OTel)는 "무엇이 언제부터 언제까지 걸렸나"를 공급사와 상관없는 모양으로 남기는 표준입니다. 기록 단위는 **스팬**(이름, 시작·끝 시각, 속성, 부모 스팬 id)이고, 한 통화의 스팬들을 부모-자식으로 엮은 나무가 **트레이스**입니다. Agent Observability 화면의 가로 막대 하나하나가 스팬입니다.

통화가 끝날 때 SDK가 여는 스팬은 코드에서 이렇게 보입니다(`agents/ipc/job_proc_lazy_main.ts` 231∼265, `agents/job_lifecycle.ts`).

```text
job_shutdown  (속성: 종료 이유, 사용자가 끝냈는지)
 ├ on_session_end        onSessionEnd 콜백 (이 레포는 쓰지 않음)
 ├ session_end_upload    세션 리포트·녹음 업로드
 ├ room_disconnect       방 연결 끊기
 └ shutdown_callback     ctx.addShutdownCallback마다 하나 (이 레포: 통화 결과 전송)
```

- 15-4절의 유예 시간 손 계산에서 "종료 절차"가 바로 이 막대들입니다. 어느 통화의 종료가 느렸다면 어느 막대가 길었는지로 원인을 가릅니다. 예를 들어 `shutdown_callback`이 10초 가까우면 functions-xtool 쪽이 느렸던 것입니다.
- 스팬과 로그는 잡이 끝날 때 내보내고(`flushJobTraces`, `flushJobLogs`), 각각 10초 제한이 있습니다(`job_lifecycle.ts` 21∼23). 내보내기가 실패하면 그 통화의 트레이스가 비어 보일 수 있습니다.

### 운영 로그에서 지켜볼 것 (2026-11-06 추가)

`start`의 기본 로그 수준은 info이고 JSON 한 줄씩 나옵니다(`agents/cli.ts` 173). 다른 장에서 찾은 것 중 운영에서 놓치기 쉬운 것을 모았습니다.

| 무엇 | 로그·신호 | 알아 둘 점 |
| --- | --- | --- |
| 이벤트 루프 막힘 | `event loop blocked …`(code) / `process not scheduled …`(host), 100ms부터 warn | 기준은 `LIVEKIT_AGENTS_LOOP_BLOCK_WARN_MS`·`…_ERROR_MS`로 바꿈(0이면 끔). host로 나오면 코드가 아니라 CPU 한도(스로틀링)를 봄 (4-4절) |
| 잡 프로세스 무응답 | `job executor is unresponsive` | **잡 쪽 루프 막힘을 잡지 못함.** 지연을 pong을 보낸 시각으로 재기 때문(17-2 #31). 잡의 막힘은 위 루프 감시 로그로 찾음. 60초 동안 pong이 없으면 `job is unresponsive`와 함께 SIGKILL |
| 처리 안 된 Promise 거부 | 잡 프로세스: `Unhandled promise rejection in job process`가 **debug로만** | info인 운영 로그에 안 보임(17-2 #44, 12-2절). 워커·추론 프로세스에는 이 처리기가 없어 그 프로세스가 끝나고, 워커가 끝나면 컨테이너의 모든 통화가 끝남(15-4절 PID 1) |
| 메모리 | `job process memory usage is above the warning threshold (advisory only …)` / `… exceeded memory limit, killing it` / 파드 `OOMKilled` | 15-5절 깊이 보기 |
| 디스크 (2026-11-08 추가) | 로그 없음. 컨테이너 안의 `du -sh /tmp/livekit-agents`, 파드의 임시 저장소 사용량, emptyDir 한도를 넘어 내보내진 파드(`Evicted`) | 녹음이 켜져 있으면 SDK가 지우지 않은 `audio.ogg`가 통화마다 늘어남(위 "LiveKit Cloud 세션 리포트") |
| 종료 | 파드 종료 코드 **143**(drain 뒤 정상), **137**(SIGKILL: 유예 초과나 OOM), `timed out draining`(60분) | 4-7절, 15-4절 |
| 종료 절차의 시간 초과 | `entrypoint did not exit in time …`, `AgentSession.close() timed out …`, `OTEL … flush timed out …` | `job_lifecycle.ts`. 유예 시간 계산의 "최악" 쪽으로 가고 있다는 신호 |
| 결과 전송 실패 | `통화 결과를 보내지 못했습니다` (error) | [src/main.ts](../../src/main.ts). 재전송이 없으므로 이 줄 하나가 곧 결과 유실 |
| entry 실패 (2026-11-08 추가) | `error in entry function` (error) | 설정 오타처럼 entry 안에서 난 예외로 통화가 시작도 못 함(`job_lifecycle.ts` 81∼86). 워커의 헬스 체크는 계속 200이라 probe로는 안 보임(15-1절) |

- 처리 안 된 거부를 운영에서 보려면 로그 수준을 debug로 내리면 되지만 양이 많아집니다. `@typescript-eslint/no-floating-promises`를 켜서 미리 막는 쪽을 12-2절이 다룹니다.

### 통화 결과 전송 (2026-11-03 추가)

통화가 끝나면 에이전트가 대화록과 지연 기록을 functions-xtool로 보냅니다([src/call-result.ts](../../src/call-result.ts)). 요약과 판정 칸 추출은 받는 쪽이 따로 합니다. 1장 그림의 "통화 후 처리"로 가는 첫 연결입니다.

받는 쪽([6-web-test.md 4-1](../6-web-test.md#4-1-통화-결과-저장판정조회))은 `submitVoiceCallResult`가 Firestore `calls/{callId}`에 저장하고, 문서가 생기면 트리거 함수가 Opus 5.5로 요약·판정 칸을 뽑아 붙입니다(8-10절). 관리 화면은 통화가 끝나면 3초마다(최대 2분) 결과를 조회해 보여 줍니다. 받는 쪽은 **같은 통화를 다시 보내도 덮어쓰지 않게** 만들어져 있습니다. 같은 요청을 여러 번 보내도 결과가 같은 성질(멱등성, 10-6절에서 본 그 개념)이 있으면, 나중에 에이전트 쪽에 재전송을 붙여도 중복 기록 걱정이 없습니다.

```text
통화 중   MetricsCollected → addLatency (EOU·LLM 첫 토큰·TTS 첫 음성을 배열에 쌓음)
          Close 이벤트 → 끝난 이유 기록 (endCall이면 그 사유)
잡 종료   종료 콜백 → submitCallResult
            POST VOICE_RESULT_URL (functions-xtool submitVoiceCallResult)
            헤더 X-Voice-Agent-Secret: VOICE_AGENT_SECRET (공유 비밀키)
            본문 { callId, customer, startedAt, endedAt, endReason, transcript, latency }
            10초 시간 제한, 실패하면 로그만 남김
```

| 설계 | 이유 |
| --- | --- |
| **종료 콜백**에서 보냄 | 잡이 끝날 때 한 번. 세션이 닫힌 뒤라 대화 기록이 완성돼 있음 |
| 대화록 = `session.history`에서 user·assistant 글만 | 지시문·도구 호출은 뺌. 즉시 반응은 기록에 없으니 자연히 빠짐(11-6절). 테스트(`call-result.test.ts`)가 고정 |
| 공유 비밀키 헤더 | 서버끼리의 단순 인증. 키는 환경변수로만(`.env.example`에 자리만 있음). [README](../../README.md)의 "functions-xtool API(공유 비밀키 인증)"가 처음 구현된 곳 |
| 설정이나 `callId`가 없으면 보내지 않음 | 로컬 개발·콘솔 테스트(가상 고객, `callId` 없음)에서 운영 데이터가 생기지 않게 |
| `AbortSignal.timeout(10_000)` | 받는 쪽이 느려도 잡 종료가 무한히 늦어지지 않게 |
| 실패는 `.catch`로 로그만 | 결과 전송 실패가 종료 절차를 멈추면 안 됨. 대신 **결과가 유실될 수 있음** → 재전송 장치는 아직 없음 |

알아 둘 점입니다.

- **고객이 먼저 끊으면 언제 보내지나.** 종료 콜백은 잡이 끝날 때 돕니다. AI가 끊는 경로(`end_call`, `endCall`)는 `ctx.shutdown()`을 부르므로 바로 보내지만, 고객이 먼저 끊으면 세션만 닫히고 잡은 **방이 닫힐 때까지** 남습니다(4-7절). 그만큼 전송이 늦어졌습니다. 2026-11-04에 SDK 코드와 문서로 확인하고, 같은 날 `deleteRoomOnClose: true` 한 줄로 고쳤습니다. 지금은 고객이 끊어도 방이 바로 지워져 결과가 곧바로 갑니다. 고치기 전과 뒤의 시간표는 아래 "끝나는 경로별 시간표"에 있습니다.
- **대화록의 표기.** TTS alignment 때문에 assistant 말에 발음 변환된 글("에프투 울트라")이 남을 수 있습니다(10-6절, 17-2 #10). 받는 쪽의 판정 추출이 기기 이름을 찾을 때 영향을 줍니다.
- **세 번째 계약.** 전송 본문의 `CallTurn` 모양은 originalshq의 `voice-call/types.ts`와 맞춰야 합니다(파일 주석). 4-3절의 "계약이 두 곳에 적혀 있다는 위험"이 하나 더 생긴 셈입니다. 지금 있는 사본은 4-3절 표에 모두 모았습니다.
- 지연 기록에 섞이는 값은 13-5절을 봅니다.

### 받는 쪽 코드 읽기 (2026-11-04 추가)

> originalshq 커밋 `a7687d0`·`d57c577`·`d7054a1`의 `functions-xtool/src/endpoints/voice-agent.ts`, `voice-call/types.ts`, 관리 화면 `src/screens/log/`를 바탕으로 썼습니다. 이 레포 밖의 코드라 학습서에서는 읽기만 합니다.

함수 넷이 한 통화의 앞뒤를 맡습니다.

| 함수 | 종류 | 누가 부르나 | 인증 | 하는 일 |
| --- | --- | --- | --- | --- |
| `createVoiceAgentSession` | HTTP | 관리 화면 | Firebase 로그인 + 관리자 | 방 이름과 접속 토큰 발급, 에이전트 배정 (3-7절) |
| `submitVoiceCallResult` | HTTP | 에이전트 워커 | 공유 비밀키 헤더 | 검사 → `calls/{callId}` 생성 (`status: 'saved'`) |
| `extractVoiceCallJudgment` | Firestore 트리거 | 문서 생성 이벤트 | (내부) | Opus 5.5 판정 → 같은 문서에 `result` (8-11절) |
| `getVoiceCall` | HTTP | 관리 화면 (3초마다) | Firebase 로그인 + 관리자 | 문서 한 건 조회 |

#### 비밀키 비교: 왜 `===`가 아니라 `timingSafeEqual`인가

```ts
const secretMatches = (given: string | undefined, expected: string) => {
  if (!given) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}
```

보통의 문자열 비교는 **앞에서부터 보다가 다른 글자를 만나면 바로** 끝납니다. 그러면 앞 글자가 맞은 추측은 틀린 추측보다 아주 조금 늦게 거절됩니다. 공격자가 응답 시간을 아주 많이 재면 이 차이로 비밀을 한 글자씩 알아낼 수 있습니다. 이것이 **타이밍 공격**입니다. `timingSafeEqual`은 **어디서 달라지든 끝까지 같은 시간을 들여** 비교합니다(상수 시간 비교). 길이를 먼저 보는 것은 `timingSafeEqual`이 길이가 다른 두 값을 받으면 예외를 던지기 때문이고, 그 대가로 길이만은 드러납니다. 네트워크 잡음 때문에 실제로 성공하기는 어려운 공격이지만, 비용이 거의 없는 방어라 비밀 비교에는 늘 이렇게 씁니다.

순서도 볼 만합니다. 처음 판은 공통 껍데기(`endpoint`)가 본문 검사(400)를 먼저 하고, 비밀키 확인(401)은 본 처리에서 했습니다. 그래서 키 없는 요청도 검사 오류 문구로 본문의 모양을 알 수 있었습니다. (2026-11-05 갱신) originalshq `918c50a`에서 이 함수만 껍데기의 검사를 빼고, **비밀키를 먼저 확인한 뒤** 본 처리 안에서 `validateCallResult`를 부르도록 바뀌었습니다. 코드 주석은 "키 없이 부른 요청에는 입력 검사 문구도 보여 주지 않는다"입니다. 인증을 인가·검사보다 먼저 하는 것은 16-1절의 층 순서와 같습니다. 누군지 모르는 상대에게는 다음 층의 정보를 주지 않습니다.

#### 깊이 보기: 타이밍 공격은 왜 어려운가(ns 차이와 µs 흔들림) (2026-11-06 추가)

"네트워크 잡음 때문에 실제로 성공하기는 어렵다"를 숫자로 봅니다. [lab/15-timing.mjs](lab/15-timing.mjs)는 64자 무작위 비밀값을 첫 글자만 다른 추측, 마지막 글자만 다른 추측과 비교하는 시간을 재고, 같은 컴퓨터 안(127.0.0.1)의 HTTP 왕복이 얼마나 흔들리는지 잽니다(이 맥, 실측).

```text
== 1·2. 비교 한 번의 시간 (7회 중앙값) ==
   ===            첫 글자 다름 6.67ns, 마지막 글자 다름 11.22ns → 차이 4.55ns (글자당 약 0.072ns)
   timingSafeEqual 첫 글자 다름 61.6ns, 마지막 글자 다름 61.7ns → 차이 0.1ns (잡음 수준)

== 3. 127.0.0.1 HTTP 왕복 2,000번 ==
   평균 74µs, 표준편차 σ 25µs, p50 68µs, p99 165µs
```

- `===`는 실제로 앞에서부터 보다가 멈춥니다. 64자 전체를 다 봐야 할 때가 첫 글자에서 멈출 때보다 약 4.5ns 느렸고, 한 글자 차이로 나누면 0.07ns 남짓입니다. ns 단위 측정은 실행마다 흔들리므로 자릿수만 봅니다.
- `timingSafeEqual`은 어디서 달라지든 약 62ns로 같았습니다. `===`보다 10배쯤 느린 것은 JS에서 네이티브(C++)로 건너가는 비용으로 보입니다(추정). 요청 하나에 한 번이라 상관없습니다.

**몇 번 재야 가려낼 수 있나(손 계산).** 맞은 추측과 틀린 추측의 평균 응답 시간 차가 δ이고 응답마다 흔들림이 σ라면, 두 무리를 각각 n번 재서 평균을 비교할 때 평균 차의 흔들림은 σ·√(2/n)입니다. 이것이 δ의 1/3보다 작아야(z = 3) 믿을 만하게 가릅니다.

```text
n ≥ 2 · (z·σ / δ)²

같은 컴퓨터:  σ = 25µs = 25,000ns, δ = 0.072ns  →  n ≈ 2 · (3 × 25,000 / 0.072)² ≈ 2×10¹²번
인터넷(가정): σ = 1ms = 1,000,000ns              →  n ≈ 3×10¹⁵번
```

실습 4번이 같은 식에 실측값을 넣어 "후보 16개(hex)를 초당 1,000번씩 시험하면" 한 글자에 같은 컴퓨터에서도 약 10³년, 인터넷이면 약 10⁶년이라고 냅니다(실행마다 조금 다름). 64글자면 64배입니다. 실제 연구는 평균 대신 최솟값·백분위수 같은 더 나은 통계와 LAN 환경으로 수백 ns 차이까지 가려낸 적이 있다고 알려져 있으므로(확인 필요, 문헌 기억), 숫자가 크다고 마음 놓을 것은 아닙니다. 문자열이 길거나 비교가 무거운 다른 코드라면 차이가 µs로 커질 수 있습니다. `timingSafeEqual`은 이런 계산을 할 필요조차 없게 만드는 값싼 습관입니다.

- 길이를 먼저 비교하는 부분(`a.length === b.length`)은 길이를 드러냅니다. 비밀키 길이는 공개돼도 되는 값이라 괜찮습니다. 길이까지 숨기려면 양쪽을 같은 해시(예: SHA-256)로 바꾼 뒤 비교합니다(일반론).
- 이 방어는 Cloud Functions 앞단의 지연·흔들림(수 ms)과 겹쳐 더 강해집니다. 공격 가능성보다 **비밀키 유출**(로그, 이미지, 15-4절의 `.history/`)이 훨씬 현실적인 위험입니다.

#### 처음 것만 남기기: `create()`와 멱등 키

```ts
const created = await db.collection(CALLS).doc(data.callId).create(record)
  .then(() => true)
  .catch((error) => {
    if (error.code === 6) return false // ALREADY_EXISTS
    throw error
  })
response.status(created ? 201 : 200).send({ callId: data.callId, created })
```

| Firestore 쓰기 | 문서가 이미 있으면 | 성질 |
| --- | --- | --- |
| `set()` | 덮어씀 | 마지막 것이 이김 (last-write-wins) |
| `create()` | **실패** (`ALREADY_EXISTS`, gRPC 상태 코드 6) | 처음 것이 이김 (first-write-wins) |

여기서 `callId`가 **멱등 키(idempotency key)** 역할을 합니다. 같은 통화를 두 번 보내도 기록은 한 건이고, 두 번째 요청도 오류가 아닌 200(`created: false`)을 받습니다. 네트워크에서는 "요청은 처리됐는데 응답만 잃어버린" 경우가 있습니다. 그래서 다시 보내는 쪽은 받는 쪽이 멱등이라는 전제가 있어야 안전합니다. 에이전트에 재전송을 붙일 때 받는 쪽은 이미 준비돼 있는 셈입니다.

#### 저장과 판정을 나눈 이유: 이벤트로 잇기

```text
에이전트 ──POST──▶ submitVoiceCallResult ──create──▶ calls/{callId}  (status: saved)
                     └ 201 응답 (판정을 기다리지 않음)        │ 문서 생성 이벤트
                                                            ▼
                                            extractVoiceCallJudgment (제한 120초)
                                              ├ 성공: status: analyzed, result, analysisModel, analyzedAt
                                              └ 실패: status: analysis_failed, analysisError
```

- **에이전트가 모델 응답을 기다리지 않습니다.** HTTP 요청 안에서 판정까지 하면 에이전트의 종료 콜백이 판정 시간(실측 8.5초, [6-web-test.md 5장](../6-web-test.md#5-확인한-것-2026-11-03))만큼 묶이고, 전송 10초 제한에 걸리면 저장까지 실패한 것처럼 보입니다. 저장만 하고 바로 답하니 전송은 짧고 확실합니다.
- **상태 기계.** `saved → analyzed | analysis_failed`. 화면은 `saved`가 아니게 될 때까지 조회합니다. 실패도 상태로 남기 때문에 "왜 결과가 없지?"를 문서만 보고 알 수 있습니다.
- **이벤트는 최소 한 번(at-least-once) 전달됩니다.** 클라우드 트리거는 드물게 같은 이벤트로 함수를 두 번 부를 수 있습니다. 그러면 판정이 두 번 돌고 나중 결과로 덮어씁니다. 비용이 한 번 더 들 뿐 기록이 망가지지는 않습니다. "정확히 한 번"을 보장하는 대신 **두 번 일어나도 괜찮게** 만드는 것이 분산 시스템의 흔한 선택입니다.
- **트리거가 지켜보는 DB를 맞춰야 합니다.** functions-xtool은 이름 있는 Firestore 데이터베이스 `xtool-read`를 씁니다(`getFirestore('xtool-read')`). 트리거에도 `database: 'xtool-read'`를 적어야 하고, 빠뜨리면 기본 데이터베이스를 지켜보므로 **오류 없이 트리거가 영영 돌지 않습니다.** 지금 코드는 맞게 되어 있습니다.
- **입력 상한.** 대화록 400턴, 한 줄 4,000자. 8분 통화 상한(5-5절)을 기준으로 넉넉하게 잡은 값입니다. 지연 기록은 모양이 틀리면 **버리고 저장은 계속합니다**("판정이 더 중요하다"). 숫자가 아닌 값이 하나라도 있으면 지연 기록 전체가 빠집니다. SDK 지표의 "값 없음"은 `-1`이라 이 검사를 통과하므로, 에이전트 쪽에서 미리 거릅니다(13-5절, 2026-11-04 고침).
- **트리거가 시간 제한(120초)에 걸려 강제로 끝나면** `catch`가 돌지 않아 문서가 `saved`로 남습니다. 그러면 화면은 2분 뒤 "에이전트의 통화 결과 전송 설정(VOICE_RESULT_URL)을 확인하라"고 안내하는데, 이때는 전송이 아니라 판정이 멈춘 것이라 안내가 엉뚱한 곳을 가리킵니다(17-2 #24).

#### 끝나는 경로별 시간표 (웹 테스트, 2026-11-04 갱신)

| 경로 | 순서 | 결과가 화면에 뜨기까지 |
| --- | --- | --- |
| **AI가 끝냄** (`end_call`, 무응답, 최대 길이) | 작별 인사 재생 → `ctx.shutdown()` → 세션 닫힘 → **RoomIO가 방 삭제** → 브라우저 연결 끊김, 화면이 조회 시작 → 에이전트가 방에서 나감 → 종료 콜백(결과 전송) | 전송은 바로, 판정 수 초 |
| **직원이 "통화 끝내기"** (전화라면 고객이 끊음) | 브라우저가 나감(`CLIENT_INITIATED`) → RoomIO가 세션을 닫음 → **RoomIO가 방 삭제** → 에이전트 연결 끊김 → 잡 종료 → 종료 콜백(결과 전송) | 위와 같음 |

두 줄이 같아진 것은 `deleteRoomOnClose: true`를 켠 뒤입니다(17-2 #21 고침, 4-7절 "방 삭제를 한곳으로 모으기"). 고치기 전 두 번째 줄은 이랬습니다.

> 브라우저가 나감 → RoomIO가 세션을 닫음 → **잡은 그대로** → 에이전트만 남은 방은 유예 시간(`departure_timeout`) 뒤에 닫힘 → 에이전트 연결 끊김 → 잡 종료 → 종료 콜백(결과 전송). 결과는 방 유예 시간만큼 늦게 떴고, 그동안 화면은 "통화 기록을 기다리는 중…"이었습니다.

SDK 코드(`ipc/job_proc_lazy_main.ts`, `voice/room_io/room_io.ts`)와 LiveKit 문서로 확인한 원인은 이렇습니다.

- 잡을 끝내는 것은 `ctx.shutdown()` 또는 **방 연결 끊김** 등이고(4-7절), 세션이 닫히는 것만으로는 잡이 끝나지 않습니다.
- LiveKit은 **에이전트가 아닌 마지막 참가자**가 나가면 방을 닫는데, 바로 닫지 않고 방 설정의 유예 시간(`departure_timeout`)을 기다립니다.
- 화면은 최대 2분 기다리므로 웹 테스트에서는 결과가 늦게 뜰 뿐 빠지지는 않았습니다. "접속했다 나가자 종료 사유 `participant_disconnected`로 결과를 보냄"이 확인돼 있습니다(6-web-test.md 5장, 지연 시간은 기록 없음). 전화에서도 고객 쪽 끊음(BYE)은 `CLIENT_INITIATED`로 오므로 같은 경로입니다.

해결은 한 줄이었습니다. 세션 시작 옵션 `inputOptions`에 **`deleteRoomOnClose: true`를** 넣으면 세션이 닫힐 때 RoomIO가 방을 지우고, 방이 지워지면 에이전트 연결이 끊겨 잡이 곧바로 끝납니다. LiveKit 문서는 이 옵션을 Python 전용으로 표시하지만, 설치된 Node SDK 1.9.5에도 공개 타입(`RoomInputOptions.deleteRoomOnClose`)으로 있습니다(17-2 #23). 다른 방법은 세션 `Close` 이벤트에서 `ctx.shutdown()`을 부르는 것이었습니다. 그 방법은 잡은 끝내지만 방을 지우지 않습니다. 전화라면 고객이 이미 끊었으니 상관없지만, 방을 지우는 일을 한곳으로 모으려고 `deleteRoomOnClose`를 골랐습니다.

남은 확인: 실제 웹 통화에서 "통화 끝내기"를 누른 뒤 에이전트 로그에 `deleting room on agent session close`가 찍히고 결과가 몇 초 안에 뜨는지 봐야 합니다. 텍스트 디버거는 방을 쓰지 않아 이 경로를 지나지 않습니다.

#### 화면: 조회(polling)로 기다리기

`VoiceCallResult`는 통화가 끝나면 `getVoiceCall`을 3초마다 부르고, 문서가 `saved`가 아니게 되거나 2분이 지나면 멈춥니다. 문서가 아직 없으면(404) 계속 기다립니다. 실시간 구독(`onSnapshot`)을 쓰면 더 빠르겠지만, 그러려면 브라우저가 Firestore를 직접 읽어야 하고 보안 규칙을 따로 짜야 합니다. 지금 구조는 개인정보가 든 대화록을 **관리자 확인을 거치는 함수로만** 읽게 합니다. 몇 초의 실시간성을 내주고 접근 경로를 하나로 묶은 선택으로 볼 수 있습니다.

같은 화면이 지연 기록의 **평균**을 보여 줍니다(말 끝 판단, LLM 첫 토큰, TTS 첫 음성). 13-6절에서 본 것처럼 평균은 꼬리를 숨깁니다. 13-5절의 섞이던 값 중 `-1`과 미리 합성 몫은 2026-11-04에 걸렀지만(17-2 #20), 취소된 생성은 일부러 남겼고 `-1`을 뺀 만큼 평균은 약간 낙관적입니다. 한 통화의 대략을 보는 용도로 읽어야 합니다.

### 앞으로 필요한 것

| 무엇 | 왜 |
| --- | --- |
| 통화별 결과 저장 이후 | 저장·판정·조회는 됨 (위, 2026-11-04 기준). 남은 것: 에이전트 쪽 재전송, Monday 반영, 상담사 알림, 통계 |
| 지연 백분위수 대시보드 | 꼬리 지연 감시 (13-6절) |
| 오류율 (STT·LLM·TTS 연결 실패) | 공급사 장애 감지 |
| 통화당 비용 | [2-tech-stack.md 9장](../2-tech-stack.md#9-비용-추정)의 추정 검증 |
| 이상 알림 | 통화량 급증, 실패 급증 |

---

## 15-7. 장애에 대한 설계: 공급사가 죽으면

(2026-11-08 추가) 여기서 공급사가 "죽는다"는 것은 그 API가 오류(429 요청 과다, 5xx 서버 오류)를 돌려주거나, 정해진 시간 안에 답하지 않거나, 연결 자체가 맺어지지 않는 상태를 말합니다. 공급사 쪽 장애는 우리 코드로 막을 수 없으므로 할 수 있는 일은 둘입니다. 다른 공급사로 넘기거나(대체 경로), 기능을 줄여 계속 도는 것(우아한 강등, graceful degradation)입니다. LiveKit은 앞의 것을 위해 **FallbackAdapter**를 줍니다. 같은 종류의 부품(STT·LLM·TTS) 여러 개를 순서대로 두고, 앞의 것이 실패하면 다음 것으로 넘기는 감싸기 클래스입니다. Node SDK에도 셋 다 있지만(`agents/stt/fallback_adapter.ts`, `agents/llm/fallback_adapter.ts`, `agents/tts/fallback_adapter.ts`) 이 레포는 아직 쓰지 않습니다.

외부 API 세 개(Soniox, Anthropic, ElevenLabs)에 의존하므로, 하나만 멈춰도 통화가 멈춥니다. 현재 상태와 선택지입니다.

| 부품 | 지금의 동작 | 선택지 |
| --- | --- | --- |
| STT | 연결 오류 시 코어가 0.5초 뒤 스트림 재생성 | LiveKit의 STT FallbackAdapter (여러 STT를 순서대로) |
| LLM | 첫 출력 전 429·5xx만 재시도. 출력이 시작된 뒤 실패하면 재시도 안 함. (2026-11-06 갱신) Anthropic 경로는 연결 오류·시간 초과·스트림 중 `error`도 재시도하지 않고, Bedrock 경로는 거꾸로 400·403까지 세 번 재시도함. 시도당 10초 제한은 응답 머리글까지만 걸림(8-7절, 17-2 #37) | LLM FallbackAdapter, 첫 토큰 시간 초과 시 다른 모델 ([2-tech-stack.md 4-3](../2-tech-stack.md#4-3-llm-대화-두뇌)의 "백업 모델") |
| TTS | 텍스트 보낸 뒤 10초 안에 오디오 없으면 시간 초과 | TTS FallbackAdapter |
| 턴 감지 | 클라우드 실패 시 로컬 mini로 자동 전환 | 이미 있음 |
| 적응형 끼어들기 | 실패 반복 시 VAD 방식으로 전환 | 이미 있음 |
| 노이즈 제거 | 실패 시 원본 통과 | 이미 있음 |

LiveKit 자체 부품들(턴 감지, 끼어들기, 노이즈 제거)은 **실패하면 더 단순한 방식으로 내려가는(graceful degradation)** 설계가 이미 들어 있습니다. 외부 공급사 쪽은 우리가 FallbackAdapter 등으로 설계해야 합니다. "LiveKit Inference(별도 키 없음)"를 대체 경로로 두면 공급사 계정 문제에도 대비할 수 있습니다. 이 프로젝트의 `config.ts`가 이미 `livekit` 공급사를 지원하는 것은 이런 확장의 바탕이 됩니다.

#### 깊이 보기: 고객이 듣는 최악의 침묵, 그리고 취소의 비용 (2026-11-06 추가)

장애 설계는 "죽으면 바꾼다"만이 아니라 **바꾸기 전까지 고객이 얼마나 기다리나**를 정하는 일입니다. 8-7절 깊이 보기가 LLM 경로를 코드와 가짜 서버로 따라가 계산한 표를 가져옵니다(왕복 r = 0.3초 가정). 고객 말이 끝나면 즉시 반응("네네")이 먼저 나가고, 그 뒤부터 첫 답 글까지가 침묵입니다. 답이 끝내 없으면 고객 자리비움 타이머(`userAwayTimeout` 10초, [src/call-guard.ts](../../src/call-guard.ts))가 "여보세요? 제 목소리 잘 들리세요?"를 내보냅니다.

(2026-11-08 갱신) 이 타이머는 고객과 에이전트가 **둘 다** 듣기 상태(`listening`)일 때만 돕니다. 처음 판은 본 답을 기다리는 동안에는 에이전트가 듣기 상태가 아니라고 보고 "실패 + 10초"로 셌습니다. 그런데 즉시 반응은 본 답과 따로 내보내는 말이라, 그 재생이 끝나면 상태 임대가 풀려 에이전트 상태가 `listening`으로 돌아갑니다. 그래서 **본 답을 기다리는 동안에도 10초 타이머가 돕니다**. 즉시 반응을 한 턴의 "여보세요?"는 대략 `max(실패 시각, 즉시 반응 끝 + 10초) + TTS 첫 음성`에 나갑니다. 11장 글쓴이가 코드로 확인하고, 실제 `AgentSession`에 이 레포의 `createAgent`·`guardCall`을 얹고 LLM·TTS만 가짜로 바꿔 재현했습니다. 같은 날 `guardCall`을 고친 뒤(17-2 #56 대응) 다시 재현해도 실패한 경우의 시각은 같았습니다. 흐름과 고친 방법은 [11-6절 깊이 보기 "본 답을 기다리는 동안 도는 10초 타이머"](11-session-pipeline.md#깊이-보기-본-답을-기다리는-동안-도는-10초-타이머-2026-11-08-추가)에 있습니다.

| 상황 | 실패까지 | "여보세요?"까지: 즉시 반응을 한 턴 (보통) | 즉시 반응을 건너뛴 턴 |
| --- | --- | --- | --- |
| 529가 바로 돌아옴 (재시도 3번: 100ms, 2초, 2초) | 5.3초 | 약 11초 (재현 11.12초) | 약 15.3초 (재현 15.93초) |
| 시도마다 10초 가까이 끌다 5xx | 44.1초 (계산상 최대) | 약 44∼45초, 실패 직후 (재현 44.71초) | 약 54초 |
| 응답 머리글이 오지 않음 | 10초 (시간 초과는 재시도 안 함) | 약 11초 (재현 11.10초) | 약 20초 |
| 머리글 뒤 스트림이 멈춤 | 한도 없음 | 나가지 않음(추정). `guardCall`이 끝나지 않은 본 답을 기다리며 묻지 않음(그 전에는 본 답 뒤에 줄을 선 채 남음) | 같음 |
| Bedrock 403 (모델 자격 없음) | 약 5.3초 (재시도할 필요 없는데 3번) | 약 11초 | 약 15.3초 |

표 읽는 법입니다. "실패까지"는 LLM 요청을 시작한 때부터 잰 계산값입니다. 오른쪽 두 열의 "약 …초"는 같은 기준의 어림이고, 괄호 안 재현 값은 고객의 마지막 말소리를 0으로 잰 실측이라 턴 확정(약 0.4초)과 가짜 TTS 첫 음성(0.17초)이 더 들어 있습니다. 셋째 열과 넷째 열이 갈리는 이유가 즉시 반응입니다. 즉시 반응을 건너뛴 턴(수신 거부·불만·사람 요청, `shouldAck`가 거짓, 11-6절)은 본 답의 "생각 중" 상태가 실패까지 이어지므로 처음 판의 셈("실패 + 10초") 그대로입니다.

- (2026-11-08 갱신) **늦게 성공했을 때 (고침).** 처음 코드는 본 답이 약 10.5초 넘게 늦게라도 성공하면, 본 답 바로 뒤에 "여보세요? 제 목소리 잘 들리세요?"를 이어서 냈습니다(재현: 12초 뒤 성공 → 15.51초에 "여보세요?"). 타이머가 끝난 순간 `guardCall`이 그 말을 대기열에 넣어 두었기 때문입니다. 고객은 답을 듣자마자 "들리세요?"를 한 번 더 들었습니다. 지금 `guardCall`은 끝나지 않은 본 답이 있으면 묻지 않고, 늦게 온 답을 말한 뒤 10초를 다시 기다립니다(재현 25.50초, 5-5절·11-6절, 17-2 #56 대응).
- FallbackAdapter를 붙인다면 **이 시간 안에** 다음 모델로 넘어가야 의미가 있습니다. (2026-11-08 갱신) 처음 코드에서는 즉시 반응을 한 턴의 실질적인 한도가 약 10초였습니다. 그보다 늦으면 다음 모델의 답보다 "여보세요?"가 먼저 나가거나 답 뒤에 붙었습니다. 지금은 `guardCall`이 끝나지 않은 본 답을 기다리므로 그런 일은 없습니다. FallbackAdapter는 LLM을 감싼 LLM이라 다음 모델로 넘어가도 같은 본 답 안의 일이기 때문입니다(`llm/fallback_adapter.ts`의 `FallbackAdapter`·`FallbackLLMStream`, 코드 구조로 추론). 그래도 고객이 듣는 침묵은 그대로 길어집니다. 지금은 재시도 판정이 경로마다 어긋나 있어(17-2 #37), 대체 경로를 붙이기 전에 "무엇을 실패로 보고 언제 포기하나"부터 정해야 합니다. 특히 머리글 뒤에 멈춘 스트림은 어떤 제한에도 걸리지 않으므로, 첫 글 조각까지의 시간 제한을 따로 두는 설계가 필요합니다(제안).
- 운영 지표로는 턴마다 "고객 말 끝 → 첫 답 음성" 시간의 꼬리(p99)와, 위 표의 실패 로그 빈도를 봅니다(13-6절).

**취소된 요청은 끝까지 간다(17-2 #41, 12-8절).** 고객이 끼어들거나 선제 생성이 버려지면 LiveKit 쪽 스트림은 닫히지만, Anthropic 플러그인이 HTTP 요청에 취소 신호를 넘기지 않아 **모델은 답을 끝까지 만들고 그만큼 출력 토큰이 과금됩니다**(가짜 서버는 취소 뒤에도 글 조각 20/20개를 다 보냄, `lab/11-preemptive.mjs` H). 장애 관점에서는 두 가지입니다.

- 비용: 끼어들기가 잦은 통화일수록 보이지 않는 출력 토큰이 늘어납니다. 버려진 선제 시도 하나는 한 턴 값입니다(11-4절의 손 계산). 통화당 비용 지표(15-6절 "앞으로 필요한 것")를 만들 때 `usage`가 취소된 요청까지 세는지 함께 봐야 합니다.
- 연결: 취소된 요청이 응답을 다 받을 때까지 연결을 붙잡으므로, 공급사가 느려지는 장애 때는 붙잡힌 연결이 쌓입니다(추정). 동시 요청 한도가 있는 요금제라면 장애를 키울 수 있습니다.

---

## 15-8. 보안·법무 체크리스트

(2026-11-08 추가) 배포 전과 운영 중에 한 번씩 확인할 항목을 모은 표입니다. "영역"은 무엇을 지키려는 것인지, "항목"은 확인할 일, "근거"는 자세한 내용이 있는 절이나 문서입니다. 앞의 절들에서 찾은 비밀값·개인정보 문제가 여기로 모입니다.

| 영역 | 항목 | 근거 |
| --- | --- | --- |
| 비밀값 | `.env.local` 커밋 금지, 운영은 Secret, LiveKit Cloud는 `--secrets-file` (임시 파일도 `.gitignore`) | [4-setup-checklist.md 10장](../4-setup-checklist.md#10-커밋-전-확인), 15-5 |
| 웹 테스트 접근 | 토큰 발급 함수가 Firebase 로그인 + 관리자 확인. 외부 공개 전 횟수 제한·봇 차단·동의 문구 필요 | 3-7, [6-web-test.md 7장](../6-web-test.md#7-주의) |
| 테스트 직원 고지 | 내부 테스트도 실제 음성이 해외 API로 감 | [6-web-test.md 7장](../6-web-test.md#7-주의) |
| 비용 폭탄 | Anthropic 월 사용 한도, SIP 국제전화 차단·발신 규칙·방화벽 | [7-telephony-setup.md 7장](../7-telephony-setup.md#7-보안-요금-폭탄-막기) |
| 클라우드 자격 증명 (2026-11-05 추가) | AWS는 Bedrock 호출만 허용한 좁은 정책, 장기 키 대신 연동 검토, 쓰지 않는 키 삭제, 예산 알림. 키 값·계정 ID를 공개 레포·스크린샷에 남기지 않음 | 16-5, 16-9 |
| 공급망 | `allowBuilds`, lockfile 고정, 패치 최소화. (2026-11-06 추가) lockfile이 패키지마다 SHA-512(integrity), 패치 파일은 SHA-256으로 묶음. 정상 절차로 올라온 악성 새 판은 못 막음 | 15-3절 깊이 보기 |
| 빌드 컨텍스트의 비밀값 (2026-11-06 추가) | `.dockerignore`의 `.env.*`는 루트의 이름만 막았음. 작업 폴더의 `.history/`(편집기 로컬 기록)에 있던 `.env` 사본 47개가 로컬 `docker build`의 컨텍스트에 들어가 **최종 이미지에 실릴 수 있었음**. LiveKit Cloud 업로드는 `.gitignore`도 빼서 해당 없었음. (2026-11-06 갱신) `.history/`·`**/.env*`를 `.dockerignore`에 더해 고침(`4bc8d72`). 이미지 빌드 전 실습 1번으로 0개인지 확인 | 15-4절 깊이 보기, `lab/15-docker-cache.mjs` |
| TTS 공급사의 기록 (2026-11-06 추가) | ElevenLabs 플러그인의 `enable_logging` 기본값이 `true`이고 `createTTS`가 바꾸지 않음. 고객 이름이 든 첫 멘트가 공급사 기록에 남을 수 있음. 보관하지 않는 방식(zero retention, `false`)은 엔터프라이즈 전용(ElevenLabs 문서). 계약·처리방침·고지에서 다룰 항목 | 10-3절 깊이 보기, 17-2 #40 |
| 녹음 임시 파일 (2026-11-08 추가) | 세션 녹음이 켜져 있으면 고객·에이전트 음성이 `os.tmpdir()/livekit-agents/job-<잡 id>/audio.ogg`로 남고, SDK 1.9.5는 올린 뒤에도 지우지 않음. 파드·인스턴스 디스크에 개인정보가 통화마다(8분 통화 약 5∼8MB, 추정) 쌓임. 지우는 장치, 디스크 접근 권한, 보관 기간을 정함 | 15-6절 "LiveKit Cloud 세션 리포트", 15-5절 표의 `/tmp` |
| 웹 테스트 토큰 (2026-11-06 추가) | 토큰의 `roomConfig.agents[0].metadata`에 고객 이름 등이 평문 JSON으로 실림. JWT는 서명일 뿐 암호화가 아니라 토큰을 가진 사람은 누구나 읽음. 토큰을 로그·오류 보고에 남기지 않기. 전화(SIP)는 서버끼리 디스패치하므로 해당 없음 | 3-7절 깊이 보기, 17-2 #29 |
| 고지 | AI·녹음 고지를 고정 문장으로, 끼어들기 막음 | 9장 |
| 고지 타이밍 | 전화를 **받은 뒤** 고지가 재생되는지 (`waitUntilAnswered`) | 4-6절 |
| 개인정보 수집 | 주민번호·카드번호 묻지 않음 (지시문 + 시나리오) | 9장 |
| 수신 거부 | "전화하지 마세요" → 즉시 종료 (기록 도구는 예정) | 9장 |
| 발신 시간 | 08∼21시 (functions-xtool이 검사 예정) | [2-tech-stack.md 6장](../2-tech-stack.md#6-전체-아키텍처) |
| 국외 이전 | 해외 API(Soniox, Anthropic, ElevenLabs, LiveKit Cloud)로 음성·대화가 감 | 법무 검토 |
| 녹음 활용 | 학습 용도로 쓰려면 동의 범위 확인 | [4-setup-checklist.md 7-8](../4-setup-checklist.md#7-상담팀업무-쪽에서-정해-줄-것) |

---

## 15-9. 정리

(2026-11-08 갱신) 2026-11-06·11-08 판에서 더한 내용을 함께 적었습니다. 왼쪽 낱말이 주제이고, 오른쪽이 이 장의 결론입니다.

```text
설정    환경변수 → loadConfig (빨리 실패, 단 통화가 시작될 때 실패함 → 워커 시작 때 한 번 더 검사 제안)
        → 팩토리 (완전성 검사: strict의 TS2366, never 관용구 권장)
코드    Node 24가 .ts를 바로 실행 (타입 자리를 공백으로 덮음, 소스맵 불필요) ← tsc는 검사만 (엄격 옵션)
        bundler 해석은 확장자 없는 import를 못 잡음 → nodenext 제안 (레포 오류 0개)
의존성  pnpm 12.16.1 고정, lockfile(SHA-512 integrity, 패치 SHA-256), allowBuilds·overrides·patch
이미지  다단계 빌드, ca-certificates, 비루트, exec CMD (SIGTERM → drain)
        설치 전에 pnpm-workspace.yaml·.npmrc·patches 복사 (lockfile 검사가 잡아 준 문제, 고침)
        캐시 키 = 앞 키 + 명령 문자열 + 복사한 파일 체크섬. 마지막 COPY --from은 node_modules째 다시 올라감
        COPY . .는 작업 폴더를 봄 → .history/의 .env 사본(.dockerignore 보강, 2026-11-06 고침), docs/ 주의
        PID 1은 처리기 건 신호만 받고 고아를 거둬야 함. 녹음 ffmpeg가 고아가 되면 좀비가 남음 → tini는 값싼 방어
배포    LiveKit Cloud(원격 빌드, v1·적응형 기본, 미국·유럽·뭄바이 리전, 재배포 때 최대 1시간 기다림) 또는 GKE 서울
        아직 둘 다 만들지 않음(livekit.toml 없음). 웹 테스트는 맥의 lk agent dev
        GKE면 유예 660~720초 제안(GKE 축소는 10분에서 자름), 헬스 체크 8081을 probe 셋에 나눔,
        CPU 한도는 정수로(availableParallelism은 내림, 빈자리 데우기 약 0.6초씩 차례로),
        메모리 ≈ 1.0GB(2 CPU, 통화 0) + 통화당 (236 + x)MB, OOM은 파드 전체
관측    JSON 로그(callId·jobID로 통화별 모음), LiveKit Cloud 세션 리포트 (개인정보 검토), 종료 절차의 스팬,
        루프 막힘·종료 코드 143/137·결과 전송 실패·entry 실패 로그. 잡의 처리 안 된 거부는 debug라 안 보임
        세션 단위 MetricsCollected는 LiveKit 문서상 사용 중단(1.9.5 코드에는 표시 없음, SDK 올릴 때 확인)
        녹음 audio.ogg는 올린 뒤에도 임시 폴더에 남음(SDK 1.9.5) → 지우는 장치 필요
장애    LiveKit 부품은 자동 강등, 외부 공급사는 FallbackAdapter 설계 필요
        LLM 실패까지 5.3초~44.1초(머리글 뒤 멈춤은 무한). 즉시 반응 뒤에도 10초 타이머가 돌아
        "여보세요?"는 약 11초부터 나감. 취소된 요청도 끝까지 과금
```

---

## 확인 문제

1. `pick()`이 잘못된 값을 받았을 때 기본값으로 가지 않고 오류를 내는 이유는?
2. (2026-11-06 갱신) `SttProvider`에 `'rtzr'`을 추가하고 `createSTT`에 `case`를 빼먹으면 어떻게 됩니까? 어떤 옵션이 그 오류를 냅니까? `noImplicitReturns`를 끄면 달라집니까?
3. `exactOptionalPropertyTypes`가 켜진 상태에서 `voiceId: config.voice`(값이 undefined일 수 있음)를 그대로 쓰면 왜 안 됩니까?
4. 타입만 쓰는 import를 `import type` 없이 쓰면 Node에서 무슨 일이 생깁니까?
5. Dockerfile의 CMD를 셸 형식으로 바꾸면 배포 때 어떤 문제가 생길 수 있습니까?
6. 고치기 전 Dockerfile의 설치 단계가 실패한 이유와, 실패하지 않았다면 생길 수 있었던 더 위험한 문제는?
7. (2026-11-06 추가, 손 계산) GKE에서 SIGTERM이 막 시작한 통화 하나가 있을 때 왔습니다. 배정·세션 시작 3초, 통화 최대 8분, 끝인사 6초, 종료 절차 20초이고, 파드에 `preStop`으로 `sleep 10`을 두었습니다. (가) `terminationGracePeriodSeconds`는 최소 몇 초여야 합니까? (나) 기본값 30초로 두면 파드에 어떤 종료 코드가 남고, 통화와 통화 결과는 어떻게 됩니까? (다) `G`를 720초로 두었는데 이 파드가 노드 축소로 내려가면 무엇이 달라질 수 있습니까?
8. (2026-11-06 추가, 손 계산) 이 레포의 Dockerfile에서 (가) `pnpm-workspace.yaml`의 `allowBuilds`만 고쳤을 때, (나) `knowledge/xtool.md`만 고쳤을 때 각각 어느 줄부터 다시 돕니까? 레지스트리에 새로 올라가는 큰 레이어는 무엇입니까? (다) 최종 단계에서 `COPY --chown` 대신 `COPY`한 뒤 `RUN chown -R appuser /app`을 따로 두면 이미지 크기는 어떻게 됩니까?
9. (2026-11-06 추가) 다음을 `node`로 바로 실행하면 각각 어떻게 됩니까? (가) `enum Mode { Off, Adaptive }`가 든 `.ts` (나) `import { x } from './b'`(확장자 없음). 이때 이 레포의 `pnpm typecheck`는 통과합니까? (다) 타입 표기가 많은 줄에서 던진 오류의 스택 추적 열 번호가 소스맵 없이도 원본과 맞는 이유는?
10. (2026-11-06 추가, 손 계산) GKE 파드에 CPU limit 1.5를 주었습니다(`cpu.max` = `150000 100000`). (가) `os.availableParallelism()`, 유휴 프로세스 수, 부하 계산에 쓰는 CPU 수는 각각 얼마입니까? (나) 2.5초 동안 `usage_usec`이 2,100,000 늘었다면 load는 얼마이고 새 잡을 받습니까? (다) limit 없이 request만 1.5로 주면(노드 16코어) 무엇이 달라집니까?
11. (2026-11-08 추가, 손 계산) CPU limit 1.5인 파드(유휴 프로세스 1개)에 통화 세 개가 거의 동시에 왔습니다. 잡 프로세스 하나를 데우는 데 0.6초가 걸린다고 봅니다. (가) 두 번째와 세 번째 통화는 각각 약 몇 초 늦게 시작합니까? (나) limit을 2로 올리면 어떻게 달라집니까? (다) limit 2에서 세 통화가 모두 진행 중일 때 메모리 어림은 얼마입니까(통화 하나가 더하는 몫 x = 100MB 가정)?
12. (2026-11-08 추가) 즉시 반응("네네", 0.5초)을 한 턴에서 LLM 요청이 529로 세 번 재시도한 끝에 5.3초 뒤 실패했습니다. 턴 확정은 고객의 마지막 말소리 뒤 0.4초, TTS 첫 음성은 0.17초로 봅니다. (가) "여보세요?"는 마지막 말소리로부터 대략 몇 초에 나갑니까? (나) 같은 실패가 즉시 반응을 건너뛴 턴(수신 거부 등)에서 나면 몇 초입니까? (다) 본 답이 실패하지 않고 12초 뒤에 성공해 15.3초까지 재생됐다면 고객은 무엇을 듣습니까? 처음 코드와 지금 코드를 나눠 답하십시오.

<details>
<summary>답 보기</summary>

1. 오타가 조용히 기본값으로 바뀌면 설정이 안 먹었다는 사실을 아무도 모르기 때문입니다. 시작할 때 실패해야 바로 고칩니다. 다만 이 레포는 `loadConfig()`를 `entry` 안에서 부르므로, 실패가 워커 시작이 아니라 첫 통화에서 드러납니다. 헬스 체크도 통과하므로 워커가 뜰 때 한 번 더 검사하는 편이 낫습니다(15-1절).
2. (2026-11-06 갱신) 컴파일 오류 **TS2366**("Function lacks ending return statement and return type does not include 'undefined'")이 함수의 반환 타입 자리에 납니다. 반환 타입 `stt.STT`를 적었고 `strict`에 든 `strictNullChecks`가 켜져 있어서, `switch`를 빠져나가 `undefined`를 돌려주는 경로가 허용되지 않기 때문입니다. `noImplicitReturns`를 꺼도 똑같이 실패합니다. `noImplicitReturns`(TS7030)는 반환 타입을 추론에 맡긴 함수에서만 따로 의미가 있습니다. `default: { const unhandled: never = provider; throw … }`를 두면 모든 설정에서 `switch` 안에 `Type '"rtzr"' is not assignable to type 'never'`가 뜨고, 런타임에도 그 자리에서 실패합니다([lab/15-tsc-checks.mjs](lab/15-tsc-checks.mjs)).
3. 선택 속성에 `undefined`를 명시적으로 넣는 것이 타입 오류이고, 라이브러리에 따라 `undefined`가 기본값을 덮어쓰는 버그가 생길 수 있기 때문입니다.
4. Node는 `import type`만 지우므로 일반 import가 남고, 런타임에 그 이름의 export가 없다는 오류가 납니다(`SyntaxError: … does not provide an export named …`, 실습으로 확인). 이 레포에서는 `verbatimModuleSyntax`가 tsc 단계에서 먼저 잡습니다.
5. (2026-11-06 갱신) `/bin/sh -c "…"`의 셸이 먼저 PID 1이 됩니다. 셸이 명령 하나를 exec하면 node가 PID 1을 물려받아 괜찮지만(이 맥의 sh·dash에서 실측, 이미지의 dash는 확인 필요), 명령이 둘 이상이거나 래퍼를 끼우면 셸이 남습니다. 그러면 SIGTERM이 node에 전달되지 않아 drain이 일어나지 않고(PID 1인 셸은 처리기가 없어 신호를 무시), 유예 시간이 지나면 SIGKILL로 진행 중인 통화가 강제로 끊깁니다. 셸에 기대지 않도록 exec 형식을 씁니다.
6. 설치 시점에 `pnpm-workspace.yaml`이 없어 lockfile의 overrides 설정과 어긋났기 때문에 `--frozen-lockfile`이 실패했습니다. 이 검사가 없었다면 `patches/` 없이 빌드되어, 오류 없이 말 끝 판단만 다시 느려지는 회귀가 생겼을 수 있습니다.
7. (가) `G`는 preStop이 시작될 때부터 세므로 10 + 3 + 480 + 6 + 20 = **519초** 이상이어야 합니다. 여유를 두어 600∼720초로 잡습니다. (나) preStop이 시작된 지 30초 뒤(SIGTERM으로부터는 20초 뒤) SIGKILL이 와서 종료 코드 **137**이 남습니다. 통화는 중간에 끊기고, 잡 프로세스가 종료 콜백까지 가지 못하므로 통화 결과도 functions-xtool로 가지 않습니다. (다) GKE는 노드 축소 때 유예를 최대 10분(600초)으로 자릅니다. 이 예는 519초라 그 안에 들지만, 통화가 더 길거나 종료 절차가 SDK 제한까지 늘어지면 720초를 다 쓰지 못하고 끊길 수 있습니다. 축소에서 빼려면 `safe-to-evict: "false"` 주석 같은 별도 장치를 씁니다.
8. (가) `pnpm-workspace.yaml`은 build 단계의 첫 `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./`에 들어가므로 그 줄부터 `COPY patches`, `pnpm install`, `download-files`, `COPY . .`, `prune`, 그리고 최종 단계의 `COPY --from=build`부터 끝까지 다시 돕니다. base와 최종 단계의 `adduser`는 캐시입니다. build 단계의 레이어는 최종 이미지에 들어가지 않으므로 레지스트리에 올라가는 큰 레이어는 최종 `COPY --from=build` 하나(소스 + node_modules)입니다. (나) `knowledge/`는 `COPY . .`에만 들어가므로 `COPY . .`, `prune`, 최종 `COPY --from=build`부터 다시 돕니다. 올라가는 큰 레이어는 (가)와 같습니다. 글 몇 줄을 고쳐도 node_modules가 든 레이어 전체가 바뀝니다. (다) `chown`은 모든 파일의 소유자를 바꾸므로 overlayfs가 파일을 통째로 위 층에 복사하고(copy-up), 그 층이 새 레이어가 됩니다. 아래 레이어의 원본은 남으므로 `/app` 크기만큼이 한 번 더 실려 그 부분이 약 두 배가 됩니다.
9. (가) `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`로 시작 전에 실패합니다. `enum`은 JS 객체를 새로 만들어야 해서 지우기로는 못 하기 때문입니다. tsc에서는 `erasableSyntaxOnly`가 막고, 대안은 `as const` 객체입니다. (나) Node는 `ERR_MODULE_NOT_FOUND`로 실패합니다. ESM은 확장자를 추측하지 않습니다. 이 레포의 `moduleResolution: "bundler"`에서는 `pnpm typecheck`가 **통과**합니다. `nodenext`였다면 TS2835로 잡혔습니다. (다) Node가 타입 자리를 같은 길이의 공백으로 바꾸기 때문입니다(한글 같은 글자는 U+2002로 바꿔 UTF-16 칸 수와 UTF-8 바이트 수까지 지킴). 줄과 열이 원본 그대로라 소스맵이 필요 없습니다.
10. (가) libuv가 `150000 / 100000`을 정수로 나눠 **1**, 유휴 프로세스는 min(1, 4) = **1**개, SDK의 부하 계산은 소수 그대로 **1.5**를 씁니다. (나) 2,100,000 ÷ (2,500,000 × 1.5) = **0.56**이라 0.7 미만이므로 새 잡을 받습니다. (다) `cpu.max`가 `max`가 되어 `availableParallelism()`은 노드의 16, 유휴 프로세스는 4개가 됩니다(메모리 약 3 × 236 ≈ 710MB 더 필요). 부하 계산도 `os.cpus().length` = 16을 분모로 써서 같은 사용량이 2,100,000 ÷ (2,500,000 × 16) ≈ 0.05로 보이므로, 파드가 CPU를 다투는 중에도 워커는 거의 늘 "여유 있음"을 알리고 잡을 계속 받습니다.
11. (가) 첫 통화가 하나뿐인 유휴 프로세스를 가져가고, 그 빈자리를 새로 데우기 시작합니다. 두 번째 통화는 그 데우기가 끝날 때까지 약 **0.6초**, 세 번째는 그다음 데우기까지 약 **1.2초** 늦게 시작합니다. 유휴 자리가 하나라 다음 데우기는 앞서 데운 프로세스가 일을 맡은 뒤에야 시작하고, 데우기는 `initMutex`로 하나씩 차례로 하기 때문입니다(`ipc/proc_pool.ts` 71∼77·115∼131). (나) `availableParallelism()`이 2라 유휴 프로세스가 2개입니다. 첫째·둘째는 바로 시작하고, 빈자리 두 개를 차례로 데우므로 셋째만 약 0.6초 기다립니다. (다) 워커 240 + 추론 290 + (유휴 2 + 통화 3) × 236 + 통화 3 × 100 = 530 + 1,180 + 300 = **약 2,010MB**(약 2.0GB)입니다. RSS를 더한 값이라 실제 `memory.current`보다 넉넉한 쪽입니다(15-5절 깊이 보기).
12. (가) 즉시 반응이 끝나는 약 0.9초(0.4 + 0.5)에 에이전트 상태가 `listening`으로 돌아가 10초 타이머가 돌기 시작합니다. 실패(약 0.4 + 5.3 = 5.7초)는 "즉시 반응 끝 + 10초"보다 이르므로 max(5.7, 0.9 + 10) + 0.17 ≈ **11.1초**입니다(11장 재현 11.12초). (나) 즉시 반응이 없으면 본 답의 "생각 중" 상태가 실패까지 이어져 타이머가 실패 뒤에야 돕니다. 5.7 + 10 + 0.17 ≈ **15.9초**입니다(재현 15.93초). (다) 처음 코드에서는 약 10.9초에 고객 상태가 `away`가 되어 `guardCall`이 "여보세요?"를 대기열에 넣어 두므로, 본 답이 끝나자마자 "여보세요? 제 목소리 잘 들리세요?"가 이어서 나왔습니다(재현 15.51초). 지금 코드는 `away`가 와도 본 답이 끝나지 않았으므로 묻지 않고, 본 답이 끝난 15.3초부터 10초 뒤에 묻습니다. TTS 첫 음성까지 더해 약 **25.5초**입니다(재현 25.50초). 그 사이에 고객이 대답하면 묻지 않습니다(15-7절 깊이 보기, 11-6절).

</details>
