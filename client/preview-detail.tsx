import { Text, View } from 'react-native';
import type { BoardCardDTO, BoardDTO } from '../shared/rpc.js';
import { Field, Notice } from './components.js';
import { AssigneeRow } from './status-icon.js';
import { MenuSheet } from './menu-sheet.js';
import type { Palette } from './palette.js';
import type { Copy } from './i18n.js';
import type { HostPlatform } from './layout.js';
import { px } from './ui-scale.js';
export function PreviewDetail({ board, card, colors, m, platform, onClose }: {
  board: BoardDTO; card: BoardCardDTO; colors: Palette; m: Copy; platform: HostPlatform; onClose: () => void;
}) {
  return <MenuSheet title={m.demo + ' · ' + m.detail} open onClose={onClose} colors={colors} platform={platform} closeLabel={m.close}>{sc => <>
    <Notice text={m.demoReadOnly} colors={sc} />
    <Field label={m.title} colors={sc}>{card.title}</Field>
    <Field label={m.stage} colors={sc}>{board.template.stages.find(s => s.stageId === card.stageId)?.name ?? card.stageId}</Field>
    <Field label={m.nextAction} colors={sc}>{card.nextAction || m.none}</Field>
    <Field label={m.priority} colors={sc}>{m[card.priority]}</Field>
    <Field label={m.agents} colors={sc}><View style={{ gap: px(4) }}>
      {!card.agentIds.length && <Text style={{ color: sc.foregroundMuted }}>{m.none}</Text>}
      {card.agentIds.map(agentId => <View key={agentId} style={{ gap: px(2) }}>
        <AssigneeRow label={board.agentLabels[agentId]} agentId={agentId} colors={sc} m={m} />
      </View>)}
    </View></Field>
  </>}
  </MenuSheet>;
}
