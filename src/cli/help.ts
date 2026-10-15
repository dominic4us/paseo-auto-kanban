export { PACKAGE_VERSION as VERSION } from '../../server/version.js';
export const rootHelp = `kanban - workspace process boards for agent orchestrators
Common flow (replace the example card prefix and set AGENT first):
  kanban init
  kanban card add --title "Review" --criteria "Record findings" --intent requested
  kanban card link card_a1b2c3d4 --agent "$AGENT" --role reviewer
  kanban card move card_a1b2c3d4 --to review
  kanban ls

Commands:
  init             Initialize; --list-templates or --show-template REF to inspect
  rev              Print the current revision only
  ls               Short card list; --full for complete cards; --all for all boards
  card add         Create a card (--title required)
  card move        Move CARD --to STAGE
  card update      Change fields, --archive, or --restore
  card link        Link --agent UUID; --remove to unlink
  card show        Complete card and retained movement history
  card busy        Mark CARD "TEXT" as busy (a test run, a build); --off ends it
  apply FILE|-     Apply a JSON batch atomically
  export           Compare and refresh PROCESS.md
  doctor           Read-only ledger and output checks
  unlock           Recover an abandoned lock; --force asserts writers are stopped

Global: --workspace ID|PATH, --data-dir PATH, --json, --help; --version
Selection: --workspace > PASEO_AGENT_CWD > current directory.
Writes: --if-revision REV and --request-id UUID are optional.
Defaults: current locked state; generated request id appears in the result.
Lost response? Inspect ls/card show before resending. Scripts should retain a key.
Use kanban COMMAND --help for arguments, examples, and safe retry guidance.
`;
const common = `Global options: --workspace ID|PATH --data-dir PATH --json --help
Workspace: --workspace > PASEO_AGENT_CWD > current directory.
`;
const writes = `Optional write guards: --if-revision REV --request-id UUID
Without guards, apply to the latest locked state. Same-field replacements are last-writer-wins.
For read-edit-write, retain the revision you read and pass --if-revision.
For retry safety, create an id once with node -e 'console.log(crypto.randomUUID())'.
Keep the id and original arguments; do not generate another id when retrying.
If a response is lost without a retained id, inspect ls/card show first.
`;
const fields = `Fields: --title TEXT --criteria TEXT --notes TEXT --priority high|normal|low
  --blocked-reason TEXT --next-action TEXT --intent draft|requested
  --awaiting agent|user|none --deliverable RELATIVE_PATH (repeatable)
Requested cards require nonempty --criteria. User defaults to draft; agent to requested.
`;
export const commandHelp: Record<string, string> = {
  init: `Usage: kanban init [--template ID[@VERSION]] [--workspace-id ID | --paseo-map FILE]
Or: kanban init --list-templates | --show-template ID[@VERSION]
Default template: basic@1. No external ID creates a stable local workspace ID.
An explicit path or PASEO_AGENT_CWD initializes that exact directory.
Without an explicit directory, an existing ancestor board is reused.
Paseo maps must be previously saved workspace-list JSON; kanban never calls Paseo.
A specified initialization revision must be 0 (board absent).
Example: kanban init --template basic@1
` + common + writes,
  rev: `Usage: kanban rev
Prints just the revision; --json wraps {boardId,revision}.
Example: kanban rev --workspace wks_example01
` + common,
  ls: `Usage: kanban ls [--full | --all]
Default: compact card summaries; --full includes notes, criteria, links and metadata.
--all returns every board summary and cards needing human attention.
--all cannot be combined with --workspace or --full. Archived cards require card show.
Example: kanban ls --json
` + common,
  'card add': `Usage: kanban card add --title TEXT [--stage STAGE] [fields]
` + fields + `Example: kanban card add --title "Review" --criteria "Record findings" --intent requested
` + common + writes,
  'card move': `Usage: kanban card move CARD --to STAGE
CARD is a full ID or a unique prefix (at least eight hex characters after card_).
Same stage is unchanged; archived cards must be restored first.
Completion requires requested intent, acceptance criteria and no block.
Moving does not change awaiting or start an agent.
Example: kanban card move card_a1b2c3d4 --to review
` + common + writes,
  'card update': `Usage: kanban card update CARD [fields | --archive | --restore]
` + fields + `Also: --clear-blocked --clear-deliverables (exclusive with their value flags).
--deliverable replaces the entire list; empty --notes/--next-action clears that field.
--archive and --restore are exclusive with each other and all field patches.
At least one field is required. Use card move to change the stage.
Example: kanban card update card_a1b2c3d4 --awaiting user --next-action "Review results"
` + common + writes,
  'card link': `Usage: kanban card link CARD --agent UUID [--role TEXT] [--label TEXT]
Unlink: kanban card link CARD --agent UUID --remove
--remove cannot be combined with --role or --label.
A new link defaults to role worker and empty label. Omitted existing fields are preserved.
One agent can serve multiple cards; labels are caller-supplied title snapshots.
Example: kanban card link card_a1b2c3d4 --agent "$AGENT" --role reviewer --label "Review agent"
` + common + writes,
  'card show': `Usage: kanban card show CARD
Complete card, board revision and retained movement history, including archived cards.
CARD may be a unique prefix (at least eight hex characters after card_).
Example: kanban card show card_a1b2c3d4 --json
` + common,
  'card busy': `Usage: kanban card busy CARD "TEXT" [--by AGENT_ID|NAME]
Off: kanban card busy CARD --off
Marks work that is not an agent's turn (a test run, a build) on the card: a dashed ring,
the text and how long it has run. TEXT is required (1-200 characters). Marking again
replaces the text and restarts the time. --by defaults to PASEO_AGENT_ID, else "cli".
Stored in the data folder's busy.json, not the ledger (no revision, no PROCESS.md change).
Never switched off by time: after 2 hours the card asks a person to check it.
Archived cards cannot be marked; archiving a card drops its mark.
Example: kanban card busy card_a1b2c3d4 "Testing"; npm test; kanban card busy card_a1b2c3d4 --off
` + common,
  apply: `Usage: kanban apply FILE|-
UTF-8 JSON: {"requestId":"UUID","operations":[{"op":"add","title":"Review","intent":"requested","acceptanceCriteria":"Findings recorded"}]}
requestId is recommended; ifRevision is optional. Both can instead be CLI options.
A key cannot appear both in the file and as an option. No automatic retransmission.
Operations: add, move(id,to), update(id,patch), link(id,agentId,role?,label?),
  unlink(id,agentId), archive(id), restore(id). Use model field names in JSON.
One board, 1-100 operations, at most 1 MiB; all succeed or no changes are stored.
Later operations cannot reference IDs created within the same batch.
Example: kanban apply tasks.json --request-id "$ID"
` + common + writes,
  export: `Usage: kanban export
Compare and refresh the generated PROCESS.md; never import edits back into the board.
Same content is not written. Manual files, wrong owners and symlinks are preserved.
Missing/protected directories or ambiguous owners are skipped with warnings.
config.json controls exportEnabled, locale (en or ko), and export.detail (compact or full).
Example: kanban export
` + common,
  doctor: `Usage: kanban doctor
Read-only checks for the current board, backups, locks, config and generated output.
Use --workspace BOARD_ID to diagnose a damaged board without resolving its directory.
Reports errors with repair guidance; never deletes or repairs files.
Example: kanban doctor --workspace board_HASH --json
` + common,
  unlock: `Usage: kanban unlock [--force] [--global]
Normal recovery: lock older than 60 seconds AND owner dead or process-start mismatch.
--global targets the shared metadata lock; cannot be combined with --workspace.
--force is an explicit assertion that ALL relevant writers and new entries are stopped.
A verifiably live owner is never forcibly removed. Do not automate --force retries.
Inspect doctor output before recovery. No lock is unchanged.
Example: kanban unlock
` + common,
};
