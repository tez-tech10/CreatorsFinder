// Free, local language check. Returns 'english', 'other' or 'unclear'.
// Short or emoji-only bios come back 'unclear' → the worker then looks at recent posts.

const EN = new Set(("the and my me i you your of to in for with on is it a an just love girl link below here dm " +
  "content subscribe free new daily pics vids video videos only only fans exclusive spicy page check out " +
  "follow sub subs sexy cute babe baby lover living life gym fitness gamer streamer model creator " +
  "welcome hi hey im i'm this that at be all about what who are was not no yes more your's here's").split(" "));

const OTHER = new Set(("de la el que y con para por los las una uno del se lo mi tu es muy pero como más " +
  "eu você não com uma para meu minha seu sua também são " +
  "und ich der die das nicht mit ist ein eine für auf sie " +
  "et les je moi le une des est pour dans pas avec vous " +
  "il di che non per sono della una gli " +
  "ve bir ben sen bu da için ile " +
  "ja nie się jest na że to").split(" "));

const NON_LATIN = /[\u0400-\u04FF\u0600-\u06FF\u0590-\u05FF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u0900-\u097F]/g;
const LETTER = /\p{L}/gu;

export function detectLanguage(text) {
  if (!text) return "unclear";
  const clean = String(text)
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[@#][\w.]+/g, " ")
    .toLowerCase();

  const letters = (clean.match(LETTER) || []).length;
  if (letters < 8) return "unclear";

  const nonLatin = (clean.match(NON_LATIN) || []).length;
  if (nonLatin / letters > 0.3) return "other";

  const words = clean.split(/[^\p{L}']+/u).filter(Boolean);
  let en = 0, other = 0;
  for (const w of words) {
    if (EN.has(w)) en++;
    if (OTHER.has(w)) other++;
  }
  if (en >= 2 && en > other * 1.5) return "english";
  if (other >= 2 && other > en) return "other";
  return "unclear";
}
