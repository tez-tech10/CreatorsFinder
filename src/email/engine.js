// Email outreach: sends first emails + one follow-up from your Gmail inboxes, reads replies,
// handles bounces and opt-outs, and posts updates to Telegram.
import { simpleParser } from "mailparser";
import { query, one, activity } from "../lib/db.js";
import { notify, notifyOnce } from "../lib/telegram.js";
import { driver, newMessageId, AuthError, RecipientError } from "./mail.js";
import { render, varsFor, cleanReply, isOptOut, shortNumber, firstName } from "./template.js";

const log = (...a) => console.log(new Date().toISOString(), "[email]", ...a);
const RIYADH_MS = 3 * 3600_000;            // Riyadh is UTC+3 all year (no daylight saving)

// ---------- Sending window (Riyadh time) ----------
// The most recent window start (today or yesterday at email_from_hour) and whether it's still open.
export function windowBounds(settings, now = Date.now()) {
  const from = settings.email_from_hour, to = settings.email_to_hour;
  const minutes = (((to - from + 24) % 24) || 24) * 60;
  const local = new Date(now + RIYADH_MS);
  let startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), from);
  if (local.getUTCHours() < from) startLocal -= 86_400_000;
  const start = startLocal - RIYADH_MS;
  const end = start + minutes * 60_000;
  return { start, end, open: now < end, minutes, key: new Date(startLocal).toISOString().slice(0, 10) };
}

// ---------- Small queries ----------
export async function enabledInboxes() {
  return (await query("select * from email_inboxes where enabled order by created_at")).rows;
}

async function sentSince(inboxId, since) {
  const r = await one(`select count(*)::int as n, max(sent_at) as last from email_messages
                        where inbox_id = $1 and direction = 'out' and kind in ('first', 'followup') and sent_at >= $2`, [inboxId, new Date(since)]);
  return { n: r.n, last: r.last ? new Date(r.last).getTime() : 0 };
}

async function topInstagram(creatorId) {
  return one(`select handle, followers from platform_accounts where creator_id = $1 and platform = 'instagram'
               order by followers desc nulls last limit 1`, [creatorId]);
}

async function markInboxProblem(inbox, message) {
  await query("update email_inboxes set status = 'error', last_error = $1 where id = $2", [message.slice(0, 500), inbox.id]);
  await activity("email", `Inbox ${inbox.email} has a problem: ${message.slice(0, 200)}`);
  await notifyOnce(`inbox:${inbox.id}:${new Date().toISOString().slice(0, 10)}`,
    `[gmail] Problem with ${inbox.email}: ${message.slice(0, 200)}\nSending and reading from this inbox are paused. Fix it on the Email page, then press Test.`);
}

// ---------- Picking who to email next ----------
const NOT_BLOCKED = `
  not exists (select 1 from exclusions e where e.x_user_id = c.x_user_id)
  and not exists (select 1 from suppression_list s where s.x_user_id = c.x_user_id)`;

export async function nextFollowUp(inbox, settings) {
  if (!settings.followup_enabled) return null;
  return one(`
    select c.* from creators c
     where c.email_inbox_id = $1 and c.email_stage = 'sent' and c.status in ('new', 'contacted')
       and c.emailed_at < now() - make_interval(days => $2)
       and not exists (select 1 from suppression_list s where lower(s.email) = lower(c.email_to))
       and ${NOT_BLOCKED}
     order by c.emailed_at limit 1`, [inbox.id, settings.followup_days]);
}

export async function nextNewLead(settings) {
  return one(`
    select c.*, em.value as pick_email from creators c
      cross join lateral (
        select k.value from contacts k
         where k.creator_id = c.id and k.type = 'email' and k.email_status <> 'invalid'
           and not exists (select 1 from suppression_list s where lower(s.email) = lower(k.value))
           and not exists (select 1 from email_messages m where m.direction = 'out' and lower(m.to_addr) = lower(k.value) and m.kind <> 'test')
         order by k.found_at limit 1) em
     where c.email_list = 'eligible' and c.email_stage = 'none' and c.status = 'new' and c.delivered_at is null
       and ($1::boolean is false or c.possibly_managed is false)
       and ${NOT_BLOCKED}
     order by c.created_at limit 1`, [!!settings.email_skip_managed]);
}

export async function waitingCount(settings) {
  return (await one(`
    select count(*)::int as n from creators c
     where c.email_list = 'eligible' and c.email_stage = 'none' and c.status = 'new' and c.delivered_at is null
       and ($1::boolean is false or c.possibly_managed is false) and ${NOT_BLOCKED}`, [!!settings.email_skip_managed])).n;
}

// ---------- Sending ----------
async function record(fields) {
  const keys = Object.keys(fields);
  await query(`insert into email_messages (${keys.join(",")}) values (${keys.map((_, i) => "$" + (i + 1)).join(",")})`, keys.map((k) => fields[k]));
}

