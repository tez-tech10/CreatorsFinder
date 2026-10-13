// Run with: npm test   (needs no API keys)
process.env.DATABASE_URL ||= "postgres://localhost/none"; process.env.SITE_URL ||= "http://localhost";
process.env.TWITTERAPI_KEY ||= "test";
process.env.OPENROUTER_API_KEY ||= "test";

import { test } from "node:test";
import assert from "node:assert/strict";
const { detectLanguage } = await import("../src/crawler/language.js");
const { ageRedFlag } = await import("../src/crawler/safety.js");
const { extractFrom } = await import("../src/crawler/links.js");
const { parseResults, decide } = await import("../src/crawler/llm.js");
const { normalizeUser } = await import("../src/crawler/twitter.js");

const empty = () => ({ onlyfans: new Set(), fansly: new Set(), fanvue: new Set(), instagram: new Set(), tiktok: new Set(), telegram: new Set(), whatsapp: new Set(), emails: new Set(), phones: new Set(), linkPages: new Set(), sources: {} });

test("language", () => {
  assert.equal(detectLanguage("Fitness girl 💪 daily workouts, exclusive content in my link below"), "english");
  assert.equal(detectLanguage("Hola! Soy de Madrid, contenido exclusivo para ti y mucho más con amor"), "other");
  assert.equal(detectLanguage("Olá, eu sou do Brasil e não para de treinar com você"), "other");
  assert.equal(detectLanguage("Привет, я модель из Москвы"), "other");
  assert.equal(detectLanguage("🔥🔥🔥 ⬇️"), "unclear");
  assert.equal(detectLanguage(""), "unclear");
});

test("age safety", () => {
  assert.ok(ageRedFlag("I'm 17 lol"));
  assert.ok(ageRedFlag("16 yo cosplayer"));
  assert.ok(ageRedFlag("high school senior"));
  assert.ok(ageRedFlag("class of 2027"));
  assert.ok(ageRedFlag("", "minor, don't dm"));
  assert.equal(ageRedFlag("18+ only. 24 yo fitness model"), null);
  assert.equal(ageRedFlag("Love my 19 cats"), null);
});

test("link extraction", () => {
  const o = empty();
  extractFrom(`<a href="https://onlyfans.com/avarose?ref=x">OF</a> <a href="https://www.instagram.com/ava.rose/">IG</a>
    <a href="https://t.me/avachannel">tg</a> <a href="https://wa.me/15551234567">wa</a> mailto:ava.business@gmail.com
    "url":"https:\\u002F\\u002Ffansly.com\\u002FAvaRose" contact: ava@avarose.co  logo@2x.png
    https://instagram.com/p/abc123 https://onlyfans.com/action/login https://tiktok.com/@avarosee tel:+1 (555) 222-3344`, o);
  assert.deepEqual([...o.onlyfans], ["https://onlyfans.com/avarose"]);
  assert.deepEqual([...o.instagram], ["ava.rose"]);
  assert.deepEqual([...o.telegram], ["avachannel"]);
  assert.deepEqual([...o.whatsapp], ["+15551234567"]);
  assert.deepEqual([...o.fansly], ["https://fansly.com/AvaRose"]);
  assert.deepEqual([...o.tiktok], ["avarosee"]);
  assert.ok(o.emails.has("ava.business@gmail.com") && o.emails.has("ava@avarose.co"));
  assert.ok(o.phones.has("+15552223344"));
});

test("bare onlyfans link in bio text", () => {
  const o = empty();
  extractFrom("sub to my page onlyfans.com/lunaxo 💕", o);
  assert.deepEqual([...o.onlyfans], ["https://onlyfans.com/lunaxo"]);
});

test("AI answer parsing + decisions", () => {
  const r = parseResults('```json\n{"results":[{"id":"1","is_creator":true,"female_self_stated":true,"english":true,"real_person":true,"age_flag":false,"confidence":0.9}]}\n```');
  assert.equal(r.length, 1);
  assert.equal(decide(r[0]).outcome, "qualified");
  assert.equal(decide({ ...r[0], age_flag: true }).outcome, "excluded");
  assert.equal(decide({ ...r[0], age_flag: undefined }).outcome, "excluded");     // unsure = excluded
  assert.equal(decide({ ...r[0], confidence: 0.5 }).reason, "ai_low_confidence");
  assert.equal(decide({ ...r[0], female_self_stated: false }).outcome, "rejected");
  assert.equal(parseResults("sorry I can't"), null);
});

test("normalize X user", () => {
  const u = normalizeUser({ id: 123, userName: "ava", name: "Ava", description: "hi https://t.co/x", followers: 45000, following: 300, canDm: true,
    profile_bio: { entities: { url: { urls: [{ expanded_url: "https://linktr.ee/ava" }] } } } });
  assert.equal(u.id, "123");
  assert.equal(u.canDm, true);
  assert.ok(u.links.includes("https://linktr.ee/ava"));
});

const { cleanHandle } = await import("../src/routes/seeds.js");
const { hashPassword, verifyPassword } = await import("../src/lib/auth.js");

test("handle cleaning", () => {
  assert.equal(cleanHandle("@GoodModel"), "GoodModel");
  assert.equal(cleanHandle("https://twitter.com/Good_1?s=20"), "Good_1");
  assert.equal(cleanHandle("x.com/abc/status/1"), "abc");
  assert.equal(cleanHandle("bad handle!!"), null);
  assert.equal(cleanHandle("@toolongusername123"), null);
});

