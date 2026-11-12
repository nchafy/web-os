# Hobbyist OS field survey: what SerenityOS, HelenOS, Redox, the tiny-budget systems, the persistent systems and the dead solo-dev desktops know that this plan does not

Source list: the systems linked from <https://en.wikipedia.org/wiki/Hobbyist_operating_system> (AROS,
DexOS, EmuTOS, GeckOS, Ghost, HelenOS, KolibriOS, LUnix, MenuetOS, Phantom OS, Redox, SerenityOS,
Syllable Desktop, SymbOS, TempleOS, SkyOS, AtheOS), plus BeOS/Haiku, which is not on the list but is
the architecture AtheOS and Syllable are both copies of.

Raw evidence, append-only, same contract as the rest of `research/`. The distilled actions — proposed
constraints, proposed decisions, milestone deltas — are in `09-hobbyist-os-actions.md`. Where a
finding is already answered by `../CONSTRAINTS.md`, it says so and names the constraint, because a
survey that re-raises settled questions is noise.

Wikipedia itself carries almost nothing load-bearing: it defines a hobby OS by its developers'
motive rather than any technical property, gives one-line descriptions for only three of the
seventeen systems, and its only general claims are that development may start from an existing
kernel or from scratch, that C and assembly dominate, and that most hobby systems stop at a text
interface because a GUI is harder. Orientation only. Every finding below comes from the projects'
own source or documentation.

---

## 1. SerenityOS

The most directly comparable system in the set: a from-scratch Unix-like kernel whose entire GUI is
userland processes talking a generated IPC protocol to a compositor that is itself an ordinary
process. It is what this project is trying to be, with twelve years and hundreds of contributors
already spent on it.

All GitHub citations in this section are blob URLs pinned at
`32c6480ae7ec919eeda050f7a84d9532c87a0738` (`SerenityOS/serenity` master HEAD as of
2026-11-12), so they do not rot.

### A SerenityOS "synchronous" high-level call does not block its thread — it reentrantly pumps the caller's own event loop (`while (!resolved) Core::EventLoop::current().pump();`), so the process keeps dispatching unrelated events while a request is outstanding.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibCore/Promise.h#L53-L59
- Confidence: verified
- Why it matters: **this is the largest structural divergence in the survey, and it is not available
  to us.** `Atomics.wait` on the one futex word freezes the whole Worker; nothing can be dispatched
  while parked, so there is no reentrant-pump option at any price. Every API shaped "looks
  synchronous, actually pumps" — file pickers, modal dialogs, decode results, anything that needs an
  answer from another *process* rather than from the kernel — has to be rebuilt as an explicit state
  machine driven from `poll()`. The blocking channel is cheaper than async per call (constraint 6)
  and strictly less expressive per *program*. That trade is currently undocumented.

### `GUI::Dialog::exec()` implements modality by constructing a nested `Core::EventLoop` inside the calling function and running it to completion; `done()` quits the inner loop and `exec()` returns the result to the original call site.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibGUI/Dialog.cpp#L22-L47; the event-loop stack is a documented feature — https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Documentation/EventLoop.md#L25
- Confidence: verified
- Why it matters: the server half of modality transfers (see `WindowMode` below); the client half
  cannot. `const name = await prompt()` written as straight-line code is the single most common shape
  in GUI application code and it is inexpressible in a one-futex-word process. Either every dialog
  call site is a continuation, or a process gets a second, non-blocking reply path.

### The *client* allocates both window backing stores as anonymous shared-memory bitmaps and hands the fd to WindowServer with a monotonically increasing serial; on a steady-state buffer flip the client re-sends an already-known serial and the server only calls `swap_backing_stores()`, mapping nothing new.

- Evidence: client https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibGUI/Window.cpp#L1028-L1062 (serial allocated at #L39-L49); server https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/ConnectionFromClient.cpp#L779-L812; wire form `set_window_backing_store(i32 window_id, i32 bpp, i32 pitch, IPC::File anon_file, i32 serial, bool has_alpha_channel, Gfx::IntSize size, Gfx::IntSize visible_size, bool flush_immediately) => ()` at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowServer.ipc#L104
- Confidence: verified
- Why it matters: contradicts the M8 surface design (`win_create` returns a transferred
  `OffscreenCanvas`). A transfer is a one-way, one-shot handoff — the client loses the object — so
  there is no front/back pair, no serial, and no cheap flip. Double buffering needs two surfaces the
  process *retains* plus a per-frame "which is current" word. The ownership rule is worth copying
  verbatim: client allocates, client frees, server holds a mapping keyed by serial, and the serial is
  what makes the steady-state flip free.

### The idle back buffer is marked `madvise(MADV_SET_VOLATILE)` so the kernel may purge it under memory pressure; the next paint sets `MADV_SET_NONVOLATILE`, a `was_purged` result forces a full-window repaint, and an `ENOMEM` result permanently downgrades that window to single-buffered.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibGUI/Window.cpp#L61-L100; fallback at #L515-L538
- Confidence: verified
- Why it matters: the plan has no memory-pressure story at all. At the 1,000-process design limit
  (constraint 17) with two full-window surfaces each, surfaces are the first thing to exhaust the
  renderer — and they are *also* the thing the blur governor already accounts (constraint 49), so
  there are two independent budgets over the same pixels. The protocol shape transfers even though
  `madvise` does not: the window protocol needs a kernel→process "your back buffer is gone, repaint
  everything" event and a per-window single-buffered degraded mode. That belongs in the ABI, not in
  app code.

### A service acquires its capabilities as file descriptors and *then* drops the promise that would let it acquire more: ImageDecoder pledges `"stdio recvfd sendfd thread unix"`, locks the veil with zero paths via `unveil(nullptr, nullptr)`, takes over its already-accepted client socket, then re-pledges `"stdio recvfd sendfd thread"` — dropping `unix`.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/ImageDecoder/main.cpp#L13-L23
- Confidence: verified
- Why it matters: this is what M6 is groping toward, done the right way round. The restriction lives
  in *kernel* per-process state and is checked by the syscall dispatcher; it is not the sandboxed
  code deleting its own globals. We can have the real thing cheaply: a capability bitmask in the
  process table, a `pledge`-shaped syscall that can only ever clear bits, and a check at dispatch.
  That is a genuine boundary against a confused-deputy bug in a first-party app — which is this
  project's actual threat model (D6) — in a way that deleting `fetch` inside the worker is not.
  Constraint 41's "hardening, not a boundary" label stays true of the realm lockdown and would not
  be true of this.

### Process credentials are an immutable, atomically-refcounted kernel object holding `uid/gid/euid/egid/suid/sgid/extra_gids` plus **`sid` and `pgid`**, replaced wholesale rather than mutated, in a region the kernel remaps read-only after each update.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Kernel/Security/Credentials.h#L15-L46; rationale at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/usr/share/man/man7/Mitigations.md#L350-L367
- Confidence: verified
- Why it matters: partly answered — D12 already says the credential is read from the process table
  and never from process-controlled memory, so the "per-call argument" wording describes the VFS
  function signature, not the trust path. Two things are *not* answered. The credential needs `sid`
  and `pgid` in it, because job control needs them and the ABI currently has `setpgid` with no
  session concept. And a multi-step path resolution should take one immutable snapshot at syscall
  entry rather than re-reading, so a `chown` landing mid-walk cannot straddle the check. Note
  Serenity's own man page is explicit that `unveil` restricts paths and does **not** replace ordinary
  permission checks: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/usr/share/man/man2/unveil.md#L38-L42

### A sandboxed app reaches arbitrary user files with no path permission at all: TextEditor unveils only `/res` plus three portal sockets, then gets an **open fd** for a user-chosen file from FileSystemAccessServer, which draws the picker itself and passes the fd back over the socket.

- Evidence: app https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Applications/TextEditor/main.cpp#L21-L39; `request_file(i32 request_id, i32 window_server_client_id, i32 window_id, ByteString path, Core::File::OpenMode requested_access) =|` at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/FileSystemAccessServer/FileSystemAccessServer.ipc#L5-L12; reply `handle_prompt_end(i32 request_id, i32 error, Optional<IPC::File> fd, Optional<ByteString> chosen_file) =|` at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/FileSystemAccessServer/FileSystemAccessClient.ipc
- Confidence: verified
- Why it matters: the piece the VFS design is missing entirely. A credential-checked path namespace
  means every app must be *trusted with a namespace*; the broker inverts it — the app names nothing,
  the user clicks, the app receives a pre-opened fd. In our terms: a call that installs an
  already-open inode handle into another process's fd table. It also makes the file picker one
  implementation instead of one per app, which matters when one developer writes every app.

### Handle passing is a generic, out-of-band, bounded facility: `sendfd(2)`/`recvfd(2)` move an fd across a local socket without touching the byte stream, never block, and fail `EBUSY`/`EAGAIN` when the peer queue is full or empty — each gated by its own pledge.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/usr/share/man/man2/sendfd.md and https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/usr/share/man/man2/recvfd.md
- Confidence: verified
- Why it matters: undercuts the stated reason for the `win_*` family (D7: "a file write cannot
  transfer a canvas handle"). The general answer is not "give windows their own syscalls" but "give
  the ABI one out-of-band handle queue per process, with a bounded depth and an `EAGAIN`", built from
  `postMessage` transfer lists running alongside the SAB. Then window surfaces, clipboard buffers,
  broker-supplied files and received SABs all use one mechanism. The SAB reply word cannot carry a
  transferable, so *any* reply returning a handle needs this path — it was never a window-only
  problem.

### Client→server messages may be synchronous but server→client messages are 100% asynchronous: `WindowServer.ipc` is 46 sync / 54 async, while `WindowClient.ipc` is 0 sync / 35 async and `WindowManagerClient.ipc` 0 sync / 12 async. The one exception in the tree is `WebContentClient.ipc` (12 sync) — the browser.

- Evidence: counted with `grep -c '=>'` / `grep -c '=|'` over https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowClient.ipc and https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowServer.ipc; exception at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WebContent/WebContentClient.ipc#L71-L85
- Confidence: verified (counts reproducible with that grep on those blobs)
- Why it matters: the whole deadlock-avoidance discipline is a **lint rule over the protocol
  definition**, not a runtime mechanism. With one outstanding call per process, a kernel→process
  synchronous call is an instant deadlock. Write the rule down and enforce it mechanically.

### While blocked on a sync reply, a connection still reads the socket and queues non-matching messages into `m_unprocessed_messages` for deferred dispatch, matching the reply only by `(endpoint_magic, message_id)` — there is no sequence number.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibIPC/Connection.cpp#L206-L227; `send_sync` at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibIPC/Connection.h#L92-L99
- Confidence: verified
- Why it matters: two consequences. Draining-while-blocked is what stops the peer's writes from
  blocking, and a process parked in `Atomics.wait` cannot drain — so the kernel must buffer each
  process's event backlog itself, and that buffer needs a bound and a defined overflow (the same
  defect class as constraint 9). And reply matching with no correlation id is safe *only* because
  exactly one call is outstanding; the ABI's CALLID field plus the one-call invariant is the same
  bet, and it should be asserted rather than assumed.

### IPC write back-pressure is handled differently for the two directions: on `EAGAIN`/`EMSGSIZE` an async send reentrantly pumps the event loop while a sync send calls `sched_yield()`, capped at 100 write attempts, logging a `FIXME` whenever more than one write was needed.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibIPC/Message.cpp#L41-L104 (cap at L79, branch at L80-L83)
- Confidence: verified
- Why it matters: partly answered — the ABI already defines overflow as a short count plus
  `shm_create` for bulk, which is the better answer. The transferable part is negative: do not build
  the spin-and-pump path, because we cannot pump while blocked. A hard limit plus a handle is the
  only shape available.

### Payloads that may be large never travel in the message body — they travel as a `Core::AnonymousBuffer` (an fd plus a size, mmapped on receipt). The clipboard reply itself carries one, and the entire system theme is broadcast to every client as a single shared buffer inside `fast_greet`.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/Clipboard/ClipboardServer.ipc; https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibCore/AnonymousBuffer.h#L37-L48; theme buffer in `fast_greet` at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowClient.ipc#L6
- Confidence: verified
- Why it matters: a *reply* carrying a handle is routine, not exotic — the clipboard is the second
  case after the window surface where the SAB reply channel cannot express the answer. Two cases make
  it a mechanism, not a special case (`CLAUDE.md`: the second caller justifies the abstraction). The
  theme-broadcast detail is also a direct answer to constraint 18: one shared buffer every client
  maps is O(1), where pushing a theme to N processes is O(N).

### A long-running request is split in two: the sync call returns only a correlation ticket, and the result arrives later as an async message keyed by it — `decode_image(…) => (i64 image_id)` then `did_decode_image(i64 image_id, …)`, with `cancel_decoding(i64 image_id)` as a separate async message.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/ImageDecoder/ImageDecoderServer.ipc and https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/ImageDecoder/ImageDecoderClient.ipc
- Confidence: verified
- Why it matters: raises a question M0 does not ask. Our kernel never blocks (constraint 2), so a
  *process* waiting a long time is fine — but the kernel's own thread is the only one in the system,
  and the fast VFS path is **synchronous** OPFS calls on that thread. A 495 µs `createSyncAccessHandle`
  (22), a 260 µs `flush()` (23), and Safari's 0.60 ms-per-name directory enumeration (33) are all
  head-of-line blocking for all 128 processes, not just the caller. Either the slow calls are
  ticketed and completed through `poll()`, or OPFS handles move to a second kernel-side I/O worker.
  M0 measures contention with `getpid`/`write`/`nanosleep` — none of which touch OPFS — so it cannot
  see this.

### The single wait primitive is `poll()` over a fd set whose first entry is a self-pipe: `wake()` writes `0i32` into it and the POSIX signal handler writes the (always non-zero) signal number, so signals, cross-thread wakes, timers and socket readiness all resolve to one `poll()` return, and the read drains an array of pending wakes at once.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibCore/EventLoopImplementationUnix.cpp#L268-L298 and the single wait at #L385-L418; prose at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Documentation/EventLoop.md#L17-L20
- Confidence: verified
- Why it matters: independent confirmation of D8 and constraint 42 — one wait primitive, everything
  is an fd, `EINTR` just re-polls. Mostly already answered, since the kernel bumps `SEQ` and sets
  `SIGPEND` together so a process parked in `poll()` does wake. The new detail is **coalescing**:
  one wake-up drains *all* pending events in one read, which is what keeps a signal storm from
  costing one round trip per signal.

### Ctrl-C is a kernel TTY concept, not a window-manager one: `TTY::handle_input` compares the byte against `c_cc[VINTR]`/`VQUIT`/`VSUSP` and calls `generate_signal()`, which signals **every process in the foreground process group**; the same layer raises `SIGTTIN`/`SIGTTOU` for background I/O, `SIGWINCH` on resize and `SIGHUP` on hangup.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Kernel/Devices/TTY/TTY.cpp#L183-L198, #L353-L365, #L44-L46, #L83-L85, #L559, #L582
- Confidence: verified
- Why it matters: M4 already puts `ICANON`/`ECHO`/`ISIG`/`VINTR`/`VQUIT`/`VSUSP` in the kernel and
  the ABI already raises `SIGWINCH` from `tty_winsize_set`, so the shape is right. Missing:
  `SIGTTIN`/`SIGTTOU` for a background process touching the terminal (which is how `ps` in a
  background job behaves correctly rather than interleaving output), `SIGHUP` on window close, and a
  session id to hang them off.

### SerenityOS has a kernel `posix_spawn` that returns `ENOTSUP` the moment any file actions or spawn attributes are supplied — the real pre-exec work still happens in a forked child — and the POSIX surface it would have to carry is `addopen`/`addclose`/`adddup2`/`addchdir`/`addfchdir`/`adddestroy` plus `setpgroup`/`setschedparam`/`setschedpolicy`/`setsigmask`/`setsigdefault`/`setflags`.

- Evidence: `ENOTSUP` at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Kernel/Syscalls/posix_spawn.cpp#L35-L38; the man3 set under https://github.com/SerenityOS/serenity/tree/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/usr/share/man/man3; semantics at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/usr/share/man/man3/posix_spawn.md
- Confidence: verified
- Why it matters: the ABI's `SpawnSpec` action list is already ordered, which is the thing that
  matters (`dup2(3,1); close(3)` and the reverse differ) — so this is mostly confirmation. Two gaps:
  the spec carries no signal mask or signal-disposition reset, and no `chdir`. And one improvement
  worth taking deliberately: POSIX lets `posix_spawn` **return 0** when a post-fork file action or
  the `exec` itself fails, leaving the child to exit 127. A spawn-only ABI with no fork can report
  that failure synchronously instead, and should say so.

### SerenityOS's own service launcher still uses `fork()` precisely because the pre-exec window is where the work is: `Service::spawn` forks and then, in the child, does `chdir`, `sched_setparam`, opens `StdIO` as fd 0 and `dup2`s it to 1 and 2, calls `ioctl(TIOCSCTTY)` to take a controlling terminal, builds a `SOCKET_TAKEOVER` env var of `path:fd[;path:fd…]`, drops privileges, and only then `exec`s.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/SystemServer/Service.cpp#L147-L236 (fork L157, `TIOCSCTTY` L181, `SOCKET_TAKEOVER` L197-L221, exec L236)
- Confidence: verified
- Why it matters: read it as the acceptance test for `SpawnSpec`. If `spawn` cannot express that
  list, services cannot be written in this system at all — and `TIOCSCTTY` is the awkward one,
  because taking a controlling terminal is a *capability acquisition* in the pre-exec window rather
  than a parameter. `SOCKET_TAKEOVER` is the same trick as inheriting an fd by number, named in the
  environment.

### Lazily-started services are socket-activated: SystemServer binds and `listen(…, 16)`s the portal socket itself, watches it with a notifier, and on first readability `accept()`s and spawns one process per connection — so a client's `connect()` never fails because the service was not running. The policy is declarative per service (`Lazy`, `MultiInstance`, `AcceptSocketConnections`, `KeepAlive`) with asserted invariants.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/SystemServer/Service.cpp#L75-L125 and asserts at #L354-L359; declarations at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/etc/SystemServerUser.ini
- Confidence: verified
- Why it matters: with a hard process cap (17) and ~600 KiB resident each, eager service startup
  spends the budget before the user opens anything. Per-connection spawn is also how you get
  one-decoder-per-document isolation for free. The ABI consequence is small and already mostly
  present: the kernel must be able to create a process whose low fds are pre-populated with
  already-connected endpoints.

### PID 1 selects a whole service *set* from a kernel-reported boot mode read out of `/sys/kernel/system_mode`, with `self-test` as a first-class mode; each service declares the modes it runs in, and failure to determine the mode degrades to `text` rather than aborting.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/SystemServer/main.cpp#L75-L124 and #L184-L208; `SystemModes=` and the `self-test` TestRunner entry at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/etc/SystemServer.ini
- Confidence: verified
- Why it matters: the harness should be a **boot mode of the real system**, not a separate driver —
  a URL parameter that makes PID 1 start the test runner instead of the taskbar, so the thing under
  test is the real kernel, real VFS and real WM. It also gives the plan something it does not have:
  a PID 1 at all. M3 generates `/proc` but nothing owns service startup, session state, or the
  restart policy for a crashed shell.

