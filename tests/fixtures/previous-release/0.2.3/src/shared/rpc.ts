import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { workflowDataSchema } from './workflow.js';
import { mailListSchema, mailThreadSchema } from './mail-list.js';
import { DISPATCH_HELD } from './dispatch.js';

const boardId = z.string().regex(/^board_[0-9a-f]{64}$/);
/**
 * REQ-57: a workspace that Paseo knows about but that has no ledger board yet is shown as an empty
 * board. Its view id is derived from the workspace id and is deliberately not a ledger board id, so a
 * mutation or a card read can never be addressed to it; only board.get and board.ensure accept it.
 */
export const EMPTY_BOARD_PREFIX = 'empty:';
const emptyBoardId = z.string().regex(/^empty:[A-Za-z0-9_-]{1,160}$/);
const viewBoardId = z.union([boardId, emptyBoardId]);
export function emptyBoardView(workspaceId: string): string { return EMPTY_BOARD_PREFIX + workspaceId; }
export function workspaceOfEmptyBoard(id: string): string | null {
  return id.startsWith(EMPTY_BOARD_PREFIX) ? id.slice(EMPTY_BOARD_PREFIX.length) : null;
}
/** D22/D44: the one spelling of a workspace directory — defined beside the core, which compares it too. */
export { normalizeCwd, folderKey } from './core/domain.js';
const workspaceId = z.string().regex(/^(wks_[A-Za-z0-9_-]{1,128}|local_[0-9a-f]{64})$/);
const cardId = z.string().regex(/^card_[0-9a-f-]{36}$/);
const time = z.string();
/**
 * REQ-84: work that is not an agent's turn marked on a card (`kanban card busy`) — its words, since when, and who marked it
 * (an agent id, a person's name or "cli"). From the plugin's own `busy.json` (server/busy.ts), never the ledger.
 */
const busyMark = z.object({ text: z.string(), since: time, by: z.string() });
export type BusyDTO = z.infer<typeof busyMark>;
export const errorSchema = z.object({
  code: z.string(), message: z.string(), target: z.string(), nextAction: z.string(),
  details: z.unknown(),
});
const warning = errorSchema.omit({ details: true });
export type ReadError = z.infer<typeof errorSchema>;
function envelope<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data, committed: z.literal(false), warnings: z.array(warning) }),
    z.object({ ok: z.literal(false), error: errorSchema, committed: z.literal(false) }),
  ]);
}
const stage = z.object({ stageId: z.string(), name: z.string(), countsAsDone: z.boolean() });
const template = z.object({
  schemaVersion: z.literal(1), id: z.string(), version: z.number(), name: z.string(), stages: z.array(stage),
});
const priority = z.enum(['high', 'normal', 'low']);
const intent = z.enum(['draft', 'requested']);
const awaiting = z.enum(['user', 'agent']).nullable();
const actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({ kind: z.literal('agent'), agentId: z.string() }),
]);
const link = z.object({ agentId: z.string(), role: z.string(), label: z.string(), linkedAt: time });
/** REQ-97: a draft sent to the workspace's lead (shared/core/domain.ts `CardDispatch`). */
const dispatchState = z.enum(['pending', 'sent', 'noLead', 'cancelled']);
const dispatchHeldReason = z.enum(DISPATCH_HELD);
const dispatch = z.object({ state: dispatchState, targetAgentId: z.string().nullable(), requestedAt: time,
  sentAt: time.nullable(), messageId: z.string() });
