import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { usePaseo } from '@getpaseo/plugin/client';
import { retryPause } from './directory-retry.js';
import { present } from './auto-refresh.js';
import { busyByName, isAgentId } from './busy-view.js';
import type { AgentLinks } from './card-groups.js';
import { leadStatus, statusKey, type LeadStatus, type LeadStatusInput, type StatusCard } from './lead-status.js';
import { boardAgentIds, isOrphanedCard, countOrphanedCards, countsKey, countUrgentSignals, hostSince, signalBucket, summarizeSignals, summaryKey,
  type AgentModelInfo, type SignalBucket, type SignalCounts, type SignalSummary } from './signal-model.js';

type PaseoApi = ReturnType<typeof usePaseo>;
type AgentUpdate = Parameters<Parameters<PaseoApi['agents']['subscribe']>[0]>[0];
/**
 * Paseo 0.9 assigns the directory subscription id itself and rejects a client-chosen one
 * ("Subscription IDs are assigned by the host"), so the plugin only asks to subscribe. 0.8 accepts the
 * same empty request and answers with its own id, so one spelling works on both.
 */
type DirectorySubscription = { release(): Promise<void> };
/** Joins agent ids into one effect dependency; ids never contain a newline. */
const ID_SEPARATOR = '\n';
/** REQ-41: at most this many one-shot lookups run at once, and each id is looked up once per session. */
export const LOOKUP_LIMIT = 3;
/**
 * D41: a lead card on screen re-reads its own agent this often (`recheck`), and an agent is re-read at most once in
 * `RECHECK_GAP_MS` however many cards ask (a second before the minute, so a card's own ticks are never skipped).
 */
export const LEAD_RECHECK_MS = 60_000, RECHECK_GAP_MS = LEAD_RECHECK_MS - 1000;
/** D41: how far a re-read's last activity may run ahead of the store's before it is logged as drift. */
const DRIFT_SLACK_MS = 60_000;
/** Demo ids are client-only fiction; never ask the daemon about them. */
const DEMO_PREFIX = 'demo_';

/** A read model of agent signals. Components subscribe once and re-render only on their own change. */
export interface SignalSource {
  read(agentId: string): SignalBucket;
  subscribe(listener: () => void): () => void;
  ready(): boolean;
  /**
   * Asks for ids the directory never reported; resolving one is optional and always one-shot. D35: `first` puts them
   * (and any of them still waiting in the queue) ahead of the others — a lead's archive state decides its place and look.
   */
  request?(agentIds: readonly string[], first?: boolean): void;
  /** REQ-51: true only once the store has positive evidence (a live event or lookup) that this agent is archived. */
  archived?(agentId: string): boolean;
  /** REQ-53/73: the last known provider/model/thinking option, title and profile label, if the store has seen one. */
  model?(agentId: string): AgentModelInfo | undefined;
  /**
   * REQ-78 ④: true while this agent may still be named — the first listing is on its way, or the agent is waiting for
   * (or in) its one-shot lookup. False once it is named, once the lookup answered without a name, or when neither can run.
   */
  pending?(agentId: string): boolean;
  /**
   * REQ-83: why the agents could not be read (the listing or its subscription failed, or answered in another shape),
   * or '' while they can. The screens say so: the cards' state marks may have stopped following the agents.
   */
  problem?(): string;
  /** REQ-104: when this agent was last active (the host's `lastActivityAt`, else `updatedAt`), if the store has seen it. */
  activity?(agentId: string): string | undefined;
  /**
   * REQ-130: when the agent's state changed to the one it reads now (ISO). REQ-133 (research/264 J1): the host's own time
   * first (`hostSince`: a running turn's start, an attention's time), so an agent already at work when the screen opened
   * has one; else only a change this store saw itself — none on its first sight.
   */
  since?(agentId: string): string | undefined;
  /**
   * D41: reads these agents again, ahead of every other lookup (D35's front of the queue), even when the listing named them
   * — a lead's own state, in case the live events stopped reaching it. At most once per `RECHECK_GAP_MS` an agent.
   */
  recheck?(agentIds: readonly string[]): void;
  /**
   * REQ-142 (gate 340 F1): the Paseo workspace the agent belongs to (the host's `workspaceId`), if the store has seen it —
   * where opening it goes, which may not be the workspace of the board its card is on.
   */
  workspace?(agentId: string): string | undefined;
}
export const emptySignalSource: SignalSource = { read: () => 'unknown', subscribe: () => () => {}, ready: () => false };
/** Demo data and tests: a fixed map that never receives real events. */
export function staticSignalSource(map: Record<string, SignalBucket>, archivedIds: readonly string[] = [], models: Record<string, AgentModelInfo> = {},
  active: Record<string, string> = {}, since: Record<string, string> = {}): SignalSource {
  const archived = new Set(archivedIds);
  return { read: id => map[id] ?? 'unknown', subscribe: () => () => {}, ready: () => true, archived: id => archived.has(id), model: id => models[id],
    activity: id => active[id], since: id => since[id] };
}

