/**
 * LOCAL EXPERIMENT (e10x7). Read-only LAN probe: does the E10 answer the PPCS
 * local lookup that other Eufy cameras answer on UDP 32108?
 *
 * Sends only the 4-byte LAN search (F1 30 00 00) to the E10's private address,
 * listens briefly, and reports value-free facts: answered or not, reply type and
 * length, and whether the reply carries a PPCS identity. It never sends a check,
 * key or command, never logs addresses or identities, and opens no session.
 */
import { createSocket, type Socket } from "node:dgram";
import { e10PrivateAddress } from "./e10-route.js";

export const E10_LAN_PROBE_PORT = 32_108;
const LAN_SEARCH = Buffer.from([0xf1, 0x30, 0x00, 0x00]);

export interface E10LanProbeResult {
  readonly target: "inventory" | "configured" | "none";
  readonly answered: boolean;
  /** Second byte of the first reply from the E10's address, e.g. 0x41 = local lookup reply. */
  readonly replyType: string | null;
  readonly replyBytes: number;
  /** Reply contains a PPCS identity block (prefix + serial), without revealing it. */
  readonly identity: boolean;
  /** Replies from other devices (other Eufy cameras answer too); counted, never identified. */
  readonly otherReplies: number;
  readonly elapsedMs: number;
}

export interface E10LanProbeOptions {
  readonly address: string | null;
  readonly target: "inventory" | "configured";
  readonly timeoutMilliseconds?: number;
  readonly socket?: () => Socket;
  readonly now?: () => number;
}

/** A PPCS identity block: 8-byte ASCII prefix area starting with letters, then a 4-byte serial. */
export function e10ReplyHasIdentity(message: Buffer): boolean {
  if (message.length < 4 + 8 + 4) return false;
  const prefix = message.subarray(4, 12);
  const letters = prefix.subarray(0, 3).toString("latin1");
  return /^[A-Z]{3}$/.test(letters);
}

export function e10LanProbeLine(result: E10LanProbeResult): string {
  return `target=${result.target} answered=${result.answered} reply_type=${result.replyType ?? "none"} reply_bytes=${result.replyBytes}`
    + ` identity=${result.identity} other_replies=${result.otherReplies} elapsed_ms=${result.elapsedMs}`;
}

export async function e10LanProbe(options: E10LanProbeOptions): Promise<E10LanProbeResult> {
  const now = options.now ?? (() => performance.now());
  const started = now();
  const address = options.address;
  if (!address || !e10PrivateAddress(address) || address.includes(":")) {
    return { target: "none", answered: false, replyType: null, replyBytes: 0, identity: false, otherReplies: 0, elapsedMs: 0 };
  }
  const socket = (options.socket ?? (() => createSocket("udp4")))();
  let first: Buffer | null = null;
  let others = 0;
  let firstLength = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, Math.min(Math.max(options.timeoutMilliseconds ?? 3_000, 200), 10_000));
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.on("message", (message: Buffer, info: { address: string }) => {
        if (info.address !== address) { others++; return; }
        if (!first && message.length >= 2 && message[0] === 0xf1) {
          first = Buffer.from(message.subarray(0, Math.min(message.length, 64)));
          firstLength = message.length;
          clearTimeout(timer);
          // Short tail so a second reply type is not mistaken for silence.
          setTimeout(resolve, 100);
        }
      });
      socket.bind(0, () => {
        try {
          for (let i = 0; i < 3; i++) setTimeout(() => socket.send(LAN_SEARCH, E10_LAN_PROBE_PORT, address), i * 300);
        } catch (error) { clearTimeout(timer); reject(error as Error); }
      });
    });
  } finally {
    try { socket.close(); } catch { /* already closed */ }
  }
  const reply = first as Buffer | null;
  return {
    target: options.target,
    answered: reply !== null,
    replyType: reply ? `0x${reply[1]!.toString(16).padStart(2, "0")}` : null,
    replyBytes: reply ? firstLength : 0,
    identity: reply ? e10ReplyHasIdentity(reply) : false,
    otherReplies: others,
    elapsedMs: Math.round(now() - started),
  };
}
