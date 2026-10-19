import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { OverviewScreen } from './client/overview.js';
import { WorkspacePanel } from './client/panel.js';
import { ExplorerPanel } from './client/explorer-panel.js';
import { registerKanbanSidebar } from './client/sidebar.js';
import { Platform } from 'react-native';
function Surface(props: PluginSurfaceProps) { return <OverviewScreen {...props} key={props.host.id} />; }
export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addSurface('overview', Surface),
    registerKanbanSidebar(client),
    client.addWorkspacePanel({ id: 'board', title: 'Kanban', icon: 'Columns3', context: 'workspace', Component: WorkspacePanel }),
    client.addWorkspacePanel({ id: 'explorer', title: 'Kanban', icon: 'Columns3', context: 'workspace', locations: ['explorer'], Component: ExplorerPanel }),
    client.addCommandCenterItem({ id: 'overview', title: 'Kanban: Overview', icon: 'Columns3',
      context: 'global', onSelect: context => context.openSurface('overview') }),
    client.addCommandCenterItem({ id: 'board', title: 'Kanban: Workspace board', icon: 'Columns3',
      context: 'workspace', onSelect: context => context.openPanel('board') }),
  ];
  if (Platform.OS === 'web') cleanups.push(client.addCommandCenterItem({
    id: 'explorer', title: 'Kanban: Open in right panel', icon: 'Columns3', context: 'workspace',
    onSelect: context => context.openPanel('explorer', { location: 'explorer' }),
  }));
  return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
}
