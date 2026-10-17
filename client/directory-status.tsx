import { View } from 'react-native';
import { Notice } from './components.js';
import type { Palette } from './palette.js';
import type { Copy } from './i18n.js';
import type { AutoHealthDTO } from '../shared/rpc.js';
/**
 * REQ-78: what the screens say about the workspace listing. While boards wait for it, one quiet line in their
 * place; when reading it failed or timed out, why, and that it is read again on its own — the line goes once a
 * listing succeeds.
 */
export function DirectoryStatus({ placing, error, colors, m }: { placing: boolean; error: string; colors: Palette; m: Copy }) {
  return <>
    {placing && <Notice testID="directory-loading" text={m.loadingWorkspaces} colors={colors} />}
    {!!error && <Notice testID="directory-error" text={`${m.directoryError}: ${error} · ${m.directoryRetry}`} colors={colors} error />}
  </>;
}
/** REQ-78: marks the moment this screen's own workspace listing answered, for a headless check to wait on. It takes no room. */
export function DirectoryReadyMark() {
  return <View testID="directory-ready" pointerEvents="none" style={{ position: 'absolute', width: 0, height: 0 }} />;
}
/**
 * REQ-83: the other readings a screen depends on, each said apart and quietly, under the workspace listing's line —
 * the agents' states (the cards' marks), the server's automatic tracking (the moves), and the auto refresh of the
 * boards. None of them is blamed on a Paseo version: a dropped connection fails the same way, so both are named.
 * A tracking problem is left out while automatic cards are off (`autoCards` false): nothing is being moved then.
 * H3: when the agents' states and the server's tracking both could not be read, one line says it once and names both
 * features, instead of two red lines opening with the same sentence. H1: a hold names what could not be read — agents'
 * states, or hook inputs of another shape.
 */
export function TrackingStatus({ signals, health, autoCards, refreshFailing, colors, m }: {
  signals: string; health: AutoHealthDTO | undefined; autoCards: boolean | undefined; refreshFailing: boolean; colors: Palette; m: Copy;
}) {
  const tracking = autoCards !== false && health && health.state !== 'ok' ? health : null;
  const detail = (value: string | null | undefined) => value ? ': ' + value : '';
  const failed = tracking?.state === 'failed' ? tracking : null;
  // H1: an older server does not count the inputs; its latest problem being a hook's says which it was.
  const inputs = tracking?.state === 'held' ? tracking.inputs ?? (tracking.issue === 'bad-hook' ? tracking.held : 0) : 0;
  return <>
    {!!signals && !!failed && <Notice testID="tracking-host-failed" error colors={colors}
      text={`${m.hostReadFailed} (${m.signalsFeature}${detail(signals)} · ${m.trackingFeature}${detail(failed.detail)}) · ${m.checkHost} · ${m.directoryRetry}`} />}
    {!!signals && !failed && <Notice testID="tracking-signals-error" error colors={colors}
      text={`${m.hostReadFailed} (${m.signalsFeature}${detail(signals)}) · ${m.checkHost} · ${m.directoryRetry}`} />}
    {!!failed && !signals && <Notice testID="tracking-server-failed" error colors={colors}
      text={`${m.hostReadFailed} (${m.trackingFeature}${detail(failed.detail)}) · ${m.checkHost}`} />}
    {tracking?.state === 'held' && <Notice testID="tracking-server-held" colors={colors}
      text={`${m.trackingFeature}: ${m.trackingHeld(tracking.held - inputs, inputs)}${tracking.detail ? ' (' + tracking.detail + ')' : ''} · ${m.checkHost}`} />}
    {refreshFailing && <Notice testID="tracking-refresh-error" error colors={colors}
      text={`${m.refreshFeature}: ${m.refreshFailed} · ${m.directoryRetry}`} />}
  </>;
}
