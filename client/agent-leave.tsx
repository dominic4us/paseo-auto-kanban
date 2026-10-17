import { useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { KanbanSheet } from './kanban-sheet.js';
import { Button } from './components.js';
import { readable, type Palette } from './palette.js';
import type { HostPlatform } from './layout.js';
import type { Copy } from './i18n.js';
import { px } from './ui-scale.js';
import { leavesWorkspace, type GuardedOpen } from './agent-jump.js';
import { useSignalSource } from './signal-context.js';

type OpenAgent = (input: { agentId: string }) => void;
/**
 * REQ-142: "Go to agent" through `leavesWorkspace` — at once when the agent's own workspace (the screen's signal source,
 * `SignalSource.workspace`) is the screen's, else after the sheet's [Open]; an agent not known there asks too.
 */
export function useAgentLeave({ openAgent, here, colors, m, platform, mobile }: {
  openAgent: OpenAgent | undefined; here: string | undefined; colors: Palette; m: Copy; platform: HostPlatform; mobile: boolean;
}): { open: GuardedOpen | undefined; sheet: ReactNode } {
  const [asking, setAsking] = useState<string | null>(null), signals = useSignalSource();
  const open: GuardedOpen | undefined = openAgent ? agentId => {
    if (leavesWorkspace(here, signals.workspace?.(agentId))) setAsking(agentId); else openAgent({ agentId });
  } : undefined;
  const sheet = asking && openAgent ? <AgentLeaveSheet colors={colors} m={m} platform={platform} mobile={mobile}
    onCancel={() => setAsking(null)} onOpen={() => { const agentId = asking; setAsking(null); openAgent({ agentId }); }} /> : null;
  return { open, sheet };
}
export function AgentLeaveSheet({ colors: c, m, platform, mobile, onCancel, onOpen }: {
  colors: Palette; m: Copy; platform: HostPlatform; mobile: boolean; onCancel: () => void; onOpen: () => void;
}) {
  return <KanbanSheet testID="agent-leave-sheet" title={m.goToAgent} open onClose={onCancel} colors={c} platform={platform}
    closeLabel={m.close} width={px(440)}>
    <Text testID="agent-leave-text" style={{ color: c.foreground, fontSize: px(14), lineHeight: px(20) }}>{m.agentLeaveText}</Text>
    <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: px(8), paddingTop: px(8) }}>
      <Button testID="agent-leave-cancel" label={m.cancel} colors={c} mobile={mobile} onPress={onCancel} />
      <Pressable testID="agent-leave-open" accessibilityRole="button" accessibilityLabel={m.agentLeaveOpen} onPress={onOpen}
        style={{ minHeight: mobile ? px(44) : px(30), minWidth: px(88), paddingHorizontal: px(14), borderRadius: px(6),
          alignItems: 'center', justifyContent: 'center', backgroundColor: c.accent }}>
        <Text style={{ color: readable(c.accentForeground, c.accent), fontSize: px(13), fontWeight: '600' }}>{m.agentLeaveOpen}</Text>
      </Pressable>
    </View>
  </KanbanSheet>;
}
