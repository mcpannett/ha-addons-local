/**
 * `protobufjs`, loaded on first use rather than at import.
 *
 * The module costs **+10 MB of RSS** to import, and the push subtree that parses its `.proto` documents
 * at module scope was **+17 MB** all in — measured one fresh process per module, RSS rather than
 * `heapUsed`, because what a memory-limited host kills a process for is resident pages. Every consumer
 * paid both to import this package, including one that never registers for push and owns no device
 * speaking raw data-points.
 *
 * **Loaded with `createRequire`, not `await import()`, and that is the whole design decision.** The
 * call sites are synchronous — a wire parser driven by socket data, a data-point decoder called from a
 * message handler — and none of them has an `await` to hide a module load behind. An async loader would
 * have meant either making those paths async, which changes contracts a consumer depends on, or a
 * "load it first" rule enforced by throwing at runtime in exactly the paths that used to work. A
 * synchronous require defers the cost without either.
 *
 * Node-only, which this package already is (it opens UDP sockets and reads TLS certificates).
 * The lazy loader is adapted from mega-yfue/eufy-sdk (Apache-2.0).
 */
import { createRequire } from "node:module";

/** The `protobufjs` module shape, loaded on demand. */
type Protobuf = typeof import("protobufjs");

const requireFrom = createRequire(import.meta.url);
let cached: Protobuf | undefined;

/** The engine, loading it on the first call. The ONLY runtime reference to `protobufjs` here. */
export function protobufjs(): Protobuf {
  return (cached ??= requireFrom("protobufjs") as Protobuf);
}
