const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const T4F_WINDOWS = [
  { start: 8 * 60 + 3, end: 8 * 60 + 12, label: "London Window", next: "14:45 WAT" },
  { start: 14 * 60 + 45, end: 15 * 60 + 8, label: "New York Window", next: "08:03 WAT (Tomorrow)" }
];

const INTERVAL_MS = { "1min": 60_000, "5min": 300_000, "15min": 900_000, "1h": 3_600_000 };
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
    timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  const window = T4F_WINDOWS.find(item => minutes >= item.start && minutes <= item.end);
  
  let nextTime = "08:03 WAT (Tomorrow)";
  if (minutes < T4F_WINDOWS[0].start) nextTime = "08:03 WAT";
  else if (minutes > T4F_WINDOWS[0].end && minutes < T4F_WINDOWS[1].start) nextTime = "14:45 WAT";

  return {
    time: `${values.hour}:${values.minute}:${values.second}`,
    minutes,
    active: Boolean(window),
    label: window?.label || "Scan Window Closed",
    nextTime: window ? window.next : nextTime
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

  const response = await fetch(url.toString(), { headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !Array.isArray(payload.values)) {
    throw new Error(`Twelve Data error: ${payload.message || payload.code || response.status}`);
  }

  const candles = payload.values.map(row => {
    const datetime = String(row.datetime || "").replace(" ", "T");
    const time = Date.parse(datetime.endsWith("Z") ? datetime : `${datetime}Z`);
    return { time, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) };
  }).filter(candle =>
    Number.isFinite(candle.time) && Number.isFinite(candle.close) && candle.time + intervalMs <= Date.now() - 3000
  ).sort((a, b) => a.time - b.time);

  const value = { symbol: payload.meta?.symbol || "XAU/USD", candles };
  const nextBoundary = (Math.floor(Date.now() / intervalMs) + 1) * intervalMs;
  TWELVE_DATA_CACHE.set(cacheKey, { value, expiresAt: nextBoundary + 3000 });
  return value;
}

async function getGoldCandles(env) {
  const [m1, m5, m15, h1] = await Promise.all([
    fetchTwelveDataCandles(env, "1min", 500),
    fetchTwelveDataCandles(env, "5min", 500),
    fetchTwelveDataCandles(env, "15min", 150),
    fetchTwelveDataCandles(env, "1h", 100)
  ]);
  return { m1: m1.candles, m5: m5.candles, m15: m15.candles, h1: h1.candles };
}

function ema(values, period) {
  if (values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let value = values[0];
  for (let i = 1; i < values.length; i++) value = values[i] * multiplier + value * (1 - multiplier);
  return value;
}

function atr(candles, period) {
  if (candles.length < period) return 1.0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(candles[i].high - candles[i].low, Math.abs(candles[i].high - candles[i-1].close), Math.abs(candles[i].low - candles[i-1].close));
    sum += tr;
  }
  return sum / period;
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
    if ((field === "high" && candles[i][field] > candles[index][field]) || (field === "low" && candles[i][field] < candles[index][field])) index = i;
  }
  return { value: candles[index][field], time: candles[index].time };
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function buildT4FSignal(data, session) {
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
  const isReady = session.active && macroAligned && nearLevel && !m1Confirmed;

  let signal = "WAITING", entry = null, stopLoss = null, tp1 = null, tp2 = null, tp3 = null, setupKey = null, reason = "No setup.";

  if (!session.active) reason = "Outside T4F windows.";
  else if (!macroAligned) reason = "H1 EMA 50 trend filter does not agree.";
  else if (!nearLevel) reason = "Price >$5 away from level.";
  else if (!m1Confirmed) reason = "Awaiting 1M confirmation.";
  else if (signalAllowed) {
    signal = bias; entry = level;
    if (bias === "SELL") {
      stopLoss = recentHigh.value + 1.50; const risk = stopLoss - entry;
      tp1 = entry - risk; tp2 = entry - (risk * 2); tp3 = entry - (risk * 3);
      setupKey = `T4F|SELL|${recentHigh.time}|${entry.toFixed(2)}`;
    } else {
      stopLoss = recentLow.value - 1.50; const risk = entry - stopLoss;
      tp1 = entry + risk; tp2 = entry + (risk * 2); tp3 = entry + (risk * 3);
      setupKey = `T4F|BUY|${recentLow.time}|${entry.toFixed(2)}`;
    }
    reason = "T4F conditions met.";
  }
  return { engine: "1 (T4F SNIPER)", signal, entry: round2(entry), stopLoss: round2(stopLoss), tp1: round2(tp1), tp2: round2(tp2), tp3: round2(tp3), setupKey, reason, isReady };
}