function createStore() {
  const buckets = new Map<string, SignalBucket>();
  /*
   * REQ-41: an agent the directory no longer lists is usually archived, which reads as finished, not as
   * "status unavailable". `resolved` keeps the answer of the one-shot lookup for the session; a live
   * event always wins over it, and a failed or missing lookup stays 'unknown' without being retried.
   */
  const resolved = new Map<string, SignalBucket>();
  const asked = new Set<string>();
  const queue: string[] = [];
  /** REQ-51/53: side information the same events and lookups already carry, kept alongside the bucket. */
  const archivedIds = new Set<string>();
  const models = new Map<string, AgentModelInfo>();
  /** REQ-142: each agent's own workspace, from the same listing, events and lookups. */
  const homes = new Map<string, string>();
  const noteHome = (agent: { id: string }) => {
    const workspaceId = (agent as { workspaceId?: unknown }).workspaceId;
    if (typeof workspaceId === 'string' && workspaceId) homes.set(agent.id, workspaceId);
  };
  /**
   * REQ-104: each agent's last activity. Kept beside the bucket but never a change on its own: it moves on every
   * event of a running agent, and what reads it (an idle lead's status row) is re-read when the bucket changes.
   */
  const active = new Map<string, string>();
  /** REQ-130: when each agent's bucket last changed while this store watched it (never on its first sight). */
  const changedAt = new Map<string, string>();
  const noteChange = (id: string, previous: SignalBucket | undefined, next: SignalBucket | undefined) => {
    if (next === undefined) changedAt.delete(id);
    else if (previous !== undefined && previous !== next) changedAt.set(id, new Date(Date.now()).toISOString());
  };
  /**
   * REQ-133: the host's own time for the state each agent was last read in, kept with that state (`hostSince`). Returns
   * whether it moved — a new turn of an agent still at work is no change of its bucket, yet its time starts again.
   */
  const hostAt = new Map<string, { bucket: SignalBucket; at: string }>();
  const noteHost = (id: string, agent: Parameters<typeof hostSince>[0], bucket: SignalBucket | undefined): boolean => {
    const at = bucket === undefined ? undefined : hostSince(agent, bucket, Date.now()), before = hostAt.get(id)?.at;
    if (at) hostAt.set(id, { bucket: bucket!, at }); else hostAt.delete(id);
    return at !== before;
  };
  const sinceOf = (id: string) => { const host = hostAt.get(id); return host && host.bucket === read(id) ? host.at : changedAt.get(id); };
  const activityOf = (agent: { lastActivityAt?: string | null; updatedAt?: string | null }) => agent.lastActivityAt || agent.updatedAt || undefined;
  const noteActive = (agent: { id: string; lastActivityAt?: string | null; updatedAt?: string | null }) => {
    const at = activityOf(agent);
    if (at) active.set(agent.id, at);
  };
  /**
   * REQ-126: each provider's model display names by model id (and alias), read once a session from its model list
   * (`providers.listModels`, the list Paseo's model picker shows). A host without it, or a list that fails, leaves the
   * name to be read from the id (`modelShortName`); it is not asked again.
   */
  const modelNames = new Map<string, ReadonlyMap<string, string>>(), namesAsked = new Set<string>();
  const labelOf = (provider: string | null | undefined, model: string | null | undefined) =>
    provider && model ? modelNames.get(provider)?.get(model) ?? null : null;
  const askNames = (provider: string | null | undefined) => {
    const providers = api?.providers;
    if (!provider || namesAsked.has(provider) || typeof providers?.listModels !== 'function') return;
    namesAsked.add(provider);
    void (async () => {
      try {
        const result = await providers.listModels(provider as Parameters<typeof providers.listModels>[0]);
        const names = new Map<string, string>();
        for (const entry of result?.models ?? []) {
          const label = entry.label?.trim();
          if (!label) continue;
          for (const id of [entry.id, ...(entry.aliases ?? [])]) if (id && !names.has(id)) names.set(id, label);
        }
        if (!names.size) return;
        modelNames.set(provider, names);
        let changed = false;
        for (const [id, info] of models) {
          const label = info.provider === provider ? labelOf(provider, info.model) : null;
          if (label && label !== info.modelLabel) { models.set(id, { ...info, modelLabel: label }); changed = true; }
        }
        if (changed) notify();
      } catch { /* the id's own short name stands in */ }
    })();
  };
  const modelOf = (agent: AgentModelInfo & { labels?: Record<string, string> | undefined }): AgentModelInfo => {
    askNames(agent.provider);
    return { provider: agent.provider, model: agent.model, thinkingOptionId: agent.thinkingOptionId,
      modelLabel: labelOf(agent.provider, agent.model),
      title: agent.title ?? null, profile: agent.labels?.profile ?? null,
      role: agent.labels?.role ?? null, parentAgentId: agent.labels?.['paseo.parent-agent-id'] ?? null };
  };
  const listeners = new Set<() => void>();
  let loaded = false, users = 0, generation = '', bootstrapping = false, pass = 0, lookups = 0;
  /** REQ-78 ④: whether the first listing is still being read, has been read, or failed (then nothing will be looked up). */
  let phase: 'idle' | 'loading' | 'loaded' | 'failed' = 'idle';
  /** REQ-83: what the last failed listing said, and the pending re-read (2 s, 4 s … up to a minute, like REQ-78's). */
  let problem = '', stream = '', retries = 0, retry: ReturnType<typeof setTimeout> | null = null;
  const stopRetry = () => { if (retry !== null) clearTimeout(retry); retry = null; };
  /** An id queued but never looked up is asked again later, so it does not stay unnamed for the session. */
  /** REQ-78 ④: ids whose one-shot lookup has answered, named or not; a live event never takes that back. */
  const answered = new Set<string>();
  /**
   * D41: agents being read again (`recheck`), when each was last asked, those a live event reached meanwhile (it is newer
   * than the answer, which then only adds a later activity), and those asked before the listing was read.
   */
  const rechecks = new Set<string>(), recheckedAt = new Map<string, number>(), touched = new Set<string>(), early = new Set<string>();
  const dropQueue = () => { for (const id of queue) if (!rechecks.delete(id)) asked.delete(id); queue.length = 0; early.clear(); };
  let buffer: AgentUpdate[] = [];
  let detach: (() => void) | null = null;
  let api: PaseoApi | null = null;
  /**
   * 0.9 hands back a handle whose lifetime is the caller's: every re-list opens another daemon
   * subscription, so the one it replaces has to be released. 0.8 answers without a handle and reuses
   * its own id, and then this stays null.
   */
  let directory: DirectorySubscription | null = null;
  /** Keeps the subscription a snapshot opened, unless a newer pass already superseded that snapshot. */
  const hold = (next: DirectorySubscription | undefined, current: number) => {
    if (!next) return;
    if (current !== pass) { void next.release(); return; }
    const previous = directory; directory = next;
    if (previous) void previous.release();
  };
  const releaseDirectory = () => { const held = directory; directory = null; if (held) void held.release(); };
  const notify = () => { for (const listener of [...listeners]) listener(); };
  /** Returns whether anything changed: the daemon repeats identical snapshots often (measured). */
  const apply = (update: AgentUpdate): boolean => {
    const id = update.kind === 'upsert' ? update.agent.id : update.agentId;
    if (rechecks.has(id)) touched.add(id);
    const wasArchived = archivedIds.has(id);
    const previousModel = JSON.stringify(models.get(id));
    // REQ-130: a one-shot lookup's answer counts as what was seen before, so a live change after it has its time.
    const seen = buckets.get(id) ?? (resolved.get(id) === 'unknown' ? undefined : resolved.get(id));
    const hadResolved = resolved.delete(id);
    if (update.kind === 'upsert') {
      noteActive(update.agent);
      if (update.agent.archivedAt) archivedIds.add(id); else archivedIds.delete(id);
      models.set(id, modelOf(update.agent)); noteHome(update.agent);
    }
    const next = update.kind === 'upsert' ? (update.agent.archivedAt ? 'idle' : signalBucket(update.agent)) : undefined;
    const previous = buckets.get(id);
    const bucketChanged = next !== previous;
    noteChange(id, seen, next);
    const hostMoved = noteHost(id, update.kind === 'upsert' ? update.agent : null, next);
    if (next === undefined) buckets.delete(id); else buckets.set(id, next);
    return bucketChanged || hostMoved || hadResolved || wasArchived !== archivedIds.has(id) || previousModel !== JSON.stringify(models.get(id));
  };
  const read = (agentId: string): SignalBucket =>
    buckets.get(agentId) ?? (archivedIds.has(agentId) ? 'idle' : resolved.get(agentId)) ?? 'unknown';
  /**
   * D41: a re-read's answer. It stands in for the live event that may have been lost, unless one arrived meanwhile; its
   * activity counts only when later than the store's. What it changes is logged once, the evidence for D41's cause.
   */
  const settleRecheck = (id: string, agent: Extract<AgentUpdate, { kind: 'upsert' }>['agent'] | null | undefined) => {
    rechecks.delete(id);
    const wasTouched = touched.delete(id);
    if (!agent) return false;
    const before = read(id), beforeAt = active.get(id), at = activityOf(agent);
    const later = !!at && (!beforeAt || Date.parse(at) > Date.parse(beforeAt));
    let changed = false;
    if (!wasTouched) {
      changed = apply({ kind: 'upsert', agent });
      if (beforeAt && !later) active.set(id, beforeAt);
    } else if (later) active.set(id, at!);
    const after = read(id);
    if (before !== after || (later && (!beforeAt || Date.parse(at!) - Date.parse(beforeAt) > DRIFT_SLACK_MS)))
      console.debug(`[kanban] lead signal drift ${id} ${before}→${after} activity ${beforeAt ?? '-'}→${active.get(id) ?? '-'}`);
    return changed || later;
  };
  const drain = () => {
    while (lookups < LOOKUP_LIMIT && queue.length) {
      const id = queue.shift()!, paseo = api;
      if (!paseo) { if (!rechecks.delete(id)) asked.delete(id); dropQueue(); return; }
      lookups++;
      if (rechecks.has(id)) {
        void (async () => {
          let changed = false;
          try { changed = settleRecheck(id, (await paseo.agents.ref(id).refresh())?.agent); }
          catch { rechecks.delete(id); touched.delete(id); }
          lookups--;
          if (changed) notify();
          drain();
        })();
        continue;
      }
      void (async () => {
        let bucket: SignalBucket = 'unknown';
        try {
          const result = await paseo.agents.ref(id).refresh();
          // An archived agent is finished work, not an unknown one; anything else keeps its own bucket.
          if (result?.agent) {
            if (!active.has(id)) noteActive(result.agent);
            bucket = result.agent.archivedAt ? 'idle' : signalBucket(result.agent);
            if (!buckets.has(id)) noteHost(id, result.agent, bucket);
            if (!buckets.has(id)) {
              if (result.agent.archivedAt) archivedIds.add(id); else archivedIds.delete(id);
            }
            if (!buckets.has(id)) { models.set(id, modelOf(result.agent)); noteHome(result.agent); }
          }
        } catch {
          // A refused or unknown id stays 'Status unavailable'; it never raises a banner or retries.
        }
        lookups--;
        resolved.set(id, bucket); answered.add(id);
        notify();
        drain();
      })();
    }
  };
  const request = (agentIds: readonly string[], first = false) => {
    if (!loaded || !api) return;
    let queued = false;
    const front: string[] = [];
    for (const id of agentIds) {
      if (!id || id.startsWith(DEMO_PREFIX) || buckets.has(id)) continue;
      if (asked.has(id)) {
        const at = first ? queue.indexOf(id) : -1;
        if (at >= 0) { queue.splice(at, 1); front.push(id); }
        continue;
      }
      asked.add(id); queued = true;
      if (first) front.push(id); else queue.push(id);
    }
    if (front.length) { queue.unshift(...front); queued = true; }
    if (queued) drain();
  };
  const recheck = (agentIds: readonly string[]) => {
    const front: string[] = [], now = Date.now();
    for (const id of agentIds) {
      if (!id || id.startsWith(DEMO_PREFIX)) continue;
      if (!loaded || !api) { early.add(id); continue; }
      // Waiting for (or in) its first lookup, or already being read again: that read is as fresh.
      if (rechecks.has(id) || (asked.has(id) && !answered.has(id))) continue;
      if (now - (recheckedAt.get(id) ?? -Infinity) < RECHECK_GAP_MS) continue;
      rechecks.add(id); recheckedAt.set(id, now); front.push(id);
    }
    if (front.length) { queue.unshift(...front); drain(); }
  };
  const snapshot = async (paseo: PaseoApi) => {
    const current = ++pass; bootstrapping = true; buffer = [];
    if (!loaded) phase = 'loading';
    try {
      const next = new Map<string, SignalBucket>(), archivedNext = new Set<string>(), seen = new Set<string>();
      const hostNext = new Map<string, Parameters<typeof hostSince>[0]>();
      let cursor: string | undefined, first = true;
      do {
        const page = await paseo.agents.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) },
          ...(first ? { subscribe: {} } : {}) });
        if (first) hold(page.subscription, current);
        if (current !== pass) return;
        for (const entry of page.entries) {
          models.set(entry.agent.id, modelOf(entry.agent)); noteHome(entry.agent); noteActive(entry.agent);
          if (entry.agent.archivedAt) archivedNext.add(entry.agent.id);
          next.set(entry.agent.id, entry.agent.archivedAt ? 'idle' : signalBucket(entry.agent)); hostNext.set(entry.agent.id, entry.agent);
          if (!entry.agent.archivedAt) archivedIds.delete(entry.agent.id);
        }
        first = false;
        cursor = page.pageInfo.hasMore ? page.pageInfo.nextCursor ?? undefined : undefined;
        if (cursor && seen.has(cursor)) break;
        if (cursor) seen.add(cursor);
      } while (cursor);
      for (const [id, bucket] of next) { noteChange(id, buckets.get(id), bucket); noteHost(id, hostNext.get(id), bucket); }
      buckets.clear(); for (const [id, bucket] of next) buckets.set(id, bucket);
      // Archived agents are absent from snapshots; retain earlier positive lookup evidence.
      for (const id of archivedNext) archivedIds.add(id);
      loaded = true; phase = 'loaded'; problem = ''; retries = 0; stopRetry();
    } catch (error) {
      // A failed subscription reads as 'unknown' everywhere. REQ-83: the screens say so, and it is read again on its own.
      if (current === pass) { buckets.clear(); loaded = false; phase = 'failed'; problem = failure(error); scheduleRetry(paseo); }
    } finally {
      if (current === pass) { bootstrapping = false; for (const update of buffer) apply(update); buffer = [];
        // D41: a lead card that showed before the listing is read again now, ahead of what the listing leaves unnamed.
        if (loaded && early.size) { const ids = [...early]; early.clear(); recheck(ids); }
        notify(); }
    }
  };
  const scheduleRetry = (paseo: PaseoApi) => {
    stopRetry();
    if (!users) return;
    retry = setTimeout(() => { retry = null; if (users && api === paseo) { retries++; void snapshot(paseo); } }, retryPause(retries));
  };
  const receive = (paseo: PaseoApi, update: AgentUpdate) => {
    const stamp = (update as { generation?: string }).generation ?? '';
    // A new stream generation means the daemon restarted the directory: re-list instead of trusting
    // deltas. The installed daemon (0.8.x) omits `generation`, so the live recovery path is the
    // foreground re-list in `attach`; this stays for daemons that do send it.
    if (stamp && generation && stamp !== generation) { generation = stamp; void snapshot(paseo); return; }
    if (stamp) generation = stamp;
    if (bootstrapping) { buffer.push(update); return; }
    if (apply(update)) notify();
  };
  return {
    source: {
      read,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      ready: () => loaded,
      request,
      recheck,
      archived: (agentId: string) => archivedIds.has(agentId),
      model: (agentId: string) => models.get(agentId),
      workspace: (agentId: string) => homes.get(agentId),
      activity: (agentId: string) => active.get(agentId),
      since: sinceOf,
      pending: (agentId: string) => !!agentId && !agentId.startsWith(DEMO_PREFIX) && !models.has(agentId) && !answered.has(agentId) &&
        (phase === 'loading' || (phase === 'loaded' && api !== null)),
      problem: () => phase === 'failed' ? problem || 'agents.list' : stream,
    } as SignalSource,
    /** Borrows the host connection: the returned cleanup removes local listeners only, never closes it. */
    attach: (paseo: PaseoApi) => {
      users++; api = paseo;
      if (users === 1) {
        // REQ-83: a host without the event stream (or one that throws) leaves the listing to say what it can.
        let stopEvents: () => void = () => {};
        try {
          const stop: unknown = paseo.agents.subscribe(update => receive(paseo, update));
          if (typeof stop === 'function') stopEvents = stop as () => void;
        } catch (error) { stream = 'agents.subscribe: ' + failure(error); }
        const app = AppState.addEventListener('change', state => { if (state === 'active') void snapshot(paseo); });
        detach = () => { stopEvents(); app.remove(); };
        void snapshot(paseo);
      }
      return () => {
        users = Math.max(0, users - 1);
        if (!users) { pass++; bootstrapping = false; buffer = []; dropQueue(); detach?.(); detach = null; api = null; stopRetry(); retries = 0; stream = '';
          if (phase === 'loading') phase = loaded ? 'loaded' : 'idle';
          releaseDirectory(); }
      };
    },
    /** Recovery path a reconnect uses, exposed for tests. */
    resync: (paseo: PaseoApi) => snapshot(paseo),
    /** Test seam: which ids this session already spent a one-shot lookup on. */
    lookedUp: () => [...asked],
  };
}
/** REQ-83: a failure's words, one line and short — the screens quote it after what could not be read. H2: a cut one ends in "…". */
export function failure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const chars = [...(text.replace(/\s+/g, ' ').trim() || 'agents.list')];
  return chars.length > 120 ? chars.slice(0, 119).join('') + '…' : chars.join('');
}
export type SignalStore = ReturnType<typeof createStore>;
const stores = new Map<string, SignalStore>();
export function signalStoreFor(hostId: string): SignalStore {
  let store = stores.get(hostId);
  if (!store) { store = createStore(); stores.set(hostId, store); }
  return store;
}
export function useLiveSignals(hostId: string, enabled: boolean): SignalSource {
  const paseo = usePaseo();
  const store = useMemo(() => signalStoreFor(hostId), [hostId]);
  useEffect(() => { if (!enabled) return undefined; return store.attach(paseo); }, [store, paseo, enabled]);
  return enabled ? store.source : emptySignalSource;
}
/** Ids an effect can depend on without allocating a new array every render. */
function splitIds(idKey: string): string[] { return idKey ? idKey.split(ID_SEPARATOR) : []; }
/**
 * The re-render boundary: a card or lane header re-renders only when its own representative signal
 * changes, so one event never repaints the board.
 */
