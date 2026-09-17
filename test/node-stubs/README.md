# node-stubs

`bin/worklog.mjs` is the only file in this project that needs a Node runtime, and this
machine does not have one. Rather than leave the CLI untested, `scripts/test.sh` copies
it into a temp directory with its `node:*` imports rewritten to point at these stubs, and
runs `test/cli.check.js` against that copy under JavaScriptCore.

What that buys: real coverage of the argument parser and of the path guard that keeps the
static server inside the package directory — the two parts with logic worth getting wrong.
What it does not buy: any evidence that Node itself runs the file. Sockets, streams and
`spawn` are faked here. Run `npm test` on a machine with Node for the real thing.

The stub filesystem deliberately contains `/secret` and `/pkgsecret/x`, both outside the
fake package root, so a traversal that reached them would return a file rather than null.
