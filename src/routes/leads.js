// Phase 4 — Leads: browse, filter, update, and export the creators the crawler found.
import { Router } from "express";
import { query, one, pool, activity } from "../lib/db.js";
import { requireAdmin } from "../middleware/session.js";

const router = Router();
router.use("/api/admin/leads", requireAdmin);
router.use("/api/admin/deliveries", requireAdmin);

const STATUSES = ["new", "contacted", "replied", "declined", "signed", "unreachable"];
const EMAIL_LISTS = ["eligible", "pending_ig", "under_review", "none"];
const SORTS = {
  newest: "c.created_at desc",
  followers_desc: "c.x_followers desc nulls last",
  followers_asc: "c.x_followers asc nulls last",
  active: "c.last_post_at desc nulls last",
};

// Builds the WHERE clause from query-string filters. Shared by list, count and export.
export function buildFilters(q) {
  const where = [], params = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace("?", `$${params.length}`)); };

  if (q.search) {
    const s = `%${String(q.search).trim().replace(/^@/, "").slice(0, 80)}%`;
    params.push(s);
    const n = params.length;
    where.push(`(c.handle ilike $${n} or c.display_name ilike $${n} or c.bio ilike $${n})`);
  }
  if (q.niche) add("lower(c.niche) = lower(?)", String(q.niche));
  if (q.min_followers) add("c.x_followers >= ?", Number(q.min_followers) || 0);
  if (q.max_followers) add("c.x_followers <= ?", Number(q.max_followers) || 0);
  if (q.status && STATUSES.includes(q.status)) add("c.status = ?", q.status);
  // "Has email" = on the email list (plan 5.1). Other email states can be picked with email_list=…
  if (q.has_email === "1") where.push("c.email_list = 'eligible'");
  if (q.email_list && EMAIL_LISTS.includes(q.email_list)) add("c.email_list = ?", q.email_list);
  if (q.has_telegram === "1") where.push("exists (select 1 from contacts k where k.creator_id = c.id and k.type = 'telegram')");
  if (q.has_instagram === "1") where.push("exists (select 1 from platform_accounts p where p.creator_id = c.id and p.platform = 'instagram')");
  if (q.dm_open === "1") where.push("c.dm_open is true");
  if (q.managed === "0") where.push("c.possibly_managed is false");
  if (q.delivered === "0") where.push("c.delivered_at is null");
  if (q.delivered === "1") where.push("c.delivered_at is not null");
  // Leads that are excluded or suppressed never show, whatever the filters
  where.push("not exists (select 1 from exclusions e where e.x_user_id = c.x_user_id)");
  where.push("not exists (select 1 from suppression_list s where s.x_user_id = c.x_user_id)");
  return { sql: where.length ? "where " + where.join(" and ") : "", params };
}

const LIST_COLUMNS = `
  c.id, c.x_user_id, c.handle, c.display_name, c.x_followers, c.niche, c.tier, c.status, c.dm_open,
  c.possibly_managed, c.profile_image, c.last_post_at, c.created_at, c.delivered_at, c.email_list, c.ig_followers_total, c.email_stage,
  (select k.value from contacts k where k.creator_id = c.id and k.type = 'email' and k.email_status <> 'invalid' order by k.found_at limit 1) as email,
  exists (select 1 from contacts k where k.creator_id = c.id and k.type = 'telegram') as has_telegram,
  (select p.url from platform_accounts p where p.creator_id = c.id and p.platform = 'onlyfans' limit 1) as onlyfans_url,
  (select p.handle from platform_accounts p where p.creator_id = c.id and p.platform = 'instagram' limit 1) as instagram`;

router.get("/api/admin/leads", async (req, res, next) => {
  try {
    const f = buildFilters(req.query);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const order = SORTS[req.query.sort] || SORTS.newest;
    const [rows, total, niches] = await Promise.all([
      query(`select ${LIST_COLUMNS} from creators c ${f.sql} order by ${order} limit ${limit} offset ${offset}`, f.params),
      one(`select count(*)::int as n from creators c ${f.sql}`, f.params),
      query("select niche, count(*)::int as n from creators where niche is not null and niche <> '' group by niche order by 2 desc limit 30"),
    ]);
    res.json({ leads: rows.rows, total: total.n, limit, offset, niches: niches.rows });
  } catch (e) { next(e); }
});

router.get("/api/admin/leads/:id", async (req, res, next) => {
  try {
    const lead = await one("select c.*, s.handle as seed_handle, s.seed_type from creators c left join seeds s on s.id = c.found_via_seed_id where c.id = $1", [req.params.id]);
    if (!lead) return res.status(404).json({ error: "Lead not found." });
    const [contacts, platforms] = await Promise.all([
      query("select type, value, source, email_status, internal_only, found_at from contacts where creator_id = $1 order by type, found_at", [lead.id]),
      query("select platform, handle, url, followers, checked_at from platform_accounts where creator_id = $1 order by platform", [lead.id]),
    ]);
    res.json({ lead, contacts: contacts.rows, platforms: platforms.rows });
  } catch (e) { next(e); }
});

