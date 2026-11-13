// Histogram -> percentiles, and the ONE place the withholding rule, the quantum band and the
// concurrency gates are enforced. Imported by the bench page and consumed by probe.py, so the
// bench and the suite cannot disagree about what a p99 means.
//
// Nothing here measures anything. It is pure arithmetic over what the processes reported.

/** A percentile below this many quanta is not resolvable by the clock and is withheld. */
export const WITHHOLD_QUANTA = 5;

/**
 * THE QUANTILE THE HEADLINE IS READ AT, declared once and read by every call site that claims to
 * compute it — the pooled figure the verdict is taken from and the per-process column beside it.
 * A literal at either call site would make the two columns two different statistics printed under
 * one name, and the column that kept 0.99 would disagree with the headline in silence.
 */
export const HEADLINE_QUANTILE = 0.99;

/** Samples below which a printed percentile is withheld as insufficient. */
export const MIN_PERCENTILE_SAMPLES = 1000;

/**
 * Gate policy, declared once and used by both the predicate and the detail string a reader quotes.
 * These are thresholds on statistics this file computes, so they live here; the decision bars, the
 * liveness margin and the quiescence limit cross into probe.py and live in bars.json.
 */
export const GATE = {
  /** A2a: saturation was reached — depth_max as a fraction of N. */
  satFraction: 0.75,
  /** A2b: the MEDIAN dispatch saw this fraction of N queued. The floor of 2 is kept for N=2,3,
   *  where half of N is 1 and a median of 1 is no contention at all. */
  medianFraction: 0.5,
  medianFloor: 2,
  /** A2c: fraction of dispatches that saw a backlog, and the N at or above which it is read. Below
   *  N=16 the per-process wake-latency gap is too large a share of the cycle for this bar to mean
   *  saturation — measured 0.898-0.901 at N=4 on clean runs against 0.999 at N=16 — and a bar a
   *  healthy N=4 cannot meet is not evidence about N=4. */
  queuedFraction: 0.95,
  queuedMinN: 16,
  /** A9: agreement between the kernel's notify-woke-0 count and the processes' not-equal count. */
  raceAgreement: 0.95,
  /** A6: kernel utilisation, and the N at or above which it is read. Below 128 the bottleneck is
   *  the renderer and not the kernel, so the clause is reported as not-read rather than dropped. */
  rhoFloor: 0.9,
  rhoMinN: 128,
};

/** Above this the clock is too coarse to describe a ~14 us channel at all. A non-isolated context
 *  clamps performance.now() to 100 us, at which most of a 14 us region times as zero and a
 *  histogram binned at 5 us would look lossless with bins twenty times too narrow. */
export const QUANTUM_REFUSE_US = 20;

const US = 1000;   // ms -> us

export function poolHistograms(list) {
  const first = list[0];
  const lin = new Array(first.linBins).fill(0);
  const log = new Array(first.logBins).fill(0);
  let count = 0;
  let sum = 0;
  let max = 0;
  let min = Infinity;
  let beyondTop = 0;
  for (const s of list) {
    for (let i = 0; i < s.lin.length; i += 1) lin[i] += s.lin[i];
    for (let i = 0; i < s.log.length; i += 1) log[i] += s.log[i];
    count += s.count;
    sum += s.sum;
    beyondTop += s.beyondTop;
    if (s.max > max) max = s.max;
    if (s.count && s.min < min) min = s.min;
  }
  return {
    lin, log, count, sum, max, beyondTop,
    min: count ? min : 0,
    quantumMs: first.quantumMs,
    linBins: first.linBins,
    logBins: first.logBins,
    logTopMs: first.logTopMs,
  };
}

/**
 * Every bin as [value in ms, count], linear region then log region, ascending.
 *
 * ONE definition of the bin geometry: the percentile, the exceedance and the quantile witness all
 * read the same ladder, so the log step cannot be computed one way in one of them and another way
 * in the next.
 */
export function ladder(h) {
  const out = [];
  for (let i = 0; i < h.lin.length; i += 1) out.push([i * h.quantumMs, h.lin[i]]);
  const linTop = h.linBins * h.quantumMs;
  const step = Math.log(h.logTopMs / linTop) / h.logBins;
  for (let j = 0; j < h.log.length; j += 1) out.push([linTop * Math.exp(step * j), h.log[j]]);
  return out;
}

