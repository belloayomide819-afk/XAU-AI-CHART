const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const T4F_WINDOWS = [
  { start: 8 * 60 + 3, end: 8 * 60 + 12, label: "London Window" },
  { start: 14 * 60 + 45, end: 15 * 60 + 8, label: "New York Window" }
];

const INTERVAL_MS = { "1min": 60_000, "15min": 900_000, "1h": 3_600_000 };
const MAX_CLAIMS = 1000;
const CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const TWELVE_DATA_CACHE = new Map();

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function lagosClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  const window = T4F_WINDOWS.find(item => minutes >= item.start && minutes <= item.end);
  return {
    time: `${values.hour}:${values.minute}:${values.second}`,
    minutes,
    active: Boolean(window),
    label: window?.label || "Scan Window Closed"
  };
}

async function fetchTwelveDataCandles(env, interval, outputsize) {
  const apiKey = env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error("TWELVE_DATA_API_KEY missing.");

  const intervalMs = INTERVAL_MS[interval];
  const now = Date.now();
  const cacheKey = `${interval}:${outputsize}`;
  const cached = TWELVE_DATA_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  const url = new URL("https://api.twelvedata.com/time_series");
  url.searchParams.set("symbol", "XAU/USD");
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", String(outputsize));
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url.toString(), {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000)
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !Array.isArray(payload.values)) {
    throw new Error(`Twelve Data error: ${payload.message || payload.code || response.status}`);
  }

  const candles = payload.values.map(row => {
    const datetime = String(row.datetime || "").replace(" ", "T");
    const time = Date.parse(datetime.endsWith("Z") ? datetime : `${datetime}Z`);
    return {
      time,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close)
    };
  }).filter(candle =>
    Number.isFinite(candle.time) && Number.isFinite(candle.close) &&
    candle.time + intervalMs <= Date.now() - 3000
  ).sort((a, b) => a.time - b.time);

  const value = { symbol: payload.meta?.symbol || "XAU/USD", candles };
  const nextBoundary = (Math.floor(Date.now() / intervalMs) + 1) * intervalMs;
  TWELVE_DATA_CACHE.set(cacheKey, { value, expiresAt: nextBoundary + 3000 });
  return value;
}

async function getGoldCandles(env) {
  const [m1, m15, h1] = await Promise.all([
    fetchTwelveDataCandles(env, "1min", 500),
    fetchTwelveDataCandles(env, "15min", 150),
    fetchTwelveDataCandles(env, "1h", 100)
  ]);
  return { m1: m1.candles, m15: m15.candles, h1: h1.candles };
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
  let sum = String(value).split("").reduce((total, digit) => total + Number(digit), 0);
  while (sum > 9) sum = String(sum).split("").reduce((total, digit) => total + Number(digit), 0);
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

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function buildSignal(data, session) {
  const { m1, m15, h1 } = data;
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

  // T4F Logic
  const bias = closedM15.close > closedM15.open ? "SELL" : "BUY";
  const macroBull = h1Close > h1Ema50;
  const macroBear = h1Close < h1Ema50;
  
  const sellEntry = recentHigh.value - digitalRootOffset(recentHigh.value);
  const buyEntry = recentLow.value + digitalRootOffset(recentLow.value);
  const level = bias === "SELL" ? sellEntry : buyEntry;
  
  const nearLevel = Math.abs(price - level) <= 5.0;
  const macroAligned = bias === "SELL" ? macroBear : macroBull;
  const m1Confirmed = bias === "SELL" ? latestM1.close < previousM1.open : latestM1.close > previousM1.open;
  
  const signalAllowed = session.active && macroAligned && nearLevel && m1Confirmed;

  let signal = "WAITING";
  let entry = null, stopLoss = null, takeProfit = null, setupKey = null, reason = "No valid T4F setup.";

  if (!session.active) {
    reason = "Outside T4F windows (08:03-08:12 or 14:45-15:08).";
  } else if (!macroAligned) {
    reason = "H1 EMA 50 trend filter does not agree with M15 bias.";
  } else if (!nearLevel) {
    reason = "Price is >$5 away from the 369 level.";
  } else if (!m1Confirmed) {
    reason = "Awaiting 1M candle confirmation.";
  } else if (signalAllowed) {
    signal = bias;
    entry = level;

    if (bias === "SELL") {
      stopLoss = recentHigh.value + 1.50;
      const risk = stopLoss - entry;
      takeProfit = entry - risk * 3;
      setupKey = `T4F|SELL|${recentHigh.time}|${entry.toFixed(2)}|${stopLoss.toFixed(2)}`;
    } else {
      stopLoss = recentLow.value - 1.50;
      const risk = entry - stopLoss;
      takeProfit = entry + risk * 3;
      setupKey = `T4F|BUY|${recentLow.time}|${entry.toFixed(2)}|${stopLoss.toFixed(2)}`;
    }
    reason = "All T4F conditions confirmed.";
  }

  return {
    signal,
    entry: round2(entry),
    stopLoss: round2(stopLoss),
    takeProfit: round2(takeProfit),
    setupKey,
    reason,
    candleTime: new Date(closedM15.time).toISOString(),
  };
}

async function claimUnique(env, key) {
  if (!env.XAU_SETUP_LOCK) return { claimed: true };
  const id = env.XAU_SETUP_LOCK.idFromName("xau-global-lock");
  const stub = env.XAU_SETUP_LOCK.get(id);
  const response = await stub.fetch("https://lock/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key })
  });
  return response.json();
}

