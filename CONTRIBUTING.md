# Contributing

Thanks for your interest. Bug reports, suggestions and questions are welcome through the issue forms. For a
code change, please open an issue first so we can agree on the approach; this is a small project maintained in
spare time, and replies may take a few days.

## Build and test

Requirements: Node.js 22 or newer and npm. A Paseo installation is optional for most tests.

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm test            # builds, then runs every tests/*.test.mjs (about six minutes)
```

- When you change the version, change `package.json`, `package-lock.json` and `release.json` together (or delete
  `release.json` in your copy for a development build): the build stops when `release.json` and `package.json`
  disagree.

- `npm test` includes the **Hermes gate**: it compiles the client bundle with the installed Paseo plugin
  compiler and `hermesc` to make sure nothing breaks on the mobile JavaScript engine. Without Paseo tooling it
  prints an explicit `skipped` reason locally; CI is strict. `npm run test:hermes` runs the gate alone. See
  [docs/plugin-code-rules.md](docs/plugin-code-rules.md#hermes-gate).
- `npm run test:web` drives the real Kanban screens under react-native-web in headless Chromium with synthetic
  data. It needs `tests/web/node_modules` (`npm install --prefix tests/web`) and a Playwright Chromium (`npx playwright-core install chromium`).
- Tests use synthetic data and temporary folders only. They never install or reload a plugin and never touch a
  real data folder.
- Keeping `node_modules` and `dist` outside the checkout is optional; see [docs/build-setup.md](docs/build-setup.md).

## Trying your change in Paseo

Install your checkout under a separate plugin ID so it does not replace a released installation. The plugin uses
the data folder of the Paseo server it runs in (`KANBAN_DATA_DIR` in the server's environment, else
`~/paseo-kanban-data`), so test writes on a test machine or on [a separate test server](#a-separate-test-server):

```sh
paseo plugin install /absolute/path/to/checkout --id paseo-auto-kanban-dev
paseo plugin reload paseo-auto-kanban-dev     # after each change
```

Paseo compiles the TypeScript sources directly; there is no build step for the plugin itself. Disable the
released plugin while testing, since both would react to the same agent events. Before proposing a change that
touches Paseo APIs, run the [Paseo release check](docs/paseo-release-check.md) steps that apply.

### A separate test server

On a machine whose Paseo server holds real boards, start a second Paseo server with its own home, port and data
folder. `KANBAN_DATA_DIR` only counts when it is set for the server process as it starts:

```sh
TEST="$HOME/paseo-test"
paseo daemon config set --home "$TEST/.paseo" daemon.listen 127.0.0.1:6877
paseo daemon config set --home "$TEST/.paseo" features.webUi.enabled true
paseo daemon config set --home "$TEST/.paseo" pluginsEnabled true
KANBAN_DATA_DIR="$TEST/kanban-data" paseo daemon start --home "$TEST/.paseo"
paseo plugin install /absolute/path/to/checkout --id paseo-auto-kanban-dev --home "$TEST/.paseo"
```

- `daemon.listen` keeps it off the real server's port. Its web screen is at `http://127.0.0.1:6877/` only with
  `features.webUi.enabled` set in that home (`daemon start` does not read it from the environment); without it the
  page is a 404.
- `pluginsEnabled` is the **Enable plugins** switch for that server.
- Stop it with `paseo daemon stop --home "$TEST/.paseo"` when you are done.

## Code rules

- Read [docs/plugin-code-rules.md](docs/plugin-code-rules.md). In short: `client/` and `shared/` run on the mobile
  Hermes engine — no classes, async generators, RegExp `v` flags, `using` declarations or top-level await there;
  use host theme colours and public host components; never touch the host's DOM.
- `shared/core/domain.ts` is the pure domain; `server/core/` owns files. The CLI and the plugin server import the
  same modules — do not copy core code.
- The ledger format, `config.json`, the data folder name, the CLI name and the format strings
  (`paseo-kanban.workflow/…`) are compatibility surfaces. Changing them needs a migration plan.
- Automatic features must fail closed: when the plugin cannot read something, it holds (no card, no move, no
  write) and says so on screen, rather than guessing.
- Screens are English and Korean (`client/i18n.ts`). Add both strings; if you cannot write Korean, add the
  English one in both places and say so in the pull request.
- Never commit real ledgers, `PROCESS.md` files from real work, credentials or screenshots of real projects. Use
  the demo data for screenshots.

**Internal work numbers.** Code comments and some test file names contain references such as `REQ-` or `D`
followed by a number, or a numbered document. These are the maintainer's internal work-tracking numbers. They are kept for history; you do
not need to understand them, and new code does not need them.

## Releases

For the maintainer. A release is one commit on `main` with a tag `vX.Y.Z`; nothing is published from a laptop.

1. **Candidate branch.** Push the release commit to a branch `rc/vX.Y.Z` before `main`. The *Candidate tests*
   workflow ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `npm ci`, `npm test`, `npm run test:web`,
   `npm run test:hermes` and `npm run test:hermes-run` on a clean GitHub runner with Node.js 22.
2. **Green.** Go on only when that run is green. If it fails, fix it, delete the `rc/vX.Y.Z` branch and push a new
   candidate. A tag is never moved.
3. **`main` and the tag.** Push the same commit to `main` together with the tag. The *Release to npm (staged)*
   workflow ([.github/workflows/release.yml](.github/workflows/release.yml)) tests again, checks that the tag matches
   the `package.json` version and that the packed file list looks right, and stages the version on npm through
   trusted publishing (OIDC): no npm token is stored anywhere, and the package gets a provenance statement.
4. **Approve on npm.** On npmjs.com, open the package's *Staged Packages* tab, check the version and the file count,
   and approve with two-factor authentication. Only then is the version public; `npm view paseo-auto-kanban version`
   shows it.

The npm trusted publisher for this package allows only `npm stage publish`, only from `release.yml` in this
repository, so a workflow run alone can never make a version public.

**When to register the trusted publisher.** npm drops a trusted publisher that has no successful publish within
48 hours of being created; it cannot be edited, only deleted and registered again. So register it (package
*Settings* on npmjs.com → *Trusted Publisher* → GitHub Actions, workflow `release.yml`, allowed action
`npm stage publish` only) after the candidate run is green and right before pushing `main` and the tag — not
ahead of time. If it expires, delete it and register it again just before the next push.

**Manual fallback**, when Actions cannot be used: in a clean clone of the tagged commit run `npm ci --ignore-scripts`,
`npm test` and `npm pack --dry-run` (check the file list), then `npm publish` and confirm with two-factor
authentication.

## Pull requests

- One topic per pull request, with tests. Run `npm test` (and `npm run test:web` for screen changes) before
  opening it.
- Describe what changes for a person using the board, and anything that changes on disk.
- By submitting a contribution you agree that it is licensed under the [Apache-2.0](LICENSE) license of this
  project.

## Reporting security issues

Please do not open a public issue; see [SECURITY.md](SECURITY.md).
