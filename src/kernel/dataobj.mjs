// M10. THE TYPED DATA OBJECT: the clipboard and drag-and-drop, which are one thing twice.
//
// `docs/designs/REVIEW-FINDINGS.md` §2 is the finding this answers, and its sharpest line is not
// about drag at all: `clipboard_write(bytes)` with no format tag "leaves a receiver structurally
// unable to distinguish a pasted PNG from pasted UTF-8". That is an ABI defect rather than a missing
// feature, so the untyped pair is DELETED and this is what replaces it — a kernel-owned, refcounted,
// format-tagged payload reached through an fd (constraints 45, 240).
//
// WHY THE KERNEL OWNS THE PAYLOAD, in one sentence each:
//
//   the clipboard outlives its source      copy in an editor, close the editor, paste in a viewer.
//                                          The object is referenced by the clipboard slot, so the
//                                          source's teardown does not take it (constraint 241)
//   a drag outlives its source             the review's own words: "the payload must be kernel-owned
//                                          so a drag survives the source process entering DYING
//                                          mid-drag". The session holds a reference
//   a published object cannot change       it is SEALED on offer, so two processes reading one
//                                          object cannot be shown different bytes (constraint 242)
//   the gesture is not the page's to decide the page reports WHERE the pointer is; which window is
//                                          the target, whether it may be one, and who gets the drop
//                                          are this file's — the same division M9 made for the
//                                          stack (constraint 226)
//
// WHAT IS A FILE DESCRIPTION AND WHAT IS NOT. The OBJECT is: `F_DATA`, so `close(2)`, `dup(2)`,
// spawn inheritance and reap teardown already release it and a process holds only an integer
// (constraint 15). The CLIPBOARD SLOT and the DRAG SESSION are not — they are one each, kernel-wide,
// and a process reaches them by naming WHERE rather than by holding a handle.

import {
  EINVAL, EBADF, ENOENT, ENOTSUP, EPERM, EBUSY, EMFILE, EFBIG, ENOMEM,
  DOBJ_FMT_MAX, DOBJ_MAX_BYTES, DOBJ_BUDGET_BYTES, DOBJ_CAP, DOBJ_F_APPEND,
  DOBJ_WHERE_CLIPBOARD, DOBJ_WHERE_DRAG, DOBJ_WHERE_DROP,
  DOBJ_EFFECT_COPY, DOBJ_EFFECT_MOVE, DOBJ_TEXT, DRAG_IDLE_MS,
  WEV_DRAG_ENTER, WEV_DRAG_LEAVE, WEV_DROP, WEV_DRAG_DONE,
  fmtBit, fmtsOf, fmtName,
} from "../abi.mjs";

/** Injected at boot, never imported: `kernel.mjs` imports this file and the reverse is a cycle.
 *  The shape `pipe.mjs`, `pty.mjs` and `wins.mjs` all take. `K.wins()` is a GETTER, because the
 *  window table is built after this manager and a captured null would never update. */
let K = null;

export function installDataKernel(surface) {
  K = surface;
}

/**
 * M10's FIRST NEGATIVE CONTROL, boot-gated on bench=1: every object offers TEXT and nothing else,
 * whatever its creator asked for.
 *
 * `PLAN.md` §5's control for M10 in its own words — "offer only the text format; the image paste
 * must fail cleanly, not silently paste a path". It is the whole claim of a TYPED clipboard put the
 * only way round that can fail: an untyped one would hand the receiver the bytes it had and let it
 * guess, and a receiver that guessed would paste a path into an image view (constraint 247).
 */
let typedFormats = true;

export function setTypedFormats(on) {
  typedFormats = !!on;
}

/** M10's SECOND: a drop is never delivered. The session runs, the target highlights, the gesture
 *  ends — and no `WEV_DROP` reaches anybody and no payload is left to collect, so the CLIPBOARD half
 *  must keep working while the DRAG half fails entirely. Two controls because the milestone is two
 *  gestures, which is how M9's pair tells its two halves apart. */
let dropReaches = true;

export function setDropReaches(on) {
  dropReaches = !!on;
}

