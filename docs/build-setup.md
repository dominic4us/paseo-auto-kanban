# Build setup record

This optional layout keeps generated files outside the checkout. Standard local
installs can instead use the root package scripts directly.

Run from the checkout root with Node 22 or newer. The default cache is
`$HOME/build-cache/paseo-kanban`; override it with `KANBAN_BUILD_ROOT`.
Dependencies and compiled files live in that cache, with links in the checkout.
These commands do not install a command-line executable.

```sh
cache="${KANBAN_BUILD_ROOT:-$HOME/build-cache/paseo-kanban}"
mkdir -p "$cache/dist"
cp package.json package-lock.json "$cache/"
npm ci --prefix "$cache" --ignore-scripts --no-audit --no-fund
ln -s "$cache/node_modules" node_modules
ln -s "$cache/dist" dist
npm run typecheck
npm run build
npm test
```

The initial setup used `npm install` in the cache to generate the lockfile,
then copied that lockfile into the checkout. Subsequent setups use `npm ci`.
Do not replace existing non-link directories with these commands. Cache artifacts
can be rebuilt; source files and the lockfile remain in the checkout.

The TypeScript root is the checkout: shared/core holds the pure domain, server/core
holds Node adapters, and src/cli imports both. Generated entries are
`dist/src/cli/main.js` and `dist/server/core/index.js`. Build also writes the
legacy `dist/cli/main.js` forwarding executable without changing PATH links.
The SDK, React, React Native and Zod packages are development/type dependencies;
Paseo supplies plugin runtime modules. The CLI core needs none of them at runtime.

The root plugin manifest has no build command. Its compiler reads the TypeScript
import graph directly; do not generate or commit copied core artifacts.
Plugin installation instructions and privilege details are in the root README.
