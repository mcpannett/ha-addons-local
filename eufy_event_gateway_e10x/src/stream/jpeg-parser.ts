/**
 * Reassembles JPEG images from FFmpeg's arbitrary stdout chunks.
 *
 * FFmpeg can split a marker across writes or place several images in one
 * write. This stateful parser keeps the unfinished suffix, emits only bytes
 * bracketed by JPEG start/end markers, and discards unrelated output. The
 * stream manager owns the FFmpeg process; this class owns only byte-boundary
 * reconstruction and is suitable for deterministic unit tests.
 */
export class JpegParser {
  #pending = Buffer.alloc(0);

  /** Consume FFmpeg output and return all complete images now available. */
  push(chunk: Buffer): Buffer[] {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const images: Buffer[] = [];

    while (true) {
      const start = this.#pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        this.#pending = this.#pending.subarray(Math.max(0, this.#pending.length - 1));
        break;
      }
      const end = this.#pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end < 0) {
        if (start > 0) this.#pending = this.#pending.subarray(start);
        break;
      }
      images.push(this.#pending.subarray(start, end + 2));
      this.#pending = this.#pending.subarray(end + 2);
    }
    return images;
  }
}
