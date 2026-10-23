import { z } from 'zod';

/**
 * REQ-124: the "workflow" view of a lane. A workspace that wants it keeps one definition file in its own folder
 * (`WORKFLOW_DEFINITION_PATH`): the steps of its procedure (`stages`, `edges`, drawn on a row/column grid) and how to read
 * what happened from the workspace's own documents (`sources`). The server reads those documents (server/workflow.ts) and
 * joins them by release version; nothing is written anywhere.
 *
 * The reading rules take a fixed vocabulary only — no free regular expressions — so a definition cannot make the server
 * run away or leave the workspace folder: file patterns are relative, `*` stays inside one path segment, `..` and `**` are
 * refused. An unknown key or word makes the whole file "형식 모름" (`defined: false, reason: 'unknown-format'`).
 */
export const WORKFLOW_DEFINITION_PATH = '.kanban/workflow.json';
export const WORKFLOW_FORMAT = 'paseo-kanban.workflow/1';
/**
 * REQ-125 U1 (research/290 1.0·1.1·1.2·2.1): the second format, whose rows are "건" — one per folder right under a folder the
 * file names (`instanceKey`) — instead of release versions. A `/2` file names every feature it uses (`features`); a feature
 * this build does not read is refused before anything else as "update Kanban — needs 〈feature〉" (`reason: 'needs-update'`),
 * never read in part. Once published, a `/2` key keeps its meaning; a new meaning comes as a new feature name (or `/3`).
 * A plugin before U1 refuses a `/2` file as "형식 모름" (its format literal), as designed.
 */
export const WORKFLOW_FORMAT_2 = 'paseo-kanban.workflow/2';
/** The features this build reads. U4a (research/309 5판): `state-log` — a 건's events from the tag lines of a record file. */
export const WORKFLOW_FEATURES = ['instance-folder', 'folder', 'file-versions', 'program', 'state-log'] as const;
/** The first segment of a `/2` rule's pattern: the 건 folder (research/290 1.2 — a rule is the 건's only when every pattern starts so). */
export const INSTANCE_TOKEN = '{instance}';

const stageId = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
/** A workspace-relative file pattern: `*` only inside one segment; never absolute, `**`, `\`, or a segment starting with `.` (so no `..`, `.git`). */
const safePattern = (value: string) => {
  if (value.startsWith('/') || value.includes('\\') || value.includes('**') || value.includes('\0')) return false;
  const parts = value.split('/');
  return parts.every(p => p !== '' && !p.startsWith('.') && p.split('*').length <= 2);
};
export const filePattern = z.string().min(1).max(200).refine(safePattern, 'Unsafe file pattern.');
const words = z.array(z.string().min(1).max(20)).min(1).max(8);
/**
 * Where a release version is read:
 * - `name-version`: the file name's `v0142` → 0.1.42 (one digit, one digit, two digits)
 * - `text-version`: (headings) the first x.y.z after a done word ("완료" or "커밋") following the verb
 * - `after:<word>`: the first x.y.z within 40 characters after `<word>` in the head (e.g. `after:release.json`, `after:대상`)
 * - `bump-to`: (git) "bump to x.y.z" in a commit title
 */
const releaseRule = z.union([z.enum(['name-version', 'text-version', 'bump-to']), z.string().regex(/^after:[^\n]{1,20}$/)]);
const releaseRules = z.union([releaseRule, z.array(releaseRule).min(1).max(4)]);
const headBytes = z.number().int().min(256).max(65_536);
const common = { stage: stageId, files: z.array(filePattern).min(1).max(8) };
export const workflowSourceSchema = z.discriminatedUnion('read', [
  /** Lines starting with `heading` that hold `verb`: the first REQ/D id before the verb, the release after it. */
  z.strictObject({ ...common, read: z.literal('headings'), heading: z.enum(['#', '##', '###', '####']),
    id: z.literal('req-or-defect'), verb: z.string().min(1).max(20), release: z.literal('text-version'),
    time: z.literal('kst').optional() }),
  /** One event per matching file or folder name: its REQ/D ids and document number. */
  z.strictObject({ ...common, read: z.literal('names'), id: z.literal('req-or-defect').optional(),
    release: releaseRules.optional(), releaseVia: z.literal('req').optional(), releaseFallback: z.literal('req').optional() }),
  /** A report's verdict line: the first line holding one of `markers`, the first of `words` after it. */
  z.strictObject({ ...common, read: z.literal('verdict'), round: z.enum(['first', 'again']),
    markers: z.array(z.string().min(1).max(20)).min(1).max(8),
    words: z.strictObject({ pass: words, conditional: words, fail: words }),
    release: releaseRules.optional(), releaseFallback: z.literal('req').optional(), time: z.literal('kst').optional(),
    headBytes: headBytes.optional() }),
  /** A result file's head: its release, first KST time, and whether its title holds a failure word. */
  z.strictObject({ ...common, read: z.literal('result-head'), release: releaseRules, time: z.literal('kst').optional(),
    failWords: z.array(z.string().min(1).max(20)).max(8).optional(), headBytes: headBytes.optional(),
    /** `dir-suffix`: the commit hash is the hex after the last `-` of the file's folder (`stable-636771c/RESULT.md`). */
    sha: z.literal('dir-suffix').optional() }),
  /** The branch's reflog (`.git/logs/refs/heads/<branch>`, else `.git/logs/HEAD`): commit titles, never git itself. */
  z.strictObject({ stage: stageId, read: z.literal('git-reflog'),
    branch: z.string().regex(/^(?!.*\.\.)(?!\/)[A-Za-z0-9._/-]{1,100}$/), release: z.literal('bump-to') }),
]);
export type WorkflowSource = z.infer<typeof workflowSourceSchema>;
const stageSchema = z.strictObject({ id: stageId, label: z.string().min(1).max(40), shape: z.enum(['box', 'pill', 'diamond']),
  row: z.number().int().min(0).max(5), col: z.number().int().min(0).max(15),
  /** A step a person does (e.g. a check on a phone): drawn outlined, "읽을 자료 없음" unless a source reads it. */
  person: z.boolean().optional() });
