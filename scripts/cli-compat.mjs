import { mkdir, writeFile, chmod } from 'node:fs/promises';
// Preserve previously installed executable links across the source layout change.
await mkdir(new URL('../dist/cli/', import.meta.url), { recursive: true });
await writeFile(new URL('../dist/cli/main.js', import.meta.url),
  '#!/usr/bin/env node\nimport "../src/cli/main.js";\n');
await chmod(new URL('../dist/cli/main.js', import.meta.url), 0o755);
await chmod(new URL('../dist/src/cli/main.js', import.meta.url), 0o755);
