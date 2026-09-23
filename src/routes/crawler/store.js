// All crawler database reads/writes (plain SQL on the Supabase tables).
import { query, one, activity } from "../lib/db.js";
import { log } from "./util.js";

export { activity };

export async function getSettings() {
  return one("select * from settings where id = 1");
}

export async function heartbeat(state, message = null, currentJob = null) {
  try {
    await query("update worker_status set state=$1, message=$2, current_job=$3, last_seen_at=now() where id = 1", [state, message, currentJob]);
  } catch (e) { log("[heartbeat] failed:", e.message); }
}

export async function markStarted() {
  await query("update worker_status set started_at = now() where id = 1");
}

// ---------- Spending (daily budget) ----------
let spendCache = { day: null, total: 0, fetchedAt: 0 };
const today = () => new Date().toISOString().slice(0, 10);

// If spending can't be read, this throws → the crawler pauses (never assumes $0).
export async function spentToday() {
  if (spendCache.day !== today() || Date.now() - spendCache.fetchedAt > 60_000) {
    const r = await one("select coalesce(sum(cost_usd), 0)::float as total from spend_log where day = (now() at time zone 'utc')::date");
    spendCache = { day: today(), total: Number(r.total), fetchedAt: Date.now() };
  }
  return spendCache.total;
}

export async function recordSpend(provider, action, units, costUsd, meta = null) {
  if (!units && !costUsd) return;
  spendCache.total += Number(costUsd || 0);
  try {
    await query("insert into spend_log (provider, action, units, cost_usd, meta) values ($1,$2,$3,$4,$5)", [provider, action, units, costUsd, meta]);
  } catch (e) { log("[spend] failed to record:", e.message); }
}

// ---------- Seed lock ----------
export async function activeSeedCount() {
  return Number((await one("select count(*) as n from seeds where status = 'active'")).n);
}

export async function switchCrawlerOff(reason) {
  await query("update settings set crawler_enabled = false, updated_at = now() where id = 1");
  await activity("settings", `Crawler switched off: ${reason}`);
}

// ---------- Seeds → first jobs ----------
export async function ensureSeedJobs() {
  const r = await query(`
    insert into crawl_jobs (x_user_id, handle, depth, source_seed_id, root_seed_type)
    select s.x_user_id, s.handle, 0, s.id, s.seed_type from seeds s
     where s.status = 'active'
    on conflict (x_user_id) do nothing
    returning x_user_id`);
  // Seeds themselves are sources, never leads
  await query(`
    insert into x_accounts_seen (x_user_id, handle, outcome, reason, depth, source_seed_id)
    select x_user_id, handle, 'rejected', 'seed', 0, id from seeds
    on conflict (x_user_id) do nothing`);
  // A seed that was paused and is active again gets its job back
  const back = await query(`
    update crawl_jobs j set status = 'queued', attempts = 0, last_error = null, updated_at = now()
      from seeds s
     where s.x_user_id = j.x_user_id and s.status = 'active' and j.status = 'failed' and j.last_error = 'seed_inactive'
    returning j.x_user_id`);
  return r.rowCount + back.rowCount;
}

// Takes the next job. Safe with several lanes at once (skip locked).
// Also re-takes jobs stuck in 'running' for 30+ minutes (after a crash/redeploy).
export async function claimJob(maxJobDepth) {
  return one(`
    update crawl_jobs j
       set status = 'running', locked_at = now(), attempts = j.attempts + 1, updated_at = now()
     where j.id = (
       select id from crawl_jobs
        where depth <= $1 and attempts < 3
          and (status = 'queued' or (status = 'running' and locked_at < now() - interval '30 minutes'))
        order by depth, created_at
        for update skip locked
        limit 1)
    returning j.*`, [maxJobDepth]);
}

export async function seedStatus(seedId) {
  const r = await one("select status from seeds where id = $1", [seedId]);
  return r?.status || null;
}

export async function updateJob(id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  await query(`update crawl_jobs set ${sets}, updated_at = now() where id = $${keys.length + 1}`, [...keys.map((k) => fields[k]), id]);
}

export async function jobStatus(id) {
  return (await one("select status from crawl_jobs where id = $1", [id]))?.status;
}

export async function finishJob(job, stats) {
  await query("update crawl_jobs set status = 'done', last_error = null, locked_at = null, updated_at = now() where id = $1", [job.id]);
  await query("update x_accounts_seen set followings_crawled = true, updated_at = now() where x_user_id = $1", [job.x_user_id]);
  if (job.source_seed_id) {
    await query(`update seeds set accounts_pulled = accounts_pulled + $1, qualified_count = qualified_count + $2,
                  last_crawled_at = now() where id = $3`, [stats.pulled, stats.qualified, job.source_seed_id]);
  }
}

