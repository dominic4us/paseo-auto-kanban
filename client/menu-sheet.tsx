import type { ReactNode } from 'react';
import type { Palette } from './palette.js';
import type { HostPlatform } from './layout.js';
import { KanbanSheet } from './kanban-sheet.js';
import { px } from './ui-scale.js';
/**
 * REQ-72: a Kanban sheet (`KanbanSheet`) on every platform — from the bottom on a phone and below 760px, a
 * centred window wider — so the sheet and what is in it take the chosen theme. The content still gets its
 * colours from the sheet; they are the screen's now.
 */
export function MenuSheet({ title, open, onClose, onDismiss, colors, platform, closeLabel, children }: {
  title: string; open: boolean; onClose: () => void; onDismiss?: () => void; colors: Palette; platform: HostPlatform; closeLabel: string; children: (colors: Palette) => ReactNode;
}) {
  // REQ-68: no version footer — the version is in the settings window's About, the screens' ⋯ that carried it are gone.
  return <KanbanSheet testID="menu-sheet" title={title} open={open} onClose={onClose} onDismiss={onDismiss} colors={colors}
    platform={platform} closeLabel={closeLabel} width={px(520)}>{children(colors)}</KanbanSheet>;
}
