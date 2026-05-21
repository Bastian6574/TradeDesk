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
try:
    from dotenv import load_dotenv as _load_dotenv
    _load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except ImportError:
    pass  # dotenv not installed — set ANTHROPIC_API_KEY in shell env instead
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")
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
    "30m": 120, "1h": 300, "1d": 1800, "1wk": 7200
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
        df = yf.Ticker(resolve_ticker(ticker)).history(period=period, interval=interval, auto_adjust=False, actions=False)
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

@app.route("/api/social/<ticker>")
def get_social_sentiment(ticker):
    t = ticker.upper()
    cache_key = ("social", t)
    cached = _cache_get(cache_key)
    if cached:
        return jsonify(cached)
    try:
        result = _sentiment.analyze_social(t, ANTHROPIC_API_KEY) if _sentiment else \
                 {"score":50,"label":"NEUTRAL","color":"amber","summary":"Sentiment engine unavailable.",
                  "themes":[],"bull_signals":[],"bear_signals":[],"bull_count":0,"bear_count":0,"post_count":0}
        _cache_set(cache_key, result, 600)  # 10-min cache
        return jsonify(result)
    except Exception as ex:
        return jsonify({"error": str(ex)}), 500

def _claude_daily_forecast(ticker, inputs, signals, bias_score, bias_label):
    parts = [f"Ticker: {ticker}"]
    if "price" in inputs:
        p = inputs["price"]
        parts.append(f"Price: {p.get('last')} | 5d: {p.get('pct_5d')}% | 1m: {p.get('pct_1m')}%")
    if "tech" in inputs:
        t_ = inputs["tech"]
        parts.append(f"Technical: {t_.get('label')} score={t_.get('score')}")
        if t_.get("breakdown"):
            bd = " ".join(f"{k}:{v:+.2f}" for k, v in t_["breakdown"].items())
            parts.append(f"  TF breakdown: {bd}")
    if "fng" in inputs:
        f_ = inputs["fng"]
        if f_.get("value") is not None:
            parts.append(f"Fear & Greed: {f_.get('value')}/100 ({f_.get('classification','')})")
    if "news" in inputs:
        n_ = inputs["news"]
        parts.append(f"News: {n_.get('label')} ▲{n_.get('buy_count',0)}/▼{n_.get('sell_count',0)}")
    if "social" in inputs:
        s_ = inputs["social"]
        parts.append(f"Social: {s_.get('label')} score={s_.get('score')}/100 ▲{s_.get('bull_count',0)}/▼{s_.get('bear_count',0)}")
        if s_.get("summary"):
            parts.append(f"  Social summary: {s_['summary'][:150]}")
    if "funding" in inputs:
        f_ = inputs["funding"]
        parts.append(f"Funding rate: {f_.get('rate',0):.4f}% per 8h | OI: ${(f_.get('oi',0) or 0)/1e9:.1f}B")
    sig_lines = [f"  {name}: {sig.get('label','')} (bias {sig.get('bias',0):+.2f})"
                 for name, sig in list(signals.items())[:6]]
    if sig_lines:
        parts.append("Signals:\n" + "\n".join(sig_lines))
    parts.append(f"Heuristic composite: {bias_score:+.3f} → {bias_label}")
    data_summary = "\n".join(parts)
    prompt = (
        f"You are a senior quantitative analyst. Based on the following market data, "
        f"provide a concise daily forecast for {ticker}.\n\n{data_summary}\n\n"
        "Respond with a JSON object (no markdown, just the JSON):\n"
        '{"label":"BULLISH" or "BEARISH" or "NEUTRAL","confidence":integer 40-95,'
        '"summary":"2-3 sentence summary","bull_factors":["factor1","factor2","factor3"],'
        '"bear_factors":["factor1","factor2","factor3"],'
        '"key_risk":"single biggest risk today","price_bias":"brief directional bias"}\n'
        "Be concise, data-driven, and specific to the numbers provided."
    )
    try:
        r = _req.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 450,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=15,
        )
        if not r.ok:
            return None
        text = r.json().get("content", [{}])[0].get("text", "")
        start = text.find("{"); end = text.rfind("}") + 1
        if start >= 0 and end > start:
            parsed = json.loads(text[start:end])
            return {
                "label":        parsed.get("label", bias_label),
                "confidence":   int(parsed.get("confidence", 65)),
                "summary":      parsed.get("summary"),
                "bull_factors": parsed.get("bull_factors", []),
                "bear_factors": parsed.get("bear_factors", []),
                "key_risk":     parsed.get("key_risk"),
                "price_bias":   parsed.get("price_bias"),
            }
    except Exception:
        pass
    return None


