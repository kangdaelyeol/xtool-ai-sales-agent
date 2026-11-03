import { readFileSync } from 'node:fs';

/** 상담팀이 채우는 회사·기기 정보 (knowledge/xtool.md). 레포 루트 기준 경로입니다. */
const KNOWLEDGE_FILE = new URL('../knowledge/xtool.md', import.meta.url);

/** HTML 주석(작성 안내)과 빈 줄을 빼고, 남는 내용이 없으면 빈 문자열을 돌려줍니다. */
export function cleanKnowledge(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((line) => line.trim())
    .join('\n')
    .trim();
}

/** 워커가 뜰 때 한 번 읽습니다. 파일이 없으면 지식 없이 진행합니다. */
export function loadKnowledge(): string {
  try {
    return cleanKnowledge(readFileSync(KNOWLEDGE_FILE, 'utf8'));
  } catch {
    return '';
  }
}