export class DataObj {
  constructor(id, pid, offer) {
    this.id = id;
    /** The CREATING process. Not an authority — the fd is — but the only way `/proc` can say whose
     *  object is holding the budget. */
    this.pid = pid;
    /** The OFFER: a bitmask of formats, declared once at create and never widened. A target tests
     *  it during the gesture, before any bytes exist, which is what the mask is for. */
    this.offer = offer >>> 0;
    /** format id -> bytes. A format in the offer with nothing set yet answers -ENOENT, which is a
     *  different fact from -ENOTSUP ("never offered") and a program that conflated them would retry
     *  for ever on an object whose source died mid-write. */
    this.payload = new Map();
    /** Published objects are IMMUTABLE. See `DataMgr.seal`. */
    this.sealed = false;
    /** Descriptions, plus the clipboard slot, plus a live drag session, plus any uncollected drop.
     *  Freed at 0 — and the count is of REFERENCES rather than fds, because `dup` and spawn
     *  inheritance share one description (constraint 103's shape). */
    this.refs = 1;
    /** Payload bytes over every format, which is what the budget counts. */
    this.bytes = 0;
    this.stats = { sets: 0, appends: 0, gets: 0, refused: 0, offers: 0, opens: 0 };
  }

  report() {
    return {
      id: this.id,
      pid: this.pid,
      offer: this.offer,
      formats: fmtsOf(this.offer),
      // The format NAMES beside the ids: a reader of `/proc/dataobj` must not have to go to the
      // table to learn what format 3 is.
      names: fmtsOf(this.offer).map(fmtName),
      // What is actually SET, which is not the offer: an object mid-write offers more than it has.
      set: [...this.payload.keys()].sort((a, b) => a - b),
      sizes: Object.fromEntries([...this.payload].map(([f, b]) => [fmtName(f), b.length])),
      sealed: this.sealed,
      refs: this.refs,
      bytes: this.bytes,
      ...this.stats,
    };
  }
}

/**
 * The object table, the one clipboard slot and the one drag session.
 *
 * EVERY RULE HERE IS A FUNCTION OF THE TABLE except the four that post, which is deliberate for the
 * reason `WinMgr`'s walk is: the lifetime arithmetic — who holds a reference, when the budget comes
 * back, what a drop does to a queue that is full — is the part most likely to be got wrong, so it is
 * host-testable without a browser (`bench/m10-data/probe.mjs`).
 */
export class DataMgr {
  constructor() {
    this.byId = new Map();
    this.nextId = 1;
    /** THE CLIPBOARD: one object or null, kernel-wide. Not an fd and not a path — a process names
     *  `DOBJ_WHERE_CLIPBOARD` and gets an fd onto whatever is there. */
    this.clipboard = null;
    /** THE DRAG SESSION: `{obj, srcWin, effects, target, startedMs, lastMs}` or null. One at a
     *  time, because there is one pointer. */
    this.drag = null;
    /** winid -> an object dropped on it and not yet collected. ONE PER WINDOW, newest wins: a
     *  target that ignores its drops must not be able to make the kernel hold payloads for ever. */
    this.pending = new Map();
    /** Payload bytes outstanding across every live object — what `DOBJ_BUDGET_BYTES` bounds. */
    this.bytes = 0;
    this.stats = {
      created: 0, freed: 0, sealed: 0, refusedCap: 0, refusedBudget: 0, refusedBig: 0,
      refusedFormat: 0, refusedSealed: 0, doubleFrees: 0,
      // The clipboard: publishes, opens, and how many times a publish displaced an earlier object.
      copies: 0, pastes: 0, displaced: 0,
      // The drag: sessions begun, refused, targets entered, drops delivered, drops LOST to a full
      // queue, sessions cancelled by the idle bound, and page reports that arrived with no session.
      drags: 0, refusedDrag: 0, enters: 0, leaves: 0, drops: 0, dropsLost: 0,
      cancelled: 0, lateDrags: 0, pendingReplaced: 0, pendingDropped: 0, opensLost: 0,
    };
  }

  get(id) {
    return this.byId.get(id | 0) || null;
  }

  live() {
    return [...this.byId.values()];
  }

