// Processes one crawl job: pull followings page by page, run every check, save qualified creators.
import { config } from "../config.js";
import { log, mapLimit, followerTier } from "./util.js";
import { getFollowingsPage, getLastTweets, normalizeUser, tweetDate } from "./twitter.js";
import { detectLanguage } from "./language.js";
import { ageRedFlag } from "./safety.js";
import { checkLinks } from "./links.js";
import { classifyBatch, decide } from "./llm.js";
import * as store from "./store.js";

export class BudgetReached extends Error {}

async function assertBudget(settings) {
  const spent = await store.spentToday();
  if (spent >= Number(settings.daily_budget_usd)) throw new BudgetReached(`Daily budget reached ($${spent.toFixed(2)} of $${settings.daily_budget_usd})`);
}

function linkSummary(found) {
  const parts = [];
  if (found.onlyfans.size) parts.push("onlyfans");
  if (found.fansly.size) parts.push("fansly");
  if (found.fanvue.size) parts.push("fanvue");
  if (found.instagram.size) parts.push("instagram");
  if (found.telegram.size) parts.push("telegram");
  if (found.emails.size) parts.push("email");
  return parts.join(", ");
}

// Runs the checks on one page of accounts. Returns number qualified.
async function processAccounts(rawUsers, job, settings, stats) {
  const depth = job.depth + 1;
  const seedId = job.source_seed_id;
  const turbo = settings.crawl_mode === "turbo";

  // 1) Normalize + drop duplicates within the page
  const byId = new Map();
  for (const u of rawUsers) { const n = normalizeUser(u); if (n && !byId.has(n.id)) byId.set(n.id, n); }
  const known = await store.knownIds([...byId.keys()]);
  const fresh = [...byId.values()].filter((u) => !known.has(u.id));
  stats.skippedKnown += byId.size - fresh.length;
  if (!fresh.length) return 0;

  // Register as 'pending' first (so a crash mid-way is retried, not lost)
  await store.markSeen(fresh.map((u) => ({ x_user_id: u.id, handle: u.handle, outcome: "pending", depth, source_seed_id: seedId })));

  const decided = []; // { x_user_id, handle, outcome, reason, depth, source_seed_id }
  const reject = (u, reason) => { decided.push({ x_user_id: u.id, handle: u.handle, outcome: "rejected", reason, depth, source_seed_id: seedId }); stats.rejected[reason] = (stats.rejected[reason] || 0) + 1; };

  try {
  // 2) Free checks
  let survivors = [];
  for (const u of fresh) {
    const flag = ageRedFlag(u.name, u.bio);
    if (flag) { await store.exclude(u.id, u.handle, "age_safety_keywords", depth, seedId); stats.excluded++; continue; }
    if (u.unavailable) { reject(u, "unavailable"); continue; }
    if (u.isProtected) { reject(u, "private"); continue; }
    if (u.followers < settings.follower_min || u.followers > settings.follower_max) { reject(u, "out_of_range"); continue; }
    if (u.isAutomated) { reject(u, "automated"); continue; }
    u.bioLang = detectLanguage(u.bio);
    if (u.bioLang === "other") { reject(u, "not_english"); continue; }
    survivors.push(u);
  }

  // 3) Link check (free, own server)
  const linkResults = await mapLimit(survivors, turbo ? 12 : 4, (u) => checkLinks(u.bio, u.links));
  const withOf = [];
  survivors.forEach((u, i) => {
    const found = linkResults[i];
    if (!found || found.error || !found.onlyfans.size) { reject(u, "no_onlyfans"); return; }
    u.found = found;
    withOf.push(u);
  });

  // 4) Recent posts: activity + language (only for accounts that have an OnlyFans link)
  const activeCutoff = Date.now() - settings.active_days * 86_400_000;
  const tweetResults = await mapLimit(withOf, turbo ? 8 : 3, async (u) => {
    await assertBudget(settings);
    const tweets = await getLastTweets(u.id);
    await store.recordSpend("twitterapi", "last_tweets", tweets.length || 1, (tweets.length || 1) * config.costPerTweet);
    return tweets;
  });
  const forAi = [];
  for (let i = 0; i < withOf.length; i++) {
    const u = withOf[i]; const tweets = tweetResults[i];
    if (tweets?.error instanceof BudgetReached) throw tweets.error;
    if (!tweets || tweets.error) { reject(u, "posts_unavailable"); continue; }
    const dates = tweets.map(tweetDate).filter(Boolean).sort((a, b) => b - a);
    u.lastPostAt = dates[0] || null;
    if (!u.lastPostAt || u.lastPostAt.getTime() < activeCutoff) { reject(u, "inactive"); continue; }
    const texts = tweets.map((t) => t.text || t.full_text || "").filter(Boolean);
    const flag = ageRedFlag(texts.join(" \n "));
    if (flag) { await store.exclude(u.id, u.handle, "age_safety_keywords", depth, seedId); stats.excluded++; continue; }
    if (u.bioLang === "unclear" && detectLanguage(texts.join(" ")) === "other") { reject(u, "not_english"); continue; }
    u.recentPosts = texts.slice(0, 5);
    u.linkSummary = linkSummary(u.found);
    forAi.push(u);
  }

  // 5) AI check in batches
  var qualified = 0;
  const size = Math.max(1, Math.min(25, settings.llm_batch_size || 10));
  for (let i = 0; i < forAi.length; i += size) {
    await assertBudget(settings);
    let batch = forAi.slice(i, i + size);
    let outcome = await classifyBatch(batch);
    await store.recordSpend("openrouter", "llm_batch", batch.length, outcome.cost, { model: outcome.model, tokens: outcome.tokens });

    // Anyone the AI skipped gets one more try on their own batch
    const missing = batch.filter((u) => !outcome.results.has(u.id));
    if (missing.length) {
      const retry = await classifyBatch(missing);
      await store.recordSpend("openrouter", "llm_batch", missing.length, retry.cost, { model: retry.model, retry: true });
      retry.results.forEach((v, k) => outcome.results.set(k, v));
    }

    for (const u of batch) {
      const ai = outcome.results.get(u.id);
      const d = ai ? decide(ai) : { outcome: "rejected", reason: "ai_failed" };
      if (d.outcome === "excluded") { await store.exclude(u.id, u.handle, d.reason, depth, seedId); stats.excluded++; continue; }
      if (d.outcome !== "qualified") { reject(u, d.reason); continue; }

      const c = {
        ...u, ai, depth, seedId, tier: followerTier(u.followers),
        possiblyManaged: job.depth === 0 && job.root_seed_type === "agency",
      };

      // A qualified creator always becomes a crawl source (if depth allows), even without email.
      if (depth < settings.max_depth) await store.queueCrawl(c, job);

      if (!settings.collect_without_email && !u.found.emails.size) {
        decided.push({ x_user_id: u.id, handle: u.handle, outcome: "rejected", reason: "no_email", depth, source_seed_id: seedId });
        stats.rejected.no_email = (stats.rejected.no_email || 0) + 1;
        continue;
      }
      await store.saveCreator(c, u.found);
      decided.push({ x_user_id: u.id, handle: u.handle, outcome: "qualified", reason: null, depth, source_seed_id: seedId });
      qualified++;
    }
  }

  return qualified;
  } finally {
    // Save every decision made so far, even if the budget ran out mid-page.
    await store.markSeen(decided);
  }
}

