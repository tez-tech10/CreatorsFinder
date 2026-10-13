// Email list rules (plan section 5.1). Pure functions, no database.
//
//   X followers ≥ second limit (follower_max) + email      → email list
//   X followers between the limits + email                 → Instagram check
//       Instagram total ≥ ig_min_followers                 → email list
//       otherwise (or no Instagram linked)                  → under review (email kept internally)
//   no email                                                → X list only

export const MAX_IG_ACCOUNTS = 3;

// Decided when a creator is first saved.
export function initialEmailList({ xFollowers, hasEmail, igHandles }, settings) {
  if (!hasEmail) return { status: "none", reason: null };
  if (xFollowers >= settings.follower_max) return { status: "eligible", reason: "x_followers" };
  if (!igHandles?.length) return { status: "under_review", reason: "no_instagram" };
  return { status: "pending_ig", reason: null };
}

// Decided once Instagram follower counts are back.
export function afterInstagram(igFollowers, settings) {
  const total = igFollowers.reduce((sum, n) => sum + (Number(n) || 0), 0);
  return total >= settings.ig_min_followers
    ? { status: "eligible", reason: "instagram_followers", total }
    : { status: "under_review", reason: total ? "instagram_below_min" : "instagram_not_found", total };
}
