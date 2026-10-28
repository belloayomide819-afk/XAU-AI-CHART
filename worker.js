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
const TWELVE_DATA_CACHE = new Map();
const SENT_SIGNALS = new Set();

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
  return { engine: "1 (T4F SNIPER)", signal, entry: round2(entry), stopLoss: round2(stopLoss), tp1: round2(tp1), tp2: round2(tp2), tp3: round2(tp3), setupKey, reason };
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
  if (!asiaFound) return { engine: "2 (ASIA SWEEP)", signal: "WAITING", reason: "No Asia session found." };

  const currentCandle = m15[m15.length - 1];
  const prevCandle = m15[m15.length - 2];
  const closes = m15.map(c => c.close);
  const ema200 = ema(closes, 200);
  const isBullishTrend = currentCandle.close > ema200;

  let signal = "WAITING", entry = null, stopLoss = null, tp1 = null, tp2 = null, tp3 = null, setupKey = null, reason = "Waiting for Asia Sweep.";

  if (currentCandle.high > asiaHigh && currentCandle.close < asiaHigh && !isBullishTrend) {
    if (currentCandle.close < prevCandle.low) {
      signal = "SELL"; entry = currentCandle.close; stopLoss = currentCandle.high + 0.5;
      const risk = stopLoss - entry; tp1 = entry - risk; tp2 = entry - (risk * 1.5); tp3 = asiaLow;
      setupKey = `ASIA|SELL|${currentCandle.time}`; reason = "Asia High Swept + CHoCH.";
    }
  }
  if (currentCandle.low < asiaLow && currentCandle.close > asiaLow && isBullishTrend) {
    if (currentCandle.close > prevCandle.high) {
      signal = "BUY"; entry = currentCandle.close; stopLoss = currentCandle.low - 0.5;
      const risk = entry - stopLoss; tp1 = entry + risk; tp2 = entry + (risk * 1.5); tp3 = asiaHigh;
      setupKey = `ASIA|BUY|${currentCandle.time}`; reason = "Asia Low Swept + CHoCH.";
    }
  }
  return { engine: "2 (ASIA SWEEP)", signal, entry: round2(entry), stopLoss: round2(stopLoss), tp1: round2(tp1), tp2: round2(tp2), tp3: round2(tp3), setupKey, reason };
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
    }
  }
  return { engine: "3 (M5 SCALPER)", signal, entry: round2(entry), stopLoss: round2(stopLoss), tp1: round2(tp1), tp2: round2(tp2), tp3: round2(tp3), setupKey, reason, rules };
}

async function sendTelegram(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { sent: false, status: "NOT_CONFIGURED" };
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true })
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
  
  const t4fResult = buildT4FSignal(data, session);
  const asiaResult = buildAsiaSweepSignal(data);
  const scalperResult = buildScalperSignal(data); 
  
  const results = [t4fResult, asiaResult, scalperResult];
  const alertsSent = [];

  for (const res of results) {
    if (res.signal !== "WAITING" && res.setupKey) {
      if (!SENT_SIGNALS.has(res.setupKey)) {
        SENT_SIGNALS.add(res.setupKey);
        try {
          await sendTelegram(env, telegramText(res));
          alertsSent.push({ engine: res.engine, status: "SENT" });
        } catch (e) {
          alertsSent.push({ engine: res.engine, status: "FAILED" });
        }
      }
    }
  }

  return { ok: true, price: round2(currentPrice), session, engines: { t4f: t4fResult, asia: asiaResult, scalper: scalperResult }, telegram: alertsSent };
}