@app.route("/api/daily_forecast/<ticker>")
def get_daily_forecast(ticker):
    t = ticker.upper()
    cache_key = ("daily_forecast", t)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        inputs = {}
        # Price action
        daily_data = fetch_chart_data(t, "1mo", "1d")
        closes = []
        if daily_data and not daily_data.get("error") and daily_data.get("candles"):
            candles = daily_data["candles"]
            closes  = [c["c"] for c in candles]
            if len(closes) >= 5:
                inputs["price"] = {
                    "last":   closes[-1],
                    "pct_5d": round((closes[-1] - closes[-5]) / closes[-5] * 100, 2),
                    "pct_1m": round((closes[-1] - closes[0])  / closes[0]  * 100, 2),
                }
        # Sentiment
        sentiment = None
        if _sentiment:
            try:
                sentiment = _sentiment.get() if t in CRYPTO_TICKERS else \
                            _cache_get(("sentiment_stock", t)) or _stock_sentiment(t)
                inputs["tech"] = sentiment.get("tech", {})
                inputs["fng"]  = sentiment.get("fng",  {})
                inputs["news"] = sentiment.get("news", {})
            except Exception:
                pass
        # Social (from cache if available)
        social_cached = _cache_get(("social", t))
        if social_cached:
            inputs["social"] = {
                "label":      social_cached.get("label"),
                "score":      social_cached.get("score"),
                "bull_count": social_cached.get("bull_count"),
                "bear_count": social_cached.get("bear_count"),
                "summary":    social_cached.get("summary"),
                "themes":     (social_cached.get("themes") or [])[:3],
            }
        # Funding (crypto only, from cache)
        if t in CRYPTO_TICKERS:
            fund_cached = _cache_get(("funding", t + "USDT"))
            if fund_cached:
                inputs["funding"] = {
                    "rate": fund_cached.get("last_funding_rate"),
                    "oi":   fund_cached.get("oi_usd"),
                }
        # Heuristic bias
        bias_score, bias_label, signals = 0.0, "NEUTRAL", {}
        if closes:
            try:
                bias_score, bias_label, signals = _heuristic_bias(
                    _np.array(closes), t in CRYPTO_TICKERS, sentiment
                )
            except Exception:
                pass
        confidence = min(95, max(40, round(abs(bias_score) * 100 + 50)))
        color = "green" if bias_score > 0.1 else "red" if bias_score < -0.1 else "amber"
        result = {
            "label":        bias_label,
            "confidence":   confidence,
            "color":        color,
            "bias_score":   round(bias_score, 3),
            "signals":      signals,
            "summary":      None,
            "bull_factors": [],
            "bear_factors": [],
            "key_risk":     None,
            "price_bias":   None,
            "inputs":       inputs,
            "last_update":  datetime.now().strftime("%H:%M"),
            "model":        "heuristic",
        }
        if ANTHROPIC_API_KEY:
            try:
                ai = _claude_daily_forecast(t, inputs, signals, bias_score, bias_label)
                if ai:
                    result.update(ai)
                    result["model"] = "claude-haiku"
            except Exception:
                pass
        _cache_set(cache_key, result, 1800)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


SWING_CACHE_FILE = "swing_watchlist.json"
SWING_FILE_TTL   = 86400   # 24h
SWING_MEM_TTL    = 1800    # 30min

# Mirrors FAVORITES in research.js — these are always included in swing scans
SWING_UNIVERSE = [
    "AMD","META","PPFB","MSFT","NET","GOOG","IBM","ETOR","SPY","BRK-B",
    "AAPL","PLTR","CRM","GME","SIE.DE","RIOT","HUT","KO","ANET","QQQ","VOOV",
    "IDEV","CSCO","ORCL","DIS","MARA","NVDA","TSLA","AMZN","RHM.DE",
]


def _compute_swing_technicals(ticker, interval, period):
    d = fetch_chart_data(ticker, period, interval)
    if not d or len(d.get("candles", [])) < 30:
        return None
    candles = d["candles"]
    closes  = [c["c"] for c in candles]
    highs   = [c["h"] for c in candles]
    vols    = [c.get("v", 0) or 0 for c in candles]
    price   = closes[-1]

    rsi = float(_compute_rsi(_np.array(closes)))

    e12       = _ema_series(closes, 12)
    e26       = _ema_series(closes, 26)
    macd_line = e12 - e26
    sig_line  = _ema_series(list(macd_line), 9)
    hist      = macd_line - sig_line
    macd_hist    = float(hist[-1])
    macd_hist_p1 = float(hist[-2]) if len(hist) >= 2 else macd_hist
    macd_hist_p2 = float(hist[-3]) if len(hist) >= 3 else macd_hist_p1
    macd_cross   = bool(macd_hist_p1 < 0 and macd_hist >= 0)

    ema50_arr  = _ema_series(closes, 50)
    ema50      = float(ema50_arr[-1])
    dist_ema50_pct = (price - ema50) / ema50 * 100

    ema200     = None
    dist_ema200_pct = None
    if len(closes) >= 200:
        ema200_arr  = _ema_series(closes, 200)
        ema200      = float(ema200_arr[-1])
        dist_ema200_pct = (price - ema200) / ema200 * 100

    period_len = min(52, len(closes))
    low_52w    = min(closes[-period_len:])
    dist_52w_low_pct = (price - low_52w) / low_52w * 100 if low_52w > 0 else 0.0

    high_20    = max(highs[-20:]) if len(highs) >= 20 else max(highs)
    drawdown_20_pct = (price - high_20) / high_20 * 100 if high_20 > 0 else 0.0

    vol_exhaustion = False
    vol_ratio      = 1.0
    if len(vols) >= 20:
        mean20     = sum(vols[-20:]) / 20
        recent3    = sum(vols[-3:]) / 3 if sum(vols[-3:]) > 0 else 0
        peak10     = max(vols[-10:])
        if mean20 > 0:
            vol_ratio = recent3 / mean20
            vol_exhaustion = bool(peak10 > mean20 * 2.5 and vol_ratio < 0.6)

    return {
        "rsi":              rsi,
        "macd_hist":        macd_hist,
        "macd_hist_p1":     macd_hist_p1,
        "macd_hist_p2":     macd_hist_p2,
        "macd_cross":       macd_cross,
        "ema50":            ema50,
        "ema200":           ema200,
        "dist_ema50_pct":   dist_ema50_pct,
        "dist_ema200_pct":  dist_ema200_pct,
        "dist_52w_low_pct": dist_52w_low_pct,
        "drawdown_20_pct":  drawdown_20_pct,
        "vol_exhaustion":   vol_exhaustion,
        "vol_ratio":        vol_ratio,
        "price":            price,
    }


