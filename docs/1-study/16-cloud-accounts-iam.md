# 16장. 클라우드 계정과 권한: AWS·GCP

(2026-11-05 추가)

LLM을 Amazon Bedrock 도쿄로 옮겨 보려고(13-5절) 처음 AWS를 쓰면서, 호출 한 번이 통과하기까지 **서로 다른 이유의 거절을 여섯 번** 받았습니다. 판정 트리거를 처음 배포할 때는 GCP에서도 권한 문제로 한 번 실패했습니다(15-6절). 이 장은 그 거절들을 교재로 삼아 **클라우드가 "누가, 무엇을, 어디서"를 어떻게 판단하는지**를 층별로 정리합니다.

- 다루는 것: 인증과 인가, AWS 계정·조직·리전, 자격 증명의 종류(액세스 키·STS 임시 자격 증명·Bedrock API 키), SigV4 서명, SDK가 자격 증명을 찾는 순서, IAM 정책 평가와 SCP, Bedrock의 모델 사용 신청·추론 프로필·두 창구, GCP의 서비스 계정·서비스 에이전트, 권한 변경의 전파 지연, 운영에서 키를 다루는 법
- 다루지 않는 것: Bedrock 클라이언트를 Anthropic 플러그인에 끼우는 코드(8-8절)와 Anthropic API와의 A/B 측정 결과(13-5절).
- 이 레포는 공개 저장소라, 본문의 계정 ID·조직 ID·정책 ID는 `<작업 계정 ID>`처럼 가렸습니다. 계정 ID는 비밀번호가 아니지만 알려 줄 이유도 없습니다.

---

## 16-1. 인증과 인가: 거절에는 층이 있다

클라우드 API가 요청을 받으면 세 가지를 차례로 묻습니다.

| 질문 | 이름 | 무엇으로 판단 |
| --- | --- | --- |
| 너는 누구냐 | **인증** (authentication) | 자격 증명: 키, 토큰, 서명 |
| 이걸 해도 되냐 | **인가** (authorization) | 정책: 허용·거부 규칙 |
| 그게 거기 있냐 | 자원 확인 | 계정·리전·모델 목록 |

HTTP 상태 코드로는 보통 401이 인증 실패, 403이 "누군지는 알지만 안 됨"입니다. 하지만 AWS는 서명이 틀린 요청도 403으로 돌려줄 때가 있어서, **숫자보다 응답 본문을 읽어야** 합니다.

### 실제로 받은 거절 (2026-11-05)

같은 목표(도쿄에서 Haiku 5.5 한 번 부르기)를 향해 가며 받은 응답을 순서대로 놓으면, 거절마다 걸린 층이 다릅니다.

| # | 시도 | 응답 | 걸린 층 | 원인 |
| --- | --- | --- | --- | --- |
| 1 | 무료 플랜 계정으로 콘솔에서 도쿄 Bedrock 열기 | "고급 기능 활성화" 안내 | 계정 플랜 | 무료 플랜이 쓸 수 있는 범위 밖. 유료 플랜(쓴 만큼 냄)으로 전환 |
| 2 | 시드니에서 받은 Bedrock API 키로 도쿄 호출 | 401, 자격 증명의 리전 불일치 | 인증 | 단기 API 키는 만든 리전에 묶임 (16-3절) |
| 3 | 도쿄 키로 Mantle 창구 호출 | 인증 통과, Haiku 5.5 없음 | 자원 | 창구마다 모델 목록이 다름 (16-6절) |
| 4 | 같은 키로 bedrock-runtime 창구 호출 | 403, `bedrock:CallWithBearerToken` … `explicit deny in a service control policy` | 인가 (조직) | 조직 정책(SCP)이 API 키 사용을 막음 (16-5절) |
| 5 | IAM 액세스 키(SigV4 서명)로 같은 호출 | 403, `anthropic.claude-haiku-5-5 is not available for this account` | 모델 사용 자격 | 이때는 Anthropic 첫 사용 양식을 내지 않은 상태 (16-6절) |
| 6 | 작업 계정에서 사용 목적 양식 제출 | `PutUseCaseForModelAccess` 거부 | 인가 (조직) | 같은 SCP가 제출도 막음 → 관리 계정에서 제출 |
| 7 | 제출 뒤 45초마다 재시도 (13:20~13:35), 이어서 다른 모델로 같은 호출 | Haiku 5.5는 계속 #5와 같은 403. **같은 키로 Haiku 4.5·Sonnet 4.6은 응답** | 모델 사용 자격 (계정·모델 단위) | 양식은 처리됨. Haiku 5.5만 이 계정에 열리지 않음 → AWS 지원에 요청 (16-6절) |

이 표에서 배울 점은 두 가지입니다.

- **한 번 호출이 통과하려면 모든 층을 통과해야 합니다.** 앞 층을 고치면 다음 층의 거절이 드러납니다. #4를 고치자 #5가 보였습니다. 그래서 "403이 났다, 키가 틀렸나?"처럼 한 층만 의심하면 오래 헤맵니다.
- **거절 메시지는 네 가지를 알려 줍니다.** 누가(`arn:aws:sts::<작업 계정 ID>:assumed-role/AccountFullAccessRole/<세션 이름>`), 무엇을(`bedrock:CallWithBearerToken`), 무엇에 대해(`resource: *`), 왜(`explicit deny in a service control policy`). 이 넷을 읽으면 층이 보입니다.
- **같은 문구라도 원인이 같다는 보장은 없습니다.** #5와 #7은 글자 하나 다르지 않은 403이었지만, #5는 양식을 내기 전이었고 #7은 양식이 처리된 뒤였습니다. 둘을 가른 것은 **조건을 하나만 바꾼 비교**입니다. 키·리전·창구를 그대로 두고 모델만 Haiku 4.5로 바꾸자 응답이 왔으므로, 막힌 것은 계정 전체가 아니라 그 모델 하나라는 결론이 나왔습니다.

