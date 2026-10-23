import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createKanbanError, isKanbanError, type KanbanError,
     fail,
     parseJson,
     stableStringify,
     validateBoard,
     validateConfig, createBoardValidator,
     validateTemplate,
     validateActor,
     validateRevision,
     isUUID,
     isBoardId,
     isWorkspaceId,
     builtinTemplate,
     normalizeOperations,
     applyOperations,
     normalizeCwd,
     checkCaller,
     summarizeBoard,
     type Actor,
     type Caller,
     type Board,
     type Config,
     type DomainContext,
     type Operation,
     type Template,
     type Warning,
     type Revision,
     type Locale,
     } from '../../shared/core/domain.js';
import { O_DIRECTORY, O_NOFOLLOW, flushAccess, isWindows, renameOver } from './durable.js';
import { AUTO_CONTROL_BYTES, AUTO_CONTROL_DIR, cardSeen, commitDecisions, emptyControl, mayDecide, parseControl, rebaseReport, seen, reconcile, type AutoControl, type ControlEntry,
    type ControlEvidence, type ControlToken, type RebaseKind, type RememberedEntry } from './auto-control.js';
import { readAutoState } from './auto-state.js';
export interface CommitEffect {
    status: 'written' | 'unchanged' | 'skipped' | 'failed';
    warnings: Warning[];
    exportWrites: number;
    bytesWritten: number;
}
export interface StoreOptions {
    afterCommit?: (board: Board, store: Store) => Promise<CommitEffect>;
    dataDir?: string;
    forbiddenRoots?: string[];
    context?: DomainContext;
    environment?: Record<string, string | undefined>;
    homeDir?: string;
    lockTimeoutMs?: number;
    fileSystem?: {
        link?: typeof fs.link;
    };
}
export interface ReadStats {
    readFiles: number; readBytes: number;
    boardReads: number; boardReadBytes: number;
    identityReads: number; identityReadBytes: number;
}
export type BoardIdentity = Pick<Board,
    'schemaVersion' | 'id' | 'workspaceId' | 'cwd' | 'workspaceStatus'>;
const emptyReads = (): ReadStats => ({ readFiles: 0, readBytes: 0,
    boardReads: 0, boardReadBytes: 0, identityReads: 0, identityReadBytes: 0 });
export interface IOStats extends ReadStats {
    lockHeldMs: number; lockWaitMs: number;
    boardWrites: number;
    backupLinks: number;
    backupWrites: number;
    exportWrites: number;
    fsyncCalls: number;
    /** D61: folder flushes skipped — never made on Windows, or refused by the file system (research/406). */
    fsyncSkipped: number;
    bytesWritten: number;
    lockAcquisitions: number;
}
export interface Result<T> {
    data: T;
    committed: boolean;
    warnings: Warning[];
    meta: {
        io: IOStats;
        durationMs: number;
    };
}
export interface MutationData {
    export?: CommitEffect['status'];
    boardId: string;
    revision: Revision;
    currentRevision: Revision;
    requestId: string;
    cardIds: string[];
    changed: boolean;
    replayed: boolean;
}
export interface MutationInput {
    actor: Actor;
    requestId: string;
    ifRevision?: Revision;
    operations: Operation[];
}
/**
 * D66: a write of the automatic cards, through their own entry point (`Store.autoMutate`). `expect` is the card decision
 * token the engine judged by (`readAutoControl`); a move is committed only while the card is still `managed` under it.
 */
export interface AutoMutationInput {
    agentId: string;
    requestId: string;
    ifRevision?: Revision;
    expect?: ControlToken;
    operations: Operation[];
}
/** D66: the card decisions of one board as they hold now — the file reconciled with the ledger in memory, nothing written. */
export interface ControlView {
    /**
     * Gate 489 F1 (research/477 설계보완 §9): `unreadable` — the file could not be read for a passing reason (permissions,
     * I/O, a newer schema): held, and every change that could decide is refused until it reads again. `damaged` — its bytes
     * are no decision file (not JSON, another board's, a wrong shape): the first look under the board's lock sets it aside
     * and starts the board again from its cards (`settleAutoControl`).
     */
    status: ControlStatus;
    /** What is wrong with a damaged or unreadable file, for the screens and the log. */
    problem: string | null;
    controlEpoch: string | null;
    board: Board;
    cards: Record<string, ControlEntry>;
    /** False when the file does not hold this judgement yet (missing, or cards it lacks or that differ); see `settleAutoControl`. */
    settled: boolean;
}
export type ControlStatus = 'ok' | 'missing' | 'damaged' | 'unreadable';
/** D66: a resume as a screen asks for it (G2 makes the token mandatory); `decisionId` makes a retried resume a replay. */
export interface ResumeExpectation extends ControlToken { decisionId?: string;
    /** Gate 495 F1: the card as the screen showed it (`cardSeen`); a card changed since is refused. */
    card?: string }
export interface ResumeData { boardId: string; cardId: string; controlEpoch: string; generation: number; decisionId: string; mode: ControlEntry['mode']; replayed: boolean }
export interface InitInput {
    cwd: string;
    workspaceId?: string;
    workspaceStatus?: Board['workspaceStatus'];
    template?: string;
    actor: Actor;
    requestId: string;
    ifRevision?: '0';
    /**
     * D44: `false` for a board the plugin makes by itself for a workspace that never asked for one — its first commit
     * writes no PROCESS.md (later commits ask the plugin's own record, server/core/export.ts `quietBoard`).
     */
    export?: false;
}
interface LockOwner {
    token: string;
    pid: number;
    procStartTicks: string | null;
    bootId: string | null;
    pidNamespace: string | null;
    hostname: string;
    createdAt: string;
    /** D63: written only off Linux, where no /proc start identity exists; see `portableLiveness`. */
    platform?: string;
    bootTime?: number;
    machineId?: string;
}
interface LockRecord {
    owner: LockOwner | null;
    dev: number;
    ino: number;
}
interface Measurement {
    readsAtStart?: ReadStats;
    committed?: boolean;
    start: number;
    io: IOStats;
    warnings: Warning[];
}
export interface CheckResult {
    target: string;
    status: 'ok' | 'warning' | 'error';
    code: string;
    message: string;
    nextAction: string;
}
export interface UnlockOptions {
    force?: boolean;
    offline?: boolean;
    global?: boolean;
}
const hash = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException)?.code;
/** D63: this boot's start in epoch milliseconds, from the system uptime. */
const bootTime = (): number => Math.round(Date.now() - os.uptime() * 1000);
/**
 * D63: how far two readings of one boot's start may differ — the wall clock and the uptime counter drift apart over
 * days and the wall clock may be stepped. It is an estimate, not proof of one boot: a lock left just before a quick
 * restart can still pass, its owner having ended with the restart. Other machines are told apart by the machine id.
 */
const BOOT_TOLERANCE_MS = 300_000;
function measure(): Measurement { return { start: performance.now(),
     io: { ...emptyReads(),
     lockHeldMs: 0,
     lockWaitMs: 0,
     boardWrites: 0,
     backupLinks: 0,
     backupWrites: 0,
     exportWrites: 0,
     fsyncCalls: 0,
     fsyncSkipped: 0,
     bytesWritten: 0,
     lockAcquisitions: 0 },
     warnings: [] };
     }
