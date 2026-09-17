// A tiny virtual tree rooted at /pkg, mirroring what the published package holds.
const DIRS = new Set(['/pkg', '/pkg/js', '/pkg/css', '/pkg/bin', '/pkg/docs']);
const FILES = new Map([
  ['/pkg/index.html', '<!doctype html>'],
  ['/pkg/package.json', '{"version":"0.1.0"}'],
  ['/pkg/js/app.js', 'export {}'],
  ['/pkg/docs/board.png', 'png'],
  ['/pkg/bin/worklog.mjs', '#!/usr/bin/env node'],
  // Outside the package root on purpose: the guard, not ENOENT, has to reject these.
  ['/secret', 'ssh-key'],
  ['/pkgsecret/x', 'sibling whose name starts with the root path'],
]);
export const promises = {
  async stat(p) {
    if (DIRS.has(p)) return { isDirectory: () => true, isFile: () => false };
    if (FILES.has(p)) return { isDirectory: () => false, isFile: () => true };
    const err = new Error(`ENOENT: ${p}`); err.code = 'ENOENT'; throw err;
  },
  async readFile(p) { if (!FILES.has(p)) throw new Error(`ENOENT: ${p}`); return FILES.get(p); },
};
export function createReadStream() { return { on: () => ({ pipe: () => {} }), pipe: () => {} }; }
export default { promises, createReadStream };
