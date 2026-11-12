# GAP 6 — the VFS: where POSIX metadata (mode/uid/gid/mtime/symlinks/link counts) lives given OPFS exposes none of it, how the blob store and the metadata store stay consistent across a crash when they are not one transaction, the v1 mount table and drivers, quota/eviction exposure, and what of this survives in Safari.

## Verdict

Keep the authoritative inode table in memory in the kernel worker and persist it as an OPFS superblock snapshot plus an append-only OPFS journal (option b), with file data in a flat OPFS directory named by inode number; IndexedDB holds only host-directory handles. webxp's /Users/chafyni/claude/webxp/shared/fs/vfs.mjs is reusable as the layer above the store, but two assumptions touch every method: file data is a JS string, and there is one global uid/gid. Safari 27.2 runs all of this except host-directory mounts.

## Detail

## 1. The OPFS gaps, confirmed

`getFile()` yields a `File`: `name`, `size`, `lastModified`, `type` — and `type` is "an implementation-defined value, based on for example entry's name or its file extension" (https://fs.spec.whatwg.org/#api-filesystemfilehandle-getfile). `lastModified` comes from the entry's modification timestamp; there is no setter (measured: `settable=false` in Chrome 157 and Safari 27.2). The string "symlink" does not appear in the spec (0 hits over the rendered text). No mode/uid/gid anywhere; for OPFS the permission state "must always be granted" (https://wicg.github.io/file-system-access/#permissions). So all four are ours to store. Measured bonus: Safari's `lastModified` was second-granular (`...565000`), Chrome's millisecond (`...538912`) — another reason mtime lives in our index, not in OPFS.

## 2. Inode store: option (b), snapshot + journal

Measured, Chrome 157.0.8103.38 headless and Safari 27.2 (WebKit 605.1.15), macOS 26.7.2, Apple M2 Pro 32 GB; harness `/Users/chafyni/claude/tmp-vfsbench/{index.html,worker.js,serve.py}` served over `http://127.0.0.1:8099` with COOP/COEP, N=10 000 inodes (1 668 008-byte JSON), two runs agreeing within noise:

| | Chrome | Safari |
|---|---|---|
| boot: OPFS superblock read+parse+Map | **7.2 ms** | **7.4 ms** |
| boot: IDB open+`getAll`+Map | 23.4 ms | 28.1 ms |
| durable write: journal append + `flush()`, handle held | **0.48 ms** | **0.054 ms** |
| same, handle reopened per record | 1.18 ms | 0.64 ms |
| durable write: IDB `durability:"strict"`, one tx each | 0.65 ms | **2.70 ms** |
| sidecar-per-inode: read+parse 2 000 files | 1 742 ms | 1 659 ms |
| OPFS directory enumeration, per name | 0.011 ms | **0.60 ms** |
| in-memory stat (`Map.get`) | 0.000027 ms | 0.000021 ms |
| depth-5 path walk | 0.00037 ms | 0.00050 ms |

(c) sidecars are dead: ~0.87 ms per inode to read means ~9 s for 10k, and that is before a path walk. (a) IndexedDB boots 3x slower and costs 5–50x more per durable metadata write. Stat and path walk are free either way because the table is in memory — the store is only touched at boot and on commit.

**Layers.** syscall ABI → VFS core (in-memory inode table, path walk, perms, fd table) → mount table → per-driver store. The core is synchronous because `createSyncAccessHandle` is `[Exposed=DedicatedWorker]` and the kernel is a dedicated worker.

**OPFS layout** (origin bucket root): `sb.0`, `sb.1` alternating snapshots; `sb.ptr` = {generation, slot, journalSeq, crc32}; `j.log` append-only, each record length-prefixed JSON + crc32; `b/<ino>` flat data blobs; `t/<ino>` staging. Flat, because directory `move()` does not exist in Chrome (measured `TypeError: d.move is not a function`).

## 3. Crash consistency

`flush()` is the only durability primitive: "Attempt to transfer all cached modifications of the file's content to the file system's underlying storage device" (https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-flush). `close()` "does not guarantee that all file modifications will be immediately reflected" (#dom-filesystemsyncaccesshandle-close). `write()` admits partial writes and specifies no order (#dom-filesystemsyncaccesshandle-write). `move()` is **not in the standard at all** — whatwg/fs#10 and #180 are still open — so no atomicity is promised anywhere.

**Ordering, per mutation:** (1) write/extend `b/<ino>`, `flush()`; (2) append the journal record, `flush()`; (3) apply in memory. Data before metadata: an orphan blob is garbage, a metadata record pointing at absent data is corruption. Snapshot every 512 records: write the idle `sb` slot, `flush()`, then rewrite `sb.ptr`, `flush()`. Hold the `j.log` and `sb` handles for the kernel's lifetime (2–12x cheaper, measured).

**fsck at boot:** validate `sb.ptr` crc, else pick the higher valid generation; load the snapshot through webxp's `VFS.parse` validation; replay `j.log` from `journalSeq`, stopping at the first bad crc or truncated length prefix — that is the crash point, discard the tail. Repairs: inode with missing blob and size>0 → size 0, report, never silent; blob size ≠ inode size → trust the blob; `nlink` recomputed from surviving directory entries (webxp already does this); unreachable inodes dropped (webxp's reachability sweep); `t/*` deleted. Blob-orphan collection is deferred to idle, not boot — 10k names costs ~6 s of enumeration in Safari. A snapshot that fails validation mounts read-only and says so; webxp reseeds instead, which is wrong once the data is the user's.

## 4. webxp reuse

Reusable unchanged as the upper layer: `#lookup` (symlink chasing, `MAX_LINKS=40`, dangling-final-link create semantics), `#may`/`#need`, hard links and `nlink` accounting, `FsError` POSIX codes, `serialize`/`parse` as snapshot writer/loader and half of fsck, `batch`/`watch`. Must change: (i) `inode.data` is a JS string — `readFile`/`writeFile`/`appendFile`/`copyFile`/`usedBytes` all measure `.length`; data becomes bytes in `b/<ino>`; (ii) `this.uid`/`this.gid` is one global identity — must become a per-call credential; (iii) `MAX_FILE_SIZE`/`MAX_TOTAL_SIZE` (256 KB/1 MB localStorage ceilings) go, replaced by `estimate()`; (iv) no fd layer (open/read/write/lseek/dup, O_APPEND/O_TRUNC) — absent from the 1301 lines; (v) mounts are an ad-hoc `inode.source`/`mounted` flag on one table — `#lookup` needs a real mount-crossing branch.

## 5. Mounts (longest prefix wins)

`/` opfs rw · `/usr` overlay(lower=httpimg ro, upper=`opfs:/.rw/usr`, COW with whiteouts) · `/proc` `/dev` `/sys` genfs, synthesized on read, no stored inodes · `/mnt/host/<label>` hostfs · `/tmp` tmpfs. httpimg index copies daedalOS `scripts/fs2json.js`: `{fsroot, size, version:4}`, each node `[name, size, mtime, target]` where `target` is a symlink string or a child array — it already carries mtime and symlink targets, which is exactly the metadata OPFS lacks. hostfs persists `FileSystemDirectoryHandle` in IndexedDB (handles are `[Serializable]`, https://fs.spec.whatwg.org/#api-filesystemhandle) and re-prompts with `requestPermission()`, which needs transient activation — so a mount survives a reload as an entry needing one click.

## 6. Quota, Safari

Yes, the filesystem can be deleted: buckets start "best-effort" and the UA "should clear ... buckets whose mode is best-effort" under pressure (https://storage.spec.whatwg.org/#storage-pressure). `persist()` is `[Exposed=Window]` (measured `undefined` in both browsers' workers) — the shell, not the kernel, must request it, display `persisted()`, and offer export.

Safari 27.2, measured: cross-origin isolation, `SharedArrayBuffer`, `Atomics.wait` ("timed-out"), `createSyncAccessHandle`, `createWritable`, OPFS all work — the kernel boundary and this VFS run. Missing: `showDirectoryPicker`/`showOpenFilePicker` are `undefined` (no host mount); `handle.remove()` absent (use `removeEntry`); `move()` accepts only `(dir, name)` — the one-argument rename throws `TypeError: Not enough arguments`, while Chrome has no directory move at all, so `fileHandle.move(dirHandle, name)` is the only portable form. Safari gets a full OS minus host directories.

## Claims

- [spec-normative] getFile() exposes only name, size, lastModified and type; lastModified is set from the entry's modification timestamp and the spec defines no way to set it. type is implementation-defined, derived from e.g. the file extension.
  - https://fs.spec.whatwg.org/#api-filesystemfilehandle-getfile
- [measured] File.lastModified has no setter in either engine: reading the accessor descriptor on File.prototype gave settable=false in Chrome 157.0.8103.38 and Safari 27.2 (harness /Users/chafyni/claude/tmp-vfsbench/moveworker.js, probe 'getFile().lastModified after write').
  - https://w3c.github.io/FileAPI/#dfn-lastModified
- [measured] The WHATWG File System standard contains no mention of symbolic links, mode bits, uid or gid; a grep of the rendered specification text for 'symlink' returned 0 matches.
  - https://fs.spec.whatwg.org/
- [spec-normative] For an entry in a bucket file system the permission state 'must always be granted', so OPFS carries no per-file access control to build POSIX permissions on.
  - https://wicg.github.io/file-system-access/#permissions
- [spec-normative] createSyncAccessHandle is [Exposed=DedicatedWorker] and 'will only succeed when the fileHandle is in a bucket file system'.
  - https://fs.spec.whatwg.org/#api-filesystemfilehandle-createsyncaccesshandle
- [spec-normative] flush() is specified as 'Attempt to transfer all cached modifications of the file's content to the file system's underlying storage device', with a note that it can be a no-op on in-memory file systems. It is the only durability primitive OPFS offers.
  - https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-flush
- [spec-normative] close() 'does not guarantee that all file modifications will be immediately reflected in the underlying storage device. Call the flush() method first if you require this guarantee.'
  - https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-close
- [spec-normative] FileSystemSyncAccessHandle.write() admits partial writes and the spec declines to specify write order, so a single write is not atomic.
  - https://fs.spec.whatwg.org/#dom-filesystemsyncaccesshandle-write
- [documented] move() is not part of the WHATWG File System standard at all — the adding PRs whatwg/fs#10 and whatwg/fs#180 were both still open on 2026-11-11 — so no atomicity guarantee for move() or rename exists in any specification.
  - https://github.com/whatwg/fs/pull/10
- [measured] move() support is split and only the two-argument form is portable: in Chrome 157.0.8103.38, FileSystemDirectoryHandle.prototype.move is undefined ('TypeError: d.move is not a function') while file.move(name), file.move(dir) and file.move(dir, name) all succeed; in Safari 27.2 both file and directory move exist but every one-argument call throws 'TypeError: Not enough arguments' and only move(dir, name) succeeds. Harness /Users/chafyni/claude/tmp-vfsbench/moveworker.js.
  - https://github.com/mdn/browser-compat-data/blob/f0ac50c21ebcebf37f2b4468a0c07de5fcc47577/api/FileSystemHandle.json
- [measured] A move onto an existing destination overwrites it in Chrome 157 (destination size became 3 bytes after moving a 3-byte file over a 1-byte file).
  - https://fs.spec.whatwg.org/
- [measured] FileSystemHandle.remove() is absent in Safari 27.2 ('f.remove is undefined') and present in Chrome 157; deletion must go through the parent's removeEntry().
  - https://github.com/mdn/browser-compat-data/blob/f0ac50c21ebcebf37f2b4468a0c07de5fcc47577/api/FileSystemHandle.json
- [measured] A second createSyncAccessHandle on an open file is refused in both engines, but with different errors: NoModificationAllowedError in Chrome 157 (as specified) and InvalidStateError in Safari 27.2.
  - https://fs.spec.whatwg.org/#api-filesystemfilehandle-createsyncaccesshandle
- [measured] Boot to a usable 10 000-inode table costs 7.2 ms from a single 1 668 008-byte OPFS superblock (read via sync access handle, JSON.parse, build Map) versus 23.4 ms via IndexedDB open+getAll+Map, in Chrome 157 headless; 7.4 ms versus 28.1 ms in Safari 27.2. Per-inode OPFS sidecars cost 1 742 ms (Chrome) / 1 659 ms (Safari) for only 2 000 files. Harness /Users/chafyni/claude/tmp-vfsbench/worker.js, served over http://127.0.0.1:8099 with COOP/COEP, macOS 26.7.2, Apple M2 Pro, 32 GB; two Chrome runs agreed within 7%.
  - https://fs.spec.whatwg.org/#api-filesystemsyncaccesshandle
- [measured] A durable metadata write is 5-50x cheaper as an OPFS journal append than as an IndexedDB transaction: 100 appends with flush() on a held-open handle took 48.2 ms in Chrome 157 and 5.4 ms in Safari 27.2, versus 64.5 ms and 270.2 ms for 100 single-put transactions with durability:'strict'. Reopening the journal handle per record cost 118 ms (Chrome) / 64 ms (Safari).
  - https://w3c.github.io/IndexedDB/#transaction-durability-hint
- [spec-normative] IndexedDB durability 'strict' means the agent may consider the transaction committed only after verifying the changes reached a persistent storage medium; 'relaxed' commits once the changes reach the operating system without verification. A committed transaction writes all its changes atomically or aborts and rolls back.
  - https://w3c.github.io/IndexedDB/#transaction-lifecycle
- [measured] An in-memory stat and path walk are effectively free, so the store choice does not affect syscall latency: 100 000 Map.get stats took 2.7 ms (Chrome) / 2.1 ms (Safari) and 100 000 depth-5 path walks took 3.65 ms / 4.96 ms.
  - https://fs.spec.whatwg.org/
- [measured] OPFS directory enumeration is 55x more expensive in Safari: 2 000 names took 22.6 ms in Chrome 157 (0.011 ms/name) and 1 207.7 ms in Safari 27.2 (0.60 ms/name), which rules out enumerating the blob directory at boot.
  - https://fs.spec.whatwg.org/#api-filesystemdirectoryhandle-asynciterable
- [spec-normative] FileSystemHandle, FileSystemFileHandle and FileSystemDirectoryHandle are all [Serializable], which is what allows a host-directory handle to be stored in IndexedDB and reused after a reload.
  - https://fs.spec.whatwg.org/#api-filesystemhandle
- [spec-normative] A persisted handle still needs permission re-granted: queryPermission() returning 'prompt' means requestPermission() must be called before any operation, and showDirectoryPicker itself requires transient user activation.
  - https://wicg.github.io/file-system-access/#api-filesystemhandle-querypermission
- [spec-normative] A web OS filesystem can be deleted by the browser: a local storage bucket's mode is initially 'best-effort', and under storage pressure the user agent 'should clear network state and local storage buckets whose mode is best-effort'. Storage marked persistent cannot be cleared by the user agent 'without involvement from the origin or user'.
  - https://storage.spec.whatwg.org/#storage-pressure
- [measured] persist() is [Exposed=Window] while persisted() and estimate() are exposed on Window and Worker, so the kernel worker cannot request durability — the shell must. Measured: navigator.storage.persist was undefined inside the dedicated worker in both Chrome 157 and Safari 27.2.
  - https://storage.spec.whatwg.org/#storagemanager
- [spec-normative] estimate() returns usage and quota as 'an implementation-defined rough estimate', explicitly not exact, because user agents may deduplicate and compress — so it cannot be used as a df-accurate figure.
  - https://storage.spec.whatwg.org/#usage-and-quota
- [documented] Safari 17 and later evict per origin in least-recently-used order by last user interaction or last storage operation, sparing origins with an active page or in persistent mode; persist() is granted by heuristics such as the site being a Home Screen Web App. Per-origin quota is up to 60% of disk for browser apps, 15% for others.
  - https://webkit.org/blog/14403/updates-to-storage-policy/
- [documented] WebKit's ITP deletes all of a site's script-writable storage - IndexedDB, LocalStorage, SessionStorage, media keys, service worker registrations and cache - after seven days of Safari use without user interaction; home-screen web apps run on their own counter and are not expected to be cleared.
  - https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/
- [measured] showDirectoryPicker, showOpenFilePicker and showSaveFilePicker are unsupported in Safari and Firefox per browser-compat-data (version_added: false), and measured as undefined in Safari 27.2 and as functions in Chrome 157 - so host-directory mounts are a Chromium-only driver.
  - https://github.com/mdn/browser-compat-data/blob/f0ac50c21ebcebf37f2b4468a0c07de5fcc47577/api/Window.json
- [measured] The kernel boundary itself works in Safari 27.2: with COOP same-origin and COEP require-corp, crossOriginIsolated was true, SharedArrayBuffer was a function, and Atomics.wait on a SharedArrayBuffer inside a dedicated worker returned 'timed-out' - the same results as Chrome 157. browser-compat-data records SharedArrayBuffer and Atomics.wait from Safari 15.2.
  - https://github.com/mdn/browser-compat-data/blob/f0ac50c21ebcebf37f2b4468a0c07de5fcc47577/javascript/builtins/Atomics.json
- [documented] FileSystemFileHandle.createWritable landed in Safari only at version 26 (Chrome 86, Firefox 111), while createSyncAccessHandle has been there since Safari 15.2 - so on Safari 15.2-25 the only way to write OPFS at all is a sync access handle in a dedicated worker.
  - https://github.com/mdn/browser-compat-data/blob/f0ac50c21ebcebf37f2b4468a0c07de5fcc47577/api/FileSystemFileHandle.json
- [documented] daedalOS builds its read-only image index at build time with scripts/fs2json.js, emitting {fsroot, size, version:4} where each node is the array [name, size, mtime, target] and target holds either a symlink's readlink() result or the child array for a directory - i.e. the index already carries the mtime and symlink targets OPFS cannot store.
  - https://github.com/DustinBrett/daedalOS/blob/ed9c7a54cc50a6e9125333743164830ad56779a5/scripts/fs2json.js
- [documented] webxp's VFS keeps file contents as JS strings ('Files hold text. A JS string is the contents, there is no binary mode, and size is a character count') and a single instance-wide uid/gid ('The identity every call is made as. One process'), with localStorage-sized ceilings MAX_FILE_SIZE = 256 KiB and MAX_TOTAL_SIZE = 1 MiB - the three assumptions that must change when the backing store is swapped.
  - https://fs.spec.whatwg.org/
- [documented] webxp's serialize() already performs two of the fsck repairs: it recomputes each directory's nlink from the entries that survived rather than carrying it over, and it drops inodes unreachable from the root; parse() validates that every directory entry points at a present inode and refuses the image otherwise.
  - https://fs.spec.whatwg.org/

## Design consequences

- The inode table is authoritative in RAM and the store is write-behind: stat and path walk never touch storage (measured 27 ns and 370 ns), so syscall latency is independent of the store choice. Boot must load the whole table (7.2 ms at 10k inodes) — the design does not support lazily paging metadata, and would need rework past ~100k inodes.
- Every durable metadata mutation is one journal append plus one flush, so the j.log and superblock sync access handles must be opened once at kernel start and never closed — reopening per record costs 2.5x (Chrome) to 12x (Safari).
- Directories exist only in the inode table. The OPFS blob directory must stay flat and named by inode, because Chrome 157 has no FileSystemDirectoryHandle.move() and the one-argument rename does not exist in Safari 27.2; the only portable primitive is fileHandle.move(dirHandle, name).
- fsck must never silently reseed. A snapshot that fails validation mounts read-only and surfaces the failure; webxp's reset-on-bad-image behaviour has to be replaced before real user data lands in it.
- Blob-orphan collection cannot run at boot: OPFS directory enumeration costs 0.60 ms per name in Safari 27.2 (55x Chrome), so 10k names is ~6 s of startup. It belongs on an idle task or an explicit fsck.
- The VFS core's signatures change shape: a credential (uid/gid) must be a per-call argument, not instance state, or processes cannot have different identities; and file data must be bytes, not JS strings, before any binary app bundle can be stored.
- persist() is Window-only, so the persistence request, the persisted() indicator and the export affordance are shell responsibilities, not kernel ones — the kernel worker cannot ask for durability.
- hostfs is a Chromium-only driver. The mount table must treat drivers as optional and the UI must not present /mnt/host as a permanent fixture in Safari.
- IndexedDB survives in the design for exactly one job — storing FileSystemDirectoryHandles for host mounts — which keeps the two-store crash-consistency problem out of the hot path entirely.

## Could not determine

- Whether Safari's move() overwrites an existing destination. The overwrite probe used the one-argument form, which Safari 27.2 rejects with 'TypeError: Not enough arguments', so the test never ran there; Chrome 157 overwrites. The design therefore does removeEntry(dest) then move(dir, name), with the journal covering the window, rather than relying on replace semantics.
- Whether OPFS (the bucket file system) is covered by WebKit's seven-day ITP deletion of script-writable storage. The 2020 post that announces the rule lists IndexedDB, LocalStorage, SessionStorage, media keys and service worker registrations, and predates OPFS in Safari; the 2023 storage-policy post describes LRU eviction without naming a seven-day rule. I found no source that states which rule governs OPFS today.
- Safari 27.2's navigator.storage.estimate() returned quota 82 463 372 084 and usage 2 207 288 021 bytes for a freshly created http://127.0.0.1:8099 origin that held under 5 MB. The usage figure is not credible as a per-origin number, but I could not determine what it is actually reporting, so df must not be built on Safari's usage value.
- Boot and write costs were measured only on one machine (Apple M2 Pro, macOS 26.7.2) with warm OPFS. I did not measure a cold-disk boot, a spinning-disk or low-end Android device, or the behaviour at 100k inodes, so the 7.2 ms figure should not be assumed to scale linearly.
- Which component consumes daedalOS's fs.9p.json at runtime. package.json pins browserfs to a vendored file:./vendor/browserfs.tgz, and I did not unpack that tarball, so I cannot confirm the exact reader or whether its index format matches upstream BrowserFS's HTTPRequest backend.
- Whether an OPFS journal append followed by flush() is genuinely durable across a process kill, as opposed to merely attempted. The spec says 'attempt to transfer', with no success guarantee and an explicit no-op case, and I did not run a power-loss or SIGKILL-during-flush experiment. The fsck design assumes the journal tail can always be torn.