function result<T>(m: Measurement, data: T, committed = false): Result<T> { return { data, committed, warnings: m.warnings, meta: { io: m.io, durationMs: performance.now() - m.start } }; }
function warning(code: string, message: string, target: string, nextAction: string): Warning { return { code, message, target, nextAction }; }
function ioError(error: unknown, target: string, writing = false): KanbanError {
    if (isKanbanError(error))
        return error;
    return createKanbanError('E_IO',
         `File operation failed (${codeOf(error) ?? 'unknown'}).`,
         target,
         writing ? 'Inspect the current board. Retry with the original request id and arguments if available.' : 'Check the path, permissions, and available space.',
         { osCode: codeOf(error) ?? null },
         writing ? 'unknown' : false);
}
/** D66: why the engine may not make these changes now, or null. See `Store.autoMutate`. */
function engineRefusal(board: Board, control: AutoControl, operations: readonly Operation[], agentId: string, expect: ControlToken | null):
    { reason: string; cardId: string | null } | null {
    for (const op of operations) {
        if (op.op === 'add') continue;
        const card = board.cards.find(c => c.id === op.id);
        const entry = control.cards[op.id];
        // A card that is not there fails as before, in applyOperations.
        if (!card || !entry) continue;
        const refuse = (reason: string) => ({ reason, cardId: card.id });
        if (card.archivedAt !== null) return refuse('archived');
        if (entry.mode === 'unknown') return refuse('unknown');
        if (op.op === 'link') { if (op.agentId !== agentId) return refuse('link'); continue; }
        if (!card.agents.some(a => a.agentId === agentId)) return refuse('unlinked');
        if (op.op === 'move') {
            if (entry.mode !== 'managed') return refuse(entry.mode);
            if (!expect || expect.controlEpoch !== control.controlEpoch || expect.generation !== entry.generation) return refuse('stale');
            continue;
        }
        if (op.op === 'update') {
            if (Object.keys(op.patch).some(key => key !== 'awaiting' && key !== 'title')) return refuse('patch');
            if (entry.mode !== 'managed' && entry.mode !== 'paused') return refuse(entry.mode);
            continue;
        }
        return refuse('operation');
    }
    return null;
}
function envelope(value: unknown, required: string[], optional: string[] = []): void {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        fail('E_VALIDATION', 'Expected a request object.');
    for (const key of Object.keys(value))
        if (!required.includes(key) && !optional.includes(key))
            fail('E_VALIDATION', 'Unknown request field.', key);
    for (const key of required)
        if (!Object.hasOwn(value, key))
            fail('E_VALIDATION', 'Missing request field.', key);
}
function inside(candidate: string, parent: string): boolean {
    const relative = path.relative(parent, candidate);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export async function canonicalPath(input: string): Promise<string> {
    let existing = path.resolve(input);
    const tail: string[] = [];
    for (;;) {
        try {
            return path.join(await fs.realpath(existing), ...tail);
        }
        catch (error) {
            if (codeOf(error) !== 'ENOENT')
                throw ioError(error, existing);
            try {
                if ((await fs.lstat(existing)).isSymbolicLink())
                    fail('E_PATH_FORBIDDEN', 'Dangling symbolic links are not allowed.', existing);
            }
            catch (probe) {
                if (codeOf(probe) !== 'ENOENT')
                    throw probe;
            }
            const parent = path.dirname(existing);
            if (parent === existing)
                throw ioError(error, existing);
            tail.unshift(path.basename(existing));
            existing = parent;
        }
    }
}
export function defaultContext(): DomainContext { return { newId: randomUUID, now: () => new Date().toISOString() }; }
export async function openStore(options: StoreOptions = {}): Promise<Store> {
    const environment = options.environment ?? process.env;
    const home = options.homeDir ?? os.homedir();
    const roots = [path.join(home, '.paseo'), ...(environment.PASEO_HOME ? [environment.PASEO_HOME] : []), ...(options.forbiddenRoots ?? [])];
    const forbiddenRoots = await Promise.all(roots.map(canonicalPath));
    const dataDir = await canonicalPath(options.dataDir ?? environment.KANBAN_DATA_DIR ?? path.join(home, 'paseo-kanban-data'));
    if (forbiddenRoots.some(root => inside(dataDir, root)))
        fail('E_PATH_FORBIDDEN', 'The data directory is in a protected root.', dataDir, 'Select a directory outside the protected roots.');
    return new Store(dataDir, [...new Set(forbiddenRoots)], options.context ?? defaultContext(), options);
}
export class Store {
    private readonly reads = emptyReads();
    private readonly identities = new Map<string, { signature: string; identity: BoardIdentity }>();
    readMetrics(): ReadStats { return { ...this.reads }; }
    recordRead(file: string, bytes: number, identity = false): void {
        this.reads.readFiles++; this.reads.readBytes += bytes;
        if (identity) { this.reads.identityReads++; this.reads.identityReadBytes += bytes; }
        else if (path.dirname(file) === path.join(this.dataDir, 'boards') && file.endsWith('.json')) {
            this.reads.boardReads++; this.reads.boardReadBytes += bytes;
        }
    }
    private measurement(): Measurement {
        return { ...measure(), readsAtStart: this.readMetrics() };
    }
    private outcome<T>(m: Measurement, data: T, committed = false): Result<T> {
        for (const key of Object.keys(this.reads) as (keyof ReadStats)[])
            m.io[key] = this.reads[key] - (m.readsAtStart?.[key] ?? 0);
        return result(m, data, committed);
    }
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly link: typeof fs.link;
    private readonly timeout: number;
    private readonly afterCommit: StoreOptions['afterCommit'];
    private readonly paseoHome: string;
    private readonly home: string;
    private readonly environment: Record<string, string | undefined>;
    private readonly machineIds = new Map<string, string>();
    constructor(public readonly dataDir: string, public readonly forbiddenRoots: readonly string[], public readonly context: DomainContext, options: StoreOptions) {
        this.link = options.fileSystem?.link ?? fs.link;
        this.afterCommit = options.afterCommit;
        this.paseoHome = (options.environment ?? process.env).PASEO_HOME
            ?? path.join(options.homeDir ?? os.homedir(), '.paseo');
        this.home = options.homeDir ?? os.homedir();
        this.environment = options.environment ?? process.env;
        this.timeout = options.lockTimeoutMs ?? 30000;
        if (!(this.timeout > 0 && this.timeout <= 30000))
            fail('E_VALIDATION', 'Lock timeout must be between 1 and 30000 milliseconds.');
    }
    diagnostics(): {
        activeTimers: number;
        activeWatchers: number;
    } { return { activeTimers: this.timers.size, activeWatchers: 0 }; }
    private async delay(ms: number): Promise<void> {
        await new Promise<void>(resolve => { const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, ms); this.timers.add(timer); });
    }
    private boardPath(id: string): string { if (!isBoardId(id))
        fail('E_VALIDATION', 'Invalid board id.', id); return path.join(this.dataDir, 'boards', `${id}.json`); }
    private lockPath(id?: string): string { if (id !== undefined && !isBoardId(id))
        fail('E_VALIDATION', 'Invalid board id.', id); return id ? path.join(this.dataDir, 'boards', `${id}.lock`) : path.join(this.dataDir, '.meta.lock'); }
    private async allowed(target: string): Promise<void> {
        const real = await canonicalPath(target);
        if (this.forbiddenRoots.some(root => inside(real, root)))
            fail('E_PATH_FORBIDDEN', 'Path is inside a protected root.', target, 'Select a path outside the protected roots.');
    }
    async assertAllowedPath(target: string): Promise<string> { await this.allowed(target); return canonicalPath(target); }
    private async safeParents(file: string): Promise<void> {
        if (!inside(file, this.dataDir))
            fail('E_PATH_FORBIDDEN', 'Path escapes the data directory.', file);
        await this.allowed(this.dataDir);
        const relative = path.relative(this.dataDir, path.dirname(file));
        let current = this.dataDir;
        for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
            if (segment)
                current = path.join(current, segment);
            const info = await fs.lstat(current);
            if (!info.isDirectory() || info.isSymbolicLink())
                fail('E_PATH_FORBIDDEN', 'Expected a real directory.', current);
        }
    }
    /** D61: no folder flush on Windows, counted in fsyncSkipped; on every other host a failed one fails the write. */
    private async syncDirectory(dir: string, m: Measurement): Promise<void> {
        if (isWindows()) {
            m.io.fsyncSkipped++;
            return;
        }
        const fd = await fs.open(dir, constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        try {
            await fd.sync();
            m.io.fsyncCalls++;
        }
        finally {
            await fd.close();
        }
    }
    private async ensureDirectory(dir: string, m: Measurement): Promise<void> {
        try {
            const info = await fs.lstat(dir);
            if (!info.isDirectory() || info.isSymbolicLink())
                fail('E_PATH_FORBIDDEN', 'Expected a real directory.', dir);
            return;
        }
        catch (error) {
            if (codeOf(error) !== 'ENOENT')
                throw error;
        }
        const parent = path.dirname(dir);
        if (parent !== dir)
            await this.ensureDirectory(parent, m);
        try {
            await fs.mkdir(dir, { mode: 0o700 });
            await this.syncDirectory(parent, m);
        }
        catch (error) {
            if (codeOf(error) !== 'EEXIST')
                throw error;
            const info = await fs.lstat(dir);
            if (!info.isDirectory() || info.isSymbolicLink())
                throw error;
        }
    }
    private async fileBytes(file: string, max?: number): Promise<Buffer> {
        await this.safeParents(file);
        const fd = await fs.open(file, constants.O_RDONLY | O_NOFOLLOW);
        try {
            const stat = await fd.stat();
            if (!stat.isFile())
                fail('E_PATH_FORBIDDEN', 'Expected a regular file.', file);
            if (max !== undefined && stat.size > max)
                fail('E_LIMIT', 'Input file is too large.', file);
            const bytes = await fd.readFile();
            this.recordRead(file, bytes.length);
            return bytes;
        }
        finally {
            await fd.close();
        }
    }
    private decode(bytes: Uint8Array, target: string): unknown {
        try {
            return parseJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        }
        catch (error) {
            throw createKanbanError('E_CORRUPT',
                 'Invalid UTF-8 or JSON data.',
                 target,
                 'Preserve the original file and inspect a valid backup.',
                 { cause: error instanceof Error ? error.message : String(error) });
        }
    }
    private async readDocument(file: string, max?: number): Promise<unknown> { return this.decode(await this.fileBytes(file, max), file); }
    private validateStored<T>(data: unknown, validate: (value: unknown) => asserts value is T, file: string): T {
        try {
            validate(data);
            return data;
        }
        catch (error) {
            if (isKanbanError(error) && error.code === 'E_SCHEMA_VERSION')
                throw error;
            throw createKanbanError('E_CORRUPT',
                 'Stored data failed validation.',
                 file,
                 'Preserve the original file and inspect a valid backup.',
                 { cause: error instanceof Error ? error.message : String(error) });
        }
    }
    async readConfig(): Promise<Config> {
        const file = path.join(this.dataDir, 'config.json');
        try {
            const raw = await this.readDocument(file, 16384);
            if (raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.hasOwn(raw, 'export'))
                (raw as Record<string, unknown>).export = { detail: 'compact' };
            if (raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.hasOwn(raw, 'locale'))
                (raw as Record<string, unknown>).locale = 'en';
            return this.validateStored(raw, validateConfig, file);
        }
        catch (error) {
            if (codeOf(error) === 'ENOENT')
                return { schemaVersion: 1, exportEnabled: true, locale: 'en', export: { detail: 'compact' } };
            throw ioError(error, file);
        }
    }
    private async atomicWrite(file: string, bytes: Buffer, m: Measurement, kind: 'board' | 'backup' | 'config', syncParent = true): Promise<void> {
        await this.safeParents(file);
        const temporary = path.join(path.dirname(file), `.tmp-${randomUUID()}`);
        let own = false;
        try {
            const fd = await fs.open(temporary, 'wx', 0o600);
            own = true;
            try {
                await fd.writeFile(bytes);
                m.io.bytesWritten += bytes.length;
                await fd.sync();
                m.io.fsyncCalls++;
            }
            finally {
                await fd.close();
            }
            try {
                const target = await fs.lstat(file);
                if (!target.isFile() || target.isSymbolicLink())
                    fail('E_PATH_FORBIDDEN', 'Refusing to replace a non-regular file.', file);
            }
            catch (error) {
                if (codeOf(error) !== 'ENOENT')
                    throw error;
            }
            await renameOver(temporary, file);
            own = false;
            if (kind === 'board')
                m.io.boardWrites++;
            else if (kind === 'backup')
                m.io.backupWrites++;
            if (syncParent)
                await this.syncDirectory(path.dirname(file), m);
            if (kind === 'board') m.committed = true;
        }
        finally {
            if (own)
                await fs.unlink(temporary).catch(() => undefined);
        }
    }
    private async processIdentity(pid: number): Promise<{
        ticks: string | null;
        boot: string | null;
        namespace: string | null;
        missing: boolean;
    }> {
        if (process.platform !== 'linux')
            return { ticks: null, boot: null, namespace: null, missing: false };
        const [boot, namespace] = await Promise.all([fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'), fs.readlink('/proc/self/ns/pid')]);
        try {
            const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
            const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
            const ticks = fields[19];
            if (!ticks || !/^\d+$/.test(ticks))
                throw new Error('Invalid process start time.');
            return { ticks, boot: boot.trim(), namespace, missing: false };
        }
        catch (error) {
            if (codeOf(error) === 'ENOENT')
                return { ticks: null, boot: boot.trim(), namespace, missing: true };
            throw error;
        }
    }
    private async owner(): Promise<LockOwner> {
        let identity;
        try {
            identity = await this.processIdentity(process.pid);
        }
        catch {
            identity = { ticks: null, boot: null, namespace: null };
        }
        return { token: randomUUID(),
             pid: process.pid,
             procStartTicks: identity.ticks,
             bootId: identity.boot,
             pidNamespace: identity.namespace,
             hostname: os.hostname(),
             createdAt: new Date().toISOString(),
             ...(process.platform === 'linux' ? {} : { platform: process.platform, bootTime: bootTime(),
                 ...await this.machineId().then(machineId => machineId === null ? {} : { machineId }) }) };
    }
    /**
     * D63 (gate 416 F1): where this machine keeps its id — the user's local, non-roaming application data, never the
     * data folder, which is the thing two machines might wrongly share. Read off Linux only.
     */
    private machineIdFile(): string {
        const local = process.platform === 'win32'
            ? (path.isAbsolute(this.environment.LOCALAPPDATA ?? '') ? this.environment.LOCALAPPDATA! : path.join(this.home, 'AppData', 'Local'))
            : process.platform === 'darwin' ? path.join(this.home, 'Library', 'Application Support')
            : path.join(this.home, '.config');
        return path.join(local, 'paseo-auto-kanban', 'machine-id');
    }
    /**
     * D63 (gate 416 F1): a random id made once per machine and user, without asking the operating system through an
     * outside command. `null` — no automatic recovery — when it cannot be read or made, or would sit in the data folder.
     */
    private async machineId(): Promise<string | null> {
        const file = this.machineIdFile();
        if (!await this.outsideData(file))
            return null;
        const known = this.machineIds.get(file);
        if (known)
            return known;
        try {
            let value: string;
            try {
                value = await fs.readFile(file, 'utf8');
            }
            catch (error) {
                if (codeOf(error) !== 'ENOENT')
                    return null;
                await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
                const made = randomUUID();
                try {
                    await fs.writeFile(file, `${made}\n`, { flag: 'wx', mode: 0o600 });
                    value = made;
                }
                catch (raced) {
                    if (codeOf(raced) !== 'EEXIST')
                        return null;
                    value = await fs.readFile(file, 'utf8');
                }
            }
            value = value.trim();
            if (!isUUID(value) || !await this.outsideData(file))
                return null;
            this.machineIds.set(file, value);
            return value;
        }
        catch {
            return null;
        }
    }
    /**
     * D63 (gate 417 F2): whether the machine id file really lies outside the data folder — the path with every link in
     * it followed, so a link from the application data into the data folder cannot share one id between machines.
     * Asked on every use, the cached id included; a path that cannot be resolved counts as inside.
     */
    private async outsideData(file: string): Promise<boolean> {
        if (!path.isAbsolute(file))
            return false;
        try {
            return !inside(await canonicalPath(file), this.dataDir);
        }
        catch {
            return false;
        }
    }
    private async lockRecord(file: string): Promise<LockRecord | null> {
        try {
            await this.safeParents(file);
            const fd = await fs.open(file, constants.O_RDONLY | O_NOFOLLOW);
            try {
                const stat = await fd.stat();
                if (!stat.isFile() || stat.size > 16384)
                    fail('E_PATH_FORBIDDEN', 'Invalid lock file.', file);
                let owner: LockOwner | null = null;
                try {
                    const value = parseJson(await fd.readFile('utf8')) as LockOwner;
                    if (value &&
            isUUID(value.token) &&
            Number.isSafeInteger(value.pid) &&
            value.pid > 0 &&
            typeof value.hostname === 'string' &&
            typeof value.createdAt === 'string' &&
            Number.isFinite(Date.parse(value.createdAt)) &&
            (value.procStartTicks === null ||
            typeof value.procStartTicks === 'string') &&
            (value.bootId === null ||
            typeof value.bootId === 'string') &&
            (value.pidNamespace === null ||
            typeof value.pidNamespace === 'string'))
                        owner = value;
                }
                catch { /* Partial ownership is not eligible for automatic recovery. */ }
                return { owner, dev: stat.dev, ino: stat.ino };
            }
            finally {
                await fd.close();
            }
        }
        catch (error) {
            if (codeOf(error) === 'ENOENT')
                return null;
            throw error;
        }
    }
    private async liveness(owner: LockOwner | null): Promise<'live' | 'dead' | 'unknown'> {
        if (process.platform !== 'linux')
            return this.portableLiveness(owner);
        if (!owner || owner.hostname !== os.hostname() || !owner.procStartTicks || !owner.bootId || !owner.pidNamespace)
            return 'unknown';
        try {
            const current = await this.processIdentity(owner.pid);
            if (current.boot !== owner.bootId || current.namespace !== owner.pidNamespace)
                return 'unknown';
            return current.missing || current.ticks !== owner.procStartTicks ? 'dead' : 'live';
        }
        catch {
            return 'unknown';
        }
    }
    /**
     * D63: Windows and macOS have no /proc start identity. An owner is dead only when its lock names this machine's id,
     * host name and platform and a boot start within the tolerance, and no process now has its pid (ESRCH). A pid in use — the owner, or another process that
     * reused it (EPERM included) — cannot be told apart without a start time, so it stays 'unknown': never reclaimed
     * automatically, and never 'live' either, so forced offline recovery remains open.
     */
    private async portableLiveness(owner: LockOwner | null): Promise<'dead' | 'unknown'> {
        if (!owner || owner.hostname !== os.hostname() || owner.platform !== process.platform ||
            owner.procStartTicks !== null || owner.bootId !== null || owner.pidNamespace !== null ||
            typeof owner.bootTime !== 'number' || !Number.isFinite(owner.bootTime) ||
            Math.abs(bootTime() - owner.bootTime) > BOOT_TOLERANCE_MS ||
            !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !isUUID(owner.machineId))
            return 'unknown';
        // Gate 416 F1: a host name and a boot time can match on another machine sharing the folder; its pid table is
        // not ours, so ESRCH here says nothing about it. Only this machine's own id lets the local answer count.
        const machine = await this.machineId();
        if (machine === null || machine !== owner.machineId)
            return 'unknown';
        try {
            process.kill(owner.pid, 0);
        }
        catch (error) {
            if (codeOf(error) === 'ESRCH')
                return 'dead';
        }
        return 'unknown';
    }
    private async createLock(file: string, owner: LockOwner): Promise<LockRecord> {
        await this.safeParents(file);
        const fd = await fs.open(file, 'wx', 0o600);
        try {
            await fd.writeFile(JSON.stringify(owner));
            const info = await fd.stat();
            return { owner, dev: info.dev, ino: info.ino };
        }
        catch (error) {
            await fs.unlink(file).catch(() => undefined);
            throw error;
        }
        finally {
            await fd.close();
        }
    }
    private async removeOwned(file: string, expected: LockRecord): Promise<void> {
        const actual = await this.lockRecord(file);
        if (actual && actual.dev === expected.dev && actual.ino === expected.ino && actual.owner?.token === expected.owner?.token)
            await fs.unlink(file);
        else if (actual)
            fail('E_LOCK_ACTIVE', 'Lock ownership changed.', file, 'Run doctor before attempting recovery.');
    }
    private async lockAdvice(record: LockRecord | null, started: number,
        observedOwners = 0, guard = false): Promise<{ nextAction: string; details: Record<string, unknown> }> {
        const ownerState = await this.liveness(record?.owner ?? null);
        const details: Record<string, unknown> = {
            ownerState, waitedMs: Math.round(performance.now() - started),
            observedOwners, owner: record?.owner ?? null,
        };
        if (ownerState === 'dead' && record?.owner) {
            const reclaimableAtMs = Date.parse(record.owner.createdAt) + 60000;
            details.reclaimableAtMs = reclaimableAtMs;
            const remaining = Math.max(1, Math.ceil((reclaimableAtMs - Date.now()) / 1000));
            return { details, nextAction: guard
                ? 'The owner is confirmed dead. Inspect the entry guard with doctor for offline recovery.'
                : 'Retry after ' + remaining + ' seconds; the owner is confirmed dead.' };
        }
        return { details, nextAction: ownerState === 'live'
            ? 'Wait for the active owner to finish, then retry. Do not force an active owner.'
            : 'Run doctor; use unlock --force only after stopping all writers.' };
    }
    private async claim(file: string, deadline: number): Promise<() => Promise<void>> {
        let pause = 50;
        const guard = `${file}.claim`;
        const owner = await this.owner();
        for (;;) {
            try {
                const record = await this.createLock(guard, owner);
                return () => this.removeOwned(guard, record);
            }
            catch (error) {
                if (codeOf(error) !== 'EEXIST')
                    throw error;
                if (performance.now() >= deadline) {
                    const advice = await this.lockAdvice(await this.lockRecord(guard),
                        deadline - this.timeout, 1, true);
                    fail('E_LOCK_TIMEOUT', 'Timed out waiting for the lock entry guard.',
                        guard, advice.nextAction, advice.details);
                }
                await this.delay(Math.max(1, Math.min(pause + Math.random() * 50, deadline - performance.now())));
                pause = Math.min(500, pause * 2);
            }
        }
    }
    private async quarantine(file: string, token: string): Promise<void> { const moved = `${file}.stale-${token}`; await fs.rename(file, moved); await fs.unlink(moved); }
    private async acquire(file: string, m: Measurement): Promise<() => Promise<void>> {
        const started = performance.now();
        const deadline = started + this.timeout;
        const observed = new Set<string>();
        const owner = await this.owner();
        let pause = 20;
        for (;;) {
            // Busy waiters only read. Actual acquisition/reclamation still rechecks inside claim.
            const peek = await this.lockRecord(file);
            if (peek?.owner) observed.add(peek.owner.token);
            const reclaimable = peek?.owner &&
                Date.now() - Date.parse(peek.owner.createdAt) > 60000 &&
                await this.liveness(peek.owner) === 'dead';
            if (peek && !reclaimable) {
                if (performance.now() >= deadline) {
                    const advice = await this.lockAdvice(peek, started, observed.size);
                    fail('E_LOCK_TIMEOUT', 'Timed out waiting for the board lock.',
                        file, advice.nextAction, advice.details);
                }
                const aged = performance.now() - started > 5000;
                const interval = Math.min(aged ? 200 : 500, pause) + Math.random() * 50;
                await this.delay(Math.max(1, Math.min(interval, deadline - performance.now())));
                pause = Math.min(500, pause * 2);
                continue;
            }
            const releaseClaim = await this.claim(file, deadline);
            let owned: LockRecord | undefined;
            try {
                const existing = await this.lockRecord(file);
                if (existing?.owner) observed.add(existing.owner.token);
                if (existing && existing.owner && Date.now() - Date.parse(existing.owner.createdAt) > 60000 && await this.liveness(existing.owner) === 'dead') {
                    await this.quarantine(file, owner.token);
                    m.warnings.push(warning('W_STALE_LOCK', 'Reclaimed an abandoned lock.', file, 'Inspect the previous operation if its response was lost.'));
                }
                if (!existing || await this.lockRecord(file) === null) {
                    owned = await this.createLock(file, owner);
                    m.io.lockAcquisitions++;
                }
            }
            finally {
                await releaseClaim();
            }
            if (owned) {
                const expected = owned;
                return async () => { const release = await this.claim(file, performance.now() + this.timeout); try {
                    await this.removeOwned(file, expected);
                }
                finally {
                    await release();
                } };
            }
            if (performance.now() >= deadline) {
                const holder = await this.lockRecord(file);
                const advice = await this.lockAdvice(holder, started, observed.size);
                fail('E_LOCK_TIMEOUT', 'Timed out waiting for the board lock.',
                    file, advice.nextAction, advice.details);
            }
            await this.delay(Math.max(1, Math.min(pause + Math.random() * 10, deadline - performance.now())));
            pause = Math.min(500, pause * 2);
        }
    }
    private async exclusive<T>(id: string | undefined, m: Measurement, action: () => Promise<T>): Promise<T> {
        const waiting = performance.now();
        const release = await this.acquire(this.lockPath(id), m);
        m.io.lockWaitMs += performance.now() - waiting;
        const held = performance.now();
        let succeeded = false;
        try {
            const value = await action(); succeeded = true; return value;
        } finally {
            try { await release(); }
            catch (error) {
                if (!succeeded || !m.committed) throw error;
                m.warnings.push(warning('W_LOCK_RELEASE',
                    'The board committed, but releasing its lock failed.', this.lockPath(id),
                    'Inspect the lock with doctor before the next mutation.'));
            } finally { m.io.lockHeldMs += performance.now() - held; }
        }
    }
    /**
     * REQ-156 gate 490 R1: a plugin file of the data folder's top (the new-version check's `.update-check.lock`) held with the
     * very rules of a board's lock — created and taken over only inside the entry guard, taken over only from an owner known
     * dead for over a minute, released only by its own token — so two processes reclaiming one dead lock never both get in.
     * The name is one dot-file of the data folder; the action's result is returned as it is.
     */
    async withDataLock<T>(name: string, action: () => Promise<T>): Promise<T> {
        if (!/^\.[a-z0-9-]+\.lock$/.test(name))
            fail('E_VALIDATION', 'Invalid lock name.', name);
        await this.ensureDirectory(this.dataDir, this.measurement());
        const release = await this.acquire(path.join(this.dataDir, name), this.measurement());
        try {
            return await action();
        }
        finally {
            await release();
        }
    }
    async withBoardLock<T>(id: string, action: (board: Board) => Promise<T>): Promise<Result<T>> {
        const m = this.measurement();
        try {
            return this.outcome(m, await this.exclusive(id, m, async () => action(await this.readBoard(id))));
        }
        catch (error) {
            throw ioError(error, this.boardPath(id));
        }
    }
    private async committedEffect(board: Board, m: Measurement): Promise<CommitEffect['status']> {
        if (!this.afterCommit) return 'skipped';
        try {
            const effect = await this.afterCommit(structuredClone(board), this);
            m.warnings.push(...effect.warnings);
            m.io.exportWrites += effect.exportWrites;
            m.io.bytesWritten += effect.bytesWritten;
            return effect.status;
        } catch (error) {
            m.warnings.push(warning('W_EXPORT_FAILED', 'The board was saved, but its derived output failed.', board.cwd,
                'Run kanban export --workspace ' + board.id + ' after checking the output path.'));
            return 'failed';
        }
    }
    private async initialize(m: Measurement): Promise<void> {
        await this.allowed(this.dataDir);
        await this.ensureDirectory(this.dataDir, m);
        for (const dir of ['boards', 'templates', '_archive'])
            await this.ensureDirectory(path.join(this.dataDir, dir), m);
        const config = path.join(this.dataDir, 'config.json');
        try {
            await this.fileBytes(config);
            await this.readConfig();
        }
        catch (error) {
            if (codeOf(error) !== 'ENOENT')
                throw error;
            await this.exclusive(undefined, m, async () => { try {
                await this.fileBytes(config);
            }
            catch (second) {
                if (codeOf(second) !== 'ENOENT')
                    throw second;
                await this.atomicWrite(config, Buffer.from(stableStringify({ schemaVersion: 1, exportEnabled: true, locale: 'en', export: { detail: 'compact' } }, 2) + '\n'), m, 'config');
            } });
        }
    }
    async readBoard(id: string): Promise<Board> {
        const file = this.boardPath(id);
        try {
            const board = this.validateStored(await this.readDocument(file), validateBoard, file);
            if (board.id !== id)
                fail('E_CORRUPT', 'Board id does not match its filename.', file);
            return board;
        }
        catch (error) {
            if (codeOf(error) === 'ENOENT')
                fail('E_NOT_FOUND', 'Board not found.', id, 'Initialize the workspace or select an existing board.');
            throw ioError(error, file);
        }
    }
    private serializeBoard(board: Board): Buffer {
        const { schemaVersion, id, workspaceId, cwd, workspaceStatus, ...body } = board;
        const identity = { schemaVersion, id, workspaceId, cwd, workspaceStatus };
        const leading = JSON.stringify(identity, null, 2).trimEnd().slice(0, -1).trimEnd();
        const rest = stableStringify(body, 2).slice(1);
        return Buffer.from(leading + ',' + rest + '\n');
    }
    private validateIdentity(raw: unknown, id: string): BoardIdentity {
        const value = raw as BoardIdentity;
        if (!value || value.schemaVersion !== 1 || value.id !== id ||
            !isWorkspaceId(value.workspaceId) || typeof value.cwd !== 'string' ||
            !path.isAbsolute(value.cwd) ||
            !['active', 'inactive', 'unknown'].includes(value.workspaceStatus))
            fail('E_CORRUPT', 'Invalid board identity fields.', id,
                'Inspect the board without overwriting its contents.');
        return { schemaVersion: 1, id, workspaceId: value.workspaceId,
            cwd: value.cwd, workspaceStatus: value.workspaceStatus };
    }
    async readIdentity(id: string): Promise<BoardIdentity> {
        await this.safeParents(this.boardPath(id));
        return this.readIdentityFile(id);
    }
    private async readIdentityFile(id: string): Promise<BoardIdentity> {
        const file = this.boardPath(id);
        const info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink())
            fail('E_PATH_FORBIDDEN', 'Expected a regular board file.', file);
        const signature = [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
        const cached = this.identities.get(id);
        if (cached?.signature === signature) return { ...cached.identity };
        const fd = await fs.open(file, constants.O_RDONLY | O_NOFOLLOW);
        let prefix = ''; let identity: BoardIdentity | undefined; let readBytes = 0;
        try {
            const bytes = Buffer.alloc(1024);
            for (let offset = 0; offset < Math.min(info.size, 16384); offset += 1024) {
                const read = await fd.read(bytes, 0, 1024, offset);
                readBytes += read.bytesRead;
                prefix += bytes.subarray(0, read.bytesRead).toString('latin1');
                const end = prefix.indexOf('\n  "cards":');
                if (end >= 0) {
                    const header = Buffer.from(prefix.slice(0, end), 'latin1').toString('utf8');
                    const raw = parseJson(header.trimEnd().replace(/,$/, '') + '\n}');
                    identity = this.validateIdentity(raw, id); break;
                }
                if (!read.bytesRead) break;
            }
        } finally { await fd.close(); this.recordRead(file, readBytes, true); }
        // Legacy ledgers remain readable; only a real mutation changes their layout.
        identity ??= this.validateIdentity(await this.readBoard(id), id);
        this.identities.set(id, { signature, identity });
        return { ...identity };
    }
    async listBoardIdentities(): Promise<BoardIdentity[]> {
        const directory = path.join(this.dataDir, 'boards');
        let names: string[];
        try { await this.safeParents(path.join(directory, '_')); names = await fs.readdir(directory); }
        catch (error) { if (codeOf(error) === 'ENOENT') return []; throw error; }
        const values = await Promise.all(names.filter(name => name.endsWith('.json'))
            .sort().map(name => this.readIdentityFile(name.slice(0, -5))));
        const ids = new Set<string>();
        for (const value of values) {
            if (ids.has(value.workspaceId)) fail('E_CORRUPT', 'Duplicate workspace id.', value.workspaceId);
            ids.add(value.workspaceId);
        }
        return values;
    }
    /** Metadata probes never initialize storage or acquire a writer lock. */
    async statBoards(ids?: readonly string[]): Promise<{
        entries: { id: string; stamp: string }[]; errors: KanbanError[];
    }> {
        const directory = path.join(this.dataDir, 'boards');
        const entries: { id: string; stamp: string }[] = [];
        const errors: KanbanError[] = [];
        if (ids) for (const id of ids) this.boardPath(id);
        let selected: readonly string[];
        try {
            await this.safeParents(path.join(directory, '_'));
            selected = ids ?? (await fs.readdir(directory)).filter(n => n.endsWith('.json'))
                .sort().map(n => n.slice(0, -5));
        } catch (error) {
            if (codeOf(error) === 'ENOENT') return { entries, errors };
            throw ioError(error, directory);
        }
        for (const id of selected) {
            try {
                if (!isBoardId(id)) fail('E_CORRUPT', 'Invalid board filename.', id);
                const info = await fs.lstat(this.boardPath(id), { bigint: true });
                if (!info.isFile() || info.isSymbolicLink())
                    fail('E_PATH_FORBIDDEN', 'Expected a regular board file.', id);
                entries.push({ id, stamp: [info.dev, info.ino, info.size,
                    info.mtimeNs, info.ctimeNs].join(':') });
            } catch (error) {
                if (codeOf(error) !== 'ENOENT') errors.push(ioError(error, id));
            }
        }
        return { entries, errors };
    }
    async getRevision(id: string): Promise<Revision> { return (await this.readBoard(id)).revision; }
    async listBoards(): Promise<Board[]> {
        const directory = path.join(this.dataDir, 'boards');
        let names: string[];
        try {
            await this.safeParents(path.join(directory, '_'));
            names = await fs.readdir(directory);
        }
        catch (error) {
            if (codeOf(error) === 'ENOENT')
                return [];
            throw ioError(error, directory);
        }
        const boards: Board[] = [];
        const errors: unknown[] = [];
        const ids = new Set<string>();
        for (const name of names.filter(n => n.endsWith('.json')).sort()) {
            try {
                const id = name.slice(0, -5);
                if (!isBoardId(id))
                    fail('E_CORRUPT', 'Invalid board filename.', name);
                const board = await this.readBoard(id);
                if (ids.has(board.workspaceId))
                    fail('E_CORRUPT', 'Duplicate workspace id.', board.workspaceId);
                ids.add(board.workspaceId);
                boards.push(board);
            }
            catch (error) {
                errors.push(isKanbanError(error) ? { code: error.code, target: error.target, message: error.message } : String(error));
            }
        }
        if (errors.length)
            fail('E_CORRUPT', 'Some boards could not be read.', directory, 'Inspect the reported files without overwriting them.', { boards: boards.map(summarizeBoard), errors });
        return boards.sort((a, b) => a.cwd.localeCompare(b.cwd) || a.id.localeCompare(b.id));
    }
    async resolveIdentity(selector: string): Promise<BoardIdentity> {
        if (isBoardId(selector)) {
            await this.safeParents(this.boardPath(selector));
            return this.readIdentity(selector);
        }
        const boards = await this.listBoardIdentities();
        if (isWorkspaceId(selector)) {
            const match = boards.find(b => b.workspaceId === selector);
            if (match)
                return match;
            fail('E_NOT_FOUND', 'Workspace not registered.', selector, 'Initialize this workspace.');
        }
        const cwd = await canonicalPath(selector);
        let matches = boards.filter(b => inside(cwd, b.cwd));
        const longest = Math.max(...matches.map(b => b.cwd.length));
        matches = matches.filter(b => b.cwd.length === longest);
        for (const status of ['active', 'unknown', 'inactive']) {
            const choices = matches.filter(b => b.workspaceStatus === status);
            if (choices.length > 1)
                fail('E_WORKSPACE_AMBIGUOUS',
                     'Multiple boards match this directory.',
                     cwd,
                     'Select a complete boardId or workspaceId.',
                     choices.map(({ id,
                     workspaceId,
                     cwd,
                     workspaceStatus }) => ({ boardId: id,
                     workspaceId,
                     cwd,
                     workspaceStatus })));
            if (choices.length === 1)
                return choices[0]!;
        }
        fail('E_NOT_FOUND', 'No board matches this directory.', cwd, 'Initialize the workspace.');
    }
    async resolveWorkspace(selector: string): Promise<Board> {
        return this.readBoard((await this.resolveIdentity(selector)).id);
    }
    async resolveCurrentIdentity(explicit?: string,
        environment: Record<string, string | undefined> = process.env,
        cwd = process.cwd()): Promise<BoardIdentity> {
        if (explicit !== undefined) return this.resolveIdentity(explicit);
        if (environment.PASEO_AGENT_CWD !== undefined) {
            if (!path.isAbsolute(environment.PASEO_AGENT_CWD))
                fail('E_VALIDATION', 'Agent directory must be absolute.');
            return this.resolveIdentity(environment.PASEO_AGENT_CWD);
        }
        return this.resolveIdentity(cwd);
    }
    async resolveCurrentWorkspace(explicit?: string, environment: Record<string, string | undefined> = process.env, cwd = process.cwd()): Promise<Board> {
        if (explicit !== undefined)
            return this.resolveWorkspace(explicit);
        if (environment.PASEO_AGENT_CWD !== undefined) {
            if (!path.isAbsolute(environment.PASEO_AGENT_CWD))
                fail('E_VALIDATION', 'Agent directory must be absolute.');
            return this.resolveWorkspace(environment.PASEO_AGENT_CWD);
        }
        return this.resolveWorkspace(cwd);
    }
    async listTemplates(): Promise<Template[]> {
        const locale = (await this.readConfig()).locale;
        const templates = [builtinTemplate(locale)];
        const directory = path.join(this.dataDir, 'templates');
        let names: string[];
        try {
            await this.safeParents(path.join(directory, '_'));
            names = await fs.readdir(directory);
        }
        catch (error) {
            if (codeOf(error) === 'ENOENT')
                return templates;
            throw ioError(error, directory);
        }
        for (const name of names.filter(n => n.endsWith('.json')).sort()) {
            const file = path.join(directory, name);
            const template = this.validateStored(await this.readDocument(file, 1048576), validateTemplate, file);
            if (name !== `${template.id}@${template.version}.json` || templates.some(t => t.id === template.id && t.version === template.version))
                fail('E_CORRUPT', 'Duplicate template or filename mismatch.', file);
            templates.push(template);
        }
        for (const id of new Set(templates.map(t => t.id))) {
            const versions = templates.filter(t => t.id === id).map(t => t.version).sort((a, b) => a - b);
            if (versions.some((version, i) => version !== i + 1))
                fail('E_CORRUPT', 'Template versions must be consecutive.', id);
        }
        return templates;
    }
    async readTemplate(reference = 'basic@1'): Promise<Template> {
        const match = /^([a-z][a-z0-9_-]{0,47})(?:@([1-9]\d*))?$/.exec(reference);
        if (!match)
            fail('E_VALIDATION', 'Invalid template reference.', reference);
        const options = (await this.listTemplates()).filter(t => t.id === match[1] && (match[2] === undefined || t.version === Number(match[2]))).sort((a, b) => b.version - a.version);
        if (!options[0])
            fail('E_NOT_FOUND', 'Template not found.', reference, 'List the available templates.');
        return options[0];
    }
    private mutationInput(input: MutationInput): Operation[] {
        envelope(input, ['actor', 'requestId', 'operations'], ['ifRevision']);
        validateActor(input.actor);
        if (!isUUID(input.requestId))
            fail('E_VALIDATION', 'A requestId UUID is required by the store API.');
        if (input.ifRevision !== undefined)
            validateRevision(input.ifRevision);
        if (Buffer.byteLength(stableStringify(input)) > 1048576)
            fail('E_LIMIT', 'Request exceeds 1 MiB.');
        return normalizeOperations(input.operations);
    }
    private digest(id: string,
         actor: Actor,
         requestIdRevision: string | undefined,
         operations: unknown): string { return hash(stableStringify({ boardId: id,
         actor,
         ifRevision: requestIdRevision ?? null,
         operations }));
         }
    private replay(board: Board, requestId: string, digest: string): MutationData | null {
        const receipt = board.receipts.find(r => r.requestId === requestId);
        if (!receipt)
            return null;
        if (receipt.digest !== digest)
            fail('E_REQUEST_REUSED', 'Request id was used for a different request.', requestId, 'Retry the original arguments or use a new request id.');
        return { boardId: board.id, revision: receipt.revision, currentRevision: board.revision, requestId, cardIds: [...receipt.cardIds], changed: false, replayed: true };
    }
    private async confirmReplay(id: string, m: Measurement): Promise<void> {
        const file = this.boardPath(id);
        await this.safeParents(file);
        // D61: Windows flushes only a handle opened for writing.
        const fd = await fs.open(file, flushAccess() | O_NOFOLLOW);
        try {
            await fd.sync();
            m.io.fsyncCalls++;
        }
        finally {
            await fd.close();
        }
        await this.syncDirectory(path.dirname(file), m);
    }
    /**
     * REQ-52: the 300-card mark counts the cards still on the board — the archived ones are never drawn nor listed by
     * `kanban ls`, and once the automatic archive puts finished work away they would keep the warning on for good with
     * nothing left to do about it. What they still cost on disk is the 2 MiB mark's, which weighs the whole file.
     */
    private scales(board: Board, bytes: number, m: Measurement, count?: number): void {
        if (board.cards.filter(c => c.archivedAt === null).length > 300 || bytes > 2097152 || (count !== undefined && count > 30))
            m.warnings.push(warning('W_SCALE', 'Recommended operating size exceeded.', board.id, 'Measure storage and response costs before further growth.'));
    }
    private async boardCount(): Promise<number> { return (await fs.readdir(path.join(this.dataDir, 'boards'))).filter(name => /^board_[0-9a-f]{64}\.json$/.test(name)).length; }
    async boardWarnings(id: string): Promise<Warning[]> { const b = await this.readBoard(id);
         const m = this.measurement();
         this.scales(b,
         Buffer.byteLength(stableStringify(b,
         2) + '\n'),
         m,
         await this.boardCount());
         return m.warnings;
         }
    /**
     * D22 ⑤: which Paseo workspace owns this directory, read from Paseo's own read-only record.
     * `kanban init` has no other source for it — an agent shell carries PASEO_AGENT_ID and
     * PASEO_AGENT_CWD but never a workspace id, and the core does no live discovery — so without this
     * the first board at a directory keeps a `local_<hash(cwd)>` id for the rest of its life and the
     * plugin cannot pair it with the workspace Paseo later creates there. Nothing is written. A missing,
     * oversized, malformed or ambiguous record simply leaves the local id in place, so the CLI still
     * works with no Paseo installed. Archived rows are skipped; two live rows for one directory are
     * ambiguous and are refused rather than guessed.
     */
    private async paseoWorkspaceId(cwd: string): Promise<string | undefined> {
        // D44: the plugin's spelling, so a Windows directory written with the other slashes or drive case still matches.
        const same = normalizeCwd;
        try {
            const raw = await fs.readFile(path.join(this.paseoHome, 'projects', 'workspaces.json'), 'utf8');
            if (raw.length > 8 * 1024 * 1024)
                return undefined;
            const rows: unknown = JSON.parse(raw);
            if (!Array.isArray(rows))
                return undefined;
            const found = new Set<string>();
            const target = same(cwd);
            for (const row of rows) {
                if (!row || typeof row !== 'object')
                    continue;
                const value = row as { workspaceId?: unknown; cwd?: unknown; archivedAt?: unknown };
                if (value.archivedAt || typeof value.cwd !== 'string' || same(value.cwd) !== target)
                    continue;
                if (typeof value.workspaceId === 'string' && /^wks_[A-Za-z0-9_-]{1,128}$/.test(value.workspaceId))
                    found.add(value.workspaceId);
            }
            return found.size === 1 ? [...found][0] : undefined;
        }
        catch {
            return undefined;
        }
    }
    async initBoard(input: InitInput): Promise<Result<MutationData>> {
        const m = this.measurement();
        envelope(input, ['cwd', 'actor', 'requestId'], ['workspaceId', 'workspaceStatus', 'template', 'ifRevision', 'export']);
        if (input.export !== undefined && input.export !== false)
            fail('E_VALIDATION', 'Initialization accepts only export false.');
        validateActor(input.actor);
        if (!isUUID(input.requestId))
            fail('E_VALIDATION', 'A requestId UUID is required by the store API.');
        if (input.ifRevision !== undefined && input.ifRevision !== '0')
            fail('E_VALIDATION', 'Initialization accepts only revision 0.');
        const cwd = await canonicalPath(input.cwd);
        await this.allowed(cwd);
        try {
            if (!(await fs.stat(cwd)).isDirectory())
                fail('E_CWD_MISSING', 'Workspace directory does not exist.', cwd);
        }
        catch (error) {
            if (codeOf(error) === 'ENOENT')
                fail('E_CWD_MISSING', 'Workspace directory does not exist.', cwd);
            throw error;
        }
        let existing = await this.listBoardIdentities();
        const inferred = input.workspaceId === undefined && existing.some(board => board.cwd === cwd)
            ? (await this.resolveIdentity(cwd)).workspaceId : undefined;
        // D22 ⑤: a board at a directory Paseo already owns takes Paseo's workspace id instead of a
        // local one. A board that is already here still wins, so no existing identity ever moves.
        const discovered = input.workspaceId === undefined && inferred === undefined
            ? await this.paseoWorkspaceId(cwd) : undefined;
        const workspaceId = input.workspaceId ?? inferred ?? discovered ?? `local_${hash(cwd)}`;
        if (!isWorkspaceId(workspaceId))
            fail('E_VALIDATION', 'Invalid workspace id.', workspaceId);
        await this.initialize(m);
        for (let attempt = 0;; attempt++) {
            const found = existing.find(b => b.workspaceId === workspaceId);
            const id = found?.id ?? `board_${hash(workspaceId + (attempt ? `#${attempt}` : ''))}`;
            try {
                const answer = await this.exclusive(id, m, async (): Promise<MutationData | null> => {
                    let current: Board | undefined;
                    try {
                        current = await this.readBoard(id);
                    }
                    catch (error) {
                        if (!(isKanbanError(error) && error.code === 'E_NOT_FOUND'))
                            throw error;
                    }
                    if (current && current.workspaceId !== workspaceId)
                        return null;
                    const operations = [{ op: 'init',
                         cwd,
                         workspaceId,
                         ...(input.template === undefined ? {} : { template: input.template }),
                         ...(input.workspaceStatus === undefined ? {} : { workspaceStatus: input.workspaceStatus }) }];
                    const digest = this.digest(id, input.actor, input.ifRevision, operations);
                    if (current) {
                        const replay = this.replay(current, input.requestId, digest);
                        if (replay) {
                            await this.confirmReplay(id, m);
                            return replay;
                        }
                        if (input.ifRevision === '0')
                            fail('E_REVISION_CONFLICT', 'The board already exists.', id, 'Read the current board before editing.', { expected: '0', actual: current.revision });
                        const refMatches = input.template === undefined || input.template === current.template.id || input.template === `${current.template.id}@${current.template.version}`;
                        if (current.cwd !== cwd || !refMatches || (input.workspaceStatus !== undefined && input.workspaceStatus !== current.workspaceStatus))
                            fail('E_ALREADY_INITIALIZED', 'The board has different settings.', id, 'Inspect the existing board.');
                        this.scales(current, Buffer.byteLength(stableStringify(current)), m, existing.length);
                        return { boardId: id, revision: current.revision, currentRevision: current.revision, requestId: input.requestId, cardIds: [], changed: false, replayed: false };
                    }
                    const template = await this.readTemplate(input.template);
                    const now = this.context.now();
                    const board: Board = { schemaVersion: 1,
                         id,
                         workspaceId,
                         cwd,
                         workspaceStatus: input.workspaceStatus ?? 'active',
                         template,
                         revision: `${this.context.newId()}:1`,
                         cards: [],
                         history: [],
                         receipts: [],
                         createdAt: now,
                         updatedAt: now };
                    board.receipts.push({ requestId: input.requestId, digest, revision: board.revision, cardIds: [] });
                    validateBoard(board);
                    await this.ensureDirectory(path.join(this.dataDir, '_archive', id), m);
                    const bytes = this.serializeBoard(board);
                    this.scales(board, bytes.length, m, existing.length + 1);
                    const sameCwd = existing.filter(b => b.cwd === cwd);
                    if (sameCwd.length)
                        m.warnings.push(warning('W_SHARED_CWD', 'Other boards use this workspace directory.', cwd, 'Select boards by workspaceId and review export ownership.'));
                    await this.atomicWrite(this.boardPath(id), bytes, m, 'board');
                    // D66: a new board starts its decision file, so every card on it is judged by this version from the first.
                    // Its folder is not flushed for it: losing this empty file only makes the board read as one from before it.
                    await this.saveControl(emptyControl(board), board, m, false, false);
                    const exportStatus = input.export === false ? 'skipped' : await this.committedEffect(board, m);
                    return { export: exportStatus, boardId: id, revision: board.revision, currentRevision: board.revision, requestId: input.requestId, cardIds: [], changed: true, replayed: false };
                });
                if (answer)
                    return this.outcome(m, answer, answer.changed);
                existing = await this.listBoardIdentities();
            }
            catch (error) {
                throw ioError(error, this.boardPath(id), true);
            }
        }
    }
    private async backup(board: Board, m: Measurement): Promise<void> {
        const source = this.boardPath(board.id);
        const directory = path.join(this.dataDir, '_archive', board.id);
        await this.ensureDirectory(directory, m);
        await this.safeParents(path.join(directory, '_'));
        const file = path.join(directory, `${board.revision.replace(':', '-')}.json`);
        try {
            await this.link(source, file);
            m.io.backupLinks++;
        }
        catch (error) {
            if (codeOf(error) === 'EEXIST') {
                const old = await this.fileBytes(file);
                const current = await this.fileBytes(source);
                if (!old.equals(current))
                    fail('E_CORRUPT', 'Backup content does not match its revision.', file);
            }
            else if (codeOf(error) === 'EXDEV' || codeOf(error) === 'EPERM') {
                m.warnings.push(warning('W_BACKUP_COPY', 'Hardlink unavailable; copying the backup.', file, 'Review filesystem hardlink support if write costs matter.'));
                await this.atomicWrite(file, await this.fileBytes(source), m, 'backup', false);
            }
            else
                throw error;
        }
        const validator: (value: unknown) => asserts value is Board = createBoardValidator();
        const candidates: {
            name: string;
            revision: string;
            updatedAt: string;
        }[] = [];
        const names = await fs.readdir(directory);
        for (let offset = 0; offset < names.length; offset += 4) {
            await Promise.all(names.slice(offset, offset + 4).map(async name => {
                if (!/^[0-9a-f-]{36}-[1-9]\d*\.json$/.test(name)) {
                    if (name.endsWith('.json')) m.warnings.push(warning('W_BACKUP_UNMANAGED',
                        'Unrecognized backup filename excluded from retention.', path.join(directory, name),
                        'Inspect this file; it was not counted or deleted.'));
                    return;
                }
                const target = path.join(directory, name);
                if (target === file) {
                    // This immutable version was already validated as the current ledger.
                    // EEXIST content equality was checked above before reaching this branch.
                    candidates.push({ name, revision: board.revision, updatedAt: board.updatedAt });
                    return;
                }
                try {
                    const old = this.validateStored(await this.readDocument(target), validator, target);
                    if (old.id !== board.id || old.revision.replace(':', '-') + '.json' !== name)
                        fail('E_CORRUPT', 'Backup identity mismatch.', target);
                    candidates.push({ name, revision: old.revision, updatedAt: old.updatedAt });
                } catch {
                    m.warnings.push(warning('W_BACKUP_UNMANAGED',
                        'Unreadable or mismatched backup excluded from retention.', target,
                        'Inspect this file with doctor; it was not counted or deleted.'));
                }
            }));
        }
        const epoch = board.revision.split(':')[0];
        candidates.sort((a,
             b) => { const ac = a.revision.split(':')[0] === epoch;
             const bc = b.revision.split(':')[0] === epoch;
             return Number(bc) - Number(ac) ||
            (ac &&
            bc ? Number(b.revision.split(':')[1]) - Number(a.revision.split(':')[1]) : b.updatedAt.localeCompare(a.updatedAt) ||
            b.name.localeCompare(a.name));
             });
        const removed = candidates.slice(20);
        for (const item of removed)
            await fs.unlink(path.join(directory, item.name));
        await this.syncDirectory(directory, m);
    }
    /** `caller` is set only by the board screen's handler and the dispatcher (D37); the CLI and agents pass none. */
    async mutateBoard(id: string, input: MutationInput, caller?: Caller): Promise<Result<MutationData>> {
        const m = this.measurement();
        const operations = this.mutationInput(input);
        checkCaller(operations, input.actor, caller);
        return this.commitMutation(id, m, input, operations, caller, null);
    }
    /**
     * D66: the automatic cards' own entry point — the only way a stage change counts as automatic. Not reachable from a
     * request: no actor, caller or field of `mutateBoard` claims it. Inside the board's lock the card's decision is read
     * again: a move needs the card `managed` under the token the engine judged by, the awaiting flag and the automatic title
     * need it `managed` or `paused`, a card that needs a check or is archived takes nothing, and every card but a new one
     * must carry the agent. A refusal is `E_AUTO_HELD` with nothing written to the ledger.
     */
    async autoMutate(id: string, input: AutoMutationInput): Promise<Result<MutationData>> {
        const m = this.measurement();
        const base: MutationInput = { actor: { kind: 'agent', agentId: input.agentId }, requestId: input.requestId, operations: input.operations,
            ...(input.ifRevision === undefined ? {} : { ifRevision: input.ifRevision }) };
        const operations = this.mutationInput(base);
        checkCaller(operations, base.actor, undefined);
        if (input.expect !== undefined && (!input.expect || typeof input.expect.controlEpoch !== 'string' || !Number.isSafeInteger(input.expect.generation)))
            fail('E_VALIDATION', 'Invalid automatic-move token.');
        for (const op of operations)
            if (!['add', 'link', 'move', 'update'].includes(op.op))
                fail('E_VALIDATION', 'The automatic cards only add, link, move and update cards.', op.op);
        return this.commitMutation(id, m, base, operations, undefined, { agentId: input.agentId, expect: input.expect ?? null });
    }
    private async commitMutation(id: string, m: Measurement, input: MutationInput, operations: Operation[], caller: Caller | undefined,
        engine: { agentId: string; expect: ControlToken | null } | null): Promise<Result<MutationData>> {
        const digest = this.digest(id, input.actor, input.ifRevision, operations);
        const prepare = async (board: Board): Promise<{
            data: MutationData;
            next: Board | null;
            warnings: Warning[];
        }> => {
            const replay = this.replay(board, input.requestId, digest);
            if (replay) {
                await this.confirmReplay(id, m);
                return { data: replay, next: null, warnings: [] };
            }
            if (input.ifRevision !== undefined && input.ifRevision !== board.revision)
                fail('E_REVISION_CONFLICT', 'Board revision changed.', id, 'Read the board and reconsider the operation.', { expected: input.ifRevision, actual: board.revision });
            const applied = applyOperations(board, operations, input.actor, this.context, caller);
            const data = { boardId: id,
                 revision: applied.board.revision,
                 currentRevision: applied.board.revision,
                 requestId: input.requestId,
                 cardIds: applied.cardIds,
                 changed: applied.changed,
                 replayed: false };
            if (!applied.changed)
                return { data, next: null, warnings: applied.warnings };
            applied.board.receipts.push({ requestId: input.requestId, digest, revision: applied.board.revision, cardIds: applied.cardIds });
            applied.board.receipts = applied.board.receipts.slice(-1000);
            return { data, next: applied.board, warnings: applied.warnings };
        };
        try {
            if (input.ifRevision !== undefined && !engine) {
                const candidate = await prepare(await this.readBoard(id));
                if (!candidate.next) {
                    m.warnings.push(...candidate.warnings, ...await this.boardWarnings(id));
                    return this.outcome(m, candidate.data);
                }
            }
            const data = await this.exclusive(id, m, async () => {
                const current = await this.readBoard(id);
                // D66: the card decisions as they hold now, judged and saved under this same lock.
                // A damaged file is set aside here and the board started again from its cards (gate 489 F1, `controlFor`).
                const control = this.replay(current, input.requestId, digest) ? null : await this.controlFor(current, m);
                if (engine && control) {
                    const refusal = !control.control ? { reason: control.status, cardId: null } : engineRefusal(current, control.control, operations, engine.agentId, engine.expect);
                    if (refusal) {
                        if (control.control && control.changed) await this.saveControl(control.control, current, m);
                        throw createKanbanError('E_AUTO_HELD', 'Automatic moves are on hold for this card.', refusal.cardId ?? id,
                            'Reload the board and the card, then try again.', { reason: refusal.reason, problem: control.problem });
                    }
                }
                const candidate = await prepare(current);
                m.warnings.push(...candidate.warnings);
                if (!candidate.next) {
                    this.scales(current, Buffer.byteLength(stableStringify(current, 2) + '\n'), m, await this.boardCount());
                    if (control?.control && control.changed) await this.saveControl(control.control, current, m);
                    return candidate.data;
                }
                validateBoard(candidate.next);
                const bytes = this.serializeBoard(candidate.next);
                this.scales(candidate.next, bytes.length, m, await this.boardCount());
                // Gates 481/483 — fail closed: the decisions this commit makes (a tracked card's stage changed by anybody, a
                // first link, the engine's own move) are saved BEFORE the ledger, in this same lock. If they cannot be saved
                // the ledger is not written and the change is refused, so no commit ever stands without its decision and
                // nothing is inferred later from the bounded history or the ledger's clock. If the ledger write fails after
                // them, the card is held (a paused card whose move did not land; research/477 설계보완 §8) — never freed.
                // A change that decides nothing (an untracked card, a note) does not touch the decision file at all.
                // Gate 489 F1 — the same for a file that cannot be read now: what it holds is not known, so a change that could
                // decide anything (any card's stage, a first link) is refused, and nothing is left for it to learn once it reads
                // again — no repair is skipped, there is none to make. A change that decides nothing still saves.
                if (control && !control.control) {
                    if (mayDecide(current, candidate.next))
                        throw createKanbanError('E_AUTO_CONTROL', 'Not saved — the board\'s automatic-move record can\'t be read.',
                            this.controlPath(id), 'Check free space and permissions for the plugin\'s data folder, then send the same change again.',
                            { requestId: input.requestId, reason: control.status, problem: control.problem });
                    m.warnings.push(warning('W_AUTO_CONTROL', 'The board was saved, but its automatic-move record can\'t be read, so the record was left as it is.',
                        this.controlPath(id), 'Automatic moves stay on hold on this board until the record can be read.'));
                }
                else if (control?.control && (commitDecisions(current, candidate.next, control.control, !!engine, this.clock()) || control.changed)) {
                    try { await this.saveControl(control.control, candidate.next, m, true); }
                    catch (error) {
                        throw createKanbanError('E_AUTO_CONTROL', 'Not saved — the card\'s automatic-move record couldn\'t be saved first.',
                            this.controlPath(id), 'Check free space and permissions for the plugin\'s data folder, then send the same change again.',
                            { requestId: input.requestId, cause: isKanbanError(error) ? error.details : String(error) });
                    }
                }
                await this.backup(current, m);
                await this.atomicWrite(this.boardPath(id), bytes, m, 'board');
                const exportStatus = await this.committedEffect(candidate.next, m);
                return { ...candidate.data, export: exportStatus };
            });
            return this.outcome(m, data, data.changed);
        }
        catch (error) {
            const e = ioError(error, this.boardPath(id), true);
            if (e.code === 'E_IO')
                throw createKanbanError(e.code, e.message, e.target, e.nextAction, { requestId: input.requestId, cause: e.details }, 'unknown');
            throw e;
        }
    }
    // ---- D66: the card decisions of the automatic cards (server/core/auto-control.ts) ----
    private controlPath(id: string): string { if (!isBoardId(id))
        fail('E_VALIDATION', 'Invalid board id.', id); return path.join(this.dataDir, AUTO_CONTROL_DIR, `${id}.json`); }
    private clock() { return { now: () => this.context.now(), newId: () => this.context.newId() }; }
    /**
     * Gate 489 F1: why a file is not read tells what may be done. Bytes that were read but are no decision file of this board
     * are `damaged` for good (nothing will make them readable); anything that kept the bytes from being read — permissions,
     * I/O, a path that is not a plain file — is `unreadable`, a passing state the file itself may be fine through, as is a
     * newer schema (another version's file, not ours to set aside).
     */
    private async loadControl(id: string): Promise<{ status: ControlStatus; control: AutoControl | null; problem: string | null }> {
        const file = this.controlPath(id);
        let bytes: Buffer;
        try { bytes = await this.fileBytes(file, AUTO_CONTROL_BYTES); }
        catch (error) {
            if (codeOf(error) === 'ENOENT') return { status: 'missing', control: null, problem: null };
            if (isKanbanError(error) && error.code === 'E_LIMIT') return { status: 'damaged', control: null, problem: 'too large' };
            return { status: 'unreadable', control: null, problem: isKanbanError(error) ? error.code : codeOf(error) ?? 'unreadable' };
        }
        let raw: unknown;
        try { raw = this.decode(bytes, file); } catch { return { status: 'damaged', control: null, problem: 'json' }; }
        const parsed = parseControl(raw, id);
        if ('control' in parsed) return { status: 'ok', control: parsed.control, problem: null };
        const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
        if (typeof version === 'number' && version > 1) return { status: 'unreadable', control: null, problem: 'schemaVersion ' + version };
        return { status: 'damaged', control: null, problem: parsed.problem };
    }
    /**
     * Gate 489 F1: a damaged decision file is moved aside — kept beside, as `<board>.json.damaged-<time>`, never written
     * over or deleted — so the board can start a new epoch. Its folder is flushed: the file must not come back after a crash.
     */
    private async setAsideControl(file: string, m: Measurement): Promise<string> {
        const target = file + '.damaged-' + this.context.now().replace(/[:.]/g, '-') + '-' + this.context.newId().slice(0, 8);
        await renameOver(file, target);
        await this.syncDirectory(path.dirname(file), m);
        return target;
    }
    /** What the engine's memory names of this board's cards; read only when a card has no decision yet. */
    private async controlEvidence(id: string): Promise<ControlEvidence> {
        try {
            const state = await readAutoState(this.dataDir);
            if (state.damaged) return { readable: false, remembered: new Set() };
            const entries = new Map<string, RememberedEntry[]>();
            for (const [agentId, e] of Object.entries(state.agents)) {
                if (e.boardId !== id) continue;
                entries.set(e.cardId, [...entries.get(e.cardId) ?? [], { agentId, moved: e.moved?.revision ?? null, paused: !!e.pausedAt }]);
            }
            return { readable: true, remembered: new Set(entries.keys()), entries };
        } catch { return { readable: false, remembered: new Set() }; }
    }
    /**
     * G2b: how a missing file starts again. A board none of whose files this version ever kept is one from before the file:
     * it is migrated (`migrate`, research/470 B5). Anything this version keeps beside a board's file — a report of an earlier
     * start, a file set aside — proves the board had one: it starts strictly (`lost`), or, when a file was set aside for a
     * restore (`<boardId>.json.restored…`, see docs/reference.md) that no report names yet, as that restore (`restored`).
     */
    private async missingKind(id: string): Promise<{ kind: RebaseKind; previous: string | null }> {
        const dir = path.join(this.dataDir, AUTO_CONTROL_DIR);
        let names: string[];
        try { names = (await fs.readdir(dir)).filter(name => name.startsWith(id + '.') && name !== id + '.json'); }
        catch { return { kind: 'migrated', previous: null }; }
        if (!names.length) return { kind: 'migrated', previous: null };
        const named = new Set<string>();
        for (const name of names.filter(n => n.startsWith(id + '.rebase-'))) {
            try { const previous = JSON.parse((await this.fileBytes(path.join(dir, name), AUTO_CONTROL_BYTES)).toString('utf8')).previous;
                if (typeof previous === 'string') named.add(previous); } catch { /* a report that cannot be read names nothing */ }
        }
        const restored = names.filter(n => n.startsWith(id + '.json.restored') && !named.has(n)).sort().at(-1);
        return restored ? { kind: 'restored', previous: restored } : { kind: 'lost', previous: null };
    }
    /** G2b: the report of a start of a board's decisions, beside them. Only a record for people: a failure is a warning. */
    private async writeRebaseReport(kind: RebaseKind, board: Board, control: AutoControl, previous: string | null, m: Measurement): Promise<void> {
        const at = this.context.now();
        const file = path.join(this.dataDir, AUTO_CONTROL_DIR, `${board.id}.rebase-${at.replace(/[:.]/g, '-')}-${this.context.newId().slice(0, 8)}.json`);
        try { await this.atomicWrite(file, Buffer.from(stableStringify(rebaseReport(kind, board, control, previous, at), 2) + '\n'), m, 'config', false); }
        catch { m.warnings.push(warning('W_AUTO_CONTROL', 'The board\'s automatic-move record was started over, but the report about it couldn\'t be saved.', file,
            'Check free space and permissions for the plugin\'s data folder.')); }
    }
    /**
     * The board's card decisions as they hold now. `m` is given under the board's lock only: there a damaged file is set
     * aside (gate 489 F1) and the board judged again from its cards in a new epoch — the start of a board from before the
     * file, but stricter: the file existed, so a card nothing proves untracked needs a check (nothing is freed, a completed
     * card stays paused). It is saved with the commit that found it. A file that cannot be set aside is held as unreadable.
     */
    private async controlFor(board: Board, m?: Measurement): Promise<{ status: ControlStatus; control: AutoControl | null; changed: boolean; problem: string | null; started?: boolean }> {
        let loaded = await this.loadControl(board.id), start: { kind: RebaseKind; previous: string | null } | null = null;
        if (loaded.status === 'damaged' && m) {
            const file = this.controlPath(board.id);
            try {
                const kept = await this.setAsideControl(file, m);
                m.warnings.push(warning('W_AUTO_CONTROL', 'The automatic-move record was damaged (' + loaded.problem + '). It was set aside and kept, and the record was started over, so tracked cards need a check.',
                    kept, 'Check each card, then turn its automatic tracking back on from its detail.'));
                loaded = { status: 'missing', control: null, problem: loaded.problem }; start = { kind: 'damaged', previous: path.basename(kept) };
            } catch (error) {
                loaded = { status: 'unreadable', control: null, problem: loaded.problem + '; not set aside: ' + (codeOf(error) ?? 'error') };
            }
        }
        if (!loaded.control && loaded.status !== 'missing') return { ...loaded, changed: false };
        start ??= loaded.control ? null : await this.missingKind(board.id);
        const saved = loaded.control;
        // A strict start trusts no memory: the board had a file, so a card nothing proves untracked needs a check.
        const evidence: ControlEvidence = start && start.kind !== 'migrated' ? { readable: false, remembered: new Set<string>() }
            : !saved || board.cards.some(c => !saved.cards[c.id] && c.agents.length > 0) ? await this.controlEvidence(board.id) : { readable: true, remembered: new Set<string>() };
        const { control, changed } = reconcile(board, saved, evidence, this.clock(), start?.kind === 'migrated');
        // G2b: a start is made once, under the lock, and written down — the decisions, then the report of what they became.
        // If they cannot be saved here the commit goes on as before (`changed`) and the next look starts again.
        if (start && m) {
            if (start.kind === 'lost' || start.kind === 'restored')
                m.warnings.push(warning('W_AUTO_CONTROL', start.kind === 'restored'
                    ? 'The automatic-move record was set aside for a restore and started over, so tracked cards need a check.'
                    : 'The automatic-move record was missing and was started over, so tracked cards need a check.',
                    this.controlPath(board.id), 'Check each card, then turn its automatic tracking back on from its detail.'));
            if (await this.saveControl(control, board, m)) {
                await this.writeRebaseReport(start.kind, board, control, start.previous, m);
                return { status: 'ok', control, changed: false, problem: loaded.problem, started: true };
            }
        }
        return { status: loaded.status, control, changed, problem: loaded.problem };
    }
    /** Saves the decisions after a ledger commit (or alone, for a resume). A failure is a warning: the cards differ next time. */
    private async saveControl(control: AutoControl, board: Board, m: Measurement, strict = false, syncParent = true): Promise<boolean> {
        try {
            await this.ensureDirectory(path.join(this.dataDir, AUTO_CONTROL_DIR), m);
            const next = { ...control, revision: board.revision, controlSeq: control.controlSeq + 1 };
            await this.atomicWrite(this.controlPath(board.id), Buffer.from(stableStringify(next, 2) + '\n'), m, 'config', syncParent);
            control.controlSeq = next.controlSeq; control.revision = next.revision;
            return true;
        } catch (error) {
            if (strict) throw ioError(error, this.controlPath(board.id), true);
            m.warnings.push(warning('W_AUTO_CONTROL', 'The board was saved, but its automatic-move record couldn\'t be.', this.controlPath(board.id),
                'The cards this change moved are on hold for a check until they\'re turned back on.'));
            return false;
        }
    }
    /**
     * D66: the card decisions of a board as they hold now, read without the lock (the board first, then the file): a
     * writer between the two reads makes its cards differ, so they read as held, never as free. Nothing is written.
     */
    async readAutoControl(id: string): Promise<ControlView> {
        const board = await this.readBoard(id);
        const control = await this.controlFor(board);
        // A damaged file is not settled: the next look under the lock sets it aside (`settleAutoControl`).
        return { status: control.status, problem: control.problem, controlEpoch: control.control?.controlEpoch ?? null, board,
            cards: control.control?.cards ?? {}, settled: control.status !== 'damaged' && !control.changed };
    }
    /**
     * D66: saves what `readAutoControl` judged but the file does not hold yet — the first look at a board from before the
     * file, a card an older writer added or moved, a damaged file set aside (gate 489 F1) — under the board's lock, read
     * again there. Writes only when it differs, never over a damaged file (it is moved aside first); so an old card that
     * needs a check stays recorded as such (not judged again from a memory that may be trimmed later).
     */
    async settleAutoControl(id: string): Promise<Result<{ saved: boolean }>> {
        const m = this.measurement();
        try {
            const data = await this.exclusive(id, m, async () => {
                const board = await this.readBoard(id);
                const control = await this.controlFor(board, m);
                return { saved: !!control.started || (!!control.control && control.changed && await this.saveControl(control.control, board, m)) };
            });
            return this.outcome(m, data, false);
        } catch (error) { throw ioError(error, this.controlPath(id)); }
    }
    /**
     * D66: "resume automatic tracking" for one card — committed when the decision file is saved, under the board's lock;
     * the ledger is not written. Any mode resumes (476 F3: a card that needs a check too), the card's current stage becomes
     * the confirmed one, and nothing moves until the next signal. With `expect` (G2's screens), the card's decision must
     * still be the one the person saw — the board's revision aside (476 F2) — and a retry of the same decision replays.
     */
    async resumeAuto(id: string, cardId: string, expect?: ResumeExpectation): Promise<Result<ResumeData>> {
        const m = this.measurement();
        try {
            const data = await this.exclusive(id, m, async (): Promise<ResumeData> => {
                const board = await this.readBoard(id);
                const card = board.cards.find(c => c.id === cardId);
                if (!card) fail('E_NOT_FOUND', 'Card not found.', cardId, 'Refresh the board.');
                const control = await this.controlFor(board, m);
                // Gate 489 F1: not known now, so nothing can be decided — tried again once the file reads.
                if (!control.control)
                    throw createKanbanError('E_AUTO_CONTROL', 'Not saved — the board\'s automatic-move record can\'t be read.', this.controlPath(id),
                        'Check free space and permissions for the plugin\'s data folder, then try again.', { reason: control.status, problem: control.problem });
                const entry = control.control.cards[cardId]!;
                const answer = (e: ControlEntry, replayed: boolean): ResumeData => ({ boardId: id, cardId, controlEpoch: control.control!.controlEpoch,
                    generation: e.generation, decisionId: e.decisionId, mode: e.mode, replayed });
                if (expect) {
                    if (expect.decisionId && entry.decisionId === expect.decisionId && entry.reason === 'resumed') return answer(entry, true);
                    if (expect.controlEpoch !== control.control.controlEpoch || expect.generation !== entry.generation
                        || (expect.card !== undefined && expect.card !== cardSeen(board, card)))
                        fail('E_AUTO_STALE', 'This card\'s automatic-move record has changed since it was read.', cardId,
                            'Reload the card and decide again.', { controlEpoch: control.control.controlEpoch, generation: entry.generation });
                }
                const next: ControlEntry = { mode: 'managed', generation: entry.generation + 1, decisionId: expect?.decisionId ?? this.context.newId(),
                    ...seen(card, board.revision), reason: 'resumed', at: this.context.now() };
                control.control.cards[cardId] = next;
                try { await this.saveControl(control.control, board, m, true); }
                catch (error) {
                    // Whether the file was replaced before the failure is not known; the card's next read tells, and a retry of
                    // the same decision replays if it was.
                    throw createKanbanError('E_AUTO_CONTROL', 'Turning tracking back on may not have been saved — the card\'s automatic-move record couldn\'t be written.', this.controlPath(id),
                        'Check free space and permissions for the plugin\'s data folder, then try again.',
                        { cause: isKanbanError(error) ? error.details : String(error) }, 'unknown');
                }
                return answer(next, false);
            });
            return this.outcome(m, data, !data.replayed);
        } catch (error) { throw ioError(error, this.controlPath(id), true); }
    }
    async unlock(id?: string, options: UnlockOptions = {}): Promise<Result<{
        unlocked: boolean;
        scope: string;
        reclaimedToken: string | null;
    }>> {
        const m = this.measurement();
        const file = this.lockPath(options.global ? undefined : id);
        const guard = `${file}.claim`;
        if (id === undefined && !options.global)
            fail('E_VALIDATION', 'Select a board or the global metadata scope.');
        if (options.force && !options.offline)
            fail('E_VALIDATION', 'Forced recovery requires an explicit offline assertion.', file, 'Stop all writers and pass offline: true.');
        try {
            if (await this.lockRecord(file) === null && await this.lockRecord(guard) === null)
                return this.outcome(m, { unlocked: false, scope: file, reclaimedToken: null });
            if (options.force) {
                const records = await Promise.all([this.lockRecord(guard), this.lockRecord(file)]);
                for (const record of records)
                    if (record && await this.liveness(record.owner) === 'live')
                        fail('E_LOCK_ACTIVE', 'Refusing to force a live lock owner.', file, 'Stop the owner before forced recovery.');
                const token = randomUUID();
                if (records[0])
                    await this.quarantine(guard, token);
                if (records[1])
                    await this.quarantine(file, token);
                m.warnings.push(warning('W_STALE_LOCK', 'Forced offline recovery completed.', file, 'Run doctor before resuming writers.'));
                return this.outcome(m, { unlocked: true, scope: file, reclaimedToken: records[1]?.owner?.token ?? null });
            }
            const release = await this.claim(file, performance.now() + this.timeout);
            try {
                const record = await this.lockRecord(file);
                if (!record)
                    return this.outcome(m, { unlocked: false, scope: file, reclaimedToken: null });
                if (!record.owner || Date.now() - Date.parse(record.owner.createdAt) <= 60000 || await this.liveness(record.owner) !== 'dead') {
                    const advice = await this.lockAdvice(record, m.start, 1);
                    fail('E_LOCK_ACTIVE', 'Lock is active or not yet eligible for recovery.',
                        file, advice.nextAction, advice.details);
                }
                await this.quarantine(file, randomUUID());
                m.warnings.push(warning('W_STALE_LOCK', 'Removed an abandoned lock.', file, 'Inspect the previous operation.'));
                return this.outcome(m, { unlocked: true, scope: file, reclaimedToken: record.owner.token });
            }
            finally {
                await release();
            }
        }
        catch (error) {
            throw ioError(error, file);
        }
    }
    async doctor(id: string): Promise<Result<{
        checks: CheckResult[];
    }>> {
        const m = this.measurement();
        const checks: CheckResult[] = [];
        const inspect = async (target: string, action: () => Promise<unknown>) => {
            try {
                await action();
                checks.push({ target, status: 'ok', code: 'OK', message: 'Validation passed.', nextAction: '' });
            }
            catch (error) {
                const e = ioError(error, target);
                checks.push({ target, status: 'error', code: e.code, message: e.message, nextAction: e.nextAction });
            }
        };
        await inspect(this.boardPath(id), () => this.readBoard(id));
        await inspect(path.join(this.dataDir, 'config.json'), () => this.readConfig());
        try {
            const boards = await this.listBoards();
            const board = boards.find(b => b.id === id);
            if (board) {
                const warnings = await this.boardWarnings(id);
                m.warnings.push(...warnings);
                await this.allowed(board.cwd);
                try {
                    if (!(await fs.stat(board.cwd)).isDirectory()) throw Object.assign(new Error('Not a directory.'), { code: 'ENOENT' });
                } catch (error) {
                    if (codeOf(error) !== 'ENOENT') throw error;
                    m.warnings.push(warning('W_CWD_MISSING', 'Workspace directory is missing.', board.cwd, 'Restore the directory before exporting.'));
                }
            }
        }
        catch (error) {
            const e = ioError(error, id);
            checks.push({ target: e.target, status: 'error', code: e.code, message: e.message, nextAction: e.nextAction });
        }
        const directory = path.join(this.dataDir, '_archive', id);
        try {
            await this.safeParents(path.join(directory, '_'));
            const names = await fs.readdir(directory);
            const backups = names.filter(n => /^[0-9a-f-]{36}-[1-9]\d*\.json$/.test(n));
            for (const name of backups)
                await inspect(path.join(directory,
                     name),
                     async () => { const b = this.validateStored(await this.readDocument(path.join(directory,
                     name)),
                     validateBoard,
                     name);
                     if (b.id !== id || `${b.revision.replace(':',
                     '-')}.json` !== name)
                    fail('E_CORRUPT', 'Backup identity mismatch.', name); });
            if (backups.length > 20)
                m.warnings.push(warning('W_BACKUP_RETENTION', 'More than 20 backups remain.', directory, 'Inspect interrupted maintenance before the next mutation.'));
        }
        catch (error) {
            if (codeOf(error) !== 'ENOENT') {
                const e = ioError(error, directory);
                checks.push({ target: directory, status: 'error', code: e.code, message: e.message, nextAction: e.nextAction });
            }
        }
        for (const file of [this.lockPath(id), `${this.lockPath(id)}.claim`]) {
            try {
                const record = await this.lockRecord(file);
                if (record) {
                    const advice = await this.lockAdvice(record, m.start, 1, file.endsWith('.claim'));
                    checks.push({ target: file, status: 'warning', code: 'W_LOCK_PRESENT',
                        message: JSON.stringify(advice.details), nextAction: advice.nextAction });
                }
            }
            catch (error) {
                const e = ioError(error, file);
                checks.push({ target: file, status: 'error', code: e.code, message: e.message, nextAction: e.nextAction });
            }
        }
        const outputDirs: string[] = [];
        try { const board = await this.readBoard(id); await this.allowed(board.cwd); outputDirs.push(board.cwd); }
        catch { /* Other checks report unreadable or protected workspace paths. */ }
        for (const dir of [path.join(this.dataDir, 'boards'), directory, ...outputDirs]) {
            try {
                for (const name of await fs.readdir(dir))
                    if (name.startsWith('.tmp-') || name.startsWith('.PROCESS.md.tmp-') || name.startsWith(`${id}.lock.stale-`) || name.startsWith(`${id}.lock.claim.stale-`))
                        checks.push({ target: path.join(dir,
                             name),
                             status: 'warning',
                             code: 'W_RESIDUAL_FILE',
                             message: 'An interrupted operation left a file.',
                             nextAction: 'Inspect the file while writers are stopped.' });
            }
            catch (error) {
                if (codeOf(error) !== 'ENOENT')
                    throw ioError(error, dir);
            }
        }
        return this.outcome(m, { checks });
    }
    async readWorkspaceMap(file: string, cwd: string): Promise<{
        workspaceId: string;
        workspaceStatus: Board['workspaceStatus'];
    }> {
        const fd = await fs.open(file, constants.O_RDONLY | O_NOFOLLOW);
        let raw: unknown;
        try {
            const info = await fd.stat();
            if (!info.isFile() || info.size > 1048576)
                fail('E_LIMIT', 'Workspace map must be a regular file of at most 1 MiB.');
            raw = this.decode(await fd.readFile(), file);
        }
        finally {
            await fd.close();
        }
        if (!Array.isArray(raw))
            fail('E_VALIDATION', 'Expected a workspace array.', file);
        const target = await canonicalPath(cwd);
        const matches: {
            workspaceId: string;
            workspaceStatus: Board['workspaceStatus'];
        }[] = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object' || typeof item.cwd !== 'string' || typeof item.workspaceId !== 'string' || !isWorkspaceId(item.workspaceId))
                fail('E_VALIDATION', 'Invalid workspace map entry.', file);
            if (await canonicalPath(item.cwd) === target)
                matches.push({ workspaceId: item.workspaceId, workspaceStatus: item.archivedAt ? 'inactive' : 'active' });
        }
        if (matches.length !== 1)
            fail('E_WORKSPACE_AMBIGUOUS', 'Expected exactly one workspace for this directory.', target, 'Specify the workspaceId explicitly.', matches);
        return matches[0]!;
    }
    async resolveCardPrefix(id: string, prefix: string): Promise<string> {
        const board = await this.readBoard(id);
        const exact = board.cards.find(c => c.id === prefix);
        if (exact)
            return exact.id;
        if (!/^card_[0-9a-f]{8}[0-9a-f-]*$/.test(prefix))
            fail('E_VALIDATION', 'Use at least eight hexadecimal characters after card_.');
        const matches = board.cards.filter(c => c.id.startsWith(prefix));
        if (!matches.length)
            fail('E_NOT_FOUND', 'Card not found.', prefix);
        if (matches.length > 1)
            fail('E_CARD_AMBIGUOUS', 'Card prefix is ambiguous.', prefix, 'Use a complete card id.', matches.map(c => c.id));
        return matches[0]!.id;
    }
    async locale(): Promise<Locale> { return (await this.readConfig()).locale; }
}
