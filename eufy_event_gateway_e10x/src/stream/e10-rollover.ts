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
  /**
   * 0004: "overlap" = make-before-break (two calls for a few seconds, as in 0003).
   * "sequential" = hang the old call up first, then place the next one (never two
   * calls on the camera; a short gap, output stays open). Default "overlap".
   */
  readonly mode?: "overlap" | "sequential";
  /** 0004: in sequential mode, wait at most this long for the old call's hang-up before placing the next. Default 2 000. */
  readonly sequentialCloseWaitMilliseconds?: number;
  /**
   * 0004 health guard for a call that became active after a splice or reconnect.
   * During healthWatchMilliseconds after activation, the call is "degraded" if a
   * healthWindowMilliseconds window has fewer than healthMinUnits units, or if no
   * further IDR arrives within healthIdrDeadlineMilliseconds. A degraded call is
   * hung up and replaced by a fresh call (sequential), and an overlap session
   * switches to sequential. 0 healthWatchMilliseconds disables the guard.
   */
  readonly healthWatchMilliseconds?: number;
  readonly healthWindowMilliseconds?: number;
  readonly healthMinUnits?: number;
  readonly healthIdrDeadlineMilliseconds?: number;
  /** Stop replacing after this many consecutive degraded calls. Default 3. */
  readonly maxDegradedReplacements?: number;
  /** 0004 diagnostics: log value-free per-call windows for this long after activation. Default 60 000 (0 = off). */
  readonly diagnosticsMilliseconds?: number;
  readonly diagnosticsWindowMilliseconds?: number;
  /** 0005: a call was refused (failed at stage=call, or failed without any media/offer). Value-free detail. */
  readonly onRefused?: (detail: string) => void;
  /** 0005: a call started and delivered its first unit (used to reset the refusal backoff). */
  readonly onCallStarted?: (index: number) => void;
}

/** Value-free per-call counters for one diagnostics window. */
interface CallWindow { units: number; bytes: number; idr: number; maxGapMs: number; lastAt: number | null; nal: Map<number, number> }
const newWindow = (): CallWindow => ({ units: 0, bytes: 0, idr: 0, maxGapMs: 0, lastAt: null, nal: new Map() });

/** NAL unit types in an Annex-B unit (no payload bytes are kept). */
export function annexBNalTypes(unit: Buffer): number[] {
  const types: number[] = [];
  for (let i = 0; i + 3 < unit.length; i++) {
    if (unit[i] === 0 && unit[i + 1] === 0 && (unit[i + 2] === 1 || unit[i + 2] === 0 && unit[i + 3] === 1)) {
      const at = unit[i + 2] === 1 ? i + 3 : i + 4;
      if (at < unit.length) types.push(unit[at]! & 31);
      i = at - 1;
    }
  }
  return types;
}

interface Slot { readonly index: number; readonly call: E10Call; readonly startedAt: number; ended: boolean; closing: boolean; idr: boolean; units: number;
  /** 0004: activation time, IDR bookkeeping and the current diagnostics/health windows. */
  activatedAt: number | null; lastIdrAt: number | null; window: CallWindow; health: CallWindow; diagTimer: NodeJS.Timeout | null; healthTimer: NodeJS.Timeout | null;
  packetsAtWindow: number; recoveriesAtWindow: number;
  /** Units from the latest IDR, received before this call was given a role (bounded). */
  pending: Buffer[] }

export interface E10RolloverStats {
  e10Calls: number; e10Rollovers: number; e10Reconnects: number; e10CallFailures: number;
  e10MaxGapMs: number; e10UnitsOut: number; e10MaxConcurrentCalls: number;
  e10SequentialRolls: number; e10DegradedCalls: number;
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
  readonly rollover: E10RolloverStats = { e10Calls: 0, e10Rollovers: 0, e10Reconnects: 0, e10CallFailures: 0, e10MaxGapMs: 0, e10UnitsOut: 0, e10MaxConcurrentCalls: 0,
    e10SequentialRolls: 0, e10DegradedCalls: 0 };
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
  #mode: "overlap" | "sequential";
  #degradedStreak = 0;