const edgeSchema = z.strictObject({ from: stageId, to: stageId, when: z.enum(['yes', 'no']).optional(),
  label: z.string().min(1).max(20).optional(), back: z.boolean().optional(), optional: z.boolean().optional() });
/** The steps' ids and places are unique; every edge and source names a step there is. */
function checkSteps(def: { stages: { id: string; row: number; col: number }[]; edges: { from: string; to: string }[]; sources: { stage: string }[] },
  ctx: z.RefinementCtx) {
  const ids = new Set<string>(), cells = new Set<string>();
  for (const s of def.stages) {
    if (ids.has(s.id)) ctx.addIssue({ code: 'custom', message: `Duplicate stage ${s.id}.` });
    if (cells.has(`${s.row}:${s.col}`)) ctx.addIssue({ code: 'custom', message: `Two stages at row ${s.row}, col ${s.col}.` });
    ids.add(s.id); cells.add(`${s.row}:${s.col}`);
  }
  for (const e of def.edges) for (const end of [e.from, e.to])
    if (!ids.has(end)) ctx.addIssue({ code: 'custom', message: `Edge names an unknown stage ${end}.` });
  for (const s of def.sources) if (!ids.has(s.stage)) ctx.addIssue({ code: 'custom', message: `Source names an unknown stage ${s.stage}.` });
}
export const workflowDefinitionSchema = z.strictObject({
  format: z.literal(WORKFLOW_FORMAT), name: z.string().min(1).max(80), note: z.string().max(400).optional(),
  releaseKey: z.literal('semver'), releaseWindow: z.number().int().min(1).max(100).optional(),
  stages: z.array(stageSchema).min(1).max(16), edges: z.array(edgeSchema).max(40), sources: z.array(workflowSourceSchema).max(20),
}).superRefine(checkSteps);
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

// ---- REQ-125 U1: the second format (research/290 1.0·1.1·1.2·2.1) -------------------------------------------------------
/** A feature's name in `features`: a fixed word. Any this build does not read is refused first (`unreadFeatures`). */
export const featureName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
/**
 * Where the 건 are (research/290 1.1): `path` is a workspace-relative folder pattern whose last segment is `*` alone and no
 * other segment holds `*` — one folder level, flat (a customer folder then a folder per job under it is refused). Each real folder (not a link) right under it is
 * one 건; its id is its workspace-relative path in NFC, so renaming a folder makes another 건. `label`: the name shown —
 * `as-is` (default) or `strip-number-prefix` (one leading `01_`, `2-`, `3.` or `4 ` dropped). `exclude`: folder names
 * taken out as they are written (at most eight).
 */
export const instanceKeySchema = z.strictObject({
  from: z.literal('folder'),
  path: z.string().min(1).max(200).refine(value => {
    const parts = value.split('/');
    return safePattern(value) && parts.at(-1) === '*' && parts.slice(0, -1).every(p => !p.includes('*')) && !/[{}]/.test(value);
  }, 'The 건 folder pattern must end in "/*" (or be "*") with no other "*" — one folder level only.'),
  label: z.enum(['as-is', 'strip-number-prefix']).optional(),
  exclude: z.array(z.string().min(1).max(100).refine(v => !v.includes('/') && !v.includes('\\') && !v.includes('\0'), 'A folder name, not a path.'))
    .max(8).optional(),
});
/**
 * A `/2` rule's pattern: `{instance}` as its whole first segment (the 건 folder, found through it — never by putting the
 * name into the text), then an ordinary safe pattern, or `{instance}` alone (the 건 folder itself). No other `{` or `}`:
 * the tokens of later features (`{ver}`, …) are not read here.
 */
