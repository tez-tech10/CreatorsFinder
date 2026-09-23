// Link check: follows bio links, reads link-in-bio pages, and extracts platform links + contact details.
import { HostLimiter } from "./util.js";

const limiter = new HostLimiter(2, 400);

const LINK_PAGES = /(^|\.)(linktr\.ee|link\.me|beacons\.ai|allmylinks\.com|solo\.to|bio\.link|lnk\.bio|hoo\.be|campsite\.bio|carrd\.co|snipfeed\.co|msha\.ke|taplink\.cc|linkin\.bio|getallmylinks\.com|linkbio\.co|fanlink\.to|linkfly\.to|biolinky\.co|flow\.page|koji\.to|withkoji\.com|stan\.store|linkpop\.com|direct\.me|lit\.link|tap\.bio|lynx\.bio|contact\.me|about\.me|allmy\.bio|justfor\.fans\/links)$/i;

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_BYTES = 1_500_000;

// Emails that belong to the link-page service itself, image files, etc.
const EMAIL_JUNK = /(\.(png|jpe?g|gif|webp|svg|css|js)$)|(@(sentry|wixpress|example|domain|email|linktr\.ee|linktree\.com|beacons\.ai|link\.me|allmylinks\.com|carrd\.co|onlyfans\.com|fansly\.com|x\.com|twitter\.com)\b)|^(noreply|no-reply|support|help|privacy|abuse|legal|press|dmca)@/i;

async function fetchText(url) {
  return limiter.run(url, async () => {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.8" },
      signal: AbortSignal.timeout(10_000),
    });
    const finalUrl = res.url || url;
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !/text|html|json/i.test(type)) return { finalUrl, html: "" };
    const reader = res.body.getReader();
    let size = 0; const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length; chunks.push(value);
      if (size > MAX_BYTES) { try { await reader.cancel(); } catch {} break; }
    }
    return { finalUrl, html: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8") };
  });
}

function unescapeHtml(s) {
  return s
    .replace(/\\u002[fF]/g, "/").replace(/\\u0040/g, "@").replace(/\\\//g, "/")
    .replace(/&#x2[fF];/g, "/").replace(/&#47;/g, "/").replace(/&#64;|&#x40;/g, "@")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function host(u) { try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }

// Pulls everything useful out of a blob of text/HTML.
export function extractFrom(text, out) {
  const s = unescapeHtml(text || "");

  const urls = s.match(/https?:\/\/[^\s"'<>\\)\]]+/gi) || [];
  const bare = s.match(/\b(?:www\.)?(?:onlyfans\.com|fansly\.com|fanvue\.com|instagram\.com|tiktok\.com|t\.me|wa\.me)\/[^\s"'<>\\)\]]+/gi) || [];
  for (let u of [...urls, ...bare.map((b) => "https://" + b)]) {
    u = u.replace(/[.,;:!?]+$/, "");
    const h = host(u);
    let path = "";
    try { path = new URL(u).pathname; } catch { continue; }
    const first = path.split("/").filter(Boolean)[0] || "";

    if (h.endsWith("onlyfans.com") && first && !/^(action|my|login|signup|terms|privacy|help|files)$/i.test(first)) out.onlyfans.add(`https://onlyfans.com/${first.toLowerCase()}`);
    else if (h.endsWith("fansly.com") && first) out.fansly.add(`https://fansly.com/${first}`);
    else if (h.endsWith("fanvue.com") && first) out.fanvue.add(`https://www.fanvue.com/${first}`);
    else if (h.endsWith("instagram.com") && first && !/^(p|reel|reels|explore|stories|accounts|about|legal|developer)$/i.test(first)) out.instagram.add(first.toLowerCase());
    else if (h.endsWith("tiktok.com") && first.startsWith("@")) out.tiktok.add(first.slice(1).toLowerCase());
    else if ((h === "t.me" || h === "telegram.me") && first && !/^(share|iv|addstickers|proxy|socks)$/i.test(first)) out.telegram.add(first.startsWith("+") ? `https://t.me/${first}` : first.toLowerCase());
    else if (h === "wa.me" && /^\d{7,15}$/.test(first)) out.whatsapp.add("+" + first);
    else if (h === "api.whatsapp.com") { try { const p = new URL(u).searchParams.get("phone"); if (p && /^\d{7,15}$/.test(p)) out.whatsapp.add("+" + p); } catch {} }
    else if (LINK_PAGES.test(h)) out.linkPages.add(u);
  }

  for (const m of s.matchAll(/mailto:([^"'?\s<>]+)/gi)) out.emails.add(decodeURIComponent(m[1]).toLowerCase());
  for (const m of s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/gi) || []) out.emails.add(m.toLowerCase());
  for (const m of s.matchAll(/tel:(\+?[\d\s().-]{7,20})/gi)) { const d = m[1].replace(/[^\d+]/g, ""); if (d.replace(/\D/g, "").length >= 7) out.phones.add(d.startsWith("+") ? d : "+" + d); }
}

function emptyResult() {
  return { onlyfans: new Set(), fansly: new Set(), fanvue: new Set(), instagram: new Set(), tiktok: new Set(),
    telegram: new Set(), whatsapp: new Set(), emails: new Set(), phones: new Set(), linkPages: new Set(),
    resolvedLink: null, sources: {} };
}

// Main entry: bio text + bio links → everything found.
export async function checkLinks(bio, links) {
  const out = emptyResult();
  extractFrom(bio, out);
  // Phone numbers written in the bio itself (e.g. "+1 555 123 4567")
  for (const m of (bio || "").match(/\+\d[\d\s().-]{7,18}\d/g) || []) out.phones.add("+" + m.replace(/\D/g, ""));

  const toVisit = new Set();
  for (const l of links || []) {
    const h = host(l);
    if (!h || /(^|\.)(x\.com|twitter\.com)$/.test(h)) continue;
    extractFrom(l, out);
    toVisit.add(l);
  }

  // Visit bio links (resolves shorteners), then any link-in-bio pages found on them.
  const visited = new Set();
  for (const round of [0, 1]) {
    const batch = round === 0 ? [...toVisit] : [...out.linkPages].filter((u) => !visited.has(u));
    for (const u of batch.slice(0, 4)) {
      if (visited.has(u)) continue;
      visited.add(u);
      try {
        const { finalUrl, html } = await fetchText(u);
        visited.add(finalUrl);
        if (!out.resolvedLink) out.resolvedLink = finalUrl;
        const before = out.emails.size;
        extractFrom(finalUrl, out);
        if (html) extractFrom(html, out);
        if (out.emails.size > before) out.sources.email = host(finalUrl);
      } catch { /* unreachable page: skip */ }
    }
  }

  // Clean up emails
  for (const e of [...out.emails]) if (EMAIL_JUNK.test(e) || e.length > 80) out.emails.delete(e);
  if (!out.sources.email && out.emails.size) out.sources.email = "bio";
  return out;
}
