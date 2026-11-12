# GAP 7 — is `fork` possible in a browser?

Raised because `CONSTRAINTS.md` constraint 20 asserted "there is no fork" and attributed the
reason to Browsix concluding fork is *fundamentally* incompatible with a blocking syscall
channel. The user asked for that to be re-examined from primary sources rather than accepted.

**It was wrong as stated.** Two agents independently got fork *working* in Chrome: one ran
`sharrattj/dash` performing command substitution and a subshell through real `__wasi_proc_fork`
under `@wasmer/sdk`, and one built it from scratch with `wasm-opt --asyncify` end-to-end across a
Worker boundary through the `Atomics.wait` syscall channel. The conclusion survives for different
and better reasons — see `../CONSTRAINTS.md` constraint 20 as rewritten, and `../DECISIONS.md` D5.

Four angles, 16 agents, 2 soft claims refuted on verification.

---

## ANGLE 1 — what Browsix actually did about fork, and what it actually concluded (source + paper + measurement)

### Verdict

Constraint 20's conclusion is right but its stated reason is wrong, and the plan asserts the wrong one of your three options. Browsix never concluded (a) "fork is fundamentally incompatible with blocking syscalls"; it concluded (c) "we had no way to spill and reload a call stack except Emterpreter, and Emterpreter is incompatible with the synchronous path". The paper's own §6 Discussion names the missing ingredient and says that with it, "SharedArrayBuffers would let BROWSIX support fork in Emscripten applications as a synchronous system call" — and that ingredient has shipped twice since (Emscripten Asyncify/fibers, 2019; WASIX proc_fork, shipping). Keep "no fork", but rewrite the justification: for v1 the real blocker is that a JS Worker's state cannot be serialized at all (Browsix §3.5, still true), and for Option B it is that the cost is a whole-heap memcpy — measured here at 16.6 ms for 64 MiB, ~1,000× your 14–16 µs syscall and one dropped frame.

### Detail

**1. How fork was implemented.** Confirmed by reading the file, and it is not in the Browsix repo — it is in the modified Emscripten that browsix.org links as the C/C++ runtime. `src/library_syscall.js` `__syscall2` wraps the call in `EmterpreterAsync.handle`, captures `{pc: HEAP32[EMTSTACKTOP>>2], stackSave: asm.stackSave(), emtStackTop: EMTSTACKTOP}`, and passes `HEAPU8.buffer` — the entire linear memory — to the kernel. The child resumes in `src/postamble.js` with `EmterpreterAsync.resumeFromFork(Runtime.process.forkArgs.pc, …)` returning 0. Kernel side (`kernel.ts:1871-1898`) shallow-clones the fd table, `ref()`s each file, and **transfers** the heap in the `init` message (`kernel.ts:2259-2262`, transfer list `heap ? [heap] : null`). So: whole-heap copy plus an interpreter PC. The claim in circulation is correct.

**2. The incompatibility is (c), not (a).** Two independent proofs. In code: the `_sync-syscalls` branch has both configurations side by side. `__syscall3` (read) on the sync path calls `SYSCALLS.browsix.syscall.sync(SYS_READ, …)` → `Atomics.store` / `postMessage` / `Atomics.wait` — your exact channel. `__syscall2` (fork) on that same path is `abort('fork not supported in sync Browsix')`, gated purely on `#if EMTERPRETIFY_ASYNC`. In the Browsix-Wasm-era branch it is `abort('TODO: fork not currently supported in sync Browsix')` and `abort('TODO: sync post-fork?')` — the authors wrote *TODO*, not *impossible*. In prose: §3.4 says "there is no way to re-wind or jump to a particular call stack in the child Web Worker", and §4.3 says async syscalls "require… the Emterpreter to save and restore the C stack… Synchronous system calls do not have this limitation." Then §6 Discussion, Stack Management, states the fix outright: a JS `setcontext`/`getcontext` equivalent plus SharedArrayBuffers "would let BROWSIX support fork… as a synchronous system call." The incompatibility was with *their 2016 toolchain*, not with blocking syscalls.

**3. Emterpreter, and whether Asyncify has the property.** Emterpreter was a bytecode interpreter for asm.js whose call stack lived in linear memory (`EMTSTACKTOP`), which is why a memory copy carried the stack. Removal: commit `b43474f5` (2020-05-18), listed in `ChangeLog.md` **under the 1.39.17 section (06/05/2020)** — not 1.39.18 as gap-02 states; `tools/emterpretify.py` is 200 at tag 1.39.16 and 404 at 1.39.17. Asyncify **does** have the property. Binaryen's pass doc: the asyncify stack "is a representation of the call frame, as a list of indexes of calls… also used to save locals", in linear memory, pointed to by `__asyncify_data`; five exported controls (`asyncify_start_rewind` etc.). Emscripten `_malloc`s that struct and embeds the stack "in the same memory region". So memory-copy + one integer pointer + `asyncify_start_rewind` + calling the bottom-of-stack export reproduces a suspended stack in a second instance. Two gotchas I found by reading: the rewind entry point is an **interned id** resolved through `Asyncify.callStackIdToName`, a JS map built lazily by `getCallStackId`, so the child must be handed the parent's map; and `__asyncify_state` / `__asyncify_data` / `__stack_pointer` are **wasm globals, outside linear memory**, so a memory copy alone is insufficient. WASIX independently confirms that second one: its `proc_fork` calls `capture_store_snapshot`, whose entire payload is "Values of all globals". Also note `emscripten/fiber.h` (2019) is literally the primitive §6 asked for — `emscripten_fiber_init_from_current_context` / `emscripten_fiber_swap`.

**4. Browsix-Wasm.** It dropped fork silently. The word "fork" appears **zero** times in arXiv:1901.09056, and the Browsix-Wasm-era Emscripten branch aborts on it. What broke was not fork specifically: §2 says heap-as-SAB was abandoned because "WebAssembly memory cannot be shared across WebWorkers and does not support the Atomic API", plus no on-demand heap growth and Chrome's ~2.2 GB per-context cap. **Both of the first two are now false, measured.** SPEC CPU is single-process, so nothing forced them back.

**5. What Browsix measured.** No per-syscall latency table exists. The paper has one Table (feature comparison) and Figure 9 (utility execution times, "roughly another 3×" over Node). The only fork-attributable published cost is §5.2 + §2.2 read together: pdflatex is ~100 ms native, "just under 3 seconds" in Browsix with sync syscalls, and "around 12 seconds" with async + Emterpreter — and the LaTeX workload *needs* async mode because GNU Make uses fork. Choosing fork cost a ~4× whole-program slowdown. Do not quote a per-fork number; there isn't one.

Harness, re-runnable: `/Users/chafyni/.claude/jobs/e856c39e/tmp/harness/{serve.py,mkwasm.py,run.py,run_grow.py}`, Chrome 157.0.8103.38 headless, COOP same-origin + COEP require-corp, `crossOriginIsolated` asserted true. Negative control (`run_neg.py`, same files served without the headers) reports `sabDefined: false` and refuses to produce results, so the positive run can fail.

### Blockers

- v1 (JS processes) genuinely cannot fork, and this is the part of constraint 20 that survives. Browsix arXiv:1611.07862 §3.5: 'Web Workers do not expose a cloning API, and JavaScript lacks the reflection primitives required to serialize a context's entire state into a snapshot.' Figure 3's caption is explicit: 'fork is only supported for C and C++ programs.' No amount of transport work changes this, so for v1 the answer is no at any price.
- The copy cost is a dropped frame. Measured in Chrome 157 (two shared WebAssembly.Memory instances of the same module, source dirtied one byte per 4 KiB page, Uint8Array.set): 16 MiB = 3.27 ms (4.79 GiB/s), 64 MiB = 16.58 ms (3.77 GiB/s), 256 MiB = 85.74 ms (2.92 GiB/s). Against your measured 14-16 us syscall, a 64 MiB fork is ~1,000 syscalls and exceeds a 16.7 ms frame. A shell that forks per command would be visibly janky.
- Asyncify instrumentation is build-wide, not fork-local. Emscripten documents 'usually not extreme, something like 50% or so' runtime overhead and output that 'can be much larger'; every function that may be on the stack under fork must be instrumented. You would pay it on every Option B process to serve the few that fork. ASYNCIFY_ONLY narrows it but the docs warn such manual lists 'are error-prone and can break an application if set incorrectly'.
- wasm globals are outside linear memory. __stack_pointer, __asyncify_state and __asyncify_data are globals (binaryen Asyncify.cpp L1772-1793), so copying linear memory does not copy them. WASIX handles this with capture_store_snapshot/restore_store_snapshot over 'Values of all globals'; a JS-hosted kernel can only do this if the module exports its globals, which a stock toolchain output does not guarantee.
- The Asyncify rewind entry point does not survive a fresh instance unaided. asyncify_data_s.rewind_id is an interned integer resolved through Asyncify.callStackIdToName, a plain JS object populated lazily by getCallStackId at first unwind (src/library_async.js L182-197, L263-270). A child worker starts with an empty map, so the parent's name<->id table must be shipped in the init message alongside memory.
- wasm32-wasip1 has no fork in the ABI at all, so adopting fork means leaving wasip1 for WASIX - one vendor's non-standard extension with no second implementation. That is a dependency decision, not a transport one, and it contradicts Option B's stated premise of running unmodified wasip1 binaries.
- Chrome's ~2.2 GB per-JS-context heap cap, cited in arXiv:1901.09056 §2, is the one 2019 objection I did not falsify. Browsix-Wasm's arithmetic still applies: fork doubles a process's resident memory at the instant of the call, so forking processes halve your concurrent-process ceiling.

### Could not determine

- Whether WASIX proc_fork actually works inside a browser tab. research/04-browser-linux-runtimes.md measured it under @wasmer/sdk on Node 20.19.0, not in Chrome, and I did not run it in a browser in this pass. Treat 'WASIX gives you fork in a tab' as unverified.
- Whether JSPI — the documented successor to Asyncify — retains the property fork needs. Asyncify works for fork precisely because the suspended stack is in linear memory; JSPI suspends into a host-side continuation, which I would expect to be opaque and non-copyable, but I did not read the JSPI spec text or test it. If that expectation holds, migrating to JSPI would close the fork door that Asyncify leaves open — which is worth knowing before Option B commits to a toolchain.
- Whether Asyncify's lazily-interned callStackIdToName map is deterministic across two instances of the same build. getCallStackId interns on first use, so it depends on execution order, not on the module; I read the code but did not construct the failing case.
- Which Emscripten ref the published Browsix-Wasm artifact used. browsix.org links bpowers/emscripten generically and there are at least five candidate browsix branches; I read browsix-incoming-3 (2018-12-24) as the closest by date and cannot pin it to the ATC'19 artifact.
- A discrepancy in research/gap-02.md I could not settle: the paper says the Browsix-Wasm auxiliary buffer is 64 MB, while the Emscripten branch's setting is `var BROWSIX_SHM_SIZE = 16777216` (16 MiB) at https://github.com/bpowers/emscripten/blob/c477d54b84aa90ef28b83a1907cae5ba1023d3d1/src/settings.js#L817 . Both are facts; the setting is configurable and I could not find the build that used 64 MB. Do not state 64 MB as the implemented default.
- Why Browsix stopped. Unchanged from the earlier pass: no maintainer statement, no archive notice, no deprecation note. The Emterpreter removal and the 2018 SharedArrayBuffer disablement remain circumstantial, and I did not establish a causal link.
- Chrome's current per-JS-context heap cap. arXiv:1901.09056 §2 cites ~2.2 GB for 2019 Chrome; I did not re-measure it in Chrome 157, so the concurrent-process arithmetic that follows from it is not verified for today.