export function useSignalSummary(source: SignalSource, agentIds: readonly string[]): SignalSummary | null {
  const idKey = agentIds.join(ID_SEPARATOR);
  const summary = summarizeSignals(agentIds, source.read);
  // D35: the listing's arrival alone can change a lead's look (`leadArchivedAgent`), with no other of these moving.
  const held = leadArchivedAgent(source);
  const key = () => summaryKey(summarizeSignals(splitIds(idKey), source.read)) + '|' +
    splitIds(idKey).map(id => JSON.stringify([source.archived?.(id), source.model?.(id), source.pending?.(id), held(id)])).join('|');
  const seen = useRef(key()); seen.current = key();
  const [, bump] = useState(0);
  useEffect(() => source.subscribe(() => {
    const next = key();
    if (next !== seen.current) { seen.current = next; bump(value => value + 1); }
    source.request?.(splitIds(idKey));
  }), [source, idKey]);
  useEffect(() => { source.request?.(splitIds(idKey)); }, [source, idKey]);
  return summary;
}
/**
 * Research/174 J3: who turned a busy mark on (`busyByName`), kept live — an agent the store has not named yet is asked for
 * once and its title shows when it arrives. '' with no mark.
 */
export function useBusyBy(source: SignalSource, by: string | undefined): string {
  const agent = !!by && isAgentId(by);
  const read = () => by ? busyByName(by, agent ? source.model?.(by)?.title : null) : '';
  const subscribe = useMemo(() => agent ? (listener: () => void) => source.subscribe(listener) : noSubscribe, [source, agent]);
  const name = useSyncExternalStore(subscribe, read, read);
  useEffect(() => { if (agent) source.request?.([by]); }, [source, by, agent]);
  return name;
}
const noSubscribe = () => () => {};
/** REQ-83: the source's problem, kept live; '' while the agents can be read (and for the demo, which has none). */
export function useSignalProblem(source: SignalSource): string {
  const [value, setValue] = useState(() => source.problem?.() ?? '');
  useEffect(() => {
    setValue(source.problem?.() ?? '');
    return source.subscribe(() => setValue(source.problem?.() ?? ''));
  }, [source]);
  return value;
}
/** The same boundary for a folded lane's "error 1 · waiting 2" badge (REQ-44). */
export function useSignalCounts(source: SignalSource, agentIds: readonly string[]): SignalCounts {
  const idKey = agentIds.join(ID_SEPARATOR);
  const counts = countUrgentSignals(agentIds, source.read);
  const seen = useRef(countsKey(counts)); seen.current = countsKey(counts);
  const [, bump] = useState(0);
  useEffect(() => source.subscribe(() => {
    const next = countsKey(countUrgentSignals(splitIds(idKey), source.read));
    if (next !== seen.current) { seen.current = next; bump(value => value + 1); }
    source.request?.(splitIds(idKey));
  }), [source, idKey]);
  useEffect(() => { source.request?.(splitIds(idKey)); }, [source, idKey]);
  return counts;
}
/** REQ-51: how many not-done cards on a board (or overview) have every agent archived, kept live. */
export function useOrphanedCount(source: SignalSource,
  stages: readonly { countsAsDone: boolean; cards: readonly { agentIds: readonly string[] }[] }[]): number {
  const archived = (id: string) => source.archived?.(id) === true;
  const count = countOrphanedCards(stages, archived);
  const seen = useRef(count); seen.current = count;
  const [, bump] = useState(0);
  useEffect(() => source.subscribe(() => {
    const next = countOrphanedCards(stages, archived);
    if (next !== seen.current) { seen.current = next; bump(value => value + 1); }
  }), [source, stages]);
  return count;
}

