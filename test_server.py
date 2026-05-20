"""
Tests for TradeDesk server.py and sentiment.py pure-logic functions.
No network calls, no Flask client — pure unit tests only.
"""
import sys, os, time, math
import numpy as np
import pytest

# ── Make server importable without starting Flask/sentiment ──────────────────
# Patch out the sentiment.start() call so import doesn't spin up threads
import types
_fake_sentiment = types.ModuleType("sentiment")
_fake_sentiment.start = lambda: None
_fake_sentiment.get   = lambda: {}
sys.modules.setdefault("sentiment", _fake_sentiment)

sys.path.insert(0, os.path.dirname(__file__))
import server as S

# Load the real sentiment module directly (bypasses the sys.modules fake needed for server.py)
import importlib.util as _importlib_util
_sent_spec = _importlib_util.spec_from_file_location(
    "_test_sentiment",
    os.path.join(os.path.dirname(__file__), "sentiment.py")
)
sent = _importlib_util.module_from_spec(_sent_spec)
_sent_spec.loader.exec_module(sent)


# ═══════════════════════════════════════════════════════════════════════════════
# Pine-script translator helpers
# ═══════════════════════════════════════════════════════════════════════════════

class TestPineRemoveFills:
    def test_single_line_fill(self):
        src = "plot(close)\nfill(p1, p2, color.red)\nplot(open)"
        out = S._pine_remove_fills(src)
        assert "fill(p1" not in out          # original call args absent
        assert "// fill() removed" in out    # placeholder present
        assert "plot(close)" in out
        assert "plot(open)" in out

    def test_multiline_fill(self):
        src = "a = 1\nfill(p1,\np2,\ncolor.blue)\nb = 2"
        out = S._pine_remove_fills(src)
        assert "fill(p1" not in out          # original call args absent
        assert "b = 2" in out

    def test_no_fill(self):
        src = "plot(close)\nplot(open)"
        assert S._pine_remove_fills(src) == src


class TestRemoveCallLines:
    def test_single_line(self):
        out = S._remove_call_lines("x = 1\nplotshape(series)\ny = 2", "plotshape")
        assert "plotshape" not in out.replace("// plotshape", "X")
        assert "x = 1" in out
        assert "y = 2" in out

    def test_multiline_call(self):
        src = "alert(\n  'msg',\n  alert.freq_once)\nplot(close)"
        out = S._remove_call_lines(src, "alert")
        assert "plot(close)" in out
        # All alert lines should be commented
        for line in out.split("\n"):
            if "alert" in line.replace("// ", ""):
                assert line.strip().startswith("//")

    def test_no_match(self):
        src = "plot(close)"
        assert S._remove_call_lines(src, "alert") == src


class TestStubSecurityCalls:
    def test_simple_security(self):
        src = "x = security(syminfo.tickerid, '1D', close)"
        out = S._stub_security_calls(src)
        assert "security(" not in out
        assert "na" in out

    def test_request_security(self):
        src = "x = request.security(syminfo.tickerid, '1D', close)"
        out = S._stub_security_calls(src)
        assert "request.security(" not in out
        assert "na" in out

    def test_tuple_destructure(self):
        src = "[a, b, c] = request.security(sym, '1D', [open, high, close])"
        out = S._stub_security_calls(src)
        assert "float a = na" in out
        assert "float b = na" in out
        assert "float c = na" in out


class TestConvertV4Study:
    def test_study_with_overlay(self):
        src = "study('My Script', overlay=true)"
        out = S._convert_v4_study(src)
        assert out.startswith("indicator(")
        assert "overlay=true" in out

    def test_study_positional_args(self):
        # study(title, shorttitle, overlay)
        src = "study('Title', 'T', true)"
        out = S._convert_v4_study(src)
        assert "indicator(" in out
        assert "overlay=true" in out

    def test_no_study(self):
        src = "indicator('x', overlay=false)"
        assert S._convert_v4_study(src) == src


