const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const MIN_CANDLES = 60;
const LOOKBACK = 10;
const STRUCTURE_LOOKBACK = 5;
const SWEEP_WINDOW = 4;
const STRUCTURE_WINDOW = 3;
const ATR_PERIOD = 14;

const EMA_FAST = 20;
const EMA_SLOW = 50;

const MIN_ATR = 0.20;
const ATR_SL_MULTIPLIER = 1.10;

const MIN_RR = 2.0;
const TARGET_RR = 2.5;

const MAX_SIGNALS_PER_DAY = 6;
const SIGNAL_TTL = 86400;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });
}

function roundPrice(value) {
  return Math.round(value * 100) / 100;
}

function dayKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);

  let result = 0;

  for (let i = 0; i < period; i++) {
    result += values[i];
  }

  result /= period;

  for (let i = period; i < values.length; i++) {
    result =
      (values[i] - result) * multiplier + result;
  }

  return result;
}

function calculateATR(candles, period = ATR_PERIOD) {
  if (candles.length < period + 1) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trs.push(tr);
  }

  const recent = trs.slice(-period);

  return recent.reduce((a, b) => a + b, 0) / recent.length;
}

function calculateVWAP(candles) {
  if (!candles.length) return null;

  let totalPrice = 0;
  let totalWeight = 0;

  for (const candle of candles) {
    const typicalPrice =
      (candle.high + candle.low + candle.close) / 3;

    const weight =
      candle.volume && candle.volume > 0
        ? candle.volume
        : 1;

    totalPrice += typicalPrice * weight;
    totalWeight += weight;
  }

  return totalPrice / totalWeight;
}

function bullish(candle) {
  return candle.close > candle.open;
}

function bearish(candle) {
  return candle.close < candle.open;
}

function getRecentSweep(candles) {
  const start = Math.max(
    LOOKBACK,
    candles.length - SWEEP_WINDOW
  );

  let buySweep = null;
  let sellSweep = null;

  for (let i = start; i < candles.length; i++) {
    const candle = candles[i];

    const previous = candles.slice(
      Math.max(0, i - LOOKBACK),
      i
    );

    if (previous.length < LOOKBACK) continue;

    const previousLow = Math.min(
      ...previous.map(c => c.low)
    );

    const previousHigh = Math.max(
      ...previous.map(c => c.high)
    );

    if (
      candle.low < previousLow &&
      candle.close > previousLow &&
      bullish(candle)
    ) {
      buySweep = {
        index: i,
        time: candle.time,
        level: previousLow
      };
    }

    if (
      candle.high > previousHigh &&
      candle.close < previousHigh &&
      bearish(candle)
    ) {
      sellSweep = {
        index: i,
        time: candle.time,
        level: previousHigh
      };
    }
  }

  return {
    buy: buySweep,
    sell: sellSweep
  };
}

function getRecentStructure(candles) {
  const start = Math.max(
    STRUCTURE_LOOKBACK,
    candles.length - STRUCTURE_WINDOW
  );

  let buyStructure = null;
  let sellStructure = null;

  for (let i = start; i < candles.length; i++) {
    const candle = candles[i];

    const previous = candles.slice(
      Math.max(0, i - STRUCTURE_LOOKBACK),
      i
    );

    if (previous.length < STRUCTURE_LOOKBACK) continue;

    const recentHigh = Math.max(
      ...previous.map(c => c.high)
    );

    const recentLow = Math.min(
      ...previous.map(c => c.low)
    );

    if (candle.close > recentHigh) {
      buyStructure = {
        index: i,
        time: candle.time,
        level: recentHigh
      };
    }

    if (candle.close < recentLow) {
      sellStructure = {
        index: i,
        time: candle.time,
        level: recentLow
      };
    }
  }

  return {
    buy: buyStructure,
    sell: sellStructure
  };
}

function getMomentum(candles) {
  if (candles.length < 6) {
    return {
      buy: false,
      sell: false
    };
  }

  const last = candles[candles.length - 1];
  const previous = candles[candles.length - 6];

  const move = last.close - previous.close;

  return {
    buy: move > 0,
    sell: move < 0
  };
}

function getTrend(candles) {
  const closes = candles.map(c => c.close);

  const fastNow = ema(
    closes.slice(-EMA_SLOW - 5),
    EMA_FAST
  );

  const fastPrevious = ema(
    closes.slice(-EMA_SLOW - 6, -1),
    EMA_FAST
  );

  const slow = ema(
    closes.slice(-EMA_SLOW),
    EMA_SLOW
  );

  if (
    fastNow === null ||
    fastPrevious === null ||
    slow === null
  ) {
    return {
      buy: false,
      sell: false,
      ema20: null,
      ema50: null
    };
  }

  return {
    buy:
      fastNow > slow &&
      fastNow >= fastPrevious,

    sell:
      fastNow < slow &&
      fastNow <= fastPrevious,

    ema20: fastNow,
    ema50: slow
  };
}