export type DispatchDTO = z.infer<typeof dispatch>;
const card = z.object({
  id: cardId, title: z.string(), stageId: z.string(), acceptanceCriteria: z.string(),
  notes: z.string(), priority, blockedReason: z.string().nullable(), nextAction: z.string(),
  intent, awaiting, deliverables: z.array(z.string()), agents: z.array(link), createdBy: actor,
  createdAt: time, updatedAt: time, archivedAt: time.nullable(),
  /** REQ-97: absent on a card never sent, and from an older server. */
  dispatch: dispatch.optional(),
  /** REQ-108: set by the write that moved the card; absent on a card not moved since, and from an older server. */
  stageEnteredAt: time.optional(),
});
const history = z.object({
  cardId, from: z.string().nullable(), to: z.string(), actor, at: time, revision: z.string(),
});
const summary = z.object({
  id: viewBoardId, workspaceId, cwd: z.string(), workspaceStatus: z.enum(['active', 'inactive', 'unknown']),
  revision: z.string(), updatedAt: time,
  /** Absent on ledger boards; false on the synthesized view of a workspace with no board file yet. */
  hasLedger: z.boolean().optional(),
  /**
   * REQ-76 F1: a fingerprint of which card sits under which, from the plugin's own file and not the ledger, so the
   * revision alone misses a parent remembered later. Absent when no card sits under another, and from an older server.
   */
  groups: z.string().max(64).optional(),
  /** REQ-84: a fingerprint of the board's busy marks, which change the plugin's file and not the revision. Absent with none. */
  busy: z.string().max(64).optional(),
  /**
   * REQ-124: the workspace folder holds a workflow definition (`.kanban/workflow.json`), so its lane offers "Board | Workflow".
   * Only the overview's board views and (REQ-127) `board.get`'s board say it (one cached stat per folder, server/workflow.ts);
   * absent otherwise and from an older server.
   */
  workflow: z.literal(true).optional(),
  /**
   * REQ-125: the built-in workflow this workspace is trying (`workflow-picks.json`), when it has no definition file — then
   * `workflow` is true too and the lane's workflow is the built-in's. Absent with a file, with no pick and from an older server.
   */
  workflowPick: z.string().max(40).optional(),
  /**
   * REQ-138: a ledger board of a workspace Paseo no longer lists as live (archived or gone) that has no live card — the
   * screens leave it out of their lanes and workspace lists (`shownBoards`). Only a full overview read with Paseo's listing
   * says it, judged afresh each read; absent otherwise, on a synthesized empty board and from an older server.
   */
  emptyGone: z.literal(true).optional(),
  /**
   * REQ-137: the chat marked as this board's workspace lead (`auto-cards.json` `leads`), its agent id. Only the board views
   * (the overview's and `board.get`'s) say it, and it is folded into `groups` so a mark changed elsewhere is noticed.
   * Absent with none, with the file unreadable (fail closed: by name alone) and from an older server.
   */
  lead: z.string().max(256).optional(),
  /**
   * 281 F1: who leads the workspace now as the server judges it for a draft (server/dispatch.ts `judgeLead`, the receiver's own
   * `pickLead` of the listed, admitted chats) — the screens' crown, settings line and menu take it as it is, never judge again.
   * `agentId`/`title`/`by`: the chat a draft goes to by the mark (`set`) or by name (`name`); null with neither (a fallback or
   * nobody: the screens' own "has sub-cards" / "none"). `mark`: why the kept mark (`lead`) is not in effect — its chat is
   * archived, or not one this board sends to (`unusable`: another board's chat, a sub-chat, a topic lead, a closing
   * workspace). Absent when it was not judged (no host listing, a read that failed or took too long, an older server).
   */
  leadNow: z.object({ agentId: z.string().max(256).nullable(), title: z.string().max(1024), by: z.enum(['set', 'name']).nullable(),
    mark: z.enum(['archived', 'unusable']).optional() }).optional(),
  progress: z.object({ done: z.number(), requested: z.number(), draft: z.number(),
    archived: z.number(), percent: z.number().nullable(),
    /**
     * REQ-52: the archived cards that were archived from a completion stage — counted in `done` and `requested` too, and
     * said beside the done column's count. Absent from an older server.
     */
    archivedDone: z.number().optional() }),
});
const boardCard = z.object({
  id: cardId, title: z.string(), stageId: z.string(), priority, intent, blocked: z.boolean(),
  nextAction: z.string(), agents: z.number(), awaiting,
  agentIds: z.array(z.string()), completedAt: time.nullable(),
  /** REQ-73: when the card last changed, for the age on its face. Optional so an older reply still parses. */
  updatedAt: time.optional(),
  /** REQ-79: when the card was made, for the "newest first" order. Optional so an older reply still parses. */
  createdAt: time.optional(),
  /**
   * REQ-76: the card of the same board this one sits under — the card of its first agent's top-level agent, as the
   * plugin remembered it (server/card-parents.ts). Absent on a card that sits on its own, and from an older server.
   */
  parentCardId: cardId.optional(),
  /**
   * REQ-103 ①: ticked and all checklist lines (`- [ ]` / `- [x]`) of the card's acceptance criteria (shared/criteria.ts).
   * Absent when the criteria have none, and from an older server.
   */
  criteria: z.object({ checked: z.number(), total: z.number() }).optional(),
  /**
   * REQ-97: where the card's request to the lead stands, for the chip on its face. Absent on a card never sent.
   * v0.1.46-B: `targetAgentId`, the agent it waits for or went to (the screen says "latest agent" when that one is not a
   * lead by name); absent from an older server.
   */
  dispatch: z.object({ state: dispatchState, sentAt: time.nullable(), targetAgentId: z.string().nullable().optional(),
    /** 253-D3: a card waiting with nobody to go to for another reason than "no agent there"; absent otherwise and from an older server. */
    held: dispatchHeldReason.optional(),
    /**
     * REQ-137: the agent it waits for is the chat marked as the board's lead, or (281 F2) the one it went to was the marked chat
     * when it was sent — never "the latest agent". From the mark as it was then (`dispatchMode`), not as it is now.
     */
    marked: z.literal(true).optional(),
    /**
     * 281 F2: sent before the board's mark last changed (or with the plugin's file unreadable) — by which rule it went is not
     * kept (the ledger keeps no receiver's role, v0.1.47), so the screens say only "Sent", neither the lead nor the latest agent.
     */
    modeUnknown: z.literal(true).optional() }).optional(),
  /**
   * REQ-86: when the card entered its stage — the card's own `stageEnteredAt` (REQ-108), else the ledger's movement records
   * (server/read-model.ts `stageEntry`). `stageEnteredEstimated`: neither says it, since the records were cut off (1000 a
   * board), so this is the card's last change. Both absent from an older server.
   */
  stageEnteredAt: time.optional(),
  stageEnteredEstimated: z.literal(true).optional(),
  /** REQ-84: the card's busy mark. Absent on a card with none, and from an older server. */
  busy: busyMark.optional(),
  /**
   * Research/174 J2: when the card's busy mark was last turned off, within the last three hours — REQ-86's "no agent at work"
   * counts from then, as from an agent's activity. Absent while a mark is on, with none recent, and from an older server.
   */
  busyEndedAt: time.optional(),
});
export type BoardCardDTO = z.infer<typeof boardCard>;
export const hideDoneSchema = z.enum(['off', '7d', '30d']);
export type HideDone = z.infer<typeof hideDoneSchema>;
const boardDTO = z.object({
  summary, template, agentLabels: z.record(z.string(), z.string()),
  stages: z.array(stage.extend({ cards: z.array(boardCard), hiddenCount: z.number(), totalCount: z.number() })),
});
export type BoardDTO = z.infer<typeof boardDTO>;
/** REQ-84: `busyOverdue` — a busy mark left on for more than two hours asks a person to look. */
const reason = z.enum(['awaitingUser', 'blocked', 'draft', 'busyOverdue']);
const attention = boardCard.extend({ boardId, workspaceId, cwd: z.string(), stageName: z.string(),
  reasons: z.array(reason), agentLabels: z.record(z.string(), z.string()) });
