import { DurableObject } from "cloudflare:workers";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

/*
  =====================================================
  XAU AI CHART
  Pine kNN Alert Engine
  =====================================================

  Based on the original Pine script:

  K          = 63
  k          = floor(sqrt(63)) = 7
  Indicator  = All
  Fast       = 14
  Slow       = 28
  Filter     = Both
  Holding    = 1
  Threshold  = 99.9

  Telegram sends ONLY:

  XAU AI CHART

  🟢 BUY XAUUSD

  OR

  XAU AI CHART

  🔴 SELL XAUUSD
*/

const TIMEFRAME = "45min";

const K = 63;
const KNN_K = Math.floor(Math.sqrt(K));

const FAST = 14;
const SLOW = 28;

const HOLDING_PERIOD = 1;
const TIME_THRESHOLD = 99.9;

const REARM_CANDLES = 2;

/*
  We need enough history for:

  RSI 28
  CCI 28
  ROC 28
  MOM 28
  scale(MOM,63)
  ATR
  HMA(volume RSI,10)

  300 gives the engine enough historical data
  to reconstruct the Pine state before evaluating
  the newest closed candle.
*/
const OUTPUT_SIZE = 300;

/* =====================================================
   BASIC HELPERS
===================================================== */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json"
    }
  });
}

function isFiniteNumber(v) {
  return Number.isFinite(Number(v));
}

/* =====================================================
   PINE-LIKE MATH
===================================================== */

function sma(values, period) {
  if (values.length < period) return null;

  let sum = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const v = values[i];

    if (!Number.isFinite(v)) {
      return null;
    }

    sum += v;
  }

  return sum / period;
}

function rma(values, period) {
  if (values.length < period) return null;

  let firstSum = 0;

  for (let i = 0; i < period; i++) {
    if (!Number.isFinite(values[i])) {
      return null;
    }

    firstSum += values[i];
  }

  let result = firstSum / period;

  for (let i = period; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      return null;
    }

    result =
      ((result * (period - 1)) + values[i]) /
      period;
  }

  return result;
}

function wma(values, period) {
  if (values.length < period) return null;

  let weightedSum = 0;
  let weightTotal = 0;
  let weight = 1;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const v = values[i];

    if (!Number.isFinite(v)) {
      return null;
    }

    weightedSum += v * weight;
    weightTotal += weight;
    weight++;
  }

  return weightedSum / weightTotal;
}

function hma(values, period) {
  if (values.length < period) return null;

  const half = Math.max(
    1,
    Math.floor(period / 2)
  );

  const root = Math.max(
    1,
    Math.floor(Math.sqrt(period))
  );

  const raw = [];

  /*
    Reconstruct WMA(half) and WMA(period)
    for each usable point.
  */
  for (
    let i = period - 1;
    i < values.length;
    i++
  ) {
    const windowHalf =
      values.slice(
        i - half + 1,
        i + 1
      );

    const windowFull =
      values.slice(
        i - period + 1,
        i + 1
      );

    const wh =
      wma(windowHalf, half);

    const wf =
      wma(windowFull, period);

    if (
      wh === null ||
      wf === null
    ) {
      raw.push(null);
    } else {
      raw.push(
        2 * wh - wf
      );
    }
  }

  /*
    Pine HMA is WMA of the raw series.
  */
  const validRaw =
    raw.filter(
      v => Number.isFinite(v)
    );

  return wma(
    validRaw,
    root
  );
}

/* =====================================================
   RSI
===================================================== */

function calculateRSI(series, period) {
  if (series.length < period + 1) {
    return null;
  }

  const gains = [];
  const losses = [];

  for (let i = 1; i < series.length; i++) {
    const change =
      series[i] - series[i - 1];

    gains.push(
      Math.max(change, 0)
    );

    losses.push(
      Math.max(-change, 0)
    );
  }

  const avgGain =
    rma(gains, period);

  const avgLoss =
    rma(losses, period);

  if (
    avgGain === null ||
    avgLoss === null
  ) {
    return null;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 -
    (100 / (1 + rs));
}

/* =====================================================
   ROC
===================================================== */

function calculateROC(series, period) {
  if (series.length <= period) {
    return null;
  }

  const current =
    series[series.length - 1];

  const previous =
    series[
      series.length - 1 - period
    ];

  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }

  return (
    (current - previous) /
    previous
  ) * 100;
}

/* =====================================================
   CCI
===================================================== */