function buildSignal(candles) {
  if (candles.length < MIN_CANDLES) {
    return {
      signal: "WAITING",
      reason: "Not enough closed candles"
    };
  }

  /*
    IMPORTANT:
    We remove the currently forming candle.
    Therefore all signals are based only on closed candles.
  */
  const closed = candles.slice(0, -1);

  if (closed.length < MIN_CANDLES) {
    return {
      signal: "WAITING",
      reason: "Waiting for more closed candles"
    };
  }

  const last = closed[closed.length - 1];

  const sweep = getRecentSweep(closed);
  const structure = getRecentStructure(closed);

  const trend = getTrend(closed);

  const momentum = getMomentum(closed);

  const atr = calculateATR(closed);

  const vwap = calculateVWAP(
    closed.slice(-30)
  );

  if (atr === null || vwap === null) {
    return {
      signal: "WAITING",
      reason: "Indicators not ready"
    };
  }

  /*
    A setup can now come from:

    1. Recent liquidity sweep
       OR
    2. Recent BOS / CHoCH

    We no longer require both events
    to happen on exactly the same candle.
  */

  const buySweep = !!sweep.buy;
  const sellSweep = !!sweep.sell;

  const buyStructure = !!structure.buy;
  const sellStructure = !!structure.sell;

  const buyTrigger =
    buySweep || buyStructure;

  const sellTrigger =
    sellSweep || sellStructure;

  const buyVWAP =
    last.close > vwap;

  const sellVWAP =
    last.close < vwap;

  const buyMomentum =
    momentum.buy;

  const sellMomentum =
    momentum.sell;

  const volatilityOK =
    atr >= MIN_ATR;

  let buySecondary = 0;
  let sellSecondary = 0;

  if (buyVWAP) buySecondary++;
  if (buyMomentum) buySecondary++;
  if (volatilityOK) buySecondary++;

  if (sellVWAP) sellSecondary++;
  if (sellMomentum) sellSecondary++;
  if (volatilityOK) sellSecondary++;

  /*
    Require:

    BUY:
    recent sweep OR structure
    +
    EMA trend
    +
    2/3 secondary confirmations

    SELL:
    same opposite conditions
  */

  const buyValid =
    buyTrigger &&
    trend.buy &&
    buySecondary >= 2;

  const sellValid =
    sellTrigger &&
    trend.sell &&
    sellSecondary >= 2;

  if (!buyValid && !sellValid) {
    return {
      signal: "WAITING",
      reason: "No complete setup",
      checks: {
        sweep:
          buySweep || sellSweep
            ? "CONFIRMED"
            : "WAIT",

        structure:
          buyStructure || sellStructure
            ? "CONFIRMED"
            : "WAIT",

        ema:
          trend.buy || trend.sell
            ? "CONFIRMED"
            : "WAIT",

        vwap:
          buyVWAP || sellVWAP
            ? "CONFIRMED"
            : "WAIT",

        momentum:
          buyMomentum || sellMomentum
            ? "CONFIRMED"
            : "WAIT",

        atr:
          volatilityOK
            ? "CONFIRMED"
            : "WAIT",

        rr: "WAIT",
        candleClose: "CONFIRMED",
        nonRepainting: "ACTIVE"
      }
    };
  }

  let direction;

  if (buyValid && !sellValid) {
    direction = "BUY";
  } else if (sellValid && !buyValid) {
    direction = "SELL";
  } else {
    /*
      Extremely rare case where both directions qualify.
      Use the direction with stronger confirmation.
    */
    direction =
      buySecondary >= sellSecondary
        ? "BUY"
        : "SELL";
  }

  const entry = last.close;

  let stopLoss;

  if (direction === "BUY") {
    const sweepLow =
      sweep.buy?.index !== undefined
        ? Math.min(
            ...closed
              .slice(
                Math.max(
                  0,
                  sweep.buy.index - 2
                ),
                sweep.buy.index + 1
              )
              .map(c => c.low)
          )
        : Infinity;

    const recentLow = Math.min(
      ...closed.slice(-6).map(c => c.low)
    );

    const structuralSL = Math.min(
      sweepLow,
      recentLow
    );

    stopLoss =
      structuralSL < entry
        ? structuralSL - atr * 0.15
        : entry - atr * ATR_SL_MULTIPLIER;
  } else {
    const sweepHigh =
      sweep.sell?.index !== undefined
        ? Math.max(
            ...closed
              .slice(
                Math.max(
                  0,
                  sweep.sell.index - 2
                ),
                sweep.sell.index + 1
              )
              .map(c => c.high)
          )
        : -Infinity;

    const recentHigh = Math.max(
      ...closed.slice(-6).map(c => c.high)
    );

    const structuralSL = Math.max(
      sweepHigh,
      recentHigh
    );

    stopLoss =
      structuralSL > entry
        ? structuralSL + atr * 0.15
        : entry + atr * ATR_SL_MULTIPLIER;
  }

  stopLoss = roundPrice(stopLoss);

  const risk = Math.abs(
    entry - stopLoss
  );

  if (!Number.isFinite(risk) || risk <= 0) {
    return {
      signal: "WAITING",
      reason: "Invalid risk distance"
    };
  }

  const takeProfit =
    direction === "BUY"
      ? entry + risk * TARGET_RR
      : entry - risk * TARGET_RR;

  const rr =
    Math.abs(takeProfit - entry) / risk;

  if (rr < MIN_RR) {
    return {
      signal: "WAITING",
      reason: "Risk/reward below minimum",
      checks: {
        sweep: "CONFIRMED",
        structure: "CONFIRMED",
        ema: "CONFIRMED",
        vwap: "CONFIRMED",
        momentum: "CONFIRMED",
        atr: volatilityOK
          ? "CONFIRMED"
          : "WAIT",
        rr: "WAIT",
        candleClose: "CONFIRMED",
        nonRepainting: "ACTIVE"
      }
    };
  }

  /*
    Setup anchor prevents the same sweep/structure
    from generating repeated Telegram alerts.
  */
  const anchor =
    direction === "BUY"
      ? (
          sweep.buy?.time ||
          structure.buy?.time ||
          last.time
        )
      : (
          sweep.sell?.time ||
          structure.sell?.time ||
          last.time
        );

  return {
    signal: direction,
    entry: roundPrice(entry),
    stopLoss,
    takeProfit: roundPrice(takeProfit),
    rr: Number(rr.toFixed(2)),
    candleTime: last.time,
    setupAnchor: anchor,

    checks: {
      sweep:
        direction === "BUY"
          ? buySweep
            ? "CONFIRMED"
            : "WAIT"
          : sellSweep
            ? "CONFIRMED"
            : "WAIT",

      structure:
        direction === "BUY"
          ? buyStructure
            ? "CONFIRMED"
            : "WAIT"
          : sellStructure
            ? "CONFIRMED"
            : "WAIT",

      ema: "CONFIRMED",

      vwap:
        direction === "BUY"
          ? buyVWAP
            ? "CONFIRMED"
            : "WAIT"
          : sellVWAP
            ? "CONFIRMED"
            : "WAIT",

      momentum:
        direction === "BUY"
          ? buyMomentum
            ? "CONFIRMED"
            : "WAIT"
          : sellMomentum
            ? "CONFIRMED"
            : "WAIT",

      atr:
        volatilityOK
          ? "CONFIRMED"
          : "WAIT",

      rr: "CONFIRMED",

      candleClose: "CONFIRMED",

      nonRepainting: "ACTIVE"
    }
  };
}

