// The host's `@getpaseo/plugin/client/react-native` for the headless page: react-native-web's own components, and an
// Icon that draws its first letter in the colour it is given (the page only needs it to have a size and a colour).
import { Text, View } from 'react-native';
export { ScrollView, TextInput } from 'react-native';
// REQ-85 ⑧: the host's copyText as Paseo 0.9.1's web app has it (the browser clipboard); a page can refuse it to see the fallback.
export async function copyText(text: string) {
  if ((window as { __noClipboard?: boolean }).__noClipboard || !navigator.clipboard) throw new Error('Clipboard copy is unavailable in this browser');
  await navigator.clipboard.writeText(text);
}
export function Icon({ name, size = 16, color }: { name: string; size?: number; color?: string }) {
  return <View {...({ dataSet: { icon: name } } as object)} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
    <Text {...({ dataSet: { iconGlyph: "1" } } as object)} style={{ color, fontSize: Math.round(size * .7), lineHeight: size }}>{name[0]}</Text>
  </View>;
}
