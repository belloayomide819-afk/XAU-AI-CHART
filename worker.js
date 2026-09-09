const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });
}

const MIN_CANDLES = 60;
const LOOKBACK = 10;
const STRUCTURE_LOOKBACK = 5;
const SWEEP_WINDOW = 3;
const ATR_PERIOD = 14;
const RR_TARGET = 2.5;
const ATR_SL_MULTIPLIER = 1.15;
const MIN_ATR = 0.30;

function emaSeries(values, period) {
  const result = new Array(values.length).fill(null);

  if (values.length < period) return result;

  let sum = 0;

  for (let i = 0; i < period; i++) {
    sum += values[i];
  }

  result[period - 1] = sum / period;

  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    result[i] =
      (values[i] - result[i - 1]) * multiplier +
      result[i - 1];
  }

  return result;
}

function atrSeries(candles, period = 14) {
  const result = new Array(candles.length).fill(null);

  if (candles.length < period + 1) return result;

  const tr = new Array(candles.length).fill(null);

  tr[0] = candles[0].high - candles[0].low;

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    tr[i] = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );
  }

  let initial = 0;

  for (let i = 0; i < period; i++) {
    initial += tr[i];
  }

  result[period - 1] = initial / period;

  for (let i = period; i < candles.length; i++) {
    result[i] =
      ((result[i - 1] * (period - 1)) + tr[i]) / period;
  }

  return result;
}

function vwapSeries(candles) {
  const result = new Array(candles.length).fill(null);

  let priceTotal = 0;
  let weightTotal = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    const typical =
      (candle.high + candle.low + candle.close) / 3;

    priceTotal += typical;
    weightTotal += 1;

    result[i] = priceTotal / weightTotal;
  }

  return result;
}

function bullish(candle) {
  return candle.close > candle.open;
}

function bearish(candle) {
  return candle.close < candle.open;
}

function detectSweepAt(candles, index) {
  if (index < LOOKBACK) {
    return {
      buy: false,
      sell: false
    };
  }

  const current = candles[index];

  let previousLow = Infinity;
  let previousHigh = -Infinity;

  for (
    let i = index - LOOKBACK;
    i < index;
    i++
  ) {
    previousLow = Math.min(previousLow, candles[i].low);
    previousHigh = Math.max(previousHigh, candles[i].high);
  }

  const buy =
    current.low < previousLow &&
    current.close > previousLow &&
    bullish(current);

  const sell =
    current.high > previousHigh &&
    current.close < previousHigh &&
    bearish(current);

  return { buy, sell };
}

function findRecentSweep(candles, index) {
  const result = {
    buy: false,
    sell: false,
    index: -1
  };

  const start =
    Math.max(LOOKBACK, index - SWEEP_WINDOW);

  for (let i = index; i >= start; i--) {
    const sweep = detectSweepAt(candles, i);

    if (sweep.buy) {
      result.buy = true;
      result.index = i;
      break;
    }

    if (sweep.sell) {
      result.sell = true;
      result.index = i;
      break;
    }
  }

  return result;
}

function detectStructure(candles, index) {
  if (index < STRUCTURE_LOOKBACK + 1) {
    return {
      buy: false,
      sell: false
    };
  }

  const current = candles[index];

  let recentHigh = -Infinity;
  let recentLow = Infinity;

  for (
    let i = index - STRUCTURE_LOOKBACK;
    i < index;
    i++
  ) {
    recentHigh = Math.max(
      recentHigh,
      candles[i].high
    );

    recentLow = Math.min(
      recentLow,
      candles[i].low
    );
  }

  return {
    buy: current.close > recentHigh,
    sell: current.close < recentLow
  };
}

