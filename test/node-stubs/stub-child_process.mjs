export const opened = [];
export function spawn(cmd, args) { opened.push([cmd, args]); return { on() {}, unref() {} }; }
export default { spawn };
