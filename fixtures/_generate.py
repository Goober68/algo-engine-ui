#!/usr/bin/env python3
"""Generate algo-engine-ui mock fixtures from real runner JSONLs +
broker-truth trade CSVs. Produces one folder per slot:

  fixtures/
    live_2026_05_10/
      meta.json
      slot0/
        bars.jsonl          # synthesized OHLC from decision close fields
        decisions.jsonl     # filtered runner output (drops warmup floods)
        trades.jsonl        # paired fills from open_qty transitions
        broker_truth.jsonl  # closed trades from TPT-{N}_trades.csv
      slot1/ ...
      slot2/ ...

Bars are synthesized — runner emits only `close` per bar, so H/L are
faked as close +/- (1/2 * |close - prev_close|) for plausible candles.
Replace with real OHLC source if/when runner emits bar events directly.
"""
import csv
import json
import os
from datetime import datetime, timezone
from pathlib import Path

ROOT     = Path(__file__).parent
SRC_RUN  = Path("C:/tmp/slot_jsonls")
SRC_CSV  = Path("C:/Develop/gh/algo-backtester/data/live_accounts")
OUT_RUN  = ROOT / "live_2026_05_10"

SLOTS = [
    (0, "TPT-499", "cluster_v2 canonical",
        {"fastPeriod": 29, "slowPeriod": 62}),
    (1, "TPT-656", "tpAtrMult=5.5",
        {"fastPeriod": 34, "slowPeriod": 70, "tpAtrMult": 5.5}),
    (2, "TPT-671", "distAdjust=0.30",
        {"fastPeriod": 25, "slowPeriod": 60, "distAdjust": 0.30}),
]

CUTOFF_NS = int(datetime(2026, 5, 11, 2, 30, tzinfo=timezone.utc).timestamp() * 1e9)


def load_decisions(slot_idx: int) -> list[dict]:
    """Load all decision events for this slot across all sessions,
    de-duped by ts_ns (NOT bar_idx — bar_idx is a session-local counter
    that resets on each runner restart, so the same bar_idx in two
    sessions means different things). Later sessions win on duplicates,
    matching warmup-from-history semantics where a restarted runner
    replays bars from before its boot time."""
    by_ts: dict[int, dict] = {}
    files = sorted(SRC_RUN.glob(f"slot{slot_idx}_*.jsonl"),
                   key=lambda p: p.stat().st_mtime)
    for path in files:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                s = line.strip()
                if not s.startswith("{"):
                    continue
                try:
                    obj = json.loads(s)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") != "decision":
                    continue
                ts = obj.get("ts_ns")
                if ts is None:
                    continue
                by_ts[ts] = obj   # later mtime overwrites
    out = sorted(by_ts.values(), key=lambda d: d["ts_ns"])
    return out


def synthesize_bars(decisions: list[dict]) -> list[dict]:
    """Synthesize OHLC bars from decision events. Runner emits close per
    bar; we fake H/L = close +/- max(|range|/2, tick_size). Volume left 0."""
    TICK = 0.25
    out = []
    for i, d in enumerate(decisions):
        c = d["xovd"]["close"]
        pc = d["xovd"]["prev_close"] if i > 0 else c
        rng = abs(c - pc)
        half = max(rng / 2, TICK)
        # Bias so candle is up if c > pc, down otherwise. Open near pc, close c.
        o = pc if i > 0 else c
        h = max(o, c) + half * 0.4
        l = min(o, c) - half * 0.4
        # Round to tick
        h = round(h / TICK) * TICK
        l = round(l / TICK) * TICK
        out.append({
            "ts_ns": d["ts_ns"],
            "bar_idx": d["bar_idx"],
            "open":  round(o, 2),
            "high":  round(h, 2),
            "low":   round(l, 2),
            "close": round(c, 2),
            "volume": 0,
            "fast_ma": d["xovd"]["fast_ma"],
            "slow_ma": d["xovd"]["slow_ma"],
            "atr":     d["xovd"]["atr"],
        })
    return out