export const instancePattern = z.string().min(1).max(200).refine(value => {
  const parts = value.split('/');
  if (parts[0] !== INSTANCE_TOKEN) return false;
  if (parts.length === 1) return true;
  // `{instance}/` is an empty segment, refused as `/1` refuses one (302-F3) — not the 건 folder itself.
  const rest = parts.slice(1).join('/');
  return safePattern(rest) && !/[{}]/.test(rest);
}, 'Every pattern of a 건 rule must start with "{instance}/" and be a safe relative pattern.');
/**
 * REQ-125 U2 (research/290 2.2): the file's segment of a `file-versions` pattern, cut into written letters, its fixed tokens
 * and at most one `*`. `{ver}` (the version) once and required; `{yyyymmdd}` (a day); `{ext}` (the format) only at the very end
 * after a "."; `{nn}` (a sorting number) only at the very start; nothing else in braces. Two tokens (or a token and `*`) never
 * touch — written letters stand between them, so a name splits one way only. Null when the segment breaks these rules.
 */
export type VersionToken = 'ver' | 'yyyymmdd' | 'ext' | 'nn' | 'star';
export type VersionPart = { text: string } | { token: VersionToken };
const VERSION_TOKENS: readonly VersionToken[] = ['ver', 'yyyymmdd', 'ext', 'nn'];
export function versionParts(segment: string): VersionPart[] | null {
  const parts: VersionPart[] = [];
  for (const piece of segment.split(/(\{[^{}]*\}|\*)/)) {
    if (!piece) continue;
    if (piece === '*') parts.push({ token: 'star' });
    else if (piece.startsWith('{') && piece.endsWith('}')) {
      const name = piece.slice(1, -1) as VersionToken;
      if (!VERSION_TOKENS.includes(name)) return null;
      parts.push({ token: name });
    } else if (/[{}]/.test(piece)) return null;
    else parts.push({ text: piece });
  }
  const tokens = parts.flatMap(p => 'token' in p ? [p.token] : []), tokenAt = (i: number) => { const p = parts.at(i); return p && 'token' in p ? p.token : null; };
  if ((['ver', 'yyyymmdd', 'ext', 'nn', 'star'] as const).some(name => tokens.filter(t => t === name).length > 1) || !tokens.includes('ver')) return null;
  if (tokens.includes('nn') && tokenAt(0) !== 'nn') return null;
  if (tokens.includes('ext')) { const before = parts.at(-2); if (tokenAt(-1) !== 'ext' || !before || !('text' in before) || !before.text.endsWith('.')) return null; }
  for (let i = 1; i < parts.length; i++) if (tokenAt(i) && tokenAt(i - 1)) return null;
  return parts;
}
/**
 * A `file-versions` pattern: `{instance}` as its whole first segment, ordinary safe folder segments (no braces), then the
 * file's segment (`versionParts`). The folders between are walked as a `folder` rule's are.
 */
export const versionPattern = z.string().min(1).max(200).refine(value => {
  const parts = value.split('/');
  if (parts[0] !== INSTANCE_TOKEN || parts.length < 2) return false;
  const folders = parts.slice(1, -1), last = parts.at(-1)!;
  // An empty folder segment ("{instance}//…") is refused as `/1` refuses one (302-F3's lesson).
  if (folders.length && (!safePattern(folders.join('/')) || /[{}]/.test(folders.join('/')))) return false;
  // The file's segment as `/1` takes one once its tokens are letters: not empty, not hidden, one `*` at most.
  return safePattern(last.replace(/\{[a-z]+\}/g, 'x')) && versionParts(last) !== null;
}, 'A "file-versions" pattern must start with "{instance}/" and end in a file name holding {ver} once — {nn} only first, ".{ext}" only last, no two tokens side by side.');
/**
 * REQ-125 U3 (research/290 1.2·2.4): a `scope: "program"` rule's patterns — as a 건 rule's after `{instance}/`, but from the
 * workspace folder and with no `{instance}` anywhere: a `folder` rule's an ordinary safe pattern (no braces), a `file-versions`
 * rule's safe folder segments (no braces) then the file's segment (`versionParts`).
 */
export const programPattern = z.string().min(1).max(200).refine(value => safePattern(value) && !/[{}]/.test(value),
  'A "program" rule\'s pattern is a safe relative pattern from the workspace folder, with no "{instance}" and no token.');
