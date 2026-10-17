import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { workspaceLabelSchema, type WorkspaceLabelsDTO } from '../shared/rpc.js';
const definitionsSchema = z.array(workspaceLabelSchema);
const apiRows = z.array(z.object({ id: z.string(), labels: z.array(z.string()).optional() }));
const fileRows = z.array(z.object({ workspaceId: z.string(), labels: z.array(z.string()).optional() }));
export const noWorkspaceLabels = (): WorkspaceLabelsDTO => ({ available: false, source: 'none', definitions: [], byWorkspace: {} });
/** Optional metadata only: malformed/missing files disable the feature, never the ledger. */
export async function readWorkspaceLabels(options: {
  api?: () => Promise<unknown>; home?: string; read?: (path: string) => Promise<string>;
} = {}): Promise<WorkspaceLabelsDTO> {
  const read = options.read ?? (path => readFile(path, 'utf8'));
  const home = options.home ?? process.env.PASEO_HOME ?? join(homedir(), '.paseo');
  const json = async (name: string) => { const raw = await read(join(home, 'projects', name));
    if (raw.length > 8 * 1024 * 1024) throw new Error('Metadata too large.'); return JSON.parse(raw) as unknown; };
  try {
    let response: unknown;
    try { response = await options.api?.(); } catch { response = null; }
    const payload = z.object({ entries: apiRows, definitions: definitionsSchema.optional() }).safeParse(response);
    const definitions = payload.success && payload.data.definitions !== undefined ? payload.data.definitions
      : definitionsSchema.parse(await json('workspace-labels.json'));
    if (!definitions.length) return noWorkspaceLabels();
    let source: 'api' | 'file', entries: { id: string; labels?: string[] | undefined }[];
    if (payload.success && payload.data.entries.some(w => w.labels !== undefined)) {
      source = 'api'; entries = payload.data.entries;
    } else {
      source = 'file'; entries = fileRows.parse(await json('workspaces.json')).map(w => ({ id: w.workspaceId, labels: w.labels }));
    }
    const known = new Map(definitions.map(label => [label.name.replace(/\s+/g, ' ').trim().toLowerCase(), label.name]));
    if (known.size !== definitions.length || known.has('') || new Set(entries.map(w => w.id)).size !== entries.length) return noWorkspaceLabels();
    return { available: true, source, definitions, byWorkspace: Object.fromEntries(entries.map(w => [w.id,
      [...new Set((w.labels ?? []).map(name => known.get(name.replace(/\s+/g, ' ').trim().toLowerCase())).filter((v): v is string => !!v))]])) };
  } catch { return noWorkspaceLabels(); }
}