/** Nearest-rank, over the pooled bins. Never an interpolation, and never a mean of percentiles. */
export function percentileMs(h, q) {
  if (!h.count) return null;
  const target = Math.ceil(q * h.count);
  let seen = 0;
  for (const [ms, c] of ladder(h)) {
    seen += c;
    if (seen >= target) return ms;
  }
  return h.max;
}

/** Samples at or above a threshold. Estimator-free: it depends on no percentile definition. */
export function exceedance(h, thresholdUs) {
  const thresholdMs = thresholdUs / US;
  let over = 0;
  for (const [ms, c] of ladder(h)) {
    if (ms >= thresholdMs) over += c;
  }
  over += h.beyondTop;
  return { count: over, fraction: h.count ? over / h.count : 0 };
}

/** Double noise, not a tolerance on the claim: `us` and the ladder value it came from are the
 *  same expression evaluated twice. The next bin up is one whole quantum away in the linear
 *  region and ~15% away in the log region, so nothing a reading could be confused with is
 *  anywhere near this. */
const LADDER_REL = 1e-9;

/**
 * THE PUBLISHED PERCENTILE, CHECKED BY COUNTING. It does not re-run percentileMs: it asks whether
 * `us` sits where the q-quantile must sit, which is two counting statements —
 *
 *   more than (1-q) of the samples lie AT OR ABOVE it, and no more than (1-q) lie STRICTLY ABOVE.
 *
 * Both are theorems about the nearest-rank q-quantile of any distribution (cum below the bin is
 * at most ceil(qn)-1, cum through it is at least ceil(qn)), so a figure computed at a lower
 * quantile and printed as this one fails the second clause. That is the whole point: a headline
 * replaced by a different quantile is invisible to every bound-shaped check, because the stalled
 * distribution can be tight enough that p50 == p99 and the negative control stays happy.
 */
export function quantileWitness(h, q, us) {
  if (!h.count || us === null || us === undefined) return null;
  const tail = 1 - q;
  let atOrAbove = h.beyondTop;
  let above = h.beyondTop;
  for (const [ms, c] of ladder(h)) {
    const v = ms * US;
    if (v >= us * (1 - LADDER_REL)) atOrAbove += c;
    if (v > us * (1 + LADDER_REL)) above += c;
  }
  const atOrAboveFraction = atOrAbove / h.count;
  const aboveFraction = above / h.count;
  return {
    q,
    us,
    atOrAboveFraction,
    aboveFraction,
    tail,
    ok: atOrAboveFraction > tail && aboveFraction <= tail,
  };
}

/**
 * A percentile as it may be printed. THE WITHHOLDING RULE IS PER PERCENTILE, keyed on that
 * percentile's own VALUE, not on the sample set's p50: keying it on p50 would suppress a
 * trustworthy p99 of 400 us whenever the p50 happened to be 20 us, which is exactly the decision
 * figure the bench exists to produce.
 *
 * The band is +/- one quantum and is a PER-SAMPLE bound, not a confidence interval on the
 * percentile: whether Chrome's clamp floors or rounds to nearest is undetermined, so the
 * conservative choice is both directions.
 */
export function cell(h, q, minN) {
  const quantumUs = h.quantumMs * US;
  if (!h.count || h.count < minN) return { text: `—(n=${h.count})`, us: null, why: "insufficient" };
  const ms = percentileMs(h, q);
  const us = ms * US;
  if (us < WITHHOLD_QUANTA * quantumUs) {
    return {
      text: "—",
      us: null,
      why: `withheld: ${us.toFixed(3)} us is below ${WITHHOLD_QUANTA} quanta `
        + `(${(WITHHOLD_QUANTA * quantumUs).toFixed(3)} us)`,
    };
  }
  return {
    us,
    lowUs: us - quantumUs,
    highUs: us + quantumUs,
    text: `${us.toFixed(1)}[${(us - quantumUs).toFixed(1)},${(us + quantumUs).toFixed(1)}]`,
    why: null,
  };
}

