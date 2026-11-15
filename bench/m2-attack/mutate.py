#!/usr/bin/env python3
"""Apply one mutation to a scratch copy. Exits non-zero if the anchor text is not unique."""
import pathlib
import sys

ROOT = pathlib.Path("/Users/chafyni/.claude/jobs/e856c39e/tmp/mut")

MUTATIONS = {
    # 1. The caller reseeds on a refusal: MOUNT_REFUSE is treated as MOUNT_FRESH.
    "m1_reseed": [(
        "src/kernel/store.mjs",
        "    if (report.mountable === MOUNT_REFUSE) {\n"
        "      this.mode = MOUNT_REFUSE;\n"
        "      return this.report;\n"
        "    }",
        "    if (report.mountable === MOUNT_REFUSE) {\n"
        "      this.vfs = new VFS({ owner: { uid: 0, gid: 0 } });\n"
        "      this.mode = MOUNT_FRESH;\n"
        "      await this.writeSnapshot();\n"
        "      this.mode = MOUNT_RW;\n"
        "      return this.report;\n"
        "    }",
    )],
    # 2. The swing happens before the blob flush: journal + flush, then flush the blob.
    "m2_swing_before_flush": [(
        "src/kernel/store.mjs",
        "    // 1. the blob, 2. its flush. Durable BEFORE anything points at it.\n"
        "    if (!this.cfg.noCowOrder) {\n"
        "      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n"
        "      if (flushed < 0) return flushed;\n"
        "      this.stats.blobFlushes += 1;\n"
        "    }\n"
        "\n"
        "    // 3. the journal record, 4. its flush.\n"
        "    const appended = await this.journal(op);\n"
        "    if (appended < 0) return appended;\n"
        "    const jflush = await this.flushJournal();\n"
        "    if (jflush < 0) return jflush;\n",
        "    // MUTATION: journal first, blob flush after. The ordering is inverted.\n"
        "    const appended = await this.journal(op);\n"
        "    if (appended < 0) return appended;\n"
        "    const jflush = await this.flushJournal();\n"
        "    if (jflush < 0) return jflush;\n"
        "    if (!this.cfg.noCowOrder) {\n"
        "      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n"
        "      if (flushed < 0) return flushed;\n"
        "      this.stats.blobFlushes += 1;\n"
        "    }\n",
    ), (
        # The commit body as it reads now: the in-memory validation sits between the two
        # flushes, and the replacement leaves it exactly where it is.
        "src/kernel/store.mjs",
        '    // 1. the blob, 2. its flush. Durable BEFORE anything points at it.\n    if (!this.cfg.noCowOrder) {\n      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n      if (flushed < 0) return flushed;\n      this.stats.blobFlushes += 1;\n    }\n\n    // 3. VALIDATE, by applying in memory. The apply IS the validation — `vfs.applyOp` refuses an\n    // op that cannot be applied to this state rather than guessing — so the journal below only\n    // ever receives a record the VFS accepted.\n    try {\n      this.vfs.applyOp(op);\n    } catch (error) {\n      return errnoOfFsError(error);\n    }\n\n    // 4. the journal record, 5. its flush.\n    const appended = await this.journal(op);\n    if (appended < 0) return appended;\n    const jflush = await this.flushJournal();\n    if (jflush < 0) return jflush;\n',
        '    // MUTATION: validate, journal, journal flush, and only THEN flush the blob,\n    // so the record on disk points at data that is not durable.\n    // 3. VALIDATE, by applying in memory. The apply IS the validation — `vfs.applyOp` refuses an\n    // op that cannot be applied to this state rather than guessing — so the journal below only\n    // ever receives a record the VFS accepted.\n    try {\n      this.vfs.applyOp(op);\n    } catch (error) {\n      return errnoOfFsError(error);\n    }\n\n    // 4. the journal record, 5. its flush.\n    const appended = await this.journal(op);\n    if (appended < 0) return appended;\n    const jflush = await this.flushJournal();\n    if (jflush < 0) return jflush;\n    if (!this.cfg.noCowOrder) {\n      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n      if (flushed < 0) return flushed;\n      this.stats.blobFlushes += 1;\n    }\n',
    ), (
        # The commit body after the point-of-use refactor: the base is read now, the staged
        # blob goes with a refused commit, and the validation still sits between the two
        # flushes. The replacement moves the BLOB flush to the end and nothing else.
        "src/kernel/store.mjs",
        '    // 1. the blob, 2. its flush. Durable BEFORE anything points at it.\n    if (!this.cfg.noCowOrder) {\n      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n      if (flushed < 0) {\n        if (staging) await this.dropStaging(d);\n        return flushed;\n      }\n      this.stats.blobFlushes += 1;\n    }\n\n    // 3. VALIDATE, by applying in memory. The apply IS the validation — `vfs.applyOp` refuses an\n    // op that cannot be applied to this state rather than guessing — so the journal below only\n    // ever receives a record the VFS accepted.\n    try {\n      this.vfs.applyOp(op);\n    } catch (error) {\n      // THE STAGED BLOB GOES WITH THE REFUSAL, and the refusal is NAMED. Nothing will ever\n      // publish this generation now, and a staged blob nobody frees is on disk for the life of\n      // the volume. The errno goes back to the caller — including to `close()`, which must not\n      // report success for a commit that was refused.\n      this.stats.refusedCommits += 1;\n      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `\n        + `${(error && error.message) || error}`);\n      const errno = errnoOfFsError(error);\n      if (staging) await this.dropStaging(d);\n      return errno;\n    }\n\n    // 4. the journal record, 5. its flush.\n    const appended = await this.journal(op);\n    if (appended < 0) return appended;\n    const jflush = await this.flushJournal();\n    if (jflush < 0) return jflush;\n',
        '    // MUTATION: validate, journal, journal flush, and only THEN flush the blob, so the\n    // record on disk points at data that is not durable.\n    // 3. VALIDATE, by applying in memory. The apply IS the validation — `vfs.applyOp` refuses an\n    // op that cannot be applied to this state rather than guessing — so the journal below only\n    // ever receives a record the VFS accepted.\n    try {\n      this.vfs.applyOp(op);\n    } catch (error) {\n      // THE STAGED BLOB GOES WITH THE REFUSAL, and the refusal is NAMED. Nothing will ever\n      // publish this generation now, and a staged blob nobody frees is on disk for the life of\n      // the volume. The errno goes back to the caller — including to `close()`, which must not\n      // report success for a commit that was refused.\n      this.stats.refusedCommits += 1;\n      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `\n        + `${(error && error.message) || error}`);\n      const errno = errnoOfFsError(error);\n      if (staging) await this.dropStaging(d);\n      return errno;\n    }\n\n    // 4. the journal record, 5. its flush.\n    const appended = await this.journal(op);\n    if (appended < 0) return appended;\n    const jflush = await this.flushJournal();\n    if (jflush < 0) return jflush;\n    if (!this.cfg.noCowOrder) {\n      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n      if (flushed < 0) {\n        if (staging) await this.dropStaging(d);\n        return flushed;\n      }\n      this.stats.blobFlushes += 1;\n    }\n\n',
    ), (
        # The commit body after the compare-and-swap landed: the CAS validation and the
        # staged-length assertion sit around the two flushes, and the replacement moves
        # the BLOB flush to the end and nothing else.
        "src/kernel/store.mjs",
        '    // 1. the blob, 2. its flush. Durable BEFORE anything points at it.\n    if (!this.cfg.noCowOrder) {\n      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n      if (flushed < 0) {\n        if (staging) await this.dropStaging(d);\n        return flushed;\n      }\n      this.stats.blobFlushes += 1;\n    }\n\n    // 3a. THE COMPARE-AND-SWAP\'S VALIDATION STEP, and it is not redundant with `applyOp`\'s\n    // generation check below.\n    //\n    // WHAT THIS ASSERTS: that the base this op was computed against is STILL the inode\'s current\n    // state — the generation the copy-up copied from, and how far that generation\'s bytes reached\n    // when it did. A staged generation is a speculative whole-file copy, and a speculative copy is\n    // only valid if nothing moved underneath it.\n    //\n    // WHAT `applyOp` ASSERTS (`op.gen < inode.gen`): that a generation never moves BACKWARDS.\n    // Monotonicity, not currency. It passes happily when the inode is on generation 1, this op\n    // names generation 2, and another description published four fsynced bytes into generation 1\n    // between the copy-up and here — measured, and the result was those four bytes reverted with\n    // `pwrite`, `fsync` and `close` all returning 0 and fsck reporting the volume clean. THE TWO\n    // CHECKS ARE DIFFERENT ASSERTIONS AND NEITHER COVERS THE OTHER. Do not delete this one.\n    //\n    // AND IT IS A SWAP, not a check followed by a swap: `resolve` is the last `await` before\n    // `applyOp`, which is synchronous, so no other operation can interleave between the compare\n    // and the publish. Putting an `await` between these two lines breaks the primitive.\n    const now = await this.resolve(d.ino);\n    if (typeof now === "number") {\n      if (staging) await this.dropStaging(d);\n      return now;\n    }\n    if (moved(base, now)) return REBASE;\n\n    // 3b. VALIDATE, by applying in memory. The apply IS the validation — `vfs.applyOp` refuses an\n    // op that cannot be applied to this state rather than guessing — so the journal below only\n    // ever receives a record the VFS accepted.\n    try {\n      this.vfs.applyOp(op);\n    } catch (error) {\n      // THE STAGED BLOB GOES WITH THE REFUSAL, and the refusal is NAMED. Nothing will ever\n      // publish this generation now, and a staged blob nobody frees is on disk for the life of\n      // the volume. The errno goes back to the caller — including to `close()`, which must not\n      // report success for a commit that was refused.\n      this.stats.refusedCommits += 1;\n      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `\n        + `${(error && error.message) || error}`);\n      const errno = errnoOfFsError(error);\n      if (staging) await this.dropStaging(d);\n      return errno;\n    }\n\n    // 4. the journal record, 5. its flush.\n    const appended = await this.journal(op);\n    if (appended < 0) return appended;\n    const jflush = await this.flushJournal();\n    if (jflush < 0) return jflush;\n',
        '    // MUTATION: validate, journal, journal flush, and only THEN flush the blob, so the\n    // record on disk points at data that is not durable.\n    // 3a. THE COMPARE-AND-SWAP\'S VALIDATION STEP, and it is not redundant with `applyOp`\'s\n    // generation check below.\n    //\n    // WHAT THIS ASSERTS: that the base this op was computed against is STILL the inode\'s current\n    // state — the generation the copy-up copied from, and how far that generation\'s bytes reached\n    // when it did. A staged generation is a speculative whole-file copy, and a speculative copy is\n    // only valid if nothing moved underneath it.\n    //\n    // WHAT `applyOp` ASSERTS (`op.gen < inode.gen`): that a generation never moves BACKWARDS.\n    // Monotonicity, not currency. It passes happily when the inode is on generation 1, this op\n    // names generation 2, and another description published four fsynced bytes into generation 1\n    // between the copy-up and here — measured, and the result was those four bytes reverted with\n    // `pwrite`, `fsync` and `close` all returning 0 and fsck reporting the volume clean. THE TWO\n    // CHECKS ARE DIFFERENT ASSERTIONS AND NEITHER COVERS THE OTHER. Do not delete this one.\n    //\n    // AND IT IS A SWAP, not a check followed by a swap: `resolve` is the last `await` before\n    // `applyOp`, which is synchronous, so no other operation can interleave between the compare\n    // and the publish. Putting an `await` between these two lines breaks the primitive.\n    const now = await this.resolve(d.ino);\n    if (typeof now === "number") {\n      if (staging) await this.dropStaging(d);\n      return now;\n    }\n    if (moved(base, now)) return REBASE;\n\n    // 3b. VALIDATE, by applying in memory. The apply IS the validation — `vfs.applyOp` refuses an\n    // op that cannot be applied to this state rather than guessing — so the journal below only\n    // ever receives a record the VFS accepted.\n    try {\n      this.vfs.applyOp(op);\n    } catch (error) {\n      // THE STAGED BLOB GOES WITH THE REFUSAL, and the refusal is NAMED. Nothing will ever\n      // publish this generation now, and a staged blob nobody frees is on disk for the life of\n      // the volume. The errno goes back to the caller — including to `close()`, which must not\n      // report success for a commit that was refused.\n      this.stats.refusedCommits += 1;\n      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `\n        + `${(error && error.message) || error}`);\n      const errno = errnoOfFsError(error);\n      if (staging) await this.dropStaging(d);\n      return errno;\n    }\n\n    // 4. the journal record, 5. its flush.\n    const appended = await this.journal(op);\n    if (appended < 0) return appended;\n    const jflush = await this.flushJournal();\n    if (jflush < 0) return jflush;\n    if (!this.cfg.noCowOrder) {\n      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n      if (flushed < 0) {\n        if (staging) await this.dropStaging(d);\n        return flushed;\n      }\n      this.stats.blobFlushes += 1;\n    }\n',
    ), (
        # GENERATED by retarget8.py against the commit body of this round. Do not edit by
        # hand: re-run the generator instead.
        "src/kernel/store.mjs",
        '    // 1. the blob, 2. its flush. Durable BEFORE anything points at it.\n    if (!this.cfg.noCowOrder) {\n      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n      if (flushed < 0) {\n        if (staging) await this.dropStaging(d);\n        return flushed;\n      }\n      this.stats.blobFlushes += 1;\n    }\n\n    // 3a. THE COMPARE-AND-SWAP\'S VALIDATION STEP, and it is not redundant with `applyOp`\'s\n    // generation check below.\n    //\n    // WHAT THIS ASSERTS: that the base this op was computed against is STILL the inode\'s current\n    // state — the generation the copy-up copied from, and how far that generation\'s bytes reached\n    // when it did. A staged generation is a speculative whole-file copy, and a speculative copy is\n    // only valid if nothing moved underneath it.\n    //\n    // WHAT `applyOp` ASSERTS (`op.gen < inode.gen`): that a generation never moves BACKWARDS.\n    // Monotonicity, not currency. It passes happily when the inode is on generation 1, this op\n    // names generation 2, and another description published four fsynced bytes into generation 1\n    // between the copy-up and here — measured, and the result was those four bytes reverted with\n    // `pwrite`, `fsync` and `close` all returning 0 and fsck reporting the volume clean. THE TWO\n    // CHECKS ARE DIFFERENT ASSERTIONS AND NEITHER COVERS THE OTHER. Do not delete this one.\n    //\n    // AND IT IS A SWAP, not a check followed by a swap: `resolve` is the last `await` before\n    // `applyOp`, which is synchronous, so no other operation can interleave between the compare\n    // and the publish. Putting an `await` between these two lines breaks the primitive.\n    const now = await this.resolve(d.ino);\n    if (typeof now === "number") {\n      if (staging) await this.dropStaging(d);\n      return now;\n    }\n    if (moved(base, now)) return REBASE;\n\n    // 3b. VALIDATE, by applying in memory. The apply IS the validation — `vfs.applyOp` refuses an\n    // op that cannot be applied to this state rather than guessing — so the journal below only\n    // ever receives a record the VFS accepted.\n    //\n    // THE STATE THIS APPLY MOVES IS TAKEN FIRST, because the apply is also a PUBLISH and the\n    // record that makes it durable is two awaits away. An append that refuses leaves the tree\n    // holding a generation and a size no record names, and this is what puts them back.\n    let before;\n    try {\n      before = this.vfs.commitState(op.ino);\n      this.vfs.applyOp(op);\n    } catch (error) {\n      // THE STAGED BLOB GOES WITH THE REFUSAL, and the refusal is NAMED. Nothing will ever\n      // publish this generation now, and a staged blob nobody frees is on disk for the life of\n      // the volume. The errno goes back to the caller — including to `close()`, which must not\n      // report success for a commit that was refused.\n      this.stats.refusedCommits += 1;\n      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `\n        + `${(error && error.message) || error}`);\n      const errno = errnoOfFsError(error);\n      if (staging) await this.dropStaging(d);\n      return errno;\n    }\n\n    // 4. the journal record, 5. its flush.\n    //\n    // AN APPEND THAT REFUSED TAKES THE APPLY WITH IT. The record is not in the file and its\n    // sequence is burned (see `journal`), so nothing will ever name this generation: left applied,\n    // the kernel publishes a size `write` and `fsync` were both told had failed, the next mount\n    // replays a journal with no record of it, and the in-memory tree, the journal and the volume\n    // are three different answers. The staged generation is KEPT, for the same reason -EBUSY keeps\n    // it: a caller retrying is the correct response and the retry can still publish.\n    const appended = await this.journal(op);\n    if (appended < 0) {\n      // THE UNDO ITSELF CAN REFUSE, and the one way it does is that the inode WENT while the\n      // append was in flight: `unlink` takes no inode lock, because a metadata op changes no\n      // generation and no published size. There is then no publish left to undo — the inode and\n      // everything it published left the tree together — so this is reported and not raised. An\n      // exception here would turn a named I/O failure into a bare -EIO out of `later`.\n      try {\n        this.vfs.revertCommit(op.ino, before);\n      } catch (error) {\n        this.note(`commit of inode ${op.ino} generation ${op.gen} could not be journalled (errno `\n          + `${-appended}) and its publish could not be undone: `\n          + `${(error && error.message) || error}`);\n        return appended;\n      }\n      this.note(`commit of inode ${op.ino} generation ${op.gen} could not be journalled (errno `\n        + `${-appended}); the publish was undone in memory, so nothing reports a size no record `\n        + "names");\n      return appended;\n    }\n    // THE FLUSH IS DIFFERENT FROM THE APPEND AND IS NOT UNDONE. `append` wrote the record into the\n    // journal file; only its durability past this agent is in question, which is precisely what\n    // POSIX lets `fsync` report and a caller retry. Reverting here would leave a record on disk\n    // that the running kernel\'s tree denies — the same disagreement pointing the other way — so\n    // the swing below COMPLETES and the errno is returned after it.\n    //\n    // RETURNING EARLY IS THE THIRD OPTION AND IT IS THE WORST, by inspection rather than by\n    // measurement: it leaves the inode published while the handle row still points at the\n    // superseded blob and the description still holds the new generation as its PRIVATE stage, so\n    // that description\'s next write goes in place into bytes the metadata has already published.\n    const jflush = await this.flushJournal();\n    this.stats.swings += 1;\n',
        '    // MUTATION: the blob\'s flush is moved to AFTER the journal record and its flush, so\n    // the record on disk points at data that is not durable.\n\n    // 3a. THE COMPARE-AND-SWAP\'S VALIDATION STEP, and it is not redundant with `applyOp`\'s\n    // generation check below.\n    //\n    // WHAT THIS ASSERTS: that the base this op was computed against is STILL the inode\'s current\n    // state — the generation the copy-up copied from, and how far that generation\'s bytes reached\n    // when it did. A staged generation is a speculative whole-file copy, and a speculative copy is\n    // only valid if nothing moved underneath it.\n    //\n    // WHAT `applyOp` ASSERTS (`op.gen < inode.gen`): that a generation never moves BACKWARDS.\n    // Monotonicity, not currency. It passes happily when the inode is on generation 1, this op\n    // names generation 2, and another description published four fsynced bytes into generation 1\n    // between the copy-up and here — measured, and the result was those four bytes reverted with\n    // `pwrite`, `fsync` and `close` all returning 0 and fsck reporting the volume clean. THE TWO\n    // CHECKS ARE DIFFERENT ASSERTIONS AND NEITHER COVERS THE OTHER. Do not delete this one.\n    //\n    // AND IT IS A SWAP, not a check followed by a swap: `resolve` is the last `await` before\n    // `applyOp`, which is synchronous, so no other operation can interleave between the compare\n    // and the publish. Putting an `await` between these two lines breaks the primitive.\n    const now = await this.resolve(d.ino);\n    if (typeof now === "number") {\n      if (staging) await this.dropStaging(d);\n      return now;\n    }\n    if (moved(base, now)) return REBASE;\n\n    // 3b. VALIDATE, by applying in memory. The apply IS the validation — `vfs.applyOp` refuses an\n    // op that cannot be applied to this state rather than guessing — so the journal below only\n    // ever receives a record the VFS accepted.\n    //\n    // THE STATE THIS APPLY MOVES IS TAKEN FIRST, because the apply is also a PUBLISH and the\n    // record that makes it durable is two awaits away. An append that refuses leaves the tree\n    // holding a generation and a size no record names, and this is what puts them back.\n    let before;\n    try {\n      before = this.vfs.commitState(op.ino);\n      this.vfs.applyOp(op);\n    } catch (error) {\n      // THE STAGED BLOB GOES WITH THE REFUSAL, and the refusal is NAMED. Nothing will ever\n      // publish this generation now, and a staged blob nobody frees is on disk for the life of\n      // the volume. The errno goes back to the caller — including to `close()`, which must not\n      // report success for a commit that was refused.\n      this.stats.refusedCommits += 1;\n      this.note(`commit of inode ${d.ino} generation ${op.gen} over ${at.gen} was refused: `\n        + `${(error && error.message) || error}`);\n      const errno = errnoOfFsError(error);\n      if (staging) await this.dropStaging(d);\n      return errno;\n    }\n\n    // 4. the journal record, 5. its flush.\n    //\n    // AN APPEND THAT REFUSED TAKES THE APPLY WITH IT. The record is not in the file and its\n    // sequence is burned (see `journal`), so nothing will ever name this generation: left applied,\n    // the kernel publishes a size `write` and `fsync` were both told had failed, the next mount\n    // replays a journal with no record of it, and the in-memory tree, the journal and the volume\n    // are three different answers. The staged generation is KEPT, for the same reason -EBUSY keeps\n    // it: a caller retrying is the correct response and the retry can still publish.\n    const appended = await this.journal(op);\n    if (appended < 0) {\n      // THE UNDO ITSELF CAN REFUSE, and the one way it does is that the inode WENT while the\n      // append was in flight: `unlink` takes no inode lock, because a metadata op changes no\n      // generation and no published size. There is then no publish left to undo — the inode and\n      // everything it published left the tree together — so this is reported and not raised. An\n      // exception here would turn a named I/O failure into a bare -EIO out of `later`.\n      try {\n        this.vfs.revertCommit(op.ino, before);\n      } catch (error) {\n        this.note(`commit of inode ${op.ino} generation ${op.gen} could not be journalled (errno `\n          + `${-appended}) and its publish could not be undone: `\n          + `${(error && error.message) || error}`);\n        return appended;\n      }\n      this.note(`commit of inode ${op.ino} generation ${op.gen} could not be journalled (errno `\n        + `${-appended}); the publish was undone in memory, so nothing reports a size no record `\n        + "names");\n      return appended;\n    }\n    // THE FLUSH IS DIFFERENT FROM THE APPEND AND IS NOT UNDONE. `append` wrote the record into the\n    // journal file; only its durability past this agent is in question, which is precisely what\n    // POSIX lets `fsync` report and a caller retry. Reverting here would leave a record on disk\n    // that the running kernel\'s tree denies — the same disagreement pointing the other way — so\n    // the swing below COMPLETES and the errno is returned after it.\n    //\n    // RETURNING EARLY IS THE THIRD OPTION AND IT IS THE WORST, by inspection rather than by\n    // measurement: it leaves the inode published while the handle row still points at the\n    // superseded blob and the description still holds the new generation as its PRIVATE stage, so\n    // that description\'s next write goes in place into bytes the metadata has already published.\n    const jflush = await this.flushJournal();\n    if (!this.cfg.noCowOrder) {\n      const flushed = await this.io.request(IO_FSYNC, { id: blobId });\n      if (flushed < 0) {\n        if (staging) await this.dropStaging(d);\n        return flushed;\n      }\n      this.stats.blobFlushes += 1;\n    }\n    this.stats.swings += 1;\n',
    )],
    # 3. free() ignores the per-inode refcount: the directory decides, not the table.
    "m3_refcount_ignored": [(
        "src/kernel/io-worker.mjs",
        "  const entry = byName.get(key);\n  if (entry && entry.refs > 0) {",
        "  const entry = byName.get(key);\n  if (false && entry && entry.refs > 0) {",
    ), (
        # The refcount arbitration moved into src/kernel/iocore.mjs, which io-worker.mjs and
        # io-inline.mjs now both host: one copy instead of two hand-synced ones.
        "src/kernel/iocore.mjs",
        "    const entry = byName.get(key);\n    if (entry && entry.refs > 0) {",
        "    const entry = byName.get(key);\n    if (false && entry && entry.refs > 0) {",
    )],
    # 4. The credential is ignored on every mode check.
    "m4_cred_ignored": [(
        "src/fs/vfs.mjs",
        "  #may(cred, inode, bits) {\n    if (cred.uid === 0) {",
        "  #may(cred, inode, bits) {\n    if (true) return true;\n    if (cred.uid === 0) {",
    )],
    # 5. The blob directory handle is re-resolved per open instead of cached at boot.
    "m5_path_per_component": [(
        "src/kernel/io-worker.mjs",
        "  const where = dirOf(dir);\n"
        "  if (!where) return -EIO;\n"
        "  const fh = await where.getFileHandle(name, { create: true });",
        "  let where = dirOf(dir);\n"
        "  if (!where) return -EIO;\n"
        "  // MUTATION: resolve the directory per call rather than once at boot.\n"
        "  if (dir === BLOB_DIR) {\n"
        "    where = await root.getDirectoryHandle(BLOB_DIR, { create: true });\n"
        "    where = await where.getDirectoryHandle('.', { create: false }).catch(() => where);\n"
        "  }\n"
        "  const fh = await where.getFileHandle(name, { create: true });",
    ), (
        "src/kernel/iocore.mjs",
        "    const where = dirOf(dir);\n"
        "    if (!where) return -EIO;\n"
        "    const fh = await where.getFileHandle(name, { create: true });",
        "    let where = dirOf(dir);\n"
        "    if (!where) return -EIO;\n"
        "    // MUTATION: resolve the directory per call rather than once at boot.\n"
        "    if (dir === BLOB_DIR) {\n"
        "      where = await root.getDirectoryHandle(BLOB_DIR, { create: true });\n"
        "    }\n"
        "    const fh = await where.getFileHandle(name, { create: true });",
    ), (
        # openNamed after the create-flag fix: a named EXISTING generation is opened without
        # `create`, so the anchor carries the try/catch that reports an absent blob.
        "src/kernel/iocore.mjs",
        '    const where = dirOf(dir);\n    if (!where) return -EIO;\n    let fh;\n    try {\n      fh = await where.getFileHandle(name, { create: create === true });\n',
        '    let where = dirOf(dir);\n    if (!where) return -EIO;\n    // MUTATION: resolve the directory per call rather than once at boot.\n    if (dir === BLOB_DIR) {\n      where = await root.getDirectoryHandle(BLOB_DIR, { create: true });\n    }\n    let fh;\n    try {\n      fh = await where.getFileHandle(name, { create: create === true });\n',
    )],
    # 7. The group arm of the mode word is deleted: a group member falls through to `other`.
    "m7_group_bits": [(
        "src/fs/vfs.mjs",
        "    const shift = inode.uid === cred.uid ? 6 : inode.gid === cred.gid ? 3 : 0;",
        "    const shift = inode.uid === cred.uid ? 6 : 0;",
    )],
    # 6. A close releases the inode's handle while another description still rests on it.
    #
    # THE ANCHOR MOVED WITH THE PROPERTY, the third time that has happened in this file: the
    # refcount arbitration was in src/kernel/io-worker.mjs, then in src/kernel/iocore.mjs, and the
    # count of DESCRIPTIONS is now in src/kernel/store.mjs because a description no longer holds a
    # handle at all — it holds an inode number and an offset, and iocore has never heard of a file
    # description. Mutating iocore's per-NAME guard is now behaviourally inert on the fd path: the
    # Store's row takes exactly one reference per inode, so `reusedOpens` is 0 across two opens of
    # one file and refs never exceeds 1 for a blob. Left pointed there, this mutation SURVIVED
    # both gates — a mutation of code the proofs no longer reach reads as a mutation nobody
    # caught. Scored at the live site it is caught by proof (c)'s holder reading after the second
    # description's close.
    "m6_close_drops_refs": [(
        "src/kernel/store.mjs",
        "    row.users -= 1;\n    if (row.users > 0) return 0;\n",
        "    row.users -= 1;\n",
    )],
}


def main() -> int:
    """Apply a mutation, trying each of its anchors in turn.

    A mutation may carry SEVERAL candidate anchors, because the code it targets has moved: the
    refcount arbitration and the per-open directory resolution were in src/kernel/io-worker.mjs
    and are now in src/kernel/iocore.mjs, which both I/O hosts share. An anchor that is absent is
    skipped; an anchor that is present more than once is still a hard error, and a mutation none
    of whose anchors applied is a mutation that was never introduced — which would read as a
    mutation the suite caught.
    """
    name = sys.argv[1]
    applied = 0
    for rel, old, new in MUTATIONS[name]:
        path = ROOT / name / rel
        if not path.exists():
            continue
        text = path.read_text()
        n = text.count(old)
        if n == 0:
            continue
        if n != 1:
            print("ANCHOR NOT UNIQUE in %s: %d occurrence(s)" % (rel, n))
            return 1
        path.write_text(text.replace(old, new))
        print("patched %s/%s" % (name, rel))
        applied += 1
    if applied != 1:
        print("NO ANCHOR APPLIED for %s (%d of %d candidates matched)"
              % (name, applied, len(MUTATIONS[name])))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
