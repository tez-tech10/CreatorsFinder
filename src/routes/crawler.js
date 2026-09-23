import { Router } from "express";
import { query, one } from "../lib/db.js";
import { requireAdmin } from "../middleware/session.js";

const router = Router();
router.use("/api/admin/crawler", requireAdmin);
router.use("/api/admin/activity", requireAdmin);

// Everything the admin screen shows about the crawler, in one call.
router.get("/api/admin/crawler", async (_req, res, next) => {
  try {
    const [progress, spend, worker, rejections, settings] = await Promise.all([
      one(`select
        (select count(*) from crawl_jobs where status = 'queued')::int   as jobs_queued,
        (select count(*) from crawl_jobs where status = 'running')::int  as jobs_running,
        (select count(*) from crawl_jobs where status = 'done')::int     as jobs_done,
        (select count(*) from crawl_jobs where status = 'failed')::int   as jobs_failed,
        (select count(*) from x_accounts_seen where coalesce(reason, '') <> 'seed')::int as accounts_seen,
        (select count(*) from creators)::int                              as creators_total,
        (select count(*) from creators where created_at > now() - interval '24 hours')::int as creators_24h,
        (select count(distinct creator_id) from contacts where type = 'email')::int as creators_with_email,
        (select count(*) from creators where dm_open is true)::int        as creators_dm_open,
        (select count(*) from exclusions)::int                            as excluded_total`),
      one(`select coalesce(sum(cost_usd), 0)::float as total_usd,
                  coalesce(sum(cost_usd) filter (where provider = 'twitterapi'), 0)::float as twitterapi_usd,
                  coalesce(sum(cost_usd) filter (where provider = 'openrouter'), 0)::float as openrouter_usd
             from spend_log where day = (now() at time zone 'utc')::date`),
      one("select state, message, current_job, last_seen_at, started_at from worker_status where id = 1"),
      query(`select reason, count(*)::int as total from x_accounts_seen
              where outcome in ('rejected', 'excluded') and coalesce(reason, '') <> 'seed'
              group by reason order by 2 desc`),
      one("select daily_budget_usd, crawler_enabled, crawl_mode from settings where id = 1"),
    ]);
    const online = worker?.last_seen_at && Date.now() - new Date(worker.last_seen_at).getTime() < 3 * 60_000;
    res.json({
      progress,
      spend: { ...spend, budget_usd: Number(settings.daily_budget_usd) },
      worker: { ...worker, online: !!online },
      rejections: rejections.rows,
      crawler_enabled: settings.crawler_enabled,
      crawl_mode: settings.crawl_mode,
    });
  } catch (e) { next(e); }
});

router.get("/api/admin/activity", async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const rows = (await query("select id, category, message, meta, created_at from activity_log order by id desc limit $1", [limit])).rows;
    res.json({ activity: rows });
  } catch (e) { next(e); }
});

export default router;
