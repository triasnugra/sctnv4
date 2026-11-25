"""Uji paritas: simulate_trade (Python, mesin sctn) vs simulate (JS, monitor).
Pemakaian: python3 test/parity.py <path simulator.py mesin>   (dari root repo monitorsctn)
Membuat 400 skenario acak (candle 15m sintetis), menjalankan keduanya, membandingkan status/outcome/R."""
import importlib.util, json, subprocess, sys
import numpy as np, pandas as pd

spec = importlib.util.spec_from_file_location("simulator", sys.argv[1])
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
rng = np.random.default_rng(42)
EV = {"fee_pct_roundtrip": 0.10, "pending_expiry_hours": 24, "max_hold_hours": 72}
cases = []
for i in range(400):
    n = int(rng.integers(40, 500))
    t0 = pd.Timestamp("2026-11-01", tz="UTC") + pd.Timedelta(minutes=int(rng.integers(0, 600)) * 15)
    idx = pd.date_range(t0, periods=n, freq="15min", tz="UTC")
    p = 100 * np.exp(np.cumsum(rng.normal(0, rng.choice([0.002, 0.004, 0.008]), n)))
    hi = p * (1 + np.abs(rng.normal(0, 0.003, n))); lo = p * (1 - np.abs(rng.normal(0, 0.003, n)))
    df = pd.DataFrame({"open": p, "high": np.maximum(hi, p), "low": np.minimum(lo, p), "close": p}, index=idx)
    long = bool(rng.integers(0, 2)); sg = 1 if long else -1
    px = float(p[0]); stop_pct = float(rng.choice([0.7, 1.0, 1.5, 2.5]))
    zone = bool(rng.integers(0, 2))
    entry = px if zone else px * (1 - sg * rng.uniform(0.002, 0.012))
    stop = entry * (1 - sg * stop_pct / 100); d = abs(entry - stop)
    tp1 = entry + sg * d * rng.uniform(1.2, 2); tp2 = entry + sg * d * rng.uniform(2.5, 4)
    be = entry + sg * entry * 0.001
    asof = idx[0] + pd.Timedelta(minutes=int(rng.integers(0, 14)))
    s = {"direction": "LONG" if long else "SHORT", "status": "ENTRY ZONE" if zone else "PENDING LIMIT", "asof": asof,
         "entry": entry, "stop": stop, "tp1": tp1, "tp2": tp2, "be_stop": be, "tp1_close_pct": 60.0, "stop_pct": stop_pct}
    py = m.simulate_trade(s, df, EV)
    cs = [{"t": int(ts.value // 10**6), "h": float(r.high), "l": float(r.low), "c": float(r.close)} for ts, r in df.iterrows()]
    cases.append({"s": {"dir": s["direction"], "statusSig": s["status"], "asof": int(asof.value // 10**6), "entry": entry, "stop": stop,
                        "tp1": tp1, "tp2": tp2, "be": be, "f": 60.0, "stopPct": stop_pct}, "cs": cs,
                  "py": {"status": py["status"], "outcome": py["outcome"], "r": py["r"]}})
out = subprocess.run(["node", "test/parity.mjs"], input=json.dumps(cases), capture_output=True, text=True)
if out.returncode: print(out.stderr); sys.exit(1)
js = json.loads(out.stdout); bad = 0; kinds = {}
for c, j in zip(cases, js):
    p = c["py"]; kinds[p["status"] + "/" + p["outcome"]] = kinds.get(p["status"] + "/" + p["outcome"], 0) + 1
    ok = p["status"] == j["status"] and p["outcome"] == j["outcome"] and ((p["r"] is None and j["r"] is None) or abs(p["r"] - j["r"]) < 1e-3)
    if not ok:
        bad += 1
        if bad <= 5: print("BEDA", p, j)
print("skenario:", len(cases), "beda:", bad, "sebaran:", kinds)
sys.exit(1 if bad else 0)
