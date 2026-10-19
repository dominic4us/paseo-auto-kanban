import type { PluginServerContext } from '@getpaseo/plugin/server';
import { openStore } from './server/core/store.js';
import { exportCommittedBoard } from './server/core/export.js';
import { createEnsureHandler, createMutationHandler } from './server/mutations.js';
import { createReadHandlers, readError, readLocale } from './server/handlers.js';
import { listWorkspaces } from './server/workspaces.js';
import { createAutoCards, type Signal } from './server/auto-cards.js';
import { createDispatcher } from './server/dispatch.js';
import { createAutoArchiver } from './server/auto-archive.js';
import { pruneAfterWrite } from './server/busy.js';
import { autoCardsLeadSet, autoCardsResume, autoCardsSet, autoCardsWorkspaceSet, boardEnsure, boardGet, busyClear, busySet, cardGet, dispatchPreview, overviewGet, revisionsGet, boardMutate, uiStateSet, workflowGet, workflowPickSet, workflowExport, mailListGet, mailThreadGet, archiveSettingsSet, archiveTidy, archivedList, archivedRestore } from './shared/rpc.js';

export default function contribute(server: PluginServerContext) {
  const store = openStore({ lockTimeoutMs: 5000, afterCommit: exportCommittedBoard });
  // REQ-61: agent lifecycle → cards. The hooks hand the signal over and return at once; the daemon
  // never waits on the ledger and no error can reach it (`signal` catches everything itself).
  const auto = createAutoCards({ store, locale: readLocale });
  // REQ-97: a draft moved to the working stage goes to the workspace's lead as a prompt, only while the lead is idle.
  const dispatch = createDispatcher({ store, locale: readLocale, fallbackFloor: () => auto.dispatchFloor() });
  // REQ-52: finished cards archived after the set days — swept when a screen reads the boards, at most every ten minutes.
  const archiver = store.then(value => createAutoArchiver(value));
  // REQ-83: every read says how automatic tracking is doing.
  // H5: a workspace listing that answered is Paseo answering again, so tracking's failed agent listing is retried at once.
  const workspaces: typeof listWorkspaces = async paseo => {
    const listing = await listWorkspaces(paseo);
    auto.answered(paseo as unknown as Parameters<typeof auto.answered>[0]);
    return listing;
  };
  // 281 F1: the board views carry who leads each workspace by the dispatcher's own judgement, so a screen never judges again.
  const handlers = store.then(value => createReadHandlers(value, undefined, undefined, workspaces, auto.health, undefined, undefined, undefined,
    (paseo, boards) => dispatch.leadsNow(paseo, boards)));
  const mutate = store.then(value => createMutationHandler(value));
  // REQ-57: initialization reuses the read handlers' workspace lookup, so Paseo is asked once per path.
  const ensure = Promise.all([store, handlers]).then(([value, read]) =>
    createEnsureHandler(value, read.activeWorkspace));
  // REQ-83: the payload is handed over as it came; `signal` checks the agent before anything is moved.
  const on = (name: Signal) => (payload: unknown, context: unknown) => {
    const agent = payload && typeof payload === 'object' ? (payload as { agent?: unknown }).agent : undefined;
    const paseo = context && typeof context === 'object' ? (context as { paseo?: unknown }).paseo : undefined;
    void auto.signal(agent, name, paseo as Parameters<typeof auto.signal>[2]);
    void dispatch.signal(agent, name, paseo);
  };
  const cleanups = [
    server.on('agent.created', on('created')),
    server.on('agent.turn_started', on('turn_started')),
    server.on('agent.turn_ended', on('turn_ended')),
    server.on('agent.permission_requested', on('permission_requested')),
    server.on('agent.permission_resolved', on('permission_resolved')),
    server.on('agent.archived', on('archived')),
  ];
  server.handle(boardMutate, async (input, { paseo }) => {
    const reply = await (await mutate)(input);
    // REQ-52: a card archived from the detail keeps no busy mark (as `kanban card update --archive`).
    if (reply.ok && reply.data.changed && input.operations.some(op => op.op === 'archive')) {
      const value = await store; await pruneAfterWrite(value.dataDir, input.boardId, async () => (await value.readBoard(input.boardId)).cards);
    }
    // REQ-97: a request confirmed just now goes out at once if the lead is already idle.
    if (reply.ok && reply.data.changed && input.operations.some(op => op.op === 'dispatch')) void dispatch.kick(paseo, input.boardId);
    return reply;
  });
  server.handle(dispatchPreview, async (input, { paseo }) => {
    try {
      const value = dispatchPreview.input.parse(input);
      return { ok: true as const, data: await dispatch.preview(paseo, value.boardId, value.cardId), committed: false as const, warnings: [] };
    } catch (error) { return { ok: false as const, error: readError(error), committed: false as const }; }
  });
  server.handle(boardEnsure, async (input, { paseo }) => (await ensure)(input, paseo));
  // The first board read after a restart repairs what the hooks missed, in the background.
  server.handle(overviewGet, async (input, { paseo }) => { auto.wake(paseo); void dispatch.wake(paseo); (await archiver).wake(); return (await handlers).overview(input, paseo); });
  server.handle(boardGet, async (input, { paseo }) => { auto.wake(paseo); void dispatch.wake(paseo); (await archiver).wake(); return (await handlers).board(input, paseo); });
  server.handle(cardGet, async input => (await handlers).card(input));
  // 298-F1: an open screen only asks for revisions (client/auto-refresh.ts), so that look wakes the automatic archive too — still at
  // most every ten minutes; an archive moves the board's revision, and the screen then reads it again. No timer of its own: with no
  // screen looking nothing is written (research/294 §10).
  server.handle(revisionsGet, async input => { (await archiver).wake(); return (await handlers).revisions(input); });
  server.handle(uiStateSet, async input => (await handlers).ui(input));
  // REQ-124: a lane's workflow, read from its workspace's own documents.
  server.handle(workflowGet, async (input, { paseo }) => (await handlers).workflow(input, paseo));
  // REQ-125: a lane tries a built-in workflow (or stops), kept in the plugin's own file only.
  server.handle(workflowPickSet, async (input, { paseo }) => (await handlers).workflowPick(input, paseo));
  // REQ-125 2단계: the pick written into the workspace folder as `.kanban/workflow.json`, only on the owner's press.
  server.handle(workflowExport, async (input, { paseo }) => (await handlers).workflowExport(input, paseo));
  // REQ-128: the lab's message list and one of its threads, read from the folder the host's lab names.
  server.handle(mailListGet, async input => (await handlers).mailList(input));
  server.handle(mailThreadGet, async input => (await handlers).mailThread(input));
  // REQ-84 ⑤: a person turns a card's busy mark off from the detail.
  server.handle(busyClear, async input => (await handlers).clearBusy(input));
  // REQ-130: and turns a lead card's one-line memo (the same busy mark) on.
  server.handle(busySet, async input => (await handlers).setBusy(input));
  server.handle(autoCardsSet, async input => {
    try {
      const value = autoCardsSet.input.parse(input);
      return { ok: true as const, data: await auto.setEnabled(value.hostId, value.enabled), committed: false as const, warnings: [] };
    } catch (error) { return { ok: false as const, error: readError(error), committed: false as const }; }
  });
  // D44: a person switches one workspace's auto cards (and its automatic board) off or on.
  server.handle(autoCardsWorkspaceSet, async input => {
    try {
      const value = autoCardsWorkspaceSet.input.parse(input);
      return { ok: true as const, data: await auto.setWorkspaceEnabled(value.cwd, value.enabled), committed: false as const, warnings: [] };
    } catch (error) { return { ok: false as const, error: readError(error), committed: false as const }; }
  });
  // REQ-137: a person marks a card's chat as its workspace's lead (or takes the mark off); a draft waiting may now go to it.
  server.handle(autoCardsLeadSet, async (input, { paseo }) => {
    try {
      const value = autoCardsLeadSet.input.parse(input);
      const data = await auto.setLead(value.boardId, value.cardId, value.lead);
      if (data.changed) void dispatch.kick(paseo, value.boardId);
      return { ok: true as const, data, committed: false as const, warnings: [] };
    } catch (error) { return { ok: false as const, error: readError(error), committed: false as const }; }
  });
  // REQ-74: a person turns automatic moves back on for a card they had moved.
  server.handle(autoCardsResume, async input => {
    try {
      const value = autoCardsResume.input.parse(input);
      return { ok: true as const, data: await auto.resume(value.boardId, value.cardId), committed: false as const, warnings: [] };
    } catch (error) { return { ok: false as const, error: readError(error), committed: false as const }; }
  });
  // REQ-52: the automatic archive's days, the done column's "Tidy", and the archived list with its restore.
  const archive = <I, T>(rpc: { input: { parse: (value: unknown) => I } }, action: (value: I) => Promise<T>) => async (input: unknown) => {
    try { return { ok: true as const, data: await action(rpc.input.parse(input)), committed: false as const, warnings: [] }; }
    catch (error) { return { ok: false as const, error: readError(error), committed: false as const }; }
  };
  server.handle(archiveSettingsSet, archive(archiveSettingsSet, async value => (await archiver).setDays(value.days)));
  server.handle(archiveTidy, archive(archiveTidy, async value => (await archiver).tidy(value.boardId)));
  server.handle(archivedList, archive(archivedList, async value => (await archiver).list(value.boardId)));
  server.handle(archivedRestore, archive(archivedRestore, async value => (await archiver).restore(value.boardId, value.cardId, value.ifRevision)));
  return () => { cleanups.forEach(cleanup => { try { cleanup(); } catch { /* already gone */ } }); };
}
