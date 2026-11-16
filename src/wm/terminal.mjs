// The terminal widget: a screen, a keyboard, and nothing else.
//
// ======================================================================================
// IT DOES NOT ECHO. THAT IS THE WHOLE DESIGN, AND THE ONE THING A REVIEWER SHOULD CHECK.
//
// A keystroke goes OUT and never appears on screen by this module's doing. The character the user
// sees is the pty's echo, which travelled: widget -> /dev/console -> `term` -> write(master) ->
// the kernel's line discipline -> the master's output queue -> `term` -> /dev/console -> here.
//
// A widget that echoed locally would look identical and would satisfy M4a's proof with no pty
// behind it at all. `MILESTONES.md` M4a's negative control is exactly that experiment — "detach
// the pty; the keystroke must not appear" — and it can only fail if this file keeps its hands off
// the screen. Local echo would ALSO be wrong in substance: `ECHO` is a termios flag the program
// owns, and a password prompt turns it off.
// ======================================================================================
//
// WHAT IT UNDERSTANDS, and the reason the list is this short: the shell emits plain text, `\r`,
// `\n`, and the destructive erase `\b \b` the line discipline writes for VERASE
// (`src/kernel/pty.mjs`). It emits no escape sequences at all — checked, not assumed:
// `src/bin/sh.mjs` and `src/libos/std.mjs` contain none. So a CSI parser here would be code with
// no caller, which the handoff's own rule calls unverified. A program that needs one is the
// milestone that adds one.

/** Where the screen scrolls from. A terminal is not a log and must not grow without bound. */
const MAX_LINES = 400;

/**
 * Bytes for a key event, or null for a key this terminal does not send.
 *
 * CONTROL CHARACTERS ARE PRODUCED HERE AND NOWHERE ELSE, because they are what makes the pty's
 * discipline reachable from a keyboard: Ctrl-C must arrive as 0x03 for `ISIG`/`VINTR` to raise
 * SIGINT, and Ctrl-D as 0x04 for `VEOF`. `event.key` for Ctrl-C is "c" with `ctrlKey` set, so the
 * translation cannot be skipped.
 */
export function bytesForKey(event) {
  const { key, ctrlKey, altKey, metaKey } = event;
  if (metaKey) return null;              // a browser or OS shortcut, not ours to take
  if (ctrlKey && !altKey) {
    if (key.length === 1) {
      // The C0 range: Ctrl-@ is 0, Ctrl-A is 1 ... Ctrl-Z is 26, then [ \ ] ^ _ as 27..31.
      // Uppercased first, so one subtraction covers both cases of the letter Chrome reports.
      const c = key.toUpperCase().charCodeAt(0);
      if (c >= 64 && c <= 95) return new Uint8Array([c - 64]);
    }
    return null;
  }
  // ENTER IS LINE FEED, NOT CARRIAGE RETURN, and this is not a style choice.
  //
  // `src/kernel/pty.mjs` commits a canonical line on byte 10 and implements no `ICRNL`, so a
  // terminal that sent 13 would type a line the shell never receives: the discipline echoes the
  // bare CR, the cursor returns to column 0, and `read(slave)` stays parked for ever. MEASURED —
  // it is the first thing this widget got wrong, and the symptom was a prompt that accepted
  // typing and never answered. `bench/m5-sh/program.mjs` writes "\n" to the master for the same
  // reason, which is the existing statement of this contract.
  if (key === "Enter") return new Uint8Array([10]);
  if (key === "Tab") return new Uint8Array([9]);
  if (key === "Backspace") return new Uint8Array([127]); // DEL, the pty's default VERASE
  if (key === "Escape") return new Uint8Array([27]);
  if (key.length === 1) return new TextEncoder().encode(key);
  // Arrows, function keys, modifiers on their own. A terminal that invented sequences for these
  // would be inventing a protocol no program here reads.
  return null;
}

