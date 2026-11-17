// Pipes: the buffer is kernel-side (constraint 15), and a dead peer's wake is always the kernel's
// to send (docs/ABI.md decision 5).
//
// THE ASYMMETRY, which is the thing readers get backwards:
//
//   a blocked READER whose last writer went  ->  0, meaning EOF. NOT an errno.
//   a blocked WRITER whose last reader went  ->  -EPIPE, AND SIGPIPE.
//
// A call with nothing to return parks (constraint 88): the record carries the `p.seq` its call was
// dispatched at, every reply bumps `p.seq`, so a record whose seq has moved has already been
// answered and is dropped.

import { PIPE_CAPACITY, EPIPE, SIGPIPE, ST_RETURN } from "../abi.mjs";
import { ByteRing } from "../fs/ring.mjs";

/** The kernel surface a pipe needs. Injected, not imported: `kernel.mjs` imports this file. */
let K = null;

export function installPipeKernel(surface) {
  K = surface;
}

export class Pipe {
  constructor(capacity = PIPE_CAPACITY) {
    this.capacity = capacity;
    this.ring = new ByteRing(capacity);
    /**
     * Whether each END is open: 0 or 1, never more. A pipe has one read description and one write
     * description; `dup` and spawn-inheritance add REFERENCES, and the kind's `close` op fires once,
     * when the last reference goes (constraint 92). Counting per HOLDER leaves `writers` at 1 after
     * the only writer exits, and the reader parks on an EOF that can never arrive.
     */
    this.readers = 0;
    this.writers = 0;
    this.waitingReaders = [];
    this.waitingWriters = [];
    this.stats = {
      written: 0, read: 0, readerParks: 0, writerParks: 0, eof: 0, epipe: 0, stale: 0,
      // Writers whose SIGPIPE was FATAL: teardown answered their call, and this file must not.
      killedByEpipe: 0,
    };
  }

  get free() {
    return this.ring.free;
  }

  get length() {
    return this.ring.length;
  }

  #push(src, from = 0) {
    const n = this.ring.push(src, from);
    this.stats.written += n;
    return n;
  }

  #shift(into, off, want) {
    const n = this.ring.shift(into, off, want);
    this.stats.read += n;
    return n;
  }

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

  /** Read into `into` at `off`. A count, 0 for EOF, or null meaning parked. */
  read(slot, seq, into, off, want) {
    this.#prune();
    if (want <= 0) return 0;
    if (this.length > 0) {
      const n = this.#shift(into, off, want);
      // After the shift, so a writer that could not fit sees the room.
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

  /** Write `src`. A count, a negative errno, or null meaning parked. */
  write(slot, seq, src) {
    this.#prune();
    if (this.readers === 0) return this.#epipe(slot);
    if (src.length === 0) return 0;
    // Not an optimisation: a reader parked on a 1-byte read must be woken by a 1-byte write even
    // when the buffer is full, which routing through the ring first would make depend on space.
    const direct = this.#handToReaders(src);
    if (direct === src.length) return direct;
    const n = direct + this.#push(src, direct);
    if (n > 0) {
      this.#wakeReaders();
      return n;
    }
    // OUR OWN COPY: the caller's SAB is stable only while it is parked, and the kernel replies
    // before the data is drained.
    this.waitingWriters.push({ slot, seq, bytes: src.slice(), done: 0 });
    this.stats.writerParks += 1;
    return null;
  }

  #epipe(slot) {
    this.stats.epipe += 1;
    // The signal first: a SIG_DFL SIGPIPE is fatal, so the writer usually never sees the errno.
    if (K) K.raise(slot, SIGPIPE);
    // And a fatal raise has ALREADY ANSWERED the call — teardown replies -ECONNABORTED — so an
    // errno here would be a second reply for one call. `null` means "already handled".
    if (slot.inflight === null) {
      this.stats.killedByEpipe += 1;
      return null;
    }
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
      const n = this.#push(w.bytes, w.done);
      w.done += n;
      if (w.done < w.bytes.length) return;   // still short; stays parked
      this.waitingWriters.shift();
      K.reply(w.slot, w.done, 0, ST_RETURN, 0);
      this.#wakeReaders();
    }
  }

  /**
   * One description closed. SYNCHRONOUS, because teardown does not await: an async EOF wake would
   * land after the dying worker was terminated and the peer would wait forever.
   */
  close(isReader) {
    if (isReader) {
      this.readers = 0;
      {
        // Every parked writer gets -EPIPE and SIGPIPE. Drained into a local first: raising a
        // signal can reap the slot being iterated over.
        const waiting = this.waitingWriters;
        this.waitingWriters = [];
        for (const w of waiting) {
          if (!this.#live(w)) continue;
          this.stats.epipe += 1;
          if (K) K.raise(w.slot, SIGPIPE);
          // Re-checked BY SEQUENCE, not by `ctl`: teardown bumps `seq` immediately but `ctl` is
          // nulled two seconds later, so a `ctl` guard would let a second reply through.
          if (this.#live(w)) {
            K.reply(w.slot, -EPIPE, -1, ST_RETURN, 0);
          } else {
            this.stats.killedByEpipe += 1;
          }
        }
      }
      return 0;
    }
    this.writers = 0;
    {
      // Every parked reader gets 0, EOF. Bytes still in the ring go first: a writer that wrote and
      // then closed must not lose the write.
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

  report() {
    return {
      capacity: this.capacity, buffered: this.length, free: this.free,
      readers: this.readers, writers: this.writers,
      waitingReaders: this.waitingReaders.length, waitingWriters: this.waitingWriters.length,
      ...this.stats,
    };
  }
}
