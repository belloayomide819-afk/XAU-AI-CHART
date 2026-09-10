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

/*
  XAU AI CHART
  Higher-frequency M5 engine

  Data:
  Twelve Data for XAUUSD price + M5 candles

  Core:
  Liquidity Sweep
  + Recent Structure Confirmation
  + Directional EMA
  + 2 of 3 confirmations

  Only CLOSED candles are used for signals.
*/

const MIN_CANDLES = 60;

const LOOKBACK = 10;
const STRUCTURE_LOOKBACK = 5;

const SWEEP_WINDOW = 4;
const STRUCTURE_WINDOW = 2;

const ATR_PERIOD = 14;

const RR_TARGET = 2.5;
const MIN_RR = 2.0;

const ATR_SL_MULTIPLIER = 1.10;
const MIN_ATR = 0.25;

const EMA_FAST = 20;
const EMA_SLOW = 50;


/* =========================================================
   EMA
========================================================= */

function emaSeries(values, period) {
  const result = new Array(values.length).fill(null);

  if (values.length < period) {
    return result;
  }

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


/* =========================================================
   ATR
========================================================= */

function atrSeries(candles, period = 14) {
  const result = new Array(candles.length).fill(null);

  if (candles.length < period + 1) {
    return result;
  }

  const tr = new Array(candles.length).fill(null);

  tr[0] =
    candles[0].high -
    candles[0].low;

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

  result[period - 1] =
    initial / period;

  for (let i = period; i < candles.length; i++) {
    result[i] =
      (
        result[i - 1] * (period - 1) +
        tr[i]
      ) / period;
  }

  return result;
}


/* =========================================================
   VWAP PROXY
========================================================= */

function vwapSeries(candles) {
  const result = new Array(candles.length).fill(null);

  let priceTotal = 0;
  let weightTotal = 0;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    const typical =
      (
        candle.high +
        candle.low +
        candle.close
      ) / 3;

    priceTotal += typical;
    weightTotal += 1;

    result[i] =
      priceTotal / weightTotal;
  }

  return result;
}


/* =========================================================
   CANDLE HELPERS
========================================================= */

function bullish(candle) {
  return candle.close > candle.open;
}

function bearish(candle) {
  return candle.close < candle.open;
}


/* =========================================================
   LIQUIDITY SWEEP
========================================================= */

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
    previousLow =
      Math.min(
        previousLow,
        candles[i].low
      );

    previousHigh =
      Math.max(
        previousHigh,
        candles[i].high
      );
  }

  const buy =
    current.low < previousLow &&
    current.close > previousLow &&
    bullish(current);

  const sell =
    current.high > previousHigh &&
    current.close < previousHigh &&
    bearish(current);

  return {
    buy,
    sell
  };
}


