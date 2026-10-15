import { useEffect, useRef, useState } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { boardMutate, cardGet, editablePatch, type CardSnapshot, type MutationRequest } from '../shared/rpc.js';
import { editableKeys, newRequestId, reclaimSeconds, type EditorState, type Fields } from './editor-state.js';
import { laterRevision } from './move-model.js';
import { mutationAllowed } from './demo.js';
import { usePreview } from './preview-context.js';
import type { Copy } from './i18n.js';

/**
 * REQ-88 ⑤ (research/129 ⑤A): the detail saves each field on its own — a text field when it is left or submitted, a choice
 * the moment it is pressed — instead of one "Save changes" at the bottom. Each save is one `update` of that field alone, so
 * a person editing several fields in a row sends several small writes; they go one after another (`chain`), each against the
 * latest revision this screen knows (the previous save's reply, a move's read, a card read — whichever is later).
 * A write refused because the board moved on (another field saved elsewhere, an agent's move) is read again: if nobody
 * touched *this* field meanwhile it is sent once more at once; if the latest already holds the same words it counts as
 * saved; only when this very field changed elsewhere does the field ask — "Show latest" or "Keep mine". A failed save
 * leaves the typed value where it is, with "Try again"; a lost reply offers the very same request again (the ledger's
 * receipts make that safe).
 */
export type FieldKey = typeof editableKeys[number];
type Value = Fields[FieldKey];
export type FieldStatus = { state: 'saving' } | { state: 'saved' } | { state: 'invalid'; message?: string }
  | { state: 'failed'; message: string; wait?: number | null }
  | { state: 'unknown'; request: MutationRequest; value: Value; from: Value }
  | { state: 'conflict'; latest: Value };
/** How long "Saved" stays under a field after its save. */
export const FIELD_SAVED_MS = 3000;

/** The one write a field's save sends: that field alone. */
export function fieldRequest(boardId: string, cardId: string, revision: string, key: FieldKey, value: Value): MutationRequest {
  return { boardId, ifRevision: revision, requestId: newRequestId(), operations: [{ op: 'update', id: cardId, patch: { [key]: value } }] };
}
/**
 * After a refusal for a changed board: `same` — the latest already has what was typed; `retry` — the field is still what it
 * was when the save started (somebody changed something else); `conflict` — the field itself was changed elsewhere.
 */
export function fieldConflict(from: Value, latest: Value, mine: Value): 'same' | 'retry' | 'conflict' {
  return latest === mine ? 'same' : latest === from ? 'retry' : 'conflict';
}
/** Whether a field's value would be accepted (length, a title that is not empty). */
export function fieldValid(key: FieldKey, value: Value): boolean {
  return editablePatch.safeParse({ [key]: value }).success;
}
/** The fields whose typed value differs from what was last read. */
export function dirtyFields(state: EditorState): FieldKey[] {
  return state.base ? editableKeys.filter(key => state.draft[key] !== state.base!.card[key]) : [];
}

