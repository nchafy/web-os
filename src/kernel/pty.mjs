// A pseudo-terminal: two queues and a line discipline, all kernel-side.
//
// THE DISCIPLINE IS HERE AND NOT IN THE TERMINAL APP, so Ctrl-C raises SIGINT on the foreground
// process group even when the UI is wedged (constraints 15, 16, 21).
//
// THE TWO DIRECTIONS ARE NOT SYMMETRIC, which is why the master and the slave are separate kinds:
//
//   write(master) is INPUT.  It runs the line discipline: signals, echo, canonical buffering.
//   write(slave)  is OUTPUT. It goes straight to the master's queue, unprocessed.
//   read(slave)   takes processed input. In canonical mode, only whole lines.
//   read(master)  takes the slave's output, plus whatever the echo produced.
//
// WHAT IS SPECIFIED AND WHAT IS ASSUMED. `MILESTONES.md` M4 specifies one behaviour: ISIG with
// VINTR must raise SIGINT on the foreground group. **`ICANON` and `ECHO` semantics are specified in
// no authored document** — what follows is POSIX's default behaviour taken as an assumption.

import {
  ICANON, ECHO, ISIG, VINTR, VQUIT, VERASE, VKILL, VEOF, VSUSP,
  PTY_INPUT_BYTES, PTY_OUTPUT_BYTES, SIGINT, SIGQUIT, SIGTSTP, SIGWINCH, SIGPIPE,
  EPIPE, ST_RETURN, defaultTermios,
} from "../abi.mjs";
import { ByteRing } from "../fs/ring.mjs";

/** The kernel surface a pty needs. Injected, not imported: `kernel.mjs` imports this file. */
let K = null;

export function installPtyKernel(surface) {
  K = surface;
}

/** M4b's first negative control: every new pty comes up with ISIG cleared. TRUE in every real
 *  boot, and the kernel refuses to clear it without a bench boot. */
let defaultIsig = true;

export function setPtyDefaultIsig(on) {
  defaultIsig = !!on;
}

/** M4b's fourth control: a resize no longer raises SIGWINCH, under the same bench-boot gate. The
 *  control removes the signal and leaves the resize, so the check cannot pass on the resize alone. */
let winchEnabled = true;

export function setPtyWinch(on) {
  winchEnabled = !!on;
}

/** M4a's negative control: the master's input side is detached. FALSE in every real boot, and the
 *  kernel refuses to set it without a bench boot. `writeInput` carries why this is where to cut. */
let detached = false;

export function setPtyDetached(on) {
  detached = !!on;
}

export class Pty {
  constructor() {
    this.input = new ByteRing(PTY_INPUT_BYTES);
    /** The slave's output and the echo, waiting for the master. */
    this.output = new ByteRing(PTY_OUTPUT_BYTES);
    /** The canonical line under construction. SEPARATE from `input` because a half-typed line is
     *  not readable, and ERASE must take back a byte the slave may otherwise have drained. */
    this.line = new ByteRing(PTY_INPUT_BYTES);
    this.termios = defaultTermios();
    if (!defaultIsig) this.termios.lflag &= ~ISIG;
    this.winsize = { rows: 24, cols: 80, xpixel: 0, ypixel: 0 };
    /** The foreground process group, where ISIG sends its signal. 0 means "nobody", and the signal
     *  is then DROPPED rather than broadcast: an unset foreground group must not deliver Ctrl-C to
     *  every process in the system. Moved with `ioctl(TIOCSPGRP)`. */
    this.fgPgid = 0;
    /** A ^D typed while nobody is reading, latched for whichever `read` arrives next. Cleared by
     *  any later input, because a ^D followed by typing is not end of file. */
    this.pendingEof = false;
    /** Open ends, 0 or 1 each, per description. Same model as the pipe: constraint 92. */
    this.masters = 0;
    this.slaves = 0;
    this.waitingMasters = [];
    this.waitingSlaves = [];
    /** Slave writers parked on a full output ring. */
    this.waitingWriters = [];
    this.stats = {
      inBytes: 0, outBytes: 0, echoed: 0, signals: 0, linesReady: 0,
      erased: 0, killed: 0, discarded: 0, overlong: 0, eof: 0, stale: 0, writerParks: 0,
    };
  }

