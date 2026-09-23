// Session cookie → req.user. Guards block requests without a valid session.
import { one, query } from "../lib/db.js";
import { hashToken } from "../lib/auth.js";

export const COOKIE = "cf_session";

export async function attachUser(req, _res, next) {
  req.user = null;
  const token = req.cookies?.[COOKIE];
  if (!token) return next();
  try {
    const row = await one(
      `select u.id, u.email, s.token_hash, s.last_used_at
         from sessions s join admin_users u on u.id = s.user_id
        where s.token_hash = $1 and s.expires_at > now()`,
      [hashToken(token)]
    );
    if (row) {
      req.user = { id: row.id, email: row.email, role: "admin" };
      // Refresh "last used" at most once an hour
      if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 3_600_000) {
        query("update sessions set last_used_at = now() where token_hash = $1", [row.token_hash]).catch(() => {});
      }
    }
  } catch (e) { return next(e); }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Please sign in." });
  next();
}
