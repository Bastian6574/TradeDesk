#!/usr/bin/env python3
"""
sentiment.py — Background sentiment engine for TradeDesk
Runs three sentiment sources in background threads:
  - TECH: multi-timeframe technical analysis (pandas-ta + Binance)
  - FNG:  Fear & Greed Index (alternative.me, free)
  - NEWS: CoinDesk RSS headlines

Call sentiment.start() once, then sentiment.get() anytime for current state.
"""

import threading, time, re, warnings, json
from datetime import datetime
import requests

# ── ANTHROPIC / SOCIAL CONFIG ─────────────────────────────────────────────────
ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL   = "claude-haiku-4-5-20251001"

_CRYPTO_TICKERS = {"BTC","ETH","BNB","SOL","DOGE","ADA","XRP","AVAX","DOT","LINK","MATIC","LTC","BCH","UNI","ATOM"}

_REDDIT_CRYPTO_SUBS = {
    "BTC":  ["Bitcoin", "CryptoCurrency"],
    "ETH":  ["ethereum", "CryptoCurrency"],
    "SOL":  ["solana", "CryptoCurrency"],
    "DOGE": ["dogecoin", "CryptoCurrency"],
    "XRP":  ["Ripple", "CryptoCurrency"],
    "BNB":  ["BNBTrader", "CryptoCurrency"],
    "ADA":  ["cardano", "CryptoCurrency"],
    "AVAX": ["Avax", "CryptoCurrency"],
    "LINK": ["LINKTrader", "CryptoCurrency"],
    "MATIC":["0xPolygon", "CryptoCurrency"],
}

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

def _ema(series, span):
    return series.ewm(span=span, adjust=False).mean()

def _rsi(series, period=14):
    delta = series.diff()
    gain = delta.clip(lower=0).ewm(alpha=1/period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1/period, adjust=False).mean()
    rs = gain / loss.replace(0, float("nan"))
    return 100 - (100 / (1 + rs))

def _score_df(df) -> float:
    import math
    if df is None or len(df) < 30:
        return 0.0
    c = df["close"]
    h = df["high"]
    l = df["low"]

    ema20  = _ema(c, 20).iloc[-1]
    ema50  = _ema(c, 50).iloc[-1]
    ema200 = _ema(c, 200).iloc[-1] if len(df) >= 200 else float("nan")
    last   = c.iloc[-1]

    rsi_val = _rsi(c, 14).iloc[-1]

    ema12 = _ema(c, 12); ema26 = _ema(c, 26)
    macd_line   = ema12 - ema26
    macd_signal = _ema(macd_line, 9)
    macd_hist   = (macd_line - macd_signal).iloc[-1]

    sma20 = c.rolling(20).mean(); std20 = c.rolling(20).std()
    bb_upper = (sma20 + 2 * std20).iloc[-1]
    bb_lower = (sma20 - 2 * std20).iloc[-1]
    bb_pct = (last - bb_lower) / (bb_upper - bb_lower) if (bb_upper - bb_lower) > 0 else float("nan")

    lo14 = l.rolling(14).min(); hi14 = h.rolling(14).max()
    stoch_k_raw = 100 * (c - lo14) / (hi14 - lo14).replace(0, float("nan"))
    stoch_k = stoch_k_raw.rolling(3).mean()
    stoch_d = stoch_k.rolling(3).mean()
    sk, sd = stoch_k.iloc[-1], stoch_d.iloc[-1]

    votes = []
    for v in [ema20, ema50]:
        if not math.isnan(v): votes.append(1 if last > v else -1)
    if not math.isnan(ema200): votes.append(1 if last > ema200 else -1)
    if not math.isnan(rsi_val): votes.append(1 if rsi_val >= 55 else -1 if rsi_val <= 45 else 0)
    if not math.isnan(macd_hist): votes.append(1 if macd_hist > 0 else -1)
    if not math.isnan(bb_pct):   votes.append(1 if bb_pct > 0.6 else -1 if bb_pct < 0.4 else 0)
    if not math.isnan(sk) and not math.isnan(sd):
        votes.append(1 if sk > sd and sk < 80 else -1 if sk < sd and sk > 20 else 0)

    return round(sum(votes) / len(votes), 3) if votes else 0.0

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