function momentum(candles, index, atr) {
  const current = candles[index];
  const previous = candles[index - 1];

  if (!atr[index]) {
    return {
      buy: false,
      sell: false
    };
  }

  const body =
    Math.abs(current.close - current.open);

  const strongBody =
    body >= atr[index] * 0.20;

  return {
    buy:
      strongBody &&
      bullish(current) &&
      current.close > previous.close,

    sell:
      strongBody &&
      bearish(current) &&
      current.close < previous.close
  };
}

function getSwingLow(candles, start, end) {
  let value = Infinity;

  for (let i = start; i <= end; i++) {
    value = Math.min(value, candles[i].low);
  }

  return value;
}

function getSwingHigh(candles, start, end) {
  let value = -Infinity;

  for (let i = start; i <= end; i++) {
    value = Math.max(value, candles[i].high);
  }

  return value;
}

function analyzeSignal(candles) {
  if (!Array.isArray(candles) ||
      candles.length < MIN_CANDLES) {
    return {
      signal: "WAITING",
      reason: "Not enough candles"
    };
  }

  /*
    Ignore the newest candle because it may still be forming.
    Only closed candles are used.
  */
  const closed = candles.slice(0, -1);

  if (closed.length < 55) {
    return {
      signal: "WAITING",
      reason: "Not enough closed candles"
    };
  }

  const index = closed.length - 1;
  const current = closed[index];
  const previous = closed[index - 1];

  const closes = closed.map(c => c.close);

  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const atr = atrSeries(closed, ATR_PERIOD);
  const vwap = vwapSeries(closed);

  if (
    !ema20[index] ||
    !ema50[index] ||
    !atr[index] ||
    !vwap[index]
  ) {
    return {
      signal: "WAITING",
      reason: "Indicators unavailable"
    };
  }

  const recentSweep =
    findRecentSweep(closed, index);

  const structure =
    detectStructure(closed, index);

  const momentumResult =
    momentum(closed, index, atr);

  const trendBuy =
    ema20[index] > ema50[index] &&
    current.close > ema20[index];

  const trendSell =
    ema20[index] < ema50[index] &&
    current.close < ema20[index];

  const vwapBuy =
    current.close > vwap[index];

  const vwapSell =
    current.close < vwap[index];

  const volatilityOK =
    atr[index] > MIN_ATR;

  const buySecondary = [
    vwapBuy,
    momentumResult.buy,
    volatilityOK
  ].filter(Boolean).length;

  const sellSecondary = [
    vwapSell,
    momentumResult.sell,
    volatilityOK
  ].filter(Boolean).length;

  /*
    New entry logic:

    1. Recent liquidity sweep
    2. Structure confirmation
    3. EMA trend
    4. At least 2 of:
       VWAP
       Momentum
       Volatility

    The sweep may occur up to 3 closed candles
    before the structure confirmation.
  */

  const buySignal =
    recentSweep.buy &&
    structure.buy &&
    trendBuy &&
    buySecondary >= 2;

  const sellSignal =
    recentSweep.sell &&
    structure.sell &&
    trendSell &&
    sellSecondary >= 2;

  let signal = "WAITING";

  if (buySignal && !sellSignal) {
    signal = "BUY";
  }

  if (sellSignal && !buySignal) {
    signal = "SELL";
  }

  const baseChecks = {
    liquiditySweep:
      recentSweep.buy || recentSweep.sell,

    structure:
      structure.buy || structure.sell,

    ema:
      trendBuy || trendSell,

    vwap:
      vwapBuy || vwapSell,

    momentum:
      momentumResult.buy || momentumResult.sell,

    volatility: volatilityOK,

    candleClose: true,
    nonRepainting: true,

    buySecondary,
    sellSecondary
  };

  if (signal === "WAITING") {
    return {
      signal: "WAITING",
      candleTime: current.time,
      checks: baseChecks
    };
  }

  const entry = current.close;

  let stopLoss;
  let takeProfit;

  /*
    Include the recent sweep area in the protection zone.
  */

  if (signal === "BUY") {
    const start =
      Math.max(
        0,
        Math.min(
          recentSweep.index,
          index
        ) - 2
      );

    const swingLow =
      getSwingLow(
        closed,
        start,
        index
      );

    stopLoss = Math.min(
      swingLow,
      entry - atr[index] * ATR_SL_MULTIPLIER
    );

    const risk =
      entry - stopLoss;

    if (risk <= 0) {
      return {
        signal: "WAITING",
        candleTime: current.time,
        reason: "Invalid BUY risk",
        checks: baseChecks
      };
    }

    takeProfit =
      entry + risk * RR_TARGET;
  }

  if (signal === "SELL") {
    const start =
      Math.max(
        0,
        Math.min(
          recentSweep.index,
          index
        ) - 2
      );

    const swingHigh =
      getSwingHigh(
        closed,
        start,
        index
      );

    stopLoss = Math.max(
      swingHigh,
      entry + atr[index] * ATR_SL_MULTIPLIER
    );

    const risk =
      stopLoss - entry;

    if (risk <= 0) {
      return {
        signal: "WAITING",
        candleTime: current.time,
        reason: "Invalid SELL risk",
        checks: baseChecks
      };
    }

    takeProfit =
      entry - risk * RR_TARGET;
  }

  const risk =
    signal === "BUY"
      ? entry - stopLoss
      : stopLoss - entry;

  const reward =
    signal === "BUY"
      ? takeProfit - entry
      : entry - takeProfit;

  const rr =
    risk > 0
      ? reward / risk
      : 0;

  if (rr < 2) {
    return {
      signal: "WAITING",
      candleTime: current.time,
      reason: "Risk/reward below 2R",
      checks: baseChecks
    };
  }

  return {
    signal,
    candleTime: current.time,

    entry: Number(entry.toFixed(2)),
    stopLoss: Number(stopLoss.toFixed(2)),
    takeProfit: Number(takeProfit.toFixed(2)),

    riskReward: Number(rr.toFixed(2)),

    checks: {
      ...baseChecks,

      liquiditySweep: true,
      structure: true,

      ema:
        signal === "BUY"
          ? trendBuy
          : trendSell,

      vwap:
        signal === "BUY"
          ? vwapBuy
          : vwapSell,

      momentum:
        signal === "BUY"
          ? momentumResult.buy
          : momentumResult.sell,

      volatility: true
    }
  };
}

