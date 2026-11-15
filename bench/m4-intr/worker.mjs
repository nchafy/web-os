// The worker side of M4's owed experiment.
//
// THE QUESTION (MILESTONES.md §Open experiments, owed before M4): can `Atomics.notify` interrupt a
// worker that is inside a SYNCHRONOUS OPFS read? If it cannot, then any syscall whose handler sits
// inside such a read is uninterruptible for its duration, and docs/ABI.md's claim that `read()` is
// INTR-capable needs qualifying.
//
// The worker holds its own `FileSystemSyncAccessHandle` here, which the real architecture forbids
// (constraint 15 puts handles in the kernel's I/O worker). That is deliberate: this measures the
// PRIMITIVE, and the primitive is what the architecture's conclusion has to rest on.

const EVT = 0;      // the word main notifies
const PHASE = 1;    // what the worker is doing, so main can time its notify
const P_IDLE = 0, P_READING = 1, P_DONE = 2, P_PARKED = 3;

let i32 = null;

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.t === "init") {
      i32 = new Int32Array(m.sab);
      self.postMessage({ t: "ready" });
      return;
    }

    // ---- baseline: a worker in Atomics.wait IS woken by a notify ---------------------------
    // Without this, a negative result below says nothing: it could just mean the notify never
    // arrived. A harness nobody has seen succeed on the easy case has not been checked.
    if (m.t === "park") {
      Atomics.store(i32, EVT, 0);
      // P_PARKED, not P_READING: main waits for THIS and then delays before notifying, because
      // "the worker is inside Atomics.wait" is not observable from outside. Without the delay the
      // store landed first and `wait` returned `not-equal` — a correct outcome that measures
      // nothing, and the harness refused to report rather than calling it a wake.
      Atomics.store(i32, PHASE, P_PARKED);
      const t0 = performance.now();
      const r = Atomics.wait(i32, EVT, 0, m.timeoutMs);
      const t1 = performance.now();
      Atomics.store(i32, PHASE, P_DONE);
      self.postMessage({ t: "park-done", result: r, waitedMs: t1 - t0 });
      return;
    }

    // ---- the subject: a notify delivered while the thread is inside a synchronous read ------
    if (m.t === "read-while-notified") {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(m.name, { create: true });
      const h = await fh.createSyncAccessHandle();
      if (h.getSize() < m.bytes) {
        h.truncate(m.bytes);
        h.flush();
      }
      const buf = new Uint8Array(m.chunk);
      Atomics.store(i32, EVT, 0);

      // Tell main we are about to read, then read. Main notifies as soon as it sees PHASE.
      Atomics.store(i32, PHASE, P_READING);
      const t0 = performance.now();
      let got = 0;
      let firstSeen = -1;
      let reads = 0;
      // Read the whole file in `chunk`-sized pieces, which is what a real caller does: the ABI
      // caps one read at MAX_INLINE. After EVERY chunk, check whether the notify has landed, so
      // `firstSeen` is the earliest point the worker COULD have noticed.
      for (let at = 0; at < m.bytes; at += m.chunk) {
        got += h.read(buf, { at });
        reads += 1;
        if (firstSeen < 0 && Atomics.load(i32, EVT) !== 0) firstSeen = performance.now();
      }
      const t1 = performance.now();
      Atomics.store(i32, PHASE, P_DONE);
      // One more check after the loop, for the case where the notify landed during the last chunk.
      const seenAfter = Atomics.load(i32, EVT) !== 0;
      h.close();
      self.postMessage({
        t: "read-done",
        bytes: got, reads, readMs: t1 - t0,
        // Milliseconds from the start of the read to the first moment the worker could observe
        // the flag. A notify cannot PREEMPT the chunk that is running, so the floor here is one
        // chunk's duration -- which is the number M4's design needs.
        firstSeenMs: firstSeen < 0 ? null : firstSeen - t0,
        seenAfter,
        perReadUs: ((t1 - t0) * 1000) / reads,
      });
      return;
    }

    // ---- ONE uninterrupted synchronous read, to measure the blocking floor -----------------
    if (m.t === "one-read") {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(m.name, { create: true });
      const h = await fh.createSyncAccessHandle();
      if (h.getSize() < m.bytes) {
        h.truncate(m.bytes);
        h.flush();
      }
      const buf = new Uint8Array(m.bytes);
      // Warm, then measure: a cold first read includes the handle's own lazy setup.
      h.read(buf, { at: 0 });
      const samples = [];
      for (let i = 0; i < m.rounds; i += 1) {
        const t0 = performance.now();
        h.read(buf, { at: 0 });
        samples.push(performance.now() - t0);
      }
      h.close();
      samples.sort((a, b) => a - b);
      self.postMessage({
        t: "one-read-done", bytes: m.bytes, rounds: m.rounds,
        medianMs: samples[Math.floor(samples.length / 2)],
        p99Ms: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.99))],
        maxMs: samples[samples.length - 1],
      });
      return;
    }
    self.postMessage({ t: "error", why: `unknown message ${m && m.t}` });
  } catch (error) {
    self.postMessage({ t: "error", why: String((error && error.stack) || error) });
  }
};