// Change status and/or notes. "declined" also adds her to the do-not-contact list.
router.patch("/api/admin/leads/:id", async (req, res, next) => {
  try {
    const lead = await one("select id, x_user_id, handle, status from creators where id = $1", [req.params.id]);
    if (!lead) return res.status(404).json({ error: "Lead not found." });
    const { status, notes, email_list } = req.body || {};
    if (status !== undefined && !STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status." });

    // Manual review: approve an under-review creator for the email list, or move one back to review
    if (email_list !== undefined) {
      if (!["eligible", "under_review"].includes(email_list)) return res.status(400).json({ error: "Invalid email list choice." });
      const hasEmail = await one("select 1 from contacts where creator_id = $1 and type = 'email' and email_status <> 'invalid' limit 1", [lead.id]);
      if (!hasEmail) return res.status(400).json({ error: "She has no email, so she can't go on the email list." });
      await query("update creators set email_list = $1, email_list_reason = $2, updated_at = now() where id = $3",
        [email_list, email_list === "eligible" ? "admin_approved" : "admin_review", lead.id]);
      await activity("leads", `@${lead.handle} ${email_list === "eligible" ? "approved for the email list" : "moved to email review"}`);
    }
    if (notes !== undefined && typeof notes !== "string") return res.status(400).json({ error: "Invalid notes." });

    const updated = await one(
      `update creators set status = coalesce($1, status), notes = case when $2::boolean then $3 else notes end, updated_at = now()
        where id = $4 returning id, status, notes, email_list, email_list_reason`,
      [status || null, notes !== undefined, notes !== undefined ? notes.slice(0, 2000) : null, lead.id]);

    if (status && status !== lead.status) {
      await activity("leads", `@${lead.handle} marked ${status}`);
      if (status === "declined") {
        await query("insert into suppression_list (x_user_id, reason) values ($1, 'declined') on conflict (x_user_id) do nothing", [lead.x_user_id]);
      }
    }
    res.json({ lead: updated });
  } catch (e) { next(e); }
});

// CSV export of the current filter. With mark=1 + buyer, the exported leads are marked delivered
// (so with "not yet delivered" selected, a lead is never exported to two buyers).
function csvCell(v) {
  const s = v == null ? "" : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;      // stop spreadsheet formula injection
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

router.get("/api/admin/leads-export.csv", requireAdmin, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const f = buildFilters(req.query);
    const max = Math.min(10000, Math.max(1, Number(req.query.max) || 1000));
    const mark = req.query.mark === "1";
    const buyer = String(req.query.buyer || "").trim().slice(0, 200);
    const includePhones = req.query.phones === "1";       // internal use only — off by default
    if (mark && !buyer) return res.status(400).json({ error: "Add who the leads are for, to mark them delivered." });

    await client.query("begin");
    // Lock the rows so two exports at the same time can't deliver the same lead twice
    const rows = (await client.query(
      `select c.id, c.handle, c.display_name, c.x_followers, c.niche, c.last_post_at, c.possibly_managed,
              c.email_list, c.ig_followers_total
         from creators c ${f.sql} order by c.created_at limit ${max} for update skip locked`, f.params)).rows;
    const ids = rows.map((r) => r.id);
    const contacts = ids.length ? (await client.query(
      "select creator_id, type, value from contacts where creator_id = any($1) and (type <> 'email' or email_status <> 'invalid') order by found_at", [ids])).rows : [];
    const platforms = ids.length ? (await client.query(
      "select creator_id, platform, handle, url from platform_accounts where creator_id = any($1)", [ids])).rows : [];

    const by = (list, id, pred) => list.filter((x) => x.creator_id === id && pred(x));
    // Email is only exported for creators on the email list (plan 5.1).
    // Internal exports (phones=1) also show under-review emails in their own column.
    const lines = [["x_handle", "x_profile", "name", "x_followers", "niche", "last_active", "onlyfans", "fansly", "email", "telegram", "instagram", "instagram_followers", "tiktok", "possibly_managed"]
      .concat(includePhones ? ["phone", "whatsapp", "email_not_on_list"] : [])];
    for (const r of rows) {
      const c = (t) => by(contacts, r.id, (x) => x.type === t).map((x) => x.value).join(" | ");
      const p = (pl, field) => by(platforms, r.id, (x) => x.platform === pl).map((x) => x[field]).join(" | ");
      lines.push([r.handle, `https://x.com/${r.handle}`, r.display_name, r.x_followers, r.niche,
        r.last_post_at ? new Date(r.last_post_at).toISOString().slice(0, 10) : "", p("onlyfans", "url"), p("fansly", "url"),
        r.email_list === "eligible" ? c("email") : "", c("telegram"), p("instagram", "handle"), r.ig_followers_total ?? "",
        p("tiktok", "handle"), r.possibly_managed ? "yes" : "no"]
        .concat(includePhones ? [c("phone"), c("whatsapp"), r.email_list === "eligible" ? "" : c("email")] : []));
    }

    if (mark && ids.length) {
      const d = (await client.query("insert into deliveries (buyer, lead_count) values ($1, $2) returning id", [buyer, ids.length])).rows[0];
      await client.query("update creators set delivered_at = now(), delivery_id = $1 where id = any($2)", [d.id, ids]);
    }
    await client.query("commit");
    if (mark && ids.length) await activity("leads", `${ids.length} leads exported and marked delivered to ${buyer}`);

    const name = `creatorsfinder-leads-${new Date().toISOString().slice(0, 10)}${mark ? "-" + buyer.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) : ""}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.send("﻿" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n");
  } catch (e) {
    await client.query("rollback").catch(() => {});
    next(e);
  } finally { client.release(); }
});

router.get("/api/admin/deliveries", async (_req, res, next) => {
  try {
    res.json({ deliveries: (await query("select * from deliveries order by created_at desc limit 50")).rows });
  } catch (e) { next(e); }
});

export default router;
