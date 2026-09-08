(function() {
  var BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function sha256PureJs(data) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var l = data.length;
    var n = ((l + 8) >> 6) + 1;
    var words = new Uint32Array(n * 16);
    for (var i = 0; i < l; i++) {
      words[i >> 2] |= data[i] << (24 - (i & 3) * 8);
    }
    words[l >> 2] |= 0x80 << (24 - (l & 3) * 8);
    words[n * 16 - 1] = l * 8;

    var W = new Uint32Array(64);
    for (var i = 0; i < n; i++) {
      for (var t = 0; t < 16; t++) W[t] = words[i * 16 + t];
      for (var t = 16; t < 64; t++) {
        var s0 = ((W[t-15] >>> 7) | (W[t-15] << 25)) ^ ((W[t-15] >>> 18) | (W[t-15] << 14)) ^ (W[t-15] >>> 3);
        var s1 = ((W[t-2] >>> 17) | (W[t-2] << 15)) ^ ((W[t-2] >>> 19) | (W[t-2] << 13)) ^ (W[t-2] >>> 10);
        W[t] = (W[t-16] + s0 + W[t-7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (var t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ ((~e) & g);
        var temp1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0;
      H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0;
      H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0;
      H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0;
      H[7] = (H[7] + h) >>> 0;
    }
    var res = new Uint8Array(32);
    for (var i = 0; i < 8; i++) {
      res[i * 4] = (H[i] >>> 24) & 0xff;
      res[i * 4 + 1] = (H[i] >>> 16) & 0xff;
      res[i * 4 + 2] = (H[i] >>> 8) & 0xff;
      res[i * 4 + 3] = H[i] & 0xff;
    }
    return res;
  }

  function bytesToHex(bytes) {
    var hex = "";
    for (var i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, "0");
    }
    return hex;
  }

  function hexToBytes(hex) {
    var bytes = new Uint8Array(hex.length / 2);
    for (var i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  async function sha256Bytes(bytes) {
    if (typeof crypto !== "undefined" && crypto.subtle && crypto.subtle.digest) {
      try {
        var hash = await crypto.subtle.digest("SHA-256", bytes);
        return new Uint8Array(hash);
      } catch (_) {}
    }
    return sha256PureJs(bytes);
  }

  async function keyToSessionCode(entropy) {
    var h = await sha256Bytes(entropy);
    return bytesToHex(h.slice(0, 6));
  }

  function bytesToBase62(bytes) {
    var hex = bytesToHex(bytes);
    var num = BigInt("0x" + hex);
    var res = "";
    while (num > 0n) {
      var rem = Number(num % 62n);
      res = BASE62[rem] + res;
      num = num / 62n;
    }
    while (res.length < 22) res = "0" + res;
    return res;
  }

  function base62ToBytes(str) {
    str = str.trim();
    if (str.length !== 22) throw new Error("Invalid Base62 key length, expected 22");
    var num = 0n;
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      var idx = BASE62.indexOf(ch);
      if (idx === -1) throw new Error("Invalid Base62 char: " + ch);
      num = num * 62n + BigInt(idx);
    }
    var hex = num.toString(16);
    while (hex.length < 32) hex = "0" + hex;
    return hexToBytes(hex);
  }

  function parseKey(input) {
    var clean = (input || "").trim();
    if (/^[0-9a-zA-Z]{22}$/.test(clean)) {
      return base62ToBytes(clean);
    }
    if (/^[0-9a-fA-F]{32}$/.test(clean)) {
      return hexToBytes(clean);
    }
    throw new Error("Invalid key: must be a 22-char Base62 string or 32-char hex");
  }

  async function deriveWebCryptoKeys(keyBytes, sessionCode) {
    if (!crypto || !crypto.subtle) return null;
    var enc = new TextEncoder();
    var salt = enc.encode(sessionCode);

    var hmacKey = await crypto.subtle.importKey("raw", salt, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    var prk = await crypto.subtle.sign("HMAC", hmacKey, keyBytes);

    var prkKey = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

    async function deriveSubkey(info) {
      var infoBytes = new Uint8Array([...enc.encode(info), 1]);
      var okm = await crypto.subtle.sign("HMAC", prkKey, infoBytes);
      var subkeyBytes = new Uint8Array(okm.slice(0, 16));
      return await crypto.subtle.importKey("raw", subkeyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    }

    return {
      cmdKey: await deriveSubkey("cya-cmd"),
      respKey: await deriveSubkey("cya-resp"),
      metaKey: await deriveSubkey("cya-meta"),
    };
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  async function decryptPayload(cryptoKey, ivB64, dataB64, aadStr) {
    if (!crypto || !crypto.subtle) throw new Error("WebCrypto not available");
    var iv = b64ToBytes(ivB64);
    var data = b64ToBytes(dataB64);
    var enc = new TextEncoder();
    var opt = { name: "AES-GCM", iv: iv };
    if (aadStr) {
      opt.additionalData = enc.encode(aadStr);
    }
    var decrypted = await crypto.subtle.decrypt(opt, cryptoKey, data);
    return new TextDecoder().decode(decrypted);
  }

  window.CYA_CRYPTO = {
    generateEntropy: function() {
      var b = new Uint8Array(16);
      if (typeof crypto !== "undefined" && crypto.getRandomValues) {
        crypto.getRandomValues(b);
      } else {
        for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
      }
      return b;
    },
    bytesToBase62: bytesToBase62,
    base62ToBytes: base62ToBytes,
    parseKey: parseKey,
    keyToSessionCode: keyToSessionCode,
    deriveWebCryptoKeys: deriveWebCryptoKeys,
    decryptPayload: decryptPayload,
  };
})();
