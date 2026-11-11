/**
 * LOCAL EXPERIMENT (not upstream, unproven on hardware).
 *
 * Make-before-break E10 call rollover. Eufy's web signalling ends each E10 live
 * call after about 300 s (the web portal's own "5 minutes limitation"). This
 * keeps ONE persistent Annex-B H.264 output open for the media manager and
 * moves it between short calls:
 *
 *  - At callLimit - lead after the active call starts, open a standby call.
 *  - The standby's first output is its startup random-access unit (SPS+PPS+IDR,
 *    see NvrRtcSession #receiveE10Video). Output is spliced to the standby at the
 *    first unit that carries an IDR, and the old call is then closed (hang-up).
 *  - If the active call ends first (hang-up, failure), the standby (if any) takes
 *    over at its first IDR, otherwise a new call is placed at once, with backoff
 *    retries. The persistent output stays open throughout (no consumer EOF).
 *  - Never more than maxCalls (2) calls exist, counting calls still closing.
 *  - The output is ended with an error only after maxOutage without video, so the
 *    provider then retires the source exactly as before.
 *
 * Timestamps: the output is a raw Annex-B elementary stream without timestamps;
 * the media manager clocks units on arrival, so splicing at an IDR keeps the
 * downstream clock monotonic. Parameter-set changes are carried in-band at the
 * splice IDR.
 */
import { PassThrough } from "node:stream";

/** The parts of an E10 NvrRtcSession this controller drives. */
export interface E10Call {
  readonly output: PassThrough;
  readonly stats: object;
  readonly framingRejections: object;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface E10RolloverOptions {
  /** Construct (not start) call number index. Index 0 may reuse the view's context; later calls fetch a fresh one. */
  readonly create: (index: number) => Promise<E10Call>;
  /** The service's per-call limit. Default 300 000. */
  readonly callLimitMilliseconds?: number;
  /** Open the standby this long before the limit. Default 30 000. */
  readonly leadMilliseconds: number;
  /** Retry delays for a failed call; the last repeats. Default 2 s, 5 s, 10 s, 20 s. */
  readonly retryDelaysMilliseconds?: readonly number[];
  /** End the output after this long without any video. Default 60 000. */
  readonly maxOutageMilliseconds?: number;
  /** At most this many calls at once, including closing ones. Default 2. */
  readonly maxCalls?: number;
  /** A standby that has not produced an IDR in this time is abandoned. Default 25 000. */
  readonly standbyTimeoutMilliseconds?: number;
  readonly signal: AbortSignal;
  /** Called once, with the persistent output, after the first call delivers video. */
  readonly ready: (output: PassThrough, codec: () => "h264" | null) => void;
  readonly log?: (event: string, message: string) => void;
  readonly now?: () => number;
}

interface Slot { readonly index: number; readonly call: E10Call; readonly startedAt: number; ended: boolean; closing: boolean; idr: boolean; units: number;
  /** Units from the latest IDR, received before this call was given a role (bounded). */
  pending: Buffer[] }

export interface E10RolloverStats {
  e10Calls: number; e10Rollovers: number; e10Reconnects: number; e10CallFailures: number;
  e10MaxGapMs: number; e10UnitsOut: number; e10MaxConcurrentCalls: number;
}

/** True when an Annex-B unit contains an IDR slice (type 5). */
export function annexBHasIdr(unit: Buffer): boolean {
  for (let i = 0; i + 3 < unit.length; i++) {
    if (unit[i] === 0 && unit[i + 1] === 0 && (unit[i + 2] === 1 || unit[i + 2] === 0 && unit[i + 3] === 1)) {
      const at = unit[i + 2] === 1 ? i + 3 : i + 4;
      if (at < unit.length && (unit[at]! & 31) === 5) return true;
      i = at - 1;
    }
  }
  return false;
}

export class E10RollingSession {
  readonly output = new PassThrough({ highWaterMark: 4 * 1024 * 1024 + 64 });
  readonly rollover: E10RolloverStats = { e10Calls: 0, e10Rollovers: 0, e10Reconnects: 0, e10CallFailures: 0, e10MaxGapMs: 0, e10UnitsOut: 0, e10MaxConcurrentCalls: 0 };
  /** NvrRtcSession compatibility for provider code paths that E10 never admits. */
  readonly switchable = false;
  readonly controlStats = { panData: 0, panReceipts: 0, panAcknowledgedWithoutData: 0, panTimeouts: 0 };

  #active: Slot | null = null;
  #standby: Slot | null = null;
  #calls = new Set<Slot>();
  #next = 0;
  #retry = 0;
  #timer: NodeJS.Timeout | null = null;
  #outage: NodeJS.Timeout | null = null;
  #lastUnitAt: number | null = null;
  #retired = false;
  #closing: Promise<void> | null = null;
  #opening = false;

  constructor(readonly options: E10RolloverOptions) {
    options.signal.addEventListener("abort", () => { void this.close(); }, { once: true });
  }

