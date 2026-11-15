// Pipes. The buffer is kernel-side, and that is constraint 15 and not a preference.
//
// `docs/ABI.md` decision 5: "No worker ever waits on another worker's futex — the kernel owns
// every pipe." A direct worker-to-worker ring would be faster and would make the dead-peer wake
// impossible, which is the whole thing a pipe has to get right.
//
// THE ASYMMETRY, which `docs/ABI.md` decision 5 says is worth restating because getting it
// backwards makes `yes | head -1` either hang or report a spurious error:
//
//   a blocked READER whose last writer went  ->  0, meaning EOF. NOT an errno.
//   a blocked WRITER whose last reader went  ->  -EPIPE, AND SIGPIPE.
//
// HOW A BLOCKED CALL PARKS. Constraint 88, measured in M4's prerequisite experiment: a blocking
// call must park on the process's SEQ word and never inside a synchronous call, because a thread
// inside a synchronous call cannot be interrupted at all — `Atomics.notify` woke 0 workers against
// it. So a pipe read with no data returns PENDING, leaves a record here, and the kernel replies to
// it later from whichever event unblocks it: a write, a close, or a signal.
//
// STALE RECORDS ARE SKIPPED BY SEQUENCE, not removed by a cancellation hook. Every record carries
// the `p.seq` its call was dispatched at, and `p.seq` is bumped by every reply — a normal answer,
// an `intr()`, a teardown's -ECONNABORTED, a panic. So a record whose seq has moved belongs to a
// call that has already been answered and is dropped. That is the same guard `later()` uses
// (src/kernel/kernel.mjs), and it means there is no way for a pipe to reply into a slot that has
// moved on. Records are also pruned on every operation so a long-lived pipe cannot accumulate them.

import { PIPE_CAPACITY, EPIPE, SIGPIPE, ST_RETURN } from "../abi.mjs";

/** The kernel surface a pipe needs. Injected once at boot rather than imported, because
 *  `kernel.mjs` imports this file and the reverse would be a cycle. */
let K = null;

export function installPipeKernel(surface) {
  K = surface;
}

export class Pipe {
  constructor(capacity = PIPE_CAPACITY) {
    this.capacity = capacity;
    this.buf = new Uint8Array(capacity);
    // A simple head/length ring. Not a pair of indices: with length explicit, "full" and "empty"
    // are distinguishable without sacrificing a byte, and a wrapped read is two subarray copies.
    this.head = 0;
    this.length = 0;
    /** Open descriptions, by direction. A pipe is alive while either side has one. */
    this.readers = 0;
    this.writers = 0;
    /** Parked calls. {slot, seq, dstOff, want} for readers; {slot, seq, bytes, done} for writers. */
    this.waitingReaders = [];
    this.waitingWriters = [];
    /** Counters, so a check can assert on the mechanism rather than only on the outcome. */
    this.stats = { written: 0, read: 0, readerParks: 0, writerParks: 0, eof: 0, epipe: 0, stale: 0 };
  }

  get free() {
    return this.capacity - this.length;
  }

  /* ---- the ring ------------------------------------------------------------------------- */