function buildAsiaSweepSignal(data) {
  const { m15 } = data;
  let asiaHigh = -Infinity, asiaLow = Infinity, asiaFound = false;
  for (let i = m15.length - 1; i >= m15.length - 80; i--) {
    const candleTime = new Date(m15[i].time);
    const utcHour = candleTime.getUTCHours();
    if (utcHour >= 0 && utcHour < 9) {
      asiaHigh = Math.max(asiaHigh, m15[i].high);
      asiaLow = Math.min(asiaLow, m15[i].low);
      asiaFound = true;
    } else if (asiaFound) break;
  }
  if (!asiaFound) return { engine: "2 (ASIA SWEEP)", signal: "WAITING", reason: "No Asia session found.", isReady: false };

  const currentCandle = m15[m15.length - 1];
  const prevCandle = m15[m15.length - 2];
  const closes = m15.map(c => c.close);
  const ema200 = ema(closes, 200);
  const isBullishTrend = currentCandle.close > ema200;

  let signal = "WAITING", entry = null, stopLoss = null, tp1 = null, tp2 = null, tp3 = null, setupKey = null, reason = "Waiting for Asia Sweep.";
  let isReady = false;

  if (currentCandle.high > asiaHigh && currentCandle.close < asiaHigh && !isBullishTrend && currentCandle.close >= prevCandle.low) {
      isReady = true;
      reason = "Asia High Swept. Awaiting CHoCH.";
  }
  if (currentCandle.low < asiaLow && currentCandle.close > asiaLow && isBullishTrend && currentCandle.close <= prevCandle.high) {
      isReady = true;
      reason = "Asia Low Swept. Awaiting CHoCH.";
  }

  if (currentCandle.high > asiaHigh && currentCandle.close < asiaHigh && !isBullishTrend && currentCandle.close < prevCandle.low) {
    signal = "SELL"; entry = currentCandle.close; stopLoss = currentCandle.high + 0.5;
    const risk = stopLoss - entry; tp1 = entry - risk; tp2 = entry - (risk * 1.5); tp3 = asiaLow;
    setupKey = `ASIA|SELL|${currentCandle.time}`; reason = "Asia High Swept + CHoCH.";
    isReady = false;
  }
  if (currentCandle.low < asiaLow && currentCandle.close > asiaLow && isBullishTrend && currentCandle.close > prevCandle.high) {
    signal = "BUY"; entry = currentCandle.close; stopLoss = currentCandle.low - 0.5;
    const risk = entry - stopLoss; tp1 = entry + risk; tp2 = entry + (risk * 1.5); tp3 = asiaHigh;
    setupKey = `ASIA|BUY|${currentCandle.time}`; reason = "Asia Low Swept + CHoCH.";
    isReady = false;
  }
  return { engine: "2 (ASIA SWEEP)", signal, entry: round2(entry), stopLoss: round2(stopLoss), tp1: round2(tp1), tp2: round2(tp2), tp3: round2(tp3), setupKey, reason, isReady };
}

