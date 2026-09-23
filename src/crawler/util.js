// Waits can be cut short when the worker is asked to stop (e.g. Railway redeploy).
const wakers = new Set();
let stopRequested = false;
export function requestStop() { stopRequested = true; for (const w of wakers) w(); wakers.clear(); }
export function isStopping() { return stopRequested; }
export const sleep = (ms) => new Promise((resolve) => {
  if (stopRequested) return resolve();
  const done = () => { clearTimeout(t); wakers.delete(done); resolve(); };
  const t = setTimeout(done, ms);
  wakers.add(done);
});

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Runs async tasks with a maximum number at the same time.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { error: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Limits requests per website so link pages aren't hammered (and we don't get blocked).
export class HostLimiter {
  constructor(perHost = 2, gapMs = 400) {
    this.perHost = perHost; this.gapMs = gapMs; this.hosts = new Map();
  }
  async run(url, fn) {
    let host = "unknown";
    try { host = new URL(url).hostname; } catch {}
    const h = this.hosts.get(host) || { active: 0, last: 0, queue: [] };
    this.hosts.set(host, h);
    while (h.active >= this.perHost) await new Promise((r) => h.queue.push(r));
    h.active++;
    const wait = h.last + this.gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    h.last = Date.now();
    try { return await fn(); }
    finally { h.active--; const n = h.queue.shift(); if (n) n(); }
  }
}

export function followerTier(n) {
  if (n == null) return null;
  if (n >= 100_000) return "Large";
  if (n >= 40_000) return "Mid";
  return "Rising";
}
