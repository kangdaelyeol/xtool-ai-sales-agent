// 16장 실습: 자격 증명 체인이 실제로 하는 일 — 순서 뒤집기와, 요청마다 다시 찾기
// (학습서 16-4절 "깊이 보기: 체인의 실제 동작").
//  1) AWS_PROFILE과 환경변수 키가 함께 있을 때: Node 기본 체인(fromNodeProviderChain)은 프로필 키를,
//     Bedrock SDK(core/auth.js의 createCredentialChain(fromEnv, …))는 환경변수 키를 씀
//  2) 웹 ID 토큰(AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN)일 때: 가짜 STS(127.0.0.1)를 세워 Bedrock 요청 3번에
//     STS AssumeRoleWithWebIdentity가 몇 번 가는지 셈. STS 응답에 40ms 지연을 넣어 요청마다 늘어나는 시간도 봄
//  3) 같은 일을 providerChainResolver로 체인을 한 번만 만들어 넘기면(기억하는 체인) 몇 번 가나
//  4) 인스턴스 메타데이터(IMDS)일 때: 가짜 IMDS(127.0.0.1)로 요청 2번에 HTTP가 몇 번 가나
//
// 실행: 레포 루트에서  node docs/1-study/lab/16-credential-chain.mjs   (1초 안팎)
// 기준: Node 24, @anthropic-ai/bedrock-sdk 1.1.1, @aws-sdk/credential-providers 3.1161.0,
//       @aws-sdk/credential-provider-node 3.972.92. 2026-11-06 작성.
// 키·토큰은 모두 지어낸 값이고, STS·IMDS는 127.0.0.1의 가짜 서버입니다(AWS_ENDPOINT_URL_STS,
// AWS_EC2_METADATA_SERVICE_ENDPOINT로 돌림). 실제 ~/.aws와 .env.local을 읽지 않도록 임시 폴더의 파일만 가리킵니다.
// Bedrock 요청은 fetch를 가로채 AWS로 나가지 않습니다.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const fromBedrock = createRequire(require.resolve('@anthropic-ai/bedrock-sdk'));
const { createCredentialChain, fromEnv, fromNodeProviderChain } = fromBedrock('@aws-sdk/credential-providers');

const dir = mkdtempSync(join(tmpdir(), 'lab16-chain-'));
const SECRET = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
function resetEnv(extra) {
  for (const name of Object.keys(process.env)) if (name.startsWith('AWS_')) delete process.env[name];
  Object.assign(process.env, {
    AWS_CONFIG_FILE: join(dir, 'config'), // 없는 파일 → 프로필 단계는 빈손
    AWS_SHARED_CREDENTIALS_FILE: join(dir, 'credentials'),
    AWS_EC2_METADATA_DISABLED: 'true', // 4번 전까지는 169.254.169.254로 나가지 않게
    AWS_REGION: 'ap-northeast-1',
    ...extra,
  });
}
resetEnv({});
const { createBedrockClient } = await import('../../../src/models/index.ts');