async function getCandles(env) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY secret is not configured."
    );
  }

  const apiUrl =
    "https://api.twelvedata.com/time_series" +
    "?symbol=XAU/USD" +
    "&interval=5min" +
    "&outputsize=100" +
    "&format=JSON" +
    "&apikey=" +
    encodeURIComponent(
      env.TWELVE_DATA_API_KEY
    );

  const response =
    await fetch(apiUrl);

  const data =
    await response.json();

  if (!response.ok ||
      data.status === "error") {
    throw new Error(
      "Twelve Data request failed: " +
      JSON.stringify(data)
    );
  }

  const values =
    Array.isArray(data.values)
      ? data.values
      : [];

  return values
    .reverse()
    .map(candle => ({
      time: candle.datetime,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
      volume:
        candle.volume
          ? Number(candle.volume)
          : null
    }));
}

async function sendTelegram(env, signal) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN secret is not configured."
    );
  }

  if (!env.TELEGRAM_CHAT_ID) {
    throw new Error(
      "TELEGRAM_CHAT_ID secret is not configured."
    );
  }

  const message =
    `XAU AI CHART SIGNAL\n\n` +
    `${signal.signal} XAUUSD\n` +
    `Timeframe: M5\n\n` +
    `Entry: ${signal.entry}\n` +
    `Stop Loss: ${signal.stopLoss}\n` +
    `Take Profit: ${signal.takeProfit}\n` +
    `Risk/Reward: ${signal.riskReward}R\n\n` +
    `Liquidity Sweep: CONFIRMED\n` +
    `BOS / CHoCH: CONFIRMED\n` +
    `Closed Candle: CONFIRMED\n` +
    `Non-Repainting: ACTIVE`;

  const telegramUrl =
    `https://api.telegram.org/bot` +
    `${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response =
    await fetch(
      telegramUrl,
      {
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
      }
    );

  const result =
    await response.json();

  if (!response.ok ||
      !result.ok) {
    throw new Error(
      "Telegram request failed: " +
      JSON.stringify(result)
    );
  }

  return result;
}

async function scanAndNotify(env) {
  const candles =
    await getCandles(env);

  const signal =
    analyzeSignal(candles);

  if (signal.signal === "WAITING") {
    return {
      ok: true,
      notified: false,
      signal
    };
  }

  const signalKey =
    `${signal.signal}_${signal.candleTime}`;

  const alreadySent =
    env.SIGNAL_CACHE
      ? await env.SIGNAL_CACHE.get(signalKey)
      : null;

  if (alreadySent) {
    return {
      ok: true,
      notified: false,
      duplicate: true,
      signal
    };
  }

  await sendTelegram(
    env,
    signal
  );

  if (env.SIGNAL_CACHE) {
    await env.SIGNAL_CACHE.put(
      signalKey,
      "sent",
      {
        expirationTtl: 86400
      }
    );
  }

  return {
    ok: true,
    notified: true,
    signal
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders
      });
    }

    const url =
      new URL(request.url);

    if (url.pathname === "/api/status") {
      return json({
        ok: true,
        service: "XAU AI CHART API",
        status: "online",
        market: "XAUUSD",
        timeframe: "M5",
        goldApi: !!env.GOLD_API_KEY,
        twelveData:
          !!env.TWELVE_DATA_API_KEY,
        telegram:
          !!env.TELEGRAM_BOT_TOKEN &&
          !!env.TELEGRAM_CHAT_ID,
        signalEngine:
          "Sweep + Structure + EMA + 2/3 confirmation"
      });
    }

    if (url.pathname === "/api/gold") {
      if (!env.GOLD_API_KEY) {
        return json({
          ok: false,
          error:
            "GOLD_API_KEY secret is not configured."
        }, 500);
      }

      try {
        const response =
          await fetch(
            "https://www.goldapi.io/api/price/XAU/USD",
            {
              headers: {
                "x-access-token":
                  env.GOLD_API_KEY,
                "Content-Type":
                  "application/json"
              }
            }
          );

        const data =
          await response.json();

        if (!response.ok) {
          return json({
            ok: false,
            error:
              "GoldAPI request failed.",
            details: data
          }, response.status);
        }

        return json({
          ok: true,
          market: "XAUUSD",
          price: data.price,
          bid: data.bid,
          ask: data.ask,
          open: data.open_price,
          high: data.high_price,
          low: data.low_price,
          previousClose:
            data.prev_close_price,
          change: data.ch,
          changePercent: data.chp,
          timestamp: data.timestamp,
          datetime: data.date,
          exchange: data.exchange,
          source: "GoldAPI"
        });
      } catch (error) {
        return json({
          ok: false,
          error:
            "GoldAPI connection failed.",
          details: error.message
        }, 500);
      }
    }

    if (url.pathname === "/api/candles") {
      try {
        const candles =
          await getCandles(env);

        return json({
          ok: true,
          market: "XAUUSD",
          timeframe: "M5",
          count: candles.length,
          candles,
          source: "Twelve Data"
        });
      } catch (error) {
        return json({
          ok: false,
          error:
            "Twelve Data candle request failed.",
          details: error.message
        }, 500);
      }
    }

    if (url.pathname === "/api/scan") {
      try {
        const result =
          await scanAndNotify(env);

        return json(result);
      } catch (error) {
        return json({
          ok: false,
          error: error.message
        }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      scanAndNotify(env)
        .catch(error => {
          console.error(
            "Scheduled XAU scan failed:",
            error.message
          );
        })
    );
  }
};
