import collections, json, pathlib, sys, time
sys.path.insert(0, "/Users/chafyni/claude/web-os/.claude/worktrees/webos-impl/scripts")
import cdp
root = "/Users/chafyni/.claude/jobs/e856c39e/tmp/consoleroot"
sys.argv = []
import check as H  # reuse its serve()
with H.serve(root) as serving:
    b = cdp.Browser()
    b.__enter__()
    try:
        page = b.page()
        page.call("Runtime.enable"); page.call("Log.enable"); page.call("Page.enable")
        page.navigate(serving.base + "/")
        time.sleep(1.5)
        page.evaluate("1")
        ev = page.consume_events()
        counts = collections.Counter(e.get("method") for e in ev)
        print("event methods:", dict(counts))
        for e in ev:
            m = e.get("method")
            if m in ("Log.entryAdded", "Runtime.consoleAPICalled", "Runtime.exceptionThrown"):
                print(m, json.dumps(e.get("params"))[:300])
    finally:
        b.__exit__(None, None, None)