const observed = { observedAt: time, locale: z.enum(['en', 'ko']) };
export const workspaceLabelSchema = z.object({ name: z.string().min(1),
  color: z.enum(['violet', 'sky', 'emerald', 'orange', 'pink', 'indigo', 'teal', 'red', 'amber', 'blue']) });
export const workspaceLabelsSchema = z.object({ available: z.boolean(), source: z.enum(['api', 'file', 'none']),
  definitions: z.array(workspaceLabelSchema), byWorkspace: z.record(z.string(), z.array(z.string())) });
export type WorkspaceLabel = z.infer<typeof workspaceLabelSchema>;
export type WorkspaceLabelsDTO = z.infer<typeof workspaceLabelsSchema>;
/**
 * REQ-59: the order the user arranged, remembered beside the project filter. `projects` holds project
 * ids and `workspaces` holds workspace keys (the Paseo workspace id, or the board's own workspace id
 * when Paseo no longer lists it), each in the order they should appear. Anything absent from a list
 * keeps the automatic order and follows the listed entries.
 */
export const uiOrderSchema = z.object({ projects: z.array(z.string()), workspaces: z.array(z.string()),
  /**
   * REQ-75 A4: the flat board's own lane order (workspace keys), kept apart from `workspaces`, which is the
   * order inside each project of the grouped board. Absent until the flat board is arranged once.
   */
  flatWorkspaces: z.array(z.string()).optional() });
export type UiOrderDTO = z.infer<typeof uiOrderSchema>;
/**
 * REQ-66: the Kanban settings window, remembered per host beside the filter and the order. A field that
 * is absent means its default (board centred, auto refresh on), so a file written before REQ-66 reads as
 * the defaults and nothing is written until a row is changed.
 */
export const boardAlignSchema = z.enum(['left', 'center', 'right']);
export type BoardAlign = z.infer<typeof boardAlignSchema>;
/** REQ-70: the colours Kanban draws in — the host's (Paseo), the device's (system), or always light or dark. */
export const themeChoiceSchema = z.enum(['paseo', 'system', 'light', 'dark']);
export type ThemeChoice = z.infer<typeof themeChoiceSchema>;
/** REQ-79: how cards are ordered inside a column (client/card-order.ts). */
export const cardOrderSchema = z.enum(['default', 'updated', 'created']);
/**
 * REQ-90: the lab — trial features for the developer's own devices, each off until switched on. Only what differs from the
 * default is kept (`mail` true, a `mailDir`, `mailAlias` 'folder'), so a host that never opened the lab keeps the old shape.
 * `mail`: the "messages waiting" badge on the lanes (server/mailbox.ts); `mailDir`: the message folder it reads (no default:
 * empty reads nothing); `mailAlias`: how a workspace's short name comes from its folder — `compact` (the default: the last
 * folder's name without spaces) or `folder` (the name as it is).
 */
export const mailAliasSchema = z.enum(['compact', 'folder']);
export type MailAliasRule = z.infer<typeof mailAliasSchema>;
export const MAIL_DIR_LIMIT = 1024;
export const labsSchema = z.object({ mail: z.boolean().optional(), mailDir: z.string().max(MAIL_DIR_LIMIT).optional(),
  mailAlias: mailAliasSchema.optional() });
