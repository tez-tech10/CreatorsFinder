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

  // Instagram check (optional). Without APIFY_TOKEN, creators wait in "Waiting for Instagram".
  apifyToken: process.env.APIFY_TOKEN?.trim() || null,
  apifyIgActor: process.env.APIFY_IG_ACTOR?.trim() || "apify~instagram-profile-scraper",
  apifyBase: process.env.APIFY_BASE || "https://api.apify.com",
  costPerIgProfile: Number(process.env.COST_PER_IG_PROFILE || 0.0015),
  igBatchSize: 20,

  // Email (Gmail App Passwords). SECRET_KEY encrypts the stored App Passwords — any long random text.
  secretKey: process.env.SECRET_KEY?.trim() || null,
  smtpHost: process.env.SMTP_HOST || "smtp.gmail.com",
  smtpPort: Number(process.env.SMTP_PORT || 465),
  imapHost: process.env.IMAP_HOST || "imap.gmail.com",
  imapPort: Number(process.env.IMAP_PORT || 993),
  mailTls: process.env.MAIL_TLS !== "0",          // only turned off for local testing
  timezone: "Asia/Riyadh",

  // Telegram channel updates (optional)
  telegramToken: process.env.TELEGRAM_BOT_TOKEN?.trim() || null,
  telegramChatId: process.env.TELEGRAM_CHAT_ID?.trim() || null,
  telegramBase: process.env.TELEGRAM_BASE || "https://api.telegram.org",

  pollIdleMs: 30_000,
  pollBusyMs: 1_000,
};
