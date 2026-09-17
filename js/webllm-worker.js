/**
 * webllm-worker.js — hosts the in-browser model off the main thread.
 *
 * Kept as its own file because a Worker needs a script URL. Generation on a 3B model
 * takes seconds; running it here is what keeps the board from freezing meanwhile.
 */
import * as webllm from 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.85/lib/index.js';

const handler = new webllm.WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
