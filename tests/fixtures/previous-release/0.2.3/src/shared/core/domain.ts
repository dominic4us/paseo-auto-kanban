export type UUID = string;
export type Time = string;
export type Revision = string;
export type Locale = 'en' | 'ko';
/**
 * D22: the one spelling of a workspace directory that the server, the client and the tests compare.
 * Trailing separators are dropped and the path is folded to Unicode NFC, so the same directory written
 * two ways still matches the one board that lives there.
 * D44: a Windows path (a drive letter, or a `\\server\share` UNC path) is also spelled with `/` and a lower-case drive
 * letter, so `C:\a\b`, `c:/a/b/` and `C:/a/b\` are one folder. A POSIX path keeps its backslashes, which are part of a name there.
 */
export function normalizeCwd(cwd: string): string {
  let trimmed = cwd.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:(?:[\\/]|$)/.test(trimmed)) trimmed = trimmed[0]!.toLowerCase() + trimmed.slice(1).replace(/\\/g, '/');
  else if (/^\\\\[^\\/]/.test(trimmed)) trimmed = trimmed.replace(/\\/g, '/');
  return typeof trimmed.normalize === 'function' ? trimmed.normalize('NFC') : trimmed;
}
/**
 * 247-D4: the key two spellings of one folder are compared by — never a path to open. A Windows folder (a drive letter,
 * or a `\\server\share` / `//server/share` UNC path) ignores case by default, so `C:\A\B` and `c:/a/b/` are one folder
 * and one switch; its key is folded to lower case. A POSIX path keeps its case: `/A` and `/a` are different folders.
 * `normalizeCwd` stays the spelling that is opened and shown.
 */
export function folderKey(cwd: string): string {
  const spelled = normalizeCwd(cwd);
  return /^[a-z]:(?:\/|$)/.test(spelled) || /^\/\/[^/]/.test(spelled) ? spelled.toLowerCase() : spelled;
}
/** D44/249-D3: one saved switch of a workspace's automatic cards; the key it is saved under is the folder's spelling (`normalizeCwd`). */
export interface FolderSwitch { enabled: boolean; changedAt: string }
/**
 * 249-D3: the switch of the workspaces at these folders, judged from every saved switch — the one judgement the engine, the
 * read handlers (what the settings window shows) and the save obey. A switch belongs to the spelling it was saved under:
 * on a Windows directory that tells case apart, `C:\Fixture\A` and `C:\Fixture\a` are two folders, and turning one back on
 * must not turn the other on. Two spellings of one folder (247-D4: Windows case, slashes, a trailing separator) still read
 * as one switch when they disagree, on the safe side:
 * - the folder's own spelling saved "off" → off; saved "on" → on, unless another spelling of it was turned off later;
 * - no switch under its own spelling → off if any spelling of it is off, else on (the start line is the latest "on").
 * Off when any of the folders is off — an agent's own folder, its board's, its worktree's root.
 */
export function folderSwitch(switches: Readonly<Record<string, FolderSwitch>>, cwds: readonly (string | null | undefined)[]):
  { enabled: boolean; since: string | null } {
  let since: string | null = null;
  for (const cwd of cwds) {
    if (!cwd) continue;
    const spelled = normalizeCwd(cwd), key = folderKey(cwd);
    let own: FolderSwitch | null = null;
    const others: FolderSwitch[] = [];
    for (const [saved, entry] of Object.entries(switches)) {
      if (folderKey(saved) !== key) continue;
      if (normalizeCwd(saved) !== spelled) others.push(entry);
      else if (!own || entry.changedAt > own.changedAt) own = entry;
    }
    const off = own ? !own.enabled || others.some(o => !o.enabled && o.changedAt > own!.changedAt) : others.some(o => !o.enabled);
    if (off) return { enabled: false, since: null };
    const on = own?.changedAt ?? others.map(o => o.changedAt).sort().at(-1) ?? null;
    if (on && (!since || on > since)) since = on;
  }
  return { enabled: true, since };
}
export type Actor = {
    kind: 'user';
} | {
    kind: 'agent';
    agentId: UUID;
};
export interface DomainContext {
    newId(): UUID;
    now(): Time;
}
export interface Stage {
    stageId: string;
    name: string;
    countsAsDone: boolean;
}
export interface Template {
    schemaVersion: 1;
    id: string;
    version: number;
    name: string;
    stages: Stage[];
}
export interface AgentLink {
    agentId: UUID;
    role: string;
    label: string;
    linkedAt: Time;
}
export interface Card {
    id: string;
    title: string;
    stageId: string;
    acceptanceCriteria: string;
    notes: string;
    priority: 'high' | 'normal' | 'low';
    blockedReason: string | null;
    nextAction: string;
    intent: 'draft' | 'requested';
    awaiting: 'agent' | 'user' | null;
    deliverables: string[];
    agents: AgentLink[];
    createdBy: Actor;
    createdAt: Time;
    updatedAt: Time;
    archivedAt: Time | null;
    /** REQ-97: a draft sent to the workspace's lead by moving it to the working stage. Absent on every other card. */
    dispatch?: CardDispatch;
    /**
     * REQ-108: when the card entered the stage it is in, set by every write that changes its stage. Absent on a card not
     * moved since it was created, and on a ledger written before it — the movement history says it then (read-model).
     */
    stageEnteredAt?: Time;
    /**
     * REQ-52: why the card is archived, when it was not a person's own act — `auto`, the plugin's automatic archive of a card
     * that sat in a completion stage for the set number of days. Present only while the card is archived; a restore takes it off.
     */
    archiveReason?: 'auto';
    /** REQ-52: when the card was last restored — the automatic archive counts its days from then again (`archiveClock`). */
    restoredAt?: Time;
}
/**
 * REQ-97: `pending` waits for the lead to be idle, `sent` was delivered once (`messageId` makes a repeat a no-op in
 * the daemon), `noLead` found no lead to send to and is retried when one appears, `cancelled` was moved back first.
 */
