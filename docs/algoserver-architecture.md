# AlgoServer architecture — as-built + target (2026-05-15)

Authoritative reference for the coord/UI/data-plane architecture as it
stands after the 2026-05-15 work. Companion to:

- `C:\Develop\gh\AlgoServer.drawio` — the user's hand-drawn **target**
  topology (source of truth for intent).
- `docs/bars-pipeline-diagnosis-2026-05-15.md` — the diagnosis of the
  *broken* state that triggered this work (historical; superseded by
  this doc for current state).

Status legend: ✅ live & verified · 🔨 partial · ⛔ pending operator ·
🔭 future · 🧩 engine-claude dependency.

---

## Topology (3 boxes, workgroup — no AD)

| Box | Role | Runs |
|---|---|---|
| **VPS** `DESKTOP-HEP1RI6` `.203` | Live trading | `runner.exe` (AlgoEngineRunner, 3 LIVE slots TPT-499/656/671), Databento feed, **AlgoCoord** (`:8090`, LocalSystem), AlgoDataStore, local shard cache |
| **AlgoFoundry / .17** `\\ALGOFOUNDRY` | Dev + data hub | Source repos, UI dev (Vite `:5173`), `E:\TickData` (raw DBN), `E:\MarketData\TBBODailyShards` (canonical shards), the Claude agents. **No coord runs here.** |
| **GPU box** `.21` | Sweep/playground compute | ROCm/HIP kernels |

`\\ALGOFOUNDRY\AlgoTickData` = `.17 E:\` root, share ACL `Everyone:Read`.
The live runner binary on the VPS is `C:\gh\algo-engine\build-runner\runner\runner.exe`.

---

## Two data planes (do not conflate)

### Plane A — market tick/bar (the chart's history)

```
.17 E:\TickData (raw DBN, fresh)
   └─ tools/daily_shard_extractor.py  (canonical layout producer)
        └─ E:\MarketData\TBBODailyShards\MNQ\<YYYY>\<date>.tick.bin   (tick-only, immutable)
              └─ [daily PULL: D3DTest scheduled robocopy, NOT LocalSystem]
                   └─ VPS C:\MarketData\TBBODailyShards\…
                        └─ coord/stitcher.py  (in-proc, numpy bar-derive, SHA256 stitch cache)
                             └─ GET /r/{id}/s/{slot}/bars  → src=shard:stitched
```

- ✅ Stitcher reads canonical `<root>/<root-symbol>/<YYYY>/<date>.tick.bin`
  with `MNQM6↔MNQ↔MNQ.c.0` alias + year-partition probe (`7383e25`).
- ✅ Extractor (`985a488`) + self-healing catch-up `extract_recent_shards.py`
  (`327899b`) emit the **same** canonical layout (producer/consumer aligned).
- ✅ VPS `coord_config.toml [paths]` `shards_dir`/`data_windows_dir` →
  local cache; `tick_data_root` unset (VPS doesn't extract).
- ⛔ `.17` daily extractor scheduled task — **operator must register**
  (elevated; command in MEMORY). Latest shard until then lags.
- ⛔ VPS daily pull is the user's D3DTest 18:30 robocopy task.
- A row store would be **wrong** here — binary columnar shards are correct.

### Plane B — runner-emitted streams (decisions/fills/…)

```
runner.exe  → append-only NDJSON WAL  (runner_slot{N}_*.jsonl, relay_audit_*)   [ZERO-BLOCK: nothing else in tick path]
   └─ coord/runner_ingest.py  (_runner_ingest_loop, 5s, executor, idempotent upsert)
        └─ coord/algodatastore.py  SqliteAlgoStore  (PK (runner,slot,stream,ts_ns) WITHOUT ROWID)
             └─ get_slot_decisions / get_slot_bars decisions-merge   (store-backed, O(1) cold-slot glob fallback)
                  └─ GET /_store/parity  (ongoing glob-vs-store health)