  /** A process's objects. O(objects) and asked per `/proc` read, like `WinMgr.ofPid`. */
  ofPid(pid) {
    return this.live().filter((o) => o.pid === pid);
  }

  /**
   * Create an object offering `mask`, or a negative errno.
   *
   * AN EMPTY OFFER IS -EINVAL. An object nothing can ask for is a payload with no readers, and a
   * program that offered nothing by accident — a mask built from format ids it got wrong, which
   * `fmtBit` renders as 0 — must be told at the call rather than at a paste that finds nothing.
   */
  create(pid, mask) {
    /* THE CONTROL IS HERE AND NOT AT THE CALL SITE, so it cuts the OFFER and nothing else: the
     * object is still created, still sealed, still carried, still fetched by format. What
     * disappears is the receiver's ability to ask for an image — which is the one thing a typed
     * clipboard is for. */
    const asked = (typedFormats ? mask : fmtBit(DOBJ_TEXT)) >>> 0;
    // Masked against the table, so a bit nobody defines cannot reach a target as an offer it will
    // then ask for and be refused.
    let offer = 0;
    for (const f of fmtsOf(asked)) offer |= fmtBit(f);
    if (offer === 0) {
      this.stats.refusedFormat += 1;
      return -EINVAL;
    }
    if (this.ofPid(pid).length >= DOBJ_CAP) {
      this.stats.refusedCap += 1;
      return -EMFILE;
    }
    const id = this.nextId;
    this.nextId += 1;
    const obj = new DataObj(id, pid, offer);
    this.byId.set(id, obj);
    this.stats.created += 1;
    return obj;
  }

  /**
   * Write one format's bytes. The count written, or a negative errno.
   *
   * THREE REFUSALS, THREE ERRNOS, and they are three facts a program must be able to tell apart:
   * -ENOTSUP for a format this object never offered, -EPERM for an object that has been published
   * and is therefore immutable, -EFBIG for its own ceiling and -ENOMEM for the system's. A single
   * "it refused" passes for a kernel that refused for the wrong reason (CLAUDE.md §Verification).
   */
  set(obj, format, bytes, flags = 0) {
    const f = format | 0;
    if (f < 1 || f > DOBJ_FMT_MAX) {
      obj.stats.refused += 1;
      this.stats.refusedFormat += 1;
      return -EINVAL;
    }
    if ((obj.offer & fmtBit(f)) === 0) {
      obj.stats.refused += 1;
      this.stats.refusedFormat += 1;
      return -ENOTSUP;
    }
    if (obj.sealed) {
      obj.stats.refused += 1;
      this.stats.refusedSealed += 1;
      return -EPERM;
    }
    const append = (flags & DOBJ_F_APPEND) !== 0;
    const held = obj.payload.get(f);
    const base = append && held ? held.length : 0;
    const want = base + bytes.length;
    // THE OBJECT'S OWN CEILING FIRST, so a program that asked for something impossible is told
    // that rather than being told the system is full.
    if (obj.bytes - (held ? held.length : 0) + want > DOBJ_MAX_BYTES) {
      obj.stats.refused += 1;
      this.stats.refusedBig += 1;
      return -EFBIG;
    }
    if (this.bytes - (held ? held.length : 0) + want > DOBJ_BUDGET_BYTES) {
      // -ENOMEM and not -EAGAIN, for M8's reason: a budget is a ceiling and not a transient, so a
      // caller told to try again would try for ever (constraint 220).
      obj.stats.refused += 1;
      this.stats.refusedBudget += 1;
      return -ENOMEM;
    }
    // A COPY, for the reason `writeCells` makes one: the source is the caller's SAB and the caller
    // may overwrite it the instant its call is answered.
    const next = new Uint8Array(want);
    if (base > 0) next.set(held, 0);
    next.set(bytes, base);
    const delta = next.length - (held ? held.length : 0);
    obj.payload.set(f, next);
    obj.bytes += delta;
    this.bytes += delta;
    if (append) obj.stats.appends += 1; else obj.stats.sets += 1;
    return bytes.length;
  }