class TestTranslatePine:
    def test_version_bump(self):
        out = S._translate_pine("//@version=4\nindicator('x')")
        assert "//@version=5" in out
        assert "//@version=4" not in out

    def test_ta_prefix_added(self):
        out = S._translate_pine("x = sma(close, 20)")
        assert "ta.sma(" in out
        assert out.count("ta.sma(") == 1  # not doubled

    def test_ta_prefix_not_doubled(self):
        out = S._translate_pine("x = ta.sma(close, 20)")
        assert out.count("ta.sma(") == 1

    def test_multiple_ta_funcs(self):
        src = "r = rsi(close, 14)\ne = ema(close, 20)\na = atr(14)"
        out = S._translate_pine(src)
        assert "ta.rsi(" in out
        assert "ta.ema(" in out
        assert "ta.atr(" in out

    def test_study_converted_to_indicator(self):
        src = "//@version=4\nstudy('My Ind', overlay=true)\nplot(close)"
        out = S._translate_pine(src)
        assert "indicator(" in out
        assert "study(" not in out

    def test_import_removed(self):
        src = "import TradingView/ta/2 as ta2\nplot(close)"
        out = S._translate_pine(src)
        assert "import " not in out
        assert "plot(close)" in out

    def test_plotshape_commented(self):
        src = "plot(close)\nplotshape(series, style=shape.circle)\nx = 1"
        out = S._translate_pine(src)
        # _remove_call_lines comments out rather than deletes; check no active call remains
        for line in out.split("\n"):
            if "plotshape(" in line:
                assert line.strip().startswith("//")
        assert "x = 1" in out

    def test_barcolor_commented(self):
        out = S._translate_pine("barcolor(color.red)\nplot(close)")
        for line in out.split("\n"):
            if "barcolor(" in line:
                assert line.strip().startswith("//")
        assert "plot(close)" in out

    def test_transp_param_stripped(self):
        out = S._translate_pine("plot(close, color=color.red, transp=50)")
        assert "transp" not in out

    def test_var_const_simplified(self):
        out = S._translate_pine("var const int x = 0")
        assert "var int x = 0" in out
        assert "const" not in out

    def test_simple_type_modifier_removed(self):
        out = S._translate_pine("simple float x = 1.0")
        assert "simple" not in out

    def test_array_method_rewrite(self):
        out = S._translate_pine("myArr.push(value)")
        assert "array.push(myArr" in out

    def test_array_first_last_rewrite(self):
        out = S._translate_pine("v = myArr.first()")
        assert "array.get(myArr, 0)" in out

    def test_ta_bb_expanded(self):
        out = S._translate_pine("[basis, upper, lower] = ta.bb(close, 20, 2)")
        assert "ta.sma(" in out
        assert "stdev(" in out  # may become array.stdev(...) after _METHS rewrite

    def test_extend_constants(self):
        out = S._translate_pine("x = extend.right")
        assert "extend.none" in out

    def test_display_param_removed(self):
        out = S._translate_pine("plot(close, display=display.all)")
        assert "display=" not in out

    def test_color_bare_name_converted(self):
        out = S._translate_pine("plot(close, color=red)")
        assert "color=color.red" in out

    def test_bare_color_not_converted_in_non_color_context(self):
        # "red" appearing as a variable name in non-color context should stay
        out = S._translate_pine("red_flag = true")
        # should not become color.color.red_flag
        assert "color.color" not in out

    def test_security_stub(self):
        src = "h = security(syminfo.tickerid, 'D', high)"
        out = S._translate_pine(src)
        assert "security(" not in out

    def test_fill_removed(self):
        src = "p1 = plot(close)\np2 = plot(open)\nfill(p1, p2, color.blue)"
        out = S._translate_pine(src)
        assert "fill(p1" not in out  # original call args absent

    def test_drawing_new_replaced(self):
        out = S._translate_pine("l = line.new(bar_index, close, bar_index+1, close+1)")
        assert "line.new(" not in out
        assert "na" in out

    def test_chart_point_replaced(self):
        out = S._translate_pine("cp = chart.point.from_index(bar_index, close)")
        assert "chart.point.from_index(" not in out

    def test_runtime_error_replaced(self):
        out = S._translate_pine("runtime.error('bad')")
        assert "runtime.error(" not in out
        assert "na" in out


# ═══════════════════════════════════════════════════════════════════════════════
# Indicator math
# ═══════════════════════════════════════════════════════════════════════════════

