#!/usr/bin/env node
/**
 * worklog — serve this app from wherever npm put it.
 *
 * The app is a zero-build static site: the only thing standing between the files
 * and a browser is that ES modules will not load over file://. So that is all this
 * does — hand the package's own directory to localhost. There is no build, no
 * watcher, no bundler, and nothing here touches your data: the page talks to the
 * GitHub API directly from the browser, exactly as it does on Pages.
 *
 * Zero dependencies on purpose. A tool whose whole pitch is "no toolchain" should
 * not arrive with a dependency tree.
 */
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
  const opts = { port: 8765, open: true, demo: false, host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (argv[i].includes('=') ? argv[i].split('=').slice(1).join('=') : argv[++i]);
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-v' || a === '--version') opts.version = true;
    else if (a === '--no-open') opts.open = false;
    else if (a === '--demo') opts.demo = true;
    else if (a.startsWith('--port')) opts.port = Number(val());
    else if (a === '-p') opts.port = Number(argv[++i]);
    else if (a.startsWith('--host')) opts.host = val();
    else return { error: `unknown option: ${a}` };
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    return { error: `--port wants a number between 0 and 65535, got ${opts.port}` };
  }
  return opts;
}

const HELP = `worklog — run the Work Log board on localhost

  npx work-log              serve the app and open it
  npx work-log --demo       open the sample board instead (no token, nothing saved)
  npx work-log --no-open    just serve; print the URL
  npx work-log --port 3000  pick the port (default 8765, next free one if taken)
  npx work-log --host 0.0.0.0   listen beyond loopback, e.g. to reach it from a phone

Your log lives in a git repo you own, not here. Nothing is stored in this package,
and your tokens stay in the browser. Point the app at a repo from Settings, or run
scripts/setup.sh from the repo if you would rather create one from the terminal.

Hosted copy, if you would rather not run anything:
  https://tanmayagrawal21.github.io/worklog/
`;

/**
 * Resolve a URL path to a file inside ROOT, or null. `path.resolve` collapses
 * ../ before the prefix check, so an encoded traversal cannot escape the package.
 */
async function resolveFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  const abs = path.resolve(ROOT, '.' + (rel.startsWith('/') ? rel : '/' + rel));
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  try {
    const st = await fs.stat(abs);
    if (st.isDirectory()) return resolveFile(path.posix.join(rel, 'index.html'));
    return st.isFile() ? abs : null;
  } catch {
    return null;
  }
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Only GET here.\n');
  const file = await resolveFile(req.url || '/');
  if (!file) return send(res, 404, `Not found: ${req.url}\n`);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    // Served straight off disk during development; a cached module is a confusing edit.
    'cache-control': 'no-store',
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).on('error', () => res.end()).pipe(res);
});

/** Open in the default browser, and shrug if that is not a thing here (SSH, container, CI). */
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', url];
  try {
    const child = spawn(cmd[0], Array.isArray(cmd[1]) ? cmd[1] : [cmd[1]], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* printing the URL is enough */ }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error) { process.stderr.write(`${opts.error}\n\n${HELP}`); process.exit(2); }
  if (opts.help) return process.stdout.write(HELP);
  if (opts.version) {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    return process.stdout.write(`${pkg.version}\n`);
  }

  if (!await resolveFile('/index.html')) {
    process.stderr.write(`No index.html next to ${ROOT} — this copy of the package looks incomplete.\n`);
    process.exit(1);
  }

  // Walk up from the requested port rather than failing: the common cause of EADDRINUSE
  // here is a second copy of this same command, and refusing to start is not helpful.
  let port = opts.port;
  const limit = opts.port === 0 ? 1 : 20;
  for (let tries = 0; ; tries++) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, opts.host, resolve);
      });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || tries + 1 >= limit) {
        process.stderr.write(`Could not listen on ${opts.host}:${port} — ${err.message}\n`);
        process.exit(1);
      }
      process.stdout.write(`Port ${port} is busy, trying ${port + 1}…\n`);
      port++;
    }
  }

  const shown = opts.host === '0.0.0.0' || opts.host === '::' ? 'localhost' : opts.host;
  const url = `http://${shown}:${server.address().port}/${opts.demo ? '?demo=1' : ''}`;
  process.stdout.write(`Work Log on ${url}\nCtrl-C to stop.\n`);
  if (opts.open) openBrowser(url);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
}

main();
