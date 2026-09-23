// twitterapi.io (read-only, public data). Response shapes vary per endpoint, so every read is defensive.
import { config } from "../config.js";

async function call(path, params) {
  const url = new URL(config.twitterBase + path);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, v);

  for (let attempt = 1; attempt <= 4; attempt++) {
    let res;
    try {
      res = await fetch(url, { headers: { "x-api-key": config.twitterKey }, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt === 4) throw new Error(`twitterapi.io network error: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error("twitterapi.io rejected the API key (TWITTERAPI_KEY).");
    if (res.status === 402) throw Object.assign(new Error("twitterapi.io account is out of credit."), { fatal: true });
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 4) throw new Error(`twitterapi.io error ${res.status}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!body) throw new Error(`twitterapi.io returned an unreadable response (${res.status})`);
    return body;
  }
}

// One page of accounts that userName follows.
export async function getFollowingsPage(userName, cursor) {
  const r = await call("/twitter/user/followings", { userName, cursor, pageSize: 200 });
  const users = r.followings || r.users || r.data?.followings || r.data?.users || [];
  return {
    users: Array.isArray(users) ? users : [],
    nextCursor: r.has_next_page || r.data?.has_next_page ? (r.next_cursor || r.data?.next_cursor || null) : null,
  };
}

// Most recent posts (used for activity + language when the bio is unclear).
export async function getLastTweets(userId) {
  const r = await call("/twitter/user/last_tweets", { userId });
  const tweets = r.tweets || r.data?.tweets || [];
  return Array.isArray(tweets) ? tweets : [];
}

// Normalizes a twitterapi.io user object into the fields the pipeline uses.
export function normalizeUser(u) {
  if (!u || u.id == null) return null;
  const links = new Set();
  const addUrls = (arr) => (arr || []).forEach((x) => x && (x.expanded_url || x.url) && links.add(x.expanded_url || x.url));
  addUrls(u.profile_bio?.entities?.url?.urls);
  addUrls(u.profile_bio?.entities?.description?.urls);
  addUrls(u.entities?.url?.urls);
  addUrls(u.entities?.description?.urls);
  if (typeof u.url === "string" && !/^https?:\/\/(x|twitter)\.com\//i.test(u.url)) links.add(u.url);

  const bio = u.description ?? u.profile_bio?.description ?? "";
  (bio.match(/https?:\/\/[^\s]+/g) || []).forEach((l) => links.add(l));

  return {
    id: String(u.id),
    handle: u.userName || u.screen_name || "",
    name: u.name || null,
    bio,
    location: u.location || null,
    followers: Number(u.followers ?? u.followers_count ?? 0),
    following: Number(u.following ?? u.friends_count ?? 0),
    canDm: typeof u.canDm === "boolean" ? u.canDm : null,
    isProtected: u.protected === true,
    unavailable: u.unavailable === true,
    isAutomated: u.isAutomated === true,
    profileImage: u.profilePicture || null,
    createdAt: u.createdAt ? new Date(u.createdAt) : null,
    links: [...links],
  };
}

export function tweetDate(t) {
  const d = new Date(t?.createdAt || t?.created_at || 0);
  return isNaN(d) ? null : d;
}

// Single profile lookup by handle (used when adding a seed).
export async function getUserInfo(userName) {
  const r = await call("/twitter/user/info", { userName });
  if (r.status && r.status !== "success") return null;
  return r.data && r.data.id ? r.data : null;
}