def _score_swing_entry(tech):
    score   = 0
    signals = []

    rsi = tech["rsi"]
    if rsi <= 25:
        score += 30; signals.append(f"RSI {rsi:.0f} DEEPLY OVERSOLD")
    elif rsi <= 30:
        score += 25; signals.append(f"RSI {rsi:.0f} OVERSOLD")
    elif rsi <= 35:
        score += 15; signals.append(f"RSI {rsi:.0f} approaching oversold")
    elif rsi <= 40:
        score += 7;  signals.append(f"RSI {rsi:.0f}")

    h0, h1, h2 = tech["macd_hist"], tech["macd_hist_p1"], tech["macd_hist_p2"]
    if tech["macd_cross"]:
        score += 28; signals.append("MACD CROSS UP")
    elif h0 < 0 and h0 > h1 > h2:
        score += 18; signals.append("MACD hist 2-bar reversal")
    elif h0 < 0 and h0 > h1:
        score += 10; signals.append("MACD hist turning up")

    d200 = tech["dist_ema200_pct"]
    if d200 is not None:
        if -3 <= d200 <= 1:
            score += 15; signals.append("Near EMA200")
        elif -10 <= d200 < -3:
            score += 8;  signals.append(f"Below EMA200 {d200:.1f}%")

    d50 = tech["dist_ema50_pct"]
    if -2 <= d50 <= 1:
        score += 8; signals.append("Near EMA50")

    if tech["vol_exhaustion"]:
        score += 10; signals.append(f"Volume exhaustion ({tech['vol_ratio']:.2f}x)")

    dd = tech["drawdown_20_pct"]
    if dd < -15:
        score += 12; signals.append(f"Deep pullback {dd:.1f}%")
    elif dd < -8:
        score += 7;  signals.append(f"Pullback {dd:.1f}%")

    d52 = tech["dist_52w_low_pct"]
    if d52 < 5:
        score += 10; signals.append(f"Near 52w low (+{d52:.1f}%)")
    elif d52 < 15:
        score += 4;  signals.append(f"52w low +{d52:.1f}%")

    return (min(score, 100), signals)


def _claude_swing_analysis(ticker, tf, tech, signals):
    if not ANTHROPIC_API_KEY:
        return None
    try:
        news_items = []
        try:
            raw_news = yf.Ticker(ticker).news or []
            for item in raw_news[:5]:
                title = item.get("title", "")
                if title:
                    news_items.append(title)
        except Exception:
            pass

        news_str = "\n".join(f"- {h}" for h in news_items) if news_items else "No recent headlines."
        sig_str  = ", ".join(signals[:6])
        prompt = (
            f"Ticker: {ticker} | Timeframe: {tf} | Price: {tech['price']:.2f}\n"
            f"Technical signals: {sig_str}\n"
            f"RSI: {tech['rsi']:.1f} | MACD hist: {tech['macd_hist']:.4f} | "
            f"Drawdown 20-bar: {tech['drawdown_20_pct']:.1f}% | "
            f"Dist EMA50: {tech['dist_ema50_pct']:.1f}%\n"
            f"Recent headlines:\n{news_str}\n\n"
            "You are a swing trading analyst. Assess this potential swing entry setup.\n"
            "Respond with a JSON object only (no markdown):\n"
            '{"conviction":"LOW|MEDIUM|HIGH","setup_quality":"1-sentence",'
            '"entry_window":"e.g. 2-3 days","confirm_level":"price or condition",'
            '"invalidate":"what breaks the setup","news_risk":"LOW|MEDIUM|HIGH"}'
        )
        r = _req.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 300,
                "messages": [{"role": "user", "content": prompt}],
            },
            timeout=15,
        )
        if not r.ok:
            return None
        text = r.json().get("content", [{}])[0].get("text", "")
        start = text.find("{"); end = text.rfind("}") + 1
        if start >= 0 and end > start:
            return json.loads(text[start:end])
    except Exception:
        pass
    return None


def _run_swing_scan():
    state    = load_state()
    user_wl  = [t for t in (state.get("watchlist") or []) if t not in CRYPTO_TICKERS]
    # Merge research favorites + user watchlist, deduplicated, crypto filtered
    seen = set()
    watchlist = []
    for t in [*[x for x in SWING_UNIVERSE if x not in CRYPTO_TICKERS], *user_wl]:
        if t not in seen:
            seen.add(t); watchlist.append(t)
    if not watchlist:
        return {"entries": {}, "watchlist": [], "ts": time.time()}

    TF_CFGS = [
        {"tf": "1h",  "period": "3mo", "tier": "risky",  "section": "st", "min_score": 58, "label": "1H"},
        {"tf": "1d",  "period": "2y",  "tier": "great",  "section": "lt", "min_score": 48, "label": "1D"},
        {"tf": "1wk", "period": "5y",  "tier": "superb", "section": "lt", "min_score": 42, "label": "1W"},
    ]

    tasks = [(ticker, cfg) for ticker in watchlist for cfg in TF_CFGS]
    entries = {}

    def _scan_one(ticker, cfg):
        try:
            tech = _compute_swing_technicals(ticker, cfg["tf"], cfg["period"])
            if tech is None:
                return None
            score, signals = _score_swing_entry(tech)
            if score < cfg["min_score"]:
                return None
            ai = None
            if score >= 58:
                try:
                    ai = _claude_swing_analysis(ticker, cfg["tf"], tech, signals)
                except Exception:
                    pass
            return (ticker, cfg["tf"], {
                "score":   score,
                "signals": signals,
                "tech":    tech,
                "tier":    cfg["tier"],
                "section": cfg["section"],
                "tf":      cfg["tf"],
                "label":   cfg["label"],
                "ai":      ai,
            })
        except Exception:
            return None

    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_scan_one, ticker, cfg): (ticker, cfg) for ticker, cfg in tasks}
        for fut in as_completed(futures):
            result = fut.result()
            if result is None:
                continue
            ticker, tf, entry = result
            if ticker not in entries:
                entries[ticker] = {}
            entries[ticker][tf] = entry

    return {
        "entries":   entries,
        "watchlist": watchlist,
        "ts":        time.time(),
        "scan_date": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }


