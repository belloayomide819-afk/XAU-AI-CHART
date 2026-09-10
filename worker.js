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
const SIGNAL_CLAIM_TTL = 300;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

function roundPrice(value) {
  return Number(Number(value).toFixed(2));
}

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

function bullish(candle) {
  return candle.close > candle.open;
}

function bearish(candle) {
  return candle.close < candle.open;
}

function candleBodyPercentage(candle) {
  const range = candle.high - candle.low;

  if (range <= 0) {
    return 0;
  }

  return Math.abs(candle.close - candle.open) / range * 100;
}

function highest(candles, start, end) {
  let value = -Infinity;

  for (let i = start; i < end; i++) {
    value = Math.max(value, candles[i].high);
  }

  return value;
}

function lowest(candles, start, end) {
  let value = Infinity;

  for (let i = start; i < end; i++) {
    value = Math.min(value, candles[i].low);
  }

  return value;
}

function calculateEMA(candles, period) {
  if (candles.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let emaValue =
    candles
      .slice(0, period)
      .reduce((sum, candle) => sum + candle.close, 0) / period;

  for (let i = period; i < candles.length; i++) {
    emaValue =
      (candles[i].close - emaValue) * multiplier + emaValue;
  }

  return emaValue;
}

function calculatePreviousEMA(candles, period) {
  if (candles.length < period + 1) {
    return null;
  }

  return calculateEMA(candles.slice(0, -1), period);
}

function calculateATR(candles, period) {
  if (candles.length < period + 1) {
    return null;
  }

  const trueRanges = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    return null;
  }

  let atr =
    trueRanges
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr =
      ((atr * (period - 1)) + trueRanges[i]) / period;
  }

  return atr;
}

function calculateVWAP(candles) {
  if (!candles.length) {
    return null;
  }

  let totalPrice = 0;
  let totalWeight = 0;

  for (const candle of candles) {
    const typicalPrice =
      (candle.high + candle.low + candle.close) / 3;

    const weight =
      Math.max(candle.high - candle.low, 0.01);

    totalPrice += typicalPrice * weight;
    totalWeight += weight;
  }

  if (totalWeight <= 0) {
    return null;
  }

  return totalPrice / totalWeight;
}

function getRecentSweep(candles) {
  if (candles.length < LOOKBACK + 1) {
    return {
      buy: null,
      sell: null
    };
  }

  const start =
    Math.max(
      LOOKBACK,
      candles.length - SWEEP_WINDOW
    );

  let buy = null;
  let sell = null;

  for (let i = start; i < candles.length; i++) {
    const current = candles[i];

    const previousLow =
      lowest(candles, i - LOOKBACK, i);

    const previousHigh =
      highest(candles, i - LOOKBACK, i);

    const body =
      candleBodyPercentage(current);

    const buySweep =
      current.low < previousLow &&
      current.close > previousLow &&
      bullish(current) &&
      body >= 35;

    const sellSweep =
      current.high > previousHigh &&
      current.close < previousHigh &&
      bearish(current) &&
      body >= 35;

    if (buySweep) {
      buy = {
        index: i,
        time: current.time,
        level: previousLow
      };
    }

    if (sellSweep) {
      sell = {
        index: i,
        time: current.time,
        level: previousHigh
      };
    }
  }

  return {
    buy,
    sell
  };
}

function getRecentStructure(candles) {
  if (candles.length < STRUCTURE_LOOKBACK + 1) {
    return {
      buy: null,
      sell: null
    };
  }

  const start =
    Math.max(
      STRUCTURE_LOOKBACK,
      candles.length - STRUCTURE_WINDOW
    );

  let buy = null;
  let sell = null;

  for (let i = start; i < candles.length; i++) {
    const current = candles[i];

    const recentHigh =
      highest(
        candles,
        i - STRUCTURE_LOOKBACK,
        i
      );

    const recentLow =
      lowest(
        candles,
        i - STRUCTURE_LOOKBACK,
        i
      );

    const body =
      candleBodyPercentage(current);

    const buyStructure =
      current.close > recentHigh &&
      bullish(current) &&
      body >= 35;

    const sellStructure =
      current.close < recentLow &&
      bearish(current) &&
      body >= 35;

    if (buyStructure) {
      buy = {
        index: i,
        time: current.time,
        level: recentHigh
      };
    }

    if (sellStructure) {
      sell = {
        index: i,
        time: current.time,
        level: recentLow
      };
    }
  }

  return {
    buy,
    sell
  };
}

