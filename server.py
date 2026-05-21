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

try:
    from statsmodels.tsa.holtwinters import ExponentialSmoothing as _ETS
    _ets_ok = True
except ImportError:
    _ets_ok = False
import json, math, os, re, subprocess, time, threading, tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests as _req
from datetime import datetime, timezone, timedelta


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
    "30m": 120, "1h": 300, "1d": 600, "1wk": 3600
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

DEFAULT_WATCHLIST = ["BTC","ANET","MSTR","ORCL","PLTR"]
STATE_FILE        = "state.json"
PINE_DIR          = "pine_scripts"
CRYPTO_TICKERS    = {"BTC","ETH","BNB","SOL","DOGE","ADA","XRP","AVAX","DOT","LINK"}
VENV_PACKAGES     = os.environ.get("VENV_PACKAGES", "")

_state_lock = threading.Lock()

def load_state():
    defaults = {
        "watchlist":       DEFAULT_WATCHLIST,
        "averages":        {},
        "active_ticker":   "BTC",
        "active_monitor":  1,
        "default_tf":      "30m",
        "chart_zoom":      150,
        "sidebar_width":   260,
        "update_interval": 1000,
        "monitors":        {"1": {"charts": [{"ticker": "BTC", "tf": "30m", "utilityMode": "rsi", "widgetMode": "candles", "widgetSettings": {}}]}}
    }
    with _state_lock:
        if not os.path.exists(STATE_FILE):
            return defaults
        try:
            with open(STATE_FILE) as f:
                raw = f.read()
            healed = False
            for _ in range(20):
                try:
                    saved = json.loads(raw)
                    break
                except json.JSONDecodeError:
                    trimmed = raw.rstrip()
                    if trimmed.endswith('}'):
                        raw = trimmed[:-1]
                        healed = True
                    else:
                        return defaults
            else:
                return defaults
            if healed:
                _write_state_atomic(raw)
            for k, v in defaults.items():
                if k not in saved:
                    saved[k] = v
            return saved
        except Exception:
            return defaults

def _write_state_atomic(content_or_dict):
    dir_ = os.path.dirname(os.path.abspath(STATE_FILE))
    with tempfile.NamedTemporaryFile("w", dir=dir_, delete=False, suffix=".tmp") as tf:
        if isinstance(content_or_dict, dict):
            json.dump(content_or_dict, tf, indent=2)
        else:
            tf.write(content_or_dict)
        tmp_path = tf.name
    os.replace(tmp_path, STATE_FILE)

def save_state(state):
    with _state_lock:
        _write_state_atomic(state)

def _ema_series(values, period):
    k = 2.0 / (period + 1)
    ema = [float(values[0])]
    for v in values[1:]:
        ema.append(float(v) * k + ema[-1] * (1 - k))
    return _np.array(ema)

def _compute_rsi(closes, period=14):
    d = _np.diff(closes.astype(float))
    g = _np.where(d > 0, d, 0.0)
    l = _np.where(d < 0, -d, 0.0)
    ag = _np.mean(g[-period:])
    al = _np.mean(l[-period:])
    return 100.0 if al == 0 else 100.0 - 100.0 / (1.0 + ag / al)

def _compute_macd(closes):
    e12  = _ema_series(closes, 12)
    e26  = _ema_series(closes, 26)
    line = e12 - e26
    sig  = _ema_series(line, 9)
    return float(line[-1]), float(sig[-1]), float(line[-2]), float(sig[-2])