export class Terminal {
  /**
   * @param {object} spec
   * @param {HTMLElement} spec.into    the window's client area
   * @param {Function} spec.onKeys     (Uint8Array) => void, the one route off this widget
   */
  constructor(spec) {
    this.onKeys = spec.onKeys;
    /** Finished lines, and the line under the cursor. Kept apart so `\r` and `\b` have something
     *  to move within — a single string of text has no cursor and cannot render an erase. */
    this.lines = [];
    this.line = "";
    this.col = 0;
    /** Everything ever received, for a check that wants the whole transcript rather than the
     *  visible window. The screen scrolls; the transcript does not. */
    this.transcript = "";
    this.bytesIn = 0;
    this.keyBytesOut = 0;
    /**
     * Keys that came from the BROWSER's own input pipeline, and keys a script synthesised.
     *
     * `event.isTrusted` is the only honest way to tell them apart, and the distinction is the
     * difference between M4a's proof and a weaker one: a `new KeyboardEvent(...)` dispatched by
     * the page exercises this widget's handler and nothing in front of it, while a key driven
     * through `Input.dispatchKeyEvent` goes through focus, key translation and event dispatch
     * exactly as a person's keypress does. `CLAUDE.md` asks for real input, so the check asserts
     * on `trustedKeys` and not merely on bytes having been sent.
     */
    this.trustedKeys = 0;
    this.synthKeys = 0;
    this.decoder = new TextDecoder("utf-8", { fatal: false });

    const pre = document.createElement("pre");
    pre.className = "terminal";
    // FOCUSABLE, because a terminal that cannot take the keyboard is a picture of a terminal. The
    // `textbox` role is the honest one: it is a thing you type into.
    pre.tabIndex = 0;
    pre.setAttribute("role", "textbox");
    pre.setAttribute("aria-multiline", "true");
    pre.setAttribute("aria-label", "Terminal");
    pre.addEventListener("keydown", (e) => this.#key(e));
    // A click anywhere in the screen takes the keyboard, which is what every terminal does.
    pre.addEventListener("pointerdown", () => pre.focus());
    spec.into.append(pre);
    this.el = pre;
    this.render();
  }

  focus() {
    this.el.focus();
  }

  #key(event) {
    const bytes = bytesForKey(event);
    if (!bytes) return;
    // TAKEN FROM THE BROWSER. Without this, Tab moves focus out of the terminal and Backspace can
    // navigate — and the byte is sent as well, so the terminal appears to work and the page jumps.
    event.preventDefault();
    if (event.isTrusted) this.trustedKeys += 1; else this.synthKeys += 1;
    this.keyBytesOut += bytes.length;
    // AND NOTHING IS DRAWN. See the header.
    this.onKeys(bytes);
  }

  /**
   * Bytes from the pty. The only thing that may change the screen.
   *
   * `stream: true` on the decoder is load-bearing: a multi-byte character can be split across two
   * reads of the master, and a non-streaming decode would render two replacement characters where
   * one letter belongs.
   */
  write(bytes) {
    this.bytesIn += bytes.length;
    const text = this.decoder.decode(bytes, { stream: true });
    this.transcript += text;
    for (const ch of text) {
      if (ch === "\n") {
        this.lines.push(this.line);
        this.line = "";
        this.col = 0;
      } else if (ch === "\r") {
        this.col = 0;
      } else if (ch === "\b") {
        if (this.col > 0) this.col -= 1;
      } else if (ch === "\x07" || ch === "\x00") {
        // A bell with no speaker, and a NUL. Dropped rather than rendered as a glyph.
      } else {
        // OVERWRITE AT THE CURSOR, which is what makes the erase sequence work: `\b` then a space
        // then `\b` leaves the cursor on a blank where the character was. Appending instead would
        // paint "a\b \b" as four visible cells.
        this.line = this.line.slice(0, this.col) + ch + this.line.slice(this.col + 1);
        this.col += 1;
      }
    }
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.render();
  }

  render() {
    this.el.textContent = [...this.lines, this.line].join("\n");
    this.el.scrollTop = this.el.scrollHeight;
  }

  /** What is on the screen, as one string. The check reads THIS and not the transcript, because
   *  the question M4a asks is what a reader would see. */
  screen() {
    return [...this.lines, this.line].join("\n");
  }
}