function getTrend(candles) {
  const ema20 =
    calculateEMA(candles, EMA_FAST);

  const ema50 =
    calculateEMA(candles, EMA_SLOW);

  const previousEMA20 =
    calculatePreviousEMA(candles, EMA_FAST);

  const previousEMA50 =
    calculatePreviousEMA(candles, EMA_SLOW);

  if (
    ema20 === null ||
    ema50 === null ||
    previousEMA20 === null ||
    previousEMA50 === null
  ) {
    return {
      buy: false,
      sell: false,
      ema20: null,
      ema50: null
    };
  }

  const buy =
    ema20 > ema50 &&
    ema20 > previousEMA20;

  const sell =
    ema20 < ema50 &&
    ema20 < previousEMA20;

  return {
    buy,
    sell,
    ema20,
    ema50,
    previousEMA20,
    previousEMA50
  };
}

function getMomentum(candles) {
  if (candles.length < 4) {
    return {
      buy: false,
      sell: false
    };
  }

  const current =
    candles[candles.length - 1];

  const previous =
    candles[candles.length - 2];

  const older =
    candles[candles.length - 4];

  const buy =
    current.close > previous.close &&
    previous.close > older.close;

  const sell =
    current.close < previous.close &&
    previous.close < older.close;

  return {
    buy,
    sell
  };
}