function buildScalperSignal(data) {
  const { m5 } = data;
  const closes = m5.map(c => c.close);
  const ema50 = ema(closes, 50);
  const currentAtr = atr(m5, 14);
  const currentCandle = m5[m5.length - 1];
  
  let gains = 0, losses = 0;
  for (let i = closes.length - 14; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const rs = gains / (losses || 1);
  const rsi = 100 - (100 / (1 + rs));
  
  const prevCandle = m5[m5.length - 2];
  const prevDiff = closes[closes.length - 2] - closes[closes.length - 3];
  const prevRsi = 100 - (100 / (1 + ((gains - (prevDiff > 0 ? prevDiff : 0)) / ((losses + (prevDiff < 0 ? prevDiff : 0)) || 1))));

  let signal = "WAITING", entry = null, stopLoss = null, tp1 = null, tp2 = null, tp3 = null, setupKey = null, reason = "No Scalper setup.";
  let isReady = false;

  const slDistance = currentAtr * 1.5; 
  const bodySize = Math.abs(currentCandle.close - currentCandle.open);
  const distanceToEma = Math.abs(currentCandle.close - ema50);
  
  const rules = { rsiCross: false, momentum: false, location: false };

  if (prevRsi <= 50 && rsi > 50 && currentCandle.close > ema50) {
    rules.rsiCross = true;
    if (bodySize > (currentAtr * 0.5)) rules.momentum = true;
    if (distanceToEma < (currentAtr * 2.0)) rules.location = true;
    
    if (rules.momentum && rules.location) {
      signal = "BUY"; entry = currentCandle.close; stopLoss = entry - slDistance;
      tp1 = entry + (slDistance * 0.5); tp2 = entry + (slDistance * 1.0); tp3 = entry + (slDistance * 2.0);
      setupKey = `SCALP|BUY|${currentCandle.time}`; reason = "M5 RSI Cross Up + Momentum + Tight Location.";
    } else {
      isReady = true;
      reason = "M5 RSI Crossed Up. Awaiting Momentum/Location.";
    }
  }
  
  if (prevRsi >= 50 && rsi < 50 && currentCandle.close < ema50) {
    rules.rsiCross = true;
    if (bodySize > (currentAtr * 0.5)) rules.momentum = true;
    if (distanceToEma < (currentAtr * 2.0)) rules.location = true;
    
    if (rules.momentum && rules.location) {
      signal = "SELL"; entry = currentCandle.close; stopLoss = entry + slDistance;
      tp1 = entry - (slDistance * 0.5); tp2 = entry - (slDistance * 1.0); tp3 = entry - (slDistance * 2.0);
      setupKey = `SCALP|SELL|${currentCandle.time}`; reason = "M5 RSI Cross Down + Momentum + Tight Location.";
    } else {
      isReady = true;
      reason = "M5 RSI Crossed Down. Awaiting Momentum/Location.";
    }
  }
  
  return { engine: "3 (M5 SCALPER)", signal, entry: round2(entry), stopLoss: round2(stopLoss), tp1: round2(tp1), tp2: round2(tp2), tp3: round2(tp3), setupKey, reason, rules, isReady };
}

async function sendTelegram(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, status: "NOT_CONFIGURED" };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
  });
  const payload = await res.json();
  return { sent: true, status: "SENT", response: payload };
}

async function checkActiveTrades(env, currentPrice) {
  if (!env.XAU_SETUP_LOCK) return;
  const id = env.XAU_SETUP_LOCK.idFromName("xau-global-lock");
  const stub = env.XAU_SETUP_LOCK.get(id);
  const response = await stub.fetch("https://lock/check_trades", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ price: currentPrice })
  });
  const data = await response.json();
  if (data.messages && data.messages.length > 0) {
    for (const msg of data.messages) await sendTelegram(env, msg);
  }
}

