import { DurableObject } from "cloudflare:workers";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const PAIRS = [
  { label: "XAUUSD", symbol: "XAU/USD" },
  { label: "BTCUSD", symbol: "BTC/USD" }
];

const TIMEFRAME = "15min";
const LOT = "0.01";
const RR = 2;
const BODY_MIN = 0.65;
const RSI_LONG = 55;
const RSI_SHORT = 45;
const ATR_SL = 0.2;
const OUTPUT_SIZE = 80;

export class XAUSetupLock extends DurableObject {
  async fetch() {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" }
    });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({
        ok: true,
        status: "working",
        worker: "smart-recovery-bot",
        pairs: ["XAUUSD", "BTCUSD"],
        timeframe: "15m",
        lot: LOT
      });
    }

    if (url.pathname === "/telegram-test") {
      const test = await sendTelegram(
        env,
        "XAU AI CHART\n\nTelegram connection test successful.\nStrategy: 15m momentum breakout\nPairs: XAUUSD + BTCUSD\nLot: 0.01"
      );
      return json(test);
    }

    if (url.pathname === "/" || url.pathname === "/scan") {
      const force = url.searchParams.get("force") === "1";
      const result = await runScan(env, force);
      return json(result);
    }

    return json({
      ok: true,
      message: "Use /health, /scan, /scan?force=1 or /telegram-test"
    });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScan(env, false));
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

async function runScan(env, force) {
  const results = [];

  for (const pair of PAIRS) {
    try {
      const candles = await getCandles(env, pair.symbol);
      const closed = candles.slice(0, -1);
      const sig = detectSignal(closed);

      if (!sig) {
        results.push({ pair: pair.label, signal: "none" });
        continue;
      }

      const key = `${pair.label}|${sig.time}|${sig.side}`;
      if (env.XAU_SIGNAL_CACHE && !force) {
        const existing = await env.XAU_SIGNAL_CACHE.get(key);
        if (existing) {
          results.push({ pair: pair.label, signal: "already_sent", ...sig });
          continue;
        }
      }

      const text =
        `${sig.side === "BUY" ? "🟢" : "🔴"} ${pair.label} | 15M SIGNAL\n\n` +
        `Direction: ${sig.side}\n` +
        `Lot size: ${LOT}\n\n` +
        `Entry: ${sig.entry}\n` +
        `SL: ${sig.sl}\n` +
        `TP: ${sig.tp}\n\n` +
        `RR: 1:${RR}\n` +
        `RSI: ${sig.rsi} | Body: ${sig.body}%\n` +
        `Candle: ${sig.time}`;

      const sent = await sendTelegram(env, text);
      if (env.XAU_SIGNAL_CACHE && sent.sent) {
        await env.XAU_SIGNAL_CACHE.put(key, "1", { expirationTtl: 60 * 60 * 12 });
      }

      results.push({
        pair: pair.label,
        signal: sent.sent ? "sent" : "telegram_failed",
        error: sent.error || null,
        ...sig
      });
    } catch (err) {
      results.push({ pair: pair.label, error: String(err.message || err) });
    }
  }

  return {
    ok: true,
    time: new Date().toISOString(),
    results
  };
}

async function getCandles(env, symbol) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error("TWELVE_DATA_API_KEY is missing");
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${TIMEFRAME}` +
    `&outputsize=${OUTPUT_SIZE}` +
    "&apikey=" +
    encodeURIComponent(env.TWELVE_DATA_API_KEY);

  const response = await fetch(url);
  const data = await response.json();

  if (!response.ok || data.status === "error" || !Array.isArray(data.values)) {
    throw new Error(data.message || "Twelve Data candle request failed.");
  }

  return data.values
    .map((c) => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .filter((c) =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .reverse();
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return { sent: false, error: "TELEGRAM_BOT_TOKEN is missing." };
  }
  if (!env.TELEGRAM_CHAT_ID) {
    return { sent: false, error: "TELEGRAM_CHAT_ID is missing." };
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: String(env.TELEGRAM_CHAT_ID),
        text
      })
    }
  );

  const data = await response.json();
  if (!data.ok) {
    return { sent: false, error: data.description || "Telegram send failed." };
  }
  return { sent: true, error: null };
}

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) out.push(null);
    else if (i === period - 1) out.push(prev);
    else {
      prev = values[i] * k + prev * (1 - k);
      out.push(prev);
    }
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function atr(candles, period = 14) {
  const trs = [null];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - p.close),
        Math.abs(c.low - p.close)
      )
    );
  }
  const out = Array(candles.length).fill(null);
  let count = 0;
  let sum = 0;
  for (let i = 1; i < candles.length; i++) {
    if (count < period) {
      sum += trs[i];
      count++;
      if (count === period) out[i] = sum / period;
    } else {
      out[i] = (out[i - 1] * (period - 1) + trs[i]) / period;
    }
  }
  return out;
}

function detectSignal(candles) {
  if (!candles || candles.length < 60) return null;
  const i = candles.length - 1;
  const c = candles[i];
  const closes = candles.map((x) => x.close);
  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = atr(candles, 14);
  if ([e9[i], e21[i], e50[i], r[i], a[i]].some((v) => v == null)) return null;

  let prev4High = -Infinity;
  let prev4Low = Infinity;
  for (let k = i - 4; k <= i - 1; k++) {
    if (k < 0) continue;
    prev4High = Math.max(prev4High, candles[k].high);
    prev4Low = Math.min(prev4Low, candles[k].low);
  }

  const range = c.high - c.low;
  const body = range === 0 ? 0 : Math.abs(c.close - c.open) / range;

  const longOk =
    e9[i] > e21[i] &&
    e21[i] > e50[i] &&
    r[i] > RSI_LONG &&
    c.close > prev4High &&
    c.close > e9[i] &&
    body >= BODY_MIN &&
    c.close > c.open;

  const shortOk =
    e9[i] < e21[i] &&
    e21[i] < e50[i] &&
    r[i] < RSI_SHORT &&
    c.close < prev4Low &&
    c.close < e9[i] &&
    body >= BODY_MIN &&
    c.close < c.open;

  if (!longOk && !shortOk) return null;

  const entry = c.close;
  let sl;
  let tp;
  let side;
  if (longOk) {
    sl = c.low - ATR_SL * a[i];
    const risk = Math.max(entry - sl, a[i] * 0.35);
    sl = entry - risk;
    tp = entry + RR * risk;
    side = "BUY";
  } else {
    sl = c.high + ATR_SL * a[i];
    const risk = Math.max(sl - entry, a[i] * 0.35);
    sl = entry + risk;
    tp = entry - RR * risk;
    side = "SELL";
  }

  return {
    side,
    entry: round(entry),
    sl: round(sl),
    tp: round(tp),
    time: c.time,
    rsi: round(r[i], 1),
    body: Math.round(body * 100)
  };
}

function round(n, d = 2) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}
