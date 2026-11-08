# 16장. 클라우드 계정과 권한: AWS·GCP

(2026-11-05 추가)

LLM을 Amazon Bedrock 도쿄로 옮겨 보려고(13-5절) 처음 AWS를 쓰면서, 호출 한 번이 통과하기까지 **거절을 일곱 번** 받았습니다. 거절마다 이유가 달랐습니다(16-1절 표). 판정 트리거(통화 결과가 저장되면 판정을 뽑는 함수, 15-6절)를 처음 배포할 때는 GCP에서도 권한 문제로 한 번 실패했습니다. 이 장은 그 거절들을 교재로 삼아 **클라우드가 "누가, 무엇을, 어디서"를 어떻게 판단하는지**를 층별로 정리합니다.

(2026-11-08 추가) 처음 나오는 이름 셋을 먼저 풀어 둡니다. **AWS**(Amazon Web Services)는 아마존의 클라우드이고, **GCP**(Google Cloud Platform)는 구글의 클라우드입니다. **Amazon Bedrock**은 AWS가 Claude 같은 여러 회사의 모델을 자기 데이터센터에서 대신 돌려 주는 서비스입니다(8-8절). 음성 에이전트 책에 클라우드 계정 이야기가 들어가는 이유는 지연 때문입니다. 한 턴에서 가장 큰 몫은 LLM 첫 토큰이고, Haiku 5.5를 아시아에서 처리한다고 문서로 보장된 길은 Bedrock의 `jp.` 프로필(도쿄·오사카)뿐이었습니다(13-5절). 그 길을 쓰려면 AWS 계정과 권한을 먼저 통과해야 합니다. 통화 결과를 받는 functions-xtool은 GCP에서 돌기 때문에 GCP의 권한도 함께 봅니다.

- 다루는 것: 인증과 인가, AWS 계정·조직·리전, 자격 증명의 종류(액세스 키·STS 임시 자격 증명·Bedrock API 키), SigV4 서명, SDK가 자격 증명을 찾는 순서, IAM 정책 평가와 SCP, Bedrock의 모델 사용 신청·추론 프로필·두 창구, GCP의 서비스 계정·서비스 에이전트, 권한 변경의 전파 지연, 운영에서 키를 다루는 법
- 다루지 않는 것: Anthropic 플러그인의 `client` 옵션에 Bedrock 클라이언트를 넘기는 코드(8-8절)와 Anthropic API와의 A/B 측정 결과(13-5절).
- 이 레포는 공개 저장소라, 본문의 계정 ID·조직 ID·정책 ID는 `<작업 계정 ID>`처럼 가렸습니다. 계정 ID는 비밀번호가 아니지만 알려 줄 이유도 없습니다.
- (2026-11-06 추가) "깊이 보기"에서는 서명·토큰·정책 평가·응답 프레임을 **실제 문자열과 바이트로** 열어 봅니다. 실습 스크립트 다섯 개([lab/16-sigv4.mjs](lab/16-sigv4.mjs), [lab/16-api-key-anatomy.mjs](lab/16-api-key-anatomy.mjs), [lab/16-credential-chain.mjs](lab/16-credential-chain.mjs), [lab/16-policy-eval.mjs](lab/16-policy-eval.mjs), [lab/16-eventstream.mjs](lab/16-eventstream.mjs))는 AWS 문서의 예시 키(`AKIDEXAMPLE` 등)와 127.0.0.1의 가짜 서버로 돌고, AWS·GCP를 부르지 않으며 `.env.local`을 읽지 않습니다. 예시의 계정 칸은 AWS 문서의 예시 값(`123456789012`, `111122223333`)입니다. 레포 루트에서 `node docs/1-study/lab/16-sigv4.mjs`처럼 키 없이 돌립니다. 처음 읽을 때는 "깊이 보기"를 건너뛰어도 흐름을 따라가는 데 지장이 없습니다.

(2026-11-08 추가) **이 장의 지도.** 워커가 Bedrock에 LLM 요청 하나를 보내 답을 받기까지 지나는 길입니다. 위에서 아래로 일이 일어나는 차례이고, `[ ]`는 프로그램이나 서버, `│` 옆의 글은 그 구간에서 일어나는 일, 오른쪽 숫자는 그 일을 다루는 절입니다. ①∼④는 AWS가 요청을 받아 묻는 것으로, 이번에 거절을 만난 차례대로 적었습니다. 하나라도 거절하면 요청은 거기서 끝나고 모델까지 가지 않습니다.

```text
[이 레포의 워커]  LLM_PROVIDER=bedrock일 때
   │ 어떤 자격 증명으로 서명할지 고름: 자격 증명 체인                    16-4
   │ 요청에 "나는 누구다"를 붙임: SigV4 서명 또는 베어러 토큰             16-3
   ▼
[AWS 끝점]  예: bedrock-runtime.ap-northeast-1.amazonaws.com (도쿄)    16-2, 16-6
   │ ① 인증: 서명이 맞고 리전이 맞나                                   16-1, 16-3
   │ ② 자원: 이 창구에 이 모델이 있나                                  16-6
   │ ③ 인가: 조직의 상한(SCP)과 신원의 정책이 허용하나                   16-5
   │ ④ 모델 사용 자격: 이 계정에 이 모델이 열려 있나                     16-6
   ▼
[모델 서버]  추론 프로필이 정한 리전(jp. = 도쿄·오사카)에서 처리          16-6
   응답: AWS 이진 이벤트 스트림 → SDK가 SSE로 바꿔 플러그인에 넘김        16-6 깊이 보기

[functions-xtool]  GCP 프로젝트(Firebase)에서 도는 통화 결과 처리 함수   16-7
   권한의 주인: 서비스 계정·서비스 에이전트, 비밀값: Secret Manager
```

권한을 바꾼 직후에 거절이 나는 현상은 두 클라우드에 함께 있어 16-8절에서 따로 봅니다. 운영에서 키를 어디에 두고 어떻게 줄이는지는 16-9절, 한 장 요약은 16-10절입니다.

---

## 이 장에서 쓰는 말 (2026-11-08 추가)

