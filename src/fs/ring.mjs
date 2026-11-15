// A fixed-capacity byte ring. One definition, used by every queue in the kernel.
//
// PURE, and in src/fs/ for that reason: it is a total function over its own buffer and the bytes
// handed to it, so `fsfuzz.py` can drive it without a browser. It names no capability, performs no
// I/O and cannot suspend.
//
// IT EXISTS BECAUSE THERE WERE ABOUT TO BE TWO. M4's pipe had this inline, and M4b's pty needs
// three more queues — the slave's input, the master's output, and the canonical line buffer. Four
// hand-written rings is four places for the wrap arithmetic to be wrong, and the wrap is the part
// that is easy to get wrong: a write that straddles the end of the buffer is two copies, and a
// reader that forgets the second one loses the tail silently.
//
// `length` IS EXPLICIT rather than derived from a head/tail pair. With two indices, "full" and
// "empty" are the same state unless a byte of capacity is sacrificed or a flag is carried; with an
// explicit length both are answerable and the whole buffer is usable.

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
   * Append as much of `src` as fits. Returns the count taken, which may be 0 or a short count.
   *
   * A SHORT COUNT IS NOT AN ERROR — it is what `write(2)` does on a nearly-full pipe, and the
   * caller's job is to report the count rather than to assume it wrote everything.
   */
  push(src, from = 0) {
    const want = src.length - from;
    const n = Math.min(want, this.free);
    if (n <= 0) return 0;
    const at = (this.head + this.length) % this.capacity;
    const first = Math.min(n, this.capacity - at);
    this.buf.set(src.subarray(from, from + first), at);
    // THE WRAP. A push that straddles the end of the buffer is two copies, and this second one is
    // the line a hand-written ring forgets.
    if (first < n) this.buf.set(src.subarray(from + first, from + n), 0);
    this.length += n;
    return n;
  }

  /** Append one byte. Returns 1 or 0. The line discipline's hot path. */
  pushByte(b) {
    if (this.full) return 0;
    this.buf[(this.head + this.length) % this.capacity] = b & 0xff;
    this.length += 1;
    return 1;
  }

  /** Copy up to `want` bytes into `into` at `off`, removing them. Returns the count. */
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

  /** Remove the most recently pushed byte. Returns it, or -1. Canonical-mode erase. */
  popLast() {
    if (this.empty) return -1;
    const b = this.buf[(this.head + this.length - 1) % this.capacity];
    this.length -= 1;
    return b;
  }

  /** Every byte, oldest first, as a fresh array. Drains the ring. */
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
