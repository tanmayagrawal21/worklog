/**
 * cli.check.js — the argument parser and path guard of bin/worklog.mjs.
 *
 * Not named *.test.js because it cannot run on its own: it needs the rewritten copy
 * of the CLI that scripts/test.sh builds, whose path arrives as an argument. See
 * test/node-stubs/README.md for what this does and does not prove.
 */
const out = [];
let fails = 0;
const ok = (cond, name) => { if (!cond) { fails++; out.push(`FAIL ${name}`); } else out.push(`ok   ${name}`); };

const target = (globalThis.arguments || globalThis.process?.argv?.slice(2) || [])[0];
if (!target) throw new Error('usage: jsc -m test/cli.check.js -- <path to rewritten cli.mjs>');

// The CLI reads these off the global object, as it would under Node.
globalThis.process = {
  argv: ['node', '/pkg/bin/worklog.mjs', '--help'],
  platform: 'darwin',
  stdout: { write: (s) => out.push(`stdout: ${JSON.stringify(s.slice(0, 46))}`) },
  stderr: { write: (s) => out.push(`stderr: ${JSON.stringify(s.slice(0, 46))}`) },
  exit: (c) => out.push(`exit(${c})`),
  on: () => {},
};
globalThis.Buffer = { byteLength: (s) => String(s).length };

await import(target);
await new Promise((r) => setTimeout(r, 0));   // let main()'s microtasks drain
const { parseArgs, resolveFile } = globalThis.__probe;

ok(out.some((l) => l.startsWith('stdout: "worklog')), '--help prints help and never listens');

const d = parseArgs([]);
ok(d.port === 8765 && d.open === true && d.host === '127.0.0.1' && !d.demo, 'defaults: 8765, open, loopback');
ok(parseArgs(['--port', '3000']).port === 3000, '--port 3000');
ok(parseArgs(['--port=3000']).port === 3000, '--port=3000');
ok(parseArgs(['-p', '3000']).port === 3000, '-p 3000');
ok(parseArgs(['--host=0.0.0.0']).host === '0.0.0.0', '--host=0.0.0.0');
ok(parseArgs(['--no-open']).open === false, '--no-open');
ok(parseArgs(['--demo']).demo === true, '--demo');
ok(parseArgs(['-h']).help && parseArgs(['--version']).version, '-h and --version');
// A bad port used to sail through as NaN and fail much later inside listen().
ok(parseArgs(['--port', 'banana']).error?.includes('--port'), 'non-numeric port is rejected up front');
ok(parseArgs(['--port', '99999']).error?.includes('--port'), 'out-of-range port is rejected up front');
ok(parseArgs(['--frobnicate']).error?.includes('unknown option'), 'unknown option is rejected');

ok(await resolveFile('/index.html') === '/pkg/index.html', 'serves a file');
ok(await resolveFile('/') === '/pkg/index.html', '/ serves index.html');
ok(await resolveFile('/js/app.js') === '/pkg/js/app.js', 'serves a nested file');
ok(await resolveFile('/index.html?x=1#y') === '/pkg/index.html', 'query and fragment are stripped');
ok(await resolveFile('/js/') === null, 'a directory with no index is a 404, not a listing');
ok(await resolveFile('/nope.js') === null, 'a missing file is null');
ok(await resolveFile('/%ZZ') === null, 'malformed percent-encoding is null, not a throw');

// These two exist in the stub tree, so only the prefix check can be rejecting them.
ok(await resolveFile('/../secret') === null, 'a real file above the root stays unreachable');
ok(await resolveFile('/../pkgsecret/x') === null, 'a sibling dir sharing the root prefix stays unreachable');
for (const attack of ['/js/../../secret', '/%2e%2e/secret', '/%2e%2e%2fsecret', '/./../../etc/passwd']) {
  ok(await resolveFile(attack) === null, `traversal blocked: ${attack}`);
}

print(`cli:      ${out.length} assertions, ${fails} failing`);
if (fails) { print(out.filter((l) => l.startsWith('FAIL')).join('\n')); throw new Error('cli checks failed'); }
