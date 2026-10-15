# paseo-auto-kanban reference

The [README](../README.md) covers installation, what happens automatically and how to remove the plugin.
This page describes the model, the screens, the automatic features, the data files and the command line in
detail. Facts here follow the code; when they disagree, the code wins and this page has a bug.

- [Concepts](#concepts)
- [Screens](#screens)
- [Agent auto cards](#agent-auto-cards)
- [Sending a draft to an agent](#sending-a-draft-to-an-agent)
- [Auto refresh](#auto-refresh)
- [Archiving finished cards](#archiving-finished-cards)
- [Kanban settings](#kanban-settings)
- [Workflow view (beta)](#workflow-view-beta)
- [Data folder](#data-folder)
- [Workspace identity](#workspace-identity)
- [Writes and generated output](#writes-and-generated-output)
- [Command line reference](#command-line-reference)
- [Locks and recovery](#locks-and-recovery)
- [When Paseo answers in an unexpected way](#when-paseo-answers-in-an-unexpected-way)
- [Layout details](#layout-details)
- [Plugin internals](#plugin-internals)
- [Acknowledgments](#acknowledgments)

## Concepts

- **Board.** One per workspace, stored as a JSON ledger in the data folder. The default template `basic@1` has
  four stages: Waiting (shown as *To Do* on English screens), In progress, Review and Done. Stage ids are
  `todo`, `doing`, `review`, `done`; Done is the completion stage (`countsAsDone`).
  The names differ by place: the phone's tabs say *Doing* for In progress, and the CLI prints the stored name,
  so `kanban ls` shows `todo (Waiting)` for To Do.
- **Card.** A unit of work: title, acceptance criteria, notes, next action, priority, deliverables, block reason,
  `awaiting` (agent / user / none) and linked agents. Cards are archived, never deleted.
- **Intent.** A person creates *drafts* by default; an agent identified by `PASEO_AGENT_ID` creates *requested*
  work by default. Requested work needs acceptance criteria. A draft stays in the first stage.
- **Needs attention.** An active card outside the completion stage that has `awaiting=user`, a block, or is a
  draft. It is never inferred from a stage name or an agent role. Completion does not clear `awaiting`, but a
  completed card no longer counts as needing attention and `PROCESS.md` omits its signals.
- A blocked card cannot enter a completion stage; reopen completed work before blocking it.
- **Agent state is a signal, not completion.** Idle, cancelled or a finished model turn never marks a card done.

## Screens

The sidebar **Kanban** item opens the overview of every project. Each workspace also has a **Kanban** panel
showing its own board. Both share the card detail sheet.

### Wide layout (760 px and wider)

- One swimlane per workspace, grouped by project (the **Group by project** switch beside the view switch turns grouping off). Each lane repeats the stage
  headings with counts; cards carry a coloured stage stripe (grey / blue / purple / green).
- Projects that need attention come first, then by recent activity. Inside a project, lanes with cards come
  before card-less lanes. Lanes preview three cards per stage; *Show all* expands one lane; the Done column shows
  at most ten cards with a link to the full board.
- Every unarchived Paseo project and workspace is listed, with or without a board. A workspace with no board is a
  folded lane marked *No cards*; its **+** creates the board and the first card (see
  [Writes](#writes-and-generated-output)).
- A board whose workspace is no longer in Paseo is listed under **Not found in Paseo** at the end. Boards of
  archived or deleted workspaces that have no live cards are hidden; Settings → About shows how many and can show
  them for the session.
- The filter row stays at the top: project checklist, workspace labels (OR between labels), **Needs attention**,
  and search. Search is case-insensitive and matches every word in a card's title and next action. Filters combine
  with AND. Hiding a project narrows the board rather than filtering cards.
- Project and workspace headings have a ⋯ menu with Move to top / up / down and Reset to automatic order. Lanes
  with cards and card-less lanes are two layers; a move stays inside its layer. The arranged order is remembered
  per host in `ui-state.json`.
- Names follow Paseo's sidebar: a single-workspace project shows the project name, adding the workspace name when
  it differs; workspace rows add `branch · folder` in muted text.
- Headers pin while scrolling: the project header, then the lane header beneath it.

### Phone layout (below 760 px)

The same model is shown as stage tabs (starting at In progress) with cards grouped by workspace. The attention
chip and tabs share one row; filters and search are in a sheet. Tap or long-press names to expand them. There
is no drag; move a card from its menu or detail.

### Cards

- **Live agent state.** Cards show the linked agents' current Paseo state (error, waiting for input or permission,
  working, finished and needing review, finished, unavailable) from the host's subscription — no ledger write.
  Press or hold the mark to name it; nothing depends on hover. A folded lane header shows only the urgent tally.
- An agent the listing never names is looked up once per session: archived reads as finished, an unknown or
  refused lookup stays unavailable (at most three lookups at once).
- **Acceptance criteria as a checklist.** Lines written `- [ ] item` show progress ("Criteria 2/3"). A done card
  with unticked lines shows a quiet *Criteria unchecked* mark.
- **Time in stage.** Cards in In progress and Review show how long they have been there from one hour on. The
  mark turns orange after 12 h in Review, or after 2 h in In progress with no linked agent running (a permission
  wait or a card awaiting you does not count). It is a quiet signal, not an attention count.
- **Busy mark** for work that is not an agent's turn (a test run, a build): `kanban card busy CARD "Testing"`
  turns it on, `--off` turns it off. It is stored in `busy.json`, not the ledger, and is never switched off by
  time; after 2 hours the card asks for a person.
- **Lead cards.** A workspace's lead chat (see [Sending a draft](#sending-a-draft-to-an-agent)) gets a crown and a
  status line: its own state (working, your turn, resting), then counts of its sub-cards. A topic lead — an agent
  started by the lead with the label `role=topic-lead` — gets a medal. Sub-agents' cards are grouped under the
  card of their top-level agent.
- **Card detail.** Edit title, notes, next action, priority, block reason and awaiting; choose a stage; see
  linked agents with model and thinking level, the author, and the stage history (with why the card is where it
  is). Wide screens use a two-column dialog up to 720 px; phones use a bottom sheet.
- **Conflicts.** Edits send the board revision and a request id. A conflict keeps your draft and offers a
  latest/mine comparison; a lost response re-reads the board and keeps the original request for an explicit,
  idempotent retry.

### Demo data

A preview with fictional projects, built in memory, exists for screenshots and development. It is shown only on
a device where the browser storage key `paseo-kanban:dev-demo` is `1`. While it is on, real reads pause, all
editing is disabled, and nothing reaches settings, ledgers or `PROCESS.md`.

## Agent auto cards

When Paseo creates a **top-level** agent (no parent) in a workspace, the plugin server adds one card in the first
stage: the agent's title, automatic acceptance criteria in the board's language, created by and linked to that
agent. The agent's own lifecycle signals then move it:

| Signal | Card |
|---|---|
| turn started | second stage (In progress) |
| turn ended | last open stage (Review) |
| permission requested / resolved | sets / clears `awaiting=user` (a flag a person set is never cleared) |
| archived | last open stage — archiving never completes a card; a person moves it to Done |

- **A person's move wins.** Once a card is moved by anything other than this feature after tracking began — the
  board, the detail view, or `kanban card move` by a person or any agent — its automatic moves pause for good, for
  all its agents, including ones linked later. The permission flag and the automatic title still follow. The card
  detail shows why the card is where it is and offers **Resume automatic tracking**. Unlinking an agent is not a
  move.
- A card that already links the agent (for example one an orchestrator linked) is updated instead of a second
  card being made. A board made after the agent started gets its card at the agent's next signal.
- Sub-agents never get their own card; the parent they had when first seen is remembered so their cards group
  under the parent's card.
- An agent in a worktree workspace without a board of its own uses the board at its project's root folder, if one
  exists (its own board always wins).
- **Automatic boards.** A workspace with no board gets one when a top-level agent created after the feature's
  start line sends a signal. The start line is the first run of a version that makes boards, or the moment the
  workspace was switched back on. The board is made in the folder Paseo names for the workspace (a worktree's at
  its project root), once per real folder (a symbolic link is the same folder), and only for an agent Paseo's own
  record confirms (created after the start line, not archived, not a sub-agent). It writes **no `PROCESS.md`**;
  `kanban export` writes one on request, and from then on it is kept up to date. Older chats never join such a
  board, so an upgrade does not fill boards.
- **Restarts.** After a server restart, the first hook or board read lists the agents once and repairs signals
  missed for agents created since the feature started. This runs once per server run.
- Writes happen only when an agent's stage bucket, permission flag or automatic title changes, through a serial
  queue per workspace. Failures are logged and never reach the daemon.

### Switches

- Settings → Automation → **Agent auto cards** (default on). Each device shows its own saved choice; the server
  obeys the most recent choice saved from any device.
- **By workspace**: off stops that workspace's new cards, automatic moves and automatic board. Existing cards
  stay. At most 1,000 workspaces can be switched off; a further one is refused.
- A switch takes effect for every signal read after it was saved; a move already being written may still finish.
- Folders are compared after normalisation (no trailing separator, Unicode NFC; on Windows `/` separators, a
  lower-case drive letter and case-insensitive comparison). Two spellings of one Windows folder share a switch;
  turning a folder on in a spelling that was never saved while another spelling is off is refused (`E_CONFLICT`).

### `auto-cards.json`

The feature's state lives in the data folder: the switch per host, the moment the feature first ran
(`activatedAt`; agents created before it are never back-filled), the start line for boards (`autoBoardFloor`),
per agent the card and the state it last applied, pause and resume times, the per-workspace switches, and the
boards the feature made (which never get a `PROCESS.md` created after a commit). Every write keeps the same bytes
in `auto-cards.backup.json`.

A file that exists but cannot be read (not JSON, another schema, wrong shapes, over 8 MiB, a read error) is
**damaged**: automatic cards stop entirely — no card, no move, no board — no switch can be saved, the bytes are
never overwritten, and the screens say tracking is held. Repair the bytes or copy `auto-cards.backup.json` over
it. Deleting `auto-cards.json` alone changes nothing (it is read from the backup). Deleting both is a reset to
"on, nothing applied yet", which also turns every board the feature made into an ordinary board (it gets a
`PROCESS.md` at its next change).

## Sending a draft to an agent

A person can hand a draft card to the workspace's lead chat:

1. Move a draft card to In progress (or use the **+** at the right of a workspace's To Do heading to write one).
2. A confirmation shows the card, the message, and which chat will receive it. Nothing is sent before you press
   **Send**; cancelling leaves the card unchanged.
3. The server sends the card as a prompt starting with `[Kanban request]` (in the board's language) once the
   receiving chat is idle, and only once per card. Moving the card back cancels a pending send.

The receiving chat is, in order: a chat you marked as the workspace's lead from a card's menu; a top-level chat
whose title starts with `Lead-` (or whose profile starts with `Lead_`, any case); otherwise the workspace's most
recent top-level chat, including chats in the project's worktrees. The card shows the state (`pending`, `sent`,
no lead, cancelled). Agents cannot send drafts themselves: `kanban apply` refuses the dispatch operations.

## Auto refresh

The plugin SDK cannot push from the server, so an open screen asks for board revisions only (board ids and
revision numbers) about every 4 seconds, and re-reads only boards whose revision changed. It asks only while the
screen is mounted and in the foreground, stops after 3 minutes without a touch, click, scroll or key, and asks
again at once on the next interaction, focus or return to the foreground. The check itself never writes, but like any read it lets the finished-card archive run (at most every ten
minutes). The title row says
*Auto refresh on*, *Paused · last checked HH:MM* or *Auto refresh off*. Turn it off in Settings → Automation; the
refresh button still works.

## Archiving finished cards

Cards that have been in a completion stage for the set number of days (default 7; Off, 3, 7, 14 or 30) are
archived. The sweep runs when a screen reads the boards, at most every ten minutes, and at once when the days
change; with no screen open, nothing is written. Archived finished cards still count toward progress. The Done
heading shows done and archived counts and offers a one-step **Tidy**. The workspace ⋯ → **Archived cards**
lists them with **Restore**. Archiving a card before it is done removes it from progress (for cancelled or
duplicate cards). The setting is stored in `auto-archive.json`; a damaged file turns the sweep off until a value
is chosen again.

## Kanban settings

Open from the gear button at the top right of a Kanban screen. Categories on the left on wide screens, a bottom
sheet on phones. Each row saves on its own and applies only after the server confirms it; a failed save keeps
the previous value and offers **Try again**.

| Category | Rows |
|---|---|
| Display | Theme (Paseo, system, light, dark), Screen size (80–150 %, only the Kanban area), Board position (left / centre / right on screens wider than the board), Reset order |
| Automation | Agent auto cards, By workspace, Archive finished cards, Leads by workspace (read only), Auto refresh |
| About | Version, connected host, hidden empty boards |

Display rows are stored per host in `ui-state.json`. The screen language comes from `locale` in `config.json`.
A **Labs** category appears only on devices with the developer key; its features are experimental, off by
default, and not supported.

## Workflow view (beta)

On wide screens a lane can show a workflow: the steps of a process drawn as a flow, with a table of evidence per
release or per case. The definition is the file `.kanban/workflow.json` in the workspace folder (formats
`paseo-kanban.workflow/1` and `/2`). The view only reads files inside the workspace folder (links are not
followed outside it), within fixed limits, and never runs git. Folder reading is supported on Linux servers.

A lane without a definition can try one of eight built-in templates; the choice is stored in the data folder
(`workflow-picks.json`), not in the project. **Export to the project folder** writes `.kanban/workflow.json`
after a confirmation; it never overwrites an existing file and is available on Linux servers only. On phones the
view opens from the lane menu as a full-screen sheet.

## Data folder

Precedence: `--data-dir` > `KANBAN_DATA_DIR` > `~/paseo-kanban-data`. The Paseo server and the CLI must select
the same folder and run as the same OS user in the same process namespace.

```text
config.json                    # schemaVersion, exportEnabled, locale, export.detail
ui-state.json                  # plugin view state per host (filters, order, settings); the CLI never reads it
auto-cards.json                # agent auto cards (switches, boards made, last applied state per agent)
auto-cards.backup.json         # the same bytes, written after every write of auto-cards.json
auto-archive.json              # days before finished cards are archived
busy.json                      # busy marks per card
workflow-picks.json            # built-in workflow tried per workspace (+ .backup.json)
boards/<boardId>.json          # template snapshot, cards, history, receipts
boards/<boardId>.lock          # temporary writer ownership
_archive/<boardId>/<epoch>-<seq>.json   # previous ledger generations
templates/<id>@<version>.json  # manually installed user templates
```

- `config.json` defaults to
  `{"schemaVersion":1,"exportEnabled":true,"locale":"en","export":{"detail":"compact"}}` and rejects unknown
  fields. `locale` is `en` or `ko` and sets generated text and built-in labels; commands, errors and identifiers
  stay English. `export.detail` is `compact` (short ids, one header time) or `full` (criteria, notes,
  deliverables).
- **Screen language.** With no `config.json`, screens start in English. A `config.json` without `locale`, written
  by an earlier version, keeps the Korean screens those versions showed. Add `"locale": "en"` to change it.
- `ui-state.json` and the other plugin files are written through a temporary file and rename, only when a value
  changes. A missing or malformed `ui-state.json` means "nothing hidden, automatic order" and is never repaired on
  its own.
- The protected roots `~/.paseo` and `PASEO_HOME` are never ledger or export destinations.
- Stop writers before replacing configuration or user templates. Published template versions are immutable;
  existing boards keep their own snapshot.

## Workspace identity

Selection is `--workspace ID|PATH` > `PASEO_AGENT_CWD` > current directory. Explicit paths and the environment
variable can initialise an exact nested workspace; plain current-directory initialisation reuses an existing
ancestor board.

Identity is `workspaceId`, not the directory. Without `init --workspace-id` or a saved `--paseo-map` file, `init`
reads Paseo's workspace record (`workspaces.json` in the `projects` folder of `PASEO_HOME`, default `~/.paseo`) read-only and adopts
the live workspace id registered for that directory. A missing, oversized, malformed or ambiguous record leaves a
stable local id derived from the directory, so the CLI works without Paseo. Nothing is written to that record.

A board created before Paseo had a workspace at its folder keeps its local id. The plugin pairs such a board with
the workspace whose folder is the same (trailing separators removed, Unicode NFC), shows that workspace's title
and project, and routes **+** to the existing board, so one folder never gets two boards. A board at a project's
root folder that no workspace carries is shown as a workspace row named after the project, marked *original
path*. Ledger identities are never rewritten.

Workspace labels come from Paseo's workspace listing; label colours from `workspace-labels.json` in the same `projects` folder
(read-only). Missing or incompatible metadata hides the label filter.

## Writes and generated output

**Reading never changes a board**, with two exceptions that belong to automatic features: the first board read
after a server restart lets agent auto cards catch up on missed signals, and a read lets the finished-card
archive run (at most every ten minutes); auto refresh checks count as such reads.

- A change atomically replaces only its board ledger, through a temporary file, rename and fsync. Same-content
  requests change nothing.
- The previous ledger is kept as a hard link (or a copy, with a warning) in `_archive/`. The latest 20 backups
  and 1,000 movement records and receipts are kept. The 30-board, 300-card and 2 MiB thresholds warn instead of
  rejecting work. Unreadable or mismatched old backups are preserved and reported as unmanaged.
- **`PROCESS.md`.** After a change, a board that has an export writes `PROCESS.md` in its workspace folder while
  still holding the board lock: deterministic content, comparison first, a temporary file and rename. It is
  derived output, not a backup. A board gets an export when it is created by `kanban init` or by the plugin's
  **+** on a board-less lane (the same path), or after `kanban export` on an automatic board.
- It never overwrites a file it did not generate, a file of another board, or a symbolic link. Protected or
  missing folders and ambiguous ownership are skipped with warnings. Only the sole active board at a folder can
  export there.
- An export failure does not roll back a saved card. Fix the cause and run `kanban export`.
- Turn exports off with `"exportEnabled": false` in `config.json`; existing files are kept. Do not edit
  `PROCESS.md` by hand.

## Command line reference

### Installing from npm

```sh
npm install -g --prefix ~/.local paseo-auto-kanban
kanban --version
```

`--prefix ~/.local` avoids the `EACCES` a root-owned npm global folder gives; an old `kanban` link in `~/.local/bin`
stops the install with `EEXIST` until it is removed (see the README's [Command line](../README.md#command-line)). The CLI
does not update with the plugin: `npm install -g --prefix ~/.local paseo-auto-kanban@latest`.

### Building and linking

```sh
npm ci --ignore-scripts
npm run build
node dist/src/cli/main.js --help
npm link            # optional; changes your executable search path
kanban --version
```

Run `command -v kanban` first; if another tool owns the name, use the identical `paseo-kanban` executable. In a
container, keep the checkout and the link on a persistent volume:

```sh
checkout="$(pwd -P)"
mkdir -p "$HOME/.local/bin"
test ! -e "$HOME/.local/bin/kanban" && test ! -L "$HOME/.local/bin/kanban"
ln -s "$checkout/dist/src/cli/main.js" "$HOME/.local/bin/kanban"
chmod u+x "$checkout/dist/src/cli/main.js"
export PATH="$HOME/.local/bin:$PATH"   # also add this to your shell configuration
```

Rebuilding keeps an existing file's mode; check the executable bit after replacing build output. A compatibility
executable at `dist/cli/main.js` forwards old links to `dist/src/cli/main.js`.

### Five-minute workflow

```sh
kanban init
kanban card add --title "Review implementation" --criteria "Record findings and decision" --intent requested
kanban card link card_a1b2c3d4 --agent "$AGENT" --role reviewer --label "Review agent"
kanban card move card_a1b2c3d4 --to doing
kanban card update card_a1b2c3d4 --notes "Findings recorded" --deliverable docs/result.md
kanban card move card_a1b2c3d4 --to review
kanban card update card_a1b2c3d4 --awaiting user --next-action "Confirm the decision"
kanban ls
kanban card show card_a1b2c3d4
```

Replace `card_a1b2c3d4` with a unique prefix from the created card; automation should keep full ids. With agent
auto cards on, a board usually already exists; `kanban init` is needed only when `kanban ls` says
`No board matches this directory`.

### Commands

Every command has `--help`; `--json` prints one envelope on stdout and diagnostics on stderr.

| Command | Purpose |
|---|---|
| `init` | Create or reuse a board; `--list-templates` / `--show-template` inspect templates |
| `rev` | Print the current board revision |
| `ls` | Compact card list; `--full` for all fields, `--all` for board summaries |
| `card add` | Create a card (`--title` required) |
| `card move` | Move a card `--to` a stage |
| `card update` | Change fields, `--archive`, or `--restore` |
| `card link` | Link an agent, or unlink with `--remove` |
| `card show` | Complete card and retained movement history |
| `card busy` | Mark a card busy with a text; `--off` ends it |
| `apply FILE` | Atomic JSON batch (`-` reads stdin) |
| `export` | Compare and refresh `PROCESS.md` |
| `doctor` | Read-only ledger and output checks with recovery guidance |
| `unlock` | Recover an abandoned lock; `--global` selects the metadata lock |

Success JSON is `{ok:true,data,committed,warnings,meta}`; errors are
`{ok:false,error:{code,message,target,nextAction,details},committed}`. Exit codes: 0 success (including
post-commit export warnings), 2 input/transition, 3 missing/ambiguous selection, 4 revision/request conflict,
5 lock, 6 I/O/export/path, 7 corruption/schema. A write I/O failure may have committed; inspect before retrying.

### Safe retries

`--request-id` and `--if-revision` are optional. Without them, writes are serialised and applied to the current
state: unrelated fields survive, and the last replacement of the same field wins.

```sh
ID=$(node -e 'console.log(crypto.randomUUID())')
kanban card move card_a1b2c3d4 --to review --request-id "$ID"
```

For a retry, reuse the same `ID` and exactly the original arguments. For edits based on text you read earlier,
capture the revision (`kanban rev` or `card show --json`) and pass it with `--if-revision`; a conflict means
reconsider the edit. If a response is lost and no id was kept, inspect `kanban ls` and `card show` before
resending. Replay covers retained receipts of actual changes (the latest 1,000); no-op receipts are not saved.

### Batches

`kanban apply tasks.json` or `kanban apply -` (UTF-8 JSON on stdin). One board, 1–100 operations, at most 1 MiB.
All operations succeed or nothing is saved. Operations: `add`, `move`, `update`, `link`, `unlink`, `archive`,
`restore`. JSON uses model field names such as `acceptanceCriteria` and `blockedReason`. New card ids cannot be
referenced later in the same batch. Guards may be in the file or the CLI options, not both.

```json
{"operations":[{"op":"add","title":"Review","intent":"requested","acceptanceCriteria":"Findings recorded","awaiting":"agent"}]}
```

### Programmatic use

`openStore()` from `server/core` is ledger-only by default; opt into exports with
`openStore({afterCommit: exportCommittedBoard})`.

## Locks and recovery

Run `kanban doctor --workspace BOARD_ID`. When an owner is confirmed dead but too recent, the output includes the
reclaim time. `kanban unlock` requires a lock older than 60 seconds and proof that its process is gone or its
start identity differs; a slow live owner is never taken over. Linux identifies abandoned locks through `/proc`;
elsewhere, offline recovery is needed.

An unknown namespace or unavailable process identity needs offline recovery: stop all writers, inspect the
reported paths, then `kanban unlock --force` (which asserts writers are stopped — never put it in an automatic
retry loop). Containers with different process namespaces must not share a live data folder.

Corruption is never replaced by an empty board. Keep the damaged bytes, stop writers and restore a validated
backup with a new revision epoch and empty receipts, through a new file and rename; never edit a hard-linked
backup in place.

## When Paseo answers in an unexpected way

- **Automatic moves are held, not guessed.** An unknown agent status (outside `initializing`, `idle`, `running`,
  `error`, `closed`), a missing field, or a hook whose agent lacks its fields moves nothing. An agent listing that
  fails, times out or answers in another shape applies nothing; an agent missing from it is never taken as
  finished. The repair is retried three times, then at the next hook or read (at most every 30 seconds), or five
  minutes after the last failure.
- **Each screen says what could not be read**, one quiet line per feature: workspace names, agent states,
  automatic tracking, auto refresh.
- A plugin that Paseo refuses to load cannot say anything itself; Paseo's plugin settings show the reason.

## Layout details

- Wide board: 280 px columns, 264 px cards, 44 px header rows, project groups 14 px apart, workspace lanes 8 px
  apart and indented 24 px behind a disclosure arrow (12 px at 390 px wide). Lane headers carry a 96 px progress
  bar over requested work (drafts excluded). Panels keep a contrast of at least 1.15:1 against the page and cards
  against their panel in both themes.
- Narrow layouts budget the first card at 168 px (overview) or 149 px (workspace panel, including the host's tab
  row) from the top, assuming a 64 px host header. Larger host chrome or OS text scaling needs a device check.
- Phone sheets add conservative bottom clearance (Android 56, iOS 44) because the plugin cannot read the host's
  insets. Keyboard and system-bar behaviour still need device checks.
- View choices, lane expansion and selected stages live in memory for the loaded plugin session and survive
  remounts (for example a theme change), not a reload.
- Wide card details use the public React Native modal (up to 720 px, 90 % of the window, two columns from 640 px);
  phones keep the host's sheet.

## Plugin internals

- `shared/core/domain.ts` is the pure domain; `server/core/` owns file storage and export. The CLI (`src/cli/`)
  and the plugin server import the same modules — no copied core.
- The plugin's read model derives completion times and linked agent ids without changing ledger fields.
- `kanban.v1.overview.get` accepts `includeBoards:true` and optional `boardIds` (1–20) to return board views with
  the summary; unchanged files reuse a validated stat cache. `kanban.v1.revisions.get` returns board ids and
  revisions only.
- `npm run build` writes `server/version.ts` from `package.json`; the CLI uses the same constant. An optional root
  `release.json` (`{version, release, date}`) is captured at build time; without it, About says *Development
  build*.

## Acknowledgments

Project initials, project view-key rules and identity-colour hashing and palette follow
[Paseo v0.8.0](https://github.com/getpaseo/paseo/tree/v0.8.0/packages/app/src), licensed under
[Apache-2.0](https://github.com/getpaseo/paseo/blob/v0.8.0/LICENSE): `styles/identity-colors.ts`,
`utils/project-display-name.ts`, `workspace-structure.ts` (in `projects`), `components/project-icon-view.tsx` and
`components/sidebar/project-leading-visual.tsx`. The attribution is repeated in `client/project-icon.ts` and
`client/palette.ts`. These sources were used to match results, not to import private host components. Custom
project icon images are not in the public directory data, so the plugin draws the matching initial box. See also
[NOTICE](../NOTICE).
