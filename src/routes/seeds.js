import { Router } from "express";
import { query, one, activity } from "../lib/db.js";
import { requireAdmin } from "../middleware/session.js";
import { getUserInfo } from "../crawler/twitter.js";
import { enforceSeedLock } from "./settings.js";

const router = Router();
router.use("/api/admin/seeds", requireAdmin);

// Accepts "@name", "name", "x.com/name", "https://twitter.com/name?s=20"
export function cleanHandle(input) {
  let h = String(input ?? "").trim();
  h = h.replace(/^https?:\/\//i, "").replace(/^(www\.|mobile\.)?(x|twitter)\.com\//i, "");
  h = h.replace(/^@/, "").split(/[/?#]/)[0].trim();
  return /^[A-Za-z0-9_]{1,15}$/.test(h) ? h : null;
}

export async function seedSummary() {
  const r = await one(`
    select
      count(*) filter (where status = 'active')::int                           as active_count,
      count(*) filter (where status = 'active' and seed_type = 'agency')::int  as agency_count,
      count(*) filter (where status = 'active' and seed_type = 'model')::int   as model_count,
      count(*) filter (where status = 'paused')::int                           as paused_count,
      (select min_seeds from settings where id = 1)                            as min_seeds
    from seeds`);
  return { ...r, crawler_unlocked: r.active_count >= r.min_seeds };
}

router.get("/api/admin/seeds", async (_req, res, next) => {
  try {
    const seeds = (await query("select * from seeds where status <> 'removed' order by created_at")).rows;
    res.json({ seeds, summary: await seedSummary() });
  } catch (e) { next(e); }
});

router.post("/api/admin/seeds", async (req, res, next) => {
  try {
    const handle = cleanHandle(req.body?.handle);
    if (!handle) return res.status(400).json({ error: "That doesn't look like a valid X handle." });
    const seedType = req.body?.seed_type;
    if (seedType !== "agency" && seedType !== "model") return res.status(400).json({ error: "Choose Model or Agency." });
    const notes = typeof req.body?.notes === "string" ? req.body.notes.trim().slice(0, 500) || null : null;

    let u;
    try { u = await getUserInfo(handle); }
    catch (e) { return res.status(502).json({ error: e.message }); }
    if (!u) return res.status(404).json({ error: `No X account found for @${handle}.` });
    if (u.unavailable) return res.status(422).json({ error: `@${handle} is unavailable on X${u.unavailableReason ? ` (${u.unavailableReason})` : ""}.` });
    if (u.protected === true) return res.status(422).json({ error: `@${handle} is a private account. Its followings can't be read, so it can't be a seed.` });

    const xUserId = String(u.id);
    // X gives a small 48px picture ("_normal"); ask for the 200px version instead.
    const picture = typeof u.profilePicture === "string" && u.profilePicture.startsWith("https://")
      ? u.profilePicture.replace("_normal.", "_200x200.") : null;
    const existing = await one("select id, status, handle from seeds where x_user_id = $1", [xUserId]);
    if (existing && existing.status !== "removed") {
      return res.status(409).json({ error: `@${existing.handle} is already a seed (${existing.status}).` });
    }

    const values = [xUserId, u.userName || handle, u.name || null, typeof u.followers === "number" ? u.followers : null, seedType, notes, picture];
    const seed = existing
      ? await one(`update seeds set x_user_id=$1, handle=$2, display_name=$3, x_followers=$4, seed_type=$5, notes=$6,
                     profile_image=$7, status='active', updated_at=now() where id=$8 returning *`, [...values, existing.id])
      : await one(`insert into seeds (x_user_id, handle, display_name, x_followers, seed_type, notes, profile_image)
                   values ($1,$2,$3,$4,$5,$6,$7) returning *`, values);

    await activity("seeds", `Seed added: @${seed.handle} (${seedType})`, { x_user_id: xUserId, followers: seed.x_followers });
    res.json({ seed, summary: await seedSummary() });
  } catch (e) { next(e); }
});

// Pause / resume / remove / change type
router.patch("/api/admin/seeds/:id", async (req, res, next) => {
  try {
    const seed = await one("select * from seeds where id = $1", [req.params.id]);
    if (!seed || seed.status === "removed") return res.status(404).json({ error: "Seed not found." });

    const status = req.body?.status;
    const type = req.body?.seed_type;
    if (status && !["active", "paused", "removed"].includes(status)) return res.status(400).json({ error: "Invalid status." });
    if (type && !["agency", "model"].includes(type)) return res.status(400).json({ error: "Invalid type." });

    const updated = await one(
      "update seeds set status = coalesce($1, status), seed_type = coalesce($2, seed_type), updated_at = now() where id = $3 returning *",
      [status || null, type || null, seed.id]
    );
    if (status && status !== seed.status) await activity("seeds", `Seed ${status === "active" ? "resumed" : status}: @${seed.handle}`);
    if (type && type !== seed.seed_type) await activity("seeds", `Seed type changed to ${type}: @${seed.handle}`);

    const locked = await enforceSeedLock(); // switches the crawler off if seeds dropped below the minimum
    res.json({ seed: updated, summary: await seedSummary(), crawler_switched_off: locked });
  } catch (e) { next(e); }
});

export default router;
