#!/usr/bin/env python3
"""
Trading Dashboard Server — Raspberry Pi
Access: http://192.168.178.31:5000
Builder: http://192.168.178.31:5000/builder
"""

from flask import Flask, jsonify, send_from_directory, request
from flask_cors import CORS
import yfinance as yf
import pandas as pd
import numpy as _np

try:
    from statsmodels.tsa.arima.model import ARIMA as _ARIMA
    _arima_ok = True
except ImportError:
    _arima_ok = False
import json, os, subprocess, time
import requests as _req
from datetime import datetime, timezone

# ── CHART CACHE ───────────────────────────────────────────────────────────────
_chart_cache = {}  # key -> (data, expires_at)

_CACHE_TTL = {
    "1m": 20, "5m": 60, "15m": 120,
    "30m": 120, "1h": 300, "1d": 600
}

def _cache_get(key):
    entry = _chart_cache.get(key)
    if entry and time.time() < entry[1]:
        return entry[0]
    return None

def _cache_set(key, data, ttl):
    _chart_cache[key] = (data, time.time() + ttl)

app = Flask(__name__, static_folder='static')
CORS(app)

# Start sentiment engine
try:
    import sentiment as _sentiment
    _sentiment.start()
    print("  Sentiment engine started.")
except Exception as e:
    print(f"  Sentiment engine unavailable: {e}")
    _sentiment = None

DEFAULT_WATCHLIST = ["BTC","AAPL","NVDA","TSLA","MSFT","AMZN","META","GOOGL","SPY"]
STATE_FILE        = "state.json"
CRYPTO_TICKERS    = {"BTC","ETH","BNB","SOL","DOGE","ADA","XRP","AVAX","DOT","LINK"}
VENV_PACKAGES     = "/home/bastra/trading/trading_dashboard/venv/lib/python3.13/site-packages"

def load_state():
    defaults = {
        "watchlist":      DEFAULT_WATCHLIST,
        "averages":       {},
        "active_ticker":  "BTC",
        "active_monitor": 1,
        "default_tf":     "30m",
        "chart_zoom":     150,
        "sidebar_width":  260,
        "update_interval": 1000,
        "monitors":       {"1": "BTC", "2": "NVDA", "3": "SPY"}
    }
    if os.path.exists(STATE_FILE):
        saved = json.load(open(STATE_FILE))
        for k, v in defaults.items():
            if k not in saved:
                saved[k] = v
        return saved
    return defaults

def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

def resolve_ticker(ticker):
    t = ticker.upper()
    return t + "-USD" if t in CRYPTO_TICKERS else t

def fetch_chart_data(ticker, period="5d", interval="30m"):
    cache_key = (ticker.upper(), period, interval)
    cached = _cache_get(cache_key)
    if cached is not None:
        return cached
    try:
        df = yf.Ticker(resolve_ticker(ticker)).history(period=period, interval=interval)
        if df.empty:
            return None
        df["MA20"] = df["Close"].rolling(20).mean()
        df["MA50"] = df["Close"].rolling(50).mean()
        candles = []
        for ts, row in df.iterrows():
            candles.append({
                "t":    int(ts.timestamp() * 1000),
                "o":    round(float(row["Open"]),  4),
                "h":    round(float(row["High"]),  4),
                "l":    round(float(row["Low"]),   4),
                "c":    round(float(row["Close"]), 4),
                "v":    int(row["Volume"]),
                "ma20": round(float(row["MA20"]), 4) if pd.notna(row["MA20"]) else None,
                "ma50": round(float(row["MA50"]), 4) if pd.notna(row["MA50"]) else None,
            })
        last       = candles[-1]["c"]
        change_pct = ((last - candles[0]["c"]) / candles[0]["c"]) * 100
        result = {"ticker": ticker.upper(), "last": last,
                  "change_pct": round(change_pct, 2), "interval": interval, "candles": candles}
        _cache_set(cache_key, result, _CACHE_TTL.get(interval, 60))
        return result
    except Exception as e:
        return {"error": str(e)}

def no_cache(response):
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response

@app.route("/")
def index():
    return no_cache(send_from_directory("static", "index.html"))

@app.route("/builder")
def builder():
    return no_cache(send_from_directory("static", "builder.html"))

