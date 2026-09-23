// Direct Postgres connection to Supabase (tables only).
import pg from "pg";
import { config } from "../config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (e) => console.error("[db] idle client error:", e.message));

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function one(text, params = []) {
  const r = await pool.query(text, params);
  return r.rows[0] || null;
}

export async function activity(category, message, meta = null) {
  try {
    await pool.query("insert into activity_log (category, message, meta) values ($1, $2, $3)", [category, message, meta]);
  } catch (e) { console.error("[activity]", e.message); }
}