export const programVersionPattern = z.string().min(1).max(200).refine(value => {
  const parts = value.split('/'), folders = parts.slice(0, -1), last = parts.at(-1)!;
  if (folders.length && (!safePattern(folders.join('/')) || /[{}]/.test(folders.join('/')))) return false;
  return safePattern(last.replace(/\{[a-z]+\}/g, 'x')) && versionParts(last) !== null;
}, 'A "program" "file-versions" pattern names no "{instance}" and ends in a file name holding {ver} once — {nn} only first, ".{ext}" only last, no two tokens side by side.');
/**
 * `/2` reading rules. A 건 rule's every pattern starts with `{instance}`; a `scope: "program"` rule's (U3) none does:
 * - `folder` (U1): one event per matched folder that holds data — at least one regular file right inside it that is not
 *   hidden and not `README.*` (research/290 2.1). It only says "자료 있음".
 * - `file-versions` (U2, research/290 2.2): the versions of a document left in the folder now — "관측한 판의 순서", never how
 *   many times work was redone. A document (chain) is its 건, its folder inside the 건 and its name without the tokens: the
 *   format (`{ext}`) is never part of it, so one version as DOCX and PDF is one version; a sorting number is left out only
 *   where the pattern writes `{nn}`. Versions compare as numbers (`v01.0` is `v1.0`). `ver`: the version's shape. `observed`:
 *   `lowest` (the lowest version seen), `later` (each one above it), or none (all). A file whose written letters fit but whose
 *   tokens do not (a day not on the calendar) is "형식 모름", never a version.
 * Neither answers a decision (◇), so a decision with one is refused; only a `state-log` rule (U4a, below) reads an answer.
 * REQ-125 U3 (research/290 1.2·2.4, 291 F5): `scope: "program"` — a step common to every 건 of the file, read once from the
 * workspace folder and shown once in the "공통" band, never per 건. What such a rule finds inside a 건 folder (path parts
 * compared whole, so `A` is not `AB`) is neither common nor that 건's: "규칙 충돌" (`excluded: rule-conflict`). The kinds never
 * mix — `scope` with `{instance}` and `scope` with `match` are refused, and so is a step holding both kinds of rule.
 */
const versionKeys = { ver: z.enum(['major.minor', 'major.minor.patch', 'integer']), observed: z.enum(['lowest', 'later']).optional() };
// A 건 rule takes `scope` only as absent, so its problems read as before U3; a program rule names it.
const instanceScope = { scope: z.undefined().optional() }, programScope = { scope: z.literal('program') };
/** Characters as a person counts them (code points), not UTF-16 units — the tag line's `[건]`/`[행위]` are counted so too. */
const chars = (value: string) => Array.from(value).length;
/**
 * REQ-125 U4a (research/309 5판 2.1): a `state-log` rule's record file — a fixed workspace-relative path: no `*`, no `{…}`,
 * no `..`, no segment starting with "." or empty, no "/" at the end, never absolute.
 */
export const logFilePath = z.string().min(1).max(200).refine(value => safePattern(value) && !/[*{}]/.test(value),
  'A "state-log" file is a fixed relative path — no "*", no "{…}", no "..", no hidden or empty part.');