@app.route("/api/chart/<ticker>")
def chart(ticker):
    period   = request.args.get("period",   "5d")
    interval = request.args.get("interval", "30m")
    data = fetch_chart_data(ticker.upper(), period, interval)
    if data is None:
        return jsonify({"error": "No data found"}), 404
    return jsonify(data)

@app.route("/api/sentiment")
def get_sentiment():
    if _sentiment is None:
        return jsonify({"error": "Sentiment engine not available"}), 503
    return jsonify(_sentiment.get())

def _crypto_details(ticker):
    sym = ticker + "USDT"
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    day_start_ms = int(datetime.now(timezone.utc).replace(
        hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
    buy_vol = 0.0; total_vol = 0.0
    start = day_start_ms
    while start < now_ms:
        r = _req.get("https://api.binance.com/api/v3/klines",
            params={"symbol": sym, "interval": "1m",
                    "startTime": start, "endTime": now_ms, "limit": 1000},
            timeout=6)
        chunk = r.json()
        if not chunk or isinstance(chunk, dict): break
        for k in chunk:
            total_vol += float(k[5])
            buy_vol   += float(k[9])   # taker buy base asset volume
        if len(chunk) < 1000: break
        start = chunk[-1][0] + 60000
    r2 = _req.get("https://api.binance.com/api/v3/klines",
        params={"symbol": sym, "interval": "1d", "limit": 8}, timeout=6)
    daily = r2.json()
    past = daily[:-1] if len(daily) > 1 else daily
    avg_daily = sum(float(k[5]) for k in past) / len(past) if past else 0
    return {"buy_vol": round(buy_vol, 4), "sell_vol": round(total_vol - buy_vol, 4),
            "total_vol": round(total_vol, 4), "avg_daily_vol": round(avg_daily, 4), "is_crypto": True}

def _stock_details(ticker):
    data_1m = fetch_chart_data(ticker, "1d", "1m")
    today_vol = int(sum(c["v"] for c in data_1m["candles"])) if data_1m and not data_1m.get("error") else 0
    data_1d = fetch_chart_data(ticker, "10d", "1d")
    candles_1d = data_1d["candles"] if data_1d and not data_1d.get("error") else []
    past = candles_1d[:-1] if len(candles_1d) > 1 else candles_1d
    avg_daily = int(sum(c["v"] for c in past) / len(past)) if past else 0
    return {"buy_vol": None, "sell_vol": None, "total_vol": today_vol,
            "avg_daily_vol": avg_daily, "is_crypto": False}

@app.route("/api/details/<ticker>")
def get_details(ticker):
    t = ticker.upper()
    cache_key = ("details", t)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        result = _crypto_details(t) if t in CRYPTO_TICKERS else _stock_details(t)
        _cache_set(cache_key, result, 10)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/forecast/<ticker>")
def get_forecast(ticker):
    import warnings
    t        = ticker.upper()
    interval = request.args.get("interval", "30m")
    period   = request.args.get("period",   "5d")
    n        = min(int(request.args.get("n", 20)), 50)

    cache_key = ("forecast", t, interval, period)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    data = fetch_chart_data(t, period, interval)
    if not data or data.get("error"):
        return jsonify({"error": "No chart data"}), 404

    candles = data["candles"]
    closes  = [c["c"] for c in candles]

    means = ci_lo = ci_hi = None
    if _arima_ok and len(closes) >= 10:
        try:
            with warnings.catch_warnings():
                warnings.filterwarnings("ignore")
                fit  = _ARIMA(closes, order=(2, 1, 2)).fit()
                fc   = fit.get_forecast(steps=n)
                means  = fc.predicted_mean.tolist()
                ci     = fc.conf_int(alpha=0.3)
                ci_lo  = ci.iloc[:, 0].tolist()
                ci_hi  = ci.iloc[:, 1].tolist()
        except Exception:
            means = None

    if means is None:
        # Fallback: linear extrapolation on last 20 candles
        xs    = _np.arange(min(20, len(closes)))
        ys    = _np.array(closes[-20:])
        m, b  = _np.polyfit(xs, ys, 1)
        means = [float(m * (len(xs) + i) + b) for i in range(n)]
        std   = float(_np.std(_np.diff(ys))) if len(ys) > 1 else float(closes[-1]) * 0.005
        ci_lo = [v - 2 * std for v in means]
        ci_hi = [v + 2 * std for v in means]

    recent = candles[-20:]
    atr    = float(_np.mean([c["h"] - c["l"] for c in recent]))
    interval_ms = candles[-1]["t"] - candles[-2]["t"] if len(candles) >= 2 else 1800000
    last_t = candles[-1]["t"]
    prev_c = float(candles[-1]["c"])

    forecast = []
    for i in range(n):
        fc_c = float(means[i])
        fc_o = prev_c
        fc_h = max(fc_o, fc_c) + atr * 0.3
        fc_l = min(fc_o, fc_c) - atr * 0.3
        forecast.append({
            "t":     int(last_t + (i + 1) * interval_ms),
            "o":     round(fc_o, 4),  "h": round(fc_h, 4),
            "l":     round(fc_l, 4),  "c": round(fc_c, 4),
            "ci_lo": round(float(ci_lo[i]), 4),
            "ci_hi": round(float(ci_hi[i]), 4),
        })
        prev_c = fc_c

    result = {"ticker": t, "interval": interval,
              "model": "ARIMA(2,1,2)" if _arima_ok else "linear", "forecast": forecast}
    _cache_set(cache_key, result, 60)
    return jsonify(result)

@app.route("/api/mini/<ticker>")
def mini_chart(ticker):
    data = fetch_chart_data(ticker.upper(), period="5d", interval="30m")
    if data is None:
        return jsonify({"error": "No data"}), 404
    return jsonify(data)

@app.route("/api/state", methods=["GET"])
def get_state():
    return jsonify(load_state())

@app.route("/api/state", methods=["POST"])
def update_state():
    state   = load_state()
    updates = request.json or {}
    for key in ["averages","monitors","active_ticker","active_monitor",
                "default_tf","chart_zoom","sidebar_width","update_interval",
                "active_curve","rsi_period","utility_height","right_panel_width"]:
        if key in updates:
            state[key] = updates[key]
    save_state(state)
    return jsonify({"ok": True})

@app.route("/api/watchlist", methods=["GET"])
def get_watchlist():
    return jsonify(load_state()["watchlist"])

@app.route("/api/watchlist", methods=["POST"])
def set_watchlist():
    state = load_state()
    state["watchlist"] = [t.upper() for t in request.json.get("tickers", [])]
    save_state(state)
    return jsonify({"ok": True, "watchlist": state["watchlist"]})

@app.route("/api/average/<ticker>", methods=["POST"])
def set_average(ticker):
    state = load_state()
    price = request.json.get("price")
    if price is not None:
        state["averages"][ticker.upper()] = float(price)
        save_state(state)
    return jsonify({"ok": True})

@app.route("/api/average/<ticker>", methods=["DELETE"])
def delete_average(ticker):
    state = load_state()
    state["averages"].pop(ticker.upper(), None)
    save_state(state)
    return jsonify({"ok": True})

@app.route("/api/reload", methods=["POST"])
def reload_dashboard():
    try:
        import urllib.request, json as _json
        tabs   = _json.loads(urllib.request.urlopen("http://localhost:9222/json").read())
        if not tabs:
            return jsonify({"ok": False, "error": "No tabs"}), 500
        tab_id = tabs[0]["id"]
        result = subprocess.run(["python3", "-c", f"""
import json, websocket
ws = websocket.create_connection(
    "ws://localhost:9222/devtools/page/{tab_id}",
    header={{"Origin": "http://localhost:9222"}})
ws.send(json.dumps({{"id":1,"method":"Page.reload","params":{{}}}}))
ws.close()
"""], capture_output=True, timeout=5,
            env={**os.environ, "PYTHONPATH": VENV_PACKAGES})
        if result.returncode == 0:
            return jsonify({"ok": True})
        return jsonify({"ok": False, "error": result.stderr.decode()}), 500
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

if __name__ == "__main__":
    os.makedirs("static", exist_ok=True)
    print("=" * 55)
    print("  Trading Dashboard Server")
    print("  http://0.0.0.0:5000")
    print(f"  Access via: http://192.168.178.31:5000")
    print("=" * 55)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)