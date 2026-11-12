# Context

Background for a reader who has not built an operating system, has not used the other web OSes,
and has not seen the predecessor. Nothing here is normative — `docs/CONSTRAINTS.md` is. This is
the orientation that makes the rest readable.

---

## 1. What an operating system actually is

An operating system solves one problem: you have one computer and many programs that all want it.
Without something in the middle, any program could read any other program's memory, overwrite any
file, and hold the processor forever. The OS is that middle.

It does it with about six ideas.

**A process** is a running program — not the file on disk, the running instance. Every process has
a number, its **pid**, and that number is how everything else refers to it. "Kill process 4812"
works because 4812 is a real handle on a real thing.

The property that matters most here: a process exists on its own. It does not need a window. A web
server, a backup job, a clock — processes with no visible surface. And a process can own two
windows, or close its window and keep running.

**The kernel** is the one program allowed to touch things: the disk, memory, the screen. No other
program does. It is not "the OS's code" loosely speaking; it is a specific privileged thing with a
hard wall around it.

**A syscall** is how a process asks the kernel for something, and it is the only way. A process
cannot write a file; it calls `write()` and the kernel writes the file, after checking whether this
process may. Linux has a few hundred: `open`, `read`, `write`, `close`, `kill`, `mkdir`. That list
— the names, the arguments, the errors — is the **ABI**, and it is the real interface of an
operating system. Everything else is built on it.

Stated plainly, because it is the whole thesis of this project: **the wall between a process and
the kernel is what makes something an operating system.** Not the icons.

**The filesystem** is more than storage; in Unix it is the system's *namespace*, the place where
everything has a name. Documents are files. So is the mouse (`/dev/input/mouse0`), the random
number generator (`/dev/random`), and every running process (`/proc/4812/status`). You can read the
state of process 4812 as if it were a text file, because as far as the system is concerned it is
one.

Files carry **permissions** — a mode and an owner — and that only means something because the
kernel knows *who is asking*. Every process carries an identity. Permissions without a caller
identity are decoration, which is exactly what they were in the predecessor.

A **mount** makes two different stores appear as one tree: a USB stick shows up at `/media/usb` and
is thereafter just part of the same namespace.

**The shell** reads what you type and spawns processes. `ls | grep txt | wc -l` starts three
processes and connects them with **pipes** — one-way channels where one process's output is
another's input. Neither `ls` nor `wc` knows the other exists. That is composition, and it is what
makes a command line more than a menu.

**Signals** interrupt a process. Ctrl-C sends `SIGINT`. `kill -9` sends `SIGKILL`, which cannot be
refused. Ending a program against its will is the difference between a system you control and one
you negotiate with.

**What is *not* the operating system:** the window manager. The thing that draws title bars and
runs the taskbar is just another program — on Linux you can replace it while the machine keeps
running. Windows 7's glass, taskbar and Snap are a skin over a kernel that does not care what it
looks like.

Which is why the two goals here are not in tension. They are different layers.

---

## 2. Why a browser makes this hard

A web page is the opposite of an operating system. All the JavaScript on a page runs in one
**realm** — one shared global namespace — on one thread. Every script can see and modify every
other script's variables. There is no wall anywhere.

And you cannot **preempt**. A real kernel interrupts a running program thousands of times a second
to give someone else a turn. A browser cannot do that to JavaScript: a function that loops forever
freezes the tab until it stops.

Four primitives make it possible anyway. The entire architecture is these four.

**A Worker** is a separate thread with its own realm. It cannot touch the page's variables — only
exchange messages. And you can call `terminate()` on it. That is the kill.

**SharedArrayBuffer** is memory two threads both see. With `Atomics.wait()` a Worker can *pause
itself* on a location until someone changes it — a **futex**, the primitive real kernels use for
blocking. It is what lets a process call `read()` and genuinely wait, instead of being forced into
callbacks.

**OPFS** is real file storage in the browser, and uniquely offers *synchronous* access — but only
inside a Worker.

Together: a process is a Worker, it blocks on a SharedArrayBuffer, and the kernel is another Worker
that replies. Measured here at **14–16 µs per round trip**, which turned out to be *faster* than
asynchronous message passing.

**The fourth piece is the price.** SharedArrayBuffer only exists if the server sends two headers
(`COOP` and `COEP`), because SAB plus a precise timer is a Spectre side channel. That is why
GitHub Pages cannot host this, and why fonts and assets must be self-hosted. It is also why
third-party *iframes* can never appear inside the desktop — though note that is mostly the web's
own `X-Frame-Options` policy rather than anything this project chose.

**Measured, not assumed:** map tiles work fine. `bench/coep-tiles/` loads OpenFreeMap vector tiles
plus OpenStreetMap, OpenTopoMap and Esri raster tiles under full isolation, with zero blocked
requests and a negative control proving the check can fail. Anything that sends
`Access-Control-Allow-Origin` is fine, because `require-corp` accepts a resource fetched in CORS
mode. The ban is narrower than it first sounds.

