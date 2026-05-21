export const LIVE_MAX  = 500;
export const N_FC      = 20;
export const TF_PERIOD = { "1s":null,"1m":"1d","5m":"2d","15m":"5d","30m":"5d","1h":"1mo","1d":"2y","1wk":"5y" };
export const TF_N_FC   = { "5m":12, "15m":16, "30m":24, "1h":24, "1d":14, "1wk":8 };

export function fmt(v)    { if (v==null) return "—"; return v>=1000?v.toFixed(2):v>=1?v.toFixed(3):v.toFixed(5); }
export function fmtVol(v) { if (!v) return "—"; if (v>=1e9) return (v/1e9).toFixed(2)+"B"; if (v>=1e6) return (v/1e6).toFixed(2)+"M"; if (v>=1e3) return (v/1e3).toFixed(1)+"K"; return v.toFixed(0); }

export function toBinanceSymbol(t) {
  const m = {BTC:"btcusdt",ETH:"ethusdt",BNB:"bnbusdt",SOL:"solusdt",DOGE:"dogeusdt",ADA:"adausdt",XRP:"xrpusdt",AVAX:"avaxusdt",DOT:"dotusdt",LINK:"linkusdt"};
  return m[t.toUpperCase()] || null;
}

export function tfIntervalMs(tf) {
  return {"1m":60000,"5m":300000,"15m":900000,"30m":1800000,"1h":3600000,"1d":86400000,"1wk":604800000}[tf] || 0;
}

export function candleTimeRemaining(tf, lastTs) {
  const iv = tfIntervalMs(tf); if (!iv || !lastTs) return null;
  const rem = (lastTs + iv) - Date.now(); if (rem <= 0) return null;
  const s=Math.floor(rem/1000), h=Math.floor(s/3600), mn=Math.floor((s%3600)/60), sc=s%60;
  return h>0 ? `${h}:${String(mn).padStart(2,'0')}:${String(sc).padStart(2,'0')}` : `${String(mn).padStart(2,'0')}:${String(sc).padStart(2,'0')}`;
}

export function calcRSI(candles, period=14) {
  const closes=candles.map(c=>c.c), rsi=new Array(closes.length).fill(null);
  if (closes.length < period+1) return rsi;
  let ag=0,al=0;
  for (let i=1;i<=period;i++){const d=closes[i]-closes[i-1];if(d>0)ag+=d;else al+=Math.abs(d);}
  ag/=period; al/=period;
  rsi[period]=al===0?100:100-(100/(1+ag/al));
  for (let i=period+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1],g=d>0?d:0,l=d<0?Math.abs(d):0;
    ag=(ag*(period-1)+g)/period; al=(al*(period-1)+l)/period;
    rsi[i]=al===0?100:100-(100/(1+ag/al));
  }
  return rsi;
}

export function calcEMA(values, period) {
  const k=2/(period+1), ema=new Array(values.length).fill(null);
  let prev=null;
  for (let i=0;i<values.length;i++){
    if (values[i]==null) continue;
    if (prev==null){prev=values[i];ema[i]=values[i];continue;}
    ema[i]=values[i]*k+prev*(1-k); prev=ema[i];
  }
  return ema;
}

export function calcMACD(candles) {
  const closes=candles.map(c=>c.c);
  const ema12=calcEMA(closes,12), ema26=calcEMA(closes,26);
  const macdLine=closes.map((_,i)=>(ema12[i]!=null&&ema26[i]!=null)?ema12[i]-ema26[i]:null);
  const signal=calcEMA(macdLine.filter(v=>v!=null),9);
  const aligned=new Array(macdLine.length).fill(null);
  let si=0; macdLine.forEach((v,i)=>{if(v!=null){aligned[i]=signal[si++]||null;}});
  const hist=macdLine.map((v,i)=>(v!=null&&aligned[i]!=null)?v-aligned[i]:null);
  return {macdLine,signal:aligned,hist};
}

export function calcMA(candles, n) {
  return candles.map((_,i)=>i<n-1?null:candles.slice(i-n+1,i+1).reduce((s,c)=>s+c.c,0)/n);
}

export function loadCSS(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const l=document.createElement('link'); l.rel='stylesheet'; l.href=href;
  document.head.appendChild(l);
}
