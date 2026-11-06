// 2장 실습 공용 도구: WAV 읽기·쓰기, 한국어 음성 만들기, 결과 폴더.
// 직접 실행하는 파일이 아니라 02-*.mjs 실습들이 불러 씁니다.
// 기준: Node.js 24, macOS `say`(없으면 합성 신호로 대신함)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 생성물은 레포가 아니라 임시 폴더에 둡니다. */
export const OUT_DIR = join(tmpdir(), 'xtool-study-02');
mkdirSync(OUT_DIR, { recursive: true });

/** 16비트 모노 PCM WAV를 읽습니다. 'fmt '와 'data' 말고 다른 덩어리(JUNK 등)는 건너뜁니다. */
export function readWav(path) {
  const b = readFileSync(path);
  let pos = 12; // 'RIFF' 크기 'WAVE' 다음
  let rate = 0;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') rate = b.readUInt32LE(pos + 12);
    if (id === 'data') {
      const pcm = new Int16Array(size / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = b.readInt16LE(pos + 8 + i * 2);
      return { rate, pcm };
    }
    pos += 8 + size + (size % 2);
  }
  throw new Error(`data 덩어리가 없습니다: ${path}`);
}

/** 16비트 모노 PCM WAV를 씁니다. 머리(44바이트)는 RIFF·fmt·data 세 덩어리입니다. */
export function writeWav(name, rate, pcm) {
  const path = join(OUT_DIR, name);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length * 2, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); // fmt 덩어리 크기
  h.writeUInt16LE(1, 20); // 1 = PCM
  h.writeUInt16LE(1, 22); // 채널 1개
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); // 초당 바이트
  h.writeUInt16LE(2, 32); // 샘플 하나의 바이트
  h.writeUInt16LE(16, 34); // 비트
  h.write('data', 36);
  h.writeUInt32LE(pcm.length * 2, 40);
  writeFileSync(path, Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)]));
  return path;
}

/** 24kHz 한국어 음성. macOS `say -v Yuna`로 만들고, 없으면 모음+마찰음 비슷한 합성 신호를 씁니다. */
export function koreanSpeech(text = '안녕하세요, 에프투 울트라와 에스원 상담 도와드리겠습니다.') {
  const path = join(OUT_DIR, 'source-24k.wav');
  try {
    execFileSync('say', ['-v', 'Yuna', '--data-format=LEI16@24000', '-o', path, text]);
    return { ...readWav(path), source: 'say -v Yuna' };
  } catch {
    const rate = 24000;
    const pcm = new Int16Array(rate * 1.5);
    for (let i = 0; i < pcm.length; i++) {
      const t = i / rate;
      let v = 0;
      if (t < 1)
        for (let h = 1; h <= 30; h++) v += Math.sin(2 * Math.PI * 120 * h * t) / h; // 모음 비슷한 배음
      else v = (Math.random() * 2 - 1) * 0.8; // "ㅅ" 비슷한 넓은 대역 잡음
      pcm[i] = Math.round(v * 6000);
    }
    return { rate, pcm, source: '합성 신호(say 없음)' };
  }
}

/** 신호 대 잡음비(dB). 기준 신호 ref와 비교한 오차의 에너지 비입니다. */
export function snrDb(ref, test) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    s += ref[i] ** 2;
    n += (ref[i] - test[i]) ** 2;
  }
  return 10 * Math.log10(s / n);
}
