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
function measure(): Measurement { return { start: performance.now(),
     io: { ...emptyReads(),
     lockHeldMs: 0,
     lockWaitMs: 0,
     boardWrites: 0,
     backupLinks: 0,
     backupWrites: 0,
     exportWrites: 0,
     fsyncCalls: 0,
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
    constructor(public readonly dataDir: string, public readonly forbiddenRoots: readonly string[], public readonly context: DomainContext, options: StoreOptions) {
        this.link = options.fileSystem?.link ?? fs.link;
        this.afterCommit = options.afterCommit;
        this.paseoHome = (options.environment ?? process.env).PASEO_HOME
            ?? path.join(options.homeDir ?? os.homedir(), '.paseo');
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
    private async syncDirectory(dir: string, m: Measurement): Promise<void> {
        const fd = await fs.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
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
        const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
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
            await fs.rename(temporary, file);
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
             createdAt: new Date().toISOString() };
    }
    private async lockRecord(file: string): Promise<LockRecord | null> {
        try {
            await this.safeParents(file);
            const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
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
        const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
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
        const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
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
            if (input.ifRevision !== undefined) {
                const candidate = await prepare(await this.readBoard(id));
                if (!candidate.next) {
                    m.warnings.push(...candidate.warnings, ...await this.boardWarnings(id));
                    return this.outcome(m, candidate.data);
                }
            }
            const data = await this.exclusive(id, m, async () => {
                const current = await this.readBoard(id);
                const candidate = await prepare(current);
                m.warnings.push(...candidate.warnings);
                if (!candidate.next) {
                    this.scales(current, Buffer.byteLength(stableStringify(current, 2) + '\n'), m, await this.boardCount());
                    return candidate.data;
                }
                validateBoard(candidate.next);
                const bytes = this.serializeBoard(candidate.next);
                this.scales(candidate.next, bytes.length, m, await this.boardCount());
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
        const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
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
