// 15장 실습: SIGTERM이 워커에 닿는 길과 종료 순서
//  1) node를 직접 띄움(Dockerfile의 exec 형식 CMD와 같은 관계): SIGTERM → 처리기 → drain → exit(143)
//  2) drain 중에 SIGTERM이 한 번 더 오면: SDK처럼 process.once로 걸었으면 두 번째는 기본 동작(즉시 종료)
//  3) 셸이 감쌀 때: sh -c 'node …'(명령 하나) / sh -c 'node …; echo 끝'(명령 둘)에 SIGTERM을 보내면
//  4) 쿠버네티스 종료 순서를 줄여서 흉내: SIGTERM → 유예 시간 → SIGKILL. 유예 시간이 통화보다 짧을 때와 길 때
//
// 실행: 레포 루트에서  node docs/1-study/lab/15-signals.mjs   (약 6초)
// 기준: Node 24, macOS(이 맥의 /bin/sh는 bash 3.2, /bin/dash도 있음). 2026-11-06 작성.
// 이 파일이 자기 자신을 자식으로 띄워 "워커 흉내"를 시킵니다. 키·네트워크·.env.local을 쓰지 않습니다.
// 워커 흉내는 agents/cli.ts 87~99의 모양을 따릅니다: process.once('SIGTERM') → drain → process.exit(143).
// 맥에는 컨테이너 PID 1이 없으므로 "PID 1이면 어떻게 다른가"는 출력 끝의 설명과 본문(15-4절)으로 봅니다.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv[2] === 'worker') {
  // ── 자식: 워커 흉내 ──
  const drainMs = Number(process.argv[3]); // 진행 중인 통화가 끝나기까지 남은 시간
  const t0 = performance.now();
  const say = (s) =>
    console.log(
      `${String(Math.round(performance.now() - t0)).padStart(5)}ms  [워커 ${process.pid}] ${s}`,
    );
  say(`시작 (부모 ${process.ppid})`);
  process.once('SIGTERM', () => {
    say(`SIGTERM 받음 → drain 시작 (통화 끝날 때까지 ${drainMs}ms)`);
    setTimeout(() => {
      say('drain 끝 → process.exit(143)');
      process.exit(143);
    }, drainMs);
  });
  setInterval(() => {}, 1000); // 할 일이 없어도 살아 있게
} else {
  // ── 부모 ──
  // child를 띄우고, 출력 줄을 그대로 보여 주고, 끝나면 { code, signal }을 돌려준다
  function start(cmd, args) {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (b) => process.stdout.write(b.toString().replace(/^(?=.)/gm, '   ')));
    const done = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
    return { child, done };
  }
  const describe = ({ code, signal }) =>
    signal
      ? `신호 ${signal}로 죽음 (셸 관례로는 ${128 + { SIGTERM: 15, SIGKILL: 9 }[signal]})`
      : `종료 코드 ${code}`;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const workerArgs = (ms) => [SELF, 'worker', String(ms)];

  console.log('== 1. node를 직접 (exec 형식) ==');
  {
    const { child, done } = start(process.execPath, workerArgs(400));
    await sleep(300);
    child.kill('SIGTERM');
    console.log(`   → ${describe(await done)}`);
  }

  console.log('\n== 2. drain 중에 SIGTERM 한 번 더 ==');
  {
    const { child, done } = start(process.execPath, workerArgs(400));
    await sleep(300);
    child.kill('SIGTERM');
    await sleep(100);
    child.kill('SIGTERM');
    console.log(`   → ${describe(await done)}  ← 처리기가 once라 두 번째는 기본 동작(종료)`);
  }

  console.log('\n== 3. 셸이 감쌀 때 (셸에 SIGTERM) ==');
  const shells = ['/bin/sh', '/bin/dash'].filter((s) => existsSync(s));
  for (const sh of shells) {
    for (const tail of ['', '; echo "셸: node가 끝난 뒤의 명령"']) {
      const script = `"${process.execPath}" "${SELF}" worker 300${tail}`;
      console.log(`   -- ${sh} -c 'node …${tail ? '; echo …' : ''}'`);
      const { child, done } = start(sh, ['-c', script]);
      await sleep(300);
      // ps로 셸 자리의 프로세스가 무엇인지 본다
      const ps = spawn('ps', ['-o', 'pid=,ppid=,comm=', '-p', String(child.pid)]);
      const row = await new Promise((r) => {
        let s = '';
        ps.stdout.on('data', (b) => (s += b));
        ps.on('close', () => r(s.trim().replace(/\s+/g, ' ')));
      });
      console.log(`   셸 PID ${child.pid}의 현재 정체: ${row}`);
      child.kill('SIGTERM');
      const res = await done;
      await sleep(400);
      // 셸이 죽은 뒤 남은 node가 있는지 찾는다 (명령 둘이면 node는 셸의 자식)
      const pg = spawn('pgrep', ['-f', `${SELF} worker 300`]);
      const left = await new Promise((r) => {
        let s = '';
        pg.stdout.on('data', (b) => (s += b));
        pg.on('close', () => r(s.trim().split('\n').filter(Boolean).map(Number)));
      });
      console.log(`   → 셸: ${describe(res)}`);
      for (const pid of left) {
        console.log(
          `   → node ${pid}는 SIGTERM을 못 받고 살아 있음(고아). 실습 정리를 위해 SIGKILL`,
        );
        if (alive(pid)) process.kill(pid, 'SIGKILL');
      }
    }
  }

  console.log('\n== 4. 쿠버네티스 종료 순서 흉내 (1분 = 100ms로 줄임) ==');
  // 남은 통화 8분 + 끝인사·결과 전송 0.5분 = 8.5분 → 850ms
  for (const [label, graceMs] of [
    ['유예 30초(기본값)', 50],
    ['유예 600초', 1000],
  ]) {
    console.log(`   -- ${label}: SIGTERM 뒤 ${graceMs}ms 안에 안 끝나면 SIGKILL`);
    const { child, done } = start(process.execPath, workerArgs(850));
    await sleep(300);
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), graceMs);
    const res = await done;
    clearTimeout(timer);
    console.log(
      `   → ${describe(res)}${res.signal === 'SIGKILL' ? '  ← 통화 중에 끊김' : '  ← 통화를 끝까지 마침'}`,
    );
  }

  console.log(`
참고: 컨테이너에서 node가 PID 1이면 2번이 달라집니다. PID 네임스페이스의 첫 프로세스(PID 1)는 처리기를 건 신호만 받으므로(pid_namespaces(7)),
once 처리기가 빠진 뒤의 두 번째 SIGTERM은 무시됩니다(같은 네임스페이스 밖에서 보낸 SIGKILL·SIGSTOP만 예외).
3번에서 셸이 PID 1이면 셸도 SIGTERM 처리기가 없어 아무 일도 일어나지 않고, 유예 시간이 끝날 때 SIGKILL로 함께 죽습니다.`);
}
