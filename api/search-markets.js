export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { cardImage, cardSet, cardNumber, playerOrCharacter, printType, condition } = req.body;

    if (!cardImage || !cardSet || !cardNumber) {
      return res.status(400).json({ error: "Card image, set, and number are required" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim().replace(/^["']|["']$/g, "");
    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }

    // Extract base64 data
    let base64Data = cardImage;
    if (cardImage.includes(",")) {
      const parts = cardImage.split(",");
      base64Data = parts[1];
    }
    base64Data = base64Data.replace(/\s/g, "");

    const printInfo = printType === "parallel-rare" ? "parallel or rare variant" : (printType || "base print");
    const conditionInfo = condition ? `PSA ${condition} equivalent` : "near mint condition";

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `I'm showing you a photo of a collectible trading card. Use web search to find the current market prices for this exact card on eBay (sold listings from last 30 days) and Cardstock.

Card Details:
- Set/Year: ${cardSet}
- Card Number/Player: ${cardNumber}
- Print Type: ${printInfo}
- Target Condition: ${conditionInfo}

Search for recent SOLD prices in USD from:
1. eBay sold listings (last 30 days - look for actual sold prices, not asking prices)
2. Cardstock.com price tracking
3. 130point.com if available

For the card shown in the image, find at least 2-3 recent sales in similar condition. Return ONLY a JSON object with this exact format:
{"estimatedPrice": number, "range": "low to high", "confidence": "low/medium/high", "reason": "one sentence with specific marketplace info", "sources": "where you found prices (e.g., eBay sold 10/2/2026, Cardstock tracking)"}

If you cannot find pricing data, return: {"estimatedPrice": null, "range": "unavailable", "confidence": "low", "reason": "no market data found for this card", "sources": ""}`,
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: base64Data,
            },
          },
        ],
      },
    ];

    let data;
    // Web search runs server-side; a long search can pause the turn, so resume it.
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "server-side-fallback-2026-07-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-5-5",
          max_tokens: 8000,
          fallbacks: "default",
          output_config: { effort: "medium" },
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 10 }],
          messages,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Anthropic API error response:", error);
        return res.status(response.status).json({ error: `API error: ${error}` });
      }

      data = await response.json();
      if (data.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: data.content });
    }

    if (data.stop_reason === "refusal") {
      return res.status(422).json({
        error: "Claude declined to look up this card",
        category: data.stop_details?.category ?? null,
      });
    }
    if (data.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "Claude response was truncated" });
    }

    const text = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    // Extract JSON from response
    const start = text.lastIndexOf("{");
    const end = text.indexOf("}", start);
    if (start === -1 || end === -1) {
      return res.status(502).json({ error: "No price data in Claude's reply" });
    }

    const result = JSON.parse(text.slice(start, end + 1));

    // Format the response
    if (result.estimatedPrice !== null && typeof result.estimatedPrice === "number") {
      const value = result.estimatedPrice;
      const formattedValue = value >= 1000
        ? `$${(value / 1000).toFixed(1)}k`
        : `$${Math.round(value)}`;

      return res.status(200).json({
        value: formattedValue,
        details: `${result.reason} (Range: ${result.range}). Confidence: ${result.confidence}. Source: ${result.sources}`
      });
    } else {
      return res.status(200).json({
        value: "N/A",
        details: result.reason || "No pricing data available for this card. Check eBay sold listings or Cardstock directly."
      });
    }
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
