package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"testing"
)

func TestBIP39Roundtrip(t *testing.T) {
	entropy := make([]byte, 16)
	if _, err := rand.Read(entropy); err != nil {
		t.Fatal(err)
	}

	phrase, err := EntropyToPhrase(entropy)
	if err != nil {
		t.Fatalf("EntropyToPhrase failed: %v", err)
	}

	recovered, err := PhraseToEntropy(phrase)
	if err != nil {
		t.Fatalf("PhraseToEntropy failed: %v", err)
	}

	if !bytes.Equal(entropy, recovered) {
		t.Fatalf("entropy mismatch: got %x, want %x", recovered, entropy)
	}
}

func TestBase62Roundtrip(t *testing.T) {
	for i := 0; i < 20; i++ {
		entropy := make([]byte, 16)
		if _, err := rand.Read(entropy); err != nil {
			t.Fatal(err)
		}

		b62 := BytesToBase62(entropy)
		if len(b62) != 22 {
			t.Fatalf("expected length 22, got %d (%s)", len(b62), b62)
		}

		recovered, err := Base62ToBytes(b62)
		if err != nil {
			t.Fatalf("Base62ToBytes failed: %v", err)
		}

		if !bytes.Equal(entropy, recovered) {
			t.Fatalf("base62 mismatch: got %x, want %x", recovered, entropy)
		}
	}
}

func TestParseKeyOrPhrase(t *testing.T) {
	entropy := make([]byte, 16)
	_, _ = rand.Read(entropy)

	phrase, _ := EntropyToPhrase(entropy)
	b62 := BytesToBase62(entropy)
	hexStr := hex.EncodeToString(entropy)

	k1, err := ParseKeyOrPhrase(phrase)
	if err != nil || !bytes.Equal(k1, entropy) {
		t.Fatalf("failed parse phrase: %v", err)
	}

	k2, err := ParseKeyOrPhrase(b62)
	if err != nil || !bytes.Equal(k2, entropy) {
		t.Fatalf("failed parse b62: %v", err)
	}

	k3, err := ParseKeyOrPhrase(hexStr)
	if err != nil || !bytes.Equal(k3, entropy) {
		t.Fatalf("failed parse hex: %v", err)
	}
}

func TestDeriveSessionCode(t *testing.T) {
	entropy, _ := hex.DecodeString("00112233445566778899aabbccddeeff")
	code := DeriveSessionCode(entropy)
	if len(code) != 12 {
		t.Fatalf("expected 12 chars, got %d: %s", len(code), code)
	}
}

func TestEncryptDecryptAESGCM(t *testing.T) {
	key := make([]byte, 16)
	_, _ = rand.Read(key)

	plaintext := []byte("hello world, testing e2e encryption in go")
	aad := []byte("msg-id-1234")

	iv, data, err := EncryptAESGCM(key, plaintext, aad)
	if err != nil {
		t.Fatalf("encrypt failed: %v", err)
	}

	decrypted, err := DecryptAESGCM(key, iv, data, aad)
	if err != nil {
		t.Fatalf("decrypt failed: %v", err)
	}

	if !bytes.Equal(decrypted, plaintext) {
		t.Fatalf("mismatch: got %s, want %s", string(decrypted), string(plaintext))
	}

	// Tampered AAD
	if _, err := DecryptAESGCM(key, iv, data, []byte("wrong-aad")); err == nil {
		t.Fatal("expected error with wrong AAD")
	}
}

func TestCrossCompatibilityWithTS(t *testing.T) {
	testKey := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	b62 := BytesToBase62(testKey)
	if b62 != "000SYW7RiJxkEgOGusQGwp" {
		t.Fatalf("b62 mismatch: got %s, want 000SYW7RiJxkEgOGusQGwp", b62)
	}

	keys := DeriveSubkeys(testKey, "123456789012")
	if hex.EncodeToString(keys.CmdKey) != "7e6906cd6d736f8bcb5d2dd4dea54b1e" {
		t.Fatalf("cmdKey mismatch: %s", hex.EncodeToString(keys.CmdKey))
	}
	if hex.EncodeToString(keys.RespKey) != "d8e4a29fed6047aa9a318a91ee2aff09" {
		t.Fatalf("respKey mismatch: %s", hex.EncodeToString(keys.RespKey))
	}
	if hex.EncodeToString(keys.MetaKey) != "c1711015d8bf78a7938d9d3fa4e99c73" {
		t.Fatalf("metaKey mismatch: %s", hex.EncodeToString(keys.MetaKey))
	}
}
