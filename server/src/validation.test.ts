import { expect, test } from "bun:test";
import { generateCode } from "./api.ts";
import { isSessionCode } from "./store.ts";

test("isSessionCode accepts 12-char hex codes", () => {
  expect(isSessionCode("a1b2c3d4e5f6")).toBe(true);
  expect(isSessionCode("123456789012")).toBe(true);
  expect(isSessionCode("abcdefabcdef")).toBe(true);
  expect(isSessionCode("a1b2c3d4e5f")).toBe(false);
  expect(isSessionCode("a1b2c3d4e5f6g")).toBe(false);
  expect(isSessionCode("A1b2c3d4e5f6")).toBe(false);
});

test("generateCode returns valid 12-char hex session code", () => {
  for (let i = 0; i < 20; i++) {
    expect(isSessionCode(generateCode())).toBe(true);
  }
});
