#!/usr/bin/env python3
"""Append the option-D milestone screens to mockups/milestones.html."""
import sys

PATH = sys.argv[1]
s = open(PATH).read()

D = r""",

 { id:'D0', grp:'Learning mode (D)', t:'RV32I interpreter', d:'6 d · teaching CPU', tag:'tier 2',
  lede:'A second tier: an emulated RV32I machine supplying the MMU, timer interrupts and device bus the browser withholds. Measured at 455 MIPS on a synthetic loop — D0 re-measures it on a real binary, because that is the figure everything else rests on.',
  screen:{kind:'noui',body:T(`
$ machine run /usr/share/rv32/hello.elf
hello from rv32i

$ machine bench /usr/share/rv32/dhrystone.elf
  synthetic 5-instr loop ....... 455 MIPS   (bench/feasibility)
  real workload (dhrystone) .... 118 MIPS   <-- the honest number
  decode+dispatch share ........ 61%

  ACCEPT   118 MIPS        (kill criterion: below 20)

$ ps
  PID  TIER  STAT  CMD
    2  host  S     -sh
    9  rv32  R     dhrystone      <-- same /proc, different tier

  negative control: ADDI immediate sign-extension swapped
    hello.elf output wrong ....................... FAILED as required`)},
  real:['RV32I base integer set, decoding from memory','One prebuilt binary committed — no toolchain needed to read the repo','Emulated processes appear in the same /proc as host ones'],
  proof:'The binary produces its known output, and MIPS is <b>re-measured on that real workload</b> and recorded beside the synthetic 455.',
  neg:'Corrupt one instruction decode — swap ADDI&rsquo;s immediate sign extension. The binary must produce wrong output or trap.',
  warn:'455 MIPS came from a 5-instruction loop with a hot dispatch path. A real program will be slower. Kill criterion: below 20 MIPS the tier is not a tier.' },

 { id:'D1', grp:'Learning mode (D)', t:'Sv32 virtual memory', d:'3 d', tag:'tier 2',
  lede:'The biggest coverage gain in the project. Two-level page tables, a TLB, and page faults vectoring through a real trap — so virtual memory stops being an animation. A Proxy-based software MMU measured 66x slower, which is why this needs the interpreter.',
  screen:{kind:'desk',windows:[
    {cls:'plain',x:22,y:18,w:300,h:286,title:'page-table walker — pid 9',
     bodyHtml:`<div style="padding:9px;font:11px ui-monospace,monospace;color:#1f2b38">
      <div style="color:#6b7c8f">va 0x00401abc</div>
      <div style="margin:6px 0 2px">L1[0x001] &rarr; ppn 0x0042 &nbsp;<span style="color:#3f8f55">V</span></div>
      <div>L0[0x001] &rarr; ppn 0x0317 &nbsp;<span style="color:#3f8f55">V R W</span> <span style="color:#b98024">D</span></div>
      <div style="margin-top:6px;color:#2c5d8f">pa 0x00317abc</div>
      <hr style="border:0;border-top:1px solid #dce6f0;margin:9px 0">
      <div>TLB &nbsp;hits 18422 &nbsp;misses 97 &nbsp;<b>99.5%</b></div>
      <div>faults &nbsp;minor 97 &nbsp;major 4 &nbsp;cow 11</div>
      <div style="margin-top:7px;color:#6b7c8f">resident 124 / 256 pages</div></div>`},
    {cls:'plain',x:300,y:124,w:262,h:180,title:'Terminal',body:T(`
$ check.py --only mmu
same va, two procs, diff data .. ok
unmapped -> mcause=13 ......... ok
handler ran, resumed .......... ok`)}]},
  real:['Sv32 two-level page tables, 4 KiB pages','TLB with a measurable hit rate','Page faults through the real trap vector','Demand paging out to OPFS — real swap to real storage'],
  proof:'Two processes write the <b>same virtual address</b> and read back different values — inexpressible in tier 1. An unmapped access faults with the right <code>mcause</code> and the handler runs.',
  neg:'Make translation the identity map. The two processes must start seeing each other&rsquo;s data, and the first assertion must fail.' },

 { id:'D2', grp:'Learning mode (D)', t:'Traps, timer, preemption', d:'2 d', tag:'tier 2',
  lede:'The thing tier 1 cannot do at any price: switch away from a process that issues no syscalls. A quantum expressed in instructions is a real timer interrupt.',
  screen:{kind:'noui',body:T(`
$ check.py --only preempt

  two spinning processes, no syscalls, 1.00s
    quantum          4.00 ms
    switches seen    249
    expected         250 +/- 5            ok
    pid 9 runtime    0.501s
    pid 10 runtime   0.499s               ok  (fair)

  trap path:  mtimecmp fires -> mtvec -> save mepc
              -> scheduler -> restore -> mret

  negative control: timer disabled
    switches seen    0                    FAILED as required
    (two spinning processes issue no syscalls, so nothing else
     can ever switch them — which is exactly the tier 1 story)`)},
  real:['mtime / mtimecmp','mtvec / mcause / mepc','A quantum counted in instructions','Genuine preemption, not cooperation'],
  proof:'A process issuing <b>no syscalls at all</b> is still switched away from. Count switches over one second and assert within tolerance of <code>elapsed / quantum</code>.',
  neg:'Disable the timer. The switch count must collapse to zero for two spinning processes, and the check must fail.' },

 { id:'D3', grp:'Learning mode (D)', t:'Scheduler policies', d:'3 d', tag:'tier 2',
  lede:'Four policies behind one interface, and the same workload under each. The convoy effect and priority inversion become things you cause rather than read about.',
  screen:{kind:'desk',windows:[
    {cls:'plain',x:24,y:18,w:330,h:286,title:'scheduler — one workload, four policies',
     bodyHtml:`<div style="padding:10px;font:11px ui-monospace,monospace">
      <div style="color:#6b7c8f;margin-bottom:7px">1 interactive + 2 batch, 3.0 s</div>
      <table style="width:100%;border-collapse:collapse">
      <tr style="color:#6b7c8f"><td>policy</td><td style="text-align:right">resp</td><td style="text-align:right">turn</td></tr>
      <tr><td>FCFS</td><td style="text-align:right;color:#c7694f">412ms</td><td style="text-align:right">2.9s</td></tr>
      <tr><td>round-robin</td><td style="text-align:right;color:#b98024">38ms</td><td style="text-align:right">3.1s</td></tr>
      <tr><td><b>MLFQ</b></td><td style="text-align:right;color:#3f8f55"><b>9ms</b></td><td style="text-align:right">3.2s</td></tr>
      <tr><td>lottery</td><td style="text-align:right">46ms</td><td style="text-align:right">3.0s</td></tr>
      </table>
      <div style="margin-top:9px;color:#2c5d8f">assert MLFQ &lt; RR &lt; FCFS &nbsp;ok</div>
      <div style="margin-top:7px;color:#6b7c8f">convoy effect visible under FCFS: the<br>interactive job waits behind both batch jobs</div></div>`},
    {cls:'plain',x:322,y:138,w:240,h:166,title:'run queue',
     bodyHtml:`<div style="padding:9px;font:11px ui-monospace,monospace">
      <div style="color:#6b7c8f">MLFQ</div>
      <div>q0 &nbsp;[ 9 ]&nbsp; <span style="color:#3f8f55">&larr; interactive</span></div>
      <div>q1 &nbsp;[ ]</div>
      <div>q2 &nbsp;[ 10 11 ]&nbsp; <span style="color:#6b7c8f">batch, demoted</span></div>
      <div style="margin-top:8px;color:#6b7c8f">priority boost in 0.8s</div></div>`}]},
  real:['Round-robin, MLFQ, lottery, stride','One interface, swappable at runtime','Measured response and turnaround per policy'],
  proof:'The same workload under each policy gives different and <i>predicted</i> numbers. Assert the ordering: MLFQ response &lt; round-robin &lt; FCFS.',
  neg:'Make every policy return the same choice. The orderings must collapse and the assertion must fail — otherwise it is measuring noise, not policy.' },

 { id:'D4', grp:'Learning mode (D)', t:'fork, COW, demand paging', d:'3 d', tag:'tier 2',
  lede:'fork is impossible for a JS process and needs a rebuild for a stock wasm one — but an interpreter state object is plain data. Which makes copy-on-write demonstrable by frame number rather than by assertion.',
  screen:{kind:'noui',body:T(`
$ check.py --only fork

  fork() -> child 0, parent 12 ................... ok
  child writes invisible to parent ............... ok

  copy-on-write, by FRAME NUMBER not contents:
    before write   pid 9  va 0x402000 -> ppn 0x0317
                   pid 12 va 0x402000 -> ppn 0x0317   <-- shared
    after  write   pid 12 va 0x402000 -> ppn 0x04a1   <-- copied
    cow faults 1 ................................. ok

  demand paging to OPFS:
    touch paged-out page -> major fault, data ok .. ok
    major faults 4,  OPFS reads 4 ................ ok

  negative control: eager copy instead of COW
    frames differ before the write ............... FAILED as required
  negative control: all pages pinned
    major fault count 0 .......................... FAILED as required`)},
  real:['fork by copying the interpreter state object','COW: read-only mark, copy on fault','Demand paging backed by OPFS'],
  proof:'A COW page&rsquo;s <b>physical frame number is identical in both processes until one writes</b>. Assert the frame id, not the contents.',
  neg:'Eager-copy instead of COW — the shared-frame assertion must fail. Then pin all pages — the demand-paging fault count must drop to zero and that check must fail too.',
  warn:'Measured: fork by whole-heap copy costs 16.6 ms at 64 MiB and 85.7 ms at 256 MiB, on the kernel&rsquo;s own thread. Cheap here only because interpreter heaps are small — do not generalise it to option B.' },

 { id:'D5', grp:'Learning mode (D)', t:'Devices, providers, hot-unplug', d:'14 d', tag:'devices',
  lede:'Storage providers are config rows, not drivers. Measured: GitHub raw and jsDelivr both serve genuine ranged block reads with CORS, so the default external device is free and needs no account.',
  screen:{kind:'desk',windows:[
    {cls:'plain',x:20,y:16,w:286,h:296,title:'blockdev — providers',
     bodyHtml:`<div style="padding:9px;font:11px ui-monospace,monospace">
      <table style="width:100%;border-collapse:collapse">
      <tr style="color:#6b7c8f"><td>provider</td><td style="text-align:right">p50</td><td style="text-align:right">p99</td></tr>
      <tr><td>jsdelivr</td><td style="text-align:right;color:#3f8f55">22ms</td><td style="text-align:right">61ms</td></tr>
      <tr><td>gh-raw</td><td style="text-align:right">31ms</td><td style="text-align:right">88ms</td></tr>
      <tr><td>r2-owned</td><td style="text-align:right">27ms</td><td style="text-align:right;color:#c7694f">412ms</td></tr>
      <tr><td>synthetic</td><td style="text-align:right" colspan="2">replays r2</td></tr>
      </table>
      <div style="margin-top:9px;color:#6b7c8f">the tail is why a real bucket earns a place.<br>a fixed delay cannot teach p99.</div>
      <hr style="border:0;border-top:1px solid #dce6f0;margin:9px 0">
      <div>cache &nbsp;LRU&nbsp;&nbsp;&nbsp;hit 87.2%</div>
      <div>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;clock &nbsp;hit 81.4%</div>
      <div style="margin-top:6px">RAID5 &nbsp;3 providers &nbsp;<span style="color:#3f8f55">optimal</span></div></div>`},
    {cls:'plain',x:300,y:126,w:262,h:186,title:'hot-unplug',
     bodyHtml:`<div style="padding:9px;font:11px ui-monospace,monospace">
      <div style="color:#c7694f">wifi off, mid-read</div>
      <div style="margin-top:6px">read(lba 4096) &hellip; timeout 2s</div>
      <div>retry 1 &hellip; fail</div>
      <div>retry 2 &hellip; fail</div>
      <div style="color:#c7694f">-EIO to pid 9</div>
      <div style="margin-top:7px;color:#6b7c8f">partial buffer discarded,<br>not returned</div>
      <div style="margin-top:8px;color:#b98024">fell back to synthetic<br>(and said so)</div></div>`}]},
  real:['Provider table as data: url template + range strategy','Free defaults: cdn.jsdelivr.net, raw.githubusercontent.com','Buffer cache, swappable eviction','PIO and DMA as two implementations','RAID 0/1/5 across providers'],
  proof:'Four. The first keeps the rest honest: <b>a CI capability probe per provider</b> — a ranged GET must return exactly the requested byte count with <code>Content-Range</code>, and CORS must be present. A provider that silently stops supporting Range fails the build rather than degrading a page.',
  neg:'Point a provider at a 404 — the synthetic fallback must engage <b>and the page must say it did</b>. A silent fallback is the failure this milestone exists to guard against.',
  warn:'<code>mount</code> must never accept a caller-supplied URL — a provider id and a path, resolved against committed config. Otherwise every process gets an SSRF primitive, and M6 deletes fetch precisely to prevent that.' },

 { id:'D6', grp:'Learning mode (D)', t:'Two tabs, minimal NFS', d:'3 d', tag:'devices',
  lede:'Two browser tabs as two machines over BroadcastChannel — no server, no signalling. With a synthetic loss model, cache coherence bugs become things you cause on demand.',
  screen:{kind:'noui',body:T(`
$ check.py --only nfs

  tab A writes /mnt/net/x, tab B reads it ........ ok
  link model: 40ms +/- 12, loss 0%

  loss raised to 20%:
    retransmission recovers ...................... ok
    12 of 61 datagrams lost, 12 retransmits

  stale cache, caused on demand:
    tab B caches x,  tab A writes x
    tab B detects staleness (mtime+generation) ... ok

  negative control: cache invalidation disabled
    stale read goes undetected ................... FAILED as required`)},
  real:['BroadcastChannel as the link — same origin, no server','Synthetic latency and loss model','Whole-file caching with invalidation'],
  proof:'Tab A writes, tab B reads the new content. At 20% loss the retransmission path recovers. Then <b>cause a stale read on demand</b> and assert the client detects it.',
  neg:'Disable cache invalidation — the stale read must go undetected and the check must fail.' },

 { id:'D7', grp:'Learning mode (D)', t:'Page harness and scrubber', d:'6 d', tag:'the layer',
  lede:'The scrubber is the feature no other OS course can offer: you cannot rewind a real kernel. Here the trace is a ring buffer, so you can.',
  screen:{kind:'desk',windows:[
    {cls:'plain',x:24,y:20,w:520,h:280,title:'lesson — context switching',
     bodyHtml:`<div style="padding:10px;font:11px ui-monospace,monospace">
      <div style="display:grid;grid-template-columns:62px 1fr;gap:6px;align-items:center">
      <span style="color:#6b7c8f;text-align:right">sh (2)</span>
      <div style="height:18px;background:#eef3f9;border-radius:2px;position:relative">
        <div style="position:absolute;left:0;width:30%;top:2px;height:14px;background:#5a9bd4;border-radius:2px"></div>
        <div style="position:absolute;left:30%;width:56%;top:2px;height:14px;background:#b0bcc9;border-radius:2px;color:#47535f;font-size:9px;text-align:center;line-height:14px">blocked in Atomics.wait</div></div>
      <span style="color:#6b7c8f;text-align:right">grep (8)</span>
      <div style="height:18px;background:#eef3f9;border-radius:2px;position:relative">
        <div style="position:absolute;left:38%;width:40%;top:2px;height:14px;background:#5a9bd4;border-radius:2px"></div></div>
      <span style="color:#6b7c8f;text-align:right">kernel</span>
      <div style="height:18px;background:#eef3f9;border-radius:2px;position:relative">
        <div style="position:absolute;left:30%;width:8%;top:2px;height:14px;background:#8156b8;border-radius:2px;color:#fff;font-size:9px;text-align:center;line-height:14px">sched</div></div>
      </div>
      <div style="margin-top:11px;display:flex;align-items:center;gap:8px">
        <span style="border:1px solid #a9bdd1;border-radius:3px;padding:1px 7px">&#9664;</span>
        <span style="border:1px solid #a9bdd1;border-radius:3px;padding:1px 7px">&#9654;</span>
        <div style="flex:1;height:5px;background:#dce6f0;border-radius:3px;position:relative">
          <div style="position:absolute;left:34%;top:-4px;width:12px;height:12px;border-radius:50%;background:#2f7fd4"></div></div>
        <span style="color:#6b7c8f">t = 1.204 ms</span></div>
      <div style="margin-top:10px;color:#6b7c8f">ring 16 MiB &nbsp; records 412,880 &nbsp;
        <span style="color:#3f8f55">dropped 0</span></div></div>`}]},
  real:['One page template everywhere','Scrubber replaying /dev/trace','Check runner across every page','Visible dropped-record counter'],
  proof:'The scrubber reconstructs a known syscall sequence from a recorded trace, and the reconstruction matches what was recorded.',
  neg:'Undersize the ring to 64 KiB at full syscall rate. The dropped-record counter must become non-zero <b>and be displayed</b> — a trace view that silently drops records shows a clean picture of a broken system.',
  warn:'Measured: 4 ns a record, so tracing is always on. But a 1 MiB ring holds 32,768 records and wraps every 0.5 s at full rate — the scrubber needs at least 16 MiB.' },

 { id:'D8', grp:'Learning mode (D)', t:'The 35 principle pages', d:'14 d', tag:'the layer',
  lede:'Every component in Wikipedia&rsquo;s Operating system &sect; Components, drilled to OSTEP chapter depth. 22 live, 8 partial, 2 inverted, 3 absent — nothing on the Wikipedia list is absent.',
  screen:{kind:'noui',body:T(`
$ lessons/run.py --prove-failure

  INVERTED  trap vs interrupt ................. reported failure  ok
  INVERTED  signals: ctrl-c reaches the pgrp ... reported failure  ok
  INVERTED  deadlock: f|g both functions ....... reported failure  ok
  INVERTED  fsck reports the discarded tail .... reported failure  ok
  INVERTED  cache: LRU beats clock here ........ reported failure  ok
  INVERTED  cow shares a frame until write ..... reported failure  ok
  INVERTED  m6 exploit is refused .............. reported failure  ok
  ...  32 of 32 page checks reported failure

  3 absent pages carry no check (flash/SSD, auth, crypto)
  A lesson that stops being true fails the build; it does not lie.

$ lessons/run.py
  32 page checks .............................. all pass`)},
  real:['35 pages on one template','Every page is an assertion in CI','Honesty category declared per page: instrumented / emulated / simulated'],
  proof:'<code>--prove-failure</code> inverts all 32 checkable pages and the run must report failures.',
  neg:'That <i>is</i> the control — the mode exists so the lesson suite can be seen to fail. A page whose check cannot fail is not a page.',
  warn:'Only the scheduling-policy comparison is <i>simulated</i>, and it must stay visibly fenced off from the instrumented and emulated pages. A resource that blurs &ldquo;this is real&rdquo; and &ldquo;this is a model&rdquo; is worse than one with gaps.' },
]"""

anchor = "]\n\nconst nav = document.getElementById('nav')"
assert anchor in s, "anchor not found"
s = s.replace(anchor, D + "\n\nconst nav = document.getElementById('nav')", 1)
open(PATH, 'w').write(s)
print("mockup: option D screens added")