### Claims

- [read-from-source] Browsix implemented fork by sending the process's entire linear memory plus an Emterpreter program counter to the kernel: __syscall2 captures {pc: HEAP32[EMTSTACKTOP>>2], stackSave: asm.stackSave(), emtStackTop: EMTSTACKTOP} and passes HEAPU8.buffer. The file is src/library_syscall.js in bpowers/emscripten branch _browsix, not in the Browsix repo itself.
  - https://github.com/bpowers/emscripten/blob/6aa4afc33283f6617636b7ab60fbde579739dd6a/src/library_syscall.js#L639-L655
- [read-from-source] The forked child resumes by calling EmterpreterAsync.resumeFromFork(Runtime.process.forkArgs.pc, ...) and returning 0, after asserting HEAP32.buffer === Runtime.process.parentBuffer and HEAP32[EMTSTACKTOP>>2] === forkArgs.pc.
  - https://github.com/bpowers/emscripten/blob/6aa4afc33283f6617636b7ab60fbde579739dd6a/src/postamble.js#L255-L265
- [read-from-source] Kernel-side fork shallow-clones the parent's fd table with ref() on each file, reuses the parent's blobUrl, and transfers the heap ArrayBuffer to the child in the 'init' message (transfer list `heap ? [heap] : null`).
  - https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/kernel/kernel.ts#L1871-L1898
- [read-from-source] DECISIVE for (a) vs (c): in the branch that implements the synchronous channel, fork is gated solely on `#if EMTERPRETIFY_ASYNC` and the sync arm is `abort('fork not supported in sync Browsix')` — while read() on the same sync path works via SYSCALLS.browsix.syscall.sync(). The exclusion is a toolchain-mode gate, not a property of blocking syscalls.
  - https://github.com/bpowers/emscripten/blob/18d2a9bcee24636b46cdf891c9b22ce2903a5738/src/library_syscall.js#L423-L448
- [read-from-source] Browsix's synchronous channel is the same shape as my-web-os's: Atomics.store(HEAP32, waitOff>>2, 0); self.postMessage(syncMsg); Atomics.wait(HEAP32, waitOff>>2, 0), with integer-only args, registered with the kernel via a 'personality' call carrying the SharedArrayBuffer and the futex offset.
  - https://github.com/bpowers/emscripten/blob/18d2a9bcee24636b46cdf891c9b22ce2903a5738/src/library_syscall.js#L259-L280
- [documented] The paper's sentence the plan relies on is scoped to its own mechanism: 'A side effect of this approach is that fork is not compatible with synchronous system calls, as there is no way to re-wind or jump to a particular call stack in the child Web Worker.' (§3.4, on Atomics.wait-based syscalls.) It names a missing capability, not an impossibility.
  - https://arxiv.org/abs/1611.07862
- [documented] REFUTES the plan's claim (a): Browsix §6 Discussion, 'Stack Management', states that a JavaScript equivalent of setcontext/getcontext 'coupled with the use of SharedArrayBuffers would let BROWSIX support fork in Emscripten applications as a synchronous system call.' The authors considered sync fork achievable and blocked only on a missing platform primitive.
  - https://arxiv.org/abs/1611.07862
- [documented] The limitation that does generalize is about serialization, not blocking: §3.5 'Web Workers do not expose a cloning API, and JavaScript lacks the reflection primitives required to serialize a context's entire state into a snapshot. Thus, BROWSIX only supports fork when a language runtime is able to completely enumerate and serialize its own state.' Figure 3's caption: 'fork is only supported for C and C++ programs.'
  - https://arxiv.org/abs/1611.07862
- [documented] §4.3 confirms the Emterpreter dependency and that the sync path is otherwise unencumbered: async syscalls 'require use of Emscripten's interpreter mode (named the "Emterpreter") to save and restore the C stack... require all functions that may be on the stack under a system call to be interpreted so that the stack can be restored... Synchronous system calls do not have this limitation.'
  - https://arxiv.org/abs/1611.07862
- [measured] CORRECTION to research/gap-02.md: the Emterpreter was removed in commit b43474f55aeb49083b9df74fdd0e52ec8decf788 (2020-05-18) and is listed in ChangeLog.md under the **1.39.17 (06/05/2020)** section, not 1.39.18 (06/12/2020). tools/emterpretify.py returns HTTP 200 at tag 1.39.16 and 404 at tag 1.39.17.
  - https://github.com/emscripten-core/emscripten/commit/b43474f55aeb49083b9df74fdd0e52ec8decf788
- [read-from-source] The ChangeLog entry's own wording names the replacement: 'Remove emterpreter and `EMTERPRETIFY` settings. Emterpreter has largely been replaced by asyncify and is fastcomp only so due for removing in the near future anyway.'
  - https://github.com/emscripten-core/emscripten/blob/1.39.18/ChangeLog.md
- [read-from-source] Asyncify HAS the property fork needed. Binaryen's pass doc: the asyncify stack 'is a representation of the call frame, as a list of indexes of calls... also used to save locals', held in linear memory behind the __asyncify_data pointer, with five exported controls asyncify_start_unwind / stop_unwind / start_rewind / stop_rewind / get_state.
  - https://github.com/WebAssembly/binaryen/blob/version_120/src/passes/Asyncify.cpp#L99-L171
- [read-from-source] Emscripten allocates the asyncify data struct and its stack inside linear memory with _malloc: `var ptr = _malloc(sizeof(asyncify_data_s) + Asyncify.StackSize)`, commented 'We also embed a stack in the same memory region here'. So a memory copy carries the suspended stack, and the only extra state is the integer pointer.
  - https://github.com/emscripten-core/emscripten/blob/3.1.74/src/library_async.js#L234-L248
- [read-from-source] GOTCHA, read from source: the rewind entry point is stored in memory only as an interned i32 (asyncify_data_s.rewind_id) and resolved via Asyncify.callStackIdToName, a JS map populated lazily by getCallStackId. A fresh child instance has an empty map, so the parent's name/id table must be transferred alongside linear memory or doRewind cannot resolve the export.
  - https://github.com/emscripten-core/emscripten/blob/3.1.74/src/library_async.js#L182-L197
- [read-from-source] GOTCHA, read from source: Asyncify adds two wasm GLOBALS, __asyncify_state (i32) and __asyncify_data (pointer), which live outside linear memory. A fork by memory copy must transfer them separately.
  - https://github.com/WebAssembly/binaryen/blob/version_120/src/passes/Asyncify.cpp#L1772-L1793
- [read-from-source] The primitive Browsix §6 asked for exists: emscripten/fiber.h (copyright 2019) defines emscripten_fiber_t holding stack_base/stack_limit/stack_ptr plus an embedded asyncify_data_t, with emscripten_fiber_init_from_current_context() (getcontext) and emscripten_fiber_swap() (swapcontext).
  - https://github.com/emscripten-core/emscripten/blob/3.1.74/system/include/emscripten/fiber.h
- [measured] Browsix-Wasm dropped fork silently: the string 'fork' occurs zero times in the full extracted text of arXiv:1901.09056. The paper gives no statement that fork broke; it is simply absent, and SPEC CPU2006/2017 is single-process so nothing forced the issue.
  - https://arxiv.org/abs/1901.09056
- [documented] What Browsix-Wasm §2 actually says broke, verbatim: 'A deeper problem is that WebAssembly memory cannot be shared across WebWorkers and does not support the Atomic API, which BROWSIX processes use to wait for system calls.' Its other two objections to heap-as-SAB were no on-demand heap growth and Chrome's ~2.2 GB per-context heap cap.
  - https://arxiv.org/abs/1901.09056
- [measured] MEASURED, falsifies the first 2019 objection: in Chrome 157.0.8103.38 headless under COOP same-origin + COEP require-corp (crossOriginIsolated true), `new WebAssembly.Memory({initial:256, maximum:256, shared:true}).buffer instanceof SharedArrayBuffer` is true; the Memory postMessages to a dedicated Worker, the worker blocks in Atomics.wait on an Int32Array over it and wakes with 'ok' on Atomics.store + Atomics.notify, and the worker's own instance of the same module reads a value the parent wrote (0xBEEF) and increments it to 0xBEF0.
  - https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Memory/Memory
- [measured] MEASURED, falsifies the second 2019 objection: a shared WebAssembly.Memory grows on demand. mem.grow(1023) on a {initial:1, maximum:4096, shared:true} memory took 0.145 ms, byteLength went 65,536 -> 67,108,864, the pre-grow SharedArrayBuffer was NOT detached and still read the correct cell, mem.buffer became a new SharedArrayBuffer object, the existing instance kept working, and a Worker handed the grown memory saw the current value.
  - https://developer.mozilla.org/en-US/docs/WebAssembly/JavaScript_interface/Memory/grow
- [measured] MEASURED, the real price of fork in this architecture: copying one instance's linear memory into a second instance of the same module cost 3.27 ms for 16 MiB (4.79 GiB/s), 16.58 ms for 64 MiB (3.77 GiB/s) and 85.74 ms for 256 MiB (2.92 GiB/s) in Chrome 157 headless on darwin 25.6. The clone resumed the source's counter (2 -> 3, not 0 -> 1), confirming address-space copy. Negative controls in the same run: an unshared memory is not a SharedArrayBuffer, and mismatched shared-state imports fail with LinkError.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer
- [read-from-source] EXISTENCE PROOF against the 'fundamental' framing: WASIX ships a real POSIX fork for wasm32. __wasi_proc_fork(copy_memory, retptr0) is documented 'Forks the current process into a new subprocess. If the function returns a zero then its the new subprocess', and __wasi_stack_checkpoint / __wasi_stack_restore 'read'/'manipulate the __stack_pointer global'. musl's own fork.c runs on top via _fork_internal.
  - https://github.com/wasix-org/wasix-libc/blob/2025b44a5d2eb22b64ecdbf1bb16f3e7699dfb60/libc-bottom-half/headers/public/wasi/api_wasix.h#L4185-L4198
- [read-from-source] WASIX's proc_fork is implemented, not merely declared: the Wasmer host unwinds, captures the memory stack, the rewind stack and a store snapshot, then rewinds in both parent and child (handle_rewind returns distinct is-child / is-parent branches).
  - https://github.com/wasmerio/wasmer/blob/v6.0.1/lib/wasix/src/syscalls/wasix/proc_fork.rs
- [read-from-source] WASIX independently confirms the wasm-globals gotcha: capture_store_snapshot's entire payload is StoreSnapshot { globals: Vec<u128> } — 'Values of all globals, indexed by the same index used in Webassembly' — restored into the child with set_global_unchecked.
  - https://github.com/wasmerio/wasmer/blob/v6.0.1/lib/wasix/src/utils/store.rs
- [read-from-source] The Browsix-Wasm-era Emscripten branch (Dec 2018) labels sync fork a TODO rather than an impossibility: `abort('TODO: fork not currently supported in sync Browsix')` and, in the post-init path, `abort('TODO: sync post-fork?')`.
  - https://github.com/bpowers/emscripten/blob/c477d54b84aa90ef28b83a1907cae5ba1023d3d1/src/library_browsix.js#L361-L364
- [measured] CONFIRMS the earlier pass: there is no per-syscall latency table in arXiv:1611.07862. The paper contains one Table (Table 1, a feature comparison of JS execution environments) and Figure 9 (a utility execution-time chart, 'roughly another 3x overhead' over Node.js). Do not cite a per-syscall or per-fork number from this paper.
  - https://arxiv.org/abs/1611.07862
