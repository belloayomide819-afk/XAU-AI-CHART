import { DurableObject } from "cloudflare:workers";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const MIN_CANDLES = 60;
const LOOKBACK = 10;
const STRUCTURE_LOOKBACK = 5;

const ATR_PERIOD = 14;
const EMA_FAST = 20;
const EMA_SLOW = 50;

const MIN_ATR = 0.20;
const ATR_SL_MULTIPLIER = 1.10;

const MIN_RR = 2.0;
const TARGET_RR = 2.5;

const REARM_CANDLES = 2;

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

function bullish(c) {
  return c.close > c.open;
}

function bearish(c) {
  return c.close < c.open;
}

function candleBodyPercentage(c) {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return Math.abs(c.close - c.open) / range * 100;
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
  if (candles.length < period) return null;

  const multiplier = 2 / (period + 1);

  let ema =
    candles
      .slice(0, period)
      .reduce((sum, c) => sum + c.close, 0) / period;

  for (let i = period; i < candles.length; i++) {
    ema =
      (candles[i].close - ema) * multiplier + ema;
  }

  return ema;
}

function calculatePreviousEMA(candles, period) {
  if (candles.length < period + 1) return null;
  return calculateEMA(candles.slice(0, -1), period);
}

function calculateATR(candles, period) {
  if (candles.length < period + 1) return null;

  const trs = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close)
      )
    );
  }

  if (trs.length < period) return null;

  let atr =
    trs
      .slice(0, period)
      .reduce((sum, v) => sum + v, 0) / period;

  for (let i = period; i < trs.length; i++) {
    atr =
      ((atr * (period - 1)) + trs[i]) / period;
  }

  return atr;
}

function calculateVWAP(candles) {
  if (!candles.length) return null;

  let totalPrice = 0;
  let totalWeight = 0;

  for (const c of candles) {
    const typical =
      (c.high + c.low + c.close) / 3;

    const weight =
      Math.max(c.high - c.low, 0.01);

    totalPrice += typical * weight;
    totalWeight += weight;
  }

  return totalWeight > 0
    ? totalPrice / totalWeight
    : null;
}

/*
  FRESH LIQUIDITY SWEEP

  BUY:
  current candle takes previous lows,
  then closes back above that low.

  SELL:
  current candle takes previous highs,
  then closes back below that high.
*/
function getCurrentSweep(candles) {
  if (candles.length < LOOKBACK + 1) {
    return { buy: null, sell: null };
  }

  const i = candles.length - 1;
  const current = candles[i];

  const previousLow =
    lowest(candles, i - LOOKBACK, i);

  const previousHigh =
    highest(candles, i - LOOKBACK, i);

  const body =
    candleBodyPercentage(current);

  const buy =
    current.low < previousLow &&
    current.close > previousLow &&
    bullish(current) &&
    body >= 35;

  const sell =
    current.high > previousHigh &&
    current.close < previousHigh &&
    bearish(current) &&
    body >= 35;

  return {
    buy: buy
      ? {
          time: current.time,
          level: previousLow
        }
      : null,

    sell: sell
      ? {
          time: current.time,
          level: previousHigh
        }
      : null
  };
}

/*
  FRESH STRUCTURE BREAK

  Only the newest closed candle is allowed
  to create a new structure signal.
*/
function getCurrentStructure(candles) {
  if (candles.length < STRUCTURE_LOOKBACK + 1) {
    return { buy: null, sell: null };
  }

  const i = candles.length - 1;
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

  const buy =
    current.close > recentHigh &&
    bullish(current) &&
    body >= 35;

  const sell =
    current.close < recentLow &&
    bearish(current) &&
    body >= 35;

  return {
    buy: buy
      ? {
          time: current.time,
          level: recentHigh
        }
      : null,

    sell: sell
      ? {
          time: current.time,
          level: recentLow
        }
      : null
  };
}