@app.route("/api/swing_scan")
def get_swing_scan():
    force = request.args.get("force", "0") == "1"
    if not force:
        cached = _cache_get(("swing_scan",))
        if cached is not None:
            return jsonify(cached)
        try:
            with open(SWING_CACHE_FILE, "r") as f:
                file_data = json.load(f)
            if time.time() - file_data.get("ts", 0) < SWING_FILE_TTL:
                _cache_set(("swing_scan",), file_data, SWING_MEM_TTL)
                return jsonify(file_data)
        except Exception:
            pass
    try:
        result = _run_swing_scan()
        try:
            with open(SWING_CACHE_FILE, "w") as f:
                json.dump(result, f)
        except Exception:
            pass
        _cache_set(("swing_scan",), result, SWING_MEM_TTL)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── COMPREHENSIVE ANALYSIS ────────────────────────────────────────────────────
def _gather_tf_technicals(ticker, interval, period):
    try:
        d = fetch_chart_data(ticker, period, interval)
        if not d or d.get("error") or len(d.get("candles", [])) < 20:
            return None
        candles = d["candles"]
        closes = _np.array([c["c"] for c in candles], dtype=float)
        highs  = _np.array([c["h"] for c in candles], dtype=float)
        lows   = _np.array([c["l"] for c in candles], dtype=float)
        vols   = _np.array([c.get("v", 0) or 0 for c in candles], dtype=float)
        n = len(closes); price = float(closes[-1])

        rsi      = float(_compute_rsi(closes))
        e12      = _ema_series(closes, 12); e26 = _ema_series(closes, 26)
        macd_l   = e12 - e26; sig = _ema_series(list(macd_l), 9); hist = macd_l - sig
        macd_h   = float(hist[-1]); macd_h_p = float(hist[-2]) if n >= 2 else macd_h
        cross_up = bool(macd_h_p < 0 and macd_h >= 0)

        ema20  = float(_ema_series(closes, 20)[-1])  if n >= 20  else None
        ema50  = float(_ema_series(closes, 50)[-1])  if n >= 50  else None
        ema200 = float(_ema_series(closes, 200)[-1]) if n >= 200 else None

        last20 = closes[-min(20, n):]
        bb_mid = float(last20.mean()); bb_std = float(last20.std())
        bb_u   = bb_mid + 2*bb_std;   bb_l   = bb_mid - 2*bb_std
        bb_pct = (price - bb_l) / (bb_u - bb_l) if bb_u > bb_l else 0.5

        avg_vol   = float(vols[-20:].mean()) if n >= 20 else 1.0
        vol_ratio = float(vols[-1]) / avg_vol if avg_vol > 0 else 1.0

        support = float(lows[-min(20, n):].min()); resist = float(highs[-min(20, n):].max())
        e20_arr = _ema_series(closes, 20)
        slope   = (float(e20_arr[-1]) - float(e20_arr[-min(6, n)])) / float(e20_arr[-1]) * 100
        trend   = "UP" if slope > 0.3 else "DOWN" if slope < -0.3 else "FLAT"

        return {
            "price": round(price, 4), "rsi": round(rsi, 1),
            "macd_hist": round(macd_h, 6), "macd_cross_up": cross_up,
            "ema20": round(ema20, 4) if ema20 else None,
            "ema50": round(ema50, 4) if ema50 else None,
            "ema200": round(ema200, 4) if ema200 else None,
            "bb_pct": round(bb_pct, 2), "bb_upper": round(bb_u, 4), "bb_lower": round(bb_l, 4),
            "vol_ratio": round(vol_ratio, 2), "support": round(support, 4),
            "resist": round(resist, 4), "trend": trend, "bars": n,
        }
    except Exception:
        return None


def _heuristic_analysis(ticker, tech_by_tf, price, avg_price):
    bull = bear = 0
    for tech in tech_by_tf.values():
        rsi = tech["rsi"]
        if rsi < 35: bull += 2
        elif rsi > 65: bear += 2
        bull += (1 if tech["macd_hist"] > 0 else 0)
        bear += (1 if tech["macd_hist"] < 0 else 0)
        bull += (1 if tech["trend"] == "UP"   else 0)
        bear += (1 if tech["trend"] == "DOWN" else 0)
    action = "BUY" if bull > bear * 1.3 else "SELL" if bear > bull * 1.3 else "WATCH"
    conv   = "HIGH" if abs(bull-bear) >= 6 else "MEDIUM" if abs(bull-bear) >= 3 else "LOW"
    dt     = tech_by_tf.get("1d") or next(iter(tech_by_tf.values()))
    result = {
        "action": action, "conviction": conv,
        "summary": f"Heuristic: {bull} bull vs {bear} bear signals across {len(tech_by_tf)} timeframes. No AI key configured.",
        "bull_case": f"Bullish momentum on {bull} signals. Support at ${dt['support']:.2f}.",
        "bear_case":  f"Bearish momentum on {bear} signals. Break of ${dt['support']:.2f} opens further downside.",
        "price_target_1w": round(price * (1.03 if action == "BUY" else 0.97), 2),
        "price_target_1m": round(price * (1.08 if action == "BUY" else 0.93), 2),
        "support_1": round(dt["support"], 2), "support_2": None,
        "resistance_1": round(dt["resist"], 2), "resistance_2": None,
        "key_level": f"${dt['ema50']:.2f} EMA50" if dt.get("ema50") else f"${dt['support']:.2f} support",
        "entry_zone": f"${round(price*0.98,2)} – ${round(price,2)}" if action == "BUY" else None,
        "stop_loss": round(dt["support"] * 0.98, 2),
        "timeframe_bias": "daily", "price": price, "model": "heuristic", "ticker": ticker,
    }
    if avg_price:
        result["avg_price"] = avg_price
        result["pnl_pct"]   = round((price - avg_price) / avg_price * 100, 2)
    return result


