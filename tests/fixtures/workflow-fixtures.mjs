// REQ-124 2단위: two made-up workspaces for the workflow screen, written to a folder and read by the real server reader
// (dist/server/workflow.js) — a gated plugin workflow (loops, a commit whose title cannot be read, a report in an unknown
// format, a person's step) and a workflow of another field with no gate (research/216 3장, REQ-125): grasp → draft →
// owner review ◇ → revise → deliver → wait for the reply. Made-up numbers, versions, hashes and names only.
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

const words = { pass: ['통과'], conditional: ['조건부'], fail: ['불통과', '실패'] };
const markers = ['종합 판정', '최종 판정', '최종 집계'];
export const gateDefinition = {
  format: 'paseo-kanban.workflow/1', name: '합성 개발 절차(게이트 있음)', releaseKey: 'semver', releaseWindow: 10,
  stages: [
    { id: 'req', label: '요구 접수', shape: 'pill', row: 0, col: 0 },
    { id: 'impl', label: '구현', shape: 'box', row: 0, col: 1 },
    { id: 'gate', label: '게이트', shape: 'box', row: 0, col: 2 },
    { id: 'pass', label: '통과?', shape: 'diamond', row: 0, col: 3 },
    { id: 'commit', label: '커밋', shape: 'box', row: 0, col: 4 },
    { id: 'stable', label: '안정판', shape: 'box', row: 0, col: 5 },
    { id: 'tester', label: '테스터 배포', shape: 'pill', row: 0, col: 6 },
    { id: 'fix', label: '수정', shape: 'box', row: 1, col: 3 },
    { id: 'phone', label: '휴대폰 확인', shape: 'box', row: 1, col: 5, person: true },
  ],
  edges: [
    { from: 'req', to: 'impl' }, { from: 'impl', to: 'gate' }, { from: 'gate', to: 'pass' },
    { from: 'pass', to: 'commit', when: 'yes', label: '예' }, { from: 'pass', to: 'fix', when: 'no', label: '아니오' },
    { from: 'fix', to: 'gate', back: true, label: '재게이트' }, { from: 'commit', to: 'stable' }, { from: 'stable', to: 'tester' },
    { from: 'stable', to: 'phone', optional: true },
  ],
  sources: [
    { stage: 'req', read: 'headings', files: ['notes/reqs.md'], heading: '###', id: 'req-or-defect', verb: '접수', release: 'text-version', time: 'kst' },
    { stage: 'impl', read: 'names', files: ['docs/*_결과.md'], id: 'req-or-defect', releaseVia: 'req' },
    { stage: 'gate', read: 'verdict', round: 'first', files: ['docs/*_게이트검증.md'], markers, words, release: ['name-version', 'after:대상: v'], releaseFallback: 'req', time: 'kst' },
    { stage: 'gate', read: 'verdict', round: 'again', files: ['docs/*_재게이트.md'], markers, words, release: ['name-version', 'after:대상: v'], releaseFallback: 'req', time: 'kst' },
    { stage: 'fix', read: 'names', files: ['docs/*_게이트후수정.md'], release: 'name-version', releaseFallback: 'req' },
    { stage: 'commit', read: 'git-reflog', branch: 'main', release: 'bump-to' },
    { stage: 'stable', read: 'result-head', files: ['logs/stable-*/RESULT.md'], release: 'after:release.json', time: 'kst', failWords: ['실패', '롤백'], sha: 'dir-suffix' },
    { stage: 'tester', read: 'result-head', files: ['logs/tester-*/RESULT.md'], release: 'after:태그', time: 'kst', failWords: ['보류'] },
  ],
};
const sha = c => c.repeat(40);
const reflog = (from, to, epoch, message) => `${from} ${to} Someone Example <someone@example.com> ${epoch} +0900\t${message}`;
const verdict = (doc, v, title, word, time) => `# ${doc} · v${v} ${title}\n\n- 착수: 2026-03-0${time} KST\n\n## 종합 판정: **${word}**\n`;
/**
 * Six releases: 0.2.6 failed, was fixed and passed on conditions, its commit title unread (no reflog line — the stable
 * result's hash stands in); 0.2.5 passed and went to a tester; 0.2.4 went back twice; 0.2.3 passed; 0.2.2's report has
 * no verdict line (unknown format); 0.2.1 failed and was fixed, then committed without a second gate (an open loop).
 */
