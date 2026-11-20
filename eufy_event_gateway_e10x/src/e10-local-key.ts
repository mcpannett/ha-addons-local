/**
 * LOCAL EXPERIMENT (e10x7). Optional fixed key for E10 live URLs, so go2rtc or
 * Frigate can keep one stable LAN URL instead of short-lived stream tokens.
 * Off unless the user sets a key of at least 24 characters. The key is never logged.
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const E10_LOCAL_KEY_QUERY = "key";
/** Only these stream formats accept the key; controls and other APIs never do. */
export const E10_LOCAL_KEY_FORMATS: readonly string[] = ["live.ts", "live.h264"];

/** Accept a configured key only if it is long enough and printable ASCII without spaces. */
export function e10LocalKeyConfig(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const key = value.trim();
  return key.length >= 24 && key.length <= 256 && /^[\x21-\x7e]+$/.test(key) ? key : null;
}

/** Constant-time comparison that does not leak the key length. */
export function e10LocalKeyMatches(configured: string | null, supplied: readonly string[]): boolean {
  const value = supplied.length === 1 ? supplied[0] : undefined;
  if (!configured || typeof value !== "string") return false;
  const a = createHash("sha256").update(configured).digest();
  const b = createHash("sha256").update(value).digest();
  return timingSafeEqual(a, b);
}

/** Decide whether one request may use the key: E10 camera, stream format, GET, key matches. */
export function e10LocalKeyAuthorizes(input: {
  readonly configured: string | null; readonly method: string | undefined; readonly segments: readonly string[];
  readonly supplied: readonly string[]; readonly isE10: (serial: string) => boolean;
}): boolean {
  const { configured, method, segments, supplied, isE10 } = input;
  return !!configured && method === "GET" && segments.length === 4 && segments[0] === "api" && segments[1] === "cameras"
    && E10_LOCAL_KEY_FORMATS.includes(segments[3]!) && isE10(segments[2]!) && e10LocalKeyMatches(configured, supplied);
}
