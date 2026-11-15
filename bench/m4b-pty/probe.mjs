// The pty and its line discipline under plain Node.
//
// The discipline's ORDER is the subject: signals before echo before buffering. A Ctrl-C echoed
// before it was recognised leaves a stray ^C in the output; one buffered first is delivered to the
// program as data. Neither shows up as an error — they show up as a terminal that behaves oddly.
import { Pty, installPtyKernel } from "../../src/kernel/pty.mjs";
import {
  ICANON, ECHO, ISIG, VINTR, VQUIT, VERASE, VKILL, VEOF, VSUSP,
  SIGINT, SIGQUIT, SIGTSTP, SIGWINCH, ST_RETURN, defaultTermios,
} from "../../src/abi.mjs";

const results = [];
const check = (n, g, w) => {
  const ok = JSON.stringify(g) === JSON.stringify(w);
  results.push({ name: n, ok, got: ok ? undefined : g, want: ok ? undefined : w });
};
const checkThat = (n, c, d) => results.push({ name: n, ok: !!c, detail: c ? undefined : d });

const ENC = new TextEncoder(), DEC = new TextDecoder();
let nextPid = 1;
const makeSlot = () => ({ pid: nextPid++, ctl: {}, seq: 1 });
const replies = [];
const groupSignals = [];
installPtyKernel({
  reply: (slot, r0, r1, status, rlen) => {
    replies.push({ pid: slot.pid, r0, r1, status, rlen }); slot.seq += 1;
  },
  signalGroup: (pgid, sig) => { groupSignals.push({ pgid, sig }); },
});
const reset = () => { replies.length = 0; groupSignals.length = 0; };
const reply = (i = 0) => replies[i] || { r0: "<no reply>", rlen: null };
const sig = (i = 0) => groupSignals[i] || { pgid: null, sig: "<no signal>" };
/** Read the master's output as text, which is where the echo lands. */
const outText = (pty) => {
  const buf = new Uint8Array(4096);
  const n = pty.output.shift(buf, 0, 4096);
  return DEC.decode(buf.subarray(0, Math.max(0, n)));
};
const slaveRead = (pty, slot, want = 4096) => {
  const buf = new Uint8Array(4096);
  const r = pty.readInput(slot, slot.seq, buf, 0, want);
  return r === null ? null : { n: r, text: r > 0 ? DEC.decode(buf.subarray(0, r)) : "" };
};
const open = () => { const p = new Pty(); p.masters = 1; p.slaves = 1; p.fgPgid = 7; return p; };

// ---- defaults -----------------------------------------------------------------------------
{
  const pty = open();
  const r = pty.report();
  checkThat("a fresh pty is canonical", r.canonical, r);
  checkThat("and echoing", r.echo, r);
  checkThat("and signal-generating", r.isig, r);
  check("with POSIX's VINTR", r.cc[VINTR], 3);
  check("and an 80x24 window", [r.winsize.rows, r.winsize.cols], [24, 80]);
}

// ---- CANONICAL MODE: nothing is readable until the line is terminated ---------------------
{
  reset();
  const pty = open();
  const s = makeSlot();
  pty.writeInput(ENC.encode("hel"));
  check("a partial line leaves nothing to read", pty.report().inputPending, 0);
  check("and is held in the line buffer", pty.report().linePending, 3);
  const parked = slaveRead(pty, s);
  check("so a reader parks", parked, null);
  check("nothing was replied", replies.length, 0);
  pty.writeInput(ENC.encode("lo\n"));
  check("the newline wakes the reader", replies.length, 1);
  check("with the whole line", reply(0).r0, 6);
  check("and the line includes the newline", reply(0).rlen, 6);
  check("one line was committed", pty.report().linesReady, 1);
  check("and the line buffer is empty again", pty.report().linePending, 0);
}

// ---- the bytes the reader actually gets ---------------------------------------------------
{
  reset();
  const pty = open();
  const s = makeSlot();
  pty.writeInput(ENC.encode("abc\n"));
  const got = slaveRead(pty, s);
  check("a complete line is readable without parking", got.n, 4);
  check("and reads back exactly", got.text, "abc\n");
  check("then there is nothing left", pty.report().inputPending, 0);
}

