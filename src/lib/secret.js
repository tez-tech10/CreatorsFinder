// Encrypts Gmail App Passwords before they go into the database (AES-256-GCM).
// The key comes from SECRET_KEY in Railway, so a copy of the database alone can't reveal them.
import crypto from "node:crypto";
import { config } from "../config.js";

export class MissingSecretKey extends Error {
  constructor() { super("Add SECRET_KEY in Railway → Variables (any long random text) before adding inboxes."); }
}

function key() {
  if (!config.secretKey || config.secretKey.length < 16) throw new MissingSecretKey();
  return crypto.createHash("sha256").update(config.secretKey).digest();
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(String(text), "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decrypt(blob) {
  const [v, iv, tag, data] = String(blob).split(":");
  if (v !== "v1") throw new Error("Unknown secret format.");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(data, "base64")), d.final()]).toString("utf8");
}