def _run_comprehensive_analysis(ticker):
    t = ticker.upper()
    is_crypto = t in CRYPTO_TICKERS

    tf_cfgs = [("15m","5d","15m"), ("1h","1mo","1h"), ("1d","1y","1d"), ("1wk","5y","1wk")]
    tech_by_tf = {}
    for label, period, interval in tf_cfgs:
        r = _gather_tf_technicals(t, interval, period)
        if r:
            tech_by_tf[label] = r
    if not tech_by_tf:
        return {"error": f"no candle data available for {t}"}

    price = (tech_by_tf.get("1d") or tech_by_tf.get("1h") or next(iter(tech_by_tf.values())))["price"]

    sentiment = None
    if not is_crypto:
        try: sentiment = _stock_sentiment(t)
        except Exception: pass

    news_headlines = []
    try:
        items = yf.Ticker(t).news or []
        news_headlines = [n.get("title","") for n in items[:8] if n.get("title")]
    except Exception:
        pass

    social     = _cache_get(("social", t))
    forecast   = _cache_get(("daily_forecast", t))
    swing_data = _cache_get(("swing_scan",))
    swing_entry = None
    if swing_data:
        best_tfs = swing_data.get("entries", {}).get(t, {})
        if best_tfs:
            swing_entry = max(best_tfs.values(), key=lambda x: x.get("score", 0))

    state     = load_state()
    avg_price = state.get("averages", {}).get(t)

    # ── Build prompt ──────────────────────────────────────────────────────────
    lines = [f"COMPREHENSIVE ANALYSIS: {t}", f"Current price: ${price}"]
    if avg_price:
        pnl = (price - avg_price) / avg_price * 100
        lines.append(f"User cost basis: ${avg_price}  P&L: {pnl:+.1f}%")

    lines.append("\n=== TECHNICALS (by TF) ===")
    for tf_lbl, tech in tech_by_tf.items():
        p_ = tech["price"]
        rsi_tag  = " OVERSOLD"   if tech["rsi"] < 30 else " OVERBOUGHT" if tech["rsi"] > 70 else ""
        bb_tag   = " nearLowerBB" if tech["bb_pct"] < 0.2 else " nearUpperBB" if tech["bb_pct"] > 0.8 else ""
        cross    = " MACD CROSS UP" if tech["macd_cross_up"] else ""
        ema_strs = []
        for e_n, e_v in [("EMA20",tech.get("ema20")),("EMA50",tech.get("ema50")),("EMA200",tech.get("ema200"))]:
            if e_v:
                ema_strs.append(f"{e_n} {(p_-e_v)/e_v*100:+.1f}%")
        lines.append(
            f"[{tf_lbl}] RSI {tech['rsi']:.0f}{rsi_tag} | MACD {tech['macd_hist']:+.5f}{cross} | "
            f"trend {tech['trend']} | vol {tech['vol_ratio']:.1f}x{bb_tag} | "
            f"S ${tech['support']:.2f} R ${tech['resist']:.2f}" +
            (f" | {' '.join(ema_strs)}" if ema_strs else "")
        )

    if sentiment:
        ts_ = sentiment.get("tech",{}); ns_ = sentiment.get("news",{})
        lines += ["\n=== SENTIMENT ===",
                  f"Tech: {ts_.get('label','?')} score {ts_.get('score',0):+.2f}",
                  f"News: {ns_.get('label','?')} ▲{ns_.get('buy_count',0)} ▼{ns_.get('sell_count',0)}"]
    if social:
        lines.append(f"Social: {social.get('label','?')} score {social.get('score','?')}/100")
        if social.get("summary"):
            lines.append(f"  Summary: {social['summary'][:130]}")
    if news_headlines:
        lines.append("\n=== RECENT NEWS ===")
        lines += [f"  • {h[:120]}" for h in news_headlines[:6]]
    if forecast:
        lines += ["\n=== DAILY FORECAST ===",
                  f"Forecast: {forecast.get('label','?')} ({forecast.get('confidence','?')}% conf)"]
        if forecast.get("summary"):   lines.append(f"  {forecast['summary'][:160]}")
        if forecast.get("key_risk"):  lines.append(f"  Risk: {forecast['key_risk'][:100]}")
    if swing_entry:
        lines += ["\n=== SWING SETUP ===",
                  f"[{swing_entry.get('label','?')}] score {swing_entry.get('score','?')}/100  {', '.join(swing_entry.get('signals',[])[:4])}"]
        if swing_entry.get("ai"):
            ai_sw = swing_entry["ai"]
            lines.append(f"  {ai_sw.get('setup_quality','?')} | entry window: {ai_sw.get('entry_window','?')}")

    data_summary = "\n".join(lines)
    prompt = (
        f"{data_summary}\n\n"
        "Give a comprehensive trading analysis based on ALL data above.\n"
        "Respond with ONLY a JSON object (no markdown):\n"
        '{"action":"BUY"|"SELL"|"HOLD"|"WATCH",'
        '"conviction":"LOW"|"MEDIUM"|"HIGH",'
        '"summary":"3-4 sentences covering all timeframes and data points",'
        '"bull_case":"specific price levels and catalysts for upside",'
        '"bear_case":"specific risks and levels for downside",'
        '"price_target_1w":number,'
        '"price_target_1m":number,'
        '"support_1":number,"support_2":number,'
        '"resistance_1":number,"resistance_2":number,'
        '"key_level":"single most important price level or condition",'
        '"entry_zone":"ideal buy zone if action is BUY/WATCH, else null",'
        '"stop_loss":number,'
        '"timeframe_bias":"which TF is most actionable right now"}'
    )

    if not ANTHROPIC_API_KEY:
        return _heuristic_analysis(t, tech_by_tf, price, avg_price)

    try:
        r = _req.post(
            "https://api.anthropic.com/v1/messages",
            headers={"x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": "claude-haiku-4-5-20251001", "max_tokens": 1000,
                  "messages": [{"role": "user", "content": prompt}]},
            timeout=30,
        )
        if not r.ok:
            return _heuristic_analysis(t, tech_by_tf, price, avg_price)
        text  = r.json().get("content", [{}])[0].get("text", "")
        start = text.find("{"); end = text.rfind("}") + 1
        if start >= 0 and end > start:
            parsed = json.loads(text[start:end])
            parsed.update({"price": price, "model": "claude-haiku", "ticker": t})
            if avg_price:
                parsed["avg_price"] = avg_price
                parsed["pnl_pct"]   = round((price - avg_price) / avg_price * 100, 2)
            return parsed
    except Exception:
        pass
    return _heuristic_analysis(t, tech_by_tf, price, avg_price)


