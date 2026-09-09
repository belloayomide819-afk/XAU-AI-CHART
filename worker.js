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

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // -----------------------------
    // STATUS
    // -----------------------------
    if (url.pathname === "/api/status") {
      return json({
        ok: true,
        service: "XAU AI CHART API",
        status: "online",
        market: "XAUUSD",
        timeframe: "M5",
        goldApi: !!env.GOLD_API_KEY,
        twelveData: !!env.TWELVE_DATA_API_KEY
      });
    }

    // -----------------------------
    // LIVE GOLD PRICE
    // -----------------------------
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

    // -----------------------------
    // XAUUSD M5 CANDLES
    // -----------------------------
    if (url.pathname === "/api/candles") {
      if (!env.TWELVE_DATA_API_KEY) {
        return json({
          ok: false,
          error: "TWELVE_DATA_API_KEY secret is not configured."
        }, 500);
      }

      try {
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
          return json({
            ok: false,
            error: "Twelve Data candle request failed.",
            details: data
          }, response.status || 400);
        }

        const values = Array.isArray(data.values)
          ? data.values
          : [];

        const candles = values.reverse().map(candle => ({
          time: candle.datetime,
          open: Number(candle.open),
          high: Number(candle.high),
          low: Number(candle.low),
          close: Number(candle.close),
          volume: candle.volume
            ? Number(candle.volume)
            : null
        }));

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
          error: "Twelve Data connection failed.",
          details: error.message
        }, 500);
      }
    }

    // -----------------------------
    // WEBSITE
    // -----------------------------
    return env.ASSETS.fetch(request);
  }
};