  /**
   * Read one format, from `offset`. `{bytes, total}` or a negative errno.
   *
   * `fetch` AND NOT `get`, because `get(id)` above is the table lookup every manager in this kernel
   * has — and two methods of one name in a class body is the LATER one silently replacing the
   * first. It was written that way for an hour: the lookup disappeared, and the first symptom was a
   * TypeError inside a check about something else.
   *
   * THE WINDOW IS THE CALLER'S, NOT THE OBJECT'S: a payload may be larger than one byte region, so
   * `total` travels beside the chunk and the libos loops — which is `write(2)`'s short-count
   * contract read the other way (docs/ABI.md decision 4).
   */
  fetch(obj, format, offset = 0) {
    const f = format | 0;
    if (f < 1 || f > DOBJ_FMT_MAX) {
      obj.stats.refused += 1;
      this.stats.refusedFormat += 1;
      return -EINVAL;
    }
    /* THE REFUSAL THIS MILESTONE IS ABOUT. A format the object never offered is -ENOTSUP, named
     * and specific, so an image view that asked for a bitmap and got a path list refuses out loud
     * instead of rendering a filename as a picture (constraint 247). */
    if ((obj.offer & fmtBit(f)) === 0) {
      obj.stats.refused += 1;
      this.stats.refusedFormat += 1;
      return -ENOTSUP;
    }
    const held = obj.payload.get(f);
    // OFFERED AND NOT YET WRITTEN IS -ENOENT. A different fact from -ENOTSUP: this one may become
    // readable, and that one never will.
    if (!held) {
      obj.stats.refused += 1;
      return -ENOENT;
    }
    const at = offset | 0;
    if (at < 0 || at > held.length) {
      obj.stats.refused += 1;
      return -EINVAL;
    }
    obj.stats.gets += 1;
    return { bytes: held.subarray(at), total: held.length };
  }

  /** Published objects are immutable, and this is the one place that happens. Counted, because
   *  "the clipboard holds an object" and "the object can still be rewritten" are the same picture
   *  until somebody reads the bytes twice (constraint 242). */
  seal(obj) {
    if (obj.sealed) return 0;
    obj.sealed = true;
    this.stats.sealed += 1;
    return 0;
  }

  retain(obj) {
    obj.refs += 1;
    return obj.refs;
  }

  /**
   * Drop one reference, and free the object at zero — which is where the budget comes back.
   *
   * A RELEASE BELOW ZERO IS A KERNEL BUG AND IS COUNTED RATHER THAN APPLIED. Five things hold
   * references — an fd, the clipboard slot, a live session, a pending drop, and the creator before
   * it seats its fd — and the one failure that would not show up anywhere else is a payload
   * released twice: the budget would go NEGATIVE and the next object would be charged against a
   * number that is already wrong. `doubleFrees` is published in `/proc/dataobj`'s report.
   */
  release(obj) {
    if (!obj) return 0;
    if (obj.refs <= 0) {
      this.stats.doubleFrees += 1;
      return 0;
    }
    obj.refs -= 1;
    if (obj.refs > 0) return obj.refs;
    this.bytes -= obj.bytes;
    obj.bytes = 0;
    obj.payload.clear();
    this.byId.delete(obj.id);
    this.stats.freed += 1;
    return 0;
  }

  /**
   * Publish to the clipboard. The old occupant's reference goes, which is how a copy displaces a
   * copy — and the slot's own reference is what makes "copy, quit the program, paste" work: the
   * object outlives every fd its creator held (constraint 241).
   */
  toClipboard(obj) {
    if (this.clipboard === obj) {
      this.seal(obj);
      return 0;
    }
    const old = this.clipboard;
    this.clipboard = obj;
    this.retain(obj);
    this.seal(obj);
    this.stats.copies += 1;
    if (old) {
      this.stats.displaced += 1;
      this.release(old);
    }
    K.post({ t: "clipboard", obj: obj.id, offer: obj.offer, formats: fmtsOf(obj.offer) });
    return 0;
  }

