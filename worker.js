const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const T4F_WINDOWS = [
  { start: 8 * 60 + 3, end: 8 * 60 + 12, label: "Lagos morning window" },
  { start: 14 * 60 + 45, end: 15 * 60 + 8, label: "Lagos afternoon window" }
];
const INTERVAL_MS = { "1m": 60_000, "15m": 900_000, "1h": 3_600_000 };
const MAX_CLAIMS = 1000;
const CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function lagosClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  const window = T4F_WINDOWS.find(w => minutes >= w.start && minutes <= w.end);
  return {
    time: `${values.hour}:${values.minute}:${values.second}`,
    minutes,
    active: Boolean(window),
    label: window?.label || "T4F scan window closed"
  };
}

async function fetchYahooChart(symbol, range, interval) {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", "false");
  const response = await fetch(url.toString(), {
    headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0 XAU-AI-CHART/1.0" },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error(`Gold feed returned HTTP ${response.status} for ${symbol} ${interval}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result?.timestamp?.length) {
    throw new Error(payload?.chart?.error?.description || `No ${interval} candles returned for ${symbol}`);
  }
  const quote = result.indicators?.quote?.[0];
  if (!quote) throw new Error(`Missing candle data for ${symbol} ${interval}`);
  const intervalMs = INTERVAL_MS[interval];
  const now = Date.now();
  const candles = result.timestamp.map((seconds, i) => ({
    time: Number(seconds) * 1000,
    open: quote.open?.[i] == null ? null : Number(quote.open[i]),
    high: quote.high?.[i] == null ? null : Number(quote.high[i]),
    low: quote.low?.[i] == null ? null : Number(quote.low[i]),
    close: quote.close?.[i] == null ? null : Number(quote.close[i])
  })).filter(c =>
    Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) &&
    Number.isFinite(c.close) && c.time + intervalMs <= now - 3000
  ).sort((a, b) => a.time - b.time);
  if (!candles.length) throw new Error(`No completed ${interval} candles for ${symbol}`);
  return { symbol, candles, currency: result.meta?.currency || "USD" };
}

