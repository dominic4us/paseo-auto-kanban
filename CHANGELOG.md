# Changelog

All notable changes, newest first. Versions before 0.2.0 were private test builds published under the plugin
ID `paseo-kanban`; this summary groups them by theme.

## 0.2.1

- **Install from npm.** The plugin can be installed with `paseo plugin install npm:paseo-auto-kanban`, and the
  `kanban` CLI with `npm install -g paseo-auto-kanban`. The package carries the plugin sources Paseo compiles, the
  built CLI and the licence notices — no tests or development files — and runs no install scripts. Installing from Git works as before.
- **Workflow view:** a built-in workflow now says at the top that it reads no documents and shows the flow for
  reference, and how to fill the table (export it and add reading rules). On a phone, the table heading of a
  case-per-row workflow says when it also reads the record section, not only folder and file names. On wide
  screens, the label of a line that goes back is no longer hidden under the step it leaves and avoids other
  labels. Known limit: when a loop has been taken three times and steps show counts, its label can still touch a
  neighbouring label or step by a few pixels.

## 0.2.0 — first public release

- **Renamed** to `paseo-auto-kanban`. The plugin ID changed from `paseo-kanban`, so an existing installation must
  be removed and installed again (see the README, *Moving from `paseo-kanban`*). The data folder
  `~/paseo-kanban-data`, the `kanban` CLI and file format names keep their earlier names; existing boards keep
  working.
- New installations start in **English**. An existing `config.json` without a `locale` keeps the Korean screens
  earlier versions showed.
- Licensed under Apache-2.0. New README, reference documentation, contribution and security guides, issue forms.

## 0.1.56 – 0.1.64

- Finished cards are archived on their own after a number of days (7 by default; off, 3, 14 or 30 in settings).
  The Done heading shows done and archived counts with a one-step tidy, and archived cards can be listed and
  restored.
- **Workflow view (beta):** a definition file can describe one row per case (format 2), follow a document through
  its versions, show steps shared by every case once, and read confirmed decisions from a case log section, so
  only the chosen branch is drawn. Anything uncertain is shown as unclear rather than guessed. Folder reading no
  longer follows links outside the workspace and stops at fixed limits.
- Boards of archived or deleted workspaces with no live cards are hidden, with a count and a switch in settings.
- The Kanban screens can be drawn larger or smaller (80–150 %) without changing the rest of Paseo.
- The full test suite runs in one pass in about six minutes.

## 0.1.46 – 0.1.55

- **Automatic boards:** a workspace with no board gets one the first time a new top-level chat starts there, with
  no file written into the project folder. Agents and chats from before the upgrade are left alone. Each
  workspace can turn automatic cards off. A damaged automation file stops all automatic cards instead of
  guessing.
- **Sending drafts:** a draft moved to In progress can be sent, after confirmation, to the workspace's lead chat,
  or to its most recent top-level chat when no lead exists. A card's menu can mark its chat as the lead, and
  English `Lead-` titles count as well as Korean ones.
- Lead cards show the lead's own state (working, your turn, resting) and counts of their sub-cards; a one-line
  memo can be set from the detail.
- A lane without a workflow definition can try one of eight built-in templates and export it to the project
  folder as `.kanban/workflow.json` (never overwriting an existing file).
- English screens use more consistent wording; times follow the device's time zone.

## 0.1.33 – 0.1.45

- Drafts can be sent to the workspace lead from the board, with queued, sent and no-lead states.
- Cards show how long they have been in progress or review, with a quiet warning after 12 h in review or 2 h with
  no agent working. A `kanban card busy` mark shows work that is not an agent's turn (a test run, a build).
- Topic leads get their own medal; a lead waiting on its own question shows *Awaiting decision*.
- Workflow view per lane on wide screens and phones, read only from files inside the workspace.
- Assignee lines name the agent's model and thinking level.
- An experimental message-folder view was added; it is now hidden under Labs and not supported.
- Checked on Paseo 0.10.1 and 0.10.2.

## 0.1.20 – 0.1.32

- New card face with agent state, model icon and profile; two-column card detail with per-field save.
- **Cards stay where a person put them:** a manual move pauses automatic moves, and archiving an agent never
  completes its card.
- Sub-agents' cards are grouped under their top-level agent's card; lead cards get a crown and a status line.
- Acceptance criteria as checkable lines with progress ("Criteria 2/3").
- Automatic moves are held, not guessed, when Paseo answers in a shape the plugin cannot read; the declared
  Paseo range widened to `>=0.8.0 <1.0.0`.

## 0.1.4 – 0.1.19

- Support for Paseo 0.9.
- **Agent auto cards:** a card for every top-level agent, moved by the agent's lifecycle.
- Automatic refresh while a screen is visible; Kanban settings with board position, theme and more.
- Project and workspace order menus, project-root boards attached to their project, empty lanes sorted last.
- Boards reconnect to Paseo workspaces by folder, and `kanban init` adopts the real Paseo workspace id.
- Demo data moved behind a developer switch; contrast and phone layout improvements.

## 0.1.0 – 0.1.1

- File-based ledger with atomic writes, backups and lock recovery; the `kanban` CLI with JSON output, safe retries
  and batches; generated `PROCESS.md`.
- Paseo plugin: swimlane board on wide screens, stage tabs on phones, card detail editing, search, label and
  project filters, live agent status on cards.
