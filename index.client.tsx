import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { OverviewScreen } from './client/overview.js';
import { WorkspacePanel } from './client/panel.js';
function Surface(props: PluginSurfaceProps) { return <OverviewScreen {...props} key={props.host.id} />; }
export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSurface('overview', Surface),
    client.addSidebarItem({ id: 'overview', title: 'Kanban', icon: 'Columns3', surface: 'overview' }),
    client.addWorkspacePanel({ id: 'board', title: 'Kanban', icon: 'Columns3', context: 'workspace', Component: WorkspacePanel }),
    client.addCommandCenterItem({ id: 'overview', title: 'Kanban: Overview', icon: 'Columns3',
      context: 'global', onSelect: context => context.openSurface('overview') }),
    client.addCommandCenterItem({ id: 'board', title: 'Kanban: Workspace board', icon: 'Columns3',
      context: 'workspace', onSelect: context => context.openPanel('board') }),
  ];
  return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
}
