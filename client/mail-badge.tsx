import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/react-native';
import type { MailAliasRule, MailDTO } from '../shared/rpc.js';
import { laneMail, mailAlias } from '../shared/mailbox.js';
import type { Copy } from './i18n.js';
import { readable, type Palette } from './palette.js';
import { Tip, usePointerTip, useTipPlace } from './components.js';
import { claimPressTip, outsidePress } from './press-tip.js';
import { mailTipHeight, mailTipText } from './mail-tip.js';
import { px } from './ui-scale.js';

/**
 * REQ-90: the lab's "messages waiting" badge on a lane's heading — how many open threads of the message folder wait for this
 * workspace (the newest file's "받는 곳:" is its short name, shared/mailbox.ts). Nothing when none do. The mouse on it (or a
 * press, on a phone) shows the threads and their newest files; threads whose newest file has no such line are counted apart
 * ("Unknown format n"), as they cannot be placed on a lane. Opening a thread is out of its scope: it only tells.
 *
 * research/179 J3: on a phone (`compact`) it is the envelope and the number only, about 29px instead of 52, so the lane's
 * name keeps the room; "교신 N" is still what a screen reader hears. The wide board keeps the words.
 * D1: the tip is placed from its guessed height (mail-tip.ts), then from the height it was drawn at; while it shows, the
 * lane lifts itself over the next one (`useTipPlace` raises every `TipLayer` around it, mobile-swimlane.tsx).
 */
export function MailBadge({ mail, cwd, rule, colors: c, m, compact = false, onOpen }: {
  mail: MailDTO | undefined; cwd: string; rule: MailAliasRule; colors: Palette; m: Copy; compact?: boolean;
  /** REQ-134 MA: on a phone with the message list, a press opens it filtered to this workspace; a long press shows the tip. */
  onOpen?: (() => void) | undefined;
}) {
  const alias = mailAlias(cwd, rule), threads = laneMail(mail, alias);
  const tip = usePointerTip(), anchor = useRef<View>(null), [pressed, setPressed] = useState(false), [span, setSpan] = useState(0);
  const shown = tip.shown || pressed, width = compact ? px(300) : px(420), [drawn, setDrawn] = useState(0);
  const words = mail && threads.length ? mailTipText(threads, mail.unknown.length, alias, m) : '';
  const place = useTipPlace(shown, anchor, 'left', drawn || mailTipHeight(words, width));
  // A new text is guessed again until it is drawn.
  useEffect(() => { setDrawn(0); }, [words, width]);
  // One press tip at a time (REQ-44's rule): another's press, or a press outside on the web, closes this one.
  useEffect(() => {
    if (!pressed) return undefined;
    const release = claimPressTip(() => setPressed(false)), outside = outsidePress(anchor.current, () => setPressed(false));
    return () => { release(); outside(); };
  }, [pressed]);
  if (!mail || !threads.length) return null;
  const text = readable(c.accent, c.surface0), label = m.mailBadge(threads.length);
  // The tip is centred on the badge and pushed back inside the window (REQ-85 ①), so a long path never runs off a phone.
  return <View ref={anchor} style={shown ? { zIndex: 2 } : undefined}
    onLayout={event => { const next = Math.round(event.nativeEvent.layout.width); setSpan(value => value === next ? value : next); }}>
    <Pressable testID="lane-mail-badge" accessibilityRole="button" accessibilityLabel={label + ': ' + threads.map(t => t.thread).join(', ')}
      {...tip.handlers} onPress={() => onOpen ? onOpen() : setPressed(value => !value)}
      {...(onOpen ? { onLongPress: () => setPressed(value => !value) } : {})} hitSlop={compact ? px(10) : px(4)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: compact ? px(2) : px(3), paddingHorizontal: compact ? px(4) : px(6), height: compact ? px(18) : px(20), borderRadius: px(10),
        borderWidth: 1, borderColor: text }}>
      <Icon name="Mail" size={compact ? px(11) : px(12)} color={text} />
      <Text testID="lane-mail-badge-text" numberOfLines={1} style={{ color: text, fontSize: compact ? px(10) : px(11), lineHeight: compact ? px(14) : px(16), fontWeight: '600' }}>{compact ? String(threads.length) : label}</Text>
    </Pressable>
    {shown && <Tip testID="lane-mail-tip" label={words} place={place} offset={compact ? px(18) : px(20)}
      colors={c} width={width} lineHeight={px(15)} {...(span ? { span } : {})} onHeight={next => setDrawn(value => value === next ? value : next)} />}
  </View>;
}
