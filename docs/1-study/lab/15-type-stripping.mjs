// 15장 실습: Node 24의 타입 지우기(type stripping)를 안에서 보기
//  1) 지운 결과: 타입 자리가 공백으로 바뀌어 길이와 위치가 그대로인지 (module.stripTypeScriptTypes)
//  2) 한글이 든 타입을 지우면 무엇으로 채우나 (UTF-16 열과 UTF-8 바이트 위치)
//  3) 스택 추적의 행:열이 소스맵 없이도 .ts 원본과 맞는지
//  4) 지우기만으로 안 되는 문법(enum, namespace, 생성자 매개변수 속성)의 오류와 --experimental-transform-types
//  5) node_modules 안의 .ts, 타입을 일반 import로 가져오기, 확장자 없는 import, tsconfig의 paths
//
// 실행: 레포 루트에서  node docs/1-study/lab/15-type-stripping.mjs   (약 2초)
// 기준: Node 24.22(process.features.typescript = 'strip'). 2026-11-06 작성.
// 예제 .ts 파일은 os.tmpdir() 아래 임시 폴더에 만들고 끝나면 지웁니다. 레포 파일은 건드리지 않습니다.
// 키·네트워크·.env.local을 쓰지 않습니다. stripTypeScriptTypes는 실험 기능이라 경고 한 줄이 나올 수 있습니다.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lab15-strip-'));
const write = (name, text) => {
  mkdirSync(join(dir, name, '..'), { recursive: true });
  writeFileSync(join(dir, name), text);
};
// 자식 node로 실행하고 결과 한 줄로 요약
function run(file, flags = []) {
  const r = spawnSync(process.execPath, [...flags, file], { cwd: dir, encoding: 'utf8' });
  if (r.status === 0) return `실행됨, 출력 "${r.stdout.trim()}"`;
  const code = /code: '([A-Z_]+)'/.exec(r.stderr)?.[1];
  const first = r.stderr.split('\n').find((l) => /Error/.test(l)) ?? r.stderr.split('\n')[0];
  return `실패${code ? ' ' + code : ''}\n        ${first.replace(/(file:\/\/)?[^\s'"]*lab15-strip-[^/]+\//g, '').slice(0, 150)}`;
}