/**
 * AGREEMENT, as a fraction of the larger counter: 1 when the two counters are identical, 0 when
 * one of them saw nothing the other saw.
 *
 * The figure it replaces computed a DISagreement and was printed as agreement, so identical
 * counters read "agree to 0.0%" and the maximal-disagreement case collapsed to 0 as well — no
 * value of it could fail. `null` when neither side observed the event at all: there is nothing to
 * agree about, and printing 100% for an unobserved phenomenon is the same defect in the other
 * direction.
 */
export function agreementFraction(a, b) {
  if (a === 0 && b === 0) return null;
  const larger = Math.max(a, b);
  return 1 - Math.abs(a - b) / larger;
}

/** The figure, shown capable of taking every value it claims. Called by the bench page at start-up
 *  and reported, because a ratio nobody has seen move is not a check. */
export function agreementSelfTest() {
  return {
    identical: agreementFraction(29, 29),
    disjoint: agreementFraction(0, 29),
    half: agreementFraction(15, 30),
    unobserved: agreementFraction(0, 0),
    ok: agreementFraction(29, 29) === 1
      && agreementFraction(0, 29) === 0
      && agreementFraction(15, 30) === 0.5
      && agreementFraction(0, 0) === null,
  };
}

/**
 * KNOWN ANSWERS for the percentile machinery, hand-computed from two fixed sample vectors.
 *
 * The quantum is 0.5 ms because a power of two is exact in a double, so every expectation below
 * is an exact number rather than a number plus a tolerance. The log edge is exact too:
 * linTop x exp(ln(4)/2) is 5 x 2 = 10 ms.
 *
 * LIN, 20 samples: 10 at bin 1 (0.5 ms), 5 at bin 2, 4 at bin 5, 1 at bin 9.
 *   p50 -> rank ceil(10) = 10, reached inside bin 1       -> 500 us
 *   p95 -> rank 19, reached at bin 5 (10+5+4)             -> 2500 us
 *   p99 -> rank 20, reached at bin 9                      -> 4500 us
 * LOG, 100 samples: 98 at bin 1 (0.5 ms), 2 in log bin 1 (10 ms).
 *   p50 -> rank 50, inside bin 1                          -> 500 us
 *   p99 -> rank 99, past the linear region into log bin 1  -> 10000 us
 *
 * cell()'s three outcomes are pinned on the LIN vector as well: the printed band at p99, the
 * withholding rule at p50 (500 us is under 5 quanta = 2500 us), and the insufficient-sample rule.
 * And the witness is shown taking BOTH values over one vector — ok for the real p99, not ok for
 * the p50 presented as one — because a witness nobody has seen refuse is not a witness.
 */
const KAT_LIN = {
  quantumMs: 0.5, linBins: 10, logBins: 2, logTopMs: 20,
  lin: [0, 10, 5, 0, 0, 4, 0, 0, 0, 1], log: [0, 0],
  count: 20, sum: 0, max: 4.5, min: 0.5, beyondTop: 0,
};
const KAT_LOG = {
  quantumMs: 0.5, linBins: 10, logBins: 2, logTopMs: 20,
  lin: [0, 98, 0, 0, 0, 0, 0, 0, 0, 0], log: [0, 2],
  count: 100, sum: 0, max: 12, min: 0.5, beyondTop: 0,
};

/** The percentile, the band, the withholding rule and the witness, against hand-computed answers.
 *  The pattern is agreementSelfTest() above and the FNV-1a vectors in src/abi.mjs: a figure the
 *  whole milestone is reported in needs its arithmetic pinned by something other than itself. */
