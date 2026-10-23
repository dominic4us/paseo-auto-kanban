import { useState } from 'react';
import { Text, View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import * as hostUi from '@getpaseo/plugin/client/react-native';
import { updateCheckSet, type UpdateCheckDTO } from '../shared/rpc.js';
import { UPDATE_COMMANDS } from '../shared/update-check.js';
import type { Palette } from './palette.js';
import type { Copy } from './i18n.js';
import { Button, Notice } from './components.js';
import { useConfirmedValue } from './confirmed-value.js';
import { updateLine, updateState } from './update-model.js';
import { px } from './ui-scale.js';

/**
 * REQ-156 (research/478 (A)): the new-version notice on the screens. The server asks the registry (server/update-check.ts); a
 * screen only draws what its read carried — no network from here, so the phone app runs nothing new. The switch is one setting for
 * the whole plugin, saved like the automatic archive's days (`useAutoArchive`): the server's reading until a write it confirmed.
 */
export type UpdateCheckSwitch = UpdateCheckDTO & { set: (enabled: boolean) => Promise<boolean> };
export function useUpdateCheck(scope: string, remote: UpdateCheckDTO | undefined, persist: boolean,
  readToken: unknown = remote): UpdateCheckSwitch | undefined {
  const save = useRpc(updateCheckSet), confirmed = useConfirmedValue(scope + ':updateCheck', remote, readToken);
  if (!confirmed.value) return undefined;
  const set = async (enabled: boolean) => {
    if (!persist) return false;
    const ticket = confirmed.begin(); if (!ticket) return false;
    try {
      const reply = await save({ enabled });
      if (!reply?.ok) return false;
      // Off shows nothing; on shows nothing until the next read, which carries the server's kept answer if it is under a week old.
      confirmed.confirm(ticket, { enabled: reply.data.enabled }); return true;
    } catch { return false; }
  };
  return { ...confirmed.value, set };
}

/** The commands onto this device's clipboard through the host (`copyText`, as the card ID's copy); a host without it says so. */
export async function copyUpdateCommands(copy = (hostUi as { copyText?: (text: string) => Promise<void> }).copyText): Promise<boolean> {
  try { if (typeof copy !== 'function') return false; await copy(UPDATE_COMMANDS.join('\n')); return true; } catch { return false; }
}

/** About → Updates: the state in one line; with a newer release, the two commands (selectable) and their copy button. */
export function UpdateNotice({ update, running, colors: c, m, mobile }: {
  update: UpdateCheckDTO; running: string | undefined; colors: Palette; m: Copy; mobile: boolean;
}) {
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null);
  const state = updateState(update), newer = state === 'newer';
  return <View testID="update-notice" style={{ gap: px(8), alignSelf: 'stretch' }}>
    <Text testID="update-line" selectable accessibilityLiveRegion="polite" style={{ color: newer ? c.foreground : c.foregroundMuted,
      fontSize: px(13), lineHeight: px(18), fontWeight: newer ? '600' : '400' }}>{updateLine(update, running, m)}</Text>
    {newer && <>
      <View testID="update-commands" style={{ alignSelf: 'stretch', gap: px(4), padding: px(8), borderRadius: px(6), borderWidth: 1,
        borderColor: c.border, backgroundColor: c.surface1 }}>
        {UPDATE_COMMANDS.map((line, index) => <Text key={line} testID={'update-command-' + index} selectable
          style={{ color: c.foreground, fontSize: px(12), lineHeight: px(17), fontFamily: 'monospace',
            ...({ userSelect: 'text', overflowWrap: 'anywhere' } as object) }}>{line}</Text>)}
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: px(12), lineHeight: px(17) }}>{m.updateCommandsHelp}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: px(8) }}>
        <Button testID="update-copy" label={m.updateCopy} colors={c} selected mobile={mobile}
          onPress={() => { void copyUpdateCommands().then(ok => setCopied(ok ? 'ok' : 'failed')); }} />
        {copied && <View style={{ flexShrink: 1 }}><Notice testID="update-copy-result" text={copied === 'ok' ? m.updateCopied : m.updateCopyFailed}
          colors={c} error={copied === 'failed'} /></View>}
      </View>
    </>}
  </View>;
}