export async function processJob(job, settings) {
  const stats = { pulled: 0, qualified: 0, excluded: 0, skippedKnown: 0, rejected: {} };
  const cap = settings.max_followings_per_account;
  let cursor = job.cursor || null;
  let pulled = job.pulled_count || 0;

  // Seed paused or removed since it was queued? Skip it.
  if (job.depth === 0 && job.source_seed_id) {
    if ((await store.seedStatus(job.source_seed_id)) !== "active") {
      await store.updateJob(job.id, { status: "failed", last_error: "seed_inactive", locked_at: null });
      stats.skipped = true;
      return stats;
    }
  }

  while (pulled < cap) {
    await assertBudget(settings);
    const page = await getFollowingsPage(job.handle, cursor);
    await store.recordSpend("twitterapi", "followings", page.users.length || 1, (page.users.length || 1) * config.costPerProfile);
    const users = page.users.slice(0, cap - pulled);
    pulled += users.length; stats.pulled += users.length;

    stats.qualified += await processAccounts(users, job, settings, stats);

    cursor = page.nextCursor;
    await store.updateJob(job.id, { cursor, pulled_count: pulled, qualified_count: (job.qualified_count || 0) + stats.qualified });
    log(`[job @${job.handle}] pulled ${pulled}/${cap}, qualified so far ${stats.qualified}`);
    if (!cursor || !users.length) break;
  }
  return stats;
}
