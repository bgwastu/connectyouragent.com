import { expect, test } from "bun:test";
import * as store from "./store.ts";
import { handleJoin } from "./relay.ts";

function wsStub() {
  return {
    data: undefined as unknown,
    sent: [] as string[],
    closed: false,
    send(message: string) { this.sent.push(message); },
    close() { this.closed = true; },
  };
}

test("rejects a second agent for the same session code", () => {
  const code = "a1b2c3d4e5f6";
  store.close(code); // cleanup from previous runs
  store.create(code);

  const first = wsStub();
  const second = wsStub();

  handleJoin(first as never, { type: "join", session: code, role: "agent", meta: { host: "test" } });
  handleJoin(second as never, { type: "join", session: code, role: "agent", meta: { host: "test2" } });

  expect(first.closed).toBe(false);
  expect(second.closed).toBe(true);
  expect(second.sent.join("\n")).toContain("Agent already connected");

  store.close(code);
});
