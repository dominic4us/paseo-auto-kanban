#!/usr/bin/env node
// REQ-146 (research/378): install the Hermes VM `hermes-runtime.mjs` runs, outside the repository (nothing is committed).
// Hermes' own Linux release v0.13.0 runs the bytecode (96) of the app's compiler (react-native 0.81.5's hermesc).
// The archive and the binary are pinned by sha256; anything else is refused.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { VM_RELEASE, vmCachePath } from './hermes-runtime.mjs';

export const VM_ARCHIVE = {
  url: `https://github.com/facebook/hermes/releases/download/${VM_RELEASE}/hermes-cli-linux.tar.gz`,
  sha256: 'aead6eb0b8f563bb022354352eae32dad96c933330b6c1941b6db17674ca68ae',
  binarySha256: 'ae13b09993b46ae44d85880cc2adebf76290adb52ee0f7fad9f0dde270a2eb08',
  bytecode: 96,
};
const sha256 = data => createHash('sha256').update(data).digest('hex');

export async function fetchVm(options = {}) {
  if (process.platform !== 'linux' || process.arch !== 'x64')
    throw new Error(`Hermes publishes this VM for Linux x64 only (this is ${process.platform}-${process.arch}); `
      + 'on macOS the test uses react-native\'s own osx-bin/hermes, elsewhere set HERMES_VM.');
  const destination = resolve(options.dest ?? vmCachePath());
  if (existsSync(destination) && sha256(readFileSync(destination)) === VM_ARCHIVE.binarySha256 && !options.force)
    return { path: destination, cached: true };
  const archive = options.from ? readFileSync(resolve(options.from))
    : Buffer.from(await (async () => {
      const response = await fetch(VM_ARCHIVE.url);
      if (!response.ok) throw new Error(`Download failed: ${response.status} ${VM_ARCHIVE.url}`);
      return response.arrayBuffer();
    })());
  if (sha256(archive) !== VM_ARCHIVE.sha256) throw new Error('Archive sha256 mismatch: ' + sha256(archive));
  const staging = mkdtempSync(join(tmpdir(), 'kanban-hermes-vm-'));
  try {
    writeFileSync(join(staging, 'cli.tar.gz'), archive);
    const unpack = spawnSync('tar', ['-xzf', join(staging, 'cli.tar.gz'), '-C', staging, './hermes'], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error('tar failed: ' + (unpack.error?.message ?? unpack.stderr));
    const binary = join(staging, 'hermes');
    if (sha256(readFileSync(binary)) !== VM_ARCHIVE.binarySha256) throw new Error('Binary sha256 mismatch in the archive.');
    chmodSync(binary, 0o755);
    const version = spawnSync(binary, ['-version'], { encoding: 'utf8', timeout: 15000 });
    if (!new RegExp(`HBC bytecode version: ${VM_ARCHIVE.bytecode}\\b`).test(version.stdout ?? ''))
      throw new Error('Unexpected VM version: ' + (version.stdout || version.stderr || version.error?.message));
    mkdirSync(dirname(destination), { recursive: true });
    try { renameSync(binary, destination); } catch { copyFileSync(binary, destination); chmodSync(destination, 0o755); }
    return { path: destination, cached: false };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

async function main() {
  const usage = 'Usage: node scripts/fetch-hermes-vm.mjs [--from hermes-cli-linux.tar.gz] [--dest file] [--force]';
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { console.log(usage); return; }
    if (args[i] === '--force') { options.force = true; continue; }
    if ((args[i] === '--from' || args[i] === '--dest') && args[i + 1]) { options[args[i].slice(2)] = args[++i]; continue; }
    throw new Error(usage);
  }
  const result = await fetchVm(options);
  console.log((result.cached ? 'Already installed: ' : 'Installed: ') + result.path);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('Hermes VM fetch error: ' + String(error.message ?? error)); process.exitCode = 1; });
}