// ---- ECHO ---------------------------------------------------------------------------------
{
  reset();
  const pty = open();
  pty.writeInput(ENC.encode("hi"));
  check("echo puts the typed bytes on the master", outText(pty), "hi");
  // A newline echoes CR LF: a bare LF leaves the cursor in the same column on a real terminal.
  pty.writeInput(ENC.encode("\n"));
  check("and a newline echoes as CR LF", [...ENC.encode(outText(pty))], [13, 10]);
  check("the echo is counted", pty.report().echoed, 4);
}
{
  // ECHO OFF: the bytes still reach the program, and nothing reaches the master.
  reset();
  const pty = open();
  const s = makeSlot();
  const tm = defaultTermios();
  tm.lflag &= ~ECHO;
  pty.setTermios(tm);
  pty.writeInput(ENC.encode("secret\n"));
  check("with ECHO off the master sees nothing", outText(pty), "");
  check("but the program still gets the line", slaveRead(pty, s).text, "secret\n");
}

// ---- ISIG: the whole point of the discipline being in the kernel --------------------------
{
  reset();
  const pty = open();
  const s = makeSlot();
  pty.writeInput(ENC.encode("partial"));
  check("a line is pending", pty.report().linePending, 7);
  pty.writeInput(new Uint8Array([3]));          // ^C
  check("Ctrl-C raised one signal", groupSignals.length, 1);
  check("to the foreground group", sig(0).pgid, 7);
  check("and it is SIGINT", sig(0).sig, SIGINT);
  // THE BYTE IS CONSUMED. Delivering ^C to the program as data is the bug this asserts against.
  check("the byte never reaches the program", pty.report().inputPending, 0);
  // POSIX flushes pending input on a signal: the program being interrupted will not read it.
  check("and the half-typed line is abandoned", pty.report().linePending, 0);
  check("nothing was echoed as a stray ^C", outText(pty).includes("\u0003"), false);

  pty.writeInput(new Uint8Array([28]));         // ^\ -> SIGQUIT
  check("Ctrl-backslash is SIGQUIT", sig(1).sig, SIGQUIT);
  pty.writeInput(new Uint8Array([26]));         // ^Z -> SIGTSTP
  check("Ctrl-Z is SIGTSTP", sig(2).sig, SIGTSTP);
  check("three signals in total", groupSignals.length, 3);
}
{
  // ISIG OFF: ^C is DATA. The control the milestone's proof turns on.
  reset();
  const pty = open();
  const s = makeSlot();
  const tm = defaultTermios();
  tm.lflag &= ~ISIG;
  pty.setTermios(tm);
  pty.writeInput(new Uint8Array([3]));
  pty.writeInput(ENC.encode("\n"));
  check("with ISIG off no signal is raised", groupSignals.length, 0);
  const got = slaveRead(pty, s);
  check("and the ^C arrives as a byte", [...ENC.encode(got.text)], [3, 10]);
}
{
  // A pty with NO foreground group drops the signal rather than broadcasting it.
  reset();
  const pty = new Pty();
  pty.masters = 1; pty.slaves = 1;            // fgPgid stays 0
  pty.writeInput(new Uint8Array([3]));
  check("a pty with no foreground group raises nothing", groupSignals.length, 0);
  checkThat("but still counts the signal it recognised", pty.report().signals === 1,
    pty.report().signals);
}

