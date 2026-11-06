# 3장. 소리를 실어 나르기 — WebRTC, LiveKit, 전화망(SIP)

2장에서 소리가 숫자 배열(프레임)이 되는 과정을 봤습니다. 이 장은 그 프레임이 **고객과 에이전트 사이를 어떻게 오가는지**를 다룹니다. 브라우저 PoC에서는 WebRTC가, 실제 서비스에서는 전화망(SIP)이 앞단에 붙습니다. 두 세계가 LiveKit의 "방(Room)"에서 만납니다.

(2026-11-05 추가) 절마다 붙은 **"깊이 보기"** 하위 절은 패킷과 메시지의 실물(헤더 비트, SDP·후보 줄, STUN 바이트, SIP 원문, JWT 내용)을 손으로 풀어 봅니다. 처음 읽을 때는 건너뛰어도 흐름을 따라가는 데 지장이 없습니다. 손 계산은 [lab/](lab/)의 `03-*.mjs` 스크립트로 직접 돌려 볼 수 있습니다. 레포 루트에서 `node docs/1-study/lab/03-<이름>.mjs`로 실행하며, API 키나 네트워크가 필요 없습니다.

---

## 3-1. 실시간 음성 전송의 조건

일반 웹 요청(HTTP)과 실시간 음성은 요구 조건이 정반대입니다.

| | 웹 요청 / 파일 전송 | 실시간 음성 |
| --- | --- | --- |
| 가장 중요한 것 | **빠짐없이** 도착 | **제때** 도착 |
| 늦게 온 데이터 | 기다렸다가 씀 | **쓸모없음** (이미 재생 시점이 지남) |
| 잃어버린 데이터 | 다시 보냄 | 다시 보내 봐야 늦음 → 메꾸고 넘어감 |
| 적합한 전송 계층 | TCP | **UDP** |

### 왜 TCP가 아니라 UDP인가

TCP는 순서와 완전성을 보장합니다. 패킷 하나가 사라지면 **그 패킷이 다시 올 때까지 뒤 패킷을 모두 붙잡아 둡니다**(Head-of-Line Blocking). 파일에는 좋지만 음성에는 치명적입니다. 20ms 조각 하나 때문에 그 뒤의 0.5초가 멈추기 때문입니다.

UDP는 보내고 끝입니다. 순서도, 도착도 보장하지 않습니다. 대신 기다리게 하지 않습니다. 음성 전송은 UDP 위에 **RTP**를 올려 필요한 정보만 덧붙입니다.

(2026-11-05 추가) 단, "음성은 UDP"는 **UDP가 통할 때**의 이야기입니다. 회사 방화벽이나 VPN처럼 UDP를 막는 네트워크에서는 WebRTC가 TCP(ICE/TCP)나 TLS 443(TURN/TLS)으로 내려갑니다. 이때는 RTP 패킷이 TCP 스트림 안에 실려 가므로 위의 Head-of-Line 차단이 그대로 돌아옵니다. 연결은 되지만 소리가 뭉쳐 오고 지연이 늘어납니다(3-2절 "깊이 보기: UDP가 막혔을 때").

### RTP와 RTCP