function calculateCCI(
  highs,
  lows,
  closes,
  period
) {
  if (closes.length < period) {
    return null;
  }

  const typical = [];

  for (
    let i = 0;
    i < closes.length;
    i++
  ) {
    typical.push(
      (
        highs[i] +
        lows[i] +
        closes[i]
      ) / 3
    );
  }

  const current =
    typical[
      typical.length - 1
    ];

  const window =
    typical.slice(
      -period
    );

  const mean =
    window.reduce(
      (sum, v) => sum + v,
      0
    ) / period;

  let deviation = 0;

  for (const value of window) {
    deviation +=
      Math.abs(value - mean);
  }

  deviation /=
    period;

  if (deviation === 0) {
    return 0;
  }

  return (
    (current - mean) /
    (0.015 * deviation)
  );
}

/* =====================================================
   MOMENTUM
===================================================== */

function calculateMOM(
  closes,
  period
) {
  if (closes.length <= period) {
    return null;
  }

  return (
    closes[closes.length - 1] -
    closes[
      closes.length - 1 - period
    ]
  );
}

/* =====================================================
   PINE SCALE
===================================================== */

function calculateScale(
  values,
  period
) {
  if (values.length < period) {
    return null;
  }

  const window =
    values.slice(-period);

  if (
    window.some(
      v => !Number.isFinite(v)
    )
  ) {
    return null;
  }

  let low = Infinity;
  let high = -Infinity;

  for (const v of window) {
    low =
      Math.min(low, v);

    high =
      Math.max(high, v);
  }

  if (high === low) {
    return null;
  }

  return (
    (values[values.length - 1] - low) /
    (high - low)
  ) * 100;
}

/* =====================================================
   ATR
===================================================== */

function calculateATRSeries(
  candles,
  period
) {
  if (candles.length < period + 1) {
    return null;
  }

  const trs = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const current =
      candles[i];

    const previous =
      candles[i - 1];

    const tr =
      Math.max(
        current.high -
          current.low,

        Math.abs(
          current.high -
          previous.close
        ),

        Math.abs(
          current.low -
          previous.close
        )
      );

    trs.push(tr);
  }

  return rma(
    trs,
    period
  );
}

/* =====================================================
   VOLUME BREAK
   Pine:

   rsivol = rsi(volume,14)
   osc    = hma(rsivol,10)
   osc > 49
===================================================== */

function calculateVolumeBreak(
  candles
) {
  const volumes =
    candles.map(
      c => c.volume
    );

  if (
    volumes.length < 30 ||
    volumes.some(
      v => !Number.isFinite(v)
    )
  ) {
    return null;
  }

  const rsiValues = [];

  /*
    Build RSI(volume,14) as a series.
  */
  for (
    let i = 0;
    i < volumes.length;
    i++
  ) {
    const value =
      calculateRSI(
        volumes.slice(
          0,
          i + 1
        ),
        14
      );

    rsiValues.push(value);
  }

  const validRSI =
    rsiValues.filter(
      v => Number.isFinite(v)
    );

  if (validRSI.length < 20) {
    return null;
  }

  const osc =
    hma(
      validRSI,
      10
    );

  if (!Number.isFinite(osc)) {
    return null;
  }

  return osc > 49;
}

/* =====================================================
   VOLATILITY BREAK

   Pine:

   atr(1) > atr(10)
===================================================== */

function calculateVolatilityBreak(
  candles
) {
  const atr1 =
    calculateATRSeries(
      candles,
      1
    );

  const atr10 =
    calculateATRSeries(
      candles,
      10
    );

  if (
    atr1 === null ||
    atr10 === null
  ) {
    return null;
  }

  return atr1 > atr10;
}

/* =====================================================
   FEATURE CALCULATION

   Pine:

   rs = rsi(close, slow)
   rf = rsi(close, fast)

   cs = cci(close, slow)
   cf = cci(close, fast)

   os = roc(close, slow)
   of = roc(close, fast)

   ms = scale(mom(close, slow),63)*100
   mf = scale(mom(close, fast),63)*100

   f1 = avg(rs,os,cs,ms)
   f2 = avg(rf,of,cf,mf)
===================================================== */

function average(values) {
  const valid =
    values.filter(
      v => Number.isFinite(v)
    );

  if (!valid.length) {
    return null;
  }

  return (
    valid.reduce(
      (sum, v) => sum + v,
      0
    ) / valid.length
  );
}

