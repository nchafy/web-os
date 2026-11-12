# coep-tiles

Does cross-origin isolation break map tiles? No. This proves it.

`COEP: require-corp` blocks any cross-origin subresource that does not opt in — which sounds like
it rules out tile servers. It does not, because `require-corp` accepts a resource that is fetched
in **CORS mode** and passes the CORS check, and every tile server tested sends
`Access-Control-Allow-Origin: *`.

## Run

```sh
../../.venv/bin/python probe.py        # needs websocket-client
```

It starts two servers: `scripts/serve.py`-equivalent on 8771 with COOP/COEP, and
`plain_server.py` on 8772 with **no** CORS and **no** CORP, serving `nocors/red.png`. Then it
drives headless Chrome over CDP, loads a MapLibre map with one vector and three raster sources,
and reports.

## Result, 2026-11-11, Chrome 157.0.8103.38 / macOS 26.7.2 / Apple M2 Pro

```
crossOriginIsolated : True
SharedArrayBuffer   : function
map reached idle    : True
tile data events    : 40
maplibre errors     : []
raster sources ok   : {"r_osm":true,"r_topo":true,"r_esri":true}
NEG CONTROL img     : BLOCKED  (must be BLOCKED)
blocked requests    : 1
   BLOCKED corp-not-same-origin-after-defaulted-to-same-origin-by-coep  Image
failed requests     : 0
```

Vector tiles, glyph fonts and all three raster sources loaded. The screenshot is Manhattan.

## The negative control is the point

"Zero blocked requests" means nothing from a detector that never fires. The `nocors/red.png`
image — cross-origin by port, no CORS, no CORP, no `crossorigin` attribute — **must** be blocked,
and the run must report exactly one block which is that one. If the control ever loads, the probe
is measuring nothing and its result must be discarded.

This is the pattern every harness in this repo follows. See `CLAUDE.md` §Verification.

## What this does and does not establish

Establishes: tile and data services that send `ACAO` work under full isolation, including raster
tiles loaded as `<img>`, and a library that spawns its own same-origin worker (MapLibre does) is
fine.

Does not establish: anything about third-party **iframes**, which are blocked by the embedded
site's own `X-Frame-Options` / CSP and not by COEP at all. An in-OS web browser remains
impossible. See `CONTEXT.md` §2.

Tested endpoints, all `Access-Control-Allow-Origin: *` as of 2026-11-11:
`tiles.openfreemap.org` (style + glyphs + vector tiles), `tile.openstreetmap.org`,
`a.tile.opentopomap.org`, `server.arcgisonline.com/.../World_Imagery`.