def sim_from_broker(broker: list[dict]) -> list[dict]:
    """For mock purposes: derive sim trades by lightly jittering broker
    truth. Real wiring replaces this with the runner's emitted fills.
    Jitter pattern: +/- 0-3 ticks on entry/exit price, +/-$3 on pnl, so
    the reconcile equity-curve diff is visibly nonzero."""
    import hashlib
    out = []
    for i, b in enumerate(broker):
        # Deterministic per-trade jitter (hash of entry_ts) so re-runs match
        h = int(hashlib.sha1(str(b["entry_ts"]).encode()).hexdigest()[:8], 16)
        ent_jit = ((h % 7) - 3) * 0.25         # +/- 3 ticks
        ext_jit = (((h >> 4) % 7) - 3) * 0.25
        pnl_jit = (((h >> 8) % 11) - 5) * 0.50  # +/- $2.50
        out.append({
            "trade_id":  i,
            "side":      b["side"],
            "qty":       b["qty"],
            "entry_ts":  b["entry_ts"],
            "entry_px":  round(b["entry_px"] + ent_jit, 2),
            "exit_ts":   b["exit_ts"],
            "exit_px":   round((b["exit_px"] or b["entry_px"]) + ext_jit, 2) if b["exit_px"] else None,
            "pnl":       round(b["pnl"] + pnl_jit, 2),
            "reason":    "tp" if b["pnl"] > 30 else "sl" if b["pnl"] < -30 else "trail",
            "comm":      b.get("comm", 0),
        })
    return out


def load_broker_truth(account: str) -> list[dict]:
    path = SRC_CSV / account / f"{account}_trades.csv"
    if not path.exists():
        return []
    out = []
    with path.open("r", encoding="utf-8") as fh:
        for row in csv.DictReader(fh):
            iso = row.get("entry_time_cached", "")
            if not iso:
                continue
            try:
                t = datetime.fromisoformat(iso)
            except ValueError:
                continue
            entry_ns = int(t.timestamp() * 1e9)
            if entry_ns < CUTOFF_NS:
                continue
            exit_iso = row.get("exit_time_cached", "")
            exit_ns = int(datetime.fromisoformat(exit_iso).timestamp() * 1e9) if exit_iso else None
            out.append({
                "side":       row["side"],
                "qty":        int(row["qty_original_cached"]),
                "entry_ts":   entry_ns,
                "entry_px":   float(row["entry_price_cached"]),
                "exit_ts":    exit_ns,
                "exit_px":    float(row.get("exit_price_cached") or 0) or None,
                "pnl":        float(row.get("realized_pnl_cached", 0)),
                "comm":       float(row.get("commission_total_cached", 0)),
                "algo_id":    row.get("algo_id_cached", ""),
            })
    out.sort(key=lambda t: t["entry_ts"])
    return out


def write_jsonl(path: Path, records: list[dict]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r, separators=(",", ":")) + "\n")


def main():
    OUT_RUN.mkdir(parents=True, exist_ok=True)
    run_meta = {
        "run_id": "live_2026_05_10",
        "kind": "live",
        "started_at": "2026-05-10T19:25:02-07:00",
        "completed_at": "2026-05-11T07:00:00-07:00",  # fixture is replay-style
        "schema_version": 1,
        "symbol": "MNQM6",
        "bar_period_sec": 180,
        "slots": [],
    }

    for slot_idx, account, label, cfg in SLOTS:
        print(f"slot {slot_idx} ({account} / {label})")
        decisions = load_decisions(slot_idx)
        bars = synthesize_bars(decisions)
        broker = load_broker_truth(account)
        trades = sim_from_broker(broker)
        print(f"  decisions={len(decisions)}  bars={len(bars)}  "
              f"trades={len(trades)}  broker_truth={len(broker)}")

        slot_dir = OUT_RUN / f"slot{slot_idx}"
        write_jsonl(slot_dir / "bars.jsonl",         bars)
        write_jsonl(slot_dir / "decisions.jsonl",    decisions)
        write_jsonl(slot_dir / "trades.jsonl",       trades)
        write_jsonl(slot_dir / "broker_truth.jsonl", broker)

        run_meta["slots"].append({
            "slot_idx": slot_idx,
            "account":  account,
            "label":    label,
            "config":   cfg,
            "live":     True,
            "n_bars":   len(bars),
            "n_trades": len(trades),
            "n_broker": len(broker),
        })

    with (OUT_RUN / "meta.json").open("w", encoding="utf-8") as fh:
        json.dump(run_meta, fh, indent=2)
    print(f"[done] wrote {OUT_RUN}")


if __name__ == "__main__":
    main()