export type LabsDTO = z.infer<typeof labsSchema>;
/**
 * REQ-90: what the message folder holds for the lanes — every open thread (its newest file not a close) whose newest file
 * names who it waits for (`to`, the text after "받는 곳:"), and the ones whose newest file has no such line (`unknown`,
 * counted apart and never matched). `key` fingerprints both, as `revisions.get` says it; `error` when the folder could not
 * be read. Present only while the lab's badge is on and a folder is set.
 */
const mailThread = z.object({ thread: z.string(), file: z.string(), to: z.string() });
export const mailSchema = z.object({ key: z.string().max(64), threads: z.array(mailThread),
  unknown: z.array(mailThread.omit({ to: true })), error: z.literal('unreadable').optional() });
export type MailDTO = z.infer<typeof mailSchema>;
/**
 * REQ-139: how large the Kanban screens draw, in percent — 80 to 150 in steps of 10 (client/ui-scale.ts). Stored only while it
 * is not 100, so absent means 100 and a file written before reads unchanged.
 */
export const uiScaleSchema = z.number().int().min(80).max(150).refine(v => v % 10 === 0, 'A step of 10.');
export const uiSettingsSchema = z.object({ boardAlign: boardAlignSchema.optional(), autoRefresh: z.boolean().optional(),
  theme: themeChoiceSchema.optional(),
  /** REQ-75 A3: the swimlane board grouped under project headings (true), or one lane per workspace (absent/false). */
  groupByProject: z.boolean().optional(),
  /** REQ-79: the card order; stored only while it is not the default, so absent means 'default'. */
  cardOrder: cardOrderSchema.optional(),
  /** REQ-90: the lab; absent until something in it differs from its default. */
  labs: labsSchema.optional(),
  /** REQ-139: the screens' size; absent while it is 100. */
  uiScale: uiScaleSchema.optional() });
export type UiSettingsDTO = z.infer<typeof uiSettingsSchema>;
export const uiStateSchema = z.object({ hiddenProjects: z.array(z.string()), order: uiOrderSchema,
  settings: uiSettingsSchema.optional() });
export type UiStateDTO = z.infer<typeof uiStateSchema>;
/**
 * REQ-83: how the server's automatic tracking is doing (server/auto-cards.ts `AutoHealth`): `held` when some agents'
 * states or hook inputs could not be read and their automatic moves wait, `failed` when the agent listing could not be
 * read. Optional everywhere, so a screen and a server of different versions still read each other.
 */
export const autoHealthSchema = z.object({ state: z.enum(['ok', 'held', 'failed']), held: z.number(),
  issue: z.enum(['unknown-status', 'missing-field', 'bad-hook', 'list-failed', 'list-shape']).nullable(),
  detail: z.string().max(200).nullable(), at: time.nullable(),
  // H1: how many of `held` are hook inputs rather than agents' states; absent from an older server.
  inputs: z.number().optional() });
export type AutoHealthDTO = z.infer<typeof autoHealthSchema>;
/** REQ-52: the automatic archive's setting (server/auto-archive.ts). */
export const autoArchiveSchema = z.object({ days: z.number().int().min(0).max(365), damaged: z.literal(true).optional() });
export type AutoArchiveDTO = z.infer<typeof autoArchiveSchema>;
const overviewData = z.object({ ...observed, boards: z.array(summary.extend({ needsHuman: z.number() })),
  attention: z.array(attention), errors: z.array(errorSchema),
  workspaceLabels: workspaceLabelsSchema.optional(), boardViews: z.array(boardDTO).optional(), removedIds: z.array(boardId).optional(),
  /** REQ-57: remembered per host, so the project filter survives an app restart. */
  ui: uiStateSchema.optional(),
  /** REQ-61 ⑧: whether agent auto cards are on for this host (default on). Present with hostId. */
  autoCards: z.boolean().optional(),
  /** D44: the workspace folders (`normalizeCwd`) whose auto cards are switched off. Present with hostId; absent from an older server. */
  autoCardsOff: z.array(z.string()).optional(),
  /** REQ-83: the server's automatic tracking. */
  autoHealth: autoHealthSchema.optional(),
  /** REQ-52: the automatic archive's days (0: off) for the whole plugin; `damaged` when its file cannot be read. */
  autoArchive: autoArchiveSchema.optional(),
  /** REQ-90: the lab's "messages waiting" badge — only with hostId, the badge on and a folder set. */
  mail: mailSchema.optional(),
  /** REQ-48: the running plugin's build metadata, returned without a separate RPC. */
  about: z.object({ version: z.string(), release: z.string().optional() }).optional() });