// kind: 'first' | 'followup'. Returns 'sent' | 'bounced'. Throws AuthError for inbox problems.
export async function sendOutreach(inbox, creator, kind, settings) {
  const ig = await topInstagram(creator.id);
  const vars = varsFor(creator, inbox, ig?.handle);
  const to = kind === "first" ? creator.pick_email : creator.email_to;
  const subject = kind === "first" ? render(settings.email_subject, vars) || "Quick question" : "Re: " + creator.email_subject;
  const text = render(kind === "first" ? settings.email_body : settings.followup_body, vars);
  const messageId = newMessageId(inbox.email);
  const threading = kind === "followup" ? { inReplyTo: creator.email_thread_id, references: creator.email_thread_id } : {};

  try {
    await driver.send(inbox, { to, subject, text, messageId, ...threading });
  } catch (e) {
    if (!(e instanceof RecipientError)) throw e;
    await query("update contacts set email_status = 'invalid' where creator_id = $1 and type = 'email' and lower(value) = lower($2)", [creator.id, to]);
    await query("update creators set email_stage = 'bounced', updated_at = now() where id = $1 and email_stage in ('none', 'sent')", [creator.id]);
    await activity("email", `Address rejected for @${creator.handle}: ${to}`);
    await notify(`[gmail] Bounced: @${creator.handle} (${to})\nThe address doesn't exist. She stays on the X list.`);
    return "bounced";
  }

  await record({ creator_id: creator.id, inbox_id: inbox.id, direction: "out", kind, message_id: messageId,
    in_reply_to: threading.inReplyTo || null, from_addr: inbox.email, to_addr: to, subject, body: text });
  if (kind === "first") {
    await query(`update creators set email_stage = 'sent', email_to = $1, email_inbox_id = $2, email_thread_id = $3, email_subject = $4,
                   emailed_at = now(), status = case when status = 'new' then 'contacted' else status end, updated_at = now()
                 where id = $5`, [to, inbox.id, messageId, subject, creator.id]);
  } else {
    await query("update creators set email_stage = 'followed_up', followed_up_at = now(), updated_at = now() where id = $1", [creator.id]);
  }
  log(`${kind} → @${creator.handle} <${to}> from ${inbox.email}`);
  return "sent";
}

// Spreads each inbox's emails evenly over the window, with some randomness so it looks human.
const nextAt = new Map();
export function _clearSchedule() { nextAt.clear(); }   // tests only
function scheduleNext(inbox, win, fromTs) {
  const gap = Math.max(3 * 60_000, (win.minutes * 60_000) / inbox.daily_limit);
  nextAt.set(inbox.id, fromTs + gap * (0.7 + Math.random() * 0.6));
}

// One pass: each inbox sends at most one email if it's due. Returns a short status.
export async function sendTick(settings, now = Date.now()) {
  if (!settings.email_sending_enabled) return "off";
  const win = windowBounds(settings, now);
  const inboxes = await enabledInboxes();
  const healthy = inboxes.filter((i) => i.status === "ok");
  if (!healthy.length) return "no_inboxes";

  let total = 0, cap = 0, full = 0, noLeads = false;
  for (const inbox of healthy) {
    const s = await sentSince(inbox.id, win.start);
    total += s.n; cap += inbox.daily_limit;
    if (s.n >= inbox.daily_limit) { full++; continue; }
    if (!win.open) continue;
    if (!nextAt.has(inbox.id)) {
      if (s.last) scheduleNext(inbox, win, s.last); else nextAt.set(inbox.id, now);
    }
    if (now < nextAt.get(inbox.id)) continue;

    let creator = await nextFollowUp(inbox, settings), kind = "followup";
    if (!creator) { creator = await nextNewLead(settings); kind = "first"; }
    if (!creator) { noLeads = true; continue; }
    try {
      const r = await sendOutreach(inbox, creator, kind, settings);
      scheduleNext(inbox, win, now);
      if (r === "sent") { total++; if (s.n + 1 >= inbox.daily_limit) full++; }
    } catch (e) {
      if (e instanceof AuthError) { await markInboxProblem(inbox, e.message); continue; }
      log(`send failed from ${inbox.email}:`, e.message);
      nextAt.set(inbox.id, now + 5 * 60_000);
    }
  }

  if (full === healthy.length && cap) {
    await notifyOnce(`done:${win.key}`, `[gmail] Done for today: ${total}/${cap} emails sent.`);
    return "done";
  }
  if (!win.open) {
    if (total || cap) await notifyOnce(`done:${win.key}`, `[gmail] Done for today: ${total}/${cap} emails sent.` +
      (total < cap ? `\nStopped early: ${noLeads || !(await waitingCount(settings)) ? "no more creators waiting on the email list." : "the sending window ended."}` : ""));
    return "closed";
  }
  if (noLeads) {
    await notifyOnce(`noleads:${win.key}`, `[gmail] No creators left on the email list to contact (${total}/${cap} sent so far today). The crawler adds more as it finds them.`);
    return "no_leads";
  }
  return "sending";
}

