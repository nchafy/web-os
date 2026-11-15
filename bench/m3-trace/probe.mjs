// The trace ring under plain Node: the dropped-record semantics, and what a record costs.
//
// The cost figure here is a FLOOR, not the kernel's real per-syscall cost: it is the ring write
// alone, with no syscall around it, measured on whatever host runs this. MILESTONES.md M3's 4 ns
// came from the same shape of loop. The number is printed with the machine beside it because
// docs/CONSTRAINTS.md's figures are Chrome 157 / macOS 26.7.2 / M2 Pro and a bare Node run is not
// that.
import {
  TraceRing, TRACE_RECORD_BYTES, TRACE_FLOOR_BYTES, TR_ENTER, TR_EXIT, selfTest,
} from "../../src/kernel/trace.mjs";

const results = [];
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : want });
};
const checkThat = (name, ok, detail) => results.push({ name, ok: !!ok, detail: ok ? undefined : detail });

checkThat("the published derivations hold", selfTest(), "selfTest threw");
check("a record is 32 bytes", TRACE_RECORD_BYTES, 32);
check("the floor is 16 MiB", TRACE_FLOOR_BYTES, 16 * 1024 * 1024);

// ---- the dropped counter is the subject -------------------------------------------------
// A ring nobody reads must drop once it has been lapped, and must say how many.
const small = new TraceRing(64 * 1024, { enforce: false });
check("a 64 KiB ring holds 2048 records", small.capacity, 2048);
for (let i = 0; i < 2048; i += 1) small.put(TR_ENTER, 1, 0, i, 0, 0, i);
check("a ring filled exactly to capacity drops nothing", small.dropped, 0);
check("and holds every record", small.available, 2048);
small.put(TR_ENTER, 1, 0, 9999, 0, 0, 1);
check("one record past capacity drops exactly one", small.dropped, 1);
check("and it still holds capacity records", small.available, 2048);
for (let i = 0; i < 1000; i += 1) small.put(TR_ENTER, 1, 0, i, 0, 0, i);
check("1000 more drop 1000 more", small.dropped, 1001);
check("written counts every record ever, dropped or not", small.written, 2048 + 1 + 1000);

// A reader that keeps up drops nothing, however long the run.
const kept = new TraceRing(64 * 1024, { enforce: false });
for (let round = 0; round < 10; round += 1) {
  for (let i = 0; i < 2000; i += 1) kept.put(TR_EXIT, 2, 1, i, 0, 0, i);
  kept.read({ limit: 4096 });
}
check("20,000 records through a 2048-record ring lap it", kept.dropped, 20000 - 2048);
check("and reading changes nothing", kept.available, 2048);
check("over 20,000 records", kept.written, 20000);

// ---- drain ------------------------------------------------------------------------------
const r = new TraceRing(64 * 1024, { enforce: false });
r.put(TR_ENTER, 7, 3, 11, 42, 5, 1.5);
r.put(TR_EXIT, 7, 3, 11, -2, 9, 2.5);
const got = r.read();
check("read returns both records", got.length, 2);
check("entry kind survives", got[0].kind, TR_ENTER);
check("exit kind survives", got[1].kind, TR_EXIT);
check("pid survives", got[0].pid, 7);
check("syscall number survives", got[0].nr, 3);
check("callid survives", got[0].callid, 11);
check("a negative r0 survives as signed", got[1].r0, -2);
check("extra survives", got[1].extra, 9);
check("the sequence is monotonic", [got[0].seq, got[1].seq], [0, 1]);
check("the timestamp is the one the caller passed", got[0].t, 1.5);
checkThat("entry precedes exit", got[1].t > got[0].t, `${got[0].t} then ${got[1].t}`);
check("reading does not consume", r.available, 2);
r.put(TR_ENTER, 1, 0, 1, 0, 0, 3);
check("a third record joins them", r.read().length, 3);
check("and all three stay available", r.available, 3);
check("a zero limit shows nothing", r.read({ limit: 0 }).length, 0);
check("and a ring never lapped has dropped nothing", r.dropped, 0);

// Oldest-first after a wrap: the records you get are the NEWEST capacity-worth, in order.
const wrapped = new TraceRing(64 * 1024, { enforce: false });
for (let i = 0; i < 3000; i += 1) wrapped.put(TR_ENTER, 1, 0, i, i, 0, i);
const w = wrapped.read({ limit: 4096 });
check("a wrapped ring returns capacity records", w.length, 2048);
check("oldest surviving record first", w[0].r0, 3000 - 2048);
check("newest record last", w[w.length - 1].r0, 2999);
checkThat("the sequence is strictly increasing across the wrap",
  w.every((rec, i) => i === 0 || rec.seq === w[i - 1].seq + 1), "a wrap reordered the ring");

// ---- the floor is enforced where it matters ---------------------------------------------
let threw = "";
try { new TraceRing(64 * 1024); } catch (e) { threw = e.message; }
checkThat("an undersized ring is refused by default", threw.includes("floor"), threw || "no throw");
const big = new TraceRing();
check("the default ring meets the floor", big.undersizedByDefault === undefined && big.bytes, TRACE_FLOOR_BYTES);
check("the default holds 524,288 records", big.capacity, 524288);
check("stats reports undersized false for the default", big.stats().undersized, false);
check("a 3000-record run through 2048 slots drops 952", wrapped.dropped, 3000 - 2048);
check("stats reports undersized true for a 64 KiB ring", small.stats().undersized, true);

// ---- cost -------------------------------------------------------------------------------
// Warm, then measure. The ring is pre-filled so every iteration takes the wrap branch, which is
// the expensive one; measuring the empty-ring path would understate it.
const cost = new TraceRing();
const N = 2000000;
const tNow = performance.now();
for (let i = 0; i < 600000; i += 1) cost.put(TR_ENTER, 1, 0, i, 0, 0, tNow);
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i += 1) cost.put(TR_ENTER, 1, 0, i, 0, 0, tNow);
const t1 = process.hrtime.bigint();
const nsPerRecord = Number(t1 - t0) / N;
// The bar is the claim this milestone makes: a record is cheap enough that tracing is always
// on. 25 ns leaves room for a slower host than this one while still refusing the 52.8 ns a
// per-record clock read would cost.
checkThat("a record costs under 25 ns with the clock hoisted", nsPerRecord < 25,
  `${nsPerRecord.toFixed(1)} ns`);

const failed = results.filter((x) => !x.ok);
console.log(JSON.stringify({
  ok: failed.length === 0, total: results.length, failed: failed.length, failures: failed,
  nsPerRecord: Number(nsPerRecord.toFixed(2)),
  node: process.version, platform: `${process.platform}/${process.arch}`,
}, null, 2));
process.exit(failed.length ? 1 : 0);