export type DispatchState = 'pending' | 'sent' | 'noLead' | 'cancelled';
export interface CardDispatch {
    state: DispatchState;
    targetAgentId: UUID | null;
    requestedAt: Time;
    sentAt: Time | null;
    messageId: string;
}
/** REQ-97: one message id per request, derived from the card and the moment it was requested. */
export function dispatchMessageId(cardId: string, requestedAt: Time): string {
    return 'kanban-dispatch-' + cardId.slice(5) + '-' + new Date(requestedAt).getTime().toString(36);
}
/** REQ-97: where a draft goes when it is sent — the template's second open stage (the working one), or none. */
export function dispatchStage<S extends Pick<Stage, 'stageId' | 'countsAsDone'>>(stages: readonly S[]): S | undefined {
    return stages.filter(s => !s.countsAsDone)[1];
}
export interface MoveRecord {
    cardId: string;
    from: string | null;
    to: string;
    actor: Actor;
    at: Time;
    revision: Revision;
}
export interface Receipt {
    requestId: UUID;
    digest: string;
    revision: Revision;
    cardIds: string[];
}
export interface Board {
    schemaVersion: 1;
    id: string;
    workspaceId: string;
    cwd: string;
    workspaceStatus: 'active' | 'inactive' | 'unknown';
    template: Template;
    revision: Revision;
    cards: Card[];
    history: MoveRecord[];
    receipts: Receipt[];
    createdAt: Time;
    updatedAt: Time;
}
export interface Config {
    schemaVersion: 1;
    exportEnabled: boolean;
    locale: Locale;
    export: { detail: 'compact' | 'full' };
}
export interface Warning {
    code: string;
    message: string;
    target: string;
    nextAction: string;
}
export interface KanbanError extends Error {
    readonly code: string;
    readonly target: string;
    readonly nextAction: string;
    readonly details: unknown;
    readonly committed: false | 'unknown';
}
/** Native Error with the existing enumerable payload; no client-side class syntax. */
export function createKanbanError(
    code: string, message: string, target = '',
    nextAction = 'Review the input and retry.', details: unknown = null,
    committed: false | 'unknown' = false,
): KanbanError {
    return Object.assign(new Error(message), { code, target, nextAction, details, committed,
        name: 'KanbanError' });
}
/** Recognize errors across module copies and realms without a custom constructor. */
export function isKanbanError(value: unknown): value is KanbanError {
    if (!value || typeof value !== 'object' || Object.prototype.toString.call(value) !== '[object Error]')
        return false;
    const error = value as Partial<KanbanError>;
    return error.name === 'KanbanError' && typeof error.message === 'string' &&
        typeof error.code === 'string' && typeof error.target === 'string' &&
        typeof error.nextAction === 'string' && 'details' in error &&
        (error.committed === false || error.committed === 'unknown');
}
export function fail(code: string, message: string, target = '', nextAction?: string, details?: unknown): never {
    throw createKanbanError(code, message, target, nextAction, details);
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,47}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
export function isUUID(value: unknown): value is UUID { return typeof value === 'string' && UUID_PATTERN.test(value); }
export function isBoardId(value: string): boolean { return /^board_[0-9a-f]{64}$/.test(value); }
export function isWorkspaceId(value: string): boolean { return /^(wks_[A-Za-z0-9_-]{1,128}|local_[0-9a-f]{64})$/.test(value); }
function check(value: unknown, message: string, target = ''): asserts value {
    if (!value)
        fail('E_VALIDATION', message, target);
}
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object.');
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record))
        check(required.includes(key) || optional.includes(key), 'Unknown field.', key);
    for (const key of required)
        check(Object.hasOwn(record, key), 'Missing field.', key);
    return record;
}
function enumeration<T>(value: unknown, options: readonly T[], target = ''): T {
    check(options.includes(value as T), 'Unexpected value.', target);
    return value as T;
}
function text(value: unknown, limit: number, target: string, trim = false, empty = true, multiline = false): string {
    check(typeof value === 'string', 'Expected a string.', target);
    let result = value.replace(/\r\n/g, '\n');
    if (trim)
        result = result.trim();
    check((result.length <= limit || [...result].length <= limit) && (empty || result.length > 0), 'Invalid text length.', target);
    check(!(multiline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(result), 'Control characters are not allowed.', target);
    return result;
}
function storedText(value: unknown, limit: number, target: string, trim = false, empty = true, multiline = false): void {
    check(value === text(value, limit, target, trim, empty, multiline), 'Stored text must be normalized.', target);
}
export function validateTime(value: unknown): asserts value is Time {
    check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value), 'Invalid timestamp.');
    const date = new Date(value);
    check(Number.isFinite(date.getTime()) && date.toISOString() === value, 'Invalid timestamp.');
}
export function validateActor(value: unknown): asserts value is Actor {
    const a = object(value, ['kind'], ['agentId']);
    if (a.kind === 'user')
        check(!Object.hasOwn(a, 'agentId'), 'A user actor has no agentId.');
    else
        check(a.kind === 'agent' && isUUID(a.agentId), 'Invalid agent actor.');
}
export function validateRevision(value: unknown): asserts value is Revision {
    check(typeof value === 'string', 'Invalid revision.');
    const [epoch, seq, extra] = value.split(':');
    check(isUUID(epoch) && extra === undefined && /^[1-9]\d*$/.test(seq ?? '') && Number.isSafeInteger(Number(seq)), 'Invalid revision.');
}
export function nextRevision(revision: Revision): Revision {
    validateRevision(revision);
    const [epoch, seq] = revision.split(':');
    const n = Number(seq) + 1;
    if (!Number.isSafeInteger(n))
        fail('E_LIMIT', 'Revision counter exhausted.', revision, 'Restore with a new epoch.');
    return `${epoch}:${n}`;
}
export function validateConfig(value: unknown): asserts value is Config {
    const c = object(value, ['schemaVersion', 'exportEnabled', 'locale', 'export']);
    if (c.schemaVersion !== 1)
        fail('E_SCHEMA_VERSION', 'Unsupported configuration schema.');
    check(typeof c.exportEnabled === 'boolean', 'Invalid export setting.');
    enumeration(c.locale, ['en', 'ko']);
    const output = object(c.export, ['detail']);
    enumeration(output.detail, ['compact', 'full']);
}
export const messages = {
    en: { template: 'Basic workflow',
         stages: ['Waiting',
         'In progress',
         'Review',
         'Done'],
         generated: 'Generated file. Use kanban commands instead of editing this file.',
         heading: 'Work progress',
         progress: 'Progress',
         drafts: 'Drafts',
         archived: 'Archived',
         changed: 'Last changed',
         awaiting: 'Awaiting',
         agents: 'Assigned',
         none: 'None',
         criteria: 'Acceptance criteria',
         blocked: 'Blocked',
         next: 'Next action',
         notes: 'Notes',
         deliverables: 'Deliverables' },
    ko: { template: '기본 업무',
         stages: ['대기',
         '진행',
         '검토',
         '완료'],
         generated: '자동 생성 파일입니다. 직접 고치지 말고 kanban 명령을 사용하세요.',
         heading: '업무 진행',
         progress: '진행',
         drafts: '초안',
         archived: '보관',
         changed: '마지막 변경',
         awaiting: '기다림',
         agents: '담당',
         none: '없음',
         criteria: '완료 기준',
         blocked: '차단',
         next: '다음 행동',
         notes: '메모',
         deliverables: '산출물' },
} as const;
const valueLabels = {
    en: { draft: 'Draft', requested: 'Requested', high: 'High', normal: 'Normal', low: 'Low', agent: 'Agent', user: 'User' },
    ko: { draft: '초안', requested: '실행 요청', high: '높음', normal: '보통', low: '낮음', agent: '에이전트', user: '사용자' },
} as const;
export function builtinTemplate(locale: Locale = 'en'): Template {
    const m = messages[locale];
    return { schemaVersion: 1, id: 'basic', version: 1, name: m.template,
        stages: ['todo', 'doing', 'review', 'done'].map((stageId, i) => ({ stageId, name: m.stages[i]!, countsAsDone: i === 3 })) };
}
export function validateTemplate(value: unknown): asserts value is Template {
    const t = object(value, ['schemaVersion', 'id', 'version', 'name', 'stages']);
    if (t.schemaVersion !== 1)
        fail('E_SCHEMA_VERSION', 'Unsupported template schema.');
    check(typeof t.id === 'string' && NAME_PATTERN.test(t.id), 'Invalid template id.');
    check(Number.isSafeInteger(t.version) && Number(t.version) > 0, 'Invalid template version.');
    storedText(t.name, 200, 'name', true, false);
    check(Array.isArray(t.stages) && t.stages.length >= 2 && t.stages.length <= 16, 'Expected 2 to 16 stages.');
    const ids = new Set<string>();
    let done = false;
    for (const entry of t.stages) {
        const st = object(entry, ['stageId', 'name', 'countsAsDone']);
        check(typeof st.stageId === 'string' && NAME_PATTERN.test(st.stageId) && !ids.has(st.stageId), 'Invalid or duplicate stage id.');
        ids.add(st.stageId);
        storedText(st.name, 200, 'name', true, false);
        check(typeof st.countsAsDone === 'boolean', 'Invalid completion flag.');
        done ||= st.countsAsDone;
    }
    check(done && !(t.stages[0] as Stage).countsAsDone, 'The first stage must be incomplete, with at least one completion stage.');
}
const EDITABLE = ['title', 'acceptanceCriteria', 'notes', 'priority', 'blockedReason', 'nextAction', 'intent', 'awaiting', 'deliverables'] as const;
export type CardPatch = Partial<Pick<Card, typeof EDITABLE[number]>>;
export type AddInput = CardPatch & {
    title: string;
    stageId?: string;
};
export type Operation = ({
    op: 'add';
} & AddInput) | {
    op: 'move';
    id: string;
    to: string;
} | {
    op: 'update';
    id: string;
    patch: CardPatch;
} | {
    op: 'link';
    id: string;
    agentId: UUID;
    role?: string;
    label?: string;
} | {
    op: 'unlink';
    id: string;
    agentId: UUID;
} | {
    op: 'archive';
    id: string;
    /** REQ-52: `auto` only from the plugin's automatic archive (caller `archiver`), and only for a card in a completion stage. */
    reason?: 'auto';
} | {
    op: 'restore';
    id: string;
} | {
    /** REQ-97: send a draft to the lead — it becomes requested work in the working stage, waiting to be sent. */
    op: 'dispatch';
    id: string;
    to: string;
    acceptanceCriteria?: string;
    /** 253-D2: the agent the confirmation sheet named — the request goes to it while it is still one to send to. */
    targetAgentId?: UUID;
} | {
    /** REQ-97: the server's record of what became of a waiting request. */
    op: 'dispatched';
    id: string;
    state: 'pending' | 'sent' | 'noLead';
    targetAgentId: UUID | null;
};
function paths(value: unknown): string[] {
    check(Array.isArray(value) && value.length <= 32, 'Expected at most 32 deliverable paths.');
    const result: string[] = [];
    for (const p of value) {
        const name = text(p, 1024, 'deliverables', false, false);
        check(!name.includes('\\') && !/^[A-Za-z]:/.test(name) && name.split('/').every(x => x !== '' && x !== '.' && x !== '..'), 'Expected a relative deliverable path.');
        if (!result.includes(name))
            result.push(name);
    }
    return result;
}
function patch(value: unknown, allowStage = false): CardPatch & {
    stageId?: string;
} {
    const input = object(value, [], [...EDITABLE, ...(allowStage ? ['stageId'] : [])]);
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input)) {
        switch (key) {
            case 'title':
                result[key] = text(val, 200, key, true, false);
                break;
            case 'acceptanceCriteria':
            case 'notes':
                result[key] = text(val, 8000, key, false, true, true);
                break;
            case 'nextAction':
                result[key] = text(val, 1000, key, false, true, true);
                break;
            case 'blockedReason':
                result[key] = val === null ? null : text(val, 1000, key, true, false);
                break;
            case 'priority':
                result[key] = enumeration(val, ['high', 'normal', 'low']);
                break;
            case 'intent':
                result[key] = enumeration(val, ['draft', 'requested']);
                break;
            case 'awaiting':
                result[key] = enumeration(val, ['agent', 'user', null]);
                break;
            case 'deliverables':
                result[key] = paths(val);
                break;
            case 'stageId':
                check(typeof val === 'string' && NAME_PATTERN.test(val), 'Invalid stage id.');
                result[key] = val;
        }
    }
    return result as CardPatch & {
        stageId?: string;
    };
}
export function normalizeOperations(value: unknown): Operation[] {
    check(Array.isArray(value) && value.length > 0, 'Expected a nonempty operation array.');
    if (value.length > 100)
        fail('E_LIMIT', 'A batch may contain at most 100 operations.');
    return value.map(raw => {
        const o = object(raw, ['op'], ['id', 'to', 'patch', 'agentId', 'role', 'label', 'stageId', 'state', 'targetAgentId', 'reason', ...EDITABLE]);
        const kind = enumeration(o.op, ['add', 'move', 'update', 'link', 'unlink', 'archive', 'restore', 'dispatch', 'dispatched'] as const);
        if (kind === 'add') {
            const { op: _, ...input } = o;
            const fields = patch(input, true);
            check(typeof fields.title === 'string', 'Missing title.');
            return { op: 'add', ...fields } as Operation;
        }
        check(typeof o.id === 'string' && o.id.startsWith('card_') && isUUID(o.id.slice(5)), 'Expected a complete card id.', 'id');
        if (kind === 'move') {
            object(o, ['op', 'id', 'to']);
            check(typeof o.to === 'string' && NAME_PATTERN.test(o.to), 'Invalid stage id.');
            return { op: kind, id: o.id, to: o.to };
        }
        if (kind === 'dispatch') {
            object(o, ['op', 'id', 'to'], ['acceptanceCriteria', 'targetAgentId']);
            check(typeof o.to === 'string' && NAME_PATTERN.test(o.to), 'Invalid stage id.');
            check(!Object.hasOwn(o, 'targetAgentId') || isUUID(o.targetAgentId), 'Invalid agent id.', 'targetAgentId');
            return { op: kind, id: o.id, to: o.to,
                ...(Object.hasOwn(o, 'acceptanceCriteria') ? { acceptanceCriteria: text(o.acceptanceCriteria, 8000, 'acceptanceCriteria', false, true, true) } : {}),
                ...(Object.hasOwn(o, 'targetAgentId') ? { targetAgentId: o.targetAgentId as UUID } : {}) };
        }
        if (kind === 'dispatched') {
            object(o, ['op', 'id', 'state', 'targetAgentId']);
            const state = enumeration(o.state, ['pending', 'sent', 'noLead'] as const, 'state');
            check(o.targetAgentId === null ? state !== 'sent' : isUUID(o.targetAgentId), 'Invalid agent id.', 'targetAgentId');
            return { op: kind, id: o.id, state, targetAgentId: o.targetAgentId as UUID | null };
        }
        if (kind === 'update') {
            object(o, ['op', 'id', 'patch']);
            const fields = patch(o.patch);
            check(Object.keys(fields).length > 0, 'Empty patch.');
            return { op: kind, id: o.id, patch: fields };
        }
        if (kind === 'link' || kind === 'unlink') {
            object(o, ['op', 'id', 'agentId'], kind === 'link' ? ['role', 'label'] : []);
            check(isUUID(o.agentId), 'Invalid agent id.');
            return { op: kind, id: o.id, agentId: o.agentId,
                ...(Object.hasOwn(o, 'role') ? { role: text(o.role, 80, 'role', true, false) } : {}),
                ...(Object.hasOwn(o, 'label') ? { label: text(o.label, 200, 'label') } : {}) };
        }
        if (kind === 'archive' && Object.hasOwn(o, 'reason')) {
            object(o, ['op', 'id', 'reason']);
            return { op: kind, id: o.id, reason: enumeration(o.reason, ['auto'] as const, 'reason') };
        }
        object(o, ['op', 'id']);
        return { op: kind, id: o.id } as Operation;
    });
}
function validateDispatch(value: unknown, cardId: string): void {
    const d = object(value, ['state', 'targetAgentId', 'requestedAt', 'sentAt', 'messageId']);
    enumeration(d.state, ['pending', 'sent', 'noLead', 'cancelled'], 'dispatch');
    check(d.targetAgentId === null || isUUID(d.targetAgentId), 'Invalid agent id.', 'dispatch');
    validateTime(d.requestedAt);
    if (d.sentAt !== null)
        validateTime(d.sentAt);
    check((d.state === 'sent') === (d.sentAt !== null) && (d.state !== 'sent' || d.targetAgentId !== null), 'Invalid dispatch state.', 'dispatch');
    check(d.messageId === dispatchMessageId(cardId, d.requestedAt as Time), 'Invalid dispatch message id.', 'dispatch');
}
function validateCard(value: unknown, template: Template): asserts value is Card {
    // REQ-97, REQ-108: `dispatch` and `stageEnteredAt` are optional, so a ledger written before them reads as it always did.
    const c = object(value, ['id', 'stageId', ...EDITABLE, 'agents', 'createdBy', 'createdAt', 'updatedAt', 'archivedAt'], ['dispatch', 'stageEnteredAt', 'archiveReason', 'restoredAt']);
    check(typeof c.id === 'string' && c.id.startsWith('card_') && isUUID(c.id.slice(5)), 'Invalid card id.');
    const fields: Record<string, unknown> = {};
    for (const key of EDITABLE)
        fields[key] = c[key];
    check(stableStringify(patch(fields)) === stableStringify(fields), 'Stored card fields must be normalized.');
    const stage = template.stages.find(s => s.stageId === c.stageId);
    if (!stage) fail('E_TRANSITION', 'Unknown card stage.', String(c.stageId),
        'Use a stageId from kanban ls.',
        { validStageIds: template.stages.map(item => item.stageId) });
    if (c.intent === 'draft')
        check(c.stageId === template.stages[0]!.stageId, 'A draft must stay in the first stage.');
    if (c.intent === 'requested' && !(c.acceptanceCriteria as string).trim())
        fail('E_TRANSITION', 'Requested work requires acceptance criteria.', 'acceptanceCriteria',
            'Provide --criteria or use --intent draft.');
    if (stage.countsAsDone)
        check(c.intent === 'requested' && c.blockedReason === null, 'Completed work must be requested and unblocked.');
    validateActor(c.createdBy);
    validateTime(c.createdAt);
    validateTime(c.updatedAt);
    if (c.archivedAt !== null)
        validateTime(c.archivedAt);
    if (Object.hasOwn(c, 'dispatch'))
        validateDispatch(c.dispatch, c.id as string);
    if (Object.hasOwn(c, 'stageEnteredAt'))
        validateTime(c.stageEnteredAt);
    // REQ-52: the automatic archive's mark rides only on an archived card; a restore's time on any card.
    if (Object.hasOwn(c, 'archiveReason'))
        check(c.archiveReason === 'auto' && c.archivedAt !== null, 'Invalid archive reason.', 'archiveReason');
    if (Object.hasOwn(c, 'restoredAt'))
        validateTime(c.restoredAt);
    check(Array.isArray(c.agents) && c.agents.length <= 32, 'Expected at most 32 agent links.');
    const ids = new Set();
    for (const raw of c.agents) {
        const link = object(raw, ['agentId', 'role', 'label', 'linkedAt']);
        check(isUUID(link.agentId) && !ids.has(link.agentId), 'Invalid or duplicate agent link.');
        ids.add(link.agentId);
        storedText(link.role, 80, 'role', true, false);
        storedText(link.label, 200, 'label');
        validateTime(link.linkedAt);
    }
}
export function validateBoard(value: unknown): asserts value is Board {
    validateBoardInternal(value);
}
function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' ||
        Array.isArray(a) !== Array.isArray(b)) return false;
    const left = Object.keys(a); const right = Object.keys(b);
    return left.length === right.length && left.every(key => Object.hasOwn(b, key) &&
        sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
/** Creates a bounded, private memo for validating a group of immutable snapshots. */
export function createBoardValidator(): (value: unknown) => asserts value is Board {
    const cards = new Map<string, Card>();
    return (value: unknown): asserts value is Board => validateBoardInternal(value, cards);
}
function validateBoardInternal(value: unknown, memo?: Map<string, Card>): asserts value is Board {
    const b = object(value, ['schemaVersion', 'id', 'workspaceId', 'cwd', 'workspaceStatus', 'template', 'revision', 'cards', 'history', 'receipts', 'createdAt', 'updatedAt']);
    if (b.schemaVersion !== 1)
        fail('E_SCHEMA_VERSION', 'Unsupported board schema.');
    check(typeof b.id === 'string' && isBoardId(b.id), 'Invalid board id.');
    check(typeof b.workspaceId === 'string' && isWorkspaceId(b.workspaceId), 'Invalid workspace id.');
    check(typeof b.cwd === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(b.cwd) && !/[\x00-\x1f]/.test(b.cwd), 'Expected an absolute directory.');
    enumeration(b.workspaceStatus, ['active', 'inactive', 'unknown']);
    validateTemplate(b.template);
    validateRevision(b.revision);
    validateTime(b.createdAt);
    validateTime(b.updatedAt);
    check(Array.isArray(b.cards), 'Expected cards.');
    const ids = new Set<string>();
    const templateKey = memo ? stableStringify(b.template) : '';
    for (const raw of b.cards) {
        const key = templateKey + ':' + String((raw as Card)?.id);
        if (!memo || !memo.has(key) || !sameJson(memo.get(key), raw)) {
            validateCard(raw, b.template);
            if (memo) {
                if (memo.size >= 1000) memo.delete(memo.keys().next().value!);
                memo.set(key, deepCopy(raw));
            }
        }
        const c = raw as Card;
        check(!ids.has(c.id), 'Duplicate card id.');
        ids.add(c.id);
    }
    check(Array.isArray(b.history) && b.history.length <= 1000, 'Invalid movement history.');
    for (const raw of b.history) {
        const h = object(raw, ['cardId', 'from', 'to', 'actor', 'at', 'revision']);
        check(typeof h.cardId === 'string' && ids.has(h.cardId), 'Unknown history card.');
        for (const v of [h.from, h.to])
            check(v === null && h.from === v || b.template.stages.some(s => s.stageId === v), 'Unknown history stage.');
        check(h.to !== null, 'A movement needs a destination.');
        validateActor(h.actor);
        validateTime(h.at);
        validateRevision(h.revision);
    }
    check(Array.isArray(b.receipts) && b.receipts.length <= 1000, 'Invalid receipts.');
    const requests = new Set();
    for (const raw of b.receipts) {
        const r = object(raw, ['requestId', 'digest', 'revision', 'cardIds']);
        check(isUUID(r.requestId) && !requests.has(r.requestId), 'Invalid or duplicate request id.');
        requests.add(r.requestId);
        check(typeof r.digest === 'string' && HASH_PATTERN.test(r.digest), 'Invalid request digest.');
        validateRevision(r.revision);
        check(Array.isArray(r.cardIds) && r.cardIds.length <= 100 && r.cardIds.every(id => typeof id === 'string' && ids.has(id)), 'Unknown receipt card.');
    }
}
export function stableStringify(value: unknown, space?: number): string {
    return JSON.stringify(value, (_key, item: unknown) => {
        if (item && typeof item === 'object' && !Array.isArray(item))
            return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
        return item;
    }, space);
}
// Detect duplicate keys before JSON.parse can discard them, including escaped keys.
export function parseJson(source: string): unknown {
    let i = 0;
    const bad = (): never => fail('E_VALIDATION', 'Invalid JSON or duplicate object key.', String(i));
    const ws = (): void => {
        while (i < source.length) {
            const c = source.charCodeAt(i);
            if (c !== 32 && c !== 9 && c !== 10 && c !== 13) break;
            i++;
        }
    };
    const string = (decode = true): string => {
        const start = i++;
        for (;;) {
            const end = source.indexOf('"', i);
            if (end < 0) return bad();
            let slashes = 0;
            for (let at = end - 1; at > start && source[at] === '\\'; at--) slashes++;
            i = end + 1;
            if (slashes % 2) continue;
            if (!decode) return '';
            try { return JSON.parse(source.slice(start, i)) as string; }
            catch { return bad(); }
        }
    };
    const value = (depth: number): void => {
        if (depth > 128)
            bad();
        ws();
        const ch = source[i];
        if (ch === '"') {
            string(false);
            return;
        }
        if (ch === '{' || ch === '[') {
            const end = ch === '{' ? '}' : ']';
            const keys = new Set<string>();
            i++;
            ws();
            if (source[i] === end) {
                i++;
                return;
            }
            for (;;) {
                if (ch === '{') {
                    if (source[i] !== '"')
                        bad();
                    const key = string();
                    if (keys.has(key))
                        bad();
                    keys.add(key);
                    ws();
                    if (source[i++] !== ':')
                        bad();
                }
                value(depth + 1);
                ws();
                if (source[i] === end) {
                    i++;
                    return;
                }
                if (source[i++] !== ',')
                    bad();
                ws();
            }
        }
        const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(i));
        if (!match)
            bad();
        i += match![0].length;
    };
    value(0);
    ws();
    if (i !== source.length)
        bad();
    try {
        return JSON.parse(source) as unknown;
    }
    catch {
        return bad();
    }
}
function deepCopy<T>(value: T): T {
    if (Array.isArray(value)) return value.map(item => deepCopy(item)) as T;
    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, deepCopy(item)])
        ) as T;
    }
    return value;
}
function cardMeaning(card: Card): unknown {
    const { createdAt: _, updatedAt: __, archivedAt, agents, ...rest } = card;
    return { ...rest, archived: archivedAt !== null, agents: agents.map(({ linkedAt: ___, ...link }) => link) };
}
/**
 * D37: who is writing, where it matters. `dispatch` sends a draft to the lead and is the user's own act, confirmed
 * on the board screen; `dispatched` records what became of it and is the server's dispatcher's alone. Any other
 * writer — the CLI, an agent — passes no caller and may use neither.
 */
