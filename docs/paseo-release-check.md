# Paseo release check and recovery

The plugin declares `>=0.8.0 <1.0.0`. Paseo therefore lets it load on every new 0.x release without
asking, so each new Paseo gets this check instead. Record every run as a row of the table in the README's
[Paseo compatibility](../README.md#compatibility) section — the declared range is not the verified range.

## When

- A Paseo beta or release candidate appears: run it there first, before people update.
- A Paseo release: run it on the release, even when the beta passed.
- Read the release notes first. Anything about plugins, the plugin SDK (`@getpaseo/plugin`, `@getpaseo/client`), the
  protocol, agent statuses, lifecycle hooks, subscriptions or workspace listing is a reason to look harder.

A typecheck and the mock tests passing is **not** a pass: in 0.9 a subscription change passed every automated test
and failed only against a real daemon.

## Where

On a test host, or on a separate Paseo server (daemon) that was **started** with a throwaway `KANBAN_DATA_DIR` —
never the real ledgers. The plugin uses the data directory of the Paseo server process it runs in, chosen when that
process starts. Exporting `KANBAN_DATA_DIR` in a terminal changes only the commands started from that terminal, such as
the `kanban` CLI; a server that is already running, and `paseo plugin reload`, keep the directory they had. On a
machine whose Paseo server holds real boards, testing "in a separate directory" therefore needs a separate server, as
in [CONTRIBUTING](../CONTRIBUTING.md#a-separate-test-server) (its own home, port and, to open its web screen,
`features.webUi.enabled`).

```sh
export KANBAN_DATA_DIR="$HOME/kanban-release-check"   # a throwaway directory, for this terminal's kanban CLI
# Start the test Paseo server from this same environment (or set the variable in its service definition),
# so the server and the CLI use the same directory.
mkdir -p "$HOME/kanban-sample"
kanban init --workspace "$HOME/kanban-sample"      # a throwaway sample folder
```

Before any step that writes, check that the CLI and the plugin use the **same** directory:

1. `kanban ls --all` lists only the sample board, and `$KANBAN_DATA_DIR/boards/` holds only that board's file.
2. Add a card on the sample board from the Kanban screen, then run `kanban ls --workspace "$HOME/kanban-sample"` in the
   terminal: the new card must be there. If it is not, the server uses another directory — stop, and do not run the steps below on that server.

Note the versions: the Paseo server (`paseo --version`), every app that will be used (Mac app and phone app: their
settings' About), and Kanban (Kanban settings → About).

## Steps

Each step names what to look at. Stop at the first failure and go to [When a step fails](#when-a-step-fails).

1. **Load.** Install or reload the plugin (`paseo plugin reload paseo-auto-kanban`). Paseo's plugin settings show it
   enabled with no error — on the server and in **each** app (the apps check the range themselves).
2. **Initial load.** Open the Kanban surface. The boards appear; there is no "Paseo information could not be read"
   line, no "Workspace names could not be read" line, and Kanban settings → About shows the expected version.
3. **Listing.** Project and workspace names are right, the project count is right, a worktree's board sits beside its
   project's root, a workspace without a board is listed as empty.
4. **Agents.** Start an agent in the sample workspace. A card appears (agent auto cards on). Its state mark follows
   the agent (a ring while working, a dot when it finishes), line two names its model, and the mark's hint says the
   state. Nothing says "agent states could not be read".
5. **Events.** Let the agent run a turn: the card goes to In progress, then Review. Ask it to do something that needs
   a permission: the card says it waits for a response; answer it: the flag goes.
6. **Background and reconnect.** Put the phone app in the background for a minute and bring it back; the marks are
   current again. Restart the daemon while an agent works; after it is back, the first board read repairs the card
   (no duplicate card, no card moved back).
7. **Sample ledger moves.** Move the auto card by hand: automatic moves pause (the detail says so). Resume them: the
   next turn moves the card again. Archive the agent: the card waits in Review for a person.
8. **Ledger RPCs.** Edit a card in the detail, quick-move a card and undo it, create an instruction draft, copy a
   card ID from the ⋯ menu. `kanban ls` agrees with the screen.
9. **Automated.** In a branch, set the `@getpaseo/*` dev dependencies to the new version and run `npm test`,
   `npm run test:hermes` and `npm run test:web`. The host compatibility tests (`tests/req83-host-compat.test.mjs`) inject an
   unknown status, missing fields, a failed and a partial listing, and check the declared range with the installed
   Paseo's own judge.

Pass: every step as described. Add the row to the README table (Kanban version, server, app/platform, date, what
was checked), including partial runs ("server only", "phone not checked").

## When a step fails

- **The plugin does not load in one app only** (an app's settings show the range error): that app is outside the
  range or refuses it — the server may still run the automatic cards. Update the app, or the plugin.
- **Automatic moves look wrong** (cards moving back, cards in Review that are still working, cards not made): turn
  automatic tracking off first (below), then look. Screens that say "Automatic tracking: … agent states could not be
  read" mean the plugin already held those moves: a new status or field changed.
- **A read fails** ("Paseo information could not be read"): check the connection first — a dropped connection says
  the same. If it keeps failing with the connection fine, the host API changed.
- **A release breaks the plugin:** publish a manifest that excludes it, for example
  `">=0.8.0 <0.9.2 || >0.9.2 <1.0.0"` (syntax example only; `>=0.8.0 !=0.9.2` is not a valid range), with a fixed
  version as soon as there is one. An installed plugin keeps its old manifest until it is updated: a new manifest
  does not reach it by itself.

## Recovery

People can do each of these without a developer.

### Turn automatic tracking off

Kanban settings → Automation → turn off agent auto cards. From then on no hook and no repair moves or makes a card;
everything a person does keeps working, and the choice is kept per host in `auto-cards.json`. Turning it back on later
does not back-fill agents made while it was off.

If the Kanban screens do not open at all, disable the plugin instead: `paseo plugin disable paseo-auto-kanban` (or the
switch in Paseo's plugin settings). Nothing of the plugin runs then — no hooks, no screens. The ledgers stay as they are
and the `kanban` CLI keeps working.

### Install the previous revision

- From a release: `paseo plugin update paseo-auto-kanban --ref <previous-release-tag>`. The plugin is already installed
  under this ID (enabled or disabled), so `paseo plugin install` would refuse it with "Plugin ID … is already
  configured". If `update` cannot be used, remove it first and then install the tag:
  `paseo plugin remove paseo-auto-kanban`, then
  `paseo plugin install https://github.com/dominic4us/paseo-auto-kanban --ref <previous-release-tag>`.
  Removing keeps the data directory; Paseo's own per-plugin settings start fresh.
- From a checkout: check out the previous tag or commit, then `paseo plugin reload paseo-auto-kanban`.

The plugin reads the same data directory either way; no data migration is involved (the ledger and
file formats did not change).

### Data paths and backups

- The data directory: `--data-dir` > `KANBAN_DATA_DIR` > `~/paseo-kanban-data`. The daemon and the CLI must use the
  same one.
- Ledgers: `boards/<boardId>.json`. Every change keeps the previous generation in `_archive/<boardId>/<epoch>-<seq>.json`
  (the latest 20 per board).
- To undo automatic moves you do not want: move the cards back by hand (a person's move also pauses automatic moves
  for that card), or — for many cards — stop every writer (disable the plugin, no `kanban` command running), keep a copy
  of the current file, and restore the wanted generation from `_archive/` as described in the
  [recovery rules](reference.md#locks-and-recovery): replace via a new file and rename, never edit a backup in place.
- `auto-cards.json` and `ui-state.json` are the plugin's own files. Removing `auto-cards.json` together with `auto-cards.backup.json` means "on, nothing
  applied yet": automatic tracking starts over from that moment and forgets which cards a person paused.