async function getGoldCandles() {
  const symbols = ["XAUUSD=X", "GC=F"];
  let lastError;
  for (const symbol of symbols) {
    try {
      const [m1, m15, h1] = await Promise.all([
        fetchYahooChart(symbol, "1d", "1m"),
        fetchYahooChart(symbol, "5d", "15m"),
        fetchYahooChart(symbol, "5d", "1h")
      ]);
      if (m1.candles.length < 3) throw new Error("Not enough completed M1 candles");
      if (m15.candles.length < 20) throw new Error("Not enough completed M15 candles");
      if (h1.candles.length < 50) throw new Error("Not enough completed H1 candles for EMA 50");
      return { symbol, m1: m1.candles, m15: m15.candles, h1: h1.candles, isFallback: symbol === "GC=F" };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Gold market data unavailable");
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values[0];
  for (let i = 1; i < values.length; i++) value = values[i] * multiplier + value * (1 - multiplier);
  return value;
}

function digitalRootOffset(price) {
  let value = Math.floor(Math.abs(price));
  let sum = String(value).split("").reduce((n, digit) => n + Number(digit), 0);
  while (sum > 9) sum = String(sum).split("").reduce((n, digit) => n + Number(digit), 0);
  if ([1, 4, 7].includes(sum)) return 12;
  if ([2, 5, 8].includes(sum)) return 15;
  if ([3, 6, 9].includes(sum)) return 18;
  return 12;
}

function getExtreme(candles, field) {
  let index = 0;
  for (let i = 1; i < candles.length; i++) {
    if ((field === "high" && candles[i][field] > candles[index][field]) ||
        (field === "low" && candles[i][field] < candles[index][field])) index = i;
  }
  return { value: candles[index][field], time: candles[index].time };
}

function buildSignal(data, session) {
  const { m1, m15, h1, symbol, isFallback } = data;
  const closedM15 = m15[m15.length - 1];
  const previousM1 = m1[m1.length - 2];
  const latestM1 = m1[m1.length - 1];
  const recent20 = m15.slice(-20);
  const recentHigh = getExtreme(recent20, "high");
  const recentLow = getExtreme(recent20, "low");
  const h1Closes = h1.map(c => c.close);
  const h1Ema50 = ema(h1Closes, 50);
  const h1Close = h1[h1.length - 1].close;
  const price = closedM15.close;
  const bias = closedM15.close > closedM15.open ? "SELL" : "BUY";
  const macroBull = h1Close > h1Ema50;
  const macroBear = h1Close < h1Ema50;
  const sellEntry = recentHigh.value - digitalRootOffset(recentHigh.value);
  const buyEntry = recentLow.value + digitalRootOffset(recentLow.value);
  const level = bias === "SELL" ? sellEntry : buyEntry;
  const nearLevel = Math.abs(price - level) <= 5.0;
  const macroAligned = bias === "SELL" ? macroBear : macroBull;
  const m1Confirmed = bias === "SELL"
    ? latestM1.close < previousM1.open
    : latestM1.close > previousM1.open;
  const sessionActive = session.active;
  const signalAllowed = sessionActive && !isFallback && macroAligned && nearLevel && m1Confirmed;
  let signal = "WAITING";
  let entry = null;
  let stopLoss = null;
  let takeProfit = null;
  let setupKey = null;
  let reason = "No valid T4F setup on the latest completed candles.";

  if (isFallback) reason = "Spot XAUUSD data unavailable; futures fallback is display-only, so signals are disabled.";
  else if (!sessionActive) reason = "Outside the two T4F scan windows in the supplied strategy.";
  else if (!macroAligned) reason = "H1 EMA 50 trend filter does not agree with the M15 bias.";
  else if (!nearLevel) reason = "M15 close is more than $5 from the calculated entry level.";
  else if (!m1Confirmed) reason = "M1 candle confirmation is not present yet.";
  else if (signalAllowed) {
    signal = bias;
    entry = level;
    if (bias === "SELL") {
      stopLoss = recentHigh.value + 1.50;
      const risk = stopLoss - entry;
      if (!(risk > 0)) return waitingResult(data, session, "Invalid SELL stop distance; no signal issued.");
      takeProfit = entry - risk * 3;
      setupKey = `T4F|SELL|${recentHigh.time}|${entry.toFixed(2)}|${stopLoss.toFixed(2)}`;
    } else {
      stopLoss = recentLow.value - 1.50;
      const risk = entry - stopLoss;
      if (!(risk > 0)) return waitingResult(data, session, "Invalid BUY stop distance; no signal issued.");
      takeProfit = entry + risk * 3;
      setupKey = `T4F|BUY|${recentLow.time}|${entry.toFixed(2)}|${stopLoss.toFixed(2)}`;
    }
    reason = "All T4F conditions confirmed on completed candles.";
  }

  return {
    signal,
    entry: round2(entry),
    stopLoss: round2(stopLoss),
    takeProfit: round2(takeProfit),
    riskReward: signal === "WAITING" ? null : 3,
    candleTime: new Date(closedM15.time).toISOString(),
    setupKey,
    reason,
    checks: {
      sessionOpen: sessionActive,
      h1Trend: macroBull ? "BULLISH" : macroBear ? "BEARISH" : "NEUTRAL",
      macroAligned,
      m15Bias: bias,
      m15BullishCandle: closedM15.close > closedM15.open,
      levelNearby: nearLevel,
      m1Confirmation: m1Confirmed,
      candleClose: true,
      digitalRoot: digitalRootOffset(bias === "SELL" ? recentHigh.value : recentLow.value),
      swingHigh: round2(recentHigh.value),
      swingLow: round2(recentLow.value),
      priceDistance: round2(Math.abs(price - level)),
      h1Close: round2(h1Close),
      h1Ema50: round2(h1Ema50),
      sessionLabel: session.label
    },
    price: round2(latestM1.close),
    strategyPrice: round2(price),
    sourceSymbol: symbol,
    isFallback,
    updatedAt: new Date().toISOString()
  };
}

function waitingResult(data, session, reason) {
  const lastM1 = data.m1[data.m1.length - 1];
  return {
    signal: "WAITING", entry: null, stopLoss: null, takeProfit: null,
    riskReward: null, candleTime: new Date(data.m15[data.m15.length - 1].time).toISOString(),
    setupKey: null, reason,
    checks: { sessionOpen: session.active, h1Trend: "UNKNOWN", macroAligned: false,
      m15Bias: "UNKNOWN", m15BullishCandle: false, levelNearby: false,
      m1Confirmation: false, candleClose: true, digitalRoot: null,
      swingHigh: null, swingLow: null, sessionLabel: session.label },
    price: round2(lastM1.close), sourceSymbol: data.symbol, isFallback: data.isFallback,
    updatedAt: new Date().toISOString()
  };
}

function round2(value) { return Number.isFinite(value) ? Math.round(value * 100) / 100 : null; }

async function getLockStub(env) {
  if (!env.XAU_SETUP_LOCK) return null;
  const id = env.XAU_SETUP_LOCK.idFromName("xau-ai-chart-global-lock");
  return env.XAU_SETUP_LOCK.get(id);
}

async function claimUnique(env, key) {
  const stub = await getLockStub(env);
  if (!stub) return { claimed: true, persistent: false };
  const res = await stub.fetch("https://lock/claim", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key })
  });
  if (!res.ok) throw new Error("Unable to verify duplicate-signal lock");
  return res.json();
}

async function releaseUnique(env, key) {
  const stub = await getLockStub(env);
  if (!stub) return;
  await stub.fetch("https://lock/release", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key })
  });
}

async function sha256(text) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}