@app.route("/api/analyze/<ticker>")
def get_analyze(ticker):
    t = ticker.upper()
    cache_key = ("analyze", t)
    cached = _cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)
    try:
        result = _run_comprehensive_analysis(t)
        _cache_set(cache_key, result, 300)  # 5-min cache
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
            df = yf.Ticker(resolve_ticker(ticker)).history(start=start, interval=interval, auto_adjust=False, actions=False)
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
    "1wk": {"period": "10y", "seasonal": 52, "n_fc": 8,  "max_fit": 500},
    "1d":  {"period": "5y",  "seasonal": 5,  "n_fc": 14, "max_fit": 500},
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

# ══════════════════════════════════════════════════════════════════════════════
# TRADING BOT SIMULATOR
# ══════════════════════════════════════════════════════════════════════════════
PORTFOLIO_FILE  = "virtual_portfolio.json"
_portfolio_lock = threading.Lock()
_bot_thread     = None
_bot_stop_evt   = threading.Event()

_DEFAULT_PORTFOLIO = {
    "capital":         10_000.0,
    "initial_capital": 10_000.0,
    "positions":       [],
    "closed_trades":   [],
    "stats": {
        "total_trades":   0,
        "winning_trades": 0,
        "total_pnl_usd":  0.0,
        "win_rate":       0.0,
        "peak_capital":   10_000.0,
        "max_drawdown":   0.0,
    },
    "bot_active": False,
    "last_eval":  None,
    "log":        [],
}

# ── Portfolio I/O ──────────────────────────────────────────────────────────────
def _port_read():
    with _portfolio_lock:
        if not os.path.exists(PORTFOLIO_FILE):
            return json.loads(json.dumps(_DEFAULT_PORTFOLIO))
        try:
            with open(PORTFOLIO_FILE) as f:
                data = json.load(f)
            for k, v in _DEFAULT_PORTFOLIO.items():
                data.setdefault(k, json.loads(json.dumps(v)))
            return data
        except Exception:
            return json.loads(json.dumps(_DEFAULT_PORTFOLIO))

def _port_write(port):
    with _portfolio_lock:
        tmp = PORTFOLIO_FILE + ".tmp"
        with open(tmp, "w") as f:
            json.dump(port, f, indent=2)
        os.replace(tmp, PORTFOLIO_FILE)

def _port_log(port, msg):
    ts = datetime.now().strftime("%m-%d %H:%M")
    port["log"].insert(0, {"ts": ts, "msg": msg})
    port["log"] = port["log"][:100]

# ── Market hours (US Eastern) ──────────────────────────────────────────────────
def _is_market_hours():
    try:
        import pytz
        et  = pytz.timezone("US/Eastern")
        now = datetime.now(et)
        if now.weekday() >= 5:
            return False
        mo = now.replace(hour=9,  minute=30, second=0, microsecond=0)
        mc = now.replace(hour=15, minute=30, second=0, microsecond=0)
        return mo <= now <= mc
    except Exception:
        return True  # assume open if pytz unavailable

# ── Price helper ───────────────────────────────────────────────────────────────
def _bot_price(ticker):
    try:
        cached = _cache_get(f"price:{resolve_ticker(ticker)}")
        if cached and cached.get("last"):
            return float(cached["last"])
        fi = yf.Ticker(resolve_ticker(ticker)).fast_info
        return float(fi.last_price or 0)
    except Exception:
        return 0.0

def _bot_portfolio_value(port):
    total = port["capital"]
    for pos in port["positions"]:
        p = _bot_price(pos["ticker"])
        total += (p * pos["shares"]) if p > 0 else pos["cost_basis"]
    return round(total, 2)