- [documented] The only fork-attributable published cost, from §5.2 read with §2.2: pdflatex on a one-page document with a bibliography is ~100 ms native, 'just under 3 seconds' in Browsix with synchronous calls, and 'around 12 seconds' with asynchronous calls and the Emterpreter — and that workload requires the async build because GNU Make uses fork. Thinkpad X1 Carbon, i7-5600U, 8 GB, Linux 4.7.0. Choosing fork therefore cost a ~4x whole-program slowdown.
  - https://arxiv.org/abs/1611.07862
- [read-from-source] Browsix's numeric syscall table still marks process creation as non-Linux: slot 56 clone, 57 fork and 58 vfork are all sys_ni_syscall (which logs 'ni syscall' and returns -ENOSYS=-38), while creation lives at non-Linux slot 326 sys_spawn. Confirms the sync ABI never carried fork.
  - https://github.com/plasma-umass/browsix/blob/04f0830088560f27d480cde3e37c28269375f59f/src/syscall-api/table.ts#L344-L350
- [measured] The Browsix repo's HEAD is the pinned ref the plan already cites: commit 04f0830088560f27d480cde3e37c28269375f59f, 'add specinvoke build', 2019-04-24. Nothing has landed since, so the plan's references are current.
  - https://github.com/plasma-umass/browsix/commit/04f0830088560f27d480cde3e37c28269375f59f
- [read-from-source] browsix.org identifies bpowers/emscripten as the C/C++ runtime for Browsix, which is why the fork implementation is absent from the plasma-umass/browsix tree and why the earlier pass could only cite the kernel half.
  - https://github.com/bpowers/browsix.org/blob/2533c19bdd8a3baee83cf409d6667133efee156d/index.html

---

## Angle 2: WASIX claims to implement fork — is that real, and does it work in a browser?

### Verdict

WASIX's fork is real, not aspirational, and I ran it in Chrome: `sharrattj/dash` performed command substitution and a subshell — both of which go through dash's `forkshell()` → `fork()` → `__wasi_proc_fork` — inside a cross-origin-isolated page under `@wasmer/sdk` 0.19.1, at a measured 2–5 ms per fork for a small heap rising to ~20 ms at a 32 MiB heap. So constraint 20's blanket "there is no fork" is false as stated. But the mechanism is Binaryen asyncify stack unwinding plus a full shared-memory copy, which means it requires a specially built guest (wasix-libc, `wasix_32v1` imports, `wasm-opt --asyncify`, imported *shared* memory) and is structurally incompatible with a process parked in `Atomics.wait`. Constraint 20 is correct for v1 JS processes and for stock `wasm32-wasip1`; it is wrong for a wasix-built guest.

### Detail

**1. The symbol.** `proc_fork` is defined in the WASIX snapshot witx: `(@interface func (export "proc_fork") (param $copy_memory $bool) (result $error (expected $pid (error $errno))))`, alongside `proc_fork_env` (vfork) and `proc_exit2`. The runtime registers it in the `wasix_32v1` / `wasix_64v1` import namespaces only — never in `wasi_snapshot_preview1`.

**2. The mechanism.** `lib/wasix/src/syscalls/wasix/proc_fork.rs`: resolve the instance's asyncify exports; `asyncify_start_unwind` so the guest's whole call stack unwinds back to the host; read the saved stack out of linear memory; serialise the store's globals (`capture_store_snapshot`); `Memory::copy` the linear memory; hand the copy plus the globals plus the saved stack to `tasks.task_wasm(...)` to start a child task; then `asyncify_start_rewind` in both parent and child so each re-enters `proc_fork` and reads its own return value out of `handle_rewind::<M, ForkResult>` (`pid: 0` for the child). `lib/asyncify/README.md` states it plainly: "WASIX builds fork, exec, `longjmp` and deep sleep on this crate." This is Browsix's design with Emterpreter's program counter replaced by an asyncify-serialised stack — the plan already noted Asyncify replaced the Emterpreter; it is the piece that came back.

**3. Required build mode — the decisive constraint.** Four hard preconditions, all read from source:
- Asyncify exports. `WasiModuleInstanceHandles::new` does `Asyncify::new(...).ok()`, which resolves `asyncify_start_unwind`, `asyncify_stop_unwind`, `asyncify_start_rewind`, `asyncify_stop_rewind`, `asyncify_get_state`. Missing them, `unwind` logs "the module does not export asyncify" and kills the process with `Errno::Noexec` — not an `ENOSYS` the guest can handle.
- Shared memory. `Memory::copy`'s doc: "Returns `MemoryError::MemoryNotShared` for non-shared memory on every backend; in particular WASIX `proc_fork` requires shared memory."
- `__stack_pointer` exported, or `get_memory_stack_pointer` returns "failed to save stack: no `__stack_pointer` global".
- A statically linked module. `ensure_static_module()` → `Errno::Notsup` for dynamically linked ones, with the comment "anything that requires asyncify is not supported right now".

Build mode is not a detail: `wasixcc` passes `--asyncify` to `wasm-opt` *only* when exception handling is off, documented as "required for forks and setjmp/longjmp to work". And `wasix-libc` compiles `fork()` and `_Fork()` out entirely under `__wasm_exception_handling__` — `expected/wasm32-wasi-eh/defined-symbols.txt` has no `fork` symbol at all, only `__vfork_internal`. Wasmer's own fork test is pinned to `WASIXCC_WASM_EXCEPTIONS=no`; its vfork test uses EH+PIC. So WASIX ships two mutually exclusive products: the asyncify build has fork and pays asyncify's overhead; the EH build is faster, is the one with working dynamic linking, and has no fork.

Bare `--asyncify` is Binaryen's conservative mode — "it assumes that any import and any indirect call may start an unwind/rewind operation". Emscripten's figure for that overhead is "something like 50% or so" in size and speed; Kripken's measurements give ~50% larger binaries, ~22% slowdown from instrumentation alone, and a 5× outlier on SQLite.

**4. In a browser: yes, measured.** `@wasmer/sdk` 0.19.1, Chrome 143.0.7483.0 headless, COOP same-origin + COEP require-corp, `crossOriginIsolated === true`. `sharrattj/dash` ran `echo start; x=$(echo substituted); echo subst=$x; (echo subshell); echo end` → `start/subst=substituted/subshell/end`, exit 0. The published atom (webc sha256 `c81513a5…`) imports `wasix_32v1.proc_fork`, imports `env.memory` with flags `0x03` (shared, min 2 pages, max 65536 pages) and exports all five `asyncify_*` functions plus `__stack_pointer`. Isolation holds: `( x=5 ); echo "[$x]"` prints `[]` while the negative control `x=5; echo "[$x]"` prints `[5]`. Cost scales with heap, which is the memory copy showing itself: 3.4/4.7 ms per fork at ~0 MiB, 7.1/5.8 ms at 8 MiB, 19.1/21.2 ms at 32 MiB (two runs). Two browser-specific failures: background forks (`( : ) & … wait`) never completed in 30 s, while the same script under native `/bin/sh` returns immediately; and 256 concurrent children failed in 472 ms with `RangeError: WebAssembly.Memory(): could not allocate memory` — the shared-memory reservation ceiling the backend already anticipates with `JS_SHARED_MEMORY_MAXIMUM_PAGES` (32767) and a `smaller_shared_memory_maxima` retry loop. `python/python@=3.13.20` has no `os.fork` at all (EH build), and `sharrattj/bash` traps with "function signature mismatch".

**5. Licences.** wasmer runtime and `lib/asyncify`: MIT. `@wasmer/sdk`: "Modified MIT" — standard MIT plus a requirement to "prominently display 'Wasmer' on the user interface" above 1 M MAU or $1 M monthly revenue. wasix-libc: Apache-2.0-with-LLVM-exception / Apache-2.0 / MIT tri-licence, with musl (MIT), dlmalloc (CC0), cloudlibc (BSD-2) inside. wasixcc: MIT. Binaryen: Apache-2.0.

**6. Benchmark.** None published. The announcement post carries no numbers; the repo's CHANGELOG has none; the figures above are mine, reproducible from `/Users/chafyni/.claude/jobs/e856c39e/tmp/scripts/fork_bench2.py`.

**Why this does not rescue fork for the current design (inferred).** Asyncify unwinding requires the host function serving `proc_fork` to drive `asyncify_start_unwind` on the guest instance and then return, so the guest's stack becomes bytes. A my-web-os process parked in `Atomics.wait` holds a live JS/native stack with no byte representation, and its kernel lives in a different agent, so it cannot drive the unwind at all. WASIX also pays for this everywhere else: `__asyncify_with_deep_sleep` unwinds any syscall that has not finished in 50 ms rather than blocking. That is the opposite of the 14–16 µs blocking channel the plan measured.

### Blockers

- Not stock wasm32-wasip1. fork is only reachable through the `wasix_32v1` import namespace with wasix-libc; `wasi_snapshot_preview1` has no fork and wasi-libc defines none. Option B as written ("unmodified wasm32-wasip1 binaries") gets no fork.
- The guest must be asyncify-instrumented (`wasm-opt --asyncify`). Without the five `asyncify_*` exports, `proc_fork` does not return an errno — `unwind` logs "the module does not export asyncify" and terminates the process with Errno::Noexec.
- Asyncify and WASM exception handling are mutually exclusive in this toolchain, and wasix-libc deletes `fork`/`_Fork` under `__wasm_exception_handling__`. Choosing the faster EH build, or dynamic linking (EH+PIC), costs fork entirely — `ensure_static_module()` returns Notsup for dynamically linked modules.
- The guest's memory must be `shared`. `Memory::copy` returns MemoryError::MemoryNotShared on every backend, so a single-threaded non-shared-memory module cannot fork even when asyncified.
- Asyncify's instrumentation tax is paid by every function all the time, not only at fork: bare `--asyncify` assumes any import and any indirect call may unwind, which Emscripten documents as roughly 50% size and speed overhead.
- Fork cost is a full linear-memory copy, measured: ~3-5 ms fixed plus ~0.5 ms per MiB of guest heap in Chrome (19-21 ms per fork at a 32 MiB heap). A 256 MiB process costs over 100 ms per fork.
- Concurrency is capped by shared-memory reservation, not CPU. 256 live forked dash children failed in 472 ms with `RangeError: WebAssembly.Memory(): could not allocate memory`; the JS backend already clamps shared maxima to 32767 pages and retries with smaller maxima to cope.
- Background forks are broken in this stack today: `( : ) & ... wait` under sharrattj/dash in Chrome never completed within 30 s across 1, 4, 16 and 64 children, while the identical script under native /bin/sh returns immediately.
- Incompatible with the plan's syscall channel (inferred). Asyncify needs the host function to unwind the guest's own stack and return; a process parked in Atomics.wait with its kernel in another agent has no serialisable stack and cannot drive the unwind. WASIX's own blocking I/O unwinds after 50 ms rather than blocking.
- @wasmer/sdk is not plain MIT: above 1 M monthly active users or $1 M monthly revenue it requires "Wasmer" to be displayed prominently in the product's UI.

### Could not determine