function buildSignal(candles) {
  if (candles.length < MIN_CANDLES) {
    return {
      signal: "WAITING",
      reason: "Not enough candles"
    };
  }

  /*
    Use only CLOSED candles.
    The newest Twelve Data candle may still be forming.
  */
  const closed =
    candles.slice(0, -1);

  if (closed.length < MIN_CANDLES - 1) {
    return {
      signal: "WAITING",
      reason: "Not enough closed candles"
    };
  }

  const current =
    closed[closed.length - 1];

  const atr =
    calculateATR(
      closed,
      ATR_PERIOD
    );

  const vwap =
    calculateVWAP(closed);

  const trend =
    getTrend(closed);

  const momentum =
    getMomentum(closed);

  const sweep =
    getRecentSweep(closed);

  const structure =
    getRecentStructure(closed);

  const buySweep =
    !!sweep.buy;

  const sellSweep =
    !!sweep.sell;

  const buyStructure =
    !!structure.buy;

  const sellStructure =
    !!structure.sell;

  /*
    Higher-frequency trigger:
    Sweep OR recent structure.
  */
  const buyTrigger =
    buySweep || buyStructure;

  const sellTrigger =
    sellSweep || sellStructure;

  const vwapBuy =
    vwap !== null &&
    current.close > vwap;

  const vwapSell =
    vwap !== null &&
    current.close < vwap;

  const momentumBuy =
    momentum.buy;

  const momentumSell =
    momentum.sell;

  const atrConfirmed =
    atr !== null &&
    atr >= MIN_ATR;

  /*
    Require at least 2 of:
    VWAP
    Momentum
    ATR
  */
  const buySecondary =
    Number(vwapBuy) +
    Number(momentumBuy) +
    Number(atrConfirmed);

  const sellSecondary =
    Number(vwapSell) +
    Number(momentumSell) +
    Number(atrConfirmed);

  const buyValid =
    buyTrigger &&
    trend.buy &&
    buySecondary >= 2;

  const sellValid =
    sellTrigger &&
    trend.sell &&
    sellSecondary >= 2;

  const checks = {
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
      vwapBuy || vwapSell
        ? "CONFIRMED"
        : "WAIT",

    momentum:
      momentumBuy || momentumSell
        ? "CONFIRMED"
        : "WAIT",

    atr:
      atrConfirmed
        ? "CONFIRMED"
        : "WAIT",

    rr: "WAIT",

    candleClose: "CONFIRMED",

    nonRepainting: "ACTIVE"
  };

  if (!buyValid && !sellValid) {
    return {
      signal: "WAITING",
      entry: null,
      stopLoss: null,
      takeProfit: null,
      rr: null,
      candleTime: current.time,
      setupAnchor: null,
      checks
    };
  }

  let signal;
  let setup;
  let stopLoss;
  let risk;

  if (buyValid && !sellValid) {
    signal = "BUY";

    setup =
      sweep.buy ||
      structure.buy;

    const recentSwingLow =
      lowest(
        closed,
        Math.max(
          0,
          closed.length - 7
        ),
        closed.length
      );

    const atrStop =
      current.close -
      atr * ATR_SL_MULTIPLIER;

    stopLoss =
      Math.min(
        recentSwingLow,
        atrStop
      );

    risk =
      current.close -
      stopLoss;

  } else if (sellValid && !buyValid) {
    signal = "SELL";

    setup =
      sweep.sell ||
      structure.sell;

    const recentSwingHigh =
      highest(
        closed,
        Math.max(
          0,
          closed.length - 7
        ),
        closed.length
      );

    const atrStop =
      current.close +
      atr * ATR_SL_MULTIPLIER;

    stopLoss =
      Math.max(
        recentSwingHigh,
        atrStop
      );

    risk =
      stopLoss -
      current.close;

  } else {
    return {
      signal: "WAITING",
      reason: "Conflicting BUY and SELL setups",
      candleTime: current.time,
      setupAnchor: null,
      checks
    };
  }

  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {
    return {
      signal: "WAITING",
      reason: "Invalid risk distance",
      candleTime: current.time,
      setupAnchor: null,
      checks
    };
  }

  const entry =
    current.close;

  const takeProfit =
    signal === "BUY"
      ? entry + risk * TARGET_RR
      : entry - risk * TARGET_RR;

  const rr =
    Math.abs(
      takeProfit - entry
    ) /
    Math.abs(
      entry - stopLoss
    );

  if (rr < MIN_RR) {
    return {
      signal: "WAITING",
      reason: "RR below minimum",
      candleTime: current.time,
      setupAnchor: null,
      checks: {
        ...checks,
        rr: "WAIT"
      }
    };
  }

  checks.rr =
    "CONFIRMED";

  return {
    signal,

    entry:
      roundPrice(entry),

    stopLoss:
      roundPrice(stopLoss),

    takeProfit:
      roundPrice(takeProfit),

    rr:
      Number(rr.toFixed(2)),

    candleTime:
      current.time,

    /*
      This identifies the actual setup.
      Same setup = no repeated Telegram alert.
    */
    setupAnchor:
      setup
        ? setup.time
        : current.time,

    checks,

    details: {
      sweep:
        signal === "BUY"
          ? buySweep
          : sellSweep,

      structure:
        signal === "BUY"
          ? buyStructure
          : sellStructure,

      ema:
        signal === "BUY"
          ? trend.buy
          : trend.sell,

      vwap:
        signal === "BUY"
          ? vwapBuy
          : vwapSell,

      momentum:
        signal === "BUY"
          ? momentumBuy
          : momentumSell,

      atr:
        atrConfirmed
    }
  };
}

async function getCandles(env) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=XAU/USD" +
    "&interval=5min" +
    "&outputsize=100" +
    "&apikey=" +
    encodeURIComponent(
      env.TWELVE_DATA_API_KEY
    );

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (
    !response.ok ||
    data.status === "error"
  ) {
    throw new Error(
      data.message ||
      "Twelve Data candle request failed."
    );
  }

  if (!Array.isArray(data.values)) {
    throw new Error(
      "Twelve Data returned no candle data."
    );
  }

  return data.values
    .map(candle => ({
      time: candle.datetime,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close)
    }))
    .filter(candle =>
      Number.isFinite(candle.open) &&
      Number.isFinite(candle.high) &&
      Number.isFinite(candle.low) &&
      Number.isFinite(candle.close)
    )
    .reverse();
}