/** Stable card identities drive attention filtering; equal-size swaps must still update. */
export function useOrphanedCards(source: SignalSource,
  boards: readonly { stages: readonly { countsAsDone: boolean; cards: readonly { id: string; agentIds: readonly string[] }[] }[] }[]): ReadonlySet<string> {
  const stages = useMemo(() => boards.flatMap(b => b.stages), [boards]);
  const getKey = () => stages.flatMap(s => s.cards.filter(c => isOrphanedCard(c.agentIds, s.countsAsDone,
    id => source.archived?.(id) === true)).map(c => c.id)).sort().join(ID_SEPARATOR);
  const key = getKey(), seen = useRef(key); seen.current = key;
  const [, bump] = useState(0);
  const ids = boardAgentIds(stages).join(ID_SEPARATOR);
  useEffect(() => source.subscribe(() => {
    const next = getKey();
    if (next !== seen.current) { seen.current = next; bump(v => v + 1); }
    source.request?.(splitIds(ids));
  }), [source, stages, ids]);
  useEffect(() => { source.request?.(splitIds(ids)); }, [source, ids]);
  return useMemo(() => new Set(splitIds(key)), [key]);
}
/**
 * D35: whether a lead card's agent counts as archived for REQ-98/100/102 (grey edge, filled crown, no pin in "완료").
 * Archived agents are absent from the listing, so each is known only after its one-shot lookup — on a phone with a few
 * hundred agents, seconds after the first frame, while the lead read as a live one and then jumped down.
 * Once the listing has been read, an agent it did not name whose lookup has not answered yet (`pending`) is held as
 * archived; a live agent is in the listing (or arrives by event) and is never held, so a live lead never drops and
 * jumps back. Before the listing (and when it failed) nothing is known, and a lead reads as before: live.
 */