try {
  write('package.json', '{ "type": "module" }\n');

  // ── 1. 지운 결과 ─────────────────────────────────────────────
  const src = `import type { CallContext } from './call-context.ts';
interface SttConfig { provider: 'soniox' | 'livekit' }
function pick<T extends string>(name: string, fallback: T): T {
  const v = process.env[name] as T | undefined; if (!v) throw new Error('no ' + name);
  return v;
}
pick<'off' | 'adaptive'>('LAB15_NOT_SET', 'off');
`;
  const out = stripTypeScriptTypes(src);
  console.log('== 1. 지운 결과 (| 사이가 한 줄) ==');
  for (const line of out.split('\n').slice(0, 7)) console.log(`   |${line}|`);
  console.log(
    `   글자 수: 원본 ${src.length}, 지운 뒤 ${out.length} (줄 수 ${src.split('\n').length} → ${out.split('\n').length})`,
  );

  // ── 2. 한글이 든 타입 ────────────────────────────────────────
  const ko = "const greet = '고객님' as '고객님' | '사장님'; throw new Error('x');\n";
  const koOut = stripTypeScriptTypes(ko);
  // 지운 자리('고객님' 리터럴 뒤부터 ;까지)를 코드 포인트 묶음으로: U+0020은 보통 공백, U+2002는 EN SPACE
  const gap = koOut.slice(koOut.indexOf("'고객님'") + 5, koOut.indexOf(';'));
  const runs = [];
  for (const c of gap) {
    const cp = 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
    if (runs.at(-1)?.[0] === cp) runs.at(-1)[1]++;
    else runs.push([cp, 1]);
  }
  console.log('\n== 2. 한글이 든 타입을 지우면 ==');
  console.log(`   지운 뒤: ${JSON.stringify(koOut.trimEnd())}`);
  console.log(
    `   지운 자리 ${gap.length}칸: ${runs.map(([cp, n]) => `${cp}×${n}`).join(' ')}  (원본: ${JSON.stringify(ko.slice(ko.indexOf("'고객님'") + 5, ko.indexOf(';')))})`,
  );
  console.log(
    `   UTF-16 길이 ${ko.length} → ${koOut.length}, UTF-8 바이트 ${Buffer.byteLength(ko)} → ${Buffer.byteLength(koOut)}`,
  );

  // ── 3. 스택 추적의 위치 ──────────────────────────────────────
  write(
    'pos.ts',
    src.replace("import type { CallContext } from './call-context.ts';", '// 1행 자리'),
  );
  const r = spawnSync(process.execPath, ['pos.ts'], { cwd: dir, encoding: 'utf8' });
  const at = /pos\.ts:(\d+):(\d+)/.exec(
    r.stderr.split('\n').find((l) => l.includes('at pick')) ?? '',
  );
  const line4 = src.split('\n')[3];
  console.log('\n== 3. 스택 추적 (소스맵 없음) ==');
  console.log(`   스택: pos.ts:${at?.[1]}:${at?.[2]}`);
  console.log(`   원본 .ts 4행에서 "new Error"가 시작하는 열: ${line4.indexOf('new Error') + 1}`);

  // ── 4. 지우기만으로 안 되는 문법 ─────────────────────────────
  write('enum.ts', 'enum Mode { Off, Adaptive }\nconsole.log(Mode.Adaptive);\n');
  write('ns.ts', 'namespace N { export const a = 1; }\nconsole.log(N.a);\n');
  write('param.ts', 'class A { constructor(private x: number) {} }\nconsole.log(new A(1));\n');
  write(
    'const-object.ts',
    'const Mode = { Off: 0, Adaptive: 1 } as const;\ntype Mode = (typeof Mode)[keyof typeof Mode];\nconst m: Mode = Mode.Adaptive;\nconsole.log(m);\n',
  );
  console.log('\n== 4. 지우기만으로 안 되는 문법 ==');
  for (const f of ['enum.ts', 'ns.ts', 'param.ts', 'const-object.ts'])
    console.log(`   node ${f}: ${run(f)}`);
  console.log(
    `   node --experimental-transform-types enum.ts: ${run('enum.ts', ['--experimental-transform-types', '--no-warnings'])}`,
  );

  // ── 5. 그 밖의 규칙 ──────────────────────────────────────────
  write(
    'node_modules/dep/package.json',
    '{ "name": "dep", "type": "module", "exports": "./index.ts" }\n',
  );
  write('node_modules/dep/index.ts', 'export const v: number = 1;\n');
  write('use-dep.ts', "import { v } from 'dep';\nconsole.log(v);\n");
  write(
    'call-context.ts',
    'export interface CallContext { callId: string }\nexport const VERSION = 1;\n',
  );
  write(
    'value-import.ts',
    "import { CallContext } from './call-context.ts';\nconst c: CallContext = { callId: 'x' };\nconsole.log(c.callId);\n",
  );
  write(
    'type-import.ts',
    "import type { CallContext } from './call-context.ts';\nconst c: CallContext = { callId: 'x' };\nconsole.log(c.callId);\n",
  );
  write('no-ext.ts', "import { VERSION } from './call-context';\nconsole.log(VERSION);\n");
  write('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./*'] } } }));
  write('alias.ts', "import { VERSION } from '@/call-context.ts';\nconsole.log(VERSION);\n");
  console.log('\n== 5. 그 밖의 규칙 ==');
  console.log(`   node_modules 안의 .ts를 import: ${run('use-dep.ts')}`);
  console.log(`   타입을 일반 import로: ${run('value-import.ts')}`);
  console.log(`   같은 것을 import type으로: ${run('type-import.ts')}`);
  console.log(`   확장자 없는 './call-context': ${run('no-ext.ts')}`);
  console.log(`   tsconfig paths의 '@/…' 별칭: ${run('alias.ts')}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
