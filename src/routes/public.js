// Public, no login: a masked live crawl log for the homepage and sign-in page.
// Handles are always masked (first 2 letters only); no contact details are ever shown.
import { Router } from "express";
import { query, one, activity } from "../lib/db.js";
import { notify } from "../lib/telegram.js";

const router = Router();
let cache = { at: 0, data: null };

const REASONS = {
  out_of_range: "below the X follower minimum", not_english: "not posting in English", no_onlyfans: "no OnlyFans link found",
  inactive: "not active recently", private: "private account", automated: "automated account", unavailable: "account unavailable",
  posts_unavailable: "posts unavailable", ai_not_creator: "not a creator", ai_not_female_self_stated: "not a female creator (self-stated)",
  ai_not_english: "not an English speaker", ai_not_real_person: "not a real person", ai_low_confidence: "not clear enough to qualify",
  ai_failed: "couldn't be checked", no_email: "no email found",
};

export function mask(handle) {
  const h = String(handle || "");
  return "@" + h.slice(0, 2) + "•".repeat(Math.max(3, Math.min(8, h.length - 2)));
}

function short(n) {
  if (n == null) return "—";
  return n >= 1000 ? (Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, "") + "K" : String(n);
}

router.get("/api/public/crawl-log", async (_req, res, next) => {
  try {
    if (!cache.data || Date.now() - cache.at > 60_000) {
      const rows = (await query(`
        select s.outcome, s.reason, s.handle, s.updated_at, c.niche, c.x_followers,
               exists (select 1 from contacts k where k.creator_id = c.id and k.type = 'email') as has_email,
               exists (select 1 from contacts k where k.creator_id = c.id and k.type = 'telegram') as has_telegram,
               (select p.url from platform_accounts p where p.creator_id = c.id and p.platform = 'onlyfans' limit 1) is not null as has_of
          from x_accounts_seen s left join creators c on c.x_user_id = s.x_user_id
         where s.outcome in ('qualified', 'rejected', 'excluded') and coalesce(s.reason, '') <> 'seed'
         order by s.updated_at desc limit 14`)).rows;
      const totals = await one(`select count(*) filter (where outcome <> 'pending' and coalesce(reason,'') <> 'seed')::int as checked,
                                       count(*) filter (where outcome = 'qualified')::int as qualified from x_accounts_seen`);
      cache = { at: Date.now(), data: {
        totals,
        rows: rows.map((r) => r.outcome === "excluded"
          ? { at: r.updated_at, account: "@hidden", result: "EXCLUDED", why: "age safety: removed permanently", followers: "—", contact: "—" }
          : r.outcome === "qualified"
            ? { at: r.updated_at, account: mask(r.handle), result: "QUALIFIED", why: ["OnlyFans verified", "English", r.niche].filter(Boolean).join(" · "),
                followers: short(r.x_followers), contact: [r.has_email && "email", r.has_telegram && "telegram"].filter(Boolean).join(" · ") || "—", niche: r.niche }
            : { at: r.updated_at, account: mask(r.handle), result: "REJECTED", why: REASONS[r.reason] || "didn't pass the checks", followers: "—", contact: "—" }),
      } };
    }
    res.set("Cache-Control", "public, max-age=60");
    res.json(cache.data);
  } catch (e) { next(e); }
});

// Simple per-IP limit for the public forms (10 per hour).
const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter((t) => now - t < 3600_000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 10;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clip = (v, n) => String(v || "").trim().slice(0, n);

// Creator removal request: removes her right away if we have her, and blocks her handle from being collected.
router.post("/api/public/removal", async (req, res, next) => {
  try {
    if (limited(req.ip)) return res.status(429).json({ error: "Too many requests. Try again later." });
    const handle = clip(req.body?.handle, 60).replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").split(/[/?#]/)[0];
    const email = clip(req.body?.email, 200).toLowerCase();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return res.status(400).json({ error: "Enter your X handle, like @yourname." });
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "That email doesn't look right." });
    if (!req.body?.confirmed) return res.status(400).json({ error: "Please confirm you own this account." });

    const c = await one("select id, x_user_id from creators where lower(handle) = lower($1) limit 1", [handle]);
    const seen = c || await one("select x_user_id from x_accounts_seen where lower(handle) = lower($1) limit 1", [handle]);
    if (seen?.x_user_id) await query("insert into suppression_list (x_user_id, reason) values ($1, 'removal_request') on conflict do nothing", [seen.x_user_id]);
    if (email) await query("insert into suppression_list (email, reason) values ($1, 'removal_request') on conflict do nothing", [email]);
    if (c) await query("delete from creators where id = $1", [c.id]);
    await query("insert into removal_requests (handle, email, confirmed_owner, status) values ($1, $2, true, $3)", [handle, email || null, seen ? "done" : "pending"]);
    await activity("removal", `Removal request for @${handle}${c ? " (profile deleted)" : seen ? " (blocked)" : " (not in the database; handle blocked)"}`);
    await notify(`[site] Removal request: @${handle}\n${c ? "Her profile was deleted and she's on the do-not-contact list." : "She wasn't in the database. Her handle is blocked from being collected."}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Agency access request from the sign-up page (no agency accounts yet): logged + sent to Telegram.
router.post("/api/public/access-request", async (req, res, next) => {
  try {
    if (limited(req.ip)) return res.status(429).json({ error: "Too many requests. Try again later." });
    const b = req.body || {};
    const r = { name: clip(b.name, 100), email: clip(b.email, 200).toLowerCase(), agency: clip(b.agency, 120),
      size: clip(b.size, 40), niches: clip(b.niches, 200), plan: clip(b.plan, 40) };
    if (!r.name || !EMAIL_RE.test(r.email)) return res.status(400).json({ error: "Please add your name and a valid work email." });
    await activity("signup", `Access request from ${r.name} (${r.agency || "no agency name"})`, r);
    await notify(`[site] New access request\nName: ${r.name}\nEmail: ${r.email}\nAgency: ${r.agency || "—"}\nCreators managed: ${r.size || "—"}\nNiches: ${r.niches || "—"}\nPlan: ${r.plan || "—"}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
