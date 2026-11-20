import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Socket } from "node:dgram";
import { e10LanProbe, e10LanProbeLine, e10ReplyHasIdentity } from "../src/stream/e10-lan-probe.ts";

const E10 = "192.168.1.55";
const identityReply = Buffer.concat([Buffer.from([0xf1, 0x41, 0x00, 0x14]), Buffer.from("EUPRAKM\0", "latin1"), Buffer.from([0, 1, 2, 3]), Buffer.from("ABCDEFGH", "latin1")]);

/** Fake UDP socket: records sends and optionally answers from a given address. */
function fakeSocket(answer: (to: string) => { from: string; message: Buffer }[]) {
  const sent: { bytes: Buffer; port: number; host: string }[] = [];
  const socket = Object.assign(new EventEmitter(), {
    closed: false,
    bind(_port: number, cb: () => void) { setImmediate(cb); },
    send(bytes: Buffer, port: number, host: string) {
      sent.push({ bytes: Buffer.from(bytes), port, host });
      for (const reply of answer(host)) setTimeout(() => socket.emit("message", reply.message, { address: reply.from }), 5);
    },
    close() { socket.closed = true; },
  });
  return { socket, sent };
}

test("reports an answering E10 without exposing its identity", async () => {
  const { socket, sent } = fakeSocket(host => host === E10 ? [{ from: E10, message: identityReply }] : []);
  const result = await e10LanProbe({ address: E10, target: "inventory", timeoutMilliseconds: 500, socket: () => socket as unknown as Socket });
  assert.equal(result.answered, true);
  assert.equal(result.replyType, "0x41");
  assert.equal(result.identity, true);
  assert.equal(result.replyBytes, identityReply.length);
  assert.ok(sent.every(s => s.port === 32108 && s.host === E10 && s.bytes.equals(Buffer.from([0xf1, 0x30, 0, 0]))), "only LAN search sent");
  assert.ok(socket.closed);
  const line = e10LanProbeLine(result);
  assert.ok(!line.includes("EUPRAKM") && !line.includes(E10) && !line.includes("ABCDEFGH"));
});

test("silence means not answered", async () => {
  const { socket } = fakeSocket(() => []);
  const result = await e10LanProbe({ address: E10, target: "configured", timeoutMilliseconds: 300, socket: () => socket as unknown as Socket });
  assert.equal(result.answered, false);
  assert.equal(result.replyType, null);
  assert.ok(socket.closed);
});

test("replies from other devices are counted, not mistaken for the E10", async () => {
  const { socket } = fakeSocket(() => [{ from: "192.168.1.60", message: identityReply }]);
  const result = await e10LanProbe({ address: E10, target: "inventory", timeoutMilliseconds: 300, socket: () => socket as unknown as Socket });
  assert.equal(result.answered, false);
  assert.ok(result.otherReplies >= 1);
});

test("refuses public, missing or IPv6 targets without sending", async () => {
  for (const address of [null, "8.8.8.8", "fd00::1"]) {
    const { socket, sent } = fakeSocket(() => []);
    const result = await e10LanProbe({ address, target: "configured", socket: () => socket as unknown as Socket });
    assert.equal(result.target, "none");
    assert.equal(sent.length, 0);
  }
});

test("identity detection", () => {
  assert.ok(e10ReplyHasIdentity(identityReply));
  assert.ok(!e10ReplyHasIdentity(Buffer.from([0xf1, 0x41, 0, 0])));
});