// ---------- Dedupe ----------
// IDs already decided (anything not 'pending'), excluded, or suppressed.
export async function knownIds(ids) {
  if (!ids.length) return new Set();
  const r = await query(`
    select x_user_id from x_accounts_seen where x_user_id = any($1) and outcome <> 'pending'
    union select x_user_id from exclusions where x_user_id = any($1)
    union select x_user_id from suppression_list where x_user_id = any($1)`, [ids]);
  return new Set(r.rows.map((x) => x.x_user_id));
}

export async function markSeen(rows) {
  if (!rows.length) return;
  const cols = ["x_user_id", "handle", "outcome", "reason", "depth", "source_seed_id"];
  const params = [], values = [];
  rows.forEach((r, i) => {
    values.push(`(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(",")})`);
    cols.forEach((c) => params.push(r[c] ?? null));
  });
  await query(`
    insert into x_accounts_seen (${cols.join(",")}) values ${values.join(",")}
    on conflict (x_user_id) do update set handle = excluded.handle, outcome = excluded.outcome,
      reason = excluded.reason, depth = excluded.depth, source_seed_id = excluded.source_seed_id, updated_at = now()`, params);
}

export async function exclude(xUserId, handle, reason, depth, seedId) {
  await query("insert into exclusions (x_user_id, reason) values ($1, $2) on conflict (x_user_id) do nothing", [xUserId, reason]);
  await markSeen([{ x_user_id: xUserId, handle, outcome: "excluded", reason, depth, source_seed_id: seedId }]);
}

// ---------- Saving a qualified creator ----------
export async function saveCreator(c, found) {
  const row = await one(`
    insert into creators (x_user_id, handle, display_name, bio, x_followers, x_following, last_post_at, bio_link, resolved_link,
      niche, tier, language, found_via_seed_id, depth, possibly_managed, llm_result, dm_open, dm_checked_at, profile_image, x_created_at)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'english',$12,$13,$14,$15,$16,$17,$18,$19)
    on conflict (x_user_id) do update set handle = excluded.handle, display_name = excluded.display_name, bio = excluded.bio,
      x_followers = excluded.x_followers, x_following = excluded.x_following, last_post_at = excluded.last_post_at,
      resolved_link = excluded.resolved_link, dm_open = excluded.dm_open, dm_checked_at = excluded.dm_checked_at, updated_at = now()
    returning id`,
    [c.id, c.handle, c.name, c.bio, c.followers, c.following, c.lastPostAt || null, c.links[0] || null, found.resolvedLink,
     c.ai?.niche || null, c.tier, c.seedId, c.depth, c.possiblyManaged, c.ai || null, c.canDm,
     c.canDm == null ? null : new Date(), c.profileImage, c.createdAt && !isNaN(c.createdAt) ? c.createdAt : null]);

  const platforms = [["x", c.handle, `https://x.com/${c.handle}`, c.followers]];
  found.onlyfans.forEach((url) => platforms.push(["onlyfans", url.split("/").pop(), url, null]));
  found.fansly.forEach((url) => platforms.push(["fansly", url.split("/").pop(), url, null]));
  found.fanvue.forEach((url) => platforms.push(["fanvue", url.split("/").pop(), url, null]));
  found.instagram.forEach((h) => platforms.push(["instagram", h, `https://instagram.com/${h}`, null]));
  found.tiktok.forEach((h) => platforms.push(["tiktok", h, `https://tiktok.com/@${h}`, null]));
  for (const [platform, handle, url, followers] of platforms) {
    await query(`insert into platform_accounts (creator_id, platform, handle, url, followers, checked_at)
                 values ($1,$2,$3,$4,$5, case when $5::int is null then null else now() end)
                 on conflict (creator_id, platform, url) do nothing`, [row.id, platform, handle, url, followers]);
  }

  const contacts = [];
  const src = found.sources.email || "bio";
  found.emails.forEach((v) => contacts.push(["email", v, src]));
  found.phones.forEach((v) => contacts.push(["phone", v, "bio_or_link_page"]));
  found.whatsapp.forEach((v) => contacts.push(["whatsapp", v, "link_page"]));
  found.telegram.forEach((v) => contacts.push(["telegram", v, "link_page"]));
  for (const [type, value, source] of contacts) {
    // Phone + WhatsApp are always internal-only (never shown to agencies)
    const internal = type === "phone" || type === "whatsapp";
    await query(`insert into contacts (creator_id, type, value, source, internal_only) values ($1,$2,$3,$4,$5)
                 on conflict (creator_id, type, value) do nothing`, [row.id, type, value, source, internal]);
  }
  return row.id;
}

export async function queueCrawl(c, job) {
  await query(`insert into crawl_jobs (x_user_id, handle, depth, source_seed_id, root_seed_type)
               values ($1,$2,$3,$4,$5) on conflict (x_user_id) do nothing`,
    [c.id, c.handle, c.depth, job.source_seed_id, job.root_seed_type]);
}
