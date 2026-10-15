#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { openStore, canonicalPath, type Store, type Result, type InitInput } from '../../server/core/store.js';
import { exportBoard, exportCommittedBoard, inspectExport, readInputJson } from '../../server/core/export.js';
import { boardView, summarizeBoard, isUUID, isBoardId, isWorkspaceId, isKanbanError, fail, validateActor, type Actor, type Operation } from '../../shared/core/domain.js';
import { commandHelp, rootHelp, VERSION } from './help.js';
import { asError, exitCode, printError, printSuccess, success } from './format.js';
import { busyText, pruneAfterWrite, setBusy } from '../../server/busy.js';

const strings = ['workspace',
     'data-dir',
     'if-revision',
     'request-id',
     'template',
     'workspace-id',
     'paseo-map',
     'show-template',
     'title',
     'stage',
     'criteria',
     'notes',
     'priority',
     'blocked-reason',
     'next-action',
     'intent',
     'awaiting',
     'to',
     'agent',
     'role',
     'label',
     'by'];
const booleans = ['json', 'help', 'version', 'list-templates', 'all', 'full', 'clear-blocked', 'clear-deliverables', 'archive', 'restore', 'remove', 'force', 'global', 'off'];
const common = ['workspace', 'data-dir', 'json', 'help'];
const guards = ['if-revision', 'request-id'];
const fields = ['title', 'criteria', 'notes', 'priority', 'blocked-reason', 'next-action', 'intent', 'awaiting', 'deliverable'];
const permitted: Record<string, string[]> = {
  init: [...guards, 'template', 'workspace-id', 'paseo-map', 'list-templates', 'show-template'],
  rev: [], ls: ['all', 'full'], 'card add': [...guards, ...fields, 'stage'],
  'card move': [...guards, 'to'], 'card update': [...guards, ...fields, 'clear-blocked', 'clear-deliverables', 'archive', 'restore'],
  'card link': [...guards, 'agent', 'role', 'label', 'remove'], 'card show': [], 'card busy': ['off', 'by'], apply: guards,
  export: [], doctor: [], unlock: ['force', 'global'],
};
type Values = Record<string, string | boolean | string[] | undefined>;
function usage(message: string, target = ''): never { return fail('E_USAGE', message, target, `Run kanban ${Object.hasOwn(commandHelp, target) ? target + ' ' : ''}--help.`); }
function string(values: Values,
     name: string): string | undefined { const v = values[name];
     if (v === undefined) return undefined;
     if (typeof v !== 'string') usage(`Expected a string for --${name}.`);
     return v;
     }
