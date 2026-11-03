# 15장. 설정·빌드·배포·운영

마지막 기술 장입니다. 코드가 **어떻게 설정되고, 어떤 도구로 검사·실행되고, 어떻게 이미지로 묶여 서버에 올라가며, 운영 중 무엇을 지켜봐야 하는지**를 다룹니다. 이 프로젝트는 아직 PoC 단계라 배포 설정이 Dockerfile까지만 있으므로, 앞으로 할 일도 함께 정리합니다.

---

## 15-1. 설정: 환경변수로 부품 바꾸기

### 12-Factor의 "설정은 환경에"

코드와 설정을 분리하는 원칙입니다. 같은 이미지를 개발·운영에서 쓰고, 다른 것은 **환경변수**뿐이어야 합니다. 이 프로젝트의 환경변수는 두 종류입니다([.env.example](../../.env.example)).

| 종류 | 예 | 성격 |
| --- | --- | --- |
| 비밀값 | `LIVEKIT_API_SECRET`, `ANTHROPIC_API_KEY`, `ELEVEN_API_KEY`, `SONIOX_API_KEY` | 절대 커밋 안 함. 로컬은 `.env.local`, 운영은 Secret |
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

- **빨리 실패하기(fail fast).** `LLM_THINKING=of`처럼 오타를 내면 조용히 기본값으로 가지 않고 시작할 때 바로 오류를 냅니다. 운영에서 "설정이 안 먹었는데 아무도 몰랐다"는 사고를 막습니다.
- **제네릭 `T extends string`** 덕분에 반환 타입이 `string`이 아니라 `'off' | 'adaptive'` 같은 정확한 유니온이 됩니다. 이후 코드에서 `switch`가 모든 경우를 다뤘는지 컴파일러가 확인할 수 있습니다.
- `DEFAULT_MODELS`를 `as const`로 선언해 공급사별 기본 모델 표를 타입 수준의 상수로 둡니다.
- 주석 "dotenv를 읽은 뒤에 호출합니다"는 8-8절의 import 시점 문제를 피하기 위한 것입니다. 그래서 설정을 모듈 최상위에서 읽지 않고 `entry` 안에서 함수로 읽습니다.

### 팩토리: 부품 생성 한곳에 모으기

```ts
// src/models/index.ts
export function createSTT(config: SttConfig): stt.STT {
  switch (config.provider) {
    case 'soniox':  return new FinalizingSonioxSTT({ … });
    case 'livekit': return new inference.STT({ model: config.model, language: 'ko' });
  }
}
```

