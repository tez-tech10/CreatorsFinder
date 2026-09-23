// AI check through OpenRouter: up to N profiles per request, with a fallback model list.
import { config } from "../config.js";

const SYSTEM = `You review public X (Twitter) profiles for a talent agency that works with adult OnlyFans creators.
For EACH profile, decide from the text only. Never guess from images or stereotypes.

Return ONLY valid JSON in exactly this shape, no other text:
{"results":[{"id":"<id>","is_creator":true,"female_self_stated":true,"english":true,"real_person":true,"age_flag":false,"confidence":0.0,"niche":"","reason":""}]}

Field rules:
- is_creator: the profile itself is an OnlyFans / adult content creator (not a fan, promo page, agency, or aggregator).
- female_self_stated: true only if the text presents her as a woman (e.g. she/her, "girl", "woman", "wife", feminine self-description). If there is no signal, false.
- english: she writes mainly in English.
- real_person: an individual person, not a bot, brand, or page run for many creators.
- age_flag: true if ANYTHING suggests she could be under 18 (school, grade, age under 18, "teen" wording, childish context). If unsure, true.
- confidence: 0 to 1, how sure you are about is_creator + female_self_stated + english together.
- niche: 1–3 words (e.g. "fitness", "cosplay", "gamer", "alt", "lifestyle"). Empty if unknown.
- reason: max 15 words explaining the decision.
Include every id you were given, exactly once.`;

function profileText(p) {
  return [
    `id: ${p.id}`,
    `handle: @${p.handle}`,
    `name: ${p.name || ""}`,
    `followers: ${p.followers}`,
    `bio: ${(p.bio || "").slice(0, 400)}`,
    `links found: ${(p.linkSummary || "").slice(0, 200)}`,
    p.recentPosts?.length ? `recent posts: ${p.recentPosts.map((t) => t.slice(0, 160)).join(" | ")}` : "",
  ].filter(Boolean).join("\n");
}

export function parseResults(content) {
  if (!content) return null;
  let text = String(content).replace(/```json|```/gi, "").trim();
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(obj.results) ? obj.results : null;
  } catch { return null; }
}

// Returns { results: Map(id → result), cost, model } or throws when every model failed.
export async function classifyBatch(profiles) {
  const ids = new Set(profiles.map((p) => p.id));
  const body = {
    models: config.llmModels,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: profiles.map(profileText).join("\n\n---\n\n") },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
    usage: { include: true },
  };

  let lastErr = "no response";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${config.openrouterBase}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${config.openrouterKey}`, "Content-Type": "application/json", "X-Title": "Creator crawler" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const json = await res.json().catch(() => null);
      if (res.status === 401) throw Object.assign(new Error("OpenRouter rejected the API key (OPENROUTER_API_KEY)."), { fatal: true });
      if (!res.ok || !json) { lastErr = `OpenRouter ${res.status}: ${json?.error?.message || "error"}`; await new Promise((r) => setTimeout(r, 5000 * attempt)); continue; }

      const results = parseResults(json.choices?.[0]?.message?.content);
      if (!results) { lastErr = "AI answer was not valid JSON"; continue; }

      const map = new Map();
      for (const r of results) if (r && ids.has(String(r.id))) map.set(String(r.id), r);
      return { results: map, cost: Number(json.usage?.cost || 0), model: json.model || null, tokens: json.usage?.total_tokens || 0 };
    } catch (e) {
      if (e.fatal) throw e;
      lastErr = e.message;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw new Error(`AI check failed after retries: ${lastErr}`);
}

// Turns one AI result into a decision. Strict: unsure about age = excluded.
export function decide(r) {
  if (!r) return { outcome: "retry", reason: "ai_missing" };
  if (r.age_flag !== false) return { outcome: "excluded", reason: "age_safety_ai" };
  const conf = Number(r.confidence);
  if (r.is_creator !== true) return { outcome: "rejected", reason: "ai_not_creator" };
  if (r.female_self_stated !== true) return { outcome: "rejected", reason: "ai_not_female_self_stated" };
  if (r.english !== true) return { outcome: "rejected", reason: "ai_not_english" };
  if (r.real_person !== true) return { outcome: "rejected", reason: "ai_not_real_person" };
  if (!(conf >= 0.7)) return { outcome: "rejected", reason: "ai_low_confidence" };
  return { outcome: "qualified", reason: null };
}
