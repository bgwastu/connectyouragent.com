import { describe, expect, test } from "bun:test";
import {
  base62ToBytes,
  bytesToBase62,
  decryptPayload,
  deriveSessionKeys,
  encryptPayload,
  entropyToPhrase,
  generateEntropy,
  keyToSessionCode,
  parseKeyOrPhrase,
  phraseToEntropy,
} from "./crypto.ts";

describe("crypto utils", () => {
  test("BIP-39 mnemonic roundtrip", () => {
    const entropy = generateEntropy(16);
    const phrase = entropyToPhrase(entropy);
    const words = phrase.split(" ");
    expect(words.length).toBe(12);

    const recovered = phraseToEntropy(phrase);
    expect(Buffer.from(recovered).toString("hex")).toBe(Buffer.from(entropy).toString("hex"));
  });

  test("Base62 roundtrip", () => {
    for (let i = 0; i < 20; i++) {
      const entropy = generateEntropy(16);
      const b62 = bytesToBase62(entropy);
      expect(b62.length).toBe(22);
      expect(/^[0-9a-zA-Z]{22}$/.test(b62)).toBe(true);

      const recovered = base62ToBytes(b62);
      expect(Buffer.from(recovered).toString("hex")).toBe(Buffer.from(entropy).toString("hex"));
    }
  });

  test("parseKeyOrPhrase accepts phrase, base62, and hex", () => {
    const entropy = generateEntropy(16);
    const phrase = entropyToPhrase(entropy);
    const b62 = bytesToBase62(entropy);
    const hex = Buffer.from(entropy).toString("hex");

    expect(Buffer.from(parseKeyOrPhrase(phrase)).toString("hex")).toBe(hex);
    expect(Buffer.from(parseKeyOrPhrase(b62)).toString("hex")).toBe(hex);
    expect(Buffer.from(parseKeyOrPhrase(hex)).toString("hex")).toBe(hex);
  });

  test("keyToSessionCode produces 12-char hex", () => {
    const entropy = generateEntropy(16);
    const code = keyToSessionCode(entropy);
    expect(code.length).toBe(12);
    expect(/^[0-9a-f]{12}$/.test(code)).toBe(true);
  });

  test("encrypt and decrypt with AES-128-GCM and AAD", () => {
    const entropy = generateEntropy(16);
    const keys = deriveSessionKeys(entropy, "a1b2c3d4e5f6");

    const message = JSON.stringify({ cmd: "whoami && id", id: "12345" });
    const encrypted = encryptPayload(keys.cmdKey, message, "12345");
    expect(encrypted.enc).toBe(true);
    expect(typeof encrypted.iv).toBe("string");
    expect(typeof encrypted.data).toBe("string");

    const decrypted = decryptPayload(keys.cmdKey, encrypted, "12345");
    expect(decrypted).toBe(message);

    // Tampered AAD should throw
    expect(() => decryptPayload(keys.cmdKey, encrypted, "wrong-aad")).toThrow();

    // Tampered ciphertext should throw
    const tamperedData = Buffer.from(encrypted.data, "base64");
    tamperedData[0] ^= 1;
    expect(() =>
      decryptPayload(
        keys.cmdKey,
        { iv: encrypted.iv, data: tamperedData.toString("base64") },
        "12345",
      ),
    ).toThrow();
  });
});