def _port_update_stats(port, pnl_usd):
    s = port["stats"]
    s["total_trades"]   = s.get("total_trades", 0) + 1
    if pnl_usd > 0:
        s["winning_trades"] = s.get("winning_trades", 0) + 1
    s["total_pnl_usd"] = round(s.get("total_pnl_usd", 0) + pnl_usd, 2)
    s["win_rate"]       = round(s["winning_trades"] / s["total_trades"], 3) if s["total_trades"] else 0
    val = _bot_portfolio_value(port)
    if val > s.get("peak_capital", port["initial_capital"]):
        s["peak_capital"] = val
    dd = val - s.get("peak_capital", port["initial_capital"])
    if dd < s.get("max_drawdown", 0):
        s["max_drawdown"] = round(dd, 2)

# ── Open / close positions ─────────────────────────────────────────────────────
def _bot_open(port, ticker, tf, score, tier, conviction, target, stop_loss):
    pct_map = {
        ("HIGH",   "superb"): 0.12,
        ("HIGH",   "great"):  0.10,
        ("MEDIUM", "superb"): 0.09,
        ("MEDIUM", "great"):  0.07,
    }
    alloc_pct = pct_map.get((conviction, tier), 0.07)
    alloc     = min(port["capital"] * alloc_pct, port["initial_capital"] * 0.15)
    price     = _bot_price(ticker)
    if price <= 0 or alloc < 5:
        return False
    shares = round(alloc / price, 6)
    cost   = round(shares * price, 2)
    if cost > port["capital"]:
        return False
    port["capital"] = round(port["capital"] - cost, 2)
    port["positions"].append({
        "ticker":      ticker,
        "entry_price": round(price, 4),
        "shares":      shares,
        "cost_basis":  cost,
        "entry_date":  datetime.now().strftime("%Y-%m-%d %H:%M"),
        "tf":          tf,
        "tier":        tier,
        "score":       score,
        "conviction":  conviction,
        "target":      round(target,    4),
        "stop_loss":   round(stop_loss, 4),
        "trail_armed": False,
    })
    _port_log(port, f"BUY  {ticker}  @${price:.2f}  {shares:.4f}sh  {tier}  score={score}  tgt=${target:.2f}  sl=${stop_loss:.2f}")
    return True

def _bot_close(port, ticker, reason, price=None):
    pos = next((p for p in port["positions"] if p["ticker"] == ticker), None)
    if not pos:
        return
    if not price or price <= 0:
        price = _bot_price(ticker) or pos["entry_price"]
    pnl_usd = round((price - pos["entry_price"]) * pos["shares"], 2)
    pnl_pct  = round((price - pos["entry_price"]) / pos["entry_price"] * 100, 2) if pos["entry_price"] else 0
    port["capital"] = round(port["capital"] + price * pos["shares"], 2)
    port["closed_trades"].insert(0, {
        "ticker":      ticker,
        "entry_price": pos["entry_price"],
        "exit_price":  round(price, 4),
        "shares":      pos["shares"],
        "pnl_usd":     pnl_usd,
        "pnl_pct":     pnl_pct,
        "entry_date":  pos["entry_date"],
        "exit_date":   datetime.now().strftime("%Y-%m-%d %H:%M"),
        "exit_reason": reason,
        "tier":        pos.get("tier", "—"),
        "tf":          pos.get("tf",   "1d"),
    })
    port["closed_trades"] = port["closed_trades"][:200]
    port["positions"]     = [p for p in port["positions"] if p["ticker"] != ticker]
    _port_update_stats(port, pnl_usd)
    sign = "+" if pnl_usd >= 0 else ""
    _port_log(port, f"SELL {ticker}  @${price:.2f}  {sign}${pnl_usd:.2f} ({sign}{pnl_pct:.1f}%)  [{reason}]")

# ── Evaluate open positions ────────────────────────────────────────────────────
def _bot_evaluate_positions(port):
    for pos in list(port["positions"]):
        ticker = pos["ticker"]
        price  = _bot_price(ticker)
        if price <= 0:
            continue
        entry = pos["entry_price"]
        pct   = (price - entry) / entry if entry else 0

        if pos.get("stop_loss") and price <= pos["stop_loss"]:
            _bot_close(port, ticker, "SL", price); continue

        if pos.get("target") and price >= pos["target"]:
            _bot_close(port, ticker, "TP", price); continue

        days_limit = 30 if pos.get("tf") == "1wk" else 10
        try:
            days_held = (datetime.now() - datetime.strptime(pos["entry_date"][:10], "%Y-%m-%d")).days
            if days_held >= days_limit:
                _bot_close(port, ticker, "TIME", price); continue
        except Exception:
            pass

        # Arm trail stop at +8%: move stop to just above breakeven
        if pct >= 0.08 and not pos.get("trail_armed"):
            pos["trail_armed"] = True
            new_stop = round(entry * 1.002, 4)
            if new_stop > (pos.get("stop_loss") or 0):
                pos["stop_loss"] = new_stop
                _port_log(port, f"TRAIL {ticker}  +{pct*100:.1f}%  stop→${new_stop:.2f}")