export type Caller = 'board' | 'dispatcher' | 'archiver';
export function checkCaller(operations: readonly Operation[], actor: Actor, caller: Caller | undefined): void {
    for (const op of operations) {
        if (op.op === 'dispatch' && !(caller === 'board' && actor.kind === 'user'))
            fail('E_VALIDATION', 'dispatch is only available from the board UI.', op.id,
                'Ask the user to send the draft to the lead from the board.');
        if (op.op === 'dispatched' && caller !== 'dispatcher')
            fail('E_VALIDATION', 'dispatched is recorded only by the server dispatcher.', op.id,
                'Leave the request to the server; it records what was sent.');
        // REQ-52: only the plugin's automatic archive says it archived a card by itself.
        if (op.op === 'archive' && op.reason === 'auto' && caller !== 'archiver')
            fail('E_VALIDATION', 'An automatic archive is recorded only by the plugin.', op.id,
                'Archive the card without a reason.');
    }
}
export function applyOperations(board: Board, input: unknown, actor: Actor, context: DomainContext, caller?: Caller): {
    board: Board;
    changed: boolean;
    cardIds: string[];
    warnings: Warning[];
} {
    validateBoard(board);
    validateActor(actor);
    const operations = normalizeOperations(input);
    checkCaller(operations, actor, caller);
    const result: Board = deepCopy(board);
    const now = context.now();
    validateTime(now);
    const before = new Date(board.updatedAt).getTime();
    const wall = new Date(now).getTime();
    const at = new Date(Math.max(wall, Math.min(before, wall + 86400000))).toISOString();
    const warnings: Warning[] = before > wall + 86400000 ? [{ code: 'W_CLOCK_SKEW',
         message: 'Stored time exceeded the 24-hour tolerance.',
         target: board.id,
         nextAction: 'Check the system clock.' }] : [];
    const cardIds: string[] = [];
    const initialIds = new Set(board.cards.map(c => c.id));
    for (const op of operations) {
        let card: Card;
        if (op.op === 'add') {
            const id = `card_${context.newId()}`;
            check(!result.cards.some(c => c.id === id), 'Generated card id collision.');
            const { op: _, ...fields } = op;
            card = { id,
                 stageId: board.template.stages[0]!.stageId,
                 acceptanceCriteria: '',
                 notes: '',
                 priority: 'normal',
                 blockedReason: null,
                 nextAction: '',
                 intent: actor.kind === 'agent' ? 'requested' : 'draft',
                 awaiting: null,
                 deliverables: [],
                 agents: [],
                 createdBy: deepCopy(actor),
                 createdAt: at,
                 updatedAt: at,
                 archivedAt: null,
                 ...fields };
            result.cards.push(card);
        }
        else {
            if (!initialIds.has(op.id))
                fail('E_NOT_FOUND', 'Card not found in the initial board.', op.id, 'List the board and select an existing card.');
            const found = result.cards.find(c => c.id === op.id);
            if (!found)
                fail('E_NOT_FOUND', 'Card not found.', op.id, 'List the board and select an existing card.');
            card = found;
            if (op.op !== 'archive' && op.op !== 'restore' && card.archivedAt !== null)
                fail('E_TRANSITION', 'Restore the archived card before editing.', card.id);
            switch (op.op) {
                case 'move':
                    card.stageId = op.to;
                    // REQ-97: moved back before it was sent — nothing is sent, and it is a draft again.
                    if (op.to === board.template.stages[0]!.stageId && card.dispatch &&
                        (card.dispatch.state === 'pending' || card.dispatch.state === 'noLead')) {
                        card.dispatch = { ...card.dispatch, state: 'cancelled' };
                        card.intent = 'draft';
                    }
                    break;
                case 'dispatch': {
                    const target = dispatchStage(board.template.stages);
                    if (card.intent !== 'draft' || card.stageId !== board.template.stages[0]!.stageId)
                        fail('E_TRANSITION', 'Only a draft in the first stage can be sent to the lead.', card.id,
                            'Create a new draft card for a new request.');
                    if (card.dispatch && card.dispatch.state !== 'cancelled')
                        fail('E_TRANSITION', 'This card was already sent to the lead.', card.id, 'Create a new draft card for a new request.');
                    if (!target || op.to !== target.stageId)
                        fail('E_TRANSITION', 'A draft is sent by moving it to the working stage.', card.id,
                            'Use the working stage.', { validStageIds: target ? [target.stageId] : [] });
                    // Requested work needs acceptance criteria: the ones typed with the request, else the title.
                    if (!card.acceptanceCriteria.trim())
                        card.acceptanceCriteria = op.acceptanceCriteria?.trim() || card.title;
                    card.intent = 'requested';
                    card.stageId = op.to;
                    // 253-D2: the agent confirmed in the sheet, kept as the one it waits for (the dispatcher checks it again).
                    card.dispatch = { state: 'pending', targetAgentId: op.targetAgentId ?? null, requestedAt: at, sentAt: null,
                        messageId: dispatchMessageId(card.id, at) };
                    break;
                }
                case 'dispatched': {
                    const d = card.dispatch;
                    if (!d || !(d.state === 'pending' || d.state === 'noLead') || (op.state === 'pending' && d.state !== 'noLead'))
                        fail('E_TRANSITION', 'The request is no longer waiting to be sent.', card.id, 'Read the card again.');
                    card.dispatch = { ...d, state: op.state, targetAgentId: op.targetAgentId ?? d.targetAgentId,
                        sentAt: op.state === 'sent' ? at : null };
                    break;
                }
                case 'update':
                    Object.assign(card, op.patch);
                    break;
                case 'archive':
                    // REQ-52: the automatic archive takes only a card still in a completion stage, and marks it as its own.
                    if (op.reason === 'auto') {
                        if (!board.template.stages.some(s => s.stageId === card.stageId && s.countsAsDone))
                            fail('E_TRANSITION', 'Only a completed card is archived automatically.', card.id, 'Read the board again.');
                        if (card.archivedAt === null)
                            card.archiveReason = 'auto';
                    }
                    card.archivedAt ??= at;
                    break;
                case 'restore':
                    // REQ-52: a restored card counts its days to the automatic archive from now (`archiveClock`).
                    if (card.archivedAt !== null)
                        card.restoredAt = at;
                    card.archivedAt = null;
                    delete card.archiveReason;
                    break;
                case 'unlink':
                    card.agents = card.agents.filter(a => a.agentId !== op.agentId);
                    break;
                case 'link': {
                    const link = card.agents.find(a => a.agentId === op.agentId);
                    if (link) {
                        if (op.role !== undefined)
                            link.role = op.role;
                        if (op.label !== undefined)
                            link.label = op.label;
                    }
                    else
                        card.agents.push({ agentId: op.agentId, role: op.role ?? 'worker', label: op.label ?? '', linkedAt: at });
                    break;
                }
            }
        }
        try {
            validateCard(card, board.template);
        }
        catch (error) {
            if (isKanbanError(error))
                fail('E_TRANSITION', error.message, card.id,
                    card.intent === 'draft' && card.stageId !== board.template.stages[0]!.stageId
                        ? `Set acceptance criteria, then run kanban card update ${card.id} --intent requested before moving.`
                        : error.nextAction, error.details);
            throw error;
        }
        cardIds.push(card.id);
    }
    const changedIds = new Set<string>();
    for (let i = 0; i < result.cards.length; i++) {
        const card = result.cards[i]!;
        const old = board.cards.find(c => c.id === card.id);
        if (!old || stableStringify(cardMeaning(old)) !== stableStringify(cardMeaning(card)))
            changedIds.add(card.id);
        else
            result.cards[i] = deepCopy(old);
    }
    if (!changedIds.size)
        return { board: deepCopy(board), changed: false, cardIds, warnings };
    result.revision = nextRevision(board.revision);
    result.updatedAt = at;
    for (const id of new Set(cardIds)) {
        if (!changedIds.has(id))
            continue;
        const card = result.cards.find(c => c.id === id)!;
        const old = board.cards.find(c => c.id === id);
        card.updatedAt = at;
        if (!old || old.stageId !== card.stageId)
            result.history.push({ cardId: id, from: old?.stageId ?? null, to: card.stageId, actor: deepCopy(actor), at, revision: result.revision });
        // REQ-108: a new card's entry is its creation, left to the read; a move to the same stage keeps the one it has.
        if (old && old.stageId !== card.stageId)
            card.stageEnteredAt = at;
    }
    backfillStageEntries(board.history, result.cards);
    result.history = result.history.slice(-1000);
    validateBoard(result);
    return { board: result, changed: true, cardIds, warnings };
}
/**
 * REQ-108 backfill: a card with no `stageEnteredAt` whose last retained movement record took it where it still is gets that
 * record's time, so its entry outlives the record's trimming. Runs only inside a write that changes the board (the same
 * compare-and-swap), never on a read. `history` is the board's before the write: a card this write moved is already set, and
 * a card it created waits for the next write. The newest records are the ones kept, so a card's last retained record is its
 * true last move — never a guess.
 */
