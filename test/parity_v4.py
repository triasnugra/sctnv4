"""Uji paritas: simulate_trade (Python, mesin sctnv4: scalp/risk.py) vs simulatePy (JS, monitor).
Pemakaian (dari root repo msctn):  python3 test/parity_v4.py <folder sctnv4-main>
400 skenario acak (candle 5m sintetis); membandingkan status/outcome/R."""
import json, subprocess, sys
import numpy as np, pandas as pd
sys.path.insert(0, sys.argv[1])
from scalp.config import load_config
from scalp.risk import simulate_trade

cfg = load_config(None)
rng = np.random.default_rng(7)
OUT = {"SL": "LOSS", "TP1_BE": "TP1_BE", "TP1_SL": "TP1_SL", "TP2": "TP2", "TIME": "TIMEOUT", "TP1_TIME": "TIMEOUT"}
cases, expect = [], []
for i in range(400):
    n = int(rng.integers(30, 400))
    t0 = pd.Timestamp("2026-11-25", tz="UTC") + pd.Timedelta(minutes=int(rng.integers(0, 200)) * 5)
    idx = pd.date_range(t0, periods=n, freq="5min", tz="UTC")
    p = 100 * np.exp(np.cumsum(rng.normal(0, rng.choice([0.001, 0.002, 0.004]), n)))
    hi = np.maximum(p * (1 + np.abs(rng.normal(0, 0.002, n))), p); lo = np.minimum(p * (1 - np.abs(rng.normal(0, 0.002, n))), p)
    df = pd.DataFrame({"time": idx, "open": p, "high": hi, "low": lo, "close": p})
    long = bool(rng.integers(0, 2)); sg = 1 if long else -1
    entry = float(p[0]); stop_pct = float(rng.choice([0.7, 1.0, 1.5, 2.5]))
    stop = entry * (1 - sg * stop_pct / 100); d = abs(entry - stop)
    tp1 = entry + sg * d * rng.uniform(1.0, 2); tp2 = entry + sg * d * rng.uniform(2.2, 4)
    start = idx[0] + pd.Timedelta(seconds=int(rng.integers(0, 290)))
    o = simulate_trade(df, "long" if long else "short", entry, stop, tp1, tp2, start, cfg)
    expect.append({"status": "CLOSED" if o["closed"] else "OPEN", "outcome": OUT.get(o["status"], ""), "r": round(float(o["r"]), 4)})
    fee = 2.0 * (cfg.account.fee_bps + cfg.account.slippage_bps) / 100.0  # persen pulang-pergi
    cases.append({"s": {"dir": "LONG" if long else "SHORT", "asof": int(start.value // 10**6), "entry": entry, "stop": stop, "tp1": tp1, "tp2": tp2,
                        "f": 100 * float(cfg.risk.tp1_fraction), "stopPct": stop_pct},
                  "cs": [{"t": int(ts.value // 10**6), "h": float(r.high), "l": float(r.low), "c": float(r.close)} for _, r in df.iterrows() for ts in [r.time]],
                  "ev": {"fee": fee, "holdH": float(cfg.risk.time_stop_hours)}})
res = json.loads(subprocess.run(["node", "test/parity_v4.mjs"], input=json.dumps(cases), capture_output=True, text=True, check=True).stdout)
bad = [(i, e, r) for i, (e, r) in enumerate(zip(expect, res)) if e["status"] != r["status"] or e["outcome"] != r["outcome"] or abs(e["r"] - r["r"]) > 1e-3]
from collections import Counter
print("skenario:", len(res), "| beda:", len(bad), "| sebaran hasil:", dict(Counter(e["outcome"] or e["status"] for e in expect)))
for b in bad[:5]: print(b)
sys.exit(1 if bad else 0)