export const gateFiles = {
  'notes/reqs.md': ['# 요구 표', '',
    '### REQ-31 접수 — 합성 기능 (2026-03-01 09:00 KST) · 완료, v0.2.1', '',
    '### REQ-32 접수 — 두 번째 (2026-03-01 10:00 KST) · 완료, v0.2.2', '',
    '### REQ-33 접수 — 세 번째 (2026-03-02 09:00 KST) · 완료, v0.2.3', '',
    '### REQ-34 접수 — 네 번째 (2026-03-02 10:00 KST) · 완료, v0.2.4', '### D7 접수 — 결함 (2026-03-02 11:00 KST) · 완료, v0.2.4', '',
    '### REQ-35 접수 — 다섯 번째 (2026-03-03 09:00 KST) · 완료, v0.2.5', '',
    '### REQ-36 접수 — 여섯 번째 (2026-03-03 10:00 KST) · 완료, v0.2.6', ''].join('\n'),
  'docs/30_REQ31_결과.md': '# 결과\n', 'docs/38_REQ32_결과.md': '# 결과\n', 'docs/42_REQ33_결과.md': '# 결과\n',
  'docs/47_REQ34_결과.md': '# 결과\n', 'docs/56_REQ35_결과.md': '# 결과\n', 'docs/58_REQ36_결과.md': '# 결과\n',
  'docs/35_v0201_게이트검증.md': verdict(35, '0.2.1', '게이트 — REQ-31', '불통과 — 결함 1', '1 11:00'),
  'docs/36_v0201_게이트후수정.md': '# 수정\n',
  'docs/40_v0202_게이트검증.md': '# 40 · v0.2.2 게이트 — REQ-32\n\n| 항목 | 판정 |\n|---|---|\n| A | 통과 |\n',
  'docs/45_v0203_게이트검증.md': verdict(45, '0.2.3', '게이트 — REQ-33', '통과 — 결함 0', '2 11:00'),
  'docs/50_v0204_게이트검증.md': verdict(50, '0.2.4', '게이트 — REQ-34 · D7', '불통과 — 결함 2', '2 12:00'),
  'docs/51_v0204_게이트후수정.md': '# 수정\n',
  'docs/52_v0204_재게이트.md': verdict(52, '0.2.4', '재게이트 — 50-D1', '불통과 — 결함 1', '2 14:00'),
  'docs/53_v0204_게이트후수정.md': '# 수정\n',
  'docs/54_v0204_재게이트.md': verdict(54, '0.2.4', '재게이트 — 52-D1', '통과 — 결함 0', '2 16:00'),
  'docs/55_v0205_게이트검증.md': verdict(55, '0.2.5', '게이트 — REQ-35', '통과 — 결함 0', '3 11:00'),
  'docs/60_v0206_게이트검증.md': verdict(60, '0.2.6', '게이트 — REQ-36', '불통과 — 결함 1', '3 12:00'),
  'docs/61_v0206_게이트후수정.md': '# 수정\n',
  'docs/62_v0206_재게이트.md': verdict(62, '0.2.6', '재게이트 — 60-D1', '조건부 통과 — 판단 1', '3 14:00'),
  'logs/stable-1111111/RESULT.md': '# 안정판 갱신 결과\n- 완료: 2026-03-01 13:00 KST. release.json 0.2.1 / 1111111\n',
  'logs/stable-3333333/RESULT.md': '# 안정판 갱신 결과\n- 완료: 2026-03-02 13:00 KST. release.json 0.2.3 / 3333333\n',
  'logs/stable-4444444/RESULT.md': '# 안정판 갱신 결과\n- 완료: 2026-03-02 17:00 KST. release.json 0.2.4 / 4444444\n',
  'logs/stable-5555555/RESULT.md': '# 안정판 갱신 결과\n- 완료: 2026-03-03 12:00 KST. release.json 0.2.5 / 5555555\n',
  'logs/stable-6666666/RESULT.md': '# 안정판 갱신 결과\n- 완료: 2026-03-03 15:00 KST. release.json 0.2.6 / 6666666\n',
  'logs/tester-1/RESULT.md': '# 테스터 1호 결과\n- 2026-03-03 13:00 KST: 태그 v0.2.5 push 완료\n',
  '.git/logs/refs/heads/main': [
    reflog(sha('0'), sha('1'), 1772330400, 'commit: First feature, bump to 0.2.1'),
    reflog(sha('1'), sha('2'), 1772337600, 'commit: Second feature, bump to 0.2.2'),
    reflog(sha('2'), sha('3'), 1772416800, 'commit: Third feature, bump to 0.2.3'),
    reflog(sha('3'), sha('4'), 1772435000, 'commit: Fourth feature, bump to 0.2.4'),
    reflog(sha('4'), sha('5'), 1772506800, 'commit: Fifth feature, bump to 0.2.5'),
  ].join('\n') + '\n',
};