const seen = [];
const fakeFetch = async (input, init) => {
  const auth = new Request(input, init).headers.get('authorization') ?? '';
  seen.push({ at: performance.now(), keyId: /Credential=([^/]+)/.exec(auth)?.[1] });
  return new Response('{"message":"fake"}', { status: 400, headers: { 'content-type': 'application/json' } });
};
const ask = (client) =>
  client.messages
    .create({ model: 'jp.anthropic.claude-haiku-5-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] })
    .catch(() => {});
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

try {
  // ── 1. AWS_PROFILE이 있으면 순서가 뒤집힘 ──────────────────────
  console.log('== 1. AWS_PROFILE=demo와 환경변수 키가 함께 있을 때 ==');
  writeFileSync(join(dir, 'credentials'), `[demo]\naws_access_key_id = AKIDPROFILEEXAMPLE\naws_secret_access_key = ${SECRET}\n`);
  resetEnv({ AWS_PROFILE: 'demo', AWS_ACCESS_KEY_ID: 'AKIDENVEXAMPLE', AWS_SECRET_ACCESS_KEY: SECRET });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (msg) => warnings.push(String(msg).split('\n').slice(0, 4).join(' ').replace(/\s+/g, ' '));
  const nodeChain = await fromNodeProviderChain()();
  console.warn = realWarn;
  console.log(`Node 기본 체인        → ${nodeChain.accessKeyId}  (환경변수를 건너뛰고 프로필)`);
  console.log(`  그때 나온 경고: ${warnings[0]?.slice(0, 160)}…`);
  seen.length = 0;
  await ask(createBedrockClient().withOptions({ fetch: fakeFetch }));
  console.log(`Bedrock SDK 체인      → ${seen[0].keyId}  (fromEnv를 맨 앞에 둬서 환경변수가 이김)`);
  rmSync(join(dir, 'credentials'));

  // ── 2. 웹 ID 토큰 + 가짜 STS ───────────────────────────────────
  console.log('\n== 2. 웹 ID 토큰으로 역할 맡기: Bedrock 요청 3번에 STS 호출 몇 번? ==');
  const stsCalls = [];
  let shownSts = false;
  const sts = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stsCalls.push({ body, signed: 'authorization' in req.headers });
      const expiration = new Date(Date.now() + 3600_000).toISOString();
      // AWS STS 문서의 AssumeRoleWithWebIdentity 응답 모양(값은 지어냄)
      const xml = `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
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
      <SecretAccessKey>${SECRET}</SecretAccessKey>
      <SessionToken>FAKE-SESSION-TOKEN</SessionToken>
      <Expiration>${expiration}</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
  <ResponseMetadata><RequestId>00000000-0000-0000-0000-000000000000</RequestId></ResponseMetadata>
</AssumeRoleWithWebIdentityResponse>`;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(xml);
      }, 40); // 왕복 40ms라고 가정(서울–도쿄 RTT 약 41ms, 13장 실측과 비슷한 값)
      if (!shownSts) {
        shownSts = true;
        console.log('  STS가 받은 첫 요청 본문(토큰은 줄임):');
        console.log(`    ${decodeURIComponent(body).replace(/WebIdentityToken=[^&]+/, 'WebIdentityToken=<토큰 파일 내용>')}`);
        console.log(`    Authorization 머리글: ${'authorization' in req.headers ? '있음' : '없음 (서명하지 않는 호출. 토큰 자체가 증명)'}`);
        console.log('  돌려준 응답 모양:');
        console.log(xml.replace(/^/gm, '    │'));
      }
    });
  });
  const stsPort = await listen(sts);
  writeFileSync(join(dir, 'token'), 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJodHRwczovL2FjY291bnRzLmdvb2dsZS5jb20ifQ.fake-signature');
  resetEnv({
    AWS_WEB_IDENTITY_TOKEN_FILE: join(dir, 'token'),
    AWS_ROLE_ARN: 'arn:aws:iam::123456789012:role/gke-bedrock-role',
    AWS_ROLE_SESSION_NAME: 'voice-agent-pod',
    AWS_ENDPOINT_URL_STS: `http://127.0.0.1:${stsPort}`,
  });

  async function run(label, client) {
    stsCalls.length = 0;
    seen.length = 0;
    const rows = [];
    for (let i = 1; i <= 3; i++) {
      const start = performance.now();
      await ask(client);
      rows.push(`요청 ${i}: 서명 키 ${seen.at(-1).keyId}, fetch까지 ${Math.round(seen.at(-1).at - start)}ms, STS 누적 ${stsCalls.length}번`);
    }
    console.log(`\n  [${label}]`);
    for (const row of rows) console.log(`    ${row}`);
  }
  await run('지금 코드(createBedrockClient)', createBedrockClient().withOptions({ fetch: fakeFetch }));

  // ── 3. 기억하는 체인을 넘기면 ──────────────────────────────────
  const remembered = createCredentialChain(fromEnv(), fromNodeProviderChain()); // SDK와 같은 순서, 한 번만 만듦
  await run(
    '체인을 한 번 만들어 providerChainResolver로 넘김',
    createBedrockClient().withOptions({ fetch: fakeFetch, providerChainResolver: async () => remembered }),
  );
  sts.close();

  // ── 4. IMDS ────────────────────────────────────────────────────
  console.log('\n== 4. EC2 인스턴스 메타데이터(IMDSv2)일 때: 요청 2번에 HTTP 몇 번? ==');
  const imdsCalls = [];
  const imds = createServer((req, res) => {
    imdsCalls.push(`${req.method} ${req.url}`);
    if (req.method === 'PUT' && req.url === '/latest/api/token') return res.end('FAKE-IMDS-SESSION-TOKEN');
    if (req.url === '/latest/meta-data/iam/security-credentials/') return res.end('voice-agent-role');
    if (req.url === '/latest/meta-data/iam/security-credentials/voice-agent-role') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({
          Code: 'Success',
          Type: 'AWS-HMAC',
          AccessKeyId: 'ASIAEXAMPLEEXAMPLE00',
          SecretAccessKey: SECRET,
          Token: 'FAKE',
          Expiration: new Date(Date.now() + 6 * 3600_000).toISOString(),
          LastUpdated: new Date().toISOString(),
        }),
      );
    }
    res.writeHead(404).end();
  });
  const imdsPort = await listen(imds);
  resetEnv({ AWS_EC2_METADATA_SERVICE_ENDPOINT: `http://127.0.0.1:${imdsPort}` });
  delete process.env.AWS_EC2_METADATA_DISABLED;
  const imdsClient = createBedrockClient().withOptions({ fetch: fakeFetch });
  for (let i = 1; i <= 2; i++) {
    await ask(imdsClient);
    console.log(`  요청 ${i} 뒤 IMDS 호출 누적 ${imdsCalls.length}번`);
  }
  console.log(`  한 요청의 순서: ${imdsCalls.slice(0, 3).join(' → ')}`);
  imds.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
