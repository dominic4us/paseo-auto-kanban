import { lstat, rm } from 'node:fs/promises';
// Runs before `npm pack`/`npm publish` so the package only carries output built from the current sources. It removes
// dist only when dist is a real folder. npm leaves a symbolically linked dist out of the tarball without a warning, which
// would ship a CLI with no code behind it, and anything else under that name is not build output to throw away, so
// packing from such a checkout stops here; pack from a fresh clone instead.
const dist = new URL('../dist', import.meta.url);
const entry = await lstat(dist).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
if (entry && !entry.isDirectory()) {
  console.error(entry.isSymbolicLink()
    ? 'dist is a symbolic link; npm would pack it empty. Pack from a fresh clone where dist is a real folder.'
    : 'dist is not a folder; nothing was removed. Move it away, or pack from a fresh clone.');
  process.exit(1);
}
if (entry) await rm(dist, { recursive: true, force: true });
