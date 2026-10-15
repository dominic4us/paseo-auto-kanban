# paseo-auto-kanban

**A Paseo kanban your agents update themselves.**

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/lead-dark-still.png">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/lead.gif" width="802" alt="Animated demo: a lead agent's card, marked with a gold crown, splits the work between two sub-agents; each sub-agent gets its own card tagged with the lead's name, the lead card counts its sub-cards and how many are running, and when one sub-agent finishes its card moves to Review.">
</picture>

<sub>A lead agent hands work to sub-agents — recorded in Paseo with real agents and a demo project. <a href="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/lead-dark-still.png">Still image</a></sub>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/hero-dark-still.png">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/hero.gif" width="802" alt="An agent starts in Paseo and a card appears on its own in To Do, moves to In progress while the agent works, asks for you when the agent requests a permission, and waits in Review when the agent stops.">
</picture>

<sub>Recorded in Paseo with a real agent and a demo project. <a href="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/hero-dark-still.png">Still image</a></sub>

```sh
paseo plugin install npm:paseo-auto-kanban
```

Needs Paseo 0.9.0 or newer; then turn on **Settings → Plugins → Enable plugins**. Details in [Install](#install).

Start an agent in Paseo and a card appears on that workspace's board. The card moves while the agent works,
asks for you when the agent needs a permission, and waits in Review when the agent stops — because an agent
that stopped is not the same as work that is done. You decide when a card is done.

Orchestrator agents can also manage cards themselves with the `kanban` command line tool: create cards with
acceptance criteria, link the agents they delegate to, and record deliverables. Boards are stored in local
files on the machine that runs Paseo. The plugin collects no telemetry and contacts no outside service of its
own; board contents travel only the way Paseo already works — shown in the Paseo apps you connect, and sent to
an agent (and so to that agent's model provider) when you confirm sending a card to it.

## Why

When you run several agents across several projects, the questions are always the same: what is each one
doing, which one is waiting for me, and what is actually finished? Paseo shows each chat; this plugin shows the
work. One board per workspace, every project on one screen, and a "needs you" count that only counts things
a person has to act on.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/overview-dark-still.png">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/overview.gif" width="800" alt="One board shows several projects with agents at work, highlights the card whose agent is waiting for a response, then shows the same board on a phone.">
</picture>

<sub>Demo data. <a href="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/overview-poster.png">View without motion</a></sub>

- **Automatic cards.** Every top-level agent gets a card. Turn started → In progress, permission request →
  needs you, turn ended → Review, agent archived → still Review. If you move a card yourself, it stays where
  you put it.
- **Busy, not idle.** An agent that stopped is not always finished with the work: tests or a build may still be
  running. Mark the card busy (`kanban card busy CARD "Testing"`) and its border turns dashed; after two
  hours it turns orange and asks for you. The card detail shows the mark and turns it off.
- **A CLI for orchestrators.** `kanban card add`, `card link`, `card move`, atomic JSON batches, safe retries.
  An optional generated `PROCESS.md` lets people and other agents read the board as plain text.
- **All projects at a glance.** Swimlanes per project and workspace, filters and search, live agent state on
  each card, automatic refresh, a phone layout, English and Korean, light and dark.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/busy-dark-still.png">
  <img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/busy.gif" width="800" alt="A card in Review gets a dashed border when it is marked busy, then turns orange after two hours and the board's &quot;Needs attention&quot; count goes up.">
</picture>

<sub>Demo data. <a href="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/busy-poster.png">View without motion</a></sub>

<img src="https://raw.githubusercontent.com/panto-dominic/paseo-auto-kanban/v0.2.2/docs/images/card-detail.png" width="800" alt="Card details (demo data, dark theme): title, stage, next action, priority and the linked agent with its state">

## Install

Run these where the Paseo server (daemon) runs, as the same user. An npm install needs Paseo **0.9.0 or newer**
(`paseo --version`); the optional `kanban` CLI needs Node.js **22 or newer** (`node -v`).

1. Install the plugin:

   ```sh
   paseo plugin install npm:paseo-auto-kanban
   ```

   Paseo shows a one-line trust warning first and runs no package scripts.

2. In Paseo, open **Settings → Plugins** and turn on **Enable plugins**. This switch covers all plugins; until it
   is on, an installed plugin stays `disabled`.
3. Check that it runs: `paseo plugin ls` should show `paseo-auto-kanban` as `running`.

A **Kanban** item then appears in the Paseo sidebar. It starts empty until a board exists: **start a new chat in a
Paseo workspace** and that workspace's board appears with a card for the chat. Chats opened before the install do
not fill a board.

> **Plugins are not sandboxed.** This one runs with the Paseo server's file access and can use Paseo's agent API.
> Read [what happens automatically](#what-happens-automatically) before installing.

## Updating and other install options

**From Git** at a release tag instead of npm (the same plugin):

```sh
paseo plugin install https://github.com/panto-dominic/paseo-auto-kanban --ref v0.2.2
```

The npm package is published from 0.2.1 on. 0.8.x installs plugins only from a folder or Git, not from npm.

**If it does not run.** The **Enable plugins** switch can still be off if you have not used a plugin before
(`paseo plugin enable <id>` turns on one plugin, not this switch). `disabled` in `paseo plugin ls` means that switch
(or the plugin's own enabled state) is off; a load error is shown in the same list. An empty Kanban screen says
*No boards registered yet*; you can also create a board yourself with `kanban init` (see [Command line](#command-line)).

**Updating.** The plugin and the `kanban` CLI are installed separately, so update both:

```sh
paseo plugin update paseo-auto-kanban
npm install -g --prefix ~/.local paseo-auto-kanban@latest
```

(the second line only if you installed the CLI that way — see [Command line](#command-line)). With no newer
release, the first line says `up to date`. To go to a specific release: `--version <version>` for an npm install,
`--ref <tag>` for a Git install; `install` again refuses an ID that is already installed.

**Requirements:** Paseo `>=0.8.0 <1.0.0` is what `paseo-plugin.json` declares (see [compatibility](#compatibility)
for what has actually been checked); installing from npm needs 0.9.0 or newer. Paseo compiles the TypeScript
sources itself, from either source — no build step is needed for the plugin. An npm install needs `npm` on the
Paseo server's machine. The optional CLI needs Node.js 22 or newer; see [Command line](#command-line). Like every
Paseo plugin, this one is not sandboxed: read the code before installing.

## Where your data lives

All boards live in **`~/paseo-kanban-data`** on the Paseo server's machine (override with `KANBAN_DATA_DIR`).
The folder keeps the project's earlier name, `paseo-kanban`, so boards made before the rename keep working.

| What | Where |
|---|---|
| Boards (cards, history), backups, settings | `~/paseo-kanban-data/` |
| `PROCESS.md` (generated, optional) | the workspace's own folder — see below |
| `.kanban/workflow.json` | the workspace's own folder, only when you press **Export** in the workflow view |
| Display settings (theme, screen size, board position, filters) | `~/paseo-kanban-data/ui-state.json`, per connected host |
| Last theme and language, to draw before the first read | the app's local storage, keys starting with `paseo-kanban:` |

Treat the data folder and any `PROCESS.md` as private: they contain your card titles and notes.
Details of every file are in [docs/reference.md](docs/reference.md#data-folder).

## What happens automatically

The plugin never contacts a network service and never deletes a card. These are the things it does without
you pressing a button, and how to turn each off. Settings open from the gear button at the top right of the
Kanban screen (on some phone screens, from the ⋯ menu) → **Kanban settings**.

| What | Default | Turn off |
|---|---|---|
| **Agent auto cards.** When Paseo creates a top-level agent (not a sub-agent), the server adds a card to that workspace's board and moves it on the agent's lifecycle signals. A card that already links the agent is updated instead. | On | Settings → Automation → **Agent auto cards** (the last choice saved from any device applies to the server), or per workspace under **By workspace**. Existing cards stay. |
| **Automatic boards.** A workspace with no board gets one, in the data folder, the first time a new top-level chat starts there. Chats and agents that existed before the plugin first ran never fill a board. No file is written into the workspace folder for such a board. | On (part of auto cards) | Same switches as auto cards. |
| **`PROCESS.md` in the workspace folder.** A board created with `kanban init`, or by adding the first card with **+** on an empty lane, writes `PROCESS.md` into the workspace folder and rewrites it after every change. It never overwrites a file it did not generate. Automatic boards do not get one until you run `kanban export`. | On | Set `"exportEnabled": false` in `~/paseo-kanban-data/config.json`. Existing files are kept. Consider adding `PROCESS.md` to your `.gitignore`. |
| **Archiving finished cards.** Cards that have sat in Done for the set number of days are archived (not deleted). They still count in progress and can be restored from the workspace's ⋯ → **Archived cards**. | 7 days | Settings → Automation → **Archive finished cards** → Off (or 3, 14, 30 days). |
| **Auto refresh.** While a Kanban screen is visible, it asks the server every 4 seconds which boards changed. It only reads (a check can also let the finished-card archive above run, at most every ten minutes) and pauses after 3 minutes without activity. | On | Settings → Automation → **Auto refresh**. |

Sending a card to an agent is **never** automatic: when you move a draft card to In progress, a confirmation
shows which chat will receive it, and only after you press **Send** does the server send the card to that
workspace's lead chat as a prompt (see [docs/reference.md](docs/reference.md#sending-a-draft-to-an-agent)).

The plugin also reads, without writing, Paseo's own workspace and label records under `~/.paseo/projects/`
to show names, labels and colours.

## Command line

The `kanban` CLI is optional. It lets orchestrator agents (and you) create and move cards from a terminal.
It needs Node.js 22+, no network, and no running Paseo.

```sh
npm install -g --prefix ~/.local paseo-auto-kanban
kanban --version
```

`--prefix ~/.local` installs into your home folder, so no `sudo` is needed. A plain `npm install -g paseo-auto-kanban`
fails with `EACCES: permission denied` when npm's global folder belongs to root (`/usr` or `/usr/local`, the default
for Node.js from apt or NodeSource); if `npm config get prefix` already points inside your home (nvm, for example),
that plain command works too. The command lands in `~/.local/bin`, which Ubuntu puts on `PATH` at login once the
folder exists; if `kanban` is not found right after installing, open a new terminal or run `hash -r`. Two names
are installed, `kanban` and `paseo-kanban` (the same tool).

If an earlier build of this plugin left a `kanban` link in `~/.local/bin` (`ls -l ~/.local/bin/kanban` shows it pointing
into a `paseo-kanban` folder), remove that link first, or the install stops with `EEXIST: file already exists`. Leave
a `kanban` that belongs to another tool alone and use `paseo-kanban` instead.

```sh
rm -f ~/.local/bin/kanban
```

The package has no runtime dependencies and runs no install scripts. To build it from source instead:

```sh
git clone https://github.com/panto-dominic/paseo-auto-kanban --branch v0.2.2
cd paseo-auto-kanban && npm ci --ignore-scripts && npm run build
npm link            # or link dist/src/cli/main.js into a folder on your PATH yourself
kanban --version
```

Check `command -v kanban` first; if another tool owns that name, use the identical `paseo-kanban` command.
Run the CLI as the same user as the Paseo server so both use the same data folder.

```sh
kanban card add --title "Review implementation" --criteria "- [ ] Findings recorded" --intent requested
kanban card link card_a1b2c3d4 --agent "$AGENT" --role reviewer --label "Review agent"
kanban card move card_a1b2c3d4 --to review
kanban ls
```

Give your orchestrator [docs/agent-guide.md](docs/agent-guide.md). The full command reference, JSON output
and retry rules are in [docs/reference.md](docs/reference.md#command-line-reference).

## Compatibility

The declared range is what Paseo lets you install, **not** what has been verified. Paseo checks it on the
server and again in each app; a version outside it is refused with the reason in Paseo's plugin settings.

| Kanban | Paseo server | App / platform | Date | What was checked |
|---|---|---|---|---|
| 0.1.46 – 0.1.64 | 0.10.2 | Web UI served by the daemon (wide and phone width) | 2026-10-02 – 10-13 | Release check of each version |
| 0.1.43 | 0.10.2 | Web UI served by the daemon (1920 and 390 wide) | 2026-10-01 | Same results before and after the Paseo update |
| 0.1.41 | 0.10.1 | Web UI served by the daemon (1920 and 390 wide) | 2026-09-30 | Same results before and after the Paseo update |
| 0.1.26 | 0.9.1 | Web UI served by the daemon | 2026-09-26 | Screens, settings, sub-card groups |
| 0.1.25 | 0.9.1 | Mobile app | 2026-09-26 | Filter sheet on a phone (manual check) |
| 0.1.8 | 0.9.1 | Mobile app 0.8.0 (Android) | 2026-09-23 | The plugin loads |
| 0.1.x | 0.9.1 | Mac app | 2026-09-20 onward | Daily use, not a structured check |
| — | 0.8.x, 0.9.2, later than 0.10.2 | any | not checked | Allowed by the range, unknown |

Rows for 0.2.0 are added after its release check. If something breaks after a Paseo update, see
[docs/paseo-release-check.md](docs/paseo-release-check.md#recovery).

## Moving from `paseo-kanban`

Earlier builds were installed under the plugin ID `paseo-kanban`. From 0.2.0 the ID is `paseo-auto-kanban`,
so Paseo treats it as a new plugin. Your boards are not tied to the ID and stay where they are. Run these on the
Paseo server's machine, as the same user as the Paseo server, after checking the versions as in [Install](#install):

```sh
cp -a ~/paseo-kanban-data ~/paseo-kanban-data.backup
paseo plugin remove paseo-kanban
paseo plugin ls
paseo plugin install npm:paseo-auto-kanban
paseo plugin ls
```

- `remove` prints the entry it removed once, still marked `disabled`; the next `paseo plugin ls` shows no
  `paseo-kanban` line. The **Enable plugins** switch stays on.
- After `install`, `paseo plugin ls` shows `paseo-auto-kanban` `running`, and the Kanban screen shows the same
  boards and cards. Start a new chat to see a card appear as before.
- Remove the old plugin **before** installing the new one, and do not keep both enabled. They share the same data
  folder and both react to every agent event, so cards stop moving properly: in a test, one of them took the
  other's move for a person's and stopped moving that card, which stayed in In progress after its agent finished.

If you used the old `kanban` CLI through a link in `~/.local/bin`, that link breaks when the old plugin is removed.
Replace it with the npm package (see [Command line](#command-line)):

```sh
rm -f ~/.local/bin/kanban
npm install -g --prefix ~/.local paseo-auto-kanban
kanban --version
```

Without the `rm -f` line the install stops with `EEXIST: file already exists`. From now on the CLI no longer updates
with the plugin; update both as in [Updating](#updating-and-other-install-options).

The data folder, the `kanban` CLI, and the file format names (`paseo-kanban.workflow/…`) keep the old name.
Settings that Paseo keeps per plugin ID (enabled or disabled) start fresh. Screens that showed Korean before keep
Korean (a `config.json` with `"locale": "ko"` or no `locale` line); new installations start in English.

## Uninstall

```sh
paseo plugin remove paseo-auto-kanban
```

This stops and removes the plugin. Paseo prints the removed entry once, marked `disabled`; after that
`paseo plugin ls` no longer lists it. Your data is left in place; delete it yourself if you no longer want it:

- `~/paseo-kanban-data/` (all boards, backups and settings),
- `PROCESS.md` in workspace folders, and `.kanban/workflow.json` if you exported one,
- the `kanban` command if you installed or linked it: `npm rm -g --prefix ~/.local paseo-auto-kanban` after an
  install with `--prefix ~/.local`, `npm rm -g paseo-auto-kanban` after a plain `npm install -g` or `npm link`, or
  remove your own link.

## Limitations

- **One machine per data folder.** Boards live on the Paseo server's disk. Do not share one data folder
  between machines or containers; lock recovery relies on the local process table (automatic on Linux).
- **No drag and drop.** Move cards with the stage menu or the card detail.
- **Mobile apps** are checked less than the web UI; keyboard and safe-area behaviour may vary by device.
- **The workflow view** (beta) reads workspace folders only on a Linux server, and exporting a workflow file
  is Linux-only.
- **Language:** new installations start in English. Korean is selected with `"locale": "ko"` in
  `config.json`; there is no language switch in the settings window yet.
- **Stage names differ by place.** The second stage is *In progress* on wide screens but *Doing* on the phone's
  tabs, and the first is stored as *Waiting* — `kanban ls` prints `todo (Waiting)` — while English screens show *To Do*.
- **Labs:** an experimental message-folder feature exists in the code but is hidden and off; it is not
  supported.
- Paseo publishes no stability promise for its 0.x plugin API; a new Paseo release may need a plugin update.

## Documentation

- [docs/reference.md](docs/reference.md) — screens, automatic cards, settings, data files, CLI reference
- [docs/agent-guide.md](docs/agent-guide.md) — instructions to give an orchestrator agent
- [CHANGELOG.md](CHANGELOG.md) · [CONTRIBUTING.md](CONTRIBUTING.md) · [SECURITY.md](SECURITY.md)
- [README.ko.md](README.ko.md) — 한국어 요약

## License

[Apache-2.0](LICENSE). Parts of the project icon and colour logic follow Paseo (Apache-2.0); see
[NOTICE](NOTICE) and [docs/reference.md](docs/reference.md#acknowledgments).
