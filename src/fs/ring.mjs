// A fixed-capacity byte ring. One definition, used by every queue in the kernel.
//
// PURE, and in src/fs/ for that reason: it is a total function over its own buffer and the bytes
// handed to it, so `fsfuzz.py` can drive it without a browser. It names no capability, performs no
// I/O and cannot suspend.
//
// `length` is explicit rather than derived from a head/tail pair. With two indices, "full" and
// "empty" are the same state unless a byte of capacity is sacrificed or a flag is carried.

export class ByteRing {
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`a ring needs a positive integer capacity, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buf = new Uint8Array(capacity);
    this.head = 0;
    this.length = 0;
  }

  get free() {
    return this.capacity - this.length;
  }

  get empty() {
    return this.length === 0;
  }

  get full() {
    return this.length === this.capacity;
  }

  /**
   * Append as much of `src` as fits. A short count is not an error — it is what `write(2)` does on
   * a nearly-full pipe, and the caller must report the count rather than assume a full write.
   */
  push(src, from = 0) {
    const want = src.length - from;
    const n = Math.min(want, this.free);
    if (n <= 0) return 0;
    const at = (this.head + this.length) % this.capacity;
    const first = Math.min(n, this.capacity - at);
    this.buf.set(src.subarray(from, from + first), at);
    // A push straddling the end of the buffer is two copies; dropping this one loses the tail
    // silently.
    if (first < n) this.buf.set(src.subarray(from + first, from + n), 0);
    this.length += n;
    return n;
  }

  pushByte(b) {
    if (this.full) return 0;
    this.buf[(this.head + this.length) % this.capacity] = b & 0xff;
    this.length += 1;
    return 1;
  }

  /** Copy up to `want` bytes into `into` at `off`, removing them from the ring. */
  shift(into, off, want) {
    const n = Math.min(want, this.length);
    if (n <= 0) return 0;
    const first = Math.min(n, this.capacity - this.head);
    into.set(this.buf.subarray(this.head, this.head + first), off);
    if (first < n) into.set(this.buf.subarray(0, n - first), off + first);
    this.head = (this.head + n) % this.capacity;
    this.length -= n;
    return n;
  }

  /** Canonical-mode erase. Returns the byte removed, or -1. */
  popLast() {
    if (this.empty) return -1;
    const b = this.buf[(this.head + this.length - 1) % this.capacity];
    this.length -= 1;
    return b;
  }

  /** Every byte, oldest first, as a fresh array. */
  drain() {
    const out = new Uint8Array(this.length);
    this.shift(out, 0, out.length);
    return out;
  }

  clear() {
    this.head = 0;
    this.length = 0;
  }
}