export function percentileSelfTest() {
  const us = (h, q) => percentileMs(h, q) * 1000;
  const got = {
    linP50Us: us(KAT_LIN, 0.5),
    linP95Us: us(KAT_LIN, 0.95),
    linP99Us: us(KAT_LIN, HEADLINE_QUANTILE),
    logP50Us: us(KAT_LOG, 0.5),
    logP99Us: us(KAT_LOG, HEADLINE_QUANTILE),
    cellP99Text: cell(KAT_LIN, HEADLINE_QUANTILE, 10).text,
    cellWithheldUs: cell(KAT_LIN, 0.5, 10).us,
    cellInsufficientWhy: cell(KAT_LIN, HEADLINE_QUANTILE, MIN_PERCENTILE_SAMPLES).why,
    witnessOnP99: quantileWitness(KAT_LOG, HEADLINE_QUANTILE, us(KAT_LOG, HEADLINE_QUANTILE)).ok,
    witnessOnP50: quantileWitness(KAT_LOG, HEADLINE_QUANTILE, us(KAT_LOG, 0.5)).ok,
  };
  const want = {
    linP50Us: 500,
    linP95Us: 2500,
    linP99Us: 4500,
    logP50Us: 500,
    logP99Us: 10000,
    cellP99Text: "4500.0[4000.0,5000.0]",
    cellWithheldUs: null,
    cellInsufficientWhy: "insufficient",
    witnessOnP99: true,
    witnessOnP50: false,
  };
  const wrong = Object.keys(want).filter((k) => got[k] !== want[k]);
  return { q: HEADLINE_QUANTILE, got, want, wrong, ok: wrong.length === 0 };
}

/**
 * The kernel's bounded heartbeat-gap histogram -> Decision 2's published distribution.
 *
 * Nearest-rank over fixed bins, like every other percentile here. A percentile that falls past the
 * top bin is reported as null with `over` and `maxMs` beside it, never silently clamped to the top
 * bin: that would print a 32 ms p999 for a 400 ms gap.
 */
export function hbGapStats(hbGap) {
  if (!hbGap || !hbGap.count) return null;
  const at = (q) => {
    const target = Math.ceil(q * hbGap.count);
    let seen = 0;
    for (const [i, c] of hbGap.bins) {
      seen += c;
      if (seen >= target) return i * hbGap.binMs;
    }
    return null;
  };
  return {
    count: hbGap.count,
    meanMs: hbGap.sumMs / hbGap.count,
    p50Ms: at(0.5),
    p99Ms: at(0.99),
    p999Ms: at(0.999),
    maxMs: hbGap.maxMs,
    over: hbGap.over,
    topMs: hbGap.topMs,
  };
}

/**
 * Did the measured windows actually overlap? The intersection of every process's window, in the
 * wall clock, over the window length. 1.0 means every process was inside its measured window for
 * the whole of every other process's.
 *
 * This is the direct statement of the thing the depth histogram only implies, and it is reported
 * whether or not it passes.
 */
export function overlapStats(barriers, windowMs) {
  const spans = barriers.filter((b) => b && b.released && b.leftWall);
  if (spans.length === 0 || !windowMs) return null;
  const latestStart = Math.max(...spans.map((b) => b.releasedWall));
  const earliestEnd = Math.min(...spans.map((b) => b.leftWall));
  const overlapMs = earliestEnd - latestStart;
  return {
    processes: spans.length,
    releaseSpreadMs: latestStart - Math.min(...spans.map((b) => b.releasedWall)),
    endSpreadMs: Math.max(...spans.map((b) => b.leftWall)) - earliestEnd,
    overlapMs,
    fraction: overlapMs / windowMs,
  };
}