/**
 * Another field, no gate and no commit (research/216 3장 → REQ-125): grasp → draft → owner review ◇ → revise → deliver →
 * wait for the reply. Grasping and the reply have nothing to read; a review is a record with a verdict line ("검토 결과:
 * 승인/조건부/반려"), a delivery a sent folder's RESULT. A request that comes back after the reply goes round the row again.
 */
export const otherDefinition = {
  format: 'paseo-kanban.workflow/1', name: '합성 제안 절차(게이트 없음)', releaseKey: 'semver', releaseWindow: 10,
  stages: [
    { id: 'grasp', label: '파악', shape: 'pill', row: 0, col: 0 },
    { id: 'draft', label: '초안', shape: 'box', row: 0, col: 1 },
    { id: 'review', label: '담당자 검토', shape: 'box', row: 0, col: 2 },
    { id: 'ok', label: '승인?', shape: 'diamond', row: 0, col: 3 },
    { id: 'deliver', label: '전달', shape: 'box', row: 0, col: 4 },
    { id: 'reply', label: '외부 응답 대기', shape: 'pill', row: 0, col: 5, person: true },
    { id: 'revise', label: '수정', shape: 'box', row: 1, col: 3 },
  ],
  edges: [
    { from: 'grasp', to: 'draft' }, { from: 'draft', to: 'review' }, { from: 'review', to: 'ok' },
    { from: 'ok', to: 'deliver', when: 'yes', label: '예' }, { from: 'ok', to: 'revise', when: 'no', label: '아니오' },
    { from: 'revise', to: 'review', back: true, label: '다시 검토' }, { from: 'deliver', to: 'reply' },
    { from: 'reply', to: 'grasp', back: true, label: '새 요청' },
  ],
  sources: [
    { stage: 'draft', read: 'names', files: ['drafts/*_초안.md'], release: 'name-version' },
    { stage: 'review', read: 'verdict', round: 'first', files: ['reviews/*_검토.md'], markers: ['검토 결과'],
      words: { pass: ['승인'], conditional: ['조건부'], fail: ['반려'] }, release: 'name-version', time: 'kst' },
    { stage: 'review', read: 'verdict', round: 'again', files: ['reviews/*_재검토.md'], markers: ['검토 결과'],
      words: { pass: ['승인'], conditional: ['조건부'], fail: ['반려'] }, release: 'name-version', time: 'kst' },
    { stage: 'revise', read: 'names', files: ['drafts/*_수정.md'], release: 'name-version' },
    { stage: 'deliver', read: 'result-head', files: ['sent/*/RESULT.md'], release: 'after:판', time: 'kst' },
  ],
};
/** 0.1.3 delivered with no review on record ("기록 없음" — not "not reviewed"); 0.1.2 turned down, not revised yet; 0.1.1 revised once and delivered. */
export const otherFiles = {
  'drafts/3_v0101_제안서_초안.md': '# 초안\n', 'reviews/4_v0101_검토.md': '# 검토\n\n- 2026-04-01 10:00 KST\n\n검토 결과: 반려 — 범위 다시\n',
  'drafts/5_v0101_제안서_수정.md': '# 수정\n', 'reviews/6_v0101_재검토.md': '# 재검토\n\n- 2026-04-01 15:00 KST\n\n검토 결과: 승인\n',
  'sent/v0101-first/RESULT.md': '# 전달 기록\n- 2026-04-02 09:00 KST 판 0.1.1 보냄\n',
  'drafts/8_v0102_제안서_초안.md': '# 초안\n', 'reviews/9_v0102_검토.md': '# 검토\n\n- 2026-04-03 10:00 KST\n\n검토 결과: 반려 — 숫자 확인\n',
  'sent/v0103-third/RESULT.md': '# 전달 기록\n- 2026-04-05 09:00 KST 판 0.1.3 보냄\n',
};

/** Writes `files` and the definition under `dir` (made if missing) and returns it. */
export async function writeWorkspace(dir, definition, files) {
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(join(dir, name, '..'), { recursive: true });
    await fs.writeFile(join(dir, name), text);
  }
  if (definition) {
    await fs.mkdir(join(dir, '.kanban'), { recursive: true });
    await fs.writeFile(join(dir, '.kanban/workflow.json'), JSON.stringify(definition, null, 2));
  }
  return dir;
}
