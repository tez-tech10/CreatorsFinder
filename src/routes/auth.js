import { Router } from "express";
import { one, query, activity } from "../lib/db.js";
import { verifyPassword, newToken, hashToken, SESSION_DAYS } from "../lib/auth.js";
import { COOKIE } from "../middleware/session.js";
import { config } from "../config.js";

const router = Router();

// Simple brute-force protection: 8 failed attempts per IP per 15 minutes.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(), win = 15 * 60_000;
  const list = (attempts.get(ip) || []).filter((t) => now - t < win);
  attempts.set(ip, list);
  return list.length >= 8;
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "lax",
    domain: config.cookieDomain,
    path: "/",
    maxAge: SESSION_DAYS * 86_400_000,
  };
}

router.post("/api/auth/login", async (req, res, next) => {
  try {
    const ip = req.ip;
    if (tooMany(ip)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });

    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });

    const user = await one("select id, email, password_hash from admin_users where email = $1", [email]);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      attempts.get(ip).push(Date.now());
      return res.status(401).json({ error: "Wrong email or password." });
    }

    const token = newToken();
    await query(
      "insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)",
      [hashToken(token), user.id, String(SESSION_DAYS)]
    );
    await query("update admin_users set last_login_at = now() where id = $1", [user.id]);
    await query("delete from sessions where expires_at < now()");
    await activity("auth", `Signed in: ${user.email}`);

    res.cookie(COOKIE, token, cookieOptions());
    res.json({ user: { email: user.email, role: "admin" } });
  } catch (e) { next(e); }
});

router.post("/api/auth/logout", async (req, res, next) => {
  try {
    const token = req.cookies?.[COOKIE];
    if (token) await query("delete from sessions where token_hash = $1", [hashToken(token)]);
    const { maxAge, ...opts } = cookieOptions();
    res.clearCookie(COOKIE, opts);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// "Who am I?" — the admin pages call this first and go to login on 401.
router.get("/api/auth/me", (req, res) => {
  if (!req.user) return res.status(401).json({ error: "Not signed in." });
  res.json({ user: req.user });
});

export default router;