---

## 16-2. AWS의 뼈대: 계정, 조직, 리전

### 계정

AWS **계정**은 자원과 청구의 경계입니다. 12자리 숫자 ID가 있고, 한 계정의 자원은 기본적으로 다른 계정에서 보이지 않습니다. 계정을 처음 만들 때 생기는 **루트 사용자**(가입 이메일)는 모든 권한을 가지므로, 평소에는 쓰지 않고 따로 만든 사용자나 역할로 일합니다.

### 조직 (AWS Organizations)

여러 계정을 묶어 청구와 정책을 함께 관리하는 기능입니다. 이 프로젝트의 AWS는 이렇게 생겼습니다.

```text
조직 (Daniel-kang-Team)
├── 관리 계정 (Management Account)        청구·조직 관리. SCP가 적용되지 않음
├── Identity Delegated Admin              사용자·권한 관리를 위임받은 계정
└── Curiosity Unlocked (작업 계정)        Bedrock을 쓰는 곳. SCP가 적용됨
```

- **관리 계정**은 조직의 주인입니다. 조직 전체에 **SCP**(서비스 제어 정책, 16-5절)를 걸 수 있고, 자기 자신에게는 SCP가 적용되지 않습니다. AWS는 관리 계정에서 업무 자원을 돌리지 말라고 권합니다. 권한을 제한할 수 없는 계정이기 때문입니다.
- **멤버 계정**(작업 계정)에서 일하고, 관리 계정은 정말 필요한 일(이번에는 #6의 양식 제출)에만 씁니다.
- 콘솔 오른쪽 위의 **세션 전환**은 한 브라우저에서 여러 계정·신원에 동시에 로그인해 두고 오가는 기능입니다. 이번에 작업 계정과 관리 계정을 오간 방법입니다.

### 콘솔 로그인도 임시 자격 증명이다

16-1절 표 #4의 오류에서 "누가"는 `assumed-role/AccountFullAccessRole/<세션 이름>`이었습니다. 콘솔에 로그인한 사람의 신원이 **역할(role)을 맡은 임시 세션**이라는 뜻입니다. 사람이 콘솔에서 누르는 버튼도 결국 STS(16-3절)가 발급한 임시 자격 증명으로 서명된 API 호출입니다. 그래서 그 세션으로 만든 단기 Bedrock API 키도 같은 신원(역할 세션)으로 기록됩니다.

### 리전

대부분의 서비스와 자원은 **리전**(예: 도쿄 `ap-northeast-1`, 오사카 `ap-northeast-3`, 서울 `ap-northeast-2`, 시드니 `ap-southeast-2`) 단위로 따로 존재합니다. IAM처럼 전역인 서비스도 있습니다.

- 콘솔 홈은 리전이 없는 화면이라 리전 메뉴가 안 보입니다. 서비스 화면으로 들어가거나 주소에 리전을 넣어 고정합니다(`https://ap-northeast-1.console.aws.amazon.com/bedrock/home?region=ap-northeast-1`).
- 이번에 처음 받은 키가 시드니 것이었던 이유도 리전입니다(#2). 키를 받을 때 콘솔이 시드니 리전에 있었습니다(무료 플랜에서는 도쿄를 열 수 없었음, #1).
- **같은 서비스라도 리전마다 제공하는 모델이 다릅니다.** 서울 Bedrock은 Haiku 5.5를 `global.` 프로필로만 주고, 도쿄는 일본 안에서만 처리하는 `jp.` 프로필도 줍니다(16-6절, [5-poc-results.md](../5-poc-results.md) 조사).

---

## 16-3. 자격 증명의 종류

"너는 누구냐"에 답하는 방법은 여러 가지입니다. 이번에 만난 것만 정리합니다.

| 종류 | 생김새 | 수명 | 요청에 싣는 방식 | 이번에 |
| --- | --- | --- | --- | --- |
| IAM 사용자 **액세스 키** | `AKIA…` + 비밀 키 | 지울 때까지 (직접 교체) | SigV4 서명 | `.env.local`의 `AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`. 지금 쓰는 방식 |
| STS **임시 자격 증명** | `ASIA…` + 비밀 키 + 세션 토큰 | 15분~12시간 | SigV4 서명 + `X-Amz-Security-Token` | 콘솔 로그인 세션(역할 맡기) |
| Bedrock **단기 API 키** | `bedrock-api-key-…` | 최대 12시간, 또는 만든 세션이 끝날 때까지 | `Authorization: Bearer …` | 처음 받은 키. SCP에 막힘 |
| Bedrock **장기 API 키** | 같은 접두사 | 1일~무기한 (만들 때 정함) | `Authorization: Bearer …` | 쓰지 않음 |

### 장기 키와 임시 자격 증명

- **IAM 사용자**는 "사람이나 프로그램 하나"를 나타내는 오래 사는 신원이고, 액세스 키는 그 사용자의 **장기 자격 증명**입니다. 새면 누가 지울 때까지 계속 쓸 수 있습니다.
- **IAM 역할**은 "모자"에 가깝습니다. 정해진 사람이나 서비스가 잠시 쓰고, 쓰는 동안 **STS**(Security Token Service)가 임시 자격 증명을 줍니다. 만료되면 저절로 쓸모가 없어지므로, 새도 피해가 시간으로 제한됩니다.
- AWS가 권하는 방향은 "사람은 역할로 로그인하고, 프로그램도 가능하면 역할을 맡게 하라"입니다. 이 프로젝트가 IAM 사용자 키를 쓰는 이유와 대안은 16-9절에 있습니다.

### Bedrock API 키: 베어러 토큰

Bedrock API 키는 **베어러(bearer) 토큰**입니다. 이름 그대로 "가진 사람이 주인"인 토큰이라, 요청에 그대로 실어 보내고 서버는 토큰만 보고 신원을 판단합니다. 쓰기는 가장 쉽지만 새면 그대로 남이 씁니다.

- **단기 키**는 만든 신원(이번에는 콘솔의 역할 세션)의 권한을 그대로 이어받습니다. AWS가 공개한 토큰 생성 라이브러리(`aws-bedrock-token-generator`)를 보면, 단기 키는 **SigV4로 미리 서명한 URL을 문자열로 감싼 것**입니다. 서명에 리전이 들어가므로 키가 리전에 묶이고(#2), 서명에 만료 시각이 들어가므로 최대 12시간 뒤 쓸모가 없어집니다. 클라이언트에서 서명만으로 만들어지므로 **만드는 것 자체는 막을 수 없고, 쓰는 것만 막을 수 있습니다**(AWS 문서).
- **장기 키**는 IAM 사용자에 딸린 서비스 전용 자격 증명입니다. 콘솔에서 만들면 그 키를 위한 IAM 사용자가 함께 생깁니다. AWS는 장기 키를 탐색용으로만 권합니다.

### SigV4: 비밀 키를 보내지 않고 증명하기

IAM 액세스 키는 요청에 싣지 않습니다. 대신 요청마다 **서명**을 만들어 붙입니다. 이것이 Signature Version 4(SigV4)입니다.

```text
1. 정규 요청(canonical request)을 만든다
     메서드 + 경로(인코딩 규칙 고정) + 쿼리 + 서명할 헤더들 + 본문의 SHA-256
2. 서명할 문자열 = "AWS4-HMAC-SHA256" + 시각 + 범위(날짜/리전/서비스/aws4_request) + 1의 해시
3. 서명 키를 비밀 키에서 단계적으로 끌어낸다
     kDate    = HMAC("AWS4" + 비밀 키, 날짜)
     kRegion  = HMAC(kDate, 리전)
     kService = HMAC(kRegion, 서비스)
     kSigning = HMAC(kService, "aws4_request")
4. 서명 = HMAC(kSigning, 2의 문자열)  → Authorization 헤더에 액세스 키 ID·범위·서명을 실음
```

서버도 같은 계산을 해서 서명이 맞는지 봅니다. 이 설계에서 나오는 성질이 셋 있습니다.

- **비밀 키는 네트워크로 나가지 않습니다.** 중간에서 엿봐도 얻는 것은 그 요청 하나의 서명뿐입니다.
- **서명은 그 요청에만 맞습니다.** 경로나 본문을 바꾸면 해시가 달라져 서명이 틀립니다. 시각이 들어가므로 몇 분이 지나면 같은 요청을 다시 보내도 거절됩니다(재전송 공격 방지).
- **서명 키는 날짜·리전·서비스로 좁혀집니다.** 3단계의 사슬 때문입니다. 도쿄 Bedrock용으로 끌어낸 키로는 다른 리전이나 서비스의 요청을 서명할 수 없습니다.

1단계의 "경로 인코딩 규칙"은 실제로 함정이었습니다. 다른 작업에서 `curl --aws-sigv4`로 콜론(`:`)이 든 모델 ID(`…-v1:0`)를 부르자, 서버가 "우리가 계산한 서명과 다르다"며 자기가 기대한 정규 요청(콜론이 `%3A`로 인코딩된 경로)을 돌려줬습니다. 서명하는 쪽과 서버가 경로를 다르게 인코딩하면 키가 맞아도 실패합니다. SDK가 이런 규칙을 대신 처리해 주는 것이 **직접 서명하지 말고 SDK를 쓰는** 이유입니다.

---

## 16-4. SDK는 자격 증명을 어디서 찾나

코드에 키를 넣지 않아도 AWS SDK는 정해진 순서로 자격 증명을 찾습니다. 이것을 **자격 증명 체인**(credential provider chain)이라고 합니다. Node용 기본 체인은 대략 이 순서입니다.

```text
환경변수 (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
→ SSO 로그인 캐시
→ 공유 파일 (~/.aws/credentials, ~/.aws/config의 프로필)
→ 외부 프로세스 (credential_process)
→ 웹 ID 토큰 파일 (AWS_WEB_IDENTITY_TOKEN_FILE + 역할 → STS)
→ 컨테이너·인스턴스 메타데이터 (ECS 작업 역할, EC2 인스턴스 역할)
```

앞에서 찾으면 뒤는 보지 않습니다. 같은 코드가 노트북에서는 환경변수로, AWS 서버에서는 인스턴스 역할로 인증되는 것이 이 체인 덕분입니다.

### Bedrock SDK의 우선순위

이 프로젝트가 쓰는 `@anthropic-ai/bedrock-sdk` 1.1.1은 그 앞에 **Bedrock API 키**를 끼웁니다(`node_modules/@anthropic-ai/bedrock-sdk/client.js`의 생성자 주석과 코드, `core/auth.js`).

```text
1. 생성자의 apiKey 인자
2. 환경변수 AWS_BEARER_TOKEN_BEDROCK         ← 있으면 여기서 끝 (베어러 토큰)
3. 생성자의 awsAccessKey·awsSecretKey·awsSessionToken
4. 환경변수 AWS_ACCESS_KEY_ID·AWS_SECRET_ACCESS_KEY  ← SigV4
5. 기본 체인 (위)
```

- 2단계에서 토큰을 찾으면 SigV4 서명을 하지 않고 `Authorization: Bearer`로 보냅니다.
- `ANTHROPIC_API_KEY`는 일부러 읽지 않습니다. 코드 주석에 "Bedrock의 인증 수단이 아닌데, 읽으면 SigV4 서명을 막는다"고 적혀 있습니다. 같은 `.env.local`에 Anthropic 키가 함께 있어도 안전한 이유입니다.
- 생성자에 `apiKey: null`을 주면 2단계의 환경변수를 보지 않습니다(코드 주석: "`null` clears the key … may not go back to the environment").

### 함정: 남아 있는 베어러 토큰이 IAM 키를 이긴다 (17-2 #26, 2026-11-05 고침)

Bedrock을 붙인 직후 `.env.local`에는 처음 받은 단기 API 키(`AWS_BEARER_TOKEN_BEDROCK`)와 새로 만든 IAM 액세스 키가 **함께** 있었습니다. 처음 커밋된 코드(`144d25b`)는 클라이언트를 `new AnthropicBedrock({ awsRegion, maxRetries: 0 })`로 만들었고, 워커와 측정 스크립트는 시작할 때 `.env.local`을 환경변수로 읽습니다. 그러면 위 순서의 2단계에서 API 키가 먼저 잡혀, **IAM 키가 있어도 SCP에 막힌 방식(#4)으로 호출합니다.**

- 다른 작업의 확인용 `curl`과 A/B 측정용 임시 스크립트는 이 변수를 지우고(`unset`, `delete process.env.AWS_BEARER_TOKEN_BEDROCK`) 돌려서 드러나지 않았습니다.
- 고치는 방법은 둘이었습니다. `.env.local`에서 그 줄을 지우거나(어차피 단기 키라 만료됨), 클라이언트를 `apiKey: null`로 만들어 SigV4만 쓰게 하는 것입니다. 후자가 "이 경로는 IAM 키로만 인증한다"는 의도를 코드에 남깁니다.
- **고친 뒤.** 두 가지가 모두 됐습니다. `.env.local`의 그 줄은 지워졌고, [src/models/index.ts](../../src/models/index.ts)의 `createBedrockClient()`가 `apiKey: null`로 만듭니다. [src/models/index.test.ts](../../src/models/index.test.ts)는 남은 변수를 흉내 내고, 요청의 `Authorization` 머리글이 `AWS4-HMAC-SHA256`(SigV4)으로 시작하는지 봅니다. `apiKey: null`을 빼면 이 테스트가 실패하는 것도 확인했습니다. 실제 IAM 키에 가짜 남은 변수를 넣고 한 번 불렀을 때는 인증을 지나 모델 사용 자격 403(#7)까지 갔습니다.

이 함정은 8-8절의 "import 시점에 읽는 환경변수"와 같은 계열입니다. **암묵적으로 읽는 설정은 우선순위가 정해져 있고, 그 순서를 모르면 내가 넣은 값이 아닌 다른 값이 쓰입니다.** 인증 수단처럼 정책과 얽힌 설정은 명시적으로 고르는 편이 안전합니다.

---

## 16-5. 인가: IAM 정책은 어떻게 평가되나

### 정책의 모양

IAM 정책은 JSON 문서이고, 규칙(statement) 하나는 이렇게 읽습니다.

```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModelWithResponseStream"],
  "Resource": ["arn:aws:bedrock:ap-northeast-1:<계정 ID>:inference-profile/jp.anthropic.claude-haiku-5-5"],
  "Condition": { "...": "..." }
}
```

"이 **효과**(허용·거부)를, 이 **동작**에 대해, 이 **자원**에서, 이 **조건**일 때"입니다. 자원은 ARN(`arn:aws:서비스:리전:계정:자원`)으로 가리킵니다.

정책은 붙는 곳에 따라 종류가 나뉩니다.

| 종류 | 어디에 붙나 | 하는 일 |
| --- | --- | --- |
| 신원 기반 정책 | 사용자·역할 | "이 신원은 무엇을 할 수 있나" (권한을 **줌**) |
| 자원 기반 정책 | S3 버킷 등 자원 | "누가 이 자원을 쓸 수 있나" |
| **SCP** | 조직의 계정·조직 단위 | "이 계정 안의 누구도 이 이상은 못 한다" (상한, 권한을 **주지 않음**) |
| 권한 경계, 세션 정책 | 사용자·역할, 세션 | 추가 상한 |

### 평가 순서

요청 하나가 들어오면 AWS는 관련된 정책을 모두 모아 이렇게 판단합니다(단순화한 그림).

```text
1. 기본값은 거부
2. 어디든 "명시적 거부(Deny)"가 맞으면 → 거부. 끝. (어떤 허용도 이것을 뒤집지 못함)
3. SCP가 이 동작을 허용 범위에 두는가? 아니면 → 거부
4. 신원 기반(또는 자원 기반) 정책에 허용(Allow)이 있는가? 없으면 → 거부 (1의 기본값)
5. 권한 경계·세션 정책도 허용하는가? → 허용
```

핵심 규칙은 **명시적 거부 > 허용 > 기본 거부**입니다. #4의 메시지가 바로 2단계였습니다. 작업 계정의 콘솔 역할은 이름부터 `AccountFullAccessRole`(계정 전체 권한)이었지만, 조직의 SCP가 `bedrock:CallWithBearerToken`을 명시적으로 거부했으므로 허용이 아무리 넓어도 소용없었습니다.

### SCP는 왜 API 키를 막았나

조직 SCP의 실제 내용은 작업 계정에서 조회 권한이 없어 보지 못했습니다(추정). 다만 AWS 문서의 Bedrock 예시 SCP에 **API 키 만들기(`iam:CreateServiceSpecificCredential`)와 쓰기(`bedrock:CallWithBearerToken`)를 함께 막는 정책**이 있고, 메시지가 그 동작과 정확히 맞습니다. 베어러 토큰은 새면 그대로 쓰이므로(16-3절), 보안을 중시하는 조직이 흔히 거는 규칙입니다.

여기서 한 가지가 더 설명됩니다. #3에서 같은 키가 **Mantle 창구에서는 인증을 통과**했습니다. AWS 문서에 따르면 Mantle 창구의 API 키 사용은 별도 동작(`bedrock-mantle:CallWithBearerToken`)이라, `bedrock:CallWithBearerToken`만 막으면 Mantle은 막히지 않습니다. 같은 키가 창구에 따라 통과하고 막힌 이유입니다.

### 최소 권한: 지금 정책과 운영용 정책

지금 IAM 사용자에는 AWS 관리형 정책 `AmazonBedrockLimitedAccess`가 붙어 있습니다. 시험하기에는 편하지만, 이 에이전트가 쓰는 호출 하나보다 훨씬 넓은 범위를 허용합니다. 운영에 올릴 때는 **이 에이전트가 실제로 하는 일만** 허용하는 정책으로 바꿉니다. 원리는 이렇습니다.

- 에이전트는 Anthropic 플러그인으로 스트리밍 호출만 하고, Bedrock SDK는 이것을 `/model/{모델}/invoke-with-response-stream`으로 보냅니다(`client.js`). 그래서 필요한 동작은 `bedrock:InvokeModelWithResponseStream` 하나입니다.
- `jp.` 같은 지역형 추론 프로필(16-6절)로 부르면, 요청이 프로필이 가리키는 여러 리전으로 갈 수 있습니다. AWS 문서는 **프로필 ARN과, 프로필이 보낼 수 있는 모든 리전의 기본 모델 ARN**을 함께 허용하라고 합니다. `jp.`는 도쿄와 오사카입니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeThroughJpProfile",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModelWithResponseStream",
      "Resource": "arn:aws:bedrock:ap-northeast-1:<작업 계정 ID>:inference-profile/jp.anthropic.claude-haiku-5-5"
    },
    {
      "Sid": "ModelInProfileRegions",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModelWithResponseStream",
      "Resource": [
        "arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-haiku-5-5",
        "arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.claude-haiku-5-5"
      ],
      "Condition": {
        "StringEquals": {
          "bedrock:InferenceProfileArn": "arn:aws:bedrock:ap-northeast-1:<작업 계정 ID>:inference-profile/jp.anthropic.claude-haiku-5-5"
        }
      }
    }
  ]
}
```

- 기본 모델 ARN에는 계정 칸이 비어 있습니다(`::`). AWS가 가진 공용 자원이기 때문입니다.
- 두 번째 규칙의 조건은 "기본 모델은 **이 프로필을 거쳐서만** 부를 수 있다"는 뜻입니다. 프로필 없이 오사카 모델을 바로 부르는 것은 허용하지 않습니다.
- **빠뜨리기 쉬운 것:** 서버리스 모델은 첫 호출 때 AWS Marketplace 구독이 자동으로 만들어지는데, AWS 문서에 따르면 그 첫 호출을 하는 신원에게 `aws-marketplace:Subscribe`·`Unsubscribe`·`ViewSubscriptions` 권한이 있어야 합니다. 관리자가 한 번 먼저 불러 구독을 만들어 두면 이후 신원에게는 필요 없습니다. 지금의 관리형 정책이 이것을 포함하는지는 확인 필요입니다.
- 이 정책은 원리를 보여 주는 예시입니다. 운영 전환 때 실제 호출로 검증합니다.

---

## 16-6. Bedrock에서만 쓰는 개념

### 모델 사용 신청

예전에는 Bedrock 콘솔의 "모델 액세스" 화면에서 모델마다 켜야 했습니다. AWS 공지에 따르면 2025년 10월부터 서버리스 모델은 **첫 호출 때 자동으로 열리고**(최대 15분), 예외가 하나 남았습니다.

- **Anthropic 모델은 첫 사용 양식**(회사명, 웹사이트, 용도, 사용자가 내부인지 외부인지)을 **계정마다 한 번, 또는 조직의 관리 계정에서 한 번** 내야 합니다. 관리 계정에서 내면 멤버 계정에 이어집니다.
- #5의 "not available for this account"가 이 양식을 내지 않은 상태의 응답이었습니다. 인증과 IAM 인가를 모두 통과한 뒤에 나오는 거절이라 "키는 맞다"는 뜻이기도 합니다.
- 양식이 처리된 뒤에도 Haiku 5.5만 같은 문구로 막혔습니다(#7). 같은 키로 Haiku 4.5와 Sonnet 4.6은 도쿄에서 응답했습니다. 오류 문구가 "추가 접근은 AWS 영업팀에 문의하라"고 안내하는 것처럼, 계정에 따라 최신 모델을 바로 열어 주지 않는 경우가 있는 것으로 보입니다(추정). 2026-11-05 현재 AWS 지원에 열어 달라고 요청하는 단계입니다.
- 작업 계정에서는 양식 조회(`GetUseCaseForModelAccess`)와 제출(`PutUseCaseForModelAccess`)이 모두 SCP에 막혀(#6), **SCP가 적용되지 않는 관리 계정**에서 냈습니다. 16-2절의 조직 구조가 실제로 쓰인 순간입니다.
- AWS 문서에 따르면 이 양식 요구는 Mantle 창구에는 적용되지 않습니다. 다만 도쿄 Mantle에는 Haiku 5.5가 없어 이 길로는 피할 수 없었습니다(#3).

### 추론 프로필: 어디서 처리하나

같은 모델을 부르는 ID가 셋입니다.

| ID | 뜻 | 처리 위치 |
| --- | --- | --- |
| `anthropic.claude-haiku-5-5` | 기본 모델 | 부른 리전 (Haiku 5.5는 이 방식을 어느 리전에서도 지원하지 않음) |
| `jp.anthropic.claude-haiku-5-5` | **지역형** 교차 리전 추론 프로필 | 일본 안 (도쿄·오사카) |
| `global.anthropic.claude-haiku-5-5` | **전역** 교차 리전 추론 프로필 | 전 세계 어디든 |

**추론 프로필**은 "이 요청을 어느 리전들로 보내도 되는가"를 정한 이름입니다. 한 리전이 붐비면 다른 리전으로 보내 처리량을 늘립니다. 지역형은 데이터가 그 지역 밖으로 나가지 않는 대신 고를 수 있는 리전이 적고, 전역은 그 반대입니다. Anthropic 문서 기준으로 지역형은 전역보다 약 10% 비쌉니다.

13-5절의 "접속 지점(edge)과 처리 위치(region)는 다르다"가 여기서 구체적인 선택지가 됩니다. 서울에서 도쿄 `bedrock-runtime`에 접속해도 `global.`을 쓰면 처리는 어디서든 될 수 있습니다. 지연을 줄이려는 목적이면 `jp.`를 써야 합니다.

### 두 창구: bedrock-runtime과 Mantle

| | bedrock-runtime | Mantle |
| --- | --- | --- |
| 주소 | `bedrock-runtime.<리전>.amazonaws.com` | `bedrock-mantle.<리전>.api.aws` |
| 요청 모양 | Bedrock 고유: 모델이 경로에(`/model/{id}/invoke-with-response-stream`), 본문에 `anthropic_version: "bedrock-2023-05-31"` | OpenAI 호환(`/v1`), Anthropic 호환(`/anthropic/v1/messages`) |
| 스트리밍 | AWS 이진 이벤트 스트림 | 원래 API 형식 |
| API 키 동작 이름 | `bedrock:CallWithBearerToken` | `bedrock-mantle:CallWithBearerToken` |
| 도쿄의 Haiku 5.5 (2026-11-05) | 있음 (`jp.`·`global.`) | 없음 (Haiku 4.5, Opus 4.7, Opus 4.8만) |

Bedrock SDK는 bedrock-runtime의 차이를 감춰 줍니다(`client.js`, `core/streaming.js`).

- Anthropic Messages API 모양의 요청에서 `model`·`stream`을 빼 경로로 옮기고, `anthropic_version`을 본문에 넣습니다.
- 응답의 AWS 이진 이벤트 스트림을 Anthropic API와 같은 SSE로 바꿔 돌려줍니다. 그래서 8-6절의 SSE를 기대하는 플러그인 코드가 그대로 동작합니다.

플러그인에 이 클라이언트를 끼우는 방법과 그 대가(타입 강제 변환)는 Bedrock 작업이 끝난 뒤 8장에 정리합니다.

---

## 16-7. GCP 쪽: 서비스 계정과 서비스 에이전트

functions-xtool(통화 결과 저장·판정, 15-6절)은 Firebase, 즉 GCP 프로젝트 위에서 돕니다. GCP의 권한 모델은 AWS와 단어가 다릅니다.

| 개념 | GCP | AWS에 빗대면 |
| --- | --- | --- |
| 경계 | 조직 → 폴더 → **프로젝트** → 자원 (위에서 준 권한이 아래로 상속) | 조직 → 계정 |
| 권한 묶음 | **역할**(role): `roles/…` 권한 목록. 기본·사전 정의·커스텀 | 정책 |
| 권한 주기 | 자원의 허용 정책에 **바인딩**(주체 + 역할) 추가 | 신원에 정책 붙이기 |
| 프로그램의 신원 | **서비스 계정** (`이름@프로젝트.iam.gserviceaccount.com`) | IAM 역할 |
| 구글 서비스가 내 프로젝트에서 쓰는 신원 | **서비스 에이전트** (`service-<프로젝트 번호>@gcp-sa-<서비스>.iam.gserviceaccount.com`) | 서비스 연결 역할 |

AWS와 가장 다른 점은 **"역할"이라는 단어**입니다. AWS의 역할은 맡을 수 있는 신원이고, GCP의 역할은 권한 묶음입니다. GCP에서 AWS 역할에 해당하는 것은 서비스 계정입니다.

### 사례: 판정 트리거의 첫 배포 실패 (2026-11-03)

`extractVoiceCallJudgment`는 Firestore 문서가 생기면 도는 2세대 함수입니다. 2세대 Firestore 트리거는 **Eventarc**라는 이벤트 전달 서비스를 거칩니다.

```text
Firestore 문서 생성 → Eventarc(서비스 에이전트가 이벤트를 받아 전달) → Cloud Run 위의 함수
```

- 이 프로젝트에서 Eventarc를 처음 쓰는 배포였고, 다른 함수 3개는 배포됐지만 트리거만 실패했습니다. Firebase CLI는 "Eventarc 서비스 에이전트의 권한이 아직 준비되지 않았을 수 있으니 몇 분 뒤 다시 배포하라"는 취지로 안내했습니다.
- 원인은 **서비스 에이전트가 처음 만들어지고 역할을 받는 일이 배포보다 늦게 퍼진 것**입니다. 내 코드나 내 권한 문제가 아니라 구글 쪽 신원의 준비 문제입니다.
- 대응은 둘입니다. 몇 분 기다려 그 함수만 다시 배포하거나, 그래도 실패하면 서비스 에이전트에 역할을 직접 줍니다.

```bash
gcloud projects add-iam-policy-binding <프로젝트 ID> \
  --member="serviceAccount:service-<프로젝트 번호>@gcp-sa-eventarc.iam.gserviceaccount.com" \
  --role="roles/eventarc.serviceAgent"
```

콘솔에서는 IAM 화면에서 "Google 제공 역할 부여 포함"을 체크해야 서비스 에이전트가 보입니다. 평소에는 숨겨 둘 만큼 사용자가 직접 다룰 일이 드문 신원이라는 뜻입니다.

### 비밀값

functions-xtool의 비밀값(`VOICE_AGENT_SECRET`, `ANTHROPIC_API_KEY` 등)은 `defineSecret`으로 선언하고 Secret Manager에 넣습니다([6-web-test.md 6-1](../6-web-test.md)). 함수가 그 비밀을 읽으려면 함수의 실행 서비스 계정에 읽기 권한이 있어야 합니다. Firebase CLI가 배포 때 이것을 처리해 주므로 평소에는 보이지 않습니다.

---

## 16-8. 권한 변경은 바로 퍼지지 않는다

AWS의 #7과 GCP의 트리거 실패는 같은 현상입니다. **권한·신원 시스템은 여러 리전에 복제된 분산 시스템이고, 변경은 "결국에는" 모든 곳에 반영됩니다**(최종 일관성, eventual consistency). 방금 준 권한이 다음 요청에서 바로 보인다는 보장이 없습니다.

| 변경 | 전파에 걸린 시간 |
| --- | --- |
| AWS 서버리스 모델의 첫 호출 자동 구독 | 최대 15분 (AWS 문서) |
| Anthropic 사용 양식 제출 → 작업 계정에서 호출 | 13:20 제출, 13:36에는 Haiku 4.5·Sonnet 4.6이 응답 (이전 상태는 확인 못 함). Haiku 5.5는 양식과 별개로 막힘 (16-6절) |
| GCP Eventarc 서비스 에이전트 준비 | 몇 분 (Firebase 안내) |

여기서 나오는 작업 원칙은 셋입니다.

- **변경 직후의 실패 한 번으로 결론을 내지 않습니다.** 같은 요청을 간격을 두고 다시 보내 봅니다. 다른 작업이 45초마다 다시 부른 것이 이 방식입니다.
- **기다림에는 끝을 정합니다.** 문서에 적힌 전파 시간(예: 15분)을 넘겨도 그대로면 전파가 아니라 다른 원인을 의심하고, 조건을 하나만 바꾼 비교로 층을 다시 가릅니다. #7에서 모델만 바꿔 본 것이 그 예입니다(16-1절).
- **다시 시도할 때는 무엇이 바뀌었는지 응답 본문을 비교합니다.** 403의 문구가 #4에서 #5로 바뀐 것처럼, 같은 숫자 안에서 층이 넘어가는 것이 진전입니다.
- **배포 자동화에는 재시도를 넣습니다.** 사람이 기다렸다 다시 누르는 일을 스크립트가 지수 백오프로 대신합니다.

---

## 16-9. 운영에서 자격 증명 다루기

### 키가 사는 곳

| 비밀값 | 로컬 | LiveKit Cloud 배포 | GKE 배포 (예정) | functions-xtool |
| --- | --- | --- | --- | --- |
| Anthropic·ElevenLabs·Soniox 키 | `.env.local` | 비밀값 저장소 (`--secrets-file`, 15-5절) | Kubernetes Secret | — |
| AWS (Bedrock) | `.env.local` | 비밀값 저장소 | Secret, 또는 키 없이 연동 (아래) | — |
| `VOICE_AGENT_SECRET` | `.env.local` | 비밀값 저장소 | Secret | Secret Manager |

### 장기 키를 줄이는 길

IAM 사용자 액세스 키는 지울 때까지 사는 장기 자격 증명이라, 새면 피해가 시간으로 제한되지 않습니다. 워커를 어디서 돌리느냐에 따라 대안이 다릅니다.

- **LiveKit Cloud에 올리면:** 비밀값을 환경변수로만 넘길 수 있어 IAM 사용자 키가 현실적인 선택입니다. 위험은 이렇게 줄입니다.
  - 16-5절의 좁은 정책
  - 키 교체 주기
  - 예산 알림
  - 다만 LiveKit Cloud 에이전트 리전(미국·유럽·뭄바이)에서는 도쿄 Bedrock의 이점이 줄어듭니다(13-5절).
- **GKE 서울에 올리면:** 키 없이 연동하는 방법이 있습니다(**워크로드 아이덴티티 연동**).
  1. 파드가 GCP 서비스 계정의 신원으로 구글이 서명한 ID 토큰을 받습니다.
  2. AWS STS의 `AssumeRoleWithWebIdentity`에 그 토큰을 내고 AWS 역할의 **임시 자격 증명**을 받습니다.
  3. 16-4절 체인의 "웹 ID 토큰" 단계가 이것을 자동으로 처리합니다.
  4. 장기 키가 아예 없으므로 샐 것도 없습니다.

  선택지로만 조사했고, 구현은 하지 않았습니다(확인 필요).

### 키 위생

- 키 값은 대화, 스크린샷, 이슈에 붙이지 않습니다. 이번에 시드니 단기 키 일부가 스크린샷에 찍혔지만, 서명이 키 뒷부분에 있고 12시간 안에 만료되는 키라 위험이 낮았습니다. 장기 키였다면 바로 비활성화하고 새로 만들었어야 합니다.
- 키가 새면 순서는 **비활성화 → 새 키 발급·교체 → 옛 키 삭제**입니다. 먼저 지우면 운영이 멈춥니다.
- 쓰지 않는 키는 `.env.local`에서 지웁니다. 남겨 둔 키는 16-4절처럼 다른 키보다 먼저 쓰일 수 있습니다. 다른 서비스 이름(`OPENAI_API_KEY`)으로 넣은 키도 헷갈림의 원인이라 정리합니다.
- AWS는 유료 플랜으로 바꾸면 실수로 켠 다른 서비스도 과금되므로 **예산 알림**(Billing → Budgets, 예: 월 $10)을 겁니다. 15-8절의 "비용 폭탄"과 같은 이유입니다.

---

## 16-10. 정리

```text
층        계정 플랜 → 인증(자격 증명·리전) → 자원(창구·모델 목록) → 인가(SCP → IAM) → 모델 사용 자격 → 전파
읽는 법   거절 본문의 누가/무엇을/무엇에/왜. 403 숫자보다 문구, 문구가 바뀌면 다음 층으로 넘어간 것
          같은 문구라도 원인은 다를 수 있음 → 조건 하나만 바꾼 비교로 가름
자격 증명 장기 키(AKIA, SigV4) / 임시(ASIA + 세션 토큰, STS) / 베어러(Bedrock API 키, 가진 사람이 주인)
SigV4     비밀 키는 안 보냄, 요청·시각·리전·서비스에 묶인 서명
SDK       자격 증명 체인. Bedrock SDK는 AWS_BEARER_TOKEN_BEDROCK이 IAM 키보다 먼저 (#26)
인가      명시적 거부 > 허용 > 기본 거부. SCP는 상한일 뿐 권한을 주지 않음, 관리 계정에는 미적용
Bedrock   Anthropic 첫 사용 양식(관리 계정에서 한 번), jp.(일본 안)·global.(어디든), runtime vs Mantle
GCP       역할 = 권한 묶음, 서비스 계정 = 프로그램 신원, 서비스 에이전트 = 구글 서비스의 신원
운영      최소 권한, 장기 키 줄이기(연동), 쓰지 않는 키 지우기, 예산 알림, 변경 뒤에는 재시도
```

---

## 확인 문제

1. 처음 받은 Bedrock API 키로 도쿄를 부르자 401이 났습니다. 키 값이 맞는데도 거절된 이유를 단기 키가 만들어지는 방식으로 설명하세요.
2. 작업 계정의 콘솔 역할 이름은 `AccountFullAccessRole`이었는데 왜 `bedrock:CallWithBearerToken`이 거부됐습니까? IAM 평가 순서의 어느 단계입니까?
3. 같은 Bedrock API 키가 Mantle 창구에서는 인증을 통과하고 bedrock-runtime에서는 막혔습니다. 왜 그렇습니까?
4. IAM 키로 바꾼 뒤 받은 "not available for this account"는 무엇을 뜻하고, 왜 이 양식을 관리 계정에서 내야 했습니까?
5. `.env.local`에 `AWS_BEARER_TOKEN_BEDROCK`과 `AWS_ACCESS_KEY_ID`가 함께 있을 때, 처음 코드의 `new AnthropicBedrock({ awsRegion })`은 어느 쪽으로 인증합니까? 의도대로 IAM 키를 쓰게 하는 방법 두 가지는?
6. SigV4에서 서명 키를 비밀 키로부터 날짜·리전·서비스 순으로 끌어내는 설계의 이점은 무엇입니까?
7. 지역형 추론 프로필 `jp.`로 부르는 에이전트에게 프로필 ARN만 허용하면 왜 부족합니까?
8. GCP의 "역할"과 AWS의 "역할"은 어떻게 다릅니까? Eventarc 트리거 배포 실패에서 권한을 받아야 했던 신원은 무엇이었습니까?
9. 사용 목적 양식을 낸 뒤에도 Haiku 5.5 호출은 전과 똑같은 403 문구를 받았습니다. "아직 전파 중"과 "이 모델만 따로 막힘"을 어떻게 가를 수 있습니까?

<details>
<summary>답 보기</summary>

1. 단기 키는 SigV4로 미리 서명한 URL을 감싼 것이고, 서명 범위에 리전(시드니)이 들어갑니다. 도쿄 서버는 다른 리전 범위로 서명된 자격 증명을 받아들이지 않으므로 인증 단계에서 거절합니다.
2. 조직 SCP의 명시적 거부 때문입니다. 평가 순서에서 명시적 거부는 어떤 허용보다 먼저 판단되고(2단계), SCP는 계정 안의 모든 신원에게 적용되는 상한이라 역할의 허용이 아무리 넓어도 뒤집지 못합니다.
3. API 키 사용 동작이 창구마다 다르기 때문입니다. bedrock-runtime은 `bedrock:CallWithBearerToken`, Mantle은 `bedrock-mantle:CallWithBearerToken`입니다. SCP가 앞의 것만 거부하면 Mantle은 막히지 않습니다.
4. 인증과 IAM 인가는 통과했지만 계정에 Anthropic 모델 사용 자격이 없다는 뜻입니다. 첫 사용 양식이 필요합니다. 작업 계정에서는 양식 조회·제출 API도 SCP에 막혔고, 관리 계정에는 SCP가 적용되지 않으며 거기서 낸 양식은 멤버 계정에 이어지므로 관리 계정에서 냈습니다.
5. 베어러 토큰(`AWS_BEARER_TOKEN_BEDROCK`)으로 인증합니다. Bedrock SDK에서는 환경변수 토큰이 액세스 키보다 우선합니다. 방법은 `.env.local`에서 그 줄을 지우는 것, 또는 클라이언트를 `apiKey: null`로 만들어 SigV4만 쓰게 하는 것입니다. 지금 코드(`createBedrockClient()`)는 후자입니다.
6. 서명 키가 그 날짜·리전·서비스에서만 쓸모가 있어, 서명 키나 서명이 새도 피해 범위가 좁습니다.
7. 지역형 프로필은 요청을 도쿄나 오사카의 기본 모델로 보냅니다. 그래서 그 두 리전의 기본 모델 ARN에 대한 허용도 필요합니다. 하나라도 빠지면 그 리전으로 간 요청이 거부됩니다.
8. GCP의 역할은 권한 묶음이고(AWS의 정책에 가까움), AWS의 역할은 맡을 수 있는 신원입니다(GCP의 서비스 계정에 가까움). 권한을 받아야 했던 것은 Eventarc 서비스 에이전트(`service-<프로젝트 번호>@gcp-sa-eventarc.iam.gserviceaccount.com`)였습니다. 구글 서비스가 내 프로젝트 안에서 쓰는 신원입니다.
9. 키·리전·창구를 그대로 두고 모델만 바꿔 부릅니다. 같은 Anthropic 모델인 Haiku 4.5·Sonnet 4.6이 응답하면, 양식은 처리됐고 계정 전체가 막힌 것도 아니므로 Haiku 5.5만의 제한입니다. 문서상 전파 시간을 넘겼는지도 함께 봅니다.

</details>