function required(values: Values, name: string, command: string): string { const v = string(values, name); if (v === undefined) usage(`Missing --${name}.`, command); return v; }
function actor(): Actor {
  const id = process.env.PASEO_AGENT_ID;
  const result: Actor = id === undefined ? { kind: 'user' } : { kind: 'agent', agentId: id };
  validateActor(result); return result;
}
function paired(values: Values, a: string, b: string, command: string): void { if (values[a] !== undefined && values[b] !== undefined) usage(`--${a} and --${b} cannot be combined.`, command); }
function patch(values: Values): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [flag,
       field] of Object.entries({ title: 'title',
       criteria: 'acceptanceCriteria',
       notes: 'notes',
       priority: 'priority',
       'blocked-reason': 'blockedReason',
       'next-action': 'nextAction',
       intent: 'intent',
       awaiting: 'awaiting' })) {
    const value = string(values, flag); if (value !== undefined) result[field] = flag === 'awaiting' && value === 'none' ? null : value;
  }
  if (values['clear-blocked']) result.blockedReason = null;
  if (values.deliverable !== undefined) result.deliverables = values.deliverable;
  if (values['clear-deliverables']) result.deliverables = [];
  return result;
}
async function initialInput(store: Store, values: Values): Promise<InitInput> {
  const explicit = string(values, 'workspace'); const environmentPath = process.env.PASEO_AGENT_CWD;
  const externalId = string(values, 'workspace-id'); const map = string(values, 'paseo-map');
  paired(values, 'workspace-id', 'paseo-map', 'init');
  if (externalId !== undefined && !/^wks_[A-Za-z0-9_-]{1,128}$/.test(externalId)) usage('--workspace-id must be a Paseo workspace id.', 'init');
  let cwd: string;
  if (explicit !== undefined && (isBoardId(explicit) || isWorkspaceId(explicit))) cwd = (await store.resolveWorkspace(explicit)).cwd;
  else if (explicit !== undefined) cwd = await canonicalPath(explicit);
  else if (environmentPath !== undefined) {
    // canonicalPath accepts relative CLI paths; the agent environment must be explicit and absolute.
    if (!/^(\/|[A-Za-z]:[\\/])/.test(environmentPath)) usage('PASEO_AGENT_CWD must be absolute.', 'init');
    cwd = await canonicalPath(environmentPath);
  } else {
    cwd = await canonicalPath(process.cwd());
    if (externalId === undefined && map === undefined) {
      try { cwd = (await store.resolveWorkspace(cwd)).cwd; }
      catch (error) { if (!(isKanbanError(error) && error.code === 'E_NOT_FOUND')) throw error; }
    }
  }
  const selected = map === undefined ? {} : await store.readWorkspaceMap(map, cwd);
  const revision = string(values, 'if-revision'); if (revision !== undefined && revision !== '0') usage('Initialization accepts only revision 0.', 'init');
  return { cwd, actor: actor(), requestId: string(values, 'request-id') ?? store.context.newId(), ...selected,
    ...(externalId === undefined ? {} : { workspaceId: externalId }),
    ...(string(values, 'template') === undefined ? {} : { template: string(values, 'template')! }),
    ...(revision === undefined ? {} : { ifRevision: '0' as const }) };
}
async function resolveId(store: Store, values: Values, allowDamaged = false): Promise<string> {
  const explicit = string(values, 'workspace');
  if (allowDamaged && explicit !== undefined && isBoardId(explicit)) return explicit;
  return (await store.resolveCurrentIdentity(explicit)).id;
}
/**
 * REQ-84: `card busy CARD "TEXT"` marks work that is not an agent's turn (a test run, a build) on the card; `--off` ends it.
 * The mark is kept in the data folder's `busy.json`, never in the ledger (server/busy.ts). It is set while the board's lock
 * is held, so the card it names exists and is not archived at that moment; marking again replaces the words and the time.
 */
