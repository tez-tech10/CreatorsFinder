// Background crawler: starts with the API server on Railway.
// Steady mode = 1 lane, turbo = 3 lanes working in parallel.
import { config } from "../config.js";
import { log, sleep, requestStop, isStopping } from "./util.js";
import * as store from "./store.js";
import { processJob, BudgetReached } from "./pipeline.js";
import { fetchProfiles, InstagramUnavailable } from "./instagram.js";
import { afterInstagram } from "./emailrules.js";
import { notify, notifyOnce } from "../lib/telegram.js";
import { sendTick, readTick } from "../email/engine.js";

const today = () => new Date().toISOString().slice(0, 10);

async function lane(n) {
  while (!isStopping()) {
    let settings;
    try { settings = await store.getSettings(); }
    catch (e) {
      log(`[lane ${n}] cannot load settings:`, e.message);
      if (n === 1) await store.heartbeat("error", "Cannot reach the database: " + e.message);
      await sleep(config.pollIdleMs); continue;
    }

    if (n > 1 && settings.crawl_mode !== "turbo") { await sleep(config.pollIdleMs); continue; }

    if (!settings.crawler_enabled) {
      if (n === 1) await store.heartbeat("paused", "Crawler is switched off in the admin screen.");
      await sleep(config.pollIdleMs); continue;
    }

    // 10-seed lock: never crawl below the minimum
    try {
      const active = await store.activeSeedCount();
      if (active < settings.min_seeds) {
        if (n === 1) {
          await store.switchCrawlerOff(`only ${active} active seeds (minimum ${settings.min_seeds})`);
          await notify(`[crawler] Switched off: only ${active} active seeds (minimum ${settings.min_seeds}). Add seeds, then switch it back on.`);
        }
        await sleep(config.pollIdleMs); continue;
      }
    } catch (e) { log(`[lane ${n}] seed check failed:`, e.message); await sleep(config.pollIdleMs); continue; }

    let spent;
    try { spent = await store.spentToday(); }
    catch (e) {
      if (n === 1) await store.heartbeat("error", "Paused: can't read today's spending: " + e.message);
      log(`[lane ${n}] can't read spending:`, e.message); await sleep(config.pollIdleMs); continue;
    }
    if (spent >= Number(settings.daily_budget_usd)) {
      if (n === 1) {
        await store.heartbeat("budget_reached", `Today's budget is used ($${spent.toFixed(2)} of $${settings.daily_budget_usd}). Resumes tomorrow (UTC) or when you raise the budget.`);
        await notifyOnce(`budget:${today()}`, `[crawler] Daily budget reached: $${spent.toFixed(2)} of $${settings.daily_budget_usd}. Paused until tomorrow (UTC) or until you raise the budget in Settings.`);
      }
      await sleep(5 * 60_000); continue;
    }

    if (n === 1) {
      const added = await store.ensureSeedJobs().catch((e) => { log("[seeds]", e.message); return 0; });
      if (added) log(`[lane 1] queued ${added} seed account(s)`);
    }

    let job;
    try { job = await store.claimJob(Math.max(0, settings.max_depth - 1)); }
    catch (e) { log(`[lane ${n}] claim failed:`, e.message); await sleep(config.pollIdleMs); continue; }

    if (!job) {
      if (n === 1) await store.heartbeat("idle", "Nothing left to crawl at the current depth. Add seeds or raise the depth.");
      await sleep(config.pollIdleMs); continue;
    }

    log(`[lane ${n}] crawling @${job.handle} (depth ${job.depth}, attempt ${job.attempts})`);
    await store.heartbeat("crawling", `Crawling @${job.handle}`, job.handle);

    try {
      const stats = await processJob(job, settings);
      if (!stats.skipped && (await store.jobStatus(job.id)) === "running") {
        await store.finishJob(job, stats);
        const top = Object.entries(stats.rejected).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v}`).join(", ");
        await store.activity("pipeline", `Crawled @${job.handle}: ${stats.pulled} pulled, ${stats.qualified} qualified`, { ...stats, top_rejections: top });
        log(`[lane ${n}] done @${job.handle}: ${stats.pulled} pulled, ${stats.qualified} qualified, ${stats.excluded} excluded`);
      }
    } catch (e) {
      if (e instanceof BudgetReached) {
        await store.updateJob(job.id, { status: "queued", attempts: Math.max(0, job.attempts - 1), locked_at: null });
        await store.heartbeat("budget_reached", e.message);
        log(`[lane ${n}] ${e.message}`);
        continue;
      }
      const failed = e.fatal || job.attempts >= 3;
      await store.updateJob(job.id, { status: failed ? "failed" : "queued", last_error: String(e.message).slice(0, 500), locked_at: null });
      await store.activity("pipeline", `Error on @${job.handle}: ${e.message}`, { attempt: job.attempts });
      await store.heartbeat("error", e.message);
      log(`[lane ${n}] error @${job.handle}:`, e.message);
      await notifyOnce(`crawlerr:${new Date().toISOString().slice(0, 13)}`, `[crawler] Problem while crawling @${job.handle}: ${String(e.message).slice(0, 200)}${failed ? "\nThis account was skipped after 3 tries." : "\nIt will retry automatically."}`);
      await sleep(e.fatal ? 10 * 60_000 : 15_000);
      continue;
    }
    await sleep(config.pollBusyMs);
  }
}

// Instagram check lane (plan 5.1): runs on its own so a slow Instagram service never slows the X crawl.
// Only creators with an email and X followers between the two limits ever reach it.
let igNotice = null;
async function igNote(msg) {
  if (msg === igNotice) return;
  igNotice = msg;
  if (msg) {
    log("[instagram]", msg);
    await store.activity("instagram", msg).catch(() => {});
    await notifyOnce(`ig:${today()}:${msg.slice(0, 60)}`, `[instagram] ${msg}`);
  }
}

async function instagramLane() {
  while (!isStopping()) {
    try { await instagramTick(); }
    catch (e) { log("[instagram] error:", e.message); await sleep(60_000); }
  }
}

export async function instagramTick() {
  let settings;
  try { settings = await store.getSettings(); } catch { await sleep(config.pollIdleMs); return; }
  // Follows the main crawler switch, so "off" means nothing is spent anywhere
  if (!settings.crawler_enabled || !settings.ig_check_enabled) { await sleep(config.pollIdleMs); return; }

  let batch;
  try { batch = await store.pendingInstagram(config.igBatchSize); }
  catch (e) { log("[instagram] queue read failed:", e.message); await sleep(config.pollIdleMs); return; }
  if (!batch.length) { await sleep(config.pollIdleMs); return; }

  if (!config.apifyToken) { await igNote(`${batch.length}+ creators are waiting for the Instagram check, but APIFY_TOKEN isn't set in Railway.`); await sleep(5 * 60_000); return; }

  // Same daily budget as the X crawl
  let spent;
  try { spent = await store.spentToday(); } catch { await sleep(config.pollIdleMs); return; }
  if (spent >= Number(settings.daily_budget_usd)) { await sleep(5 * 60_000); return; }

  // Anyone queued without a linked Instagram goes straight to review (no request needed)
  const noIg = batch.filter((c) => !c.ig.length);
  for (const c of noIg) await store.saveInstagramResult(c.id, [], { status: "under_review", reason: "no_instagram", total: null });
  const work = batch.filter((c) => c.ig.length);
  if (!work.length) return;

  const usernames = [...new Set(work.flatMap((c) => c.ig))];
  let profiles;
  try {
    profiles = await fetchProfiles(usernames);
    await store.recordSpend("apify", "instagram_profiles", usernames.length, usernames.length * config.costPerIgProfile, { found: profiles.size });
    // Nothing at all came back: the service is having trouble. Don't judge anyone on that.
    if (!profiles.size) throw new Error("Apify returned no profiles");
    await igNote(null);
  } catch (e) {
    if (e instanceof InstagramUnavailable) { await igNote(`Instagram check paused: ${e.message}`); await sleep(10 * 60_000); return; }
    log("[instagram] request failed:", e.message);
    await store.instagramFailed(work.map((c) => c.id));
    await sleep(60_000); return;
  }

  let eligible = 0;
  for (const c of work) {
    const mine = c.ig.map((u) => profiles.get(u) || { username: u, found: false, followers: null });
    const decision = afterInstagram(mine.map((p) => p.followers), settings);
    await store.saveInstagramResult(c.id, mine, decision);
    if (decision.status === "eligible") eligible++;
  }
  log(`[instagram] checked ${work.length} creators (${usernames.length} accounts): ${eligible} to email list, ${work.length - eligible} under review`);
  await sleep(config.pollBusyMs);
}

// Email lane: sends when it's due (every 30s check) and reads replies every 3 minutes.
// Independent of the crawler switch: it has its own "Sending on" switch on the Email page.
let lastRead = 0;
async function emailLane() {
  while (!isStopping()) {
    try {
      const settings = await store.getSettings();
      if (Date.now() - lastRead > 3 * 60_000) { lastRead = Date.now(); await readTick(); }
      await sendTick(settings);
    } catch (e) { log("[email] error:", e.message); }
    await sleep(30_000);
  }
}

let running = null;

export function startCrawler() {
  log("Crawler starting. AI models:", config.llmModels.join(" → "));
  running = (async () => {
    try { await store.markStarted(); } catch {}
    await store.heartbeat("idle", "Crawler started");
    await Promise.all([lane(1), lane(2), lane(3), instagramLane(), emailLane()]);
    await store.heartbeat("offline", "Crawler stopped");
    log("Crawler stopped.");
  })().catch(async (e) => {
    log("Crawler crashed:", e);
    await store.heartbeat("error", "Crawler crashed: " + e.message);
  });
  return running;
}

export async function stopCrawler() {
  requestStop();
  if (running) await running;
}
