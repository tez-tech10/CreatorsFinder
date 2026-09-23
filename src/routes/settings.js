import { Router } from "express";
import { query, one, activity } from "../lib/db.js";
import { requireAdmin } from "../middleware/session.js";

const router = Router();
router.use("/api/admin/settings", requireAdmin);

// If active seeds < minimum, the crawler is switched off. Returns true if it switched it off.
export async function enforceSeedLock() {
  const r = await one(`
    update settings set crawler_enabled = false, updated_at = now()
     where id = 1 and crawler_enabled
       and (select count(*) from seeds where status = 'active') < min_seeds
    returning id`);
  if (r) await activity("settings", "Crawler switched off: fewer active seeds than the minimum.");
  return !!r;
}

const RULES = {
  follower_min:               { min: 0, max: 10_000_000 },
  follower_max:               { min: 1, max: 100_000_000 },
  active_days:                { min: 1, max: 365 },
  max_depth:                  { min: 1, max: 6 },
  max_followings_per_account: { min: 100, max: 10_000 },
  daily_budget_usd:           { min: 0, max: 10_000 },
  llm_batch_size:             { min: 1, max: 25 },
};

router.get("/api/admin/settings", async (_req, res, next) => {
  try { res.json({ settings: await one("select * from settings where id = 1") }); }
  catch (e) { next(e); }
});

router.patch("/api/admin/settings", async (req, res, next) => {
  try {
    const current = await one("select * from settings where id = 1");
    const next_ = { ...current };
    const b = req.body || {};

    for (const [k, r] of Object.entries(RULES)) {
      if (b[k] === undefined) continue;
      const n = Number(b[k]);
      if (!Number.isFinite(n) || n < r.min || n > r.max) return res.status(400).json({ error: `${k.replace(/_/g, " ")} must be between ${r.min} and ${r.max}.` });
      next_[k] = k === "daily_budget_usd" ? Math.round(n * 100) / 100 : Math.round(n);
    }
    if (b.crawl_mode !== undefined) {
      if (!["steady", "turbo"].includes(b.crawl_mode)) return res.status(400).json({ error: "Mode must be steady or turbo." });
      next_.crawl_mode = b.crawl_mode;
    }
    if (b.collect_without_email !== undefined) next_.collect_without_email = !!b.collect_without_email;
    if (!(next_.follower_max > next_.follower_min)) return res.status(400).json({ error: "Max followers must be higher than min followers." });

    if (b.crawler_enabled !== undefined) {
      const on = !!b.crawler_enabled;
      if (on && !current.crawler_enabled) {
        const active = Number((await one("select count(*) as n from seeds where status = 'active'")).n);
        if (active < current.min_seeds) return res.status(400).json({ error: `Add at least ${current.min_seeds} active seeds before switching the crawler on (currently ${active}).` });
      }
      next_.crawler_enabled = on;
    }

    const saved = await one(`
      update settings set follower_min=$1, follower_max=$2, active_days=$3, max_depth=$4, max_followings_per_account=$5,
             daily_budget_usd=$6, crawl_mode=$7, collect_without_email=$8, crawler_enabled=$9, llm_batch_size=$10, updated_at=now()
       where id = 1 returning *`,
      [next_.follower_min, next_.follower_max, next_.active_days, next_.max_depth, next_.max_followings_per_account,
       next_.daily_budget_usd, next_.crawl_mode, next_.collect_without_email, next_.crawler_enabled, next_.llm_batch_size]);

    const changes = Object.keys(saved).filter((k) => k !== "updated_at" && String(saved[k]) !== String(current[k]));
    if (changes.length) {
      const msg = changes.includes("crawler_enabled")
        ? `Crawler switched ${saved.crawler_enabled ? "on" : "off"}`
        : "Collection settings updated";
      await activity("settings", msg, Object.fromEntries(changes.map((k) => [k, saved[k]])));
    }
    res.json({ settings: saved });
  } catch (e) { next(e); }
});

export default router;