function backfillStageEntries(history: readonly MoveRecord[], cards: Card[]): void {
    const missing = new Map<string, Card>();
    for (const card of cards)
        if (card.stageEnteredAt === undefined) missing.set(card.id, card);
    if (!missing.size) return;
    const last = new Map<string, MoveRecord>();
    for (const record of history)
        if (missing.has(record.cardId)) last.set(record.cardId, record);
    for (const [id, record] of last) {
        const card = missing.get(id)!;
        if (record.to === card.stageId) card.stageEnteredAt = record.at;
    }
}
/** Attention is a read-time projection; completion never edits the saved signals. */
export function needsHuman(
    card: Pick<Card, 'stageId' | 'archivedAt' | 'awaiting' | 'blockedReason' | 'intent'>,
    stages: readonly Pick<Stage, 'stageId' | 'countsAsDone'>[]
): boolean {
    return card.archivedAt === null && !stages.some(s => s.stageId === card.stageId && s.countsAsDone) &&
        (card.awaiting === 'user' || card.blockedReason !== null || card.intent === 'draft');
}
/**
 * REQ-52: an archived card that was archived from a completion stage — finished work put away (by hand, by "Tidy" or by the
 * automatic archive). It still counts as done in the progress. A card archived from any other stage (cancelled, a duplicate)
 * counts nowhere.
 */