  get #now(): number { return this.options.now?.() ?? performance.now(); }
  get #limit(): number { return this.options.callLimitMilliseconds ?? 300_000; }
  get #maxCalls(): number { return Math.min(2, Math.max(1, this.options.maxCalls ?? 2)); }

  /** Counters of the active call plus rollover counters, for the provider's failure line. */
  get stats(): Record<string, number> {
    return { ...(this.#active?.call.stats ?? this.#last?.call.stats ?? {}) as Record<string, number>, ...this.rollover };
  }
  #last: Slot | null = null;
  get framingRejections(): object { return this.#active?.call.framingRejections ?? {}; }
  get remainingLifetimeMilliseconds(): number { return 0; }
  canTakeOver(): boolean { return false; }
  async initialLiveSettings(): Promise<never> { throw new Error("E10 rollover has no live settings"); }

  /** Place the first call; resolves once it delivered video and the persistent output was reported. */
  async start(): Promise<void> {
    const slot = await this.#open();
    if (!slot) throw new Error("E10 rollover first call unavailable");
    this.#activate(slot);
    for (const unit of slot.pending.splice(0)) this.#write(unit);
    this.options.ready(this.output, () => "h264");
  }

  #log(event: string, message: string): void { try { this.options.log?.(event, message); } catch { /* never affects media */ } }

  /** Create and start one call, never exceeding maxCalls. Returns null on failure. */
  async #open(): Promise<Slot | null> {
    if (this.#retired || this.#calls.size >= this.#maxCalls || this.#opening) return null;
    this.#opening = true;
    const index = this.#next++;
    let call: E10Call;
    try { call = await this.options.create(index); }
    catch { this.#opening = false; this.rollover.e10CallFailures++; this.#log("e10_rollover_call_failed", `call=${index} stage=create`); if (index === 0) throw new Error("create"); return null; }
    const slot: Slot = { index, call, startedAt: this.#now, ended: false, closing: false, idr: false, units: 0, pending: [] };
    this.#calls.add(slot);
    this.rollover.e10Calls++;
    this.rollover.e10MaxConcurrentCalls = Math.max(this.rollover.e10MaxConcurrentCalls, this.#calls.size);
    call.output.on("error", () => { this.#ended(slot, "error"); });
    call.output.once("end", () => { this.#ended(slot, "end"); });
    call.output.once("close", () => { this.#ended(slot, "close"); });
    call.output.on("data", (unit: Buffer) => { this.#unit(slot, unit); });
    try { await call.start(); }
    catch (error) {
      this.#opening = false;
      this.rollover.e10CallFailures++;
      this.#log("e10_rollover_call_failed", `call=${index} stage=start reason=${(error as { reason?: string })?.reason ?? "unknown"} concurrent=${this.#calls.size}`);
      this.#ended(slot, "start_failed");
      if (index === 0) throw error;
      return null;
    }
    this.#opening = false;
    if (this.#retired) { void this.#closeSlot(slot); return null; }
    slot.ended ? null : this.#log("e10_rollover_call_started", `call=${index} concurrent=${this.#calls.size} since_start_ms=${Math.round(this.#now - slot.startedAt)}`);
    return slot.ended ? null : slot;
  }

  #activate(slot: Slot): void {
    this.#active = slot; this.#last = slot; this.#retry = 0;
    if (this.#timer) clearTimeout(this.#timer);
    const wait = Math.max(0, this.#limit - this.options.leadMilliseconds - (this.#now - slot.startedAt));
    this.#timer = setTimeout(() => { this.#timer = null; void this.#prepareStandby(); }, wait);
    this.#timer.unref?.();
  }

  async #prepareStandby(): Promise<void> {
    if (this.#retired || this.#standby || !this.#active) return;
    const standby = await this.#open();
    if (!standby) { this.#scheduleRetry("standby"); return; }
    if (this.#retired) return;
    this.#assignStandby(standby);
    if ((this.#standby as Slot | null) !== standby) return;
    const timeout = setTimeout(() => {
      if ((this.#standby as Slot | null) === standby && !standby.idr) {
        this.#log("e10_rollover_standby_timeout", `call=${standby.index}`);
        this.#standby = null; void this.#closeSlot(standby); this.#scheduleRetry("standby");
      }
    }, this.options.standbyTimeoutMilliseconds ?? 25_000);
    timeout.unref?.();
  }

  #assignStandby(slot: Slot): void {
    this.#standby = slot;
    if (slot.pending.length) this.#splice(slot, slot.pending.splice(0));
  }

  #scheduleRetry(kind: "standby" | "reconnect"): void {
    if (this.#retired || this.#timer) return;
    const delays = this.options.retryDelaysMilliseconds ?? [2_000, 5_000, 10_000, 20_000];
    const delay = delays[Math.min(this.#retry++, delays.length - 1)] ?? 5_000;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#active && !this.#active.ended) void this.#prepareStandby();
      else void this.#reconnect();
    }, delay);
    this.#timer.unref?.();
    this.#log("e10_rollover_retry", `kind=${kind} delay_ms=${delay} attempt=${this.#retry}`);
  }

  #unit(slot: Slot, unit: Buffer): void {
    if (this.#retired) return;
    slot.units++;
    if (slot === this.#active) { this.#write(unit); return; }
    const idr = annexBHasIdr(unit);
    if (slot !== this.#standby) {
      // No role yet (still starting): keep units from the latest IDR so nothing is lost.
      if (idr) slot.pending = [unit];
      else if (slot.pending.length && slot.pending.length < 256) slot.pending.push(unit);
      return;
    }
    if (!idr) return;
    this.#splice(slot, [unit]);
  }

  /** Make a standby the active call from an IDR-led run of units, then retire the old call. */
  #splice(slot: Slot, units: Buffer[]): void {
    // Splice: the standby's IDR (with in-band SPS/PPS) becomes the next output unit.
    slot.idr = true;
    slot.pending = [];
    const old = this.#active;
    this.#standby = null;
    this.#activate(slot);
    for (const unit of units) this.#write(unit);
    if (old) {
      this.rollover.e10Rollovers++;
      this.#log("e10_rollover_spliced", `from=${old.index} to=${slot.index} old_age_ms=${Math.round(this.#now - old.startedAt)} old_ended=${old.ended} rollovers=${this.rollover.e10Rollovers}`);
      void this.#closeSlot(old);
    } else {
      this.rollover.e10Reconnects++;
      this.#log("e10_rollover_reconnected", `call=${slot.index} reconnects=${this.rollover.e10Reconnects}`);
    }
  }

  #write(unit: Buffer): void {
    const now = this.#now;
    if (this.#lastUnitAt !== null) this.rollover.e10MaxGapMs = Math.max(this.rollover.e10MaxGapMs, Math.round(now - this.#lastUnitAt));
    this.#lastUnitAt = now;
    this.rollover.e10UnitsOut++;
    if (this.#outage) { clearTimeout(this.#outage); this.#outage = null; }
    // Never destroy on backpressure; the media manager drains or retires the source itself.
    this.output.write(unit);
  }

  #ended(slot: Slot, how: string): void {
    if (slot.ended) return;
    slot.ended = true;
    if (!slot.closing) void this.#closeSlot(slot);
    if (this.#retired) return;
    if (slot === this.#standby) {
      this.#standby = null;
      this.#log("e10_rollover_standby_ended", `call=${slot.index} how=${how}`);
      this.#scheduleRetry("standby");
      return;
    }
    if (slot !== this.#active || slot.closing && !this.#calls.has(slot)) return;
    this.#active = null;
    this.#log("e10_rollover_active_ended", `call=${slot.index} how=${how} age_ms=${Math.round(this.#now - slot.startedAt)} standby=${this.#standby ? "pending" : "none"}`);
    this.#armOutage();
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    if (!this.#standby) void this.#reconnect();
    // Otherwise the standby takes over at its first IDR (its activation re-arms the timer).
  }

  async #reconnect(): Promise<void> {
    if (this.#retired || this.#active || this.#standby) return;
    this.#armOutage();
    // A standby already being placed becomes the replacement at its first IDR.
    if (this.#opening) return;
    const slot = await this.#open();
    if (this.#retired) return;
    if (!slot) { this.#scheduleRetry("reconnect"); return; }
    // Treat the new call as a standby so output resumes exactly at its IDR.
    this.#assignStandby(slot);
  }

  #armOutage(): void {
    if (this.#outage || this.#retired) return;
    this.#outage = setTimeout(() => {
      this.#outage = null;
      if (this.#retired || this.#active) return;
      this.#log("e10_rollover_gave_up", `max_outage_ms=${this.options.maxOutageMilliseconds ?? 60_000} calls=${this.rollover.e10Calls}`);
      const error = Object.assign(new Error("E10 rollover outage"), { stage: "video", reason: "video_progress_timeout" });
      this.output.destroy(error);
      void this.close();
    }, this.options.maxOutageMilliseconds ?? 60_000);
    this.#outage.unref?.();
  }

  async #closeSlot(slot: Slot): Promise<void> {
    if (slot.closing) return;
    slot.closing = true;
    // A deliberate close of an old call is not an outage.
    if (!slot.call.output.listenerCount("error")) slot.call.output.on("error", () => {});
    try { await slot.call.close(); } catch { /* retired either way */ }
    this.#calls.delete(slot);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#retired = true;
    if (this.#timer) clearTimeout(this.#timer);
    if (this.#outage) clearTimeout(this.#outage);
    this.#timer = this.#outage = null;
    this.#closing = (async () => {
      await Promise.all([...this.#calls].map(slot => this.#closeSlot(slot)));
      this.#active = this.#standby = null;
      if (!this.output.destroyed) this.output.end();
    })();
    return this.#closing;
  }
}