export type OverviewDTO = z.infer<typeof overviewData>;
const boardData = z.object({ ...observed, board: boardDTO, revision: z.string(),
  about: z.object({ version: z.string(), release: z.string().optional() }).optional(),
  /** REQ-66: this host's settings, present with hostId, so a panel opened first obeys auto refresh off. */
  settings: uiSettingsSchema.optional(),
  /** REQ-67 ⑥: whether agent auto cards are on, present with hostId, for the settings window opened from a board. */
  autoCards: z.boolean().optional(),
  /** D44: as on the overview. */
  autoCardsOff: z.array(z.string()).optional(),
  /** REQ-83: the server's automatic tracking. */
  autoHealth: autoHealthSchema.optional(),
  /** REQ-52: as on the overview. */
  autoArchive: autoArchiveSchema.optional() });
export type BoardSnapshot = z.infer<typeof boardData>;
const moveCause = z.enum(['created', 'turn_started', 'turn_ended', 'permission_requested', 'permission_resolved', 'archived', 'reconcile']);
/** REQ-74: why the card sits in its stage — the automatic cards (and which signal), a person, or another agent. */
const moveReason = z.object({ by: z.enum(['auto', 'user', 'agent']), cause: moveCause.nullable(), agentId: z.string().nullable(),
  at: time, created: z.boolean() });
export type MoveReasonDTO = z.infer<typeof moveReason>;
export type MoveCause = z.infer<typeof moveCause>;
/** REQ-74: automatic tracking of an auto card: following its agent, paused by somebody's move, or switched off. */
const tracking = z.object({ state: z.enum(['on', 'paused', 'off']), since: time.nullable() });
export type TrackingDTO = z.infer<typeof tracking>;
const cardData = z.object({ ...observed, boardId, card, template, history: z.array(history), revision: z.string(),
  reason: moveReason.nullable().optional(), tracking: tracking.nullable().optional(),
  /** REQ-86: as on the board's card (`boardCard`), for the detail's "Entered this stage". */
  stageEnteredAt: time.optional(), stageEnteredEstimated: z.literal(true).optional(),
  /** REQ-84: as on the board's card, for the detail's line and its "Turn off". Null with none; absent from an older server. */
  busy: busyMark.nullable().optional(),
  /** 253-D3: as the board card's `dispatch.held`, for the detail's request line. */
  dispatchHeld: dispatchHeldReason.optional(),
  /** REQ-137 / 281 F2: as the board card's `dispatch.marked` and `dispatch.modeUnknown`, for the detail's request line. */
  dispatchMode: z.object({ marked: z.literal(true).optional(), modeUnknown: z.literal(true).optional() }).optional() });
export type CardSnapshot = z.infer<typeof cardData>;
const hostId = z.string().min(1).max(256);
export const overviewGet = defineRpc({ name: 'kanban.v1.overview.get',
  input: z.strictObject({ includeBoards: z.boolean().optional(), hostId: hostId.optional(),
    /** REQ-57 ①: ask Paseo which workspaces exist, so board-less ones are listed too. */
    includeWorkspaces: z.boolean().optional(),
    boardIds: z.array(boardId).min(1).max(20).optional() }), output: envelope(overviewData) });
export const boardGet = defineRpc({ name: 'kanban.v1.board.get', input: z.strictObject({
  boardId: viewBoardId.optional(), workspaceId: workspaceId.optional(), hideDone: hideDoneSchema.optional(),
  hostId: hostId.optional(),
}).refine(v => Number(v.boardId !== undefined) + Number(v.workspaceId !== undefined) === 1,
  'Specify exactly one boardId or workspaceId.'), output: envelope(boardData) });
export const cardGet = defineRpc({ name: 'kanban.v1.card.get', input: z.strictObject({ boardId, cardId }),
  output: envelope(cardData) });
export const revisionsGet = defineRpc({ name: 'kanban.v1.revisions.get',
  /** `groups`: REQ-76 F1, also say each board's `summary.groups`, for a screen that draws sub-cards under their parent. */
  input: z.strictObject({ boardIds: z.array(boardId).max(1000).optional(), groups: z.boolean().optional(),
    /** REQ-90: sent only by a screen whose lab badge is on, so the server says the message folder's fingerprint (`mail`). */
    hostId: hostId.optional() }),
  output: envelope(z.object({ observedAt: time,
    boards: z.array(z.object({ id: boardId, revision: z.string(), state: z.literal('ready'), groups: z.string().max(64).optional(),
      /** REQ-84: as `summary.busy`. */
      busy: z.string().max(64).optional() })),
    removedIds: z.array(boardId), errors: z.array(errorSchema),
    /** REQ-83: the server's automatic tracking, so an open screen hears of it without a ledger change. */
    autoHealth: autoHealthSchema.optional(),
    /** REQ-90: the message folder's fingerprint (`mail.key` of the overview), with hostId while the lab's badge is on. */
    mail: z.string().max(64).optional(),
  })),
});