  get lflag() {
    return this.termios.lflag;
  }

  #on(bit) {
    return (this.termios.lflag & bit) !== 0;
  }

  #cc(index) {
    return this.termios.cc[index];
  }

  // The same sequence guard the pipe uses: src/kernel/pipe.mjs's header.
  #live(rec) {
    if (!rec.slot.ctl || rec.slot.seq !== rec.seq) {
      this.stats.stale += 1;
      return false;
    }
    return true;
  }

  /** One byte of input. True if the discipline consumed it rather than queueing it. ORDER IS
   *  LOAD-BEARING: signals, then erase and kill, then echo, then buffering. A Ctrl-C echoed before
   *  being recognised leaves a stray ^C in the output; one buffered first arrives as data. */
  #inputByte(b) {
    // 1. SIGNALS. The byte is consumed and never reaches the program.
    if (this.#on(ISIG)) {
      const sig = b === this.#cc(VINTR) ? SIGINT
        : b === this.#cc(VQUIT) ? SIGQUIT
          : b === this.#cc(VSUSP) ? SIGTSTP : 0;
      if (sig) {
        this.stats.signals += 1;
        // THE WHOLE FOREGROUND GROUP, which reaches a wedged process (constraint 16).
        if (this.fgPgid > 0 && K) K.signalGroup(this.fgPgid, sig);
        if (this.#on(ICANON)) this.line.clear();
        return true;
      }
    }

    // 2. CANONICAL EDITING.
    if (this.#on(ICANON)) {
      if (b === this.#cc(VERASE)) {
        const gone = this.line.popLast();
        if (gone >= 0) {
          this.stats.erased += 1;
          // Back up, overwrite with a space, back up again: the character visibly disappears.
          if (this.#on(ECHO)) this.#echo([8, 32, 8]);
        }
        return true;
      }
      if (b === this.#cc(VKILL)) {
        const n = this.line.length;
        this.line.clear();
        if (n > 0) {
          this.stats.killed += 1;
          if (this.#on(ECHO)) {
            for (let i = 0; i < n; i += 1) this.#echo([8, 32, 8]);
          }
        }
        return true;
      }
      if (b === this.#cc(VEOF)) {
        // ^D. A pending line is delivered as-is; an EMPTY line means end of file.
        if (this.line.length > 0) {
          this.#commitLine();
        } else {
          this.stats.eof += 1;
          // Latched first: a parked reader is answered below, one that arrives later reads this.
          this.pendingEof = true;
          this.#wakeSlavesWithEof();
        }
        return true;
      }
    }

    // 3. ECHO, before buffering, so the typist sees the character whether a program reads it or not.
    if (this.#on(ECHO)) {
      // A newline echoes as CR LF: a bare LF leaves the cursor in the same column on a terminal.
      if (b === 10) this.#echo([13, 10]);
      else this.#echo([b]);
    }

    // 4. BUFFERING.
    if (!this.#on(ICANON)) {
      if (this.input.pushByte(b) === 0) this.stats.discarded += 1;
      return false;
    }
    if (this.line.pushByte(b) === 0) {
      /* THE LINE BUFFER IS FULL, so deliver what there is. Discarding instead throws away a
       * terminating newline that arrives on a full buffer: the line never commits, every later
       * keystroke is discarded, and the terminal is permanently wedged. */
      this.stats.overlong += 1;
      this.#commitLine();
      if (this.line.pushByte(b) === 0) {
        // The buffer is smaller than one byte, which cannot happen — counted rather than ignored.
        this.stats.discarded += 1;
        return false;
      }
    }
    if (b === 10) this.#commitLine();
    return false;
  }

  #commitLine() {
    const bytes = this.line.drain();
    const n = this.input.push(bytes);
    if (n < bytes.length) this.stats.discarded += bytes.length - n;
    this.stats.linesReady += 1;
    this.#wakeSlaves();
  }

  #echo(bytes) {
    for (const b of bytes) {
      if (this.output.pushByte(b) === 0) {
        this.stats.discarded += 1;
        return;
      }
      this.stats.echoed += 1;
    }
    this.#wakeMasters();
  }

  /** write(master): INPUT. Always accepts everything — a terminal does not block the typist. */
  writeInput(src) {
    // M4a'S NEGATIVE CONTROL. ACCEPTED and DISCARDED, so every other link stays working and only
    // the pty stops being the pty — which is what makes a locally-echoing widget's check go RED.
    if (detached) {
      this.stats.discarded += src.length;
      return src.length;
    }
    // Typing after a ^D means the user did not mean end of file after all.
    if (src.length > 0) this.pendingEof = false;
    for (let i = 0; i < src.length; i += 1) this.#inputByte(src[i]);
    this.stats.inBytes += src.length;
    this.#wakeSlaves();
    return src.length;
  }

  /** write(slave): OUTPUT, unprocessed. A count, or null meaning PARKED.
   *
   *  THE WRITER PARKS WHEN THE RING IS FULL, as a pipe's does. Returning `push`'s count — 0 on a
   *  full ring — loses output past `PTY_OUTPUT_BYTES` with no errno: `libos.write` breaks on 0. */
  writeOutput(slot, seq, src) {
    this.#prune();
    if (src.length === 0) return 0;
    const n = this.output.push(src);
    if (n > 0) {
      this.stats.outBytes += n;
      this.#wakeMasters();
      return n;
    }
    this.waitingWriters.push({ slot, seq, bytes: src.slice(), done: 0 });
    this.stats.writerParks += 1;
    return null;
  }

  /** read(slave). A count, 0 for EOF, or null meaning parked. */
  readInput(slot, seq, into, off, want) {
    this.#prune();
    if (want <= 0) return 0;
    if (!this.input.empty) return this.input.shift(into, off, want);
    if (this.pendingEof) {
      // Consumed, so the NEXT read parks again rather than seeing a permanent end of file.
      this.pendingEof = false;
      return 0;
    }
    if (this.masters === 0) {
      // The terminal is gone: EOF, as a reader whose last writer closed gets from a pipe.
      this.stats.eof += 1;
      return 0;
    }
    this.waitingSlaves.push({ slot, seq, into, off, want });
    return null;
  }

  /** read(master). A count, 0 for EOF, or null meaning parked. */
  readOutput(slot, seq, into, off, want) {
    this.#prune();
    if (want <= 0) return 0;
    if (!this.output.empty) {
      const n = this.output.shift(into, off, want);
      // Space freed: a slave that could not fit its output may now.
      this.#wakeWriters();
      return n;
    }
    if (this.slaves === 0) {
      this.stats.eof += 1;
      return 0;
    }
    this.waitingMasters.push({ slot, seq, into, off, want });
    return null;
  }

  #prune() {
    this.waitingSlaves = this.waitingSlaves.filter((r) => this.#live(r));
    this.waitingMasters = this.waitingMasters.filter((r) => this.#live(r));
    this.waitingWriters = this.waitingWriters.filter((r) => this.#live(r));
  }

  #wakeWriters() {
    while (this.output.free > 0 && this.waitingWriters.length) {
      const w = this.waitingWriters[0];
      if (!this.#live(w)) { this.waitingWriters.shift(); continue; }
      const n = this.output.push(w.bytes, w.done);
      w.done += n;
      this.stats.outBytes += n;
      if (w.done < w.bytes.length) return;   // still short; stays parked
      this.waitingWriters.shift();
      K.reply(w.slot, w.done, 0, ST_RETURN, 0);
      this.#wakeMasters();
    }
  }

  #wakeSlaves() {
    while (!this.input.empty && this.waitingSlaves.length) {
      const r = this.waitingSlaves[0];
      if (!this.#live(r)) { this.waitingSlaves.shift(); continue; }
      this.waitingSlaves.shift();
      const n = this.input.shift(r.into, r.off, r.want);
      K.reply(r.slot, n, 0, ST_RETURN, n);
    }
  }

  #wakeMasters() {
    while (!this.output.empty && this.waitingMasters.length) {
      const r = this.waitingMasters[0];
      if (!this.#live(r)) { this.waitingMasters.shift(); continue; }
      this.waitingMasters.shift();
      const n = this.output.shift(r.into, r.off, r.want);
      K.reply(r.slot, n, 0, ST_RETURN, n);
    }
  }

  #wakeSlavesWithEof() {
    const waiting = this.waitingSlaves;
    this.waitingSlaves = [];
    for (const r of waiting) {
      if (!this.#live(r)) continue;
      K.reply(r.slot, 0, 0, ST_RETURN, 0);
    }
  }

  getTermios() {
    return {
      iflag: this.termios.iflag, oflag: this.termios.oflag, cflag: this.termios.cflag,
      lflag: this.termios.lflag, cc: this.termios.cc.slice(),
    };
  }

  /** Replace the termios wholesale: the caller supplies every field, so a flag a later milestone
   *  adds survives a round trip through a caller that has never heard of it. LEAVING CANONICAL
   *  MODE FLUSHES THE PENDING LINE — held, those bytes are unreachable, nothing terminates them. */
  setTermios(next) {
    const wasCanon = this.#on(ICANON);
    this.termios = {
      iflag: next.iflag >>> 0, oflag: next.oflag >>> 0, cflag: next.cflag >>> 0,
      lflag: next.lflag >>> 0, cc: next.cc.slice(),
    };
    if (wasCanon && !this.#on(ICANON) && this.line.length > 0) {
      const bytes = this.line.drain();
      this.input.push(bytes);
      this.#wakeSlaves();
    }
    return 0;
  }

  getWinsize() {
    return { ...this.winsize };
  }

  /** Resize, and raise SIGWINCH on the slave's foreground pgrp (`docs/ABI.md`). Only when the size
   *  CHANGED: a spurious SIGWINCH makes every full-screen program redraw. */
  setWinsize(ws) {
    const changed = ws.rows !== this.winsize.rows || ws.cols !== this.winsize.cols
      || ws.xpixel !== this.winsize.xpixel || ws.ypixel !== this.winsize.ypixel;
    this.winsize = { rows: ws.rows, cols: ws.cols, xpixel: ws.xpixel, ypixel: ws.ypixel };
    if (winchEnabled && changed && this.fgPgid > 0 && K) {
      this.stats.signals += 1;
      K.signalGroup(this.fgPgid, SIGWINCH);
    }
    return 0;
  }

  close(isMaster) {
    if (isMaster) {
      this.masters = 0;
      // The terminal went away: a parked slave READER gets EOF, a parked slave WRITER gets -EPIPE
      // and SIGPIPE (docs/ABI.md decision 5).
      this.#wakeSlavesWithEof();
      const writers = this.waitingWriters;
      this.waitingWriters = [];
      for (const w of writers) {
        if (!this.#live(w)) continue;
        this.stats.epipe = (this.stats.epipe || 0) + 1;
        if (K) K.raise(w.slot, SIGPIPE);
        if (this.#live(w)) K.reply(w.slot, -EPIPE, -1, ST_RETURN, 0);
      }
      return 0;
    }
    this.slaves = 0;
    // The program went away, so a parked master reader gets EOF. NOT -EPIPE: it is a reader.
    const waiting = this.waitingMasters;
    this.waitingMasters = [];
    for (const r of waiting) {
      if (!this.#live(r)) continue;
      this.stats.eof += 1;
      K.reply(r.slot, 0, 0, ST_RETURN, 0);
    }
    return 0;
  }

  report() {
    return {
      lflag: this.termios.lflag,
      canonical: this.#on(ICANON), echo: this.#on(ECHO), isig: this.#on(ISIG),
      cc: [...this.termios.cc],
      winsize: { ...this.winsize },
      fgPgid: this.fgPgid,
      masters: this.masters, slaves: this.slaves,
      inputPending: this.input.length, outputPending: this.output.length,
      linePending: this.line.length,
      waitingMasters: this.waitingMasters.length, waitingSlaves: this.waitingSlaves.length,
      waitingWriters: this.waitingWriters.length,
      pendingEof: this.pendingEof,
      ...this.stats,
    };
  }

  /** Whether each side would satisfy a `poll` for POLLIN right now. */
  readable(isMaster) {
    return isMaster
      ? (!this.output.empty || this.slaves === 0)
      : (!this.input.empty || this.pendingEof || this.masters === 0);
  }

  /** Whether a write would make progress, which is what `poll` reports for POLLOUT. NOT
   *  unconditional: the slave stops being writable once its output ring fills, and asserting
   *  POLLOUT anyway makes a poll-then-write loop busy-spin on the kernel thread. */
  writable(isMaster) {
    return isMaster ? true : this.output.free > 0;
  }
}
