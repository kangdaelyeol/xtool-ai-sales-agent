// 6장 실습: 선제 생성 재사용 검사 transcriptsEquivalent가 한국어를 어떻게 비교하는지 보기 (학습서 6-8절 깊이 보기).
//  1) SDK dist에서 실제 함수를 불러와 글 쌍을 비교
//  2) 같은 정규식으로 글을 어떻게 자르는지 보기: 한자·가나·태국 문자는 한 글자씩, 한글은 공백 단위
//  3) 코어가 확정 조각을 이어 붙이는 식(공백 하나를 끼움)과 그 결과
//
// 실행 (레포 루트에서):  node docs/1-study/lab/06-transcripts-equivalent.mjs
// 기준: Node 24, @livekit/agents 1.9.5 (2026-11-06). 키·네트워크를 쓰지 않습니다.
// 이 함수는 패키지 exports에 없어서(내부용) 파일 경로로 직접 불러옵니다. agent_activity.js가 SDK 대부분을
// 끌어오므로 1초 남짓 걸립니다. 내부 파일이라 SDK 버전이 바뀌면 경로나 동작이 달라질 수 있습니다.
const base = import.meta.resolve('@livekit/agents'); // .../dist/index.js
const { transcriptsEquivalent } = await import(new URL('./voice/agent_activity.js', base));
const { splitWords } = await import(new URL('./tokenize/basic/word.js', base));

// 2) agent_activity.ts 214~220행과 같은 자르기. 비교용으로 정규식을 그대로 옮겼습니다.
const SDK_RANGES = '\\u0e00-\\u0e7f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff'; // 태국, 가나, 한자
const HANGUL = '\\uac00-\\ud7a3'; // 한글 음절 (SDK 정규식에는 없음)
const wordsWith = (ranges) => (text) => {
  const re = new RegExp(`[${ranges}]|[^${ranges}]+`, 'gu');
  return splitWords(text, true)
    .flatMap(([w]) => w.match(re) ?? [])
    .filter(Boolean)
    .map((w) => w.toLowerCase());
};
const sdkWords = wordsWith(SDK_RANGES);
const hangulWords = wordsWith(SDK_RANGES + HANGUL);
const equivWith = (words) => (a, b) => {
  const x = words(a);
  const y = words(b);
  return x.length > 0 && x.length === y.length && x.every((w, i) => w === y[i]);
};

console.log('1) transcriptsEquivalent(선제 생성 때 글, 턴 확정 뒤 글)');
const PAIRS = [
  ['네, 메탈팹이요.', '네 메탈팹이요', '구두점'],
  ['방문체험 할게요', '방문체험  할게요 ', '공백 개수·끝 공백'],
  ['F2 울트라', 'f2 울트라', '대소문자'],
  ['방문 체험 할게요', '방문체험 할게요', '띄어쓰기 위치 (한국어)'],
  ['参观 体验', '参观体验', '띄어쓰기 위치 (중국어)'],
  ['ほうもん たいけん', 'ほうもんたいけん', '띄어쓰기 위치 (일본어 가나)'],
  ['메탈 백이랑 피쓰리도', '메탈팹이랑 피쓰리도', '코드 보정 (메탈 백 → 메탈팹)'],
  ['F two 울트라로', 'F2 울트라로', '코드 보정 (F two → F2)'],
];
for (const [a, b, what] of PAIRS) {
  const real = transcriptsEquivalent(a, b);
  const mine = equivWith(sdkWords)(a, b);
  if (real !== mine) throw new Error(`옮긴 정규식이 SDK와 다릅니다: ${a} / ${b}`);
  console.log(`   ${String(real).padEnd(5)} ← ${what}: "${a}" / "${b}"`);
}

console.log('\n2) 비교 전에 글을 자른 모양');
for (const text of [
  '방문 체험 할게요',
  '방문체험 할게요',
  '参观体验',
  'ほうもんたいけん',
  '네, F2 울트라!',
]) {
  console.log(`   ${JSON.stringify(text).padEnd(22)} → ${JSON.stringify(sdkWords(text))}`);
}
console.log('   (가정) 정규식에 한글 범위를 넣었다면:');
for (const [a, b] of [
  ['방문 체험 할게요', '방문체험 할게요'],
  ['메탈 백이랑', '메탈팹이랑'],
]) {
  console.log(
    `   ${JSON.stringify(hangulWords(a))} vs ${JSON.stringify(hangulWords(b))} → ${equivWith(hangulWords)(a, b)}`,
  );
}

// 3) audio_recognition.ts 1347~1348행: audioTranscript += ` ${transcript}`; 그 뒤 trimStart()
//    PREFLIGHT 때는 1410~1411행: `${audioTranscript} ${preflight}`.trimStart()
console.log('\n3) 한 턴에 확정(FINAL)이 두 번 오면 코어가 이어 붙인 글');
let audioTranscript = '';
for (const finalText of ['메탈팹이랑', ' 피쓰리도']) {
  audioTranscript = `${audioTranscript} ${finalText}`.trimStart();
  console.log(
    `   FINAL ${JSON.stringify(finalText).padEnd(12)} → audioTranscript ${JSON.stringify(audioTranscript)}`,
  );
}
console.log(
  `   한 번에 확정됐을 때 "메탈팹이랑 피쓰리도"와 같은가: ${transcriptsEquivalent('메탈팹이랑 피쓰리도', audioTranscript)} (공백 개수는 무시)`,
);
audioTranscript = '';
for (const finalText of ['메탈', '팹이랑'])
  audioTranscript = `${audioTranscript} ${finalText}`.trimStart();
console.log(
  `   단어 중간에서 확정이 끊기면 LLM이 보는 글: ${JSON.stringify(audioTranscript)} ` +
    `("메탈팹이랑"과 같은가: ${transcriptsEquivalent('메탈팹이랑', audioTranscript)})`,
);
console.log(
  '   선제 생성 글도 같은 식으로 이어 붙이므로, 이 공백 자체는 재사용 검사를 깨지 않습니다.',
);