const inputText = (limit: number, required = false) => z.string().refine(value => {
  const normalized = value.replace(/\r\n/g, '\n');
  const text = required ? normalized.trim() : normalized;
  return [...text].length <= limit && (!required || text.length > 0);
}, 'Invalid text length.');
export const editablePatch = z.strictObject({
  title: inputText(200, true).optional(), notes: inputText(8000).optional(),
  nextAction: inputText(1000).optional(), priority: priority.optional(),
  blockedReason: inputText(1000, true).nullable().optional(), awaiting: awaiting.optional(),
  // REQ-103 ①: the detail ticks a checklist line of the acceptance criteria and saves the criteria text (REQ-88 ⑤).
  acceptanceCriteria: inputText(8000).optional(),
});
export const addOperation = z.strictObject({ op: z.literal('add'), title: inputText(200, true),
  notes: inputText(8000).optional(), nextAction: inputText(1000).optional(), priority: priority.optional() });
export const uiOperation = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('update'), id: cardId, patch: editablePatch }),
  z.strictObject({ op: z.literal('move'), id: cardId, to: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/) }),
  // REQ-97: a draft moved to the working stage after the confirmation sheet — sent to the lead once it is idle.
  // 253-D2: `targetAgentId`, the agent the sheet named — the request goes to it, or waits, never to another chat unasked.
  z.strictObject({ op: z.literal('dispatch'), id: cardId, to: z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/),
    acceptanceCriteria: inputText(8000).optional(), targetAgentId: z.string().uuid().optional() }),
  // REQ-52: the detail's "Archive" — a person's own act, so no reason is recorded (cancelled or a duplicate, if not done).
  z.strictObject({ op: z.literal('archive'), id: cardId }),
  addOperation,
]);
const mutationInput = z.strictObject({ boardId,
  requestId: z.string().uuid(), ifRevision: z.string().regex(/^[0-9a-f-]{36}:[1-9][0-9]*$/),
  operations: z.array(uiOperation).min(1).max(100),
});
export type MutationRequest = z.infer<typeof mutationInput>;
const mutationData = z.object({ boardId, revision: z.string(), currentRevision: z.string(),
  requestId: z.string(), cardIds: z.array(cardId), changed: z.boolean(), replayed: z.boolean(),
  export: z.enum(['written', 'unchanged', 'skipped', 'failed']).optional(),
});
export const boardMutate = defineRpc({ name: 'kanban.v1.board.mutate', input: mutationInput,
  output: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: mutationData, committed: z.boolean(), warnings: z.array(warning) }),
    z.object({ ok: z.literal(false), error: errorSchema, committed: z.union([z.literal(false), z.literal('unknown')]) }),
  ]),
});
export type MutationReply = z.infer<typeof boardMutate.output>;

/**
 * REQ-57 ③: the first card of a board-less workspace. The server resolves the workspace directory from
 * Paseo itself (never from the client), runs the same core init path as `kanban init` and then applies
 * the add operations under the caller's requestId, so retrying the same request replays instead of
 * adding a second card. Card text is validated before anything is written.
 */
const ensureInput = z.strictObject({ workspaceId,
  requestId: z.string().uuid(),
  operations: z.array(addOperation).min(1).max(20),
});
export type EnsureRequest = z.infer<typeof ensureInput>;
export const boardEnsure = defineRpc({ name: 'kanban.v1.board.ensure', input: ensureInput,
  output: z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: mutationData.extend({ created: z.boolean() }), committed: z.boolean(), warnings: z.array(warning) }),
    z.object({ ok: z.literal(false), error: errorSchema, committed: z.union([z.literal(false), z.literal('unknown')]) }),
  ]),
});
export type EnsureReply = z.infer<typeof boardEnsure.output>;
const orderKeys = (limit: number) => z.array(z.string().min(1).max(256)).max(limit);
/**
 * REQ-57 ④/REQ-59 ②: one small write, and only when the user changes the project filter or the order.
 * The two fields travel separately, so moving a lane never rewrites the filter and vice versa.
 */
export const uiStateSet = defineRpc({ name: 'kanban.v1.ui.set',
  input: z.strictObject({ hostId, hiddenProjects: orderKeys(500).optional(),
    /** REQ-75 A4: an order sent without `flatWorkspaces` (an older client) keeps the stored flat order. */
    order: z.strictObject({ projects: orderKeys(500), workspaces: orderKeys(2000), flatWorkspaces: orderKeys(2000).optional() }).optional(),
    /** REQ-66: one settings row per write; only the fields sent change. */
    settings: z.strictObject({ boardAlign: boardAlignSchema.optional(), autoRefresh: z.boolean().optional(),
      theme: themeChoiceSchema.optional(), groupByProject: z.boolean().optional(), cardOrder: cardOrderSchema.optional(),
      /** REQ-90: the lab's fields sent change; the others keep what the file holds. */
      labs: z.strictObject({ mail: z.boolean().optional(), mailDir: z.string().max(MAIL_DIR_LIMIT).optional(),
        mailAlias: mailAliasSchema.optional() }).optional(),
      /** REQ-139: the screens' size; 100 takes it out of the file. */
      uiScale: uiScaleSchema.optional() })
      .refine(v => v.boardAlign !== undefined || v.autoRefresh !== undefined || v.theme !== undefined || v.groupByProject !== undefined
        || v.cardOrder !== undefined || v.labs !== undefined || v.uiScale !== undefined,
        'Specify a setting.').optional() })
    .refine(v => v.hiddenProjects !== undefined || v.order !== undefined || v.settings !== undefined,
      'Specify hiddenProjects, order, settings or a combination.'),
  output: envelope(z.object({ ...uiStateSchema.shape, changed: z.boolean() })) });