클라우드 계정과 권한을 처음 보면 막히는 말만 모았습니다. 자세한 뜻은 괄호 안의 절에 있고, 전체 용어집은 [17장](17-glossary-and-next.md#17-1-용어집)입니다.

| 말 | 뜻 |
| --- | --- |
| 인증 / 인가 | "너는 누구냐"를 확인하는 일 / "그 일을 해도 되냐"를 정하는 일입니다. 인증은 자격 증명으로, 인가는 정책으로 판단합니다(16-1) |
| 자격 증명 (credential) | 내가 누구인지 서버에 증명하는 데 쓰는 비밀 정보입니다. AWS 액세스 키, STS 임시 자격 증명, Bedrock API 키가 모두 자격 증명입니다(16-3) |
| AWS 계정 / 루트 사용자 | 자원과 청구를 묶는 단위로, 12자리 숫자 ID가 붙습니다 / 계정을 만들 때 생기는, 모든 권한을 가진 가입 이메일 신원입니다(16-2) |
| 조직 / 관리 계정 / 멤버 계정 | 여러 계정을 묶어 청구와 정책을 함께 관리하는 단위(AWS Organizations) / 그 조직을 만든 주인 계정 / 조직에 속한 나머지 계정입니다. 이 프로젝트의 작업 계정은 멤버 계정입니다(16-2) |
| SCP (서비스 제어 정책) | 관리 계정이 멤버 계정에 거는 "이 계정 안에서는 누구도 이 이상은 못 한다"는 상한 정책입니다. 권한을 주지 않고 줄이기만 하며, 관리 계정 자신에게는 걸리지 않습니다(16-2, 16-5) |
| 리전 | AWS가 데이터센터를 모아 둔 지역 단위입니다. 도쿄는 `ap-northeast-1`이고, 대부분의 자원과 키가 리전마다 따로 있습니다(16-2) |
| IAM / IAM 사용자 / IAM 역할 | 신원과 권한을 관리하는 AWS 서비스(Identity and Access Management) / 사람이나 프로그램 하나를 나타내는 오래 사는 신원 / 정해진 사람이나 서비스가 잠시 맡아 쓰는 신원입니다(16-3) |
| 정책 / 주체 | "어떤 동작을 어떤 자원에 해도 되나"를 적은 JSON 문서 / 요청을 보낸 신원입니다(16-5) |
| STS / 역할 맡기 (AssumeRole) / 신뢰 정책 | 임시 자격 증명을 내주는 AWS 서비스 / STS에 "이 역할의 임시 자격 증명을 달라"고 하는 호출 / 그 역할을 누가 맡을 수 있는지 적은 정책입니다(16-3, 16-5) |
| 액세스 키 / 임시 자격 증명 / 세션 토큰 | IAM 사용자의 오래 사는 키 쌍(키 ID `AKIA…` + 비밀 키) / STS가 주는 만료 있는 키 쌍(키 ID `ASIA…`) / 임시 자격 증명에 딸려 오는 토큰으로, 요청마다 함께 실어야 합니다(16-3) |
| SigV4 | 비밀 키는 보내지 않고, 요청마다 그 내용으로 계산한 서명을 머리글에 붙이는 AWS 인증 방식입니다(16-3) |
| 베어러 토큰 / Bedrock API 키 | 가진 사람이면 누구나 쓸 수 있는 토큰 / Bedrock이 받는 베어러 토큰으로, `Authorization: Bearer …` 머리글에 실어 보냅니다(16-3) |
| 자격 증명 체인 | 코드에 키가 없을 때 SDK가 환경변수 → 파일 → 메타데이터 순으로 자격 증명을 찾는 규칙입니다(16-4) |
| 명시적 거부 / 기본 거부 | 정책의 `"Effect": "Deny"` 문장이 요청에 맞아서 난 거부 / 맞는 허용 문장이 하나도 없어서 난 거부입니다. 명시적 거부는 어떤 허용으로도 뒤집지 못합니다(16-5) |
| 권한 경계 / 세션 정책 | 신원에 붙이는 최대 권한 / 역할을 맡을 때 그 세션만 더 좁히는 정책입니다. 둘 다 상한일 뿐 권한을 주지 않습니다(16-5) |
| 최소 권한 | 하는 일에 꼭 필요한 동작과 자원만 허용하는 원칙입니다(16-5) |
| ARN | AWS 안의 자원과 신원에 붙는 이름입니다. `arn:aws:서비스:리전:계정:자원` 모양입니다(16-5) |
| 창구 | 이 장에서 같은 Bedrock에 요청을 넣는 서로 다른 주소(끝점)를 이르는 말입니다. 이 레포가 쓰는 `bedrock-runtime`(InvokeModel)과 새 끝점 `bedrock-mantle`이 있습니다(16-6) |
| 모델 사용 자격 (모델 접근) | 이 계정의 신원이 그 모델을 불러도 되는 상태입니다. Anthropic 모델은 첫 사용 양식을 내야 생깁니다(16-6) |
| 추론 프로필 | 요청을 어느 리전들로 보내 처리해도 되는지 정한 모델 ID입니다. `jp.`는 도쿄·오사카, `global.`은 전 세계입니다(16-6) |
| Marketplace 구독 | AWS 장터에서 판매사(여기서는 Anthropic)의 상품을 "이 계정이 쓰겠다"고 등록하는 것입니다(16-5) |
| 서비스 연결 역할 / 서비스 에이전트 | AWS 서비스가 내 계정 안에서 일할 때 쓰는 고정 역할 / 구글 서비스가 내 프로젝트 안에서 일할 때 쓰는 신원입니다(16-7) |
| GCP 프로젝트 / 서비스 계정 | 구글 클라우드에서 자원·청구·권한을 묶는 기본 단위(Firebase 프로젝트가 곧 GCP 프로젝트) / 프로그램이 쓰는 구글 신원입니다(16-7) |
| Secret Manager | GCP의 비밀값 보관 서비스입니다. 값을 암호화해 두고, 읽을 권한이 있는 신원만 읽게 합니다(16-7) |
| IMDS | EC2 가상 머신 안에서만 닿는 주소 `169.254.169.254`의 메타데이터 서비스입니다. 그 머신에 붙은 역할의 임시 자격 증명을 내줍니다(16-4) |
| 워크로드 아이덴티티 연동 / OIDC / ID 토큰 / audience | 한 곳(GKE)이 발급한 신원 증명을 다른 클라우드(AWS)의 임시 자격 증명으로 바꿔, 오래 사는 키 없이 인증하는 방식 / 토큰 주인을 JWT로 증명하는 표준 / 그 JWT / "누구에게 내라고 만든 토큰인가"를 적은 칸(`aud`)입니다(16-9) |
| 막는다 / 연다 (이 장의 표현) | 정책이나 계정 설정 때문에 AWS가 그 요청을 거절한다(보통 HTTP 403, 요청은 모델까지 가지 않음) / 더는 거절하지 않게 된다는 뜻입니다. 모델이 "열렸다"는 그 계정에 모델 사용 자격이 생겼다는 뜻입니다(16-1, 16-6) |
| (키가) 샌다 | 키 값이 의도하지 않은 사람에게 보이게 된다는 뜻입니다. 스크린샷, 커밋된 `.env` 파일, 로그, 이슈에 붙인 글이 흔한 길입니다(16-3, 16-9) |

---

## 16-1. 인증과 인가: 거절에는 층이 있다

(2026-11-08 추가) 이 절은 클라우드가 요청을 **거절하는 이유**를 층으로 나눠 봅니다. 먼저 모든 거절의 바탕인 세 질문을 정의하고, 이번에 실제로 받은 일곱 번의 거절을 그 층에 놓아 봅니다. 이 프로젝트에 필요한 이유는 이렇습니다. 워커의 LLM 요청이 Bedrock에서 거절되면 그 턴의 답이 나가지 않는데, 거절 메시지를 층으로 읽지 못하면 원인을 찾느라 오래 헤맵니다.

클라우드 API가 요청을 받으면 세 가지를 차례로 묻습니다.

| 질문 | 이름 | 무엇으로 판단 |
| --- | --- | --- |
| 너는 누구냐 | **인증** (authentication) | 자격 증명: 키, 토큰, 서명 |
| 이걸 해도 되냐 | **인가** (authorization) | 정책: 허용·거부 규칙 |
| 그게 거기 있냐 | 자원 확인 | 계정·리전·모델 목록 |

HTTP 상태 코드(응답 첫 줄의 세 자리 숫자)로는 보통 401이 인증 실패, 403이 "누군지는 알지만 안 됨"입니다. 하지만 AWS는 서명이 틀린 요청도 403으로 돌려줄 때가 있어서, **숫자보다 응답 본문을 읽어야** 합니다.

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
| 7 | 제출 뒤 45초마다 재시도 (13:20∼13:35), 이어서 다른 모델로 같은 호출 | Haiku 5.5는 계속 #5와 같은 403. **같은 키로 Haiku 4.5·Sonnet 4.6은 응답** | 모델 사용 자격 (계정·모델 단위) | 양식은 처리됨. Haiku 5.5만 이 계정에 열리지 않음 → AWS 지원에 요청 (16-6절) |

(2026-11-08 추가) 표 읽는 법입니다. 한 줄이 시도 한 번이고, #은 시도한 차례입니다. "응답"은 받은 HTTP 상태 코드와 본문의 핵심 문구, "걸린 층"은 그 거절이 어느 단계에서 났는지, "원인"은 나중에 밝힌 이유입니다. 층은 위 세 질문(인증·인가·자원)에 둘을 더한 것입니다. **계정 플랜**(#1)은 계정이 쓸 수 있는 기능의 범위를 정하는 가입 등급이고, **모델 사용 자격**(#5·#7)은 그 계정이 그 모델을 불러도 되는 상태입니다(16-6절). 그 밖의 낯선 말은 이렇습니다.

- **창구**(#3·#4)는 같은 Bedrock에 요청을 넣는 서로 다른 주소입니다(16-6절 "두 창구").
- **"막음"**(#4·#6)은 AWS가 그 요청을 403으로 거절해 처리하지 않았다는 뜻입니다. 막은 것은 정책 JSON의 거부 문장 한 줄입니다. #4라면 조직의 SCP 안에 `{"Effect": "Deny", "Action": "bedrock:CallWithBearerToken", "Resource": "*"}` 같은 문장이 있었던 것으로 봅니다(SCP 원문은 보지 못함, 16-5절).
- **"열리지 않음"**(#7)은 그 계정에 그 모델의 사용 자격이 생기지 않아 호출이 계속 #5와 같은 403을 받는다는 뜻입니다.

이 표에서 배울 점은 세 가지입니다.

- **한 번 호출이 통과하려면 모든 층을 통과해야 합니다.** 앞 층을 고치면 다음 층의 거절이 드러납니다. #4를 고치자 #5가 보였습니다. 그래서 "403이 났다, 키가 틀렸나?"처럼 한 층만 의심하면 오래 헤맵니다.
- **거절 메시지는 네 가지를 알려 줍니다.** 누가(`arn:aws:sts::<작업 계정 ID>:assumed-role/AccountFullAccessRole/<세션 이름>`), 무엇을(`bedrock:CallWithBearerToken`), 무엇에 대해(`resource: *`), 왜(`explicit deny in a service control policy`). 이 넷을 읽으면 층이 보입니다. (2026-11-08 추가) AWS IAM 문서가 설명하는 거절 문구(access denied 오류 메시지)는 대개 아래 모양이라, 줄마다 한 칸씩 읽으면 됩니다. #4의 칸을 그 모양에 넣어 다시 적은 것이고, 받은 원문을 그대로 옮긴 것은 아닙니다.

  ```text
  User: arn:aws:sts::<작업 계정 ID>:assumed-role/AccountFullAccessRole/<세션 이름>   ← 누가
  is not authorized to perform: bedrock:CallWithBearerToken                       ← 무엇을
  on resource: *                                                                  ← 무엇에 대해
  with an explicit deny in a service control policy                               ← 왜
  ```

  - **누가**: `arn:…`은 AWS가 자원과 신원에 붙이는 이름(ARN, 16-5절)입니다. 이 ARN은 "STS가 발급한(`sts`), `AccountFullAccessRole`이라는 역할을 맡은(`assumed-role`) 세션 하나"를 가리킵니다(16-2절 "콘솔 로그인도 임시 자격 증명이다").
  - **무엇을**: `서비스:동작` 모양의 동작 이름입니다. 정책은 이 이름으로 허용과 거부를 적습니다.
  - **무엇에 대해**: 동작의 대상 자원입니다. `*`는 특정 자원이 아니라는 뜻입니다.
  - **왜**: 어느 종류의 정책이 거절했는지입니다. "service control policy"면 조직의 SCP(16-5절), "identity-based policy"면 신원에 붙은 정책입니다. "explicit deny"(명시적 거부)인지, 맞는 허용이 없어서인지(기본 거부)도 여기서 갈립니다.
- **같은 문구라도 원인이 같다는 보장은 없습니다.** #5와 #7은 글자 하나 다르지 않은 403이었지만, #5는 양식을 내기 전이었고 #7은 양식이 처리된 뒤였습니다. 둘을 가른 것은 **조건을 하나만 바꾼 비교**입니다. 키·리전·창구를 그대로 두고 모델만 Haiku 4.5로 바꾸자 응답이 왔으므로, 막힌 것은 계정 전체가 아니라 그 모델 하나라는 결론이 나왔습니다.

(2026-11-06 추가) **운영 로그에서 이 거절을 볼 때는 모양이 바뀝니다.** 위 표는 `curl`이나 SDK를 직접 불러 응답 본문을 그대로 본 결과입니다. 워커 안에서는 Anthropic 플러그인이 오류를 한 번 바꿔 싣는데, 플러그인은 `e instanceof Anthropic.APIError`로 오류를 가르고 이 `Anthropic`은 SDK 0.33입니다. Bedrock 클라이언트가 던지는 오류는 SDK 1.4의 클래스라 검사가 거짓이 되고, 오류는 "연결 오류"로 분류됩니다(`node_modules/@livekit/agents-plugin-anthropic/src/llm.ts` 457∼475, 8-7절, 17-2 #37).

- #5·#7 같은 403도 **재시도 가능한 연결 오류(`APIConnectionError`)** 가 되어 LiveKit이 세 번 더 보냅니다. 기다림 0.1 + 2 + 2초에 왕복 네 번이 붙어, 왕복을 0.3초로 잡으면 약 5.3초 뒤에야 그 턴이 실패합니다(8-7절 표의 계산).
- 오류 객체의 **상태 코드 칸이 사라집니다.** 다만 메시지는 SDK 1.4 오류의 것을 그대로 옮기므로(같은 파일 472∼474) `"403 anthropic.claude-haiku-5-5 is not available for this account."`처럼 앞머리에 숫자와 본문 문구가 남습니다(SDK 1.4에 가짜 403을 돌려준 실측). 이 절의 원칙대로 **숫자 칸이 아니라 문구를 읽어야** 층이 보입니다.
- 네 번 보낼 때마다 서명을 새로 하고(16-3절 깊이 보기), 자격 증명을 STS에서 받는 방식이라면 그때마다 STS도 다시 부릅니다(16-4절 깊이 보기).

---

## 16-2. AWS의 뼈대: 계정, 조직, 리전

(2026-11-08 추가) 이 절은 AWS에서 모든 것이 놓이는 세 가지 그릇을 다룹니다. **계정**은 자원과 청구를 담는 그릇, **조직**은 계정 여러 개를 묶어 정책을 함께 거는 그릇, **리전**은 자원이 실제로 놓이는 지역입니다. 16-1절의 거절 가운데 #1(계정 플랜), #2(리전), #4·#6(조직의 SCP)이 이 그릇들과 얽혀 있어서, 이 셋을 알아야 거절의 이유가 읽힙니다.

### 계정

AWS **계정**은 자원과 청구의 경계입니다. 그 계정 안에서 만든 자원은 그 계정에 속하고, 그 자원이 쓴 요금은 그 계정 앞으로 청구된다는 뜻입니다. 12자리 숫자 ID가 있고, 한 계정의 자원은 기본적으로 다른 계정에서 보이지 않습니다. 계정을 처음 만들 때 생기는 **루트 사용자**(가입 이메일)는 모든 권한을 가지므로, 평소에는 쓰지 않고 따로 만든 사용자나 역할로 일합니다.

### 조직 (AWS Organizations)

여러 계정을 묶어 청구와 정책을 함께 관리하는 기능입니다. 이 프로젝트의 AWS는 이렇게 생겼습니다.

```text
조직 (AWS Organizations)
├── 관리 계정 (Management Account)        청구·조직 관리. SCP가 적용되지 않음
├── 위임 관리 계정                        사용자·권한 관리를 위임받은 멤버 계정
└── 작업 계정                             Bedrock을 쓰는 멤버 계정. SCP가 적용됨
```

(2026-11-08 추가) 그림 읽는 법입니다. 맨 위가 조직이고, `├──`·`└──` 아래가 그 조직에 속한 계정입니다. 가운데 열은 계정의 역할(실제 계정 이름은 가렸습니다), 오른쪽 열은 그 계정이 하는 일입니다. 계정을 묶는 폴더인 조직 단위(OU)는 그리지 않았습니다.

- **관리 계정**은 조직을 만든 주인 계정입니다. 조직 전체에 **SCP**(서비스 제어 정책, Service Control Policy)를 걸 수 있고, 자기 자신에게는 SCP가 적용되지 않습니다. AWS는 관리 계정에서 업무 자원을 돌리지 말라고 권합니다. 권한을 제한할 수 없는 계정이기 때문입니다.
- (2026-11-08 추가) **SCP**는 관리 계정이 멤버 계정에 거는 "이 계정 안에서는 누구도 이 이상은 못 한다"는 상한입니다. 예를 들어 `{"Effect": "Deny", "Action": "bedrock:CallWithBearerToken", "Resource": "*"}` 한 줄이 든 SCP를 작업 계정에 걸면, 그 계정 안의 누구도 Bedrock API 키로 호출할 수 없습니다. 계정 전체 권한을 가진 역할이라도 마찬가지입니다(#4). SCP는 권한을 주지는 않고 줄이기만 합니다(16-5절).
- **멤버 계정**은 조직에 속한 관리 계정 밖의 계정입니다. 이 프로젝트는 멤버 계정인 작업 계정에서 일하고, 관리 계정은 정말 필요한 일(이번에는 #6의 양식 제출)에만 씁니다.
- 콘솔 오른쪽 위의 **세션 전환**은 한 브라우저에서 여러 계정·신원에 동시에 로그인해 두고 오가는 기능입니다. 이번에 작업 계정과 관리 계정을 오간 방법입니다.

### 콘솔 로그인도 임시 자격 증명이다

16-1절 표 #4의 오류에서 "누가"는 `assumed-role/AccountFullAccessRole/<세션 이름>`이었습니다. 콘솔에 로그인한 사람의 신원이 **역할(role)을 맡은 임시 세션**이라는 뜻입니다. **역할**은 정해진 사람이나 서비스가 잠시 맡아 쓰는 신원입니다(16-3절). ARN의 끝부분은 세 조각으로 읽습니다. `assumed-role`은 "역할을 맡은 세션"이라는 표시, `AccountFullAccessRole`은 맡은 역할의 이름, `<세션 이름>`은 맡을 때 그 세션에 붙인 이름입니다. 사람이 콘솔에서 누르는 버튼도 결국 STS(16-3절)가 발급한 임시 자격 증명으로 서명된 API 호출입니다. 그래서 그 세션으로 만든 단기 Bedrock API 키도 같은 신원(역할 세션)으로 기록됩니다.

### 리전

대부분의 서비스와 자원은 **리전**(예: 도쿄 `ap-northeast-1`, 오사카 `ap-northeast-3`, 서울 `ap-northeast-2`, 시드니 `ap-southeast-2`) 단위로 따로 존재합니다. 리전은 AWS가 데이터센터 여러 곳을 묶어 둔 지리적 지역입니다. 리전마다 따로 존재한다는 것은, 도쿄에서 만든 자원은 도쿄의 이름(`ap-northeast-1`)을 달고 도쿄 끝점에서만 쓰인다는 뜻입니다. #2의 단기 API 키가 그 예입니다. IAM처럼 전역인 서비스도 있습니다. IAM 사용자·역할·정책은 리전 없이 계정에 하나씩 있어서, ARN의 리전 칸이 비어 있습니다(`arn:aws:iam::<계정 ID>:user/<이름>`).

- 콘솔 홈은 리전이 없는 화면이라 리전 메뉴가 안 보입니다. 서비스 화면으로 들어가거나 주소에 리전을 넣어 고정합니다(`https://ap-northeast-1.console.aws.amazon.com/bedrock/home?region=ap-northeast-1`).
- 이번에 처음 받은 키가 시드니 것이었던 이유도 리전입니다(#2). 키를 받을 때 콘솔이 시드니 리전에 있었습니다(무료 플랜에서는 도쿄를 열 수 없었음, #1).
- **같은 서비스라도 리전마다 제공하는 모델이 다릅니다.** 서울 Bedrock은 Haiku 5.5를 `global.` 프로필로만 주고, 도쿄는 일본 안에서만 처리하는 `jp.` 프로필도 줍니다(16-6절, [5-poc-results.md](../5-poc-results.md) 조사).

---

## 16-3. 자격 증명의 종류

(2026-11-08 추가) **자격 증명**(credential)은 "내가 누구인지"를 서버에 증명하는 데 쓰는 비밀 정보입니다. 사람이 비밀번호로 로그인하듯, 프로그램은 키나 토큰을 씁니다. 이 절은 이번에 만난 네 가지 자격 증명의 생김새·수명·싣는 방식을 견주고, 이 레포가 실제로 쓰는 IAM 액세스 키가 요청에 어떻게 실리는지(SigV4 서명)를 봅니다. 자격 증명의 종류에 따라 "새면 얼마나 위험한가"와 "조직 정책이 막는가"가 달라지므로(#2·#4), 이 프로젝트가 어느 것을 쓸지 고르는 기준이 됩니다.

"너는 누구냐"에 답하는 방법은 여러 가지입니다. 이번에 만난 것만 정리합니다.

| 종류 | 생김새 | 수명 | 요청에 싣는 방식 | 이번에 |
| --- | --- | --- | --- | --- |
| IAM 사용자 **액세스 키** | `AKIA…` + 비밀 키 | 지울 때까지 (직접 교체) | SigV4 서명 | `.env.local`의 `AWS_ACCESS_KEY_ID`·`AWS_SECRET_ACCESS_KEY`. 지금 쓰는 방식 |
| STS **임시 자격 증명** | `ASIA…` + 비밀 키 + 세션 토큰 | 15분∼12시간 (역할 맡기 기준) | SigV4 서명 + `X-Amz-Security-Token` | 콘솔 로그인 세션(역할 맡기) |
| Bedrock **단기 API 키** | `bedrock-api-key-…` | 최대 12시간, 또는 만든 세션이 끝날 때까지 | `Authorization: Bearer …` | 처음 받은 키. SCP에 막힘 |
| Bedrock **장기 API 키** | 확인하지 않음 (만들지 않았고, AWS 문서에도 모양이 적혀 있지 않음) | 만들 때 정함: 1∼36,600일 또는 만료 없음 | `Authorization: Bearer …` | 쓰지 않음 |

(2026-11-08 추가) 표 읽는 법입니다. "생김새"는 눈으로 구별되는 모양입니다. 액세스 키는 키 ID와 비밀 키 두 값의 쌍이고, 키 ID의 앞 네 글자로 종류를 압니다. `AKIA`면 IAM 사용자의 장기 키, `ASIA`면 STS가 준 임시 키입니다. "수명"은 그 자격 증명을 만든 뒤 쓸 수 있는 기간입니다. "요청에 싣는 방식"은 자격 증명이 HTTP 요청의 어디에 들어가는지입니다. SigV4는 비밀 키 대신 그 키로 계산한 서명을 `Authorization` 머리글에 싣고(아래), 베어러 토큰은 토큰 문자열 자체를 `Authorization: Bearer …`에 싣습니다. 표의 장기 키 수명은 IAM API 문서(`CreateServiceSpecificCredential`의 `CredentialAgeDays`)로 확인한 값입니다.

### 장기 키와 임시 자격 증명

- **IAM 사용자**는 "사람이나 프로그램 하나"를 나타내는 오래 사는 신원이고, 액세스 키는 그 사용자의 **장기 자격 증명**입니다. 새면 누가 지울 때까지 계속 쓸 수 있습니다. 예를 들어 `.env.local`을 실수로 커밋해 공개 저장소에 올리면, 그 파일을 본 사람은 누군가 그 키를 비활성화하거나 지울 때까지 그 사용자의 권한으로 AWS에 요청을 보낼 수 있습니다.
- **IAM 역할**은 정해진 사람이나 서비스가 잠시 맡아 쓰는 신원입니다. 모자에 빗대면, 모자를 쓰는 동안은 원래 신원의 권한이 아니라 그 모자(역할)의 권한으로 움직입니다. 역할을 맡으면 **STS**(Security Token Service)가 임시 자격 증명(키 ID·비밀 키·세션 토큰 세 값)을 줍니다. 만료 시각이 지나면 그 세 값으로 만든 서명은 거절되므로, 새도 피해가 그 시각까지로 제한됩니다.
- AWS가 권하는 방향은 "사람은 역할로 로그인하고, 프로그램도 가능하면 역할을 맡게 하라"입니다. 이 프로젝트가 IAM 사용자 키를 쓰는 이유와 대안은 16-9절에 있습니다.

### Bedrock API 키: 베어러 토큰

Bedrock API 키는 **베어러(bearer) 토큰**입니다. 이름 그대로 "가진 사람이 주인"인 토큰이라, 요청에 그대로 실어 보내고 서버는 토큰만 보고 신원을 판단합니다. 쓰기는 가장 쉽지만 새면 그대로 남이 씁니다. (2026-11-08 추가) 요청 머리글로 보면 이 한 줄입니다(값은 실습이 예시 키로 만든 가짜 토큰의 앞부분).

```text
Authorization: Bearer bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbiZYLUFtei1BbGdvcml0…
```

서버는 이 문자열만 보고 신원을 정하므로, 이 줄을 복사한 사람은 누구든 같은 신원으로 요청을 보낼 수 있습니다. 그 사람이 얼마 동안 무엇을 할 수 있는지는 아래 깊이 보기의 "SigV4와 무엇이 다른가"에서 봅니다.

- **단기 키**는 만든 신원(이번에는 콘솔의 역할 세션)의 권한을 그대로 이어받습니다. AWS가 공개한 토큰 생성 라이브러리(`aws-bedrock-token-generator`)를 보면, 단기 키는 **SigV4로 미리 서명한 URL을 문자열로 감싼 것**입니다. 서명에 리전이 들어가므로 키가 리전에 묶이고(#2), 서명에 만료 시각이 들어가므로 최대 12시간 뒤 쓸모가 없어집니다. 클라이언트에서 서명만으로 만들어지므로 **만드는 것 자체는 막을 수 없고, 쓰는 것만 막을 수 있습니다**(AWS 문서).
- **장기 키**는 IAM 사용자에 딸린 서비스 전용 자격 증명입니다. 콘솔에서 만들면 그 키를 위한 IAM 사용자가 함께 생깁니다. AWS는 장기 키를 탐색용으로만 권합니다.

#### 깊이 보기: 단기 API 키 한 개를 풀어 보기 (2026-11-06 추가)

**만드는 코드.** AWS가 공개한 생성기(`aws-bedrock-token-generator-js`, GitHub `main`의 2025-07-24 커밋)의 `src/token.ts`는 핵심이 30줄 남짓입니다. 하는 일은 넷입니다(코드로 확인).

1. `POST https://bedrock.amazonaws.com/?Action=CallWithBearerToken` 요청을 만듭니다. 머리글은 `host` 하나이고 본문은 없습니다. **호스트 이름에 리전이 없습니다.**
2. 그 요청을 SigV4로 **미리 서명**(presign)합니다. 서비스 이름은 `bedrock`, 리전은 받은 값, 만료는 기본 43,200초(12시간)입니다. 미리 서명은 아래 SigV4와 같은 계산이지만, 범위·시각·서명을 머리글 대신 **쿼리 문자열**에 넣어 "주소 하나로 완결된 서명된 요청"을 만드는 방식입니다. S3의 미리 서명 URL과 같은 것입니다.
3. 그 주소에서 `https://`를 떼고 끝에 `&Version=1`을 붙입니다.
4. base64로 바꾸고 앞에 `bedrock-api-key-`를 붙입니다.

**실측.** [lab/16-api-key-anatomy.mjs](lab/16-api-key-anatomy.mjs)는 이 레포에 깔린 같은 부품(`@smithy/signature-v4` 3.1.2의 `presign`)으로, AWS 문서의 예시 키·지어낸 세션 토큰·시드니 리전(#2와 같은 상황)을 넣어 같은 모양의 토큰을 만들고 다시 풉니다. 만든 토큰(544자)의 앞부분입니다.

```text
bedrock-api-key-YmVkcm9jay5hbWF6b25hd3MuY29tLz9BY3Rpb249Q2FsbFdpdGhCZWFyZXJUb2tlbiZYLUFtei1BbGdvcml0
aG09QVdTNC1ITUFDLVNIQTI1NiZYLUFtei1DcmVkZW50aWFsPUFTSUFJT1NGT0ROTjdFWEFNUExFJTJGMjAyNjExMDUlMkZhcC1z
…
```

접두사를 떼고 base64를 풀면 이렇습니다(줄은 `&`마다 나눔).

```text
bedrock.amazonaws.com/?Action=CallWithBearerToken
  &X-Amz-Algorithm=AWS4-HMAC-SHA256
  &X-Amz-Credential=ASIAIOSFODNN7EXAMPLE%2F20261105%2Fap-southeast-2%2Fbedrock%2Faws4_request
  &X-Amz-Date=20261105T040000Z
  &X-Amz-Expires=43200
  &X-Amz-Security-Token=FAKE-SESSION-TOKEN-FROM-CONSOLE-ROLE
  &X-Amz-Signature=da4f30a4cca2431d37b7d1ff7d081e221a8e8629ee0d18dcab6e06380eb84615
  &X-Amz-SignedHeaders=host
  &Version=1
```

| 칸 | 값 | 여기서 바로 보이는 것 |
| --- | --- | --- |
| `X-Amz-Credential` | 키 ID / 날짜 / **리전** / `bedrock` / `aws4_request` | **#2의 원인.** 호스트에 리전이 없으니 이 토큰이 어느 리전 것인지는 이 범위 칸만 정합니다. 도쿄 창구에 내면 범위의 리전이 자기와 다릅니다. 실습에서 도쿄 리전으로 키 사슬을 만들어 확인하면 서명이 맞지 않습니다. 실제 서버가 리전 문자열을 먼저 비교하는지 서명을 계산해 보는지는 공개되지 않았습니다(추정) |
| `X-Amz-Date` + `X-Amz-Expires` | 한국 11-05 13:00, 43,200초 | **12시간 만료**(한국 11-06 01:00). 만료 칸도 서명 대상이라 7일로 고쳐 쓰면 서명이 틀립니다(실습) |
| `X-Amz-Security-Token` | 콘솔 세션의 세션 토큰 | **"만든 세션이 끝날 때까지".** 임시 자격 증명으로 만든 키에는 세션 토큰이 그대로 실려서, 그 세션이 먼저 끝나면 키도 끝납니다. 생성기 주석도 "실제 유효 기간은 요청한 만료와 자격 증명 만료 중 짧은 쪽"이라고 적습니다(`src/getToken.ts`) |
| `Action` | `CallWithBearerToken` | 이 토큰을 쓰는 순간 IAM이 보는 동작 이름(`bedrock:CallWithBearerToken`, #4)과 같은 이름 |
| `X-Amz-Signature` | 64자 hex | 비밀 키로 만든 서명. **비밀 키 자체는 어디에도 없습니다** |
| `Version` | `1` | 서명한 뒤에 붙여 서명 대상이 아님 |

**"만들기는 못 막고 쓰기만 막는다"가 코드에서 보입니다.** 1∼4단계에 네트워크 호출이 하나도 없습니다. 실습은 `fetch`를 막아 두고 토큰을 만들어 호출이 0번임을 확인합니다. 비밀 키(콘솔이면 세션의 임시 비밀 키)만 있으면 어느 컴퓨터에서든 계산만으로 만들 수 있으므로, AWS가 끼어들 수 있는 때는 그 토큰이 요청에 실려 **들어올 때**뿐입니다. 그래서 SCP가 막은 것도 만들기가 아니라 쓰기(`bedrock:CallWithBearerToken`)였고, AWS 문서도 "단기 키의 생성은 막을 수 없다"고 적습니다.

**12시간은 어디서 오나.** 서명 라이브러리는 미리 서명을 7일까지 받아 줍니다(`@smithy/signature-v4` 3.1.2의 `dist-cjs/index.js` 80행 `MAX_PRESIGNED_TTL`. 실습에서 8일은 거절, 7일은 만들어짐). 12시간 상한은 생성기의 입력 검사(`validateTokenExpiryInput`)입니다. 서버가 12시간이 넘는 토큰을 받아 주는지는 확인하지 못했습니다(확인 필요).

**SigV4와 무엇이 다른가.** SigV4는 요청마다 **그 요청의 내용**(경로·머리글·본문 해시)에 맞는 서명을 새로 만듭니다(아래). API 키 안의 서명은 "`Action=CallWithBearerToken`을 부른다"는 고정된 가짜 요청에 대한 서명 하나라서, 실제 요청의 내용과는 묶여 있지 않습니다. 그래서 가로챈 사람이 할 수 있는 일이 SigV4는 "그 요청 하나를 5분 안에 다시 보내기"인 반면, API 키는 "12시간 동안 그 신원이 할 수 있는 모든 Bedrock 호출"입니다. 위 "베어러 토큰" 문단의 "새면 그대로 남이 씁니다"가 이 뜻입니다.

### SigV4: 비밀 키를 보내지 않고 증명하기

IAM 액세스 키의 두 값 가운데 **비밀 키**는 요청에 싣지 않습니다. 키 ID(`AKIA…`)만 싣고, 비밀 키로는 요청마다 **서명**을 만들어 붙입니다. 이것이 Signature Version 4(SigV4)입니다.

(2026-11-06 추가) 아래 계산에 나오는 부품입니다.

- **SHA-256**은 어떤 길이의 바이트든 32바이트(hex로 64자) 값으로 줄이는 해시 함수입니다. 입력이 한 비트만 달라도 결과가 완전히 달라지고, 결과에서 입력을 되돌릴 수 없습니다. 키가 없어서 누구나 같은 값을 계산합니다.
- **HMAC-SHA256**은 비밀 키를 섞은 SHA-256입니다([17-1 HMAC](17-glossary-and-next.md#17-1-용어집), 3-7절 JWT의 HS256과 같은 함수). 같은 키를 가진 쪽만 같은 값을 만듭니다. 3장 JWT는 HMAC을 한 번 쓰고, SigV4는 다섯 번(키 넷 + 서명 하나) 씁니다.
- **정규화**(canonicalization)는 "같은 뜻이면 같은 바이트"가 되도록 표기를 하나로 고정하는 규칙입니다. 머리글 이름의 대소문자, 머리글 순서, 공백, 쿼리 순서, 경로의 인코딩은 HTTP로는 같은 뜻이어도 바이트가 다를 수 있습니다. 해시는 바이트가 한 개만 달라도 달라지므로, 서명하는 쪽과 확인하는 쪽이 같은 규칙으로 정규화해야 같은 서명이 나옵니다.
- **퍼센트 인코딩**은 URL에 그대로 쓸 수 없는 바이트를 `%` + 두 자리 hex로 적는 방법입니다(`:` → `%3A`, 한글 "네" → `%EB%84%A4`). SigV4는 `A-Z a-z 0-9 - . _ ~`만 그대로 두고 나머지는 모두 대문자 hex로 적으라고 정합니다(AWS IAM 문서의 `UriEncode`).

```text
1. 정규 요청(canonical request)을 만든다
     메서드 + 경로(인코딩 규칙 고정) + 쿼리 + 서명할 머리글(이름:값) + 서명한 머리글 이름 목록 + 본문의 SHA-256
2. 서명할 문자열 = "AWS4-HMAC-SHA256" + 시각 + 범위(날짜/리전/서비스/aws4_request) + 1의 해시
3. 서명 키를 비밀 키에서 단계적으로 끌어낸다
     kDate    = HMAC("AWS4" + 비밀 키, 날짜)
     kRegion  = HMAC(kDate, 리전)
     kService = HMAC(kRegion, 서비스)
     kSigning = HMAC(kService, "aws4_request")
4. 서명 = HMAC(kSigning, 2의 문자열)  → Authorization 헤더에 액세스 키 ID·범위·서명을 실음
```

(2026-11-06 갱신) 1단계에 "서명한 머리글 이름 목록"을 더했습니다. 실물은 아래 깊이 보기의 정규 요청 18줄입니다.

(2026-11-08 추가) 블록 읽는 법입니다. 번호는 계산 차례입니다. `=` 왼쪽은 그 줄에서 만드는 값이고, `HMAC(키, 데이터)`는 "키"로 "데이터"를 HMAC-SHA256한 32바이트 값입니다. 3단계의 네 줄은 앞 줄의 결과가 다음 줄의 키가 되는 사슬이라 **키 사슬**이라고 부릅니다. 2단계의 **범위**(credential scope)는 `날짜/리전/서비스/aws4_request` 꼴의 문자열이고, 4단계에서 `Authorization` 머리글에 실리는 것은 키 ID, 범위, 서명한 머리글 목록, 서명 넷입니다. 비밀 키 자체는 어디에도 실리지 않습니다. 실제 값으로 따라가는 것은 아래 깊이 보기입니다.

서버도 같은 계산을 해서 서명이 맞는지 봅니다. 이 설계에서 나오는 성질이 셋 있습니다.

- **비밀 키는 네트워크로 나가지 않습니다.** 중간에서 엿봐도 얻는 것은 그 요청 하나의 서명뿐입니다.
- **서명은 그 요청에만 맞습니다.** 경로나 본문을 바꾸면 해시가 달라져 서명이 틀립니다. (2026-11-06 갱신) 시각도 서명에 들어가므로, 요청의 시각(`X-Amz-Date`)이 서버 시각과 **약 5분** 넘게 어긋나면 거절됩니다. AWS 문서는 "대부분의 경우 요청은 요청에 적힌 시각으로부터 5분 안에 AWS에 닿아야 한다"고 적고, 미래 쪽이면 `Signature not yet current`, 과거 쪽이면 `Signature expired`로 거절합니다. 이것은 **재전송 공격**(가로챈 요청을 그대로 다시 보내 같은 일을 또 시키는 공격)을 **시간으로 제한**하는 장치이지 완전히 막는 장치가 아닙니다. SigV4에는 한 번만 쓰는 값(nonce)이 없어서, **그 5분 창 안에서 같은 요청을 다시 보내는 것은 서명만으로는 구별되지 않습니다.** 서명되지 않은 머리글(예: `user-agent`)은 바꿔서 보내도 서명이 맞습니다(아래 깊이 보기). 창 안의 재전송은 TLS(요청을 가로채기 어렵게 함)와, 필요하면 서비스 쪽의 중복 처리로 막습니다. 실제로 Bedrock이 창 안의 같은 요청을 두 번 받아 주는지는 확인하지 않았습니다.
- **서명 키는 날짜·리전·서비스로 좁혀집니다.** 3단계의 사슬 때문입니다. 도쿄 Bedrock용으로 끌어낸 키로는 다른 리전이나 서비스의 요청을 서명할 수 없습니다.

1단계의 "경로 인코딩 규칙"은 실제로 함정이었습니다. 다른 작업에서 `curl --aws-sigv4`로 콜론(`:`)이 든 모델 ID(`…-v1:0`)를 부르자, 서버가 "우리가 계산한 서명과 다르다"며 자기가 기대한 정규 요청(콜론이 `%3A`로 인코딩된 경로)을 돌려줬습니다. 서명하는 쪽과 서버가 경로를 다르게 인코딩하면 키가 맞아도 실패합니다. SDK가 이런 규칙을 대신 처리해 주는 것이 **직접 서명하지 말고 SDK를 쓰는** 이유입니다. (2026-11-06 갱신) 왜 어긋났는지는 아래 깊이 보기의 "경로는 한 번 더 인코딩한다"에서 코드와 실측으로 풉니다.

#### 깊이 보기: SigV4 서명을 손으로 다시 계산하기 (2026-11-06 추가)

3-7절에서 JWT 서명을 `createHmac` 한 줄로 다시 계산했듯이, 여기서는 Bedrock 요청 하나의 서명을 처음부터 끝까지 다시 계산합니다. [lab/16-sigv4.mjs](lab/16-sigv4.mjs)는 운영과 같은 `createBedrockClient()`([src/models/index.ts](../../src/models/index.ts))를 쓰되, [src/models/index.test.ts](../../src/models/index.test.ts)처럼 `fetch`를 가로채 선로(wire)에 나갈 요청, 곧 SDK가 네트워크로 실제로 내보낼 바이트 그대로의 요청을 받아 냅니다. 키는 AWS SigV4 문서의 예시 키(`AKIDEXAMPLE` / `wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY`)를 운영처럼 환경변수로 넣고, 시각은 2026-11-05T23:30:00Z(한국 11-06 08:30)로 고정했습니다. 그다음 **서버가 하듯** Authorization 머리글에서 범위와 서명할 머리글 목록을 읽어 서명을 다시 계산합니다.

**선로에 나간 요청.** 플러그인처럼 `stream: true`와 시간 제한 10초로 부른 첫 시도입니다.

```text
POST https://bedrock-runtime.ap-northeast-1.amazonaws.com/model/jp.anthropic.claude-haiku-5-5/invoke-with-response-stream
accept: application/json
authorization: AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261105/ap-northeast-1/bedrock/aws4_request,
               SignedHeaders=accept;content-type;host;x-amz-content-sha256;x-amz-date;x-stainless-arch;x-stainless-lang;x-stainless-os;x-stainless-package-version;x-stainless-retry-count;x-stainless-runtime;x-stainless-runtime-version;x-stainless-timeout,
               Signature=1360e25344f58edb3a7d5bc8bb108c3b66831fc99e358746db4fb812c64cb32d
content-type: application/json
host: bedrock-runtime.ap-northeast-1.amazonaws.com
user-agent: AnthropicBedrock/JS 1.4.0
x-amz-content-sha256: 330b7b94acf7451e9e51f459e6694dcdbec350cbb28c4659aeaa11f51b84071f
x-amz-date: 20261105T233000Z
x-stainless-arch: arm64
x-stainless-lang: js
x-stainless-os: MacOS
x-stainless-package-version: 1.4.0
x-stainless-retry-count: 0
x-stainless-runtime: node
x-stainless-runtime-version: v24.22.2
x-stainless-timeout: 10
(본문 107바이트) {"max_tokens":64,"messages":[{"role":"user","content":"안녕하세요"}],"anthropic_version":"2026-10-21"}
```

`authorization`은 원래 한 줄이고 읽기 좋게 쉼표에서 나눴습니다. `x-stainless-*`는 Anthropic SDK가 붙이는 진단용 머리글(운영체제, 런타임 판, 재시도 횟수, 시간 제한 초)이라 기계마다 값이 달라지고, 그래서 마지막 서명 값은 돌리는 기계마다 다릅니다.

**1단계: 정규 요청.** 줄 번호는 설명용이고 실제로는 줄바꿈(`\n`)으로 이은 문자열입니다.

```text
 1 │POST
 2 │/model/jp.anthropic.claude-haiku-5-5/invoke-with-response-stream
 3 │
 4 │accept:application/json
 5 │content-type:application/json
 6 │host:bedrock-runtime.ap-northeast-1.amazonaws.com
 7 │x-amz-content-sha256:330b7b94acf7451e9e51f459e6694dcdbec350cbb28c4659aeaa11f51b84071f
 8 │x-amz-date:20261105T233000Z
 9 │x-stainless-arch:arm64
10 │x-stainless-lang:js
11 │x-stainless-os:MacOS
12 │x-stainless-package-version:1.4.0
13 │x-stainless-retry-count:0
14 │x-stainless-runtime:node
15 │x-stainless-runtime-version:v24.22.2
16 │x-stainless-timeout:10
17 │
18 │accept;content-type;host;x-amz-content-sha256;x-amz-date;x-stainless-arch;…;x-stainless-timeout
19 │330b7b94acf7451e9e51f459e6694dcdbec350cbb28c4659aeaa11f51b84071f
```

| 줄 | 내용 | 규칙 |
| --- | --- | --- |
| 1 | 메서드 | 대문자 그대로 |
| 2 | 경로 | 선로의 경로를 `/`로 나눈 조각마다 **한 번 더** 퍼센트 인코딩(아래 "경로는 한 번 더") |
| 3 | 쿼리 | 없으면 빈 줄. 있으면 이름·값을 각각 인코딩하고 이름순 정렬 |
| 4∼16 | 서명할 머리글 13개 | 이름은 소문자, 이름순, `이름:값`, 값의 앞뒤 공백 제거·연속 공백 하나로 |
| 17 | 빈 줄 | 머리글 덩어리가 각 줄 끝에 `\n`을 달고, 거기에 구분 `\n`이 하나 더 붙어서 생김 |
| 18 | 서명한 머리글 이름 목록 | `;`로 이음. Authorization의 `SignedHeaders`와 같은 값. 서버는 이 목록으로 4∼16줄을 다시 만듦 |
| 19 | 본문 SHA-256 | 본문 107바이트의 해시. `x-amz-content-sha256` 머리글 값과 같음(실습에서 확인) |

**2단계: 서명할 문자열.** 정규 요청 전체를 SHA-256 한 값으로 줄여 넷째 줄에 넣습니다.

```text
AWS4-HMAC-SHA256
20261105T233000Z
20261105/ap-northeast-1/bedrock/aws4_request
297026fa42857b53a66de262b4cbc1f6110c3ee9ca5f8612bc59e1b640d16be8
```

셋째 줄이 **범위**(credential scope)입니다. Authorization의 `Credential=` 뒤에도 키 ID와 함께 그대로 실려, 서버가 어느 날짜·리전·서비스용 키로 확인할지 알게 합니다.

**3단계: 키 사슬.** 앞 단계의 결과(32바이트)가 다음 단계의 HMAC 키가 됩니다.

| 단계 | 키 | 데이터 | 결과 (hex) |
| --- | --- | --- | --- |
| kDate | `"AWS4" + 비밀 키` (문자열) | `20261105` | `436747a62f8ebc7a03d250f83d6ea3a372c68d7f042cf83791fa5a2c617238ad` |
| kRegion | kDate | `ap-northeast-1` | `f4745a72dd9b0ec6089301070d85fcce9d3b4bf0893c8bf5e51f8f1b87159a0b` |
| kService | kRegion | `bedrock` | `95ae36ea352de4d58269c46e1a026fbd3d118545948693f04c48962039fa2924` |
| kSigning | kService | `aws4_request` | `38fa558a39619a8b2f1ef302240c62639c704a273d2c3e93b71cb6cb302f9b6e` |

이 네 값은 비밀 키·날짜·리전·서비스만으로 정해지므로, 같은 예시 키로 누가 계산해도 같습니다. **4단계**는 `HMAC(kSigning, 2단계 문자열)`의 hex입니다.

```text
SDK의 서명     : 1360e25344f58edb3a7d5bc8bb108c3b66831fc99e358746db4fb812c64cb32d
다시 계산한 값 : 1360e25344f58edb3a7d5bc8bb108c3b66831fc99e358746db4fb812c64cb32d
일치: true
```

`node:crypto`의 `createHash`·`createHmac`만으로 같은 값이 나옵니다. 서버가 하는 일도 이것과 같습니다. 다른 점은 서버는 키 ID로 자기 쪽에 저장된 비밀 키를 찾는다는 것뿐입니다.

**출력에서 읽을 것.**

- **서명되는 머리글은 15개 중 13개입니다.** 빠진 것은 `authorization`(서명 자신)과 `user-agent`입니다. `@smithy/signature-v4` 3.1.2는 `user-agent`, `connection`, `x-amzn-trace-id` 등을 늘 빼는 목록(`ALWAYS_UNSIGNABLE_HEADERS`, `dist-cjs/index.js` 56∼71)을 갖고 있고, AWS 문서도 프록시나 로드 밸런서가 고칠 수 있는 머리글은 서명하지 말라고 권합니다. Bedrock SDK는 여기에 OpenTelemetry 추적 머리글(`traceparent`, `tracestate`, `baggage`)도 더해 뺍니다(`core/auth.js` 122, `internal/trace-headers.js`). 서명 뒤에 HTTP 계측 도구가 이 머리글을 붙이거나 바꿔도 서명이 깨지지 않게 하려는 것입니다(15-6절의 OTel 트레이스).
- **범위의 서비스 이름은 `bedrock`입니다.** 호스트는 `bedrock-runtime`이지만 Bedrock SDK가 `service: 'bedrock'`으로 서명합니다(`node_modules/@anthropic-ai/bedrock-sdk/core/auth.js` 97∼102). 호스트 이름과 서명용 서비스 이름은 다를 수 있다는 뜻입니다. 다른 작업의 `curl --aws-sigv4 "aws:amz:ap-northeast-1:bedrock"`도 같은 이름으로 서명해 인증을 통과했습니다(모델 사용 자격 403까지 감).
- **범위 날짜는 UTC입니다.** 한국 11-06 08:30에 서명했는데 범위 날짜는 `20261105`입니다. 한국 시각 오전 9시 전에는 범위 날짜가 "어제"이고, 09:00:00부터 오늘이 됩니다(실습 6번). 서버는 범위 날짜가 `x-amz-date`의 날짜와 다르면 `Date in Credential scope does not match …`로 거절합니다(AWS 문서). 로그에서 날짜가 하루 어긋나 보여도 이상이 아닙니다.
- **본문 안의 `anthropic_version`은 `2026-10-21`입니다.** Bedrock SDK는 Anthropic SDK가 붙이는 `anthropic-version` 머리글 값을 본문으로 옮기는데(`client.js` 189∼200), SDK 1.4.0의 그 값이 `2026-10-21`입니다(`@anthropic-ai/sdk` 1.4.0 `client.js` 972). **API 버전**은 서버가 요청을 어떤 규칙으로 해석할지 정하는 날짜 이름입니다(8장). AWS 문서는 이 값이 `bedrock-2023-05-31`이어야 한다고 적습니다.
- (2026-11-08 갱신) **Bedrock이 이 값을 받는지는 모델에 달렸습니다.** Anthropic 문서(API 버전 `2026-10-21` 이전 안내, 2026-11-08 확인, 8-8절)는 그 버전부터의 SDK가 Bedrock 클라이언트로도 `2026-10-21`을 보내고, Bedrock은 이 값을 **Claude 4.7 이후 모델에만** 받는다고 적습니다. 같은 문서에 따르면 `@anthropic-ai/bedrock-sdk` 1.x는 `@anthropic-ai/sdk` 1.x 위에서 돌므로, 이 레포의 1.1.1도 이 값을 보냅니다. 운영 대상인 Haiku 5.5는 여기에 들어가므로 문서상 받아지는 값입니다. 그보다 앞선 모델(Haiku 4.5 등, 문서의 "Opus 4.6 이하" 목록)은 대상이 아니어서, 그런 모델을 Bedrock으로 부르는 코드는 지금 쓰는 SDK판에 머물라고 합니다. 이 레포는 2026-11-05 첫 Bedrock 커밋(`144d25b`)부터 지금과 같은 `@anthropic-ai/bedrock-sdk` 1.1.1·`@anthropic-ai/sdk` 1.4.0이었으므로, 그날 A/B에서 Haiku 4.5가 응답한 것은 문서로 설명되지 않습니다. 그때 보낸 본문도, 부른 모델 ID도 남기지 않아 확인이 필요합니다(17-2 #54, 13-5절).

**한 곳씩 바꿔 보기.** 받은 요청의 한 곳만 바꾸고 같은 계산을 다시 하면 이렇습니다(실습 3번).

| 바꾼 곳 | 결과 | 이유 |
| --- | --- | --- |
| 본문 "안녕하세요" → "안녕하세여" | 서명 틀림 | 본문 해시(19줄)가 바뀜 |
| `x-stainless-retry-count` 0 → 1 | 서명 틀림 | 서명된 머리글(13줄) |
| `x-amz-date` 1초 뒤로 | 서명 틀림 | 8줄과 서명할 문자열 2줄 |
| `user-agent`를 `curl/8.7.1`로 | **서명 맞음** | 서명되지 않은 머리글. 창 안에서 이런 부분은 남이 바꿔도 통과 |
| 서버의 비밀 키가 다름 | 서명 틀림 | 키 사슬 첫 단계부터 달라짐 |

**재시도마다 다시 서명합니다.** `x-stainless-retry-count`가 서명된 머리글이라, SDK가 같은 요청을 다시 보낼 때도 서명을 새로 해야 합니다. 실습 4번은 SDK 재시도를 한 번 켜고(500 → 400) 두 요청을 비교합니다. 시각을 고정했는데도 retry-count가 0과 1로 달라 서명이 `1360e253…`과 `547a6823…`으로 다릅니다. Bedrock SDK는 서명을 요청을 보내기 직전의 미들웨어(`client.js` 169∼176의 `backendMiddleware` → 233∼247의 `getAuthHeaders`)에서 하므로 시도마다 새로 서명됩니다. 운영 코드는 `maxRetries: 0`이라 이 값은 늘 0이고, 재시도는 LiveKit이 **새 요청**으로 하므로 `x-amz-date`부터 달라져 역시 새 서명입니다(16-1절의 #37 경로).

**서명 키는 기억해 둡니다.** HMAC 네 번짜리 키 사슬은 요청마다 계산하지 않습니다. `@smithy/signature-v4`가 (날짜, 리전, 서비스, 자격 증명의 해시, 세션 토큰)을 열쇠로 최근 50개까지 모듈 안에 기억합니다(`dist-cjs/index.js` 85∼103 `signingKeyCache`). 하루에 한 번, 날짜가 바뀔 때(한국 오전 9시) 새로 계산됩니다. 요청마다 새로 하는 것은 정규 요청 해시와 마지막 HMAC 한 번입니다.

**경로는 한 번 더 인코딩한다: 콜론 함정의 정체.** 실습 5번은 콜론이 든 모델 ID(`jp.anthropic.claude-haiku-4-5-20251001-v1:0`)로 같은 일을 합니다. 이 ID는 경로 인코딩을 보이려고 고른 모양입니다. Haiku 4.5에 `jp.` 프로필이 실제로 있는지는 확인이 필요합니다(16-6절 "추론 프로필").

```text
선로의 경로      : /model/jp.anthropic.claude-haiku-4-5-20251001-v1:0/invoke-with-response-stream
정규 요청의 경로 : /model/jp.anthropic.claude-haiku-4-5-20251001-v1%3A0/invoke-with-response-stream
```

- **선로에는 콜론이 그대로 나갑니다.** Bedrock SDK가 경로를 만들 때 쓰는 인코더는 RFC 3986에서 경로에 써도 되는 글자(`:`, `@`, `!` 등)를 그대로 둡니다(`internal/utils/path.js` 14∼16 `encodeURIPath`).
- **정규 요청에는 그 경로를 조각마다 한 번 더 인코딩해서 넣습니다.** `@smithy/signature-v4`의 `getCanonicalPath`(`dist-cjs/index.js` 529∼550)가 경로를 정리한 뒤 `escapeUri`로 한 번 더 바꾸고 `%2F`만 `/`로 되돌립니다. 코드의 변수 이름도 `doubleEncoded`입니다. 이 동작은 `uriEscapePath` 옵션(기본 `true`, AWS SDK 설정 이름으로는 `signingEscapePath`)으로 켜져 있고, 알려진 바로는 S3 클라이언트만 이것을 끕니다(이 레포에는 S3 클라이언트가 없어 코드로 보지는 않음). "S3가 아닌 서비스는 선로의 경로를 한 번 더 인코딩한다"는 규칙입니다. 지금 AWS IAM 문서 본문에는 "두 번"이라는 말이 직접 나오지 않아서, 규칙은 SDK 코드와 서버가 돌려준 정규 요청(콜론이 `%3A`)으로 확인한 것입니다.
- **`curl`은 경로를 받은 그대로 정규 요청에 넣습니다.** `curl` 8.7.1로 127.0.0.1의 가짜 서버에 `--aws-sigv4`를 보내고, 받은 서명을 두 가지 정규 경로로 다시 계산해 봤습니다. 서명이 맞은 쪽은 `v1:0`(그대로)이었고 `v1%3A0`은 맞지 않았습니다(실측). 서버는 `v1%3A0`으로 계산하니 서명이 어긋난 것입니다. 모델 ID를 미리 `v1%3A0`으로 바꿔 보내면 curl은 `v1%3A0`으로, 서버는 한 번 더 바꾼 `v1%253A0`으로 계산하므로 역시 어긋납니다(curl 쪽은 실측, 서버 쪽은 SDK 규칙에서 추정). 그날 받은 오류 본문의 정규 경로가 `%3A`였던 것과 맞습니다.
- 이 레포의 운영 모델 ID(`jp.anthropic.claude-haiku-5-5`)에는 콜론이 없어 이 함정을 밟지 않지만, Haiku 4.5처럼 `-v1:0`이 붙는 ID로 바꾸면 SDK는 맞게 처리하고, 경로를 받은 그대로 서명하는 도구(curl 8.7.1의 `--aws-sigv4` 등)는 틀립니다.

---

## 16-4. SDK는 자격 증명을 어디서 찾나

(2026-11-08 추가) 이 절의 대상은 SDK가 "어느 자격 증명으로 서명할지"를 고르는 규칙입니다. 코드에 키를 적지 않으면 SDK는 정해진 곳들을 차례로 뒤져 처음 찾은 것을 씁니다. 이 프로젝트에 필요한 이유는 17-2 #26입니다. 이 규칙을 몰라서, 새로 넣은 IAM 키가 아니라 `.env.local`에 남아 있던 다른 키로 호출이 나갔습니다(아래 "함정").

코드에 키를 넣지 않아도 AWS SDK는 정해진 순서로 자격 증명을 찾습니다. 이것을 **자격 증명 체인**(credential provider chain)이라고 합니다. Node용 기본 체인은 대략 이 순서입니다.

```text
환경변수 (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)   ← AWS_PROFILE이 있으면 건너뜀
→ SSO (코드에서 SSO 설정을 직접 넘겼을 때만)
→ 공유 파일 (~/.aws/credentials, ~/.aws/config의 프로필. 프로필에 적은 SSO·역할 맡기도 여기서)
→ 외부 프로세스 (credential_process)
→ 웹 ID 토큰 파일 (AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN → STS)
→ 컨테이너 자격 증명(ECS 작업 역할 등) 또는 EC2 인스턴스 메타데이터(IMDS)
```

앞에서 찾으면 뒤는 보지 않습니다. 같은 코드가 노트북에서는 환경변수로, AWS 서버에서는 인스턴스 역할로 인증되는 것이 이 체인 덕분입니다.

(2026-11-08 추가) 블록 읽는 법입니다. 위에서 아래로 찾는 차례이고, `→`는 "앞 단계에서 못 찾으면 다음 단계로"라는 뜻입니다. 괄호 안은 그 단계가 읽는 곳, `←` 오른쪽은 예외 규칙입니다. 낯선 이름 넷을 풀면 이렇습니다.

- **SSO**(Single Sign-On)는 회사 로그인 한 번으로 여러 AWS 계정에 들어가는 방식입니다. AWS에서는 IAM Identity Center가 이 일을 합니다.
- **`credential_process`는** 자격 증명을 내주는 외부 프로그램을 설정 파일에 적어 두면, SDK가 그 프로그램을 실행해 출력에서 키를 받는 방식입니다.
- **ECS 작업 역할**은 AWS의 컨테이너 실행 서비스(ECS)가 컨테이너마다 붙여 주는 역할입니다.
- **IMDS**는 바로 아래 문단에서 풉니다.

(2026-11-06 갱신) 순서를 `@aws-sdk/credential-provider-node` 3.972.92의 코드(`dist-cjs/index.js` 96∼160 `defaultProvider`)에 맞췄습니다. 지난 판의 "SSO 로그인 캐시" 단계는 코드에서 SSO 설정을 직접 넘길 때만 쓰이고 평소에는 건너뜁니다(126∼134). `aws sso login`으로 쓰는 보통의 SSO는 프로필 단계가 처리합니다. 마지막 단계는 ECS 같은 컨테이너용 변수(`AWS_CONTAINER_CREDENTIALS_*_URI`)가 있으면 그쪽, 없으면 IMDS로 갑니다(5∼19). **IMDS**(Instance Metadata Service)는 EC2 가상 머신 안에서만 닿는 주소 `169.254.169.254`의 HTTP 서비스로, 그 머신에 붙은 역할의 임시 자격 증명을 내줍니다. `AWS_EC2_METADATA_DISABLED=true`면 이 단계를 끕니다.

### Bedrock SDK의 우선순위

이 프로젝트가 쓰는 `@anthropic-ai/bedrock-sdk` 1.1.1은 그 앞에 **Bedrock API 키**를 끼웁니다(`node_modules/@anthropic-ai/bedrock-sdk/client.js`의 생성자 주석과 코드, `core/auth.js`). 아래 블록은 번호가 작을수록 먼저 봅니다. 1·2는 베어러 토큰을, 3∼5는 SigV4 서명에 쓸 키를 찾는 단계입니다.

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

Bedrock을 붙인 직후 `.env.local`에는 처음 받은 단기 API 키(`AWS_BEARER_TOKEN_BEDROCK`)와 새로 만든 IAM 액세스 키가 **함께** 있었습니다. 처음 커밋된 코드(`144d25b`)는 클라이언트를 `new AnthropicBedrock({ awsRegion, maxRetries: 0 })`로 만들었고, 워커와 측정 스크립트는 시작할 때 `.env.local`을 환경변수로 읽습니다. 그러면 위 순서의 2단계에서 API 키가 먼저 잡혀, **IAM 키가 있어도 SCP가 거부하는 방식(#4, 베어러 토큰)으로 호출합니다.** 요청에는 SigV4 서명 대신 `Authorization: Bearer bedrock-api-key-…`가 실리고, 응답은 #4와 같은 `explicit deny` 403입니다.

- 다른 작업의 확인용 `curl`과 A/B 측정용 임시 스크립트는 이 변수를 지우고(`unset`, `delete process.env.AWS_BEARER_TOKEN_BEDROCK`) 돌려서 드러나지 않았습니다.
- 고치는 방법은 둘이었습니다. `.env.local`에서 그 줄을 지우거나(어차피 단기 키라 만료됨), 클라이언트를 `apiKey: null`로 만들어 SigV4만 쓰게 하는 것입니다. 후자가 "이 경로는 IAM 키로만 인증한다"는 의도를 코드에 남깁니다.
- **고친 뒤.** 두 가지가 모두 됐습니다. `.env.local`의 그 줄은 지워졌고, [src/models/index.ts](../../src/models/index.ts)의 `createBedrockClient()`가 `apiKey: null`로 만듭니다. [src/models/index.test.ts](../../src/models/index.test.ts)는 남은 변수를 흉내 내고, 요청의 `Authorization` 머리글이 `AWS4-HMAC-SHA256`(SigV4)으로 시작하는지 봅니다. `apiKey: null`을 빼면 이 테스트가 실패하는 것도 확인했습니다. 실제 IAM 키에 가짜 남은 변수를 넣고 한 번 불렀을 때는 인증을 지나 모델 사용 자격 403(#7)까지 갔습니다.

이 함정은 8-8절의 "import 시점에 읽는 환경변수"와 같은 계열입니다. **암묵적으로 읽는 설정은 우선순위가 정해져 있고, 그 순서를 모르면 내가 넣은 값이 아닌 다른 값이 쓰입니다.** 인증 수단처럼 정책과 얽힌 설정은 명시적으로 고르는 편이 안전합니다.

#### 깊이 보기: 체인의 실제 동작(순서 뒤집기와 요청마다 다시 찾기) (2026-11-06 추가)

위 우선순위의 4·5단계는 실제로는 체인 하나입니다. 생성자에 키를 넘기지 않으면(이 레포가 그렇습니다) Bedrock SDK는 서명할 때마다 이 함수를 부릅니다(`node_modules/@anthropic-ai/bedrock-sdk/core/auth.js` 48∼63, 줄여 옮김).

```js
const DEFAULT_PROVIDER_CHAIN_RESOLVER = (logger) =>
  import('@aws-sdk/credential-providers').then(({ createCredentialChain, fromEnv, fromNodeProviderChain }) =>
    // The Node default chain skips env credentials whenever `AWS_PROFILE` is set;
    // the AWS CLI and the other Anthropic SDKs let env credentials win.
    createCredentialChain(fromEnv(…), fromNodeProviderChain({ … })),
  );
```

여기서 두 가지가 나옵니다.

**(가) `AWS_PROFILE`이 있으면 순서가 뒤집힙니다.** Node 기본 체인의 첫 단계는 `AWS_PROFILE`이 설정돼 있으면 환경변수 키가 있어도 "AWS_PROFILE is set, skipping fromEnv provider"를 던지고 다음 단계(프로필)로 넘어갑니다. 둘 다 있으면 경고를 한 번 찍습니다(`@aws-sdk/credential-provider-node` `dist-cjs/index.js` 96∼122). Bedrock SDK는 그 체인 **앞에** `fromEnv`를 하나 더 둬서, 위 주석대로 AWS CLI처럼 환경변수 키가 이기게 만듭니다. [lab/16-credential-chain.mjs](lab/16-credential-chain.mjs) 1번은 임시 폴더에 `[demo]` 프로필 파일을 만들고 `AWS_PROFILE=demo`와 환경변수 키를 함께 둔 실측입니다.

```text
Node 기본 체인        → AKIDPROFILEEXAMPLE  (환경변수를 건너뛰고 프로필)
  그때 나온 경고: @aws-sdk/credential-provider-node - defaultProvider::fromEnv WARNING: Multiple credential sources detected: …
Bedrock SDK 체인      → AKIDENVEXAMPLE  (fromEnv를 맨 앞에 둬서 환경변수가 이김)
```

같은 기계에서 다른 Node AWS SDK 도구는 프로필의 신원으로, 이 워커는 `.env.local`의 신원으로 움직일 수 있다는 뜻입니다. 거절을 볼 때 "누가"(16-1절)를 먼저 확인해야 하는 이유가 하나 더 생깁니다.

**(나) 체인을 요청마다 새로 만들어, 기억이 요청 사이에 남지 않습니다.** 위 함수는 `getAuthHeaders`(같은 파일 70∼124) 안에서 불리고, `getAuthHeaders`는 요청을 보내기 직전의 미들웨어에서 **시도마다** 불립니다(`client.js` 169∼176, 233∼247). 그런데 기억(memoize)은 체인 객체 안에 있습니다.

- `createCredentialChain`은 기억하지 않고 매번 차례로 물어봅니다(`@aws-sdk/credential-providers` `dist-cjs/index.js` 4∼23).
- `fromNodeProviderChain`은 처음 불릴 때 기본 체인을 만들어 **자기 클로저 안에** 두고(103∼112), 기본 체인은 받은 자격 증명을 만료 5분 전까지 다시 씁니다(`credential-provider-node` 21∼77, 161∼162).
- 그런데 Bedrock SDK가 요청마다 `fromNodeProviderChain(…)`을 새로 부르므로 클로저도 매번 새것이고, 기억은 요청 하나가 끝나면 버려집니다(코드로 확인).

지금처럼 **환경변수 키**면 `fromEnv`가 `process.env`를 읽고 끝나므로 아무 문제가 없습니다. 자격 증명을 **네트워크에서 받아 오는 방식**으로 바꾸면 달라집니다. 실습 2∼4번은 STS와 IMDS를 127.0.0.1의 가짜 서버로 돌려(`AWS_ENDPOINT_URL_STS`, `AWS_EC2_METADATA_SERVICE_ENDPOINT`) Bedrock 요청을 여러 번 보내고 호출 수를 셉니다(3번은 출력에서 2번 아래의 `[체인을 한 번 만들어 providerChainResolver로 넘김]` 칸으로 나옵니다). 가짜 STS는 응답 전에 40ms를 쉽니다. 13장에서 잰 서울↔AWS 도쿄 왕복(약 40ms, 39∼44ms)과 비슷한 값으로 가정한 것입니다.

| 자격 증명 출처 | 요청 3번에 STS·IMDS 호출 | 요청을 내보내기까지 걸린 시간 |
| --- | --- | --- |
| 환경변수 키 (지금 운영) | 0번 | 재지 않음. 네트워크 호출이 없어 자격 증명 몫은 사실상 0 |
| 웹 ID 토큰 + STS, 지금 코드 | **3번 (요청마다 1번)** | 첫 요청 73∼88ms(모듈 읽기 포함, 세 번 돌린 범위), 그다음 **46ms씩** |
| 웹 ID 토큰 + STS, 체인을 한 번만 만들어 넘김 | 1번 | 첫 요청 47∼48ms, 그다음 1∼3ms |
| IMDS, 지금 코드 | **요청마다 3번** (`PUT /latest/api/token` → 역할 이름 → 자격 증명) | (지연을 넣지 않음) |

- 웹 ID나 IMDS로 바꾸면 **매 턴 LLM 요청 앞에 자격 증명 왕복이 붙습니다.** 13장의 지연 예산에서 첫 토큰 시간에 그대로 더해지는 몫입니다. 실제 STS까지의 왕복은 STS 엔드포인트 위치에 따라 다르고 재지 않았습니다.
- 16-1절의 #37 경로와 겹치면, 실패한 한 턴에 네 번 보내는 동안 STS도 네 번 부릅니다(코드로 추론).
- 웹 ID 토큰 파일은 부를 때마다 다시 읽습니다(`@aws-sdk/credential-provider-web-identity` `dist-cjs/index.js` 34∼47의 `readFileSync`). 파일이 갱신돼도 따라가는 것은 장점입니다.
- STS에는 호출량 한도가 있어, 통화가 많아지면 한도에 가까워질 수 있습니다(추정, 한도 값은 확인하지 않음).

**대응(제안, 코드는 고치지 않았습니다).** 체인을 워커가 한 번만 만들어 `providerChainResolver`로 넘기면 기억이 살아남습니다. SDK가 생성자 옵션으로 열어 둔 자리입니다(`client.js` 81 주석).

```ts
import { createCredentialChain, fromEnv, fromNodeProviderChain } from '@aws-sdk/credential-providers';

const credentials = createCredentialChain(fromEnv(), fromNodeProviderChain()); // SDK와 같은 순서, 한 번만
new AnthropicBedrock({ awsRegion, apiKey: null, maxRetries: 0, providerChainResolver: async () => credentials });
```

`@aws-sdk/credential-providers`는 지금 Bedrock SDK를 통해서만 들어와 있어서, 쓰려면 `package.json`에 직접 넣어야 합니다. 지금의 환경변수 키에서는 필요 없고, 16-9절의 연동으로 갈 때 함께 바꿀 일입니다.

---

## 16-5. 인가: IAM 정책은 어떻게 평가되나

(2026-11-08 추가) **인가**는 인증으로 신원이 확인된 요청을 두고 "이 신원이 이 자원에 이 동작을 해도 되나"를 정하는 일입니다. AWS는 이 판단을 **정책**이라는 JSON 문서로 합니다. 이 절은 정책 한 문장을 읽는 법, 정책이 붙는 곳에 따른 종류, 여러 정책이 겹칠 때의 평가 순서를 보고, 이 레포의 에이전트에 맞는 좁은 정책을 만들어 봅니다. #4·#6이 모두 이 단계의 거절이었고, 운영에 올릴 때는 지금의 넓은 정책을 좁혀야 하므로 이 프로젝트에 필요한 내용입니다.

### 정책의 모양

IAM 정책은 JSON 문서이고, 규칙(statement) 하나는 이렇게 읽습니다.

```json
{
  "Effect": "Allow",
  "Action": ["bedrock:InvokeModelWithResponseStream"],
  "Resource": ["arn:aws:bedrock:ap-northeast-1:<작업 계정 ID>:inference-profile/jp.anthropic.claude-haiku-5-5"],
  "Condition": { "...": "..." }
}
```

"이 **효과**(허용·거부)를, 이 **동작**에 대해, 이 **자원**에서, 이 **조건**일 때"입니다. 자원은 ARN(`arn:aws:서비스:리전:계정:자원`)으로 가리킵니다.

(2026-11-08 추가) 칸마다 조금 더 풀면 이렇습니다.

- **`Action`은** `서비스 접두사:API 이름` 꼴입니다. `bedrock:InvokeModelWithResponseStream`은 "Bedrock의 InvokeModelWithResponseStream API(스트리밍으로 모델 부르기)"입니다.
- **`Condition`의** `"...": "..."`는 자리만 표시한 것입니다. 실제 조건의 예는 아래 "최소 권한"의 운영 정책에 있습니다.
- **ARN**(Amazon Resource Name)은 AWS 안의 자원과 신원에 붙는 이름입니다. 위 자원을 칸으로 나누면 `arn`(고정) : `aws`(파티션, 보통 리전들의 묶음) : `bedrock`(서비스) : `ap-northeast-1`(리전) : `<작업 계정 ID>`(계정) : `inference-profile/jp.anthropic.claude-haiku-5-5`(자원 종류/이름)입니다. 전역 서비스(IAM)는 리전 칸이, AWS가 가진 공용 자원(아래의 기본 모델)은 계정 칸이 비어 `::`가 됩니다.

정책은 붙는 곳에 따라 종류가 나뉩니다.

| 종류 | 어디에 붙나 | 하는 일 |
| --- | --- | --- |
| 신원 기반 정책 | 사용자·역할 | "이 신원은 무엇을 할 수 있나" (권한을 **줌**) |
| 자원 기반 정책 | S3 버킷 등 자원 | "누가 이 자원을 쓸 수 있나" |
| **신뢰 정책** (2026-11-06 추가) | IAM 역할 | "누가 이 역할을 **맡을** 수 있나". 역할에 붙는 자원 기반 정책의 한 종류 |
| **SCP** | 조직의 계정·조직 단위 | "이 계정 안의 누구도 이 이상은 못 한다" (상한, 권한을 **주지 않음**) |
| 권한 경계, 세션 정책 | 사용자·역할, 세션 | 추가 상한 |

(2026-11-08 추가) 표 읽는 법입니다. "어디에 붙나"는 그 정책 문서를 매다는 대상이고, "하는 일"은 그 정책이 권한을 주는지(**줌**) 줄이기만 하는지(**상한**)입니다. 요청 하나에 이 정책들이 한꺼번에 적용될 수 있고, 그것을 어떻게 합치는지가 아래 "평가 순서"입니다.

(2026-11-06 추가) 표의 낯선 이름 셋입니다.

- **주체**(principal)는 요청을 보낸 신원입니다. IAM 사용자, 역할 세션(`assumed-role/…`), 연동된 외부 신원(`accounts.google.com`의 서비스 계정 등), AWS 서비스가 될 수 있습니다. 신원 기반 정책에는 주체 칸이 없고(붙은 곳이 곧 주체), 자원 기반 정책과 신뢰 정책에는 `Principal` 칸이 있습니다.
- **신뢰 정책과 역할 맡기**(AssumeRole). 역할은 권한(신원 기반 정책)과 "누가 맡을 수 있나"(신뢰 정책)를 따로 갖습니다. 누군가 STS에 `AssumeRole`(AWS 신원이 맡을 때), `AssumeRoleWithWebIdentity`(구글 같은 외부 발급자가 서명한 OIDC 토큰으로 맡을 때, 16-9절 깊이 보기) 등을 부르면 STS가 신뢰 정책을 평가하고, 통과하면 그 역할의 임시 자격 증명을 줍니다. 다른 계정의 신원이 맡을 때는 신뢰 정책과 그 계정 쪽 신원 정책의 `sts:AssumeRole` 허용이 **둘 다** 있어야 합니다. 콘솔 로그인 역할 `AccountFullAccessRole`(16-2절)도 신뢰 정책이 허용한 누군가가 맡은 것입니다. 그 신뢰 정책은 조회하지 않았습니다.
- **권한 경계**(permissions boundary)는 사용자·역할에 붙이는 "이 신원이 가질 수 있는 최대 권한"이고, **세션 정책**은 역할을 맡을 때 요청에 실어 그 세션만 더 좁히는 정책입니다. 둘 다 SCP처럼 권한을 주지 않고 상한만 정합니다. 최종 권한은 교집합입니다(아래 깊이 보기에서 오사카 예).

### 평가 순서

(2026-11-08 추가) 먼저 거부의 두 종류를 구별해 둡니다. **명시적 거부**(explicit deny)는 어느 정책이든 `"Effect": "Deny"`인 문장이 이 요청에 맞는 경우입니다. **기본 거부**(implicit deny)는 거부 문장은 없지만 맞는 허용(`"Effect": "Allow"`) 문장도 하나 없어서 나는 거부입니다. 차이는 고치는 방법에서 드러납니다. 기본 거부는 알맞은 정책에 허용 한 줄을 더하면 풀립니다. 명시적 거부는 허용을 아무리 더해도 풀리지 않아서, 그 거부 문장을 고치거나 그 정책이 닿지 않는 길(#6처럼 SCP가 없는 관리 계정)을 써야 합니다.

요청 하나가 들어오면 AWS는 관련된 정책을 모두 모아 이렇게 판단합니다(단순화한 그림).

```text
1. 기본값은 거부
2. 어디든 "명시적 거부(Deny)"가 맞으면 → 거부. 끝. (어떤 허용도 이것을 뒤집지 못함)
3. SCP가 이 동작을 허용 범위에 두는가? 아니면 → 거부
4. 신원 기반(또는 자원 기반) 정책에 허용(Allow)이 있는가? 없으면 → 거부 (1의 기본값)
5. 권한 경계·세션 정책도 허용하는가? → 허용
```

(2026-11-08 추가) 블록 읽는 법입니다. 번호는 AWS가 묻는 차례이고, "→ 거부"가 나오면 그 자리에서 판단이 끝납니다. 2의 거부는 명시적 거부, 3·4·5에서 허용을 못 찾아 난 거부는 기본 거부입니다. 2∼5를 모두 지나야 허용입니다.

핵심 규칙은 **명시적 거부 > 허용 > 기본 거부**입니다. #4의 메시지가 바로 2단계였습니다. 작업 계정의 콘솔 역할은 이름부터 `AccountFullAccessRole`(계정 전체 권한)이었지만, 조직의 SCP가 `bedrock:CallWithBearerToken`을 명시적으로 거부했으므로 허용이 아무리 넓어도 소용없었습니다.

### SCP는 왜 API 키를 막았나

조직 SCP의 실제 내용은 작업 계정에서 조회 권한이 없어 보지 못했으므로, 이 절의 SCP 이야기는 추정입니다. 다만 AWS 문서의 Bedrock 예시 SCP에 **API 키 만들기(`iam:CreateServiceSpecificCredential`)와 쓰기(`bedrock:CallWithBearerToken`)를 함께 막는 정책**이 있고, 메시지가 그 동작과 정확히 맞습니다. 베어러 토큰은 새면 그대로 쓰이므로(16-3절), 보안을 중시하는 조직이 흔히 거는 규칙입니다.

(2026-11-08 추가) 그 모양을 문장 하나로 적으면 이렇습니다. 아래 깊이 보기의 실습([lab/16-policy-eval.mjs](lab/16-policy-eval.mjs))이 쓰는 추정 모양이고, 이 조직의 SCP 원문이 아닙니다.

```json
{
  "Sid": "DenyApiKeys",
  "Effect": "Deny",
  "Action": ["iam:CreateServiceSpecificCredential", "bedrock:CallWithBearerToken"],
  "Resource": "*"
}
```

"이 계정 안의 누구든, 어떤 자원에 대해서든(`*`), 장기 API 키를 만들거나 Bedrock API 키로 부르면 거부한다"로 읽습니다. 신원 기반 정책처럼 SCP에도 `Principal` 칸이 없습니다. SCP가 걸린 계정 안의 모든 신원이 곧 대상이기 때문입니다.

여기서 한 가지가 더 설명됩니다. #3에서 같은 키가 **Mantle 창구에서는 인증을 통과**했습니다. AWS 문서에 따르면 Mantle 창구의 API 키 사용은 별도 동작(`bedrock-mantle:CallWithBearerToken`)이라, `bedrock:CallWithBearerToken`만 막으면 Mantle은 막히지 않습니다. 같은 키가 창구에 따라 통과하고 막힌 이유입니다.

(2026-11-06 추가) 2026-11-06에 다시 본 AWS 문서("Control permissions for generating and using Amazon Bedrock API keys")의 예시는 `iam:CreateServiceSpecificCredential`, `bedrock:CallWithBearerToken`, `bedrock-mantle:CallWithBearerToken` **셋을 함께** 거부하고, "API 키 사용을 완전히 막으려면 두 동작을 모두 거부해야 한다"고 적습니다. 단기·장기 키를 가르는 조건 키 `bedrock:bearerTokenType`(`SHORT_TERM`·`LONG_TERM`)도 있습니다. 2026-11-08에 본 AWS 문서("API keys")에는 Mantle 쪽에도 같은 뜻의 조건 키 `bedrock-mantle:bearerTokenType`이 있습니다. 이 조직의 SCP가 Mantle을 막지 않은 것은 Mantle 동작이 생기기 전의 예시 모양(둘만 거부)이기 때문으로 보입니다(추정, SCP 원문은 보지 못함).

### 최소 권한: 지금 정책과 운영용 정책

(2026-11-08 추가) **최소 권한**(least privilege)은 신원에게 그 일을 하는 데 꼭 필요한 동작과 자원만 허용하는 원칙입니다. 키가 새거나 코드가 잘못 동작해도, 그 신원이 할 수 있는 일이 좁으면 피해도 그만큼 좁습니다.

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

- (2026-11-08 추가) 맨 위 `"Version": "2012-10-17"`은 정책 언어의 판 이름이라 오늘 날짜로 바꾸지 않습니다. `Sid`는 문장마다 붙이는 이름표(statement ID)로, 평가에는 쓰이지 않고 사람이 문장을 가리킬 때 씁니다.
- 기본 모델 ARN에는 계정 칸이 비어 있습니다(`::`). AWS가 가진 공용 자원이기 때문입니다.
- 두 번째 규칙의 조건은 "기본 모델은 **이 프로필을 거쳐서만** 부를 수 있다"는 뜻입니다. 프로필 없이 오사카 모델을 바로 부르는 것은 허용하지 않습니다.
- **빠뜨리기 쉬운 것:** 서버리스 모델은 첫 호출 때 AWS Marketplace 구독이 자동으로 만들어지는데, AWS 문서에 따르면 그 첫 호출을 하는 신원에게 `aws-marketplace:Subscribe`·`Unsubscribe`·`ViewSubscriptions` 권한이 있어야 합니다. 관리자가 한 번 먼저 불러 구독을 만들어 두면 이후 신원에게는 필요 없습니다. 지금의 관리형 정책이 이것을 포함하는지는 확인 필요입니다. (2026-11-06 추가) **Marketplace 구독**은 AWS가 다른 회사(여기서는 Anthropic)의 상품을 대신 파는 장터에서 그 상품을 "이 계정이 쓰겠다"고 등록해 두는 것입니다. 청구와 판매사 약관이 이 구독에 묶이므로, Bedrock의 Anthropic 모델도 이 경로로 계정에 열립니다.
- 이 정책은 원리를 보여 주는 예시입니다. 운영 전환 때 실제 호출로 검증합니다.

#### 깊이 보기: 정책 평가를 손으로 따라 하기 (2026-11-06 추가)

**요청을 네 칸으로 적습니다.** AWS는 요청 하나를 받으면 먼저 "요청 문맥"을 만듭니다. #4를 그 모양으로 적으면 이렇습니다.

| 칸 | #4의 값 | 어디서 왔나 |
| --- | --- | --- |
| 주체 | `arn:aws:sts::<작업 계정 ID>:assumed-role/AccountFullAccessRole/<세션 이름>` | 토큰 안의 자격 증명(16-3절 깊이 보기의 `X-Amz-Credential`·세션 토큰)이 가리키는 신원 |
| 동작 | `bedrock:CallWithBearerToken` | 베어러 토큰으로 들어온 요청이라 붙는 동작. 실제 호출 동작(`bedrock:InvokeModelWithResponseStream`)의 권한도 따로 필요한 것으로 보임(확인 필요) |
| 자원 | `*` | 오류 메시지의 `resource: *` |
| 조건 값 | `bedrock:bearerTokenType = SHORT_TERM` 등 | 요청에서 AWS가 채움. 조건 키는 서비스마다 정해져 있음 |

**정책 문장마다 맞는지 봅니다.** 한 문장이 "맞는다"는 것은 동작·자원(·주체)·조건이 **모두** 맞는다는 뜻입니다. 동작과 자원은 `*`(0자 이상)·`?`(한 글자) 와일드카드를 쓰고, 동작 이름은 대소문자를 가리지 않습니다. 조건은 연산자끼리·키끼리 모두 맞아야 하고(AND), 한 키에 값을 여러 개 적으면 그중 하나만 맞으면 됩니다(OR). **요청에 그 조건 키가 아예 없으면** `…IfExists`가 붙지 않은 연산자는 거짓입니다. [lab/16-policy-eval.mjs](lab/16-policy-eval.mjs)의 장난감 평가기가 #4를 이렇게 찍습니다(SCP 내용은 보지 못해 메시지와 AWS 문서 예시로 추정한 모양).

```text
  정책 | 문장 | 효과 | 동작 | 자원 | 주체 | 조건 | 맞음
  scp:FullAWSAccess | AllowAll | Allow | O | O | O | 조건 없음 | ★
  scp:DenyBedrockApiKeys(추정) | DenyApiKeys | Deny | O | O | O | 조건 없음 | ★
  scp:DenyBedrockApiKeys(추정) | DenyUseCaseForm | Deny | X | O | O | — |
  identity:AccountFullAccess(추정) | All | Allow | O | O | O | 조건 없음 | ★
  1. 명시적 거부: scp:DenyBedrockApiKeys(추정)의 DenyApiKeys
  → 거부 (명시적)
```

(2026-11-08 추가) 출력 읽는 법입니다. 표 부분은 한 줄이 정책 문장 하나입니다. "정책"은 `종류:정책 이름`, "문장"은 그 문장의 `Sid`입니다. 동작·자원·주체 칸의 O·X는 그 칸이 요청과 맞는지, 맨 끝의 ★는 문장 전체가 맞았다는 표시입니다. 조건 칸의 `—`는 동작·자원·주체 중 하나가 이미 맞지 않아 조건은 보지 않았다는 뜻입니다(실습 코드 64행). 표 아래의 번호 줄은 바로 아래 "평가 순서를 따라갑니다" 표의 단계 번호(1 거부 확인, 2 SCP, 3 자원 기반, 4 신원 기반, 5 권한 경계, 6 세션 정책)이고, 마지막 `→` 줄이 판정입니다. 본문 "평가 순서" 블록과는 번호 매김이 다릅니다.

허용 문장 둘(★)이 맞아도, 거부 문장 하나가 맞으면 거기서 끝납니다. `FullAWSAccess`는 조직을 만들면 기본으로 붙는 "모두 허용" SCP입니다. SCP는 권한을 주지 않으므로, 이것이 없으면 SCP 단계에서 허용을 찾지 못해 모든 요청이 기본 거부됩니다.

**평가 순서를 따라갑니다.** 장난감은 AWS 문서의 "같은 계정 안의 요청" 흐름을 줄인 것입니다. 위 "평가 순서" 목록의 2∼5단계를, 자원 기반 정책과 세션 정책까지 나눠 번호를 다시 매겼습니다(1의 기본 거부는 "아니면" 칸에 들어감).

| 단계 | 묻는 것 | 아니면 |
| --- | --- | --- |
| 1 | 어느 정책이든 **맞는 Deny**가 있나 | 있으면 **명시적 거부**, 끝 |
| 2 | (조직에 속한 멤버 계정이면) **SCP에 맞는 Allow**가 있나 | 없으면 기본 거부 |
| 3 | 자원 기반 정책(신뢰 정책 포함)에 맞는 Allow가 있나 | 같은 계정 안에서는 여기서 허용될 수 있음. 없으면 다음으로 |
| 4 | **신원 기반 정책에 맞는 Allow**가 있나 | 없으면 기본 거부 |
| 5 | 권한 경계가 있으면, 거기에도 Allow가 있나 | 없으면 기본 거부 |
| 6 | 세션 정책이 있으면, 거기에도 Allow가 있나 | 없으면 기본 거부 |
| 끝 | 모두 지나면 | **허용** |

SCP의 "상한"은 2단계입니다. 실제 조직에서는 루트·조직 단위(OU)·계정의 **각 층마다** SCP에 허용이 있어야 아래로 내려갑니다(AWS Organizations 문서). 관리 계정에는 이 단계가 아예 없습니다. 같은 스크립트로 이번 거절과 16-5절의 운영 정책을 돌린 결과입니다.

| 요청 | 결과 | 멈춘 단계 |
| --- | --- | --- |
| #4 콘솔 역할 세션의 API 키 호출 | 거부 (명시적) | 1. SCP의 Deny |
| #6 작업 계정에서 양식 제출 `bedrock:PutUseCaseForModelAccess` | 거부 (명시적) | 1. SCP의 Deny |
| #6 관리 계정에서 같은 제출 | **허용** | 2단계 없음 → 4. 신원 기반 허용 |
| 운영 정책, `jp.` 프로필 ARN | 허용 | 4. 첫 문장 |
| 운영 정책, 프로필이 오사카 기본 모델로 보낸 요청 (`bedrock:InferenceProfileArn` = `jp.` 프로필) | 허용 | 4. 둘째 문장(조건 맞음) |
| 운영 정책, 프로필 없이 도쿄 기본 모델 직접 | 거부 (기본) | 4. 둘째 문장의 조건 키가 요청에 없음 |
| 운영 정책, `global.` 프로필 | 거부 (기본) | 4. 맞는 자원 없음 |
| 운영 정책 + "도쿄만" 권한 경계, 오사카로 간 요청 | **거부 (기본)** | 5. 권한 경계 밖 |

마지막 줄이 교집합의 함정입니다. 신원 정책은 오사카를 허용했지만, 권한 경계를 `arn:aws:bedrock:ap-northeast-1:*`로 좁혀 두면 `jp.` 프로필이 오사카로 보낸 요청만 골라 실패합니다. 요청이 어느 리전으로 갈지는 AWS가 정하므로 **같은 호출이 가끔만 실패**하는 모양이 됩니다(장난감 평가기로 본 것, 실제 계정에서는 확인하지 않음).

이 장난감은 AWS 실제 평가기의 단순화입니다. `NotAction`·`NotResource`, `…IfExists`를 포함한 대부분의 조건 연산자, 정책 변수(`${aws:username}`), 다른 계정 사이의 요청, 자원 제어 정책(RCP), 역할 세션과 자원 기반 정책 사이의 세부 규칙은 다루지 않습니다.

**신뢰 정책도 같은 기계로 평가합니다.** 16-9절의 연동에서 AWS 역할의 신뢰 정책은 "구글이 서명한 이 서비스 계정의 토큰만 이 역할을 맡을 수 있다"를 조건으로 적습니다. 장난감은 그것을 3단계(자원 기반 정책)로 평가합니다. 웹 ID 연동에는 호출하는 쪽 AWS 신원이 없어 신원 기반 정책이 끼어들 자리가 없으므로, 신뢰 정책 하나가 맡을 수 있는지를 혼자 정합니다. 아래 각 줄은 "어떤 토큰으로 역할을 맡으려 했나 → 판정"입니다.

```text
  우리 서비스 계정, audience sts.amazonaws.com → 허용
  같은 프로젝트의 다른 서비스 계정                 → 거부 (기본)
  우리 서비스 계정이지만 다른 audience로 받은 토큰    → 거부 (기본)
  조건 없는 신뢰 정책 + 남의 서비스 계정 → 허용
```

마지막 줄이 신뢰 정책에서 가장 위험한 실수입니다. `Principal`에 `accounts.google.com`만 적고 조건을 빼면, 구글 계정을 가진 세상의 누구나(어떤 프로젝트의 서비스 계정이든) 그 역할을 맡을 수 있습니다. 조건 키의 뜻은 16-9절 깊이 보기에 있습니다.

**직접 해 볼 수 있는 것(안내만, 이 장에서는 실행하지 않음).** 아래 세 가지는 AWS CLI로 부를 수 있는 무료 API이고, 자원을 바꾸지 않고 읽기만 합니다. 실제 계정에서 돌리므로 출력의 계정 ID·ARN을 공개 저장소에 붙이지 않습니다.

| 명령 | 알려 주는 것 | 이번에 쓸 곳 |
| --- | --- | --- |
| `aws sts get-caller-identity` | 지금 자격 증명이 **누구**인가(계정, ARN) | 16-1절 "누가"의 확인. 16-4절의 순서 뒤집기(`AWS_PROFILE`)가 의심될 때 |
| `aws iam simulate-principal-policy --policy-source-arn <사용자·역할 ARN> --action-names bedrock:InvokeModelWithResponseStream --resource-arns <자원 ARN> --context-entries …` | 그 신원의 정책으로 이 요청이 허용되는가, 어느 문장이 맞았나 | 운영 정책을 붙이기 전에 위 표의 여덟 줄을 실제 평가기로 다시 확인. SCP·권한 경계가 결과에 어떻게 들어가는지는 시뮬레이터 문서를 보고 판단(확인 필요) |
| `aws sts decode-authorization-message --encoded-message <…>` | 일부 서비스가 거절할 때 주는 암호화된 사유를 풀어 줌 | 거절 메시지에 `Encoded authorization failure message`가 붙어 올 때. Bedrock의 #4는 평문으로 사유를 줬음 |

---

## 16-6. Bedrock에서만 쓰는 개념

(2026-11-08 추가) 이 절은 Amazon Bedrock(AWS가 여러 회사의 모델을 대신 돌려 주는 서비스, 8-8절)에만 있는 규칙 셋을 다룹니다. 같은 Claude라도 Bedrock으로 부르면 계정마다 그 모델을 쓸 자격이 있어야 하고(**모델 사용 신청**), 요청을 어느 리전에서 처리할지 고르는 이름이 있으며(**추론 프로필**), 요청을 넣는 주소가 둘입니다(**두 창구**). 이 프로젝트가 Bedrock을 보는 까닭은 LLM 처리를 일본으로 옮겨 턴마다 약 0.1초를 줄이려는 것이므로(13-5절), 셋 모두 "정말 일본에서, 운영 옵션 그대로 돌릴 수 있나"와 직결됩니다.

### 모델 사용 신청

(2026-11-08 추가) **모델 접근**(model access), 이 장의 말로 **모델 사용 자격**은 "이 계정의 신원이 이 모델을 불러도 되는가"입니다. IAM 정책이 허용해도 이 자격이 없으면 #5처럼 거절됩니다. 이 장에서 모델이 "열렸다"고 하면 이 자격이 생겨 호출이 응답을 받게 됐다는 뜻입니다.

예전에는 Bedrock 콘솔의 "모델 액세스" 화면에서 모델마다 켜야 했습니다. AWS 공지에 따르면 2025년 10월부터 서버리스 모델은 **첫 호출 때 자동으로 열리고**(최대 15분), 예외가 하나 남았습니다.

- **Anthropic 모델은 첫 사용 양식**(회사명, 웹사이트, 용도, 사용자가 내부인지 외부인지)을 **계정마다 한 번, 또는 조직의 관리 계정에서 한 번** 내야 합니다. 관리 계정에서 내면 멤버 계정에 이어집니다.
- #5의 "not available for this account"가 이 양식을 내지 않은 상태의 응답이었습니다. 인증과 IAM 인가를 모두 통과한 뒤에 나오는 거절이라 "키는 맞다"는 뜻이기도 합니다.
- 양식이 처리된 뒤에도 Haiku 5.5만 같은 문구로 막혔습니다(#7). 같은 키로 Haiku 4.5와 Sonnet 4.6은 도쿄 끝점에서 응답했습니다(이때 Haiku 4.5를 어느 모델 ID·프로필로 불렀는지는 남기지 않았습니다. 아래 "추론 프로필"의 확인 필요 문단). 오류 문구가 "추가 접근은 AWS 영업팀에 문의하라"고 안내하는 것처럼, 계정에 따라 최신 모델을 바로 열어 주지 않는 경우가 있는 것으로 보입니다(추정). 2026-11-05 현재 AWS 지원에 열어 달라고 요청하는 단계입니다.
- 작업 계정에서는 양식 조회(`GetUseCaseForModelAccess`)와 제출(`PutUseCaseForModelAccess`)이 모두 SCP에 막혀(#6), **SCP가 적용되지 않는 관리 계정**에서 냈습니다. 16-2절의 조직 구조가 실제로 쓰인 순간입니다.
- AWS 문서에 따르면 이 양식 요구는 Mantle 창구에는 적용되지 않습니다. 다만 도쿄 Mantle에는 Haiku 5.5가 없어 이 길로는 피할 수 없었습니다(#3).

### 추론 프로필: 어디서 처리하나

같은 모델을 부르는 ID가 셋입니다.

| ID | 뜻 | 처리 위치 |
| --- | --- | --- |
| `anthropic.claude-haiku-5-5` | 기본 모델 | 부른 리전 (Haiku 5.5는 이 방식을 어느 리전에서도 지원하지 않음) |
| `jp.anthropic.claude-haiku-5-5` | **지역형** 교차 리전 추론 프로필 | 일본 안 (도쿄·오사카) |
| `global.anthropic.claude-haiku-5-5` | **전역** 교차 리전 추론 프로필 | 전 세계 어디든 |

(2026-11-08 추가) 표 읽는 법입니다. 세 줄 모두 같은 Haiku 5.5를 부르는 모델 ID이고, 앞에 붙은 말(없음, `jp.`, `global.`)이 처리 위치를 정합니다. 이 ID를 InvokeModel 주소의 `/model/{ID}/` 자리에 넣습니다(16-3절 깊이 보기의 선로 요청). "교차 리전"은 요청을 받은 리전과 다른 리전에서도 처리할 수 있다는 뜻입니다.

**추론 프로필**은 "이 요청을 어느 리전들로 보내도 되는가"를 정한 이름입니다. 한 리전이 붐비면 다른 리전으로 보내 처리량을 늘립니다. 지역형은 데이터가 그 지역 밖으로 나가지 않는 대신 고를 수 있는 리전이 적고, 전역은 그 반대입니다. Anthropic 문서 기준으로 지역형은 전역보다 약 10% 비쌉니다.

13-5절의 "접속 지점(edge)과 처리 위치(region)는 다르다"가 여기서 구체적인 선택지가 됩니다. 서울에서 도쿄 `bedrock-runtime`에 접속해도 `global.`을 쓰면 처리는 어디서든 될 수 있습니다. 지연을 줄이려는 목적이면 `jp.`를 써야 합니다.

(2026-11-08 추가, 확인 필요) **어떤 프로필이 있는지는 모델마다 다릅니다.** Anthropic의 예전 연동 문서(Opus 4.6 이하를 다루는 Bedrock 페이지, 2026-11-08 확인, 13-5절)의 추론 프로필 표에서 Haiku 4.5 행은 `global`·`us`·`eu`만 "Yes"이고 `jp`는 "No"입니다. 그런데 13-5절의 A/B는 Bedrock 쪽을 "`jp.`(도쿄)에서 Haiku 4.5"로 기록했습니다. 그날 실제로 부른 모델 ID를 남기지 않아, 그 요청이 정말 일본 안에서 처리됐는지는 확인이 필요합니다. 도쿄 리전에서 `aws bedrock list-inference-profiles --region ap-northeast-1`을 보내 Haiku 4.5의 `jp.` 프로필이 있는지 보면 가릴 수 있습니다(실제 계정에 보내는 읽기 전용 명령이라 이 장에서는 돌리지 않았습니다). 13-5절의 실측 값은 그대로 둡니다. 어느 프로필이었든 서울에서 도쿄 끝점에 붙어 잰 값이라는 사실은 같기 때문입니다.

### 두 창구: bedrock-runtime과 Mantle

(2026-11-08 추가) **창구**는 이 장에서 같은 Bedrock에 요청을 넣는 서로 다른 주소(끝점, endpoint)를 이르는 말입니다. 둘은 주소만 다른 것이 아니라 요청 모양, 응답 형식, 권한의 동작 이름, 쓸 수 있는 모델과 기능이 다릅니다. Anthropic 문서(2026-11-08 확인, 8-8절)는 `bedrock-runtime`의 InvokeModel을 **예전 연동**, `bedrock-mantle`의 Messages API를 **새 끝점**이라 부릅니다. 이 레포의 `createBedrockClient()`는 `AnthropicBedrock`을 만들므로 **예전 연동** 쪽입니다(선로의 경로 `/model/…/invoke-with-response-stream`, 16-3절 깊이 보기).

(2026-11-08 갱신) 아래 표는 두 창구를 InvokeModel과 새 끝점으로 나눠 다시 적은 것입니다.

| | InvokeModel (`bedrock-runtime`, 예전 연동) | 새 끝점 (`bedrock-mantle`, Mantle) |
| --- | --- | --- |
| 주소 | `bedrock-runtime.<리전>.amazonaws.com` | `bedrock-mantle.<리전>.api.aws` |
| SDK 클라이언트 | `AnthropicBedrock`. **이 레포가 쓰는 것** | `AnthropicBedrockMantle`. 설치된 `@anthropic-ai/bedrock-sdk` 1.1.1에 들어 있지만 쓰지 않음 |
| 요청 모양 | Bedrock 고유: 모델이 경로에(`/model/{id}/invoke-with-response-stream`), 본문에 `anthropic_version` | Claude API와 같은 Messages API(`/anthropic/v1/messages`, 모델은 본문의 `model`). OpenAI 호환(`/v1`)도 있음 |
| 본문의 `anthropic_version` | AWS 문서의 값은 `bedrock-2023-05-31`. 이 레포의 SDK(1.4.0)는 `2026-10-21`을 넣고, Anthropic 문서상 Bedrock은 이 값을 Claude 4.7 이후 모델에만 받음. Haiku 5.5는 해당(16-3절 깊이 보기) | 넣지 않음. SDK가 본문을 Bedrock 모양으로 다시 쓰지 않음(`src/mantle-client.ts`) |
| SigV4 서명의 서비스 이름 | `bedrock` (`core/auth.js` 97∼102) | `bedrock-mantle` (`src/mantle-client.ts`의 `DEFAULT_SERVICE_NAME`) |
| 스트리밍 응답 | AWS 이진 이벤트 스트림. SDK가 SSE로 바꿈(아래 깊이 보기) | 원래 API 형식(SSE) |
| 자동 캐시 (최상위 `cache_control`) | Anthropic 문서상 **지원하지 않음**. 명시 브레이크포인트를 쓰라고 함 | 문서상 지원 |
| Anthropic 첫 사용 양식 | 필요 (위 "모델 사용 신청") | AWS 문서상 적용되지 않음 |
| API 키 동작 이름 | `bedrock:CallWithBearerToken` | `bedrock-mantle:CallWithBearerToken` |
| 도쿄의 Haiku 5.5 (2026-11-05) | 있음 (`jp.`·`global.`) | 없음 (Haiku 4.5, Opus 4.7, Opus 4.8만) |

(2026-11-08 추가) 표 읽는 법입니다. 왼쪽 칸이 지금 이 레포가 쓰는 경로이고, 오른쪽 칸은 바꿀 수 있는 대안입니다. 한 줄씩 왼쪽과 오른쪽을 견주어 읽습니다. "문서상"은 Anthropic·AWS 문서에 적힌 내용이고, 이 계정에서 실제 응답으로 확인한 것은 아니라는 뜻입니다. Haiku 5.5가 이 계정에 아직 열리지 않아(#7) 운영 모델로 두 창구를 직접 견줘 본 적은 없습니다. SDK 클라이언트·서명 이름·`anthropic_version` 줄은 설치된 SDK 코드로 확인한 것입니다.

Bedrock SDK는 bedrock-runtime의 차이를 감춰 줍니다(`client.js`, `core/streaming.js`).

- Anthropic Messages API 모양의 요청에서 `model`·`stream`을 빼 경로로 옮기고, `anthropic_version`을 본문에 넣습니다. (2026-11-06 갱신) 넣는 값은 따로 정한 것이 아니라 Anthropic SDK가 붙인 `anthropic-version` 머리글 값을 옮긴 것입니다(`client.js` 189∼200). 본문의 나머지 칸(`thinking`, `output_config.effort`, 최상위 `cache_control`)은 손대지 않고 그대로 보냅니다.
- (2026-11-08 갱신) **그대로 보낸다고 받아 준다는 뜻은 아닙니다.** 특히 최상위 `cache_control`, 곧 이 레포가 쓰는 자동 캐시(8-4절)는 Anthropic 문서가 이 예전 연동의 **지원하지 않는 기능**으로 적고, 명시 브레이크포인트를 쓰라고 합니다(8-8절). 2026-11-06 판은 여기에 "문서상 Bedrock에서도 지원"이라고 썼는데, 그것은 새 끝점에 해당하는 이야기였으므로 바로잡습니다. 이 경로로 Haiku 5.5를 불렀을 때 400이 나는지, 조용히 무시되는지, 받아지는지는 Haiku 5.5가 이 계정에 아직 열리지 않아(#7, 2026-11-05 다시 확인해도 모델 사용 자격 403) 확인하지 못했습니다. 바꾸기 전에 400이 나는지와 2회차 `cached tokens`가 0인지를 봅니다. `pnpm check:llm`은 `LLM_PROVIDER`를 읽지 않고 늘 Anthropic API로 재므로(`scripts/check-llm.ts`) 이 확인에 쓸 수 없습니다. Bedrock 경로로 요청을 보내는 도구는 `pnpm compare:llm`이고, 이것은 400은 보여 주지만 `cached tokens`는 출력하지 않습니다(8-8절). 막히면 길은 둘입니다. 명시 브레이크포인트로 바꾸거나, 새 끝점 클라이언트 `AnthropicBedrockMantle`로 바꾸는 것입니다(8-8절, 제안). 다만 2026-11-05에 본 도쿄 Mantle에는 Haiku 5.5가 없었으므로(위 표), 그 사이 생겼는지도 함께 봅니다.
- 응답의 AWS 이진 이벤트 스트림을 Anthropic API와 같은 SSE로 바꿔 돌려줍니다. 그래서 8-6절의 SSE를 기대하는 플러그인 코드가 그대로 동작합니다.

플러그인의 `client` 옵션에 이 클라이언트 객체를 넘기는 방법("클라이언트만 바꿔 끼우기")과 그 대가(타입 강제 변환)는 8-8절 "응용: 연결만 바꿔 끼우기"에 있습니다.

#### 깊이 보기: bedrock-runtime 응답을 바이트로 읽기 (2026-11-06 추가)

Anthropic API의 스트리밍 응답은 빈 줄로 이벤트를 나누는 SSE 텍스트입니다(8-6절). bedrock-runtime은 `content-type: application/vnd.amazon.eventstream`으로 **길이를 앞에 적은 이진 프레임**을 보냅니다. AWS의 여러 스트리밍 API가 함께 쓰는 "event stream" 인코딩입니다. [lab/16-eventstream.mjs](lab/16-eventstream.mjs)는 SDK가 실제로 쓰는 코덱(`@smithy/eventstream-codec` 2.2.0)으로 Anthropic 이벤트 하나를 담은 프레임을 만들고, 손으로 쪼개고, CRC를 다시 계산하고, 그 바이트를 Bedrock SDK에 먹여 봅니다. 프레임의 머리글 순서와 본문 모양은 SDK의 해석 코드가 받는 모양으로 만든 것이라, 실제 Bedrock 응답의 바이트와 순서까지 같다는 보장은 없습니다.

**프레임 하나의 hexdump.** 담은 것은 `{"type":"content_block_delta",…,"text":"네, 안녕하세요."}`(101바이트)입니다.

```text
0000  00 00 00 ef 00 00 00 4b 2e a8 17 7f 0b 3a 65 76  .......K.....:ev
0010  65 6e 74 2d 74 79 70 65 07 00 05 63 68 75 6e 6b  ent-type...chunk
0020  0d 3a 63 6f 6e 74 65 6e 74 2d 74 79 70 65 07 00  .:content-type..
0030  10 61 70 70 6c 69 63 61 74 69 6f 6e 2f 6a 73 6f  .application/jso
0040  6e 0d 3a 6d 65 73 73 61 67 65 2d 74 79 70 65 07  n.:message-type.
0050  00 05 65 76 65 6e 74 7b 22 62 79 74 65 73 22 3a  ..event{"bytes":
0060  22 65 79 4a 30 65 58 42 6c 49 6a 6f 69 59 32 39  "eyJ0eXBlIjoiY29
…
00e0  61 6c 43 34 69 66 58 30 3d 22 7d 49 fb ff 47     alC4ifX0="}I..G
```

(2026-11-08 추가) hexdump 읽는 법입니다. 맨 왼쪽 네 자리는 그 줄 첫 바이트의 위치(16진수, `0010` = 16번째 바이트), 가운데 16개는 바이트 값(16진수 두 자리씩), 오른쪽은 그 바이트를 글자로 찍은 것입니다. 글자로 찍을 수 없는 바이트는 `.`으로 나옵니다. `…`는 가운데 줄을 줄였다는 표시입니다. 아래 표의 "바이트" 칸은 이 위치를 10진수로 적은 것입니다.

| 바이트 | 칸 | 값 | 읽는 법 |
| --- | --- | --- | --- |
| 0∼3 | 전체 길이 | `00 00 00 ef` = 239 | 큰 끝(big-endian, 큰 자리 바이트를 앞에 둠) 32비트. `0x000000ef` = 239. 이 프레임 전체(이 칸 포함) |
| 4∼7 | 머리글 길이 | `00 00 00 4b` = 75 | 머리글 덩어리의 바이트 수 |
| 8∼11 | 앞부분 CRC32 | `2e a8 17 7f` | 0∼7바이트(두 길이 칸)의 CRC |
| 12∼31 | 머리글 1 | `0b` `:event-type` `07` `00 05` `chunk` | 이름 길이 1B, 이름, 값 종류 1B(7 = 문자열), 값 길이 2B, 값 → 1 + 11 + 1 + 2 + 5 = 20B |
| 32∼64 | 머리글 2 | `:content-type` = `application/json` | 1 + 13 + 1 + 2 + 16 = 33B |
| 65∼86 | 머리글 3 | `:message-type` = `event` | 1 + 13 + 1 + 2 + 5 = 22B |
| 87∼234 | 본문 148B | `{"bytes":"eyJ0eXBl…"}` | Anthropic 이벤트 JSON의 **base64**를 다시 JSON으로 감쌈 |
| 235∼238 | 메시지 CRC32 | `49 fb ff 47` | 0∼234바이트 **전체**의 CRC. 앞부분 CRC 칸도 포함 |

길이 손 계산은 **12(앞부분) + 머리글 + 본문 + 4(메시지 CRC)** 입니다. 12 + 75 + 148 + 4 = 239가 첫 4바이트의 값과 맞습니다. 이 레포의 SDK는 본문에서 `bytes` 칸만 꺼냅니다(`node_modules/@anthropic-ai/bedrock-sdk/AWS_restJson1.js` 198∼205 `de_PayloadPart`). 짧은 글 조각 하나가 101B → base64 136B → JSON 148B → 프레임 239B로 2.4배쯤 커지지만, 한 조각이 수백 바이트라 지연에는 사실상 영향이 없습니다(계산).

**CRC32를 손으로.** CRC-32는 zip·이더넷과 같은 IEEE 판입니다(코덱이 `@aws-crypto/crc32`를 씀). 표 없이 비트 단위로 계산해도 같은 값이 나옵니다.

```js
let crc = 0xffffffff;
for (const byte of bytes) {
  crc ^= byte;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
}
return (crc ^ 0xffffffff) >>> 0;
```

```text
앞부분: 프레임 0x2ea8177f / 손 계산 0x2ea8177f / zlib 0x2ea8177f
메시지: 프레임 0x49fbff47 / 손 계산 0x49fbff47 / zlib 0x49fbff47
CRC32("123456789") = 0xcbf43926 (표준 검사값 0xcbf43926)
```

- **CRC가 둘인 이유(설명).** 받는 쪽은 첫 4바이트의 길이를 믿고 그만큼 기다립니다. 길이 칸이 깨지면 엉뚱한 양을 기다리게 되므로, 앞부분 CRC로 길이부터 확인하고 나머지를 읽습니다. 코덱도 앞부분 CRC를 먼저, 메시지 CRC를 그다음에 확인합니다(`@smithy/eventstream-codec` 2.2.0 `dist-cjs/index.js` 269∼302 `splitMessage`).
- **CRC는 보안 장치가 아닙니다.** 키가 없어서 내용을 바꾼 사람이 CRC도 다시 계산해 넣으면 그만입니다. 실수로 깨진 바이트를 잡을 뿐이고, 일부러 바꾸는 것을 막는 일은 TLS가 합니다. 16-3절의 HMAC(키가 있어야 같은 값을 만듦)과 비교하면 차이가 분명합니다.

**SDK가 SSE로 바꾸는 곳.** 바꿀지는 `client.js`가 응답의 `content-type`이 `application/vnd.amazon.eventstream`을 **포함할 때만** 정하고(253∼262 `adaptResponse`. 일반 JSON·오류 본문·이미 SSE인 응답은 그대로 둠), 바꾸는 일은 `core/streaming.js`의 `eventStreamToSSEResponse`(58∼104)가 합니다.

1. 프레임을 풀어 `chunk` 이벤트의 `bytes`를 꺼내 JSON으로 읽고, 그 안의 `type`을 SSE 이벤트 이름으로 씁니다. JSON은 한 줄이 되도록 다시 직렬화합니다(75∼80). `type`이 없는 프레임(관문의 연결 유지 신호 등)은 버립니다.
2. `event: <type>\ndata: <json>\n\n`을 하나씩 내보냅니다.
3. `exception`·`error` 프레임은 SSE `error` 이벤트로 바꿉니다(84∼90, 110∼122).
4. 응답의 `content-type`을 `text/event-stream; charset=utf-8`로 바꾸고 `content-length`를 지웁니다(92∼94).

실습 4번은 프레임 6개(1,298바이트)를 일부러 **7바이트씩** 잘라서 `fetch` 응답으로 돌려줍니다. 프레임 경계와 상관없이 잘라도 SDK가 내놓는 SSE 원문은 Anthropic API의 것과 같은 모양입니다.

```text
event: message_start
data: {"type":"message_start","message":{"id":"msg_fake",…}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"네, 안녕하세요."}}
…
event: message_stop
data: {"type":"message_stop"}
```

**길이 접두의 이점.** 받는 쪽은 처음 4바이트를 모으면 프레임 길이를 알고, 그만큼 모이는 순간 바로 내보냅니다(`@smithy/eventstream-serde-universal` 2.2.0 `dist-cjs/index.js`의 `getChunkedStream`). SSE처럼 "빈 줄이 왔나"를 찾지 않으므로, 8-6절의 #36(이벤트 끝을 다음 바이트가 올 때까지 붙잡음) 같은 문제가 생길 자리가 없습니다. 바꾼 SSE는 Bedrock SDK 밑의 SDK 1.4가 읽는데, 1.4는 #36이 고쳐진 판입니다(8-6절). 그래서 Bedrock 경로에는 #36의 지연이 없을 것으로 봅니다(코드로 추론).

**깨진 바이트와 오류 프레임(실습 5번).**

```text
비트 하나 뒤집기 → Error: The message checksum (1659860720) did not match the expected value of 3605960512
exception 프레임 → SSE:
  event: error
  data: {"type":"error","error":{"type":"throttlingException","message":"Too many requests, please wait before trying again."}}
SDK 이벤트로 읽으면 → APIError (status undefined): {"type":"error","error":{"type":"throttlingException",…
```

- 본문 비트 하나를 뒤집으면 메시지 CRC가 맞지 않아 평범한 `Error`가 스트림 중간에 던져집니다.
- 서버가 스트림 중간에 보내는 `exception` 프레임(`:message-type: exception`, `:exception-type: throttlingException` 등. SDK가 아는 종류는 `AWS_restJson1.js` 109∼149)은 SSE `error` 이벤트가 되고, SDK 1.4는 이것을 상태 코드 없는 `APIError`로 던집니다.
- 플러그인을 거치면 두 경우 모두 SDK 0.33의 오류 클래스가 아니므로 `APIConnectionError`가 되고, 글이 하나도 나가기 전이면 재시도 대상입니다(16-1절의 #37 경로, 코드로 추론. 플러그인을 거쳐 재현하지는 않음). 8-7절 표에서 Anthropic 경로의 "200 + `error` 이벤트, 글 전"은 재시도하지 않았으므로, **같은 과부하가 스트림 중간에 와도 두 경로가 다르게 반응**하는 셈입니다.

---

## 16-7. GCP 쪽: 서비스 계정과 서비스 에이전트

(2026-11-08 추가) **GCP**(Google Cloud Platform)는 구글의 클라우드이고, **Firebase**는 그 위에 앱 개발용 기능(데이터베이스 Firestore, 함수 실행 등)을 묶은 서비스입니다. Firebase 프로젝트는 곧 GCP 프로젝트이므로, functions-xtool의 함수와 Firestore와 비밀값은 모두 GCP 프로젝트 하나 안에 있습니다. 이 절은 GCP의 권한 단어를 AWS와 견주고, 판정 트리거의 첫 배포 실패로 "구글 서비스가 내 프로젝트에서 쓰는 신원"(서비스 에이전트)이 무엇인지 봅니다. 에이전트 워커가 통화 결과를 보내는 받는 쪽이 여기서 돌기 때문에 이 프로젝트에 필요한 내용입니다.

functions-xtool(통화 결과 저장·판정, 15-6절)은 Firebase, 즉 GCP 프로젝트 위에서 돕니다. GCP의 권한 모델은 AWS와 단어가 다릅니다.

| 개념 | GCP | AWS에 빗대면 |
| --- | --- | --- |
| 경계 | 조직 → 폴더 → **프로젝트** → 자원 (위에서 준 권한이 아래로 상속) | 조직 → 계정 |
| 권한 묶음 | **역할**(role): `roles/…` 권한 목록. 기본·사전 정의·커스텀 | 정책 |
| 권한 주기 | 자원의 허용 정책에 **바인딩**(주체 + 역할) 추가 | 신원에 정책 붙이기 |
| 프로그램의 신원 | **서비스 계정** (`이름@프로젝트.iam.gserviceaccount.com`) | IAM 역할 |
| 구글 서비스가 내 프로젝트에서 쓰는 신원 | **서비스 에이전트** (`service-<프로젝트 번호>@gcp-sa-<서비스>.iam.gserviceaccount.com`) | 서비스 연결 역할 |

(2026-11-08 추가) 표 읽는 법입니다. 왼쪽 칸은 개념, 가운데는 GCP에서 부르는 이름과 생김새, 오른쪽은 AWS에서 하는 일이 가장 가까운 것입니다. 오른쪽은 비슷한 것을 짝지었을 뿐 똑같지는 않습니다. **프로젝트**는 GCP에서 자원·청구·권한을 묶는 기본 단위로, AWS의 계정과 비슷한 자리입니다. GCP에서 권한을 준다는 것은 자원(예: 프로젝트)에 붙은 **허용 정책**(allow policy)에 "이 주체에게 이 역할"이라는 짝(**바인딩**) 한 줄을 더하는 것입니다. 아래 사례의 `gcloud projects add-iam-policy-binding` 명령이 바로 그 한 줄을 더합니다.

AWS와 가장 다른 점은 **"역할"이라는 단어**입니다. AWS의 역할은 맡을 수 있는 신원이고, GCP의 역할은 권한 묶음입니다. GCP에서 AWS 역할에 해당하는 것은 서비스 계정입니다.

(2026-11-06 추가) 표의 오른쪽 칸 **서비스 연결 역할**(service-linked role)은 AWS 서비스가 내 계정 안에서 일하려고 쓰는, 그 서비스에 묶인 미리 정해진 역할입니다. 신뢰 정책이 그 서비스만 맡을 수 있게 고정돼 있고, 사용자가 권한을 마음대로 바꿀 수 없습니다. "구글 서비스가 내 프로젝트에서 쓰는 신원"인 서비스 에이전트와 하는 일이 비슷합니다.

### 사례: 판정 트리거의 첫 배포 실패 (2026-11-03)

`extractVoiceCallJudgment`는 Firestore 문서가 생기면 도는 2세대 함수입니다. 2세대 Firestore 트리거는 **Eventarc**라는 이벤트 전달 서비스를 거칩니다.

(2026-11-06 추가) 세 이름입니다. **Cloud Run**은 컨테이너를 요청이 올 때 띄워 실행하는 구글의 서버리스 실행 환경입니다. **2세대 함수**(Cloud Functions 2nd gen, Firebase Functions v2)는 함수 코드를 구글이 컨테이너로 만들어 Cloud Run 위에서 돌리는 방식이고, 1세대는 별도 실행 환경이었습니다. **Eventarc**는 구글 서비스에서 생긴 사건(Firestore 문서 생성 등)을 받아 정해진 대상(여기서는 Cloud Run 위의 함수)으로 전달하는 서비스입니다. 그 전달을 구글 쪽 신원인 Eventarc 서비스 에이전트가 하므로, 이 신원의 권한이 준비되지 않으면 내 코드와 상관없이 배포가 실패합니다.

```text
Firestore 문서 생성 → Eventarc(서비스 에이전트가 이벤트를 받아 전달) → Cloud Run 위의 함수
```

- 이 프로젝트에서 Eventarc를 처음 쓰는 배포였고, 다른 함수 3개는 배포됐지만 트리거만 실패했습니다. Firebase CLI는 "Eventarc 서비스 에이전트의 권한이 아직 준비되지 않았을 수 있으니 몇 분 뒤 다시 배포하라"는 취지로 안내했습니다.
- 원인은 **서비스 에이전트가 처음 만들어지고 역할을 받는 일이 배포보다 늦게 퍼진 것**입니다. 내 코드나 내 권한 문제가 아니라 구글 쪽 신원의 준비 문제입니다. "늦게 퍼졌다"는, 서비스 에이전트에 역할을 준 변경이 구글 권한 시스템의 모든 곳에 반영되기 전에 배포 과정이 그 권한을 먼저 확인해 "권한 없음"을 받았다는 뜻입니다(16-8절의 최종 일관성).
- 대응은 둘입니다. 몇 분 기다려 그 함수만 다시 배포하거나, 그래도 실패하면 서비스 에이전트에 역할을 직접 줍니다. 아래 명령에서 `<프로젝트 ID>`는 사람이 정한 프로젝트 이름(예: `my-app-1234`)이고, `<프로젝트 번호>`는 구글이 붙인 숫자입니다. 서비스 에이전트의 주소에는 번호가 들어갑니다.

```bash
gcloud projects add-iam-policy-binding <프로젝트 ID> \
  --member="serviceAccount:service-<프로젝트 번호>@gcp-sa-eventarc.iam.gserviceaccount.com" \
  --role="roles/eventarc.serviceAgent"
```

콘솔에서는 IAM 화면에서 "Google 제공 역할 부여 포함"을 체크해야 서비스 에이전트가 보입니다. 평소에는 숨겨 둘 만큼 사용자가 직접 다룰 일이 드문 신원이라는 뜻입니다.

### 비밀값

(2026-11-08 추가) **비밀값**은 알려지면 남이 내 신원으로 요청을 보낼 수 있게 되는 값(키, 토큰, 공유 비밀)입니다. **Secret Manager**는 GCP의 비밀값 보관 서비스입니다. 값을 암호화해 저장하고, 값을 바꿀 때마다 판(version)을 새로 쌓으며, 읽기 역할(`roles/secretmanager.secretAccessor` 등)을 받은 신원만 값을 읽게 합니다.

functions-xtool의 비밀값(`VOICE_AGENT_SECRET`, `ANTHROPIC_API_KEY` 등)은 `defineSecret`으로 선언하고 Secret Manager에 넣습니다([6-web-test.md 6-1](../6-web-test.md)). 여기서 `ANTHROPIC_API_KEY`는 통화가 끝난 뒤 요약·판정을 뽑는 데 쓰는 키입니다. 함수가 그 비밀을 읽으려면 함수의 실행 서비스 계정(함수가 돌 때 쓰는 구글 신원)에 읽기 권한이 있어야 합니다. Firebase CLI가 배포 때 이것을 처리해 주므로 평소에는 보이지 않습니다.

---

## 16-8. 권한 변경은 바로 퍼지지 않는다

(2026-11-08 갱신) 이 절은 권한을 바꾼 직후에 나는 실패를 다룹니다. GCP의 트리거 실패가 그 예이고, AWS에서 양식을 낸 직후 #7을 받았을 때 처음 의심한 것도 이 현상이었습니다. 다만 #7은 기다려도 그대로여서, 결국 전파가 아니라 Haiku 5.5만 따로 막힌 것으로 밝혀졌습니다(16-1절). **권한·신원 시스템은 여러 리전에 복제된 분산 시스템이고, 변경은 "결국에는" 모든 곳에 반영됩니다**(최종 일관성, eventual consistency). 방금 준 권한이 다음 요청에서 바로 보인다는 보장이 없습니다. 예를 들어 정책을 붙이고 1초 뒤에 보낸 요청은 아직 새 정책을 모르는 서버가 받아 거절할 수 있고, 같은 요청을 몇 초에서 몇 분 뒤에 보내면 통과합니다. AWS IAM 문서도 변경이 모든 곳에 퍼지는 데 시간이 걸린다고 적습니다.

| 변경 | 전파에 걸린 시간 |
| --- | --- |
| AWS 서버리스 모델의 첫 호출 자동 구독 | 최대 15분 (AWS 문서) |
| Anthropic 사용 양식 제출 → 작업 계정에서 호출 | 13:20 제출, 13:36에는 Haiku 4.5·Sonnet 4.6이 응답 (이전 상태는 확인 못 함). Haiku 5.5는 양식과 별개로 막힘 (16-6절) |
| GCP Eventarc 서비스 에이전트 준비 | 몇 분 (Firebase 안내) |

(2026-11-08 추가) 표 읽는 법입니다. 왼쪽은 무엇을 바꿨는지, 오른쪽은 그 변경이 실제 요청에 보이기까지 걸린 시간과 그 근거(문서, 안내, 실측 시각)입니다.

여기서 나오는 작업 원칙은 넷입니다.

- **변경 직후의 실패 한 번으로 결론을 내지 않습니다.** 같은 요청을 간격을 두고 다시 보내 봅니다. 다른 작업이 45초마다 다시 부른 것이 이 방식입니다.
- **기다림에는 끝을 정합니다.** 문서에 적힌 전파 시간(예: 15분)을 넘겨도 그대로면 전파가 아니라 다른 원인을 의심하고, 조건을 하나만 바꾼 비교로 층을 다시 가릅니다. #7에서 모델만 바꿔 본 것이 그 예입니다(16-1절).
- **다시 시도할 때는 무엇이 바뀌었는지 응답 본문을 비교합니다.** 403의 문구가 #4에서 #5로 바뀐 것처럼, 같은 숫자 안에서 층이 넘어가는 것이 진전입니다.
- **배포 자동화에는 재시도를 넣습니다.** 사람이 기다렸다 다시 누르는 일을 스크립트가 지수 백오프로 대신합니다. (2026-11-06 추가) **지수 백오프**는 실패할 때마다 기다림을 두 배씩 늘리는 재시도 방식이고(예: 0.5초, 1초, 2초, … 상한까지), **지터**는 그 기다림에 작은 무작위 값을 섞는 것입니다. 지터가 없으면 같은 때 실패한 많은 클라이언트가 같은 박자로 다시 보내, 회복하던 서버에 요청이 또 한꺼번에 몰립니다. Bedrock SDK 밑의 Anthropic SDK 1.4는 0.5초 × 2^n(최대 8초)에 최대 25%를 줄이는 지터를 씁니다(`@anthropic-ai/sdk` 1.4.0 `client.js` 905∼914). 오디오의 지터(도착 간격의 흔들림, 2장)와 같은 단어이지만 다른 뜻입니다.

---

## 16-9. 운영에서 자격 증명 다루기

(2026-11-08 추가) 이 절은 개발을 마치고 워커를 실제로 돌릴 때 비밀값(키·토큰·공유 비밀)을 어디에 두는지, 오래 사는 키를 어떻게 줄이는지, 새었을 때 무엇을 하는지 다룹니다. 이 레포는 공급사 키 셋(Anthropic·ElevenLabs·Soniox)과 AWS 키, 결과 전송용 공유 비밀을 쓰므로, 실행 환경이 바뀔 때마다 이 값들이 어디로 가는지 알아야 합니다.

### 키가 사는 곳

| 비밀값 | 로컬 | LiveKit Cloud 배포 | GKE 배포 (예정) | functions-xtool |
| --- | --- | --- | --- | --- |
| Anthropic·ElevenLabs·Soniox 키 | `.env.local` | 비밀값 저장소 (`--secrets-file`, 15-5절) | Kubernetes Secret | `ANTHROPIC_API_KEY`만 Secret Manager(통화 뒤 요약·판정 추출용). ElevenLabs·Soniox 키는 쓰지 않음 |
| AWS (Bedrock) | `.env.local` | 비밀값 저장소 | Secret, 또는 키 없이 연동 (아래) | 쓰지 않음 |
| `VOICE_AGENT_SECRET` | `.env.local` | 비밀값 저장소 | Secret | Secret Manager |
| `LIVEKIT_URL`·`LIVEKIT_API_KEY`·`LIVEKIT_API_SECRET` (2026-11-08 추가) | `.env.local` | LiveKit Cloud가 자동으로 넣음. 직접 넣지 않음(LiveKit 문서 "Secrets management") | Secret | Secret Manager(웹 테스트의 접속 토큰 발급용, [6-web-test.md](../6-web-test.md)) |

(2026-11-08 추가) 표 읽는 법입니다. 줄은 비밀값, 칸은 그 비밀값을 넣어 두는 실행 환경입니다. "비밀값 저장소"는 LiveKit Cloud가 배포한 워커 컨테이너에 환경변수로 넣어 주는 저장소이고(15-5절), "Kubernetes Secret"(줄여서 Secret)은 쿠버네티스가 파드(컨테이너를 띄우는 단위, 15-5절)에 환경변수나 파일로 넣어 주는 비밀값 객체입니다. "쓰지 않음"은 그 환경의 코드가 그 값을 쓰지 않는다는 뜻입니다. functions-xtool 칸은 originalshq의 `functions-xtool/src/app.ts`에 선언된 `defineSecret` 목록으로 확인했습니다.

### 장기 키를 줄이는 길

IAM 사용자 액세스 키는 지울 때까지 사는 장기 자격 증명이라, 새면 피해가 시간으로 제한되지 않습니다. 워커를 어디서 돌리느냐에 따라 대안이 다릅니다.

- **LiveKit Cloud에 올리면:** 비밀값을 환경변수로만 넘길 수 있어 IAM 사용자 키가 현실적인 선택입니다. 위험은 이렇게 줄입니다.
  - 16-5절의 좁은 정책
  - 키 교체 주기
  - 예산 알림
  - 다만 LiveKit Cloud 에이전트 리전(미국·유럽·뭄바이)에서는 도쿄 Bedrock의 이점이 줄어듭니다(13-5절).
- **GKE 서울에 올리면:** 키 없이 연동하는 방법이 있습니다(**워크로드 아이덴티티 연동**). GKE는 구글이 운영해 주는 쿠버네티스입니다(15-5절). **워크로드 아이덴티티 연동**(workload identity federation)은 워커가 이미 가진 다른 곳의 신원 증명(여기서는 구글이 서명한 ID 토큰)을 AWS STS에 내고, 그 대가로 AWS 역할의 임시 자격 증명을 받는 방식입니다. 오래 사는 AWS 키를 어디에도 저장하지 않습니다. 순서는 아래 넷입니다. (2026-11-06 갱신) 지난 판은 1단계(토큰을 받음)에서 3단계(체인이 자동 처리)로 바로 건너뛰었는데, 둘 사이에 빠진 고리가 있어 고쳤습니다.
  1. 파드가 **구글이 서명한 ID 토큰**을 받습니다. 메타데이터 서버의 `identity` 엔드포인트에 받을 쪽(`audience=sts.amazonaws.com` 등)을 적어 요청하면 JWT 문자열이 **응답 본문으로** 옵니다. 파일이 저절로 생기지는 않습니다.
  2. AWS STS의 `AssumeRoleWithWebIdentity`에 그 토큰과 역할 ARN을 내고 AWS 역할의 **임시 자격 증명**을 받습니다. 이 호출은 서명하지 않습니다. 토큰 자체가 증명입니다.
  3. 16-4절 체인의 "웹 ID 토큰" 단계(`fromTokenFile`)는 **`AWS_WEB_IDENTITY_TOKEN_FILE`이 가리키는 파일**과 `AWS_ROLE_ARN`을 읽어 2단계를 대신합니다(`@aws-sdk/credential-provider-web-identity` `dist-cjs/index.js` 34∼56). 그러니 체인이 자동으로 처리하게 하려면 1단계의 토큰을 **파일로 써 주는 장치**가 하나 더 있어야 합니다. 방법은 아래 깊이 보기에 셋 있습니다.
  4. 장기 키가 아예 없으므로 샐 것도 없습니다. 대신 16-4절 깊이 보기의 "요청마다 STS를 부르는" 문제를 함께 풀어야 합니다.

  선택지로만 조사했고, 구현은 하지 않았습니다(확인 필요).

#### 깊이 보기: 워크로드 아이덴티티 연동의 실제 (2026-11-06 추가)

**이름 정리.** GKE의 기능 이름 "Workload Identity Federation for GKE"는 파드가 **구글** API를 부를 때 쿠버네티스 신원을 구글 신원으로 잇는 장치입니다. 여기서 하려는 일은 그렇게 얻은 구글 신원을 한 번 더 **AWS** 역할에 잇는 것이라, 연동이 두 단계 이어진 모양입니다.

**OIDC, ID 토큰, audience.** OIDC(OpenID Connect)는 "이 토큰의 주인이 누구인지"를 JWT로 증명하는 표준입니다. 발급자(issuer)가 서명한 그 JWT를 **ID 토큰**이라 하고, 받는 쪽은 발급자가 공개한 공개 키 목록(JWKS)으로 서명을 확인합니다. 3-7절의 LiveKit 토큰은 HS256(같은 비밀을 양쪽이 나눠 가짐)이었지만, 구글 ID 토큰은 RS256(구글만 개인 키를 갖고 누구나 공개 키로 확인)이라 AWS와 구글이 비밀을 나눠 가질 필요가 없습니다. **audience**(`aud`)는 "이 토큰을 누구에게 내라고 만들었나"입니다. 받는 쪽이 자기 이름이 아닌 토큰을 거절해야, 다른 서비스에 내려고 받은 토큰을 누가 손에 넣어 STS 요청의 `WebIdentityToken` 칸에 넣어 보내도 통하지 않습니다.

**토큰의 모양.** 메타데이터 서버에 `GET http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=sts.amazonaws.com&format=full`(머리글 `Metadata-Flavor: Google`)을 보내면 JWT 문자열이 옵니다. 3-7절처럼 가운데 부분을 base64url로 풀면 대략 이런 모양입니다(구글 문서와 흔히 보이는 모양을 따른 예이고, 이 프로젝트에서 받아 본 토큰이 아닙니다. 값은 지어냄).

```json
{
  "iss": "https://accounts.google.com",
  "aud": "sts.amazonaws.com",
  "azp": "100000000000000000001",
  "sub": "100000000000000000001",
  "email": "voice-agent@<프로젝트 ID>.iam.gserviceaccount.com",
  "email_verified": true,
  "iat": 1793905200,
  "exp": 1793908800
}
```

| 칸 | 뜻 | AWS 신뢰 정책에서 |
| --- | --- | --- |
| `iss` | 발급자, 구글 | `"Principal": { "Federated": "accounts.google.com" }`. IAM 문서의 예시는 구글을 이 이름으로 바로 씀 |
| `aud` | 1단계에서 적은 audience | `azp`가 있으면 조건 키 `accounts.google.com:oaud`가 이 값 |
| `azp` | 토큰을 받은 쪽(서비스 계정)의 고유 ID, 21자리 숫자 | `azp`가 있으면 조건 키 `accounts.google.com:aud`가 **이 값**(IAM 문서). 이름은 aud인데 비교 대상은 azp라 헷갈리기 쉬움 |
| `sub` | 서비스 계정의 고유 ID | `accounts.google.com:sub` |
| `exp − iat` | 3,600초 | 토큰은 1시간짜리. 파일로 써 주는 장치는 그 안에 갱신해야 함 |

서비스 계정이 받은 토큰에 `azp`가 늘 있는지는 확인하지 못했습니다. `azp`가 없으면 `accounts.google.com:aud`와 `oaud`가 둘 다 `aud` 값이 되므로(IAM 문서), 조건 값은 실제 토큰을 한 번 풀어 보고 정합니다.

**신뢰 정책.** 위 토큰을 낸 그 서비스 계정만 이 역할을 맡게 하는 모양입니다(예시, 적용하지 않음).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "accounts.google.com" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "accounts.google.com:aud": "<서비스 계정 고유 ID>",
          "accounts.google.com:oaud": "sts.amazonaws.com",
          "accounts.google.com:sub": "<서비스 계정 고유 ID>"
        }
      }
    }
  ]
}
```

조건을 빼면 구글 계정을 가진 누구나 이 역할을 맡을 수 있습니다(16-5절 깊이 보기의 마지막 줄). 이 역할의 **권한**(신원 기반 정책)에는 16-5절의 최소 권한 정책을 붙입니다.

**`AssumeRoleWithWebIdentity`의 요청과 응답.** [lab/16-credential-chain.mjs](lab/16-credential-chain.mjs) 2번의 가짜 STS가 받은 요청과, AWS STS 문서의 응답 모양을 따라 돌려준 값입니다.

```text
POST /   (content-type: application/x-www-form-urlencoded, Authorization 머리글 없음)
Action=AssumeRoleWithWebIdentity&Version=2011-06-15&RoleArn=arn:aws:iam::123456789012:role/gke-bedrock-role&RoleSessionName=voice-agent-pod&WebIdentityToken=<토큰 파일 내용>
```

```xml
<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <SubjectFromWebIdentityToken>100000000000000000001</SubjectFromWebIdentityToken>
    <Audience>sts.amazonaws.com</Audience>
    <Provider>accounts.google.com</Provider>
    <AssumedRoleUser>
      <Arn>arn:aws:sts::123456789012:assumed-role/gke-bedrock-role/voice-agent-pod</Arn>
      <AssumedRoleId>AROAEXAMPLEEXAMPLE001:voice-agent-pod</AssumedRoleId>
    </AssumedRoleUser>
    <Credentials>
      <AccessKeyId>ASIAEXAMPLEEXAMPLE00</AccessKeyId>
      <SecretAccessKey>…</SecretAccessKey>
      <SessionToken>…</SessionToken>
      <Expiration>…</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>
```

- 받은 `ASIA…` 키·비밀 키·세션 토큰은 16-3절 표의 "STS 임시 자격 증명"입니다. 워커는 이것으로 Bedrock 요청을 SigV4 서명하고, 세션 토큰은 `x-amz-security-token` 머리글로 실어 함께 서명합니다(`@smithy/signature-v4` `signRequest`가 서명 전에 이 머리글을 넣음).
- 그 뒤의 거절 메시지에서 "누가"는 `assumed-role/gke-bedrock-role/voice-agent-pod`로 찍힙니다. 16-1절의 콘솔 역할 세션과 같은 모양입니다.

**토큰을 파일로 만드는 세 가지 방법**(조사, 구현하지 않음).

| 방법 | 하는 일 | 확인 수준 |
| --- | --- | --- |
| (가) 코드에서 직접 | 메타데이터 서버에서 ID 토큰을 받아 `fromWebToken({ roleArn, webIdentityToken })`(같은 패키지)을 부르는 공급자를 만들고, 16-4절처럼 한 번만 만들어 기억하게 해서 `providerChainResolver`로 넘김. 파일이 필요 없음 | SDK 쪽 함수는 코드로 확인. 토큰이 1시간 뒤 바뀌므로 자격 증명을 새로 받을 때마다 토큰도 새로 받아야 함 |
| (나) 토큰을 파일로 써 주는 곁 컨테이너 | 같은 파드의 작은 컨테이너가 ID 토큰을 받아 공유 볼륨의 파일에 쓰고 1시간 안에 갱신. 워커에는 `AWS_WEB_IDENTITY_TOKEN_FILE`·`AWS_ROLE_ARN`만 줌 | 체인이 파일을 부를 때마다 다시 읽으므로 갱신을 따라감(코드로 확인). 곁 컨테이너는 직접 만들어야 함 |
| (다) 쿠버네티스 서비스 계정 토큰 + 클러스터 발급자 등록 | 쿠버네티스가 파드에 파일로 넣고 스스로 갱신하는 **투영된 서비스 계정 토큰**(projected service account token, audience를 `sts.amazonaws.com`으로 지정)을 쓰고, 클러스터의 OIDC 발급자를 AWS IAM에 OIDC 공급자로 등록. EKS(AWS가 운영하는 쿠버네티스)의 IRSA(IAM Roles for Service Accounts, 파드의 쿠버네티스 서비스 계정에 AWS 역할을 잇는 방식)와 같은 모양이라 체인이 그대로 처리 | 토큰의 `sub`는 `system:serviceaccount:<네임스페이스>:<이름>` 모양. GKE 클러스터 발급자의 공개 키를 AWS가 조회할 수 있는지는 확인 필요 |

(가)와 (나)는 GKE 메타데이터 서버가 파드에 구글 ID 토큰을 내줘야 성립합니다. 쿠버네티스 서비스 계정을 IAM 서비스 계정에 연결해 두는 설정이 필요한 것으로 보이며, 연결 없이도 되는지는 문서에서 확인하지 못했습니다(확인 필요).

### 키 위생

(2026-11-08 추가) **키 위생**은 키가 새지 않게 하고, 새더라도 피해가 작게 끝나도록 키를 다루는 습관입니다.

- 키 값은 대화, 스크린샷, 이슈에 붙이지 않습니다. 이번에 시드니 단기 키 일부가 스크린샷에 찍혔지만, 서명이 키 뒷부분에 있고 12시간 안에 만료되는 키라 위험이 낮았습니다. 장기 키였다면 바로 비활성화하고 새로 만들었어야 합니다. (2026-11-06 추가) 16-3절 깊이 보기에서 푼 순서대로, base64는 원문을 앞에서부터 차례로 바꾸므로 토큰 앞부분은 원문의 `bedrock.amazonaws.com/?Action=…&X-Amz-Algorithm=…&X-Amz-Credential=<키 ID>/<날짜>/<리전>…`에 해당합니다. 쓰는 데 필요한 세션 토큰과 서명은 그 뒤에 있습니다. 다만 키 ID와 날짜·리전은 보였을 수 있습니다.
- 키가 새면 순서는 **비활성화 → 새 키 발급·교체 → 옛 키 삭제**입니다. 먼저 지우면 운영이 멈춥니다. (2026-11-08 추가) Bedrock 단기 API 키는 AWS에 저장된 객체가 아니라 계산으로 만든 문자열이라(16-3절 깊이 보기) 지울 대상이 없습니다. AWS 문서("API keys"의 Compromised keys)는 그 키를 만든 세션을 무효로 하거나, `bedrock:CallWithBearerToken`을 거부하는 정책을 붙이라고 합니다. 장기 API 키는 IAM 사용자에 딸린 자격 증명이라 액세스 키처럼 비활성화·재설정·삭제합니다.
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
Bedrock   Anthropic 첫 사용 양식(관리 계정에서 한 번), jp.(일본 안)·global.(어디든)
          runtime(InvokeModel, 예전 연동, 이 레포, 자동 캐시는 문서상 미지원) vs Mantle(새 끝점)
GCP       역할 = 권한 묶음, 서비스 계정 = 프로그램 신원, 서비스 에이전트 = 구글 서비스의 신원
운영      최소 권한, 장기 키 줄이기(연동), 쓰지 않는 키 지우기, 예산 알림, 변경 뒤에는 재시도

서명 실물  정규 요청 19줄(서명 머리글 13개, user-agent 빠짐) → 서명할 문자열 4줄 → HMAC 네 번의 키 사슬 → 서명
          범위 날짜는 UTC(한국 오전 9시 전은 어제), 서비스 이름은 bedrock, 경로는 한 번 더 인코딩(콜론 → %3A)
          시각 창 약 5분. 창 안의 재전송은 서명만으로는 못 막음. retry-count가 서명돼 재시도마다 새 서명
API 키    bedrock-api-key- + base64(미리 서명한 주소). 리전은 범위에만, 만료 12시간, 세션 토큰이 실림, 만들기는 계산뿐
체인 실물  AWS_PROFILE이면 Node 기본 체인은 환경변수를 건너뜀(Bedrock SDK는 fromEnv를 앞에 둬 뒤집음)
          체인을 요청마다 새로 만듦 → STS·IMDS로 바꾸면 매 요청 왕복. 한 번 만들어 providerChainResolver로
평가 실물  (주체, 동작, 자원, 조건) → 거부 → SCP(층마다) → 자원 기반·신뢰 정책 → 신원 → 경계 → 세션. 교집합
응답 바이트 event-stream: 12B(길이·길이·CRC) + 머리글 + {"bytes":base64} + CRC. SDK가 SSE로 바꿈. CRC는 보안 장치 아님
연동 실물  구글 ID 토큰(iss·aud·azp·sub, 1시간) → 신뢰 정책 조건 → AssumeRoleWithWebIdentity. 체인은 토큰 "파일"을 읽음
```

(2026-11-06 갱신) 위 블록에서 빈 줄 아래의 여섯 항목(서명 실물∼연동 실물)은 이번에 더한 깊이 보기의 요약입니다.

(2026-11-08 추가) 블록 읽는 법입니다. 왼쪽 열은 주제, 오른쪽은 그 주제의 요점입니다. `→`는 차례(먼저 → 나중), `/`는 나란히 놓은 종류, `>`는 이기는 쪽, `vs`는 견주는 두 선택지입니다. 첫 줄의 "층"은 16-1절 표의 걸린 층을 거절을 만난 차례대로 늘어놓은 것입니다.

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
10. (2026-11-06 추가, 손 계산) 한국 시각 2026-11-06 08:59:59에 도쿄 bedrock-runtime으로 가는 요청을 서명합니다. (가) 범위 문자열을 쓰세요. (나) 키 사슬 네 단계의 HMAC 키와 데이터를 순서대로 쓰세요. (다) 같은 시각에 SDK 재시도로 한 번 더 나가는 요청은 왜 서명이 달라집니까? 1초 뒤에 나간다면 무엇이 더 바뀝니까?
11. (2026-11-06 추가) 단기 API 키를 base64로 풀었더니 `X-Amz-Credential=ASIA…/20261105/ap-southeast-2/bedrock/aws4_request`, `X-Amz-Date=20261105T040000Z`, `X-Amz-Expires=43200`, `X-Amz-Security-Token=…`이 있었습니다. (가) 한국 시각으로 언제까지 쓸 수 있고, 그보다 일찍 쓸모없어지는 경우는 언제입니까? (나) 이 키가 도쿄에서 거절된 이유를 이 칸들로 설명하세요. (다) 조직이 이 키의 "생성"을 막을 수 없는 이유는 무엇입니까?
12. (2026-11-06 추가, 손 계산) event-stream 프레임에 머리글 `:event-type`=`chunk`, `:content-type`=`application/json`, `:message-type`=`event`가 있고 본문이 200바이트입니다. (가) 머리글 길이 칸과 전체 길이 칸의 값은 얼마입니까? (나) 앞부분 CRC와 메시지 CRC는 각각 몇 번째 바이트부터 몇 번째까지의 CRC입니까? (다) 본문의 비트 하나가 깨지면 어느 CRC가 잡습니까? 누가 일부러 본문을 바꾸고 CRC를 다시 계산해 넣으면 무엇이 막아 줍니까?
13. (2026-11-06 추가) GKE로 옮기며 세 가지를 바꿨습니다. (가) 16-5절의 운영 정책에 권한 경계(`bedrock:Invoke*`, 자원 `arn:aws:bedrock:ap-northeast-1:*`)를 더했더니 `jp.` 호출이 가끔만 실패합니다. 평가 순서로 이유를 설명하세요. (나) 연동 역할의 신뢰 정책에서 `Condition`을 빼면 어떤 일이 생깁니까? (다) 연동으로 바꾼 뒤 매 턴 첫 토큰이 수십 ms 늦어졌습니다. 무엇을 의심하고 어떻게 고칩니까?
14. (2026-11-08 추가) Haiku 5.5가 열려 `LLM_PROVIDER=bedrock`으로 바꾸려 합니다. (가) 이 레포의 Bedrock 클라이언트는 Anthropic 문서의 어느 연동이고, 그 연동에서 자동 캐시(최상위 `cache_control`)는 문서상 어떻게 적혀 있습니까? (나) 바꾸기 전에 무엇을 돌려 무엇을 봅니까? (다) 막혔을 때의 두 길과, 그중 새 끝점 쪽의 걸림돌은 무엇입니까?
15. (2026-11-08 추가) 16-5절 깊이 보기에서 "운영 정책, `global.` 프로필"은 기본 거부, #4는 명시적 거부였습니다. 각각 어떻게 하면 통과시킬 수 있습니까? 둘의 고치는 방법이 다른 이유를 평가 순서로 설명하세요.

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
10. (가) 한국 08:59:59는 UTC 2026-11-05 23:59:59이므로 `20261105/ap-northeast-1/bedrock/aws4_request`입니다. 서비스 칸은 호스트의 `bedrock-runtime`이 아니라 `bedrock`입니다. (나) kDate = HMAC("AWS4" + 비밀 키, "20261105") → kRegion = HMAC(kDate, "ap-northeast-1") → kService = HMAC(kRegion, "bedrock") → kSigning = HMAC(kService, "aws4_request"), 그리고 서명 = HMAC(kSigning, 서명할 문자열)의 hex입니다. (다) `x-stainless-retry-count`(0 → 1)가 서명된 머리글이라 정규 요청이 달라지고, 그 해시가 서명할 문자열의 넷째 줄이므로 서명이 달라집니다. 1초 뒤(한국 09:00:00, UTC 11-06 00:00:00)면 `x-amz-date`와 범위 날짜(`20261106`)까지 바뀌어 kDate부터 다시 계산됩니다.
11. (가) 04:00Z + 43,200초 = 16:00Z, 한국 2026-11-06 01:00까지입니다. 세션 토큰이 실려 있으므로, 키를 만든 콘솔 역할 세션의 임시 자격 증명이 그보다 먼저 끝나면 그때 쓸모없어집니다(생성기 주석: 요청한 만료와 자격 증명 만료 중 짧은 쪽). (나) 토큰의 호스트 `bedrock.amazonaws.com`에는 리전이 없고, 리전은 서명 범위의 `ap-southeast-2`에만 있습니다. 도쿄 창구는 범위의 리전이 자기 리전과 달라 인증에서 거절합니다(#2). (다) 토큰은 비밀 키로 하는 HMAC 계산(미리 서명)만으로 만들어지고 AWS에 아무것도 묻지 않습니다. AWS가 끼어들 수 있는 때는 그 토큰을 쓸 때(`bedrock:CallWithBearerToken`)뿐입니다.
12. (가) 머리글 하나 = 이름 길이 1 + 이름 + 값 종류 1 + 값 길이 2 + 값입니다. (1 + 11 + 1 + 2 + 5) + (1 + 13 + 1 + 2 + 16) + (1 + 13 + 1 + 2 + 5) = 20 + 33 + 22 = 75. 전체 = 12 + 75 + 200 + 4 = 291입니다. (나) 앞부분 CRC는 0∼7바이트(두 길이 칸), 메시지 CRC는 0∼286바이트(마지막 4바이트를 뺀 전부, 앞부분 CRC 칸 포함)의 CRC입니다. (다) 메시지 CRC가 잡습니다(앞부분 CRC는 길이 칸만 덮음). CRC에는 키가 없어 바꾼 사람이 다시 계산해 넣으면 통과하므로, 일부러 바꾸는 것은 TLS가 막습니다.
13. (가) `jp.` 프로필은 도쿄·오사카 중 AWS가 고른 리전의 기본 모델로 요청을 보냅니다. 오사카로 간 요청의 자원은 `ap-northeast-3` 기본 모델 ARN이라, 신원 기반 정책은 허용하지만(16-5절 깊이 보기 표의 4단계) 권한 경계에 맞는 허용이 없어(5단계) 기본 거부됩니다. 최종 권한은 교집합이고, 어느 리전으로 갈지가 요청마다 달라 "가끔" 실패합니다. (나) 구글 계정을 가진 누구의 ID 토큰이든, 어느 프로젝트의 서비스 계정이든 이 역할을 맡을 수 있게 됩니다. `accounts.google.com:aud`(azp)·`sub`로 우리 서비스 계정 하나만 허용해야 합니다. (다) Bedrock SDK가 요청마다 자격 증명 체인을 새로 만들어, 웹 ID 토큰 방식에서는 매 요청 STS를 부릅니다(16-4절 깊이 보기, 가짜 STS 실측으로 요청마다 한 번). 체인을 워커에서 한 번만 만들어 `providerChainResolver`로 넘기면 만료 5분 전까지 같은 자격 증명을 다시 씁니다.
14. (가) `createBedrockClient()`는 `AnthropicBedrock`이라 `bedrock-runtime`의 InvokeModel, 곧 Anthropic 문서가 "예전 연동"이라 부르는 쪽입니다(경로 `/model/…/invoke-with-response-stream`). 문서는 이 연동이 지원하지 않는 기능으로 최상위 `cache_control`을 적고, 명시 브레이크포인트를 쓰라고 합니다. (나) Bedrock 경로로 요청을 두 번 보내 400 설정 거절이 나는지, 2회차 요청의 `cached tokens`가 0인지 봅니다. `pnpm check:llm`은 `LLM_PROVIDER`를 읽지 않아 쓸 수 없고, `pnpm compare:llm`은 400만 보여 주므로 캐시까지 보려면 check-llm이 설정을 읽도록 고쳐야 합니다. 0이면 캐시가 돌지 않아 매 턴 지시문 전체를 다시 프리필하고 입력 요금도 기본 단가를 냅니다(8-4절, 13-5절). (다) 명시 브레이크포인트로 바꾸거나, 새 끝점 클라이언트 `AnthropicBedrockMantle`로 바꿉니다. 새 끝점은 2026-11-05에 본 도쿄 목록에 Haiku 5.5가 없었으므로, 그 사이 생겼는지부터 확인해야 합니다.
15. `global.` 줄은 명시적 거부가 없고 SCP도 허용하지만, 신원 기반 정책에 그 자원(`global.` 프로필 ARN)에 맞는 Allow가 없어 4단계에서 기본 거부됐습니다. 운영 정책에 그 프로필 ARN과 프로필이 보낼 수 있는 리전의 기본 모델 ARN을 허용하는 문장을 더하면 통과합니다. #4는 SCP의 Deny 문장이 맞아 1단계(본문 블록으로는 2단계)에서 끝났습니다. 명시적 거부는 뒤의 어떤 허용보다 먼저 판단되므로, 허용을 더해서는 풀리지 않습니다. SCP의 그 문장을 관리 계정에서 고치거나, 그 동작을 쓰지 않는 길(IAM 액세스 키의 SigV4 서명)로 바꿔야 합니다. 이번에는 뒤의 길을 택했습니다.

</details>
