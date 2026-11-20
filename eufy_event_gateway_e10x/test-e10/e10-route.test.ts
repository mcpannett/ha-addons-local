import { test } from "node:test";
import assert from "node:assert/strict";
import { e10IceServers, e10PrivateAddress, e10RouteLine, e10RouteSummary } from "../src/stream/e10-route.ts";

test("host to private host is a LAN route", () => {
  const s = e10RouteSummary({ type: "host", host: "192.168.1.20" }, { type: "host", host: "192.168.1.55" });
  assert.deepEqual(s, { local: "host", remote: "host", lan: true, path: "lan" });
  assert.equal(e10RouteLine(s), "path=lan local=host remote=host lan=true");
});

test("relay on either end is a relay route", () => {
  assert.equal(e10RouteSummary({ type: "relay", host: "1.2.3.4" }, { type: "host", host: "192.168.1.55" }).path, "relay");
  assert.equal(e10RouteSummary({ type: "host", host: "192.168.1.2" }, { type: "relay", host: "5.6.7.8" }).path, "relay");
});

test("prflx camera with a private address is LAN (seen on real E10)", () => {
  const s = e10RouteSummary({ type: "host", host: "192.168.1.20" }, { type: "prflx", host: "192.168.1.55" });
  assert.deepEqual(s, { local: "host", remote: "prflx", lan: true, path: "lan" });
});

test("prflx camera with a public address stays NAT", () => {
  assert.equal(e10RouteSummary({ type: "host", host: "192.168.1.20" }, { type: "prflx", host: "81.2.3.4" }).path, "nat");
});

test("direct but not private is NAT", () => {
  assert.equal(e10RouteSummary({ type: "srflx" }, { type: "srflx", host: "81.2.3.4" }).path, "nat");
  assert.equal(e10RouteSummary({ type: "host" }, { type: "host", host: "81.2.3.4" }).path, "nat");
});

test("missing or odd candidates are unknown, never throw", () => {
  assert.equal(e10RouteSummary(undefined, null).path, "unknown");
  assert.equal(e10RouteSummary({ type: 7 }, { type: "host" }).path, "unknown");
});

test("private address ranges", () => {
  for (const host of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "fd12:3456::1", "fe80::1"]) assert.ok(e10PrivateAddress(host), host);
  for (const host of ["172.32.0.1", "8.8.8.8", "100.64.0.1", "999.1.1.1", "2001:db8::1", "", 5]) assert.ok(!e10PrivateAddress(host), String(host));
});

test("route line never contains an address", () => {
  const line = e10RouteLine(e10RouteSummary({ type: "host", host: "192.168.1.20" }, { type: "host", host: "192.168.1.55" }));
  assert.ok(!/\d+\.\d+\.\d+\.\d+/.test(line));
});

test("no-relay removes TURN servers only when on", () => {
  const servers = [{ urls: "turn:x:3478" }];
  assert.deepEqual(e10IceServers(servers, false), servers);
  assert.deepEqual(e10IceServers(servers, true), []);
});