function findRecentSweep(candles, index) {
  const result = {
    buy: false,
    sell: false,
    index: -1
  };

  const start =
    Math.max(
      LOOKBACK,
      index - SWEEP_WINDOW
    );

  for (
    let i = index;
    i >= start;
    i--
  ) {
    const sweep =
      detectSweepAt(
        candles,
        i
      );

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


/* =========================================================
   STRUCTURE
========================================================= */

function detectStructureAt(candles, index) {
  if (
    index <
    STRUCTURE_LOOKBACK + 1
  ) {
    return {
      buy: false,
      sell: false
    };
  }

  const current =
    candles[index];

  let recentHigh = -Infinity;
  let recentLow = Infinity;

  for (
    let i =
      index - STRUCTURE_LOOKBACK;
    i < index;
    i++
  ) {
    recentHigh =
      Math.max(
        recentHigh,
        candles[i].high
      );

    recentLow =
      Math.min(
        recentLow,
        candles[i].low
      );
  }

  return {
    buy:
      current.close >
      recentHigh,

    sell:
      current.close <
      recentLow
  };
}


function findRecentStructure(
  candles,
  index
) {
  const result = {
    buy: false,
    sell: false,
    index: -1
  };

  const start =
    Math.max(
      STRUCTURE_LOOKBACK + 1,
      index - STRUCTURE_WINDOW
    );

  for (
    let i = index;
    i >= start;
    i--
  ) {
    const structure =
      detectStructureAt(
        candles,
        i
      );

    if (structure.buy) {
      result.buy = true;
      result.index = i;
      break;
    }

    if (structure.sell) {
      result.sell = true;
      result.index = i;
      break;
    }
  }

  return result;
}


/* =========================================================
   MOMENTUM
========================================================= */

function momentum(
  candles,
  index,
  atr
) {
  const current =
    candles[index];

  const previous =
    candles[index - 1];

  if (!atr[index]) {
    return {
      buy: false,
      sell: false
    };
  }

  const body =
    Math.abs(
      current.close -
      current.open
    );

  const strongBody =
    body >=
    atr[index] * 0.15;

  return {
    buy:
      strongBody &&
      bullish(current) &&
      current.close >
        previous.close,

    sell:
      strongBody &&
      bearish(current) &&
      current.close <
        previous.close
  };
}


/* =========================================================
   SWING LEVELS
========================================================= */

function getSwingLow(
  candles,
  start,
  end
) {
  let value = Infinity;

  for (
    let i = start;
    i <= end;
    i++
  ) {
    value =
      Math.min(
        value,
        candles[i].low
      );
  }

  return value;
}


function getSwingHigh(
  candles,
  start,
  end
) {
  let value = -Infinity;

  for (
    let i = start;
    i <= end;
    i++
  ) {
    value =
      Math.max(
        value,
        candles[i].high
      );
  }

  return value;
}


/* =========================================================
   ANALYZE SIGNAL
========================================================= */

function analyzeSignal(candles) {
  if (
    !Array.isArray(candles) ||
    candles.length < MIN_CANDLES
  ) {
    return {
      signal: "WAITING",
      reason:
        "Not enough candles"
    };
  }

  /*
    Ignore newest candle.
    This guarantees that the engine never uses
    an unfinished candle for confirmation.
  */

  const closed =
    candles.slice(0, -1);

  if (closed.length < 55) {
    return {
      signal: "WAITING",
      reason:
        "Not enough closed candles"
    };
  }

  const index =
    closed.length - 1;

  const current =
    closed[index];

  const closes =
    closed.map(
      candle =>
        candle.close
    );

  const ema20 =
    emaSeries(
      closes,
      EMA_FAST
    );

  const ema50 =
    emaSeries(
      closes,
      EMA_SLOW
    );

  const atr =
    atrSeries(
      closed,
      ATR_PERIOD
    );

  const vwap =
    vwapSeries(
      closed
    );

  if (
    !ema20[index] ||
    !ema50[index] ||
    !atr[index] ||
    !vwap[index]
  ) {
    return {
      signal: "WAITING",
      reason:
        "Indicators unavailable"
    };
  }

  const recentSweep =
    findRecentSweep(
      closed,
      index
    );

  const recentStructure =
    findRecentStructure(
      closed,
      index
    );

  const momentumResult =
    momentum(
      closed,
      index,
      atr
    );

  const previousEma20 =
    ema20[index - 1];

  const emaRising =
    ema20[index] >
    previousEma20;

  const emaFalling =
    ema20[index] <
    previousEma20;

  const trendBuy =
    (
      ema20[index] >
      ema50[index] ||
      current.close >
      ema20[index]
    ) &&
    emaRising;

  const trendSell =
    (
      ema20[index] <
      ema50[index] ||
      current.close <
      ema20[index]
    ) &&
    emaFalling;

  const vwapBuy =
    current.close >
    vwap[index];

  const vwapSell =
    current.close <
    vwap[index];

  const volatilityOK =
    atr[index] >
    MIN_ATR;

  const buySecondary =
    [
      vwapBuy,
      momentumResult.buy,
      volatilityOK
    ].filter(Boolean).length;

  const sellSecondary =
    [
      vwapSell,
      momentumResult.sell,
      volatilityOK
    ].filter(Boolean).length;

  const buySignal =
    recentSweep.buy &&
    recentStructure.buy &&
    trendBuy &&
    buySecondary >= 2;

  const sellSignal =
    recentSweep.sell &&
    recentStructure.sell &&
    trendSell &&
    sellSecondary >= 2;

  let signal =
    "WAITING";

  if (
    buySignal &&
    !sellSignal
  ) {
    signal = "BUY";
  }

  if (
    sellSignal &&
    !buySignal
  ) {
    signal = "SELL";
  }

  const baseChecks = {
    liquiditySweep:
      recentSweep.buy ||
      recentSweep.sell,

    structure:
      recentStructure.buy ||
      recentStructure.sell,

    ema:
      trendBuy ||
      trendSell,

    vwap:
      vwapBuy ||
      vwapSell,

    momentum:
      momentumResult.buy ||
      momentumResult.sell,

    volatility:
      volatilityOK,

    candleClose:
      true,

    nonRepainting:
      true,

    buySecondary,
    sellSecondary
  };

  if (
    signal === "WAITING"
  ) {
    return {
      signal: "WAITING",
      candleTime:
        current.time,
      checks:
        baseChecks
    };
  }

  const entry =
    current.close;

  let stopLoss;
  let takeProfit;

  if (signal === "BUY") {
    const sweepIndex =
      recentSweep.index >= 0
        ? recentSweep.index
        : index;

    const start =
      Math.max(
        0,
        Math.min(
          sweepIndex,
          index
        ) - 2
      );

    const swingLow =
      getSwingLow(
        closed,
        start,
        index
      );

    stopLoss =
      Math.min(
        swingLow,
        entry -
          atr[index] *
          ATR_SL_MULTIPLIER
      );

    const risk =
      entry -
      stopLoss;

    if (risk <= 0) {
      return {
        signal: "WAITING",
        candleTime:
          current.time,
        reason:
          "Invalid BUY risk",
        checks:
          baseChecks
      };
    }

    takeProfit =
      entry +
      risk *
      RR_TARGET;
  }

  if (signal === "SELL") {
    const sweepIndex =
      recentSweep.index >= 0
        ? recentSweep.index
        : index;

    const start =
      Math.max(
        0,
        Math.min(
          sweepIndex,
          index
        ) - 2
      );

    const swingHigh =
      getSwingHigh(
        closed,
        start,
        index
      );

    stopLoss =
      Math.max(
        swingHigh,
        entry +
          atr[index] *
          ATR_SL_MULTIPLIER
      );

    const risk =
      stopLoss -
      entry;

    if (risk <= 0) {
      return {
        signal: "WAITING",
        candleTime:
          current.time,
        reason:
          "Invalid SELL risk",
        checks:
          baseChecks
      };
    }

    takeProfit =
      entry -
      risk *
      RR_TARGET;
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

  if (rr < MIN_RR) {
    return {
      signal: "WAITING",
      candleTime:
        current.time,
      reason:
        "Risk/reward below minimum",
      checks:
        baseChecks
    };
  }

  return {
    signal,

    candleTime:
      current.time,

    entry:
      Number(
        entry.toFixed(2)
      ),

    stopLoss:
      Number(
        stopLoss.toFixed(2)
      ),

    takeProfit:
      Number(
        takeProfit.toFixed(2)
      ),

    riskReward:
      Number(
        rr.toFixed(2)
      ),

    checks: {
      ...baseChecks,

      liquiditySweep:
        signal === "BUY"
          ? recentSweep.buy
          : recentSweep.sell,

      structure:
        signal === "BUY"
          ? recentStructure.buy
          : recentStructure.sell,

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

      volatility:
        volatilityOK
    }
  };
}


/* =========================================================
   TWELVE DATA CANDLES
========================================================= */

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

  if (
    !response.ok ||
    data.status === "error"
  ) {
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
      time:
        candle.datetime,

      open:
        Number(candle.open),

      high:
        Number(candle.high),

      low:
        Number(candle.low),

      close:
        Number(candle.close),

      volume:
        candle.volume
          ? Number(candle.volume)
          : null
    }));
}


