// Email page API: inboxes, template + schedule, test sends, conversations, Telegram test.
import { Router } from "express";
import { query, one, activity } from "../lib/db.js";
import { requireAdmin } from "../middleware/session.js";
import { encrypt, MissingSecretKey } from "../lib/secret.js";
import { notify, telegramReady } from "../lib/telegram.js";
import { driver } from "../email/mail.js";
import { windowBounds, waitingCount, replyToCreator, sendTest, nextNewLead } from "../email/engine.js";
import { render, varsFor, VARIABLES } from "../email/template.js";

const router = Router();
router.use("/api/admin/email", requireAdmin);
router.use("/api/admin/telegram", requireAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const INBOX_COLS = "id, email, sender_name, daily_limit, enabled, status, last_error, last_checked_at, created_at";
const bad = (res, error) => res.status(400).json({ error });

router.get("/api/admin/email", async (_req, res, next) => {
  try {
    const settings = await one("select * from settings where id = 1");
    const win = windowBounds(settings);
    const inboxes = (await query(`
      select ${INBOX_COLS},
        (select count(*)::int from email_messages m where m.inbox_id = i.id and m.direction = 'out'
            and m.kind in ('first', 'followup') and m.sent_at >= $1) as sent_today
        from email_inboxes i order by created_at`, [new Date(win.start)])).rows;
    const stats = await one(`select
        (select count(*)::int from email_messages where direction = 'out' and kind in ('first','followup') and sent_at >= $1) as sent_today,
        (select count(*)::int from email_messages where direction = 'in' and kind = 'reply' and sent_at >= $1) as replies_today,
        (select count(*)::int from creators where email_stage <> 'none') as contacted_total,
        (select count(*)::int from creators where email_stage in ('replied', 'opted_out')) as replied_total,
        (select count(*)::int from creators where email_stage = 'bounced') as bounced_total,
        (select count(*)::int from creators where email_stage = 'sent' and status in ('new','contacted')) as awaiting_followup`, [new Date(win.start)]);
    res.json({
      settings: {
        email_sending_enabled: settings.email_sending_enabled, email_from_hour: settings.email_from_hour, email_to_hour: settings.email_to_hour,
        email_subject: settings.email_subject, email_body: settings.email_body, followup_enabled: settings.followup_enabled,
        followup_days: settings.followup_days, followup_body: settings.followup_body, email_skip_managed: settings.email_skip_managed,
      },
      window: { open: win.open, start: new Date(win.start), end: new Date(win.end) },
      inboxes, stats: { ...stats, waiting: await waitingCount(settings) },
      variables: VARIABLES, telegram_ready: telegramReady(),
    });
  } catch (e) { next(e); }
});

// ---------- Inboxes ----------
async function checkAndEncrypt(email, password) {
  const clean = String(password || "").replace(/\s+/g, "");
  if (clean.length < 8) throw Object.assign(new Error("Paste the 16-letter App Password from Google."), { status: 400 });
  let enc;
  try { enc = encrypt(clean); } catch (e) { throw Object.assign(e, { status: 400 }); }
  return enc;
}

router.post("/api/admin/email/inboxes", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const sender = String(req.body?.sender_name || "").trim().slice(0, 60);
    const limit = Math.round(Number(req.body?.daily_limit || 10));
    if (!EMAIL_RE.test(email)) return bad(res, "Enter the Gmail address.");
    if (!sender) return bad(res, "Enter the name creators will see (e.g. Sarah from Unbanned).");
    if (!(limit >= 1 && limit <= 100)) return bad(res, "Daily limit must be between 1 and 100.");
    if (await one("select 1 from email_inboxes where email = $1", [email])) return bad(res, "That inbox is already added.");
    const password_enc = await checkAndEncrypt(email, req.body?.app_password);
    try { await driver.verify({ email, sender_name: sender, password_enc }); }
    catch (e) { return bad(res, "Google didn't accept it: " + e.message); }
    const row = await one(`insert into email_inboxes (email, sender_name, password_enc, daily_limit) values ($1,$2,$3,$4) returning ${INBOX_COLS}`,
      [email, sender, password_enc, limit]);
    await activity("email", `Inbox added: ${email}`);
    res.json({ inbox: row });
  } catch (e) {
    if (e.status) return bad(res, e.message);
    next(e);
  }
});

