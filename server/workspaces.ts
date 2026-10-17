import type { PluginHandlerContext } from '@getpaseo/plugin/server';

/** What the plugin needs from a Paseo workspace: its identity and the directory PROCESS.md belongs in. */
export interface ActiveWorkspace { id: string; cwd: string; labels: string[] }
type WorkspaceApi = Pick<PluginHandlerContext['paseo'], 'workspaces'>;
/** The raw list entries, kept as-is so the label reader still sees the shape it validates. */
export interface WorkspaceListing { entries: { id: string; labels?: string[] | undefined }[]; active: ActiveWorkspace[];
  /** REQ-138 (320 J2): every live workspace id, with a folder or not — one listed without its folder still has its board. */
  liveIds?: string[] }

const isWorkspaceId = (value: unknown): value is string =>
  typeof value === 'string' && /^(wks_[A-Za-z0-9_-]{1,128}|local_[0-9a-f]{64})$/.test(value);

/**
 * One paged read per overview request — the same call the workspace labels already needed, so REQ-57
 * costs no extra round trip and adds no polling. `workspaces.list` only returns live workspaces, and
 * anything the daemon has started archiving is dropped here as well.
 */
export async function listWorkspaces(paseo: WorkspaceApi): Promise<WorkspaceListing> {
  const entries: { id: string; labels?: string[] | undefined }[] = [];
  const active: ActiveWorkspace[] = [], liveIds: string[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await paseo.workspaces.list({ page: { limit: 100, ...(cursor ? { cursor } : {}) } });
    for (const raw of page.entries) {
      const value = raw as unknown as { id?: unknown; labels?: unknown; archivingAt?: unknown;
        archivedAt?: unknown; workspaceDirectory?: unknown; projectRootPath?: unknown };
      entries.push({ id: String(value.id ?? ''),
        ...(Array.isArray(value.labels) ? { labels: value.labels.filter((v): v is string => typeof v === 'string') } : {}) });
      if (!isWorkspaceId(value.id) || value.archivingAt || value.archivedAt) continue;
      liveIds.push(value.id);
      const cwd = typeof value.workspaceDirectory === 'string' && value.workspaceDirectory
        ? value.workspaceDirectory : typeof value.projectRootPath === 'string' ? value.projectRootPath : '';
      if (!cwd) continue;
      active.push({ id: value.id, cwd,
        labels: Array.isArray(value.labels) ? value.labels.filter((v): v is string => typeof v === 'string') : [] });
    }
    cursor = page.pageInfo.nextCursor ?? undefined;
    if (cursor && seen.has(cursor)) throw new Error('Workspace pagination did not advance.');
    if (cursor) seen.add(cursor);
  } while (cursor);
  return { entries, active, liveIds };
}