// ---------- Reading replies ----------
function ids(v) {
  if (!v) return [];
  const list = Array.isArray(v) ? v : String(v).split(/\s+/);
  return list.map((x) => String(x).trim()).filter((x) => x.startsWith("<"));
}

function replyNotice(creator, ig, said, subject, firstSentAt, inboxEmail, optedOut) {
  const lines = [`NEW REPLY: ${creator.first || creator.display_name || "@" + creator.handle}${optedOut ? " (opted out)" : ""}`];
  if (ig?.handle) {
    lines.push(`IG: @${ig.handle}${ig.followers ? ` (${shortNumber(ig.followers)} followers)` : ""}`, `https://instagram.com/${ig.handle}`);
  }
  lines.push(`X: @${creator.handle}${creator.x_followers ? ` (${shortNumber(creator.x_followers)} followers)` : ""}`);
  if (!ig?.handle) lines.push(`https://x.com/${creator.handle}`);
  const quote = said.replace(/\s+/g, " ").trim();
  lines.push(`She said: "${quote.length > 300 ? quote.slice(0, 297) + "…" : quote}"`);
  const subj = /^re:/i.test(subject || "") ? subject : "Re: " + (subject || "");
  lines.push(`Thread: ${subj}${firstSentAt ? ` (we emailed ${new Date(firstSentAt).toISOString().slice(0, 10)})` : ""}`);
  lines.push(`Answer from: ${inboxEmail}`);
  return lines.join("\n");
}

async function handleBounce(inbox, mail) {
  const failed = String(mail.headers.get("x-failed-recipients") || "").toLowerCase();
  const refs = [...ids(mail.inReplyTo), ...ids(mail.references)];
  let creator = refs.length ? await one(`select c.* from email_messages m join creators c on c.id = m.creator_id
                                          where m.message_id = any($1) limit 1`, [refs]) : null;
  if (!creator && failed) creator = await one("select * from creators where lower(email_to) = $1 limit 1", [failed.split(",")[0].trim()]);
  if (!creator) {
    const text = String(mail.text || "").toLowerCase();
    const r = await query("select * from creators where email_inbox_id = $1 and email_to is not null and email_stage in ('sent','followed_up')", [inbox.id]);
    creator = r.rows.find((c) => text.includes(String(c.email_to).toLowerCase())) || null;
  }
  if (!creator) return;
  await query("update contacts set email_status = 'invalid' where creator_id = $1 and type = 'email' and lower(value) = lower($2)", [creator.id, creator.email_to]);
  await query("update creators set email_stage = 'bounced', updated_at = now() where id = $1 and email_stage <> 'replied'", [creator.id]);
  await record({ creator_id: creator.id, inbox_id: inbox.id, direction: "in", kind: "bounce", message_id: mail.messageId || null,
    from_addr: mail.from?.value?.[0]?.address || null, to_addr: inbox.email, subject: mail.subject || null, body: String(mail.text || "").slice(0, 2000) });
  await activity("email", `Bounce for @${creator.handle} (${creator.email_to})`);
  await notify(`[gmail] Bounced: @${creator.handle} (${creator.email_to})\nThe email couldn't be delivered. She stays on the X list.`);
}

