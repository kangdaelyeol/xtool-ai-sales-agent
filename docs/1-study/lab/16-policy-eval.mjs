// 16장 실습: IAM 정책 평가를 손으로 따라 하는 장난감 평가기
// (학습서 16-5절 "깊이 보기: 정책 평가를 손으로 따라 하기").
//  1) 요청 하나 = (주체, 동작, 자원, 조건 값). 정책 문장마다 효과·동작·자원·조건이 맞는지 표로 찍음
//  2) 평가 순서: 명시적 거부 → SCP 허용 → (자원 기반 정책 허용) → 신원 기반 허용 → 권한 경계 → 세션 정책
//  3) 이번 거절을 다시 돌려 봄: #4(API 키, SCP 거부), #6(양식 제출, 작업 계정/관리 계정), 16-5절 최소 권한 정책으로
//     jp. 프로필·오사카 기본 모델·프로필 없이 부르기·global. 프로필, 권한 경계를 도쿄만으로 좁혔을 때
//  4) 신뢰 정책(누가 이 역할을 맡을 수 있나): 구글 ID 토큰으로 AssumeRoleWithWebIdentity (16-9절)
//
// 실행: 레포 루트에서  node docs/1-study/lab/16-policy-eval.mjs
// 기준: Node 24, AWS IAM 문서 "Policy evaluation logic"(같은 계정 안의 요청)을 줄여 옮긴 것. 2026-11-06 작성.
// 이것은 AWS 실제 평가기의 단순화입니다. 다루지 않는 것: NotAction·NotResource·NotPrincipal, ...IfExists 등 대부분의 조건
// 연산자, 정책 변수(${aws:username}), 다른 계정 사이의 요청, RCP(자원 제어 정책), 역할 세션과 자원 기반 정책의 세부 규칙.
// 실제로 확인하려면 IAM 정책 시뮬레이터(aws iam simulate-principal-policy)를 씁니다. 이 스크립트는 AWS를 부르지 않습니다.
// 계정 ID는 AWS 문서의 예시 값(작업 계정 123456789012, 관리 계정 111122223333)이고, 조직 SCP의 실제 내용은 보지 못해
// 거절 메시지와 AWS 문서 예시로 추정한 모양입니다.

// ── 매칭 규칙 ─────────────────────────────────────────────────
// 와일드카드: * = 0자 이상, ? = 한 글자. 동작 이름은 대소문자를 가리지 않고, ARN은 가림(IAM 문서)
const glob = (pattern, value, caseInsensitive) => {
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    caseInsensitive ? 'i' : '',
  );
  return re.test(value);
};
const list = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

const OPERATORS = {
  StringEquals: (actual, expected) => actual === expected,
  StringLike: (actual, expected) => glob(expected, actual, false),
  ArnLike: (actual, expected) => glob(expected, actual, false),
  NumericEquals: (actual, expected) => Number(actual) === Number(expected),
};

function matchCondition(condition, context) {
  if (!condition) return { ok: true, why: '조건 없음' };
  for (const [op, pairs] of Object.entries(condition)) {
    const fn = OPERATORS[op];
    if (!fn) throw new Error(`이 장난감은 ${op}를 모릅니다`);
    for (const [key, expected] of Object.entries(pairs)) {
      const actual = context[key];
      // 요청에 그 키가 없으면 ...IfExists가 아닌 연산자는 거짓(IAM 문서)
      if (actual === undefined) return { ok: false, why: `${key} 값이 요청에 없음` };
      // 값이 여러 개면 그중 하나만 맞아도 됨(OR), 키·연산자끼리는 모두 맞아야 함(AND)
      if (!list(expected).some((e) => fn(actual, e)))
        return { ok: false, why: `${key} = ${actual} ≠ ${list(expected).join(' | ')}` };
    }
  }
  return { ok: true, why: '조건 맞음' };
}

function matchPrincipal(principal, request) {
  if (principal === undefined) return true; // 신원 기반 정책·SCP에는 Principal 칸이 없음(붙은 곳이 곧 주체)
  if (principal === '*') return true;
  return Object.entries(principal).some(([type, values]) =>
    list(values).some((v) => request.principalType === type && glob(v, request.principal, false)),
  );
}