  constructor(readonly options: E10RolloverOptions) {
    this.#mode = options.mode === "sequential" ? "sequential" : "overlap";
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
    this.#activate(slot, "first");
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
    const slot: Slot = { index, call, startedAt: this.#now, ended: false, closing: false, idr: false, units: 0, pending: [],
      activatedAt: null, lastIdrAt: null, window: newWindow(), health: newWindow(), diagTimer: null, healthTimer: null, packetsAtWindow: 0, recoveriesAtWindow: 0 };
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
      const failure = error as { stage?: string; reason?: string };
      const media = this.#stat(slot, "packets") + this.#stat(slot, "video");
      if (failure?.stage === "call" || failure?.stage !== "cancelled" && media === 0) {
        try { this.options.onRefused?.(`call=${index} stage=${failure?.stage ?? "unknown"} reason=${failure?.reason ?? "unknown"}`); } catch { /* never affects media */ }
      }
      this.#ended(slot, "start_failed");
      if (index === 0) throw error;
      return null;
    }
    this.#opening = false;
    if (this.#retired) { void this.#closeSlot(slot); return null; }
    if (!slot.ended) { try { this.options.onCallStarted?.(index); } catch { /* never affects media */ } }
    slot.ended ? null : this.#log("e10_rollover_call_started", `call=${index} concurrent=${this.#calls.size} since_start_ms=${Math.round(this.#now - slot.startedAt)}`);
    return slot.ended ? null : slot;
  }

  #activate(slot: Slot, how: "first" | "splice" | "reconnect"): void {
    this.#active = slot; this.#last = slot; this.#retry = 0;
    slot.activatedAt = this.#now;
    if (this.#timer) clearTimeout(this.#timer);
    const wait = Math.max(0, this.#limit - this.options.leadMilliseconds - (this.#now - slot.startedAt));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#mode === "sequential") void this.#sequentialRoll(); else void this.#prepareStandby();
    }, wait);
    this.#timer.unref?.();
    if (how !== "first") { this.#startDiagnostics(slot, how); this.#startHealth(slot); }
  }

  /** 0004: hang up the active call first, then place the next (no concurrent calls). */
  async #sequentialRoll(): Promise<void> {
    const old = this.#active;
    if (this.#retired || !old || this.#standby) return;
    this.rollover.e10SequentialRolls++;
    this.#log("e10_rollover_sequential", `from=${old.index} age_ms=${Math.round(this.#now - old.startedAt)} rolls=${this.rollover.e10SequentialRolls}`);
    if ((this.options.diagnosticsMilliseconds ?? 60_000) > 0) this.#log("e10_call_window", this.#windowLine(old, "before_sequential"));
    await this.#retireActive(old);
    void this.#reconnect();
  }

  /** Drop the active call without an outage verdict, waiting a bounded time for its hang-up. */
  async #retireActive(slot: Slot): Promise<void> {
    if (this.#active === slot) this.#active = null;
    this.#stopSlotTimers(slot);
    this.#armOutage();
    const wait = this.options.sequentialCloseWaitMilliseconds ?? 2_000;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.#closeSlot(slot), new Promise<void>(resolve => { timer = setTimeout(resolve, wait); timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
  }