export function archivedDone(card: Pick<Card, 'stageId' | 'archivedAt' | 'intent'>, stages: readonly Pick<Stage, 'stageId' | 'countsAsDone'>[]): boolean {
    return card.archivedAt !== null && card.intent === 'requested' && stages.some(s => s.stageId === card.stageId && s.countsAsDone);
}
export function summarizeBoard(board: Board) {
    const active = board.cards.filter(c => c.archivedAt === null);
    const requested = active.filter(c => c.intent === 'requested');
    const stored = board.cards.filter(c => archivedDone(c, board.template.stages)).length;
    const done = requested.filter(c => board.template.stages.find(s => s.stageId === c.stageId)!.countsAsDone).length + stored;
    const all = requested.length + stored;
    return { id: board.id, workspaceId: board.workspaceId, cwd: board.cwd, workspaceStatus: board.workspaceStatus, revision: board.revision, updatedAt: board.updatedAt,
        progress: { done,
             requested: all,
             draft: active.length - requested.length,
             archived: board.cards.length - active.length,
             // REQ-52: how many of `done` (and of `requested`) are archived — the done column's "Archived N".
             archivedDone: stored,
             percent: all ? Math.floor(done * 100 / all) : null } };
}
export function sortedCards(board: Board): Card[] {
    const order = ['high', 'normal', 'low'];
    return board.cards.filter(c => c.archivedAt === null).sort((a,
         b) => board.template.stages.findIndex(s => s.stageId === a.stageId) - board.template.stages.findIndex(s => s.stageId === b.stageId) ||
            order.indexOf(a.priority) - order.indexOf(b.priority) ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.id.localeCompare(b.id));
}
export function cardSummary(card: Card) { const { id,
     title,
     stageId,
     priority,
     intent,
     nextAction,
     awaiting } = card;
     return { id,
     title,
     stageId,
     priority,
     intent,
     blocked: card.blockedReason !== null,
     nextAction,
     agents: card.agents.length,
     awaiting };
     }
