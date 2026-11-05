# 15장. 설정·빌드·배포·운영

코드가 **어떻게 설정되고, 어떤 도구로 검사·실행되고, 어떻게 이미지로 묶여 서버에 올라가며, 운영 중 무엇을 지켜봐야 하는지**를 다룹니다. 이 프로젝트는 아직 PoC 단계라 배포 설정이 Dockerfile까지만 있으므로, 앞으로 할 일도 함께 정리합니다. 클라우드 계정과 권한(AWS·GCP)은 다음 16장에서 따로 다룹니다.

---

## 15-1. 설정: 환경변수로 부품 바꾸기

### 12-Factor의 "설정은 환경에"

코드와 설정을 분리하는 원칙입니다. 같은 이미지를 개발·운영에서 쓰고, 다른 것은 **환경변수**뿐이어야 합니다. 이 프로젝트의 환경변수는 두 종류입니다([.env.example](../../.env.example)).

| 종류 | 예 | 성격 |
| --- | --- | --- |
| 비밀값 | `LIVEKIT_API_SECRET`, `ANTHROPIC_API_KEY`, `ELEVEN_API_KEY`, `SONIOX_API_KEY`, `VOICE_AGENT_SECRET`(결과 전송, 15-6절) | 절대 커밋 안 함. 로컬은 `.env.local`, 운영은 Secret |
| 연동 주소 | `VOICE_RESULT_URL` | 비우면 결과를 보내지 않음 (로컬 개발 기본) |
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

