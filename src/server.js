import { config } from "./config.js";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";

import { pool } from "./lib/db.js";
import { ensureAdmin } from "./lib/auth.js";
import { attachUser } from "./middleware/session.js";
import auth from "./routes/auth.js";
import seeds from "./routes/seeds.js";
import settings from "./routes/settings.js";
import crawler from "./routes/crawler.js";
import { startCrawler, stopCrawler } from "./crawler/runner.js";

const app = express();

app.set("trust proxy", 1);          // Railway sits behind a proxy
app.use(helmet());
app.use(cors({ origin: [config.siteUrl], credentials: true }));  // required for the session cookie
app.use(express.json({ limit: "64kb" }));
app.use(cookieParser());
app.use(attachUser);                // sets req.user from the cookie; guards are per route

app.get("/health", async (_req, res) => {
  try { await pool.query("select 1"); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

app.use(auth);
app.use(seeds);
app.use(settings);
app.use(crawler);

app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err, _req, res, _next) => {
  console.error("[error]", err);
  res.status(500).json({ error: "Something went wrong on our side." });
});

async function start() {
  await pool.query("select 1");       // fail fast if DATABASE_URL is wrong
  await ensureAdmin();
  const server = app.listen(config.port, () => console.log(`CreatorsFinder API listening on :${config.port}`));
  if (config.runCrawler) startCrawler();

  const shutdown = async () => {
    console.log("Shutting down…");
    server.close();
    await stopCrawler();
    await pool.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start().catch((e) => {
  console.error("Startup failed:", e.message);
  process.exit(1);
});