function matchStatement(st, request) {
  const action = list(st.Action).some((a) => glob(a, request.action, true));
  const resource = st.Resource === undefined ? true : list(st.Resource).some((r) => glob(r, request.resource, false));
  const principal = matchPrincipal(st.Principal, request);
  const cond = action && resource && principal ? matchCondition(st.Condition, request.context) : { ok: false, why: '—' };
  return { action, resource, principal, cond, hit: action && resource && principal && cond.ok };
}

// ── 평가기 ────────────────────────────────────────────────────
// policies: { scp?: [...], resource?: [...], identity?: [...], boundary?: [...], session?: [...] } (각 항목은 정책 문서)
function evaluate(request, policies, { showStatements = false } = {}) {
  const trace = [];
  const groups = Object.entries(policies).filter(([, docs]) => docs !== undefined);
  const statements = (name) =>
    (policies[name] ?? []).flatMap((doc) => list(doc.Statement).map((st) => ({ doc: doc.name, st })));

  if (showStatements) {
    console.log('  정책 | 문장 | 효과 | 동작 | 자원 | 주체 | 조건 | 맞음');
    for (const [name] of groups) {
      for (const { doc, st } of statements(name)) {
        const m = matchStatement(st, request);
        const yn = (b) => (b ? 'O' : 'X');
        console.log(
          `  ${name}:${doc} | ${st.Sid ?? '-'} | ${st.Effect} | ${yn(m.action)} | ${yn(m.resource)} | ${yn(m.principal)} | ${m.cond.why} | ${m.hit ? '★' : ''}`,
        );
      }
    }
  }

  // 1단계: 모든 정책에서 맞는 Deny를 찾음. 하나라도 있으면 끝
  for (const [name] of groups) {
    for (const { doc, st } of statements(name)) {
      if (st.Effect === 'Deny' && matchStatement(st, request).hit) {
        trace.push(`1. 명시적 거부: ${name}:${doc}의 ${st.Sid ?? '문장'}`);
        return { decision: '거부 (명시적)', trace };
      }
    }
  }
  trace.push('1. 명시적 거부 없음');
  const allowIn = (name) =>
    statements(name).find(({ st }) => st.Effect === 'Allow' && matchStatement(st, request).hit);

  // 2단계: SCP가 걸린 계정이면 SCP에도 맞는 Allow가 있어야 함(상한)
  if (policies.scp) {
    const hit = allowIn('scp');
    if (!hit) {
      trace.push('2. SCP에 맞는 허용 없음');
      return { decision: '거부 (기본, SCP 상한 밖)', trace };
    }
    trace.push(`2. SCP 허용: ${hit.doc}`);
  } else trace.push('2. SCP 없음 (관리 계정이거나 조직 밖)');

  // 3단계: 자원 기반 정책(역할의 신뢰 정책도 여기)이 허용하면, 같은 계정 안에서는 여기서 허용될 수 있음
  if (policies.resource) {
    const hit = allowIn('resource');
    if (hit) {
      trace.push(`3. 자원 기반 정책 허용: ${hit.doc} → 허용`);
      return { decision: '허용', trace };
    }
    trace.push('3. 자원 기반 정책에 맞는 허용 없음');
    if (!policies.identity) return { decision: '거부 (기본)', trace };
  }

  // 4단계: 신원 기반 정책에 Allow가 있어야 함
  const id = allowIn('identity');
  if (!id) {
    trace.push('4. 신원 기반 정책에 맞는 허용 없음');
    return { decision: '거부 (기본)', trace };
  }
  trace.push(`4. 신원 기반 허용: ${id.doc}의 ${id.st.Sid ?? '문장'}`);

  // 5·6단계: 권한 경계, 세션 정책이 있으면 그것도 허용해야 함(교집합)
  for (const [step, name, label] of [
    [5, 'boundary', '권한 경계'],
    [6, 'session', '세션 정책'],
  ]) {
    if (!policies[name]) continue;
    const hit = allowIn(name);
    if (!hit) {
      trace.push(`${step}. ${label}에 맞는 허용 없음`);
      return { decision: `거부 (기본, ${label} 밖)`, trace };
    }
    trace.push(`${step}. ${label} 허용: ${hit.doc}`);
  }
  return { decision: '허용', trace };
}

