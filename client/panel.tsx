import { useWorkspace, type PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { BoardScreen } from './board.js';
import { SignalContext } from './signal-context.js';
import { useLiveSignals } from './agent-signals.js';
// Only this panel wrapper depends on the host's workspace-state provider.
export function WorkspacePanel(props: PluginWorkspacePanelProps) {
  const title = useWorkspace(props.workspaceId, workspace => workspace.title || workspace.name);
  // The panel shares the surface's signal store for this host: one subscription, two screens.
  const signals = useLiveSignals(props.host.id, true);
  return <SignalContext.Provider value={signals}>
    <BoardScreen {...props} key={`${props.host.id}:${props.workspaceId}`}
      panel workspaceTitle={title ?? undefined} selector={{ workspaceId: props.workspaceId }} />
  </SignalContext.Provider>;
}
