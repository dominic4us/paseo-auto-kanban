import { randomUUID } from 'node:crypto';
import { openStore } from '../../dist/server/core/index.js';
const options = JSON.parse(process.argv[2]);
const store = await openStore({ dataDir: options.dataDir, lockTimeoutMs: options.timeout ?? 30000 });
process.send({ ready: true });
process.once('message', async () => {
  try {
    if (options.hold) {
      await store.withBoardLock(options.id, async () => {
        process.send({ held: true });
        await new Promise(resolve => process.once('message', resolve));
      });
      process.send({ ok: true, diagnostics: store.diagnostics() });
    } else {
      const input = { actor: { kind: 'user' }, requestId: options.requestId ?? randomUUID(), operations: options.operations, ...(options.ifRevision === undefined ? {} : { ifRevision: options.ifRevision }) };
      const result = options.init ? await store.initBoard({ ...options.init, actor: input.actor, requestId: input.requestId }) : await store.mutateBoard(options.id, input);
      process.send({ ok: true, result, diagnostics: store.diagnostics() });
    }
  } catch (error) { process.send({ ok: false, code: error.code, message: error.message, diagnostics: store.diagnostics() }); }
  process.disconnect();
});