/** The heading of the record's own section (`## 건 기록`): 1~40 characters, no space at either end, no line break, "#", "[" or "]". */
export const logSectionName = z.string().refine(value => chars(value) >= 1 && chars(value) <= 40 && value === value.trim() && !/[\n\r#[\]]/.test(value),
  'A "state-log" section is 1~40 characters with no space at either end, no line break, "#", "[" or "]".');
/** A tag's act word (`[제출]`): 1~20 characters, no space at either end, no line break, "[" or "]". */
const logWord = z.string().refine(value => chars(value) >= 1 && chars(value) <= 20 && value === value.trim() && !/[\n\r[\]]/.test(value),
  'A "state-log" word is 1~20 characters with no space at either end, no line break, "[" or "]".');
const logWords = z.array(logWord).min(1).max(8);
/**
 * REQ-125 U4a (research/309 5판 2.1·2.2): `state-log` — a 건's events read from the **pure tag lines** (`- YYYY-MM-DD: [건][행위]`,
 * `- YYYY-MM-DD HH:MM KST: [건][행위]`) of one section of a record file. `words`: a list for a box or end step ("it happened"),
 * `{yes, no}` for a decision (◇). No `scope` (a 건's record only), no `match`, `aliases`, `tags`, `lines` or `time`.
 */
const stateLogSchema = z.strictObject({ stage: stageId, read: z.literal('state-log'), files: z.array(logFilePath).min(1).max(4), section: logSectionName,
  words: z.union([logWords, z.strictObject({ yes: logWords, no: logWords })]) });
export const workflowSource2Schema = z.discriminatedUnion('read', [
  z.discriminatedUnion('scope', [
    z.strictObject({ stage: stageId, read: z.literal('folder'), ...instanceScope, files: z.array(instancePattern).min(1).max(8) }),
    z.strictObject({ stage: stageId, read: z.literal('folder'), ...programScope, files: z.array(programPattern).min(1).max(8) }),
  ]),
  z.discriminatedUnion('scope', [
    z.strictObject({ stage: stageId, read: z.literal('file-versions'), ...instanceScope, files: z.array(versionPattern).min(1).max(8), ...versionKeys }),
    z.strictObject({ stage: stageId, read: z.literal('file-versions'), ...programScope, files: z.array(programVersionPattern).min(1).max(8), ...versionKeys }),
  ]),
  stateLogSchema,
]);
export type WorkflowSource2 = z.infer<typeof workflowSource2Schema>;
export const workflowDefinition2Schema = z.strictObject({
  format: z.literal(WORKFLOW_FORMAT_2), features: z.array(featureName).min(1).max(16),
  name: z.string().min(1).max(80), note: z.string().max(400).optional(),
  instanceKey: instanceKeySchema,
  stages: z.array(stageSchema).min(1).max(16), edges: z.array(edgeSchema).max(40), sources: z.array(workflowSource2Schema).max(20),
}).superRefine((def, ctx) => {
  checkSteps(def, ctx);
  if (new Set(def.features).size !== def.features.length) ctx.addIssue({ code: 'custom', message: 'A feature is named twice.' });
  // Every feature used is named (research/290 1.0): a file cannot lean on one it does not say.
  if (!def.features.includes('instance-folder')) ctx.addIssue({ code: 'custom', message: 'instanceKey needs the feature "instance-folder".' });
  for (const kind of ['folder', 'file-versions'] as const) if (def.sources.some(s => s.read === kind) && !def.features.includes(kind))
    ctx.addIssue({ code: 'custom', message: `A "${kind}" rule needs the feature "${kind}".` });
  const program = (s: WorkflowSource2) => 'scope' in s && s.scope === 'program';
  if (def.sources.some(program) && !def.features.includes('program'))
    ctx.addIssue({ code: 'custom', message: 'A "scope": "program" rule needs the feature "program".' });
  if (def.sources.some(s => s.read === 'state-log') && !def.features.includes('state-log'))
    ctx.addIssue({ code: 'custom', message: 'A "state-log" rule needs the feature "state-log".' });
  // research/290 1.2: a step is common to every 건 or read per 건, never both.
  for (const stage of new Set(def.sources.map(s => s.stage))) {
    const rules = def.sources.filter(s => s.stage === stage);
    if (new Set(rules.map(program)).size > 1)
      ctx.addIssue({ code: 'custom', message: `The step ${stage} mixes a "program" rule with a 건 rule: a step is common to every 건 or read per 건, not both.` });
    // U4a (research/309 2.1): a step reads its record or its folders, never both — in either order.
    if (new Set(rules.map(s => s.read === 'state-log')).size > 1)
      ctx.addIssue({ code: 'custom', message: `The step ${stage} mixes a "state-log" rule with a "folder" or "file-versions" rule: a step reads a record or folders, not both.` });
  }
  const diamonds = new Set(def.stages.filter(s => s.shape === 'diamond').map(s => s.id));
  for (const s of def.sources) {
    if (s.read === 'state-log') {
      // U4a: a decision's words are its answers ({yes, no}); any other step's a list (it happened).
      if (diamonds.has(s.stage) && Array.isArray(s.words))
        ctx.addIssue({ code: 'custom', message: `The decision ${s.stage} reads answers: its "state-log" words are {"yes": […], "no": […]}, not a list.` });
      if (!diamonds.has(s.stage) && !Array.isArray(s.words))
        ctx.addIssue({ code: 'custom', message: `The step ${s.stage} is no decision: its "state-log" words are a list, not {"yes", "no"}.` });
      if (new Set(s.files.map(f => f.normalize('NFC'))).size !== s.files.length)
        ctx.addIssue({ code: 'custom', message: `A "state-log" rule of ${s.stage} names a file twice.` });
    } else if (diamonds.has(s.stage))
      ctx.addIssue({ code: 'custom', message: `The decision ${s.stage} cannot take a reading rule: "${s.read}" only says ${s.read === 'folder' ? 'data is' : 'which versions are'} there, never an answer.` });
  }
  // U4a (research/309 2.6): over every `state-log` rule reading one file, a word is in one list of one rule only — so a tag line
  // is at most one rule, one step, one answer, whatever the steps, the sections or the order of the rules.
  const seen = new Map<string, string>();
  for (const s of def.sources) {
    if (s.read !== 'state-log') continue;
    const lists = Array.isArray(s.words) ? [s.words] : [s.words.yes, s.words.no];
    for (const file of new Set(s.files.map(f => f.normalize('NFC')))) for (const list of lists) for (const word of list) {
      const at = file + '\0' + word.normalize('NFC');
      if (seen.has(at)) ctx.addIssue({ code: 'custom', message: `The word "${word}" is read twice from ${file} (${seen.get(at)} and ${s.stage}): over the rules reading one file, a word means one thing.` });
      else seen.set(at, s.stage);
    }
  }
});
export type WorkflowDefinition2 = z.infer<typeof workflowDefinition2Schema>;
/** The features a `/2` file names that this build does not read (none for any other file, or one whose list is not a list of names). */
export function unreadFeatures(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== WORKFLOW_FORMAT_2) return [];
  const features = (raw as { features?: unknown }).features;
  if (!Array.isArray(features) || !features.every(f => typeof f === 'string')) return [];
  const known: readonly string[] = WORKFLOW_FEATURES;
  // A word that is not a feature name at all is no newer feature: the schema calls the file 형식 모름.
  return [...new Set((features as string[]).filter(f => featureName.safeParse(f).success && !known.includes(f)))].slice(0, 10);
}

