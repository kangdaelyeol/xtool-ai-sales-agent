// 15장 실습: tsc가 무엇을 잡고 무엇을 놓치는가
//  1) 완전성 검사: switch에서 case 하나를 빠뜨렸을 때 어떤 옵션이 어떤 오류(TS2366, TS7030)를 내는지,
//     default의 never 관용구는 어디에 오류를 내는지
//  2) 모듈 해석: 확장자 없는 import('./b')를 bundler는 통과시키고 Node는 못 찾는 것, nodenext는 잡는 것
//  3) 이 레포 전체를 nodenext로 검사하면 오류가 몇 개인지 (레포 tsconfig를 extends하는 임시 설정)
//
// 실행: 레포 루트에서  node docs/1-study/lab/15-tsc-checks.mjs   (pnpm install 뒤, 약 5초)
// 기준: Node 24, TypeScript 5.9.3(이 레포 devDependency). 2026-11-06 작성.
// 예제 파일은 os.tmpdir() 아래 임시 폴더에 만들고 끝나면 지웁니다. 레포 파일은 읽기만 합니다.
// 키·네트워크·.env.local을 쓰지 않습니다.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const TSC = join(REPO, 'node_modules/typescript/bin/tsc');
const dir = mkdtempSync(join(tmpdir(), 'lab15-tsc-'));
const write = (name, text) => writeFileSync(join(dir, name), text);

// tsc를 돌려 "파일(행,열): error TSxxxx: 문구"만 골라 돌려준다. 오류가 없으면 빈 배열
function tsc(args) {
  const r = spawnSync(process.execPath, [TSC, '--noEmit', ...args], { cwd: dir, encoding: 'utf8' });
  return (r.stdout + r.stderr)
    .split('\n')
    .filter((l) => l.includes('error TS'))
    .map((l) => l.replace(dir + '/', ''));
}
const show = (label, lines) => {
  console.log(`   ${label}`);
  if (lines.length === 0) console.log('      (오류 없음)');
  for (const l of lines) console.log(`      ${l}`);
};

try {
  // ── 1. 완전성 검사 ────────────────────────────────────────────
  // createSTT(src/models/index.ts)와 같은 모양에 'rtzr'을 더하고 case를 빼먹은 상황
  write(
    'factory.ts',
    `type SttProvider = 'soniox' | 'livekit' | 'rtzr';
interface STT { name: string }
export function createSTT(p: SttProvider): STT {          // 3행: 반환 타입을 적음 (이 레포와 같음)
  switch (p) {
    case 'soniox': return { name: 'soniox' };
    case 'livekit': return { name: 'livekit' };
  }
}
export function inferred(p: SttProvider) {                 // 9행: 반환 타입을 적지 않음 (추론)
  switch (p) {
    case 'soniox': return { name: 'soniox' };
    case 'livekit': return { name: 'livekit' };
  }
}
export function withNever(p: SttProvider): STT {           // 15행: default에 never 관용구
  switch (p) {
    case 'soniox': return { name: 'soniox' };
    case 'livekit': return { name: 'livekit' };
    default: {
      const unhandled: never = p;                          // 20행
      throw new Error('알 수 없는 STT 공급사: ' + String(unhandled));
    }
  }
}
export function logOnly(p: SttProvider): void {           // 25행: 값을 돌려주지 않는 switch
  switch (p) {
    case 'soniox': console.log('s'); break;
    case 'livekit': console.log('l'); break;
  }
}
`,
  );
  console.log('== 1. case 하나를 빠뜨린 switch (factory.ts) ==');
  const base = ['--strict', '--target', 'es2022', '--module', 'es2022', 'factory.ts'];
  for (const [nir, snc] of [
    [true, true],
    [false, true],
    [true, false],
    [false, false],
  ]) {
    show(
      `noImplicitReturns=${nir}, strictNullChecks=${snc}${nir && snc ? '  ← 이 레포 설정' : ''}`,
      tsc([...base, '--noImplicitReturns', String(nir), '--strictNullChecks', String(snc)]),
    );
  }

  // ── 2. 확장자 없는 import ─────────────────────────────────────
  write('package.json', '{ "type": "module" }\n'); // 이 레포처럼 ESM
  write('b.ts', 'export const x: number = 1;\n');
  write('a.ts', "import { x } from './b';\nconsole.log(x);\n"); // 확장자 없음
  write('c.ts', "import { x } from './b.ts';\nconsole.log(x);\n"); // 이 레포의 방식
  console.log('\n== 2. 확장자 없는 import (a.ts: "./b", c.ts: "./b.ts") ==');
  const files = ['a.ts', 'c.ts'];
  show(
    'tsc: module es2022 + moduleResolution bundler + allowImportingTsExtensions  ← 이 레포 설정',
    tsc([
      '--module',
      'es2022',
      '--moduleResolution',
      'bundler',
      '--allowImportingTsExtensions',
      ...files,
    ]),
  );
  show(
    'tsc: bundler + rewriteRelativeImportExtensions',
    tsc([
      '--module',
      'es2022',
      '--moduleResolution',
      'bundler',
      '--rewriteRelativeImportExtensions',
      ...files,
    ]),
  );
  show(
    'tsc: module nodenext + allowImportingTsExtensions',
    tsc(['--module', 'nodenext', '--allowImportingTsExtensions', ...files]),
  );
  show(
    'tsc: module nodenext + rewriteRelativeImportExtensions  ← Node 문서의 권장 조합',
    tsc(['--module', 'nodenext', '--rewriteRelativeImportExtensions', ...files]),
  );
  for (const f of files) {
    const r = spawnSync(process.execPath, [f], { cwd: dir, encoding: 'utf8' });
    const code = /code: '([A-Z_]+)'/.exec(r.stderr)?.[1];
    console.log(
      `   node ${f}: ${r.status === 0 ? `실행됨 (출력 ${r.stdout.trim()})` : `실패 ${code}`}`,
    );
  }

  // ── 3. 이 레포를 nodenext로 ───────────────────────────────────
  write(
    'tsconfig.nodenext.json',
    JSON.stringify({
      extends: join(REPO, 'tsconfig.json'), // include·exclude는 원래 파일 위치 기준으로 풀림
      compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' },
    }),
  );
  console.log('\n== 3. 이 레포 전체를 module/moduleResolution nodenext로 검사 ==');
  let out = '';
  try {
    out = execFileSync(process.execPath, [TSC, '-p', join(dir, 'tsconfig.nodenext.json')], {
      cwd: REPO,
      encoding: 'utf8',
    });
  } catch (e) {
    out = e.stdout;
  }
  const errors = out.split('\n').filter((l) => l.includes('error TS'));
  console.log(`   오류 ${errors.length}개${errors.length ? ':' : ''}`);
  for (const l of errors.slice(0, 10)) console.log(`      ${l}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
