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

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = (values[i] - result) * multiplier + result;
  }

  return result;
}

function atr(candles, period = 14) {
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

  if (trs.length < period) return null;

  let value =
    trs.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trs.length; i++) {
    value = ((value * (period - 1)) + trs[i]) / period;
  }

  return value;
}

function calculateVWAPProxy(candles) {
  if (!candles.length) return null;

  let priceTotal = 0;

  for (const candle of candles) {
    const typical =
      (candle.high + candle.low + candle.close) / 3;

    priceTotal += typical;
  }

  return priceTotal / candles.length;
}

function getRecentHigh(candles, count) {
  const data = candles.slice(-count);
  return Math.max(...data.map(c => c.high));
}

function getRecentLow(candles, count) {
  const data = candles.slice(-count);
  return Math.min(...data.map(c => c.low));
}

function analyzeSignal(candles) {
  if (!Array.isArray(candles) || candles.length < 60) {
    return {
      signal: "WAITING",
      reason: "Not enough candles"
    };
  }

  // Use only CLOSED candles.
  const closed = candles.slice(0, -1);

  if (closed.length < 55) {
    return {
      signal: "WAITING",
      reason: "Not enough closed candles"
    };
  }

  const current = closed[closed.length - 1];
  const previous = closed[closed.length - 2];

  const closes = closed.map(c => c.close);

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const atr14 = atr(closed, 14);
  const vwap = calculateVWAPProxy(closed.slice(-50));

  if (
    ema20 === null ||
    ema50 === null ||
    atr14 === null ||
    vwap === null
  ) {
    return {
      signal: "WAITING",
      reason: "Indicators unavailable"
    };
  }

  const previous10 = closed.slice(-11, -1);

  const tenBarHigh = Math.max(
    ...previous10.map(c => c.high)
  );

  const tenBarLow = Math.min(
    ...previous10.map(c => c.low)
  );

  const sweepBuy =
    current.low < tenBarLow &&
    current.close > tenBarLow;

  const sweepSell =
    current.high > tenBarHigh &&
    current.close < tenBarHigh;

  const previous5 = closed.slice(-6, -1);

  const fiveBarHigh = Math.max(
    ...previous5.map(c => c.high)
  );

  const fiveBarLow = Math.min(
    ...previous5.map(c => c.low)
  );

  const structureBuy =
    current.close > fiveBarHigh;

  const structureSell =
    current.close < fiveBarLow;

  const trendBuy =
    ema20 > ema50 &&
    current.close > ema20;

  const trendSell =
    ema20 < ema50 &&
    current.close < ema20;

  const vwapBuy =
    current.close > vwap;

  const vwapSell =
    current.close < vwap;

  const body =
    Math.abs(current.close - current.open);

  const momentumBuy =
    current.close > current.open &&
    current.close > previous.close &&
    body >= atr14 * 0.20;

  const momentumSell =
    current.close < current.open &&
    current.close < previous.close &&
    body >= atr14 * 0.20;

  const volatility =
    atr14 > 0.30;

  const volatilityBuy = volatility;
  const volatilitySell = volatility;

  const buyScore = [
    trendBuy,
    vwapBuy,
    momentumBuy,
    volatilityBuy
  ].filter(Boolean).length;

  const sellScore = [
    trendSell,
    vwapSell,
    momentumSell,
    volatilitySell
  ].filter(Boolean).length;

  let signal = "WAITING";

  if (
    buyScore >= 4 &&
    sweepBuy &&
    structureBuy
  ) {
    signal = "BUY";
  }

  if (
    sellScore >= 4 &&
    sweepSell &&
    structureSell
  ) {
    signal = "SELL";
  }

  if (signal === "WAITING") {
    return {
      signal: "WAITING",
      candleTime: current.time,
      checks: {
        liquiditySweep: sweepBuy || sweepSell,
        structure: structureBuy || structureSell,
        ema: trendBuy || trendSell,
        vwap: vwapBuy || vwapSell,
        momentum: momentumBuy || momentumSell,
        volatility
      }
    };
  }

  const entry = current.close;

  let stopLoss;
  let takeProfit;

  if (signal === "BUY") {
    const swingLow = getRecentLow(
      closed.slice(-10),
      10
    );

    stopLoss = Math.min(
      swingLow,
      entry - atr14 * 1.15
    );

    const risk = entry - stopLoss;

    if (risk <= 0) {
      return {
        signal: "WAITING",
        reason: "Invalid BUY risk"
      };
    }

    takeProfit = entry + risk * 2.5;
  } else {
    const swingHigh = getRecentHigh(
      closed.slice(-10),
      10
    );

    stopLoss = Math.max(
      swingHigh,
      entry + atr14 * 1.15
    );

    const risk = stopLoss - entry;

    if (risk <= 0) {
      return {
        signal: "WAITING",
        reason: "Invalid SELL risk"
      };
    }

    takeProfit = entry - risk * 2.5;
  }

  const risk =
    signal === "BUY"
      ? entry - stopLoss
      : stopLoss - entry;

  const reward =
    signal === "BUY"
      ? takeProfit - entry
      : entry - takeProfit;

  const rr = risk > 0 ? reward / risk : 0;

  if (rr < 2) {
    return {
      signal: "WAITING",
      reason: "Risk/reward below 2R"
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
      liquiditySweep: true,
      structure: true,
      ema: signal === "BUY" ? trendBuy : trendSell,
      vwap: signal === "BUY" ? vwapBuy : vwapSell,
      momentum: signal === "BUY" ? momentumBuy : momentumSell,
      volatility: true,
      candleClose: true,
      nonRepainting: true
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
    encodeURIComponent(env.TWELVE_DATA_API_KEY);

  const response = await fetch(apiUrl);
  const data = await response.json();

  if (!response.ok || data.status === "error") {
    throw new Error(
      "Twelve Data request failed: " +
      JSON.stringify(data)
    );
  }

  const values = Array.isArray(data.values)
    ? data.values
    : [];

  return values.reverse().map(candle => ({
    time: candle.datetime,
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: candle.volume
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
    `${signal.signal === "BUY" ? "BUY" : "SELL"} XAUUSD\n` +
    `Timeframe: M5\n\n` +
    `Entry: ${signal.entry}\n` +
    `Stop Loss: ${signal.stopLoss}\n` +
    `Take Profit: ${signal.takeProfit}\n` +
    `Risk/Reward: ${signal.riskReward}R\n\n` +
    `Signal confirmed on closed candle.\n` +
    `Non-Repainting: ACTIVE`;

  const telegramUrl =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(telegramUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text: message
    })
  });

  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(
      "Telegram request failed: " +
      JSON.stringify(result)
    );
  }

  return result;
}

async function scanAndNotify(env) {
  const candles = await getCandles(env);
  const signal = analyzeSignal(candles);

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
    await env.SIGNAL_CACHE?.get(signalKey);

  if (alreadySent) {
    return {
      ok: true,
      notified: false,
      duplicate: true,
      signal
    };
  }

  await sendTelegram(env, signal);

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

    const url = new URL(request.url);

    if (url.pathname === "/api/status") {
      return json({
        ok: true,
        service: "XAU AI CHART API",
        status: "online",
        market: "XAUUSD",
        timeframe: "M5",
        goldApi: !!env.GOLD_API_KEY,
        twelveData: !!env.TWELVE_DATA_API_KEY,
        telegram: !!env.TELEGRAM_BOT_TOKEN &&
                  !!env.TELEGRAM_CHAT_ID
      });
    }

    if (url.pathname === "/api/gold") {
      if (!env.GOLD_API_KEY) {
        return json({
          ok: false,
          error: "GOLD_API_KEY secret is not configured."
        }, 500);
      }

      try {
        const response = await fetch(
          "https://www.goldapi.io/api/price/XAU/USD",
          {
            headers: {
              "x-access-token": env.GOLD_API_KEY,
              "Content-Type": "application/json"
            }
          }
        );

        const data = await response.json();

        if (!response.ok) {
          return json({
            ok: false,
            error: "GoldAPI request failed.",
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
          previousClose: data.prev_close_price,
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
          error: "GoldAPI connection failed.",
          details: error.message
        }, 500);
      }
    }

    if (url.pathname === "/api/candles") {
      try {
        const candles = await getCandles(env);

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
          error: "Twelve Data candle request failed.",
          details: error.message
        }, 500);
      }
    }

    if (url.pathname === "/api/scan") {
      try {
        const result = await scanAndNotify(env);
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
      scanAndNotify(env).catch(error => {
        console.error(
          "Scheduled XAU scan failed:",
          error.message
        );
      })
    );
  }
};