/**
 * REQ-61 ⑧: switches the agent auto cards on or off for this host. Stored beside `ui-state.json` in the
 * plugin's own file, never in the ledger, and written only when the value actually changes.
 */
export const autoCardsSet = defineRpc({ name: 'kanban.v1.auto_cards.set',
  input: z.strictObject({ hostId, enabled: z.boolean() }),
  output: envelope(z.object({ enabled: z.boolean(), changed: z.boolean() })) });
/**
 * D44: switches the agent auto cards (and the board they would make) on or off for one workspace, by its folder as the
 * lane shows it. Kept in the plugin's own `auto-cards.json` by `normalizeCwd` of the folder, never in the ledger.
 */
export const autoCardsWorkspaceSet = defineRpc({ name: 'kanban.v1.auto_cards.workspace.set',
  input: z.strictObject({ cwd: z.string().min(1).max(4096), enabled: z.boolean() }),
  output: envelope(z.object({ enabled: z.boolean(), changed: z.boolean() })) });
/**
 * REQ-137 (research/273 B): the card ⋯ "Mark as lead" / "Unmark as lead" — the card's first chat marked as the lead of its
 * board's workspace, or the mark taken off. Kept in the plugin's own `auto-cards.json` (`leads`), never in the ledger.
 * `lead`: the chat marked now (null: none, the lead is found by name), `previous`: the one before.
 */
export const autoCardsLeadSet = defineRpc({ name: 'kanban.v1.auto_cards.lead.set',
  input: z.strictObject({ boardId, cardId, lead: z.boolean() }),
  output: envelope(z.object({ lead: z.string().nullable(), previous: z.string().nullable(), changed: z.boolean() })) });
/**
 * REQ-74: "resume automatic tracking" for one card whose automatic moves a person paused by moving it.
 * Only the plugin's own `auto-cards.json` changes; the card stays put until its agent's next signal.
 */
export const autoCardsResume = defineRpc({ name: 'kanban.v1.auto_cards.resume',
  input: z.strictObject({ boardId, cardId }),
  output: envelope(z.object({ resumed: z.number() })) });
/**
 * REQ-84 ⑤: a person turns a card's busy mark off from the detail. Only the plugin's own `busy.json` changes; turning off
 * a mark already gone is no error (`changed: false`).
 */
export const busyClear = defineRpc({ name: 'kanban.v1.busy.clear',
  input: z.strictObject({ boardId, cardId }),
  output: envelope(z.object({ changed: z.boolean() })) });
/**
 * REQ-130 (research/260 C ②): a person turns a lead card's one-line memo on from the detail — the same busy mark as
 * `kanban card busy CARD "TEXT"` (`busy.json`, never the ledger), recorded as by the board screen (`by: "screen"`).
 * Writing it again replaces the words and starts the time again; it is turned off with `busyClear`.
 */
export const busySet = defineRpc({ name: 'kanban.v1.busy.set',
  input: z.strictObject({ boardId, cardId, text: z.string().max(1000) }),
  output: envelope(z.object({ changed: z.boolean(), busy: busyMark.nullable() })) });

/**
 * REQ-97: what the confirmation sheet shows before a draft is sent — the agent it would go to (the newest unarchived
 * top-level agent of the board's workspace titled "총괄-…" or with a "총괄_…" profile; v0.1.46-B: else the newest
 * top-level agent there, `fallback`), or null when there is none, and the board's title and language as the prompt
 * names them. Nothing is sent and the ledger is not written.
 */
export const dispatchPreview = defineRpc({ name: 'kanban.v1.dispatch.preview', input: z.strictObject({ boardId, cardId }),
  // v0.1.46-B: `fallback` — not a lead by name, the workspace's newest agent; `locale` — the message's language. Absent from an older server.
  // 253-D3: `held` — with no agent to go to, why (no agent there; the start line unreadable; ...). Absent from an older server.
  output: envelope(z.object({ lead: z.object({ agentId: z.string(), title: z.string(), fallback: z.boolean().optional() }).nullable(),
    held: dispatchHeldReason.optional(), locale: z.enum(['ko', 'en']).optional(), boardTitle: z.string(),
    revision: z.string(), card, to: z.string().nullable() })) });
export type DispatchPreviewDTO = z.infer<typeof dispatchPreview.output>;