```

- ✅ Store + ingester + decisions cutover live & **parity-proven**
  (`all_equal:true` vs glob; decisions 2602 rows 0.02s vs old
  glob-concat-dedup-per-request).
- 🔨 Still glob (separate future passes): trades (`load_slot_trades`
  pairing — needs own parity), `bars.jsonl` splice (live tail),
  `current_state.jsonl` ingest.
- 🔭 Mongo driver: `open_store()` is the swap seam; interface ready.

---

## Runner Bldr (lifecycle management)

`coord/runner_defs.py` (store, `coord/data/runners/{id}/`) +
`runner_deploy.py` (orchestrator) + `runner_schedule.py` + nssm
primitives. Endpoints: `GET/PUT/DELETE /runner-defs[/{id}]`,
`POST /runner-defs/{id}/deploy?dry_run|force`.

- ✅ Phase 1: snapshot-preserving deploy (safety-guard → nssm stop →
  write slots → swap Application → start → verify → rollback),
  scheduler, dry-run proven on live VPS (non-destructive).
- 🧩 Phase 2 (true zero-bounce hot-swap): blocked on engine-claude —
  `runner.exe` must `LoadLibrary` algobot behind a stable ABI +
  FreeLibrary/reload + live state hand-off (reuse ASNP snapshot). Ask
  filed in `algo-engine/devstream.md`.

---

## Invariants (load-bearing — do not violate)

1. **Runner zero-block.** `runner.exe` only appends local NDJSON. No
   DB/network/sync in its tick path. Everything else (ingest, store,
   deploy, pull) is async/failure-isolated. Held across all 2026-05-15
   work.
2. **Source-of-truth / no silent staleness.** Charts READ from a
   store; degraded conditions are surfaced (X-Bars-Archive header +
   UI banner), never papered over. Cutovers may never serve *less*
   than the pre-store path (the O(1) cold-slot glob fallback).
3. **Parity before flip.** `/_store/parity` must be `all_equal:true`
   before any further store cutover; it's the ongoing health signal.
4. **coord is ui-claude territory; runner internals are engine-claude.**
   Cross-line changes go through `devstream.md`.

---

## Coord module map (new/changed 2026-05-15)

| File | Purpose |
|---|---|
| `coord/jsonl.py` | `build_bars_from_ticks` 2s connect-probe + 60s circuit breaker (dead-sidecar fast-fail) |
| `coord/stitcher.py` | canonical shard layout resolver (alias + year-partition) |
| `coord/algodatastore.py` | AlgoDataStore ABC + SqliteAlgoStore + `open_store` swap seam |
| `coord/runner_ingest.py` | WAL→store tailer (partial-line safe, idempotent) |
| `coord/runner_defs.py` / `runner_deploy.py` / `runner_schedule.py` | Runner Bldr |
| `coord/nssm.py` | + get/set Application, install, remove |
| `coord/main.py` | endpoints + `_runner_ingest_loop`/`_runner_schedule_loop` + `_slot_decisions` + `/_store/parity` |
| `tools/daily_shard_extractor.py` / `extract_recent_shards.py` | canonical-layout producer + self-healing catch-up |

`tzdata` is a **required** coord venv dep on Windows (Python 3.13 has
no IANA DB; `ZoneInfo` crashes the catchup loop otherwise). Not yet in
`coord/requirements.txt` — add when next touched.

---

## Resume checklist (next session)

1. Read `MEMORY.md` → `project_algoserver_target_architecture_2026_05_15`.
2. `git -C C:\Develop\gh\algo-engine log --oneline -15` for the commit trail.
3. Verify VPS HEAD == origin (`ssh algo-vps` … `git rev-parse HEAD`) —
   **committed ≠ deployed** (see lesson memory).
4. `GET http://192.168.1.203:8090/_store/parity` → expect `all_equal:true`.
5. Open items: `#8` operator actions, store future passes (trades/splice/
   state/Mongo), `#9` Linux backlog, Phase-2 engine ask.
