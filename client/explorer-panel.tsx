import { useState } from 'react';
import { View } from 'react-native';
import type { PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { OverviewScreen } from './overview.js';
import { surfaceLayout } from './mobile-layout.js';

/** REQ-152: the sidebar's whole overview, sized by the Explorer rather than the app window.
 * The SDK has no panel-width prop. Wait for onLayout so a narrow panel never first draws a wide board.
 * Keep host navigation intact: agent links go through Paseo in the window that owns this panel.
 */
export function ExplorerPanel(props: PluginWorkspacePanelProps) {
  const [width, setWidth] = useState(0);
  return <View testID="kanban-explorer" style={{ flex: 1, minWidth: 0, minHeight: 0 }}
    onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    {width > 0 && <OverviewScreen {...props} key={props.host.id} availableWidth={width}
      layout={{ ...props.layout, compact: surfaceLayout(width, props.layout.platform) === 'mobile' }} />}
  </View>;
}