// ---- the model the server returns --------------------------------------------------------------------------------
export const verdictSchema = z.enum(['pass', 'conditional', 'fail', 'unknown']);
export type Verdict = z.infer<typeof verdictSchema>;
/**
 * One thing read from a document. `path` is relative to the workspace folder; `line` (1-based) and `excerpt` (the verdict
 * or title line) are the evidence the screen shows, since a plugin cannot open a file.
 * `releaseFrom`: how the release was found — the file name, its text, the REQ table (`req`), the document order among
 * releases naming the same REQ (`order`), a commit title (`bump`), or, for a commit whose title could not be read, the
 * stable result's hash (`stable-sha`).
 */
export const workflowEventSchema = z.object({
  stage: z.string(), kind: z.enum(['heading', 'document', 'verdict', 'result', 'commit', 'folder', 'version', 'log']),
  release: z.string().nullable(), releaseFrom: z.enum(['name', 'text', 'req', 'order', 'bump', 'stable-sha']).nullable(),
  /** U4a: a record's evidence quotes up to 300 characters of its line (research/309 2.4); the other kinds stay under 200. */
  path: z.string(), line: z.number().optional(), excerpt: z.string().max(300).optional(),
  doc: z.number().optional(), ids: z.array(z.string()).optional(), round: z.enum(['first', 'again']).optional(),
  verdict: verdictSchema.optional(), marker: z.string().optional(), word: z.string().optional(),
  /** REQ-125 U1 `folder`: how many data files the folder holds (regular, not hidden, not README.*). */
  files: z.number().optional(),
  /**
   * REQ-125 U2 `file-versions` — one event per version of a document (not per file). `ver`: the version as numbers
   * ("1.0" for `v01.0`); absent for a file whose name fits but whose version or day cannot be read ("형식 모름"). `chain`:
   * the document — its folder inside the 건 and its name without the tokens. `observed`: `lowest` (the lowest version seen in
   * the chain) or `later` (one above it); `seen`: how many versions the chain shows. `paths`: every file of this version
   * (DOCX and PDF of one version are one event), `path` the first. `time`: its earliest day; `days`: how many days its files name.
   */
  ver: z.string().optional(), chain: z.string().optional(), observed: z.enum(['lowest', 'later']).optional(), seen: z.number().optional(),
  paths: z.array(z.string()).optional(), days: z.number().optional(),
  time: z.string().nullable().optional(), sha: z.string().optional(), subject: z.string().max(200).optional(),
  /** result-head: false when the title holds a failure word. */
  ok: z.boolean().optional(),
  /** result-head: the folder is there but its result file is not ("자료 없음"). */
  missing: z.literal(true).optional(),
  /** result-head: the version came from the first lines, not after the key word. */
  approx: z.literal(true).optional(),
  /**
   * REQ-125 U4a `state-log` (research/309 5판 2.4·3·8.2) — one piece of a record's evidence. `strength`: `confirmed` (a pure tag
   * line of a shown 건 whose act is this step's word, not later than the reading) or `ambiguous` (it stops an answer); `answer`: a
   * decision's yes or no; `word`: the act as written; `time`: the line's KST day or minute as written ("2026-10-01",
   * "2026-10-01 17:00 KST"), absent for a line read as no tag line; `why` (ambiguous only): `not-a-tag-line` (any other writing in
   * the section — no time, every 건), `unknown-word`, `future`, `hidden-overlap` (the name is also a 건 not shown),
   * `unknown-instance` / `stripped-name` (a name no row shows, or one only a number-stripped name fits — every 건). `scope: 'all'`:
   * it stands in every 건's cell of the step (in the model's `logShared`, not in each row). `earlier`: earlier than every latest
   * confirmed one, so it does not stop the answer. `section`: the record section it was read in.
   */
  answer: z.enum(['yes', 'no']).optional(), strength: z.enum(['confirmed', 'ambiguous']).optional(),
  why: z.enum(['not-a-tag-line', 'unknown-word', 'future', 'hidden-overlap', 'unknown-instance', 'stripped-name']).optional(),
  scope: z.literal('all').optional(), earlier: z.literal(true).optional(), section: z.string().optional(),
});
export type WorkflowEventDTO = z.infer<typeof workflowEventSchema>;
/**
 * A stage's cell in one release:
 * - `found` (확인됨): events read, each with its source
 * - `unknown-format` (형식 모름): the files are there but their verdict/version could not be read
 * - `no-record` (기록 없음): the stage has a reading rule but nothing for this release — never "not done"
 * - `no-source` (읽을 자료 없음): no reading rule for this stage (a step only in the procedure, e.g. a person's check)
 * - `title-unread` (커밋 제목 못 읽음): the commit title could not be read; the hash comes from the stable result
 * - `decision`: a diamond; its answer is the release's `firstVerdict`/`finalVerdict`
 * REQ-125 U1 (research/290 1.3·3.1), a 건's cells only — the grade is never hidden:
 * - `candidate` (후보): read from words that only suggest it (no reading makes it since U4a — research/309 3.1); `ambiguous` (모호): the record evidence disagrees or cannot be read as a tag line (U4a)
 * - `incomplete` (일부만 읽음): a cap, or a folder this host could not list safely, stopped the reading — never "기록 없음"
 * - (U2) `unknown-format` too: a `file-versions` cell whose files fit the name but none whose version could be read
 */
