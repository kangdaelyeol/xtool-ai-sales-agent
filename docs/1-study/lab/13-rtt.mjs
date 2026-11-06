// 13장 실습: HTTPS 요청 하나가 첫 바이트를 받기까지 왕복(RTT)이 몇 번 드는지 손으로 계산하고, 원하면 curl로 잽니다 (학습서 13-2절).
//   1) 빛의 속도로 본 왕복의 바닥: 광섬유 속 빛은 1ms에 약 200km → 거리 d km면 왕복 최소 d ÷ 100 ms
//   2) 새 연결과 재사용의 왕복 수: DNS + TCP 1왕복(RFC 9293) + TLS 1.3 1왕복(RFC 8446) + 요청→첫 바이트 1왕복 + 서버 처리
//      TLS 1.2(2왕복)도 비교. RTT 값은 실측(아래 3번, 2026-11-06)과 "대략"을 구분해 씀
//   3) (선택, --curl) curl로 api.anthropic.com과 Bedrock 도쿄(bedrock-runtime.ap-northeast-1)에 **키 없이** POST를 보내
//      401·403만 받으며 구간 시간을 잼. 같은 연결을 두 번 더 써서 재사용도 잼. 시간과 상태 코드만 찍고 IP·호스트 해석 결과는 찍지 않음
//
// 실행: 레포 루트에서
//   node docs/1-study/lab/13-rtt.mjs              (계산만, 네트워크 없음, 바로 끝남)
//   node docs/1-study/lab/13-rtt.mjs --curl 5     (curl 측정 5회씩, 5초 남짓. 키 없이 거절만 받으므로 과금 없음)
// 기준: Node.js 24, curl 8.x. 2026-11-06 작성. 키·.env.local을 쓰지 않습니다.
// Node 쪽(SDK 0.33의 node-fetch, Node 내장 fetch)이 HTTP/1.1을 쓰므로 curl도 --http1.1로 맞춥니다.
// 출처
//   TCP 3방향 악수                RFC 9293 3.5절 (SYN → SYN,ACK → ACK, 데이터는 셋째와 함께)
//   TLS 1.3 전체 악수 1왕복, 0-RTT  RFC 8446 2절, 2.3절(0-RTT는 재전송 공격에 안전하지 않음), 8절
//   연결 유휴 4초 종료             학습서 8-8절, 17-2 #28
import { execFileSync } from 'node:child_process';

// ── 1. 빛의 속도로 본 바닥 ─────────────────────────────────────────────
console.log('1) 광섬유 속 빛(약 200km/ms)으로 본 왕복의 바닥 (거리는 대략, 실제 경로는 더 김)');
const routes = [
  ['서울 → 도쿄', 1_160],
  ['서울 → 미국 서부(샌프란시스코 근처)', 9_000],
  ['서울 → 미국 동부(버지니아 근처)', 11_100],
];
for (const [name, km] of routes) {
  console.log(
    `   ${name.padEnd(28)} 약 ${String(km).padStart(6)}km → 왕복 최소 ${(km / 100).toFixed(0).padStart(4)}ms`,
  );
}

// ── 2. 왕복 수 계산 ──────────────────────────────────────────────────
console.log(
  '\n2) 첫 바이트까지: 새 연결 = DNS + TCP(1 RTT) + TLS 1.3(1 RTT) + 요청(1 RTT) + 서버 / 재사용 = 요청(1 RTT) + 서버',
);
// r: 클라이언트와 TLS를 끝내는 곳(접속 지점) 사이의 왕복. back: 접속 지점 뒤로 다녀오는 몫(서버 처리 포함)
const cases = [
  { name: 'Bedrock 도쿄 (실측 RTT 약 41ms)', r: 41, back: 2 },
  { name: 'Anthropic 접속 지점 (실측 RTT 약 7ms)', r: 7, back: 200 },
  { name: '미국 서부를 바로 (RTT 대략 130ms)', r: 130, back: 2 },
  { name: '미국 동부를 바로 (RTT 대략 180ms)', r: 180, back: 2 },
];
const dnsWarm = 5; // OS 캐시에 있을 때 (실측 범위 3~8ms)
console.log(
  `   ${'경로'.padEnd(36)}${'새 연결 TLS1.3'.padStart(16)}${'새 연결 TLS1.2'.padStart(16)}${'재사용'.padStart(10)}${'다시 맺는 비용'.padStart(16)}`,
);
for (const { name, r, back } of cases) {
  const reuse = r + back;
  const fresh13 = dnsWarm + r + r + reuse;
  const fresh12 = dnsWarm + r + 2 * r + reuse;
  console.log(
    `   ${name.padEnd(36)}${`${fresh13}ms`.padStart(16)}${`${fresh12}ms`.padStart(16)}${`${reuse}ms`.padStart(10)}${`+${fresh13 - reuse}ms`.padStart(16)}`,
  );
}
console.log(
  '   (back = 접속 지점 뒤의 몫. Anthropic의 200ms는 아래 3번에서 키 없는 401이 돌아오기까지 걸린 값을 그대로 넣은 것)',
);
console.log('   다시 맺는 비용 = DNS + 2 RTT. 접속 지점이 가까우면 뒤가 멀어도 이 비용은 작음');

