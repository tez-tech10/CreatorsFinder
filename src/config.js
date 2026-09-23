import "dotenv/config";

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`[config] Missing ${name}. Add it in Railway → Variables.`);
    process.exit(1);
  }
  return v.trim();
}

export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: required("DATABASE_URL"),
  siteUrl: required("SITE_URL").replace(/\/$/, ""),
  cookieDomain: process.env.COOKIE_DOMAIN?.trim() || undefined,
  isProd: process.env.NODE_ENV === "production" || !!process.env.RAILWAY_ENVIRONMENT,

  adminEmail: process.env.ADMIN_EMAIL?.trim().toLowerCase() || null,
  adminPassword: process.env.ADMIN_PASSWORD || null,

  twitterKey: required("TWITTERAPI_KEY"),
  openrouterKey: required("OPENROUTER_API_KEY"),
  llmModels: (process.env.LLM_MODELS || "qwen/qwen3.8-27b:free,z-ai/glm-5.2:free,deepseek/deepseek-v4-flash")
    .split(",").map((s) => s.trim()).filter(Boolean),

  // Set CRAWLER_OFF=1 to run the API without the crawler (e.g. a second service later).
  runCrawler: process.env.CRAWLER_OFF !== "1",

  // Only for local testing; leave unset on Railway.
  twitterBase: process.env.TWITTERAPI_BASE || "https://api.twitterapi.io",
  openrouterBase: process.env.OPENROUTER_BASE || "https://openrouter.ai/api/v1",

  // Estimated twitterapi.io prices (USD per item).
  costPerProfile: Number(process.env.COST_PER_PROFILE || 0.00015),
  costPerTweet: Number(process.env.COST_PER_TWEET || 0.00015),

  pollIdleMs: 30_000,
  pollBusyMs: 1_000,
};
