/**
 * scaffold.mjs — print the starter files for a new data repo, for setup.sh to commit.
 *
 * This exists so the CLI path and the in-app wizard cannot drift: both call
 * bootstrap.scaffoldFiles(), and the rendering lives in one place. Run it under any
 * ES-module runtime; setup.sh does the writing, because jsc cannot.
 *
 * Output is one line per file, `path<TAB>base64`, which sidesteps every shell quoting
 * question about file contents that contain quotes, newlines or `$`.
 *
 * Usage: jsc -m scripts/scaffold.mjs -- <slug> <appUrl> <with-examples: 1|0>
 */

// jsc has no console and no crypto; node has both. Fill in only what is missing.
const emit = typeof print === 'function' ? print : console.log;
if (typeof console === 'undefined') globalThis.console = { log: emit, warn: emit, error: emit };
if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
  // Only ever used for the example tasks' ids, where uniqueness is all that matters.
  globalThis.crypto = {
    getRandomValues(a) {
      for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
      return a;
    },
  };
}

function utf8(text) {
  const bytes = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return bytes;
}

// github.js constructs both at import time, and jsc has neither global. Nothing here
// decodes anything, so the decoder only has to exist.
if (typeof TextEncoder === 'undefined') {
  globalThis.TextEncoder = class { encode(s) { return new Uint8Array(utf8(s)); } };
}
if (typeof TextDecoder === 'undefined') {
  globalThis.TextDecoder = class { decode(b) { return String.fromCharCode(...(b || [])); } };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** UTF-8 → base64, by hand: there is no btoa here and no Buffer either. */
function toBase64(text) {
  const bytes = utf8(text);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    const chunk = bytes.length - i;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (chunk > 1 ? B64[(n >> 6) & 63] : '=') + (chunk > 2 ? B64[n & 63] : '=');
  }
  return out;
}

// jsc puts the args after `--` on globalThis.arguments; node puts them on process.argv.
const argv = [...(globalThis.arguments || globalThis.process?.argv?.slice(2) || [])];
const [slug, appUrl, withExamples] = argv;
if (!slug) { emit('scaffold.mjs: no repo slug given'); throw new Error('usage: scaffold.mjs <slug> <appUrl> <1|0>'); }

const { scaffoldFiles } = await import('../js/bootstrap.js');
const { files } = scaffoldFiles({ slug, appUrl, withExamples: withExamples !== '0' });
for (const f of files) emit(`${f.path}\t${toBase64(f.text)}`);
