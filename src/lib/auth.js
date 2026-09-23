// Password hashing (scrypt, built into Node) and session tokens.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { query, one, activity } from "./db.js";
import { config } from "../config.js";

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, hex] = String(stored || "").split("$");
  if (alg !== "scrypt" || !salt || !hex) return false;
  const key = await scrypt(password, salt, 64);
  const expected = Buffer.from(hex, "hex");
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

export const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
export const newToken = () => crypto.randomBytes(32).toString("base64url");

export const SESSION_DAYS = 30;

// Creates the admin from ADMIN_EMAIL / ADMIN_PASSWORD on startup,
// and updates the password if it changed in Railway.
export async function ensureAdmin() {
  if (!config.adminEmail || !config.adminPassword) {
    console.warn("[auth] ADMIN_EMAIL / ADMIN_PASSWORD not set: no admin login will be created.");
    return;
  }
  if (config.adminPassword.length < 10) {
    console.error("[auth] ADMIN_PASSWORD must be at least 10 characters. Admin not created.");
    return;
  }
  const existing = await one("select id, password_hash from admin_users where email = $1", [config.adminEmail]);
  if (!existing) {
    await query("insert into admin_users (email, password_hash) values ($1, $2)", [config.adminEmail, await hashPassword(config.adminPassword)]);
    await activity("auth", `Admin account created: ${config.adminEmail}`);
    console.log(`[auth] Admin created: ${config.adminEmail}`);
  } else if (!(await verifyPassword(config.adminPassword, existing.password_hash))) {
    await query("update admin_users set password_hash = $1 where id = $2", [await hashPassword(config.adminPassword), existing.id]);
    await query("delete from sessions where user_id = $1", [existing.id]); // sign out old sessions
    await activity("auth", `Admin password changed from Railway: ${config.adminEmail}`);
    console.log("[auth] Admin password updated; existing sessions signed out.");
  }
}
