// A pseudo-terminal: two queues and a line discipline, all kernel-side.
//
// WHY THE DISCIPLINE IS HERE AND NOT IN THE TERMINAL APP. `PLAN.md`: "Ctrl-C raises SIGINT on the
// foreground process group even when the UI is wedged, which is the entire point of putting it
// there." Three constraints make it non-negotiable rather than stylistic:
//
//   15 — pipe buffers and the like are kernel-side; a process holds only integers. A discipline
//        living in the terminal app would hold the pty's line buffer in a process.
//   16 — a process parked in `Atomics.wait` cannot service `postMessage`, so a signal must travel
//        through the SAB control word. "Ctrl-C depends on this."
//   21 — there is no preemption, so a compute-bound process is killable but not interruptible. A
//        cancel affordance must degrade to SIGKILL, and the UI must show the distinction.
//
// THE TWO DIRECTIONS ARE NOT SYMMETRIC, which is why the master and the slave are separate kinds:
//
//   write(master) is INPUT.  It runs the line discipline: signals, echo, canonical buffering.
//   write(slave)  is OUTPUT. It goes straight to the master's queue, unprocessed.
//   read(slave)   takes processed input. In canonical mode, only whole lines.
//   read(master)  takes the slave's output, plus whatever the echo produced.
//
// WHAT IS SPECIFIED AND WHAT IS ASSUMED. `MILESTONES.md` M4 specifies exactly one behaviour: ISIG
// with VINTR must raise SIGINT on the foreground group. **`ICANON` and `ECHO` semantics are
// specified in no authored document**, so what follows is POSIX's default behaviour taken as the
// assumption, and said here rather than left for a reader to infer it was designed.

import {
  ICANON, ECHO, ISIG, VINTR, VQUIT, VERASE, VKILL, VEOF, VSUSP,
  PTY_INPUT_BYTES, PTY_OUTPUT_BYTES, SIGINT, SIGQUIT, SIGTSTP, SIGWINCH,
  ST_RETURN, defaultTermios,
} from "../abi.mjs";
import { ByteRing } from "../fs/ring.mjs";

/** The kernel surface a pty needs. Injected, not imported: `kernel.mjs` imports this file. */
let K = null;

export function installPtyKernel(surface) {
  K = surface;
}

/**
 * M4b's first negative control: every new pty comes up with ISIG cleared.
 *
 * TRUE in every real boot, and the kernel refuses to clear it without a bench boot. A flag on the
 * DEFAULT rather than a branch in `#inputByte`, so the headline path is the same single flag test
 * either way — the same discipline as the fatal-signal set being data.
 */
let defaultIsig = true;

export function setPtyDefaultIsig(on) {
  defaultIsig = !!on;
}