# ── SOCIAL SENTIMENT (Reddit + Claude) ───────────────────────────────────────
def _fetch_reddit(ticker):
    """Fetch recent Reddit posts for sentiment. Returns (posts, bull_count, bear_count)."""
    t = ticker.upper()
    is_crypto = t in _CRYPTO_TICKERS
    if is_crypto:
        subs = _REDDIT_CRYPTO_SUBS.get(t, ["CryptoCurrency"])
    else:
        subs = ["wallstreetbets", "stocks", "investing"]

    headers = {"User-Agent": "TradeDesk/1.0 sentiment-bot"}
    posts, bull, bear = [], 0, 0

    for sub in subs[:2]:
        try:
            r = requests.get(
                f"https://www.reddit.com/r/{sub}/search.json",
                params={"q": t, "sort": "new", "t": "day", "limit": 20, "restrict_sr": 1},
                headers=headers,
                timeout=8,
            )
            if r.status_code != 200:
                continue
            for item in r.json().get("data", {}).get("children", []):
                p = item.get("data", {})
                title = p.get("title", "")
                snippet = p.get("selftext", "")[:150]
                combined = f"{title} {snippet}".strip()
                if combined:
                    posts.append(combined[:250])
                score = p.get("score", 0)
                ratio = p.get("upvote_ratio", 0.5)
                if score > 5:
                    if ratio >= 0.70:  bull += 1
                    elif ratio <= 0.40: bear += 1
        except Exception:
            continue

    return posts[:25], bull, bear

def _claude_analyze(ticker, posts, news_titles, bull, bear, api_key):
    posts_text = "\n".join(f"- {p}" for p in posts[:20]) or "(no social posts retrieved)"
    news_text  = "\n".join(f"- {h}" for h in news_titles[:6]) or "(no news retrieved)"
    prompt = (
        f"Analyze current market sentiment for {ticker.upper()}.\n\n"
        f"Reddit posts ({bull} net-positive / {bear} net-negative by upvote ratio):\n{posts_text}\n\n"
        f"Recent news headlines:\n{news_text}\n\n"
        "Reply with ONLY a JSON object — no markdown, no explanation:\n"
        '{"score":75,"label":"BULLISH","summary":"2 sentence plain-English why sentiment is what it is.",'
        '"themes":["theme1","theme2","theme3"],'
        '"bull_signals":["pattern1","pattern2"],'
        '"bear_signals":["pattern1"]}'
    )
    resp = requests.post(
        ANTHROPIC_API_URL,
        headers={
            "x-api-key":           api_key,
            "anthropic-version":   "2023-06-01",
            "content-type":        "application/json",
        },
        json={
            "model":      ANTHROPIC_MODEL,
            "max_tokens": 512,
            "messages":   [{"role": "user", "content": prompt}],
        },
        timeout=20,
    )
    resp.raise_for_status()
    text = resp.json()["content"][0]["text"].strip()
    # Strip markdown code fences if present
    text = re.sub(r"^```[a-z]*\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```$", "", text)
    return json.loads(text)

def analyze_social(ticker, api_key=None):
    """
    Fetch Reddit posts + yfinance news, run through Claude for structured sentiment.
    Returns dict with score, label, summary, themes, bull_signals, bear_signals,
    bull_count, bear_count, post_count. Never includes 'error' key on partial failures
    so the client stays online with a neutral fallback.
    """
    now_str = datetime.now().strftime("%H:%M")
    posts, bull, bear = _fetch_reddit(ticker)

    news_titles = []
    try:
        import yfinance as yf
        sym = ticker.upper()
        if sym in _CRYPTO_TICKERS:
            sym += "-USD"
        items = yf.Ticker(sym).news or []
        news_titles = [
            (i.get("content") or {}).get("title") or i.get("title", "")
            for i in items[:8] if i
        ]
        news_titles = [t for t in news_titles if t]
    except Exception:
        pass

    def _keyword_fallback(reason=""):
        total = bull + bear
        score = round(50 + (bull - bear) / max(total, 1) * 40) if total else 50
        label = "BULLISH" if score >= 60 else "BEARISH" if score <= 40 else "NEUTRAL"
        color = "green" if label == "BULLISH" else "red" if label == "BEARISH" else "amber"
        summary = f"Reddit: {bull} positive / {bear} negative posts."
        if reason: summary += f" ({reason})"
        return {
            "score": score, "label": label, "color": color,
            "summary": summary, "themes": [], "bull_signals": [], "bear_signals": [],
            "bull_count": bull, "bear_count": bear, "post_count": len(posts),
            "last_update": now_str,
        }

    if not api_key or api_key.startswith("paste_"):
        return _keyword_fallback("no AI key")

    try:
        result = _claude_analyze(ticker, posts, news_titles, bull, bear, api_key)
        label  = result.get("label", "NEUTRAL").upper()
        score  = int(result.get("score", 50))
        color  = "green" if label == "BULLISH" else "red" if label == "BEARISH" else "amber"
        return {
            "score":        score,
            "label":        label,
            "color":        color,
            "summary":      result.get("summary", ""),
            "themes":       result.get("themes", [])[:4],
            "bull_signals": result.get("bull_signals", [])[:3],
            "bear_signals": result.get("bear_signals", [])[:3],
            "bull_count":   bull,
            "bear_count":   bear,
            "post_count":   len(posts),
            "last_update":  now_str,
        }
    except Exception:
        return _keyword_fallback("AI analysis failed")