async function busy(store: Store, id: string, args: string[], values: Values): Promise<Result<unknown>> {
  const off = !!values.off, raw = args[1];
  if (off && values.by !== undefined) usage('--by cannot be combined with --off.', 'card busy');
  const text = off ? null : busyText(raw!);
  if (!off && text === null) fail('E_VALIDATION', 'Busy text must be 1-200 characters.', 'text', 'Say what is running, for example "Testing".');
  const by = (string(values, 'by') ?? process.env.PASEO_AGENT_ID ?? 'cli').trim();
  if (!by || by.length > 256) usage('--by must be 1-256 characters.', 'card busy');
  const cardId = await store.resolveCardPrefix(id, args[0]!);
  return store.withBoardLock(id, async board => {
    const card = board.cards.find(c => c.id === cardId)!;
    if (!off && card.archivedAt !== null) fail('E_VALIDATION', 'Archived cards cannot be marked busy.', cardId, 'Restore the card first.');
    const active = new Set(board.cards.filter(c => c.archivedAt === null).map(c => c.id));
    const result = await setBusy(store.dataDir, id, cardId, text === null ? null : { text, since: store.context.now(), by }, { active });
    return { boardId: id, cardId, busy: result.busy, changed: result.changed, workspacePath: board.cwd };
  });
}
/** REQ-84: a card archived by this command keeps no busy mark, nor (REQ-108 ④) the end of one; never fails the change itself. */
async function pruneAfter(store: Store, boardId: string): Promise<void> {
  await pruneAfterWrite(store.dataDir, boardId, async () => (await store.readBoard(boardId)).cards);
}
async function executeWithStore(store: Store, command: string, args: string[], values: Values, started: number): Promise<Result<unknown>> {

  if (command === 'init') {
    paired(values, 'list-templates', 'show-template', command);
    if (values['list-templates'] || values['show-template'] !== undefined) {
      if (['workspace', ...guards, 'template', 'workspace-id', 'paseo-map'].some(k => values[k] !== undefined)) usage('Template inspection cannot be combined with board creation options.', command);
      return success(values['list-templates'] ? (await store.listTemplates()).map(t => ({ id: t.id,
           version: t.version,
           name: t.name,
           stageCount: t.stages.length })) : await store.readTemplate(string(values,
           'show-template')!),
           started);
    }
    const outcome = await store.initBoard(await initialInput(store, values)); outcome.data.export ??= 'skipped'; return outcome;
  }
  if (command === 'ls' && values.all) {
    if (values.full || values.workspace !== undefined) usage('--all cannot be combined with --full or --workspace.', command);
    const boards = await store.listBoards(); const views = boards.map(b => boardView(b));
    const warnings = (await Promise.all(boards.map(b => store.boardWarnings(b.id)))).flat();
    return success({ boards: boards.map(summarizeBoard), needsHuman: views.flatMap(v => v.needsHuman) }, started, warnings);
  }
  if (command === 'unlock' && values.global) {
    if (values.workspace !== undefined) usage('--global cannot be combined with --workspace.', command);
    return store.unlock(undefined, { global: true, force: !!values.force, offline: !!values.force });
  }
  const id = await resolveId(store, values, command === 'doctor' || command === 'unlock');
  if (command === 'rev') return success({ boardId: id, revision: await store.getRevision(id) }, started);
  if (command === 'ls') return success(boardView(await store.readBoard(id), !!values.full), started, await store.boardWarnings(id));
  if (command === 'card show') {
    const cardId = await store.resolveCardPrefix(id, args[0]!); const board = await store.readBoard(id);
    return success({ boardId: id,
         revision: board.revision,
         card: board.cards.find(c => c.id === cardId),
         history: board.history.filter(h => h.cardId === cardId) },
         started,
         await store.boardWarnings(id));
  }
  if (command === 'card busy') return busy(store, id, args, values);
  if (command === 'export') {
    const outcome = await exportBoard(store, id);
    if (outcome.data.status === 'failed') fail('E_EXPORT', 'The output could not be refreshed; existing files were preserved.', id, 'Review the reported warnings and retry export.', outcome);
    return outcome;
  }
  if (command === 'doctor') {
    const outcome = await store.doctor(id);
    if (!outcome.data.checks.some(c => c.status === 'error')) {
      const output = await inspectExport(store, id); outcome.warnings.push(...output.warnings);
      if (output.status === 'written') outcome.warnings.push({ code: 'W_EXPORT_STALE',
           message: 'Generated output is missing or behind the ledger.',
           target: id,
           nextAction: `Run kanban export --workspace ${id}.` });
    }
    const errors = outcome.data.checks.filter(c => c.status === 'error').sort((a, b) => exitCode(b.code) - exitCode(a.code));
    if (errors[0]) fail(errors[0].code, errors[0].message, errors[0].target, errors[0].nextAction, outcome.data);
    return outcome;
  }
  if (command === 'unlock') return store.unlock(id, { force: !!values.force, offline: !!values.force });
  let requestId: unknown = string(values, 'request-id'); let ifRevision: unknown = string(values, 'if-revision'); let operations: unknown[];
  if (command === 'apply') {
    const input = await readInputJson(args[0]!);
    if (!input || typeof input !== 'object' || Array.isArray(input)) usage('Expected a JSON batch object.', command);
    const batch = input as Record<string, unknown>;
    for (const key of Object.keys(batch)) if (!['requestId', 'ifRevision', 'operations'].includes(key)) usage(`Unknown batch field: ${key}.`, command);
    if (Object.hasOwn(batch,
         'requestId') && requestId !== undefined || Object.hasOwn(batch,
         'ifRevision') && ifRevision !== undefined) usage('A guard may appear in the file or the CLI, not both.',
         command);
    requestId = Object.hasOwn(batch, 'requestId') ? batch.requestId : requestId;
    ifRevision = Object.hasOwn(batch, 'ifRevision') ? batch.ifRevision : ifRevision;
    if (!Array.isArray(batch.operations)) usage('Batch operations must be an array.', command);
    operations = batch.operations;
  } else if (command === 'card add') {
    required(values, 'title', command);
    operations = [{ op: 'add', ...patch(values), ...(string(values, 'stage') === undefined ? {} : { stageId: string(values, 'stage') }) }];
  } else {
    const cardId = await store.resolveCardPrefix(id, args[0]!);
    if (command === 'card move') operations = [{ op: 'move', id: cardId, to: required(values, 'to', command) }];
    else if (command === 'card update') {
      paired(values, 'archive', 'restore', command); paired(values, 'clear-blocked', 'blocked-reason', command); paired(values, 'clear-deliverables', 'deliverable', command);
      const update = patch(values);
      if (values.archive || values.restore) { if (Object.keys(update).length) usage('Archive/restore cannot be combined with field changes.',
           command);
           operations = [{ op: values.archive ? 'archive' : 'restore',
           id: cardId }];
           }
      else { if (!Object.keys(update).length) usage('At least one update field is required.', command); operations = [{ op: 'update', id: cardId, patch: update }]; }
    } else {
      if (values.remove && (values.role !== undefined || values.label !== undefined)) usage('--remove cannot be combined with --role or --label.', command);
      operations = [{ op: values.remove ? 'unlink' : 'link', id: cardId, agentId: required(values, 'agent', command),
        ...(values.role === undefined ? {} : { role: string(values, 'role') }), ...(values.label === undefined ? {} : { label: string(values, 'label') }) }];
    }
  }
  for (const operation of operations) {
    if (operation && typeof operation === 'object' && !Array.isArray(operation) && Object.hasOwn(operation, 'id')) {
      const op = operation as Record<string, unknown>; if (typeof op.id === 'string' && !isUUID(op.id.slice(5))) op.id = await store.resolveCardPrefix(id, op.id);
    }
  }
  if (requestId === undefined) requestId = store.context.newId();
  if (!isUUID(requestId)) fail('E_VALIDATION', 'requestId must be a UUID.', 'requestId');
  if (ifRevision !== undefined && typeof ifRevision !== 'string') fail('E_VALIDATION', 'ifRevision must be a revision string.', 'ifRevision');
  const outcome = await store.mutateBoard(id, { actor: actor(), requestId, operations: operations as Operation[], ...(ifRevision === undefined ? {} : { ifRevision: ifRevision as string }) });
  outcome.data.export ??= 'skipped'; return outcome;
}
function outputCommand(command: string, values: Values): string {
  if (command === 'init' && values['list-templates']) return 'template ls';
  if (command === 'init' && values['show-template']) return 'template show';
  if (command === 'ls' && values.all) return 'ls all';
  if (command === 'ls' && values.full) return 'ls full';
  if (command === 'card update' && values.archive) return 'card archive';
  if (command === 'card update' && values.restore) return 'card restore';
  if (command === 'card link' && values.remove) return 'card unlink';
  if (command === 'card busy' && values.off) return 'card busy off';
  return command;
}
async function execute(command: string, args: string[], values: Values,
  started: number): Promise<Result<unknown>> {
  const store = await openStore({ ...(string(values, 'data-dir') === undefined ? {} : { dataDir: string(values, 'data-dir')! }), afterCommit: exportCommittedBoard });
  const outcome = await executeWithStore(store, command, args, values, started);
  const data = outcome.data as Record<string, unknown>;
  if (['card update', 'apply'].includes(command) && outcome.committed && typeof data.boardId === 'string') await pruneAfter(store, data.boardId);
  if (['init', 'card add', 'card move', 'card update', 'card link', 'apply', 'export'].includes(command)
      && typeof data.boardId === 'string') {
    const identity = await store.readIdentity(data.boardId);
    data.workspacePath = identity.cwd;
    if (command === 'card move') data.destination = string(values, 'to');
    if (outcome.meta.io.exportWrites > 0) data.exportPath = identity.cwd.replace(/[\\/]$/, '') + '/PROCESS.md';
  }
  Object.assign(outcome.meta.io, store.readMetrics());
  outcome.meta.durationMs = performance.now() - started;
  return outcome;
}
async function main(): Promise<void> {
  const started = performance.now(); const raw = process.argv.slice(2); let json = raw.includes('--json');
  try {
    const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = {};
    for (const name of strings) options[name] = { type: 'string' };
    for (const name of booleans) options[name] = { type: 'boolean' };
    options.help = { type: 'boolean', short: 'h' }; options.deliverable = { type: 'string', multiple: true };
    let parsed; try { parsed = parseArgs({ args: raw, options, allowPositionals: true, strict: true, tokens: true }); }
    catch (error) { usage(error instanceof Error ? error.message : 'Invalid arguments.'); }
    const values = parsed.values as Values; json = !!values.json;
    const used = new Set<string>();
    for (const token of parsed.tokens) if (token.kind === 'option') { if (used.has(token.name) && token.name !== 'deliverable') usage(`Option --${token.name} was repeated.`); used.add(token.name); }
    const positions = [...parsed.positionals]; let command = positions.shift() ?? '';
    if (command === 'list') command = 'ls';
    if (command === 'card') { const sub = positions.shift();
         if (sub === undefined && values.help) { printSuccess('help',
         success({ help: Object.entries(commandHelp).filter(([name]) => name.startsWith('card ')).map(([name]) => `kanban ${name} --help`).join('\n') },
         started),
         json);
         return;
         } command += ` ${sub ?? ''}`;
         }
    if (!command) {
      for (const name of used) if (![...common, 'version'].includes(name)) usage(`--${name} requires a command.`);
      if (values.version && values.help) usage('--version and --help cannot be combined.');
      printSuccess(values.version ? 'version' : 'help', success(values.version ? { version: VERSION, schemaVersion: 1 } : { help: rootHelp }, started), json); return;
    }
    if (!permitted[command]) usage('Unknown command.', command);
    for (const name of used) if (![...common, ...permitted[command]!].includes(name)) usage(`--${name} is not valid for this command.`, command);
    if (values.help) { printSuccess('help', success({ help: commandHelp[command]! }, started), json); return; }
    for (const name of ['workspace', 'data-dir', 'workspace-id', 'paseo-map', 'template', 'show-template', 'if-revision', 'request-id', 'to', 'agent', 'by']) {
      const value = string(values, name); if (value !== undefined && !value.trim()) usage(`--${name} cannot be empty.`, command);
    }
    // REQ-84: `card busy CARD "TEXT"`, or `card busy CARD --off` — the text is what the card shows, so it is required.
    const expected = command === 'card busy' ? values.off ? 1 : 2 : ['card move', 'card update', 'card link', 'card show', 'apply'].includes(command) ? 1 : 0;
    if (command === 'card busy' && values.off && positions.length === 2) usage('--off takes no text.', command);
    if (command === 'card busy' && !values.off && positions.length === 1) usage('Say what is running, for example "Testing", or use --off.', command);
    if (positions.length !== expected) usage(`Expected ${expected} positional argument(s).`, command);
    printSuccess(outputCommand(command, values), await execute(command, positions, values, started), json);
  } catch (error) { printError(asError(error), json); }
}
await main();
