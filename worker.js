export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    // GoldAPI endpoint
    if (url.pathname === "/api/gold") {
      try {
        if (!env.GOLD_API_KEY) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "GOLD_API_KEY secret is not configured."
            }),
            {
              status: 500,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
              }
            }
          );
        }

        const response = await fetch(
          "https://www.goldapi.io/api/price/XAU/USD",
          {
            method: "GET",
            headers: {
              "x-access-token": env.GOLD_API_KEY,
              "Content-Type": "application/json"
            }
          }
        );

        const data = await response.json();

        if (!response.ok) {
          return new Response(
            JSON.stringify({
              ok: false,
              error: "GoldAPI request failed."
            }),
            {
              status: response.status,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json"
              }
            }
          );
        }

        return new Response(
          JSON.stringify({
            ok: true,
            market: "XAUUSD",
            price: data.price ?? null,
            bid: data.bid ?? null,
            ask: data.ask ?? null,
            open: data.open_price ?? null,
            high: data.high_price ?? null,
            low: data.low_price ?? null,
            previousClose: data.prev_close_price ?? null,
            change: data.ch ?? data.change ?? null,
            changePercent: data.chp ?? data.change_percent ?? null,
            timestamp: data.timestamp ?? null,
            datetime: data.datetime ?? null,
            exchange: data.exchange ?? null,
            source: "GoldAPI"
          }),
          {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );

      } catch (error) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "Unable to retrieve XAUUSD price."
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json"
            }
          }
        );
      }
    }

    // Worker status endpoint
    if (url.pathname === "/api/status") {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "XAU AI CHART API",
          status: "online",
          market: "XAUUSD",
          timeframe: "M5"
        }),
        {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json"
          }
        }
      );
    }

    // Serve the XAU AI CHART website
    return env.ASSETS.fetch(request);
  }
};