// ---- canonical editing: ERASE and KILL ---------------------------------------------------
{
  reset();
  const pty = open();
  const s = makeSlot();
  pty.writeInput(ENC.encode("helo"));
  outText(pty);                                 // drain the echo
  pty.writeInput(new Uint8Array([127]));        // DEL
  check("erase takes a byte off the line", pty.report().linePending, 3);
  check("one erase counted", pty.report().erased, 1);
  // The echo of an erase is destructive: back up, overwrite, back up again.
  check("and echoes backspace-space-backspace", [...ENC.encode(outText(pty))], [8, 32, 8]);
  // "helo" minus one byte is "hel", so one more byte makes "help".
  pty.writeInput(ENC.encode("p\n"));
  check("the edited line is what the program reads", slaveRead(pty, s).text, "help\n");
}
{
  reset();
  const pty = open();
  const s = makeSlot();
  pty.writeInput(ENC.encode("rubbish"));
  outText(pty);
  pty.writeInput(new Uint8Array([21]));         // ^U
  check("kill empties the line", pty.report().linePending, 0);
  check("one kill counted", pty.report().killed, 1);
  check("and it echoes one erase per byte", ENC.encode(outText(pty)).length, 7 * 3);
  pty.writeInput(ENC.encode("ok\n"));
  check("so the program reads only what was typed after", slaveRead(pty, s).text, "ok\n");
}
{
  // An erase on an EMPTY line does nothing and echoes nothing: there is no byte to take back.
  reset();
  const pty = open();
  pty.writeInput(new Uint8Array([127]));
  check("erase on an empty line erases nothing", pty.report().erased, 0);
  check("and echoes nothing", outText(pty), "");
}

// ---- VEOF ---------------------------------------------------------------------------------
{
  reset();
  const pty = open();
  const s = makeSlot();
  pty.writeInput(ENC.encode("tail"));
  pty.writeInput(new Uint8Array([4]));          // ^D with a pending line -> deliver it
  check("^D on a partial line delivers it", slaveRead(pty, s).text, "tail");
  check("and no EOF was signalled", pty.report().eof, 0);
}
{
  reset();
  const pty = open();
  const s = makeSlot();
  check("a reader on an empty pty parks", slaveRead(pty, s), null);
  pty.writeInput(new Uint8Array([4]));          // ^D on an empty line -> EOF
  check("^D on an empty line wakes it", replies.length, 1);
  check("with 0, meaning EOF", reply(0).r0, 0);
  check("and NOT an errno", reply(0).r1, 0);
  check("one EOF counted", pty.report().eof, 1);
}

// ---- RAW MODE: every byte is readable at once --------------------------------------------
{
  reset();
  const pty = open();
  const s = makeSlot();
  const tm = defaultTermios();
  tm.lflag &= ~ICANON;
  pty.setTermios(tm);
  pty.writeInput(ENC.encode("x"));
  check("a raw byte is immediately readable", pty.report().inputPending, 1);
  check("and reads back", slaveRead(pty, s).text, "x");
  check("the line buffer is unused in raw mode", pty.report().linePending, 0);
}
{
  // LEAVING canonical mode flushes the pending line rather than losing or stranding it.
  reset();
  const pty = open();
  const s = makeSlot();
  pty.writeInput(ENC.encode("half"));
  check("a line is pending", pty.report().linePending, 4);
  const tm = defaultTermios();
  tm.lflag &= ~ICANON;
  pty.setTermios(tm);
  check("leaving canonical mode flushes it to the program", pty.report().inputPending, 4);
  check("and the line buffer is empty", pty.report().linePending, 0);
  check("so the typed bytes are not lost", slaveRead(pty, s).text, "half");
}

// ---- OUTPUT: the slave writes, the master reads -----------------------------------------
{
  reset();
  const pty = open();
  const m = makeSlot();
  const buf = new Uint8Array(64);
  check("a master with no output parks", pty.readOutput(m, m.seq, buf, 0, 64), null);
  pty.writeOutput(ENC.encode("hello from the program"));
  check("the slave's write wakes it", replies.length, 1);
  check("with the byte count", reply(0).r0, 22);
  check("and the bytes", DEC.decode(buf.subarray(0, 22)), "hello from the program");
  // Output is NOT processed: no echo, no canonical buffering, no signal scanning.
  reset();
  pty.writeOutput(new Uint8Array([3]));
  check("a ^C in OUTPUT is data, not a signal", groupSignals.length, 0);
}