function calculateFeatures(
  candles,
  index
) {
  const history =
    candles.slice(
      0,
      index + 1
    );

  const closes =
    history.map(
      c => c.close
    );

  const highs =
    history.map(
      c => c.high
    );

  const lows =
    history.map(
      c => c.low
    );

  const rs =
    calculateRSI(
      closes,
      SLOW
    );

  const rf =
    calculateRSI(
      closes,
      FAST
    );

  const cs =
    calculateCCI(
      highs,
      lows,
      closes,
      SLOW
    );

  const cf =
    calculateCCI(
      highs,
      lows,
      closes,
      FAST
    );

  const os =
    calculateROC(
      closes,
      SLOW
    );

  const of =
    calculateROC(
      closes,
      FAST
    );

  const slowMomSeries = [];

  const fastMomSeries = [];

  for (
    let i = 0;
    i < closes.length;
    i++
  ) {
    if (i >= SLOW) {
      slowMomSeries.push(
        closes[i] -
        closes[i - SLOW]
      );
    }
  }

  for (
    let i = 0;
    i < closes.length;
    i++
  ) {
    if (i >= FAST) {
      fastMomSeries.push(
        closes[i] -
        closes[i - FAST]
      );
    }
  }

  const ms =
    calculateScale(
      slowMomSeries,
      63
    );

  const mf =
    calculateScale(
      fastMomSeries,
      63
    );

  const f1 =
    average([
      rs,
      os,
      cs,
      ms
    ]);

  const f2 =
    average([
      rf,
      of,
      cf,
      mf
    ]);

  return {
    f1,
    f2
  };
}

/* =====================================================
   KNN PREDICTION

   THIS FOLLOWS THE ORIGINAL PINE LOOP.

   prediction array is persistent.
   Maximum size = 7.
===================================================== */

function calculateKNN(
  feature1,
  feature2,
  directions,
  predictions
) {
  let maxdist = -999;

  const size =
    directions.length;

  for (
    let i = 0;
    i < size;
    i++
  ) {
    const d =
      Math.sqrt(
        Math.pow(
          feature1 -
            feature1History[i],
          2
        ) +
        Math.pow(
          feature2 -
            feature2History[i],
          2
        )
      );

    if (d > maxdist) {
      maxdist = d;

      if (
        predictions.length >=
        KNN_K
      ) {
        predictions.shift();
      }

      predictions.push(
        directions[i]
      );
    }
  }

  return predictions.reduce(
    (sum, value) =>
      sum + value,
    0
  );
}

/*
  These are intentionally module-level only
  while one scan is running.
*/
let feature1History = [];
let feature2History = [];

/* =====================================================
   BUILD PINE SIGNAL

   We replay historical candles sequentially
   so the persistent Pine arrays can be recreated.
===================================================== */

