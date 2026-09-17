// Just enough of node:path to run the CLI's pure logic under JavaScriptCore.
function normalize(parts) {
  const out = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') { if (out.length) out.pop(); continue; }
    out.push(p);
  }
  return out;
}
export function resolve(...args) {
  let segs = [];
  for (const a of args) {
    if (String(a).startsWith('/')) segs = String(a).split('/');
    else segs = segs.concat(String(a).split('/'));
  }
  return '/' + normalize(segs).join('/');
}
export function dirname(p) { const s = String(p).split('/'); s.pop(); return s.join('/') || '/'; }
export function extname(p) { const b = String(p).split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }
export const sep = '/';
export const posix = { join: (...a) => '/' + normalize(a.join('/').split('/')).join('/') };
export default { resolve, dirname, extname, sep, posix };