- The exact concurrent-fork ceiling per tab. 64 live children allocated fine, 256 failed with WebAssembly.Memory allocation; the 96/128 probes ran in a sandbox already poisoned by the first failure, and a fresh-sandbox-per-N rerun lost the CDP channel. The ceiling is somewhere in 64-256 for dash's declared 4 GiB maximum.
- Why `&` + `wait` hangs: dash's job-control path, WASIX proc_join, or the SDK's scheduler. I established the hang and a passing native control, not the cause.
- Whether a currently built bash forks in the browser. sharrattj/bash fails earlier with `RuntimeError: function signature mismatch` on instantiation, which looks like a stale published build rather than a fork problem.
- Whether Chrome's reservation of a shared memory's declared maximum is virtual or committed. I read the claim in wasmer's JS backend comment and observed the allocation failure; I did not verify it in V8's source.
- Whether proc_fork can work at all when the host serving the syscall lives in a different agent from the guest (my-web-os's kernel-worker shape). Nothing in the wasmer source addresses it and I could not construct the test.
- Any published Wasmer benchmark for proc_fork. I found none in the announcement post, the docs or the CHANGELOG.

### Claims

- [spec-normative] WASIX defines `proc_fork` with signature `(param $copy_memory $bool) (result $error (expected $pid (error $errno)))`, plus a separate `proc_fork_env` for vfork semantics.
  - https://github.com/wasix-org/wasix-witx/blob/0dfbd35a0f30f3fe7fd3b3ab5a50dc4191d5caed/phases/snapshot/witx/wasix_v1.witx#L281-L307
- [read-from-source] `proc_fork` is only exposed in the `wasix_32v1` and `wasix_64v1` import namespaces, never in `wasi_snapshot_preview1` or `wasi_unstable`.
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/wasix/src/lib.rs#L578-L579
- [read-from-source] The mechanism is Binaryen asyncify: start_unwind the guest stack to the host, serialise the store's globals, copy linear memory, spawn a child task with both, then start_rewind so parent and child each re-enter proc_fork and read their own ForkResult.
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/wasix/src/syscalls/wasix/proc_fork.rs
- [documented] Wasmer states the dependency directly: "WASIX builds fork, exec, `longjmp` and deep sleep on this crate" (the asyncify crate), driven by modules produced by `wasm-opt --asyncify`.
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/asyncify/README.md
- [read-from-source] A guest without the five asyncify exports cannot fork: unwind warns "failed to unwind the stack because the module does not export asyncify" and exits the process with Errno::Noexec rather than returning an errno.
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/wasix/src/syscalls/mod.rs#L1234-L1238
- [read-from-source] The required exports are asyncify_start_unwind, asyncify_stop_unwind, asyncify_start_rewind, asyncify_stop_rewind and asyncify_get_state.
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/asyncify/src/exports.rs#L92-L107
- [read-from-source] fork requires shared memory on every backend: "Returns `MemoryError::MemoryNotShared` for non-shared memory on every backend; in particular WASIX `proc_fork` requires shared memory."
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/api/src/entities/memory/mod.rs#L188-L196
- [read-from-source] The guest must also export a `__stack_pointer` global, or the unwind fails with "failed to save stack: no __stack_pointer global".
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/wasix/src/syscalls/mod.rs#L952-L974
- [read-from-source] fork is refused for dynamically linked modules: proc_fork calls ensure_static_module() and returns Errno::Notsup, commented "anything that requires asyncify is not supported right now".
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/wasix/src/state/handles/mod.rs#L238-L247
- [documented] wasixcc passes `--asyncify` to wasm-opt only when WASM exception handling is off, documenting it as "required for forks and setjmp/longjmp to work".
  - https://github.com/wasix-org/wasixcc/blob/d59389f68277c60b65cb1cc1524de641d845d336/src/wasixccenv.rs#L322-L329
- [read-from-source] wasix-libc compiles fork() out entirely in the exception-handling configuration: both fork.c and _Fork.c are guarded by `!defined(__wasm_exception_handling__)`, and the EH build's defined-symbols list contains no `fork` symbol, only `__vfork_internal`.
  - https://github.com/wasix-org/wasix-libc/blob/2025b44a5d2eb22b64ecdbf1bb16f3e7699dfb60/libc-top-half/musl/src/process/fork.c#L55-L59
- [read-from-source] In the EH configuration, vfork is a setjmp/longjmp construction over `__wasi_proc_fork_env` rather than a real fork, and must be a macro because setjmp has to run in the caller.
  - https://github.com/wasix-org/wasix-libc/blob/2025b44a5d2eb22b64ecdbf1bb16f3e7699dfb60/libc-top-half/musl/src/process/vfork.c#L24-L60
- [read-from-source] Wasmer's own fork test is pinned to the non-EH build via `##BuildEnv: WASIXCC_WASM_EXCEPTIONS=no`, while the vfork test is built with `WASIXCC_WASM_EXCEPTIONS=yes WASIXCC_PIC=yes`.
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/wasix/tests/wasm_tests/process/fork/build.sh
- [read-from-source] Bare `--asyncify` is Binaryen's conservative mode: "it assumes that any import and any indirect call may start an unwind/rewind operation" unless asyncify-imports is supplied, which wasixcc does not supply.
  - https://github.com/WebAssembly/binaryen/blob/d39a9694a56248419df7486f1e963975a0847db4/src/passes/Asyncify.cpp#L210-L216
- [documented] Asyncify's overhead is documented by Emscripten as "something like 50% or so" in both code size and speed, from instrumenting code to allow unwinding and rewinding.
  - https://emscripten.org/docs/porting/asyncify.html
- [documented] Measured asyncify overhead on the Emscripten benchmark suite: ~50% larger binaries in worst-case mode, a 22% slowdown from merely enabling it, and a ~5x outlier on SQLite.
  - https://kripken.github.io/blog/wasm/2019/07/16/asyncify.html
- [read-from-source] The browser SDK plumbs the fork path: its task runner handles SpawnType::AttachMemory by attaching the copied memory to a new store and passing task.globals, which is exactly what proc_fork hands it.
  - https://github.com/wasmerio/wasmer-sdk/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/js/bindgen/src/tasks/task_wasm.rs#L53-L70
- [read-from-source] The JS backend implements shared-memory copy for the browser, clamps shared maxima to 32767 pages, and retries with 64 MiB-smaller maxima because "Shared memories reserve their declared maximum in the browser" and a child must still get a usable heap beside its parent.
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/api/src/backend/js/entities/memory/mod.rs#L19-L23
- [measured] WASIX fork runs in Chrome: sharrattj/dash executed `$(echo substituted)` and `(echo subshell)` to completion (exit 0, stdout `start/subst=substituted/subshell/end`) in a cross-origin-isolated page under @wasmer/sdk 0.19.1. Reproduce with /Users/chafyni/.claude/jobs/e856c39e/tmp/scripts/fork_test2.py.
  - https://github.com/wasix-org/dash/blob/6da4b3b3db2d9f7de9c34a8b3650e63c11360249/src/jobs.c#L953
- [measured] The dash atom that forked imports wasix_32v1.proc_fork, imports env.memory with limits flags 0x03 (shared, min 2 pages, max 65536 pages) and exports all five asyncify_* functions plus __stack_pointer, _start and wasi_thread_start.
  - https://cdn.wasmer.io/webcimages/c81513a53f11a2a23ea305fa008049d15fa1b5f52b696cedbf63554077ea5998.webc
- [measured] Fork isolation holds in the browser and the check can fail: `( x=5 ); echo "[$x]"` printed `[]` while the negative control `x=5; echo "[$x]"` printed `[5]` through the same path.
  - https://github.com/wasix-org/dash/blob/6da4b3b3db2d9f7de9c34a8b3650e63c11360249/src/eval.c
- [measured] Per-fork cost in Chrome scales with guest heap, which is the memory copy showing itself: 3.4/4.7 ms at ~0 MiB, 7.1/5.8 ms at 8 MiB, 19.1/21.2 ms at 32 MiB across two runs (fork_bench2.py, min of 3, 8 forks minus 0 forks).
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/api/src/backend/js/vm/memory.rs#L50-L90
- [measured] 256 concurrently live forked children in one tab failed after 472 ms with `RangeError: WebAssembly.Memory(): could not allocate memory`; 64 did not hit that error.
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/api/src/backend/js/entities/memory/mod.rs#L221-L235
- [measured] Background forks are broken in this stack: `( : ) & ... wait` under sharrattj/dash in Chrome exceeded a 30 s budget for 1, 4, 16 and 64 children, while the identical script under native /bin/sh on macOS returns immediately.
  - https://github.com/wasix-org/dash/blob/6da4b3b3db2d9f7de9c34a8b3650e63c11360249/src/jobs.c#L908-L960
- [measured] The published python/python@=3.13.20 has no fork at all in the browser: `os.fork()` raised `AttributeError: module 'os' has no attribute 'fork'`, consistent with an exception-handling build.
  - https://github.com/wasix-org/wasix-libc/blob/2025b44a5d2eb22b64ecdbf1bb16f3e7699dfb60/expected/wasm32-wasi-eh/defined-symbols.txt
- [read-from-source] WASIX does not keep a guest blocked the way the plan's channel does: `__asyncify_with_deep_sleep` unwinds the guest stack after 50 ms (100 us with the journal on) and resumes it later, so every potentially-blocking syscall is an asyncify suspension point.
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/wasix/src/syscalls/mod.rs#L508-L560
- [documented] Cross-origin isolation is a stated deployment requirement for the browser SDK: "Browser deployments must be cross-origin isolated so `SharedArrayBuffer` is available. In practice that means serving appropriate COOP and COEP headers."
  - https://github.com/wasmerio/wasmer-sdk/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/docs/phase-3/javascript-sdk.md#L36-L37
- [read-from-source] Licences: the wasmer runtime (including lib/wasix and lib/asyncify) is MIT; wasixcc is MIT; Binaryen is Apache-2.0; wasix-libc is tri-licensed Apache-2.0-with-LLVM-exception / Apache-2.0 / MIT with musl (MIT), dlmalloc (CC0) and cloudlibc (BSD-2) inside.
  - https://github.com/wasix-org/wasix-libc/blob/2025b44a5d2eb22b64ecdbf1bb16f3e7699dfb60/LICENSE
- [read-from-source] @wasmer/sdk is not plain MIT. Its licence adds: if used in a commercial product or service with more than 1 million monthly active users or more than $1 million in monthly revenue, "you shall prominently display \"Wasmer\" on the user interface of such product or service".
  - https://github.com/wasmerio/wasmer-sdk/blob/ddbd6cda7ae1ddc7f744ae42225137c859e9b981/LICENSE
- [documented] No published benchmark for proc_fork exists. Wasmer's WASIX announcement claims process forking and that WASIX "is fully runnable in browsers" but carries no performance numbers, and the repo CHANGELOG has none.
  - https://wasmer.io/posts/announcing-wasix
- [documented] Wasmer's own documentation for the call confirms the full-copy semantics the measurements show: with copy_memory true "the memory is copied, and both the parent and child processes have separate memory spaces", and the child "starts execution from the same point as the parent process, including the call stack".
  - https://www.wasix.org/docs/api-reference/wasix/proc_fork
- [inferred] The plan's own evidence file already recorded the opening: it notes Emscripten removed the Emterpreter "largely replaced by Asyncify", treating that as the end of Browsix's fork path. Asyncify is precisely what WASIX fork is built on, so the inference that fork died with the Emterpreter does not hold.
  - https://github.com/emscripten-core/emscripten/blob/3.1.74/ChangeLog.md#L1975

---

## Angle 3: could we implement fork ourselves, for a WASM process and for a JS process?

### Verdict

Constraint 20 is wrong as stated for one of the four cases. Fork is impossible for a stock wasm binary and impossible for arbitrary JS — but it is *possible and measured working* for a wasm binary recompiled through `wasm-opt --asyncify`, including end-to-end across a real Worker boundary through the Atomics.wait syscall channel: child returned 0, parent returned the pid, locals restored, pre-fork side effects not replayed, 10 ms wall for a 16 MiB process. Browsix's "no way to rewind or jump to a particular call stack in the child Web Worker" was true of Emterpreter and is false of Asyncify, which spills the call stack into linear memory — so copying the address space copies the stack. WASIX already ships exactly this and lists `fork/default` as a required browser-lane case. The cost is real: every binary must be rebuilt, the whole heap is copied per fork, and in WASIX's shipping config asyncify excludes wasm exception handling.

### Detail

## Verdicts

**wasm-stock: NO.** Address space is copyable; execution state is not. In Chrome 157 `WebAssembly`'s whole property list is compile/validate/instantiate/Module/Instance/Table/Memory/Global/Tag/JSTag/Exception/CompileError/LinkError/RuntimeError/compileStreaming/instantiateStreaming/Suspending/promising/SuspendError. Nothing reads or writes a call stack. Neither pending proposal fixes this. Stack-switching is Phase 3 and its Explainer says continuations are single-shot and *names* "process duplication" as the multi-shot use case it declines to serve — so even when it ships, it does not give fork. JSPI is Phase 5 and shipped (Chrome 137, Firefox 153, Safari 27), but it exposes no continuation value in JS at all; the `Suspender` object was removed. Suspending one stack is not duplicating it, exactly as the brief suspects.

**wasm-recompiled: YES, measured.** Asyncify's saved stack is *data in linear memory*: `__asyncify_data` is a pointer to {current stack location, stack end}, and the asyncify stack holds call indexes plus saved locals. So the fork primitive the brief says is missing is `asyncify_start_rewind` on a fresh instance over a copied memory.

I built it. `/Users/chafyni/.claude/jobs/e856c39e/tmp/work/` — `forkee2.wat` (a 2-frame-deep call chain with locals set before the fork call), built with `wat2wasm` then `wasm-opt --asyncify --pass-arg=asyncify-imports@env.fork -O3`; `proc.js` is a my-web-os-shaped process worker whose syscall is `Atomics.wait` on a SAB; `probe3.js` is the kernel, which only ever stores and notifies.

Measured, Chrome 157 headless, M2 Pro, `crossOriginIsolated === true`:

| leg | 16 MiB | 256 MiB |
|---|---|---|
| syscall park → kernel says "unwind" → unwound | 0.07 ms | 0.08 ms |
| address space copy (`Uint8Array.set`) | 3.5 ms | 144 ms |
| child worker spawn + compile + rewind | 11.1 ms | 15.2 ms |
| **whole fork, wall** | **9.97 ms** (median of 5, 8.3–29.9) | **160 ms** |
| rewind itself | 0.09 ms | 0.10 ms |

Child (a Worker that never ran the program) returned 8000050 = fork→0 with the pre-fork local `marker=100005` intact. Parent returned 8004292 = fork→4242. `gen` stayed 1 in both and `trace` fired once in the parent, zero times in the child: **no replay of pre-fork side effects.**

Negative controls, same run: memory copied but no rewind → "ran from the top, returned 0"; rewind but no memory copy → 7000000; wrong asyncify data pointer → `RuntimeError: memory access out of bounds`; the positive case → 8000050. The check can fail.

The same saved image rewound twice gave [8000050, 8000050] — a memory-image snapshot is *multi-shot*, which is strictly more than stack-switching offers.

**js-arbitrary: NO, and not merely hard.** `structuredClone` of a generator, a function, or a Promise all throw DataCloneError (measured). No realm snapshot exists: 1,269 enumerated globals, zero matching /snapshot|serializ|checkpoint/ except `XMLSerializer`, and `ShadowRealm` is undefined.

**js-cooperative: YES, with the cost on the program author.** The program must keep all state in one structuredClone-able object and its program counter as data. Cheap: 0.04 ms to clone a 7.3 KB state, 1.12 ms for 312 KB. Regenerator is the existence proof that a JS→state-machine transform is mechanical — its `Context` carries `prev`/`next` as a numeric PC — but `hoist.js` lifts locals into the *outer wrapper's* scope, so the Context is clonable and the locals are not. A generator-based interpreter is not forkable by cloning the generator; an interpreter with an explicit stack object is.

## The Atomics.wait question

It helps, but not the way the brief guesses. The kernel knowing where the process is does not give the child a stack — the parent's host stack is unreachable from anywhere. What makes it work is that the unwind must happen **inside the same import call, after `Atomics.wait` returns, on the parent's own thread**. Only the parent can unwind itself. So fork is two legs over one futex word: wait → "unwind" → unwind → "image ready" → wait → pid → rewind. The process is genuinely blocked in both legs; the kernel never blocks. Measured, not inferred.

## Handoff: make process memory `shared: true`

`memory.buffer.transfer()` throws `TypeError: ArrayBuffer is not detachable`, and the same buffer cannot cross `postMessage` as a transferable. An unshared `WebAssembly.Memory` is not structuredClone-able; a shared one is. So the cheap path is: the child allocates a shared memory, posts it to the kernel, the kernel memcpys straight in — one copy, 1.77 ms / 16 MiB. The unshared route costs two copies, 3.95 ms / 16 MiB and 111 ms / 256 MiB.

## Precedent

WASIX ships this. `wasixv2-tests/browser/v1/fork/build.sh` is literally `wasm-opt --all-features --asyncify --pass-arg=asyncify-imports@wasix_32v1.proc_fork`, in a lane whose README says "SharedArrayBuffer + cross-origin isolation, no JSPI" — my-web-os's exact environment — and `fork/default` is on the required list. Their README: two libc configurations, "exception handling, wasixcc's default, in which fork fails with `ENOSYS`, and asyncify (`WASIXCC_WASM_EXCEPTIONS=no`), in which fork returns twice."

### Blockers

- wasm-stock is dead, not expensive: nothing in Chrome 157's WebAssembly namespace reads or writes a call stack, so an unmodified wasm32-wasip1 binary cannot be forked at any price. Verified by enumerating WebAssembly's own properties.
- Stack-switching will not rescue it. The Explainer makes continuations single-shot by design and explicitly names process duplication as the multi-shot use case it declines: "An attempt to invoke a continuation more than once results in a trap."
- JSPI will not rescue it either, and adopting JSPI for the syscall channel would DESTROY the Asyncify fork path: JSPI's suspended stack lives in engine-managed memory with no JS-visible handle, so it cannot be copied into a child. [inferred from the Overview's statement that the Suspender object was removed and Suspending has no visible attributes.] If my-web-os ever swaps Atomics.wait for JSPI, fork goes with it.
- Every wasm binary must be rebuilt with wasm-opt --asyncify. A third-party wasm32-wasip1 binary you did not compile still cannot fork. The plan's cost line - "third-party fork()-without-exec binaries" - survives unchanged.
- In WASIX's shipping configuration asyncify excludes wasm exception handling (WASIXCC_WASM_EXCEPTIONS=no), which is why libc2 maintains two sysroots and rebuilds every forking program a second time. A C++ process that needs exceptions cannot fork.
- WASIX's proc_fork refuses dynamically linked modules outright (Errno::Notsup). Any dlopen story and fork are mutually exclusive.
- Fork copies the whole heap. Measured 144 ms of main-thread memcpy for a 256 MiB process, and N live forks cost N heaps of RAM. WASIX's own runner needs a per-run MemoryMax cap because three concurrent fork-heavy tests exhaust the host.
- The memcpy has nowhere else to run. A WebAssembly.Memory buffer is not detachable and an unshared Memory is not structuredClone-able (both measured as TypeError/DataCloneError), so the kernel worker must do the copy itself, on its own thread - 144 ms during which the kernel is not servicing other processes' syscalls. That violates "the kernel never blocks" in wall-clock terms even though it never parks.
- Unless every process memory is created shared:true, fork costs two memcpys instead of one (111 ms vs 30.6 ms at 256 MiB). That is a design decision the plan has to make before M5, not after.
- js-arbitrary is impossible, not merely costly: closures, generators and Promises are all un-cloneable (measured DataCloneError), and no realm-snapshot API exists in any form (1,269 globals enumerated, ShadowRealm undefined).
- js-cooperative moves the cost onto the program author: every forkable JS program must hold all state in one structuredClone-able object and its program counter as data. A regenerator-style transform gives you the PC but leaves locals in the outer closure where the state object cannot reach them, so the transform alone is not enough.
- My measurement used a hand-written .wat with no C shadow stack. WASIX's proc_fork snapshots the memory stack AND the rewind stack AND a serialized store snapshot - three things, not one - which means a real clang-compiled binary's __stack_pointer region needs explicit handling that my test did not exercise.

