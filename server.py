#!/usr/bin/env python3
"""
Trading Dashboard Server — Raspberry Pi
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
import json, os, re, subprocess, time
import requests as _req
from datetime import datetime, timezone


# ── PINE SCRIPT TRANSLATOR ────────────────────────────────────────────────────
def _pine_remove_fills(script: str) -> str:
    """Remove fill() calls that may span multiple lines."""
    out, depth, active = [], 0, False
    for line in script.split('\n'):
        if not active:
            if re.match(r'\s*fill\s*\(', line):
                depth = line.count('(') - line.count(')')
                out.append('// fill() removed')
                active = depth > 0
            else:
                out.append(line)
        else:
            depth += line.count('(') - line.count(')')
            if depth <= 0:
                active = False
    return '\n'.join(out)


def _pine_comment_method_bodies(script: str) -> str:
    """Comment out indented bodies after 'method' definitions."""
    lines = script.split('\n')
    out = []
    in_body, body_indent = False, 0
    for line in lines:
        stripped = line.strip()
        if re.match(r'\s*// method:', line):
            out.append(line)
            in_body = True
            body_indent = len(line) - len(line.lstrip())
            continue
        if in_body:
            if not stripped:
                out.append(line)
                continue
            curr = len(line) - len(line.lstrip())
            if curr > body_indent:
                out.append('//' + line)
                continue
            in_body = False
        out.append(line)
    return '\n'.join(out)


def _remove_call_lines(script: str, fname: str) -> str:
    """Comment out all calls to fname(...), handling multi-line calls."""
    out, depth, active = [], 0, False
    pattern = re.compile(r'\b' + re.escape(fname) + r'\s*\(')
    for line in script.split('\n'):
        if not active:
            if pattern.search(line):
                depth = line.count('(') - line.count(')')
                out.append('// ' + line)
                active = depth > 0
            else:
                out.append(line)
        else:
            out.append('// ' + line)
            depth += line.count('(') - line.count(')')
            if depth <= 0:
                active = False
    return '\n'.join(out)


def _stub_security_calls(script: str) -> str:
    """Replace security()/request.security() tuple destructures with float na vars."""
    lines = script.split('\n')
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        # [a, b, c] = request.security(...) or security(...)
        m = re.match(r'^(\s*)\[([^\]]+)\]\s*=\s*(?:request\.)?security\s*\(', line)
        if m:
            indent, varlist = m.group(1), m.group(2)
            for v in [x.strip() for x in varlist.split(',')]:
                out.append(f'{indent}float {v} = na')
            # consume lines until the call closes
            depth = line.count('(') - line.count(')')
            while depth > 0 and i + 1 < len(lines):
                i += 1
                depth += lines[i].count('(') - lines[i].count(')')
        else:
            # simple var = request.security(...) / security(...)
            if re.search(r'(?:request\.)?security\s*\(', line):
                line = re.sub(r'\brequest\.security\s*\([^)]*(?:\([^)]*\)[^)]*)*\)', 'na', line)
                line = re.sub(r'(?<![.\w])security\s*\([^)]*(?:\([^)]*\)[^)]*)*\)', 'na', line)
            out.append(line)
        i += 1
    return '\n'.join(out)


def _convert_v4_study(s: str) -> str:
    """Convert v4 study() → v5 indicator()."""
    def _repl(m):
        inner = m.group(1)
        if re.search(r'\boverlay\s*=', inner):
            return f'indicator({inner})'
        # Parse positional args at depth 0
        depth, parts, cur = 0, [], []
        for ch in inner:
            if ch in '([': depth += 1
            elif ch in ')]': depth -= 1
            if ch == ',' and depth == 0:
                parts.append(''.join(cur).strip()); cur = []
            else:
                cur.append(ch)
        if cur:
            parts.append(''.join(cur).strip())
        title = parts[0] if parts else '""'
        overlay = parts[2].strip() if len(parts) > 2 else 'false'
        return f'indicator({title}, overlay={overlay})'
    return re.sub(r'\bstudy\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)', _repl, s)


# v2/v3 bare TA function names that need the ta. prefix in v5
_V2_TA_FUNCS = [
    'sma', 'ema', 'rma', 'wma', 'vwma', 'atr', 'rsi', 'cci', 'mfi',
    'mom', 'obv', 'stdev', 'variance', 'highest', 'lowest',
    'highestbars', 'lowestbars', 'crossover', 'crossunder', 'cross',
    'rising', 'falling', 'change', 'linreg', 'correlation', 'cum', 'tr',
    'stoch', 'supertrend', 'bb', 'bbw', 'kc', 'kcw', 'dmi', 'adx',
    'wpr', 'alma', 'cmo', 'tsi', 'vwap', 'swma', 'pvt',
]

# v2 bare color names (used without color. prefix)
_V2_BARE_COLORS = [
    'red', 'green', 'blue', 'orange', 'yellow', 'purple',
    'white', 'black', 'gray', 'silver', 'teal', 'lime',
    'aqua', 'navy', 'maroon', 'olive', 'fuchsia',
]


def _translate_pine(script: str) -> str:
    """Translate Pine Script v2/v4/v5/v6 → PineTS-compatible subset."""
    s = script

    # v4: study() → indicator()
    s = _convert_v4_study(s)

    # version → 5
    s = re.sub(r'//@version=\d+', '//@version=5', s)

    # remove import statements (external TradingView libraries not supported)
    s = re.sub(r'^\s*import\s+\S+\s+as\s+\w+[^\n]*\n?', '', s, flags=re.MULTILINE)
    s = re.sub(r'^\s*import\s+\S+\n?', '', s, flags=re.MULTILINE)

    # security() / request.security() → stub variable declarations as na
    s = _stub_security_calls(s)

    # strip unsupported indicator() params
    for p in ['calc_bars_count', 'explicit_plot_zorder', 'max_boxes_count',
              'max_lines_count', 'max_labels_count', 'max_polylines_count',
              'max_bars_back']:
        s = re.sub(r',\s*' + p + r'\s*=\s*[^,)]+', '', s)

    # v2/v3: bare TA function names → ta.* prefix (only where not already prefixed)
    for fn in _V2_TA_FUNCS:
        s = re.sub(r'(?<![.\w])' + fn + r'(?=\s*\()', f'ta.{fn}', s)

    # v2: transp= transparency param → strip (deprecated; handled via color.new)
    s = re.sub(r',\s*transp\s*=\s*[\d.]+', '', s)

    # v2: bare color names → color.NAME (only in color-argument contexts)
    _COLOR_PARAMS = r'(?:color|textcolor|bgcolor|bordercolor|linecolor|' \
                    r'framecolor|wickcolor|fill_color|line_color)'
    for col in _V2_BARE_COLORS:
        # After color-type parameter: color=teal → color=color.teal
        s = re.sub(r'\b(' + _COLOR_PARAMS + r'\s*=\s*)' + col + r'\b',
                   lambda m, c=col: m.group(1) + 'color.' + c, s)
        # As first arg of color.new(teal, N) → color.new(color.teal, N)
        s = re.sub(r'\bcolor\.new\s*\(\s*' + col + r'\s*,',
                   f'color.new(color.{col},', s)
    # Special: grey → color.gray
    s = re.sub(r'\b(' + _COLOR_PARAMS + r'\s*=\s*)grey\b',
               lambda m: m.group(1) + 'color.gray', s)

    # plotshape / plotcandle / barcolor / alert → comment out (unsupported)
    for fn in ('plotshape', 'plotcandle', 'barcolor', 'alert'):
        s = _remove_call_lines(s, fn)

    # polyline type declarations → float; polyline.new/methods → na
    s = re.sub(r'\bpolyline\b(?=\s+\w)', 'float', s)
    s = re.sub(r'\bpolyline\.new\s*\([^)]*\)', 'na', s)
    s = re.sub(r'\bpolyline\.\w+\s*\([^)]*\)', 'na', s)

    # ta.bb(src,len,mult) → inline [basis, upper, lower] tuple
    def _expand_bb(m):
        src, length, mult = m.group(1), m.group(2), m.group(3)
        basis = f'ta.sma({src},{length})'
        dev   = f'({mult})*ta.stdev({src},{length})'
        return f'[{basis}, {basis}+{dev}, {basis}-{dev}]'
    s = re.sub(r'\bta\.bb\s*\(([^,)]+),\s*([^,)]+),\s*([^)]+)\)', _expand_bb, s)

    # var const → var
    s = re.sub(r'\bvar\s+const\b', 'var', s)

    # remove 'simple' type modifier
    s = re.sub(r'\bsimple\s+(?=float|int|bool|string|color)', '', s)

    # remove enum blocks (v6)
    s = re.sub(r'\nenum\s+\w+(?:\n(?:[ \t]+[^\n]+|\s*))*', '', s)

    # input.enum() → string of default value name
    s = re.sub(r'input\.enum\s*\(\s*\w+\.(\w+)\b[^)]*\)',
               lambda m: f'"{m.group(1)}"', s)
    s = re.sub(r'input\.enum\s*\([^)]*\)', '"default"', s)

    # method defs → comment out (body stays as plain function)
    s = re.sub(r'^(\s*)method\s+', r'\1// method: ', s, flags=re.MULTILINE)

    # drawing-type array constructors → float array
    s = re.sub(r'array\.new\s*<\s*(?:line|label|box|table|linefill|polyline|chart\.point)\s*>\s*\(\)',
               'array.new<float>()', s)
    s = re.sub(r'array\.from\s*\(([^)]+)\)', r'array.from(\1)', s)  # keep array.from

    # drawing object creation → na
    for obj in ['line', 'label', 'box', 'table', 'linefill']:
        s = re.sub(r'\b' + obj + r'\.new\s*\([^)]*\)', 'na', s)
        s = re.sub(r'\b' + obj + r'\.\w+\s*\([^)]*\)', 'na', s)

    # .delete() → nothing
    s = re.sub(r'\.delete\s*\(\s*\)', '', s)

    # matrix → unsupported
    s = re.sub(r'\bmatrix\s*<\s*\w+\s*>', 'float[]', s)
    s = re.sub(r'\bmatrix\.\w+\s*(?:<[^>]+>)?\s*\([^)]*\)', 'na', s)
    s = re.sub(r'(\w+)\.mult\s*\([^)]+\)', r'na', s)

    # color helpers
    s = re.sub(r'color\.from_gradient\s*\([^)]*\)', 'color.gray', s)
    s = re.sub(r'\.scale_alpha\s*\(\s*[\d.]+\s*\)', '', s)
    s = re.sub(r'\bcolor\.new\s*\(\s*[^,)]+,\s*100\s*\)', 'na', s)
    s = re.sub(r'\bchart\.(?:fg|bg)_color\b', 'color.white', s)

    # remove display=, editable=, force_overlay= params
    s = re.sub(r',\s*display\s*=\s*(?:display\.)?\w+', '', s)
    s = re.sub(r',\s*editable\s*=\s*(?:true|false)', '', s)
    s = re.sub(r',\s*force_overlay\s*=\s*(?:true|false)', '', s)

    # method-style array calls → array.func() form
    _METHS = ['push','pop','shift','unshift','sort','reverse','clear','copy',
              'size','avg','median','sum','max','min','stdev','variance',
              'first','last','get','set','includes','indexof','remove',
              'insert','slice','join','concat','fill']
    _ARGS = r'([^()]*(?:\([^)]*\)[^()]*)*)'
    for meth in _METHS:
        def _repl(m, _m=meth):
            obj, args = m.group(1), m.group(2).strip()
            return f'array.{_m}({obj}{", " + args if args else ""})'
        s = re.sub(r'\b([A-Za-z_]\w*)\.' + meth + r'\s*\(' + _ARGS + r'\)',
                   _repl, s)

    # fix first/last that got extra trailing comma
    s = re.sub(r'array\.first\s*\(([^,)]+),?\s*\)', r'array.get(\1, 0)', s)
    s = re.sub(r'array\.last\s*\(([^,)]+),?\s*\)',
               r'array.get(\1, array.size(\1)-1)', s)

    # remove fill() calls
    s = _pine_remove_fills(s)

    # comment out method bodies
    s = _pine_comment_method_bodies(s)

    # strip order.ascending/descending
    s = re.sub(r',\s*order\.(?:ascending|descending)\b', '', s)

    # remove doc-comment annotations
    s = re.sub(r'//\s*@(?:enum|field|type)\b[^\n]*\n', '', s)

    # v6: extend.* constants
    s = re.sub(r'\bextend\.(?:none|left|right|both)\b', 'extend.none', s)

    # v6: chart.point → na / float
    s = re.sub(r'\bchart\.point\.from_time\s*\([^)]*\)', 'na', s)
    s = re.sub(r'\bchart\.point\.from_index\s*\([^)]*\)', 'na', s)
    s = re.sub(r'\bchart\.point\.new\s*\([^)]*\)', 'na', s)
    s = re.sub(r'\bchart\.point\b', 'float', s)

    # v6: runtime.error() → na
    s = re.sub(r'\bruntime\.error\s*\([^)]*\)', 'na', s)

    # v4: input() with typed positional args
    s = re.sub(r'\binput\s*\(\s*([^,)]+),\s*([^,)]+),\s*input\.integer([^)]*)\)',
               r'input.int(\1, \2\3)', s)
    s = re.sub(r'\binput\s*\(\s*([^,)]+),\s*([^,)]+),\s*input\.float([^)]*)\)',
               r'input.float(\1, \2\3)', s)
    s = re.sub(r'\binput\s*\(\s*([^,)]+),\s*([^,)]+),\s*input\.bool([^)]*)\)',
               r'input.bool(\1, \2\3)', s)
    s = re.sub(r'\binput\s*\(\s*([^,)]+),\s*([^,)]+),\s*input\.string([^)]*)\)',
               r'input.string(\1, \2\3)', s)

    # v4: strip inline=, group=, tooltip=, active= params
    s = re.sub(r',\s*inline\s*=\s*"[^"]*"', '', s)
    s = re.sub(r',\s*group\s*=\s*"[^"]*"', '', s)
    s = re.sub(r',\s*tooltip\s*=\s*\w+', '', s)
    s = re.sub(r',\s*active\s*=\s*\w+', '', s)

    # v6: extend.* constants → extend.none
    s = re.sub(r'\bextend\.(?:none|left|right|both)\b', 'extend.none', s)

    return s

# ── CHART CACHE ───────────────────────────────────────────────────────────────
_chart_cache = {}  # key -> (data, expires_at)

_CACHE_TTL = {
    "1m": 5, "5m": 60, "15m": 120,
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
PINE_DIR          = "pine_scripts"
CRYPTO_TICKERS    = {"BTC","ETH","BNB","SOL","DOGE","ADA","XRP","AVAX","DOT","LINK"}
VENV_PACKAGES     = os.environ.get("VENV_PACKAGES", "")

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
    nocache   = request.args.get("nocache", "0")
    if nocache != "1":
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

@app.route("/api/pine/scripts")
def list_pine_scripts():
    os.makedirs(PINE_DIR, exist_ok=True)
    scripts = []
    for fname in sorted(os.listdir(PINE_DIR)):
        if not fname.endswith(".pine"):
            continue
        fid  = "file_" + fname[:-5]
        name = fname[:-5].replace("_", " ").replace("-", " ").upper()
        try:
            with open(os.path.join(PINE_DIR, fname), encoding="utf-8") as f:
                raw = f.read()
            scripts.append({"id": fid, "name": name, "script": _translate_pine(raw)})
        except Exception:
            pass
    return jsonify(scripts)

if __name__ == "__main__":
    os.makedirs("static", exist_ok=True)
    os.makedirs(PINE_DIR, exist_ok=True)
    print("=" * 55)
    print("  Trading Dashboard Server")
    print("  http://0.0.0.0:5000")
    print(f"  Access via: http://localhost:5000")
    print("=" * 55)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)