/**
 * REQ-124: a lane's "workflow" — the procedure its workspace defines in `.kanban/workflow.json` and what its documents say
 * happened, joined by release (server/workflow.ts, shared/workflow.ts). The server finds the workspace folder itself (Paseo,
 * else the workspace's board) and only reads; `{ defined: false }` for a workspace with no (readable) definition.
 * `window`: how many releases, newest first (default: the definition's `releaseWindow`). One reading per minute per folder.
 */
export const workflowGet = defineRpc({ name: 'kanban.v1.workflow.get',
  input: z.strictObject({ workspaceId, window: z.number().int().min(1).max(100).optional() }),
  output: envelope(workflowDataSchema) });
export type WorkflowReply = z.infer<typeof workflowGet.output>;
/**
 * REQ-125 C안 1단계: "Try a workflow" — the workspace tries a built-in workflow (`template`, shared/workflow-templates.ts),
 * or (`null`) stops using it. Kept only in the plugin's own `workflow-picks.json` by the workspace's folder, which the
 * server finds as `workflow.get` does; nothing is written to the workspace folder or the ledger. A definition file wins over it.
 */
export const workflowPickSet = defineRpc({ name: 'kanban.v1.workflow.pick.set',
  input: z.strictObject({ workspaceId, template: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).nullable() }),
  output: envelope(z.object({ template: z.string().nullable(), changed: z.boolean() })) });
/**
 * REQ-125 2단계 (research/288): "Export to the project folder" — the built-in the workspace is trying (`template`, which must
 * be its pick now) written as `.kanban/workflow.json` in the workspace folder the server finds, in the board's language. Never
 * over anything there (`E_EXISTS`), never outside the folder (`E_OUTSIDE`). The file then wins, and the pick is taken out
 * (`pickCleared`: false when that could not be saved — the file still wins and the pick rests). 295-F4: `left` — files the
 * export made but could not remove (a temporary file), by full path; a refusal says them in `error.details.left`.
 */
export const workflowExport = defineRpc({ name: 'kanban.v1.workflow.export',
  input: z.strictObject({ workspaceId, template: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/) }),
  output: envelope(z.object({ path: z.string(), template: z.string(), pickCleared: z.boolean(), left: z.array(z.string()).optional() })) });

/**
 * REQ-128: the lab's message list (server/mail-list.ts) — every thread of the message folder, and one thread's files. The
 * folder is the one this host's lab names; the screen sends only its host (and a thread's id, checked to be a sub-folder of
 * it). `state: 'off'` while the lab's switch is off or no folder is set: nothing is read. Reads only, 60 s cache bound to the
 * folder's fingerprint (REQ-90's `key`), so a thread with a new file is read again at once without the screen saying so.
 */
export const mailListGet = defineRpc({ name: 'kanban.v1.mail.list', input: z.strictObject({ hostId }),
  output: envelope(mailListSchema) });
export const mailThreadGet = defineRpc({ name: 'kanban.v1.mail.thread',
  input: z.strictObject({ hostId, thread: z.string().min(1).max(255) }),
  output: envelope(mailThreadSchema) });

/**
 * REQ-52: the automatic archive of finished cards, one setting for the whole plugin — days in a completion stage before a card
 * is archived by itself (0: off). Kept in the plugin's own `auto-archive.json`, never in the ledger. A change sweeps at once.
 */
export const archiveSettingsSet = defineRpc({ name: 'kanban.v1.archive.settings.set',
  input: z.strictObject({ days: z.number().int().min(0).max(365) }),
  output: envelope(z.object({ days: z.number(), changed: z.boolean() })) });
/** REQ-52: the done column's "Tidy" — every card now in the board's completion stage archived, as the person's own act. */
export const archiveTidy = defineRpc({ name: 'kanban.v1.archive.tidy',
  input: z.strictObject({ boardId }),
  output: envelope(z.object({ archived: z.number() })) });
const archivedCard = z.object({ id: cardId, title: z.string(), stageId: z.string(), archivedAt: time,
  /** Archived by the automatic archive, not by a person. */
  auto: z.literal(true).optional(),
  /** Archived from a completion stage — finished work, counted in the progress; false for a cancelled card or a duplicate. */
  done: z.boolean() });
export type ArchivedCard = z.infer<typeof archivedCard>;
/** REQ-52: a board's archived cards, latest first (the first 300 of `total`). */
export const archivedList = defineRpc({ name: 'kanban.v1.archived.list',
  input: z.strictObject({ boardId }),
  output: envelope(z.object({ cards: z.array(archivedCard), total: z.number(), archivedDone: z.number() })) });
/** REQ-52: a person brings an archived card back to the stage it left; it then gets its full days again. */
export const archivedRestore = defineRpc({ name: 'kanban.v1.archived.restore',
  input: z.strictObject({ boardId, cardId }),
  output: envelope(z.object({ changed: z.boolean() })) });
