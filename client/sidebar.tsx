import type { ComponentType } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import type { PluginClientContext, PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon } from '@getpaseo/plugin/client/react-native';
import { noteSidebarPanel, readOpenLocation } from './open-location.js';

// Optional 0.11 sidebar contract only; keep compiling against SDK 0.9.1 and importing old host modules.
type SidebarProps = Pick<PluginSurfaceProps, 'theme' | 'host' | 'layout'> & {
  currentScreen?: { screenId: string } | null;
  openScreen(input: { screenId: string }): void;
};
type SidebarRegistration = (item: { id: string; title: string; Component: ComponentType<SidebarProps> }) => () => void;
type SidebarHost = PluginClientContext & {
  addSidebarHeaderItem?: SidebarRegistration;
  addSidebarFooterItem?: SidebarRegistration;
};

/** No public active-workspace getter exists. Read only a current, same-host opaque workspace route.
 * Never use a remembered workspace or Linking.getInitialURL (stale after navigation on the web).
 * Missing browser state, legacy encoded routes and native clients deliberately fall back to the overview.
 */
function currentWorkspace(hostId: string): string | null {
  try {
    const environment = globalThis as { window?: { location?: { pathname?: string } } };
    const match = environment.window?.location?.pathname?.match(/^\/h\/([^/]+)\/workspace\/([^/]+)\/?$/);
    if (!match || decodeURIComponent(match[1]!) !== hostId) return null;
    const id = decodeURIComponent(match[2]!);
    return /^wks_[a-zA-Z0-9_-]+$/.test(id) ? id : null;
  } catch { return null; }
}

export function registerKanbanSidebar(client: PluginClientContext): () => void {
  const host = client as SidebarHost;
  // Native apps retain the exact legacy contribution, even when their runtime has the new API.
  const register = Platform.OS === 'web'
    ? typeof host.addSidebarHeaderItem === 'function' ? host.addSidebarHeaderItem
      : typeof host.addSidebarFooterItem === 'function' ? host.addSidebarFooterItem : null
    : null;
  if (!register) return client.addSidebarItem({ id: 'overview', title: 'Kanban', icon: 'Columns3', surface: 'overview' });
  function KanbanItem(props: SidebarProps) {
    const open = () => {
      // REQ-158: the main screen unless this device chose the right panel; read at each press, so a change applies at once.
      if (props.layout.platform === 'web' && !props.layout.compact && readOpenLocation(props.host.id) === 'panel') {
        const workspaceId = currentWorkspace(props.host.id);
        try {
          // SDK ref(id) creates a new empty handle; the host's openPanel validates its own workspace state.
          if (workspaceId) {
            client.openPanel('explorer', { workspaceId, location: 'explorer' });
            return;
          }
        } catch { /* Route/host context changed or Explorer unavailable: keep the normal Kanban reachable. */ }
      }
      // The sidebar's host callback also closes compact navigation, even when overview is already open.
      props.openScreen({ screenId: 'overview' });
    };
    return <Pressable testID="kanban-sidebar" accessibilityRole="button" accessibilityLabel="Kanban" onPress={open}
      style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 8,
        backgroundColor: props.currentScreen?.screenId === 'overview' ? props.theme.colors.surface2 : 'transparent' }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Icon name="Columns3" size={18} color={props.theme.colors.foregroundMuted} />
        <Text style={{ color: props.theme.colors.foreground, fontSize: 14 }}>Kanban</Text>
      </View>
    </Pressable>;
  }
  // Prefer the header (the old item's position); use a footer-only host once, never register both.
  const remove = register.call(client, { id: 'overview', title: 'Kanban', Component: KanbanItem });
  // REQ-158: only this menu can open the right panel, so the settings offer the choice while it is registered.
  noteSidebarPanel(true);
  return () => { noteSidebarPanel(false); remove(); };
}