async function getLivePrice(env) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const url =
    "https://api.twelvedata.com/price" +
    "?symbol=XAU/USD" +
    "&apikey=" +
    encodeURIComponent(
      env.TWELVE_DATA_API_KEY
    );

  const response =
    await fetch(url);

  const data =
    await response.json();

  if (
    !response.ok ||
    data.status === "error"
  ) {
    throw new Error(
      data.message ||
      "Twelve Data price request failed."
    );
  }

  const price =
    Number(data.price);

  if (!Number.isFinite(price)) {
    throw new Error(
      "Invalid XAU/USD price from Twelve Data."
    );
  }

  return roundPrice(price);
}

async function telegramRequest(
  env,
  method,
  body = {}
) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return {
      ok: false,
      error:
        "TELEGRAM_BOT_TOKEN is missing."
    };
  }

  const url =
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`;

  try {
    const response =
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify(body)
      });

    let data;

    try {
      data =
        await response.json();
    } catch {
      return {
        ok: false,
        error:
          `Telegram returned HTTP ${response.status} with an invalid response.`
      };
    }

    if (
      !response.ok ||
      data.ok !== true
    ) {
      return {
        ok: false,
        error:
          data.description ||
          `Telegram returned HTTP ${response.status}.`,
        errorCode:
          data.error_code ||
          response.status
      };
    }

    return {
      ok: true,
      result: data.result
    };

  } catch (error) {
    return {
      ok: false,
      error:
        error?.message ||
        "Telegram network request failed."
    };
  }
}

async function sendTelegram(
  env,
  signal
) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return {
      sent: false,
      error:
        "TELEGRAM_BOT_TOKEN is missing."
    };
  }

  if (!env.TELEGRAM_CHAT_ID) {
    return {
      sent: false,
      error:
        "TELEGRAM_CHAT_ID is missing."
    };
  }

  const message =
`XAU AI CHART

${signal.signal} XAUUSD M5

Entry: ${signal.entry}
SL: ${signal.stopLoss}
TP: ${signal.takeProfit}
RR: ${signal.rr}

Sweep: ${signal.checks.sweep}
Structure: ${signal.checks.structure}
EMA: ${signal.checks.ema}
VWAP: ${signal.checks.vwap}
Momentum: ${signal.checks.momentum}
ATR: ${signal.checks.atr}

Candle: ${signal.candleTime}

Closed candle confirmed.
Non-repainting system.`;

  const result =
    await telegramRequest(
      env,
      "sendMessage",
      {
        chat_id:
          String(
            env.TELEGRAM_CHAT_ID
          ),
        text: message
      }
    );

  if (!result.ok) {
    return {
      sent: false,
      error: result.error,
      errorCode:
        result.errorCode || null
    };
  }

  return {
    sent: true,
    error: null,
    errorCode: null
  };
}

async function testTelegram(env) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return {
      ok: false,
      stage: "configuration",
      error:
        "TELEGRAM_BOT_TOKEN is missing."
    };
  }

  if (!env.TELEGRAM_CHAT_ID) {
    return {
      ok: false,
      stage: "configuration",
      error:
        "TELEGRAM_CHAT_ID is missing."
    };
  }

  const bot =
    await telegramRequest(
      env,
      "getMe"
    );

  if (!bot.ok) {
    return {
      ok: false,
      stage: "getMe",
      error: bot.error,
      errorCode:
        bot.errorCode || null
    };
  }

  const botInfo = {
    id:
      bot.result?.id || null,

    username:
      bot.result?.username || null,

    firstName:
      bot.result?.first_name || null
  };

  const message =
`XAU AI CHART

