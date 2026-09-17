export function createServer(handler) {
  return {
    handler,
    listened: null,
    once() {},
    listen(port, host, cb) { this.listened = { port, host }; cb && cb(); },
    address() { return { port: this.listened?.port ?? 0 }; },
    close() {},
  };
}
export default { createServer };