def _heuristic_bias(closes, is_crypto, sentiment_data):
    signals    = {}
    bias_parts = {}  # name -> (bias_value, weight)

    # RSI
    rsi = _compute_rsi(closes)
    if   rsi < 30: rb, rl = 0.40,  "OVERSOLD ▲"
    elif rsi < 45: rb, rl = 0.20,  "SOFT ▲"
    elif rsi < 55: rb, rl = 0.00,  "NEUTRAL"
    elif rsi < 70: rb, rl = -0.20, "SOFT ▼"
    else:          rb, rl = -0.40, "OVERBOUGHT ▼"
    signals["RSI"]    = {"value": round(rsi, 1), "label": rl, "bias": rb}
    bias_parts["RSI"] = (rb, 0.25)

    # MACD (needs ≥ 35 candles)
    if len(closes) >= 35:
        m, s, mp, sp = _compute_macd(closes)
        cross_up = m > s and mp <= sp
        cross_dn = m < s and mp >= sp
        if   cross_up: mb, ml = 0.35,  "CROSS ▲▲"
        elif m > s:    mb, ml = 0.15,  "BULL ▲"
        elif cross_dn: mb, ml = -0.35, "CROSS ▼▼"
        else:          mb, ml = -0.15, "BEAR ▼"
        signals["MACD"]    = {"value": round(m, 4), "signal_val": round(s, 4), "label": ml, "bias": mb}
        bias_parts["MACD"] = (mb, 0.25)

    # MA20 vs MA50 cross
    if len(closes) >= 50:
        ma20 = float(_np.mean(closes[-20:]))
        ma50 = float(_np.mean(closes[-50:]))
        diff  = (ma20 - ma50) / ma50
        mab   = max(-0.25, min(0.25, diff * 8))
        if   diff >  0.02: mal = "GOLDEN ▲"
        elif diff >  0.00: mal = "ABOVE ▲"
        elif diff > -0.02: mal = "BELOW ▼"
        else:              mal = "DEATH ▼"
        signals["MA CROSS"]    = {"ma20": round(ma20, 2), "ma50": round(ma50, 2), "label": mal, "bias": round(mab, 3)}
        bias_parts["MA CROSS"] = (mab, 0.20)

    if sentiment_data:
        # Tech sentiment score
        tech_score = float(sentiment_data.get("tech", {}).get("score", 0) or 0)
        tb = max(-0.30, min(0.30, tech_score * 0.10))
        if   tech_score >  1.5: tl = "STRONG BULL ▲"
        elif tech_score >  0.5: tl = "BULL ▲"
        elif tech_score > -0.5: tl = "NEUTRAL"
        elif tech_score > -1.5: tl = "BEAR ▼"
        else:                   tl = "STRONG BEAR ▼"
        signals["TECH SENT"]    = {"value": round(tech_score, 2), "label": tl, "bias": round(tb, 3)}
        bias_parts["TECH SENT"] = (tb, 0.15)

        # News buy/sell ratio
        bc  = int(sentiment_data.get("news", {}).get("buy_count",  0) or 0)
        sc_ = int(sentiment_data.get("news", {}).get("sell_count", 0) or 0)
        tot = bc + sc_
        if tot > 0:
            ratio = (bc - sc_) / tot
            nb    = ratio * 0.20
            if   ratio >  0.4: nl = f"BULL ▲ {bc}B/{sc_}S"
            elif ratio >  0.1: nl = f"SOFT BULL ▲ {bc}B/{sc_}S"
            elif ratio > -0.1: nl = f"NEUTRAL {bc}B/{sc_}S"
            elif ratio > -0.4: nl = f"SOFT BEAR ▼ {bc}B/{sc_}S"
            else:              nl = f"BEAR ▼ {bc}B/{sc_}S"
        else:
            nb, nl = 0.0, "NO DATA"
        signals["NEWS"]    = {"label": nl, "bias": round(nb, 3)}
        bias_parts["NEWS"] = (nb, 0.10)

        # Fear & Greed (contrarian)
        fng_val = sentiment_data.get("fng", {}).get("value")
        if fng_val is not None:
            fv = int(fng_val)
            if   fv < 25: fb, fl = 0.15,  f"{fv} EXT FEAR ▲"
            elif fv < 40: fb, fl = 0.08,  f"{fv} FEAR ▲"
            elif fv < 60: fb, fl = 0.00,  f"{fv} NEUTRAL"
            elif fv < 75: fb, fl = -0.08, f"{fv} GREED ▼"
            else:         fb, fl = -0.15, f"{fv} EXT GREED ▼"
            signals["F&G"]    = {"value": fv, "label": fl, "bias": fb}
            bias_parts["F&G"] = (fb, 0.05)

    total_w   = sum(w for _, w in bias_parts.values())
    composite = sum(b * w for b, w in bias_parts.values()) / total_w if total_w else 0.0
    composite = max(-1.0, min(1.0, composite))

    if   composite >  0.30: bias_label = "BULLISH"
    elif composite >  0.10: bias_label = "SOFT BULL"
    elif composite > -0.10: bias_label = "NEUTRAL"
    elif composite > -0.30: bias_label = "SOFT BEAR"
    else:                   bias_label = "BEARISH"

    return round(composite, 3), bias_label, signals

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
            c = float(row["Close"])
            if math.isnan(c) or c <= 0:
                continue
            def _f(v):
                v = float(v)
                return round(c if math.isnan(v) else v, 4)
            candles.append({
                "t":    int(ts.timestamp() * 1000),
                "o":    _f(row["Open"]),
                "h":    _f(row["High"]),
                "l":    _f(row["Low"]),
                "c":    round(c, 4),
                "v":    int(row["Volume"]) if not math.isnan(float(row["Volume"])) else 0,
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
    return get_sentiment_ticker("BTC")

@app.route("/api/sentiment/<ticker>")
def get_sentiment_ticker(ticker):
    t = ticker.upper()
    if t in CRYPTO_TICKERS or t == "BTC":
        if _sentiment is None:
            return jsonify({"error": "Sentiment engine not available"}), 503
        return jsonify(_sentiment.get())
    cache_key = ("sentiment_stock", t)
    cached = _cache_get(cache_key)
    if cached:
        return jsonify(cached)
    try:
        result = _stock_sentiment(t)
        _cache_set(cache_key, result, 300)
        return jsonify(result)
    except Exception as ex:
        return jsonify({"error": str(ex)}), 500

def _stock_sentiment(ticker):
    now_str = datetime.now().strftime("%H:%M")
    # TECH: RSI + MACD across 1h and 1d
    TFS = [("1h", "60d", 0.4), ("1d", "6mo", 0.6)]
    score = 0.0; breakdown = {}
    for tf, period, weight in TFS:
        d = fetch_chart_data(ticker, period=period, interval=tf)
        if not d or len(d.get("candles", [])) < 30:
            continue
        closes = [c["c"] for c in d["candles"]]
        rsi_val = float(_compute_rsi(_np.array(closes)))
        rsi_s   = (rsi_val - 50.0) / 50.0
        e12 = _ema_series(closes, 12)
        e26 = _ema_series(closes, 26)
        macd_line = e12 - e26
        macd_s = 1.0 if float(macd_line[-1]) > float(macd_line[-2]) else -1.0
        tf_score = rsi_s * 0.5 + macd_s * 0.5
        breakdown[tf] = round(float(tf_score), 2)
        score += float(tf_score) * weight
    label = "BULLISH" if score > 0.1 else "BEARISH" if score < -0.1 else "NEUTRAL"
    color = "green"  if score > 0.1 else "red"    if score < -0.1 else "amber"
    # NEWS: yfinance headlines with keyword scoring
    bull_kw = {"beat","beats","strong","growth","rally","upgrade","buy","record","surge",
               "gain","rises","profit","positive","high","top","outperform","raise","raised"}
    bear_kw = {"miss","misses","weak","decline","downgrade","sell","fall","loss","cut",
               "warn","warns","drop","drops","concern","below","short","lower","lowered"}
    buy_c = sell_c = noise_c = 0
    headlines = []
    try:
        news = yf.Ticker(ticker).news or []
        for item in news[:10]:
            title = item.get("title", "")
            words = set(title.lower().split())
            b = bool(words & bull_kw)
            s = bool(words & bear_kw)
            if b and not s:   signal = "buy";     buy_c  += 1
            elif s and not b: signal = "sell";    sell_c += 1
            else:             signal = "neutral"; noise_c += 1
            headlines.append({"title": title, "signal": signal})
    except Exception:
        pass
    total  = buy_c + sell_c + noise_c
    n_lbl  = "BULLISH" if buy_c > sell_c else "BEARISH" if sell_c > buy_c else ("NEUTRAL" if total else "N/A")
    n_col  = "green"   if buy_c > sell_c else "red"     if sell_c > buy_c else ("amber" if total else "text3")
    return {
        "tech": {"label": label, "score": round(score, 2), "breakdown": breakdown,
                 "color": color, "last_update": now_str},
        "fng":  {"label": "N/A", "value": None, "classification": "Crypto-only index",
                 "color": "text3", "last_update": None},
        "news": {"label": n_lbl, "buy_count": buy_c, "sell_count": sell_c,
                 "neutral_count": 0, "noise_count": noise_c, "total_count": total,
                 "color": n_col, "last_update": now_str if total else None, "headlines": headlines}
    }

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

    # Heuristic bias — same signals as Prophet
    bias_score, bias_label, signals = 0.0, "NEUTRAL", {}
    try:
        df_d = yf.Ticker(resolve_ticker(t)).history(period="1mo", interval="1d")
        if not df_d.empty:
            daily_c  = df_d["Close"].values.astype(float)
            sent_data = None
            if _sentiment is not None:
                try: sent_data = _sentiment.get()
                except Exception: pass
            bias_score, bias_label, signals = _heuristic_bias(daily_c, t in CRYPTO_TICKERS, sent_data)
    except Exception:
        pass
    # Fixed total tilt: ~5% * bias_score over the full forecast window (TF-independent)
    bps = bias_score * 0.05 / max(n, 1)
    atr_pad = atr * 0.3
    half_ci_base = [(f["ci_hi"] - f["ci_lo"]) / 2 for f in forecast]
    forecast_biased = []
    for i, f in enumerate(forecast):
        mult   = (1 + bps) ** (i + 1)
        fc_c_b = round(f["c"] * mult, 4)
        hci    = half_ci_base[i]
        forecast_biased.append({
            "t": f["t"], "o": f["o"],
            "h": round(max(f["o"], fc_c_b) + atr_pad, 4),
            "l": round(min(f["o"], fc_c_b) - atr_pad, 4),
            "c": fc_c_b,
            "ci_lo": round(fc_c_b - hci, 4),
            "ci_hi": round(fc_c_b + hci, 4),
        })
    result = {
        "ticker": t, "interval": interval,
        "model": "ARIMA(2,1,2)" if _arima_ok else "linear",
        "forecast": forecast, "forecast_biased": forecast_biased,
        "bias_score": bias_score, "bias_label": bias_label, "signals": signals,
    }
    _cache_set(cache_key, result, 60)
    return jsonify(result)

_TF_PARAMS = {
    "1W": ("5d", "30m"),   # ~80 half-hour candles; base for 1H/1D slicing too
}
_TF_DATE_PARAMS = {
    # TFs where explicit start date is more reliable than yfinance period strings
    "1M": (30,  "1d"),
    "3M": (90,  "1d"),
}

def _fetch_spark(ticker, tf):
    """Fetch sparkline data for a given TF, using date-range for 1M/3M."""
    if tf in _TF_DATE_PARAMS:
        days, interval = _TF_DATE_PARAMS[tf]
        start = (datetime.now() - timedelta(days=days)).strftime("%Y-%m-%d")
        cache_key = (ticker.upper(), f"start:{start}", interval)
        cached = _cache_get(cache_key)
        if cached is not None:
            return cached
        try:
            df = yf.Ticker(resolve_ticker(ticker)).history(start=start, interval=interval)
            if df.empty:
                return None
            candles = []
            for ts, row in df.iterrows():
                c = float(row["Close"])
                if math.isnan(c) or c <= 0:
                    continue
                candles.append({"t": int(ts.timestamp()*1000), "c": round(c, 4),
                                 "v": int(row["Volume"]) if not math.isnan(float(row["Volume"])) else 0})
            if len(candles) < 2:
                return None
            result = {"candles": candles, "last": candles[-1]["c"],
                      "change_pct": round((candles[-1]["c"] - candles[0]["c"]) / candles[0]["c"] * 100, 2)}
            _cache_set(cache_key, result, _CACHE_TTL.get(interval, 600))
            return result
        except Exception:
            return None
    period, interval = _TF_PARAMS.get(tf, ("5d", "30m"))
    return fetch_chart_data(ticker, period=period, interval=interval)

@app.route("/api/mini/batch")
def mini_batch():
    raw     = request.args.get("t", "")
    tf      = request.args.get("tf", "1W").upper()
    tickers = [t.strip().upper() for t in raw.split(",") if t.strip()][:60]
    results = {}
    def _fetch(t):
        spark = _fetch_spark(t, tf)
        if spark and not spark.get("error") and len(spark.get("candles", [])) >= 2:
            candles = spark["candles"]
            first_c = candles[0]["c"]
            last_c  = candles[-1]["c"]
            chg     = round((last_c - first_c) / first_c * 100, 2) if first_c else 0
            if math.isnan(chg) or math.isnan(last_c): chg, last_c = 0.0, 0.0
            return t, {"last": last_c, "change_pct": chg, "candles": candles}
        # fallback: daily data
        d = fetch_chart_data(t, period="5d", interval="1d")
        if d and not d.get("error") and len(d.get("candles", [])) >= 2:
            candles = d["candles"]
            prev    = candles[-2]["c"]
            last_c  = candles[-1]["c"]
            chg     = round((last_c - prev) / prev * 100, 2) if prev else 0
            return t, {"last": last_c, "change_pct": chg, "candles": candles}
        return t, None
    with ThreadPoolExecutor(max_workers=10) as ex:
        futs = {ex.submit(_fetch, t): t for t in tickers}
        for f in as_completed(futs):
            try:
                t, d = f.result()
                if d: results[t] = d
            except Exception: pass
    return jsonify(results)

@app.route("/api/mini/<ticker>")
def mini_chart(ticker):
    sym = resolve_ticker(ticker.upper())
    # Daily candles → accurate prev-close for % change
    daily = fetch_chart_data(ticker.upper(), period="5d", interval="1d")
    if not daily or not daily.get("candles"):
        return jsonify({"error": "No data"}), 404
    dc = daily["candles"]
    last       = dc[-1]["c"]
    prev_close = dc[-2]["c"] if len(dc) >= 2 else dc[0]["c"]
    change_pct = round((last - prev_close) / prev_close * 100, 2) if prev_close else 0
    # Hourly candles → nice sparkline shape (more data points)
    hourly = fetch_chart_data(ticker.upper(), period="5d", interval="1h")
    candles = hourly["candles"] if hourly and hourly.get("candles") else dc
    return jsonify({"ticker": ticker.upper(), "last": last,
                    "change_pct": change_pct, "interval": "1h", "candles": candles})

@app.route("/api/price/<ticker>")
def live_price(ticker):
    sym = resolve_ticker(ticker.upper())
    cache_key = f"price:{sym}"
    cached = _cache_get(cache_key)
    if cached: return jsonify(cached)
    try:
        fi = yf.Ticker(sym).fast_info
        last = float(fi.last_price or 0)
        prev = float(fi.previous_close or 0)
        chg  = round((last - prev) / prev * 100, 2) if prev else 0
        result = {"last": last, "change_pct": chg}
        _cache_set(cache_key, result, 1)
        return jsonify(result)
    except Exception as ex:
        return jsonify({"error": str(ex)}), 500

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

_BINANCE_FUTURES = "https://fapi.binance.com/fapi/v1"

_MAX_LEVERAGE = {
    "BTCUSDT": 125, "ETHUSDT": 100, "BNBUSDT": 75,  "SOLUSDT": 75,
    "XRPUSDT": 75,  "DOGEUSDT": 75, "ADAUSDT": 75,  "AVAXUSDT": 75,
    "DOTUSDT": 75,  "LINKUSDT": 75, "LTCUSDT": 75,  "MATICUSDT": 75,
    "NEARUSDT": 75, "ATOMUSDT": 75, "UNIUSDT": 75,  "AAVEUSDT": 75,
}

def _get_max_leverage(sym):
    return _MAX_LEVERAGE.get(sym)

@app.route("/api/funding/<ticker>")
def get_funding(ticker):
    sym = ticker.upper() + "USDT"
    cache_key = ("funding", sym)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        r1 = _req.get(f"{_BINANCE_FUTURES}/premiumIndex?symbol={sym}",   timeout=5)
        r2 = _req.get(f"{_BINANCE_FUTURES}/openInterest?symbol={sym}",   timeout=5)
        r3 = _req.get(f"{_BINANCE_FUTURES}/fundingRate?symbol={sym}&limit=10", timeout=5)
        if not r1.ok or not r2.ok:
            detail = r1.text[:200] if not r1.ok else r2.text[:200]
            return jsonify({"error": f"No futures data for {sym}", "detail": detail}), 404
        p_data  = r1.json()
        oi_data = r2.json()
        hist    = r3.json() if r3.ok and isinstance(r3.json(), list) else []
        mark   = float(p_data.get("markPrice",       0) or 0)
        rate   = float(p_data.get("lastFundingRate", 0) or 0)
        nft    = int(p_data.get("nextFundingTime",   0) or 0)
        oi_v   = float(oi_data.get("openInterest",   0) or 0)
        result = {
            "symbol":            sym,
            "mark_price":        mark,
            "last_funding_rate": rate * 100,
            "next_funding_ts":   nft,
            "oi":                oi_v,
            "oi_usd":            oi_v * mark,
            "max_leverage":      _get_max_leverage(sym),
            "history": [
                {"t": int(h["fundingTime"]), "rate": float(h["fundingRate"]) * 100}
                for h in hist if "fundingRate" in h and "fundingTime" in h
            ],
        }
        _cache_set(cache_key, result, 30)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/<path:path>")
def static_files(path):
    return no_cache(send_from_directory("static", path))

_PROPHET_CFG = {
    "1d":  {"period": "2y",  "seasonal": 7,  "n_fc": 14, "max_fit": 500},
    "1h":  {"period": "3mo", "seasonal": 24, "n_fc": 24, "max_fit": 500},
    "30m": {"period": "1mo", "seasonal": 48, "n_fc": 24, "max_fit": 500},
    "15m": {"period": "10d", "seasonal": 26, "n_fc": 16, "max_fit": 400},
    "5m":  {"period": "5d",  "seasonal": 12, "n_fc": 12, "max_fit": 300},
    "1m":  {"period": "5d",  "seasonal": None, "n_fc": 30, "max_fit": 200},
}

@app.route("/api/prophet/<ticker>")
def get_prophet(ticker):
    import warnings
    t        = ticker.upper()
    interval = request.args.get("interval", "1d")
    cfg      = _PROPHET_CFG.get(interval, _PROPHET_CFG["1d"])
    cache_key = ("prophet", t, interval)
    if not request.args.get("nocache"):
        cached = _cache_get(cache_key)
        if cached is not None:
            return jsonify(cached)
    if not _ets_ok:
        return jsonify({"error": "statsmodels not installed"}), 503
    try:
        is_crypto = t in CRYPTO_TICKERS
        sym       = resolve_ticker(t)
        n_fc      = cfg["n_fc"]

        # Fetch candles for ETS fitting (interval-matched)
        df_fit = yf.Ticker(sym).history(period=cfg["period"], interval=interval)
        min_pts = (cfg["seasonal"] * 2) if cfg.get("seasonal") else 20
        if df_fit.empty or len(df_fit) < min_pts:
            return jsonify({"error": "Not enough data for this timeframe"}), 404
        fit_closes = df_fit["Close"].values.astype(float)[-cfg["max_fit"]:]
        last_close = float(fit_closes[-1])

        # Always use daily candles for bias signals (more stable)
        df_daily = yf.Ticker(sym).history(period="1mo", interval="1d")
        daily_closes = df_daily["Close"].values.astype(float) if not df_daily.empty else fit_closes

        with warnings.catch_warnings():
            warnings.filterwarnings("ignore")
            if cfg.get("seasonal"):
                model = _ETS(fit_closes, trend="add", seasonal="add",
                             seasonal_periods=cfg["seasonal"], damped_trend=True,
                             initialization_method="estimated")
            else:
                # No damping: undamped trend extrapolates the recent slope visibly
                # (damped_trend=True causes the trend to decay to zero on short TFs)
                model = _ETS(fit_closes, trend="add", seasonal=None,
                             damped_trend=False, initialization_method="estimated")
            fit       = model.fit(optimized=True, remove_bias=True)
            fc_mean   = _np.asarray(fit.forecast(n_fc))
            resid_std = float(_np.std(fit.resid, ddof=1))
            # Floor: ETS over-fits intraday data → residuals near-zero → invisible CI.
            # Use observed 1-step price volatility as the minimum, so CI scales
            # naturally to each TF without hardcoding a % of price.
            if len(fit_closes) >= 11:
                step_vol = float(_np.std(_np.diff(fit_closes[-60:]), ddof=1))
                resid_std = max(resid_std, step_vol)

        sentiment_data = None
        if _sentiment is not None:
            try: sentiment_data = _sentiment.get()
            except Exception: pass

        bias_score, bias_label, signals = _heuristic_bias(daily_closes, is_crypto, sentiment_data)

        # Fixed total tilt: ~5% * bias_score over the full forecast window (TF-independent)
        bias_per_step = bias_score * 0.05 / max(n_fc, 1)

        z = 1.645
        forecast, forecast_biased = [], []
        for i in range(n_fc):
            yhat   = float(fc_mean[i])
            spread = resid_std * (1 + i * 0.05)
            forecast.append({
                "i": i, "yhat": round(yhat, 4),
                "yhat_lower": round(yhat - z * spread, 4),
                "yhat_upper": round(yhat + z * spread, 4),
            })
            mult   = (1 + bias_per_step) ** (i + 1)
            yhat_b = yhat * mult; spread_b = spread * abs(mult)
            forecast_biased.append({
                "i": i, "yhat": round(yhat_b, 4),
                "yhat_lower": round(yhat_b - z * spread_b, 4),
                "yhat_upper": round(yhat_b + z * spread_b, 4),
            })

        result = {
            "ticker": t, "interval": interval, "last_close": last_close,
            "model": "ETS + Heuristic", "n_fc": n_fc,
            "bias_score": bias_score, "bias_label": bias_label,
            "signals": signals,
            "forecast": forecast,
            "forecast_biased": forecast_biased,
        }
        _cache_set(cache_key, result, 3600)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

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