/* =========================================================
   TWELVE DATA LIVE PRICE
========================================================= */

async function getLivePrice(env) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY secret is not configured."
    );
  }

  const apiUrl =
    "https://api.twelvedata.com/price" +
    "?symbol=XAU/USD" +
    "&apikey=" +
    encodeURIComponent(
      env.TWELVE_DATA_API_KEY
    );

  const response =
    await fetch(apiUrl);

  const data =
    await response.json();

  if (
    !response.ok ||
    data.status === "error" ||
    !data.price
  ) {
    throw new Error(
      "Twelve Data price request failed: " +
      JSON.stringify(data)
    );
  }

  return Number(data.price);
}


/* =========================================================
   TELEGRAM
========================================================= */

async function sendTelegram(
  env,
  signal
) {
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
    `${env.TELEGRAM_BOT_TOKEN}` +
    `/sendMessage`;

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

          text:
            message
        })
      }
    );

  const result =
    await response.json();

  if (
    !response.ok ||
    !result.ok
  ) {
    throw new Error(
      "Telegram request failed: " +
      JSON.stringify(result)
    );
  }

  return result;
}


/* =========================================================
   SCAN + NOTIFY
========================================================= */

async function scanAndNotify(
  env
) {
  const candles =
    await getCandles(env);

  const signal =
    analyzeSignal(
      candles
    );

  if (
    signal.signal ===
    "WAITING"
  ) {
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
      ? await env.SIGNAL_CACHE.get(
          signalKey
        )
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
        expirationTtl:
          86400
      }
    );
  }

  return {
    ok: true,
    notified: true,
    signal
  };
}


