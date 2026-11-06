// 15장 실습: Docker 빌드 캐시를 손으로 흉내 내기 — 어떤 파일을 바꾸면 Dockerfile의 어느 줄부터 다시 도는가
//  1) .dockerignore를 적용한 빌드 컨텍스트(COPY . .이 보는 파일)의 크기와 구성
//  2) 단순화한 캐시 키 사슬: 키(n) = 해시(키(n-1) + 명령 문자열 + COPY한 파일 내용의 해시)
//  3) 시나리오별로 다시 도는 줄: 소스 한 줄, lockfile, 학습서 문서, Dockerfile의 apt 줄
//
// 실행: 레포 루트에서  node docs/1-study/lab/15-docker-cache.mjs   (1초 안팎)
// 기준: Node 24, 이 레포의 Dockerfile·.dockerignore. 2026-11-06 작성.
// Docker 없이 돕니다. 레포 파일을 읽기만 하고(내용 해시), .dockerignore에 걸린 파일은 열지 않습니다.
// 이름이 .env로 시작하는 파일은 패턴과 상관없이 열지 않습니다(크기만 보고 경고). 키·네트워크를 쓰지 않습니다.
// 4번은 git check-ignore로 .gitignore 규칙을 물어봅니다(LiveKit Cloud 업로드는 .gitignore도 빼기 때문).
// 단순화: BuildKit의 실제 키는 베이스 이미지의 digest, 파일 권한 비트 등도 넣고, ARG·ENV를 더 정교하게 다룹니다.
// .dockerignore 해석도 Docker 규칙(경로는 컨텍스트 루트 기준, *는 /를 넘지 않음, **는 여러 단계)을 줄여 옮긴 것입니다.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const h = (...parts) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);

// ── .dockerignore → 정규식 ──────────────────────────────────────
const patterns = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''));
if (patterns.some((p) => p.startsWith('!')))
  console.log('(주의: ! 예외 패턴은 이 실습에서 다루지 않습니다)');
const toRegex = (p) =>
  new RegExp(
    '^' +
      p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '«DS»') // **/ 를 잠깐 다른 표시로 바꿔 두고
        .replace(/\*\*/g, '«D»')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/«DS»/g, '(?:.*/)?')
        .replace(/«D»/g, '.*') +
      '$',
  );
const regexes = patterns.map(toRegex);
// 경로 자신이나 그 부모 폴더 중 하나라도 패턴에 맞으면 제외
const ignored = (rel) => {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (regexes.some((r) => r.test(prefix))) return true;
  }
  return false;
};

// ── 1. 빌드 컨텍스트 ───────────────────────────────────────────
const context = []; // { rel, size, secret }
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const rel = relative(ROOT, abs);
    if (ignored(rel)) continue; // 제외된 폴더는 들어가지도 않음
    const st = statSync(abs);
    if (st.isDirectory()) walk(abs);
    else context.push({ rel, size: st.size, secret: name.startsWith('.env') }); // secret은 내용을 열지 않음
  }
}
walk(ROOT);
const byTop = new Map();
for (const f of context) {
  const top = f.rel.includes('/') ? f.rel.split('/')[0] + '/' : f.rel;
  const e = byTop.get(top) ?? { n: 0, size: 0 };
  e.n++;
  e.size += f.size;
  byTop.set(top, e);
}
const kb = (b) => `${(b / 1024).toFixed(1)}KB`;
console.log('== 1. 빌드 컨텍스트 (.dockerignore 적용 뒤, COPY . .이 보는 파일) ==');
console.log(`   파일 ${context.length}개, ${kb(context.reduce((s, f) => s + f.size, 0))}`);
for (const [top, e] of [...byTop].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`   ${top.padEnd(24)} ${String(e.n).padStart(4)}개 ${kb(e.size).padStart(9)}`);
}
const secrets = context.filter((f) => f.secret && f.rel !== '.env.example');
if (secrets.length) {
  const groups = new Map();
  for (const f of secrets) {
    const masked = f.rel.replace(/\d{6,}/g, '<시각>');
    groups.set(masked, (groups.get(masked) ?? 0) + 1);
  }
  console.log(
    `   ⚠ .dockerignore에 걸리지 않은 .env 계열 파일 ${secrets.length}개 (내용은 열지 않음):`,
  );
  for (const [p, n] of groups) console.log(`      ${p}  ×${n}`);
}

// ── 2. Dockerfile 읽기 ─────────────────────────────────────────
const lines = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
  .replace(/\\\n/g, ' ') // 줄 이음
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
const args = {};
const stages = []; // { name, from, steps: [{ text, op }] }
for (const l of lines) {
  const op = l.split(/\s+/)[0].toUpperCase();
  if (op === 'FROM') {
    const m = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(l);
    const from = m[1].replace(/\$\{(\w+)\}/g, (_, k) => args[k] ?? '');
    stages.push({ name: m[2] ?? 'final', from, steps: [] });
  } else if (op === 'ARG' && stages.length === 0) {
    const [k, v] = l.slice(4).split('=');
    args[k.trim()] = v?.trim();
  } else if (stages.length) {
    stages.at(-1).steps.push({ text: l.replace(/\s+/g, ' '), op });
  }
}

