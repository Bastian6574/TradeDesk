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
import json, os, subprocess, time

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