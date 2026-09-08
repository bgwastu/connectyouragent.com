package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"math/big"
	"regexp"
	"strings"

	"github.com/tyler-smith/go-bip39"
)

const base62Alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

var base62Pattern = regexp.MustCompile(`^[0-9a-zA-Z]{22}$`)
var hexPattern = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

type SessionKeys struct {
	CmdKey  []byte
	RespKey []byte
	MetaKey []byte
}

func EntropyToPhrase(entropy []byte) (string, error) {
	return bip39.NewMnemonic(entropy)
}

func PhraseToEntropy(phrase string) ([]byte, error) {
	normalized := strings.Join(strings.Fields(strings.ToLower(phrase)), " ")
	return bip39.EntropyFromMnemonic(normalized)
}

func BytesToBase62(bytes []byte) string {
	n := new(big.Int).SetBytes(bytes)
	base := big.NewInt(62)
	zero := big.NewInt(0)
	mod := new(big.Int)

	var res []byte
	for n.Cmp(zero) > 0 {
		n.DivMod(n, base, mod)
		res = append([]byte{base62Alphabet[mod.Int64()]}, res...)
	}

	for len(res) < 22 {
		res = append([]byte{'0'}, res...)
	}
	return string(res)
}

func Base62ToBytes(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if len(s) != 22 {
		return nil, fmt.Errorf("invalid base62 string length %d, expected 22", len(s))
	}

	n := big.NewInt(0)
	base := big.NewInt(62)

	for i := 0; i < len(s); i++ {
		ch := s[i]
		idx := strings.IndexByte(base62Alphabet, ch)
		if idx < 0 {
			return nil, fmt.Errorf("invalid base62 character: %c", ch)
		}
		n.Mul(n, base)
		n.Add(n, big.NewInt(int64(idx)))
	}

	raw := n.Bytes()
	if len(raw) > 16 {
		return nil, fmt.Errorf("base62 number overflows 16 bytes")
	}

	padded := make([]byte, 16)
	copy(padded[16-len(raw):], raw)
	return padded, nil
}

func ParseKeyOrPhrase(input string) ([]byte, error) {
	clean := strings.TrimSpace(input)
	words := strings.Fields(clean)
	if len(words) >= 12 {
		return PhraseToEntropy(clean)
	}
	if base62Pattern.MatchString(clean) {
		return Base62ToBytes(clean)
	}
	if hexPattern.MatchString(clean) {
		return hex.DecodeString(clean)
	}
	return nil, fmt.Errorf("invalid key: must be 12-word seed phrase, 22-char Base62, or 32-char hex")
}

func DeriveSessionCode(keyBytes []byte) string {
	h := sha256.Sum256(keyBytes)
	return hex.EncodeToString(h[:6])
}

func hkdf16(ikm, salt []byte, info string) []byte {
	mac := hmac.New(sha256.New, salt)
	mac.Write(ikm)
	prk := mac.Sum(nil)

	mac2 := hmac.New(sha256.New, prk)
	mac2.Write([]byte(info))
	mac2.Write([]byte{1})
	okm := mac2.Sum(nil)
	return okm[:16]
}

func DeriveSubkeys(keyBytes []byte, sessionCode string) SessionKeys {
	salt := []byte(sessionCode)
	return SessionKeys{
		CmdKey:  hkdf16(keyBytes, salt, "cya-cmd"),
		RespKey: hkdf16(keyBytes, salt, "cya-resp"),
		MetaKey: hkdf16(keyBytes, salt, "cya-meta"),
	}
}

func EncryptAESGCM(key, plaintext, aad []byte) (string, string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", "", err
	}

	iv := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(iv); err != nil {
		return "", "", err
	}

	sealed := gcm.Seal(nil, iv, plaintext, aad)
	return base64.StdEncoding.EncodeToString(iv), base64.StdEncoding.EncodeToString(sealed), nil
}

func DecryptAESGCM(key []byte, ivB64, dataB64 string, aad []byte) ([]byte, error) {
	iv, err := base64.StdEncoding.DecodeString(ivB64)
	if err != nil {
		return nil, fmt.Errorf("invalid base64 iv: %w", err)
	}
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return nil, fmt.Errorf("invalid base64 data: %w", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}

	if len(iv) != gcm.NonceSize() {
		return nil, fmt.Errorf("invalid nonce length %d, expected %d", len(iv), gcm.NonceSize())
	}

	return gcm.Open(nil, iv, data, aad)
}