async function sendTelegram(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, status: "NOT_CONFIGURED" };
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.description || `Telegram HTTP ${response.status}`);
  return { sent: true, status: "SENT" };
}

function telegramSignalText(signal) {
  return [
    "<b>XAU AI CHART</b>",
    `<b>T4F TRAP &amp; LIMIT â ${signal.signal}</b>`,
    "Symbol: XAUUSD",
    `Entry: <code>${signal.entry.toFixed(2)}</code>`,
    `SL: <code>${signal.stopLoss.toFixed(2)}</code>`,
    `TP: <code>${signal.takeProfit.toFixed(2)}</code>`,
    "Risk : Reward: 1:3",
    "Setup: M15 levels + H1 EMA 50 + M1 confirmation",
    `Closed M15 candle: ${signal.candleTime}`,
    `Setup ID: <code>${signal.setupKey}</code>`
  ].join("\n");
}

async function scanApi(env) {
  const session = lagosClock();
  const data = await getGoldCandles();
  const result = buildSignal(data, session);
  let telegram = { sent: false, status: "NO_NEW_SIGNAL" };

  if (result.signal !== "WAITING" && result.setupKey) {
    const tokenReady = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
    if (tokenReady) {
      const claim = await claimUnique(env, result.setupKey);
      if (claim.claimed) {
        try {
          telegram = await sendTelegram(env, telegramSignalText(result));
        } catch (error) {
          await releaseUnique(env, result.setupKey).catch(() => {});
          telegram = { sent: false, status: "SEND_FAILED", error: errorText(error) };
        }
      } else {
        telegram = { sent: false, status: "DUPLICATE_SUPPRESSED" };
      }
    } else {
      telegram = { sent: false, status: "NOT_CONFIGURED" };
    }
  }

  return {
    ok: true,
    price: result.price,
    sourceSymbol: result.sourceSymbol,
    fallbackFeed: result.isFallback,
    session,
    signal: result,
    telegram,
    updatedAt: result.updatedAt
  };
}

async function handleWebhook(request, env) {
  const text = await request.text();
  if (!text.trim()) return json({ ok: false, error: "Empty signal body" }, 400);
  const key = `WEBHOOK|${await sha256(text.trim())}`;
  const tokenReady = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);
  if (!tokenReady) return json({ ok: false, error: "Telegram secrets are not configured" }, 503);
  const claim = await claimUnique(env, key);
  if (!claim.claimed) return json({ ok: true, duplicate: true, message: "Duplicate signal suppressed" });
  try {
    const result = await sendTelegram(env, text);
    return json({ ok: true, ...result });
  } catch (error) {
    await releaseUnique(env, key).catch(() => {});
    return json({ ok: false, error: errorText(error) }, 502);
  }
}

export class XAUSetupLock {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
    const body = await request.json().catch(() => ({}));
    if (typeof body.key !== "string" || !body.key) return json({ ok: false, error: "Missing key" }, 400);
    if (url.pathname === "/claim") {
      const result = await this.ctx.storage.transaction(async txn => {
        const now = Date.now();
        const stored = await txn.get("claimed_signals") || [];
        const live = stored.filter(item => now - item.at < CLAIM_TTL_MS);
        if (live.some(item => item.key === body.key)) {
          if (live.length !== stored.length) await txn.put("claimed_signals", live);
          return false;
        }
        live.push({ key: body.key, at: now });
        const bounded = live.slice(-MAX_CLAIMS);
        await txn.put("claimed_signals", bounded);
        return true;
      });
      return json({ ok: true, claimed: result });
    }
    if (url.pathname === "/release") {
      await this.ctx.storage.transaction(async txn => {
        const stored = await txn.get("claimed_signals") || [];
        await txn.put("claimed_signals", stored.filter(item => item.key !== body.key));
      });
      return json({ ok: true, released: true });
    }
    return json({ ok: false, error: "Not found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "XAU AI CHART", strategy: "T4F Trap & Limit", symbol: "XAUUSD", time: lagosClock() });
    }
    if (url.pathname === "/api/gold" && request.method === "GET") {
      try {
        const market = await fetchYahooChart("XAUUSD=X", "1d", "1m").catch(() => fetchYahooChart("GC=F", "1d", "1m"));
        const last = market.candles[market.candles.length - 1];
        return json({ ok: true, price: round2(last.close), sourceSymbol: market.symbol, updatedAt: new Date(last.time).toISOString(), fetchedAt: new Date().toISOString() });
      } catch (error) {
        return json({ ok: false, error: errorText(error) }, 502);
      }
    }
    if (url.pathname === "/api/scan" && request.method === "GET") {
      try { return json(await scanApi(env)); }
      catch (error) { return json({ ok: false, error: errorText(error) }, 502); }
    }
    if (request.method === "POST") return handleWebhook(request, env);

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("XAU AI CHART Worker is running", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
};