export function useFieldSaves({ boardId, cardId, editor, onSnapshot, onChanged, m }: {
  boardId: string; cardId: string; editor: EditorState; m: Copy;
  /** A card read after a save or a refusal: the editor takes it in and keeps what is typed elsewhere (`rebase`). */
  onSnapshot: (snapshot: CardSnapshot) => void;
  onChanged?: (() => void) | undefined;
}) {
  const mutate = useRpc(boardMutate), get = useRpc(cardGet), preview = usePreview();
  const [status, setStatus] = useState<Partial<Record<FieldKey, FieldStatus>>>({});
  const [lastSaved, setLastSaved] = useState<Date | null>(null), [warning, setWarning] = useState(false);
  const current = useRef(editor); current.current = editor;
  const revision = useRef<string | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const inflight = useRef(new Map<FieldKey, { value: Value; done: Promise<boolean> }>());
  const timers = useRef(new Map<FieldKey, ReturnType<typeof setTimeout>>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; const own = timers.current;
    return () => { alive.current = false; for (const timer of own.values()) clearTimeout(timer); }; }, []);
  const observe = (value: string | undefined) => {
    if (value && (!revision.current || laterRevision(value, revision.current))) revision.current = value;
  };
  observe(editor.base?.revision);
  const put = (key: FieldKey, next: FieldStatus | undefined) => {
    if (!alive.current) return;
    const timer = timers.current.get(key);
    if (timer) { clearTimeout(timer); timers.current.delete(key); }
    setStatus(value => { const copy = { ...value }; if (next) copy[key] = next; else delete copy[key]; return copy; });
    if (next?.state === 'saved') timers.current.set(key, setTimeout(() => {
      timers.current.delete(key);
      if (alive.current) setStatus(value => { if (value[key]?.state !== 'saved') return value; const copy = { ...value }; delete copy[key]; return copy; });
    }, FIELD_SAVED_MS));
  };
  const read = async () => {
    try {
      const reply = await get({ boardId, cardId });
      if (!alive.current || !reply.ok) return null;
      observe(reply.data.revision); onSnapshot(reply.data); return reply.data;
    } catch { return null; }
  };
  /** One write and what follows it. `retried`: a refusal already sent it once more. */
  const send = async (key: FieldKey, value: Value, from: Value, request?: MutationRequest, retried = false): Promise<boolean> => {
    if (!mutationAllowed(preview, boardId)) { put(key, { state: 'failed', message: m.demoReadOnly }); return false; }
    const sent = request ?? fieldRequest(boardId, cardId, revision.current ?? current.current.base?.revision ?? '', key, value);
    let reply;
    try { reply = await mutate(sent); }
    catch { put(key, { state: 'unknown', request: sent, value, from }); return false; }
    if (reply.ok) {
      observe(reply.data.revision);
      if (!alive.current) return true;
      setLastSaved(new Date());
      setWarning(reply.data.export === 'failed' || reply.warnings.some(w => w.code.startsWith('W_EXPORT')));
      put(key, { state: 'saved' });
      onChanged?.();
      await read();
      return true;
    }
    if (reply.committed === 'unknown') { put(key, { state: 'unknown', request: sent, value, from }); return false; }
    if (reply.error.code === 'E_REVISION_CONFLICT') {
      const latest = await read();
      if (!latest) { put(key, { state: 'failed', message: reply.error.message }); return false; }
      const verdict = fieldConflict(from, latest.card[key], value);
      if (verdict === 'same') { put(key, { state: 'saved' }); return true; }
      if (verdict === 'retry' && !retried) return send(key, value, from, undefined, true);
      put(key, verdict === 'retry' ? { state: 'failed', message: reply.error.message } : { state: 'conflict', latest: latest.card[key] });
      return false;
    }
    put(key, { state: 'failed', message: `${reply.error.code}: ${reply.error.message}`, wait: reclaimSeconds(reply.error.details, Date.now()) });
    return false;
  };
  const queue = (key: FieldKey, value: Value, run: () => Promise<boolean>) => {
    put(key, { state: 'saving' });
    const done: Promise<boolean> = chain.current.then(run).catch(() => false)
      .finally(() => { if (inflight.current.get(key)?.done === done) inflight.current.delete(key); });
    inflight.current.set(key, { value, done });
    chain.current = done;
    return done;
  };
  /** Save one field as it is typed now. Nothing is sent when it equals what was read, or when that value is on its way. */
  const commit = (key: FieldKey, typed?: { value: Value }): Promise<boolean> => {
    const state = current.current;
    if (!state.base) return Promise.resolve(true);
    // A choice saves in the same press that picks it, before the editor has drawn it: its value comes along.
    const value = typed ? typed.value : state.draft[key], from = state.base.card[key];
    const going = inflight.current.get(key);
    if (going && going.value === value) return going.done;
    if (value === from && !going) { const was = status[key]?.state;
      if (was && was !== 'saving' && was !== 'saved') put(key, undefined); return Promise.resolve(true); }
    if (!fieldValid(key, value)) { put(key, { state: 'invalid', ...(key === 'title' ? { message: m.titleRequired } : {}) }); return Promise.resolve(false); }
    return queue(key, value, () => send(key, value, from));
  };
  /** "Try again": a lost reply sends the same request (its receipt answers if it landed); anything else saves anew. */
  const retry = (key: FieldKey) => {
    const now = status[key];
    if (now?.state === 'unknown') return queue(key, now.value, () => send(key, now.value, now.from, now.request));
    return commit(key);
  };
  /** Every field still typed and not saved, saved now (before the window closes); true when none is left. */
  const flush = async () => {
    const results = await Promise.all([...new Set([...dirtyFields(current.current), ...inflight.current.keys()])].map(key => commit(key)));
    await chain.current;
    return results.every(Boolean);
  };
  return { status, commit, retry, flush, lastSaved, warning, clear: (key: FieldKey) => put(key, undefined),
    busy: () => inflight.current.size > 0, observe };
}