// ── 정책들 ────────────────────────────────────────────────────
const WORK = '123456789012';
const PROFILE_JP = `arn:aws:bedrock:ap-northeast-1:${WORK}:inference-profile/jp.anthropic.claude-haiku-5-5`;
const PROFILE_GLOBAL = `arn:aws:bedrock:ap-northeast-1:${WORK}:inference-profile/global.anthropic.claude-haiku-5-5`;
const MODEL = (region) => `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-haiku-5-5`;

const orgScp = [
  {
    name: 'FullAWSAccess', // 조직을 만들면 기본으로 붙는 SCP
    Statement: [{ Sid: 'AllowAll', Effect: 'Allow', Action: '*', Resource: '*' }],
  },
  {
    name: 'DenyBedrockApiKeys(추정)',
    Statement: [
      {
        Sid: 'DenyApiKeys',
        Effect: 'Deny',
        Action: ['iam:CreateServiceSpecificCredential', 'bedrock:CallWithBearerToken'],
        Resource: '*',
      },
      {
        Sid: 'DenyUseCaseForm',
        Effect: 'Deny',
        Action: ['bedrock:PutUseCaseForModelAccess', 'bedrock:GetUseCaseForModelAccess'],
        Resource: '*',
      },
    ],
  },
];
const fullAccess = [
  { name: 'AccountFullAccess(추정)', Statement: [{ Sid: 'All', Effect: 'Allow', Action: '*', Resource: '*' }] },
];
const minimal = [
  {
    name: '16-5절 최소 권한',
    Statement: [
      { Sid: 'InvokeThroughJpProfile', Effect: 'Allow', Action: 'bedrock:InvokeModelWithResponseStream', Resource: PROFILE_JP },
      {
        Sid: 'ModelInProfileRegions',
        Effect: 'Allow',
        Action: 'bedrock:InvokeModelWithResponseStream',
        Resource: [MODEL('ap-northeast-1'), MODEL('ap-northeast-3')],
        Condition: { StringEquals: { 'bedrock:InferenceProfileArn': PROFILE_JP } },
      },
    ],
  },
];
const tokyoOnlyBoundary = [
  {
    name: '도쿄만 경계',
    Statement: [{ Sid: 'TokyoOnly', Effect: 'Allow', Action: 'bedrock:Invoke*', Resource: 'arn:aws:bedrock:ap-northeast-1:*' }],
  },
];

const consoleRole = {
  principalType: 'AWS',
  principal: `arn:aws:sts::${WORK}:assumed-role/AccountFullAccessRole/<세션 이름>`,
};
const agentUser = { principalType: 'AWS', principal: `arn:aws:iam::${WORK}:user/voice-agent` };
const invoke = (resource, context = {}) => ({
  ...agentUser,
  action: 'bedrock:InvokeModelWithResponseStream',
  resource,
  context,
});

const cases = [
  [
    '#4 콘솔 역할 세션이 API 키로 호출',
    { ...consoleRole, action: 'bedrock:CallWithBearerToken', resource: '*', context: { 'bedrock:bearerTokenType': 'SHORT_TERM' } },
    { scp: orgScp, identity: fullAccess },
    true,
  ],
  [
    '#6 작업 계정에서 사용 목적 양식 제출',
    { ...consoleRole, action: 'bedrock:PutUseCaseForModelAccess', resource: '*', context: {} },
    { scp: orgScp, identity: fullAccess },
  ],
  [
    '#6 관리 계정에서 같은 제출 (SCP 미적용)',
    {
      principalType: 'AWS',
      principal: 'arn:aws:sts::111122223333:assumed-role/Admin/<세션 이름>',
      action: 'bedrock:PutUseCaseForModelAccess',
      resource: '*',
      context: {},
    },
    { identity: fullAccess },
  ],
  ['운영 정책: jp. 프로필 ARN으로 호출', invoke(PROFILE_JP), { scp: orgScp, identity: minimal }],
  [
    '운영 정책: 프로필이 오사카 기본 모델로 보냄',
    invoke(MODEL('ap-northeast-3'), { 'bedrock:InferenceProfileArn': PROFILE_JP }),
    { scp: orgScp, identity: minimal },
    true,
  ],
  ['운영 정책: 프로필 없이 도쿄 기본 모델 직접', invoke(MODEL('ap-northeast-1')), { scp: orgScp, identity: minimal }],
  ['운영 정책: global. 프로필', invoke(PROFILE_GLOBAL), { scp: orgScp, identity: minimal }],
  [
    '운영 정책 + "도쿄만" 권한 경계: 오사카로 간 요청',
    invoke(MODEL('ap-northeast-3'), { 'bedrock:InferenceProfileArn': PROFILE_JP }),
    { scp: orgScp, identity: minimal, boundary: tokyoOnlyBoundary },
  ],
];

