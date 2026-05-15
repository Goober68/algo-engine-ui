# Live-chart bars pipeline — architecture diagnosis (2026-05-15)

**Symptom reported:** live charts take a long time to load, every time, like there's no caching.

**Verdict:** not a caching problem. Every `/bars` request burns a fixed **~21s on a dead
HTTP dependency, returns 0 archive bars**, then silently falls back to ~747
`bars.jsonl` live bars. The chart has *never* shown real archive history on the VPS.
There is also no caching at any layer, which compounds it.

Proof, straight from coord's own timing log, identical on every request:

```
[bars-timing] xovd-prod-3way/s1 decisions=0.13s(2602) archive=21.05s(0) live=0.00s(747) merge=0.00s total=21.18s
```

---

## Architecture as it exists now

Red = broken/dead path · dashed = unused-by-design or absent · blue = a cache.

```mermaid
flowchart TB
    subgraph FOUNDRY["ALGOFOUNDRY (SMB share host — real data owner)"]
        MONO["monolith tick.bin<br/>19GB / 792M rec / 2022 to 2026<br/>(created by extract)"]
        SHARDS["per-day shards<br/>{symbol}/{YYYY-MM-DD}.tick.bin<br/>~18GB (created at CME break + catchup)"]
        STITCH["stitches/&lt;sha256&gt;.{tick,bar}.bin<br/>recipe-cached subsamples<br/>(CACHE, 7-day idle TTL)"]
        SHARE["share: \\\\ALGOFOUNDRY\\AlgoTickData"]
        MONO --- SHARE
        SHARDS --- SHARE
        STITCH --- SHARE
    end

    subgraph A17["AlgoGuy / .17 (dev + 'farm' box per devstream)"]
        ETD["E:\\TickData (raw DBN?)<br/>probed: archive NOT confirmed here"]
        SIDECAR["coord.tick_archive_serve<br/>DEPRECATED sidecar<br/>serves /bars /tick_history<br/>default port 8091"]
        VITE["Vite dev server :5173<br/>serves the React app"]
        ETD -. "read_ticks / get_bars" .-> SIDECAR
    end

    subgraph VPS["VPS DESKTOP-HEP1RI6 .203 (WORKGROUP, no archive data)"]
        DBENTO["Databento feed (NSSM)"]
        RUNNER["runner.exe (AlgoEngineRunner)<br/>creates: bars.jsonl, runner_slotN.jsonl<br/>(decisions/fills), audit, trail_arms"]
        RING["coord TickRing<br/>in-mem ~4h (CACHE)"]
        ZMAP["Z:\\AlgoTickData -> \\\\ALGOFOUNDRY<br/>D3DTest interactive only<br/>invisible to LocalSystem service"]

        subgraph COORD["AlgoCoord :8090 (LocalSystem)"]
            GSB["get_slot_bars()"]
            BBFT["build_bars_from_ticks()"]
            STITCHER["stitcher.stitch() — needs shards_dir"]
            TAL["tick_archive_local.get_bars()<br/>+ per-hour bar cache (CACHE)<br/>needs tick_data_root"]
            LBJ["load_bars_jsonl()"]
            LDEC["load_decisions()"]
            MERGE["merge_bars_with_indicators_by_ts()"]
            EP["serves: /runners /r/../meta<br/>/r/{id}/s/{n}/{trades,decisions,bars,<br/>broker_truth,audit} /tick_history /stream"]
        end

        DBENTO --> RING
        DBENTO --> RUNNER
        RUNNER --> LBJ
        RUNNER --> LDEC
        RING --> EP

        GSB --> LDEC
        GSB -->|"1 shards_dir UNSET on VPS<br/>(by design: VPS=thin)"| STITCHER
        STITCHER -. "skipped, no shards_dir" .-> BBFT
        GSB --> BBFT
        BBFT -->|"2 tick_data_root UNSET"| TAL
        TAL -. "skipped" .-> HTTP
        BBFT -->|"3 fallback: TICK_ARCHIVE_URL"| HTTP["HTTP GET {url}/bars"]
        GSB -->|"4 archive empty -> fallback"| LBJ
        LBJ --> MERGE
        LDEC --> MERGE
        MERGE --> EP
        ZMAP -. "LocalSystem can't see Z:<br/>workgroup: no machine-acct auth" .-> TAL
    end

    subgraph RELAY["tvbrokerrelay.com"]
        BT["broker truth CSV (fills)"]
    end

    subgraph BROWSER["Chrome (workstation)"]
        MDP["MockDataProvider.js<br/>busts client cache every<br/>slot/runner switch"]
        CHART["ChartPane (lightweight-charts)"]
    end

    HTTP ==>|"-> http://192.168.1.17:8092/bars<br/>wrong port (sidecar=8091) +<br/>NOT RUNNING -> 21s SYN timeout -> []"| SIDECAR
    SHARE -. "Z: map (interactive only)" .-> ZMAP
    SHARDS -. "stitcher would read IF shards_dir set" .-> STITCHER

    BT -->|"poll 60s"| EP
    VITE --> BROWSER
    EP -->|"REST: bars/trades/decisions<br/>+ SSE /stream"| MDP
    MDP --> CHART

    style HTTP fill:#5b1a1a,color:#fff
    style SIDECAR fill:#5b1a1a,color:#fff
    style ZMAP fill:#5b1a1a,color:#fff
    style MDP fill:#5b3a1a,color:#fff
    style STITCH fill:#1a3a5b,color:#fff
    style TAL fill:#1a3a5b,color:#fff
    style RING fill:#1a3a5b,color:#fff
```

