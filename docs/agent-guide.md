# Agent workflow guide

Give this page to an orchestrator (lead) agent, for example by pasting it into the workspace's `AGENTS.md` or
`CLAUDE.md`. It assumes the `kanban` CLI is on the agent's `PATH` (see the README, *Command line*) and runs as
the same user as the Paseo server, so both use the same data folder.

Use one board per workspace and one card per meaningful task or stage of work.
Cards describe work; agent execution status is only a signal.

## Start and delegate

1. Inspect `kanban ls`. With agent auto cards on, the workspace usually already has a board. Run `kanban init`
   only when `kanban ls` says `No board matches this directory`.
2. After decomposing work, create cards with clear acceptance criteria.
3. Prefer `kanban apply tasks.json` for several cards in one transaction.
4. Link the assigned agent with a display role and title snapshot.
5. Move cards when your assessment changes, not when a process goes idle.

```sh
kanban card add --title "Review result" --criteria "- [ ] Findings recorded" --intent requested
kanban card link card_a1b2c3d4 --agent "$AGENT" --role reviewer --label "Review agent"
kanban card move card_a1b2c3d4 --to doing
kanban card update card_a1b2c3d4 --deliverable docs/result.md --awaiting agent
```

- Replace example prefixes with unique prefixes from `ls`; automation should retain full IDs.
- `PASEO_AGENT_ID` identifies the actor and defaults new cards to requested work.
- Workspace selection is `--workspace` > `PASEO_AGENT_CWD` > current directory. Use an explicit workspace ID when
  multiple boards share a directory.
- Stage ids of the default board are `todo`, `doing`, `review` and `done`.

## Leads and topic leads

- The board treats a chat as the workspace's **lead** when a person marked it so from a card's menu, or when its
  title starts with `Lead-` (or its profile with `Lead_`, any case). The Korean prefixes `총괄-` / `총괄_` work
  the same way. The lead's card gets a crown and a status line.
- A **topic lead** — a lead you start under the workspace's lead for one topic — should be created with the label
  `role=topic-lead` (`labels.role`; the Korean `주제총괄` also works). Its card shows a medal, its whole title and
  its own sub-cards' line, and it never receives the workspace's drafts.
- A topic lead makes a card for each of its own delegations and links its sub-agent there, as the workspace's
  lead does.

## Review and ask for input

- On receiving work, inspect the deliverables against acceptance criteria.
- Move into a review stage only by an explicit command.
- Set `--awaiting user` and a concrete `--next-action` when a decision is needed.
- Put a block in `--blocked-reason`; clear it with `--clear-blocked` when resolved.
- Set `--awaiting none` when the response arrives. Completion (`countsAsDone`) excludes cards from attention
  counts and filters, retaining the saved `awaiting`; `PROCESS.md` omits completed human-response and block
  signals.
- Mark completion only after the criteria are met. Reopen work when necessary.
- Write acceptance criteria as checklist lines (`- [ ] item`, one per line); the card shows how many are met
  ("Criteria 2/3").
- Before moving a card to a completion stage, tick each met line (`- [x] item`) with
  `kanban card update <id> --criteria "..."`. A done card with unticked lines is marked "Criteria unchecked" on
  the board (a quiet mark, not a needs-attention count).
- Archive obsolete cards with `card update CARD --archive`; use `--restore` to resume.

## Time in stage

- Cards in the progress and review stages show how long they have sat there (a clock and "14h", from one hour on).
  It turns orange with ⚠ after 12h in review, or after 2h in progress with no linked agent running (a permission
  wait or a card awaiting a person does not count) — a quiet signal, not a needs-attention count.
- The entry time is the card's own `stageEnteredAt` (set by the plugin whenever a write changes the card's stage;
  never edit it), else the move history — shown "(estimated)" only when that history was trimmed.
- So move a card when its work moves on, and keep a card in progress linked to the agent doing the work; an
  unlinked or finished card left in progress is flagged after 2h.

## Automatic cards

- Agent auto cards (created for top-level Paseo agents) follow their agent until somebody else moves them. A
  `card move` you make on such a card is kept: later signals of any of its agents (one you link afterwards too) no
  longer move it, until a person chooses "Resume automatic tracking" in the card detail.
- Archiving an agent leaves its card in review, never in a completion stage — completion is a person's decision.
- Sub-agents get no card of their own; link them to the cards you create for their work.

## Work that is not an agent's turn

When you run tests or a build yourself (or a person or a script does), show it with a busy mark on the card in
the progress stage:

```sh
kanban card busy <full card id> "Testing"
kanban card busy <full card id> --off          # when done — including when the run fails
```

- The card shows a dashed ring and edge with the text and elapsed time; marking again replaces the text and
  restarts the time. `--by` records who (default `PASEO_AGENT_ID`, else `cli`).
- The mark lives in the data folder's `busy.json`, not the ledger: no revision, no `PROCESS.md` change, and
  archiving the card drops it.
- It is never switched off by time: after 2 hours the card turns orange and counts as needing a person, who can
  turn it off in the card detail.
- While it is on, the progress stage's 2h no-agent warning stays quiet, and the lead card's status line shows it
  as testing. (Older boards may still use a Korean check-card title rule; the busy mark replaces it.)

## Requests sent from the board

- A lead that receives a prompt starting with `[Kanban request]` (`[칸반 요청]` on a Korean board) got it from a
  person's draft card moved to the progress stage. It is sent only after the person confirms, only while the lead
  is idle, and once per card.
- Link your worker to that card (`kanban card link <card id from the prompt> --agent "$WORKER"`) and use it as the
  delegation card; do not create a second card for the same request.
- The card carries `dispatch` (`pending` / `sent` / `noLead` / `cancelled`) — the plugin sets it; never edit it,
  and a new request needs a new draft card.
- People also write drafts from the "+" at the right end of a workspace's To Do heading (the To Do tab's workspace
  heading on a phone): an ordinary `add` into that workspace's first stage, its criteria set with an `update`
  right after — treat it like any other draft card.
- Agents cannot use the `dispatch` or `dispatched` operations (`kanban apply` refuses them): sending a draft to the
  lead is the person's act, from the board screen.

## Editing and retrying

Default writes use the latest locked state. Unrelated fields survive; replacing the same field twice applies the
later request. For edits based on previously read notes, retain that read's revision and pass `--if-revision`;
reconsider a conflict.

For batches or scripts, generate a request ID once and retain it:

```sh
ID=$(node -e 'console.log(crypto.randomUUID())')
kanban apply tasks.json --request-id "$ID"
```

If a response is lost, reuse the same key and original arguments, without generating another ID. If no key was
retained, inspect `ls` and `card show` before resending. Replay is bounded by retained receipts for actual
changes; no-op receipts are not saved. A success with an export warning still means the card is saved. Repair the
output cause and run `kanban export`; do not create the same card again.

## Do not

- Treat idle, cancellation or a finished model turn as task completion.
- Edit `PROCESS.md`; it is a one-way generated view of the ledger.
- Start or message an agent merely because a card becomes requested.
- Blindly replace a conflicting revision or automatically use `unlock --force`.
- Place real work data, credentials or internal terminology in a public repository.