export function leadArchivedAgent(source: SignalSource): (agentId: string) => boolean {
  return agentId => source.archived?.(agentId) === true || (source.ready() && source.pending?.(agentId) === true);
}
/**
 * REQ-102: whether a lead's agent is archived (`leadArchivedAgent`), live — for a lead's place in a completion column
 * (card-order.ts). Unlike `useOrphanedCards` (which only tracks cards outside a completion stage), a card in "done"
 * never changes its membership of any tracked set when its one agent is archived, so nothing here can be value-diffed
 * against a previous key; the function's own identity changes on every signal instead, which is enough to invalidate a
 * `useMemo` (or `useCallback`) keyed on it, however rarely an archive actually flips a completion column's order.
 * D35: the leads' agents (`leadAgentIds`, a completion column's first) are looked up ahead of every other agent, so the
 * hold above ends with the first lookups instead of wherever the board's sorted ids put them (the 142nd of 240, measured).
 */
export function useArchivedAgents(source: SignalSource, leadIds: readonly string[] = []): (agentId: string) => boolean {
  const [tick, bump] = useState(0);
  const idKey = leadIds.join(ID_SEPARATOR);
  useEffect(() => source.subscribe(() => { bump(value => value + 1); source.request?.(splitIds(idKey), true); }), [source, idKey]);
  useEffect(() => { source.request?.(splitIds(idKey), true); }, [source, idKey]);
  return useMemo(() => leadArchivedAgent(source), [source, tick]);
}
/**
 * REQ-117: the agents' `role` and parent labels for `linkStages` (`AgentLinks`), from the same listing and lookups as
 * their models. Like `useArchivedAgents`, its identity changes on every signal, which invalidates what is keyed on it.
 */
