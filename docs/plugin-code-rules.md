# Plugin code rules

- `client/` and `shared/` can reach the mobile Hermes engine. Do not leave classes
  (declarations, expressions, static blocks, private fields or class inheritance),
  async generators, RegExp `v` flags, `using` declarations or top-level await there.
  Use plain object factories; use `createKanbanError` and `isKanbanError` for domain
  errors. Server-only Node code may use classes, but must not subclass shared types.
- Keep `useWorkspace` / `useAgent` in panel wrappers. Surfaces and their shared
  children must work without the host's panel-state provider.
- Use `theme.colors`; missing semantic colors belong only in `client/palette.ts`.
  Do not inspect or modify host DOM nodes. Use public host Icon/Modal components.

## Hermes gate

`npm test` automatically checks the exact Paseo client wrapper and a second bundle
that retains every runtime export from every shared source module. Both builds
use the installed Paseo `compilePlugin`, from a disposable source copy. The AST
policy also scans unexported/dead declarations in client/shared and the client
entry. Bytecode is compiled eagerly with `hermesc -emit-binary -eager`, never run.
A negative test feeds a deliberate class directly to hermesc and requires failure.
Grammar-only `hermes-parser` and successful Node/esbuild tests are not substitutes.

```sh
npm run test:hermes
node scripts/check-hermes.mjs . --json
node scripts/check-hermes.mjs . --compiler /path/to/plugins/compiler.js --hermesc /path/to/hermesc --required
```

The existing **development-only** `react-native@0.81.5` package includes hermesc
for Linux x64, macOS and Windows x64. Its [published manifest](https://github.com/facebook/react-native/blob/v0.81.5/packages/react-native/package.json)
is MIT-licensed and includes `sdks/hermesc`. No extra dependency or postinstall
script is needed: a fresh `npm ci --ignore-scripts` was verified on Linux x64.
The published archive is 24,766,674 bytes / 75,501,681 bytes unpacked; its Linux
compiler is 3,787,344 bytes and reports Hermes 0.12.0 / bytecode version 96.
These are package/binary sizes, excluding transitive dependencies. Runtime
npm dependencies remain zero. Do not replace this with an arbitrary newer engine.

The checker discovers Paseo beside its PATH executable or through local package
resolution. `PASEO_PLUGIN_COMPILER` / `--compiler` select an installed compiler;
`HERMESC` / `--hermesc` select an app-matched executable. CI must provision Paseo
0.9.x compiler tooling as well as the development dependencies. It need not run
or install a plugin. The full server is not added as a project dependency merely
for this test (it also brings daemon/native/speech dependencies).

Checks run by default. Missing compiler tooling or an unsupported binary platform
prints an explicit `skipped` reason in non-CI tests. CI is strict by default;
`KANBAN_REQUIRE_HERMES=1` or `--required` also disallows skipping locally. An
exceptional environment can explicitly set `KANBAN_REQUIRE_HERMES=0` for tests.
Invalid explicit paths, build errors and rejected syntax fail rather than skip.
The command exits 0 for passed/reported skipped, 1 for incompatibility, 2 for tool
errors; inspect the JSON `status` when using the non-strict command.

No checker command reloads Paseo, executes a plugin bundle, writes real ledgers or
retains temporary JS/bytecode. Passing proves compatibility with this compiler's
syntax, not host API availability, regex runtime semantics or every mobile build.
After shared imports change, rerun both bundles before requesting a user reload.