async function sendTelegram(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, status: "NOT_CONFIGURED" };

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.description);
  return { sent: true, status: "SENT" };
}

function telegramSignalText(signal) {
  return [
    `<b>⚜️ T4F GOLD TERMINAL ⚜️</b>`,
    `<b>${signal.signal} LIMIT ORDER</b>`,
    ``,
    `Pair: XAUUSD`,
    `Entry: <code>${signal.entry.toFixed(2)}</code>`,
    `SL: <code>${signal.stopLoss.toFixed(2)}</code>`,
    `TP: <code>${signal.takeProfit.toFixed(2)}</code>`,
    `R:R Ratio: 1:3`,
    ``,
    `<b>Execution:</b>`,
    `🟩 Standard: 0.01 Lots`,
    `🟨 Cent: 1.00 Lots`,
    ``,
    `Setup: 369 Math + Trap SL`,
    `Time: ${signal.candleTime}`
  ].join("\n");
}

async function scanApi(env) {
  const session = lagosClock();
  const data = await getGoldCandles(env);
  const result = buildSignal(data, session);
  let telegram = { sent: false, status: "NO_NEW_SIGNAL" };

  if (result.signal !== "WAITING" && result.setupKey) {
    const claim = await claimUnique(env, result.setupKey);
    if (claim.claimed) {
      try {
        telegram = await sendTelegram(env, telegramSignalText(result));
      } catch (e) {
        telegram = { sent: false, status: "FAILED" };
      }
    } else {
      telegram = { sent: false, status: "DUPLICATE_SUPPRESSED" };
    }
  }

  return {
    ok: true,
    price: round2(data.m1[data.m1.length - 1].close),
    session,
    signal: result,
    telegram,
  };
}

export class XAUSetupLock {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));
    if (url.pathname === "/claim") {
      const claimed = await this.ctx.storage.transaction(async tx => {
        const now = Date.now();
        const stored = await tx.get("claimed_signals") || [];
        const live = stored.filter(item => now - item.at < CLAIM_TTL_MS);
        if (live.some(item => item.key === body.key)) return false;
        live.push({ key: body.key, at: now });
        await tx.put("claimed_signals", live.slice(-MAX_CLAIMS));
        return true;
      });
      return json({ ok: true, claimed });
    }
    return json({ ok: false }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

    if (url.pathname === "/api/scan" && request.method === "GET") {
      try {
        return json(await scanApi(env));
      } catch (error) {
        return json({ ok: false, error: errorText(error) }, 502);
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Worker is running", { status: 200 });
  }
};
