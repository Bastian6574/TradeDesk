#!/usr/bin/env python3
"""
sentiment.py — Background sentiment engine for TradeDesk
Runs three sentiment sources in background threads:
  - TECH: multi-timeframe technical analysis (pandas-ta + Binance)
  - FNG:  Fear & Greed Index (alternative.me, free)
  - NEWS: CoinDesk RSS headlines

Call sentiment.start() once, then sentiment.get() anytime for current state.
"""

import threading, time, re, warnings
from datetime import datetime
import requests

warnings.filterwarnings("ignore")

# ── CONFIG ────────────────────────────────────────────────────────────────────
SYMBOL          = "BTCUSDT"
TECH_REFRESH_S  = 300          # 5 minutes
FNG_REFRESH_S   = 3600         # 1 hour
NEWS_REFRESH_S  = 600          # 10 minutes
NEWS_FETCH_N    = 10

TECH_TIMEFRAMES = {
    "1m":  (100, 0.10),
    "15m": (80,  0.20),
    "1h":  (60,  0.30),
    "4h":  (50,  0.40),
}

FNG_URL  = "https://api.alternative.me/fng/?limit=1"
NEWS_URL = "https://www.coindesk.com/arc/outboundfeeds/rss/"

# ── STATE ─────────────────────────────────────────────────────────────────────
_lock = threading.Lock()

_state = {
    "tech": {
        "label": "SCANNING", "score": 0.0,
        "breakdown": {}, "last_update": None
    },
    "fng": {
        "label": "SCANNING", "value": None,
        "classification": None, "last_update": None
    },
    "news": {
        "label": "SCANNING",
        "buy_count": 0, "sell_count": 0,
        "neutral_count": 0, "noise_count": 0,
        "total_count": 0, "last_update": None,
        "headlines": []
    }
}

_started = False

# ── HELPERS ───────────────────────────────────────────────────────────────────
def _ts(dt):
    return dt.strftime("%H:%M") if dt else None

def _label_color(label):
    return {"BULLISH": "green", "BEARISH": "red",
            "NEUTRAL": "amber", "FILTERED": "text2",
            "SCANNING": "text3"}.get(label, "text3")

# ── TECH SENTIMENT ────────────────────────────────────────────────────────────
def _fetch_ohlcv(interval: str, limit: int):
    try:
        import pandas as pd
        r = requests.get(
            "https://api.binance.com/api/v3/klines",
            params={"symbol": SYMBOL, "interval": interval, "limit": limit},
            timeout=8
        )
        r.raise_for_status()
        df = pd.DataFrame(r.json(), columns=[
            "open_time","open","high","low","close","volume",
            "close_time","qav","nt","tbbav","tbqav","ignore"
        ])
        for col in ["open","high","low","close","volume"]:
            df[col] = df[col].astype(float)
        return df
    except Exception:
        return None

def _score_df(df) -> float:
    try:
        import math, pandas_ta as ta
        if df is None or len(df) < 30:
            return 0.0
        d = df.copy()
        d.ta.ema(length=20,  append=True)
        d.ta.ema(length=50,  append=True)
        d.ta.ema(length=200, append=True)
        d.ta.rsi(length=14,  append=True)
        d.ta.macd(append=True)
        d.ta.bbands(length=20, append=True)
        d.ta.stoch(append=True)
        d.ta.adx(length=14,  append=True)
        r = d.iloc[-1]
        c = r["close"]
        votes = []
        for col in ["EMA_20","EMA_50","EMA_200"]:
            v = r.get(col, float("nan"))
            if not math.isnan(v): votes.append(1 if c > v else -1)
        rsi = r.get("RSI_14", float("nan"))
        if not math.isnan(rsi):
            votes.append(1 if rsi >= 55 else -1 if rsi <= 45 else 0)
        mh = r.get("MACDh_12_26_9", float("nan"))
        if not math.isnan(mh): votes.append(1 if mh > 0 else -1)
        bbp = r.get("BBP_20_2.0_2.0", float("nan"))
        if not math.isnan(bbp):
            votes.append(1 if bbp > 0.6 else -1 if bbp < 0.4 else 0)
        stk = r.get("STOCHk_14_3_3", float("nan"))
        std = r.get("STOCHd_14_3_3", float("nan"))
        if not math.isnan(stk) and not math.isnan(std):
            votes.append(1 if stk > std and stk < 80 else -1 if stk < std and stk > 20 else 0)
        adx = r.get("ADX_14", float("nan"))
        dmp = r.get("DMP_14", float("nan"))
        dmn = r.get("DMN_14", float("nan"))
        if not math.isnan(adx) and adx > 20 and not math.isnan(dmp) and not math.isnan(dmn):
            votes.append(1 if dmp > dmn else -1)
        return round(sum(votes) / len(votes), 3) if votes else 0.0
    except Exception:
        return 0.0