async function getCandles(env) {
  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=XAU/USD" +
    "&interval=5min" +
    "&outputsize=120" +
    "&apikey=" +
    encodeURIComponent(
      env.TWELVE_DATA_API_KEY
    );

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Twelve Data HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (
    !data.values ||
    !Array.isArray(data.values)
  ) {
    throw new Error(
      data.message ||
      "No candle data returned"
    );
  }

  return data.values
    .map(c => ({
      time: c.datetime,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume:
        c.volume !== null &&
        c.volume !== undefined
          ? Number(c.volume)
          : 0
    }))
    .reverse();
}

async function getLivePrice(env) {
  const url =
    "https://api.twelvedata.com/price" +
    "?symbol=XAU/USD" +
    "&apikey=" +
    encodeURIComponent(
      env.TWELVE_DATA_API_KEY
    );

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Price HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (!data.price) {
    throw new Error(
      data.message ||
      "No price returned"
    );
  }

  return Number(data.price);
}

async function sendTelegram(
  env,
  signal
) {
  if (
    !env.TELEGRAM_BOT_TOKEN ||
    !env.TELEGRAM_CHAT_ID
  ) {
    return false;
  }

  const message =
`XAU AI CHART — XAUUSD M5

${signal.signal === "BUY" ? "BUY" : "SELL"} SIGNAL

Entry: ${signal.entry}
SL: ${signal.stopLoss}
TP: ${signal.takeProfit}
RR: 1:${signal.rr}

Sweep: ${signal.checks.sweep}
BOS / CHoCH: ${signal.checks.structure}
EMA 20/50: ${signal.checks.ema}
VWAP: ${signal.checks.vwap}
Momentum: ${signal.checks.momentum}
ATR: ${signal.checks.atr}

Closed candle: CONFIRMED
Non-Repainting: ACTIVE

One setup = one alert.`;

  const url =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response =
    await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        chat_id:
          env.TELEGRAM_CHAT_ID,
        text: message
      })
    });

  return response.ok;
}

