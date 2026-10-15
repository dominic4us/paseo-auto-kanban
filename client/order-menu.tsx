import { useRef, useState } from 'react';
import type { View } from 'react-native';
import { Button, IconButton } from './components.js';
import { MenuSheet } from './menu-sheet.js';
import { PopoverMenu, PopoverRow, usePopover } from './popover-menu.js';
import type { MoveDirection } from './order-model.js';
import type { HostPlatform } from './layout.js';
import type { Palette } from './palette.js';
import type { Copy } from './i18n.js';

/**
 * REQ-59 ①: the ⋯ beside a project or workspace heading. Three moves and, where a whole group can be
 * released at once, the way back to the automatic order. An item that cannot move — the row is already
 * at the top or the bottom of its group — is disabled rather than hidden, so the menu never changes
 * shape under the pointer. The sheet is the same one the screen's ⋯ uses, so 390px gets it for free.
 * REQ-111: on a wide web screen the same items hang in a small menu right under the ⋯, as a card's ⋯ opens its own
 * (REQ-85 ⑧); a phone — and a touch screen — keeps the sheet, as a card's long press does.
 */
export function OrderMenu({ name, canUp, canDown, onMove, onReset, canReset = true, onOpenBoard, onDraft, onWorkflow, onTryWorkflow, onArchived, colors, m, platform, mobile = false,
  disabled = false, testID = 'order-menu' }: {
  name: string; canUp: boolean; canDown: boolean; onMove: (direction: MoveDirection) => void;
  onReset?: (() => void) | undefined; canReset?: boolean;
  /** REQ-67 ⑤: a workspace's own ⋯ also opens its board; a project heading over several workspaces has none. */
  onOpenBoard?: (() => void) | undefined;
  /**
   * research/187 J2: a phone lane's heading has no room for To Do's "+", so its sheet opens with "New draft" — a draft
   * into that workspace's To Do, whichever tab shows. The sheet only; a wide screen keeps the "+" on its To Do heading.
   */
  onDraft?: (() => void) | undefined;
  /**
   * REQ-134 WA (research/267): a phone lane whose workspace holds a workflow definition opens its workflow from here — the
   * heading has no room for the wide "Board | Workflow". The sheet only; the wide screens keep their switch.
   */
  onWorkflow?: (() => void) | undefined;
  /** REQ-125: a phone lane whose workspace has no definition (nor a built-in in use) offers "Try a workflow" here instead. */
  onTryWorkflow?: (() => void) | undefined;
  /** REQ-52: a workspace's archived cards — the list with "Restore" (client/archive.tsx), on every screen. */
  onArchived?: (() => void) | undefined; colors: Palette; m: Copy; platform: HostPlatform; mobile?: boolean;
  disabled?: boolean; testID?: string;
}) {
  const [open, setOpen] = useState(false), trigger = useRef<View>(null), popover = usePopover(trigger);
  const move = (direction: MoveDirection) => () => { setOpen(false); onMove(direction); };
  if (!mobile && platform === 'web') {
    const pick = (action: () => void) => () => { popover.close(); action(); };
    const rows = 3 + (onOpenBoard ? 1 : 0) + (onArchived ? 1 : 0) + (onReset ? 1 : 0);
    return <>
      <IconButton name="Ellipsis" testID={testID} plain colors={colors} mobile={false} disabled={disabled} buttonRef={trigger}
        label={m.orderMenu + ': ' + name} onPress={() => popover.open ? popover.close() : popover.show()} />
      <PopoverMenu testID="order-popover" open={popover.open} anchor={popover.anchor} rows={rows} onClose={popover.close}
        onDismiss={popover.returnFocus} label={m.orderMenu + ': ' + name} closeLabel={m.close} colors={colors}>
        {!!onOpenBoard && <PopoverRow testID="order-open-board" icon="SquareArrowOutUpRight" label={m.openInBoard} colors={colors} onPress={pick(onOpenBoard)} />}
        {!!onArchived && <PopoverRow testID="order-archived" icon="Archive" label={m.archivedShow} colors={colors} onPress={pick(onArchived)} />}
        <PopoverRow testID="order-move-top" label={m.moveTop} colors={colors} disabled={!canUp} onPress={pick(() => onMove('top'))} />
        <PopoverRow testID="order-move-up" label={m.moveUp} colors={colors} disabled={!canUp} onPress={pick(() => onMove('up'))} />
        <PopoverRow testID="order-move-down" label={m.moveDown} colors={colors} disabled={!canDown} onPress={pick(() => onMove('down'))} />
        {!!onReset && <PopoverRow testID="order-reset" label={m.resetOrder} colors={colors} disabled={!canReset} onPress={pick(onReset)} />}
      </PopoverMenu>
    </>;
  }
  return <>
    <IconButton name="Ellipsis" testID={testID} plain colors={colors} mobile={mobile} disabled={disabled}
      label={m.orderMenu + ': ' + name} onPress={() => setOpen(true)} />
    <MenuSheet title={m.orderMenu + ': ' + name} open={open} onClose={() => setOpen(false)} colors={colors}
      platform={platform} closeLabel={m.close}>{sc => <>
      {!!onDraft && <Button testID="order-draft" label={m.draftHere} colors={sc} mobile={mobile}
        onPress={() => { setOpen(false); onDraft(); }} />}
      {!!onOpenBoard && <Button testID="order-open-board" label={m.openInBoard} colors={sc} mobile={mobile}
        onPress={() => { setOpen(false); onOpenBoard(); }} />}
      {!!onWorkflow && <Button testID="order-workflow" label={m.workflowShow} colors={sc} mobile={mobile}
        onPress={() => { setOpen(false); onWorkflow(); }} />}
      {!!onTryWorkflow && <Button testID="order-workflow-try" label={m.workflowTry} colors={sc} mobile={mobile}
        onPress={() => { setOpen(false); onTryWorkflow(); }} />}
      {!!onArchived && <Button testID="order-archived" label={m.archivedShow} colors={sc} mobile={mobile}
        onPress={() => { setOpen(false); onArchived(); }} />}
      <Button testID="order-move-top" label={m.moveTop} colors={sc} mobile={mobile} disabled={!canUp} onPress={move('top')} />
      <Button testID="order-move-up" label={m.moveUp} colors={sc} mobile={mobile} disabled={!canUp} onPress={move('up')} />
      <Button testID="order-move-down" label={m.moveDown} colors={sc} mobile={mobile} disabled={!canDown} onPress={move('down')} />
      {!!onReset && <Button testID="order-reset" label={m.resetOrder} colors={sc} mobile={mobile}
        disabled={!canReset} onPress={() => { setOpen(false); onReset(); }} />}
    </>}
    </MenuSheet>
  </>;
}