### Could not determine

- Whether an Asyncify fork survives a real clang-compiled wasm32-wasip1 binary's shadow stack in a browser. WASIX does it natively and passes LTP and Open POSIX suites, but the browser executor is not in wasmer main at c388f3aeef0f82e46fb851a98f6c88652291ecba - lib/wasixv2/host/tests/browser does not exist there, and the wasixv2-tests browser README says "No executor or syscall is implemented here." The fixture and the build recipe are committed and fork/default is required; the passing executor I could not find.
- Stack-switching availability in Firefox and Safari in 2026. I measured only Chrome 157 (WebAssembly.Continuation undefined). The spec-level one-shot argument makes this moot for fork, but the availability claim itself is unverified outside Chrome.
- The Asyncify code-size tax on a realistic binary. My 148-byte toy grew 5.01x (+594 B), which is dominated by the fixed asyncify runtime and is not representative. Emscripten's docs say only "can cause the Wasm output to be much larger" and "something like 50% or so" for combined overhead, with no numeric size figure.
- Whether Asyncify's indirect-call imprecision forces whole-program instrumentation for a real OS process, and what that costs. The docs name indirect calls as an analysis limit; I did not measure a program that reaches syscalls through function pointers.
- Whether the kernel's 144 ms memcpy for a 256 MiB fork can be moved off the kernel worker - e.g. to a third 'copier' worker holding both shared memories - and what that does to the fork latency. Not tested.
- Whether the Asyncify rewind composes with a process that has multiple wasm threads. Real fork keeps only the calling thread; whether Asyncify's per-instance data block is safe when other threads of the same memory are live, I did not test.

### Claims

- [read-from-source] Asyncify's saved call stack lives in linear memory: __asyncify_data points to a struct holding the current stack location and stack end, and the asyncify stack is a list of call indexes that is also used to save locals. This is why copying a process's linear memory copies its call stack.
  - https://github.com/WebAssembly/binaryen/blob/79dfe6b412a3c22bfdb190ed6a4d79adf734db5d/src/passes/Asyncify.cpp
- [measured] A fork of an Asyncify-instrumented wasm module works end to end across a real Worker boundary through an Atomics.wait-on-SharedArrayBuffer syscall channel: the child Worker, which never executed the program, returned 8000050 (fork returned 0) and the parent returned 8004292 (fork returned pid 4242), with the pre-fork local marker=100005 restored in both frames.
  - https://github.com/WebAssembly/binaryen/blob/79dfe6b412a3c22bfdb190ed6a4d79adf734db5d/src/passes/Asyncify.cpp
