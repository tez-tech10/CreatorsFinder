// Age-safety keyword check. Runs BEFORE the AI check.
// Any match excludes the account permanently. False positives are acceptable here; misses are not.

const PATTERNS = [
  /\b(1[0-7])\s*(yo|y\/o|y\.o\.?|yrs?|years?\s*old)\b/i,
  /\b(age|aged)\s*[:\-]?\s*1[0-7]\b/i,
  /\b(i'?m|im|i am)\s*1[0-7]\b/i,
  /\b(high\s*school|highschool|middle\s*school|junior\s*high|jr\.?\s*high)\b/i,
  /\b(9th|10th|11th|12th)\s*grade\b/i,
  /\b(grade\s*(9|10|11|12))\b/i,
  /\b(class\s*of\s*20(2[6-9]|3\d))\b/i,
  /\b(minor|underage|under\s*18|not\s*18|u18)\b/i,
  /\b(teen(ager)?|schoolgirl|school\s*girl)\b/i,
];

export function ageRedFlag(...texts) {
  const joined = texts.filter(Boolean).join(" \n ");
  for (const p of PATTERNS) {
    const m = joined.match(p);
    if (m) return m[0];
  }
  return null;
}