export class Pty {
  constructor() {
    /** Processed input, waiting for the slave to read it. In canonical mode a line lands here
     *  only when it is complete. */
    this.input = new ByteRing(PTY_INPUT_BYTES);
    /** The slave's output and the echo, waiting for the master. */
    this.output = new ByteRing(PTY_OUTPUT_BYTES);
    /**
     * The canonical line under construction. SEPARATE from `input` because a half-typed line is
     * not readable: the slave must see nothing until the line is terminated, and ERASE has to be
     * able to take a byte back — which it cannot once the byte is in a queue the slave may
     * already have drained.
     */
    this.line = new ByteRing(PTY_INPUT_BYTES);
    this.termios = defaultTermios();
    if (!defaultIsig) this.termios.lflag &= ~ISIG;
    this.winsize = { rows: 24, cols: 80, xpixel: 0, ypixel: 0 };
    /**
     * The foreground process group, which is where ISIG sends its signal.
     *
     * 0 means "nobody", and a signal is then dropped rather than broadcast — a pty whose
     * foreground group was unset must not deliver Ctrl-C to every process in the system. Set from
     * the opener's pgid and moved with `ioctl(TIOCSPGRP)`, which is what a shell does per pipeline.
     */
    this.fgPgid = 0;
    /** Open ends, 0 or 1 each, per description. Same model as the pipe: constraint 92. */
    this.masters = 0;
    this.slaves = 0;
    this.waitingMasters = [];
    this.waitingSlaves = [];
    this.stats = {
      inBytes: 0, outBytes: 0, echoed: 0, signals: 0, linesReady: 0,
      erased: 0, killed: 0, discarded: 0, eof: 0, stale: 0,
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

  /* ---- liveness, the same sequence guard the pipe uses ---------------------------------- */

  #live(rec) {
    if (!rec.slot.ctl || rec.slot.seq !== rec.seq) {
      this.stats.stale += 1;
      return false;
    }
    return true;
  }

  /* ---- the line discipline -------------------------------------------------------------- */

  /**
   * One byte of input. Returns true if it was consumed by the discipline rather than queued.
   *
   * ORDER IS LOAD-BEARING: signals first, then erase and kill, then echo, then buffering. A
   * Ctrl-C that was echoed before being recognised would put a stray ^C byte in the output; a
   * Ctrl-C that was buffered first would be delivered to the program as data.
   */
  #inputByte(b) {
    // 1. SIGNALS. The byte is consumed and never reaches the program.
    if (this.#on(ISIG)) {
      const sig = b === this.#cc(VINTR) ? SIGINT
        : b === this.#cc(VQUIT) ? SIGQUIT
          : b === this.#cc(VSUSP) ? SIGTSTP : 0;
      if (sig) {
        this.stats.signals += 1;
        // THE WHOLE FOREGROUND GROUP, which is the entire reason the discipline is in the kernel:
        // it reaches a process that is wedged and not servicing messages (constraint 16). A pty
        // with no foreground group drops the signal rather than broadcasting it.
        if (this.fgPgid > 0 && K) K.signalGroup(this.fgPgid, sig);
        // POSIX also flushes the pending input on a signal: a half-typed line is abandoned,
        // because the program that was going to read it is being interrupted.
        if (this.#on(ICANON)) this.line.clear();
        return true;
      }
    }

    // 2. CANONICAL EDITING. Only meaningful while a line is being assembled.
    if (this.#on(ICANON)) {
      if (b === this.#cc(VERASE)) {
        const gone = this.line.popLast();
        if (gone >= 0) {
          this.stats.erased += 1;
          // The echo of an erase is destructive: back up, overwrite, back up again. That is what
          // a terminal does and what makes the character visibly disappear.
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
        // ^D. A pending line is delivered as-is; an EMPTY line means end of file, which is how
        // `cat` terminates on a terminal.
        if (this.line.length > 0) {
          this.#commitLine();
        } else {
          this.stats.eof += 1;
          this.#wakeSlavesWithEof();
        }
        return true;
      }
    }

    // 3. ECHO, before buffering, so the typist sees the character whether or not a program ever
    //    reads it.
    if (this.#on(ECHO)) {
      // A newline echoes as CR LF: a bare LF leaves the cursor in the same column on a real
      // terminal, which is why every tty does this.
      if (b === 10) this.#echo([13, 10]);
      else this.#echo([b]);
    }

    // 4. BUFFERING.
    if (!this.#on(ICANON)) {
      // Raw: straight to the slave's queue, readable immediately.
      if (this.input.pushByte(b) === 0) this.stats.discarded += 1;
      return false;
    }
    if (this.line.pushByte(b) === 0) {
      // A line longer than the buffer. POSIX's answer is to deliver what there is rather than to
      // lose the terminal; a discarded byte is counted so it is not silent.
      this.stats.discarded += 1;
      return false;
    }
    if (b === 10) this.#commitLine();
    return false;
  }

  /** Move the completed line into the slave's queue and wake a reader. */
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

  /* ---- the four operations -------------------------------------------------------------- */

  /** write(master): INPUT. Always accepts everything — a terminal does not block the typist. */
  writeInput(src) {
    for (let i = 0; i < src.length; i += 1) this.#inputByte(src[i]);
    this.stats.inBytes += src.length;
    this.#wakeSlaves();
    return src.length;
  }

  /** write(slave): OUTPUT, unprocessed. Short count when the master is not draining. */
  writeOutput(src) {
    const n = this.output.push(src);
    this.stats.outBytes += n;
    this.#wakeMasters();
    return n;
  }

  /** read(slave). A count, 0 for EOF, or null meaning parked. */
  readInput(slot, seq, into, off, want) {
    this.#prune();
    if (want <= 0) return 0;
    if (!this.input.empty) return this.input.shift(into, off, want);
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
    if (!this.output.empty) return this.output.shift(into, off, want);
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

  /** ^D on an empty line: every parked slave reader gets 0, which is end of file. */
  #wakeSlavesWithEof() {
    const waiting = this.waitingSlaves;
    this.waitingSlaves = [];
    for (const r of waiting) {
      if (!this.#live(r)) continue;
      K.reply(r.slot, 0, 0, ST_RETURN, 0);
    }
  }

  /* ---- termios, winsize, the foreground group ------------------------------------------ */

  getTermios() {
    return {
      iflag: this.termios.iflag, oflag: this.termios.oflag, cflag: this.termios.cflag,
      lflag: this.termios.lflag, cc: this.termios.cc.slice(),
    };
  }

  /**
   * Replace the termios wholesale. The caller supplies every field, including the three reserved
   * flag words and all twenty cc slots, so a flag a later milestone adds survives a round trip
   * through a caller that has never heard of it.
   *
   * LEAVING CANONICAL MODE FLUSHES THE PENDING LINE into the input queue. The bytes were typed and
   * the program is now asking for them unbuffered; discarding them would lose input the user had
   * already entered, and holding them would make them unreachable because nothing will ever
   * terminate the line.
   */
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

  /**
   * Resize, and raise SIGWINCH on the foreground group.
   *
   * `docs/ABI.md`: "a set on the master raises SIGWINCH on the slave's foreground pgrp". Raised
   * only when the size actually CHANGED — a program that re-asserts the size it already has has
   * not been resized, and a spurious SIGWINCH makes every full-screen program redraw.
   */
  setWinsize(ws) {
    const changed = ws.rows !== this.winsize.rows || ws.cols !== this.winsize.cols
      || ws.xpixel !== this.winsize.xpixel || ws.ypixel !== this.winsize.ypixel;
    this.winsize = { rows: ws.rows, cols: ws.cols, xpixel: ws.xpixel, ypixel: ws.ypixel };
    if (changed && this.fgPgid > 0 && K) {
      this.stats.signals += 1;
      K.signalGroup(this.fgPgid, SIGWINCH);
    }
    return 0;
  }

  /* ---- closing -------------------------------------------------------------------------- */

  close(isMaster) {
    if (isMaster) {
      this.masters = 0;
      // The terminal went away. Every parked slave reader gets EOF, which is what a program on a
      // closed terminal must see rather than an error.
      this.#wakeSlavesWithEof();
      return 0;
    }
    this.slaves = 0;
    // The program went away. A parked master reader gets EOF: there is nothing left to produce
    // output. NOT -EPIPE — the master is a reader here, and readers see EOF (docs/ABI.md
    // decision 5).
    const waiting = this.waitingMasters;
    this.waitingMasters = [];
    for (const r of waiting) {
      if (!this.#live(r)) continue;
      this.stats.eof += 1;
      K.reply(r.slot, 0, 0, ST_RETURN, 0);
    }
    return 0;
  }

  /** What a check reads. The flags and the queue depths are the mechanism. */
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
      ...this.stats,
    };
  }

  /** Whether each side would satisfy a `poll` for POLLIN right now. */
  readable(isMaster) {
    return isMaster
      ? (!this.output.empty || this.slaves === 0)
      : (!this.input.empty || this.masters === 0);
  }
}