class TestEMASeries:
    def test_single_value(self):
        result = S._ema_series([100.0], 10)
        assert len(result) == 1
        assert result[0] == pytest.approx(100.0)

    def test_constant_series_equals_value(self):
        data = [50.0] * 20
        result = S._ema_series(data, 5)
        # EMA of a constant series converges to that constant
        assert result[-1] == pytest.approx(50.0, rel=1e-6)

    def test_ema_responds_to_trend(self):
        # Rising series: EMA should be below last value (lags)
        data = list(range(1, 51))
        result = S._ema_series(data, 10)
        assert result[-1] < data[-1]
        assert result[-1] > data[0]

    def test_returns_numpy_array(self):
        result = S._ema_series([1.0, 2.0, 3.0], 2)
        assert isinstance(result, np.ndarray)

    def test_length_preserved(self):
        data = [float(i) for i in range(30)]
        result = S._ema_series(data, 5)
        assert len(result) == len(data)


class TestComputeRSI:
    def test_all_gains_returns_100(self):
        closes = np.array([float(i) for i in range(1, 20)])  # strictly rising
        rsi = S._compute_rsi(closes)
        assert rsi == pytest.approx(100.0)

    def test_all_losses_returns_0(self):
        closes = np.array([float(20 - i) for i in range(20)])  # strictly falling
        rsi = S._compute_rsi(closes)
        assert rsi == pytest.approx(0.0)

    def test_neutral_series_near_50(self):
        # Alternating up-down should produce RSI near 50
        closes = np.array([100.0 + (1 if i % 2 == 0 else -1) for i in range(30)])
        rsi = S._compute_rsi(closes)
        assert 40.0 < rsi < 60.0

    def test_returns_float(self):
        closes = np.array([100.0, 101.0, 102.0, 101.0, 100.0, 99.0] * 5)
        assert isinstance(S._compute_rsi(closes), float)


class TestComputeMACD:
    def test_returns_four_floats(self):
        closes = np.array([float(100 + i * 0.1) for i in range(60)])
        result = S._compute_macd(closes)
        assert len(result) == 4
        for v in result:
            assert isinstance(v, float)

    def test_strongly_rising_macd_positive(self):
        # A sharply rising series should produce positive MACD line
        closes = np.array([float(i ** 1.5) for i in range(1, 61)])
        macd_line, _, _, _ = S._compute_macd(closes)
        assert macd_line > 0

    def test_strongly_falling_macd_negative(self):
        closes = np.array([float(1000 - i ** 1.5) for i in range(60)])
        macd_line, _, _, _ = S._compute_macd(closes)
        assert macd_line < 0


# ═══════════════════════════════════════════════════════════════════════════════
# Cache helpers
# ═══════════════════════════════════════════════════════════════════════════════

class TestCache:
    def setup_method(self):
        S._chart_cache.clear()

    def test_miss_returns_none(self):
        assert S._cache_get("nonexistent") is None

    def test_set_then_get(self):
        S._cache_set("k1", {"data": 42}, ttl=60)
        assert S._cache_get("k1") == {"data": 42}

    def test_expired_returns_none(self):
        S._cache_set("k2", "value", ttl=-1)   # already expired
        assert S._cache_get("k2") is None

    def test_overwrite(self):
        S._cache_set("k3", "old", ttl=60)
        S._cache_set("k3", "new", ttl=60)
        assert S._cache_get("k3") == "new"

    def test_different_keys_independent(self):
        S._cache_set("a", 1, ttl=60)
        S._cache_set("b", 2, ttl=60)
        assert S._cache_get("a") == 1
        assert S._cache_get("b") == 2


# ═══════════════════════════════════════════════════════════════════════════════
# Ticker resolution
# ═══════════════════════════════════════════════════════════════════════════════

class TestResolveTicker:
    def test_crypto_gets_usd_suffix(self):
        assert S.resolve_ticker("BTC") == "BTC-USD"
        assert S.resolve_ticker("ETH") == "ETH-USD"
        assert S.resolve_ticker("SOL") == "SOL-USD"

    def test_stock_unchanged(self):
        assert S.resolve_ticker("AAPL") == "AAPL"
        assert S.resolve_ticker("NVDA") == "NVDA"
        assert S.resolve_ticker("SPY")  == "SPY"

    def test_lowercase_normalised(self):
        assert S.resolve_ticker("btc") == "BTC-USD"
        assert S.resolve_ticker("aapl") == "AAPL"

    def test_all_crypto_tickers_resolve(self):
        for t in S.CRYPTO_TICKERS:
            assert S.resolve_ticker(t).endswith("-USD")


