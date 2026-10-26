export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      // 1. Get the message sent from TradingView
      const text = await request.text();
      
      // 2. Figure out if it's a BUY or SELL
      let signalType = "UNKNOWN";
      if (text.toUpperCase().includes("BUY")) signalType = "BUY";
      if (text.toUpperCase().includes("SELL")) signalType = "SELL";

      // 3. Check your KV Memory for the last signal
      // NOTE: Make sure "SIGNALS" is the exact name of your KV binding
      let lastSignal = await env.SIGNALS.get("last_signal");

      // If this signal is exactly the same as the last one, STOP and ignore it.
      if (signalType === lastSignal) {
        return new Response("Duplicate signal ignored to prevent spam", { status: 200 });
      }

      // 4. Save this new signal to memory so we remember it for next time
      await env.SIGNALS.put("last_signal", signalType);

      // 5. Send to Telegram
      // NOTE: Make sure these variable names match your Cloudflare settings exactly
      const TELEGRAM_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN; 
      const TELEGRAM_CHAT_ID = env.TELEGRAM_CHAT_ID;     

      const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

      const response = await fetch(telegramUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: text,
          parse_mode: "HTML"
        })
      });

      if (!response.ok) {
        throw new Error(`Telegram API error: ${await response.text()}`);
      }

      return new Response("Signal sent successfully", { status: 200 });

    } catch (error) {
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  }
};