export const cellStateSchema = z.enum(['found', 'unknown-format', 'no-record', 'no-source', 'title-unread', 'decision', 'candidate', 'ambiguous', 'incomplete']);
export type CellState = z.infer<typeof cellStateSchema>;
const tally = z.object({ count: z.number(), pass: z.number(), conditional: z.number(), fail: z.number(), unknown: z.number() });
export type WorkflowTally = z.infer<typeof tally>;
export const workflowReleaseSchema = z.object({
  /** A release version, or (REQ-125 U1, `unit: 'instance'`) a 건's id: its workspace-relative folder path in NFC. */
  release: z.string(),
  /** REQ-125 U1: a 건's shown name (`instanceKey.label`). */
  label: z.string().optional(),
  /** REQ/D ids of the release: from the REQ table's done version (`heading`) and the titles of its verdict reports (`report`). */
  reqs: z.array(z.object({ id: z.string(), via: z.enum(['heading', 'report']), path: z.string(), line: z.number().optional() })),
  firstVerdict: verdictSchema.nullable(), finalVerdict: verdictSchema.nullable(), regates: z.number(),
  cells: z.array(z.object({ stage: z.string(), state: cellStateSchema, events: z.array(workflowEventSchema),
    /**
     * REQ-125 U3 311-F2: files this 건 rule would have read that a `scope: "program"` rule took as 규칙 충돌 (research/290 1.2·2.4 —
     * neither common nor the 건's): not counted, said here so the cell tells why. Absent when there are none.
     */
    conflicts: z.array(z.string()).optional(),
    /**
     * REQ-125 U4a (research/309 3.2): a decision's answer, when its record cell is confirmed. `shared`: how many of the model's
     * `logShared` (evidence standing in every 건) count in this cell, its step's first ones; `earlierShared`: those of them
     * (indexes into `logShared`) earlier than every latest confirmed piece of this cell. Absent for a cell no record rule reads.
     */
    answer: z.enum(['yes', 'no']).optional(), shared: z.number().optional(), earlierShared: z.array(z.number()).optional() })),
  /** The way the release went, in order: stages in column order, and the loop's stages (ends of a `back` edge) by document number. */
  path: z.array(z.object({ stage: z.string(), doc: z.number().optional(), round: z.enum(['first', 'again']).optional(),
    verdict: verdictSchema.optional() })),
  /** The commit's hash differs from the hash a result file (`sha: 'dir-suffix'`) names for the same release. */
  warnings: z.array(z.object({ kind: z.literal('sha-mismatch'), stage: z.string(), sha: z.string(), resultStage: z.string(),
    resultSha: z.string(), path: z.string() })),
  /**
   * REQ-125 U4b (research/309 4.3): a 건 that ended at an end step (a pill no line leaves, reached by a decision's `when` branch) —
   * `stage`, the steps whose confirmed records found it (`by`: the end step's own, a decision answered that way) and the latest of
   * them (`time`, as written). `held`: the tag is not shown, and why — `disagree` (a decision into it or its own cell is ambiguous,
   * read in part or answered the other way), `branches` (325-J3: the founding decision's answer has more than one line), `incomplete` (another cell of the 건 is read in part, 312 J6), `undated` (another
   * event of the 건 has no single day), `later` (another event is not surely earlier); `at` names that step or `path:line`.
   * Absent when no confirmed record founds one — always for a reading with no `state-log` rule.
   */
  endTag: z.object({ stage: z.string(), by: z.array(z.string()), time: z.string().optional(),
    held: z.enum(['disagree', 'branches', 'incomplete', 'undated', 'later']).optional(), at: z.string().optional() }).optional(),
});
export type WorkflowReleaseDTO = z.infer<typeof workflowReleaseSchema>;
export const workflowModelSchema = z.object({
  defined: z.literal(true), definitionPath: z.string(), key: z.string().max(64), readAt: z.string(),
  definition: z.object({ name: z.string(), note: z.string().optional(), releaseWindow: z.number(),
    stages: z.array(stageSchema), edges: z.array(edgeSchema) }),
  /** Newest first, at most `releaseWindow` (or the request's `window`). */
  releases: z.array(workflowReleaseSchema),
  /** Per stage (and round, for verdict rules): over the releases shown (`window`) and over everything read (`all`). */
  totals: z.array(z.object({ stage: z.string(), round: z.enum(['first', 'again']).optional(), window: tally, all: tally })),
  /** Every verdict report read, oldest first — the evidence table and the hand counts (research/142) come from here. */
  reports: z.array(workflowEventSchema),
  unknownFormat: z.array(z.object({ stage: z.string(), path: z.string() })),
  missing: z.array(z.object({ stage: z.string(), path: z.string() })),
  git: z.object({ state: z.enum(['read', 'no-repo', 'no-log', 'no-commits', 'unused']), commits: z.number() }),
  cost: z.object({ files: z.number(), bytes: z.number(), ms: z.number() }),
  /** A cap was reached (too many files, a file too large to read whole, too many bytes): the numbers may be short. */
  limits: z.array(z.string()),
  /**
   * REQ-125: the definition is the built-in workflow this workspace is trying (shared/workflow-templates.ts, kept in the
   * plugin's `workflow-picks.json`), not a file — no file in the workspace was read. Absent for a definition file.
   */
  builtin: z.object({ id: z.string().max(40), version: z.number(), grade: z.enum(['verified', 'adapted', 'reference']) }).optional(),
  /** REQ-125: a built-in is picked for this workspace, but its definition file wins; the pick rests (its id). */
  restingPick: z.string().max(40).optional(),
  /**
   * REQ-125 U1 (research/290 1.3): `instance` — the rows (`releases`) are 건, read from a `/2` file. Absent for releases
   * (`/1`), so a `/1` reading stays what it was, byte for byte.
   */
  unit: z.literal('instance').optional(),
  /** The 건 folder (`instanceKey.path` without its `/*`) and whether it is there. */
  instanceFolder: z.object({ path: z.string(), found: z.boolean() }).optional(),
  /**
   * Folders not taken as a 건 or as evidence, and why: a symbolic link, two names that are one in NFC (both left out, never
   * merged), a hidden name (`.`, `@`, `#`), a place outside the workspace, an entry whose kind the listing did not say.
   * U3 `rule-conflict`: what a `scope: "program"` rule found inside a 건 folder — neither common nor that 건's.
   */
  excluded: z.array(z.object({ path: z.string(), why: z.enum(['link', 'nfc-collision', 'hidden', 'outside', 'unknown-kind', 'rule-conflict']) })).optional(),
  /** Folders read only in part — a cap, or a folder this host could not list safely; the cells they leave empty say "일부만 읽음". */
  incomplete: z.array(z.string()).optional(),
  /**
   * REQ-125 U3 (research/290 2.4·3): the steps of `scope: "program"` rules, read once for every 건 — their cells (shaped as a
   * 건's, but in no row and no table column) and, per step, what they found inside a 건 folder (`conflicts`, each also in
   * `excluded` as `rule-conflict`). Absent when the file has no program rule, so a U1/U2 reading stays what it was.
   */
  program: z.object({ cells: z.array(z.object({ stage: z.string(), state: cellStateSchema, events: z.array(workflowEventSchema) })),
    conflicts: z.array(z.object({ stage: z.string(), path: z.string() })) }).optional(),
  /**
   * REQ-125 U4a (research/309 5판 2.4·8.2): evidence of the record files that stands in **every** 건's cell of its step — writing
   * in the section that is no pure tag line (`not-a-tag-line`, no time) and a pure line whose name no row shows (`unknown-instance`,
   * `stripped-name`). Kept once here, at most `eventsPerRule` per step, each cell saying how many count (`shared`). Absent when
   * the file has no `state-log` rule, so a U1~U3 reading stays what it was.
   */
  logShared: z.array(workflowEventSchema).optional(),
  /**
   * REQ-125 U4a: what the heading says about the records — `no-section` (the file or its section is not there: the cells say
   * "기록 없음"), `not-a-tag-line` (writing in the section that is no tag line: its lines, the first 20), `section-in-comment` (a
   * heading of that name inside an HTML comment — not a section), `other-item` (a tag naming a folder that is no row: a link, an
   * excluded or hidden one, one past the 200 — left to it), `untaggable` (a 건 whose shown name cannot be written in a tag).
   */
  logNotes: z.array(z.object({ kind: z.enum(['no-section', 'not-a-tag-line', 'section-in-comment', 'other-item', 'untaggable']),
    path: z.string(), section: z.string().optional(), lines: z.array(z.number()).optional(), count: z.number().optional(),
    name: z.string().optional(), missing: z.literal(true).optional() })).optional(),
});
export type WorkflowModelDTO = z.infer<typeof workflowModelSchema>;
export const workflowAbsentSchema = z.object({ defined: z.literal(false),
  reason: z.enum(['missing', 'unknown-format', 'too-large', 'outside', 'unreadable', 'needs-update']),
  /** `needs-update` (REQ-125 U1): the `/2` features this build does not read, by name; otherwise the parse problems. */
  definitionPath: z.string(), problems: z.array(z.string()).optional(),
  /** REQ-125: a built-in is picked here, but a definition file is there (unreadable as it is) and wins; the pick rests. */
  restingPick: z.string().max(40).optional() });
export type WorkflowAbsentDTO = z.infer<typeof workflowAbsentSchema>;
export const workflowDataSchema = z.discriminatedUnion('defined', [workflowAbsentSchema, workflowModelSchema]);
export type WorkflowDTO = z.infer<typeof workflowDataSchema>;