function buildSignal(
  candles
) {
  if (
    candles.length < 100
  ) {
    return {
      signal: "WAITING",
      reason:
        "Not enough candles"
    };
  }

  /*
    Remove currently forming candle.

    The original Pine alert is evaluated on
    the current bar. For our scheduled worker,
    the newest candle used here is closed.
  */
  const closed =
    candles.slice(0, -1);

  if (
    closed.length < 100
  ) {
    return {
      signal: "WAITING",
      reason:
        "Not enough closed candles"
    };
  }

  feature1History = [];
  feature2History = [];

  const directions = [];
  const predictions = [];

  let previousSignal = 0;
  let hpCounter = 0;

  let latestAlert =
    null;

  /*
    Replay every closed candle.
  */
  for (
    let index = 0;
    index < closed.length;
    index++
  ) {
    const candle =
      closed[index];

    /*
      Pine feature values.
    */
    const features =
      calculateFeatures(
        closed,
        index
      );

    /*
      Pine:

      class =
        close[1]<close[0] ? SELL :
        close[1]>close[0] ? BUY :
        HOLD
    */
    let direction = 0;

    if (index > 0) {
      if (
        closed[index - 1].close <
        candle.close
      ) {
        direction = -1;
      } else if (
        closed[index - 1].close >
        candle.close
      ) {
        direction = 1;
      }
    }

    /*
      Pine arrays are pushed BEFORE the kNN loop.
    */
    if (
      Number.isFinite(features.f1) &&
      Number.isFinite(features.f2)
    ) {
      feature1History.push(
        features.f1
      );

      feature2History.push(
        features.f2
      );

      directions.push(
        direction
      );
    }

    /*
      We cannot produce a kNN prediction until
      the current feature exists.
    */
    if (
      !Number.isFinite(features.f1) ||
      !Number.isFinite(features.f2) ||
      directions.length === 0
    ) {
      continue;
    }

    /*
      EXACT kNN selection.
    */
    let maxdist = -999;

    for (
      let i = 0;
      i < directions.length;
      i++
    ) {
      const d =
        Math.sqrt(
          Math.pow(
            features.f1 -
              feature1History[i],
            2
          ) +
          Math.pow(
            features.f2 -
              feature2History[i],
            2
          )
        );

      if (
        d > maxdist
      ) {
        maxdist = d;

        if (
          predictions.length >=
          KNN_K
        ) {
          predictions.shift();
        }

        predictions.push(
          directions[i]
        );
      }
    }

    const prediction =
      predictions.reduce(
        (sum, value) =>
          sum + value,
        0
      );

    /*
      Pine filter = Both

      volatilityBreak(1,10)
      AND
      volumeBreak(49)
    */
    const history =
      closed.slice(
        0,
        index + 1
      );

    const volatility =
      calculateVolatilityBreak(
        history
      );

    const volume =
      calculateVolumeBreak(
        history
      );

    /*
      If volume is unavailable, the Pine
      "Both" filter cannot be truthfully
      reproduced.
    */
    const filter =
      volatility === true &&
      volume === true;

    /*
      On a closed candle the bar has already
      lived through the threshold.

      Pine:
        barlife > 99.9
    */
    const barlifePassed =
      index > 0;

    let signal =
      previousSignal;

    if (
      prediction > 0 &&
      barlifePassed &&
      filter
    ) {
      signal = 1;
    } else if (
      prediction < 0 &&
      barlifePassed &&
      filter
    ) {
      signal = -1;
    }

    /*
      Pine:
        changed = change(signal)
    */
    const changed =
      signal !== previousSignal;

    /*
      Pine:
        hp_counter := changed
          ? 0
          : hp_counter + 1
    */
    if (changed) {
      hpCounter = 0;
    } else {
      hpCounter++;
    }

    /*
      Pine alert:

      if changed and signal==BUY
          alert("Buy Alert")

      if changed and signal==SELL
          alert("Sell Alert")
    */
    if (
      changed &&
      signal === 1
    ) {
      latestAlert = {
        signal: "BUY",
        candleTime:
          candle.time,
        prediction
      };
    }

    if (
      changed &&
      signal === -1
    ) {
      latestAlert = {
        signal: "SELL",
        candleTime:
          candle.time,
        prediction
      };
    }

    previousSignal =
      signal;
  }

  /*
    Reset temporary histories after scan.
  */
  feature1History = [];
  feature2History = [];

  if (!latestAlert) {
    return {
      signal: "WAITING",
      candleTime:
        closed[
          closed.length - 1
        ].time
    };
  }

  return {
    signal:
      latestAlert.signal,

    candleTime:
      latestAlert.candleTime,

    prediction:
      latestAlert.prediction,

    setupAnchor:
      latestAlert.candleTime
  };
}

/* =====================================================
   TWELVE DATA
===================================================== */

async function getCandles(env) {
  if (!env.TWELVE_DATA_API_KEY) {
    throw new Error(
      "TWELVE_DATA_API_KEY is missing"
    );
  }

  const url =
    "https://api.twelvedata.com/time_series" +
    "?symbol=XAU/USD" +
    `&interval=${TIMEFRAME}` +
    `&outputsize=${OUTPUT_SIZE}` +
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

  if (
    !Array.isArray(
      data.values
    )
  ) {
    throw new Error(
      "Twelve Data returned no candle data."
    );
  }

  return data.values
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

      /*
        Volume is REQUIRED for the exact
        Pine "Both" filter.
      */
      volume:
        candle.volume === undefined
          ? NaN
          : Number(candle.volume)
    }))
    .filter(c =>
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
    )
    .reverse();
}

/* =====================================================
   TELEGRAM
===================================================== */

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
      result:
        data.result
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

${signal.signal === "BUY"
  ? "🟢 BUY XAUUSD"
  : "🔴 SELL XAUUSD"}`;

  const result =
    await telegramRequest(
      env,
      "sendMessage",
      {
        chat_id:
          String(
            env.TELEGRAM_CHAT_ID
          ),

        text:
          message
      }
    );

  if (!result.ok) {
    return {
      sent: false,

      error:
        result.error,

      errorCode:
        result.errorCode ||
        null
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
      error:
        "TELEGRAM_BOT_TOKEN is missing."
    };
  }

  if (!env.TELEGRAM_CHAT_ID) {
    return {
      ok: false,
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
      error:
        bot.error
    };
  }

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

Telegram connection test successful.`
      }
    );

  if (!sent.ok) {
    return {
      ok: false,
      error:
        sent.error
    };
  }

  return {
    ok: true,
    bot: {
      id:
        bot.result?.id ||
        null,

      username:
        bot.result?.username ||
        null,

      firstName:
        bot.result?.first_name ||
        null
    },

    messageSent:
      true
  };
}