### CI runs the whole OS in QEMU in `self-test` mode with `panic=shutdown`, then runs `e2fsck -f -y` on the disk image, loop-mounts it on the host, and fails the job unless `/home/anon/test-results.log` *inside the image* contains the literal string `Failed: 0`; a separate always-run step dumps `debug.log`.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/.github/workflows/serenity-template.yml#L165-L196
- Confidence: verified
- Why it matters: harness honesty with teeth, and it fails closed in three places at once. The
  result must *exist on persisted storage*, must be read back after the system is gone, and must
  match an exact string — so a run that never started cannot pass. `panic=shutdown` turns a kernel
  panic into a job failure rather than a hang. Our equivalent: write results into OPFS, tear the page
  down, reopen and read them from a fresh context, and treat a missing or short result file as
  failure. That also exercises the persistence path for free.

### SerenityOS builds its own libraries a second time for the host ("Lagom") specifically so unit tests, ASAN/UBSAN and continuous fuzzing run on the build machine: 81 fuzz targets under `Meta/Lagom/Fuzzers/` wired to OSS-Fuzz, while the OS target itself supports only UBSAN.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Meta/Lagom/ReadMe.md#L11-L19 and #L51-L58; sanitizer policy at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Documentation/RunningTests.md#L44-L65; target count from `gh api repos/SerenityOS/serenity/git/trees/32c6480ae7ec919eeda050f7a84d9532c87a0738?recursive=1` filtered to `Meta/Lagom/Fuzzers/` → 81 paths
- Confidence: verified
- Why it matters: the strongest development-practice finding in the survey, and nearly free here.
  The kernel's pure parts — the inode table, superblock and journal encode/decode and replay, path
  resolution, syscall argument decoding, the dispatch table — should run in plain Node with no
  Worker, no SAB and no OPFS, so they are unit-testable and fuzzable in milliseconds. **Journal
  replay is a parser over torn bytes and is exactly a fuzz target**; M2's negative control tests one
  hand-truncated journal, where a fuzzer tests ten thousand. This costs nothing in dependencies and
  does not violate the no-build-step rule: the same `.mjs` files, imported by a test script.

### Negative controls for "this must die" are a library primitive: `LibTest::Crash` runs the offending function in a child process and asserts it died, optionally with a specific signal, treating `DidNotCrash` as a test failure.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibTest/CrashTest.h#L17-L41
- Confidence: verified
- Why it matters: the natural home for `--prove-failure` applied to capability denial rather than to
  geometry. It also implies an ABI requirement the plan does not list: `waitpid` must let the parent
  distinguish "exited with code N" from "killed for reason R". With `Worker.terminate()` as the only
  kill and no exit path in the dying worker, **the kernel is the only thing that can record why**, so
  the reason has to be written into the process table at teardown or it is lost.

