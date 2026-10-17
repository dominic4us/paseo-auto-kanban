/**
 * REQ-146 (research/378): what the app's host modules give when a plugin module is only loaded, not drawn. Enough for
 * every client module's top level to run (its size tables, styles, contexts); a hook or a host API called here throws,
 * because nothing renders. `scripts/hermes-runtime.mjs` adds a throwing stub for every other name a source imports.
 * The same object goes to node and to Hermes, so it only has to be deterministic, not faithful.
 */
const element = (type, props, key) => ({ type: typeof type === 'string' ? type : '[component]', props: props ?? null, key: key ?? null });
const component = name => name;
const identity = value => value;
const noop = () => undefined;
const subscription = () => ({ remove: noop });
function AnimatedValue(value) { this.value = value; }
AnimatedValue.prototype.setValue = function (value) { this.value = value; };
AnimatedValue.prototype.interpolate = function (config) { return { interpolate: config }; };
const animation = () => ({ start: noop, stop: noop, reset: noop });
const easing = () => identity;

export default {
  react: {
    createContext: value => ({ Provider: component('Context.Provider'), Consumer: component('Context.Consumer'), defaultValue: value }),
    memo: identity, forwardRef: identity, Fragment: component('Fragment'), createElement: element,
  },
  'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: component('Fragment') },
  'react-native': {
    StyleSheet: { create: identity, flatten: identity, hairlineWidth: 1,
      absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 } },
    Platform: { OS: 'android', Version: 34, select: choices => 'android' in choices ? choices.android : 'native' in choices ? choices.native : choices.default },
    Animated: { Value: AnimatedValue, timing: animation, loop: animation, sequence: animation, parallel: animation, spring: animation,
      View: component('Animated.View'), Text: component('Animated.Text'), createAnimatedComponent: identity },
    Easing: { linear: identity, ease: identity, quad: identity, cubic: identity, bezier: easing, in: easing, out: easing, inOut: easing },
    AppState: { currentState: 'active', addEventListener: subscription },
    AccessibilityInfo: { addEventListener: subscription, isReduceMotionEnabled: () => Promise.resolve(false) },
    View: component('View'), Text: component('Text'), Pressable: component('Pressable'), ScrollView: component('ScrollView'),
    Image: component('Image'), Modal: component('Modal'),
  },
};