router.patch("/api/admin/email/inboxes/:id", async (req, res, next) => {
  try {
    const inbox = await one("select * from email_inboxes where id = $1", [req.params.id]);
    if (!inbox) return res.status(404).json({ error: "Inbox not found." });
    const b = req.body || {};
    const sender = b.sender_name !== undefined ? String(b.sender_name).trim().slice(0, 60) : inbox.sender_name;
    const limit = b.daily_limit !== undefined ? Math.round(Number(b.daily_limit)) : inbox.daily_limit;
    if (!sender) return bad(res, "Sender name can't be empty.");
    if (!(limit >= 1 && limit <= 100)) return bad(res, "Daily limit must be between 1 and 100.");
    let password_enc = inbox.password_enc, status = inbox.status, last_error = inbox.last_error;
    if (b.app_password) {
      password_enc = await checkAndEncrypt(inbox.email, b.app_password);
      try { await driver.verify({ ...inbox, password_enc }); status = "ok"; last_error = null; }
      catch (e) { return bad(res, "Google didn't accept it: " + e.message); }
    }
    const row = await one(`update email_inboxes set sender_name=$1, daily_limit=$2, enabled=$3, password_enc=$4, status=$5, last_error=$6
                            where id = $7 returning ${INBOX_COLS}`,
      [sender, limit, b.enabled !== undefined ? !!b.enabled : inbox.enabled, password_enc, status, last_error, inbox.id]);
    res.json({ inbox: row });
  } catch (e) {
    if (e.status) return bad(res, e.message);
    next(e);
  }
});