---

## The dysfunction, distilled

| # | Problem | Consequence |
|---|---------|-------------|
| 1 | VPS coord has `shards_dir` + `tick_data_root` both unset (by devstream design: "VPS = thin") | Both fast in-proc bar paths skipped |
| 2 | Falls back to HTTP `/bars` — an endpoint **only the DEPRECATED sidecar** serves (merged coord dropped it) | The documented fallback targets an orphaned API |
| 3 | `TICK_ARCHIVE_URL` = `.17:8092`; sidecar default is `8091`; nothing running either way | 21s SYN timeout, 0 archive bars, every request |
| 4 | Real data lives on **ALGOFOUNDRY**, not .17; reachable from VPS only via `Z:` which LocalSystem can't see (workgroup, no machine-acct auth) | No clean in-proc path to the data from the service principal |
| 5 | No server-side response cache; client busts its cache every slot switch | Even the wasted work is re-paid on every navigation |
| 6 | Archive failure silently degrades to `bars.jsonl` (~747 live bars) | Chart has *never* shown real history; failure is invisible (violates prime directive) |

**Core architectural lie:** the "farm box" in the design (.17) is not where the data
actually is (ALGOFOUNDRY), and the VPS-thin model assumes an HTTP archive server that
no longer exists after the sidecar was merged into coord. Every other symptom is
downstream of that mismatch.

---

## Probed facts (so this is verifiable, not assumed)

- VPS `coord_config.toml` has no `shards_dir` / `tick_data_root` / `data_windows_dir`.
- VPS NSSM env: `TICK_ARCHIVE_URL=http://192.168.1.17:8092`; `AlgoCoord` runs as `LocalSystem`.
- `.17:8091` and `.17:8092` — nothing listening.
- VPS `Z:` → `\\ALGOFOUNDRY\AlgoTickData`, persistent mapping for D3DTest's SID only, `Unavailable` in non-interactive sessions.
- VPS is `WORKGROUP` (`DESKTOP-HEP1RI6`, `PartOfDomain=False`) → no machine-account SMB identity to grant.
- Merged coord exposes `/tick_history`, `/tick_status`, `/r/{id}/s/{n}/bars`, `/api/playground/.../bars` — **no top-level `/bars`**.
- `coord/tick_archive_serve.py` is the only thing that serves `/bars`; header says `DEPRECATED`, default port 8091.
- devstream 2026-05-14: VPS coord intentionally leaves `tick_data_root` unset (VPS=thin, farm owns data); an **open, unresolved** proposal moves `E:/AlgoData/coord/` → `E:/MarketData/...` and renames `shards_dir` → `market_shards_dir`.

---

## Status of fixes

| Task | State |
|---|---|
| Coord fast-fail + circuit-breaker on the archive path (2s connect probe + 60s breaker) | **done in `coord/jsonl.py`**, not yet deployed — kills the 21s hang regardless of topology |
| Coord: surface archive-unavailable state to UI | pending |
| Coord: short-TTL response cache for assembled bars | pending |
| UI: stop cache-busting every slot switch + surface degraded state | pending |
| Data path (real archive history on VPS chart) | **blocked on topology decision** — premise of current model is broken; needs target-architecture pick + engine-claude coordination on the in-flight layout rename |

Next step: choose a coherent **target** architecture rather than keep patching a model
whose premise (farm=.17, HTTP archive server exists) is false.
