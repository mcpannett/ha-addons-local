/**
 * Fake-call tests for the E10 rollover. Each fake call emits Annex-B units every
 * 10 ms (IDR every 5th unit) tagged with its call index, and the "service" hangs
 * the call up at the per-call limit, like Eufy does at ~300 s. Times are scaled
 * down (limit 400 ms) so a run takes a few seconds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { E10RollingSession, type E10Call } from "../src/stream/e10-rollover.ts";

const LIMIT = 400;
const unit = (call: number, n: number): Buffer => Buffer.from([0, 0, 0, 1, n % 5 === 0 ? 0x65 : 0x41, call, n & 255]);
const isIdr = (u: Buffer): boolean => (u[4]! & 31) === 5;

interface World { live: number; maxLive: number; created: number[] }

function fakeCall(index: number, world: World, opts: { refuse?: boolean; dieAfterMs?: number } = {}): E10Call {
  const output = new PassThrough({ objectMode: false });
  let timer: NodeJS.Timeout | null = null, hangup: NodeJS.Timeout | null = null, n = 0, closed = false;
  const stop = (): void => {
    if (closed) return; closed = true;
    if (timer) clearInterval(timer); if (hangup) clearTimeout(hangup);
    world.live--; output.end();
  };
  return {
    output, stats: { packets: 0, video: 0 }, framingRejections: {},
    async start() {
      if (opts.refuse) throw Object.assign(new Error("refused"), { stage: "call", reason: "busy" });
      world.live++; world.maxLive = Math.max(world.maxLive, world.live);
      timer = setInterval(() => { if (!closed) output.write(unit(index, n++)); }, 10);
      hangup = setTimeout(stop, opts.dieAfterMs ?? LIMIT);
      await new Promise(r => setTimeout(r, 15)); // first units flow before start resolves
    },
    async close() { stop(); },
  };
}

async function run(mode: "sequential" | "overlap", plan: (index: number) => { refuse?: boolean; dieAfterMs?: number } = () => ({}), runMs = 1500) {
  const world: World = { live: 0, maxLive: 0, created: [] };
  const controller = new AbortController();
  const logs: string[] = [];
  const session = new E10RollingSession({
    mode, leadMilliseconds: 100, callLimitMilliseconds: LIMIT, signal: controller.signal,
    retryDelaysMilliseconds: [20], maxOutageMilliseconds: 1000, standbyTimeoutMilliseconds: 300,
    healthWatchMilliseconds: 0, diagnosticsMilliseconds: 0, sequentialCloseWaitMilliseconds: 50,
    ready: () => {}, log: (e, m) => logs.push(`${e} ${m}`),
    create: async index => { world.created.push(index); return fakeCall(index, world, plan(index)); },
  });
  const out: Buffer[] = [];
  let ended = false;
  session.output.on("data", (u: Buffer) => out.push(u));
  session.output.on("end", () => { ended = true; });
  session.output.on("error", () => { ended = true; });
  await session.start();
  await new Promise(r => setTimeout(r, runMs));
  const endedEarly = ended;
  controller.abort();
  await session.close();
  return { world, out, endedEarly, stats: session.rollover, logs };
}

/** Every switch of call index in the output must land on an IDR. */
function assertSplicesOnIdr(out: Buffer[]): number {
  let switches = 0;
  for (let i = 1; i < out.length; i++) {
    if (out[i]![5] !== out[i - 1]![5]) { switches++; assert.ok(isIdr(out[i]!), `switch at unit ${i} is not an IDR`); }
  }
  return switches;
}

test("sequential: stream survives several call limits, one call at a time", async () => {
  const r = await run("sequential");
  assert.equal(r.endedEarly, false, "output stayed open");
  assert.ok(r.world.created.length >= 3, `calls placed: ${r.world.created.length}`);
  assert.equal(r.world.maxLive, 1, "never two calls on the camera");
  assert.ok(assertSplicesOnIdr(r.out) >= 2);
});

test("overlap: never more than two calls, switches at a keyframe", async () => {
  const r = await run("overlap");
  assert.equal(r.endedEarly, false);
  assert.ok(r.world.maxLive <= 2, `max live ${r.world.maxLive}`);
  assert.ok(r.stats.e10Rollovers >= 2, `rollovers ${r.stats.e10Rollovers}`);
  assertSplicesOnIdr(r.out);
});

test("a refused call is retried and the stream continues", async () => {
  const r = await run("sequential", index => index === 1 ? { refuse: true } : {});
  assert.equal(r.endedEarly, false);
  assert.ok(r.stats.e10CallFailures >= 1);
  assert.ok(r.world.created.length >= 3);
  assertSplicesOnIdr(r.out);
});

test("an early hang-up reconnects without ending the output", async () => {
  const r = await run("sequential", index => index === 0 ? { dieAfterMs: 120 } : {}, 800);
  assert.equal(r.endedEarly, false);
  assert.ok(r.stats.e10Reconnects + r.stats.e10SequentialRolls >= 1);
  assertSplicesOnIdr(r.out);
});

test("gives up and ends the output when every call is refused", async () => {
  const r = await run("sequential", index => index === 0 ? { dieAfterMs: 100 } : { refuse: true }, 1400);
  assert.equal(r.endedEarly, true, "output ended after max outage");
});
