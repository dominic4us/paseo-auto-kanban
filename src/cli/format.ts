import { createKanbanError, isKanbanError, type KanbanError } from '../../shared/core/domain.js';
import type { Result } from '../../server/core/store.js';
export function exitCode(code: string): number {
  if (['E_USAGE', 'E_VALIDATION', 'E_TRANSITION', 'E_LIMIT', 'E_ALREADY_INITIALIZED'].includes(code)) return 2;
  if (['E_NOT_FOUND', 'E_WORKSPACE_AMBIGUOUS', 'E_CARD_AMBIGUOUS', 'E_CWD_MISSING'].includes(code)) return 3;
  if (['E_REVISION_CONFLICT', 'E_REQUEST_REUSED'].includes(code)) return 4;
  if (['E_LOCK_TIMEOUT', 'E_LOCK_ACTIVE'].includes(code)) return 5;
  if (['E_CORRUPT', 'E_SCHEMA_VERSION'].includes(code)) return 7;
  return 6;
}
export function asError(error: unknown): KanbanError {
  if (isKanbanError(error)) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  return createKanbanError('E_IO', `Operation failed (${code ?? 'unknown'}).`, '', 'Check the input path, permissions, and available space.');
}
export function success(data: unknown, started: number, warnings: Result<unknown>['warnings'] = []): Result<unknown> {
  return { data,
       committed: false,
       warnings,
       meta: { io: { readFiles: 0,
       readBytes: 0,
       boardReads: 0,
       boardReadBytes: 0,
       identityReads: 0,
       identityReadBytes: 0,
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
       durationMs: performance.now() - started } };
}
function progress(value: Record<string, unknown>): string {
  const p = value.progress as { done: number; requested: number; percent: number | null };
  return `${p.done}/${p.requested} (${p.percent === null ? '—' : `${p.percent}%`})`;
}
function mutationLine(command: string, d: Record<string, unknown>): string {
  const cards = d.cardIds as string[];
  const revision = String(d.revision).split(':').at(-1);
  const names: Record<string, string> = {
    init: 'initialized', 'card add': 'added', 'card move': 'moved',
    'card update': 'updated', 'card archive': 'archived', 'card restore': 'restored',
    'card link': 'linked', 'card unlink': 'unlinked', apply: 'applied',
  };
  const verb = d.replayed ? 'replayed' : d.changed ? names[command] : 'unchanged';
  const subject = command === 'apply' ? cards.length + ' operations'
    : command === 'card add' && d.changed ? cards.join(',') : cards[0]?.slice(0, 13) ?? '';
  const destination = command === 'card move' && d.destination ? ' → ' + d.destination : '';
  return verb + (subject ? ' ' + subject : '') + destination +
    ' (rev ' + revision + ') @ ' + d.workspacePath +
    (d.exportPath ? '\nexported ' + d.exportPath : '');
}
export function human(command: string, data: unknown): string {
  const d = data as Record<string, unknown>;
  switch (command) {
    case 'help': return String(d.help).trimEnd();
    case 'version': return String(d.version);
    case 'init': case 'card add': case 'card move': case 'card update':
    case 'card archive': case 'card restore': case 'card link': case 'card unlink':
    case 'apply': return mutationLine(command, d);
    case 'rev': return String(d.revision);
    // REQ-84: `busy card_a1b2c3d4-… "Testing" since … by cli`, or `busy off card_…` (`unchanged` when nothing moved).
    case 'card busy': case 'card busy off': {
      const mark = d.busy as { text: string; since: string; by: string } | null;
      return (d.changed ? '' : 'unchanged ') + (mark ? 'busy ' + String(d.cardId).slice(0, 13) + ' "' + mark.text + '" since ' + mark.since + ' by ' + mark.by
        : 'busy off ' + String(d.cardId).slice(0, 13)) + ' @ ' + d.workspacePath;
    }
    case 'export': return 'output ' + d.status + ' @ ' + d.workspacePath +
      (d.exportPath ? '\nexported ' + d.exportPath : '');
    case 'unlock': return (d.unlocked ? 'unlocked' : 'unchanged') + ' scope=' + d.scope;
    case 'doctor': return (d.checks as {
      status: string; code: string; target: string; nextAction: string;
    }[]).map(c => c.status + ' ' + c.code + ' ' + c.target +
      (c.nextAction ? ' | Next: ' + c.nextAction : '')).join('\n');
    case 'ls all': {
      const boards = d.boards as Record<string, unknown>[];
      const attention = d.needsHuman as Record<string, unknown>[];
      return [...boards.map(b => String(b.id).slice(0, 14) + ' ' + String(b.workspaceId).slice(0, 14) + ' ' + progress(b) +
        ' ' + b.workspaceStatus + ' ' + b.cwd), 'Needs human:',
        ...attention.map(c => '  ' + String(c.cardId).slice(0, 13) + ' ' + c.title +
          ' [' + (c.reasons as string[]).join(',') + ']')].join('\n');
    }
    case 'ls': {
      const b = d.summary as Record<string, unknown>;
      const stages = d.stages as { stageId: string; name: string; cards: Record<string, unknown>[] }[];
      return ['@ ' + b.cwd + ' progress=' + progress(b), ...stages.flatMap(stage => [
        stage.stageId + ' (' + stage.name + '):',
        ...stage.cards.map(card => '  ' + String(card.id).slice(0, 13) + ' ' + card.title +
          ' [' + card.intent + '/' + card.priority + (card.blocked ? '/blocked' : '') + ']' +
          (card.awaiting ? ' awaiting=' + card.awaiting : '') +
          (card.nextAction ? ' next=' + card.nextAction : '')),
      ])].join('\n');
    }
    case 'template ls': return (data as { id: string; version: number; name: string; stageCount: number }[])
      .map(t => t.id + '@' + t.version + ' ' + t.name + ' (' + t.stageCount + ' stages)').join('\n');
    case 'ls full': case 'card show': case 'template show': return JSON.stringify(data, null, 2);
    default: throw createKanbanError('E_USAGE', 'Unknown output command.', command);
  }
}
export function printSuccess(command: string, outcome: Result<unknown>, json: boolean): void {
  for (const w of outcome.warnings) process.stderr.write(`${w.code}: ${w.message} [${w.target}] Next: ${w.nextAction}\n`);
  process.stdout.write(json ? JSON.stringify({ ok: true, ...outcome }) + '\n' : human(command, outcome.data) + '\n');
}
export function printError(error: KanbanError, json: boolean): void {
  process.stderr.write(`${error.code}: ${error.message}${error.target ? ` [${error.target}]` : ''} Next: ${error.nextAction}\n`);
  if (json) process.stdout.write(JSON.stringify({ ok: false,
       error: { code: error.code,
       message: error.message,
       target: error.target,
       nextAction: error.nextAction,
       details: error.details },
       committed: error.committed }) + '\n');
  process.exitCode = exitCode(error.code);
}