async function registerTrade(env, signal) {
  if (!env.XAU_SETUP_LOCK) return;
  const id = env.XAU_SETUP_LOCK.idFromName("xau-global-lock");
  const stub = env.XAU_SETUP_LOCK.get(id);
  await stub.fetch("https://lock/register_trade", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(signal)
  });
}

function telegramText(signal) {
  return [
    `<b>⚜️ TWIN ENGINE BOT ⚜️</b>`,
    `<b>[${signal.engine}]</b>`,
    `<b>${signal.signal} LIMIT ORDER</b>`,
    ``,
    `Pair: XAUUSD`,
    `Entry: <code>${signal.entry.toFixed(2)}</code>`,
    `SL: <code>${signal.stopLoss.toFixed(2)}</code>`,
    `TP1: <code>${signal.tp1.toFixed(2)}</code>`,
    `TP2: <code>${signal.tp2.toFixed(2)}</code>`,
    `TP3: <code>${signal.tp3.toFixed(2)}</code>`,
    ``,
    `<b>Execution:</b>`,
    `🟩 Standard: 0.01 Lots`,
    `🟨 Cent: 1.00 Lots`,
    `🎯 <b>When TP1 hits, move SL to Breakeven (BE).</b>`
  ].join("\n");
}

async function scanApi(env) {
  const session = lagosClock();
  const data = await getGoldCandles(env);
  const currentPrice = data.m1[data.m1.length - 1].close;
  
  await checkActiveTrades(env, currentPrice);

  const id = env.XAU_SETUP_LOCK.idFromName("xau-global-lock");
  const stub = env.XAU_SETUP_LOCK.get(id);
  
  const statusRes = await stub.fetch("https://lock/check_session_status", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: session.active, nextTime: session.nextTime })
  });
  const statusData = await statusRes.json();
  
  if (statusData.action === "OPENED") {
    await sendTelegram(env, `🟢 <b>T4F WINDOW OPEN</b>\nBot is actively scanning XAUUSD.`);
  } else if (statusData.action === "EXPIRED") {
    await sendTelegram(env, `🔴 <b>T4F WINDOW CLOSED</b>\nNo valid setup found. Wait until ${session.nextTime}.`);
  }

  const t4fResult = buildT4FSignal(data, session);
  const asiaResult = buildAsiaSweepSignal(data);
  const scalperResult = buildScalperSignal(data); 
  
  const results = [t4fResult, asiaResult, scalperResult];
  const alertsSent = [];

  for (const res of results) {
    if (res.signal !== "WAITING" && res.setupKey) {
      const claimRes = await stub.fetch("https://lock/claim", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: res.setupKey })
      });
      const claim = await claimRes.json();

      if (claim.claimed) {
        try {
          await sendTelegram(env, telegramText(res));
          await registerTrade(env, res);
          alertsSent.push({ engine: res.engine, status: "SENT" });
        } catch (e) {
          alertsSent.push({ engine: res.engine, status: "FAILED", error: errorText(e) });
        }
      }
    } else if (res.isReady) {
      const readyKey = `READY|${res.engine}|${res.reason}`;
      const claimRes = await stub.fetch("https://lock/claim", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: readyKey })
      });
      const claim = await claimRes.json();
      
      if (claim.claimed) {
        await sendTelegram(env, `⚠️ <b>[${res.engine}] GET READY</b>\n\n${res.reason}\n\nOpen MT5 and prepare your order. Waiting for final confirmation...`);
      }
    }
  }

  return { ok: true, price: round2(currentPrice), session, engines: { t4f: t4fResult, asia: asiaResult, scalper: scalperResult }, telegram: alertsSent };
}

