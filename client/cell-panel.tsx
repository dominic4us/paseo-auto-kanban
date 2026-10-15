import type { ReactNode, Ref } from 'react';
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native';
import type { Palette } from './palette.js';
import { panelTokens } from './panel-style.js';
import { PanelHeader } from './panel-header.js';
import { px } from './ui-scale.js';

/** A measurable drop-region boundary; registration/drag behavior belongs to the next unit. */
export function CellPanel({ children, colors, heading, count, color, headingTrailing, panelRef, onLayout, style, testID }: {
  color?: string; headingTrailing?: ReactNode; children?: ReactNode; colors: Palette; heading?: string; count?: number;
  panelRef?: Ref<View>; onLayout?: (event: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>; testID?: string;
}) {
  return <View ref={panelRef} onLayout={onLayout} testID={testID} collapsable={false}
    style={[{ backgroundColor: panelTokens(colors).panel, borderRadius: px(8), paddingHorizontal: px(8),
      paddingBottom: px(8), gap: px(8), minHeight: 0 }, style]}>
    {heading !== undefined && <PanelHeader title={heading} count={count ?? 0} color={color ?? colors.foregroundMuted} colors={colors}
      {...(headingTrailing !== undefined ? { trailing: headingTrailing } : {})} />}
    {children}
  </View>;
}