Telegram connection test successful.

Bot: @${botInfo.username || "unknown"}

Your Telegram alerts are connected and ready.`;

  const sent =
    await telegramRequest(
      env,
      "sendMessage",
      {
        chat_id:
          String(
            env.TELEGRAM_CHAT_ID
          ),
        text: message
      }
    );

  if (!sent.ok) {
    return {
      ok: false,
      stage: "sendMessage",
      bot: botInfo,
      error: sent.error,
      errorCode:
        sent.errorCode || null
    };
  }

  return {
    ok: true,
    stage: "complete",
    bot: botInfo,
    messageSent: true
  };
}

async function getDailySignalCount(env) {
  if (!env.SIGNAL_CACHE) {
    return 0;
  }

  const key =
    `daily-count-${dayKey()}`;

  const value =
    await env.SIGNAL_CACHE.get(key);

  return Number(
    value || 0
  );
}

async function incrementDailySignalCount(env) {
  if (!env.SIGNAL_CACHE) {
    return;
  }

  const key =
    `daily-count-${dayKey()}`;

  const current =
    await getDailySignalCount(env);

  await env.SIGNAL_CACHE.put(
    key,
    String(current + 1),
    {
      expirationTtl: 172800
    }
  );
}

/*
  Every valid setup gets one deterministic ID.

  Example:
  signal-SELL-2026-09-11 00:15:00

  Same setup = same ID.
*/
function getSignalId(signal) {
  return (
    `${signal.signal}-${signal.setupAnchor}`
  );
}

function getSentKey(signal) {
  return (
    `signal-sent-${getSignalId(signal)}`
  );
}

function getClaimKey(signal) {
  return (
    `signal-claim-${getSignalId(signal)}`
  );
}

/*
  Check whether this setup has already
  successfully sent a Telegram alert.
*/
async function alreadySent(env, signal) {
  if (!env.SIGNAL_CACHE) {
    return false;
  }

  const key =
    getSentKey(signal);

  const value =
    await env.SIGNAL_CACHE.get(key);

  return !!value;
}

/*
  Claim the setup BEFORE sending Telegram.

  This prevents multiple scans from all
  sending the same signal at the same time.
*/
async function claimSignal(env, signal) {
  if (!env.SIGNAL_CACHE) {
    return true;
  }

  const sentKey =
    getSentKey(signal);

  const claimKey =
    getClaimKey(signal);

  const alreadyDone =
    await env.SIGNAL_CACHE.get(
      sentKey
    );

  if (alreadyDone) {
    return false;
  }

  const existingClaim =
    await env.SIGNAL_CACHE.get(
      claimKey
    );

  if (existingClaim) {
    return false;
  }

  /*
    Create a short-lived claim.
    This blocks another scan from
    sending the same setup immediately.
  */
  await env.SIGNAL_CACHE.put(
    claimKey,
    "claimed",
    {
      expirationTtl:
        SIGNAL_CLAIM_TTL
    }
  );

  return true;
}

async function markSent(env, signal) {
  if (!env.SIGNAL_CACHE) {
    return;
  }

  const sentKey =
    getSentKey(signal);

  await env.SIGNAL_CACHE.put(
    sentKey,
    "sent",
    {
      expirationTtl:
        SIGNAL_TTL
    }
  );
}

async function releaseClaim(env, signal) {
  if (!env.SIGNAL_CACHE) {
    return;
  }

  const claimKey =
    getClaimKey(signal);

  await env.SIGNAL_CACHE.delete(
    claimKey
  );
}

/*
  Process an already-built signal.

  This is the ONLY place where automatic
  Telegram notifications are sent.
*/
async function processSignal(
  env,
  signal
) {
  if (
    signal.signal !== "BUY" &&
    signal.signal !== "SELL"
  ) {
    return {
      ok: true,
      ...signal,
      telegramSent: false
    };
  }

  const dailyCount =
    await getDailySignalCount(env);

  if (
    dailyCount >=
    MAX_SIGNALS_PER_DAY
  ) {
    return {
      ok: true,
      ...signal,
      telegramSent: false,
      telegramError: null,
      blocked:
        "MAX_SIGNALS_PER_DAY"
    };
  }

  const duplicate =
    await alreadySent(
      env,
      signal
    );

  if (duplicate) {
    return {
      ok: true,
      ...signal,
      telegramSent: false,
      telegramError: null,
      duplicate: true
    };
  }

  /*
    Claim BEFORE Telegram send.
  */
  const claimed =
    await claimSignal(
      env,
      signal
    );

  if (!claimed) {
    return {
      ok: true,
      ...signal,
      telegramSent: false,
      telegramError: null,
      duplicate: true,
      claimedByAnotherScan: true
    };
  }

  const telegram =
    await sendTelegram(
      env,
      signal
    );

  if (telegram.sent) {
    await markSent(
      env,
      signal
    );

    await incrementDailySignalCount(
      env
    );

    return {
      ok: true,
      ...signal,
      telegramSent: true,
      telegramError: null,
      telegramErrorCode: null
    };
  }

  /*
    Telegram failed.
    Release the claim so the next Cron
    run can try again.
  */
  await releaseClaim(
    env,
    signal
  );

  return {
    ok: true,
    ...signal,
    telegramSent: false,
    telegramError:
      telegram.error || null,
    telegramErrorCode:
      telegram.errorCode || null
  };
}

/*
  Automatic Cron scanner.
*/
async function scanAndNotify(env) {
  const candles =
    await getCandles(env);

  const signal =
    buildSignal(candles);

  return processSignal(
    env,
    signal
  );
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

    try {
      if (url.pathname === "/") {
        return json({
          ok: true,
          service:
            "XAU AI CHART API",
          status: "online"
        });
      }

      if (url.pathname === "/api/status") {
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
          telegramTest: true,

          signalEngine:
            "Higher-frequency Sweep OR Structure + EMA + 2/3 confirmation",

          priceSource:
            "Twelve Data",

          maxSignalsPerDay:
            MAX_SIGNALS_PER_DAY,

          notificationMode:
            "Cron-only automatic Telegram"
        });
      }

      if (url.pathname === "/api/gold") {
        const price =
          await getLivePrice(env);

        return json({
          ok: true,
          symbol: "XAUUSD",
          price,
          source:
            "Twelve Data"
        });
      }

      if (url.pathname === "/api/candles") {
        const candles =
          await getCandles(env);

        return json({
          ok: true,
          symbol: "XAUUSD",
          timeframe: "M5",
          candles
        });
      }

      /*
        IMPORTANT:

        /api/scan now ONLY reads/scans the market.

        It does NOT send Telegram by default.

        This means your website can refresh
        every 15 seconds without producing
        duplicate Telegram alerts.

        If you specifically want to manually
        trigger a Telegram signal, use:

        /api/scan?notify=1
      */
      if (url.pathname === "/api/scan") {
        const candles =
          await getCandles(env);

        const signal =
          buildSignal(candles);

        const notify =
          url.searchParams.get(
            "notify"
          ) === "1";

        if (!notify) {
          return json({
            ok: true,
            ...signal,
            telegramSent: false,
            notificationMode:
              "Cron-only"
          });
        }

        const result =
          await processSignal(
            env,
            signal
          );

        return json(result);
      }

      if (
        url.pathname ===
        "/api/telegram-test"
      ) {
        const result =
          await testTelegram(env);

        return json(
          result,
          result.ok
            ? 200
            : 400
        );
      }

      return json(
        {
          ok: false,
          error:
            "Endpoint not found."
        },
        404
      );

    } catch (error) {
      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Server error."
        },
        500
      );
    }
  },

  /*
    Cloudflare Cron:
    This is now the automatic Telegram
    notification engine.
  */
  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      scanAndNotify(env)
        .catch(() => {
          /*
            If one scan fails, the next
            Cron run will try again.
          */
        })
    );
  }
};