export async function processIncoming(inbox, source) {
  const mail = await simpleParser(source);
  const from = (mail.from?.value?.[0]?.address || "").toLowerCase();
  if (!from || from === inbox.email.toLowerCase()) return "skip";
  if (mail.messageId && await one("select 1 from email_messages where message_id = $1", [mail.messageId])) return "duplicate";

  if (/mailer-daemon|postmaster/i.test(from) || /delivery status notification|undeliverable|mail delivery (failed|subsystem)|returned mail|failure notice/i.test(mail.subject || "")) {
    await handleBounce(inbox, mail);
    return "bounce";
  }

  const refs = [...ids(mail.inReplyTo), ...ids(mail.references)];
  let creator = refs.length ? await one(`select c.* from email_messages m join creators c on c.id = m.creator_id
                                          where m.message_id = any($1) and m.direction = 'out' limit 1`, [refs]) : null;
  if (!creator) creator = await one(`select * from creators where lower(email_to) = $1
                                      and email_stage in ('sent', 'followed_up', 'replied', 'opted_out') limit 1`, [from]);
  if (!creator) return "unrelated";

  const said = cleanReply(mail.text || "") || String(mail.text || "").trim().slice(0, 500);
  const optedOut = isOptOut(said);
  await record({ creator_id: creator.id, inbox_id: inbox.id, direction: "in", kind: "reply", message_id: mail.messageId || null,
    in_reply_to: ids(mail.inReplyTo)[0] || null, from_addr: from, to_addr: inbox.email, subject: mail.subject || null,
    body: String(mail.text || "").slice(0, 20_000) });

  if (optedOut) {
    await query("insert into suppression_list (email, x_user_id, reason) values ($1, $2, 'email_opt_out') on conflict do nothing", [from, creator.x_user_id]);
    await query("insert into suppression_list (email, reason) values ($1, 'email_opt_out') on conflict do nothing", [from]);
    await query("update creators set email_stage = 'opted_out', status = 'declined', replied_at = now(), updated_at = now() where id = $1", [creator.id]);
  } else {
    await query(`update creators set email_stage = 'replied', replied_at = now(),
                   status = case when status in ('new', 'contacted') then 'replied' else status end, updated_at = now()
                 where id = $1`, [creator.id]);
  }
  await activity("email", `${optedOut ? "Opt-out" : "Reply"} from @${creator.handle}`);

  const ig = await topInstagram(creator.id);
  const first = await one("select sent_at from email_messages where creator_id = $1 and kind = 'first' order by sent_at limit 1", [creator.id]);
  creator.first = firstName(creator.display_name, creator.handle);
  await notify(replyNotice(creator, ig, said, mail.subject || creator.email_subject, first?.sent_at, inbox.email, optedOut));
  return optedOut ? "opt_out" : "reply";
}

export async function readInbox(inbox) {
  let res;
  try { res = await driver.fetchNew(inbox); }
  catch (e) {
    if (e instanceof AuthError) { await markInboxProblem(inbox, e.message); return { error: e.message }; }
    log(`reading ${inbox.email} failed:`, e.message);
    return { error: e.message };
  }
  const counts = {};
  for (const m of res.messages) {
    try { const r = await processIncoming(inbox, m.source); counts[r] = (counts[r] || 0) + 1; }
    catch (e) { log(`message ${m.uid} in ${inbox.email} failed:`, e.message); }
  }
  await query("update email_inboxes set last_uid = $1, uid_validity = $2, last_checked_at = now() where id = $3",
    [res.lastUid, res.uidValidity, inbox.id]);
  return counts;
}

export async function readTick() {
  const out = {};
  for (const inbox of await enabledInboxes()) {
    if (inbox.status !== "ok") continue;
    out[inbox.email] = await readInbox(inbox);
  }
  return out;
}

// ---------- Manual reply from the admin Email page ----------
export async function replyToCreator(creatorId, text) {
  const c = await one("select * from creators where id = $1", [creatorId]);
  if (!c || !c.email_inbox_id || !c.email_to) throw Object.assign(new Error("We haven't emailed her yet."), { status: 400 });
  const inbox = await one("select * from email_inboxes where id = $1", [c.email_inbox_id]);
  if (!inbox) throw Object.assign(new Error("The inbox that emailed her was removed."), { status: 400 });
  const lastIn = await one("select message_id from email_messages where creator_id = $1 and direction = 'in' and kind = 'reply' and message_id is not null order by sent_at desc limit 1", [c.id]);
  const refs = [c.email_thread_id, lastIn?.message_id].filter(Boolean);
  const messageId = newMessageId(inbox.email);
  const subject = "Re: " + String(c.email_subject || "").replace(/^re:\s*/i, "");
  await driver.send(inbox, { to: c.email_to, subject, text, messageId, inReplyTo: refs[refs.length - 1], references: refs.join(" ") });
  await record({ creator_id: c.id, inbox_id: inbox.id, direction: "out", kind: "manual", message_id: messageId,
    in_reply_to: refs[refs.length - 1] || null, from_addr: inbox.email, to_addr: c.email_to, subject, body: text });
  await activity("email", `You replied to @${c.handle}`);
}

// ---------- Test email to yourself ----------
export async function sendTest(inbox, to, settings, creator) {
  const sample = creator || { id: null, handle: "sample_creator", display_name: "Ava Rose", niche: "fitness" };
  const ig = creator ? await topInstagram(creator.id) : { handle: "ava.rose" };
  const vars = varsFor(sample, inbox, ig?.handle);
  const subject = "[TEST] " + render(settings.email_subject, vars);
  const text = render(settings.email_body, vars);
  const messageId = newMessageId(inbox.email);
  await driver.send(inbox, { to, subject, text, messageId });
  await record({ creator_id: null, inbox_id: inbox.id, direction: "out", kind: "test", message_id: messageId,
    from_addr: inbox.email, to_addr: to, subject, body: text });
  return { subject, text };
}