/* =====================================================
   DURABLE OBJECT
===================================================== */

export class XAUSetupLock extends DurableObject {

  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async readState() {
    return (
      await this.ctx.storage.get(
        "state"
      )
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

    if (
      url.pathname ===
      "/state"
    ) {
      return json({
        ok: true,
        state
      });
    }

    /*
      WAITING candles re-arm after
      two distinct neutral candles.
    */
    if (
      url.pathname ===
      "/neutral"
    ) {
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
          state.neutralCandles ||
          0
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

        await this.writeState(
          reset
        );

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

      await this.writeState(
        state
      );

      return json({
        ok: true,
        state
      });
    }

    /*
      CLAIM
    */
    if (
      url.pathname ===
      "/claim"
    ) {
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
          reason:
            "INVALID_DIRECTION"
        });
      }

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

      if (
        state.direction ===
        signal
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

      if (
        state.lastSignalCandle ===
          candleTime &&
        state.direction ===
          signal
      ) {
        return json({
          ok: true,
          allowed: false,
          reason:
            "DUPLICATE_SIGNAL"
        });
      }

      state.pending = {
        signal,
        signalId,
        candleTime,
        createdAt:
          Date.now()
      };

      await this.writeState(
        state
      );

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
    */
    if (
      url.pathname ===
      "/commit"
    ) {
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

      await this.writeState(
        state
      );

      return json({
        ok: true,
        state
      });
    }

    /*
      RELEASE
    */
    if (
      url.pathname ===
      "/release"
    ) {
      const body =
        await request.json();

      if (
        state.pending &&
        state.pending.signalId ===
          body.signalId
      ) {
        state.pending =
          null;

        await this.writeState(
          state
        );
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

/* =====================================================
   SIGNAL ID
===================================================== */

function getSignalId(
  signal
) {
  return (
    `${signal.signal}|${signal.candleTime}`
  );
}

/* =====================================================
   DURABLE OBJECT CALL
===================================================== */

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
      "XAUUSD-M45-SIGNAL-LOCK"
    );

  const stub =
    env.XAU_SETUP_LOCK.get(
      id
    );

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

/* =====================================================
   PROCESS SIGNAL
===================================================== */

async function processSignal(
  env,
  signal
) {
  if (
    signal.signal !== "BUY" &&
    signal.signal !== "SELL"
  ) {
    await callSetupLock(
      env,
      "/neutral",
      {
        candleTime:
          signal.candleTime ||
          null
      }
    );

    return {
      ok: true,
      ...signal,

      telegramSent:
        false
    };
  }

  const signalId =
    getSignalId(signal);

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
        claim.reason
    };
  }

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
        telegram.error ||
        null
    };
  }

  await callSetupLock(
    env,
    "/commit",
    {
      signal:
        signal.signal,

      signalId,

      anchor:
        signal.setupAnchor ||
        signal.candleTime,

      candleTime:
        signal.candleTime
    }
  );

  return {
    ok: true,
    ...signal,

    telegramSent:
      true
  };
}

/* =====================================================
   SCAN
===================================================== */

async function scanAndNotify(
  env
) {
  const candles =
    await getCandles(env);

  const signal =
    buildSignal(candles);

  return processSignal(
    env,
    signal
  );
}

/* =====================================================
   WORKER
===================================================== */

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
      new URL(request.url);

    try {

      if (
        url.pathname ===
        "/"
      ) {
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
            "45min",

          signalEngine:
            "Original Pine kNN Alert Logic",

          K,

          k:
            KNN_K,

          indicator:
            "All",

          fast:
            FAST,

          slow:
            SLOW,

          filter:
            "Both",

          holdingPeriod:
            HOLDING_PERIOD,

          timeThreshold:
            TIME_THRESHOLD,

          twelveData:
            !!env.TWELVE_DATA_API_KEY,

          telegram:
            !!env.TELEGRAM_BOT_TOKEN &&
            !!env.TELEGRAM_CHAT_ID,

          notificationMode:
            "Cron-only automatic Telegram",

          duplicateProtection:
            "Durable Object"
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
            "45min",

          candles
        });
      }

      /*
        READ-ONLY SIGNAL CHECK.
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
              false
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
        Durable Object state.
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

        return json(
          result
        );
      }

      /*
        Telegram test.
      */
      if (
        url.pathname ===
        "/api/telegram-test"
      ) {
        const result =
          await testTelegram(
            env
          );

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