export class XAUSetupLock {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));

    if (url.pathname === "/check_session_status") {
      const result = await this.ctx.storage.transaction(async tx => {
        const lastActive = await tx.get("last_session_active") || false;
        if (body.active && !lastActive) {
          await tx.put("last_session_active", true);
          return { action: "OPENED" };
        }
        if (!body.active && lastActive) {
          await tx.put("last_session_active", false);
          return { action: "EXPIRED" };
        }
        return { action: "NONE" };
      });
      return json(result);
    }

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

    if (url.pathname === "/register_trade") {
      await this.ctx.storage.transaction(async tx => {
        const trades = await tx.get("active_trades") || [];
        trades.push({ ...body, tp1Hit: false, tp2Hit: false, tp3Hit: false, closed: false });
        await tx.put("active_trades", trades);
      });
      return json({ ok: true });
    }

    if (url.pathname === "/check_trades") {
      const price = body.price;
      const messages = [];

      await this.ctx.storage.transaction(async tx => {
        let trades = await tx.get("active_trades") || [];
        for (let i = 0; i < trades.length; i++) {
          let t = trades[i];
          if (t.closed) continue;

          let hitSL = false;
          if (t.signal === "BUY" && price <= t.stopLoss) hitSL = true;
          if (t.signal === "SELL" && price >= t.stopLoss) hitSL = true;
          
          if (hitSL) {
            messages.push(`❌ <b>SL HIT</b> on ${t.engine} ${t.signal}. Trade Closed.`);
            trades[i].closed = true;
            continue;
          }

          if (t.signal === "BUY") {
            if (!t.tp1Hit && price >= t.tp1) { t.tp1Hit = true; messages.push(`✅ <b>TP1 HIT</b> on ${t.engine} ${t.signal} @ ${t.tp1}.\n👉 <b>MOVE SL TO BREAKEVEN NOW.</b>`); }
            if (!t.tp2Hit && price >= t.tp2) { t.tp2Hit = true; messages.push(`✅ <b>TP2 HIT</b> on ${t.engine} ${t.signal} @ ${t.tp2}. Secure profits!`); }
            if (!t.tp3Hit && price >= t.tp3) { t.tp3Hit = true; t.closed = true; messages.push(`🏆 <b>TP3 HIT</b> on ${t.engine} ${t.signal} @ ${t.tp3}.\n👉 <b>TAKE ALL PROFIT. CLOSE TRADE.</b>`); }
          } else if (t.signal === "SELL") {
            if (!t.tp1Hit && price <= t.tp1) { t.tp1Hit = true; messages.push(`✅ <b>TP1 HIT</b> on ${t.engine} ${t.signal} @ ${t.tp1}.\n👉 <b>MOVE SL TO BREAKEVEN NOW.</b>`); }
            if (!t.tp2Hit && price <= t.tp2) { t.tp2Hit = true; messages.push(`✅ <b>TP2 HIT</b> on ${t.engine} ${t.signal} @ ${t.tp2}. Secure profits!`); }
            if (!t.tp3Hit && price <= t.tp3) { t.tp3Hit = true; t.closed = true; messages.push(`🏆 <b>TP3 HIT</b> on ${t.engine} ${t.signal} @ ${t.tp3}.\n👉 <b>TAKE ALL PROFIT. CLOSE TRADE.</b>`); }
          }
        }
        trades = trades.filter(t => !t.closed);
        await tx.put("active_trades", trades);
      });

      return json({ ok: true, messages });
    }

    return json({ ok: false }, 404);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

    // --- NEW TEST TELEGRAM ROUTE ---
    if (url.pathname === "/api/test-telegram" && request.method === "GET") {
        try {
            const result = await sendTelegram(env, `🧪 <b>TEST MESSAGE</b>\n\nIf you see this, your Telegram Bot Token and Chat ID are 100% correct and working!`);
            return json({ ok: true, telegram: result });
        } catch (error) {
            return json({ ok: false, error: errorText(error) }, 502);
        }
    }

    if (url.pathname === "/api/scan" && request.method === "GET") {
      try {
        return json(await scanApi(env));
      } catch (error) {
        return json({ ok: false, error: errorText(error) }, 502);
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Twin Engine Worker is running", { status: 200 });
  }
};