export function useAgentLinks(source: SignalSource): AgentLinks {
  const [tick, bump] = useState(0);
  useEffect(() => source.subscribe(() => bump(value => value + 1)), [source]);
  return useMemo<AgentLinks>(() => agentId => source.model?.(agentId), [source, tick]);
}
/**
 * REQ-104: a lead's status row (`lead-status.ts`), kept live — re-rendered when its sub-cards' agents start or stop, or
 * the lead's own agent starts or goes quiet. `crew` is null on any other card (nothing is read or subscribed then).
 */
export function useLeadStatus(source: SignalSource, crew: { members: readonly StatusCard[]; own: readonly StatusCard[] } | null | undefined,
  lead: { id?: string; agentIds: readonly string[]; updatedAt?: string | undefined; busy?: StatusCard['busy'] }, stages: LeadStatusInput['stages'],
  now: number): LeadStatus | null {
  const compute = (): LeadStatus | null => {
    const input = latest.current;
    if (!input.crew) return null;
    const activeAt = input.lead.agentIds.map(id => source.activity?.(id)).filter((at): at is string => !!at).sort().at(-1) ?? input.lead.updatedAt;
    return leadStatus({ members: input.crew.members, own: input.crew.own, stages: input.stages, read: source.read,
      ...(input.lead.id ? { lead: { id: input.lead.id, busy: input.lead.busy } } : {}), leadAgentIds: input.lead.agentIds, activeAt,
      since: id => source.since?.(id), activity: id => source.activity?.(id), now: input.now });
  };
  const latest = useRef({ crew, lead, stages, now }); latest.current = { crew, lead, stages, now };
  const status = compute();
  const seen = useRef(status ? statusKey(status) : ''); seen.current = status ? statusKey(status) : '';
  const [, bump] = useState(0);
  const idKey = crew ? crew.members.flatMap(card => card.agentIds).join(ID_SEPARATOR) : '';
  useEffect(() => crew ? source.subscribe(() => {
    const next = compute(), key = next ? statusKey(next) : '';
    if (key !== seen.current) { seen.current = key; bump(value => value + 1); }
  }) : undefined, [source, !!crew]);
  useEffect(() => { if (idKey) source.request?.(splitIds(idKey)); }, [source, idKey]);
  /*
   * D41: a lead read "idle" with its agent running, its last activity 15 hours old — the live events had stopped reaching
   * the store. While the card is on screen its own agent is read again: once when it shows (or its agents change), then
   * once a minute while someone is looking (`present`, auto refresh's 3-minute rule). Its own agent is its first
   * (`crewOf`'s rule), so a card costs one read a minute however many agents it has.
   */
  const ownKey = crew ? lead.agentIds.find(id => !!id) ?? '' : '';
  useEffect(() => {
    if (!ownKey || !source.recheck) return undefined;
    const ids = splitIds(ownKey);
    source.recheck(ids);
    const timer = setInterval(() => { if (present()) source.recheck?.(ids); }, LEAD_RECHECK_MS);
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }, [source, ownKey]);
  return status;
}