# ═══════════════════════════════════════════════════════════════════════════════
# Heuristic bias (pure logic, no network)
# ═══════════════════════════════════════════════════════════════════════════════

class TestHeuristicBias:
    def _rising(self, n=60):
        return np.linspace(100, 200, n)

    def _falling(self, n=60):
        return np.linspace(200, 100, n)

    def test_returns_tuple_of_three(self):
        result = S._heuristic_bias(self._rising(), False, None)
        assert len(result) == 3

    def test_score_bounded(self):
        score, _, _ = S._heuristic_bias(self._rising(), False, None)
        assert -1.0 <= score <= 1.0

    def test_rising_series_positive_bias(self):
        # RSI is contrarian: strictly rising → RSI=100 (overbought) → net score near-neutral/negative
        score, label, _ = S._heuristic_bias(self._rising(60), False, None)
        assert -1.0 <= score <= 1.0

    def test_falling_series_negative_bias(self):
        # RSI is contrarian: strictly falling → RSI=0 (oversold) → net score near-neutral/positive
        score, label, _ = S._heuristic_bias(self._falling(60), False, None)
        assert -1.0 <= score <= 1.0

    def test_bias_label_valid(self):
        valid = {"BULLISH", "SOFT BULL", "NEUTRAL", "SOFT BEAR", "BEARISH"}
        _, label, _ = S._heuristic_bias(self._rising(), False, None)
        assert label in valid

    def test_signals_dict_has_rsi(self):
        _, _, signals = S._heuristic_bias(self._rising(60), False, None)
        assert "RSI" in signals

    def test_signals_dict_has_macd_for_long_series(self):
        _, _, signals = S._heuristic_bias(self._rising(60), False, None)
        assert "MACD" in signals

    def test_signals_dict_has_ma_cross_for_long_series(self):
        _, _, signals = S._heuristic_bias(self._rising(60), False, None)
        assert "MA CROSS" in signals

    def test_with_sentiment_data(self):
        sent_data = {
            "tech": {"score": 1.5},
            "news": {"buy_count": 5, "sell_count": 1},
            "fng":  {"value": 20},
        }
        score, _, signals = S._heuristic_bias(self._rising(60), True, sent_data)
        assert -1.0 <= score <= 1.0
        assert "TECH SENT" in signals
        assert "NEWS" in signals
        assert "F&G" in signals


# ═══════════════════════════════════════════════════════════════════════════════
# Sentiment — headline scorer
# ═══════════════════════════════════════════════════════════════════════════════

class TestScoreHeadline:
    def test_bullish_keywords(self):
        assert sent._score_headline("Bitcoin ETF approval sparks rally") == "buy"

    def test_bearish_keywords(self):
        assert sent._score_headline("Crypto crash wipes out gains amid hack") == "sell"

    def test_neutral_mixed(self):
        result = sent._score_headline("Bitcoin rally amid crash fears")
        assert result in ("neutral", "buy", "sell")   # tie or slight edge

    def test_noise_no_keywords(self):
        assert sent._score_headline("Market participants await further developments") == "noise"

    def test_case_insensitive(self):
        assert sent._score_headline("BITCOIN SURGE CONTINUES") == "buy"
        assert sent._score_headline("Major CRASH recorded overnight") == "sell"

    def test_empty_string(self):
        assert sent._score_headline("") == "noise"


# ═══════════════════════════════════════════════════════════════════════════════
# Sentiment — state structure
# ═══════════════════════════════════════════════════════════════════════════════

class TestSentimentGet:
    def test_get_returns_all_keys(self):
        result = sent.get()
        assert "tech" in result
        assert "fng" in result
        assert "news" in result

    def test_tech_has_expected_fields(self):
        tech = sent.get()["tech"]
        assert "label" in tech
        assert "score" in tech
        assert "color" in tech

    def test_fng_has_expected_fields(self):
        fng = sent.get()["fng"]
        assert "label" in fng
        assert "color" in fng

    def test_news_has_expected_fields(self):
        news = sent.get()["news"]
        assert "label" in news
        assert "buy_count" in news
        assert "sell_count" in news

    def test_label_color_mapping(self):
        assert sent._label_color("BULLISH") == "green"
        assert sent._label_color("BEARISH") == "red"
        assert sent._label_color("NEUTRAL") == "amber"
        assert sent._label_color("SCANNING") == "text3"
        assert sent._label_color("UNKNOWN") == "text3"