### `pledge()` and `unveil()` are tested with explicit widening-must-fail assertions: after `unveil("/etc","r")` each of `"w"`, `"x"`, `"c"` must fail; after `pledge("stdio unix rpath","stdio")`, adding `unix` must fail while narrowing to `pledge("stdio","stdio")` must succeed.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Tests/Kernel/TestKernelUnveil.cpp#L42-L70 and https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Tests/Kernel/TestKernelPledge.cpp#L43-L56
- Confidence: verified
- Why it matters: the assertion is on the **invariant** (monotonic narrowing), not on a symptom —
  which is exactly what `CLAUDE.md` demands and what a "can app X read file Y" test fails to give.
  Serenity's own man page also admits a hole worth copying as a test case: until the veil is locked,
  a restriction on a directory can sometimes be circumvented by unveiling a subdirectory with
  different permissions (https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/usr/share/man/man2/unveil.md#L44-L49).

### Menus live entirely inside WindowServer: clients call `create_menu`/`add_menu_item`/`add_menu_separator`/`popup_menu` and receive only `menu_item_activated`/`menu_item_entered`/`menu_item_left`/`menu_visibility_did_change` — the compositor process owns menu layout, rendering, hit-testing and keyboard navigation.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowServer.ipc#L7-L44 and #L111-L112; events at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowClient.ipc#L27-L30; `Menu.cpp`, `MenuManager.cpp`, `Menubar.cpp` under https://github.com/SerenityOS/serenity/tree/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer
- Confidence: verified
- Why it matters: a direct answer to having no preemption (21). A menu drawn by the compositor still
  opens, animates and highlights while the owning app sits in a compute loop; a menu drawn by the
  app does not. The same argument covers the caption, the resize grip, the scrollbar and the modified
  marker (`set_window_modified`, WindowServer.ipc L76-L77). **Which chrome is server-drawn is a
  decision the plan has not made**, and with no preemption it decides what stays alive when an app
  wedges.

### An unresponsive client is detected without any cooperation from it: a 3-second single-shot timer armed on every outgoing message fires `may_have_become_unresponsive()`, which sends an async `ping()`; if no `pong()` arrives within another 1000 ms, WindowServer overrides the cursor to the wait cursor on all that client's windows and invalidates them so the frames repaint "not responding".

- Evidence: timer at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibIPC/Connection.cpp#L34 and #L72; policy at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/ConnectionFromClient.cpp#L1169-L1198
- Confidence: verified
- Why it matters: high value, because with no preemption **"this app is wedged" is the normal case,
  not the exception**, and `Worker.terminate()` is the only remedy. Ping/pong gives the user an
  honest signal before anything is killed, and Windows 7 already has the visual vocabulary for it
  ("(Not Responding)", the ghost frame). It is also a threshold on a continuous input, so per
  `CLAUDE.md` both edges need checking: wedge→marked, and recover→unmarked.

### Paint requests are coalesced by the server, not the client: `request_update` arms a one-shot deferred invoke **only** on the empty→non-empty transition, accumulates rects into a disjoint set, drains the whole set into a single `paint(window_id, window_size, rects)`, and drops it entirely if the window is minimized or occluded.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/Window.cpp#L705-L715; `post_paint_message` at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/ConnectionFromClient.cpp#L742-L749; client-side fold-in at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibGUI/Window.cpp#L491-L497
- Confidence: verified
- Why it matters: with a ~15 µs syscall, one `invalidate` per widget is the obvious trap — 550
  syscalls fill a frame (5). The take-and-clear accumulator also satisfies the `CLAUDE.md` state
  rule: the paint handler is handed a clean slate and needs no "already painted?" guard. Dropping
  paints for occluded windows is the same governor idea as constraint 49 applied to CPU rather than
  blur.

### The taskbar is **not** a peer client of the window ABI: it connects to a second endpoint (`WindowManagerServer`/`WindowManagerClient`) on a separate socket, subscribes with `set_event_mask(u32)`, declares itself with `set_manager_window`, and receives global window state keyed by `(client_id, window_id)` pairs the ordinary endpoint cannot enumerate. The desktop, by contrast, literally *is* the file manager (`Executable=/bin/FileManager`, `Arguments=--desktop`).

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowManagerServer.ipc and https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowManagerClient.ipc; dual sockets and the Desktop entry at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/etc/SystemServer.ini
- Confidence: verified
- Why it matters: partly contradicts `CLAUDE.md`'s "the shell, taskbar and WM use the same syscalls
  as a third-party app". Explorer genuinely can be an ordinary client; the taskbar cannot, because it
  needs cross-process window enumeration that no ordinary client may have. The honest form of the
  invariant is a **second, separately-gated management interface with an event mask** — which is
  still a capability the kernel granted, so the boundary survives. It also forces a cross-process
  window identity: a per-process fd cannot name another process's window, so the management
  interface needs `(pid, winid)`.

### Cross-process modal parenting is a first-class protocol feature: a broker parents its dialog onto the *requesting app's* window via `set_window_parent_from_client(i32 client_id, i32 parent_id, i32 child_id)` plus `add_window_stealing_for_client`, and the server enforces a four-valued `WindowMode` (`Modeless`/`Passive`/`RenderAbove`/`Blocking`), computing the blocker in `Window::blocking_modal_window()` and suppressing input to blocked windows.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowServer.ipc#L194-L198; https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowMode.h; chain walk at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/Window.cpp#L686-L699, input suppression at #L455-L459; client use at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibFileSystemAccessClient/Client.cpp#L44-L63
- Confidence: verified
- Why it matters: constraint 44 and M9 already require `owner` and `modal`, so the shape is right —
  but M9's `modal ∈ {none,window,app,system}` describes *scope* where Serenity's enum describes
  *behaviour*, and `Passive` vs `RenderAbove` vs `Blocking` are three different things an owned
  window can be. More importantly, the owner may live in **another process** (that is the whole point
  of a picker broker), which a per-process window fd cannot express.

### Closing a window is advisory: the server sends async `window_close_request(window_id)` and never destroys the window itself; the client decides via `on_close_request() -> {Close, StayOpen}` and must call `destroy_window`, which synchronously returns the **list** of window ids destroyed — the window plus its descendants.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/Window.cpp#L870-L876 and #L495; client at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibGUI/Window.cpp#L692-L698; `destroy_window(i32 window_id) => (Vector<i32> destroyed_window_ids)` at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/WindowServer.ipc#L69
- Confidence: verified
- Why it matters: the advisory close is constraint 44, already settled. The *cascade* is not:
  destroying a parent destroys its descendants, so the reply must enumerate what died or the
  process's fd table desynchronizes from the kernel's. A window-as-fd design makes this worse, not
  better — closing one fd must be reported as closing several, and M7 has no such event.

### Any protocol violation kills the client: WindowServer calls `did_misbehave("… Bad window ID")`, which logs and immediately shuts the connection down. There is no error reply for a malformed request.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibIPC/ConnectionFromClient.h#L43-L59; ~30 call sites in https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Services/WindowServer/ConnectionFromClient.cpp (e.g. #L751-L757, #L783-L787)
- Confidence: verified
- Why it matters: a policy the plan has not made. Serenity's split is "ordinary runtime conditions
  get an errno, impossible arguments get death", and death is far easier to debug than a silently
  ignored call. Our ABI returns `-errno` everywhere, which means a kernel bug and an app bug look
  identical in the logs. Decide per call group which of the 68 return an errno and which fault the
  process — and note that faulting is only honest if `waitpid` can report the reason.

### Message ids are assigned by **ordinal position in the `.ipc` file** and endpoint ids are a string hash of the endpoint name, so inserting or reordering a message silently breaks the ABI; only the hash-collision half is guarded, by a repo-wide `IPCMagicLinter` run over `git ls-files '*.ipc'` in CI. The project separately states its ABI has "absolutely no stability guarantee".

- Evidence: ordinal assignment at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Meta/Lagom/Tools/CodeGenerators/IPCCompiler/main.cpp#L280-L300, endpoint magic at #L266; linter at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Meta/Lagom/Tools/IPCMagicLinter/main.cpp wired in https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Meta/lint-ci.sh; ABI statement at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Documentation/FAQ.md#L33
- Confidence: verified
- Why it matters: two actions. Decide whether the 68-call ABI is frozen — adopting WASI preview1
  errno numbers verbatim implies an external contract, while a single repository implies none, and
  the answer decides whether a retired call number may be reused. And copy the *linter*: a CI check
  over the ABI definition file asserting the properties the two sides assume — no duplicate numbers,
  no reused retired number, no kernel→process synchronous call. `CLAUDE.md` already requires syscall
  numbers and SAB offsets to be a single named constant imported by both sides; a linter is how that
  rule survives contact.

### System introspection is synthetic filesystem content rather than syscalls: the kernel serves the whole process table as a JSON document at `/sys/kernel/processes`, which `ps`, SystemMonitor and the taskbar read with ordinary file I/O and parse, and a jailed process sees only its own jail's entries in that view.

- Evidence: https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibCore/ProcessStatisticsReader.cpp#L94 and the parse at #L26-L88; jail PID-view isolation at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Base/usr/share/man/man7/Mitigations.md#L95-L105
- Confidence: verified
- Why it matters: this is M3's `/proc` argument, confirmed, and it is also how the ABI stops growing
  — task manager, mount list, journal health and kernel config all become synthetic nodes read
  through the existing `open`/`read` path rather than new syscalls. Two caveats worth recording: the
  in-memory inode table needs a node class whose content is generated on read and never persisted
  (a different code path from an OPFS-backed inode, and the thing M3's negative control exists to
  catch), and the per-process filtering belongs in the VFS layer, not in the reader.

### There is **no** automated test coverage for the GUI stack: `Tests/` holds 44 entries including `Kernel`, `LibGfx`, `LibWeb` and `LibTest` itself, but no `LibGUI` and no `WindowServer` — GUI changes are verified by booting in QEMU and by screenshots in the pull request, while `LibWeb` has a full ref-test corpus.

- Evidence: https://github.com/SerenityOS/serenity/tree/32c6480ae7ec919eeda050f7a84d9532c87a0738/Tests (reproduce with `gh api "repos/SerenityOS/serenity/contents/Tests?ref=32c6480ae7ec919eeda050f7a84d9532c87a0738" --jq '.[].name'`); corpus at https://github.com/SerenityOS/serenity/tree/32c6480ae7ec919eeda050f7a84d9532c87a0738/Tests/LibWeb
- Confidence: verified
- Why it matters: a warning. The most mature comparable project gave up on testing its window
  system, and its compositor regressions are caught by humans looking at screenshots. We have an
  advantage it does not: the surface is a browser, so driving real input and reading geometry back is
  already the predecessor's discipline (40), and a ref-test of the composited pixels is cheap. The
  negative control for a ref test is a deliberately wrong theme token or z-order that must produce a
  diff — build that before the window protocol grows, not after.

### Nothing is released: zero releases, zero tags; the cadence is `master`, where CONTRIBUTING requires "separate, atomic commits … where the build, tests and the system are all functioning", CI boots and tests the whole OS per pull request, and the public artifact is a development video. Scope is governed by refusal — the FAQ answers "When will you implement `$THING`?" with "Maybe someday. Maybe never", and CONTRIBUTING forbids starting with "a new application, library or other large component".

- Evidence: https://github.com/SerenityOS/serenity/releases and https://github.com/SerenityOS/serenity/tags (both empty; `gh api repos/SerenityOS/serenity/releases` → `[]`); atomic-commit rule at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/CONTRIBUTING.md#L40-L75; refusals at #L5 and https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Documentation/FAQ.md#L3-L13; videos at https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/README.md#L17-L22
- Confidence: verified
- Why it matters: the momentum mechanism is *a demoable system at every commit*, enforced by a CI
  gate that boots the real thing, plus a hard rule against unbounded new components. That is a
  stronger version of D16's M4a exception: not "something visible by day 22" but "it boots to a
  desktop at every commit from day 22 on", checked by the harness with a screenshot artifact.

### Could not be determined (SerenityOS)

- **Message size limit.** LibIPC frames with a `u32` length prefix and enforces no maximum; the
  practical ceiling is the socket buffer plus the 100-write retry cap, which logs a `FIXME` rather
  than enforcing a bound (https://github.com/SerenityOS/serenity/blob/32c6480ae7ec919eeda050f7a84d9532c87a0738/Userland/Libraries/LibIPC/Message.cpp#L41-L104).
- **Shell job control.** `Userland/Shell/` does not exist at this commit, though `Tests/LibShell`,
  the `Shell.md` man page and a `SystemServer.ini` reference to `/bin/Shell` remain. The job-control
  finding above rests on the kernel TTY layer, not on the shell. How Serenity's shell used
  `setpgid`/`tcsetpgrp` is unresolved here.
- The momentum finding is sourced only to in-repo documents and the releases/tags API; no blog posts
  or talks were read.

---

## 2. HelenOS and Redox

Two microkernel systems where almost everything is a userland server reached by IPC — which is
structurally what this project is, whether or not it says so. HelenOS answers "how do you get a
synchronous-looking client API over an asynchronous channel"; Redox answers "what happens when you
really do make the window manager a filesystem".

Pinned revisions: HelenOS `HelenOS/helenos` @ `776168b19bf9e89b6b6162ca77e9ac593964142f`; Redox
kernel `redox-os/kernel` @ `f31b7512dc381b9fed09b9a641da717092d83e65`; `redox-os/relibc` @
`50c054e2aa506c52629f8f95dccd396010ae12fe`; `redox-os/orbital` @
`56620bba7dfd2652bd6b4e97909faecfcde2e27d`; `redox-os/redoxfs` @
`5ba45a6887374ab425326656a276bb3b62eba7dc`.

### Every Redox message carries a caller-chosen request tag, so one connection has many calls outstanding and replies are matched by tag rather than by arrival order: `Sqe { opcode, sqe_flags, _rsvd, tag: u32, args: [u64; 6], caller: u64 }` answered by `Cqe { flags, extra_raw, tag: u32, result: u64 }`.

- System: Redox
- Evidence: https://github.com/redox-os/kernel/blob/f31b7512dc381b9fed09b9a641da717092d83e65/syscall/src/schemev2.rs
- Confidence: verified
- Why it matters: the one-futex-word design is the ABI's deepest commitment and it is **not** a
  contradiction of POSIX — a single-threaded POSIX process blocked in `poll()` also cannot issue a
  syscall. The honest statement of the cost is narrower and sharper than "no pipelining": **a web-os
  process is single-threaded by construction.** `Worker` is deleted from the realm by M6 (41), there
  is one futex word, and one outstanding call, so a process can never have two operations in flight
  — no fibrils, no coroutine runtime doing concurrent I/O, no background decode while the UI
  services events. Constraint 20a's `f | g` deadlock is a *special case* of this, and its remedy
  ("budget a second shell worker") is the general remedy: concurrency inside an app costs a second
  process, which is charged against the 128 cap. That generalisation is currently undocumented and
  it prices several apps nobody has designed yet.

### Redox's entire kernel syscall surface is ~25 numbered calls, because one generic typed call (`CALL`) and one generic handle-deriving call (`DUP_INTO`, which takes a *string* naming an aspect of the object) absorb everything a new object kind would otherwise need. There is no `fork`, `exec`, `stat`, `mkdir`, `unlink`, `pipe`, `getpid`, `kill`, `poll` or `mount` syscall.

- System: Redox
- Evidence: https://github.com/redox-os/kernel/blob/f31b7512dc381b9fed09b9a641da717092d83e65/syscall/src/number.rs
- Confidence: verified
- Why it matters: 68 calls is ~3× this, and every call number is a separate dispatch arm in the one
  kernel thread that M0 cannot measure individually. The question worth answering before M7 adds
  more: how many of the 68 are `win_*`/`dataobj_*`/`tty_*` variants that a generic
  `call(fd, payload)` plus `dup(fd, "aspect")` would absorb? `dup(fd, "clipboard")` is how Redox gets
  a clipboard handle from a window handle — which is exactly the shape of the three `dataobj_*` calls
  M10 adds.

### A Redox reply can itself carry one or several file descriptors: the completion opcode set is `RespondRegular`, `RespondWithFd`, `SendFevent`, `ObtainFd`, `RespondWithMultipleFds`, `RespondAndNotifyOnDetach`, and `Call` can carry an fd when `CallFlags::FD` is set.

- System: Redox
- Evidence: https://github.com/redox-os/kernel/blob/f31b7512dc381b9fed09b9a641da717092d83e65/syscall/src/schemev2.rs; kernel side https://github.com/redox-os/kernel/blob/f31b7512dc381b9fed09b9a641da717092d83e65/src/syscall/fs.rs#L189-L230
- Confidence: verified
- Why it matters: this and SerenityOS's `sendfd`/`recvfd` are the same answer from two independent
  systems, and together they undercut D7's *reasoning* (not its conclusion). Redox hit the identical
  wall — a file write cannot hand over a handle — and fixed it in the **reply envelope**, not by
  forking the syscall surface. The web-os equivalent is a reply descriptor meaning "the transferable
  for this reply follows on the port", which keeps windows inside the fd surface that D8 and
  constraint 42 already want, and serves the clipboard, broker-supplied files and `shm_attach` with
  one mechanism instead of three.

### Redox's `openat` does no path parsing in the kernel: it finds which scheme owns the *dirfd*, hands that scheme the whole remaining path, and stamps `CallerCtx { pid, uid, gid }` from the calling context — and a scheme may answer with a description belonging to a different scheme.

- System: Redox
- Evidence: https://github.com/redox-os/kernel/blob/f31b7512dc381b9fed09b9a641da717092d83e65/src/syscall/fs.rs#L75-L127
- Confidence: verified
- Why it matters: the credential half is **already answered** — D12 and constraint 29 put the
  credential in the kernel's process table, and "an argument on every path call" describes the
  `vfs.mjs` method signature, not the trust path. Two independent subagents misread it, which is
  itself a signal: the wording invites the misreading and should say "stamped by the kernel at
  syscall entry from the process table" wherever it appears. The routing half is a real finding:
  resolving by *which mount owns this fd* rather than by longest-prefix string match removes prefix
  shadowing, `..`-escapes-a-mount, and paths that match two mounts. If M3 keeps the prefix table, the
  invariant it rests on must be written down and given a negative control.

### HelenOS resolves mounts by following a per-node `mount` pointer in a loop (`while (base->mount) base = base->mount;`), one IPC round trip per crossing, and each filesystem server returns the index of the first character it could not resolve.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/srv/vfs/vfs_lookup.c#L209-L322
- Confidence: verified
- Why it matters: a static longest-prefix table cannot express mount-on-mount and cannot be extended
  at runtime. M3 declares the table static at boot, which makes that acceptable — but `mount` and
  `umount` are in the ABI, so either they are kernel-internal only (say so) or the table has to
  become a tree. The "first unresolved character" return is a cheap idea worth copying: it makes
  `ENOENT` diagnosable without a second call.

### A HelenOS path is written once into a read-only shared ring buffer and referenced by `(index, length)` for the whole lookup — `MAX_PATH_LEN` 32 KiB, `PLB_SIZE` 64 KiB — and the client library must canonicalize before insertion.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/lib/c/include/ipc/vfs.h#L45-L47; https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/srv/vfs/vfs_lookup.c#L51-L137; read-only share at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/srv/vfs/vfs_register.c#L190-L237; canonical-path requirement at https://www.helenos.org/wiki/FSDesign
- Confidence: verified
- Why it matters: HelenOS's whole path buffer is the size of one web-os process SAB, which is a
  useful sanity check on the 64 KiB choice. The transferable discipline is: canonicalize in libos
  before the call and have the kernel **reject** a non-canonical path rather than normalise it. That
  removes a re-validation step from every path call and turns a class of traversal bug into an
  `EINVAL` at the boundary.

### HelenOS caps outstanding async calls at 64 per phone and fails the 65th immediately with `ELIMIT` — the kernel never blocks a sender to apply backpressure.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/abi/include/abi/ipc/ipc.h#L52-L53; `check_call_limit` at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/kernel/generic/src/ipc/sysipc.c#L341-L351 with callers returning `ELIMIT` at #L376-L379 and #L428-L431
- Confidence: verified
- Why it matters: the in-flight budget is part of the ABI contract, not an implementation detail —
  the sender is expected to handle `ELIMIT`. web-os gets this free today (one call in flight), but
  the *event backlog* the kernel must buffer per process has no bound and no defined overflow, which
  is the same defect constraint 9 names for the argument buffer.

### HelenOS's answerbox is drained in strict priority order: notifications first, then answers to calls this task is waiting for, then new incoming requests.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/kernel/generic/src/ipc/ipc.c#L548-L600
- Confidence: verified
- Why it matters: the order the single kernel thread drains its syscall queue is a **scheduling
  policy nobody has specified**, and M0's accept/kill criterion is a p99 that depends on it entirely.
  Finishing work in flight before admitting new work bounds the number of simultaneously parked
  requests and is the standard livelock defence in a mutually-calling server set. This is the first
  thing to instrument in M0, and the cheapest way to turn a bad p99 into a good one without sharding.

### HelenOS forwards a client's in-flight call to a third party, which then answers the client directly and copies data straight into the client's buffer — the broker never touches the payload (`async_forward_0(&call, exch, 0, IPC_FF_ROUTE_FROM_ME)`).

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/srv/fs/locfs/locfs_ops.c#L573-L603; flag semantics at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/abi/include/abi/ipc/ipc.h#L80-L93
- Confidence: verified
- Why it matters: "every byte of IPC crosses the kernel" (15) is affordable only while the kernel
  *is* the server for everything. The moment a userland server exists — the window manager is one,
  and a picker broker would be another — a read through it costs two copies and two serialization
  slots in the one kernel thread. Forwarding is the primitive that avoids it: the kernel retargets a
  pending request's reply slot so the final answerer writes once into the original caller's SAB.
  Worth designing before the first userland server, not after.

### When a HelenOS task dies the kernel answers every call in its answerbox — un-picked-up and already-dispatched — with `EHANGUP`, and the dying task cannot finish until all answers to its own outstanding calls have been drained, ending in `assert(active_calls == 0)`.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/kernel/generic/src/ipc/ipc.c#L616-L643 and #L837-L881
- Confidence: verified
- Why it matters: M1 already proves a dead *kernel* wakes every parked process with `EIO`, and
  ABI §5 defines the dead-peer pipe wakes (reader EOF, writer EPIPE). What is missing is the general
  case: a Worker can die without warning — OOM, a crash, tab discard — and teardown is specified as
  "close fds, destroy windows, drop the taskbar button" (14) with no two-phase drain and no final
  assertion. Copy the shape: quiesce, answer everything outstanding with a defined errno, then
  assert the count is zero. The harness control is concrete — kill a Worker mid-syscall and assert
  every blocked peer wakes rather than hangs.

### A blocked request is cancellable in both systems: Redox has a `Cancel` opcode whose server replies `ECANCELED`, and HelenOS lets a dying task "forget" its outstanding calls and donate them to the answerer.

- System: Redox and HelenOS
- Evidence: Redox `Cancel = 25` in https://github.com/redox-os/kernel/blob/f31b7512dc381b9fed09b9a641da717092d83e65/syscall/src/schemev2.rs, server handling at https://github.com/redox-os/orbital/blob/56620bba7dfd2652bd6b4e97909faecfcde2e27d/src/core.rs#L186-L200; HelenOS at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/kernel/generic/src/ipc/ipc.c#L712-L775
- Confidence: verified
- Why it matters: **already answered, and the subagent's reading of our own ABI was wrong** —
  worth recording because the mistake is instructive. ABI.md §"five decisions" #1 already does
  exactly this: the kernel sets SIGPEND, sets `STATUS=2`, bumps `SEQ`, notifies, aborts the host work
  via `AbortController`, and drops the late reply by CALLID; the process returns `-EINTR`. So
  cancellation *is* kernel-driven here and the control word is only how the process learns why it
  woke. The residual is narrower and is already on the record as the ABI's "known weak point": a
  worker inside a **synchronous OPFS call** is not in `Atomics.wait` and probably cannot be woken at
  all. Redox's server-side `Cancel` plus an `AbortController` is the right model; the measurement
  before M4 is what decides whether `read()` can honour `INTR`.

### Orbital parks a `read` it cannot satisfy in a `delayed: VecDeque<(CallerCtx, OpRead)>` and replies to it later, out of order, from a single-threaded event loop multiplexing the scheme socket, the input device and the display.

- System: Redox
- Evidence: https://github.com/redox-os/orbital/blob/56620bba7dfd2652bd6b4e97909faecfcde2e27d/src/core.rs#L144-L283
- Confidence: verified
- Why it matters: supports the single-threaded-kernel shape and names the obligation that comes with
  it — a serializing server must be able to reply **out of order**, which means a parked request is a
  heap object carrying the caller's identity and buffer, parked on the *resource*, not on the thread.
  web-os's reply slot is the caller's own futex word, which makes this work for exactly one parked
  call per process. That is consistent, and it is also the thing that makes a second in-flight call
  structurally impossible rather than merely unimplemented.

### A Redox window is created by `openat` on the orbital scheme with geometry in the path (`flags/x/y/width/height/title`), driven by comma-separated ASCII verbs written to the fd, read back as fixed-size `Event` structs, flushed with `fsync`, reported by `fpath` as a formatted string — and its pixels escape the file interface entirely through `mmap_prep`, which returns the server's framebuffer pointer. A sibling handle comes from `dup(fd, b"clipboard")`.

- System: Redox
- Evidence: https://github.com/redox-os/orbital/blob/56620bba7dfd2652bd6b4e97909faecfcde2e27d/src/core.rs#L292-L356, #L357-L373, #L374-L399, #L401-L529, #L531-L543, #L576-L597, #L598-L603, #L604-L623
- Confidence: verified
- Why it matters: the most direct evidence available on D7, and it cuts both ways. A plain file
  interface genuinely cannot express a window protocol — geometry gets smuggled through the path,
  commands degenerate into a stringly-typed verb language parsed with `splitn(2, ',')`, and the
  pixels need a mapping call anyway. **D7's conclusion is supported; its stated reason is too
  narrow.** But Redox's own fix was a *typed call on an fd*, not a parallel syscall family, and
  keeping windows as fds is what preserves `poll()` over windows that D8 depends on. The shape to
  copy is `win_*` payloads as typed structs over an fd-addressed `call`, not a family of bespoke
  syscall numbers.

### Redox readiness is not inferred by the kernel: a scheme daemon must explicitly post `SYS_FEVENT`, cannot tell whether the client has an event fd, and the documentation warns about both duplicate-event and lost-event races, requiring a read-write descriptor to be registered twice.

- System: Redox
- Evidence: https://doc.redox-os.org/book/event-scheme.html
- Confidence: from docs
- Why it matters: here the centralization is a genuine advantage and the plan should say so. Because
  the kernel owns pipes, the VFS and the window manager, it knows both the readiness edge and who is
  polling, so the duplicate/lost-event class does not exist. What to copy is the interface detail —
  interest registered per direction — and the harness control Redox's docs describe: make data arrive
  between the readiness check and the park, and assert the `poll` still returns.

### HelenOS treats a notification as structurally different from a call: unanswerable, queued separately, served first, carrying a monotonically increasing counter so the receiver can detect coalescing, and optionally self-masking so the producer gets `EBUSY` until the consumer catches up.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/kernel/generic/src/ipc/event.c#L140-L186; userspace delivery at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/kernel/generic/src/ipc/sysipc.c#L790-L802
- Confidence: verified
- Why it matters: the SIGPEND bitmask is a coalescing channel with no way to learn that coalescing
  happened — which is POSIX-faithful for non-realtime signals, so it is not a defect. The cheap
  addition is diagnostic rather than semantic: a monotonic counter beside the mask lets `/proc` and
  the harness prove a signal was merged rather than lost. The producer policy (block, drop, or mask)
  is a decision the ABI has not made.

### `fork` on Redox is ordinary userspace code assembled from `dup`-with-a-string on the thread handle — `"addrspace"`, `"exclusive"` for the CoW copy, `"filetable-binary"` + `"copy"` for the fd table — and each scheme-backed shared grant must be re-`mmap`ed one by one by the name `grant-fd-<hex base>`.

- System: Redox
- Evidence: https://github.com/redox-os/relibc/blob/50c054e2aa506c52629f8f95dccd396010ae12fe/redox-rt/src/proc.rs#L982-L1096
- Confidence: verified
- Why it matters: D5 and constraint 20 stand; this adds a mechanism, not a counter-argument. If the
  ABI had `dup(fd, name)` returning a handle to an *aspect* of an object — a process's fd table, its
  namespace, its window list — then fd inheritance, `posix_spawn` file actions, `/proc` introspection
  and a future debugger become compositions rather than new syscalls. Note also what Redox's fork
  cannot do: shared mappings are not CoW-able and must be re-established by name, which is the same
  wall `WebAssembly.Memory` puts in front of a web-os fork.

### HelenOS splits path resolution from opening — `VFS_IN_WALK` returns a handle for a resolved name and `VFS_IN_OPEN` then opens it, with `WALK_MAY_CREATE`/`WALK_MUST_CREATE`/`WALK_REGULAR`/`WALK_DIRECTORY` validated in nine lines that reject the contradictory combinations.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/lib/c/include/ipc/vfs.h#L73-L90; `walk_flags_valid` at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/srv/vfs/vfs_ops.c#L840-L865
- Confidence: verified
- Why it matters: one `open(path, flags, mode)` with a dozen interacting flags is where creation
  semantics and TOCTOU bugs live, and constraint 22 already wants `open` to be rare. Walk-then-open
  makes the flag matrix a checkable predicate and gives `*at`-style resolution for free — which the
  ABI explicitly dropped (`ABI.md` §"No `*at` variants"), so this is a trade to re-read rather than
  reverse: the reason given there (all resolution and enforcement in the kernel) survives
  walk-then-open intact, because the walk is also kernel-side.

### HelenOS's bulk transfer is a three-phase negotiation in which the *recipient* inspects the proposed size before any bytes move and may shrink or reject it, with a hard 64 KiB ceiling (`DATA_XFER_LIMIT`); anything larger moves as a shared address-space area.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/abi/include/abi/ipc/ipc.h#L55-L101; argument contracts at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/abi/include/abi/ipc/methods.h#L112-L196
- Confidence: verified
- Why it matters: the same 64 KiB ceiling by coincidence, and the same question: what happens to a
  10 MiB `write`? The ABI answers it (short count plus `shm_create`), so this is confirmation — with
  one addition worth taking: the *recipient* sizing the transfer is what stops a sender from pinning
  a large buffer the receiver never wanted.

### HelenOS's interface identifier encodes the concurrency discipline a client must use — `IFACE_EXCHANGE_ATOMIC`, `_SERIALIZE`, `_PARALLEL` — and the VFS interface is declared parallel, because multi-message operations on a shared channel otherwise interleave and the server cannot tell which request a message belongs to.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/abi/include/abi/ipc/interfaces.h#L50-L121; https://www.helenos.org/wiki/AsyncSessions
- Confidence: verified
- Why it matters: web-os has one channel per process and the ABI has multi-message shapes
  (`readdir` with a cookie, a short-count `write` loop, `shm` bulk transfer). One outstanding call
  per process makes interleaving impossible, which is the quiet reason the design is sound — so the
  invariant deserves to be stated as load-bearing rather than incidental, and asserted, because the
  day a second call is permitted the reply demux and every multi-message sequence break together.

### HelenOS still serializes all of VFS's downstream calls to a given filesystem server through one exchange under a global lock, with the in-source admission "For now, we don't try to be very clever and very fast", and holds a per-fd mutex across the downstream call so one client's slow `read` does not block another's `stat`.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/srv/vfs/vfs_register.c#L243-L275; `INTERFACE_FS … | IFACE_EXCHANGE_SERIALIZE` at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/abi/include/abi/ipc/interfaces.h#L95-L96; per-fd lock and per-connection file table at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/srv/vfs/vfs_file.c#L50-L58 and #L194-L240
- Confidence: verified
- Why it matters: precedent *and* warning, and it converges with SerenityOS's ticketed-decode finding
  on the same conclusion. A 20-year-old multiserver OS serializes its filesystem and flags it rather
  than fixing it — so a serializing kernel is not disqualifying. But HelenOS serializes per
  filesystem, while web-os serializes the **entire system** in one thread, and the rule it implies is
  precise: *a syscall that must wait must not hold the kernel thread.* The fast VFS path is
  synchronous OPFS calls on that thread — 495 µs `createSyncAccessHandle` (22), 260 µs `flush()`
  (23), 0.60 ms per name on Safari (33) — and **M0's three calls (`getpid`, `write(1,…)`,
  `nanosleep`) touch none of them**, so the stated top risk is being measured with the one workload
  that cannot exhibit it.

### RedoxFS has no journal: it writes all copy-on-write data blocks first, then a single 4 KiB header block at `generation % 256` in a 256-entry header ring, each header self-validating with a seahash and a monotonically increasing generation.

- System: Redox
- Evidence: https://github.com/redox-os/redoxfs/blob/5ba45a6887374ab425326656a276bb3b62eba7dc/src/header.rs#L10-L40 (with `header_size_test` asserting `size_of::<Header>() == BLOCK_SIZE`); commit order at https://github.com/redox-os/redoxfs/blob/5ba45a6887374ab425326656a276bb3b62eba7dc/src/transaction.rs#L268-L321
- Confidence: verified
- Why it matters: the strongest alternative to D9's snapshot-plus-journal, and it attacks the project's
  own open question. Copy-on-write means no live block is ever overwritten, so the only ordering
  requirement is data-before-header; recovery is a scan for the highest valid generation, with **no
  replay path to write and no torn-tail semantics to test**. Against it: web-os's inodes are small and
  numerous and the whole table already loads at boot, and a journal makes a 10-byte metadata edit
  cheap where a header ring rewrites the tree spine. Worth pricing explicitly in M2 days 5–8 rather
  than discovering later. Either way, two details transfer unconditionally: the superblock needs a
  **generation counter** as well as a CRC, and the alternating-snapshot design is already half a
  header ring.

### RedoxFS's `Disk` trait has exactly four operations — `read_at`, `write_at`, `write_at_batched`, `size` — and no flush or barrier, so the ordering its commit protocol depends on is inherited from whatever backs the device.

- System: Redox
- Evidence: https://github.com/redox-os/redoxfs/blob/5ba45a6887374ab425326656a276bb3b62eba7dc/src/disk/mod.rs
- Confidence: verified
- Why it matters: the trap, not the model — and it is the same shape as the plan's own open question
  about whether an OPFS `flush()` is durable across a kill. A storage interface with no barrier
  cannot express the invariant its commit protocol relies on, so the test passes because the browser
  happened to order the writes. The harness must be able to simulate a crash *between* the two
  writes, which means the write path needs an injectable fault point, not just a truncation test.

### Redox signals are driven by a per-thread shared control word holding an allowset and pending bits manipulated with atomic `fetch_add`, with an `INHIBIT_DELIVERY` bit, explicit critical sections, a manually entered trampoline on `EINTR`, a post-preemption check in the kernel as the asynchronous backstop, and a userspace `procmgr` that has taken signal state over from the kernel.

- System: Redox
- Evidence: https://github.com/redox-os/relibc/blob/50c054e2aa506c52629f8f95dccd396010ae12fe/redox-rt/src/signal.rs (delivery timing at #L274-L285, `fetch_add` ownership rules at #L395-L435, `callback_or_signal_async` at #L951-L975)
- Confidence: verified
- Why it matters: the closest analogue to signals-through-a-control-word, and it names two pieces the
  ABI does not have. An **inhibit bit**: without one, a signal can be delivered while libos is
  mid-update of its own state, and the SAB layout has `SIGPEND` but no critical-section flag.
  And **single-writer ownership per field**, documented — `fetch_add` is only safe there because one
  thread owns the allowset; our SAB has the kernel writing `SEQ`/`STATUS`/`SIGPEND` and the process
  writing arguments, which is the right split but is nowhere stated as an invariant the code may rely
  on. Redox's third piece, the post-preemption check, has no web-os equivalent and cannot have one.

### A page fault on an mmap'd file in HelenOS becomes a synchronous one-page-at-a-time `IPC_M_PAGE_IN` call to the VFS pager port, and the server's own comment records that the absence of a page cache makes private mappings non-coherent.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/srv/vfs/vfs_pager.c; method contract at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/abi/include/abi/ipc/methods.h#L112-L124
- Confidence: verified
- Why it matters: a warning about a call the ABI has deliberately omitted. `mmap` is the first thing a
  ported runtime reaches for, and this is what it costs when file data lives across an IPC boundary —
  with the coherency story unfinished after twenty years. Leaving it out, or restricting it to a
  whole-file SAB snapshot with explicit write-back, is defensible; it should be *stated* as a
  decision, because option B's wasip1 target will raise it.

### Redox's own IPC performance test is `dd bs=4k count=100000` from `/scheme/zero` to `/scheme/null` plus a time-sampled kernel flamegraph with a two-revision comparison mode, and the project publishes no latency or throughput figures at all.

- System: Redox
- Evidence: https://doc.redox-os.org/book/performance.html; the microkernel-cost discussion with no figures at https://doc.redox-os.org/book/microkernels.html
- Confidence: from docs
- Why it matters: web-os already publishes more than Redox does, so the gap to close is not latency —
  it is the two things M0 lacks. A **sampling profiler of the kernel worker**, so a bad p99 is
  attributable to a handler rather than to "contention", and a **two-revision comparison mode**, so a
  regression is attributable to a commit. Both are cheap next to re-architecting on a bad number.

### Every Redox scheme daemon drops into the null namespace with `setrens(0, 0)` at startup, so its capability set is the handles it already holds and it cannot name any path — while the project's own book still marks the broader capability story "WIP".

- System: Redox
- Evidence: https://doc.redox-os.org/book/scheme-operation.html; https://doc.redox-os.org/book/security.html
- Confidence: from docs
- Why it matters: supports labelling M6 "hardening, not a security boundary" (41) — and offers a
  stronger claim that is cheaper to make and testable: *no capability is obtainable after boot*. A
  process starts with the handles it was spawned with and the namespace it was given, and the
  assertion is that a process with an empty namespace cannot name any path. That is a property of the
  kernel's own tables rather than of what was deleted from a realm.

### HelenOS finds services by name through a location service that also groups them into categories and offers a callback connection delivering `LOC_EVENT_CAT_CHANGE`, then projects the whole thing into the file namespace through a `locfs` filesystem server.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/lib/c/generic/loc.c (register #L194/#L264, lookup #L316, categories #L609, callback port #L52-L123); projection at https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/srv/fs/locfs/locfs_ops.c#L213-L290
- Confidence: verified
- Why it matters: M3 generates `/dev` on read from a static table, which is fine while devices are
  kernel-internal. The cheap-now, expensive-later piece is the **category plus change notification**:
  a consumer asks for "the displays" rather than a fixed path and is told when the set changes. A
  hardcoded generated-on-read `/dev` has no edge to notify on, and the surface this project actually
  needs it for is a second monitor, a mounted host directory, and a hot-plugged gamepad.

### Fibrils are a user-space M:N scheduler, single-threaded unless explicitly opted out of, with exactly one blocking point: a kernel `ipc_wait` entered only when no fibril is runnable.

- System: HelenOS
- Evidence: https://github.com/HelenOS/helenos/blob/776168b19bf9e89b6b6162ca77e9ac593964142f/uspace/lib/c/generic/thread/fibril.c (`multithreaded = false` #L86, `_ipc_wait` #L240-L255, `_ready_list_pop` #L263-L330, opt-out #L783-L805); semantics at https://www.helenos.org/wiki/IPC
- Confidence: verified
- Why it matters: this is the shape of a synchronous-looking API over an async channel, and
  `Atomics.wait` gives it to us for free — at the price named at the top of this section. HelenOS
  needed fibrils *because* its channel was async; we need nothing because ours blocks. The cost is
  symmetrical and should be recorded as such: HelenOS can run other work while one operation is
  outstanding, and a web-os process cannot.

### Could not be determined (HelenOS / Redox)

- **No published IPC latency or throughput figures for either project.** HelenOS has `hbench`
  in-tree; no results were found. So the 14–16 µs figure has nothing to be compared against from
  these two systems.
- **No HelenOS document on deadlock avoidance among mutually-calling servers.** The
  answerbox-drain-priority and exchange-serialization findings are mechanism read out of the source,
  not stated policy. The only in-source hint of an unresolved hazard is a
  `// TODO: Ensure deadlocks can't happen` in Redox at
  https://github.com/redox-os/kernel/blob/f31b7512dc381b9fed09b9a641da717092d83e65/src/syscall/fs.rs#L314
- **Orbital's client side** (`orbclient`, and how `winit`/`softbuffer` map onto the scheme) is on
  GitLab rather than the GitHub mirror; all Orbital evidence here is server-side.
- **RedoxFS's recovery scan** was not read: the write path (`generation % HEADER_RING`) is verified,
  but "recovery is a scan for the highest valid generation" is inferred from the header fields rather
  than read off the mount code.
- Two Redox book pages carry staleness warnings in their own text, and
  `windowing-and-graphics.html` 404s (the live page is `graphics-windowing.html`). Where a doc page
  and the source disagreed, the source is cited.

---

## 3. The tight-budget systems: SymbOS, KolibriOS, MenuetOS, EmuTOS, GeckOS, LUnix, DexOS, Ghost

These systems solved the shape of problem this project has — a hard ceiling on processes, a fixed
per-process cost, a single serializing kernel, and no spare memory — in 64 KiB or on a floppy.
SymbOS is the standout: preemptive multitasking with a message-passing windowed GUI on a Z80.

Pinned revisions: SymbOS developer documentation `Prodatron/symdoc-developer` @
`13f125a73925a76b9016de5ebe874b591b8aec2b`; EmuTOS `emutos/emutos` @
`94e002ef316b85f5ea03a8dde6686a5b692e6b61`; GeckOS V2 `fachat/GeckOS-V2` @
`2f28ba3026127281a5954ab2eb059732f295772b`; LUnix/LNG `ytmytm/c64-lng` @
`b76b0470e28ec20d08c37405bf76d16d93f85fbe`. KolibriOS was read at
`2d3d5e6299a3fe8009653ce3fc770fca04509a7d`, but **`git.kolibrios.org` returns 403 on
commit-pinned raw URLs**, so its citations are branch-relative; MenuetOS has no VCS and its pages
are undated.

### SymbOS's window protocol is retained-mode and server-side: a client sends the desktop manager a 4-byte message carrying only a bank number and a 16-bit pointer to a window *data record*, and thereafter requests redraws **by control ID** (`MSC_DSK_WININH`, ID 034: "000-239 -> the control with the specified ID will be redrawed", 255 = all). The application never touches a pixel and never owns a framebuffer.

- System: SymbOS
- Evidence: https://github.com/Prodatron/symdoc-developer/blob/13f125a73925a76b9016de5ebe874b591b8aec2b/SymbOS-Desktop.txt (IDs 032, 034, 047, 050, 051)
- Confidence: verified
- Why it matters: the strongest alternative design in the whole survey, and it attacks three of this
  project's hard limits at once. A declarative control-record tree in the process's SAB, redrawn by
  the compositor on an "invalidate control N" syscall, (a) removes per-process window surfaces from
  the ~600 KiB-per-process budget and the renderer's Worker ceiling (17), (b) makes the blurred-area
  budget (36, 49) a property of the compositor alone rather than of N processes each painting, and
  (c) answers the no-preemption problem completely — **a wedged app's window still scrolls,
  highlights and repaints, because the app was never drawing it.** The cost is the opposite of
  M8's bet: the ABI gains a widget vocabulary and loses arbitrary client drawing, which is a worse
  fit for a terminal and a better fit for Explorer, a file dialog and the taskbar. Worth pricing as
  a hybrid — retained-mode controls for chrome and standard widgets, an immediate-mode surface for
  the few apps that need pixels.

### SymbOS's IPC is a **fixed 14-byte** message that must physically live in the per-bank transfer area, and `Message_Send` returns a three-valued status in one register: 1 = sent, 0 = **message queue full**, 2 = receiver does not exist.

- System: SymbOS
- Evidence: https://github.com/Prodatron/symdoc-developer/blob/13f125a73925a76b9016de5ebe874b591b8aec2b/SymbOS-Kernel.txt (RST #08/#10/#18)
- Confidence: verified
- Why it matters: a 14-byte ceiling forced every service to be expressible as `opcode + ids + one
  pointer`, with bulk always passed by address. Our 64 KiB SAB with an inline variable-length region
  invites data-dependent syscall cost in the one thread that serializes everything — the 14–16 µs
  figure is for small calls and no constraint bounds the large ones. A fixed inline frame with
  everything larger passed as an offset makes the round trip a constant, and "queue full" as a
  first-class return is the bound constraint 9 asks for on the argument buffer and nothing yet asks
  for on the event backlog.

### KolibriOS kernel events are 32-byte pooled objects moved between per-thread FIFO lists by pointer surgery only: 512 `EVENT` objects preallocated at init and another 512 whenever the free list empties, per-thread `ObjList`/`EventList`, and "when events are moved between lists or reordered their data are not copied".

- System: KolibriOS
- Evidence: https://git.kolibrios.org/KolibriOS/kolibrios/raw/branch/main/kernel/trunk/docs/events_subsystem.txt
- Confidence: from docs (dated 2013; the `EVENT` struct still matches `const.inc` at the revision read)
- Why it matters: the concrete O(interested) design constraint 18 demands. Per-process intrusive
  FIFOs over a preallocated slab make a signal or a broadcast one list splice per *registered*
  listener, never touching the other N−1 processes, and remove allocation from the signal path
  entirely. That is the direct answer to the 378 µs-per-worker round trip, and it is a data-structure
  choice rather than a protocol change.

### KolibriOS and MenuetOS both make event interest an explicit per-process bitmask set by one call (function 40) over a deliberately tiny space of **nine** event codes — and two of the 32 mask bits are not events but spatial filters: bit 31 suppresses mouse events for an inactive window, bit 30 suppresses them when the cursor is outside the window.

- System: KolibriOS and MenuetOS
- Evidence: https://git.kolibrios.org/KolibriOS/kolibrios/raw/branch/main/kernel/trunk/docs/sysfuncs.txt (Function 40, "List of events"); http://www.menuetos.net/menuet.txt ("Menuet events are delivered as bitfield, so application itself can choose which events it reacts to")
- Confidence: verified (KolibriOS); from docs (MenuetOS, undated page)
- Why it matters: the filter bits are the transferable part and they are not obvious. "Does this
  process want mouse events for a window it does not own, or for a cursor outside its rect" is
  answered by two bits in the kernel, so the hot input path never enqueues to an uninterested
  process. With 1,000 processes and a per-frame input stream, that is the difference between O(1) and
  O(windows) per mouse move. Put spatial and focus filters in the mask word; do not let each process
  receive and discard.

### KolibriOS splits window ownership: function 0 draws the *frame* from the system skin (1 px outer, 3 px intermediate, 1 px inner, header bitmaps, and it implicitly defines the close and minimize buttons, with the header height **queried** via 48.4 rather than hardcoded), while the app draws its client area with primitives bracketed by function 12.1/12.2 — and **12.1 deletes every button defined by function 8, so all interactive regions must be redeclared on each redraw**.

- System: KolibriOS
- Evidence: https://git.kolibrios.org/KolibriOS/kolibrios/raw/branch/main/kernel/trunk/docs/sysfuncs.txt (Functions 0, 8, 12, 48.4 `_skinh`)
- Confidence: verified
- Why it matters: exactly the Windows 7 surface split — chrome is the system's, skin-driven and
  uniform; content is the app's. Two mechanisms transfer. The frame metrics are **queried, not
  assumed**, which is what lets the skin change without every app relaying out (and is the answer to
  shipping both Selawik and Segoe metrics, constraint 37). And "begin redraw destroys all hit
  regions" is how the kernel's hit-test table stays bounded without a GC: stale regions cannot
  accumulate because the app must re-declare them every frame it redraws.

### KolibriOS has a hard 256-thread table surfaced as a documented ABI error: the free-slot bitmap is `thr_slot_map rd 8` (8 dwords = 256 bits), each slot is an `APPDATA` asserted at exactly 256 bytes, and application-start functions return error `32 = 0x20 = too many processes`.

- System: KolibriOS
- Evidence: https://git.kolibrios.org/KolibriOS/kolibrios/raw/branch/main/kernel/trunk/data32.inc (line 359); https://git.kolibrios.org/KolibriOS/kolibrios/raw/branch/main/kernel/trunk/const.inc (line 594, `assert sizeof.APPDATA = 256`, with `SLOT_BASE`/`VGABasePtr` giving 0x10000/256 = 256 slots); https://git.kolibrios.org/KolibriOS/kolibrios/raw/branch/main/kernel/trunk/core/taskman.inc (`alloc_thread_slot`, `TASKMAN_ERROR_TOO_MANY_PROCESSES`)
- Confidence: verified (slot count derived from two independent constants that agree)
- Why it matters: the cap is a **sized static table** and the limit is derivable from it, not
  asserted beside it. M1's cap of 128 and the design limit of 1,000 (17) are currently two numbers in
  prose; they should be one named constant that also sizes the process table and the per-process SAB
  array, with `-EAGAIN` on exhaustion already in the ABI. `assert sizeof.APPDATA = 256` is the other
  half: the per-process kernel footprint is asserted at build time rather than measured later.

### SymbOS caps windows **system-wide at 32** and refuses the 33rd with a distinct response message (`MSR_DSK_WOPNER`, ID 160) whose entire documented meaning is that the maximum has been reached.

- System: SymbOS
- Evidence: https://github.com/Prodatron/symdoc-developer/blob/13f125a73925a76b9016de5ebe874b591b8aec2b/SymbOS-Desktop.txt (ID 160)
- Confidence: verified
- Why it matters: the blur budget binds on *area* (36), so there is currently no refusable quantity
  at all — a 1,000-process system can open 1,000 windows and discover the problem as dropped frames.
  Constraint 49's admission controller needs a companion: a global window cap and a global
  blurred-area budget, both checked at `win_create`, both returning a specific errno. An admission
  controller that can only degrade and never refuse is half a governor.

### A SymbOS executable header carries its own resource-reclamation manifest — 4 sub-process/timer IDs at offset 010 and 8 memory-area descriptors (bank, address, length) at offset 048 — and **only** if the application fills these in will the system release the memory and stop the sub-processes when the app is killed from the task manager.

- System: SymbOS
- Evidence: https://github.com/Prodatron/symdoc-developer/blob/13f125a73925a76b9016de5ebe874b591b8aec2b/SymbOS-Applications.txt ("Application header", offsets 010 and 048)
- Confidence: verified
- Why it matters: constraint 15 already puts every releasable resource kernel-side, which is the
  stronger version of this — so the finding is confirmation with one addition. A fixed-size
  kernel-written per-process manifest (children, SAB ids, window ids, fds) makes kill **O(manifest)**
  rather than a scan of global tables, which matters because teardown runs at `terminate()` time
  while the victim is still executing (14) and because signals must be O(interested) (18). SymbOS's
  mistake is instructive too: making the manifest the *app's* job is why killing a SymbOS app can
  leak, and it is precisely the dependency on app cooperation this project has already refused.

### Every SymbOS application bank reserves its first 1 KB for kernel jump and banking routines and its last 256 bytes for interbank thunks — about 2% of each process's 64 KiB address space is a resident copy of the kernel's call surface.

- System: SymbOS
- Evidence: https://github.com/Prodatron/symdoc-developer/blob/13f125a73925a76b9016de5ebe874b591b8aec2b/SymbOS-MemoryMap-CPC.txt ("Application Memory Usage")
- Confidence: verified
- Why it matters: the quantified version of a cost this project has left as one number. The ~600 KiB
  resident per process (17) should be decomposed into the fixed libos/runtime share and the
  application's own share, because only the first can be attacked by sharing and only the second
  scales with what the app does. Without the split, the 128 cap cannot be argued up or down on
  evidence.

### SymbOS gives the system two counters so CPU load is measured rather than estimated: `MTGCNT` returns a system counter incremented 100 times a second and an idle counter incremented every 64 µs while the idle process holds the CPU, with the documented formula `CPU_usage = 100% * Δidle / (Δsystem * 156)`.

- System: SymbOS
- Evidence: https://github.com/Prodatron/symdoc-developer/blob/13f125a73925a76b9016de5ebe874b591b8aec2b/SymbOS-Kernel.txt (`Multitasking_GetCounter`)
- Confidence: verified (156 ≈ 10 ms / 64 µs, consistent)
- Why it matters: an 8-bit kernel exposes a two-counter load metric through its ABI, and this project
  — whose single kernel thread serializes every syscall in the system, and whose top risk is exactly
  that — has no such thing. An idle-vs-elapsed counter pair in a SAB word, readable **without a
  syscall** (the ABI already does this for UID), turns "is the kernel the bottleneck" into a number
  the taskbar can show and the harness can assert, in production rather than once in a bench.

### SymbOS runs preemptive and cooperative multitasking together with 7 priority levels, pins the desktop manager and the system manager at priority 1 while applications sit at 4, and documents the resulting starvation: a hard-interrupted process means "processes with a lower priority won't get any CPU time" until every process at that level yields with `RST #30`.

- System: SymbOS
- Evidence: https://github.com/Prodatron/symdoc-developer/blob/13f125a73925a76b9016de5ebe874b591b8aec2b/SymbOS-Kernel.txt (RST #30, RST #38, `MSC_KRL_MTADDP` priorities 1–7)
- Confidence: verified
- Why it matters: with no preemption at all (21), SymbOS's documented starvation case *is* this
  project's normal case — and its answer is architectural rather than policy: the two
  latency-critical servers outrank every application by construction. The web-os translation is that
  the compositor and the kernel must not contend with applications for service in one FIFO syscall
  queue; they need either a separate channel or explicit priority in the drain order (which
  HelenOS's answerbox finding also argues, from the other direction).

### The MenuetOS/KolibriOS executable is a flat image with a 36-byte (`MENUET01`) or 64-byte (`MENUET64`) header and no sections, symbols or relocations: magic, then `version`, `start`, `i_end` (image size), `mem_size` (memory to grant), `stack_top`, `i_param`, `i_icon`.

- System: MenuetOS and KolibriOS
- Evidence: https://git.kolibrios.org/KolibriOS/kolibrios/raw/branch/main/kernel/trunk/core/taskman.inc (`struct APP_HEADER_01_`); http://www.menuetos.net/menuet.txt
- Confidence: verified
- Why it matters: the loader's whole job is "read 36 bytes, allocate `mem_size`, map, set entry".
  Spawn is 1.86 ms from a Blob URL plus 5–6 ms for a WASM instantiation (19), and the instantiation
  dominates — so a header that declares the memory grant and entry point up front lets the kernel
  **refuse a spawn on budget grounds before compiling anything**. The ABI has a `SpawnSpec` for the
  call but no image header, which means today the only way to learn what a program needs is to run
  it.

### KolibriOS makes dynamic linking opt-in per binary through the header version field: if `version == 2` the kernel loads `dll.obj` at exec time and rewrites the new thread's saved `EIP` to `APP_STARTUP_THUNK` inside it; otherwise the binary is fully self-contained, and a running app can still load a library explicitly with function 68.19.

- System: KolibriOS
- Evidence: https://git.kolibrios.org/KolibriOS/kolibrios/raw/branch/main/kernel/trunk/core/taskman.inc (`.try_load_dll`, `cmp dword[ecx+8], 2`, `mov [ecx+REG_EIP], eax`); https://git.kolibrios.org/KolibriOS/kolibrios/raw/branch/main/kernel/trunk/docs/sysfuncs.txt (Function 68.18/68.19)
- Confidence: verified
- Why it matters: answers "shared runtime or self-contained?" with "both, declared in the header".
  The web-os equivalent is a header bit meaning "this image expects the shared libos module already
  instantiated in the host", which is the only way to avoid paying the 5–6 ms WASM instantiation per
  process for a runtime every process shares. Without it, 128 processes pay 128 instantiations — and
  at option B, where processes are real wasip1 binaries, that is the difference between a usable
  shell pipeline and a visibly slow one.

### A SymbOS executable is a 256-byte header plus **three separately relocated segments** (code / data / transfer) and a fourth relocator-table segment discarded after load, each optionally ZX0-compressed, with the relocator table optionally nibble-packed as pointer deltas ("on average about a third smaller").

- System: SymbOS
- Evidence: https://github.com/Prodatron/symdoc-developer/blob/13f125a73925a76b9016de5ebe874b591b8aec2b/SymbOS-Applications.txt ("Application structure", "Compressed application files", "Packed relocator tables")
- Confidence: verified
- Why it matters: the load-bearing idea is that each segment's *placement constraint* is declared in
  the header, so the loader can satisfy several allocators. The web-os analogue is declaring which
  parts of an image must live in the shared SAB — visible to the kernel and the compositor — versus
  the Worker's private heap. Today everything is implicitly private, which is the deeper reason the
  window protocol has to copy pixels at all, and the reason the SymbOS retained-mode design above is
  even available as an option.

### GeckOS deliberately pays a per-switch memory copy to remove its process ceiling: the `STACKCOPY` option copies the 64-byte userspace stack out to a per-task save area and the next task's in on every context switch, which the port documentation says "allows for an arbitrary number of tasks (in theory)".

- System: GeckOS V2 (C64)
- Evidence: https://github.com/fachat/GeckOS-V2/blob/2f28ba3026127281a5954ab2eb059732f295772b/doc/c64.p.adoc
- Confidence: verified
- Why it matters: the same bargain is available here and nobody has priced it. The hard ceiling (17)
  exists because a live Worker is the only representation of a process. A **swapped-out process
  state** — process table entry and SAB retained, Worker torn down, resurrected on next delivery —
  converts a hard renderer death between 3,200 and 4,800 workers into a cost paid on wake (1.86 ms
  plus instantiation, 19). It only works for processes whose entire state is already kernel-side,
  which (15) says is all of them except the program's own heap — so the honest version is: it works
  for a process parked in `waitpid` or `poll` with a small heap, which is most daemons.

### LUnix sizes each task's slice from its priority so that the **round-trip time of the round-robin stays between 1/4 and 1/2 second**, counts the current slice in a zero-page byte, and exposes the achieved round trip as a live kernel variable (`lk_cycletime`).

- System: LUnix / LNG (C64)
- Evidence: https://github.com/ytmytm/c64-lng/blob/b76b0470e28ec20d08c37405bf76d16d93f85fbe/kernel/README
- Confidence: verified
- Why it matters: there is no preemption here so there is no slice — but the *invariant* transfers
  exactly. LUnix's scheduler contract is a bounded round-trip latency, not a quantum, and the
  achieved figure is readable at runtime. The equivalent contract for a single-threaded kernel is a
  bound on syscall service latency as the live process count grows, published as a number. That is
  what would make M0's accept/kill criterion a permanent invariant instead of a one-off gate.

### MenuetOS's scheduler ticks at 1000 Hz by default and can be raised to 100,000 Hz (system call 241), and a process can demand uninterrupted exclusive execution on a CPU (system call 240).

- System: MenuetOS (64-bit)
- Evidence: http://www.menuetos.net/menuet.txt (§2.3, §2.6)
- Confidence: from docs (published claim on an undated page; no measurement traceable)
- Why it matters: the useful part is the explicit **opt-out** of scheduling. "A compute loop with no
  syscalls is killable but not interruptible" (21) is an accidental version of the same thing.
  Making it deliberate — a declared non-yielding section with a deadline, after which the kernel
  kills — converts an unbounded hazard into a contract, gives the "not responding" detector
  (SerenityOS's ping/pong) a legitimate exemption to honour, and gives the process table a reason to
  refuse more than N non-yielding processes.

### KolibriOS IPC (function 60) has the **receiver** register a buffer in its own address space whose first two dwords are a lock word and an occupied-byte counter, with each message carrying a 12-byte header (sender PID, length, data); send returns distinct codes for "no buffer registered" (1), "buffer locked, try later" (2), "overflow of IPC-buffer of the receiver" (3) and "no such PID" (4), and the kernel raises event 7 on the receiver immediately after the write.

- System: KolibriOS
- Evidence: https://git.kolibrios.org/KolibriOS/kolibrios/raw/branch/main/kernel/trunk/docs/sysfuncs.txt (Function 60.1, 60.2)
- Confidence: verified
- Why it matters: the closest published analogue to the SAB channel, and the differences are the
  lesson: the buffer is **receiver-sized and receiver-owned**, the receiver can **lock it against
  mutation while reading**, and backpressure is a sender-visible error rather than a block. Our SAB
  is per-process and written by both sides with no lock word, and a slow receiver has no way to push
  back on many senders. Adding a lock word and an explicit overflow return is a small mechanical
  change to the SAB layout that closes the same gap constraint 9 names.

### GeckOS passes everything that does not fit in registers through one global 256-byte buffer protected by a single semaphore whose **ownership is transferred from sender to receiver on delivery** — and its own documentation calls the design a mistake it is stuck with ("Also the *PCBUF* is still used (unfortunately)").

- System: GeckOS V2
- Evidence: https://github.com/fachat/GeckOS-V2/blob/2f28ba3026127281a5954ab2eb059732f295772b/doc/sendreceive.7.adoc; buffer address in https://github.com/fachat/GeckOS-V2/blob/2f28ba3026127281a5954ab2eb059732f295772b/doc/c64.p.adoc
- Confidence: verified
- Why it matters: the single global transfer buffer is the far end of the trade this project makes
  with per-process SABs, and the authors' own verdict is worth having on the record. The transferable
  mechanism is narrow and good: **ownership transfer of the lock as part of delivery**, which removes
  a release-then-acquire round trip from every hand-off. Applicable to the `shm_create`/`shm_attach`
  path.

### EmuTOS ships one ABI at four ROM sizes — 1024/512/256/192 KB — and the size tier, not a config flag, decides which features exist: the 192 KB build has no shell, "limited desktop features (comparable to Atari TOS 1)", no text viewer or print, one language, no extra-hardware autodetection and plain-68000 only; the cartridge build drops the AES and the desktop entirely.

- System: EmuTOS
- Evidence: https://github.com/emutos/emutos/blob/94e002ef316b85f5ea03a8dde6686a5b692e6b61/doc/readme-192k.txt; https://emutos.github.io/manual/
- Confidence: verified
- Why it matters: a mechanism for keeping a fast-boot claim true as the system grows — the same ABI
  with a declared minimal profile that omits *named* subsystems, rather than one image that must
  carry everything. It implies something the ABI does not say: which of the 68 calls are optional,
  and what they return when the subsystem behind them is absent. `ENOSYS` is not in the errno set
  listed for any call group.

### EmuTOS tracks ABI fidelity as a checked-in per-call status matrix with six states — `?` unknown, `-` not implemented, `>` partial, `X` implemented/untested, `t` partially tested, `T` tested on emulator or real hardware — organised by the TOS version that introduced each call; after 25 years only **11 calls are marked not implemented**, most annotated "useless - will not be implemented".

- System: EmuTOS
- Evidence: https://github.com/emutos/emutos/blob/94e002ef316b85f5ea03a8dde6686a5b692e6b61/doc/status.txt (count from `grep -c "^ - "` at that sha = 11)
- Confidence: verified
- Why it matters: this is the artifact the 68-call ABI and the Windows 7 surface both need, and it
  does not exist here. One row per call, with **"tested on the real artifact" as a state distinct
  from "implemented"** — which is `CLAUDE.md`'s own rule about exercising a change through the
  artifact a user touches, in table form. Their omission rule is also worth copying: omit only calls
  whose *purpose* is gone, record why in the table, and never omit by difficulty.

### EmuTOS's compatibility breakages are almost never missing API surface — they are applications reading undocumented addresses and probing internals by heuristic: `incompatible.txt` names 25 programs plus 5 generic categories, including STOS Basic using "a built-in table of TOS-specific locations", Omikron Basic expecting register `A0` to point at the floppy write-protect latch on return from `Mediach`, and Omikron parsing the bytes of the `0xA00A` Line-A routine to recover an internal variable's address.

- System: EmuTOS
- Evidence: https://github.com/emutos/emutos/blob/94e002ef316b85f5ea03a8dde6686a5b692e6b61/doc/incompatible.txt
- Confidence: verified
- Why it matters: the single most useful fidelity lesson available, because it says where the risk
  actually is. Fidelity risk concentrates in whatever is **observable but unspecified** — here that
  is the SAB field layout beyond the documented words, syscall timing, pid allocation order, and the
  exact pixel geometry of the Windows 7 chrome. Anything an app can read becomes de-facto ABI. The
  actionable move is cheap and unusual: **randomise or version-stamp the unspecified parts of the SAB
  layout in debug builds**, so an app that depends on them fails in the harness rather than in a bug
  report three years later. That is a negative control for the ABI itself.

### EmuTOS's compatibility escape hatch is two user-visible toggles — Blitter and Cache — rather than per-application quirks, "because some programs, typically games, have problems with the blitter or cache, and turning them off can help".

- System: EmuTOS
- Evidence: https://emutos.github.io/manual/ ("Compatibility")
- Confidence: from docs
- Why it matters: a small fixed set of orthogonal switches the user can see beats an application-keyed
  quirk database, which is the trap a Windows 7 surface reimplementation walks into first (Windows
  itself shipped a per-executable compatibility shim database, which is the thing not to copy).

### DexOS solved the same tight-resource problem by deleting multiprocessing entirely: "there's no virtual memory paging, and only a single process is allowed (though that process can spawn multiple threads)", the program runs in ring0 with direct hardware access, "memory allocation is the responsibility of the app" and "the entire OS will fit into less than 100k".

- System: DexOS
- Evidence: http://web.archive.org/web/20090227065045/http://www.dex4u.com/ — the live site is gone (`dex4u.com` has been parked since at least the 2013-01-11 capture) and no surviving source repository was found, so this timestamped Wayback capture is the most stable address available
- Confidence: from docs (self-published; the "<100k" figure is marketing, not a traceable measurement)
- Why it matters: the useful counter-example. DexOS shows that single-process, zero-isolation is the
  cheapest way to hit a tight budget — which means the ~600 KiB per process and the
  3,200–4,800-Worker ceiling are **what isolation costs here**, not an unavoidable fact of the
  platform. That should be stated as a deliberate purchase.

### Ghost is a live project (ghostkernel.org, version 0.12.0) with disk and filesystem drivers and a disk-management service as privileged userspace processes, filesystem drivers communicating by messaging with shared memory preferred for file I/O, a window server, SMP, and a 2025 x86_64/UEFI/Limine port.

- System: Ghost
- Evidence: https://ghostkernel.org/ ; https://ghostkernel.org/documentation
- Confidence: from docs
- Why it matters: recorded only to close out the Wikipedia list — a conventional x86 microkernel with
  no comparable resource ceiling and no published figures. **Ghost is real and findable; DexOS is
  real but its site is dead.**

### Could not be determined (tight-budget systems)

- **No published boot-time figure for MenuetOS or KolibriOS.** kolibrios.org says only "boots in less
  than few seconds from power-on to working GUI"; Wikipedia says "in only a few seconds". Both
  unquantified. The only hard numbers on those pages are 12 MB RAM, i586, and the 1.44 MB floppy.
- **No published per-application binary size** for either, and
  `wiki.kolibrios.org/wiki/Executable_file_format` **404s** — the authoritative documents are in
  `kernel/trunk/docs/`, not the wiki.
- **SymbOS message queue depth is undocumented.** `Message_Send` returns 0 for "queue full" but
  neither the kernel nor the overview document states the depth, or whether it is per-process.
- **No context-switch cost in cycles or microseconds for SymbOS, GeckOS or LUnix.** The closest
  quantities are structural: GeckOS copies 64 bytes of stack per switch, LUnix up to 128, LUnix has
  32 task slots, GeckOS reports "up to 16 running tasks". Wikipedia itself flags the SymbOS claim
  that the Z80 alternate register set "accelerates context switching dramatically" as dubious.
- **No IPC latency figure is published for any of these systems.**
- **GeckOS's minimum kernel size is a doc claim**, not a measurement: "the kernel can be shortened to
  (almost) 2k in size by leaving out some stuff"
  (https://github.com/fachat/GeckOS-V2/blob/2f28ba3026127281a5954ab2eb059732f295772b/doc/kernel.7.adoc).
- **symbos.de fails TLS handshake with LibreSSL** and its pages are JavaScript-generated, so the
  app-size tables are not in the HTML.
- **git.kolibrios.org returns 403 for commit-pinned raw URLs**, so KolibriOS citations here are
  branch-relative at revision `2d3d5e6299a3fe8009653ce3fc770fca04509a7d`.

---

## 4. AROS, Phantom OS and TempleOS

Three systems chosen for three questions this project has to answer and has not: how do you
reimplement a published API you cannot see the source of (AROS), what does persistence actually cost
when it is the architecture rather than a feature (Phantom, with the prior art it descends from), and
what exactly is being bought by having a kernel boundary at all (TempleOS, which has none and is the
predecessor's accidental trust model stated as a design goal).

Pinned revisions: AROS `aros-development-team/AROS` @ `64d00bf2daa56870b93f7daa1c0e28d35a701c12`;
Phantom `dzavalishin/phantomuserland` @ `ccb6541f719fceff89a15d0c10b9efa5f5e39ad5`; TempleOS
`cia-foundation/TempleOS` @ `c26482bb6ad3f80106d28504ec5db3c6a360732c` (branch `archive`). Two
citation caveats carried from the research: Phantom's GitHub **wiki** pages cannot be pinned and are
mutable, and `phantomdox.readthedocs.io/en/latest/` has no versioned build — both are flagged where
used. All Phantom material read was English; no Russian-language source or translation was relied on.

### AROS declares each library's entire public interface in one machine-readable `.conf` file — version, base struct, every function with its register mapping, `.skip N` to reserve vector slots, `.version N` to mark functions added in a later release, plus BOOPSI class declarations — and `tools/genmodule` generates the stubs, the vector table, the headers, the inlines, the prototypes and the link entries from it.

- System: AROS
- Evidence: https://raw.githubusercontent.com/aros-development-team/AROS/64d00bf2daa56870b93f7daa1c0e28d35a701c12/rom/intuition/intuition.conf (e.g. `UWORD AddGadget(struct Window *window, struct Gadget *gadget, UWORD position) (A0, A1, D0)`, with `.skip`, `.version 33/36/39/50`, `.novararg`, `.alias`); generator at https://github.com/aros-development-team/AROS/tree/64d00bf2daa56870b93f7daa1c0e28d35a701c12/tools/genmodule
- Confidence: verified
- Why it matters: **the highest-value finding in the survey for the 68-call ABI.** `CLAUDE.md`
  already requires a syscall number, errno or SAB offset to be one named constant imported by both
  sides; this is the mechanism that makes the rule hold without discipline — one declaration, from
  which the libos stub, the kernel dispatch table, the `/proc` names and `docs/ABI.md` itself are
  generated, so they cannot drift. `.skip N` is how a call is deleted without renumbering (the slot
  stays reserved) and `.version N` is how the ABI grows additively. Both are nearly free now and
  impossible to retrofit once anything is compiled against the table. It also subsumes SerenityOS's
  `IPCMagicLinter` finding: a generator that owns the numbers makes the linter's job structural.

### An AmigaOS/AROS library call is positional, not nominal: the library base is a pointer whose negative side is a jump table of 6 bytes per entry, every function is identified by its byte offset from the base (`OpenLibrary` itself at offset 92, `DEV_BEGINIO` at −30), and `SetFunction(lib, funcOffset, funcEntry)` can repoint any slot at runtime.

- System: AROS
- Evidence: https://en.wikibooks.org/wiki/Aros/Developer/Docs/Libraries/Exec; dispatch sequence in https://raw.githubusercontent.com/aros-development-team/AROS/64d00bf2daa56870b93f7daa1c0e28d35a701c12/rom/exec/openlibrary.c
- Confidence: verified
- Why it matters: the cautionary half of the previous finding. Positional dispatch is fast and
  generates cleanly, but it makes call *ordering* part of the ABI permanently — which is what cost
  AROS its ABI break. Pick one and commit: if syscall numbers are the ABI, retired numbers are
  reserved forever and the table is generated; if the project wants freedom to reorder, dispatch by
  name and pay the lookup. The ABI currently has 68 calls in six groups with no statement either way,
  and it borrows WASI preview1's errno numbers verbatim, which is already a commitment to an external
  numbering it does not control.

### AROS's ABI v1 break was, in its own description, "mainly about structural alignment, LVOs and C library": moving the library base from the stack into a per-architecture scratch register, making dos.library's `BPTR` always word-based, and splitting arosc into a ROM-capable core plus I/O and POSIX modules — all described as "impossible to fix without breaking binary compatibility". The plan set one feature per month and estimated completion "within 2011", reporting 3 of 11 items done with only i386-hosted working; an "ABIv11" fork is still in use today.

- System: AROS
- Evidence: https://en.wikibooks.org/wiki/Aros/Developer/ABIv1; the live fork at https://en.wikibooks.org/wiki/Aros/Developer/Docs
- Confidence: from docs (a developer discussion page, explicit about which items were proposals)
- Why it matters: every item on that list is a **representation** decision, not a feature decision —
  where a handle lives, what unit a pointer counts in, how a library's state is partitioned. The
  analogous decisions here are the 64 KiB SAB layout, the futex word's position and meaning, the
  `(lo, hi)` register pairing for 64-bit arguments, and the `r0 < 0 && r1 == -1` error convention.
  Those must be frozen before the ABI is published, because the alternative is not a one-time cost:
  AROS's one-year migration estimate was still generating forks and renumbering debates a decade
  later. The rule AROS reached for afterwards is the one to adopt from the start — **additive only,
  retired slots stay reserved**.

### An Amiga/AROS GUI application never polls: it computes a signal mask from its window's message port (`1L << win->UserPort->mp_SigBit`), OR's in any other sources, blocks in `Wait()`, then drains with `GetMsg()` **until NULL**, copies the fields it needs, calls `ReplyMsg()`, and only then acts — under the hard rule "Do never try to read a message after you have replied!", because the message belongs to the sender again.

- System: AROS
- Evidence: https://en.wikibooks.org/wiki/Aros/Developer/Docs/Libraries/Intuition; port primitives and the 32-signals-per-task split at https://en.wikibooks.org/wiki/Aros/Developer/Docs/Libraries/Exec
- Confidence: from docs
- Why it matters: **three independent systems now agree on this and the ABI does not do it.** One
  wake covers many messages (AROS `GetMsg` to NULL, SerenityOS's self-pipe draining an array of
  pending wakes, HelenOS's notification counter), so a receiver must drain to empty rather than
  handle one event per wake. The request path is fine — one futex word, one outstanding call — but
  the *unsolicited event* path (window input, signals, pipe readiness) needs an explicit
  drain-to-empty contract, or events are coalesced and silently lost. The ownership rule is the second
  half: "who may touch this buffer now" is undecidable with one shared region unless handoff is
  defined, and the SAB has no such statement.

### BOOPSI splits rendering and input by sending methods to the widget's class rather than events to the app — `GM_RENDER`, `GM_HITTEST` (returning `GMR_GADGETHIT`), `GM_GOACTIVE` (returning `GMR_MEACTIVE` or `GMR_NOREUSE`), `GM_HANDLEINPUT`, `GM_GOINACTIVE`, `GM_LAYOUT` — with drawing outside `GM_RENDER` requiring `ObtainGIRPort()`/`ReleaseGIRPort()`, `GM_LAYOUT` forbidden from drawing, and state changes propagating via `Notify()` → `OM_NOTIFY` to an `ICA_TARGET`. The same documentation warns that BOOPSI dispatch is much slower than a C++ virtual call and unsuitable for time-critical loops.

- System: AROS
- Evidence: https://en.wikibooks.org/wiki/Aros/Developer/Docs/Libraries/Intuition/BOOPSI
- Confidence: from docs
- Why it matters: a published, battle-tested answer to where the line between compositor and app
  goes, and it lands in the same place as SymbOS's retained-mode controls and KolibriOS's
  frame/client split: the server owns hit-test dispatch, the active-widget state machine and layout
  invalidation; the app owns pixels and input interpretation; out-of-band drawing must explicitly
  borrow the context. The warning is the part to take most seriously here — a round trip per widget
  method is 14–16 µs, and 550 of them fill a frame (5), so a BOOPSI-shaped protocol over the syscall
  channel must batch or it will be slower than the thing it replaces.

### AROS m68k achieves real binary compatibility with AmigaOS 3.1 by matching register-level parameters and public structure layouts — but only on the same CPU, bridged at the container layer (AROS components are ELF, AmigaOS is HUNK, joined by an `ELF2HUNK` tool), with AROS-native 68k apps *not* running on classic AmigaOS, `arosc.library` apps excluded, hardware sprites and copper lists lost under the framebuffer approach, and x86 requiring Janus-UAE emulation.

- System: AROS
- Evidence: https://en.wikibooks.org/wiki/Aros/Platforms/68k_support
- Confidence: from docs
- Why it matters: the fidelity method for the Windows 7 surface, stated as a procedure. AROS
  reproduced the API faithfully and accepted that the layers where it could not — the executable
  container, and the hardware-specific behaviour *behind* the API — would be bridged by a converter
  or dropped outright. This project's equivalent unspecified layers are the Aero composite blend
  (34–35), Snap's thresholds (M14), the Superbar and jump lists. Decide per feature whether it is
  reimplemented, approximated, or dropped — and record which, per feature. AROS's progress is legible
  precisely because that list exists; `docs/CONSTRAINTS.md` has the measurements but no such register.

### AROS splits its ROM into a boot image and an extension image — "rom" holds what is needed to boot from disk, "ext" holds the rest including Intuition, Graphics and Layers — so the system boots on a partial implementation.

- System: AROS
- Evidence: https://en.wikibooks.org/wiki/Aros/Platforms/68k_support
- Confidence: from docs
- Why it matters: the same idea as EmuTOS's size tiers, arrived at independently, and it maps
  directly onto the milestone order. A kernel that mounts and runs a shell on a minimal syscall
  subset, with the rest of the 68 in a second tier, makes progress measurable per call rather than
  per milestone — and the spine already *is* that minimal subset without saying so.

### Phantom's snapshot stops the world only for a mark phase: it disables interrupts, waits for every VM thread to drop its persistent-memory lock, runs a whole-heap verifier, write-protects every mapped writable page, then re-enables interrupts and restarts the threads **before any snapshot data is written**.

- System: Phantom
- Evidence: https://raw.githubusercontent.com/dzavalishin/phantomuserland/ccb6541f719fceff89a15d0c10b9efa5f5e39ad5/oldtree/kernel/phantom/vm_map.c (`do_snapshot()`)
- Confidence: verified
- Why it matters: the stop-the-world window is bounded by a page-table walk, not by I/O. The web-os
  analogue is exact and currently unspecified: quiesce every process at a syscall boundary, mark the
  inode table immutable, release the processes, *then* serialize to OPFS. The plan says the journal is
  flushed "on fsync, on snapshot, and when idle" (23) without saying whether anything is parked while
  that happens — and a snapshot at 10k inodes plus a 260 µs flush inside a barrier is a user-visible
  stall every time it fires.

### Phantom's copy-on-write happens in the write-fault handler during a snapshot: the fault allocates a fresh page, copies the contents, remaps the original writable and enqueues the *copy* for pageout — so the snapshot writes the old bytes while the mutator keeps the new ones.

- System: Phantom
- Evidence: https://raw.githubusercontent.com/dzavalishin/phantomuserland/ccb6541f719fceff89a15d0c10b9efa5f5e39ad5/oldtree/kernel/phantom/vm_map.c (`page_fault_write()` → `page_fault_snap_aid()`, `snapper_COW_callback()`)
- Confidence: verified
- Why it matters: no write-fault hook exists in a browser, but the structural rule transfers and is
  cheap: snapshot a **frozen clone** of the inode table and keep mutating the live one, so snapshot
  latency never blocks a writer. At 10k inodes the table is small enough to clone (boot reads it in
  7.2 ms, constraint 25), which makes this strictly easier here than in Phantom.

### Every Phantom persistent page is backed by up to three disk blocks — `prev_page`, `curr_page`, `make_page` — and the rule is "If page is to be written, it goes to curr page ONLY", with the snapshot's invariant stated as "all pages have make_page and it contains correct data".

- System: Phantom
- Evidence: https://github.com/dzavalishin/phantomuserland/wiki/KernelVmMap (mutable GitHub wiki, read 2026-11-12); fields and flags confirmed in https://raw.githubusercontent.com/dzavalishin/phantomuserland/ccb6541f719fceff89a15d0c10b9efa5f5e39ad5/oldtree/kernel/phantom/vm_map.c
- Confidence: verified
- Why it matters: **this names a gap in D9 worth confirming before M2.** File data lives in a flat
  OPFS directory named by inode (26), which means overwriting an existing file mutates its blob **in
  place**. The journal and the alternating superblocks give crash consistency for *metadata*; a blob
  half-overwritten when the tab dies leaves intact metadata pointing at torn data. That is
  POSIX-permissible without `fsync` and it is also exactly ext4's `data=writeback` — the difference
  being that ext4 ships `data=ordered` by default to avoid precisely this
  (https://www.kernel.org/doc/html/latest/admin-guide/ext4.html). Either data gets the same
  prev/curr discipline (write a new blob, swing the reference at commit — which the flat layout makes
  easy, since the name is just an integer), or the guarantee is declared metadata-only and written
  down. It is a one-line change to the docs and a one-day change to the code; discovering it after
  users have files is the bad outcome.

### Phantom keeps two complete snapshots on disk while writing a third, commits by swinging `prev_snap`/`last_snap` in the superblock, brackets that update with `pager_fence()` on both sides, keeps the superblock in three copies with a checksum and a major/minor `DISK_STRUCT_VERSION` — a minor version newer than the kernel's panics — and offers an explicit latest-or-previous choice at restart. Its `pager_long_fsck()` is a stub returning 0, so a dirty filesystem panics rather than being repaired.

- System: Phantom
- Evidence: https://raw.githubusercontent.com/dzavalishin/phantomuserland/ccb6541f719fceff89a15d0c10b9efa5f5e39ad5/oldtree/kernel/phantom/vm_map.c (end of `do_snapshot()`); https://raw.githubusercontent.com/dzavalishin/phantomuserland/ccb6541f719fceff89a15d0c10b9efa5f5e39ad5/oldtree/kernel/phantom/pager.c (`pager_get_superblock`, `pager_update_superblock`, `pager_long_fsck`); retention and restart choice at https://phantomdox.readthedocs.io/en/latest/ (unpinned "latest" URL; no versioned build published)
- Confidence: verified
- Why it matters: three concrete amendments to D9/D11, in increasing order of value. (a) A
  **version field with major/minor semantics** in the superblock, with "minor newer than me ⇒
  refuse", is the cheap part and is unavailable later. (b) Phantom keeps **three** generations in
  flight, not two, so a corrupt commit still leaves a good fallback that is not the one just
  overwritten — with two alternating superblocks, a bad write to the older slot during a commit can
  leave zero valid copies. (c) With three generations, "mounts read-only and reports" (28) can be
  strengthened to "mounts the previous generation read-write and reports", which is a better outcome
  for the same honesty. And the reference implementation of orthogonal persistence never finished its
  repair path and chose to halt — which is D11's decision, independently arrived at.

### Phantom makes a syscall restartable rather than resumable: the `sys` opcode stores its arguments, rewinds the stack and instruction pointer to before the instruction, then calls the kernel — so a snapshot plus reboot mid-syscall causes the call to be **re-executed from scratch** after restart.

- System: Phantom
- Evidence: https://github.com/dzavalishin/phantomuserland/wiki/BlockingSyscalls (mutable wiki, read 2026-11-12); corroborated at https://phantomdox.readthedocs.io/en/latest/ and by `vm_syscall_block` in https://raw.githubusercontent.com/dzavalishin/phantomuserland/ccb6541f719fceff89a15d0c10b9efa5f5e39ad5/oldtree/kernel/phantom/snap_sync.c
- Confidence: verified
- Why it matters: the only reload story in the survey with a mechanism behind it, and it prices the
  idea precisely. A process could survive a tab reload only if every blocking syscall is **idempotent
  and replayable**: one outstanding call per process (which the one-futex-word design already
  guarantees), the call's arguments recorded in persistent state, and the call replayed on resume.
  That is a hard constraint on all 68 calls — `write` at an implicit offset is not idempotent,
  `pread` is — and it has to be priced before the ABI is frozen, not after. The plan has no reload
  story at all; this says what one would cost.

### Phantom has no working mechanism for reconnecting external resources across a restart: the `.internal.connection` class was deleted, the page describing kernel-object reconnection is marked "This article is outdated", and the TCP syscalls `connect`, `disconnect`, `send`, `recv` and `accept` all throw "not implemented".

- System: Phantom
- Evidence: https://github.com/dzavalishin/phantomuserland/wiki/ObjectKernelConnector (mutable wiki, read 2026-11-12); https://raw.githubusercontent.com/dzavalishin/phantomuserland/ccb6541f719fceff89a15d0c10b9efa5f5e39ad5/phantom/vm/syscall_net.c (every handler but `curl` throws)
- Confidence: verified
- Why it matters: **the hardest problem in orthogonal persistence is unsolved in the reference
  implementation after two decades.** So "a process survives reload" must not be treated as a feature
  that will fall out of good persistence design later. The approaches with evidence behind them are
  the next two findings: enumerate the un-snapshottable set and exclude it by construction, and make
  reconnection explicit at the application level.

### Phantom's architecture does enumerate its exclusions even where it cannot reconnect: the POSIX personality and the hosted runtime are explicitly not persistent, most internal classes "have to recreate their objects state on kernel restart", anything holding a kernel handle is registered on a restart list to be refcount-decremented and killed, and a single root object exists to relocate the class objects, the thread list, the class loader and the named-object directory after reboot.

- System: Phantom
- Evidence: https://phantomdox.readthedocs.io/en/latest/ (architecture list, "Restart manager — Provides means to find all objects that have to be re-connected to kernel on reboot"); restart-list rule at https://github.com/dzavalishin/phantomuserland/wiki/BlockingSyscalls (mutable wiki)
- Confidence: from docs
- Why it matters: the pattern is a **root record plus a kill-list**, and both are implementable now
  for almost nothing. The superblock should name one root record; every inode-table entry
  representing a transient — an open fd, a pipe, a pty, a window, a Worker reference — belongs in a
  list the mount path destroys unconditionally. M2 currently has no statement about what in the table
  is not supposed to survive, which means the first stale pipe inode after a reload will be found by a
  user rather than by a test.

### Embedded EROS, having moved drivers out of the kernel, had to add a class of objects exempt from checkpointing entirely — physical memory pages and non-pageable objects are excluded from both checkpointing and eviction, with two OID ranges reserved by convention for them.

- System: EROS (prior art)
- Evidence: https://www.usenix.org/legacy/publications/library/proceedings/usenix02/full_papers/shapiro/shapiro.pdf §7
- Confidence: verified
- Why it matters: generalises the previous finding into a rule — a persistent system needs a
  **declared non-persistent range**, not ad-hoc special cases. Give the inode table an explicit
  transient class with a reserved inode-number range, so "what does not survive a reload" is a
  property that can be enumerated and asserted by a check rather than discovered by debugging. It
  also gives `/proc` and `/dev` a principled home: they are generated on read (M3) and therefore
  transient by construction.

### EROS/KeyKOS takes a consistent whole-system snapshot without stopping the world — marking every dirty object copy-on-write, writing a watermark into an **append-only** checkpoint area, resuming execution immediately, then flushing pre-snapshot dirty objects while a background migrator copies them home before the next checkpoint may commit — and it reserves space for a page *before* the page is dirtied, so a snapshot can never fail for lack of room.

- System: EROS / KeyKOS (prior art)
- Evidence: https://www.usenix.org/legacy/publications/library/proceedings/usenix02/full_papers/shapiro/shapiro.pdf §3.2
- Confidence: verified
- Why it matters: three mechanisms the snapshot-plus-journal design is missing, all cheap.
  **Reserve-on-dirty** removes the failure mode where the snapshot cannot be written — which matters
  more here than on a disk, because OPFS quota is not under our control and can be refused.
  **Append-only staging** is what the journal already is. **Migrate-before-next-commit** is the gate
  the design lacks: nothing currently prevents a second snapshot starting while the first is
  half-written.

### EROS/KeyKOS carries a deliberate escape hatch that commits an individual page immediately, outside the periodic checkpoint, precisely because database logs cannot wait for the next one.

- System: EROS / KeyKOS (prior art)
- Evidence: https://www.usenix.org/legacy/publications/library/proceedings/usenix02/full_papers/shapiro/shapiro.pdf §3.2 ("there is a special 'escape hatch' mechanism permitting immediate transaction of individual pages")
- Confidence: verified
- Why it matters: **this is the answer to the project's own open question** about whether an OPFS
  journal append plus `flush()` is durable across a kill. Do not try to make the whole journal
  synchronously durable; the spec's "attempt to transfer, may be a no-op" wording then only describes
  the bulk path. Define one narrow escape-hatch call — which the ABI already has, `fsync` on a single
  fd (23) — and **measure its durability specifically**, with the negative control being a tab killed
  mid-write and an assertion that the record survived. That turns an unanswerable question about the
  whole design into one measurement on one call.

### L3/EUMEL implemented transparent checkpointing with asynchronous copy-on-write specifically for interactive responsiveness, whereas Fluke's user-level system-wide checkpoint was stop-and-copy, with disk writes completing before execution resumed — which the EROS authors call "unsuitable for interactive or real-time applications". Neither verified system state before writing a checkpoint, which the same authors note risks making a transient corruption permanent; Phantom runs a whole-heap verifier inside its barrier and verifies the snapshot after writing it.

- System: L3 / EUMEL, Fluke, Phantom (prior art + Phantom)
- Evidence: https://www.usenix.org/legacy/publications/library/proceedings/usenix02/full_papers/shapiro/shapiro.pdf §9; the L3 reference is J. Liedtke, "A persistent system in real use — experiences of the first 13 years", IWOOOS '93, pp. 2–11, DOI https://doi.org/10.1109/IWOOOS.1993.324932 (bibliographic record verified via Crossref; paper paywalled and not read); Phantom's verifiers in https://raw.githubusercontent.com/dzavalishin/phantomuserland/ccb6541f719fceff89a15d0c10b9efa5f5e39ad5/oldtree/kernel/phantom/vm_map.c
- Confidence: verified (the characterisation is the EROS authors'; the Liedtke citation is verified metadata only)
- Why it matters: two things, and the second is the more important. A snapshot that writes OPFS while
  every process sits parked in `Atomics.wait` **is** stop-and-copy, named by the EROS authors as the
  wrong choice for an interactive system — so the barrier design above is a decision to make
  deliberately and record. And a **validator must run at snapshot time, not only at mount time**: a
  persistent store that laundered a bug into permanence is the characteristic failure of this whole
  design class. Validate the table before serializing (orphan check, refcount check, inode↔blob
  correspondence), refuse to commit on failure, and keep the previous generation. The negative control
  writes a deliberately inconsistent table and asserts the commit is refused — which is also a
  stronger version of the fsck test M2 already owes, because it tests the *write* path rather than the
  read path.

### Phantom runs regular snapshots every 100 seconds by default (`seconds_between_snaps = 100`, with `request_snap()` to force one early), and EROS treats 600 seconds as a checkpoint interval while arguing the resulting loss window is "identical to that of conventional systems" because a conventional buffer cache has the same exposure.

- System: Phantom, EROS
- Evidence: https://raw.githubusercontent.com/dzavalishin/phantomuserland/ccb6541f719fceff89a15d0c10b9efa5f5e39ad5/oldtree/kernel/phantom/vm_map.c (`vm_map_snapshot_thread()`); https://www.usenix.org/legacy/publications/library/proceedings/usenix02/full_papers/shapiro/shapiro.pdf
- Confidence: verified
- Why it matters: the plan says the journal flushes "when idle" with no cadence, and 100 s is the
  published default of a real persistent OS. It also sets the honest expectation to show a user: a
  crash loses up to one interval of work, and that number should be stated in the UI rather than
  implied by the word "saved".

### A Smalltalk image is the whole object memory in one file, and Squeak's runs **bit-identical across its entire portability base**, with the VM a C translation of Smalltalk code and the image carrying the live system state.

- System: Smalltalk / Squeak (prior art)
- Evidence: Ingalls, Kaehler, Maloney, Wallace, Kay, "Back to the Future: The Story of Squeak, A Practical Smalltalk Written in Itself", OOPSLA '97, pp. 318–326; VPRI TR-1997-001, https://tinlizzie.org/VPRIPapers/tr1997001_backto.pdf
- Confidence: verified (pp. 1–4 read; no claim is made here about what a Squeak image does *not* capture, which those pages do not state)
- Why it matters: the image model is the cheap version of orthogonal persistence and it is the one
  this project can actually have, because the snapshot already *is* an image — an authoritative
  in-memory table serialized whole. The lesson to take is that an image is a **versioned,
  self-describing format**, not a memory dump, so a snapshot written by one build of the kernel can be
  read by the next. That converges with Phantom's `DISK_STRUCT_VERSION` and is the difference between
  shipping a kernel update and asking users to lose their filesystem.

### TempleOS buys its speed by having no boundary to cross: ring-0 only, a single identity-mapped address space shared by every task on every core, "No time lost changing modes or address maps", and task switches in half a microsecond.

- System: TempleOS
- Evidence: https://raw.githubusercontent.com/cia-foundation/TempleOS/c26482bb6ad3f80106d28504ec5db3c6a360732c/Doc/Features.DD; https://raw.githubusercontent.com/cia-foundation/TempleOS/c26482bb6ad3f80106d28504ec5db3c6a360732c/Doc/MemOverview.DD
- Confidence: verified
- Why it matters: this is the price tag for the thesis, and it should be in the design doc as a
  number. A 14–16 µs syscall is roughly 30× TempleOS's entire task switch. The engineering
  consequence is that **syscalls per user-visible action matters far more than cost per syscall**, so
  the 68-call ABI should be audited for chatty sequences — `stat` then `open` then `read` then
  `close` to display one file — that a batched call collapses. Constraint 22 already does this for
  `open` on measurement grounds; the same logic has not been applied to the rest.

### A TempleOS document is a live view of program memory: `DocForm()` walks a class's member list, emits a DolDoc entry for every member carrying a `"format"` metadata string, binds each entry's `data` pointer to `_d + ml->offset`, renders the value with `DocDataFmt()` and parses edits back through the same pointer with `DocDataScan()` switching on the member's `raw_type`.

- System: TempleOS
- Evidence: https://raw.githubusercontent.com/cia-foundation/TempleOS/c26482bb6ad3f80106d28504ec5db3c6a360732c/Adam/DolDoc/DocForm.HC; entry grammar at https://raw.githubusercontent.com/cia-foundation/TempleOS/c26482bb6ad3f80106d28504ec5db3c6a360732c/Doc/DolDocOverview.DD
- Confidence: verified
- Why it matters: one declaration producing both the renderer and the parser is exactly
  `CLAUDE.md`'s "declared once and derived on the other side" rule for a value crossing a boundary —
  and it is the same idea as AROS's `.conf`, applied to data instead of to calls. What does not
  survive a boundary is the raw `_d + offset` binding; the portable equivalent is a declared field
  descriptor (offset, width, raw type, format string) that both sides generate from, with the
  transport carrying values. Directly applicable to the SAB argument region and to `Filestat`, which
  is currently a hand-written 64-byte layout on both sides.

### A TempleOS document entry is executable: activating a macro dispatches through `DocEntryRun`, which feeds the macro text into the task's own input stream, where the command line — which *is* the compiler — compiles and runs it.

- System: TempleOS
- Evidence: https://raw.githubusercontent.com/cia-foundation/TempleOS/c26482bb6ad3f80106d28504ec5db3c6a360732c/Adam/DolDoc/DocRun.HC; input-stream semantics at https://raw.githubusercontent.com/cia-foundation/TempleOS/c26482bb6ad3f80106d28504ec5db3c6a360732c/Doc/InFile.DD
- Confidence: verified (the `In`/`InStr` → compile path is documented behaviour; `In`'s implementation was not read)
- Why it matters: "any document can contain text the shell will compile and run in the current task"
  is the single-realm trust model stated as a feature, by a system that chose it deliberately. The
  predecessor arrived at the same place by accident (38). Recording it here is the point: a clickable
  live document is what the boundary costs, and the trade should be written down as intentional rather
  than rediscovered as a limitation.

### TempleOS makes the whole kernel callable by name at runtime with no linker and no object files: symbol lookup walks the current task's hash symbol table and then its parents', all offspring tasks inherit their parent's symbols, and JIT'd assembly references kernel globals directly with no `IMPORT`.

- System: TempleOS
- Evidence: https://raw.githubusercontent.com/cia-foundation/TempleOS/c26482bb6ad3f80106d28504ec5db3c6a360732c/Doc/ScopingLinkage.DD; https://raw.githubusercontent.com/cia-foundation/TempleOS/c26482bb6ad3f80106d28504ec5db3c6a360732c/Doc/Features.DD
- Confidence: verified
- Why it matters: late binding to the *kernel* is exactly what this project should give up. But
  "symbol table inherited by children" is a near-exact description of an environment, and it works
  across a boundary: a per-process name table, inherited at `spawn`, resolved by the kernel on
  request. The ABI has `env_get`/`env_set` as flat bytes; if a usable shell or any `dlopen`-shaped
  extensibility is wanted, that is the shape it takes, and it costs one syscall rather than a shared
  realm.

### TempleOS cannot actually kill a task: `Kill()` only sets a `TASKf_KILL_TASK` flag and spins yielding, refuses outright for the window manager and the per-core Seth tasks, must kill all child tasks first, and then defers freeing the task's heaps onto a dying queue for `DYING_JIFFIES` because of "lingering ptr to reincarnated" tasks.

- System: TempleOS
- Evidence: https://raw.githubusercontent.com/cia-foundation/TempleOS/c26482bb6ad3f80106d28504ec5db3c6a360732c/Kernel/KTask.HC (`Kill`, `TaskEnd`, `TaskKillDying`, `TaskDel`, with the comments "//Delay freeing to prevent asking for trouble with quick reincarnations." and "//We delay freeing in case lingering ptr to reincarnated.")
- Confidence: verified
- Why it matters: the concrete bill for zero isolation, and the one capability this project gets for
  free. `Worker.terminate()` is unilateral, so `kill` should mean kill and must not be softened into a
  cooperative flag for convenience. Two details are worth noting as independent confirmation rather
  than as new ideas: TempleOS's **dying queue held for `DYING_JIFFIES` against pid reuse** is
  constraint 14's ~2 s quarantine, arrived at from the opposite direction and for the same reason; and
  "children die before parents, resources are owned by the task" is why resource ownership must be
  tracked per process (15) or `kill` leaks — which SymbOS's header manifest says from the third
  direction.

### Could not be determined (AROS / Phantom / TempleOS)

- **No published measurement of Phantom's snapshot cost or restart time.** The Developer's Guide
  offers only "amount of disk IO in persistent OS depends on amount of modified memory"; the only
  hard numbers in the tree are configuration constants (100 s interval, 32-page free reserve, three
  superblock copies). Verified as a negative result after reading the guide, the wiki index and the
  snapshot/pager sources; Russian-language conference material was not searched. **So the number this
  project needs does not exist anywhere and must be measured here** — the barrier, the serialize and
  the OPFS commit timed separately, against a deliberately varied dirty count. The only quantified
  checkpoint costs in scope are EROS's 11.42 ms to write 400 KB and 137.89 ms including migration,
  which that paper explicitly labels "computed, rather than measured results".
- **`aros.org` serves a mismatched TLS certificate**, so the official AROS status page and FAQ were
  unreachable; the "82% of AmigaOS 3.1 components" figure comes from
  https://en.wikipedia.org/wiki/AROS_Research_Operating_System (orientation only) and could not be
  verified, nor could a definitive ABI v1 completion date.
- **`web.archive.org` was blocked from the tool used for this section**, and `cap-lore.com` (the
  KeyKOS papers) has a broken certificate chain, so Landau 1992 is cited by DOI only and not read.
- Phantom's GitHub wiki pages are **mutable and unpinnable**; each is dated at the point of use.
  `phantomdox.readthedocs.io/en/latest/` has no versioned build, which breaks the pinned-citation
  preference and could not be worked around.
- Multics is the ancestor of the whole single-level-store family (Bensoussan, Clingen, Daley, "The
  Multics virtual memory: concepts and design", CACM 15(5):308–318, 1972, DOI
  https://doi.org/10.1145/355602.361306 — bibliographic record verified, paper not read). Recorded
  only so that the persistence design is understood as sitting in a fifty-year-old lineage rather
  than being novel.

---

## 5. The solo-developer desktops: BeOS/Haiku, AtheOS, Syllable, SkyOS

The closest comparison class this project has. AtheOS was a desktop operating system written by one
person; Syllable was the community that tried to continue it; SkyOS ran twelve years on a paid beta
and stopped; Haiku is the one that survived, and is the architecture AtheOS and Syllable are both
copies of. Two questions: what is the window-server architecture, and what actually killed each
project.

Haiku source citations are pinned at `a8694efb7c64c84072a83d405531bed559680bb8` (repository HEAD,
2026-11-11). Dead sites are cited as Wayback snapshots with the timestamp in the URL.

### Haiku's app_server repaints a newly exposed window region itself, from a background colour and a cached view bitmap, "without waiting for a roundtrip to the window's Draw() methods" — and keeps **two alternating `UpdateSession` objects per window** so damage arriving during an in-flight client repaint is neither lost nor merged into the current one.

- System: Haiku (BeOS lineage)
- Evidence: https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/servers/app/Window.h#L357-L425 (`fExposeRegion` comment; `UpdateSession fUpdateSessions[2]; UpdateSession* fCurrentUpdateSession; UpdateSession* fPendingUpdateSession;`)
- Confidence: verified
- Why it matters: the largest single addition to the window half, and it is a correctness item rather
  than polish. The compositor must hold enough per-window state to repaint an exposed region with no
  client involvement — otherwise dragging one window across another leaves garbage trails for a
  round trip, and with no preemption (21) that round trip can be unbounded. The two-session rule is
  the subtler half: one damage set is not enough, because the app is slow by assumption. Neither
  appears in M7–M12.

### A Haiku client's drawing is a **stateful command stream**: `BView` latches a server-side "current view" via `AS_SET_CURRENT_VIEW` and caches the token client-side, so the following primitives carry no target — and the commands are batched into a 2048-byte buffer, auto-flushed past a 2024-byte watermark, hard-capped at 65536 bytes, with any payload at or above 65536 copied into a shared `area` so only the `area_id` travels.

- System: Haiku / BeOS
- Evidence: https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/kits/interface/View.cpp (`_SwitchServerCurrentView`, called from `_CheckLockAndSwitchCurrent` before ~40 drawing calls); https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/kits/app/link_message.h (`kInitialBufferSize = 2048`, `kMaxBufferSize = 65536`, "anything beyond that should be sent with a different mechanism"); https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/kits/app/LinkSender.cpp (`kWatermark`, `create_area` + `_kern_transfer_area` for oversize)
- Confidence: verified
- Why it matters: the batching answers the BOOPSI warning from §4 — a round trip per widget method is
  unaffordable at 14–16 µs, and the answer is an explicit small-command batch plus a separate
  large-payload path, which is what the ABI's `MAX_INLINE` and `shm_create` already are. The
  current-target latch is the trap: it halves the bytes and makes the stream **order-dependent and
  non-replayable**, which collides with the frame-corpus idea below. Either every frame carries its
  window id, or the latch is a recorded protocol event the harness can re-establish — and that is a
  day-one decision about the channel, not a window-milestone decision.

### Haiku added eight methods to `BView` — `DrawAfterChildren`, `MinSize`, `MaxSize`, `PreferredSize`, `LayoutAlignment`, `HasHeightForWidth`, `GetHeightForWidth`, `SetLayout` — **without changing the BeOS R5 vtable**, by filling R5's reserved slots with shims that dispatch through a single generic `Perform(code, data)`.

- System: Haiku (reimplementing BeOS R5)
- Evidence: https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/kits/interface/View.cpp (the `#if __GNUC__ == 2` block: `_ReservedView1__5BView` → `DrawAfterChildren`, `_ReservedView2__5BView` → `PERFORM_CODE_MIN_SIZE`, …)
- Confidence: verified
- Why it matters: the same conclusion AROS's `.skip N` reaches, from an independent lineage, and
  stronger because it names the second half: **reserved slots plus one generic opaque call.**
  Reserved syscall numbers and a `perform(opcode, struct)` escape hatch cost nothing in the spine and
  are the difference between "the taskbar needs a new call" being a one-line addition and being an
  ABI break. Without them, `CLAUDE.md`'s claim that the shell is a client of the same ABI as any app
  becomes false the first time the shell needs something new.

### Haiku's IPC frame format is self-describing and versioned by a 4-byte magic, with four dialects read by one dispatcher — R5 `'FOB1'`, Dano `'FOB2'`, Haiku `'1FMH'`, each with a byte-swapped twin — and reply routing lives in the message header (`reply_port`, `reply_target`, `reply_team`, plus `MESSAGE_FLAG_REPLY_REQUIRED` / `IS_REPLY` / `PASS_BY_AREA`), so a reply can be delivered asynchronously to a different handler than the caller.

- System: Haiku / BeOS
- Evidence: https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/headers/private/app/MessageAdapter.h; dispatch at https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/kits/app/Message.cpp#L2410; header struct at https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/headers/private/app/MessagePrivate.h
- Confidence: verified
- Why it matters: two things, both cheap on day one and impossible later. A **format magic plus
  version word** in the SAB frame header costs four bytes and converges with Phantom's
  `DISK_STRUCT_VERSION` and Squeak's versioned image — and the harness is a second consumer of that
  frame format that will outlive its first version. And **reply address in the header** is what makes
  blocking-with-reply and fire-and-forget the same primitive with a flag rather than two protocols,
  which is the generalisation of Redox's tag finding and the thing that would let a window event be
  delivered without consuming the process's one outstanding call.

### Synchronous send to your own loop thread is a documented, unrecoverable deadlock in the public BeOS API — "If you call `SendMessage()` from the target looper's thread, you'll deadlock (or, at best, time out)" — and Haiku bypasses the port entirely for same-team messages, enqueuing directly into the target's `BMessageQueue`, explicitly to dodge the bounded-queue deadlock.

- System: BeOS / Haiku
- Evidence: https://www.haiku-os.org/legacy-docs/bebook/BMessenger.html; `BPrivate::BDirectMessageTarget` at https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/kits/app/Message.cpp#L2142-L2152 ("This will also prevent possible deadlocks when the queue is full")
- Confidence: verified / from docs
- Why it matters: two concrete requirements. A **fail-fast guard with a named errno** for a
  synchronous call that would wait on the caller's own loop — in this system that is the window
  manager, which is userland and is reached through the kernel, so a WM handler that blocks on a
  syscall the kernel must ask the WM to service is a hang. A hang in a browser-hosted OS is worse
  than a crash: the only recourse is killing the tab, which takes every window with it. And **every
  bounded queue needs a defined full-behaviour** — error, grow, or drop, never block — which is the
  same hole constraint 9 names for the argument buffer and §2 names for the event backlog.

### BeOS and Haiku run **one thread per window on both sides**: the client `BWindow` is a `BLooper` that spawns its own thread, and app_server creates one `ServerWindow` per `BWindow` with its own port of capacity 100 and its own thread named `w:<team>:<title>`.

- System: Haiku / BeOS
- Evidence: `BLooper::Run()` spawning at https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/kits/app/Looper.cpp; `ServerWindow::Init()` with `create_port(100, fTitle)` and the comment "There is one ServerWindow per BWindow" at https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/servers/app/ServerWindow.cpp; BeBook at https://www.haiku-os.org/legacy-docs/bebook/TheInterfaceKit_Overview_Introduction.html
- Confidence: verified
- Why it matters: the BeOS price is 2N message loops for N windows, and this project cannot pay it —
  a browser will not give you 200 Workers (17), and a process is single-threaded by construction
  (§2). So the compositor side must be **one loop with per-window queues**, which is a genuinely
  different protocol shape from BeOS's, and the difference is worth stating where M7 is written. This
  is also where AtheOS's own scheduler costs landed: its author documented that every window gets a
  thread, against "a plain round-robin RT scheduler… one high-priority thread can block all
  lower-priority thread's forever" and no CPU affinity
  (https://web.archive.org/web/20020324053752/http://atheos.cx/threads.php3, archived 2002-03-24).

### The BWindow/BView split separates "surface, identity and input target" from "drawing cursor, coordinate space and clip": a window "can retain and display rendered images, but it can't draw them", a view "is an agent for drawing, but it can't render the images it creates", each view has a server-side shadow with a client-cached graphics state, and an **unattached view cannot draw at all** — some state calls on one "will crash the application".

- System: BeOS / Haiku
- Evidence: https://www.haiku-os.org/legacy-docs/bebook/TheInterfaceKit_Overview_Introduction.html; https://www.haiku-os.org/legacy-docs/bebook/TheInterfaceKit_Drawing.html; https://www.haiku-os.org/legacy-docs/bebook/BView.html
- Confidence: from docs
- Why it matters: refines D8 rather than contradicting it. Make the **window** the fd-shaped
  capability — surface, modality, focus, clipboard and drag target — and make the drawing object a
  second, cheap, syscall-free client-side thing bound to it. Otherwise every nested widget costs a
  window fd, and a file dialog with twenty controls costs twenty fds against a per-process table.
  The attachment rule is the capability discipline the project already states: a draw handle is
  useless until bound to a granted surface, and the failure is loud.

### The damage contract runs server-first: app_server sends the window an update message, the window calls `Draw()` per out-of-date view, the clip is narrowed to the invalid area, and **the server erases it to the view colour before `Draw()` runs**; `UpdateIfNeeded()` "only works from within the BWindow's message loop thread".

- System: BeOS / Haiku
- Evidence: https://www.haiku-os.org/legacy-docs/bebook/TheInterfaceKit_Drawing.html
- Confidence: from docs
- Why it matters: server-erases-first is why BeOS apps never needed a full-surface repaint, and it
  composes with the exposed-region finding above into a complete answer for M8. The reentrancy rule
  is the other half: a synchronous "paint now" primitive must be legal only on the owning loop, or it
  becomes a cross-window hazard — and here that means it must be legal only for the process owning
  the window fd, checked in the kernel.

### Haiku's bitmap pixel memory is allocated by the **server** out of server-managed shared chunks and then mapped to the client — `CreateBitmap` carves a block from an `area`-backed chunk — with `CloneFromClient(area_id, …)` for the reverse direction. SerenityOS does the opposite: the **client** allocates both backing stores and hands the fd over.

- System: Haiku (contrasted with SerenityOS §1)
- Evidence: https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/servers/app/BitmapManager.cpp; allocator at https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/servers/app/ClientMemoryAllocator.h
- Confidence: verified
- Why it matters: a real fork in the design space, and the two mature systems chose opposite sides —
  so this is a decision to make on this project's own terms rather than by precedent. Server-allocated
  gives **accounting and revocation**: the compositor knows the total surface bytes, can refuse the
  next window, and can revoke an app's surfaces because it owns them. That is precisely what
  constraint 49's admission controller and constraint 17's process cap both need, and what the
  SymbOS window cap provides in the small. Client-allocated gives simpler lifetimes and no
  server-side allocator. Given that this project has two budgets over the same pixels (blurred area
  and renderer memory) and no mechanism for either, server-allocated looks right — and it is the
  opposite of what a transferred `OffscreenCanvas` does today.

### Haiku's app_server still carries **six unresolved lock-order inversions** between the Desktop window lock and the input dispatcher twenty-five years in, each worked around by dropping the read lock mid-handler — and its window list is an explicit readers/writer problem with a named discipline ("The window lock must be held when accessing a window list!") plus four further locks.

- System: Haiku
- Evidence: https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/servers/app/ServerWindow.cpp (lines 561, 1268–1271 with the TODO naming the deadlock, 1332, 1353, 2318, 2350, each bracketed by `UnlockSingleWindow()` / `LockSingleWindow()`); locks at https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/servers/app/Desktop.h
- Confidence: verified
- Why it matters: the ordering between **window-manager state and input dispatch** must be written
  down before either is written, because Haiku is the proof that it does not get fixed later. In a JS
  runtime there are no mutexes but the bug is identical in `await` ordering: an input handler that
  awaits WM state while the WM awaits input routing deadlocks the same way. The z-order half is a
  harness item — no window may be drawn against a stale z-order snapshot, which the geometry harness
  can assert directly.

### Haiku enforces its "lock the window before touching its views" invariant by **crashing**: `BLooper::check_lock()` calls `debugger("Looper must be locked.")`, and almost every `BView` mutator calls `_CheckLock()` first.

- System: Haiku / BeOS
- Evidence: https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/kits/app/Looper.cpp; https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/kits/interface/View.cpp
- Confidence: verified
- Why it matters: the same policy SerenityOS applies to protocol violations (`did_misbehave`) and
  Phantom to illegal persistent-memory access (panic), reached by three systems independently. The
  transferable rule for this project: make each window-ownership and resource-ownership invariant a
  **hard abort in dev builds**, not a comment, and owe each one a `--prove-failure` control that
  violates it and proves the abort fires. The BeOS experience is that a soft rule here is simply not
  obeyed.

### Haiku's demonstrated binary-compatibility mechanism is a format-adapter layer with a standalone reader per historical wire format, exercised by a tiny CLI test that unflattens **real captured messages** checked into the tree.

- System: Haiku
- Evidence: https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/src/tests/kits/app/DanoMessageTest.cpp (checks the magic is `'FOB2'`/`'2BOF'`, calls `BPrivate::unflatten_dano_message()`); adapter entry points in https://github.com/haiku/haiku/blob/a8694efb7c64c84072a83d405531bed559680bb8/headers/private/app/MessageAdapter.h
- Confidence: verified
- Why it matters: the cheapest guard available against a silent frame-format change, and it inverts
  cleanly under `--prove-failure` (corrupt the magic, demand a failure). Capture a corpus of real
  syscall frames from the shell and the ten programs of M5, check it in, and have the suite replay
  it. Note the interaction with the current-view latch above: a corpus is only replayable if the
  frames are self-contained.

### Haiku states its compatibility position per target and pays a permanent wart for it — the 32-bit build "is binary-compatible with BeOS R5", the 64-bit images "are incapable of running BeOS (GCC2) applications", and `time_t` was deliberately left 32-bit on x86 "to preserve BeOS binary compatibility" — and publishes its deliberate breaks as a list (file-system API changed so "file systems that worked on BeOS will no longer work on Haiku"; the debugging interface "source and binary incompatible"; compatibility with PR2/R3/R4 dropped).

- System: Haiku
- Evidence: https://www.haiku-os.org/about/faq/; https://www.haiku-os.org/get-haiku/r1beta1/release-notes/; https://www.haiku-os.org/docs/api/compatibility.html
- Confidence: from docs
- Why it matters: **in this family the exceptions list, not the compatibility list, is the schedule.**
  Keep a "deliberate incompatibilities" document from day one, naming per feature what is
  reimplemented, approximated or dropped — which is the same instrument AROS's status register and
  EmuTOS's `status.txt` provide, now demanded by three systems. The specific open item here is the
  predecessor: D1 settles that the 42 apps are not ported, but nothing says whether a webxp
  *filesystem image* imports, and half-kept compatibility is what costs (KolibriOS waited two years
  and then broke Menuet32 binaries outright, "but we lost little, since Menuet32 is practically not
  developed" — https://wiki.kolibrios.org/index.php?title=History_system/ru&action=raw).

### AtheOS reached a self-hosting desktop OS — own SMP kernel, own 64-bit journalled filesystem, own appserver, a KHTML browser, Apache/PHP/perl serving its own website — in about five years, by one person working in secret ("Since the very beginning I have been working on AtheOS on my own, not telling anybody"); after those five years it had **no CD-ROM support at all**, no IDE driver (disk went through the BIOS), no PPP, swap disabled, no `mmap()`, and desktop icons "hardcoded into the sources".

- System: AtheOS
- Evidence: start date and rename at https://www.osnews.com/story/322/introduction-review-of-atheos-037/; the quote at https://www.osnews.com/story/66/interview-with-the-atheos-creator-kurt-skauen/; feature list and FAQ at https://web.archive.org/web/20020324053752/http://atheos.cx/features.php3 and https://web.archive.org/web/20020324053752/http://atheos.cx/faq.php3 (archived 2002-03-24); last release 0.3.7 on 2001-10-09 at https://web.archive.org/web/20031001173038/http://www.atheos.cx/news.php3 (archived)
- Confidence: verified
- Why it matters: the calibration for a 70-working-day plan, and it is favourable but only for a
  stated reason. Five solo years bought a desktop OS still missing CD-ROM support — so 70 days is
  credible **only** because the browser supplies the hardware, the scheduler, the network stack, the
  renderer and the font engine. `PLAN.md` should say that explicitly: the 70 days buy the
  *abstractions*, not the substrate, and any milestone that reaches below the browser is out of scope
  by construction. The second half is a direct endorsement of the spine-first order: in the solo-OS
  record what gets starved is the **userland surface**, not the window manager.

### SkyOS's author named his cause in one sentence after twelve years, and it was platform-surface breadth: "Catching up with the development for all this is just not possible anymore, at least, not for one person or at least, not for me" — formerly "you developed a standard IDE driver and SkyOS would boot on 99% of all computers… there was just a single CPU", now "You must have WIFI, USB, Bluetooth, etc."

- System: SkyOS, Robert Szeleney, 2009-01-30
- Evidence: https://web.archive.org/web/20110910053108/http://www.skyos.org/?q=node/647 (archived 2011-09-10)
- Confidence: verified (author's own words, archived)
- Why it matters: this project's analogue of "drivers" is **browser-surface breadth** — OPFS
  semantics, the clipboard and drag-and-drop APIs, `backdrop-filter` performance across GPUs,
  `Atomics.wait` behaviour, and every Chrome release. That is the budget line that killed SkyOS, and
  this project has already met it four times in `PLAN.md` §10 (Safari's seven-day storage deletion,
  blur budget on other hardware, OPFS durability, `showDirectoryPicker` absence). The actionable form:
  pin the browser surface explicitly — a list of the APIs and the version the spine depends on — so
  the drift is visible as a diff rather than as a bug report.

### Syllable's toolchain ceiling was set by one missing syscall: it was stuck below GCC 4.1 until `mmap`/`mprotect`/`msync`/`munmap` landed in 0.6.7 (2012), and even then `MAP_PRIVATE` was unsupported and `mmap()` worked only on "normal" files — with the stated problem that "many modern open source programs require advanced features of the host platform, that are only available on the major systems".

- System: Syllable Desktop
- Evidence: https://web.archive.org/web/20220329003132/https://syllable.metaproject.frl/Desktop/Changes.html (archived 2022-03-29)
- Confidence: verified
- Why it matters: the syscall surface chosen in the spine decides permanently what software the
  system can ever host, **including its own toolchain** — and it converges with HelenOS's `mmap`
  warning from §2 onto the same call. The question to answer is not "do the ten programs of M5 work"
  but "what does the eleventh program need that the spine cannot express". One explicit day
  enumerating what each absent call forecloses — `mmap`, `*at`, `fork`, `ptrace`, `select` on a
  non-fd — is worth more than the same day spent on the eleventh program.

### Syllable's final release shipped from a stale branch with no source package, because the project lost its release engineering before it lost its code: "Along the way, we lost our release engineer and build infrastructure… It is not based on the latest source code in CVS, but on the previous development build… no separate source package is available for this release" — and its first act as a community project had been to make AtheOS buildable at all, because "building AtheOS from its source code wasn't reproducible, because it was set up as a one-man project".

- System: Syllable (and AtheOS)
- Evidence: https://web.archive.org/web/20220329003132/https://syllable.metaproject.frl/Desktop/Changes.html (archived); Kaj de Vos interview, TechWorld Australia, 2011-08-30, https://web.archive.org/web/20111123023529/http://www.techworld.com.au/article/398892/developer_q_syllable_os/ (archived)
- Confidence: verified
- Why it matters: the failure the harness discipline exists to prevent, happening to a real project
  at the end of its life — the thing shipped was not the thing in the repository and nobody could
  rebuild it. Two checks follow, both cheap. The harness must **refuse to run against anything but
  the live tree**, and must fail rather than warn if it cannot confirm what it loaded ("no build
  step" helps only if that is proven). And one check should prove a **clean checkout boots with no
  local state** — which is the thing AtheOS did not have, and is nearly free here because there is
  nothing to build. The same check covers the hosting-loss case: skyos.org vanished in 2013
  (https://www.osnews.com/story/26868/skyos-website-finally-fizzles-out/) and Syllable's site returns
  HTTP 522 today, so "servable from a bare directory" is a property worth asserting.

### AtheOS's author gave his reasons in writing, and the dominant ones were not technical: tiredness, a theory course, flying lessons, a plane that needed work, and a dead PC — with a fork of his work named as what "lost all motivation" for him, five months into an existing silence.

- System: AtheOS, Kurt Skauen, 2002-08-02
- Evidence: https://web.archive.org/web/20031001173038/http://www.atheos.cx/news.php3 (archived 2003-10-01, full text); the fork he refers to is Bill Hayden's, reported 2002-03-26 at https://www.osnews.com/story/852/atheos-fork-breathes-life-to-beos/
- Confidence: verified for the quotes; the causal weight is his own statement, and the ordering matters — the silence began in October 2001, so the fork converted an existing pause into a permanent exit rather than causing it
- Why it matters: a solo author's motivation is a load-bearing component with no redundancy, and it
  fails on inputs that have nothing to do with the code. Two implications for a 70-day plan, and both
  are already partly satisfied: the plan must be **robust to a multi-week gap**, which means the
  decision log, the milestone state and the open questions live in files rather than in the author's
  head (`MILESTONES.md`, `DECISIONS.md` and `PLAN.md` §10 are exactly this, and this is the evidence
  for why they are worth their maintenance cost); and the day-22 visible window is well-motivated and
  should not be deferred.

### A visible-progress cadence does **not** predict survival in this family. SkyOS had by far the most visible cadence — numbered builds to 6947, a paying beta from 2003, compositing demos in 2006 — and stopped in 2009. Haiku went **five years and eleven months with no release at all** ("It's been just about a month less than six years since Haiku's last release in November 2012") and is still shipping.

- Systems: SkyOS, AtheOS, Syllable, Haiku
- Evidence: SkyOS halt at https://web.archive.org/web/20110910053108/http://www.skyos.org/?q=node/647 (archived); AtheOS releases at https://web.archive.org/web/20031001173038/http://www.atheos.cx/news.php3 (archived); Syllable 0.4.0–0.6.7 at https://web.archive.org/web/20220329003132/https://syllable.metaproject.frl/Desktop/Changes.html (archived); Haiku's own gap at https://www.haiku-os.org/get-haiku/r1beta1/release-notes/; Haiku, Inc. holding infrastructure and funds "since 2003" at https://www.haiku-inc.org/
- Confidence: **inferred** — this is a reading of the dated release record of four projects, n=4, differing on many axes at once (open vs closed source, one vs many maintainers, with vs without a legal entity). No source was found that tests the cadence hypothesis.
- Why it matters: **D16's stated rationale is not supported by the evidence** — "30 days with nothing
  visible is how solo projects die" is the story people tell afterwards, and the one project in this
  set with the best visible cadence died while the one with a six-year silence lived. The *decision*
  is fine and should not change: M4a is two days, it deletes its own special case, and it is cheap.
  Only the justification needs rewording, onto the better-evidenced ground above — the author's
  motivation is the unredundant component, and M4a is a promise to the author rather than to an
  audience. Recording this is also the point: a plausible claim that nobody checked is exactly what
  `docs/DECISIONS.md` §Corrections exists to catch, and this is one, found in the literature rather
  than in the arithmetic.

### AtheOS's appserver wire protocol was deliberately private — "the server/client lowlevel protocol is not known by applications, but are handled entirely by the GUI toolkit's C++ classes" — and Syllable loaded its video drivers as C++ plugin classes **into** the appserver, with the `DisplayDriver` base class supplying software rendering so a minimal driver implements only detection and mode-setting.

- System: AtheOS / Syllable Desktop
- Evidence: https://web.archive.org/web/20020324053752/http://atheos.cx/gui.php3 (archived 2002-03-24); https://web.archive.org/web/20220707172848/https://syllable.metaproject.frl/documentation/API/drivers/appserver_video_drivers.html (archived 2022-07-07)
- Confidence: verified
- Why it matters: the private protocol is the trap — nobody could write an alternative toolkit, and
  when the author stopped, the appserver was the least approachable part of the system. If the window
  protocol here is private to its own toolkit, "the WM is a userland client of the same ABI as any
  app" is true only for its author; publishing it, even only to the harness, is what makes the claim
  testable. The driver finding is the good half: **an always-present software fallback behind one
  interface**, with acceleration as an override rather than a fork — which is exactly the shape the
  blur governor's degrade path should take, and the shape constraint 33 needs for optional mount
  drivers. The warning is blast radius: anything loaded into the compositor realm takes the whole GUI
  down with it, so M6 must say which code is allowed inside and prove the rest is outside.

### Syllable deliberately stopped publishing roadmaps, on the stated grounds that the lists cost work and produced none: "Several times over the years we have made detailed lists… None of those tasks got done, so making the lists was just an extra load on us, keeping us from spending time on doing actual work."

- System: Syllable Desktop
- Evidence: Kaj de Vos, TechWorld Australia, 2011-08-30, https://web.archive.org/web/20111123023529/http://www.techworld.com.au/article/398892/developer_q_syllable_os/ (archived)
- Confidence: verified
- Why it matters: his reasoning is specific to volunteer coordination — the lists did nothing because
  nobody was assigned — and for a single developer the list *is* the assignment, so `MILESTONES.md`
  is not the thing he is warning about. The part that does transfer is the distinction between a
  working artifact and a published one: this repository now carries several thousand lines of
  documentation whose audience is partly external, and maintaining that for readers is unpaid
  overhead taken from the 70 days. Worth deciding which documents are load-bearing (`CONSTRAINTS`,
  `ABI`, `MILESTONES`, `DECISIONS`) and which are presentation.

### Could not be determined (solo-developer desktops)

- **No Syllable farewell exists.** Last release 0.6.7 on 2012-04-12, last development build dated
  2012-02-14; the About page, the news archive and the changelog were read and none announces a stop.
  Treat "why Syllable stopped" as unstated by its maintainers; the 0.6.7 changelog above is the
  closest thing to a cause.
- **No lines-of-code figure for AtheOS or SkyOS** from any source read; the only AtheOS size figures
  are install sizes (22 MB base, ~20 MB more for the C/C++ tools) from the 2001 OSNews review.
- **No Haiku document describing a systematic BeOS-R5 binary-compatibility test suite.** The
  mechanisms were found (gcc2 hybrid builds, reserved-vtable shims, `MessageAdapter`,
  `DanoMessageTest`) and the published incompatibility list, but not a document stating how they
  verify that R5 applications still run.
- **One attribution deliberately not used.** A comment in the 2001 OSNews interview thread,
  attributed to Kurt Skauen, reportedly says the AtheOS appserver first ran single-threaded and that
  rewriting it to one-thread-per-window noticeably improved responsiveness. That would be the single
  most relevant data point in this section — a solo author's own before/after on exactly this
  question — but the commenter's identity was not confirmed. **Do not cite it without checking
  https://www.osnews.com/story/66/interview-with-the-atheos-creator-kurt-skauen/ directly.**
- **The MenuetOS/KolibriOS fork narrative is one-sided**: it comes from the KolibriOS history page.
  No statement from Ville Turjanmaa was found. The Menuet64 licence text
  (http://www.menuetos.net/m64l.txt — "Redistribution, reverse engineering, disassembly or
  decompilation prohibited without permission") is primary and uncontested. The transferable item is
  narrow and governance-shaped: in this family forks are triggered by a **stalled release pipeline**,
  not by technical disagreement, so the ability to cut a release must be a script in the repository
  rather than knowledge in the author's head.
- **`web.archive.org` is blocked for the WebFetch tool** in the harness used for this section; all
  Wayback pages were retrieved with `curl` and every archive URL carries its snapshot timestamp.
