// Posts updates to your Telegram channel. Never throws: a Telegram problem must not stop the crawler or emails.
import { config } from "../config.js";
import { query } from "./db.js";

export const telegramReady = () => !!(config.telegramToken && config.telegramChatId);

export async function notify(text) {
  if (!telegramReady()) return { ok: false, error: "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in Railway." };
  try {
    const res = await fetch(`${config.telegramBase}/bot${config.telegramToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChatId, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) {
      const error = j.description || `HTTP ${res.status}`;
      console.log("[telegram] failed:", error);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (e) {
    console.log("[telegram] failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// Sends a message only once per key (e.g. "budget:2026-10-13"), even across restarts.
export async function notifyOnce(key, text) {
  try {
    const r = await query("insert into app_state (key, value) values ($1, 'true') on conflict (key) do nothing returning key", ["tg:" + key]);
    if (!r.rowCount) return { ok: true, skipped: true };
  } catch { /* table missing or DB hiccup: send anyway */ }
  return notify(text);
}
