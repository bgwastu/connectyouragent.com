import { expect, test } from "bun:test";
import { createSession, db } from "./db.ts";
import { getOrCreateSlot, handleJoin, removeSlot } from "./relay.ts";

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
  db.prepare("DELETE FROM audit_log WHERE session_code = ?").run(code);
  db.prepare("DELETE FROM sessions WHERE code = ?").run(code);
  createSession(code);
  getOrCreateSlot(code);

  const first = wsStub();
  const second = wsStub();

  handleJoin(first as never, { type: "join", session: code, role: "agent" });
  handleJoin(second as never, { type: "join", session: code, role: "agent" });

  expect(first.closed).toBe(false);
  expect(second.closed).toBe(true);
  expect(second.sent.join("\n")).toContain("Agent already connected");

  removeSlot(code, "test_cleanup");
});
