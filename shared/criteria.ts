/**
 * REQ-103 ① (research/157 ④ 1단계): how far a card's acceptance criteria are met, read from the criteria text alone —
 * the ledger keeps one string (`acceptanceCriteria`), and a line written as a checklist item (`- [ ]`, `- [x]`, `- [X]`,
 * spaces before it allowed) is one criterion. The client draws "Criteria 2/3" and ticks them; the server hands the count
 * to the board so a card carries it without its whole text. Pure functions, no I/O.
 */
export interface CriteriaProgress { checked: number; total: number }
export interface CriterionLine { line: number; checked: boolean; text: string }

const CHECK_LINE = /^([ \t]*)- \[([ xX])\](?=[ \t]|\r?$)/;
const lines = (text: string) => text.split('\n');

/** Every checklist line of the criteria: its line number (0-based), whether it is ticked and its words. */
export function criteriaLines(text: string): CriterionLine[] {
  const result: CriterionLine[] = [];
  lines(text).forEach((raw, line) => {
    const match = CHECK_LINE.exec(raw);
    if (match) result.push({ line, checked: match[2] !== ' ', text: raw.slice(match[0].length).replace(/\r$/, '').trim() });
  });
  return result;
}
/** Ticked lines over checklist lines; `null` when the criteria have no checklist line (nothing is shown then). */
export function criteriaProgress(text: string): CriteriaProgress | null {
  const found = criteriaLines(text);
  return found.length ? { checked: found.filter(c => c.checked).length, total: found.length } : null;
}
/** The criteria with the checklist line at `line` ticked or unticked; any other line, or text, comes back as it was. */
export function toggleCriterion(text: string, line: number): string {
  const all = lines(text), raw = all[line];
  const match = raw === undefined ? null : CHECK_LINE.exec(raw);
  if (!raw || !match) return text;
  all[line] = match[1] + '- [' + (match[2] === ' ' ? 'x' : ' ') + ']' + raw.slice(match[0].length);
  return all.join('\n');
}