  #push(src) {
    const n = Math.min(src.length, this.free);
    if (n === 0) return 0;
    const at = (this.head + this.length) % this.capacity;
    const first = Math.min(n, this.capacity - at);
    this.buf.set(src.subarray(0, first), at);
    if (first < n) this.buf.set(src.subarray(first, n), 0);
    this.length += n;
    this.stats.written += n;
    return n;
  }

  #shift(into, off, want) {
    const n = Math.min(want, this.length);
    if (n === 0) return 0;
    const first = Math.min(n, this.capacity - this.head);
    into.set(this.buf.subarray(this.head, this.head + first), off);
    if (first < n) into.set(this.buf.subarray(0, n - first), off + first);
    this.head = (this.head + n) % this.capacity;
    this.length -= n;
    this.stats.read += n;
    return n;
  }

  /* ---- liveness ------------------------------------------------------------------------- */

  /** Is this record's call still the one its process is waiting on? See the header. */
  #live(rec) {
    if (!rec.slot.ctl || rec.slot.seq !== rec.seq) {
      this.stats.stale += 1;
      return false;
    }
    return true;
  }

  #prune() {
    this.waitingReaders = this.waitingReaders.filter((r) => this.#live(r));
    this.waitingWriters = this.waitingWriters.filter((r) => this.#live(r));
  }

  /* ---- the operations ------------------------------------------------------------------- */

  /**
   * Read into `into` at `off`. Returns a count, 0 for EOF, or null meaning "parked".
   *
   * A reader with no data and a live writer parks. With no data and no writer it is EOF, and EOF
   * is 0 rather than an errno — the half of decision 5 that is easiest to get wrong.
   */
  read(slot, seq, into, off, want) {
    this.#prune();
    if (want <= 0) return 0;
    if (this.length > 0) {
      const n = this.#shift(into, off, want);
      // Space freed, so a writer that could not fit may now. Done AFTER the shift so the writer
      // sees the room.
      this.#wakeWriters();
      return n;
    }
    if (this.writers === 0) {
      this.stats.eof += 1;
      return 0;
    }
    this.waitingReaders.push({ slot, seq, into, off, want });
    this.stats.readerParks += 1;
    return null;
  }

  /**
   * Write `src`. Returns a count, a negative errno, or null meaning "parked".
   *
   * A writer with no reader gets -EPIPE AND SIGPIPE, which is the other half of decision 5. The
   * signal is raised before the errno is returned so a SIG_DFL SIGPIPE kills the writer rather
   * than letting it observe a failure it was supposed to die on.
   */
  write(slot, seq, src) {
    this.#prune();
    if (this.readers === 0) return this.#epipe(slot);
    if (src.length === 0) return 0;
    // Hand bytes straight to a parked reader where possible. Not an optimisation: a reader parked
    // on a 1-byte read must be woken by a 1-byte write even when the buffer is full, and routing
    // every write through the ring first would make that depend on space the pipe does not have.
    const direct = this.#handToReaders(src);
    if (direct === src.length) return direct;
    const n = direct + this.#push(src.subarray(direct));
    if (n > 0) {
      this.#wakeReaders();
      return n;
    }
    // Full, and a reader exists. Park with OUR OWN COPY of the bytes: the caller's SAB is stable
    // only while the caller is parked, and the kernel will reply to it before the data is drained.
    this.waitingWriters.push({ slot, seq, bytes: src.slice(), done: 0 });
    this.stats.writerParks += 1;
    return null;
  }

  #epipe(slot) {
    this.stats.epipe += 1;
    // The signal first. A SIG_DFL SIGPIPE is fatal, so the writer usually never sees the errno —
    // which is what makes `yes | head -1` terminate rather than loop on a failing write.
    if (K) K.raise(slot, SIGPIPE);
    return -EPIPE;
  }

  /** Give bytes to parked readers, oldest first. Returns how many were consumed. */
  #handToReaders(src) {
    let at = 0;
    while (at < src.length && this.waitingReaders.length) {
      const r = this.waitingReaders[0];
      if (!this.#live(r)) { this.waitingReaders.shift(); continue; }
      this.waitingReaders.shift();
      const n = Math.min(r.want, src.length - at);
      r.into.set(src.subarray(at, at + n), r.off);
      at += n;
      this.stats.written += n;
      this.stats.read += n;
      K.reply(r.slot, n, 0, ST_RETURN, n);
    }
    return at;
  }

  #wakeReaders() {
    while (this.length > 0 && this.waitingReaders.length) {
      const r = this.waitingReaders[0];
      if (!this.#live(r)) { this.waitingReaders.shift(); continue; }
      this.waitingReaders.shift();
      const n = this.#shift(r.into, r.off, r.want);
      K.reply(r.slot, n, 0, ST_RETURN, n);
    }
  }

  #wakeWriters() {
    while (this.free > 0 && this.waitingWriters.length) {
      const w = this.waitingWriters[0];
      if (!this.#live(w)) { this.waitingWriters.shift(); continue; }
      const n = this.#push(w.bytes.subarray(w.done));
      w.done += n;
      if (w.done < w.bytes.length) return;   // still short; stays parked
      this.waitingWriters.shift();
      K.reply(w.slot, w.done, 0, ST_RETURN, 0);
      // The bytes just pushed may be what a reader was waiting for.
      this.#wakeReaders();
    }
  }

  /* ---- closing, which is where the asymmetry is delivered ------------------------------- */

  /**
   * One description closed. `isReader` says which end.
   *
   * THIS RUNS SYNCHRONOUSLY INSIDE THE KIND'S `close` OP, because teardown does not await
   * (src/kernel/kernel.mjs): an async EOF wake would land after the dying worker had already been
   * terminated, and the peer would wait forever for a wake that was scheduled and never ran.
   */
  close(isReader) {
    if (isReader) {
      this.readers = Math.max(0, this.readers - 1);
      if (this.readers === 0) {
        // Every parked writer gets -EPIPE and SIGPIPE. Drained into a local first: `#epipe`
        // raises a signal that can reap the slot, which mutates nothing here but makes iterating
        // the live array while replying into it harder to reason about than it needs to be.
        const waiting = this.waitingWriters;
        this.waitingWriters = [];
        for (const w of waiting) {
          if (!this.#live(w)) continue;
          this.stats.epipe += 1;
          if (K) K.raise(w.slot, SIGPIPE);
          // The slot may now be a zombie. `reply` is guarded on `ctl`, and raise-then-reply is
          // the same order the unparked path uses.
          if (w.slot.ctl) K.reply(w.slot, -EPIPE, -1, ST_RETURN, 0);
        }
      }
      return 0;
    }
    this.writers = Math.max(0, this.writers - 1);
    if (this.writers === 0) {
      // Every parked reader gets 0 — EOF, not an errno. Any bytes still in the ring are delivered
      // first: a writer that wrote and then closed must not lose the write.
      this.#wakeReaders();
      const waiting = this.waitingReaders;
      this.waitingReaders = [];
      for (const r of waiting) {
        if (!this.#live(r)) continue;
        this.stats.eof += 1;
        K.reply(r.slot, 0, 0, ST_RETURN, 0);
      }
    }
    return 0;
  }

  /** What a check reads. The parked counts are the mechanism; the byte counts are the outcome. */
  report() {
    return {
      capacity: this.capacity, buffered: this.length, free: this.free,
      readers: this.readers, writers: this.writers,
      waitingReaders: this.waitingReaders.length, waitingWriters: this.waitingWriters.length,
      ...this.stats,
    };
  }
}