def _tech_update():
    scores = {}; weighted = 0.0; total_w = 0.0
    for tf, (limit, weight) in TECH_TIMEFRAMES.items():
        df = _fetch_ohlcv(tf, limit)
        s  = _score_df(df)
        scores[tf] = round(s, 3)
        weighted  += s * weight; total_w += weight
    composite = round(weighted / total_w, 3) if total_w else 0.0
    label = "BULLISH" if composite >= 0.2 else "BEARISH" if composite <= -0.2 else "NEUTRAL"
    with _lock:
        _state["tech"].update({
            "label": label, "score": composite,
            "breakdown": scores, "last_update": datetime.now()
        })

def _tech_loop():
    while True:
        try: _tech_update()
        except Exception: pass
        time.sleep(TECH_REFRESH_S)

# ── FEAR & GREED ──────────────────────────────────────────────────────────────
def _fng_update():
    r = requests.get(FNG_URL, timeout=8); r.raise_for_status()
    d   = r.json()["data"][0]
    val = int(d["value"]); cls = d["value_classification"]
    label = "BULLISH" if val <= 25 else "BEARISH" if val >= 75 else "NEUTRAL"
    with _lock:
        _state["fng"].update({
            "label": label, "value": val,
            "classification": cls, "last_update": datetime.now()
        })

def _fng_loop():
    while True:
        try: _fng_update()
        except Exception: pass
        time.sleep(FNG_REFRESH_S)

# ── NEWS ──────────────────────────────────────────────────────────────────────
def _fetch_news_rss(n=10):
    try:
        r = requests.get(NEWS_URL, headers={"User-Agent":"Mozilla/5.0"}, timeout=8)
        items = re.findall(r"<item>(.*?)</item>", r.text, re.DOTALL)
        arts = []
        for item in items[:n]:
            t = re.search(r"<title><!\[CDATA\[(.*?)\]\]>", item)
            arts.append({"title": t.group(1) if t else "", "signal": "noise"})
        return arts
    except Exception:
        return []

def _score_headline(title: str) -> str:
    """Simple keyword scoring — no Claude needed."""
    t = title.lower()
    bull = ["surge","rally","bullish","ath","adoption","etf","buy","rise","gain",
            "breakout","pump","recovery","approval","launch","partnership"]
    bear = ["crash","drop","ban","hack","bearish","sell","dump","fraud","collapse",
            "lawsuit","regulation","fear","loss","fall","plunge","scam"]
    b = sum(1 for w in bull if w in t)
    s = sum(1 for w in bear if w in t)
    if b > s:   return "buy"
    if s > b:   return "sell"
    if b == s and b > 0: return "neutral"
    return "noise"

def _news_update():
    arts = _fetch_news_rss(NEWS_FETCH_N)
    for a in arts:
        a["signal"] = _score_headline(a["title"])
    buy = sell = neutral = noise = 0
    for a in arts:
        sig = a.get("signal","noise")
        if sig=="buy":      buy+=1
        elif sig=="sell":   sell+=1
        elif sig=="neutral":neutral+=1
        else:               noise+=1
    total = buy+sell+neutral+noise
    label = ("FILTERED" if total==0 or (buy==0 and sell==0)
             else "BULLISH" if buy>sell else "BEARISH" if sell>buy else "NEUTRAL")
    ranked = ([a for a in arts if a["signal"]=="sell"] +
              [a for a in arts if a["signal"]=="buy"] +
              [a for a in arts if a["signal"]=="neutral"])
    headlines = [{"title": a["title"], "signal": a["signal"]} for a in ranked[:3]]
    with _lock:
        _state["news"].update({
            "label":label, "buy_count":buy, "sell_count":sell,
            "neutral_count":neutral, "noise_count":noise,
            "total_count":total, "last_update":datetime.now(),
            "headlines": headlines
        })

def _news_loop():
    while True:
        try: _news_update()
        except Exception: pass
        time.sleep(NEWS_REFRESH_S)

# ── PUBLIC API ────────────────────────────────────────────────────────────────
def start():
    """Start background sentiment threads. Call once at server startup."""
    global _started
    if _started: return
    _started = True
    for fn in [_tech_loop, _fng_loop, _news_loop]:
        t = threading.Thread(target=fn, daemon=True)
        t.start()

def get() -> dict:
    """Return current sentiment state as JSON-serialisable dict."""
    with _lock:
        import copy
        s = copy.deepcopy(_state)

    # Serialise datetimes and add color hints
    for key in ["tech","fng","news"]:
        dt = s[key].get("last_update")
        s[key]["last_update"] = _ts(dt)
        s[key]["color"] = _label_color(s[key]["label"])

    return s