- **RTP(Real-time Transport Protocol, RFC 3550)**: 패킷마다 순서 번호, 타임스탬프, 코덱 종류(payload type)를 붙입니다. 받는 쪽은 이걸로 순서를 맞추고 지터 버퍼(2-6절)를 운영합니다.
- **RTCP**: RTP와 짝을 이루는 제어 채널입니다. "패킷 몇 % 잃었다", "지연이 얼마다" 같은 통계를 주고받아 보내는 쪽이 비트레이트를 조절하게 합니다.
- **SRTP**: RTP를 암호화한 것입니다. WebRTC는 SRTP를 필수로 씁니다. 전화망은 상품에 따라 다릅니다([7-telephony-setup.md 3-2](../7-telephony-setup.md#3-2-있으면-좋은-것)).

#### 깊이 보기: RTP 패킷 한 개를 비트로 읽기 (2026-11-05 추가)

RTP 패킷은 **12바이트 고정 헤더 + 코덱이 만든 바이트(페이로드)**입니다. RFC 3550 5.1절의 그림을 그대로 옮기면 다음과 같습니다. 맨 윗줄 숫자는 비트 번호이고, 한 줄이 32비트(4바이트)입니다. 모든 값은 네트워크 바이트 순서(빅 엔디언, 큰 자리가 앞)로 적습니다.

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|V=2|P|X|  CC   |M|     PT      |       sequence number         |   ← 바이트 0~3
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                           timestamp                           |   ← 바이트 4~7
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|           synchronization source (SSRC) identifier            |   ← 바이트 8~11
+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
|            contributing source (CSRC) identifiers             |   ← CC개 (보통 0개)
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  페이로드 (Opus·G.711 바이트, 길이는 패킷마다 다름) …
```

| 칸 | 비트 | 뜻 |
| --- | --- | --- |
| V (version) | 2 | 항상 2 |
| P (padding) | 1 | 끝에 채움 바이트가 붙었나 |
| X (extension) | 1 | 고정 헤더 뒤에 헤더 확장이 붙었나. WebRTC는 오디오 레벨·혼잡 제어용 확장을 SDP의 `a=extmap` 줄로 합의해 붙이므로 대개 1 |
| CC (CSRC count) | 4 | 뒤에 붙는 CSRC 개수. 여러 소리를 **섞은** 장비(믹서)가 원래 출처들을 적는 칸. SFU는 섞지 않으므로 보통 0 |
| M (marker) | 1 | 오디오에서는 말소리 덩어리(talkspurt)의 첫 패킷 표시(RFC 3551) |
| PT (payload type) | 7 | **이 패킷의 페이로드가 어떤 코덱인지 가리키는 번호.** 0(PCMU)·8(PCMA)은 RFC 3551이 고정해 둔 번호이고, 96~127은 SDP의 `a=rtpmap` 줄이 그 통화에서만 정하는 동적 번호. Opus의 111은 Chrome이 흔히 고르는 동적 번호일 뿐 표준 고정값이 아님 |
| sequence number | 16 | 패킷마다 1씩 늘어남. 손실·순서 뒤바뀜을 찾는 데 씀. 시작값은 무작위 |
| timestamp | 32 | 페이로드 첫 샘플의 시각을 **샘플 클록 틱**으로 적음. 재생 시각과 지터 계산에 씀. 시작값은 무작위 |
| SSRC | 32 | **동기화 출처(Synchronization SouRCe) ID.** 이 흐름 하나를 가리키는 무작위 32비트 이름. 한 연결에 트랙이 여럿이어도 이 값으로 구분 |

**타임스탬프는 "샘플 몇 개분 지났나"입니다.** 20ms 패킷이면 다음 패킷의 timestamp는 다음만큼 늘어납니다.

| 코덱 | RTP 클록 | 20ms 패킷의 timestamp 증가 |
| --- | --- | --- |
| G.711 (PCMU·PCMA) | 8,000Hz | 8,000 × 0.02 = **160** |
| Opus | **항상 48,000Hz** (RFC 7587) | 48,000 × 0.02 = **960** |

Opus는 실제로 협대역(8kHz)으로 인코딩하더라도 RTP 클록은 48kHz로 고정입니다(RFC 7587 4.1절). 그래서 SDP에도 늘 `opus/48000/2`라고 적습니다. 모노 통화여도 채널 수 칸은 2로 적어야 합니다(같은 RFC 7절).

**순서 번호와 타임스탬프는 서로 다른 것을 셉니다.** 순서 번호는 "몇 번째 패킷인가", 타임스탬프는 "언제의 소리인가"입니다. 둘을 함께 보면 손실과 침묵이 구분됩니다. 손으로 풀어 보면 이렇습니다(Opus, 20ms 패킷).

| 받은 패킷 | seq | timestamp | 앞 패킷과 비교 | 해석 |
| --- | --- | --- | --- | --- |
| A | 100 | 48,000 | | |
| B | 101 | 48,960 | seq +1, ts +960 | 정상. 20ms 뒤의 소리 |
| C | 104 | 51,840 | seq +3, ts +2,880 | seq 102·103이 없음 → **패킷 2개 손실.** ts도 3개분(60ms) 뛰어 앞뒤가 맞음 |
| D | 105 | 71,040 | seq +1, ts +19,200 | seq는 이어지는데 ts가 400ms 뜀 → 손실이 아니라 **보내는 쪽이 조용해서 안 보냄**(DTX) |

DTX(Discontinuous Transmission)는 말이 없을 때 패킷을 거의 보내지 않는 기능입니다. LiveKit 브라우저 SDK는 기본으로 켭니다(아래 대역폭 계산 참고).

**넘어감(wrap).** 순서 번호는 16비트라 65535 다음은 0입니다. 초당 50패킷이면 65,536 ÷ 50 ≈ 1,311초, 약 **21.8분마다** 한 바퀴 돕니다. 시작값이 무작위라 통화 상한 8분([src/call-guard.ts](../../src/call-guard.ts), 4-7절·5-5절) 안에서도 넘어갈 수 있습니다. 받는 쪽은 넘어간 횟수를 따로 셉니다(SRTP의 ROC, 아래). 타임스탬프는 32비트라 48kHz에서 2³² ÷ 48,000 ≈ 24.9시간에 한 바퀴입니다.

**직접 돌려 보기.** [lab/03-rtp-parse.mjs](lab/03-rtp-parse.mjs)는 패킷을 바이트로 만든 뒤 비트를 밀고(`>>`) 가려서(`&`) 다시 읽습니다. 실제 출력 일부입니다.

```text
== 1. Opus 20ms 패킷 두 개 (PT 111은 SDP가 정한 동적 번호) ==
헤더 12바이트: 80 ef ff ff b2 d0 5e 00 5e ed 12 34
첫 바이트 10000000 → V=2 P=0 X=0 CC=0
둘째 바이트 11101111 → M=1 PT=111
순서 번호 65535 → 0 (16비트라 넘어감), 타임스탬프 차이 960

== 2. G.711 μ-law(PCMU) 20ms 패킷: PT 0은 RFC 3551이 정한 고정 번호 ==
헤더: 80 00 03 e8 00 02 71 00 0b ad ca fe
PT=0, 페이로드 160B, 타임스탬프 차이 160
```

첫 바이트 `0x80`이 `10 0 0 0000`(V=2, 나머지 0)이라는 점을 기억해 두면 좋습니다. 패킷 캡처에서 RTP를 알아보는 첫 단서이고, 3-2절의 "한 포트에서 패킷 가르기"에도 다시 나옵니다.

#### 깊이 보기: 대역폭 손 계산 (2026-11-05 추가)

회선에 실리는 크기는 코덱 비트레이트보다 큽니다. 패킷마다 헤더가 붙기 때문입니다.

```text
G.711 20ms 패킷
  페이로드 160B (8kHz × 20ms × 1바이트)
+ RTP 헤더  12B
+ UDP 헤더   8B
+ IPv4 헤더 20B
= 200B × 50패킷/초 × 8비트 = 80,000bps = 80kbps    ← 코덱 자체는 64kbps
+ SRTP 인증 태그 10B → 210B × 50 × 8 = 84kbps
```

같은 방식으로 다른 경우도 계산할 수 있습니다. 실습 스크립트의 출력입니다(IPv4, 이더넷 헤더 제외).

```text
G.711 20ms, RTP                200B × 50/초 = 80kbps (페이로드 밖 20%)
G.711 20ms, SRTP(태그 10B)       210B × 50/초 = 84kbps (페이로드 밖 24%)
G.711 10ms, RTP                120B × 100/초 = 96kbps (페이로드 밖 33%)
Opus 48kbps 20ms, SRTP         170B × 50/초 = 68kbps (페이로드 밖 29%)
Opus 24kbps 20ms, SRTP         110B × 50/초 = 44kbps (페이로드 밖 45%)
```

- **패킷을 잘게 자를수록 헤더 비용이 커집니다.** 10ms로 자르면 패킷 수가 두 배라 헤더도 두 배입니다. 전화망이 `ptime=20`을 쓰는 이유 중 하나입니다(2-4절).
- Opus 48kbps는 LiveKit 브라우저 SDK(`livekit-client` 2.23.0, originalshq가 쓰는 판)의 기본 발행 상한입니다(`room/defaults.ts`의 `audioPreset: AudioPresets.music`, `room/track/options.ts`의 `maxBitrate: 48_000`). 같은 기본값에 `dtx: true`, `red: true`가 함께 켜져 있습니다. RED(RFC 2198)는 앞 프레임을 다음 패킷에 한 번 더 실어 손실에 대비하는 중복 전송이라 페이로드를 늘리고, DTX는 조용할 때 패킷을 거의 보내지 않아 평균을 줄입니다. 그래서 실제 값은 위 계산과 다르고, 아래 "직접 보기"(3-2절)에서 잴 수 있습니다. RED가 실제로 늘리는 바이트 수는 **확인 필요**입니다.
- WebRTC 패킷에는 RTP 헤더 확장(X=1)도 붙어 패킷마다 수 바이트에서 수십 바이트가 더해집니다. IPv6이면 IP 헤더가 40바이트라 20바이트가 더 붙습니다.

#### 깊이 보기: SRTP가 가리는 것과 남기는 것 (2026-11-05 추가)

SRTP(RFC 3711)는 RTP 패킷 전체를 감싸지 않습니다. 3.1절의 패킷 형식을 정리하면 다음과 같습니다.

```text
[ RTP 헤더 12B (+확장) ][ 페이로드 ………… ][ 인증 태그 10B ]
 └─ 평문(암호화 안 함) ┘ └─ 암호화 ────┘
 └──────────── 인증(변조 검사) 범위 ────┘
```

| 부분 | 처리 | 결과 |
| --- | --- | --- |
| RTP 헤더 | **암호화하지 않음**, 인증만 | 중간 장비와 패킷 캡처가 seq·timestamp·SSRC·PT를 읽을 수 있음. 그래서 손실률·지터는 암호를 풀지 않고도 잼 |
| 페이로드 | 암호화 (기본 AES 카운터 모드) | 소리 내용은 보이지 않음. 길이는 그대로 |
| 인증 태그 | 헤더+암호문(+ROC)에 HMAC-SHA1을 돌려 **80비트(10바이트)**로 자름 | 한 비트라도 바뀌면 받는 쪽이 버림 |

- 기본 변환은 AES-CM(카운터 모드) + HMAC-SHA1, 태그 80비트입니다(RFC 3711 5.1·5.2절). 흔히 `AES_CM_128_HMAC_SHA1_80`이라고 부릅니다. WebRTC는 `AEAD_AES_128_GCM`을 고를 수도 있는데, 이때 태그는 16바이트라 대역폭 계산이 달라집니다. 실제로 어느 쪽이 골라졌는지는 `chrome://webrtc-internals`의 `srtpCipher`에서 봅니다(3-2절 "직접 보기").
- **ROC(rollover counter).** 순서 번호가 넘어간 횟수입니다. 패킷에는 실리지 않고 양쪽이 각자 셉니다. 암호화에 쓰는 패킷 번호는 i = 2¹⁶ × ROC + SEQ이고(RFC 3711 3.2.1절), 이 값이 매번 달라야 같은 키로 같은 키 스트림을 두 번 쓰지 않습니다.
- 헤더가 평문이라는 것은 **누가 언제 얼마나 말했는지의 흔적(패킷 간격·크기, 오디오 레벨 헤더 확장)은 드러난다**는 뜻이기도 합니다.
- **SFU에서 암호화는 구간마다 끊깁니다.** 브라우저↔LiveKit SFU, LiveKit SFU↔에이전트가 각자 따로 DTLS-SRTP 연결입니다. SFU는 받은 패킷을 풀고 다시 암호화해 전달하므로, LiveKit 서버는 원리상 소리를 볼 수 있는 위치에 있습니다. 서버도 못 보게 하려면 종단 간 암호화(E2EE)를 따로 켜야 합니다. rtc-node에도 `e2ee.ts`가 있지만, 이 프로젝트는 쓰지 않습니다.

실습 스크립트의 5번은 가상의 세션 키로 이 변환을 직접 해 봅니다. 마스터 키에서 세션 키를 뽑는 단계는 생략했지만, 암호화 IV와 인증 태그는 RFC 3711의 식 그대로입니다.

```text
RTP  앞 16바이트: 80 00 03 e8 00 02 71 00 0b ad ca fe ff ff ff ff
SRTP 앞 16바이트: 80 00 03 e8 00 02 71 00 0b ad ca fe e2 b9 b5 52
SRTP 끝 10바이트(태그): c4 fb 21 b3 db a9 15 36 a0 42
길이 172B → 182B, 헤더를 그대로 읽으면: { sequence: 1000, ssrc: '0badcafe' }
```

앞 12바이트(헤더)는 그대로이고, 13번째 바이트부터(페이로드) 바뀌었으며, 끝에 10바이트가 붙었습니다.

---

## 3-2. WebRTC: 브라우저끼리 실시간으로 말하기

WebRTC는 브라우저(와 앱)가 플러그인 없이 실시간 음성·영상·데이터를 주고받게 하는 표준 묶음입니다. 브라우저 PoC(`lk agent dev` + Agent Console)는 이 위에서 돌아갑니다.

### 가장 어려운 문제: NAT 너머의 상대를 어떻게 찾나

집과 회사의 컴퓨터는 대부분 공유기(NAT) 뒤에 있어 **사설 IP**(예: 192.168.0.5)를 씁니다. 바깥에서는 이 주소로 직접 들어올 수 없습니다. WebRTC는 이 문제를 **ICE**라는 절차로 풉니다.

(2026-11-05 추가) **NAT의 종류.** 공유기는 안쪽 주소(192.168.0.5:54400)가 바깥으로 나갈 때 바깥 주소(예: 203.0.113.7:54321)를 붙여 줍니다. 이 짝을 **매핑**이라고 합니다. NAT는 두 가지 성질로 나뉩니다(RFC 4787).

| 성질 | 종류 | STUN이 통하나 |
| --- | --- | --- |
| 매핑: 목적지가 달라도 같은 바깥 주소를 주나 | **목적지 무관 매핑**(Endpoint-Independent): 같은 주소 | STUN 서버에게 보인 주소를 다른 상대도 쓸 수 있음 → 직접 연결 가능 |
| | **목적지별 매핑**(Address/Port-Dependent): 상대마다 다른 주소 | STUN 서버가 본 주소가 다른 상대에게는 안 맞음 → TURN 릴레이 필요 |
| 필터링: 밖에서 오는 패킷을 누구 것까지 받나 | 아무나 / 내가 보낸 적 있는 주소만 / 그 주소·포트만 | 엄격할수록 "양쪽이 동시에 보내 구멍 뚫기"가 필요 |

예전 문서의 "full cone / restricted cone / port restricted cone / symmetric NAT"라는 이름은 이 두 성질을 섞어 부른 것입니다. symmetric NAT가 목적지별 매핑이고, TURN이 필요한 대표 경우입니다. 이 프로젝트에서는 상대가 공인 IP에 있는 LiveKit SFU이므로 브라우저 쪽 NAT만 넘으면 됩니다. 브라우저가 먼저 SFU로 패킷을 보내 구멍을 열기 때문에 대개 TURN 없이 붙는다고 봅니다(**추정**. 아래 "직접 보기"에서 선택된 후보 쌍으로 확인할 수 있습니다).

| 구성 | 하는 일 |
| --- | --- |
| **STUN 서버** | "바깥에서 보면 내 주소가 뭐야?"를 알려 줍니다. 공유기가 바꿔 단 공인 IP와 포트를 알아냅니다. |
| **TURN 서버** | 직접 연결이 끝내 안 되면 중간에서 패킷을 대신 전달(릴레이)합니다. 느리고 비싸지만 마지막 수단입니다. |
| **ICE** | 가능한 주소 후보들(로컬 IP, STUN으로 알아낸 공인 주소, TURN 릴레이 주소)을 모두 모아 서로 교환하고, 실제로 패킷을 쏴 보며 되는 길을 고릅니다. |

연결 순서를 요약하면 다음과 같습니다.

```text
1. 시그널링   서로의 정보(SDP: 코덱·암호화 키 지문·ICE 후보)를 교환
              → WebRTC 표준은 방법을 정하지 않음. LiveKit은 WebSocket + protobuf
2. ICE        후보 주소 쌍을 시험해 통하는 길 선택
3. DTLS       그 길 위에서 암호화 키 교환
4. SRTP       암호화된 음성 패킷이 흐르기 시작
```

(2026-11-05 추가) **시그널링(signaling)**은 미디어가 흐르기 전에 "어떻게 연결할지"를 주고받는 별도 통로입니다. 소리 자체는 이 통로로 가지 않습니다. 전화로 치면 다이얼과 벨에 해당하고, SIP가 전화망의 시그널링입니다(3-5절). 1단계가 다 끝나기를 기다리지 않고 2단계가 시작됩니다. 시그널링으로 후보를 주고받는 동안 ICE 검사가 이미 돌아갑니다(아래 trickle ICE). DTLS(3단계)는 ICE가 쓸 길을 찾은 뒤에 시작합니다.

### SDP: "나는 이런 걸 할 수 있어"

SDP(Session Description Protocol)는 텍스트로 된 미디어 명세서입니다. 한쪽이 **제안(offer)**을 보내고 다른 쪽이 **응답(answer)**을 보내 공통분모를 정합니다(RFC 3264 offer/answer 모델).

```text
m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8     ← 오디오, 지원 코덱 번호들
a=rtpmap:111 opus/48000/2               ← 111번 = Opus 48kHz
a=rtpmap:0 PCMU/8000                    ← 0번 = G.711 μ-law
a=rtpmap:8 PCMA/8000                    ← 8번 = G.711 A-law
a=ptime:20                              ← 패킷당 20ms
```

이 형식은 3-5절의 **SIP 전화에서도 똑같이** 씁니다. WebRTC와 SIP가 생각보다 가까운 친척이라는 뜻입니다.

#### 깊이 보기: WebRTC SDP 한 장 읽기 (2026-11-05 추가)

위 예는 코덱 줄만 뽑은 것입니다. 실제 브라우저의 SDP에는 ICE와 암호화에 필요한 줄이 더 들어 있습니다. 아래는 Chrome 제안(offer)을 줄이고 값을 가상으로 바꾼 예입니다. 줄의 순서와 번호는 브라우저 버전마다 다릅니다.

```text
v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
m=audio 9 UDP/TLS/RTP/SAVPF 111 63 0 8 126
c=IN IP4 0.0.0.0
a=ice-ufrag:Fq3x
a=ice-pwd:x9Yd2kQe7Lm0Pz4Rt8Wv6B
a=ice-options:trickle
a=fingerprint:sha-256 2F:E3:4C:E2:A5:B9:FB:E7:58:EE:C7:A2:EE:AF:10:26:11:A6:12:A9:B4:E8:C7:B2:7D:C6:AC:5D:B1:61:F0:1D
a=setup:actpass
a=mid:0
a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level
a=sendrecv
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:63 red/48000/2
a=fmtp:63 111/111
a=rtpmap:126 telephone-event/8000
```

| 줄 | 뜻 |
| --- | --- |
| `m=audio 9 UDP/TLS/RTP/SAVPF …` | 오디오 단락. 포트 `9`와 `c=IN IP4 0.0.0.0`은 "주소는 아직 없음"이라는 자리표시입니다. 실제 주소는 아래 후보 줄로 따로 옵니다. `UDP/TLS/RTP/SAVPF`는 UDP 위의 DTLS로 키를 정한 SRTP(S)와 RTCP 피드백(F)을 쓴다는 뜻입니다 |
| `a=group:BUNDLE 0` | **BUNDLE.** 여러 `m=` 단락(마이크 보내기, 상대 소리 받기, 데이터 채널)을 **UDP 포트 하나(5-tuple 하나)**로 묶어 보냅니다. ICE 검사와 DTLS 핸드셰이크를 한 번만 하면 됩니다. 실제 SDP에는 `m=` 단락이 여럿 있고 이 줄에 그 번호(`mid`)가 나열됩니다 |
| `a=rtcp-mux` | RTP와 RTCP를 같은 포트로 보냅니다. 그래서 후보 줄의 component ID가 1뿐입니다 |
| `a=ice-ufrag` / `a=ice-pwd` | ICE 연결 검사(STUN 메시지)에 쓰는 사용자 이름 조각과 비밀번호입니다(아래 STUN 절) |
| `a=ice-options:trickle` | **trickle ICE.** 후보를 다 모을 때까지 기다리지 않고, 하나 찾을 때마다 시그널링으로 흘려보냅니다. 연결이 빨라집니다 |
| `a=fingerprint` / `a=setup` | DTLS 인증서의 해시와 DTLS 역할입니다(아래 DTLS 절) |
| `a=extmap:1 …audio-level` | RTP 헤더 확장(X 비트) 1번을 "이 패킷 소리의 크기"로 쓰자는 합의입니다. SFU는 소리를 풀지 않고도 이 값으로 누가 말하는지 가늠할 수 있습니다 |
| `a=rtpmap:63 red/48000/2`, `a=fmtp:63 111/111` | RED 중복 전송. 패킷 하나에 Opus(111) 프레임 두 개(이번 것 + 앞 것)를 싣습니다 |
| `a=rtpmap:126 telephone-event/8000` | DTMF 버튼 신호(3-5절) |

#### 깊이 보기: 후보 줄과 우선순위 손 계산 (2026-11-05 추가)

**후보(candidate)**는 "여기로 보내면 내가 받을 수 있을지도 모른다"는 (전송 방식, IP, 포트) 하나입니다. trickle ICE에서는 후보가 시그널링 메시지로 하나씩 오고, SDP에 실을 때는 이런 줄이 됩니다(RFC 8839의 문법, 값은 가상).

```text
a=candidate:1467250027 1 udp 2130706431 192.168.0.5 54400 typ host generation 0
a=candidate:842163049 1 udp 1694498815 203.0.113.7 54321 typ srflx raddr 192.168.0.5 rport 54400 generation 0
a=candidate:3745126810 1 udp 16777215 198.51.100.20 61000 typ relay raddr 203.0.113.7 rport 54321 generation 0
```

| 칸 | 첫 줄의 값 | 뜻 |
| --- | --- | --- |
| foundation | `1467250027` | 종류와 출처가 같은 후보끼리 같은 값. 검사 순서를 정할 때 씀 |
| component ID | `1` | 1 = RTP, 2 = RTCP. `rtcp-mux`면 1만 있음 |
| transport | `udp` | `udp` 또는 `tcp` |
| priority | `2130706431` | 아래 식으로 계산한 값. 클수록 먼저 시도 |
| 주소·포트 | `192.168.0.5 54400` | 후보 주소 |
| `typ` | `host` | 후보 종류 (아래 표) |
| `raddr`·`rport` | (둘째 줄) `192.168.0.5 54400` | 관련 주소. srflx는 바탕이 된 host 주소, relay는 TURN 서버가 본 내 바깥 주소. 진단용 |
| 그 뒤 | `generation 0` | 브라우저가 붙이는 확장 칸 |

| 종류 | 이름 | 어디서 얻나 |
| --- | --- | --- |
| `host` | 호스트 | 내 네트워크 카드의 주소. 사설 IP. 브라우저는 사설 IP를 감추려고 `<무작위 UUID>.local` 같은 mDNS 이름으로 바꿔 내기도 함 |
| `srflx` | server reflexive | STUN 서버에 "비친" 내 바깥 주소 (NAT 매핑) |
| `prflx` | peer reflexive | 연결 검사 중 상대가 보낸 패킷에서 처음 알게 된 주소 |
| `relay` | 릴레이 | TURN 서버에서 빌린 주소. 모든 패킷이 TURN을 거침 |

**우선순위 식** (RFC 8445 5.1.2.1절):

```text
priority = 2^24 × (type preference) + 2^8 × (local preference) + (256 − component ID)
```

type preference는 권장값이 host 126, prflx 110, srflx 100, relay 0입니다(같은 RFC 5.1.2.2절). local preference는 IP가 하나뿐이면 65535입니다. 손으로 계산하면 다음과 같습니다.

```text
host : 2^24×126 = 2,113,929,216 + 2^8×65535 = 16,776,960 + (256−1) = 255 → 2,130,706,431
srflx: 2^24×100 = 1,677,721,600 + 16,776,960 + 255                    → 1,694,498,815
relay: 2^24×0   =             0 + 16,776,960 + 255                    →    16,777,215
```

2²⁴와 2⁸는 곱셈이라기보다 **비트 자리 옮기기**입니다. 32비트 값의 맨 앞 8비트가 type preference, 가운데 16비트가 local preference, 끝 8비트가 (256 − component)입니다. 그래서 거꾸로 풀 때는 `>>> 24`, `(>>> 8) & 0xffff`, `& 0xff`면 됩니다. relay가 가장 낮은 것은 "다른 길이 다 안 될 때만 쓰라"는 뜻입니다.

ICE는 내 후보와 상대 후보를 짝지은 **후보 쌍**마다 연결 검사를 하고, 쌍의 우선순위는 이렇게 매깁니다(RFC 8445 6.1.2.3절). G는 결정권을 가진 쪽(controlling), D는 따르는 쪽(controlled)의 후보 우선순위입니다.

```text
pair priority = 2^32 × MIN(G, D) + 2 × MAX(G, D) + (G > D ? 1 : 0)
```

이 값은 64비트입니다. JavaScript의 `Number`는 2⁵³까지만 정확하므로 그대로 계산하면 끝자리가 틀어집니다. **직접 돌려 보기:** [lab/03-ice-stun.mjs](lab/03-ice-stun.mjs)의 출력입니다.

```text
== 1. 후보 우선순위 (local preference 65535, component 1 = RTP) ==
host  2130706431
srflx 1694498815
relay 16777215
2122260223 풀기: { typePref: 126, localPref: 32542, component: 1 }
쌍 우선순위(BigInt) 7277816997797167103
쌍 우선순위(Number) 7277816997797167104  ← 2^53을 넘어 끝자리가 틀어짐
```

`2122260223`처럼 local preference가 65535가 아닌 값이 보이면, 브라우저가 local preference를 따로 매긴 것입니다. Chrome 계열은 네트워크 종류(유선·와이파이·VPN)와 IPv4·IPv6에 따라 다르게 매기는 것으로 알려져 있습니다(확인 필요).

#### 깊이 보기: STUN 메시지와 XOR-MAPPED-ADDRESS (2026-11-05 추가)

STUN(RFC 8489)은 **20바이트 헤더 + 속성(TLV) 목록**인 이진 메시지입니다(5절).

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|0 0|     STUN Message Type     |         Message Length        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                   Magic Cookie = 0x2112A442                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                                                               |
|                    Transaction ID (96 bits)                   |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  속성 type (16)               |  속성 length (16)              |
|  속성 value … (4바이트 경계로 채움)                              |
```

- **맨 앞 2비트는 항상 0**이고, **매직 쿠키는 고정값 `0x2112A442`**입니다. 같은 포트로 RTP·DTLS가 섞여 와도 이 두 가지로 STUN을 알아봅니다.
- Message Type에는 메서드(12비트)와 클래스(2비트)가 섞여 들어 있습니다. Binding 요청은 `0x0001`, Binding 성공 응답은 `0x0101`입니다.
- Message Length는 헤더 20바이트를 **뺀** 본문 길이입니다.
- Transaction ID는 요청한 쪽이 고른 96비트 무작위 값이고, 응답이 같은 값을 돌려줘 짝을 맞춥니다.

**XOR-MAPPED-ADDRESS(속성 type `0x0020`)**는 "당신이 보낸 패킷이 나에게는 이 주소에서 왔다"를 담습니다. 그런데 주소를 그대로 적지 않고 섞어서 적습니다(14.2절).

```text
X-Port    = 포트 XOR 0x2112            (매직 쿠키의 앞 16비트)
X-Address = IPv4 주소 XOR 0x2112A442   (IPv6이면 매직 쿠키 + Transaction ID 128비트와 XOR)
```

203.0.113.7:54321로 손 계산해 봅니다.

```text
포트   54321 = 0xD431           0xD431 XOR 0x2112 = 0xF523
주소   203 . 0  . 113 . 7
     = cb    00   71    07
XOR    21    12   a4    42
     = ea    12   d5    45      → X-Address 0xEA12D545
```

받는 쪽은 같은 값으로 한 번 더 XOR하면 원래 주소가 나옵니다(A XOR K XOR K = A). 실습 스크립트 출력입니다.

```text
== 2. STUN Binding 요청 (type 0x0001, 속성 없음) ==
00 01 00 00 21 12 a4 42 00 01 02 03 04 05 06 07 08 09 0a 0b

== 3. Binding 성공 응답 (type 0x0101) + XOR-MAPPED-ADDRESS ==
헤더: 01 01 00 0c 21 12 a4 42 00 01 02 03 04 05 06 07 08 09 0a 0b
속성: 00 20 00 08 00 01 f5 23 ea 12 d5 45
디코드: { ip: '203.0.113.7', port: 54321 }
공인 IP 바이트 cb 00 71 07 가 응답 안에 그대로 있나: false
```

**왜 굳이 XOR하나.** 어떤 NAT는 "도움이 되려고" 패킷 본문에서 자기 공인 IP처럼 보이는 32비트 값을 찾아 고쳐 썼습니다(일종의 ALG, 응용 계층 게이트웨이). 그러면 STUN이 알려 주려던 주소가 망가지고 무결성 검사도 깨집니다(RFC 8489). XOR로 섞어 두면 본문에 공인 IP 바이트가 그대로 나타나지 않습니다. 위 출력의 마지막 줄이 그것입니다. 암호화가 아니라 **"NAT가 못 알아보게 하는" 위장**일 뿐입니다.

**ICE의 연결 검사도 STUN입니다.** ICE는 후보 쌍마다 STUN Binding 요청을 보내 봅니다. 이때 요청에는 다음 속성이 붙습니다(RFC 8445).

| 속성 | 값 | 하는 일 |
| --- | --- | --- |
| USERNAME | `상대의 ufrag:내 ufrag` | SDP의 `a=ice-ufrag` 두 개를 콜론으로 이음. 엉뚱한 세션의 패킷을 가름 |
| MESSAGE-INTEGRITY | HMAC-SHA1 | 상대의 `a=ice-pwd`를 키로 메시지를 서명. 시그널링을 본 쪽만 만들 수 있음 |
| PRIORITY | 숫자 | 이 검사로 prflx 후보가 생기면 쓸 우선순위 |
| ICE-CONTROLLING / ICE-CONTROLLED | 무작위 값 | 누가 결정권을 가졌나 |
| USE-CANDIDATE | 없음 | 결정권 쪽이 "이 쌍으로 정한다"고 지명(nomination) |
| FINGERPRINT | CRC-32 XOR `0x5354554E` | STUN임을 한 번 더 확인. `0x5354554E`는 ASCII로 "STUN" |

**한 포트에서 패킷 가르기.** BUNDLE과 rtcp-mux를 쓰면 UDP 포트 하나에 STUN, DTLS, SRTP, SRTCP가 모두 섞여 옵니다. 받는 쪽은 **첫 바이트 하나**로 가릅니다(RFC 7983, RFC 5764의 규칙을 고친 것).

| 첫 바이트 | 프로토콜 | 이유 |
| --- | --- | --- |
| 0~3 | STUN | 맨 앞 2비트가 0 |
| 16~19 | ZRTP | |
| 20~63 | DTLS | TLS 레코드 종류 번호(핸드셰이크 = 22 = `0x16`) |
| 64~79 | TURN ChannelData | 채널 번호 `0x4000`~`0x4FFF` |
| 128~191 | RTP / RTCP | V=2라 맨 앞 2비트가 `10` |

```text
== 4. 첫 바이트로 가르기 ==
STUN 요청                0x00 → STUN
DTLS 핸드셰이크 레코드         0x16 → DTLS
RTP (V=2)              0x80 → RTP/RTCP
TURN ChannelData       0x40 → TURN Channel
```

#### 깊이 보기: 연결된 뒤에도 계속 묻는다 — 동의 갱신 (2026-11-05 추가)

ICE가 길을 정한 뒤에도 STUN Binding 요청은 멈추지 않습니다. **동의 갱신(consent freshness, RFC 7675)**이라는 규칙 때문입니다.

- 기본 5초 간격으로, 간격마다 0.8~1.2배로 흔들어(4~6초) 선택된 쌍에 STUN 요청을 보냅니다. 상대가 응답하면 "아직 받겠다고 동의한 것"으로 봅니다.
- **30초 동안 유효한 응답이 없으면 동의가 만료**되고, 그 5-tuple로는 더 보내면 안 됩니다. 늦게 온 응답으로 되살릴 수도 없고 ICE 재시작이 필요합니다(RFC 7675 5.1절).
- 이유: 상대가 사라졌는데 계속 쏘거나, 악성 페이지가 WebRTC로 남의 서버에 패킷을 퍼붓는 것을 막기 위해서입니다. 덤으로 NAT 매핑이 시간이 지나 닫히지 않게 붙잡아 두는 역할(keep-alive)도 합니다.
- 우리 시스템에서: 브라우저 탭을 갑자기 닫으면, 원리상 SFU는 동의 갱신 응답이 끊기는 것으로도 고객이 사라졌음을 알 수 있습니다. LiveKit이 실제로 어떤 신호로 참가자를 정리하는지는 확인하지 않았습니다. LiveKit 문서는 `disconnect()` 없이 앱이 끝나면 참가자가 15초 뒤 사라진다고 적고 있습니다. 그 뒤 에이전트 쪽 처리는 4-7절 "고객이 전화를 끊으면"에 있습니다.

#### 깊이 보기: DTLS-SRTP — fingerprint와 setup (2026-11-05 추가)

SRTP는 키가 있어야 돌아갑니다. WebRTC는 그 키를 **ICE로 정한 같은 길 위에서 DTLS 핸드셰이크로** 만듭니다. DTLS는 UDP용 TLS입니다. 이 방식을 DTLS-SRTP라고 합니다(RFC 5763·5764).

```text
active를 고른 쪽 (DTLS 클라이언트)                       passive 쪽 (DTLS 서버)
  │── ClientHello  (use_srtp: 지원하는 SRTP 프로필) ─────────▶│
  │◀─ ServerHello (고른 프로필), Certificate, CertificateRequest │
  │── Certificate, Finished ───────────────────────────────▶│   ← 양쪽 다 인증서를 냄
  │◀────────────────────────────────────────── Finished ────│
  │  양쪽이 같은 핸드셰이크 결과에서 SRTP 키를 뽑음 (exporter) │
  │═══════════════ SRTP (3-1절) ══════════════════════════════│
              (간략화한 순서. 실제로 누가 active인지는 SDP 응답의 a=setup으로 확인)
```

- **인증서는 인증 기관(CA)이 서명한 것이 아닙니다.** 브라우저가 보통 연결마다 스스로 만든 인증서입니다. 그럼 상대가 진짜인지 어떻게 아나? SDP의 **`a=fingerprint:sha-256 …`**에 내 인증서의 SHA-256 해시(32바이트를 콜론으로 이은 것)를 적어 보내고, DTLS에서 받은 인증서의 해시가 이 값과 같은지 봅니다(`a=fingerprint`는 RFC 8122). SDP는 TLS로 보호된 시그널링(`wss://`)으로 왔으므로, "시그널링으로 얘기한 그 상대와 DTLS를 하고 있다"가 확인됩니다.
- **`a=setup`**은 DTLS에서 누가 클라이언트(먼저 ClientHello를 보내는 쪽)가 될지 정합니다(RFC 4145의 속성). 제안(offer)은 `actpass`(아무 쪽이나)로 보내고, 응답(answer)이 `active`(내가 클라이언트)나 `passive`(내가 서버)를 골라 확정합니다.
- **use_srtp 확장**(RFC 5764)으로 SRTP 프로필(예: `SRTP_AES128_CM_HMAC_SHA1_80`, `SRTP_AEAD_AES_128_GCM`)을 고르고, 핸드셰이크가 끝나면 TLS exporter(라벨 `EXTRACTOR-dtls_srtp`)로 방향별 마스터 키와 소금(salt)을 뽑습니다. 이 키로 3-1절의 SRTP가 돌아갑니다. 음성 패킷은 DTLS 레코드에 실리지 않습니다. DTLS 연결 자체는 키를 만든 뒤 데이터 채널(SCTP)을 실어 나르는 데 계속 씁니다.
- 결과적으로 **보안의 뿌리는 시그널링**입니다. 누가 시그널링을 가로채 SDP의 fingerprint를 바꿔치기하면 중간자 공격이 가능합니다. 그래서 시그널링은 TLS(`wss://`)로 가고, 입장은 서명된 접속 토큰(3-7절)으로 통제합니다.

#### 깊이 보기: UDP가 막혔을 때 — ICE/TCP, TURN/TLS 443 (2026-11-05 추가)

LiveKit은 다음 순서로 연결을 시도합니다(LiveKit 문서 "Connecting to LiveKit"의 Connection reliability).

| 순서 | 경로 | 쓰이는 경우 |
| --- | --- | --- |
| 1 | ICE over UDP | 대부분 |
| 2 | TURN over UDP (3478) | ICE/UDP 직접 경로가 안 될 때 |
| 3 | ICE over TCP | UDP를 막는 네트워크 (VPN, 회사 방화벽) |
| 4 | TURN over TLS | 바깥으로 TLS만 허용될 때. LiveKit Cloud가 TURN/TLS 서버를 운영 |

3·4번으로 내려가면 3-1절의 장점이 사라집니다.

- TCP는 바이트 스트림이라 RTP 패킷마다 길이 2바이트를 앞에 붙여 이어 보냅니다(RFC 4571, ICE-TCP는 RFC 6544). 그 사이 TCP 조각 하나가 사라지면 **재전송될 때까지 뒤의 음성 패킷이 모두 커널 버퍼에서 기다립니다.** 이것이 Head-of-Line 차단입니다.
- 받는 쪽 지터 버퍼에는 한동안 아무것도 안 오다가 한꺼번에 몰려옵니다. 지터 버퍼는 이를 버티려고 늘어나고, 그만큼 지연이 붙습니다. 체감 증상은 "연결은 되는데 소리가 뭉쳐 오고 대답이 늦다"입니다.
- TURN/TLS는 여기에 TURN 서버 경유(한 구간 더)와 TLS 암호화가 겹칩니다. 대신 HTTPS와 구분이 어려워 거의 모든 방화벽을 통과합니다.
- 웹 테스트가 특정 사무실 네트워크에서만 유난히 느리면 이 경우를 먼저 의심합니다. 확인은 아래 "직접 보기"에서 선택된 후보 쌍의 `protocol`(udp/tcp)과 `candidateType`(relay면 `relayProtocol`까지)을 봅니다.

#### 직접 보기: `chrome://webrtc-internals` (2026-11-05 추가)

웹 테스트(3-7절)를 하면서 이 장의 실물을 직접 볼 수 있습니다.

1. Chrome에서 **통화를 시작하기 전에** 새 탭에 `chrome://webrtc-internals`를 엽니다. 열어 둔 뒤에 만들어진 PeerConnection부터 기록됩니다.
2. 관리 화면 `/log`의 "AI 상담원" 탭에서 통화를 시작합니다. 위쪽에 PeerConnection 항목이 생깁니다. livekit-client 2.23.0은 PeerConnection 하나로 보내기·받기를 다 하는 방식이 기본이라 대개 하나이고, 서버가 그 방식을 지원하지 않으면 보내기용·받기용 두 개가 생깁니다(3-3절).
3. 다음을 찾아봅니다.

| 볼 곳 | 이 장에서 대응하는 것 |
| --- | --- |
| 이벤트 목록의 `setLocalDescription` / `setRemoteDescription` | SDP 원문. `m=`, `a=candidate`, `a=fingerprint`, `a=setup`, `a=rtpmap`, `a=group:BUNDLE` 줄 |
| 이벤트 목록의 `icecandidate` | trickle ICE로 하나씩 나오는 후보 |
| Stats의 `candidate-pair` 중 선택된(`nominated`) 쌍 | 실제로 쓰는 길. 연결된 `local-candidate`·`remote-candidate`의 `candidateType`, `protocol`, `address`, `priority` |
| `transport` | `dtlsState`(connected), `srtpCipher`, `dtlsCipher`, `selectedCandidatePairId` |
| `inbound-rtp` (kind=audio) | 에이전트 목소리를 받는 쪽. `packetsLost`, `jitter`, `jitterBufferDelay ÷ jitterBufferEmittedCount`(평균 지터 버퍼 지연), `codecId`(Opus인지) |
| `outbound-rtp` (kind=audio) | 내 마이크를 보내는 쪽. `bytesSent`의 증가로 실제 비트레이트(위 손 계산과 비교) |

**공유할 때 주의.** 화면의 "Create a WebRTC-Internals dump"로 저장할 수 있지만, **덤프에는 실제 공인 IP와 후보 주소가 들어 있습니다.** 이 레포(공개 저장소)나 이슈에 그대로 올리지 않습니다.

에이전트 쪽에도 같은 통계가 있습니다. rtc-node의 `Room.getRtcStats()`(`node_modules/@livekit/rtc-node/src/room.ts` 218행)가 네이티브 WebRTC 스택의 통계를 돌려줍니다. 코드로만 확인했고 이 레포에서 불러 본 적은 없습니다.

---

## 3-3. SFU와 LiveKit

### 여러 명이 통화할 때의 세 가지 구조

| 구조 | 방식 | 장단점 |
| --- | --- | --- |
| **메시(Mesh)** | 모두가 모두에게 직접 보냄 | 서버가 필요 없지만, 사람이 늘면 업로드가 폭증 |
| **MCU** | 서버가 모든 소리를 받아 **섞어서** 하나로 보냄 | 받는 쪽은 편하지만 서버가 디코딩·인코딩을 다 해야 해 무겁고 지연이 늘어남 |
| **SFU** | 서버가 받은 패킷을 **섞지 않고 골라서 전달**만 함 | 서버 부담이 작고 지연이 짧음. 현대 화상회의의 표준 |

**LiveKit은 오픈소스 SFU입니다**(Go로 작성, WebRTC 구현으로 Pion 사용). LiveKit Cloud는 이 서버를 전 세계 리전에 운영해 주는 서비스입니다.

### LiveKit의 데이터 모델

LiveKit을 이해하는 핵심 단어는 네 개입니다.

```text
Room (방)  ── 하나의 통화. 이름으로 구분 (예: call-<callId>)
 ├─ Participant (참가자)
 │    ├─ 사람: 브라우저 사용자, 또는 SIP로 들어온 전화 고객
 │    └─ 에이전트: 우리 워커 (이것도 그냥 참가자 중 하나)
 └─ Track (트랙)
      ├─ 참가자가 "발행(publish)"하는 미디어 흐름 (마이크 오디오 등)
      └─ 다른 참가자가 "구독(subscribe)"해서 받음
```

중요한 관점 전환이 하나 있습니다. **AI 에이전트는 LiveKit 입장에서 특별한 존재가 아닙니다.** 방에 들어온 또 하나의 참가자일 뿐입니다. 에이전트는

1. 고객의 오디오 트랙을 **구독**해서 PCM 프레임으로 받고(입력),
2. 자기 오디오 트랙을 **발행**해서 TTS 소리를 흘려보냅니다(출력).

이 덕분에 고객이 브라우저로 들어오든 전화로 들어오든 **에이전트 코드는 똑같습니다.** [src/main.ts](../../src/main.ts)가 `session.start({ room: ctx.room, ... })` 한 줄로 방에 붙는 것이 이 구조 덕분입니다. 구체적인 연결 과정은 4장과 11장에서 다룹니다.

#### 깊이 보기: 에이전트 쪽 연결의 실제 구조 — JS와 Rust 사이 (2026-11-05 추가)

에이전트는 브라우저가 아니므로 브라우저의 WebRTC가 없습니다. Node에는 WebRTC가 내장되어 있지도 않습니다. 그래서 `@livekit/rtc-node`는 **LiveKit Rust SDK와 libwebrtc(Chrome의 WebRTC 엔진)를 컴파일한 네이티브 모듈**을 JS에서 부르는 얇은 껍질입니다. macOS arm64에서는 `@livekit/rtc-ffi-bindings-darwin-arm64`의 `rtc-node.darwin-arm64.node`(17,559,776바이트, 약 17.6MB) 파일 하나입니다. JS와 네이티브 코드 사이의 호출 경계를 **FFI(Foreign Function Interface)**라고 합니다.

```text
JS (Node 이벤트 루프)                               네이티브 .node (Rust livekit + libwebrtc)
─────────────────────────────────────────────────────────────────────────────────────────
Room.connect(url, token)
  FfiRequest{connect: url, token} ─ toBinary() ──▶ livekitFfiRequest()
  ◀── FfiResponse{asyncId} (바로 돌아옴) ─────────┘   └ 시그널링 WebSocket 연결 (아래)
                                                       └ PeerConnection: ICE · DTLS · SRTP
  waitFor(FfiEvent{connect, asyncId}) ◀── 콜백(event_data 바이트) ── 연결 끝나면

new AudioStream(track, {sampleRate: 24000, numChannels: 1})
  FfiRequest{newAudioStream} ───────────────────▶ 트랙에 오디오 받는 곳을 연결
                                                  SRTP 복호 → 지터 버퍼·Opus 디코드·손실 은닉
                                                  → 24kHz 모노로 리샘플 → 프레임
  FfiEvent{audioStreamEvent.frameReceived} ◀──── 프레임 정보 + 네이티브 버퍼 주소
  AudioFrame.fromOwnedInfo: copyBuffer(주소, 길이)로 JS 메모리에 복사, 네이티브 핸들 해제
  ReadableStream에 넣음 → RoomIO → 노이즈 제거·VAD·STT (2장, 5장, 6장)
```

**코드로 확인한 것.** 경로의 `rtc/`는 `node_modules/@livekit/rtc-node/src/`, `agents/`는 `node_modules/@livekit/agents/src/`입니다.

- JS와 네이티브는 **protobuf 바이트**로만 말합니다. 요청은 `FfiRequest`를 `toBinary()`로 바꿔 `livekitFfiRequest()`에 넘기고, 돌아온 바이트를 `FfiResponse.fromBinary()`로 읽습니다(`rtc/ffi_client.ts` 60~65행). 이 호출은 동기라 바로 돌아옵니다.
- 오래 걸리는 일(방 접속 등)은 응답에 `asyncId`만 받고, 끝나면 네이티브가 콜백으로 `FfiEvent` 바이트를 보냅니다. JS는 `FfiEvent.fromBinary()`로 읽어 이벤트로 뿌리고(`rtc/ffi_client.ts` 50~57행), `waitFor()`가 같은 `asyncId`를 기다립니다(같은 파일 75~112행, `rtc/room.ts` 323~341행).
- 고객 오디오는 `NewAudioStreamRequest`에 `sampleRate`·`numChannels`를 담아 요청합니다(`rtc/audio_stream.ts` 68~93행). RoomIO의 기본값이 24kHz 모노입니다(`agents/voice/room_io/room_io.ts` 124~126행, `agents/voice/room_io/_input.ts` 339~349행). 프레임이 오면 네이티브 버퍼를 JS 쪽으로 복사합니다(`rtc/audio_frame.ts` 46~57행, `rtc/audio_stream.ts` 114~124행).
- JS 쪽 `AudioStream`에는 디코딩·리샘플 코드가 없습니다. 요청한 샘플레이트로 이미 맞춰진 프레임이 옵니다. 따라서 **지터 버퍼, Opus 디코딩, 리샘플은 네이티브 쪽에서 일어납니다.**
- 네이티브 바이너리의 문자열(`strings`)에는 libwebrtc의 `NetEqImpl`(적응형 지터 버퍼 겸 디코더), `AudioDecoderOpusImpl`, `SincResampler`가 들어 있습니다. 위 결론을 뒷받침하지만, 어느 리샘플러가 실제로 쓰이는지는 **확인하지 못했습니다.**
- 워커 등록용 WebSocket(`/agent`, 4-2절)은 이것과 별개입니다. 그쪽은 JS의 `ws` 라이브러리로 엽니다(`agents/worker.ts` 480~491행). 즉 워커에는 **JS가 여는 워커↔서버 연결 하나**와 **잡마다 네이티브가 여는 방 연결**이 따로 있습니다. 잡은 자식 프로세스에서 돌므로(4-4절) 네이티브 모듈도 프로세스마다 하나씩 올라옵니다(`rtc/ffi_client.ts`의 프로세스 전역 싱글턴).

**시그널링.** 문서와 브라우저 쪽 코드로 확인했고, 에이전트 쪽은 추정입니다. 브라우저 쪽 경로는 originalshq의 `node_modules/livekit-client/` 기준입니다.

- LiveKit 문서(Reference › Internals › Client Protocol)에 따르면 클라이언트는 서버의 `/rtc` 경로로 WebSocket을 열고, `access_token` 쿼리 파라미터로 토큰을 냅니다. 그 위로 **클라이언트는 `SignalRequest`, 서버는 `SignalResponse`** protobuf 메시지를 주고받습니다. 첫 응답은 `JoinResponse`(방·참가자 정보, ICE 서버 목록)이고, 이어서 SDP offer/answer와 `trickle`(후보 하나씩)이 이 통로로 오갑니다. PeerConnection은 보내기용·받기용으로 최대 두 개입니다.
- 관리 화면이 쓰는 `livekit-client` 2.23.0은 한 단계 새 방식이 기본입니다. `/rtc/v1?access_token=…&join_request=…`로 먼저 붙고(`join_request`는 참가 요청 protobuf를 base64url로 바꾼 것), PeerConnection 하나로 보내기·받기를 다 합니다(`singlePeerConnection: true`). 서버가 지원하지 않으면 `/rtc`로 돌아갑니다(`src/api/utils.ts`의 `createRtcUrl`, `src/api/SignalClient.ts`, `src/room/defaults.ts`).
- 에이전트 쪽 Rust SDK도 최신 코드(GitHub `livekit/rust-sdks`의 `livekit-signaling`)는 `/rtc/v1`을 먼저 쓰고 안 되면 이전 경로로 돌아갑니다. 설치된 0.13.1 바이너리에도 `SignalResponse`, `livekit_signaling::signal_stream`, `join_request`, `rtc`, `v1` 문자열이 있어 같은 방식으로 보이지만, 이 판이 실제로 어느 경로로 붙는지는 **추정**이고 확인 필요입니다.
- 토큰이 **URL 쿼리**로 간다는 점은 3-7절과 이어집니다. URL은 프록시·서버 로그에 남기 쉬운 자리라 `livekit-client`는 로그에 찍을 때 `access_token`을 `<redacted>`로 가립니다(`src/api/SignalClient.ts` 507~508행).

### LiveKit Cloud와 리전

| 구성 | 위치 | 비고 |
| --- | --- | --- |
| 미디어 서버(SFU)·SIP | LiveKit Cloud 리전 (일본 리전 사용 가능) | 고객 음성이 실제로 지나가는 곳 |
| 에이전트 워커 | 우리가 띄우는 곳 (PoC: 내 맥 / 운영: GCP 서울 예정) | 워커가 SFU에 WebSocket·WebRTC로 붙음 |
| STT·LLM·TTS API | 각 공급사 서버 (대부분 미국) | 워커가 HTTPS·WebSocket으로 호출 |

물리적 거리는 곧 지연입니다. 빛은 광섬유 안에서 1ms에 약 200km를 가므로, 서울↔미국 서부(약 9,000km) 왕복은 이론상으로도 90ms이고 실제로는 라우팅 때문에 150~200ms가 듭니다([2-tech-stack.md 8장](../2-tech-stack.md#8-응답-지연-예산)). 한 턴에 STT·LLM·TTS를 모두 미국에 다녀오면 이 비용이 여러 번 더해집니다. 13장에서 다시 다룹니다.

---

## 3-4. 전화망의 구조

실제 서비스는 고객 휴대폰으로 **전화를 겁니다.** 전화망은 인터넷과 다른 세계라서 이어 주는 장치가 여러 개 필요합니다.

```text
고객 휴대폰
   │  이동통신망 (음성 → 디지털, AMR 등 이동통신 코덱)
[이동통신사 교환기]
   │  통신사 간 연동 (G.711)
[유선/인터넷전화 통신사 — SIP 트렁크 제공]
   │  SIP + RTP (G.711), 인터넷 또는 전용선
[SBC] 통신사 쪽 관문 (Session Border Controller)
   │
[Asterisk] 우리 쪽 교환기 (GCE 서울 VM) — 등록·코덱 변환·NAT 처리·발신 규칙
   │  SIP
[LiveKit SIP] SIP 통화를 LiveKit 방의 참가자로 바꿔 줌
   │  WebRTC
[에이전트 워커]
```

| 용어 | 뜻 |
| --- | --- |
| **PSTN** | 전통 공중 전화망. 휴대폰·유선전화가 사는 세계 |
| **SIP 트렁크** | 인터넷(SIP)으로 PSTN에 전화를 걸고 받을 수 있게 통신사가 열어 주는 "가상 회선 묶음". 채널 수 = 동시 통화 수 |
| **SBC** | 통신사(또는 기업)가 SIP 경계에 두는 관문. 인증, 보안, 코덱 정리를 맡음 |
| **IP-PBX** | 인터넷전화용 사설 교환기. Asterisk가 대표적인 오픈소스 IP-PBX |
| **DID / 발신번호** | 이 트렁크에 붙은 전화번호. 고객 화면에 뜨는 번호 |

---

## 3-5. SIP: 전화를 거는 대화

**SIP(Session Initiation Protocol, RFC 3261)**는 "통화를 시작하고 끝내는" 신호만 담당합니다. 실제 소리는 따로 RTP로 흐릅니다. SIP 메시지는 HTTP와 아주 비슷하게 생긴 텍스트입니다.

### 발신 한 통의 흐름

```text
Asterisk                         통신사 SBC                    고객
   │── INVITE (SDP: 코덱 제안) ───▶│                              │
   │◀──────── 100 Trying ──────────│                              │
   │                               │──────── 호출 ───────────────▶│
   │◀──────── 180 Ringing ─────────│          (벨이 울림)          │
   │◀─ 183 Session Progress (SDP) ─│  ← 연결 전 안내음(early media) │
   │◀──────── 200 OK (SDP 응답) ────│◀──────── 받음 ───────────────│
   │──────────── ACK ─────────────▶│                              │
   │═══════════ RTP 음성 (양방향) ══════════════════════════════════│
   │──────────── BYE ─────────────▶│         (끊음)               │
   │◀─────────── 200 OK ───────────│                              │
```

#### 깊이 보기: INVITE 한 통의 원문 (2026-11-05 추가)

이 절과 아래 깊이 보기들은 **원리**를 다룹니다. 통신사에 요구할 것과 Asterisk 설정 같은 **실무**는 [7-telephony-setup.md](../7-telephony-setup.md)에 있습니다.

위 그림의 첫 화살표(Asterisk → 통신사 SBC)를 글자 그대로 쓰면 이렇습니다. 번호·도메인·주소는 모두 가상입니다. SIP 메시지는 줄 끝이 CRLF(`\r\n`)이고, 헤더와 본문 사이에 빈 줄 하나가 있습니다.

```text
INVITE sip:01000000000@sbc.example.com SIP/2.0
Via: SIP/2.0/UDP 203.0.113.10:5060;branch=z9hG4bK-4b1f9a2c;rport
Max-Forwards: 70
From: <sip:07000000000@sbc.example.com>;tag=as5e3c1d2a
To: <sip:01000000000@sbc.example.com>
Call-ID: 3c2a1b0f9e8d7c6b@203.0.113.10
CSeq: 102 INVITE
Contact: <sip:07000000000@203.0.113.10:5060>
Content-Type: application/sdp
Content-Length: 238

v=0
o=- 1730790000 1730790000 IN IP4 203.0.113.10
s=-
c=IN IP4 203.0.113.10
t=0 0
m=audio 10000 RTP/AVP 8 0 101
a=rtpmap:8 PCMA/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:101 telephone-event/8000
a=fmtp:101 0-16
a=ptime:20
a=sendrecv
```

| 헤더 | 뜻 |
| --- | --- |
| 요청 줄 | 메서드(`INVITE`), 요청 URI(누구에게 거나), 버전. HTTP의 `GET /path HTTP/1.1`과 같은 자리 |
| `Via` | 응답이 되돌아올 길. 요청이 지나는 장비마다 한 줄씩 위에 쌓고, 응답은 그 줄을 하나씩 걷어 내며 돌아감. `branch`는 이 요청 한 번(트랜잭션)의 ID이고 반드시 `z9hG4bK`로 시작함(RFC 3261 8.1.1.7절, 이 규칙을 따르는 장비라는 표시). `rport`는 "응답을 실제로 패킷이 온 포트로 보내 달라"는 NAT 대비 표시 |
| `Max-Forwards` | 장비를 지날 때마다 1씩 줄여 0이 되면 버림. 무한 루프 방지. 권장값 70 |
| `From` / `To` | 논리적 발신자·수신자. `tag`는 이 통화(대화, dialog)에서 각자의 몫을 가르는 값. `To`의 tag는 상대가 응답에 붙여 줌 |
| `Call-ID` | 이 통화 전체의 ID. 재전송·인증 재시도·BYE까지 같은 값. 통신사 로그와 맞춰 볼 때의 열쇠 |
| `CSeq` | 순번 + 메서드. 같은 대화 안 요청의 순서. 인증 때문에 다시 보내면 숫자가 1 늘어남 |
| `Contact` | 이후 요청(BYE 등)을 직접 보낼 내 주소 |
| `Content-Type` / `Content-Length` | 본문(SDP)의 종류와 **바이트 수**. 위 SDP를 CRLF로 세면 238바이트 |

SDP는 3-2절의 WebRTC SDP와 같은 문법이지만 몇 가지가 다릅니다.

| 줄 | WebRTC (3-2절) | 전화망 SIP |
| --- | --- | --- |
| `m=` 전송 방식 | `UDP/TLS/RTP/SAVPF` (DTLS-SRTP 필수) | `RTP/AVP` (암호화 없는 RTP. SRTP를 쓰면 `RTP/SAVP`) |
| 주소 | `c=0.0.0.0`, 포트 9 + ICE 후보 | **`c=`와 `m=`에 실제 IP·포트를 바로 적음.** ICE가 없음 |
| 코덱 | Opus(동적 PT 111 등) | `8`(PCMA), `0`(PCMU) 고정 번호. 순서가 선호 순서 |
| `telephone-event` | 있음 | `101`(동적 번호) + `a=fmtp:101 0-16` = 이벤트 0~16을 보낼 수 있음(0~15는 숫자·`*`·`#`·A~D, 16은 flash) |

주소를 SDP에 바로 적는다는 점이 아래 "NAT 문제가 전화에서도 되풀이된다"의 원인입니다. ICE라는 자동 확인 절차가 없으니, 적힌 주소가 틀리면 그냥 소리가 안 갑니다.

#### 깊이 보기: 응답의 흐름 — 1xx, 2xx와 ACK, early media (2026-11-05 추가)

| 응답 | 종류 | 뜻 | 이후 |
| --- | --- | --- | --- |
| `100 Trying` | 임시(1xx) | 바로 다음 장비가 받았다. "재전송을 멈춰라" | 구간마다 따로 나옴. 끝에서 끝까지 가지 않음 |
| `180 Ringing` | 임시 | 상대 전화기의 벨이 울린다. SDP 없음 | 이때 `To`에 tag가 붙어 대화가 "임시로" 생김 |
| `183 Session Progress` + SDP | 임시 | **early media.** 받기(200) 전에 미디어 경로를 먼저 연다 | 통화연결음, "전원이 꺼져 있어…" 같은 안내가 RTP로 흐름 |
| `200 OK` + SDP | 최종 성공(2xx) | 받았다. SDP는 응답(answer) | 발신 쪽이 **ACK**를 보내야 끝남 |
| `4xx`·`5xx`·`6xx` | 최종 실패 | 486 통화 중, 480 부재 등(아래 표) | 발신 쪽이 ACK를 보냄 |

- **early media**는 "통화가 성립하기 전에 흐르는 소리"입니다. 고객 목소리가 아니라 통신사가 틀어 주는 소리이므로, 에이전트가 이걸 고객 발화로 받아 STT에 넣으면 안 됩니다. 아래 표의 "183의 안내음은 대화로 취급하지 않음"이 그 뜻입니다. LiveKit 문서도 early media가 있으면 183 직후부터 RTP가 흐른다고 적고 있습니다.
- 임시 응답(1xx)에는 ACK를 보내지 않습니다.
- **ACK는 2xx와 실패 응답에서 성격이 다릅니다**(RFC 3261 6절의 정의). 실패 응답에 대한 ACK는 그 INVITE 트랜잭션의 일부라 구간마다 처리됩니다. 200 OK에 대한 ACK는 **별도 트랜잭션**으로 끝에서 끝까지 갑니다. 받는 쪽은 ACK가 올 때까지 200 OK를 다시 보내고, 64×T1(32초) 동안 ACK가 없으면 BYE로 통화를 끊습니다(RFC 3261). NAT 때문에 ACK가 엉뚱한 곳으로 가면 "받자마자 소리는 나는데 30초 남짓에서 끊긴다"는 증상이 나오는 이유입니다(널리 알려진 사례이며, 이 프로젝트에서 겪은 것은 아닙니다).
- 미디어(RTP)는 SIP 메시지가 아니라 SDP에 적힌 주소로 **따로** 흐릅니다. SIP는 주로 처음과 끝(INVITE, BYE)에 등장하고, 통화 중에는 코덱·주소를 바꿀 때(re-INVITE 등)만 나옵니다.

### 응답 코드가 알려 주는 것

SIP 응답 코드는 HTTP처럼 숫자로 결과를 알려 줍니다. 자동 발신 시스템에서는 이 코드가 곧 **통화 결과 분류**가 됩니다([2-tech-stack.md 4-6](../2-tech-stack.md#4-6-자동응답음성사서함-감지)).

| 코드 | 뜻 | 우리 시스템에서의 처리 (계획) |
| --- | --- | --- |
| 180 / 183 | 울리는 중 / 연결 전 미디어 | 183의 안내음은 대화로 취급하지 않음 |
| 200 | 받음 | 대화 시작 |
| 486 Busy Here | 통화 중 | 나중에 재시도 |
| 480 Temporarily Unavailable | 응답 없음·전원 꺼짐 등 | 재시도 + 문자 |
| 404 Not Found | 없는 번호 | 데이터 확인 |
| 603 Decline | 거절 | 재시도 정책 판단 |

**주의:** 고객이 안 받으면 통신사가 "음성사서함으로 연결됩니다…"를 틀어 주는데, 이때는 SIP 입장에서 **200 OK(연결 성공)**입니다. 기계가 받은 것을 사람이 받은 것과 구분하려면 소리를 들어 봐야 합니다. 이것이 **자동응답 감지(AMD)** 문제이고, LiveKit Agents에도 관련 기능(`voice/amd.ts`)이 있습니다. 이 프로젝트에서는 아직 다루지 않았습니다.

#### 깊이 보기: 취소와 시간 초과 — CANCEL·487, Timer B (2026-11-05 추가)

**벨이 울리는 중에 그만두기.** 고객이 안 받아서 정해 둔 시간이 지나면, 발신 쪽은 INVITE를 거둬들이는 **CANCEL**을 보냅니다.

```text
발신 쪽                                받는 쪽
   │── INVITE (CSeq 103 INVITE) ──────▶│
   │◀──────── 180 Ringing ─────────────│
   │── CANCEL (CSeq 103 CANCEL) ──────▶│   같은 Call-ID·From·To·Via branch로 "그 INVITE"를 가리킴
   │◀──────── 200 OK (CANCEL에 대한) ───│
   │◀─ 487 Request Terminated (INVITE에 대한) │
   │── ACK ───────────────────────────▶│
```

- CANCEL에 대한 응답(200)과 원래 INVITE에 대한 응답(487)이 **따로** 옵니다. 487은 "우리가 취소했다"는 뜻이지 고객이 거절했다는 뜻(603)이 아닙니다. 통화 결과를 분류할 때 둘을 섞지 않습니다.
- 임시 응답(1xx)을 하나도 받기 전에는 CANCEL을 보내면 안 됩니다(RFC 3261 9.1절의 MUST NOT). 상대가 INVITE를 받았는지조차 모르기 때문입니다.
- CANCEL과 상대의 200 OK가 엇갈리면 통화가 성립해 버립니다. 그때는 ACK를 보낸 뒤 BYE로 끊어야 합니다.
- 벨 시간은 발신 쪽이 정합니다. LiveKit SIP로 직접 건다면 livekit-server-sdk의 `createSipParticipant` 옵션 `ringingTimeout`("Maximum time for the call to ring in seconds", `src/SipClient.ts` 175~176행)이 그 자리입니다. SDK는 `waitUntilAnswered`를 켜면 이 값을 30초로 채웁니다(`src/SipClient.ts` 783~784행, `src/dialTimeout.ts` 14행). 시간이 다 됐을 때 LiveKit이 CANCEL을 보내는지는 **추정**이고 확인 필요입니다. Asterisk를 거치면 Asterisk 쪽 설정도 함께 봐야 합니다.

**아무 응답도 없을 때: Timer B.** UDP에서는 INVITE 자체가 사라질 수 있습니다. 그래서 발신 쪽은 응답이 없으면 INVITE를 다시 보냅니다(Timer A). 간격은 T1(기본 500ms)에서 시작해 두 배씩 늘어나고, **Timer B = 64 × T1 = 32초**가 지나도 응답이 없으면 실패로 봅니다(RFC 3261 부록 A의 표, 17.1.1.2절). 실습 스크립트의 계산입니다.

```text
== 2. 응답이 하나도 없을 때 INVITE를 보내는 시각(초) ==
0, 0.5, 1.5, 3.5, 7.5, 15.5, 31.5 → 7번 보내고 32초에 Timer B 만료
```

- Timer B는 **100 Trying조차 안 올 때**의 시계입니다. 임시 응답을 하나라도 받으면 재전송을 멈추고 기다리는 상태로 넘어가므로, 벨이 오래 울리는 것은 Timer B로 끊기지 않습니다. 그건 위의 CANCEL 몫입니다.
- Timer A의 재전송은 UDP에서만 합니다. TCP·TLS는 전송 계층이 재전송을 맡습니다.
- 32초 동안 응답이 없다는 것은 대개 "주소가 틀렸거나 방화벽이 막았다"는 뜻입니다. 통화 결과로는 번호 문제가 아니라 **우리 쪽 설비 문제**로 분류해야 합니다.

### 등록(REGISTER)과 IP 인증

통신사가 "이 SIP 요청이 진짜 우리 고객사에서 온 것인지" 확인하는 방법은 둘입니다.

| 방식 | 동작 |
| --- | --- |
| **IP 인증** | 미리 알려 준 고정 공인 IP에서 온 요청만 받음 |
| **등록(REGISTER)** | 우리 장비가 ID/PW로 주기적으로 "나 여기 있어"라고 등록 |

LiveKit SIP는 REGISTER 방식을 지원하지 않습니다. 국내 회선은 등록 방식이 많아서, 중간에 **Asterisk를 두어 등록과 변환을 대신 맡기는** 구조를 택했습니다([2-tech-stack.md 5-3](../2-tech-stack.md#5-3-연결-방법)).

#### 깊이 보기: 401/407 다이제스트 인증 (2026-11-05 추가)

등록 방식의 "ID/PW"는 비밀번호를 그대로 보내지 않습니다. SIP는 HTTP의 **다이제스트 인증**을 빌려 씁니다(RFC 3261 22절, 계산식은 RFC 2617). 서버가 일회용 난수(nonce)를 주면, 클라이언트는 비밀번호와 nonce를 섞은 해시만 돌려보냅니다.

```text
Asterisk                                         통신사 SBC
   │── INVITE (CSeq 102, 인증 정보 없음) ─────────────▶│
   │◀─ 407 Proxy Authentication Required ─────────────│
   │     Proxy-Authenticate: Digest realm="sbc.example.com",
   │       nonce="5f2c9e0a1b3d4c6e", qop="auth", algorithm=MD5
   │── ACK (407에 대한) ─────────────────────────────▶│
   │── INVITE (CSeq 103, 같은 Call-ID) ───────────────▶│
   │     Proxy-Authorization: Digest username="07000000000", realm="sbc.example.com",
   │       nonce="5f2c9e0a1b3d4c6e", uri="sip:01000000000@sbc.example.com",
   │       response="ecb8a0f5c761b6bd77661a0125175b11", qop=auth, nc=00000001, cnonce="8d1f0c2b"
   │◀─ 100 Trying … (이후 3-5절 흐름) ─────────────────│
```

| 응답 | 누가 요구하나 | 짝을 이루는 헤더 |
| --- | --- | --- |
| `401 Unauthorized` | 최종 상대(등록 서버, 상대 전화기) | `WWW-Authenticate` → `Authorization` |
| `407 Proxy Authentication Required` | 중간 장비(프록시, SBC) | `Proxy-Authenticate` → `Proxy-Authorization` |

REGISTER에는 보통 401이, 발신 INVITE에는 통신사에 따라 401이나 407이 옵니다. 계산식은 다음과 같습니다(`qop=auth`인 경우).

```text
HA1      = MD5(사용자명 ":" realm ":" 비밀번호)
HA2      = MD5(메서드 ":" 요청 URI)            예: "INVITE:sip:01000000000@sbc.example.com"
response = MD5(HA1 ":" nonce ":" nc ":" cnonce ":" qop ":" HA2)
```

- 비밀번호는 선로에 나가지 않습니다. 서버도 같은 계산을 해 보고 맞는지만 봅니다.
- 서버가 정한 nonce가 매번 바뀌므로, 엿들은 `response`를 다음 통화에 다시 쓰기 어렵습니다. `nc`(이 nonce로 몇 번째 요청인가)와 클라이언트 난수 `cnonce`도 섞습니다.
- 메서드와 URI가 섞이므로 같은 `response`를 다른 번호로 거는 데 쓸 수 없습니다.
- 인증을 붙여 다시 보내는 INVITE는 새 트랜잭션이라 `CSeq`가 1 늘고, `Call-ID`는 그대로입니다.
- LiveKit SIP의 발신 트렁크에도 `authUsername`·`authPassword`가 있습니다(livekit-server-sdk `src/SipClient.ts`, 프로토콜 주석은 "Username and password used to authenticate with SIP server"). 그래서 INVITE에 대한 401/407에는 LiveKit도 답할 수 있는 것으로 보입니다(코드·주석으로 확인, 실제 통신사와의 동작은 확인 필요). LiveKit에 없는 것은 **주기적인 REGISTER**입니다.
- MD5는 오래된 해시입니다. SHA-256을 쓰는 확장(RFC 8760)이 있지만 통신사 장비가 지원하는지는 확인 필요입니다. 비밀번호를 길고 무작위로 정하고, 방화벽으로 SIP 포트를 통신사 주소에만 여는 것이 실질적인 방어입니다([7-telephony-setup.md 7장](../7-telephony-setup.md#7-보안-요금-폭탄-막기)).

**직접 돌려 보기:** [lab/03-sip-digest.mjs](lab/03-sip-digest.mjs)는 먼저 RFC 2617의 예로 계산식을 확인한 뒤, 위 가상 값으로 `response`를 만듭니다.

```text
== 1. RFC 2617 예 ==
6629fae49393a05397450978507c4ef1 (RFC의 값과 같음)

== 1. 두 번째 INVITE에 붙일 헤더 ==
Proxy-Authorization: Digest username="07000000000", realm="sbc.example.com", nonce="5f2c9e0a1b3d4c6e", uri="sip:01000000000@sbc.example.com", response="ecb8a0f5c761b6bd77661a0125175b11", algorithm=MD5, qop=auth, nc=00000001, cnonce="8d1f0c2b"
```

### NAT 문제가 전화에서도 되풀이된다

SDP 안에는 "음성을 이 IP·포트로 보내 줘"라는 주소가 들어 있습니다. 서버가 클라우드의 사설 IP(예: 10.x.x.x)를 SDP에 적어 보내면, 통신사는 그 주소로 음성을 보내다 실패합니다. 증상은 **"전화는 연결되는데 소리가 안 들린다"**입니다. GCE는 1:1 NAT 구조라 Asterisk 설정에 외부 IP를 명시해야 합니다([7-telephony-setup.md 6-2](../7-telephony-setup.md#6-2-통신사-연결-개통-후)의 `external_media_address`). WebRTC의 ICE가 풀던 문제가 전화망에서 설정 파일 한 줄로 다시 나타나는 셈입니다.

#### 깊이 보기: DTMF — 버튼은 소리가 아니라 이벤트로 (2026-11-05 추가)

전화 버튼("1번을 누르세요")은 원래 두 주파수를 섞은 소리(DTMF, Dual-Tone Multi-Frequency)입니다. 이 소리를 음성 패킷에 그대로 섞어 보내면, 압축 코덱이나 잡음 제거를 거치며 모양이 망가져 받는 쪽이 못 알아들을 수 있습니다. 그래서 인터넷 전화는 보통 **"어떤 버튼을 얼마나 오래 눌렀나"를 별도 RTP 패킷으로** 보냅니다(RFC 4733, 예전 번호 RFC 2833). SDP의 `telephone-event` 줄이 그 합의입니다.

페이로드는 4바이트입니다(RFC 4733 2.3절).

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|     event     |E|R|  volume   |          duration             |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

| 칸 | 비트 | 뜻 |
| --- | --- | --- |
| event | 8 | 0~9 = 숫자, 10 = `*`, 11 = `#`, 12~15 = A~D |
| E | 1 | 이 패킷이 이 누름의 끝이다 |
| R | 1 | 예약 |
| volume | 6 | 세기(0~63, −dBm0) |
| duration | 16 | 지금까지 누른 시간. RTP 클록(8kHz) 틱 단위 |

- 버튼 한 번은 패킷 **여러 개**입니다. 모두 같은 RTP timestamp(누르기 시작한 시각)를 달고, 첫 패킷에 M 비트를 켜고, duration이 점점 늘어납니다. 마지막 패킷은 E=1로 **세 번** 보내 손실에 대비합니다(RFC 4733 2.5.1절).

실습 스크립트([lab/03-sip-digest.mjs](lab/03-sip-digest.mjs))의 3번 출력입니다("5"를 100ms 누름, volume 10).

```text
시작 (M=1)  05 0a 00 a0  duration 160틱 = 20ms
진행        05 0a 01 40  duration 320틱 = 40ms
끝         05 8a 03 20  duration 800틱 = 100ms
```

둘째 바이트가 `0a`(`0000 1010`)에서 `8a`(`1000 1010`)로 바뀐 것이 E 비트(맨 앞 비트)입니다. 뒤 6비트 `001010`은 volume 10입니다.

- LiveKit SIP는 받은 DTMF를 방의 이벤트로 넘깁니다(LiveKit 문서 "Handling DTMF"). rtc-node에서는 `RoomEvent.DtmfReceived`로 받고(`rtc/room.ts` 856~858행), `localParticipant.publishDtmf(code, digit)`로 보냅니다(`rtc/participant.ts` 229행). 이 프로젝트는 아직 버튼 입력을 쓰지 않습니다. Asterisk 쪽 방식 설정(`dtmf_mode=rfc4733`)은 [7-telephony-setup.md 6-2](../7-telephony-setup.md#6-2-통신사-연결-개통-후)에 있습니다.

---

## 3-6. LiveKit SIP: 전화를 방으로

LiveKit SIP는 SIP 통화와 LiveKit 방을 이어 주는 다리입니다.

- **발신**: API로 "이 방에 SIP 참가자를 만들어라(번호: 010…, 트렁크: …)"라고 요청하면 LiveKit SIP가 INVITE를 보내고, 고객이 받으면 그 고객이 **방의 참가자**가 됩니다.
- **수신**: 대표번호로 걸려 온 전화를 배정 규칙(dispatch rule)에 따라 방으로 넣습니다.

에이전트 입장에서는 고객이 "SIP 종류의 참가자"로 보일 뿐, 오디오 트랙을 구독하는 방법은 같습니다. 이것이 이 프로젝트가 **전화 회선 없이 브라우저로 먼저 PoC를 할 수 있었던 이유**입니다. 브라우저 참가자를 SIP 참가자로 바꾸는 것은 앞단의 일이고, 에이전트 코드는 거의 바뀌지 않습니다.

전화 연결 단계에서 에이전트 쪽에 생길 변화는 주로 이런 것들입니다.

| 변화 | 이유 |
| --- | --- |
| 입력 음질이 8kHz 협대역이 됨 | 2장. STT 재측정 필요 |
| 노이즈 모델을 전화용으로 바꿀 수 있음 | 전화 잡음 특성이 다름 |
| 통화 종료 도구 | AI가 스스로 끊어야 함. (2026-11-05 갱신) 지금은 `end_call` 도구([src/agent.ts](../../src/agent.ts)의 `beta.createEndCallTool`)와 무응답·8분 상한([src/call-guard.ts](../../src/call-guard.ts))이 있음. 전화에서는 방 삭제가 BYE로 이어지는지 확인 필요 |
| 자동응답 감지 | 사서함에 떠들지 않게 |
| 고객 정보가 job metadata로 들어옴 | 4장. 지금은 가상 고객 |

---

## 3-7. 브라우저 쪽에서 본 연결: 접속 토큰과 클라이언트 (웹 테스트)

> 2026-11-03 추가. [6-web-test.md](../6-web-test.md)의 웹 테스트 기능을 바탕으로 썼습니다.

전화 회선이 준비되기 전에, 직원이 originalshq 관리 화면(`/log`의 "AI 상담원" 탭)에서 **브라우저로** 에이전트와 통화하는 기능이 생겼습니다. 이 기능은 "고객이 방에 들어오는" 쪽을 처음으로 직접 만든 것이라, 지금까지 에이전트 쪽에서만 본 연결을 반대편에서 볼 수 있게 해 줍니다.

### 흐름

```text
[관리 화면 /log]  가상 고객 정보 입력 → "통화 시작"
   │ ① POST createVoiceAgentSession   (Authorization: Bearer <Firebase ID 토큰>)
   ▼
[functions-xtool]  관리자 확인 → 새 방 이름 → 접속 토큰 발급 (에이전트 배정 + 고객 정보 포함)
   │ ② { serverUrl, roomName, participantToken }
   ▼
[브라우저] ──③ WebRTC 음성──▶ [LiveKit Cloud] ──배정──▶ [에이전트 워커]
```

**음성은 functions-xtool을 거치지 않습니다.** 함수는 토큰 하나 만들고 끝나는 짧은 요청이라 Cloud Functions에 잘 맞고, 실제 음성은 브라우저와 LiveKit 사이를 WebRTC로 직접 오갑니다. 4-1절의 "짧은 일은 서버리스, 긴 연결은 상주 워커"라는 역할 분담이 그대로 드러납니다.

### 접속 토큰: 비밀키를 브라우저에 주지 않고 입장시키기

LiveKit 방에 들어가려면 **접속 토큰(access token)**이 필요합니다. 토큰은 **JWT**(JSON Web Token)입니다. 내용(JSON)에 서명을 붙인 문자열로, 서명은 LiveKit API 비밀키로 만듭니다.

| 토큰에 들어가는 것 | 의미 |
| --- | --- |
| 참가자 identity | 방 안에서의 이름 |
| 권한(grant) | 어느 방에 들어갈 수 있나, 발행·구독할 수 있나 |
| 유효 시간 | 웹 테스트는 10분. **접속을 시작할 수 있는 기한**이지 통화 길이 제한이 아님 |
| 방 설정 (`roomConfig`) | 이 토큰으로 방에 들어오면 **에이전트 `xtool-sales-agent`를 배정하고, 고객 정보를 metadata로 넘겨라** (4-3절) |

- **비밀키는 서버(함수)에만** 있습니다. 브라우저는 서명된 결과만 받습니다. 브라우저가 토큰 내용을 바꾸면 서명이 맞지 않아 LiveKit이 거절합니다.
- (2026-11-05 추가) 다만 **서명이지 암호화가 아닙니다. 토큰을 가진 사람은 누구나 내용을 읽을 수 있습니다.** 바꾸지 못할 뿐입니다. 토큰의 metadata에 실린 고객 이름도 평문 JSON이라, 브라우저 개발자 도구나 토큰이 지나간 로그에서 그대로 보입니다(아래 "깊이 보기").
- 그래서 토큰 발급 함수가 **누가 토큰을 받을 수 있는지** 정하는 관문이 됩니다. 웹 테스트는 Firebase 로그인 토큰을 받아 등록된 관리자인지 확인합니다(없으면 401, 관리자가 아니면 403). 아무나 통화를 열면 STT·LLM·TTS 비용이 나가기 때문입니다.
- 방 이름은 요청마다 새로 만들고(`voice-test-<시각>-<무작위>`), 그 이름을 `callId`로 씁니다.

#### 깊이 보기: 토큰을 열어 보기 — JWT의 실물 (2026-11-05 추가)

**JWT의 모양.** JWT(RFC 7519)는 점 두 개로 나뉜 세 부분입니다.

```text
eyJhbGciOiJIUzI1NiJ9 . eyJ2aWRlbyI6eyJyb29tIjoidm9pY2UtdGVzdC0x… . 54WOdDydQHk5Yn-6A7OqzWlNrU6oVQv38zgUf4NPAIE
└──── header ──────┘   └──────────── payload ────────────────┘   └────────── signature ──────────────────┘
   {"alg":"HS256"}       {"video":{…},"roomConfig":{…},"iss":…}     HMAC-SHA256(비밀키, "header.payload")
```

- **base64url**은 바이트를 글자 64개로 적는 base64의 URL 안전판입니다. `+`·`/` 대신 `-`·`_`를 쓰고 끝의 `=` 채움을 뺍니다(RFC 4648 5절). URL 쿼리(`/rtc/v1?access_token=…`, 3-3절)에 그대로 넣을 수 있게 하려는 것입니다. **인코딩일 뿐 암호화가 아닙니다.**
- **HS256**은 HMAC-SHA256입니다(JWS, RFC 7515·7518). **HMAC**은 비밀키와 메시지를 섞어 해시하는 메시지 인증 코드입니다. 같은 키를 가진 쪽만 같은 값을 만들 수 있습니다. 키 하나를 양쪽(functions-xtool과 LiveKit 서버)이 나눠 가지는 대칭 방식이라, 만드는 쪽과 확인하는 쪽이 같은 비밀키를 압니다.
- 서명 대상은 **header와 payload의 base64url 문자열 그대로**(`"<header>.<payload>"`)입니다. JSON을 다시 정렬하거나 공백을 바꾸면 다른 값이 됩니다.

**실측: 웹 테스트와 같은 토큰을 가짜 키로 만들어 풀기.** [lab/03-jwt.mjs](lab/03-jwt.mjs)는 functions-xtool의 `createVoiceAgentSession`과 같은 호출(livekit-server-sdk 2.19.2의 `AccessToken`, `RoomConfiguration`, `RoomAgentDispatch`)을 `devkey`/`secret`이라는 가짜 키와 가상 고객으로 합니다. 이 SDK는 이 레포가 직접 설치하지 않고 `@livekit/agents`의 의존성으로 들어와 있어, 스크립트는 그 자리에서 찾아 씁니다. 디코드한 payload입니다(시각 값은 돌릴 때마다 다름).

```text
== 2. header ==
{ alg: 'HS256' }

== 2. payload ==
{
  "video": {
    "room": "voice-test-1700000000000-abcd1234",
    "roomJoin": true,
    "canPublish": true,
    "canSubscribe": true,
    "canPublishData": true
  },
  "roomConfig": {
    "name": "",
    "emptyTimeout": 0,
    "departureTimeout": 0,
    "maxParticipants": 0,
    "minPlayoutDelay": 0,
    "maxPlayoutDelay": 0,
    "syncStreams": false,
    "agents": [
      {
        "agentName": "xtool-sales-agent",
        "metadata": "{\"callId\":\"voice-test-1700000000000-abcd1234\",\"customerName\":\"홍길동\",\"device\":\"F2 울트라\",\"installment\":\"희망\"}",
        "restartPolicy": "JRP_ON_FAILURE",
        "deployment": "",
        "attributes": {}
      }
    ],
    "metadata": "",
    "tags": {}
  },
  "iss": "devkey",
  "exp": 1793884815,
  "nbf": 1793884215,
  "sub": "tester-0000abcd"
}
유효 시간 exp − nbf = 600초
metadata 안의 고객 이름: 홍길동
```

| 칸 | 값 | 뜻 |
| --- | --- | --- |
| header `alg` | `HS256` | 서명 방식. `typ`이나 `kid`는 없음 |
| `iss` | API 키 | 어느 키로 서명했나. 서버는 이 값으로 비밀키를 찾음. 키 **ID**는 공개돼도 되고 비밀키는 안 됨 |
| `sub` | `tester-…` | 참가자 identity |
| `nbf` / `exp` | 발급 시각 / 발급 + 600초 | 이 구간에만 유효(`ttl: '10m'`). `iat`은 없음. 위 표의 "접속을 시작할 수 있는 기한" |
| `video` | `room`, `roomJoin`, `canPublish`… | 권한(grant). 이 방에 들어가 발행·구독할 수 있음 |
| `roomConfig.agents[0]` | `agentName`, `metadata` | 배정할 에이전트와 job metadata(4-3절). **metadata는 JSON 문자열 안의 JSON이라 고객 이름이 그대로 보임** |
| `restartPolicy` | `JRP_ON_FAILURE` | 잡이 실패하면 다시 시작(프로토콜 주석: "restart when the job fails (default)", "cloud only"). 우리가 정하지 않은 기본값 |
| `deployment` | `""` | **배포 이름을 정하지 않음.** 4-3절의 "배포 이름을 생략하면 `production`으로 간다"가 토큰에서는 이 빈 문자열로 나타남. `lk agent dev`의 `dev-…` 워커에 안 닿을 수 있는 이유(확인 수준은 4-3절 그대로) |
| `emptyTimeout`, `departureTimeout`, `maxParticipants`, `min/maxPlayoutDelay` 등 | `0`·`""` | 우리가 정하지 않은 방 설정. 0은 "정하지 않음"이라 서버 기본값을 따르는 것으로 봄(**추정**). `departureTimeout`은 4-7절·15-6절의 방 유예 시간, `playoutDelay`는 받는 쪽 재생 지연 칸인데, `lk room create --help`는 "비디오용"이라고 설명합니다. 음성 지터 버퍼(2-6절)에는 영향이 없을 것으로 봄(**확인 필요**) |

정하지도 않은 칸이 잔뜩 있는 이유: `RoomConfiguration`은 protobuf 메시지이고, JWT 라이브러리가 `JSON.stringify`로 바꿀 때 protobuf-es의 `toJSON()`이 **기본값까지 모두 적도록**(`emitDefaultValues: true`) 되어 있기 때문입니다(`@bufbuild/protobuf` 1.10.1 `dist/esm/message.js` 109~113행).

**서명을 손으로 다시 계산하기.** `node:crypto`만으로 같은 값이 나옵니다.

```js
createHmac('sha256', 'secret').update(`${headerB64}.${payloadB64}`).digest('base64url');
```

```text
== 3. 서명 다시 계산 ==
토큰의 서명  : 54WOdDydQHk5Yn-6A7OqzWlNrU6oVQv38zgUf4NPAIE
다시 계산한 값: 54WOdDydQHk5Yn-6A7OqzWlNrU6oVQv38zgUf4NPAIE
일치: true

== 4. 검증 ==
원래 토큰  : tester-0000abcd 통과
바꾼 토큰  : 거절 → ERR_JWS_SIGNATURE_VERIFICATION_FAILED
다른 비밀키: 거절 → ERR_JWS_SIGNATURE_VERIFICATION_FAILED
```

4번은 payload의 고객 이름만 바꾸고 원래 서명을 붙인 토큰을 SDK의 `TokenVerifier`로 검증한 결과입니다. 서버가 하는 확인도 같은 원리입니다. 바꾸려면 서명을 다시 만들어야 하고, 그러려면 비밀키가 있어야 합니다.

**읽기와 바꾸기는 다르다.** 정리하면 이렇습니다.

| 하려는 일 | 필요한 것 |
| --- | --- |
| 토큰 내용(고객 이름 포함) 읽기 | **아무것도 필요 없음.** base64url 디코드뿐 |
| 토큰 내용 바꾸기 | API 비밀키 |

그래서 토큰에는 **들켜도 되는 것만** 실어야 합니다. 지금 웹 테스트는 관리자만 토큰을 받고 고객 정보도 가상이라 문제가 작습니다. 하지만 같은 모양으로 실제 고객 정보를 브라우저용 토큰에 실으면, 토큰을 가진 쪽(브라우저, 확장 프로그램, 토큰이 찍힌 로그)이 모두 그 정보를 봅니다. 토큰은 URL 쿼리(`access_token=`)로도 가므로 로그에 남기 쉽습니다(3-3절). 전화 발신을 서버끼리 배정하면(4-3절의 배정 API, 아직 후보) 토큰이 브라우저를 거치지 않으므로 이 문제가 없습니다. 브라우저용 토큰에 민감한 값을 실어야 한다면 `callId`만 싣고 에이전트가 나머지를 서버에서 가져오는 설계가 대안입니다(제안이며 구현하지 않았습니다).

**워커의 토큰.** 워커가 LiveKit에 등록할 때(4-2절)도 같은 SDK로 토큰을 만듭니다(`node_modules/@livekit/agents/src/worker.ts` 482~484행). 같은 호출을 스크립트로 해 본 결과입니다.

```text
== 5. 워커 토큰 payload ==
{
  video: { agent: true },
  iss: 'devkey',
  exp: 1793905815,
  nbf: 1793884215
} 유효 6시간
```

- 권한은 `{ agent: true }` 하나이고, 방 이름도 identity도 없습니다. 특정 방이 아니라 "에이전트로 등록할 수 있음"이라는 권한입니다.
- `ttl`을 주지 않아 SDK 기본값 6시간이 됩니다(livekit-server-sdk `src/AccessToken.ts` 15~16행 `defaultTTL = '6h'`). 워커는 재접속 고리 안에서 **연결할 때마다 새 토큰을 만듭니다**(같은 파일 479~484행). 이미 열린 WebSocket이 6시간 뒤 끊기는지는 서버 쪽 동작이라 **확인 필요**입니다.
- 이 토큰은 URL이 아니라 `Authorization: Bearer` 헤더로 보냅니다(같은 파일 489~491행).

### 화면 쪽 부품: 에이전트가 방에 내보내는 것이 곧 화면의 재료

관리 화면은 `@livekit/components-react`를 씁니다. 각 부품이 읽는 것은 4-6절의 RoomIO가 방에 내보내는 것들입니다.

| 화면 부품 | 하는 일 | 에이전트 쪽 대응 |
| --- | --- | --- |
| `LiveKitRoom` | 토큰과 서버 주소로 방에 접속, 마이크 발행 | RoomIO가 이 참가자를 고객으로 골라 구독 |
| `RoomAudioRenderer` | 방의 원격 오디오 트랙을 재생 | 에이전트가 발행한 TTS 오디오 트랙 |
| `useVoiceAssistant` | 에이전트 참가자와 상태(듣는 중·생각 중·말하는 중) | 참가자 속성 `lk.agent.state` |
| `useTranscriptions` | 대화 자막 | 텍스트 스트림 `lk.transcription` |

에이전트와 화면 사이에도 **보이지 않는 계약**이 있는 셈입니다. 에이전트 상태 이름이나 자막 형식은 SDK가 정하므로 우리가 맞출 일은 거의 없지만, 화면에 상태가 이상하게 깜빡이면(11-6절의 즉시 반응과 본 답 사이 `listening`) 그 원인은 에이전트 쪽에 있습니다.

### 브라우저 쪽 세부 사항

- **마이크 권한은 "안전한 출처"에서만** 받을 수 있습니다. 브라우저는 HTTPS나 `localhost`에서만 마이크 접근(`getUserMedia`)을 허용합니다. 배포 주소는 HTTPS라 문제없습니다.
- LiveKit 라이브러리는 `/log` 화면 조각에만 들어가도록 **지연 로딩**했습니다. 일반 방문자 페이지의 번들 크기에 영향이 없습니다.
- 확인 결과(2026-11-03): 토큰으로 방에 접속한 뒤 **2.8초 뒤 에이전트가 참가**했고, 첫 멘트가 보낸 정보대로("안녕하세요, 이영희 고객님. … 메탈팹 상담 신청해 주셔서 …") 나왔습니다. 2.8초에는 디스패치, 잡 프로세스 준비(개발 모드면 유휴 프로세스가 없어 그때 fork, 4-4절), 방 접속이 들어 있습니다. 단계별로 쪼개 보는 방법은 [4-3절 깊이 보기](04-worker-runtime.md#깊이-보기-28초를-쪼개기--디스패치-시각표-2026-11-06-추가)에 있습니다(2026-11-06 추가).

전화(SIP)로 바꾸면 ③의 브라우저가 SIP 참가자로 바뀔 뿐, 토큰에 담긴 고객 정보의 모양(metadata 계약)은 그대로 씁니다.

(2026-11-04 추가) 통화가 끝나면 같은 화면이 결과를 보여 줍니다. `LiveKitRoom`의 연결이 끊기면(`onDisconnected`) 방 이름을 `callId`로 기억해 두고, `getVoiceCall`을 3초마다 불러 요약·판정이 붙을 때까지 기다립니다. 연결이 끊기는 계기는 둘입니다. 에이전트가 방을 지워 끊는 경우와, 직원이 "통화 끝내기"를 눌러 스스로 나가는 경우입니다. 처음에는 뒤쪽 결과가 방이 닫히는 규칙 때문에 늦게 도착했습니다. (2026-11-04 고침) 지금은 세션이 닫힐 때 에이전트가 방을 지우므로 두 경우 모두 바로 끝납니다(15-6절 "끝나는 경로별 시간표").

---

## 3-8. 국내 전화망의 현실적인 장애물

기술보다 제도와 계약이 더 어렵습니다. 자세한 내용은 [2-tech-stack.md 5장](../2-tech-stack.md#5-전화-회선-가장-큰-장애물)과 [7-telephony-setup.md](../7-telephony-setup.md)에 있고, 여기서는 이유만 정리합니다.

1. **해외 통신사로 걸면 국제전화로 표시됩니다.** 방통위 가이드라인에 따라 해외 발신은 00X가 붙습니다. 고객은 받지 않습니다.
2. **국내 SIP 상품은 "그 통신사 회선 위에서만" 되는 경우가 많습니다.** 클라우드 서버에서 인터넷으로 붙을 수 있는지가 첫 질문입니다.
3. **AI 자동 발신이 약관상 허용되는지** 확인해야 합니다.
4. **요금 폭탄:** 인터넷에 열린 SIP 서버는 국제전화 무단 발신 공격을 받습니다. 방화벽, 발신 규칙(010만), 국제전화 차단이 필수입니다([7-telephony-setup.md 7장](../7-telephony-setup.md#7-보안-요금-폭탄-막기)).

---

## 3-9. 정리

| 개념 | 핵심 |
| --- | --- |
| 접속 토큰 (JWT) | 서버가 비밀키로 서명한 입장권. 에이전트 배정과 고객 정보까지 실을 수 있음. (2026-11-05 갱신) 서명이지 암호화가 아니므로 누구나 읽을 수 있음 |
| 클라이언트 부품 | 에이전트가 내보내는 오디오·상태 속성·자막 스트림을 화면이 읽음 |
| UDP + RTP | 늦은 데이터는 쓸모없으므로 재전송하지 않는 전송 |
| ICE / STUN / TURN | NAT 너머 상대를 찾는 WebRTC의 절차 |
| SDP | 코덱·주소를 적은 미디어 명세서. WebRTC와 SIP가 같이 씀 |
| SFU | 섞지 않고 골라 전달하는 서버. LiveKit |
| Room / Participant / Track | LiveKit의 데이터 모델. 에이전트도 참가자 |
| SIP | 통화 시작·종료 신호. 응답 코드가 통화 결과 |
| SIP 트렁크 / SBC / Asterisk | 인터넷과 전화망을 잇는 장치들 |
| LiveKit SIP | 전화 고객을 방의 참가자로 바꿔 줌 → 에이전트 코드는 그대로 |
| RTP 헤더 (2026-11-05 추가) | 12바이트. PT = 코덱 번호, seq = 몇 번째 패킷, timestamp = 언제의 소리(Opus는 48kHz 클록, 20ms = 960), SSRC = 흐름 ID |
| SRTP (2026-11-05 추가) | 헤더는 평문·인증, 페이로드만 암호화, 끝에 인증 태그(기본 10바이트). SFU 구간마다 따로 |
| 후보 우선순위 (2026-11-05 추가) | 2²⁴·type + 2⁸·local + (256 − component). host > srflx > relay |
| STUN / XOR-MAPPED-ADDRESS (2026-11-05 추가) | 20바이트 헤더 + 매직 쿠키 0x2112A442. 주소는 NAT가 못 알아보게 XOR. ICE 연결 검사·동의 갱신도 STUN |
| DTLS-SRTP (2026-11-05 추가) | ICE로 정한 길에서 DTLS로 SRTP 키를 만듦. 인증서는 SDP의 `a=fingerprint`로 확인 |
| rtc-node FFI (2026-11-05 추가) | JS ↔ 네이티브(Rust + libwebrtc)를 protobuf 바이트로. 지터 버퍼·디코드·리샘플은 네이티브 |
| SIP 원문·다이제스트·CANCEL·Timer B (2026-11-05 추가) | INVITE는 텍스트 헤더 + SDP. 401/407은 nonce로 비밀번호 해시. 벨 중 취소는 487. 무응답은 32초 |
| DTMF (2026-11-05 추가) | 버튼을 소리가 아니라 RTP 이벤트(telephone-event)로 보냄 |

---

## 확인 문제

1. 실시간 음성에서 TCP의 재전송이 오히려 해가 되는 이유를 "Head-of-Line Blocking"으로 설명해 보세요.
2. SFU와 MCU의 차이는 무엇이고, LiveKit은 어느 쪽입니까?
3. 에이전트 코드가 브라우저 고객과 전화 고객을 거의 구분하지 않아도 되는 이유는 무엇입니까?
4. 음성사서함이 응답한 통화는 SIP 응답 코드로 무엇이 오며, 그래서 어떤 추가 처리가 필요합니까?
5. "전화는 연결되는데 소리가 안 들린다"는 증상의 가장 흔한 원인은 무엇입니까?
6. 웹 테스트에서 브라우저가 접속 토큰의 고객 정보를 바꿔 다른 이름으로 통화를 열 수 없는 이유는?
7. (2026-11-05 추가, 손 계산) G.711 μ-law를 ptime 20ms, IPv4, SRTP(`AES_CM_128_HMAC_SHA1_80`)로 보낼 때 한 방향 대역폭은 몇 kbps입니까? ptime을 10ms로 줄이면 얼마가 되고, 왜 늘어납니까?
8. (2026-11-05 추가, 손 계산) STUN Binding 성공 응답에서 XOR-MAPPED-ADDRESS의 값 8바이트가 `00 01 cf 5a e7 21 c0 56`입니다. 바깥에서 본 내 주소(IP:포트)는 무엇입니까? 주소를 굳이 XOR해서 보내는 이유는 무엇입니까?
9. (2026-11-05 추가) 웹 테스트의 접속 토큰을 손에 넣은 사람은 (가) 토큰 안의 고객 이름을 읽을 수 있습니까? (나) 이름을 바꿔 통화를 열 수 있습니까? 각각 무엇이 필요하고, 그래서 브라우저용 토큰에는 무엇을 실으면 안 됩니까?
10. (2026-11-05 추가, 손 계산) UDP로 보낸 발신 INVITE에 대해 (가) `100 Trying`조차 오지 않으면 INVITE를 몇 번 보내고 몇 초 뒤 실패로 봅니까(T1 = 500ms)? (나) `180 Ringing`을 받은 뒤 우리가 벨을 그만두면 어떤 메시지가 오가고, 원래 INVITE에는 어떤 응답이 옵니까?

<details>
<summary>답 보기</summary>

1. TCP는 잃어버린 패킷이 다시 올 때까지 뒤 패킷을 붙잡아 두므로, 20ms 하나 때문에 그 뒤 소리 전체가 멈춥니다. 음성은 늦으면 쓸모가 없어 차라리 버리고 넘어가는 편이 낫습니다.
2. MCU는 서버가 소리를 섞어 하나로 보내고, SFU는 섞지 않고 골라 전달합니다. LiveKit은 SFU입니다.
3. LiveKit SIP가 전화 고객을 방의 참가자로 바꿔 주기 때문입니다. 에이전트는 어느 경우든 참가자의 오디오 트랙을 구독합니다.
4. 200 OK(연결 성공)가 옵니다. 사람과 구분하려면 소리를 듣고 판정하는 자동응답 감지가 필요합니다.
5. NAT. 서버가 SDP에 사설 IP를 적어 보내 상대가 음성을 엉뚱한 주소로 보내는 경우입니다.
6. 토큰은 서버만 가진 비밀키로 서명되어 있어, 내용을 바꾸면 서명이 맞지 않아 LiveKit이 거절하기 때문입니다.
7. 20ms: 페이로드 160 + RTP 12 + UDP 8 + IPv4 20 + 태그 10 = 210바이트, × 50패킷/초 × 8 = **84kbps**. 10ms: 80 + 50 = 130바이트, × 100패킷/초 × 8 = **104kbps**. 패킷마다 붙는 50바이트가 패킷 수만큼 늘어나므로, 페이로드 몫(64kbps)은 그대로인데 헤더 몫이 20kbps에서 40kbps로 두 배가 됩니다.
8. `00`은 예약, `01`은 IPv4입니다. 포트: `0xCF5A XOR 0x2112 = 0xEE48 = 61000`. 주소: `e7^21 = c6(198)`, `21^12 = 33(51)`, `c0^a4 = 64(100)`, `56^42 = 14(20)` → **198.51.100.20:61000**. XOR하는 이유는 패킷 본문에서 자기 공인 IP처럼 보이는 32비트 값을 찾아 고쳐 쓰는 NAT(ALG)가 있어서입니다. 그대로 적으면 주소가 망가지고 무결성 검사가 깨집니다. 암호화가 아니라 위장입니다.
9. (가) 예. 아무것도 필요 없습니다. payload는 base64url로 인코딩된 JSON일 뿐이라 디코드하면 읽힙니다. (나) 아니요. 바꾸면 HMAC-SHA256 서명이 맞지 않고, 다시 서명하려면 functions-xtool과 LiveKit만 가진 API 비밀키가 필요합니다. 그래서 들키면 안 되는 정보(실제 고객의 개인정보, 비밀 값)는 브라우저용 토큰에 싣지 않습니다.
10. (가) 0, 0.5, 1.5, 3.5, 7.5, 15.5, 31.5초에 **7번** 보내고, Timer B(64 × T1 = **32초**)가 지나면 실패로 봅니다. (나) 우리가 CANCEL을 보내면 상대가 CANCEL에 200 OK를, 원래 INVITE에 **487 Request Terminated**를 보내고, 우리가 487에 ACK합니다. 487은 우리가 취소했다는 뜻이라 고객의 거절(603)과 구분해 기록합니다.

</details>