export function boardView(board: Board, full = false) {
    const cards = sortedCards(board);
    return { summary: summarizeBoard(board),
         stages: board.template.stages.map(s => ({ ...s,
         cards: cards.filter(c => c.stageId === s.stageId).map(c => full ? deepCopy(c) : cardSummary(c)) })),
         needsHuman: cards.filter(c => needsHuman(c, board.template.stages)).map(c => ({ boardId: board.id,
         cardId: c.id,
         title: c.title,
         stageId: c.stageId,
         reasons: [c.awaiting === 'user' && 'awaitingUser',
         c.blockedReason !== null && 'blocked',
         c.intent === 'draft' && 'draft'].filter(Boolean) })) };
}
function escapeMarkdown(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/([\\`*_\[\]])/g, '\\$1').replace(/\n/g, ' / ');
}
export function renderProcess(
    board: Board, locale: Locale = 'en', detail: 'compact' | 'full' = 'compact'
): string {
    validateBoard(board);
    const m = messages[locale];
    const values = valueLabels[locale];
    const p = summarizeBoard(board).progress;
    const changed = board.updatedAt.slice(0, 16).replace('T', ' ') + ' UTC';
    const out = [
        '<!-- paseo-kanban:generated:v1 board=' + board.id + ' -->',
        '> ' + m.generated,
        '# ' + m.heading,
        board.template.id + '@' + board.template.version + ' | ' + m.progress + ': ' +
            p.done + '/' + p.requested + ' (' + (p.percent === null ? '—' : p.percent + '%') +
            ') | ' + m.changed + ': ' + changed,
    ];
    if (p.draft) out.push(m.drafts + ': ' + p.draft);
    if (p.archived) out.push(m.archived + ': ' + p.archived);
    const cards = sortedCards(board);
    for (const stage of board.template.stages) {
        const displayName = board.template.id === 'basic' && board.template.version === 1
            ? builtinTemplate(locale).stages.find(s => s.stageId === stage.stageId)?.name ?? stage.name
            : stage.name;
        out.push('## ' + escapeMarkdown(displayName));
        const lane = cards.filter(c => c.stageId === stage.stageId);
        if (!lane.length) out.push('(' + m.none + ')');
        for (const card of lane) {
            const parts = [escapeMarkdown(card.title), card.id.slice(0, 13)];
            if (card.awaiting && (card.awaiting !== 'user' || needsHuman(card, board.template.stages))) parts.push(m.awaiting + ': ' + values[card.awaiting]);
            if (card.blockedReason && needsHuman(card, board.template.stages)) parts.push(m.blocked + ': ' + escapeMarkdown(card.blockedReason));
            if (card.agents.length) parts.push(m.agents + ': ' + card.agents
                .map(agent => escapeMarkdown(agent.label || agent.agentId.slice(0, 8))).join(', '));
            if (card.nextAction) parts.push(m.next + ': ' + escapeMarkdown(card.nextAction));
            const done = stage.countsAsDone && card.intent === 'requested';
            out.push('- [' + (done ? 'x' : ' ') + '] ' + parts.join(' · '));
            if (detail === 'full') {
                out.push('  - ' + card.id + ' · ' + values[card.intent] + ' · ' + values[card.priority]);
                for (const [label, value] of [
                    [m.criteria, card.acceptanceCriteria], [m.notes, card.notes],
                    [m.deliverables, card.deliverables.join(', ')],
                ]) if (value) out.push('  - ' + label + ': ' + escapeMarkdown(value));
            }
        }
    }
    out.push('<!-- revision: ' + board.revision + ' -->');
    return out.join('\n') + '\n';
}