// COPY의 원본 파일 목록 (컨텍스트 기준)
function copySources(text) {
  const tokens = text
    .split(' ')
    .slice(1)
    .filter((t) => !t.startsWith('--'));
  const srcs = tokens.slice(0, -1);
  return context.filter((f) =>
    srcs.some((s) => s === '.' || f.rel === s || f.rel.startsWith(s + '/')),
  );
}

// 시나리오: 경로 → 바뀐 내용 표시. dockerfileEdit는 명령 문자열 바꾸기
function keys(scn) {
  const out = []; // { stage, text, key, layer }
  const stageEnd = {};
  for (const st of stages) {
    let key = stageEnd[st.from] ?? h('FROM', st.from); // 다른 단계를 FROM하면 그 단계의 끝 키
    for (const step of st.steps) {
      let text = step.text;
      if (scn.dockerfileEdit && text.includes(scn.dockerfileEdit[0]))
        text = text.replace(...scn.dockerfileEdit);
      let content = '';
      const from = /--from=(\S+)/.exec(text)?.[1];
      if (step.op === 'COPY' && from)
        content = stageEnd[from]; // 다른 단계의 결과물 = 그 단계 키로 대신함
      else if (step.op === 'COPY')
        content = h(
          ...copySources(text).map(
            (f) =>
              f.rel +
              ':' +
              (scn.files?.[f.rel] ??
                (f.secret ? `size ${f.size}` : h(readFileSync(join(ROOT, f.rel))))),
          ),
        );
      key = h(key, text, content);
      out.push({ stage: st.name, text, key, layer: step.op === 'RUN' || step.op === 'COPY' });
    }
    stageEnd[st.name] = key;
  }
  return out;
}

const scenarios = [
  ['src 한 줄', { files: { 'src/prompt.ts': '바뀜' } }],
  ['lockfile', { files: { 'pnpm-lock.yaml': '바뀜' } }],
  ['학습서 문서', { files: { 'docs/1-study/15-config-deploy-ops.md': '바뀜' } }],
  ['apt 줄 수정', { dockerfileEdit: ['ca-certificates', 'ca-certificates curl'] }],
];
const base = keys({});
const results = scenarios.map(([, s]) => keys(s));
console.log('\n== 2·3. 단계별 캐시 (○ 캐시 재사용, ● 다시 실행) ==');
console.log(
  `   ${'단계'.padEnd(6)} ${'명령'.padEnd(54)} ${scenarios.map(([n]) => n.padEnd(8)).join(' ')}`,
);
base.forEach((step, i) => {
  const marks = results.map((r) => (r[i].key === step.key ? '○' : '●').padEnd(8 + 2));
  const text = step.text.length > 52 ? step.text.slice(0, 51) + '…' : step.text;
  console.log(
    `   ${step.stage.padEnd(6)} ${(step.layer ? '' : '(설정) ').concat(text).padEnd(54)} ${marks.join('')}`,
  );
});
console.log(`
   마지막 COPY --from=build /app /app은 node_modules와 소스를 한 레이어에 담습니다.
   그래서 소스 한 줄만 바뀌어도 node_modules까지 든 레이어가 새로 만들어지고, 레지스트리에도 통째로 다시 올라갑니다.`);

// ── 4. LiveKit Cloud 업로드라면 ────────────────────────────────
// 문서: 업로드할 빌드 컨텍스트에서 .env.* 파일과 .dockerignore·.gitignore에 걸린 파일을 뺌
const gi = spawnSync('git', ['check-ignore', '--stdin'], {
  cwd: ROOT,
  input: context.map((f) => f.rel).join('\n'),
  encoding: 'utf8',
});
const gitIgnored = new Set(gi.stdout.split('\n').filter(Boolean));
const cloud = context.filter(
  (f) => !gitIgnored.has(f.rel) && !/^\.env\./.test(f.rel.split('/').at(-1)),
);
console.log('\n== 4. 같은 폴더를 lk agent deploy로 올리면 (.gitignore·.env.*도 뺌) ==');
console.log(
  `   파일 ${context.length}개 → ${cloud.length}개, .env 계열 ${cloud.filter((f) => f.secret).length}개`,
);
console.log(
  `   .gitignore 때문에 더 빠지는 것: ${[...new Set([...gitIgnored].map((p) => p.split('/')[0] + (p.includes('/') ? '/' : '')))].join(', ') || '없음'}`,
);