const HTML_CONTENT = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>XAU AI CHART - Triple Engine</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700&display=swap');
        body { font-family: 'Inter', sans-serif; background-color: #0B0E14; color: #FAFAFA; margin: 0; padding: 16px; padding-bottom: 50px; }
        .mono { font-family: 'JetBrains Mono', monospace; }
        .card { background-color: #131722; border: 1px solid #2A2E39; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
        .section-label { font-size: 10px; font-weight: 600; color: #787B86; letter-spacing: 1px; text-transform: uppercase; margin-bottom: 12px; }
        .rule-box { background-color: #0B0E14; border: 1px solid #2A2E39; border-radius: 6px; padding: 10px 14px; margin-bottom: 6px; font-size: 12px; display: flex; align-items: center; font-family: 'JetBrains Mono', monospace; }
        .rule-green { border-color: #089981; color: #089981; }
        .rule-yellow { border-color: #F59E0B; color: #F59E0B; }
        .badge-waiting { background: #1E222D; color: #B2B5BE; padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: 700; border: 1px solid #2A2E39;}
        .badge-active { background: rgba(8, 153, 129, 0.2); color: #089981; padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: 700; border: 1px solid #089981;}
        #tvchart { width: 100%; height: 350px; border-radius: 8px; overflow: hidden; background: #131722;}
    </style>
</head>
<body class="max-w-md mx-auto">
    <div class="flex items-center gap-3 mb-6 mt-2">
        <span class="text-2xl text-yellow-500">👑</span>
        <div><h1 class="text-xl font-bold tracking-wide">XAU AI CHART</h1><p class="text-[10px] text-gray-500 tracking-widest">TRIPLE ENGINE TERMINAL</p></div>
    </div>
    <div class="flex justify-between items-center mb-4">
        <div class="text-[10px] font-bold px-3 py-1.5 rounded-full border border-green-900 text-green-500 bg-green-900/20 flex items-center gap-2"><span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span> DATA FEED CONNECTED</div>
        <div id="market-status" class="text-[10px] font-bold px-3 py-1.5 rounded border border-red-900 text-red-500 bg-red-900/20">T4F WINDOW CLOSED</div>
    </div>
    <div class="grid grid-cols-2 gap-3 mb-6">
        <div class="card mb-0"><p class="section-label mb-1">INSTRUMENT</p><h2 class="text-lg font-bold">XAUUSD</h2></div>
        <div class="card mb-0"><p class="section-label mb-1">STRATEGY TIMEFRAMES</p><h2 class="text-lg font-bold">M15 / H1 / M1 / M5</h2></div>
        <div class="card mb-0"><p class="section-label mb-1">LATEST COMPLETED PRICE</p><h2 id="live-price" class="text-lg mono font-bold">---.--</h2></div>
        <div class="card mb-0"><p class="section-label mb-1">T4F SCAN WINDOW</p><h2 id="window-status" class="text-sm font-bold text-yellow-500">WINDOW CLOSED</h2></div>
    </div>
    <div class="card border-t-2 border-t-blue-500">
        <div class="flex justify-between items-center mb-4"><div><h3 class="text-lg font-bold text-white">ENGINE 1: T4F</h3><p class="text-[10px] text-gray-500">08:03 & 14:45 WAT</p></div><div id="e1-status-badge" class="badge-waiting">WAITING</div></div>
        <div id="e1-signal-box" class="hidden bg-[#0B0E14] border border-gray-800 p-4 rounded-lg mb-4"><div class="text-[10px] text-gray-500 mb-2">CURRENT SIGNAL</div><div id="e1-type" class="text-2xl font-black text-yellow-500 mb-3">WAITING</div><div class="grid grid-cols-3 gap-2 text-center"><div class="bg-[#131722] p-2 rounded border border-gray-800"><p class="text-[9px] text-gray-500">ENTRY LIMIT</p><p id="e1-entry" class="mono text-sm font-bold mt-1 text-white">—</p></div><div class="bg-[#131722] p-2 rounded border border-gray-800"><p class="text-[9px] text-red-500">STOP LOSS</p><p id="e1-sl" class="mono text-sm font-bold text-red-500 mt-1">—</p></div><div class="bg-[#131722] p-2 rounded border border-gray-800"><p class="text-[9px] text-green-500">TAKE PROFIT</p><p id="e1-tp" class="mono text-sm font-bold text-green-500 mt-1">—</p></div></div><div class="mt-3 text-[11px] text-gray-500 font-mono"><span id="e1-reason">Outside T4F windows.</span></div></div>
        <p class="section-label mt-4">T4F RULE CHECKS</p>
        <div class="space-y-2"><div id="e1-rule-1" class="rule-box rule-yellow justify-between"><span>T4F window</span> <span>WAIT</span></div><div id="e1-rule-2" class="rule-box rule-yellow justify-between"><span>H1 EMA 50</span> <span>WAIT</span></div><div id="e1-rule-3" class="rule-box rule-yellow justify-between"><span>M15 candle bias</span> <span>WAIT</span></div><div id="e1-rule-4" class="rule-box rule-yellow justify-between"><span>Entry level</span> <span>WAIT</span></div><div id="e1-rule-5" class="rule-box rule-yellow justify-between"><span>M1 confirmation</span> <span>WAIT</span></div></div>
    </div>
    <div class="card border-t-2 border-t-yellow-500">
        <div class="flex justify-between items-center mb-4"><div><h3 class="text-lg font-bold text-white">ENGINE 2: ASIA</h3><p class="text-[10px] text-gray-500">Asia Sweep + CHoCH</p></div><div id="e2-status-badge" class="badge-waiting">WAITING</div></div>
        <div id="e2-signal-box" class="hidden bg-[#0B0E14] border border-gray-800 p-4 rounded-lg mb-4"><div class="text-[10px] text-gray-500 mb-2">CURRENT SIGNAL</div><div id="e2-type" class="text-2xl font-black text-yellow-500 mb-3">WAITING</div><div class="grid grid-cols-3 gap-2 text-center"><div class="bg-[#131722] p-2 rounded border border-gray-800"><p class="text-[9px] text-gray-500">ENTRY LIMIT</p><p id="e2-entry" class="mono text-sm font-bold mt-1 text-white">—</p></div><div class="bg-[#131722] p-2 rounded border border-gray-800"><p class="text-[9px] text-red-500">STOP LOSS</p><p id="e2-sl" class="mono text-sm font-bold text-red-500 mt-1">—</p></div><div class="bg-[#131722] p-2 rounded border border-gray-800"><p class="text-[9px] text-green-500">TAKE PROFIT</p><p id="e2-tp" class="mono text-sm font-bold text-green-500 mt-1">—</p></div></div><div class="mt-3 text-[11px] text-gray-500 font-mono"><span id="e2-reason">Waiting for Asia Sweep.</span></div></div>
        <p class="section-label mt-4">ASIA SWEEP RULE CHECKS</p>
        <div class="space-y-2"><div id="e2-rule-1" class="rule-box rule-yellow justify-between"><span>Asia Range Swept</span> <span>WAIT</span></div><div id="e2-rule-2" class="rule-box rule-yellow justify-between"><span>Trend Aligned (EMA 200)</span> <span>WAIT</span></div><div id="e2-rule-3" class="rule-box rule-yellow justify-between"><span>CHoCH Confirmed</span> <span>WAIT</span></div></div>
    </div>
    <div class="card border-t-2 border-t-purple-500">
        <div class="flex justify-between items-center mb-4"><div><h3 class="text-lg font-bold text-white">ENGINE 3: M5 SCALPER</h3><p class="text-[10px] text-gray-500">High Frequency + Momentum</p></div><div id="e3-status-badge" class="badge-waiting">WAITING</div></div>
        <div id="e3-signal-box" class="hidden bg-[#0B0E14] border border-gray-800 p-4 rounded-lg mb-4"><div class="text-[10px] text-gray-500 mb-2">CURRENT SIGNAL</div><div id="e3-type" class="text-2xl font-black text-yellow-500 mb-3">WAITING</div><div class="grid grid-cols-3 gap-2 text-center"><div class="bg-[#131722] p-2 rounded border border-gray-800"><p class="text-[9px] text-gray-500">ENTRY LIMIT</p><p id="e3-entry" class="mono text-sm font-bold mt-1 text-white">—</p></div><div class="bg-[#131722] p-2 rounded border border-gray-800"><p class="text-[9px] text-red-500">STOP LOSS</p><p id="e3-sl" class="mono text-sm font-bold text-red-500 mt-1">—</p></div><div class="bg-[#131722] p-2 rounded border border-gray-800"><p class="text-[9px] text-green-500">TAKE PROFIT</p><p id="e3-tp" class="mono text-sm font-bold text-green-500 mt-1">—</p></div></div><div class="mt-3 text-[11px] text-gray-500 font-mono"><span id="e3-reason">Waiting for M5 Momentum.</span></div></div>
        <p class="section-label mt-4">M5 SCALPER RULE CHECKS</p>
        <div class="space-y-2"><div id="e3-rule-1" class="rule-box rule-yellow justify-between"><span>RSI Cross (50)</span> <span>WAIT</span></div><div id="e3-rule-2" class="rule-box rule-yellow justify-between"><span>Momentum Candle (ATR)</span> <span>WAIT</span></div><div id="e3-rule-3" class="rule-box rule-yellow justify-between"><span>Location (EMA 50)</span> <span>WAIT</span></div></div>
    </div>
    <p class="section-label mt-6">GOLD CHART</p><div id="tvchart" class="card p-0 overflow-hidden"></div>
    <script src="https://s3.tradingview.com/tv.js"></script>
    <script>
        new TradingView.widget({"width":"100%","height":350,"symbol":"OANDA:XAUUSD","interval":"15","timezone":"Etc/UTC","theme":"dark","style":"1","locale":"en","toolbar_bg":"#f1f3f6","enable_publishing":false,"hide_side_toolbar":true,"allow_symbol_change":false,"container_id":"tvchart","studies":["MAExp@tv-basicstudies"]});
        async function fetchSignals() {
            try {
                const res = await fetch('/api/scan?t=' + new Date().getTime());
                const data = await res.json();
                if (!data.ok) return;
                document.getElementById('live-price').innerText = data.price.toFixed(2);
                const mktStatus = document.getElementById('market-status');
                const winStatus = document.getElementById('window-status');
                if (data.session.active) {
                    mktStatus.innerText = 'T4F WINDOW OPEN'; mktStatus.className = 'text-[10px] font-bold px-3 py-1.5 rounded bg-green-900/30 border border-green-900 text-green-400';
                    winStatus.innerText = 'WINDOW OPEN'; winStatus.className = 'text-sm font-bold text-green-500';
                } else {
                    mktStatus.innerText = 'T4F WINDOW CLOSED'; mktStatus.className = 'text-[10px] font-bold px-3 py-1.5 rounded bg-red-900/30 border border-red-900 text-red-400';
                    winStatus.innerText = 'WINDOW CLOSED'; winStatus.className = 'text-sm font-bold text-yellow-500';
                }
                const e1 = data.engines.t4f;
                if (e1.signal !== 'WAITING') {
                    document.getElementById('e1-status-badge').className = 'badge-active'; document.getElementById('e1-status-badge').innerText = 'ACTIVE'; document.getElementById('e1-signal-box').classList.remove('hidden'); document.getElementById('e1-type').innerText = e1.signal; document.getElementById('e1-type').className = e1.signal === 'BUY' ? 'text-2xl font-black mb-3 text-green-500' : 'text-2xl font-black mb-3 text-red-500'; document.getElementById('e1-entry').innerText = e1.entry; document.getElementById('e1-sl').innerText = e1.stopLoss; document.getElementById('e1-tp').innerText = e1.tp3;
                } else {
                    document.getElementById('e1-status-badge').className = 'badge-waiting'; document.getElementById('e1-status-badge').innerText = 'WAITING'; document.getElementById('e1-signal-box').classList.add('hidden');
                }
                document.getElementById('e1-reason').innerText = e1.reason;
                if(e1.reason.includes('Outside')) { document.getElementById('e1-rule-1').className = 'rule-box rule-yellow justify-between'; document.getElementById('e1-rule-1').innerHTML = '<span>T4F window</span> <span>CLOSED</span>'; } else { document.getElementById('e1-rule-1').className = 'rule-box rule-green justify-between'; document.getElementById('e1-rule-1').innerHTML = '<span>T4F window</span> <span>OPEN</span>'; }
                const e2 = data.engines.asia;
                if (e2.signal !== 'WAITING') {
                    document.getElementById('e2-status-badge').className = 'badge-active'; document.getElementById('e2-status-badge').innerText = 'ACTIVE'; document.getElementById('e2-signal-box').classList.remove('hidden'); document.getElementById('e2-type').innerText = e2.signal; document.getElementById('e2-type').className = e2.signal === 'BUY' ? 'text-2xl font-black mb-3 text-green-500' : 'text-2xl font-black mb-3 text-red-500'; document.getElementById('e2-entry').innerText = e2.entry; document.getElementById('e2-sl').innerText = e2.stopLoss; document.getElementById('e2-tp').innerText = e2.tp3;
                } else {
                    document.getElementById('e2-status-badge').className = 'badge-waiting'; document.getElementById('e2-status-badge').innerText = 'WAITING'; document.getElementById('e2-signal-box').classList.add('hidden');
                }
                document.getElementById('e2-reason').innerText = e2.reason;
                if(e2.reason.includes('Sweep')) { document.getElementById('e2-rule-1').className = 'rule-box rule-yellow justify-between'; document.getElementById('e2-rule-1').innerHTML = '<span>Asia Range Swept</span> <span>WAIT</span>'; } else { document.getElementById('e2-rule-1').className = 'rule-box rule-green justify-between'; document.getElementById('e2-rule-1').innerHTML = '<span>Asia Range Swept</span> <span>YES</span>'; }
                const e3 = data.engines.scalper;
                if (e3.signal !== 'WAITING') {
                    document.getElementById('e3-status-badge').className = 'badge-active'; document.getElementById('e3-status-badge').innerText = 'ACTIVE'; document.getElementById('e3-signal-box').classList.remove('hidden'); document.getElementById('e3-type').innerText = e3.signal; document.getElementById('e3-type').className = e3.signal === 'BUY' ? 'text-2xl font-black mb-3 text-green-500' : 'text-2xl font-black mb-3 text-red-500'; document.getElementById('e3-entry').innerText = e3.entry; document.getElementById('e3-sl').innerText = e3.stopLoss; document.getElementById('e3-tp').innerText = e3.tp3;
                } else {
                    document.getElementById('e3-status-badge').className = 'badge-waiting'; document.getElementById('e3-status-badge').innerText = 'WAITING'; document.getElementById('e3-signal-box').classList.add('hidden');
                }
                document.getElementById('e3-reason').innerText = e3.reason;
                if(e3.rules.rsiCross) { document.getElementById('e3-rule-1').className = 'rule-box rule-green justify-between'; document.getElementById('e3-rule-1').innerHTML = '<span>RSI Cross (50)</span> <span>PASSED</span>'; } else { document.getElementById('e3-rule-1').className = 'rule-box rule-yellow justify-between'; document.getElementById('e3-rule-1').innerHTML = '<span>RSI Cross (50)</span> <span>WAIT</span>'; }
                if(e3.rules.momentum) { document.getElementById('e3-rule-2').className = 'rule-box rule-green justify-between'; document.getElementById('e3-rule-2').innerHTML = '<span>Momentum Candle (ATR)</span> <span>PASSED</span>'; } else { document.getElementById('e3-rule-2').className = 'rule-box rule-yellow justify-between'; document.getElementById('e3-rule-2').innerHTML = '<span>Momentum Candle (ATR)</span> <span>WAIT</span>'; }
                if(e3.rules.location) { document.getElementById('e3-rule-3').className = 'rule-box rule-green justify-between'; document.getElementById('e3-rule-3').innerHTML = '<span>Location (EMA 50)</span> <span>PASSED</span>'; } else { document.getElementById('e3-rule-3').className = 'rule-box rule-yellow justify-between'; document.getElementById('e3-rule-3').innerHTML = '<span>Location (EMA 50)</span> <span>WAIT</span>'; }
            } catch (err) { console.error("Fetch error:", err); }
        }
        fetchSignals(); setInterval(fetchSignals, 10000);
    </script>
</body>
</html>
`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });

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

    return new Response(HTML_CONTENT, { headers: { "Content-Type": "text/html" } });
  }
};