# ── Scan swing watchlist for new entries ───────────────────────────────────────
def _bot_scan_entries(port):
    if len(port["positions"]) >= 5:
        return
    deployed = sum(p["cost_basis"] for p in port["positions"])
    if port["capital"] > 0 and deployed / (port["capital"] + deployed) >= 0.50:
        return

    sw = _cache_get(("swing_scan",))
    if not sw and os.path.exists(SWING_CACHE_FILE):
        try:
            with open(SWING_CACHE_FILE) as f:
                sw = json.load(f)
        except Exception:
            return
    if not sw:
        return

    held   = {p["ticker"] for p in port["positions"]}
    recent = {t["ticker"] for t in port["closed_trades"][:5]}

    candidates = []
    for ticker, tfs in (sw.get("entries") or {}).items():
        if ticker in held or ticker in recent:
            continue
        for tf, info in tfs.items():
            if tf not in ("1d", "1wk"):
                continue
            score = info.get("score", 0)
            tier  = info.get("tier", "")
            if score < 68 or tier not in ("great", "superb"):
                continue
            ai_conv = (info.get("ai") or {}).get("conviction", "MEDIUM")
            if ai_conv and ai_conv not in ("HIGH", "MEDIUM"):
                continue
            candidates.append({"ticker": ticker, "tf": tf, "score": score,
                                "tier": tier, "conviction": ai_conv or "MEDIUM"})

    candidates.sort(key=lambda x: x["score"], reverse=True)

    for c in candidates[:3]:
        if len(port["positions"]) >= 5:
            break
        ticker = c["ticker"]
        # Use cached AI analysis for targets if available
        ana       = _cache_get(("analyze", ticker))
        target    = (ana or {}).get("price_target_1w")
        stop_loss = (ana or {}).get("stop_loss")
        conviction = ((ana or {}).get("conviction") or c["conviction"]) if ana and not (ana or {}).get("error") else c["conviction"]
        # Only trust cached BUY signal; skip if AI says SELL
        if ana and not ana.get("error") and ana.get("action") not in ("BUY", None):
            continue
        price = _bot_price(ticker)
        if price <= 0:
            continue
        if not target:
            target    = price * (1.15 if c["tier"] == "superb" else 1.10)
        if not stop_loss:
            stop_loss = price * 0.95
        if _bot_open(port, ticker, c["tf"], c["score"], c["tier"], conviction, target, stop_loss):
            _port_write(port)

# ── Background loop (15-min cycle) ────────────────────────────────────────────
def _bot_loop():
    while not _bot_stop_evt.is_set():
        try:
            port = _port_read()
            if port.get("bot_active") and _is_market_hours():
                _bot_evaluate_positions(port)
                _bot_scan_entries(port)
                port["last_eval"] = datetime.now().isoformat()
                _port_write(port)
        except Exception as ex:
            print(f"[bot] loop error: {ex}")
        _bot_stop_evt.wait(900)

def _bot_ensure_thread():
    global _bot_thread
    if _bot_thread and _bot_thread.is_alive():
        return
    _bot_stop_evt.clear()
    _bot_thread = threading.Thread(target=_bot_loop, daemon=True, name="bot-loop")
    _bot_thread.start()

_bot_ensure_thread()

# ── Bot API endpoints ──────────────────────────────────────────────────────────
@app.route("/api/bot/status")
def bot_status():
    port = _port_read()
    val  = _bot_portfolio_value(port)
    init = port["initial_capital"]
    return jsonify({
        "active":          port["bot_active"],
        "capital":         round(port["capital"], 2),
        "portfolio_value": val,
        "initial_capital": init,
        "pnl_usd":         round(val - init, 2),
        "pnl_pct":         round((val - init) / init * 100, 2) if init else 0,
        "positions":       len(port["positions"]),
        "total_trades":    port["stats"].get("total_trades", 0),
        "win_rate":        port["stats"].get("win_rate", 0),
        "total_pnl_usd":   port["stats"].get("total_pnl_usd", 0),
        "max_drawdown":    port["stats"].get("max_drawdown", 0),
        "last_eval":       port.get("last_eval"),
    })

@app.route("/api/bot/positions")
def bot_positions_ep():
    port   = _port_read()
    result = []
    for pos in port["positions"]:
        price = _bot_price(pos["ticker"])
        pnl_u = round((price - pos["entry_price"]) * pos["shares"], 2) if price > 0 else 0
        pnl_p = round((price - pos["entry_price"]) / pos["entry_price"] * 100, 2) if price > 0 and pos["entry_price"] else 0
        try:
            days_held = (datetime.now() - datetime.strptime(pos["entry_date"][:10], "%Y-%m-%d")).days
        except Exception:
            days_held = 0
        result.append({**pos, "current_price": round(price, 4), "pnl_usd": pnl_u, "pnl_pct": pnl_p, "days_held": days_held})
    return jsonify(result)

@app.route("/api/bot/history")
def bot_history_ep():
    port = _port_read()
    n    = min(int(request.args.get("n", 20)), 100)
    return jsonify(port["closed_trades"][:n])

@app.route("/api/bot/log")
def bot_log_ep():
    port = _port_read()
    n    = min(int(request.args.get("n", 30)), 100)
    return jsonify(port["log"][:n])

@app.route("/api/bot/toggle", methods=["POST"])
def bot_toggle():
    port = _port_read()
    port["bot_active"] = not port["bot_active"]
    _port_log(port, "Bot " + ("ACTIVATED" if port["bot_active"] else "PAUSED"))
    _port_write(port)
    _bot_ensure_thread()
    return jsonify({"active": port["bot_active"]})

@app.route("/api/bot/reset", methods=["POST"])
def bot_reset():
    data = request.get_json(silent=True) or {}
    if data.get("confirm") != "RESET":
        return jsonify({"error": "confirm=RESET required"}), 400
    _port_write(json.loads(json.dumps(_DEFAULT_PORTFOLIO)))
    return jsonify({"ok": True})

if __name__ == "__main__":
    os.makedirs("static", exist_ok=True)
    os.makedirs(PINE_DIR, exist_ok=True)
    print("=" * 55)
    print("  Trading Dashboard Server")
    print("  http://0.0.0.0:5000")
    print(f"  Access via: http://localhost:5000")
    print("=" * 55)
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)