// REQ-136 (research/272 → 277): the English screens' words. No Korean left in an English sentence (H2: the lead's prefix
// is named, not quoted), one English word per idea (research/272 §3: lead, not orchestrator; Collapse, not Fold; memo, not
// busy mark; draft, not instruction draft; needs/waiting, not awaiting; American spelling); the phone tab's short name (H6) is gone again (REQ-148).
// The Korean words are unchanged. Labs' message strings (H7) are out of this check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copy } from '../dist/client/i18n.js';

const en = copy('en'), ko = copy('ko');
const HANGUL = /[가-힣ㄱ-ㆎ]/;
/** Every string a key says — functions called with sample arguments, records opened. */
function said(m, skip = /^(labsMail|mail)/) {
  const out = [];
  for (const [key, value] of Object.entries(m)) {
    if (skip.test(key)) continue;
    if (key === 'dispatchHeld' || key === 'dispatchHeldChip') { for (const h of ['beforeFloor', 'settings', 'targetGone', 'listing']) out.push([key + '.' + h, value(h)]); continue; }
    const v = typeof value === 'function' ? value(1, 2, 'X', 'Y') : value;
    if (typeof v === 'string') out.push([key, v]);
    else if (v && typeof v === 'object') for (const [k, s] of Object.entries(v)) out.push([key + '.' + k, String(s)]);
  }
  return out;
}

test('REQ-136 H2 no Korean in an English sentence (the held request names the lead prefix)', () => {
  // REQ-137: the held request quotes the real prefixes, "Lead-…" (or "총괄-…") — the quoted Korean prefix is the only Korean allowed.
  const korean = said(en).filter(([, s]) => HANGUL.test(s.replaceAll('"총괄-…"', '')));
  assert.deepEqual(korean, []);
  for (const held of ['beforeFloor', 'settings', 'targetGone']) assert.match(en.dispatchHeld(held), /titled "Lead-…" \(or "총괄-…"\)/);
  assert.match(ko.dispatchHeld('beforeFloor'), /총괄-/, 'the Korean words keep their prefix');
});

test('REQ-136 one English word per idea (research/272 §3)', () => {
  const words = said(en).map(([k, s]) => k + ': ' + s);
  for (const banned of [/orchestrator/i, /\bFold\b/, /busy mark/i, /instruction draft/i, /\bAwait/, /colour/i, /\bgrey\b/i, /working stage/i])
    assert.deepEqual(words.filter(s => banned.test(s)), [], String(banned));
  assert.equal(en.statusAwaiting(1), 'Needs you 1');
  assert.equal(en.leadSelfAsking('5m'), 'Needs your answer · 5m');
  assert.equal(en.leadSelfUnseen('5m'), 'Ready to check · 5m');
  assert.equal(en.memoOn, 'Turn on'); assert.equal(en.busyOff, 'Turn off');
  assert.equal(en.busyTitle, en.memoTitle, 'the busy mark and the memo are one thing by one name');
});

test('REQ-148 (once REQ-136 H6 "Doing") the phone tab says the wide board\'s name; no shorter one is left', () => {
  assert.equal(en.doingStage, 'In progress'); assert.equal(ko.doingStage, '진행');
  assert.equal(en.doingStageTab, undefined); assert.equal(ko.doingStageTab, undefined);
});
test('REQ-136 F1/F2 the draft rule names the stage that sends a draft, as the board shows it — not a fixed "In progress"', () => {
  assert.equal(en.draftRule('In progress'), 'Drafts stay in the first stage. Move one to In progress to send it to the workspace\'s lead (you confirm first).');
  assert.match(en.draftRule('Build'), /Move one to Build to send/);
  assert.doesNotMatch(en.draftRule('Build'), /In progress/);
  assert.equal(en.draftRule(''), 'Drafts stay in the first stage.', 'a board with no sending stage promises nothing');
  assert.equal(ko.draftRule('진행'), '지시 초안은 첫 단계에 유지됩니다. 진행으로 옮기면 확인을 거쳐 이 워크스페이스의 총괄에게 보냅니다.', 'Korean wording unchanged for the built-in stage');
  assert.match(ko.draftRule('검토'), /검토(으로|로) 옮기면/);
});