  #stopSlotTimers(slot: Slot): void {
    if (slot.diagTimer) clearInterval(slot.diagTimer);
    if (slot.healthTimer) clearInterval(slot.healthTimer);
    slot.diagTimer = slot.healthTimer = null;
  }

  #stat(slot: Slot, key: string): number {
    const value = (slot.call.stats as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  }

  /** 0004: value-free per-call window line (counts only). */
  #windowLine(slot: Slot, phase: string): string {
    const w = slot.window;
    const nal = [...w.nal.entries()].sort((a, b) => a[0] - b[0]).map(([type, count]) => `${type}:${count}`).join(",") || "none";
    const packets = this.#stat(slot, "packets"), recoveries = this.#stat(slot, "videoSequenceRecoveries");
    const line = `call=${slot.index} phase=${phase} age_ms=${Math.round(this.#now - slot.startedAt)} units=${w.units} bytes=${w.bytes} idr=${w.idr}`
      + ` max_gap_ms=${Math.round(w.maxGapMs)} nal=${nal} packets_delta=${packets - slot.packetsAtWindow} seq_recoveries_delta=${recoveries - slot.recoveriesAtWindow}`
      + ` concurrent=${this.#calls.size}`;
    slot.window = newWindow(); slot.packetsAtWindow = packets; slot.recoveriesAtWindow = recoveries;
    return line;
  }

  #startDiagnostics(slot: Slot, how: string): void {
    const total = this.options.diagnosticsMilliseconds ?? 60_000;
    if (total <= 0) return;
    const every = Math.max(100, this.options.diagnosticsWindowMilliseconds ?? 10_000);
    slot.window = newWindow(); slot.packetsAtWindow = this.#stat(slot, "packets"); slot.recoveriesAtWindow = this.#stat(slot, "videoSequenceRecoveries");
    let elapsed = 0;
    slot.diagTimer = setInterval(() => {
      elapsed += every;
      if (this.#retired || slot.closing) { this.#stopSlotTimers(slot); return; }
      this.#log("e10_call_window", this.#windowLine(slot, `after_${how}_${Math.round(elapsed / 1000)}s`));
      if (elapsed >= total && slot.diagTimer) { clearInterval(slot.diagTimer); slot.diagTimer = null; }
    }, every);
    slot.diagTimer.unref?.();
  }

  #startHealth(slot: Slot): void {
    const watch = this.options.healthWatchMilliseconds ?? 30_000;
    if (watch <= 0) return;
    const windowMs = Math.max(100, this.options.healthWindowMilliseconds ?? 5_000);
    const minUnits = this.options.healthMinUnits ?? 10;
    const idrDeadline = this.options.healthIdrDeadlineMilliseconds ?? 8_000;
    const activatedAt = slot.activatedAt ?? this.#now;
    slot.health = newWindow();
    let windowStart = activatedAt;
    const tick = Math.max(50, Math.min(1_000, Math.floor(windowMs / 5)));
    slot.healthTimer = setInterval(() => {
      if (this.#retired || slot !== this.#active || slot.closing) { if (slot.healthTimer) clearInterval(slot.healthTimer); slot.healthTimer = null; return; }
      const now = this.#now;
      let reason: string | null = null;
      if (now - windowStart >= windowMs) {
        if (slot.health.units < minUnits) reason = `low_rate units=${slot.health.units} window_ms=${windowMs}`;
        slot.health = newWindow(); windowStart = now;
      }
      if (!reason && now - activatedAt >= idrDeadline && (slot.lastIdrAt === null || slot.lastIdrAt <= activatedAt)) reason = `no_idr after_ms=${Math.round(now - activatedAt)}`;
      if (reason) { void this.#degraded(slot, reason); return; }
      if (now - activatedAt >= watch) {
        if (slot.healthTimer) clearInterval(slot.healthTimer); slot.healthTimer = null;
        this.#degradedStreak = 0;
      }
    }, tick);
    slot.healthTimer.unref?.();
  }

  /** 0004: replace a degraded active call with a fresh call, never two at once. */
  async #degraded(slot: Slot, reason: string): Promise<void> {
    if (this.#retired || slot !== this.#active) return;
    this.#stopSlotTimers(slot);
    this.rollover.e10DegradedCalls++;
    this.#degradedStreak++;
    const limit = this.options.maxDegradedReplacements ?? 3;
    if (this.#degradedStreak > limit) {
      this.#log("e10_rollover_degraded_kept", `call=${slot.index} ${reason} streak=${this.#degradedStreak}`);
      return;
    }
    this.#log("e10_rollover_degraded", `${reason} mode=${this.#mode} streak=${this.#degradedStreak} ${this.#windowLine(slot, "degraded")}`);
    if (this.#mode !== "sequential") { this.#mode = "sequential"; this.#log("e10_rollover_mode", "mode=sequential reason=degraded_after_overlap"); }
    if (this.#standby) { const standby = this.#standby; this.#standby = null; void this.#closeSlot(standby); }
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    await this.#retireActive(slot);
    void this.#reconnect();
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
    const types = annexBNalTypes(unit);
    const idr = types.includes(5);
    const now = this.#now;
    for (const w of [slot.window, slot.health]) {
      w.units++; w.bytes += unit.length; if (idr) w.idr++;
      if (w.lastAt !== null) w.maxGapMs = Math.max(w.maxGapMs, now - w.lastAt);
      w.lastAt = now;
      for (const type of types) w.nal.set(type, (w.nal.get(type) ?? 0) + 1);
    }
    if (idr) slot.lastIdrAt = now;
    if (slot === this.#active) { this.#write(unit); return; }
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
    if (old && (this.options.diagnosticsMilliseconds ?? 60_000) > 0) this.#log("e10_call_window", this.#windowLine(old, "before_splice"));
    if (old) this.#stopSlotTimers(old);
    this.#activate(slot, old ? "splice" : "reconnect");
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
    this.#stopSlotTimers(slot);
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
