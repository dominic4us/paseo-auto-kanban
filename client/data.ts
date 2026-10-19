import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePaseo } from '@getpaseo/plugin/client';
import { projectViewKeys } from './project-icon.js';
import { addProjectRoots, cwdKey, nameProjectRoots } from './presentation.js';
import { copy } from './i18n.js';
import { scheduleRetry, withTimeout as timed } from './directory-retry.js';
import type { Locale } from '../shared/core/domain.js';
import type { Directory, WorkspaceName } from './presentation.js';

interface ReadReply<T> { ok: true; data: T }
interface FailedReply { ok: false; error: { code: string; message: string; nextAction: string } }
/** Last good data survives failures; a route/host change discards it and all late replies. */
export function useRead<T>(key: string, read: () => Promise<ReadReply<T> | FailedReply>, enabled = true,
  /** REQ-78: what a key shows before its first reply (the directory's last listing in this app session). */
  initial: (key: string) => T | null = () => null,
  onAcceptedRead?: (data: T, token: object) => void) {
  const accepted = useRef(onAcceptedRead); accepted.current = onAcceptedRead;
  const reader = useRef(read); reader.current = read;
  const start = useRef(initial); start.current = initial;
  const epoch = useRef(0);
  const [state, setState] = useState<{ key: string; data: T | null; error: string; loading: boolean; readToken: object | null }>(() => ({
    key, data: initial(key), error: '', loading: false, readToken: null,
  }));
  const refresh = useCallback(async () => {
    if (!enabled) return;
    const current = ++epoch.current;
    setState(previous => ({ key, data: previous.key === key ? previous.data : start.current(key), error: '', loading: true,
      readToken: previous.key === key ? previous.readToken : null }));
    try {
      const reply = await reader.current();
      if (current !== epoch.current) return;
      if (!reply.ok) throw new Error(`${reply.error.code}: ${reply.error.message} ${reply.error.nextAction}`);
      const readToken = {}; accepted.current?.(reply.data, readToken);
      setState({ key, data: reply.data, error: '', loading: false, readToken });
    } catch (error) {
      if (current === epoch.current) setState(previous => ({ ...previous,
        error: error instanceof Error ? error.message : String(error), loading: false }));
    }
  }, [key, enabled]);
  /**
   * REQ-62: the auto refresh's read. No loading state and no error banner — the screen keeps what it
   * shows until the new data arrives, and a failed look leaves it as it was.
   */
  const revalidate = useCallback(async (): Promise<boolean> => {
    if (!enabled) return false;
    const current = ++epoch.current;
    const settle = () => setState(previous => previous.loading ? { ...previous, loading: false } : previous);
    try {
      const reply = await reader.current();
      if (current !== epoch.current) return false;
      if (!reply.ok) { settle(); return false; }
      const readToken = {}; accepted.current?.(reply.data, readToken);
      setState({ key, data: reply.data, error: '', loading: false, readToken });
      return true;
    } catch { if (current === epoch.current) settle(); return false; }
  }, [key, enabled]);
  useEffect(() => { void refresh(); return () => { epoch.current++; }; }, [refresh]);
  return { ...(state.key === key ? state : { key, data: start.current(key), error: '', loading: true, readToken: null }), refresh, revalidate };
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
/** A listing, and why the project names are missing from it when only they failed (the workspaces still place every board). */
interface DirectoryRead { directory: Directory; warning: string }
/**
 * REQ-78: the last listing per host in this app session, so reopening the board or switching to the list places
 * the workspaces at once while a fresh listing is read. Memory only; nothing is written anywhere.
 */
const directoryCache = new Map<string, DirectoryRead>();
const cached = (hostId: string) => directoryCache.get(hostId) ?? null;
/**
 * Observation b (REQ-77+78 gate): one listing per host at a time. Screens that ask together — the board and the list
 * it was switched to before its listing answered, or the Kanban surface mounted twice when Paseo restores the route
 * after a reload — share the listing on its way; so do retries. A listing that has already answered is never reused
 * for a screen that opens (it may predate a workspace that screen's boards name), and a manual refresh asks again at once.
 */
const inFlight = new Map<string, Promise<DirectoryRead>>();
function sharedListing(hostId: string, again: boolean, list: () => Promise<DirectoryRead>): Promise<DirectoryRead> {
  const running = inFlight.get(hostId);
  if (running && !again) return running;
  const next: Promise<DirectoryRead> = list().then(data => { directoryCache.set(hostId, data); return data; })
    .finally(() => { if (inFlight.get(hostId) === next) inFlight.delete(hostId); });
  inFlight.set(hostId, next);
  return next;
}
/**
 * The workspace directory. REQ-78: `ready` once any listing is known (this screen's, or this session's last one),
 * `settled` once this screen's own listing has answered. Until then a board the listing does not name is not yet
 * "not found in Paseo" — it may be a workspace made since — so the screens hold it back (`placedBoards`). A failed
 * or timed-out listing keeps what was known, says so in `error`, and is read again after a pause that doubles.
 */
export function useDirectory(hostId: string, enabled = true, locale: Locale = 'en') {
  const paseo = usePaseo();
  // Observation b: a manual refresh asks again even while a listing is on its way; opening and retries share it.
  const again = useRef(false);
  const read = useRead<DirectoryRead>(hostId, async () => {
    const manual = again.current; again.current = false;
    return { ok: true, data: await sharedListing(hostId, manual, list) };
  }, enabled, cached);
  const list = async (): Promise<DirectoryRead> => {
    const directory: Directory = {};
    // REQ-78 ⑤: the project names and the first page of workspaces do not depend on each other, so both are asked
    // at once; only joining them waits for both. A failed project listing costs names and root rows, not the board.
    const projectsRead = timed(paseo.projects.list(), 'projects.list').then(value => ({ value, warning: '' }),
      (error: unknown) => ({ value: null, warning: 'projects.list: ' + message(error) }));
    const page = (cursor?: string) => timed(paseo.workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } }), 'workspaces.list');
    const [projectsReply, firstPage] = await Promise.all([projectsRead, page()]);
    const projects = projectsReply.value;
    const names = new Map(projects?.projects.map(p => [p.projectId, p.projectCustomName || p.projectDisplayName]));
    const viewKeys = projectViewKeys(hostId, projects?.projects ?? []);
    const seen = new Set<string>();
    for (let response = firstPage; ;) {
      for (const w of response.entries) {
        const raw = w as unknown as { workspaceDirectory?: unknown; projectRootPath?: unknown; gitRuntime?: { currentBranch?: unknown } | null };
        const cwd = typeof raw.workspaceDirectory === 'string' && raw.workspaceDirectory ? raw.workspaceDirectory
          : typeof raw.projectRootPath === 'string' ? raw.projectRootPath : '';
        // REQ-65 ⑥: the branch rides on the same listing — no extra request.
        const branch = typeof raw.gitRuntime?.currentBranch === 'string' ? raw.gitRuntime.currentBranch : '';
        const entry: WorkspaceName = { id: w.id, name: w.title || w.name, ...(branch ? { branch } : {}),
          labels: w.labels ?? [], projectId: w.projectId,
          projectViewKey: viewKeys.get(w.projectId) ?? JSON.stringify([hostId, w.projectId]),
          projectName: names.get(w.projectId) || w.projectCustomName || w.projectDisplayName,
          ...(cwd ? { cwd } : {}) };
        directory[w.id] = entry;
        // D22: the second key lets a board whose `local_` id Paseo never knew find its workspace by directory.
        if (cwd) directory[cwdKey(cwd)] = entry;
      }
      const cursor = response.pageInfo.nextCursor ?? undefined;
      if (!cursor) break;
      if (seen.has(cursor)) throw new Error('Workspace pagination did not advance.');
      seen.add(cursor);
      response = await page(cursor);
    }
    // D25: the listing that named the projects also has their root folders — no extra request.
    addProjectRoots(directory, (projects?.projects ?? []).map(p => ({ projectId: p.projectId,
      rootPath: typeof p.projectRootPath === 'string' ? p.projectRootPath : '',
      projectName: names.get(p.projectId) || p.projectDisplayName,
      projectViewKey: viewKeys.get(p.projectId) ?? JSON.stringify([hostId, p.projectId]) })));
    return { directory, warning: projectsReply.warning };
  };
  // What this host's listing was when the screen opened: anything else in `read.data` is this screen's own answer.
  const seed = useMemo(() => cached(hostId), [hostId]);
  const error = read.error || read.data?.warning || '';
  // REQ-78 ③: a failed listing is read again on its own — 2 s, 4 s, 8 s … up to a minute — quietly, so the notice
  // stays until a listing succeeds and then goes. A manual refresh reads at once and starts the pauses over.
  const attempt = useRef(0), [retries, setRetries] = useState(0), { revalidate } = read;
  useEffect(() => {
    if (!error) { attempt.current = 0; return undefined; }
    if (!enabled) return undefined;
    let alive = true;
    const cancel = scheduleRetry(() => { attempt.current++; void revalidate().then(() => { if (alive) setRetries(n => n + 1); }); }, attempt.current);
    return () => { alive = false; cancel(); };
  }, [error, enabled, retries, revalidate]);
  const directory = useMemo(() => nameProjectRoots(read.data?.directory ?? {}, copy(locale).projectRoot), [read.data, locale]);
  return { directory, error, ready: !!read.data, settled: !!read.data && read.data !== seed,
    refresh: () => { attempt.current = 0; again.current = true; return read.refresh(); } };
}