/** depth histogram ([bin, count] pairs) -> the achieved-concurrency figures. */
export function depthStats(pairs) {
  let total = 0;
  let queued = 0;
  let lo = Infinity;
  let hi = 0;
  for (const [d, c] of pairs) {
    total += c;
    if (d >= 2) queued += c;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const at = (q) => {
    const target = Math.ceil(q * total);
    let seen = 0;
    for (const [d, c] of pairs) {
      seen += c;
      if (seen >= target) return d;
    }
    return hi;
  };
  const atOne = pairs.filter(([d]) => d <= 1).reduce((a, [, c]) => a + c, 0);
  return {
    dispatches: total,
    p50: total ? at(0.5) : 0,
    p01: total ? at(0.01) : 0,
    min: total ? lo : 0,
    max: hi,
    // The low tail, as a count and not only as a minimum. WITNESSES, never gates: `min` and
    // `atOne` are reported for the reader and no value of either can fail a run. `reply()`
    // decrements G_INFLIGHT before the woken process re-issues (src/kernel/kernel.mjs), so every
    // process has an un-outstanding interval equal to its own wake latency; over hundreds of
    // thousands of dispatches those intervals coincide across all N at least once, which makes
    // depth_min read 1 on a saturated kernel and 1 on a rate-limited one. The count is what says
    // whether a drained backlog was an event or the state of the run.
    atOne,
    atOneFraction: total ? atOne / total : 0,
    queuedFraction: total ? queued / total : 0,
  };
}

/**
 * The anti-vacuity gates. If any of these fails at the N the bar is read at, THE VERDICT IS
 * "NO VERDICT" — not ACCEPT and not KILL — the failing gate is named, and the latency cell prints
 * "withheld". An unloaded p99 is not evidence either way.
 */
export function gates({ n, depth, little, dutyMin, perProcessCalls, rho, overlap, saturated,
  latch, raceAgreement }) {
  const callsMean = perProcessCalls.length
    ? perProcessCalls.reduce((a, b) => a + b, 0) / perProcessCalls.length
    : 0;
  const callsMin = perProcessCalls.length ? Math.min(...perProcessCalls) : 0;
  const rows = [];
  const add = (name, pass, detail) => rows.push({ name, pass, detail, evaluated: true });
  /** A clause whose precondition does not hold this run. It reports, it never blocks a verdict, and
   *  it prints as "n/a" rather than as a pass nobody checked. */
  const skip = (name, detail) => rows.push({ name, pass: true, detail, evaluated: false });

  // THE INSTRUMENT'S OWN BOUND, and an exact one rather than a tolerance: N processes with one
  // outstanding call each cannot put more than N in flight, so a depth above N is not low
  // contention or high contention — it is the device lying, and every other depth clause here is
  // a LOWER bound that such a device satisfies trivially. A kernel that stopped decrementing
  // G_INFLIGHT runs the counter to the top bin and passes A2a, A2b, A7 and A8 while fabricating
  // the saturation they are there to prove.
  add(`A10 depth_max <= N and depth_p50 <= N`, depth.max <= n && depth.p50 <= n,
    `max ${depth.max}, p50 ${depth.p50}, N ${n}`);
  if (n === 1) {
    // The measurement's OWN negative control: the in-flight call is still counted, so a device
    // that reads 16 at N=1 is broken and the run says so.
    add("A0 depth==1 at N=1", depth.p50 === 1 && depth.max === 1,
      `p50 ${depth.p50}, max ${depth.max}`);
    add("A3 little in [0.85,1.05]", little >= 0.85 && little <= 1.05, `little ${little.toFixed(3)}`);
  } else {
    const satFloor = Math.floor(GATE.satFraction * n);
    const medFloor = Math.max(GATE.medianFloor, Math.floor(GATE.medianFraction * n));
    add(`A2a depth_max >= ${GATE.satFraction}N`, depth.max >= satFloor,
      `max ${depth.max} vs ${satFloor}`);
    // The median dispatch, not the minimum. An extreme value over half a million samples certifies
    // nothing about a distribution: depth_min reads 1 on a saturated kernel and 1 on a
    // rate-limited one, so it is a witness below and this is the gate.
    add(`A2b depth_p50 >= max(${GATE.medianFloor}, ${GATE.medianFraction}N)`, depth.p50 >= medFloor,
      `p50 ${depth.p50} vs floor ${medFloor}`);
    if (n >= GATE.queuedMinN) {
      add(`A2c queued_fraction >= ${GATE.queuedFraction}`,
        depth.queuedFraction >= GATE.queuedFraction,
        `q_frac ${depth.queuedFraction.toFixed(3)}`);
    } else {
      skip(`A2c queued_fraction >= ${GATE.queuedFraction}`,
        `not read below N=${GATE.queuedMinN}: the per-process wake-latency gap is too large a `
        + `share of the cycle here (q_frac ${depth.queuedFraction.toFixed(3)})`);
    }
    // The upper bound is an accounting check too: with one outstanding call per process little
    // cannot exceed 1, so little > 1.15 means double counting.
    add("A3 |little-1| <= 0.15", Math.abs(little - 1) <= 0.15, `little ${little.toFixed(3)}`);
    add("A4 estimators agree within 25%",
      Math.abs(depth.p50 - little * n) <= 0.25 * Math.max(depth.p50, little * n),
      `depth_p50 ${depth.p50} vs little*N ${(little * n).toFixed(2)}`);
    add("A5 duty_min >= 0.95 and fairness >= 0.2x mean",
      dutyMin >= 0.95 && callsMin >= 0.2 * callsMean,
      `duty ${dutyMin.toFixed(3)}, calls min/mean ${callsMin}/${callsMean.toFixed(0)}`);
  }
  if (n > 1) {
    // Did the window ever hold N calls at once? Everything below depends on it: the depth
    // histogram the gates read starts at that moment, so if it never came there is no window to
    // read. The rate-limited control is what makes this fail.
    //
    // THE LATCH IS READ, NOT TRUSTED. `saturated` is one boolean the kernel sets when its ramp
    // histogram hands over to the window one, and the threshold it hands over AT is what makes
    // that boolean mean "N outstanding calls" rather than "a dispatch happened". A kernel that
    // latched on the first dispatch sets the same flag and keeps every figure plausible, which
    // leaves this clause asserting a comment — so the target the kernel compared against and the
    // depth it fired at are published and read here.
    add("A8 the window reached N outstanding calls",
      saturated === true && latch !== null && latch !== undefined
        && latch.target === n && latch.depth >= n,
      latch === null || latch === undefined
        ? `saturated ${saturated}, and the kernel published no latch, N ${n}`
        : `saturated ${saturated}, latch target ${latch.target}, fired at depth `
          + `${latch.depth}, N ${n}, after ${depth.dispatches ? "the ramp" : "?"}`);
    // The barrier's own gate, and the one the depth histogram cannot replace: the processes must
    // have been inside their measured windows AT THE SAME TIME. Staggered windows produce a
    // perfectly respectable-looking p99 for a kernel that was never saturated.
    add("A7 windows overlap >= 0.98 of the window",
      overlap !== null && overlap.fraction >= 0.98,
      overlap === null ? "no overlap measured" : `overlap ${(overlap.fraction * 100).toFixed(2)}%`
        + ` (release spread ${overlap.releaseSpreadMs} ms, end spread ${overlap.endSpreadMs} ms)`);
  }
  const a6 = `A6 rho >= ${GATE.rhoFloor.toFixed(2)}`;
  if (n >= GATE.rhoMinN) {
    // Below this the bottleneck is the renderer, not the kernel, and the row is LABELLED rather
    // than quoted.
    add(a6, rho >= GATE.rhoFloor, `rho ${rho.toFixed(3)}`);
  } else {
    // It says so. Printing neither ok nor n/a left this clause absent from every run the headline
    // sweep takes — --hb clamps N=128 to 127 — and a clause that silently vanishes is
    // indistinguishable from one that passed.
    skip(a6, `not read below N=${GATE.rhoMinN} (n=${n}): below that the bottleneck is the `
      + `renderer rather than the kernel, so this utilisation is not evidence about this N `
      + `(rho ${rho.toFixed(3)})`);
  }
  // Constraint 7, as a gate and not only a printed number: the kernel's notify-woke-nobody count
  // and the processes' not-equal count are two counters measuring one event, so they must agree.
  // NO END-TO-END NEGATIVE CONTROL EXISTS for this one — no run has been constructed in which the
  // two genuinely diverge — so what shows it capable of failing is agreementSelfTest() over the
  // pure function. README.md records that honestly.
  if (raceAgreement === null || raceAgreement === undefined) {
    skip(`A9 race agreement >= ${GATE.raceAgreement}`,
      "neither side observed a not-equal event, so there is nothing to agree about");
  } else {
    add(`A9 race agreement >= ${GATE.raceAgreement}`, raceAgreement >= GATE.raceAgreement,
      `agreement ${(raceAgreement * 100).toFixed(1)}%`);
  }
  return {
    rows,
    pass: rows.every((r) => r.pass),
    failed: rows.filter((r) => r.evaluated && !r.pass).map((r) => r.name),
    notEvaluated: rows.filter((r) => !r.evaluated).map((r) => r.name),
  };
}

/**
 * The decision, read at the band's CONSERVATIVE edge. ACCEPT needs p99 + 1 quantum below the
 * accept bar; KILL needs p99 - 1 quantum above the kill bar; between them is INDETERMINATE and
 * the gap is named.
 */
export function verdict({ n, p99, quantumUs, bars, gateResult }) {
  // The bar is read at ONE N and nowhere else. Every other cell is evidence about the shape of
  // the curve, and quoting a verdict off it is how an unloaded number becomes a decision.
  if (n !== bars.bar_n) {
    return { verdict: "NOT THE BAR", why: `the bar is read at N=${bars.bar_n}, not N=${n}` };
  }
  if (!gateResult.pass) {
    return {
      verdict: "NO VERDICT",
      why: `anti-vacuity gate${gateResult.failed.length > 1 ? "s" : ""} failed: `
        + gateResult.failed.join(" · "),
    };
  }
  if (p99.us === null) {
    return { verdict: "NO VERDICT", why: `the p99 is not printable: ${p99.why}` };
  }
  if (p99.us + quantumUs < bars.accept_p99_us) {
    return { verdict: "ACCEPT", why: `p99 ${p99.us.toFixed(1)} us + 1 quantum < ${bars.accept_p99_us} us` };
  }
  if (p99.us - quantumUs > bars.kill_p99_us) {
    return { verdict: "KILL", why: `p99 ${p99.us.toFixed(1)} us - 1 quantum > ${bars.kill_p99_us} us` };
  }
  return {
    verdict: "INDETERMINATE",
    why: `p99 ${p99.us.toFixed(1)} us sits between the ${bars.accept_p99_us} us accept bar and `
      + `the ${bars.kill_p99_us} us kill bar`,
  };
}

/** Every process's quantum must agree, or the cross-agent equal-tick-rate assumption is wrong and
 *  nothing below it is comparable. Detected, not trusted. */
export function quantumGuard(list) {
  const values = [...new Set(list.map((s) => s.quantumMs))];
  const quantumUs = values.length ? values[0] * US : 0;
  if (values.length !== 1) {
    return { ok: false, quantumUs, why: `processes disagree on the clock quantum: ${values.map((v) => (v * US).toFixed(3)).join(", ")} us` };
  }
  if (quantumUs >= QUANTUM_REFUSE_US) {
    return { ok: false, quantumUs, why: `quantum ${quantumUs.toFixed(3)} us >= ${QUANTUM_REFUSE_US} us: too coarse to describe this channel` };
  }
  return { ok: true, quantumUs, offReference: Math.abs(quantumUs - 5) > 1e-9 };
}

/** One cell of the sweep. */
export function summariseCell({ n, samples, kernel, bars, windowMs }) {
  const loops = samples.filter((s) => s.role !== "hb");
  const hists = loops.map((s) => s.samples);
  const guard = quantumGuard(hists);
  const pooled = poolHistograms(hists);
  const quantumUs = guard.quantumUs;

  const meanUs = pooled.count ? (pooled.sum / pooled.count) * US : 0;
  const p50 = cell(pooled, 0.5, MIN_PERCENTILE_SAMPLES);
  const p95 = cell(pooled, 0.95, MIN_PERCENTILE_SAMPLES);
  // The headline and the per-process column, at ONE quantile read from one place. The pooled
  // figure is then checked against the pooled histogram by counting: the constant says which
  // quantile was asked for, the witness says the printed number is that quantile.
  const p99 = cell(pooled, HEADLINE_QUANTILE, MIN_PERCENTILE_SAMPLES);
  const p99Witness = quantileWitness(pooled, HEADLINE_QUANTILE, p99.us);
  const perProcessP99 = hists.map((h) => percentileMs(h, HEADLINE_QUANTILE) ?? 0);
  const worstP99Us = perProcessP99.length ? Math.max(...perProcessP99) * US : 0;

  const depth = depthStats(kernel.depthHist);
  // Little's law, needing no instrumentation. ONLY DURATIONS CROSS AN AGENT BOUNDARY, never
  // instants: timeOrigins differ, but every agent in one renderer ticks at the same rate.
  const lambda = pooled.count / (windowMs / 1000);
  const wMeanS = pooled.count ? (pooled.sum / pooled.count) / 1000 : 0;
  const little = n ? (lambda * wMeanS) / n : 0;
  // The duty cycle: the direct statement of "no offered rate". A process that slept between calls
  // shows below 1.
  const duties = loops.map((s) => (s.measured.spanMs ? s.samples.sum / s.measured.spanMs : 0));
  const dutyMin = duties.length ? Math.min(...duties) : 0;
  const perProcessCalls = loops.map((s) => s.measured.calls);
  // Kernel utilisation, CONFINED TO THE MEASURED WINDOW. The kernel's call counter runs from boot
  // and so covers spawn and warm-up as well; multiplying it by the window gave rho = 1.67 under
  // the stall control, which is not a utilisation. The window-confined call count is the
  // histogram's own sample count, and serviceMeanUs is used as the per-call constant.
  const rho = windowMs ? (kernel.serviceMeanUs * pooled.count) / (windowMs * 1000) : 0;

  const overlap = overlapStats(loops.map((s) => s.barrier), windowMs);

  // The counters, not the histogram snapshot: the out-of-window checks (the MAX_INLINE edges,
  // the forced not-equal probe) are deliberately excluded from the histogram and deliberately
  // included in the accounting identity. Computed before the gates because gate A9 reads the
  // not-equal total.
  const ctr = (s) => s.counters || s.samples;
  const issued = loops.reduce((a, s) => a + ctr(s).issued, 0);
  const returned = loops.reduce((a, s) => a + ctr(s).returned, 0);
  const notEqual = loops.reduce((a, s) => a + ctr(s).notEqual, 0);
  const raceAgreement = agreementFraction(kernel.notify0, notEqual);

  const gateResult = gates({
    n, depth, little, dutyMin, perProcessCalls, rho, overlap,
    saturated: kernel.saturated === true,
    latch: kernel.latch || null,
    raceAgreement,
  });
  const v = verdict({ n, p99, quantumUs, bars, gateResult });

  return {
    n,
    quantumUs,
    quantumGuard: guard,
    count: pooled.count,
    throughputPerS: pooled.count / (windowMs / 1000),
    meanUs,
    p50, p95, p99,
    // The quantile every percentile above was read at, and the counting check on the printed
    // headline. Published rather than assumed: this is the one number the milestone reports.
    p99Quantile: HEADLINE_QUANTILE,
    p99Witness,
    minPercentileSamples: MIN_PERCENTILE_SAMPLES,
    worstP99Us,
    maxUs: pooled.max * US,
    exceedAccept: exceedance(pooled, bars.accept_p99_us),
    depth, little, dutyMin, rho, overlap,
    depthAll: depthStats(kernel.depthHistAll || []),
    // The release ramp, reported rather than discarded: these are the dispatches between the
    // barrier release and the first moment N calls were outstanding at once.
    depthRamp: depthStats(kernel.depthHistRamp || []),
    saturated: kernel.saturated === true,
    latch: kernel.latch || null,
    hbGapKernel: hbGapStats(kernel.hbGap),
    barrier: kernel.barrier || null,
    gates: gateResult,
    ...v,
    accounting: {
      // issued == dispatched == replied == returned, two counters in each agent. Raising the
      // depth device without doing the work breaks this, and a broken identity makes the run
      // INVALID rather than merely suspect.
      issued, returned,
      ok: loops.reduce((a, s) => a + ctr(s).ok, 0),
      dispatched: kernel.calls,
      replied: kernel.perProcess.reduce((a, p) => a + p.replies, 0),
      identity: issued === returned
        && returned === kernel.calls
        && kernel.calls === kernel.perProcess.reduce((a, p) => a + p.replies, 0),
      beyondTop: pooled.beyondTop,
      spurious: loops.reduce((a, s) => a + ctr(s).spurious, 0),
      seqSkip: loops.reduce((a, s) => a + ctr(s).seqSkip, 0),
      timedOutButReplied: loops.reduce((a, s) => a + ctr(s).timedOutButReplied, 0),
      timedOut: loops.reduce((a, s) => a + ctr(s).timedOut, 0),
      hostGone: loops.reduce((a, s) => a + ctr(s).hostGone, 0),
      rlenFault: loops.reduce((a, s) => a + ctr(s).rlenFault, 0),
      notEqual,
      notEqualFraction: issued ? notEqual / issued : 0,
      // Two counters on opposite sides of the boundary measuring one phenomenon: a notify that
      // woke nobody is the same event the process tallies as not-equal (constraint 7).
      notify0: kernel.notify0,
      notifyWoke: kernel.notifyWoke,
      raceAgreement,
      badCallId: kernel.badCallId,
      lateReply: kernel.lateReply,
      dropped: kernel.dropped,
    },
  };
}
