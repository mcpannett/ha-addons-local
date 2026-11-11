/**
 * Doorbell-specific baseline layered over the existing camera catalogue.
 *
 * Doorbells inherit camera events/media and optional battery read discovery;
 * this file owns only the distinct press path, already routed by the gateway.
 */

import type { CoreCapabilityEntry } from "./device-capability-core.js";

/** Doorbell press event currently routed for admitted camera types. */
export const DOORBELL_CAPABILITY_CORE: readonly CoreCapabilityEntry[] = [
  { id: "doorbell.press", family: "doorbell", kind: "event", evidenceParamIds: [], gatewaySupport: "implemented", note: "Our gateway routes Mega push 3103 and clears the press flag after its event hold; this is not a persistent button state." },
] as const;
