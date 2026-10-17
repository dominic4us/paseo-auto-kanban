import { displayStageNames } from './i18n.js';
import { useMemo } from 'react';
import { useRpc } from '@getpaseo/plugin/client';
import { overviewGet } from '../shared/rpc.js';
import { useRead, useDirectory } from './data.js';
import { createDemoData } from './demo.js';
import { knownRevisions, useAutoRefresh } from './auto-refresh.js';
import { answeredSettings, useKanbanSettings } from './settings.js';
import { placedBoards } from './presentation.js';
import { useScreenLocale } from './locale-hint.js';
import { useMovedBoards } from './quick-move.js';
import { shownBoards, useRevealHidden, type HiddenBoards } from './hidden-boards.js';
export function useBoardSource(hostId: string, preview: boolean) {
  const get = useRpc(overviewGet), read = useRead(hostId + ':swimlane', () => get({ includeBoards: true, hostId }), !preview);
  // Observation a: the last language kept for the host until this read answers; `null` = no words yet.
  const shownLocale = useScreenLocale(hostId, read.data?.locale, !preview && !read.data && !read.error);
  const locale = shownLocale ?? 'en', names = useDirectory(hostId, !preview, locale);
  // REQ-62: every board the overview shows, so a board that appears or vanishes is noticed too.
  const known = useMemo(() => read.data?.boardViews ? knownRevisions(read.data.boardViews.map(b => b.summary)) : null,
    [read.data?.boardViews]);
  // REQ-66: the host's settings; the demo shows the saved board position but never polls or saves.
  const settings = useKanbanSettings(hostId, answeredSettings(!!read.data?.ui, read.data?.ui?.settings));
  // REQ-90: with the lab's badge on, each look also asks for the message folder's fingerprint (never in the demo).
  const mailOn = !preview && !!settings.labs.mail;
  const refreshStatus = useAutoRefresh({ enabled: !preview && settings.autoRefresh, known, scope: 'all', busy: read.loading, revalidate: read.revalidate, groups: true,
    mail: mailOn ? { hostId, key: read.data?.mail?.key } : undefined });
  const demo = useMemo(() => createDemoData(locale, Date.now()), [locale]);
  // REQ-138: the empty boards of archived or gone workspaces stay out of every lane and list, unless shown again from the settings.
  const [reveal, setReveal] = useRevealHidden(hostId + ':surface');
  const kept = useMemo(() => shownBoards(read.data?.boardViews ?? [], reveal, b => b.summary), [read.data?.boardViews, reveal]);
  const listed = useMemo(() => (preview ? demo.boards : kept.boards)
    .map(board => displayStageNames(board, locale)), [preview, demo.boards, kept, locale]);
  const hiddenBoards: HiddenBoards | undefined = preview || !(kept.hidden || reveal) ? undefined
    : { count: kept.hidden, shown: reveal, onChange: setReveal };
  // REQ-78 ①②: only the boards the workspace listing can already place reach the screens, so none is filed under
  // "not found in Paseo" — or shown at all, hidden project or not — before its workspace is known.
  const { ready: directoryReady, settled } = names;
  const placed = useMemo(() => preview ? listed : placedBoards(listed, names.directory, { ready: directoryReady, settled }, b => b.summary),
    [preview, listed, names.directory, directoryReady, settled]);
  // REQ-82 ③: a card a person just moved is drawn in its new column until the boards are read with the move.
  const boards = useMovedBoards(hostId, placed, !preview);
  return { about: read.data?.about, boards, summaries: boards.map(b => b.summary), locale, localePending: shownLocale === null,
    directory: preview ? demo.directory : names.directory,
    labels: preview ? demo.workspaceLabels : read.data?.workspaceLabels,
    // REQ-57 ④/REQ-59 ②: what the ledger remembered for this host; the demo never reads or writes it.
    hiddenProjects: preview ? undefined : read.data?.ui?.hiddenProjects,
    order: preview ? undefined : read.data?.ui?.order,
    autoCards: preview ? undefined : read.data?.autoCards,
    /** D44: the workspaces whose auto cards are off. */
    autoCardsOff: preview ? undefined : read.data?.autoCardsOff,
    /** REQ-52: the automatic archive's days for the whole plugin. */
    autoArchive: preview ? undefined : read.data?.autoArchive,
    /** REQ-90: what the message folder holds for the lanes, while the lab's badge is on; the rule that names each lane. */
    mail: mailOn ? read.data?.mail : undefined, mailAlias: settings.labs.mailAlias ?? 'compact',
    settings, refreshStatus,
    /** REQ-138: the boards left out (`shownBoards`) and the switch that shows them again; none in the demo or with none hidden. */
    hiddenBoards,
    /** REQ-83: the server's automatic tracking — the latest auto refresh look's report, else the read's — and whether the looks keep failing. */
    autoHealth: preview ? undefined : refreshStatus.health ?? read.data?.autoHealth, refreshFailing: !preview && !!refreshStatus.failing,
    loading: !preview && read.loading, error: preview ? '' : read.error,
    errors: preview ? [] : read.data?.errors ?? [], ready: preview || !!read.data,
    /**
     * REQ-78: the workspace listing. `projectsKnown` once any listing is known (until then there is no project
     * count to show); `placing` while boards the overview has are still waiting for it; `directoryError` when a
     * listing failed or timed out (it is read again on its own).
     */
    projectsKnown: preview || directoryReady, placing: !preview && boards.length < listed.length,
    directorySettled: preview || settled, directoryError: preview ? '' : names.error,
    observedAt: preview ? '' : read.data?.observedAt ?? '',
    refresh: () => { if (!preview) { void read.refresh(); void names.refresh(); } },
    /** REQ-82: the boards read again after a quick move, without a loading state (the REQ-62 read). */
    revalidate: () => { if (!preview) void read.revalidate(); } };
}