- [measured] Pre-fork side effects are not replayed by the rewind: the mutable global incremented before the fork call read 1 in both parent and child, and the non-asyncify `trace` import fired once in the parent and zero times in the child.
  - https://github.com/WebAssembly/binaryen/blob/79dfe6b412a3c22bfdb190ed6a4d79adf734db5d/src/passes/Asyncify.cpp
- [measured] Fork wall time for a 16 MiB process is 9.97 ms (median of 5; range 8.3-29.9 ms), split 0.07 ms unwind round trip, 3.5 ms address-space memcpy, 11.1 ms child worker spawn plus wasm compile, 0.09 ms rewind. For 256 MiB it is 160 ms, of which 144 ms is the memcpy. Chrome 157 headless, Apple M2 Pro, crossOriginIsolated true.
  - https://github.com/WebAssembly/binaryen/blob/79dfe6b412a3c22bfdb190ed6a4d79adf734db5d/src/passes/Asyncify.cpp
- [measured] Negative controls fail as required: memory copied but no rewind gives "ran from the top, returned 0"; rewind with no memory copy gives 7000000; a wrong asyncify data pointer traps with RuntimeError: memory access out of bounds; the positive case gives 8000050.
  - https://github.com/WebAssembly/binaryen/blob/79dfe6b412a3c22bfdb190ed6a4d79adf734db5d/src/passes/Asyncify.cpp
- [measured] A memory image containing an unwound asyncify stack can be rewound more than once: rewinding two fresh instances from one saved image returned 8000050 both times. A memory-image snapshot is multi-shot.
  - https://github.com/WebAssembly/binaryen/blob/79dfe6b412a3c22bfdb190ed6a4d79adf734db5d/src/passes/Asyncify.cpp
- [spec-normative] The WASM stack-switching proposal cannot implement fork even when it ships: "Continuations in the current proposal are single-shot (aka linear), meaning that they should be invoked exactly once... An attempt to invoke a continuation more than once results in a trap. Some applications such as backtracking, probabilistic programming, and process duplication exploit multi-shot continuations, but none of our critical use-cases requires multi-shot continuations."
  - https://github.com/WebAssembly/stack-switching/blob/d9fbe345495d15af623b981440d6aaacd5ad015c/proposals/stack-switching/Explainer.md#one-shot-continuations
- [documented] Stack switching is at Phase 3 (Implementation Phase) and JS Promise Integration is at Phase 5 (standardized), champions Francis McCabe and Sam Lindley, and Francis McCabe respectively.
  - https://github.com/WebAssembly/proposals/blob/df6a2aca1cd9d779eb4f2f3e19dae8277f336015/README.md
- [measured] Chrome 157 exposes no stack-switching surface: WebAssembly's own properties are compile, validate, instantiate, Module, Instance, Table, Memory, Global, Tag, JSTag, Exception, CompileError, LinkError, RuntimeError, compileStreaming, instantiateStreaming, Suspending, promising, SuspendError. WebAssembly.Continuation is undefined.
  - https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface
- [spec-normative] JSPI exposes no continuation value to JS and so cannot duplicate a stack: "Only WebAssembly computations may be suspended using JSPI", the Suspender object was removed, and the Suspending object "has no externally visible attributes other than those inherited from Object".
  - https://github.com/WebAssembly/js-promise-integration/blob/5b247b1026d2f438eefe51914a79f4218cbda9f9/proposals/js-promise-integration/Overview.md
- [documented] JSPI is shipped broadly - WebAssembly.Suspending is supported from Chrome 137, Firefox 153 and Safari 27 - so its absence is not the reason fork is unavailable.
  - https://github.com/mdn/browser-compat-data/blob/e665ba48c74db7e5c96077ae26e8fe837ff09ddf/webassembly/api/Suspending.json
