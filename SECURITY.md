# Security policy

## Supported versions

Only the latest release receives fixes. Please update before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use GitHub's private reporting instead:
open the repository's **Security** tab → **Report a vulnerability**. If that is not available, open an issue
that only asks for a private contact, without details.

Include what you did, what happened, the plugin and Paseo versions, and the operating system of the Paseo
server. You should get a first reply within a week. Fixes are released as a new version with a note in the
[changelog](CHANGELOG.md); reporters are credited if they wish.

## What the plugin can do

Paseo plugins are **not sandboxed**. This plugin runs inside the Paseo server with that server's file system
access and the agent API Paseo offers to plugins. What it actually does:

- reads and writes its own data folder (`~/paseo-kanban-data` or `KANBAN_DATA_DIR`);
- writes `PROCESS.md` into workspace folders that have an exporting board, and `.kanban/workflow.json` only when a
  person presses **Export** (see the README, *What happens automatically*);
- reads, without writing, Paseo's workspace and label records and, for the workflow view, files inside a
  workspace folder;
- sends a prompt to an agent only after a person confirms sending a draft card;
- makes **no network connections** of its own, runs no child processes, and collects no telemetry.

Reports about any behaviour outside this list are especially welcome.

## About `npm audit` warnings

`npm audit` (and GitHub's Dependabot) report warnings for this repository. They all come from
**development dependencies** — mainly the `react-native` package and its build and test tool chain (Metro,
Jest and their helpers), used here only for type definitions and the Hermes compiler check. None of them is
shipped with or loaded by the plugin:

- The plugin has **no runtime npm dependencies**. Its only runtime modules (`react`, `react-native`, `zod` and
  the `@getpaseo/*` SDK) are provided by Paseo itself, and Paseo compiles the plugin from this repository's
  TypeScript sources without installing `node_modules`.
- The `kanban` CLI uses only Node.js built-in modules at runtime.
- `npm audit --omit=dev` reports **0** vulnerabilities.

If you find a warning that does affect the plugin or the CLI at runtime, please report it as above.