/*
  BALANCED TREND

  We do NOT require EMA20 to be rising/falling.
  That was one reason BUY setups were being rejected.

  The main direction comes from EMA20 vs EMA50.
*/
function getTrend(candles) {
  const ema20 =
    calculateEMA(candles, EMA_FAST);

  const ema50 =
    calculateEMA(candles, EMA_SLOW);

  if (ema20 === null || ema50 === null) {
    return {
      buy: false,
      sell: false,
      ema20: null,
      ema50: null
    };
  }

  return {
    buy: ema20 > ema50,
    sell: ema20 < ema50,
    ema20,
    ema50
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

  return {
    buy:
      current.close > previous.close &&
      previous.close > older.close,

    sell:
      current.close < previous.close &&
      previous.close < older.close
  };
}

/*
  BUILD SIGNAL

  No forced trade.
  No repainting.
  Closed candles only.
*/
function buildSignal(candles) {
  if (candles.length < MIN_CANDLES) {
    return {
      signal: "WAITING",
      reason: "Not enough candles"
    };
  }

  /*
    Remove the currently forming candle.
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
    getCurrentSweep(closed);

  const structure =
    getCurrentStructure(closed);

  const buySweep =
    !!sweep.buy;

  const sellSweep =
    !!sweep.sell;

  const buyStructure =
    !!structure.buy;

  const sellStructure =
    !!structure.sell;

  /*
    A trade must have a fresh trigger.
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

  const buySecondary =
    Number(vwapBuy) +
    Number(momentumBuy) +
    Number(atrConfirmed);

  const sellSecondary =
    Number(vwapSell) +
    Number(momentumSell) +
    Number(atrConfirmed);

  /*
    Require:
      fresh trigger
      correct EMA side
      2 of 3 secondary confirmations
  */
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

  /*
    Never force a trade.
  */
  if (!buyValid && !sellValid) {
    return {
      signal: "WAITING",

      entry: null,
      stopLoss: null,
      takeProfit: null,
      rr: null,

      candleTime:
        current.time,

      setupAnchor: null,

      checks
    };
  }

  /*
    If both directions somehow qualify
    on the same candle, stay out.
  */
  if (buyValid && sellValid) {
    return {
      signal: "WAITING",

      reason:
        "Conflicting BUY and SELL setups",

      candleTime:
        current.time,

      setupAnchor: null,

      checks
    };
  }

  let signal;
  let setup;
  let stopLoss;
  let risk;

  if (buyValid) {
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

  } else {
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
  }

  if (
    !Number.isFinite(risk) ||
    risk <= 0
  ) {
    return {
      signal: "WAITING",

      reason:
        "Invalid risk distance",

      candleTime:
        current.time,

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

      reason:
        "RR below minimum",

      candleTime:
        current.time,

      setupAnchor: null,

      checks
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

    setupAnchor:
      setup?.time ||
      current.time,

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
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
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
          `Telegram returned HTTP ${response.status}.`
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
        "Telegram request failed."
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

Fresh setup confirmed.
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

      error:
        result.error,

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

  const sent =
    await telegramRequest(
      env,
      "sendMessage",
      {
        chat_id:
          String(
            env.TELEGRAM_CHAT_ID
          ),

        text:
`XAU AI CHART

Telegram connection test successful.

Bot: @${botInfo.username || "unknown"}

Your Telegram alerts are connected and ready.`
      }
    );

  if (!sent.ok) {
    return {
      ok: false,

      stage:
        "sendMessage",

      bot: botInfo,

      error:
        sent.error,

      errorCode:
        sent.errorCode || null
    };
  }

  return {
    ok: true,

    stage:
      "complete",

    bot:
      botInfo,

    messageSent:
      true
  };
}

/*
  =====================================================
  DURABLE OBJECT SIGNAL LOCK
  =====================================================

  This replaces the old KV-based active setup lock.

  Durable Objects serialize requests to the same object,
  so two scans cannot both successfully claim the same
  setup at the same time.
*/
export class XAUSetupLock extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async readState() {
    return (
      await this.ctx.storage.get("state")
    ) || {
      direction: null,
      anchor: null,
      lastSignalCandle: null,
      neutralCandles: 0,
      lastNeutralCandle: null,
      pending: null
    };
  }

  async writeState(state) {
    await this.ctx.storage.put(
      "state",
      state
    );

    return state;
  }

  async fetch(request) {
    const url =
      new URL(request.url);

    const state =
      await this.readState();

    /*
      READ STATE
    */
    if (url.pathname === "/state") {
      return json({
        ok: true,
        state
      });
    }

    /*
      NEUTRAL CANDLE

      Two distinct neutral candles reset
      the previous active setup.
    */
    if (url.pathname === "/neutral") {
      const body =
        await request.json();

      const candleTime =
        body.candleTime;

      if (
        state.lastNeutralCandle ===
        candleTime
      ) {
        return json({
          ok: true,
          state
        });
      }

      if (!state.direction) {
        return json({
          ok: true,
          state
        });
      }

      const neutralCandles =
        Number(
          state.neutralCandles || 0
        ) + 1;

      if (
        neutralCandles >=
        REARM_CANDLES
      ) {
        const reset = {
          direction: null,
          anchor: null,
          lastSignalCandle: null,
          neutralCandles: 0,
          lastNeutralCandle: null,
          pending: null
        };

        await this.writeState(reset);

        return json({
          ok: true,
          reset: true,
          state: reset
        });
      }

      state.neutralCandles =
        neutralCandles;

      state.lastNeutralCandle =
        candleTime;

      await this.writeState(state);

      return json({
        ok: true,
        state
      });
    }

    /*
      CLAIM A SIGNAL

      This is the important part.

      The DO decides whether this signal is:

      - NEW
      - SAME ACTIVE
      - REVERSAL
      - DUPLICATE

      before Telegram is contacted.
    */
    if (url.pathname === "/claim") {
      const body =
        await request.json();

      const signal =
        body.signal;

      const signalId =
        body.signalId;

      const candleTime =
        body.candleTime;

      if (
        signal !== "BUY" &&
        signal !== "SELL"
      ) {
        return json({
          ok: true,
          allowed: false,
          reason: "INVALID_DIRECTION"
        });
      }

      /*
        Another request is already sending
        this exact setup.
      */
      if (
        state.pending &&
        state.pending.signalId ===
          signalId
      ) {
        return json({
          ok: true,
          allowed: false,
          reason:
            "ALREADY_PENDING"
        });
      }

      /*
        Same direction already active.

        This prevents:

        SELL
        SELL
        SELL

        from being sent repeatedly.
      */
      if (
        state.direction === signal
      ) {
        return json({
          ok: true,
          allowed: false,
          reason:
            "SAME_ACTIVE_SETUP",

          activeDirection:
            state.direction
        });
      }

      /*
        Exact signal was already sent.
      */
      if (
        state.lastSignalCandle ===
          candleTime &&
        state.direction === signal
      ) {
        return json({
          ok: true,
          allowed: false,
          reason:
            "DUPLICATE_SIGNAL"
        });
      }

      /*
        New setup or genuine reversal.

        Lock it BEFORE Telegram is called.
      */
      state.pending = {
        signal,
        signalId,
        candleTime,
        createdAt:
          Date.now()
      };

      await this.writeState(state);

      return json({
        ok: true,

        allowed: true,

        action:
          state.direction
            ? "REVERSAL"
            : "NEW_SETUP"
      });
    }

    /*
      COMMIT

      Only called after Telegram succeeds.
    */
    if (url.pathname === "/commit") {
      const body =
        await request.json();

      const signal =
        body.signal;

      const signalId =
        body.signalId;

      if (
        !state.pending ||
        state.pending.signalId !==
          signalId
      ) {
        return json({
          ok: false,
          error:
            "No matching pending signal."
        });
      }

      state.direction =
        signal;

      state.anchor =
        body.anchor ||
        null;

      state.lastSignalCandle =
        body.candleTime ||
        null;

      state.neutralCandles =
        0;

      state.lastNeutralCandle =
        null;

      state.pending =
        null;

      await this.writeState(state);

      return json({
        ok: true,
        state
      });
    }

    /*
      RELEASE

      Telegram failed.
      Allow the next Cron to retry.
    */
    if (url.pathname === "/release") {
      const body =
        await request.json();

      if (
        state.pending &&
        state.pending.signalId ===
          body.signalId
      ) {
        state.pending =
          null;

        await this.writeState(state);
      }

      return json({
        ok: true,
        state
      });
    }

    return json(
      {
        ok: false,
        error:
          "Unknown Durable Object action."
      },
      404
    );
  }
}

function getSignalId(signal) {
  return (
    `${signal.signal}|${signal.setupAnchor}|${signal.candleTime}`
  );
}

async function callSetupLock(
  env,
  path,
  body
) {
  if (!env.XAU_SETUP_LOCK) {
    throw new Error(
      "XAU_SETUP_LOCK binding is missing."
    );
  }

  const id =
    env.XAU_SETUP_LOCK.idFromName(
      "XAUUSD-M5-SIGNAL-LOCK"
    );

  const stub =
    env.XAU_SETUP_LOCK.get(id);

  const response =
    await stub.fetch(
      `https://xau-lock${path}`,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify(body)
      }
    );

  return response.json();
}

async function processSignal(
  env,
  signal
) {
  /*
    WAITING = no trade.
  */
  if (
    signal.signal !== "BUY" &&
    signal.signal !== "SELL"
  ) {
    await callSetupLock(
      env,
      "/neutral",
      {
        candleTime:
          signal.candleTime
      }
    );

    return {
      ok: true,

      ...signal,

      telegramSent:
        false,

      notificationMode:
        "Cron-only"
    };
  }

  const signalId =
    getSignalId(signal);

  /*
    DURABLE atomic-style serialized claim.
  */
  const claim =
    await callSetupLock(
      env,
      "/claim",
      {
        signal:
          signal.signal,

        signalId,

        candleTime:
          signal.candleTime
      }
    );

  if (!claim.allowed) {
    return {
      ok: true,

      ...signal,

      telegramSent:
        false,

      duplicate:
        true,

      reason:
        claim.reason,

      activeDirection:
        claim.activeDirection ||
        null
    };
  }

  /*
    Telegram is only sent AFTER the setup
    has been successfully claimed.
  */
  const telegram =
    await sendTelegram(
      env,
      signal
    );

  if (!telegram.sent) {
    await callSetupLock(
      env,
      "/release",
      {
        signalId
      }
    );

    return {
      ok: true,

      ...signal,

      telegramSent:
        false,

      telegramError:
        telegram.error || null,

      telegramErrorCode:
        telegram.errorCode || null
    };
  }

  /*
    Telegram succeeded.
    Now make the direction officially active.
  */
  await callSetupLock(
    env,
    "/commit",
    {
      signal:
        signal.signal,

      signalId,

      anchor:
        signal.setupAnchor,

      candleTime:
        signal.candleTime
    }
  );

  return {
    ok: true,

    ...signal,

    telegramSent:
      true,

    telegramError:
      null,

    setupState:
      "ACTIVE"
  };
}

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

          status:
            "online"
        });
      }

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

          twelveData:
            !!env.TWELVE_DATA_API_KEY,

          telegram:
            !!env.TELEGRAM_BOT_TOKEN &&
            !!env.TELEGRAM_CHAT_ID,

          telegramTest:
            true,

          signalEngine:
            "Fresh Sweep OR Structure + EMA + 2/3 confirmation + Durable Setup Lifecycle",

          priceSource:
            "Twelve Data",

          maxSignalsPerDay:
            "UNLIMITED",

          notificationMode:
            "Cron-only automatic Telegram",

          duplicateProtection:
            "Durable Object serialized setup lock"
        });
      }

      if (
        url.pathname ===
        "/api/gold"
      ) {
        const price =
          await getLivePrice(env);

        return json({
          ok: true,

          symbol:
            "XAUUSD",

          price,

          source:
            "Twelve Data"
        });
      }

      if (
        url.pathname ===
        "/api/candles"
      ) {
        const candles =
          await getCandles(env);

        return json({
          ok: true,

          symbol:
            "XAUUSD",

          timeframe:
            "M5",

          candles
        });
      }

      /*
        READ-ONLY SCAN.

        It NEVER sends Telegram.
      */
      if (
        url.pathname ===
        "/api/scan"
      ) {
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

            telegramSent:
              false,

            notificationMode:
              "Cron-only"
          });
        }

        return json(
          await processSignal(
            env,
            signal
          )
        );
      }

      /*
        SHOW CURRENT LOCK STATE.
        Read-only — does not send Telegram.
      */
      if (
        url.pathname ===
        "/api/setup-state"
      ) {
        const result =
          await callSetupLock(
            env,
            "/state",
            {}
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

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      scanAndNotify(env)
        .catch(() => {
          /*
            Next Cron retries.
          */
        })
    );
  }
};
