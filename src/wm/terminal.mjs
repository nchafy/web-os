// The terminal widget: a screen, a keyboard, and nothing else.
//
// IT DOES NOT ECHO (constraint 161): the character the user sees is the pty's echo, round-tripped
// through the kernel's line discipline and back in via /dev/console.
//
// It understands plain text, `\r`, `\n`, and the destructive erase `\b \b` the line discipline
// writes for VERASE (`src/kernel/pty.mjs`); nothing here emits or parses an escape sequence.

/** Where the screen scrolls from: a terminal is not a log. */
const MAX_LINES = 400;

/** Bytes for a key event, or null for a key this terminal does not send. Control characters are
 *  produced here and nowhere else: `event.key` for Ctrl-C is "c" with `ctrlKey` set, so without the
 *  translation 0x03 never arrives and `ISIG`/`VINTR` never raises SIGINT. */
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
  // Enter is LINE FEED, not carriage return: `src/kernel/pty.mjs` commits a canonical line on byte
  // 10 and implements no `ICRNL`, so sending 13 types a line the shell never receives.
  if (key === "Enter") return new Uint8Array([10]);
  if (key === "Tab") return new Uint8Array([9]);
  if (key === "Backspace") return new Uint8Array([127]); // DEL, the pty's default VERASE
  if (key === "Escape") return new Uint8Array([27]);
  if (key.length === 1) return new TextEncoder().encode(key);
  return null;
}

export class Terminal {
  /** `spec.into` is the window's client area; `spec.onKeys` takes a Uint8Array and is the one
   *  route off this widget. */
  constructor(spec) {
    this.onKeys = spec.onKeys;
    /** Kept apart because a single string has no cursor for `\r` and `\b` to move within. */
    this.lines = [];
    this.line = "";
    this.col = 0;
    /** The screen scrolls at MAX_LINES; this does not. */
    this.transcript = "";
    this.bytesIn = 0;
    this.keyBytesOut = 0;
    /** Keys from the BROWSER's own input pipeline, and keys a script synthesised. A
     *  `new KeyboardEvent` exercises this handler and nothing in front of it, and `isTrusted` is
     *  the only way to tell them apart, so M4a's check asserts on `trustedKeys`, not bytes sent. */
    this.trustedKeys = 0;
    this.synthKeys = 0;
    /** The PRINTABLE characters this widget has sent, in order, so a checker can derive what the
     *  echo should contain rather than agree a string with the thing being checked. */
    this.printableSent = "";
    this.decoder = new TextDecoder("utf-8", { fatal: false });

    const pre = document.createElement("pre");
    pre.className = "terminal";
    // Focusable: a terminal that cannot take the keyboard is a picture of a terminal.
    pre.tabIndex = 0;
    pre.setAttribute("role", "textbox");
    pre.setAttribute("aria-multiline", "true");
    pre.setAttribute("aria-label", "Terminal");
    pre.addEventListener("keydown", (e) => this.#key(e));
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
    // Without this the byte is sent AND Tab moves focus out, Backspace navigates.
    event.preventDefault();
    if (event.isTrusted) this.trustedKeys += 1; else this.synthKeys += 1;
    this.keyBytesOut += bytes.length;
    for (const b of bytes) {
      if (b >= 0x20 && b < 0x7f) this.printableSent += String.fromCharCode(b);
    }
    // And nothing is drawn (constraint 161).
    this.onKeys(bytes);
  }

  /** Bytes from the pty. The only thing that may change the screen. `stream: true` is load-bearing:
   *  a multi-byte character can be split across two reads of the master. */
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
        // Overwrite at the cursor, which is what makes `\b` space `\b` erase: appending would
        // paint "a\b \b" as four cells.
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

  /** What is on the screen — what a reader would see, which is what M4a's check asks. */
  screen() {
    return [...this.lines, this.line].join("\n");
  }
}
