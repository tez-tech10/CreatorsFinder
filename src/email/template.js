// Email templates and reply text helpers. Pure functions (no database).

// "Ava Rose 🌹✨" → "Ava", "SAMMY xo" → "Sammy", "🔥🔥" → "" (template then uses "there")
export function firstName(displayName, handle) {
  const clean = (s) => String(s || "").normalize("NFKC").replace(/[^\p{L}\s'-]/gu, " ").trim();
  let w = clean(displayName).split(/\s+/).find((x) => /\p{L}{2,}/u.test(x)) || "";
  if (!w) w = (clean(String(handle || "").replace(/[_\d.]+/g, " ")).split(/\s+/)[0] || "");
  if (w.length > 14 || w.length < 2) return "";
  return w[0].toUpperCase() + w.slice(1).toLowerCase();
}

export const VARIABLES = ["first_name", "name", "x_handle", "niche", "instagram", "sender_name"];

// {{first_name}} etc. Unknown variables become empty; empty first_name becomes "there".
export function render(text, v) {
  const vals = {
    first_name: v.first_name || "there",
    name: v.name || v.first_name || "there",
    x_handle: v.x_handle ? "@" + v.x_handle : "",
    niche: v.niche || "",
    instagram: v.instagram ? "@" + v.instagram : "",
    sender_name: v.sender_name || "",
  };
  return String(text || "")
    .replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k) => vals[k.toLowerCase()] ?? "")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function varsFor(creator, inbox, instagram) {
  return {
    first_name: firstName(creator.display_name, creator.handle),
    name: creator.display_name,
    x_handle: creator.handle,
    niche: creator.niche,
    instagram,
    sender_name: inbox?.sender_name,
  };
}

// Keeps only what she wrote: drops the quoted earlier emails and signatures from phones.
export function cleanReply(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*>/.test(l)) break;
    // Gmail/Apple quote header, sometimes wrapped onto two lines
    if (/^\s*On\s.{3,}/i.test(l) && (/wrote:\s*$/i.test(l) || /wrote:\s*$/i.test(lines[i + 1] || ""))) break;
    if (/^-{2,}\s*Original Message|^_{5,}|^From: .+@/i.test(l.trim())) break;
    if (/^Sent from my (iPhone|Android|Samsung|phone)/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// "no", "stop", "unsubscribe", "not interested", "remove me" at the start of a reply = opt-out
export function isOptOut(text) {
  const t = String(text || "").trim().toLowerCase().replace(/[^a-z\s']/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  return /^(no|nope|stop|unsubscribe|remove me|not interested|no thanks|no thank you|please stop|dont email me|don't email me)\b/.test(t) && t.split(" ").length <= 12;
}

export function shortNumber(n) {
  n = Number(n);
  if (!Number.isFinite(n)) return "";
  if (n >= 1_000_000) return (Math.round(n / 100_000) / 10) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}
