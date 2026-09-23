// Background crawler: starts with the API server on Railway.
// Steady mode = 1 lane, turbo = 3 lanes working in parallel.
import { config } from "../config.js";
import { log, sleep, requestStop, isStopping } from "./util.js";
import * as store from "./store.js";
import { processJob, BudgetReached } from "./pipeline.js";

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
        if (n === 1) await store.switchCrawlerOff(`only ${active} active seeds (minimum ${settings.min_seeds})`);
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
      if (n === 1) await store.heartbeat("budget_reached", `Today's budget is used ($${spent.toFixed(2)} of $${settings.daily_budget_usd}). Resumes tomorrow (UTC) or when you raise the budget.`);
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
      await sleep(e.fatal ? 10 * 60_000 : 15_000);
      continue;
    }
    await sleep(config.pollBusyMs);
  }
}

let running = null;

export function startCrawler() {
  log("Crawler starting. AI models:", config.llmModels.join(" → "));
  running = (async () => {
    try { await store.markStarted(); } catch {}
    await store.heartbeat("idle", "Crawler started");
    await Promise.all([lane(1), lane(2), lane(3)]);
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