- **팩토리 + 전략 패턴**입니다. 호출하는 쪽(`main.ts`)은 `stt.STT`라는 공통 인터페이스만 알고, 어떤 공급사인지는 몰라도 됩니다. 새 공급사(리턴제로 등)를 붙일 때 `case` 하나와 플러그인 연결만 추가하면 됩니다([setup-checklist.md 1-4](../setup-checklist.md#1-4-부품-교체-구조)).
- `switch`에 `default`가 없습니다. 그런데도 컴파일이 되는 이유는 `provider`의 타입이 `'soniox' | 'livekit'`이고 두 경우를 모두 `return`하기 때문입니다. tsconfig의 `noImplicitReturns`가 켜져 있어서, 나중에 `SttProvider`에 `'rtzr'`을 추가하고 `case`를 빼먹으면 **컴파일 오류**가 납니다. 타입 시스템으로 "빠뜨림"을 막는 기법입니다(완전성 검사).
- 공급사마다 다른 함정을 이곳에 모았습니다. Soniox는 API 키를 다시 넘기고 강조 단어를 `context.terms`로, LiveKit Inference의 OpenAI 모델은 `reasoning_effort: 'none'`(도구 사용 조건), ElevenLabs는 voice id가 있을 때만 넘깁니다.

### `...(조건 ? { x } : {})` 패턴이 많은 이유

```ts
...(config.voice ? { voiceId: config.voice } : {}),
...(apiKey ? { apiKey } : {}),
```

tsconfig의 **`exactOptionalPropertyTypes`** 때문입니다. 이 옵션이 켜져 있으면 `voiceId?: string`인 자리에 `voiceId: undefined`를 **명시적으로** 넣는 것이 타입 오류입니다. "속성이 없음"과 "속성이 있는데 값이 undefined"를 구분하기 때문입니다. 라이브러리 중에는 `'voiceId' in opts`로 검사하거나 `{ ...defaults, ...opts }`로 합치는 곳이 있어서, `undefined`를 넣으면 기본값을 덮어써 버리는 버그가 생깁니다. 조건부 스프레드는 **값이 있을 때만 속성 자체를 만드는** 관용구입니다.

---

## 15-2. TypeScript를 빌드 없이 실행하기 (Node 24)

이 프로젝트에는 `dist/` 빌드 단계가 없습니다. `node src/main.ts`로 TypeScript 파일을 **바로** 실행합니다.

### 타입 지우기 (type stripping)

Node 24는 `.ts` 파일을 읽을 때 **타입 표기만 지우고** JavaScript로 실행합니다. 변환(transpile)이 아니라 지우기라서 빠르고 단순하지만, 지우기만으로는 처리할 수 없는 문법은 쓸 수 없습니다. 그래서 tsconfig에 짝이 되는 옵션들이 있습니다.

| 옵션 | 이유 |
| --- | --- |
| `noEmit: true` | tsc는 **타입 검사만** 함 (`pnpm typecheck`). 실행은 Node가 직접 |
| `allowImportingTsExtensions` | Node는 확장자 없는 import(`./agent`)를 못 찾음 → `./agent.ts`처럼 확장자를 쓰고, tsc가 그것을 허용하게 함 |
| `erasableSyntaxOnly` | `enum`, `namespace`, 생성자 매개변수 속성처럼 **지우기만으로 안 되는 문법 금지**. Node에서 실행하면 문법 오류가 나므로 미리 막음 |
| `verbatimModuleSyntax` | import를 쓴 그대로 남김. 타입만 가져올 때는 반드시 `import type`을 쓰게 강제함. Node는 `import type`만 지우므로, 타입을 일반 import로 가져오면 런타임에 "export가 없다" 오류가 남 |
| `isolatedModules` | 파일 하나만 보고 처리할 수 있는 코드만 허용 (지우기 방식의 전제) |

그래서 코드 곳곳에 `import type { CallContext } from './call-context.ts'`, `import { Agent, type llm } from '@livekit/agents'` 같은 표기가 있습니다. 타입과 값을 import 단계에서 구분하는 것입니다.

### 엄격 옵션들

| 옵션 | 효과 | 코드에 보이는 흔적 |
| --- | --- | --- |
| `strict` | null 검사 등 엄격 모드 묶음 | — |
| `noUncheckedIndexedAccess` | 배열·객체 인덱스 결과를 `T \| undefined`로 | `ACKS[…]!` (11-5절) |
| `exactOptionalPropertyTypes` | 선택 속성에 `undefined` 명시 금지 | 조건부 스프레드 (15-1절) |
| `noImplicitOverride` | 부모 메서드 재정의에 `override` 필수 | `override chat`, `override stream` |
| `noImplicitReturns` | 모든 경로에서 반환 | 팩토리 완전성 검사 |
| `noFallthroughCasesInSwitch` | case 사이 의도치 않은 흘러내림 금지 | — |

테스트 파일(`*.test.ts`)은 tsconfig의 `exclude`에 있어 `pnpm typecheck` 대상이 아니고, vitest가 따로 실행합니다.

---

## 15-3. 패키지 관리: pnpm

### 버전 고정

| 설정 | 위치 | 효과 |
| --- | --- | --- |
| `"packageManager": "pnpm@12.16.1"` | package.json | corepack이 정확히 이 버전을 씀. 로컬·CI·Docker가 같은 pnpm |
| `"engines": { "node": ">=24" }` + `engine-strict=true` | package.json, .npmrc | Node 22로 설치하면 **경고가 아니라 오류** ([setup-checklist.md 2장](../setup-checklist.md#2-로컬-개발-환경)) |
| `pnpm-lock.yaml` | 커밋함 | 모든 의존성의 정확한 버전·해시. `--frozen-lockfile`로 이와 다르면 실패 |

### pnpm-workspace.yaml의 세 가지 설정

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

### 패키지 패치라는 기법

다른 사람의 패키지를 고치는 방법은 여러 가지입니다.

| 방법 | 장점 | 단점 |
| --- | --- | --- |
| 업스트림에 PR | 모두가 혜택, 유지 보수 부담 없음 | 반영까지 시간이 걸림 |
| 포크해서 배포 | 자유로움 | 포크를 계속 따라잡아야 함 |
| 상속·감싸기 (`FinalizingSonioxSTT`) | 원본을 안 건드림 | 원본이 막아 둔 부분은 못 고침 |
| **패치 파일** (`pnpm patch`) | 고친 줄만 관리, lockfile로 재현 | **버전 고정**, 업그레이드 때 다시 맞춰야 함 |

이 프로젝트는 감싸기로 할 수 있는 부분(스트림 기억, `finalize()` 메서드)은 감싸고, 감싸기로 못 하는 부분(플러그인 내부 루프에서 flush 표식 처리)만 패치했습니다. **변경을 가장 작게** 하는 선택입니다. 그리고 [setup-checklist.md 9장](../setup-checklist.md#9-알아-둘-점)에 "버전을 올리면 다시 확인"이라고 남겨 두었습니다. 장기적으로는 같은 수정을 LiveKit에 제안(PR·피드백)하는 것이 좋습니다. [AGENTS.md](../../AGENTS.md)도 LiveKit 문제를 발견하면 `lk docs submit-feedback`으로 알리라고 권합니다.

---

## 15-4. Docker 이미지

[Dockerfile](../../Dockerfile)은 **다단계 빌드(multi-stage build)**입니다.

```text
base   node:24-slim + ca-certificates + pnpm 12.16.1
  │
build  ① package.json, pnpm-lock.yaml만 복사 → pnpm install --frozen-lockfile
  │    ② npx livekit-agents download-files
  │    ③ COPY . .  (나머지 소스)
  │    ④ pnpm prune --prod  (개발 의존성 제거)
  ▼
최종   base + 비루트 사용자(UID 10001) + build 결과 복사 → CMD ["node", "src/main.ts", "start"]
```

### 각 결정의 이유

| 결정 | 이유 |
| --- | --- |
| `-slim` 이미지 | 크기 감소. 대신 필요한 것을 직접 설치 |
| `ca-certificates` 설치 | LiveKit의 Rust 네이티브 코어가 **시스템 인증서 저장소**를 읽음. slim 이미지에는 없어 방 연결(TLS)이 실패함. Node 자체는 내장 인증서를 쓰므로 Node만 보면 놓치기 쉬운 함정 |
| 의존성 파일 먼저 복사 → 설치 → 그다음 소스 복사 | **레이어 캐시.** 소스만 바뀌면 설치 단계를 건너뜀 |
| `download-files`를 소스 복사 전에 | 모델 다운로드도 캐시되게. (이 프로젝트에서는 실제로 받는 파일이 없음 — 아래) |
| `prune --prod` | 실행에 tsc·vitest·eslint가 필요 없음 (Node가 TS를 직접 실행) |
| 비루트 사용자 | 컨테이너가 뚫려도 권한 최소화 |
| `COPY --chown` | 따로 `chown -R`을 돌리면 node_modules 전체를 복사한 레이어가 하나 더 생김 |
| **exec 형식 `CMD [...]`** | node가 PID 1이 되어 SIGTERM을 직접 받음 → drain 동작 (4-7절). `CMD node src/main.ts start`(셸 형식)면 셸이 PID 1이 되어 신호가 안 전달됨 |
| `.dockerignore`에 `.env.*` | 비밀값이 이미지에 들어가지 않음. 그래서 이미지 안의 `dotenv`는 아무것도 안 읽고, 운영 비밀값은 진짜 환경변수로 넣어야 함 |

### download-files는 지금 무엇을 받나

`npx livekit-agents download-files`는 설치된 `@livekit/agents-plugin-*` 패키지를 찾아 각 플러그인의 모델 파일을 미리 받습니다. 그런데 이 프로젝트에서는 **받는 파일이 없습니다.**

- Anthropic·ElevenLabs·Soniox 플러그인은 클라우드 API라 받을 모델이 없습니다.
- ai-coustics 패키지는 이름이 `agents-plugin-`으로 시작하지 않아 아예 탐색되지 않습니다.
- Silero VAD와 턴 감지 mini 모델은 `@livekit/local-inference` 네이티브 바이너리 안에 내장되어 `pnpm install` 때 이미 들어옵니다.

나중에 모델을 받는 플러그인을 추가했을 때를 위한 안전망으로 두는 것은 괜찮습니다.

### ⚠ 확인된 문제: 설치 단계에 워크스페이스 설정이 없음

①에서 `package.json`과 `pnpm-lock.yaml`만 복사하고 설치합니다. 그런데 lockfile에는 `pnpm-workspace.yaml`의 `overrides`와 `patchedDependencies` 정보가 기록되어 있습니다. 설치 시점에 그 설정 파일이 없으면 lockfile과 설정이 어긋납니다.

이 문서를 쓰면서 같은 조건(두 파일만 있는 빈 폴더)에서 `pnpm install --frozen-lockfile --lockfile-only`를 실행해 보니 다음 오류로 멈췄습니다.

```text
ERR_PNPM_LOCKFILE_CONFIG_MISMATCH
Cannot proceed with the frozen installation. The current "overrides"
configuration doesn't match the value found in the lockfile
```

`pnpm-workspace.yaml`, `.npmrc`, `patches/`를 함께 넣으면 통과했습니다. 따라서 **지금 Dockerfile로는 이미지 빌드가 설치 단계에서 실패할 가능성이 큽니다**(전체 `docker build`는 돌려 보지 않았습니다). 고치는 방법은 설치 전에 이 파일들을 함께 복사하는 것입니다.

```dockerfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile
```

이렇게 해야 Soniox 패치(6장)도 이미지에 확실히 적용됩니다. 패치가 빠진 채 빌드되면 오류 없이 **말 끝 판단만 다시 느려지는**, 찾기 어려운 회귀가 생깁니다.

---

## 15-5. 쿠버네티스(GKE)에 올릴 때 챙길 것

배포 설정은 아직 없습니다. 4장의 실행 구조에서 나오는 요구 사항을 정리합니다.

| 항목 | 설정 | 이유 |
| --- | --- | --- |
| 종료 유예 | `terminationGracePeriodSeconds`를 최장 통화 길이 + 여유 (예: 600초 이상) | 기본 30초면 drain 중인 통화가 SIGKILL로 끊김 (4-7절) |
| 헬스 체크 | `GET :8081/` | WebSocket 연결·추론 프로세스가 살아 있을 때만 200 |
| CPU | 계산 최적화형, 버스트형(크레딧) 피하기 | 로컬 턴 감지 mini 모델이 CPU 크레딧이 떨어지면 시간 초과 (LiveKit 문서 권고) |
| 메모리 | 유휴 프로세스 수 × 프로세스 메모리 + 통화 수 × 통화 메모리 + 추론 프로세스(약 138MB 모델) | 프로세스마다 네이티브 라이브러리를 따로 올림 (4-4절) |
| 유휴 프로세스 | 기본 `min(CPU 수, 4)` | 컨테이너 CPU 제한을 제대로 반영하지 못할 수 있음 → 메모리 산정에 반영 |
| 비밀값 | Secret → 환경변수 | 이미지에 `.env` 없음 |
| `/tmp` 쓰기 | 읽기 전용 루트 파일시스템이면 emptyDir 마운트 | 세션 녹음·리포트를 임시 폴더에 씀 (15-6절) |
| 턴 감지·끼어들기 | `TurnDetector({ version })`, `interruption.mode` 명시 여부 결정 | `start`에서는 기본값이 dev와 다름 (4-5절, 7장) |
| 리전 | 워커 GCP 서울, 미디어·SIP는 LiveKit Cloud 일본 | [tech-stack.md 4-1](../tech-stack.md#4-1-프레임워크) |

LiveKit Cloud에 에이전트를 직접 배포(`lk agent deploy`)하는 선택지도 있습니다. 그러면 턴 감지 `v1`과 적응형 끼어들기가 기본으로 켜지고 운영 부담이 줄지만, 에이전트 리전이 미국·유럽·뭄바이뿐이라 서울과 멀어집니다. 지연과 운영 편의의 교환입니다.

---

## 15-6. 관측(observability)

### 지금 있는 것

```ts
session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => metrics.logMetrics(ev.metrics));
log().info({ config, callId: call.callId }, '통화 시작');
```

- 구간별 지연 메트릭을 **로컬 로그**에 남깁니다(13장).
- `start` 모드의 로그는 JSON 형식이라 Cloud Logging 같은 곳에서 필드로 검색할 수 있습니다.
- 통화 시작 로그에 `callId`를 남겨 Firestore 기록과 연결합니다.

### LiveKit Cloud 세션 리포트

워커가 LiveKit Cloud 프로젝트(`*.livekit.cloud`)에 붙어 있으면, **워커를 GKE에 두더라도** 세션이 끝날 때 리포트를 LiveKit Cloud로 올립니다(`voice/report.ts`, `telemetry/`).

| 내용 | 비고 |
| --- | --- |
| 이벤트 목록, 대화 기록, 모델 사용량, 세션 설정 | Agent Observability 화면에서 확인 |
| 트레이스·로그 (OpenTelemetry) | 구간별 시간 |
| 녹음 (고객·에이전트 채널 분리, Opus 48kHz) | 프로젝트 설정의 녹음 옵션을 따름. 임시 폴더에 `audio.ogg`로 쓴 뒤 업로드 |

알아 둘 점:

- 업로드 인증은 **환경변수 `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`에서만** 만듭니다. 명령줄 플래그로만 키를 넘기면 업로드가 실패합니다.
- **개인정보**: 녹음과 대화 기록이 LiveKit Cloud로 갑니다. SIP 참가자의 **전화번호가 트레이스 속성으로 기록**됩니다. 녹음 고지·처리방침·국외 이전 동의([tech-stack.md 11장](../tech-stack.md#11-직접-재-봐야-할-것))와 함께, 리포트의 마스킹(redaction) 옵션을 검토해야 합니다.

### 앞으로 필요한 것

| 무엇 | 왜 |
| --- | --- |
| 통화별 결과를 Firestore에 저장 | 검수 화면, 통계 |
| 지연 백분위수 대시보드 | 꼬리 지연 감시 (13-6절) |
| 오류율 (STT·LLM·TTS 연결 실패) | 공급사 장애 감지 |
| 통화당 비용 | [tech-stack.md 9장](../tech-stack.md#9-비용-추정)의 추정 검증 |
| 이상 알림 | 통화량 급증, 실패 급증 |

---

## 15-7. 장애에 대한 설계: 공급사가 죽으면

외부 API 세 개(Soniox, Anthropic, ElevenLabs)에 의존하므로, 하나만 멈춰도 통화가 멈춥니다. 현재 상태와 선택지입니다.

| 부품 | 지금의 동작 | 선택지 |
| --- | --- | --- |
| STT | 연결 오류 시 코어가 0.5초 뒤 스트림 재생성 | LiveKit의 STT FallbackAdapter (여러 STT를 순서대로) |
| LLM | 첫 출력 전 429·5xx만 재시도. 출력이 시작된 뒤 실패하면 재시도 안 함 | LLM FallbackAdapter, 첫 토큰 시간 초과 시 다른 모델 ([tech-stack.md 4-3](../tech-stack.md#4-3-llm-대화-두뇌)의 "백업 모델") |
| TTS | 텍스트 보낸 뒤 10초 안에 오디오 없으면 시간 초과 | TTS FallbackAdapter |
| 턴 감지 | 클라우드 실패 시 로컬 mini로 자동 전환 | 이미 있음 |
| 적응형 끼어들기 | 실패 반복 시 VAD 방식으로 전환 | 이미 있음 |
| 노이즈 제거 | 실패 시 원본 통과 | 이미 있음 |

LiveKit 자체 부품들(턴 감지, 끼어들기, 노이즈 제거)은 **실패하면 더 단순한 방식으로 내려가는(graceful degradation)** 설계가 이미 들어 있습니다. 외부 공급사 쪽은 우리가 FallbackAdapter 등으로 설계해야 합니다. "LiveKit Inference(별도 키 없음)"를 대체 경로로 두면 공급사 계정 문제에도 대비할 수 있습니다. 이 프로젝트의 `config.ts`가 이미 `livekit` 공급사를 지원하는 것은 이런 확장의 바탕이 됩니다.

---

## 15-8. 보안·법무 체크리스트

| 영역 | 항목 | 근거 |
| --- | --- | --- |
| 비밀값 | `.env.local` 커밋 금지, 운영은 Secret | [setup-checklist.md 10장](../setup-checklist.md#10-커밋-전-확인) |
| 비용 폭탄 | Anthropic 월 사용 한도, SIP 국제전화 차단·발신 규칙·방화벽 | [telephony-setup.md 7장](../telephony-setup.md#7-보안-요금-폭탄-막기) |
| 공급망 | `allowBuilds`, lockfile 고정, 패치 최소화 | 15-3절 |
| 고지 | AI·녹음 고지를 고정 문장으로, 끼어들기 막음 | 9장 |
| 고지 타이밍 | 전화를 **받은 뒤** 고지가 재생되는지 (`waitUntilAnswered`) | 4-6절 |
| 개인정보 수집 | 주민번호·카드번호 묻지 않음 (지시문 + 시나리오) | 9장 |
| 수신 거부 | "전화하지 마세요" → 즉시 종료 (기록 도구는 예정) | 9장 |
| 발신 시간 | 08~21시 (functions-xtool이 검사 예정) | [tech-stack.md 6장](../tech-stack.md#6-전체-아키텍처) |
| 국외 이전 | 해외 API(Soniox, Anthropic, ElevenLabs, LiveKit Cloud)로 음성·대화가 감 | 법무 검토 |
| 녹음 활용 | 학습 용도로 쓰려면 동의 범위 확인 | [setup-checklist.md 7-8](../setup-checklist.md#7-상담팀업무-쪽에서-정해-줄-것) |

---

## 15-9. 정리

```text
설정    환경변수 → loadConfig (빨리 실패) → 팩토리 (완전성 검사) → 부품
코드    Node 24가 .ts를 바로 실행 (타입 지우기) ← tsc는 검사만 (엄격 옵션)
의존성  pnpm 12.16.1 고정, lockfile, allowBuilds·overrides·patch
이미지  다단계 빌드, ca-certificates, 비루트, exec CMD (SIGTERM → drain)
        ⚠ 설치 단계에 pnpm-workspace.yaml·patches 복사 필요 (재현됨)
배포    grace period ≥ 최장 통화, 헬스 체크 8081, CPU 최적화형, 턴 감지·끼어들기 모드 명시
관측    메트릭 로그, LiveKit Cloud 세션 리포트 (개인정보 검토)
장애    LiveKit 부품은 자동 강등, 외부 공급사는 FallbackAdapter 설계 필요
```

---

## 확인 문제

1. `pick()`이 잘못된 값을 받았을 때 기본값으로 가지 않고 오류를 내는 이유는?
2. `SttProvider`에 `'rtzr'`을 추가하고 `createSTT`에 `case`를 빼먹으면 어떻게 됩니까? 어떤 tsconfig 옵션 덕분입니까?
3. `exactOptionalPropertyTypes`가 켜진 상태에서 `voiceId: config.voice`(값이 undefined일 수 있음)를 그대로 쓰면 왜 안 됩니까?
4. 타입만 쓰는 import를 `import type` 없이 쓰면 Node에서 무슨 일이 생깁니까?
5. Dockerfile의 CMD를 셸 형식으로 바꾸면 배포 때 어떤 문제가 생깁니까?
6. 지금 Dockerfile의 설치 단계가 실패하는 이유와, 실패하지 않더라도 생길 수 있는 더 위험한 문제는?

<details>
<summary>답 보기</summary>

1. 오타가 조용히 기본값으로 바뀌면 설정이 안 먹었다는 사실을 아무도 모르기 때문입니다. 시작할 때 실패해야 바로 고칩니다.
2. `createSTT`의 모든 경로가 값을 반환하지 않게 되어 컴파일 오류가 납니다. `noImplicitReturns`(와 유니온 타입) 덕분입니다.
3. 선택 속성에 `undefined`를 명시적으로 넣는 것이 타입 오류이고, 라이브러리에 따라 `undefined`가 기본값을 덮어쓰는 버그가 생길 수 있기 때문입니다.
4. Node는 `import type`만 지우므로 일반 import가 남고, 런타임에 그 이름의 export가 없다는 오류가 납니다.
5. 셸이 PID 1이 되어 SIGTERM이 node에 전달되지 않으므로 drain이 일어나지 않고, 유예 시간이 지나면 진행 중인 통화가 강제로 끊깁니다.
6. 설치 시점에 `pnpm-workspace.yaml`이 없어 lockfile의 overrides 설정과 어긋나므로 `--frozen-lockfile`이 실패합니다. 실패하지 않는 방식으로 고치더라도 `patches/`가 빠지면 Soniox 패치 없이 빌드되어, 오류 없이 말 끝 판단만 다시 느려지는 회귀가 생길 수 있습니다.

</details>
