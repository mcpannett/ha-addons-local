/**
 * LOCAL EXPERIMENT (e10x7). Value-free description of the media route an E10
 * call ended up using, so the log shows whether video stayed on the LAN.
 * No addresses, ports or credentials leave this module: only candidate types
 * and a LAN yes/no.
 */

export type E10CandidateType = "host" | "srflx" | "prflx" | "relay" | "unknown";

export interface E10RouteSummary {
  readonly local: E10CandidateType;
  readonly remote: E10CandidateType;
  /** True only when both ends are host candidates and the camera's address is private. */
  readonly lan: boolean;
  /** "lan" (direct on the home network), "nat" (direct, via router mapping) or "relay" (through the service's TURN relay). */
  readonly path: "lan" | "nat" | "relay" | "unknown";
}

/** The parts of a werift candidate this module reads. */
export interface E10CandidateLike { readonly type?: unknown; readonly host?: unknown }

const TYPES = new Set(["host", "srflx", "prflx", "relay"]);

export function e10CandidateType(candidate: E10CandidateLike | null | undefined): E10CandidateType {
  const type = candidate?.type;
  return typeof type === "string" && TYPES.has(type) ? type as E10CandidateType : "unknown";
}

/** RFC 1918, RFC 6598 (CGNAT excluded: not a home LAN), link-local and IPv6 ULA/link-local. */
export function e10PrivateAddress(host: unknown): boolean {
  if (typeof host !== "string") return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if ([a, b, Number(v4[3]), Number(v4[4])].some(part => part > 255)) return false;
    return a === 10 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 169 && b === 254;
  }
  const v6 = host.toLowerCase();
  return /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}

export function e10RouteSummary(local: E10CandidateLike | null | undefined, remote: E10CandidateLike | null | undefined): E10RouteSummary {
  const l = e10CandidateType(local), r = e10CandidateType(remote);
  const lan = l === "host" && r === "host" && e10PrivateAddress(remote?.host);
  const path = l === "unknown" || r === "unknown" ? "unknown"
    : l === "relay" || r === "relay" ? "relay"
      : lan ? "lan" : "nat";
  return { local: l, remote: r, lan, path };
}

export function e10RouteLine(summary: E10RouteSummary): string {
  return `path=${summary.path} local=${summary.local} remote=${summary.remote} lan=${summary.lan}`;
}

/** Remove TURN relays from an ICE server list when the no-relay option is on. */
export function e10IceServers<T>(servers: readonly T[], noRelay: boolean): T[] {
  return noRelay ? [] : [...servers];
}
