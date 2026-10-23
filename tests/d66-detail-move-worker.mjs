// D66 gate 495 F1: another process (another screen, a CLI) completing the card — a real Store of its own, a person's move.
import { randomUUID } from 'node:crypto';
import { openStore } from '../dist/server/core/index.js';
const [dataDir, id, cardId, to = 'done'] = process.argv.slice(2);
const store = await openStore({ dataDir });
const r = await store.mutateBoard(id, { actor: { kind: 'user' }, requestId: randomUUID(), operations: [{ op: 'move', id: cardId, to }] });
console.log(JSON.stringify({ committed: r.committed, revision: r.data.revision, pid: process.pid }));
