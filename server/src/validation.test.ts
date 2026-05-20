import { expect, test } from "bun:test";
import { generateCode } from "./api.ts";
import { isSessionCode } from "./relay.ts";

test("isSessionCode accepts exactly six digits", () => {
  expect(isSessionCode("123456")).toBe(true);
  expect(isSessionCode("000000")).toBe(true);
  expect(isSessionCode("12345")).toBe(false);
  expect(isSessionCode("1234567")).toBe(false);
  expect(isSessionCode("abc123")).toBe(false);
});

test("generateCode returns a six digit session code", () => {
  for (let i = 0; i < 20; i++) {
    expect(isSessionCode(generateCode())).toBe(true);
  }
});