/* =========================================================
   WORKER
========================================================= */

export default {

  async fetch(
    request,
    env
  ) {

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          headers:
            corsHeaders
        }
      );
    }

    const url =
      new URL(
        request.url
      );


    /* -----------------------------------------------------
       STATUS
    ----------------------------------------------------- */

    if (
      url.pathname ===
      "/api/status"
    ) {
      return json({
        ok: true,

        service:
          "XAU AI CHART API",

        status:
          "online",

        market:
          "XAUUSD",

        timeframe:
          "M5",

        goldApi:
          false,

        twelveData:
          !!env.TWELVE_DATA_API_KEY,

        telegram:
          !!env.TELEGRAM_BOT_TOKEN &&
          !!env.TELEGRAM_CHAT_ID,

        signalEngine:
          "Higher-frequency Sweep + Recent Structure + EMA + 2/3 confirmation",

        priceSource:
          "Twelve Data"
      });
    }


    /* -----------------------------------------------------
       LIVE GOLD PRICE
    ----------------------------------------------------- */

    if (
      url.pathname ===
      "/api/gold"
    ) {

      try {

        const price =
          await getLivePrice(
            env
          );

        return json({
          ok: true,

          market:
            "XAUUSD",

          price,

          source:
            "Twelve Data"
        });

      } catch (error) {

        return json(
          {
            ok: false,

            error:
              "Live XAUUSD price request failed.",

            details:
              error.message
          },
          500
        );
      }
    }


    /* -----------------------------------------------------
       CANDLES
    ----------------------------------------------------- */

    if (
      url.pathname ===
      "/api/candles"
    ) {

      try {

        const candles =
          await getCandles(
            env
          );

        return json({
          ok: true,

          market:
            "XAUUSD",

          timeframe:
            "M5",

          count:
            candles.length,

          candles,

          source:
            "Twelve Data"
        });

      } catch (error) {

        return json(
          {
            ok: false,

            error:
              "Twelve Data candle request failed.",

            details:
              error.message
          },
          500
        );
      }
    }


    /* -----------------------------------------------------
       SCAN
    ----------------------------------------------------- */

    if (
      url.pathname ===
      "/api/scan"
    ) {

      try {

        const result =
          await scanAndNotify(
            env
          );

        return json(
          result
        );

      } catch (error) {

        return json(
          {
            ok: false,

            error:
              error.message
          },
          500
        );
      }
    }


    /* -----------------------------------------------------
       WEBSITE ASSETS
    ----------------------------------------------------- */

    return env.ASSETS.fetch(
      request
    );
  },


  /* =======================================================
     CRON
  ======================================================= */

  async scheduled(
    event,
    env,
    ctx
  ) {

    ctx.waitUntil(
      scanAndNotify(
        env
      )
      .catch(
        error => {
          console.error(
            "Scheduled XAU scan failed:",
            error.message
          );
        }
      )
    );
  }
};
