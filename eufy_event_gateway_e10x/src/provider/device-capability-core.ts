/**
 * Shared shape for the small, published non-camera baseline catalogues.
 *
 * Family catalogues own their rows. The Mega provider evaluates them from
 * bounded inventory evidence; no module here reads values or sends commands.
 */

/** One baseline behaviour or read candidate for a product family. */
export interface CoreCapabilityEntry {
  /** Stable gateway-facing meaning, not a vendor property name. */
  readonly id: string;
  /** Group shown in the capability matrix. */
  readonly family: string;
  /** Whether this is a read, push event, command, or media path. */
  readonly kind: "read" | "event" | "action" | "media";
  /** Reported inventory parameter IDs needed to identify a candidate read. */
  readonly evidenceParamIds: readonly number[];
  /** Existing gateway behaviour or a candidate awaiting current-value work. */
  readonly gatewaySupport: "implemented" | "reference-only";
  /** Whether a ready PPCS peer is needed before the path can be offered. */
  readonly requiresRoute?: boolean;
  /** Whether an existing gateway path can cover a read without its optional param. */
  readonly baselineWithoutParam?: boolean;
  /** Important proof or topology limit not implied by inventory shape. */
  readonly note?: string;
}