- **팩토리 + 전략 패턴**입니다. 호출하는 쪽(`main.ts`)은 `stt.STT`라는 공통 인터페이스만 알고, 어떤 공급사인지는 몰라도 됩니다. 새 공급사(리턴제로 등)를 붙일 때 `case` 하나와 플러그인 연결만 추가하면 됩니다([4-setup-checklist.md 1-4](../4-setup-checklist.md#1-4-부품-교체-구조)).
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
| `"engines": { "node": ">=24" }` + `engine-strict=true` | package.json, .npmrc | Node 22로 설치하면 **경고가 아니라 오류** ([4-setup-checklist.md 2장](../4-setup-checklist.md#2-로컬-개발-환경)) |
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

이 프로젝트는 감싸기로 할 수 있는 부분(스트림 기억, `finalize()` 메서드)은 감싸고, 감싸기로 못 하는 부분(플러그인 내부 루프에서 flush 표식 처리)만 패치했습니다. **변경을 가장 작게** 하는 선택입니다. 그리고 [4-setup-checklist.md 9장](../4-setup-checklist.md#9-알아-둘-점)에 "버전을 올리면 다시 확인"이라고 남겨 두었습니다. 장기적으로는 같은 수정을 LiveKit에 제안(PR·피드백)하는 것이 좋습니다. [AGENTS.md](../../AGENTS.md)도 LiveKit 문제를 발견하면 `lk docs submit-feedback`으로 알리라고 권합니다.

---

## 15-4. Docker 이미지

[Dockerfile](../../Dockerfile)은 **다단계 빌드(multi-stage build)**입니다.

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

고친 뒤에는 Docker 없이 빌드 단계를 그대로 따라 해 확인했습니다. 설치가 통과하고, Soniox 플러그인 `dist/stt.js`와 `dist/stt.cjs`에 `{"type":"finalize"}` 패치가 들어가며, `pnpm prune --prod` 뒤에도 패치가 남고 tsc·vitest·eslint는 빠지며, 운영 의존성만으로 `node src/main.ts --help`가 모든 플러그인을 불러 정상 실행됐습니다. 실제 `docker build`는 아직 돌려 보지 않았습니다.

이 사례에서 배울 점은 **패치가 빠져도 오류가 나지 않는 경로가 가장 위험하다**는 것입니다. lockfile 검사가 없었다면 패치 없는 이미지가 조용히 만들어지고, 운영에서 **말 끝 판단만 다시 느려지는**(6장) 찾기 어려운 회귀가 생겼을 것입니다. `--frozen-lockfile`이 설정 불일치를 오류로 잡아 준 덕분에 빌드 시점에 드러난 것입니다.

---

## 15-5. 워커를 어디에 띄우나: LiveKit Cloud 또는 GKE

> 2026-11-03 갱신. 웹 테스트([6-web-test.md 6-3](../6-web-test.md#6-3-에이전트-워커--둘-중-하나))에서 LiveKit Cloud 배포안이 구체화되어 이 절을 둘로 나눴습니다.

| | LiveKit Cloud 배포 (`lk agent create`) | 직접 운영 (GKE·GCE 서울) |
| --- | --- | --- |
| 빌드 | LiveKit이 **이 레포의 Dockerfile로 원격 빌드** | 우리가 빌드·푸시 |
| 리전 | 미국·유럽·뭄바이 (서울 없음) | 서울 가능 |
| 턴 감지 기본값 | 클라우드 `v1` | 로컬 `v1-mini` (4-5절) |
| 적응형 끼어들기 기본값 | **켜짐** | 꺼짐 (`mode: 'adaptive'` 명시 필요, 7-5절) |
| 배포 시 진행 중 통화 | production 재배포는 진행 중 세션을 최대 1시간 기다림 (LiveKit 문서) | grace period를 직접 설정 |
| 부하 기준 | LiveKit Cloud가 정함 (코드의 임계값 설정은 무시됨) | 코드 기본값 0.7 |
| 무료(Build) 요금제 | production도 쉬고 있으면 0대로 줄어 **첫 통화에 콜드 스타트** | 해당 없음 |
| 운영 부담 | 작음 | 큼 |

[2-tech-stack.md](../2-tech-stack.md)는 지연 때문에 서울 직접 운영을 추천했고, 웹 테스트는 우선 LiveKit Cloud를 택했습니다. 4·7장에서 "PoC(dev)와 운영이 다르다"고 지적한 턴 감지·끼어들기 차이는 **직접 운영할 때의 이야기**이고, LiveKit Cloud에 배포하면 dev와 같은 쪽(클라우드 `v1`, 적응형 켜짐)으로 갑니다. 대신 LLM이 미국에 있으니 미국 리전이 무난하다는 판단입니다(서울↔미국 왕복이 고객 음성 경로로 옮겨 감). 지연은 [5-poc-results.md](../5-poc-results.md) 방식으로 다시 재야 합니다.

### LiveKit Cloud 배포: 비밀값을 넘기는 방법

```bash
# 부품 키와 결과 전송 설정만 담은 임시 파일 (LIVEKIT_* 는 LiveKit Cloud가 넣어 주므로 뺌)
grep -E '^(ANTHROPIC_API_KEY|ELEVEN_API_KEY|SONIOX_API_KEY|TTS_VOICE|VOICE_RESULT_URL|VOICE_AGENT_SECRET)=' .env.local > .env.agent-secrets
lk agent create --secrets-file .env.agent-secrets
rm .env.agent-secrets
```

- (2026-11-05 갱신) 목록은 [6-web-test.md 6장](../6-web-test.md)의 배포 명령과 같습니다. 이전 판에는 `VOICE_RESULT_URL`·`VOICE_AGENT_SECRET`이 빠져 있었습니다. 그대로 배포하면 워커가 "통화 결과 전송 생략"만 남기고 결과를 보내지 않습니다(15-6절).
- LLM을 Bedrock으로 바꿔 배포한다면 `LLM_PROVIDER`와 `AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`·`AWS_REGION`도 넣습니다. `AWS_BEARER_TOKEN_BEDROCK`은 넣지 않습니다. 코드는 이 값을 읽지 않습니다(16-4절).
- 이미지에는 `.env.*`가 들어가지 않으므로(15-4절) 비밀값은 **LiveKit Cloud의 비밀값 저장소**로 따로 넘깁니다. 컨테이너에서는 환경변수로 보입니다.
- 임시 파일 `.env.agent-secrets`는 `.gitignore`에 추가되어 있습니다. 명령이 중간에 실패해 `rm`이 안 돌아도 실수로 커밋되지 않게 하는 **이중 안전장치**입니다.
- `LIVEKIT_URL`·키는 LiveKit Cloud가 넣어 주므로 빼는 것입니다. 세션 리포트 업로드(15-6절)도 이 값으로 인증됩니다.
- 처음 만들면 `livekit.toml`(프로젝트·에이전트 정보)이 생기고, 커밋합니다. 이후 코드 변경은 `lk agent deploy`로 올립니다.
- 원격 빌드가 Dockerfile을 쓰므로, 15-4절의 설치 단계 수정이 **이 배포의 전제 조건**입니다.

### 직접 운영(GKE)에 올릴 때 챙길 것

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
| 리전 | 워커 GCP 서울, 미디어·SIP는 LiveKit Cloud 일본 | [2-tech-stack.md 4-1](../2-tech-stack.md#4-1-프레임워크) |

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
- **개인정보**: 녹음과 대화 기록이 LiveKit Cloud로 갑니다. SIP 참가자의 **전화번호가 트레이스 속성으로 기록**됩니다. 녹음 고지·처리방침·국외 이전 동의([2-tech-stack.md 11장](../2-tech-stack.md#11-직접-재-봐야-할-것))와 함께, 리포트의 마스킹(redaction) 옵션을 검토해야 합니다.

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

해결은 한 줄이었습니다. 세션 시작 옵션 `inputOptions`에 **`deleteRoomOnClose: true`**를 넣으면 세션이 닫힐 때 RoomIO가 방을 지우고, 방이 지워지면 에이전트 연결이 끊겨 잡이 곧바로 끝납니다. LiveKit 문서는 이 옵션을 Python 전용으로 표시하지만, 설치된 Node SDK 1.9.5에도 공개 타입(`RoomInputOptions.deleteRoomOnClose`)으로 있습니다(17-2 #23). 다른 방법은 세션 `Close` 이벤트에서 `ctx.shutdown()`을 부르는 것이었습니다. 그 방법은 잡은 끝내지만 방을 지우지 않습니다. 전화라면 고객이 이미 끊었으니 상관없지만, 방을 지우는 일을 한곳으로 모으려고 `deleteRoomOnClose`를 골랐습니다.

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

외부 API 세 개(Soniox, Anthropic, ElevenLabs)에 의존하므로, 하나만 멈춰도 통화가 멈춥니다. 현재 상태와 선택지입니다.

| 부품 | 지금의 동작 | 선택지 |
| --- | --- | --- |
| STT | 연결 오류 시 코어가 0.5초 뒤 스트림 재생성 | LiveKit의 STT FallbackAdapter (여러 STT를 순서대로) |
| LLM | 첫 출력 전 429·5xx만 재시도. 출력이 시작된 뒤 실패하면 재시도 안 함 | LLM FallbackAdapter, 첫 토큰 시간 초과 시 다른 모델 ([2-tech-stack.md 4-3](../2-tech-stack.md#4-3-llm-대화-두뇌)의 "백업 모델") |
| TTS | 텍스트 보낸 뒤 10초 안에 오디오 없으면 시간 초과 | TTS FallbackAdapter |
| 턴 감지 | 클라우드 실패 시 로컬 mini로 자동 전환 | 이미 있음 |
| 적응형 끼어들기 | 실패 반복 시 VAD 방식으로 전환 | 이미 있음 |
| 노이즈 제거 | 실패 시 원본 통과 | 이미 있음 |

LiveKit 자체 부품들(턴 감지, 끼어들기, 노이즈 제거)은 **실패하면 더 단순한 방식으로 내려가는(graceful degradation)** 설계가 이미 들어 있습니다. 외부 공급사 쪽은 우리가 FallbackAdapter 등으로 설계해야 합니다. "LiveKit Inference(별도 키 없음)"를 대체 경로로 두면 공급사 계정 문제에도 대비할 수 있습니다. 이 프로젝트의 `config.ts`가 이미 `livekit` 공급사를 지원하는 것은 이런 확장의 바탕이 됩니다.

---

## 15-8. 보안·법무 체크리스트

| 영역 | 항목 | 근거 |
| --- | --- | --- |
| 비밀값 | `.env.local` 커밋 금지, 운영은 Secret, LiveKit Cloud는 `--secrets-file` (임시 파일도 `.gitignore`) | [4-setup-checklist.md 10장](../4-setup-checklist.md#10-커밋-전-확인), 15-5 |
| 웹 테스트 접근 | 토큰 발급 함수가 Firebase 로그인 + 관리자 확인. 외부 공개 전 횟수 제한·봇 차단·동의 문구 필요 | 3-7, [6-web-test.md 7장](../6-web-test.md#7-주의) |
| 테스트 직원 고지 | 내부 테스트도 실제 음성이 해외 API로 감 | [6-web-test.md 7장](../6-web-test.md#7-주의) |
| 비용 폭탄 | Anthropic 월 사용 한도, SIP 국제전화 차단·발신 규칙·방화벽 | [7-telephony-setup.md 7장](../7-telephony-setup.md#7-보안-요금-폭탄-막기) |
| 클라우드 자격 증명 (2026-11-05 추가) | AWS는 Bedrock 호출만 허용한 좁은 정책, 장기 키 대신 연동 검토, 쓰지 않는 키 삭제, 예산 알림. 키 값·계정 ID를 공개 레포·스크린샷에 남기지 않음 | 16-5, 16-9 |
| 공급망 | `allowBuilds`, lockfile 고정, 패치 최소화 | 15-3절 |
| 고지 | AI·녹음 고지를 고정 문장으로, 끼어들기 막음 | 9장 |
| 고지 타이밍 | 전화를 **받은 뒤** 고지가 재생되는지 (`waitUntilAnswered`) | 4-6절 |
| 개인정보 수집 | 주민번호·카드번호 묻지 않음 (지시문 + 시나리오) | 9장 |
| 수신 거부 | "전화하지 마세요" → 즉시 종료 (기록 도구는 예정) | 9장 |
| 발신 시간 | 08~21시 (functions-xtool이 검사 예정) | [2-tech-stack.md 6장](../2-tech-stack.md#6-전체-아키텍처) |
| 국외 이전 | 해외 API(Soniox, Anthropic, ElevenLabs, LiveKit Cloud)로 음성·대화가 감 | 법무 검토 |
| 녹음 활용 | 학습 용도로 쓰려면 동의 범위 확인 | [4-setup-checklist.md 7-8](../4-setup-checklist.md#7-상담팀업무-쪽에서-정해-줄-것) |

---

## 15-9. 정리

```text
설정    환경변수 → loadConfig (빨리 실패) → 팩토리 (완전성 검사) → 부품
코드    Node 24가 .ts를 바로 실행 (타입 지우기) ← tsc는 검사만 (엄격 옵션)
의존성  pnpm 12.16.1 고정, lockfile, allowBuilds·overrides·patch
이미지  다단계 빌드, ca-certificates, 비루트, exec CMD (SIGTERM → drain)
        설치 전에 pnpm-workspace.yaml·.npmrc·patches 복사 (lockfile 검사가 잡아 준 문제, 고침)
배포    LiveKit Cloud(원격 빌드, v1·적응형 기본, 미국 리전) 또는 GKE 서울
        GKE면 grace period ≥ 최장 통화, 헬스 체크 8081, CPU 최적화형, 턴 감지·끼어들기 모드 명시
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
6. 고치기 전 Dockerfile의 설치 단계가 실패한 이유와, 실패하지 않았다면 생길 수 있었던 더 위험한 문제는?

<details>
<summary>답 보기</summary>

1. 오타가 조용히 기본값으로 바뀌면 설정이 안 먹었다는 사실을 아무도 모르기 때문입니다. 시작할 때 실패해야 바로 고칩니다.
2. `createSTT`의 모든 경로가 값을 반환하지 않게 되어 컴파일 오류가 납니다. `noImplicitReturns`(와 유니온 타입) 덕분입니다.
3. 선택 속성에 `undefined`를 명시적으로 넣는 것이 타입 오류이고, 라이브러리에 따라 `undefined`가 기본값을 덮어쓰는 버그가 생길 수 있기 때문입니다.
4. Node는 `import type`만 지우므로 일반 import가 남고, 런타임에 그 이름의 export가 없다는 오류가 납니다.
5. 셸이 PID 1이 되어 SIGTERM이 node에 전달되지 않으므로 drain이 일어나지 않고, 유예 시간이 지나면 진행 중인 통화가 강제로 끊깁니다.
6. 설치 시점에 `pnpm-workspace.yaml`이 없어 lockfile의 overrides 설정과 어긋났기 때문에 `--frozen-lockfile`이 실패했습니다. 이 검사가 없었다면 `patches/` 없이 빌드되어, 오류 없이 말 끝 판단만 다시 느려지는 회귀가 생겼을 수 있습니다.

</details>
