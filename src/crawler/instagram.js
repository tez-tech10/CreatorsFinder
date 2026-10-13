// Instagram follower counts via Apify (Instagram profile scraper).
// One request checks up to ~20 usernames. Token lives in Railway → Variables (APIFY_TOKEN).
import { config } from "../config.js";

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/i;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// Apify output varies a little between scraper versions, so read every common field name.
export function normalizeProfile(p) {
  if (!p || typeof p !== "object") return null;
  const username = String(p.username || p.userName || p.inputUrl?.split("/").filter(Boolean).pop() || "").toLowerCase();
  if (!username || p.error) return username ? { username, found: false } : null;
  const followers = num(p.followersCount ?? p.followers_count ?? p.followers ?? p.edge_followed_by?.count);
  const bio = String(p.biography || p.bio || "");
  const email = String(p.businessEmail || p.public_email || p.publicEmail || p.email || bio.match(EMAIL_RE)?.[0] || "").toLowerCase() || null;
  return { username, found: followers != null, followers, email, private: !!(p.private ?? p.isPrivate) };
}

export class InstagramUnavailable extends Error {}

// usernames → Map(username → { found, followers, email, private })
export async function fetchProfiles(usernames) {
  if (!config.apifyToken) throw new InstagramUnavailable("APIFY_TOKEN is not set in Railway.");
  const url = `${config.apifyBase}/v2/acts/${encodeURIComponent(config.apifyIgActor)}/run-sync-get-dataset-items?timeout=240`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apifyToken}` },
    body: JSON.stringify({ usernames }),
    signal: AbortSignal.timeout(300_000),
  });
  if (res.status === 401 || res.status === 403) throw new InstagramUnavailable(`Apify rejected the token (HTTP ${res.status}).`);
  if (res.status === 402) throw new InstagramUnavailable("Apify account is out of credit.");
  if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const items = await res.json();
  const out = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const p = normalizeProfile(it);
    if (p && !out.has(p.username)) out.set(p.username, p);
  }
  return out;
}