async function getDailySignalCount(env) {
  if (!env.SIGNAL_CACHE) return 0;

  const key =
    `daily-count-${dayKey(Date.now())}`;

  const value =
    await env.SIGNAL_CACHE.get(key);

  return value
    ? Number(value)
    : 0;
}

async function incrementDailySignalCount(env) {
  if (!env.SIGNAL_CACHE) return;

  const key =
    `daily-count-${dayKey(Date.now())}`;

  const current =
    await getDailySignalCount(env);

  await env.SIGNAL_CACHE.put(
    key,
    String(current + 1),
    {
      expirationTtl: 86400
    }
  );
}

async function scanAndNotify(env) {
  const candles =
    await getCandles(env);

  const signal =
    buildSignal(candles);

  if (
    signal.signal !== "BUY" &&
    signal.signal !== "SELL"
  ) {
    return signal;
  }

  const count =
    await getDailySignalCount(env);

  if (
    count >= MAX_SIGNALS_PER_DAY
  ) {
    return {
      ...signal,
      blocked:
        "Daily signal limit reached"
    };
  }

  /*
    The setup anchor is more important than
    candle time here. This prevents repeated
    alerts while the same setup remains valid.
  */
  const cacheKey =
    `signal-${signal.signal}-${signal.setupAnchor}`;

  if (env.SIGNAL_CACHE) {
    const alreadySent =
      await env.SIGNAL_CACHE.get(
        cacheKey
      );

    if (alreadySent) {
      return {
        ...signal,
        duplicate: true
      };
    }
  }

  const sent =
    await sendTelegram(
      env,
      signal
    );

  if (sent && env.SIGNAL_CACHE) {
    await env.SIGNAL_CACHE.put(
      cacheKey,
      "sent",
      {
        expirationTtl:
          SIGNAL_TTL
      }
    );

    await incrementDailySignalCount(
      env
    );
  }

  return {
    ...signal,
    telegramSent: sent
  };
}

export default {
  async fetch(request, env) {
    if (
      request.method === "OPTIONS"
    ) {
      return new Response(
        null,
        {
          headers: corsHeaders
        }
      );
    }

    const url =
      new URL(request.url);

    try {
      if (
        url.pathname === "/api/status"
      ) {
        return json({
          ok: true,
          service:
            "XAU AI CHART API",
          status: "online",
          market: "XAUUSD",
          timeframe: "M5",
          goldApi: false,
          twelveData:
            !!env.TWELVE_DATA_API_KEY,
          telegram:
            !!env.TELEGRAM_BOT_TOKEN &&
            !!env.TELEGRAM_CHAT_ID,
          signalEngine:
            "Higher-frequency Sweep OR Structure + EMA + 2/3 confirmation",
          priceSource:
            "Twelve Data",
          maxSignalsPerDay:
            MAX_SIGNALS_PER_DAY
        });
      }

      if (
        url.pathname === "/api/gold"
      ) {
        const price =
          await getLivePrice(env);

        return json({
          ok: true,
          market: "XAUUSD",
          price,
          source: "Twelve Data"
        });
      }

      if (
        url.pathname === "/api/candles"
      ) {
        const candles =
          await getCandles(env);

        return json({
          ok: true,
          market: "XAUUSD",
          timeframe: "M5",
          candles
        });
      }

      if (
        url.pathname === "/api/scan"
      ) {
        const result =
          await scanAndNotify(env);

        return json({
          ok: true,
          ...result
        });
      }

      return json({
        ok: true,
        service:
          "XAU AI CHART API"
      });
    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Unknown error"
        },
        500
      );
    }
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      scanAndNotify(env)
        .catch(() => {})
    );
  }
};
