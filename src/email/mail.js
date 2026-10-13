// Talks to Gmail: sending (SMTP) and reading new mail (IMAP), using the inbox's App Password.
import crypto from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { config } from "../config.js";
import { decrypt } from "../lib/secret.js";

export class AuthError extends Error {}        // wrong App Password / IMAP off → inbox marked as a problem
export class RecipientError extends Error {}   // the address doesn't exist → email marked invalid

function smtp(inbox) {
  return nodemailer.createTransport({
    host: config.smtpHost, port: config.smtpPort, secure: config.mailTls,
    auth: { user: inbox.email, pass: decrypt(inbox.password_enc) },
    connectionTimeout: 20_000, greetingTimeout: 20_000, socketTimeout: 60_000,
    tls: config.mailTls ? undefined : { rejectUnauthorized: false },
    ignoreTLS: !config.mailTls,
  });
}

function imap(inbox) {
  return new ImapFlow({
    host: config.imapHost, port: config.imapPort, secure: config.mailTls,
    auth: { user: inbox.email, pass: decrypt(inbox.password_enc) },
    logger: false, emitLogs: false, socketTimeout: 60_000,
  });
}

export function newMessageId(fromEmail) {
  const domain = String(fromEmail).split("@")[1] || "mail.local";
  return `<cf.${crypto.randomUUID()}@${domain}>`;
}

function classify(e) {
  const msg = String(e?.response || e?.message || e);
  if (e?.authenticationFailed || e?.code === "EAUTH" || /auth|credentials|password|534|535|AUTHENTICATIONFAILED/i.test(msg)) return new AuthError(msg.slice(0, 300));
  if (e?.code === "EENVELOPE" || /^5\.1\.\d|550|553|recipient|no such user|does not exist/i.test(msg)) return new RecipientError(msg.slice(0, 300));
  return new Error(msg.slice(0, 300));
}

const real = {
  // msg: { to, subject, text, messageId, inReplyTo?, references? }
  async send(inbox, msg) {
    const t = smtp(inbox);
    try {
      await t.sendMail({
        from: { name: inbox.sender_name, address: inbox.email },
        to: msg.to, subject: msg.subject, text: msg.text,
        messageId: msg.messageId, inReplyTo: msg.inReplyTo, references: msg.references,
      });
    } catch (e) { throw classify(e); }
    finally { t.close(); }
  },

  // Checks both sending and reading work with this App Password.
  async verify(inbox) {
    const t = smtp(inbox);
    try { await t.verify(); } catch (e) { throw classify(e); } finally { t.close(); }
    const c = imap(inbox);
    try { await c.connect(); await c.logout(); }
    catch (e) { throw new AuthError("Sending works but reading replies doesn't. Turn on IMAP in Gmail settings. (" + String(e.message).slice(0, 120) + ")"); }
  },

  // New messages in the inbox after lastUid. First run (lastUid 0) only records where we are.
  async fetchNew(inbox) {
    const c = imap(inbox);
    try { await c.connect(); } catch (e) { throw classify(e); }
    const out = { uidValidity: null, lastUid: Number(inbox.last_uid) || 0, messages: [] };
    try {
      const lock = await c.getMailboxLock("INBOX");
      try {
        out.uidValidity = String(c.mailbox.uidValidity);
        const top = Number(c.mailbox.uidNext) - 1;
        const reset = inbox.uid_validity && inbox.uid_validity !== out.uidValidity;
        if (!out.lastUid || reset) { out.lastUid = Math.max(0, top); return out; }
        if (top <= out.lastUid) return out;
        for await (const m of c.fetch(`${out.lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (m.uid <= out.lastUid) continue;
          out.messages.push({ uid: m.uid, source: m.source });
        }
        out.messages.sort((a, b) => a.uid - b.uid);
        if (out.messages.length) out.lastUid = out.messages[out.messages.length - 1].uid;
      } finally { lock.release(); }
    } finally { await c.logout().catch(() => {}); }
    return out;
  },
};

// Tests swap this for a fake.
export const driver = { ...real };
export function setDriver(d) { Object.assign(driver, d); }
export function resetDriver() { Object.assign(driver, real); }