---

## 3. The other web operating systems

**daedalOS** (`dustinbrett.com`, `DustinBrett/daedalOS`) is the most impressive-looking and the most
instructive. A Windows-style desktop in React with a real filesystem, file associations,
drag-and-drop from the host OS, and emulators — DOS games, Flash, a whole VM — running in windows.
It feels remarkably like an OS.

It has no kernel. A "process" is a record holding a React component; apps are components in the
page's own realm sharing one global namespace. The cost is visible in its own source: `utils/
globals.ts` replaces `window.define` with a getter that **reads the JavaScript stack trace** to
decide which app should receive the value, and hand-deletes a list of global names after certain
apps close. That is what thirty third-party runtimes in one namespace costs.

*Its best idea, worth taking:* a build-time JSON index of a read-only filesystem image served over
HTTP, with a writable overlay on top — copy-on-write `/usr`. That is where `/usr` comes from in M3.

**OS.js** (`demo.os-js.org`) is the most deliberately OS-shaped: a login screen, a service
registry, mountable filesystems, a package format. Everything is reached by asking for it by name
rather than importing it, which is a genuinely good discipline. But apps are `<script>` tags
injected into the host page and they receive the real core object as an argument, so the blacklist
protecting it is decorative. It also requires a Node server; without one its only read/write
filesystem stops working.

**win32.run** and **RipenOS** are the same shape as the predecessor — a convincing desktop with no
boundary underneath. Not a criticism; they are doing a different thing. There is little to learn
from them that the two above do not teach better.

**Two that were not on the original list and matter more.** **Puter** (`HeyPuter/puter`) is the only
surveyed system with a real wall: every app runs on its own web **origin**, a boundary the browser
itself enforces, with a per-(user, app) token distinct from the desktop session. **anuraOS** has the
opposite half — a genuinely Unix-shaped runtime with pids, `kill`, stream stdio, shebang-dispatched
exec and longest-prefix mounts — but built on same-origin iframes, so: processes with no
protection.

**Nobody has both.** That gap is the opening this project aims at. And one measured finding explains
why it stayed open: a cross-origin iframe is in a different *agent cluster*, so the kernel's
SharedArrayBuffer arrives there as `messageerror`. Puter's isolation and a shared blocking syscall
channel are mutually exclusive (constraint 12). You can have the wall or the fast syscall, not both
— so this project takes the syscall, and scopes the threat model to first-party code.

---

## 4. The predecessor, and what it got wrong

`../webxp` is a Windows XP desktop: windows dragging and resizing from eight edges, minimising into
their own taskbar buttons, a Start menu, 42 apps, and a working filesystem behind a terminal with
inodes, symlinks, hard links and permission bits.

It also has an 11,991-line harness that drives real mouse input through Chrome and reads the
resulting geometry back, including a mode that inverts every assertion to prove the tests can fail.
That discipline is better than most production codebases have, and it carries over directly — see
`CLAUDE.md`.

Two decisions stopped it being an operating system.

**Apps import the filesystem.** `../webxp/apps/notepad/app.mjs` pulls in `../webxp/shared/fs/fs.mjs`. Notepad does not
*ask* for a file; it reaches in and takes it. So the permission bits in that filesystem can never be
enforced, because there is no caller to check. The app and the kernel are the same program.

**An app *is* its window.** The contract is `mount(root)`: you hand an app a DOM element and it
fills it. So an app with no window is inexpressible. An app with two windows is inexpressible. An
app that keeps running after you close its window is inexpressible. "End Process" means unmounting
some HTML.

Neither is a bug. They are the architecture, and they are load-bearing for all 42 apps — which is
why this is a new repository rather than a refactor.

**What comes across:** `shared/fs/vfs.mjs` (1,301 lines of inode logic) as the layer above the
store; `../webxp/src/window.mjs` (836 lines) as the window manager; the terminal's parser; and the harness.
**What does not:** the app contract, and the assumption that file data is a JavaScript string.

---

## 5. The thesis, in one paragraph

A kernel boundary in a browser is not a virtual machine. It is a synchronous syscall channel from a
process Worker into an asynchronous kernel Worker: `postMessage` out, `Atomics.wait` on a
SharedArrayBuffer for the reply, measured at 14–16 µs. That single mechanism is what all four
reference systems lack, and building it forces everything else into existence — a process table, fd
tables, pipes, credentials, and a kill that actually kills. Running real Linux in a tab (v86,
CheerpX) is a separate question with a separate answer: it gives you a real kernel as a black box
behind a serial cable, where the host cannot see guest processes or route a window to a guest pid.
It does not substitute for writing the channel.