  /**
   * Begin a drag from `win`, carrying `obj`. 0, or a negative errno.
   *
   * THE GESTURE IS GATED ON A BUTTON THE KERNEL SAW GO DOWN, and the gate is not decoration: a
   * program that could start a drag unprompted would hold the one session, refuse every other
   * drag with -EBUSY, and never end — because what ends a session is the page reporting a
   * pointerup that is never coming. `WinMgr.pointer` is written by the pointer events the page
   * already feeds, so the kernel is asking its own records rather than trusting an argument
   * (constraint 244).
   */
  beginDrag(obj, win, effects) {
    const mask = (effects | 0) & (DOBJ_EFFECT_COPY | DOBJ_EFFECT_MOVE);
    if (mask === 0) {
      this.stats.refusedDrag += 1;
      return -EINVAL;
    }
    if (this.drag) {
      // -EBUSY and not -EAGAIN: there is one pointer, and a second drag is a program's mistake
      // rather than a transient to retry.
      this.stats.refusedDrag += 1;
      return -EBUSY;
    }
    const wins = K.wins();
    const pointer = wins ? wins.pointer : null;
    if (!pointer || !pointer.down || pointer.win !== win.id) {
      this.stats.refusedDrag += 1;
      return -EPERM;
    }
    const now = K.now();
    this.drag = { obj, srcWin: win.id, effects: mask, target: 0, startedMs: now, lastMs: now };
    this.retain(obj);
    this.seal(obj);
    this.stats.drags += 1;
    obj.stats.offers += 1;
    K.post({
      t: "win-drag", win: win.id, obj: obj.id, offer: obj.offer,
      formats: fmtsOf(obj.offer), effects: mask,
    });
    return 0;
  }