for (const [title, request, policies, showStatements] of cases) {
  console.log(`\n== ${title} ==`);
  console.log(`  요청: 주체 ${request.principal}`);
  console.log(`        동작 ${request.action}`);
  console.log(`        자원 ${request.resource}`);
  if (Object.keys(request.context).length) console.log(`        조건 값 ${JSON.stringify(request.context)}`);
  const result = evaluate(request, policies, { showStatements });
  for (const line of result.trace) console.log(`  ${line}`);
  console.log(`  → ${result.decision}`);
}

// ── 신뢰 정책: 누가 이 역할을 맡을 수 있나 ─────────────────────
// 역할에 붙는 자원 기반 정책. 웹 ID 연동에는 호출하는 쪽 AWS 신원이 없으므로 이 정책만으로 결정됨
console.log('\n\n== 신뢰 정책: 구글 서비스 계정의 ID 토큰으로 AWS 역할 맡기 (16-9절) ==');
const SA_ID = '100000000000000000001'; // 구글 서비스 계정의 고유 ID(21자리 숫자) 자리. 지어낸 값
const trust = [
  {
    name: 'gke-bedrock-role 신뢰 정책',
    Statement: [
      {
        Sid: 'AllowGoogleSa',
        Effect: 'Allow',
        Principal: { Federated: 'accounts.google.com' },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            // 구글 토큰에 azp가 있으면 accounts.google.com:aud는 azp 값, oaud가 토큰의 aud 값(IAM 문서)
            'accounts.google.com:aud': SA_ID,
            'accounts.google.com:oaud': 'sts.amazonaws.com',
            'accounts.google.com:sub': SA_ID,
          },
        },
      },
    ],
  },
];
const ROLE = `arn:aws:iam::${WORK}:role/gke-bedrock-role`;
const tokenOf = (sub, aud) => ({
  principalType: 'Federated',
  principal: 'accounts.google.com',
  action: 'sts:AssumeRoleWithWebIdentity',
  resource: ROLE,
  context: { 'accounts.google.com:aud': sub, 'accounts.google.com:oaud': aud, 'accounts.google.com:sub': sub },
});
for (const [title, request] of [
  ['우리 서비스 계정, audience sts.amazonaws.com', tokenOf(SA_ID, 'sts.amazonaws.com')],
  ['같은 프로젝트의 다른 서비스 계정', tokenOf('100000000000000000002', 'sts.amazonaws.com')],
  ['우리 서비스 계정이지만 다른 audience로 받은 토큰', tokenOf(SA_ID, 'https://example.com')],
]) {
  const result = evaluate(request, { resource: trust }, { showStatements: false });
  console.log(`  ${title.padEnd(34)} → ${result.decision}  (${result.trace.at(-1)})`);
}
console.log('  조건이 없으면: 구글 계정을 가진 누구나(세상의 모든 서비스 계정) 이 역할을 맡을 수 있게 됨');
{
  const loose = [{ ...trust[0], Statement: [{ ...trust[0].Statement[0], Condition: undefined }] }];
  const result = evaluate(tokenOf('999999999999999999999', 'anything'), { resource: loose });
  console.log(`  조건 없는 신뢰 정책 + 남의 서비스 계정 → ${result.decision}`);
}
