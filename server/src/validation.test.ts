import { expect, test } from "bun:test";
import { generateCode } from "./api.ts";
import { isSessionCode } from "./relay.ts";

test("isSessionCode accepts passphrase codes", () => {
  expect(isSessionCode("sage-daffodil-antirust4321")).toBe(true);
  expect(isSessionCode("quintuple-henna-gab9876")).toBe(true);
  expect(isSessionCode("123456")).toBe(false);
  expect(isSessionCode("sage-daffodil-antirust")).toBe(false);
  expect(isSessionCode("sage-daffodil-antirust4")).toBe(false);
  expect(isSessionCode("Sage-daffodil-antirust4321")).toBe(false);
});

test("generateCode returns a passphrase session code", () => {
  for (let i = 0; i < 20; i++) {
    expect(isSessionCode(generateCode())).toBe(true);
  }
});