  /**
   * The window a drag may be delivered to, or null.
   *
   * ONE PLACE DECIDES, and a BLOCKED window is not a target: a drop is input, and a window behind
   * a modal that could still be dropped on would be the same defect as one that could still be
   * dragged around under it (constraint 233). The page hit-tests and reports a winid; whether that
   * winid may receive anything is this line.
   */
  #targetOf(winid) {
    const w = this.#liveWindow(winid);
    if (!w) return null;
    const wins = K.wins();
    if (wins.blockingFor(w)) return null;
    return w;
  }

  /**
   * A window that still exists, WHATEVER a modal is doing to it — which is a different question
   * from "may this be a target", and the LEAVE is why there are two.
   *
   * A CRITIC FOUND THIS: `dragAt` resolved the window it was leaving through `#targetOf`, so a
   * window that was entered and then became BLOCKED mid-drag never got its `WEV_DRAG_LEAVE` — its
   * hover frame stayed on screen for the rest of its life and its own enter/leave counts went
   * permanently out of balance. It is M9's own rule read correctly: an ENTER offers something and
   * is input, so a modal refuses it; a LEAVE is the RETRACTION of something already delivered, and
   * a window that missed it would be wrong about the world once the modal went away
   * (constraint 226).
   */
  #liveWindow(winid) {
    const wins = K.wins();
    if (!wins) return null;
    const w = wins.get(winid | 0);
    if (!w || w.destroyed || !w.attached) return null;
    return w;
  }

  /**
   * The page reports where the pointer is during a drag. Returns the current target's winid.
   *
   * ENTER AND LEAVE ARE EDGES AND THERE IS NO `OVER`: a drag is a pointer with a button down, so an
   * event per motion sample would stream 256 records — one `WIN_EVENT_CAP` — in about a second, and
   * `push` drops the NEWEST, which is the DROP itself (constraint 243). So this is called on every
   * sample and posts nothing unless the target CHANGED.
   */
  dragAt(winid, x = 0, y = 0) {
    if (!this.drag) {
      this.stats.lateDrags += 1;
      return 0;
    }
    this.drag.lastMs = K.now();
    const target = this.#targetOf(winid);
    const id = target ? target.id : 0;
    if (id === this.drag.target) return id;
    // `#liveWindow` AND NOT `#targetOf`: a window that became blocked after it was entered must
    // still be told the pointer left it. See the docstring there.
    const was = this.drag.target ? this.#liveWindow(this.drag.target) : null;
    if (was) {
      was.push({ type: WEV_DRAG_LEAVE });
      this.stats.leaves += 1;
    }
    this.drag.target = id;
    if (target) {
      target.push({ type: WEV_DRAG_ENTER, a: x | 0, b: y | 0, c: this.drag.obj.offer });
      this.stats.enters += 1;
    }
    /* THE PAGE RENDERS THE TARGET IT IS HANDED, for the reason it renders the stack it is handed:
     * it hit-tested, but the kernel is the side that knows a window is blocked, so a highlight the
     * page decided for itself would promise a drop that will not happen (constraint 226). */
    K.post({ t: "win-drag-target", win: id });
    return id;
  }

  /**
   * The page reports a pointer release. Returns the effect that took place — 0 for nothing.
   *
   * THE PAYLOAD IS NOT RETAINED IF THE EVENT DID NOT QUEUE. A target whose queue is full drops its
   * NEWEST event, which would be this drop — so retaining the object for a collection that can
   * never happen would hold the budget until that window died. The honest answer is the one a
   * source can act on: nothing was dropped, effect 0 (constraint 245).
   */
  dragDrop(winid, x = 0, y = 0) {
    if (!this.drag) {
      this.stats.lateDrags += 1;
      return 0;
    }
    const { obj, effects } = this.drag;
    const target = dropReaches ? this.#targetOf(winid) : null;
    let effect = 0;
    if (target) {
      const queued = target.push({ type: WEV_DROP, a: x | 0, b: y | 0, c: obj.offer });
      if (queued) {
        const old = this.pending.get(target.id);
        if (old) {
          // NEWEST WINS, and the old one's reference goes with it: a target that ignores its drops
          // must not be able to make the kernel hold payloads for ever.
          this.stats.pendingReplaced += 1;
          this.release(old);
        }
        this.pending.set(target.id, obj);
        this.retain(obj);
        // WHICH EFFECT, with no negotiation to ask: the source's own preference order, COPY before
        // MOVE. A target cannot answer "a copy but not a move" because nothing here has two
        // answers yet — see MILESTONES' M10 "what is not done".
        effect = (effects & DOBJ_EFFECT_COPY) ? DOBJ_EFFECT_COPY : DOBJ_EFFECT_MOVE;
        this.stats.drops += 1;
      } else {
        this.stats.dropsLost += 1;
      }
    }
    this.#endDrag(effect, target ? target.id : 0, "drop");
    return effect;
  }

  /** Cancel a live session: a pointer that stopped reporting, or a page shutting down. The source
   *  is told effect 0, which is the same answer a drop on nothing gives — a source must not have to
   *  distinguish "you missed" from "the gesture died". */
  cancelDrag(why = "cancelled") {
    if (!this.drag) return 0;
    this.stats.cancelled += 1;
    this.#endDrag(0, 0, why);
    return 1;
  }

  /**
   * End the session: tell the source, release the session's reference, post the end.
   *
   * THE SOURCE MAY BE GONE AND THAT IS NOT AN ERROR. A source window destroyed mid-drag is exactly
   * the case the review asked for — "the payload must be kernel-owned so a drag survives the source
   * process entering DYING mid-drag" — so the drop above has already happened and the only thing
   * lost is the notification nobody is left to read.
   */
  #endDrag(effect, targetId, why) {
    const session = this.drag;
    this.drag = null;
    /* A TARGET THAT WAS ENTERED AND GOT NO DROP IS TOLD THE POINTER LEFT, and this is the second
     * instance of the defect a critic found one function up: an idle cancellation, or a drop whose
     * event could not queue, used to end the session while the target still believed the pointer
     * was over it — so its hover frame stayed on screen for the rest of its life. A DROP is itself
     * terminal, so the LEAVE is sent only when no drop reached that window. */
    if (session.target && !(effect !== 0 && targetId === session.target)) {
      const over = this.#liveWindow(session.target);
      if (over) {
        over.push({ type: WEV_DRAG_LEAVE });
        this.stats.leaves += 1;
      }
    }
    const wins = K.wins();
    const src = wins ? wins.get(session.srcWin) : null;
    if (src && !src.destroyed) {
      src.push({ type: WEV_DRAG_DONE, a: effect, b: targetId | 0 });
    }
    // The last thing done, because releasing may free the object and the posts above read its id.
    K.post({
      t: "win-drag-end", win: session.srcWin, obj: session.obj.id,
      effect, target: targetId | 0, why,
    });
    this.release(session.obj);
    return 0;
  }

  /**
   * An fd onto the clipboard's object, or onto an uncollected drop. The object, or a negative
   * errno. The caller's reference is taken HERE; `calls.mjs` releases it if the fd cannot be made.
   *
   * A DROP IS ONE-SHOT. The pending reference is handed to the opener, so a target cannot re-open a
   * drop it has already collected — and a drop nobody collects is released when the window goes.
   */
  openFrom(where, win = null) {
    if (where === DOBJ_WHERE_CLIPBOARD) {
      if (!this.clipboard) return -ENOENT;
      this.retain(this.clipboard);
      this.clipboard.stats.opens += 1;
      this.stats.pastes += 1;
      return this.clipboard;
    }
    if (where === DOBJ_WHERE_DROP) {
      if (!win) return -EBADF;
      const obj = this.pending.get(win.id);
      if (!obj) return -ENOENT;
      this.pending.delete(win.id);
      /* THE PENDING REFERENCE BECOMES THE OPENER'S, so nothing is retained and nothing released:
       * the map held one reference, the fd will hold it, and a retain/release pair around a
       * hand-off is two chances to get the count wrong. `calls.mjs` releases it if the fd cannot
       * be made, which is the same contract as the clipboard arm above. */
      obj.stats.opens += 1;
      return obj;
    }
    // DRAG is a publish destination and not a source, and a selector nobody serves is -EINVAL
    // rather than 0: a caller checking the return would read a no-op as an object.
    return -EINVAL;
  }

  /** A window is going: its uncollected drop is released, and a drag it was the TARGET of loses its
   *  target. A session whose SOURCE window went is NOT cancelled — the payload is the kernel's and
   *  the drop must still land (constraint 241). */
  windowGone(winid) {
    const id = winid | 0;
    const obj = this.pending.get(id);
    if (obj) {
      this.pending.delete(id);
      this.stats.pendingDropped += 1;
      this.release(obj);
    }
    if (this.drag && this.drag.target === id) this.drag.target = 0;
    return 0;
  }

  /**
   * Per-heartbeat. Cancels a session whose pointer has stopped reporting, and returns the ms it had
   * been idle — or -1 for "nothing to do", which is the ordinary case.
   *
   * IT BOUNDS IDLE TIME AND NOT THE GESTURE, which is constraint 239's correction made before the
   * same mistake happens twice: a slow drag across a desktop re-arms this on every motion sample,
   * and what it catches is a session whose pointer is gone.
   */
  tick() {
    if (!this.drag) return -1;
    const idle = K.now() - this.drag.lastMs;
    if (idle < DRAG_IDLE_MS) return -1;
    this.cancelDrag(`no pointer report in ${Math.round(idle)} ms`);
    return Math.round(idle);
  }

  report() {
    return {
      ...this.stats,
      bytes: this.bytes,
      rows: this.byId.size,
      nextId: this.nextId,
      clipboard: this.clipboard
        ? { obj: this.clipboard.id, formats: fmtsOf(this.clipboard.offer).map(fmtName) }
        : null,
      drag: this.drag
        ? {
          obj: this.drag.obj.id, win: this.drag.srcWin, target: this.drag.target,
          effects: this.drag.effects, idleMs: Math.round(K.now() - this.drag.lastMs),
        }
        : null,
      pending: [...this.pending].map(([win, obj]) => ({ win, obj: obj.id })),
      objects: this.live().map((o) => o.report()),
    };
  }
}

/** The errnos this module answers, named so a reader of `calls.mjs` does not have to re-derive
 *  which refusal means what. Exported for the host probe, which asserts on the names. */
export const DATA_ERRNOS = Object.freeze({
  EINVAL, EBADF, ENOENT, ENOTSUP, EPERM, EBUSY, EMFILE, EFBIG, ENOMEM,
});
