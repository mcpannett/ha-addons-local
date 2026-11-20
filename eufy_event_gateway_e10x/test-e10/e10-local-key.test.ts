import { test } from "node:test";
import assert from "node:assert/strict";
import { e10LocalKeyAuthorizes, e10LocalKeyConfig, e10LocalKeyMatches } from "../src/e10-local-key.ts";

const KEY = "a-long-local-stream-key-1234";
const isE10 = (serial: string) => serial === "T8404E10";
const base = { configured: KEY, method: "GET", supplied: [KEY], isE10 };

test("config: off when empty, short or containing spaces", () => {
  assert.equal(e10LocalKeyConfig(undefined), null);
  assert.equal(e10LocalKeyConfig(""), null);
  assert.equal(e10LocalKeyConfig("short"), null);
  assert.equal(e10LocalKeyConfig("has a space in the key 12345"), null);
  assert.equal(e10LocalKeyConfig(`  ${KEY}  `), KEY);
});

test("matches only the exact key, once", () => {
  assert.ok(e10LocalKeyMatches(KEY, [KEY]));
  assert.ok(!e10LocalKeyMatches(KEY, [KEY + "x"]));
  assert.ok(!e10LocalKeyMatches(KEY, [KEY, KEY]));
  assert.ok(!e10LocalKeyMatches(KEY, []));
  assert.ok(!e10LocalKeyMatches(null, [KEY]));
});

test("authorizes E10 live.ts and live.h264 GETs", () => {
  for (const format of ["live.ts", "live.h264"]) {
    assert.ok(e10LocalKeyAuthorizes({ ...base, segments: ["api", "cameras", "T8404E10", format] }), format);
  }
});

test("refuses other cameras, formats, methods and paths", () => {
  assert.ok(!e10LocalKeyAuthorizes({ ...base, segments: ["api", "cameras", "OTHER", "live.ts"] }));
  assert.ok(!e10LocalKeyAuthorizes({ ...base, segments: ["api", "cameras", "T8404E10", "snapshot.jpg"] }));
  assert.ok(!e10LocalKeyAuthorizes({ ...base, segments: ["api", "cameras", "T8404E10", "settings"] }));
  assert.ok(!e10LocalKeyAuthorizes({ ...base, method: "POST", segments: ["api", "cameras", "T8404E10", "live.ts"] }));
  assert.ok(!e10LocalKeyAuthorizes({ ...base, segments: ["api", "cameras", "T8404E10", "live.ts", "x"] }));
  assert.ok(!e10LocalKeyAuthorizes({ ...base, configured: null, segments: ["api", "cameras", "T8404E10", "live.ts"] }));
});