test("password hashing", async () => {
  const h = await hashPassword("correct horse battery");
  assert.ok(await verifyPassword("correct horse battery", h));
  assert.equal(await verifyPassword("wrong", h), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});

const { initialEmailList, afterInstagram } = await import("../src/crawler/emailrules.js");
const { normalizeProfile } = await import("../src/crawler/instagram.js");

test("email list rules (plan 5.1)", () => {
  const S = { follower_min: 30000, follower_max: 150000, ig_min_followers: 30000 };
  assert.equal(initialEmailList({ xFollowers: 200000, hasEmail: true, igHandles: ["a"] }, S).status, "eligible");
  assert.equal(initialEmailList({ xFollowers: 150000, hasEmail: true, igHandles: [] }, S).status, "eligible");
  assert.equal(initialEmailList({ xFollowers: 200000, hasEmail: false, igHandles: ["a"] }, S).status, "none");
  assert.equal(initialEmailList({ xFollowers: 60000, hasEmail: false, igHandles: ["a"] }, S).status, "none");
  assert.equal(initialEmailList({ xFollowers: 60000, hasEmail: true, igHandles: ["a"] }, S).status, "pending_ig");
  assert.deepEqual(initialEmailList({ xFollowers: 60000, hasEmail: true, igHandles: [] }, S), { status: "under_review", reason: "no_instagram" });
  assert.deepEqual(afterInstagram([15000, 20000], S), { status: "eligible", reason: "instagram_followers", total: 35000 });
  assert.equal(afterInstagram([29999], S).status, "under_review");
  assert.equal(afterInstagram([null], S).reason, "instagram_not_found");
  assert.equal(afterInstagram([30000, null], S).status, "eligible");
});

test("instagram profile parsing", () => {
  assert.deepEqual(normalizeProfile({ username: "Ava.Rose", followersCount: 41000, biography: "biz: ava@mail.com", private: false }),
    { username: "ava.rose", found: true, followers: 41000, email: "ava@mail.com", private: false });
  assert.equal(normalizeProfile({ username: "x", edge_followed_by: { count: 5 } }).followers, 5);
  assert.equal(normalizeProfile({ username: "gone", error: "not_found" }).found, false);
  assert.equal(normalizeProfile({ username: "y", followersCount: 10, businessEmail: "B@x.co" }).email, "b@x.co");
  assert.equal(normalizeProfile(null), null);
});

const tpl = await import("../src/email/template.js");
const { windowBounds } = await import("../src/email/engine.js");

test("email template helpers", () => {
  assert.equal(tpl.firstName("Samantha Bowers 🌸"), "Samantha");
  assert.equal(tpl.firstName("LUNA xo"), "Luna");
  assert.equal(tpl.firstName("🔥🔥", "x_99"), "");
  assert.equal(tpl.firstName("", "jessica_rae22"), "Jessica");
  assert.equal(tpl.render("Hi {{first_name}}, {{ x_handle }} {{unknown}}!", { first_name: "", x_handle: "ava" }), "Hi there, @ava !");
  assert.equal(tpl.cleanReply("Sounds good!\n\nOn Mon, Oct 4, 2026 at 5:00 PM Sarah <a@b.co>\nwrote:\n> Hi"), "Sounds good!");
  assert.equal(tpl.cleanReply("Yes please\n> quoted"), "Yes please");
  assert.equal(tpl.cleanReply("ok\nSent from my iPhone"), "ok");
  assert.ok(tpl.isOptOut("No thanks"));
  assert.ok(tpl.isOptOut("STOP"));
  assert.ok(tpl.isOptOut("not interested, sorry"));
  assert.equal(tpl.isOptOut("No problem, let's talk tomorrow at 5pm and see what you offer for my page"), false);
  assert.equal(tpl.isOptOut("Yes! Tell me more"), false);
  assert.equal(tpl.shortNumber(254000), "254K");
  assert.equal(tpl.shortNumber(1250000), "1.3M");
});

test("sending window (Riyadh time)", () => {
  const at = (h, m = 0) => Date.UTC(2026, 9, 13, h - 3, m);   // Riyadh hour h on Oct 13
  let w = windowBounds({ email_from_hour: 17, email_to_hour: 2 }, at(20));
  assert.equal(w.open, true); assert.equal(w.minutes, 540); assert.equal(w.key, "2026-10-13");
  w = windowBounds({ email_from_hour: 17, email_to_hour: 2 }, at(1) + 86_400_000);   // 1am next day: still the 13th's window
  assert.equal(w.open, true); assert.equal(w.key, "2026-10-13");
  w = windowBounds({ email_from_hour: 17, email_to_hour: 2 }, at(10));
  assert.equal(w.open, false);
  w = windowBounds({ email_from_hour: 9, email_to_hour: 17 }, at(12));
  assert.equal(w.open, true); assert.equal(w.minutes, 480);
  w = windowBounds({ email_from_hour: 0, email_to_hour: 0 }, at(5));
  assert.equal(w.open, true); assert.equal(w.minutes, 1440);
});

test("exit cleanly", async () => { (await import("../src/lib/db.js")).pool.end(); });
