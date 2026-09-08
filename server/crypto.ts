import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export interface SessionKeys {
  cmdKey: Uint8Array;
  respKey: Uint8Array;
  metaKey: Uint8Array;
}

export interface EncryptedPayload {
  enc: true;
  iv: string;   // base64
  data: string; // base64 (ciphertext + 16-byte tag)
}

export function generateEntropy(length = 16): Uint8Array {
  return new Uint8Array(randomBytes(length));
}

export function entropyToPhrase(entropy: Uint8Array): string {
  return entropyToMnemonic(entropy, wordlist);
}

export function phraseToEntropy(phrase: string): Uint8Array {
  const normalized = phrase.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("Invalid BIP-39 mnemonic seed phrase");
  }
  return mnemonicToEntropy(normalized, wordlist);
}

export function bytesToBase62(bytes: Uint8Array): string {
  let num = BigInt("0x" + Buffer.from(bytes).toString("hex"));
  let res = "";
  while (num > 0n) {
    const rem = Number(num % 62n);
    res = BASE62_ALPHABET[rem] + res;
    num = num / 62n;
  }
  return res.padStart(22, "0");
}

export function base62ToBytes(str: string): Uint8Array {
  const clean = str.trim();
  let num = 0n;
  for (const ch of clean) {
    const idx = BASE62_ALPHABET.indexOf(ch);
    if (idx === -1) {
      throw new Error(`Invalid Base62 character: ${ch}`);
    }
    num = num * 62n + BigInt(idx);
  }
  const hex = num.toString(16).padStart(32, "0");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

export function parseKeyOrPhrase(input: string): Uint8Array {
  const clean = input.trim();
  const words = clean.split(/\s+/);
  if (words.length >= 12) {
    return phraseToEntropy(words.join(" "));
  }
  if (/^[0-9a-zA-Z]{22}$/.test(clean)) {
    return base62ToBytes(clean);
  }
  if (/^[0-9a-fA-F]{32}$/.test(clean)) {
    return new Uint8Array(Buffer.from(clean, "hex"));
  }
  throw new Error("Key must be a 12-word seed phrase, 22-char Base62 string, or 32-char hex string");
}

export function keyToSessionCode(keyBytes: Uint8Array): string {
  return createHash("sha256").update(keyBytes).digest("hex").slice(0, 12);
}

export function hkdf16(ikm: Uint8Array, salt: Uint8Array | string, info: string): Uint8Array {
  const saltBuf = typeof salt === "string" ? Buffer.from(salt, "utf-8") : Buffer.from(salt);
  const prk = createHmac("sha256", saltBuf).update(Buffer.from(ikm)).digest();
  const okm = createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info, "utf-8"), Buffer.from([1])]))
    .digest();
  return new Uint8Array(okm.subarray(0, 16));
}

export function deriveSessionKeys(keyBytes: Uint8Array, sessionCode: string): SessionKeys {
  return {
    cmdKey: hkdf16(keyBytes, sessionCode, "cya-cmd"),
    respKey: hkdf16(keyBytes, sessionCode, "cya-resp"),
    metaKey: hkdf16(keyBytes, sessionCode, "cya-meta"),
  };
}

export function encryptPayload(
  key: Uint8Array,
  plaintext: string | Uint8Array,
  aad?: string,
): EncryptedPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-128-gcm", Buffer.from(key), iv);
  if (aad) {
    cipher.setAAD(Buffer.from(aad, "utf-8"));
  }
  const ptBuf = typeof plaintext === "string" ? Buffer.from(plaintext, "utf-8") : Buffer.from(plaintext);
  const encrypted = Buffer.concat([cipher.update(ptBuf), cipher.final(), cipher.getAuthTag()]);
  return {
    enc: true,
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
  };
}

export function decryptPayload(
  key: Uint8Array,
  payload: { iv: string; data: string },
  aad?: string,
): string {
  const iv = Buffer.from(payload.iv, "base64");
  const data = Buffer.from(payload.data, "base64");
  if (data.length < 16) {
    throw new Error("Ciphertext too short (missing auth tag)");
  }
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(0, data.length - 16);

  const decipher = createDecipheriv("aes-128-gcm", Buffer.from(key), iv);
  if (aad) {
    decipher.setAAD(Buffer.from(aad, "utf-8"));
  }
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8");
}
