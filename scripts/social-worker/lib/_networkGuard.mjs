// Installs a fail-closed globalThis.fetch that every test file exercising
// bufferPostingBridge.js (or anything else capable of making a real HTTP
// call to the cloudflare-worker) loads BEFORE its test cases run. Mirrors
// cloudflare-worker/test/_networkGuard.mjs exactly — this exists because a
// prior-stage test in that sibling repo called a Buffer-calling handler
// OUTSIDE its own mock wrapper and very likely reached a live network
// endpoint. Structural safeguard, not developer discipline: any code path
// that runs without an explicit injected fetchImpl mock throws immediately,
// before a real request can leave the process.
export function installNetworkGuard() {
  globalThis.fetch = () => {
    throw new Error("unexpected_real_network_call: a test attempted to use the real global fetch outside an explicit injected fetchImpl mock.");
  };
}