- [read-from-source] WASIX builds fork in the browser by exactly this mechanism: its browser fork fixture is built with `wasm-opt --all-features --asyncify --pass-arg=asyncify-imports@wasix_32v1.proc_fork`, and the fixture asserts classic fork semantics (parent's pre-fork memory write preserved, child exit code observed via proc_join).
  - https://github.com/wasix-org/wasixv2-tests/blob/92b94c5ef4e86758b6b8b52666f5597a9ee99dd3/browser/v1/fork/main.wat
- [read-from-source] fork/default is a required WASIX v1 browser compatibility case, in a lane whose README states "The first lane is SharedArrayBuffer + cross-origin isolation, no JSPI" - the same environment my-web-os targets.
  - https://github.com/wasix-org/wasixv2-tests/blob/92b94c5ef4e86758b6b8b52666f5597a9ee99dd3/browser/v1-allowlist.txt
- [documented] Asyncify and wasm exception handling are mutually exclusive in WASIX's shipping configuration: "libc2 has two build configurations... exception handling, wasixcc's default, in which fork fails with ENOSYS, and asyncify (WASIXCC_WASM_EXCEPTIONS=no), in which fork returns twice."
  - https://github.com/wasix-org/wasixv2-tests/blob/92b94c5ef4e86758b6b8b52666f5597a9ee99dd3/README.md
- [documented] Fork's whole-heap copy is a real operational cost, not a theoretical one: WASIX's own test runner documents "Fork copies a process's whole linear memory, so tests that fork hundreds of processes... need many gigabytes; without a cap three of them at once can exhaust the host."
  - https://github.com/wasix-org/wasixv2-tests/blob/92b94c5ef4e86758b6b8b52666f5597a9ee99dd3/README.md
- [read-from-source] Wasmer's own crate states the dependency chain explicitly: "An asyncified module can unwind its stack back to the host and later be rewound to where it left off... WASIX builds fork, exec, longjmp and deep sleep on this crate."
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/asyncify/README.md
- [read-from-source] WASIX's proc_fork refuses dynamically linked modules (ensure_static_module, "process forking not supported for dynamically linked modules", Errno::Notsup) and snapshots three things, not one: the memory stack, the rewind stack, and a serialized store snapshot of the globals.
  - https://github.com/wasmerio/wasmer/blob/c388f3aeef0f82e46fb851a98f6c88652291ecba/lib/wasix/src/syscalls/wasix/proc_fork.rs
- [measured] A WebAssembly.Memory buffer cannot be moved: memory.buffer.transfer() throws "TypeError: ArrayBuffer is not detachable and could not be cloned", and postMessage with it as a transferable throws "ArrayBuffer at index 0 is not detachable and could not be transferred". An unshared WebAssembly.Memory is not structuredClone-able (DataCloneError); a shared one is. Chrome 157.
  - https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/ArrayBuffer/transfer
- [measured] Copying an address space costs a memcpy at ~6.2-6.6 GiB/s: Uint8Array.set is 2.54 ms for 16 MiB and 37.6 ms for 256 MiB, versus structuredClone of the same buffer at 7.72 ms and 143.1 ms. Allocating the destination WebAssembly.Memory is nearly free (0.025 ms / 0.735 ms).
  - https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory
- [measured] Making process memory shared:true halves the handoff: the child allocating a shared memory and the kernel memcpying into it costs 1.77 ms (16 MiB) and 30.6 ms (256 MiB), versus 3.95 ms and 111.1 ms for the two-copy unshared route through a plain transferable ArrayBuffer. Worker spawn to ready is 3.66 ms.
  - https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory
- [measured] Chrome 157's WebAssembly.Memory.prototype carries constructor, grow, buffer, toFixedLengthBuffer and toResizableBuffer. None of them duplicates a memory; the resizable-buffer integration changes the buffer's resizability, not its ownership.
  - https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Memory
- [measured] The Asyncify tax on a call-per-iteration integer loop, both builds at -O3, is 1.10x at 1e6 iterations (2.53 ms vs 2.785 ms) and 1.11x at 1e7 (25.18 ms vs 28.04 ms), with identical answers. Emscripten's own docs put the figure for real programs higher: "Asyncify adds overhead, both code size and slowness... That overhead is usually not extreme, something like 50% or so."
  - https://github.com/emscripten-core/emscripten/blob/bb11bae9af3a6551132655a0908f86889d2d423b/site/source/docs/porting/asyncify.rst
- [documented] Asyncify's instrumentation analysis is "limited by indirect calls, since it can't tell where they go", and its reentrancy rule is that "It is not safe to start an async operation while another is already running" - so an OS whose processes call syscalls through function pointers needs manual ASYNCIFY_ADD or whole-program instrumentation.
  - https://github.com/emscripten-core/emscripten/blob/bb11bae9af3a6551132655a0908f86889d2d423b/site/source/docs/porting/asyncify.rst
- [measured] Arbitrary JS cannot be forked: structuredClone of a generator, a function and a Promise all throw DataCloneError in Chrome 157, while a Map clones fine.
  - https://developer.mozilla.org/en-US/docs/Web/API/Window/structuredClone
- [measured] No web API snapshots a realm. Enumerating all 1,269 own properties of globalThis and its prototype chain in Chrome 157 yields zero names matching /snapshot|serializ|heapdump|savestate|checkpoint|cloneRealm/ other than XMLSerializer, and ShadowRealm is undefined.
  - https://developer.mozilla.org/en-US/docs/Web/API/Window/structuredClone
- [measured] Cloning an explicit JS process-state object is cheap enough to be a fork primitive: 0.04 ms for a 7.3 KB state and 1.12 ms for a 312 KB state (medians of 20).
  - https://developer.mozilla.org/en-US/docs/Web/API/Window/structuredClone
- [read-from-source] A regenerator-style transform makes a JS program counter into data but not the locals: the Context object carries prev/next as a numeric PC and tryEntries, while hoist() "replaces any Declaration nodes in its body with assignments, then returns a VariableDeclaration containing just the names of the removed declarations" - placed in the outer wrapper's scope, where the Context cannot reach them.
  - https://github.com/facebook/regenerator/blob/cb755fd82c648cbc5307a5a2d61cdd598e698fc4/packages/transform/src/hoist.js
- [inferred] Browsix's stated reason for having no fork - that there is no way to rewind or jump to a particular call stack in the child Web Worker - is specific to Emterpreter, which Emscripten deleted in 1.39.18; asyncify_start_rewind is exactly that mechanism and is still shipping.
  - https://github.com/emscripten-core/emscripten/blob/bb11bae9af3a6551132655a0908f86889d2d423b/site/source/docs/porting/asyncify.rst

---

## Angle 4 — what the absence of fork actually costs, tested construct by construct against POSIX XCU 2.x, against three fork-free shells read from source (busybox hush, busybox-w32 ash, mvdan/sh as shipped by wanix), and against the Windows precedent (Cygwin).

### Verdict

The feature list in constraint 20 is right: pipelines, `&`, `$(…)`, `&&`, `while read … < file`, `<(cmd)`, `coproc`, `trap`, `exec`, `wait` and `jobs` all reach the user on spawn + pipe + setpgid. But the stated casualty is the wrong one. `( subshell )` costs almost nothing — in-process is in fact *more* POSIX-conformant for `$$`, `$!` and `PPID` than a spawned subshell would be. The real casualty is concurrency between two shell-internal commands in one pipeline: `f | g` where both are functions or compound commands cannot run in one single-threaded Worker. Every fork-free shell in the wild buys that back with a thread (mvdan/sh uses a goroutine) or with a full re-exec of the shell carrying serialized state (hush's `re_execute_shell`, busybox-w32's `spawn_forkshell`, ~730 lines). my-web-os must budget the second of those, or accept deadlock. Separately, `fg`/`bg`/`^Z` are limited by constraint 21 and `Worker.terminate()`, not by fork — the plan credits them to spawn without naming that bill.

### Detail

## The construct ledger

Needs a real process (spawn is sufficient, fork buys nothing):
`a | b` between external programs; `cmd &` with an external command; `$(cmd)`/`` `cmd` `` of an external command; `<(cmd)` (bash needs only FIFO-or-`/dev/fd`, so pipe + `/proc/self/fd/N`); `coproc` (two pipes + one spawn); `exec cmd`.

Needs no process at all:
`{ list; }` — POSIX says *current process environment*, explicitly. `cmd1 && cmd2` — sequential, current environment. `while read x; do …; done < file` — compound command, current environment. `exec` with no command — "Redirection affects the current shell execution environment". `trap` — shell-internal. `wait`, `jobs`, `fg`, `bg` — all scoped to "the current shell execution environment", which spawn satisfies as long as the shell stays the parent.

Needs a *duplicate environment* but not a duplicate process:
`( list )`, and command substitution. POSIX defines a subshell environment as "a duplicate of the shell environment, except that signal traps that are not being ignored shall be set to the default action". Nothing in that sentence requires a pid. And the three observable identity variables argue *against* spawning: `$$` "in a subshell shall expand to the same value as that of the current shell"; `PPID` likewise; `$!` must not be affected by background commands started inside a subshell. A spawned subshell gets a new pid and would have to lie about all three. An in-process snapshot gets them right for free — provided it saves and restores the job table, or `( sleep 5 & ); echo $!` leaks.

Needs concurrency, which is where it actually breaks:
a function, builtin or compound command as a **non-last** pipeline element. `f | g` with two shell functions, or `{ a; b; } &`, or `seq 1e6 | { while read n; do …; done; } | cat`. One Worker cannot run both halves. Serialize and the first half blocks writing once the pipe buffer fills — forever. This is not theory: hush's source carries the reproducers. Its heredoc writer is a separate re-exec'd process because `full_write` "may loop or block"; its command-substitution reader is too, with the comment ``huge=`cat BIG` # was blocking here forever``; and builtins in a pipeline are re-exec'd under "On NOMMU, we must never block! Example: `{ sleep 99 | read line; } & echo Ok`".

## What the three real implementations pay

**mvdan/sh** (what wanix ships) is the closest architectural match and the cheapest: `Runner.subshell()` is a hand-written 35-field struct copy with copy-on-write for variables, functions and aliases, carrying `// Keep in sync with the Runner type`. For a pipe it spawns a **goroutine** plus a real OS pipe. Remove Go's threads and this design does not work. That is precisely what a Worker removes.

**busybox hush** is the fork-free design for MMU-less Linux, and it is the template my-web-os would have to copy. `re_execute_shell()` re-execs the busybox binary passing non-exported variables as `-V name=val`, read-only ones as `-R`, functions as `-F name body`, and `$$`/`$?`/loop depth hex-packed into one `-$…` argument. Two structural prices: function bodies must be kept as **source text** (`funcp->body_as_string`), and the parser must record the original text of every construct as it goes (`nommu_addchr` into `ctx.as_string`) — 48 call sites. Traps are deliberately not passed, justified in a long comment by POSIX's subshell trap reset.

**busybox-w32** pays the maximal price: ~730 lines of code in a ~900-line region implementing `spawn_forkshell` — `CreateFileMapping` shared memory, a recursive deep copy of globals, variable table, command table, aliases, history, job table and parse tree, a relocation bitmap, pointer fixup in the child, and `#define free(p) sticky_free(p)` so the copied block is never freed. Exactly five call sites: heredoc, command substitution, `( )`, pipeline, shellexec. That is the honest cost estimate for doing this properly.

**busybox ash** refuses: `#error "Do not even bother, ash will not run on NOMMU machine"`. **dash** has no fork-free mode — `evalsubshell`, `evalpipe` and `evalbackcmd` all call `forkshell` unconditionally.

## For Option B, the cost is zero

WASI preview1's entire import surface has no process creation: `proc_exit` and (from wasi-threads) `thread_spawn`, nothing else. wasi-libc does not even declare fork — `pid_t fork(void);` sits behind `#ifdef __wasilibc_unmodified_upstream /* WASI has no fork/exec */`. No conforming wasip1 binary can call fork. busybox's NOFORK/NOEXEC taxonomy is the useful part instead: `echo`, `kill`, `true` are NOFORK (safe in the shell's own realm); `ls`, `head`, `ps` are NOEXEC; `cat`, `wc`, `grep`, `sleep` need a real process. Eligibility excludes anything long-running or reading stdin, and `VAR=VAL nofork` is a known open bug.

## The Windows precedent

Cygwin does emulate fork, and documents the result: a non-copy-on-write child built by `CreateProcess` + `setjmp` + address-space copy + three mutex handoffs, with the admission that "fork will almost certainly always be inefficient under Win32" — and the measurement that switching the compiler driver from fork/exec to spawn "increased compilation speeds by twenty to thirty percent". FAQ 4.45 lists the production failure modes (`unable to remap somedll to same address as parent`, `resource temporarily unavailable`, requiring `rebase` and removal of injected DLLs). The lesson is the opposite of the plan's framing: fork emulation is the expensive branch. Not having it is a feature, if the shell is written for it from the start.

### Blockers

- `f() { seq 1 200000; }; g() { wc -l; }; f | g` — two shell-internal commands in one pipeline. A single Worker cannot run both. Serializing deadlocks once the kernel pipe buffer fills; the only fixes are (a) spawn a second shell worker with the serialized parse tree + variable table, or (b) buffer the whole intermediate stream in memory. Evidence that this is the real failure mode: busybox hush re-execs the shell to run a builtin in a pipeline with the comment "On NOMMU, we must never block! Example: { sleep 99 | read line; } & echo Ok" (shell/hush.c:8467-8474).
- `{ echo start; sleep 5; echo done; } & echo immediate` — a compound command in the background. Same root cause: the shell must keep running while the group runs. hush re-execs for this; busybox-w32 serializes the whole shell state through shared memory (FS_EVALSUBSHELL / FS_EVALPIPE).
- `x=$(f)` where f is a shell function emitting more than one pipe buffer. hush documents the exact symptom for the external equivalent: "huge=`cat BIG` # was blocking here forever" (shell/hush.c:7683-7687). Mitigable without concurrency only by capturing a function's stdout into an in-memory buffer rather than through a real pipe — which means `$(…)` has two code paths, one for functions and one for programs.
- `( sleep 5 & ); echo $!` must not print the subshell's background pid, and `jobs` in the parent must not list it — POSIX XCU 2.5.2 says background commands executed from subshells do not affect `$!` in the current shell. An in-process subshell that shares the shell's job table gets both wrong. The snapshot must cover the job table and `$!`, not just the variable table as PLAN.md:228 states.
- `last=init; printf 'a\nb\n' | while read x; do last=$x; done; echo $last` — measured locally: bash 3.2.57, /bin/sh and dash print `init`; /bin/zsh and /bin/ksh print `b`. An in-process pipeline tail puts my-web-os in the zsh/ksh camp. POSIX permits it ("as an extension, however, any or all commands in a pipeline may be executed in the current environment"), but any bash script relying on the loop body being isolated silently changes behaviour. This needs a decision and a documented flag, not silence.
- `^Z` on a compute-bound process cannot work, and this is not fork's fault. `Worker` exposes exactly two instance methods, `postMessage()` and `terminate()` — there is no suspend. Combined with constraint 21 (no preemption), SIGTSTP can only be honoured for a process already parked in Atomics.wait inside a syscall. Constraint 20 claims job control survives on spawn+setpgid; the claim needs the qualifier. busybox-w32 reached the same wall from the Windows side and says so: "JOBS_WIN32 doesn't enable job control, just some job-related features" (shell/ash.c:244-248).
- The in-process snapshot has no specified field list. mvdan/sh's `Runner.subshell` copies 35 named fields and carries the warning `// Keep in sync with the Runner type. Manually copy fields` — a known maintenance hazard. PLAN.md:228 says only "the shell snapshots its own variable table"; cwd, umask, fd table, positional parameters, options, `$?`, function table, aliases, loop depth, `set -e` state and trap table all have to be in that list or `( cd /tmp; … ); pwd` and `( set -e; … ); echo $?` go wrong.

### Could not determine

- Whether StackBlitz's `jsh` implements `( … )`, `coproc`, `<(…)` or job control, and what it does when two shell functions are piped together. `jsh` is closed source, is never named in the public docs, and the public issue tracker has no result for `subshell` or `jsh`. I had no API key to measure it. What IS established from the docs: the public API offers `spawn` only, and `WebContainerProcess` exposes exactly `exit`, `input`, `output`, `kill()` and `resize()` — no pid, no signal number, no fork.
- Whether wasi-libc actually compiles musl's `process/fork.c` into libc.a. The declaration is guarded out of `unistd.h`, which is sufficient for the conclusion, but CMakeLists.txt at the pinned sha has no `fork` or `process/` string and I did not trace its source globbing.
- The precise total line count of busybox-w32's fork emulation. I measured 901 lines (728 non-blank, non-comment-leading) between shell/ash.c:17280 and :18180 at sha ece38eb, which excludes the 60-line `struct forkshell` at :403-462 and the five call sites. Treat ~730 as a floor, not a total.
- Whether Browsix's own shell (as opposed to its kernel) used fork for any construct. gap-02 covers the kernel's fork path; I did not read Browsify's shell, so I cannot say which constructs it degraded.

### Claims

- [spec-normative] POSIX defines a subshell environment as a duplicate of the shell environment with non-ignored traps reset to default; command substitution, parenthesised groups and asynchronous lists shall run in one; each command of a multi-command pipeline is in a subshell environment, but 'as an extension, however, any or all commands in a pipeline may be executed in the current environment'.
  - https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_12
- [spec-normative] `{ compound-list ; }` is specified to 'Execute compound-list in the current process environment' — it needs no process, fork or spawn.
  - https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_09_04
- [spec-normative] `$$` in a subshell 'shall expand to the same value as that of the current shell', and PPID in a subshell 'shall be set to the same value as that of the parent of the current shell' — so an in-process subshell is more conformant here than a spawned one, which would carry a new pid.
  - https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_05_02
- [spec-normative] `$!` must not be affected by background commands started inside a subshell: 'background commands executed from subshells do not affect the value of "$!" in the current shell environment'. An in-process subshell sharing the shell's job table violates this.
  - https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_05_02
- [spec-normative] `exec` with no command affects the current shell execution environment and creates no process; with a command it 'shall replace the shell with command without creating a new process'.
  - https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#exec
- [spec-normative] `wait` is scoped to the invoking shell: 'The known process IDs are applicable only for invocations of wait in the current shell execution environment.' Spawn satisfies this as long as the shell remains the parent.
  - https://pubs.opengroup.org/onlinepubs/9699919799/utilities/wait.html
- [documented] bash's process substitution requires only named pipes or the /dev/fd method of naming open files — pipe + a /proc/self/fd path, no fork-specific primitive.
  - https://www.gnu.org/software/bash/manual/html_node/Process-Substitution.html
- [read-from-source] busybox ash refuses to build without fork: `#if !BB_MMU` / `# error "Do not even bother, ash will not run on NOMMU machine"`, and it forks unconditionally for command substitution via `forkshell(jp, (ctl == CTLBACKQ) ? n : NULL, FORK_NOJOB)`.
  - https://github.com/mirror/busybox/blob/1_36_1/shell/ash.c#L307
- [read-from-source] busybox hush is the fork-free shell: `re_execute_shell()` re-execs the busybox binary passing non-exported variables as `-V`, read-only ones as `-R`, functions as `-F name body`, and $$/$?/loop depth hex-packed in a `-$…` argument, then `-c <command text>`. Traps are deliberately not passed, justified by POSIX's subshell trap reset.
  - https://github.com/mirror/busybox/blob/1_36_1/shell/hush.c#L7391
- [read-from-source] hush re-execs the shell merely to run a builtin as a pipeline or background element, with the rationale 'On NOMMU, we must never block! Example: { sleep 99 | read line; } & echo Ok' — the concrete evidence that the cost of no-fork is concurrency, not environment duplication.
  - https://github.com/mirror/busybox/blob/1_36_1/shell/hush.c#L8464
- [read-from-source] hush delegates blocking heredoc writes and large command substitutions to a re-exec'd child, with the reproducer `yes … | dd bs=32 count=64k >BIG; huge=`cat BIG` # was blocking here forever`.
  - https://github.com/mirror/busybox/blob/1_36_1/shell/hush.c#L7683
- [read-from-source] hush's fork-free mode forces two structural costs on the shell: function bodies must be retained as source text (`funcp->body_as_string`, used by `exec_function`), and the parser must accumulate the original text of every construct while parsing (`nommu_addchr` into `ctx.as_string`, 48 call sites).
  - https://github.com/mirror/busybox/blob/1_36_1/shell/hush.c#L8393
- [read-from-source] busybox-w32's ash emulates fork with `spawn_forkshell`: a CreateFileMapping shared-memory block, a recursive deep copy of globals, variable table, command table, aliases, history, job table and parse tree, a relocation bitmap, pointer fixup in the child (`forkshell_init`), and `#define free(p) sticky_free(p)`. Exactly five call sites: FS_OPENHERE, FS_EVALBACKCMD, FS_EVALSUBSHELL, FS_EVALPIPE, FS_SHELLEXEC.
  - https://github.com/rmyorston/busybox-w32/blob/ece38eb40276986f883a2c4ffcfc695749d4813c/shell/ash.c#L403
- [measured] That emulation measures 901 lines (728 non-blank, non-comment-leading) between shell/ash.c:17280 and :18180, counted with python3 over the file fetched at sha ece38eb, excluding the 60-line struct and the call sites.
  - https://github.com/rmyorston/busybox-w32/blob/ece38eb40276986f883a2c4ffcfc695749d4813c/shell/ash.c#L17285
- [read-from-source] busybox-w32 ships the `jobs`, `fg` and `bg` builtins but states 'JOBS_WIN32 doesn't enable job control, just some job-related features' — the same wall my-web-os hits from constraint 21, reached from the Windows side.
  - https://github.com/rmyorston/busybox-w32/blob/ece38eb40276986f883a2c4ffcfc695749d4813c/shell/ash.c#L244
- [read-from-source] busybox's in-process execution path, `run_nofork_applet`, runs an applet inside the shell with setjmp/longjmp and a save/restore of six globals; ash's dispatcher documents the eligibility rule ('applets which can run for a long time and/or wait for user input ineligible for NOFORK: for example, "yes" or "rm"') and an open bug for `VAR=VAL nofork`.
  - https://github.com/mirror/busybox/blob/1_36_1/libbb/vfork_daemon_rexec.c#L102
- [read-from-source] In busybox 1.36.1, of the ten programs M5 plans, `echo`, `kill` and `true` are APPLET_NOFORK (safe in the caller's process); `ls`, `head` and `ps` are APPLET_NOEXEC; `cat`, `wc`, `grep` and `sleep` are plain APPLET and need a real process.
  - https://github.com/mirror/busybox/blob/1_36_1/procps/kill.c#L13
- [read-from-source] ash's own fork-avoidance rule is narrow and trap-gated: 'Can we avoid forking? For example, very last command in a script or a subshell does not need forking, we can just exec it' — taken only when `!(flags & EV_EXIT) || may_have_traps` is false.
  - https://github.com/mirror/busybox/blob/1_36_1/shell/ash.c#L10566
- [read-from-source] dash has no fork-free mode: `evalsubshell`, the pipeline loop and `evalbackcmd` all call `forkshell()` unconditionally at v0.5.12.
  - https://git.kernel.org/pub/scm/utils/dash/dash.git/tree/src/eval.c?h=v0.5.12#n498
- [read-from-source] wanix's shell is not a forking shell: it is mvdan.cc/sh/v3 `interp` with a custom exec handler that spawns wanix tasks for external commands.
  - https://github.com/tractordev/wanix/blob/dd17950e1d67d51c0b65d81d2597e0507ac67b89/rc/shell.go#L15
- [read-from-source] mvdan/sh implements the subshell as a hand-written 35-field struct copy with copy-on-write variables, functions and aliases, carrying the warning 'Keep in sync with the Runner type. Manually copy fields'. This is exactly the design PLAN.md:228 proposes, and the maintenance hazard is documented in the source.
  - https://github.com/mvdan/sh/blob/57c2becbf1d205bf6003aa73c974c82348866253/interp/api.go#L1406
- [read-from-source] mvdan/sh replaces fork's concurrency with a goroutine plus a real OS pipe (`wg.Go(func(){ r2.stmt(ctx, cm.X) ... })`), and matches bash by default with a comment to that effect, with `optLastPipe` to switch to ksh/zsh behaviour. A single-threaded Worker has no equivalent of that goroutine.
  - https://github.com/mvdan/sh/blob/57c2becbf1d205bf6003aa73c974c82348866253/interp/runner.go#L726
- [read-from-source] In mvdan/sh, `$$` is `os.Getpid()` and PPID is `os.Getppid()` in every subshell — the in-process design gets POSIX's subshell pid rule right for free.
  - https://github.com/mvdan/sh/blob/57c2becbf1d205bf6003aa73c974c82348866253/interp/vars.go#L347
- [read-from-source] anuraOS's native shell app is not a POSIX shell: it runs exactly one process via `anura.processes.execute(cmd, args)` and wires its three streams to hterm. There is no pipeline, no fork, no job control; the `Processes` API exposes only execute/kill/pid/remove. Its real shell comes from the v86 x86 emulator running Alpine.
  - https://github.com/MercuryWorkshop/anuraOS/blob/cc18239e5bf78e580265f09180cd079f9bc92f20/src/api/Processes.tsx#L49
- [documented] WebContainer's public API offers `spawn` only, and `WebContainerProcess` exposes exactly `exit`, `input`, `output`, `kill()` and `resize()` — no pid, no signal number, no fork. Searching the public issue tracker for 'fork' returns only StackBlitz UI fork-button reports.
  - https://webcontainers.io/api
- [read-from-source] WASI preview1's complete import surface contains no process creation: of 40 functions the only process-related ones are `proc_exit` and `thread_spawn`. There is no fork, spawn, exec or wait to call.
  - https://github.com/WebAssembly/wasi-libc/blob/c3a02dcd35cc0048a5ab6a30142b2df6349947ef/libc-bottom-half/headers/public/wasi/wasip1.h
- [read-from-source] wasi-libc does not even declare fork: `pid_t fork(void);` sits behind `#ifdef __wasilibc_unmodified_upstream /* WASI has no fork/exec */`. For Option B's unmodified wasm32-wasip1 binaries the cost of having no fork is exactly zero — code that calls it never compiled.
  - https://github.com/WebAssembly/wasi-libc/blob/c3a02dcd35cc0048a5ab6a30142b2df6349947ef/libc-top-half/musl/include/unistd.h#L135
- [documented] Cygwin's fork is a non-copy-on-write emulation (CreateProcess, setjmp, address-space copy, three mutex handoffs) and its own documentation concedes 'fork will almost certainly always be inefficient under Win32', then measures the alternative: changing the compiler driver to call spawn instead of fork 'increased compilation speeds by twenty to thirty percent in our tests'.
  - https://www.cygwin.com/cygwin-ug-net/highlights.html
- [documented] Cygwin FAQ 4.45 documents fork emulation's production failure modes — 'unable to remap somedll to same address as parent', 'couldn't allocate heap', 'resource temporarily unavailable' — and the mitigations (rebase, removing injected DLLs, 64-bit address space), concluding it is 'difficult to make fork() work reliably'.
  - https://www.cygwin.com/faq.html#faq.using.fixing-fork-failures
- [documented] `Worker` exposes exactly two instance methods, `postMessage()` and `terminate()`. There is no suspend or resume, so SIGTSTP of a compute-bound process is impossible regardless of fork — the `fg`/`bg`/`^Z` limit comes from the Worker model plus constraint 21, not from constraint 20.
  - https://developer.mozilla.org/en-US/docs/Web/API/Worker
- [measured] Measured on this machine: `last=init; printf 'a\nb\n' | while read x; do last=$x; done; echo last=[$last]` prints `last=[init]` under bash 3.2.57, /bin/sh and /bin/dash, and `last=[b]` under /bin/zsh and /bin/ksh. An in-process pipeline tail puts my-web-os in the zsh/ksh camp — POSIX-legal under the pipeline extension clause, but a silent behaviour change for bash scripts.
  - https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html#tag_18_12

---

## Claims refuted on adversarial verification

- **§4.3 confirms the Emterpreter dependency and that the sync path is otherwise unencumbered: async syscalls 'require use of Emscripten's interpreter mode (named the "Emterpreter") to save and restore th**
  - cited: https://arxiv.org/abs/1611.07862
  - verifier: What I read: the full Browsix paper text, extracted with pdftotext from https://arxiv.org/pdf/1611.07862v2 (md5 11f59f4c2062136b5895e5c1199db50d, identical to the default /pdf/1611.07862; arXiv 1611.07862 = Powers, Vilk, Berger, "Browsix: Bridging the Gap Between Unix and the Browser", ASPLOS 2017). Local extraction at /tmp/browsix-paper-check/v2.txt.

PART 1 OF THE CLAIM — CONFIRMED, verbatim. The quoted sentences appear exactly as given, in the "C and C++" paragraph of §4.3 (Runtime-specific Integration): "When asynchronous system calls are used, it requires use of Emscripten's interpreter mode (named the 'Emterpreter') to save and restore the C stack. BROWSIX's asynchronous system calls require all functions that may be on the stack under a system call to be interpreted so that the stack can be restored when the system call completes. ... Synchronous system calls do not have this limi

- **The only fork-attributable published cost, from §5.2 read with §2.2: pdflatex on a one-page document with a bibliography is ~100 ms native, 'just under 3 seconds' in Browsix with synchronous calls, an**
  - cited: https://arxiv.org/abs/1611.07862
  - verifier: Read the primary source in full: arXiv:1611.07862v2 (Browsix, ASPLOS 2017), downloaded to /tmp/arxiv_fetch_1611/paper.pdf and text-extracted; read §2.2, §3.5 "fork:", §4.2, §4.3, §5.2 and §6.

NUMBERS: all correct verbatim. §5.2: pdflatex ~100 ms native on "a single page document with a bibliography"; "just under 3 seconds" with synchronous calls (Chrome); "around 12 seconds" with "asynchronous system calls and the Emterpreter". Hardware exact: Thinkpad X1 Carbon, i7-5600U, 8 GB, Linux 4.7.0.

ATTRIBUTION: refuted, two independent ways.
(1) §5.2 names its own cause and it is not fork: the async/Emterpreter path "is only necessary to enable broader compatibility with today's browsers." Synchronous calls are the Chrome-only path (Atomics.wait on SharedArrayBuffer). The 3->12 s delta is the cost of the async syscall path on non-Chrome browsers, paid by every program in the pipeline includin
