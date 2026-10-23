# Previous public releases, for real

D66 G2b (research/498). Two releases are pinned: **0.2.3** (`304e049`) and **0.2.4** (`4a4325c`, the stable build).

- `manifest.json` lists, per release, the unmodified TypeScript sources the tests run and their SHA-256: the ledger
  store and validator, the engine's memory (`auto-state`), the automatic cards' engine, and what they import.
  `tests/previous-release.mjs` checks the hashes, transpiles the sources into a disposable folder and imports them
  there — no Git history, prebuilt archive or network at test time.
- `<release>/data/` is a data folder that release itself wrote (`make-data.mjs`, run with that release's build): one
  board (without the ledger's `_archive/` backups, which the commit guard keeps out) whose fifteen cards cover what an upgrade has to tell apart — the engine's own moves, a person's completion
  and moves (seen by the engine or not), a resume made in that release, an orchestrator's link the engine never used,
  an agent's own CLI move, a person's untracked cards, an archive, an unlinked agent. `<release>/expected.json` names
  each card's case and the decision the migration must make of it. The board's workspace folder is
  `/tmp/kanban-previous-fixture/<release>/project`; the tests create it.

The tests (`d66-previous-release.test.mjs`, the 0.2.4 writer of `d66-control-model.test.mjs`) read these bytes with
this version, and this version's bytes with these releases. When a new release is made public, add it beside these
(copy the same paths from its commit, extend the manifest, run `make-data.mjs` with its build) rather than replacing
one: an upgrade from each release that is still installed somewhere is the contract.