// ── 3. curl 측정 (선택) ───────────────────────────────────────────────
const i = process.argv.indexOf('--curl');
if (i < 0) {
  console.log('\n3) curl 측정은 --curl을 붙이면 돌립니다 (키 없이 거절 응답만 받음).');
  process.exit(0);
}
const runs = Number(process.argv[i + 1] ?? 5) || 5;
const targets = [
  ['api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
  ['Bedrock 도쿄', 'https://bedrock-runtime.ap-northeast-1.amazonaws.com/model/lab/invoke'],
];
// 한 번의 curl 실행에서 같은 주소를 세 번 보냄: 첫째는 새 연결, 둘째·셋째는 재사용
const FMT =
  '%{http_code} %{num_connects} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer}\\n';
function once(url) {
  const req = [
    '-o',
    '/dev/null',
    '-w',
    FMT,
    '-X',
    'POST',
    '-H',
    'content-type: application/json',
    '-d',
    '{}',
    url,
  ];
  const out = execFileSync(
    'curl',
    ['--http1.1', '-s', '--max-time', '15', ...req, ...req, ...req],
    {
      encoding: 'utf8',
    },
  );
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const [code, conns, dns, tcp, tls, ttfb] = line.split(' ');
      const ms = (x) => Number(x) * 1000;
      return {
        code,
        fresh: conns !== '0',
        dns: ms(dns),
        tcp: ms(tcp) - ms(dns),
        tls: ms(tls) - ms(tcp),
        wait: ms(ttfb) - (conns !== '0' ? ms(tls) : 0),
        ttfb: ms(ttfb),
      };
    });
}
console.log(`\n3) curl 측정 (HTTP/1.1, 키 없음, ${runs}회씩, 시간은 ms. IP는 찍지 않음)`);
const f = (x) => x.toFixed(1).padStart(7);
const span = (xs) => `${Math.min(...xs).toFixed(1)}~${Math.max(...xs).toFixed(1)}`;
for (const [name, url] of targets) {
  const fresh = [];
  const reused = [];
  console.log(`   ${name}`);
  console.log('      회  상태  연결      DNS      TCP      TLS  요청→첫바이트  첫 바이트(누적)');
  for (let k = 1; k <= runs; k++) {
    for (const [j, m] of once(url).entries()) {
      (m.fresh ? fresh : reused).push(m);
      console.log(
        `     ${String(k).padStart(2)}.${j + 1}  ${m.code}  ${m.fresh ? '새로' : '재사용'.padEnd(3)}  ${m.fresh ? f(m.dns) : '      -'}  ${m.fresh ? f(m.tcp) : '      -'}  ${m.fresh ? f(m.tls) : '      -'}  ${f(m.wait).padStart(13)}  ${f(m.ttfb).padStart(14)}`,
      );
    }
  }
  console.log(
    `     범위: 새 연결 DNS ${span(fresh.map((m) => m.dns))}, TCP ${span(fresh.map((m) => m.tcp))}, TLS ${span(fresh.map((m) => m.tls))}, 요청→첫 바이트 ${span(fresh.map((m) => m.wait))}, 첫 바이트 ${span(fresh.map((m) => m.ttfb))}`,
  );
  console.log(`           재사용 요청→첫 바이트 ${span(reused.map((m) => m.wait))}`);
  // 악수 메시지와 협상된 TLS 판. curl -v 출력에서 TLS 줄만 남기고, 숫자 주소가 든 줄은 버림
  const verbose = execFileSync(
    'sh',
    ['-c', `curl --http1.1 -sv -o /dev/null -X POST -d '{}' '${url}' 2>&1 || true`],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((l) => /TLS handshake|SSL connection using|ALPN: server/.test(l))
    .filter((l) => !/\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}:[0-9a-f]{1,4}:/i.test(l));
  for (const line of verbose) console.log(`     ${line.replace(/^\* \(\d+\) /, '* ')}`);
}