// Re-check the connection. Clears the "problem" state when it works again.
router.post("/api/admin/email/inboxes/:id/test", async (req, res, next) => {
  try {
    const inbox = await one("select * from email_inboxes where id = $1", [req.params.id]);
    if (!inbox) return res.status(404).json({ error: "Inbox not found." });
    try { await driver.verify(inbox); }
    catch (e) {
      await query("update email_inboxes set status = 'error', last_error = $1 where id = $2", [e.message.slice(0, 500), inbox.id]);
      return bad(res, e instanceof MissingSecretKey ? e.message : "Still not working: " + e.message);
    }
    await query("update email_inboxes set status = 'ok', last_error = null where id = $1", [inbox.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete("/api/admin/email/inboxes/:id", async (req, res, next) => {
  try {
    const r = await one("delete from email_inboxes where id = $1 returning email", [req.params.id]);
    if (!r) return res.status(404).json({ error: "Inbox not found." });
    await activity("email", `Inbox removed: ${r.email}`);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Template + schedule ----------
router.patch("/api/admin/email/settings", async (req, res, next) => {
  try {
    const s = await one("select * from settings where id = 1");
    const b = req.body || {};
    const n = { ...s };
    for (const k of ["email_from_hour", "email_to_hour"]) {
      if (b[k] === undefined) continue;
      const v = Math.round(Number(b[k]));
      if (!(v >= 0 && v <= 23)) return bad(res, "Hours must be between 0 and 23.");
      n[k] = v;
    }
    if (b.followup_days !== undefined) {
      const v = Math.round(Number(b.followup_days));
      if (!(v >= 1 && v <= 30)) return bad(res, "Follow-up days must be between 1 and 30.");
      n.followup_days = v;
    }
    for (const k of ["email_subject", "email_body", "followup_body"]) {
      if (b[k] === undefined) continue;
      const v = String(b[k]).replace(/\r/g, "").trim();
      if (!v) return bad(res, "Subject and messages can't be empty.");
      if (v.length > (k === "email_subject" ? 150 : 3000)) return bad(res, "That text is too long.");
      n[k] = v;
    }
    for (const k of ["email_sending_enabled", "followup_enabled", "email_skip_managed"]) if (b[k] !== undefined) n[k] = !!b[k];
    if (n.email_sending_enabled && !s.email_sending_enabled) {
      const ok = await one("select count(*)::int as n from email_inboxes where enabled and status = 'ok'");
      if (!ok.n) return bad(res, "Add a working inbox before switching sending on.");
    }
    const saved = await one(`update settings set email_sending_enabled=$1, email_from_hour=$2, email_to_hour=$3, email_subject=$4, email_body=$5,
        followup_enabled=$6, followup_days=$7, followup_body=$8, email_skip_managed=$9, updated_at=now() where id = 1 returning *`,
      [n.email_sending_enabled, n.email_from_hour, n.email_to_hour, n.email_subject, n.email_body, n.followup_enabled, n.followup_days, n.followup_body, n.email_skip_managed]);
    if (saved.email_sending_enabled !== s.email_sending_enabled) {
      await activity("email", `Email sending switched ${saved.email_sending_enabled ? "on" : "off"}`);
      await notify(`[gmail] Sending switched ${saved.email_sending_enabled ? "on" : "off"}.`);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Preview the template for a real creator from the email list (or a sample).
router.post("/api/admin/email/preview", async (req, res, next) => {
  try {
    const b = req.body || {};
    const s = await one("select * from settings where id = 1");
    const creator = await nextNewLead(s);      // the next creator who would really be emailed
    const sample = creator || { id: null, handle: "sample_creator", display_name: "Ava Rose", niche: "fitness" };
    const ig = creator ? await one("select handle from platform_accounts where creator_id = $1 and platform = 'instagram' order by followers desc nulls last limit 1", [creator.id]) : { handle: "ava.rose" };
    const inbox = await one("select * from email_inboxes where enabled order by created_at limit 1");
    const vars = varsFor(sample, inbox || { sender_name: "Your name" }, ig?.handle);
    res.json({
      for: creator ? "@" + creator.handle : "a sample creator",
      subject: render(b.email_subject ?? s.email_subject, vars),
      body: render(b.email_body ?? s.email_body, vars),
      followup: render(b.followup_body ?? s.followup_body, vars),
    });
  } catch (e) { next(e); }
});

router.post("/api/admin/email/test-send", async (req, res, next) => {
  try {
    const to = String(req.body?.to || "").trim().toLowerCase();
    if (!EMAIL_RE.test(to)) return bad(res, "Enter the address to send the test to.");
    const inbox = await one("select * from email_inboxes where id = $1", [req.body?.inbox_id]);
    if (!inbox) return bad(res, "Choose an inbox to send from.");
    const s = await one("select * from settings where id = 1");
    const creator = await nextNewLead(s);      // the next creator who would really be emailed
    try { await sendTest(inbox, to, s, creator); }
    catch (e) { return bad(res, "Couldn't send: " + e.message); }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Conversations ----------
router.get("/api/admin/email/threads", async (req, res, next) => {
  try {
    const filter = req.query.filter === "all" ? "c.email_stage <> 'none'" : "c.email_stage in ('replied', 'opted_out')";
    const rows = (await query(`
      select c.id, c.handle, c.display_name, c.profile_image, c.email_stage, c.email_to, c.emailed_at, c.replied_at, c.status,
             i.email as inbox_email,
             (select m.body from email_messages m where m.creator_id = c.id order by m.sent_at desc limit 1) as last_body,
             (select m.direction from email_messages m where m.creator_id = c.id order by m.sent_at desc limit 1) as last_direction,
             (select max(m.sent_at) from email_messages m where m.creator_id = c.id) as last_at
        from creators c left join email_inboxes i on i.id = c.email_inbox_id
       where ${filter}
       order by last_at desc nulls last limit 200`)).rows;
    res.json({ threads: rows.map((r) => ({ ...r, last_body: String(r.last_body || "").slice(0, 160) })) });
  } catch (e) { next(e); }
});

router.get("/api/admin/email/threads/:id", async (req, res, next) => {
  try {
    const c = await one(`select c.id, c.handle, c.display_name, c.x_followers, c.email_stage, c.email_to, c.status, i.email as inbox_email
                           from creators c left join email_inboxes i on i.id = c.email_inbox_id where c.id = $1`, [req.params.id]);
    if (!c) return res.status(404).json({ error: "Not found." });
    const messages = (await query(`select direction, kind, from_addr, to_addr, subject, body, sent_at from email_messages
                                    where creator_id = $1 order by sent_at`, [c.id])).rows;
    res.json({ creator: c, messages });
  } catch (e) { next(e); }
});

router.post("/api/admin/email/threads/:id/reply", async (req, res, next) => {
  try {
    const text = String(req.body?.text || "").replace(/\r/g, "").trim();
    if (!text) return bad(res, "Write a message first.");
    if (text.length > 5000) return bad(res, "That message is too long.");
    try { await replyToCreator(req.params.id, text); }
    catch (e) { return bad(res, e.message); }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- Telegram ----------
router.post("/api/admin/telegram/test", async (_req, res, next) => {
  try {
    const r = await notify("[creatorsfinder] Test message: your channel is connected. Updates will appear here.");
    if (!r.ok) return bad(res, r.error);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