// ---- termios round-trips, including the words this milestone does not use ----------------
{
  const pty = open();
  const tm = defaultTermios();
  tm.iflag = 0x11112222; tm.oflag = 0x33334444; tm.cflag = 0x55556666;
  tm.lflag = ISIG;                 // canonical and echo off
  tm.cc[19] = 0x7f;
  pty.setTermios(tm);
  const back = pty.getTermios();
  check("the reserved iflag survives", back.iflag, 0x11112222);
  check("the reserved oflag survives", back.oflag, 0x33334444);
  check("the reserved cflag survives", back.cflag, 0x55556666);
  check("lflag is what was set", back.lflag, ISIG);
  check("and the last cc slot survives", back.cc[19], 0x7f);
  checkThat("getTermios returns a COPY, so a caller cannot mutate the pty",
    (() => { back.cc[VINTR] = 99; return pty.getTermios().cc[VINTR] === 3; })(), "it aliased");
}

// ---- winsize and SIGWINCH ---------------------------------------------------------------
{
  reset();
  const pty = open();
  check("the default window", [pty.getWinsize().rows, pty.getWinsize().cols], [24, 80]);
  pty.setWinsize({ rows: 40, cols: 120, xpixel: 0, ypixel: 0 });
  check("a resize is stored", [pty.getWinsize().rows, pty.getWinsize().cols], [40, 120]);
  check("and raises SIGWINCH on the foreground group", groupSignals.length, 1);
  check("at the right group", sig(0).pgid, 7);
  check("with the right signal", sig(0).sig, SIGWINCH);
  reset();
  // RE-ASSERTING THE SAME SIZE IS NOT A RESIZE. A spurious SIGWINCH makes every full-screen
  // program redraw for nothing.
  pty.setWinsize({ rows: 40, cols: 120, xpixel: 0, ypixel: 0 });
  check("setting the same size raises nothing", groupSignals.length, 0);
}

// ---- closing: both sides see EOF, neither sees EPIPE ------------------------------------
{
  reset();
  const pty = open();
  const s = makeSlot();
  check("a slave reader parks", slaveRead(pty, s), null);
  pty.close(true);                              // the terminal goes away
  check("closing the master wakes it", replies.length, 1);
  check("with EOF", reply(0).r0, 0);
  check("a later read is EOF with no park", slaveRead(pty, s).n, 0);
}
{
  reset();
  const pty = open();
  const m = makeSlot();
  const buf = new Uint8Array(32);
  check("a master reader parks", pty.readOutput(m, m.seq, buf, 0, 32), null);
  pty.close(false);                             // the program exits
  check("closing the slave wakes it", replies.length, 1);
  // EOF, not EPIPE: the master is a READER here, and readers see EOF (docs/ABI.md decision 5).
  check("with EOF and not an errno", [reply(0).r0, reply(0).r1], [0, 0]);
}

// ---- readable(), which is what poll asks ------------------------------------------------
{
  const pty = open();
  checkThat("an empty pty is not readable by the slave", pty.readable(false) === false, "readable");
  checkThat("nor by the master", pty.readable(true) === false, "readable");
  pty.writeInput(ENC.encode("a\n"));
  checkThat("after a line the slave is readable", pty.readable(false), "not readable");
  checkThat("and the echo made the master readable", pty.readable(true), "not readable");
  const pty2 = open();
  pty2.close(true);
  checkThat("a slave whose master went is readable, because EOF is a readable event",
    pty2.readable(false), "not readable");
}

// ---- a stale record is never replied into ----------------------------------------------
{
  reset();
  const pty = open();
  const s = makeSlot();
  slaveRead(pty, s);
  check("a reader is parked", pty.report().waitingSlaves, 1);
  s.seq += 1;                                   // its call was answered by something else
  pty.writeInput(ENC.encode("x\n"));
  check("nobody was replied to", replies.length, 0);
  check("the record was dropped", pty.report().waitingSlaves, 0);
  checkThat("and counted as stale", pty.report().stale >= 1, pty.report().stale);
  check("the bytes stayed for the next reader", pty.report().inputPending, 2);
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
}, null, 2));
process.exit(failed.length ? 1 : 0);
