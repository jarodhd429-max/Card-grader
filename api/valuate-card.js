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
    const { cardSet, cardNumber, printType, condition } = req.body;

    if (!cardSet || !cardNumber) {
      return res.status(400).json({ error: "Card set and number required" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY?.trim().replace(/^["']|["']$/g, "");
    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }

    // Build the search query
    const printInfo = printType
      ? (printType === "parallel-rare" ? "parallel or rare variant" : printType)
      : "base print";
    const conditionInfo = condition ? `PSA ${condition} equivalent` : "near mint condition";

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Research the market value for this trading card:
- Set/Year: ${cardSet}
- Card Number/Player: ${cardNumber}
- Print Type: ${printInfo}
- Target Condition: ${conditionInfo}

Find recent SOLD prices in USD from:
- eBay sold listings (last 30 days)
- PriceCharting or similar card price guides
- PSA auction prices if it's a PSA card
- Facebook Marketplace or similar

Distinguish between:
- Base prints (usually $1-500 depending on card)
- Parallel/rare variants (usually 2-10x base price)
- Rookie cards (often premium pricing)
- Autographs and relics (often $50+ depending on player)

Return ONLY a JSON object with this exact format:
{"estimatedPrice": number, "range": "low to high", "confidence": "low/medium/high", "reason": "one sentence explanation", "sources": "where you found prices"}

Example: {"estimatedPrice": 125, "range": "$50 to $300", "confidence": "medium", "reason": "2022 Panini Prizm parallel parallels typically sell for 3-5x base", "sources": "eBay sold listings and PriceCharting"}

If you cannot find pricing data, return: {"estimatedPrice": null, "range": "unavailable", "confidence": "low", "reason": "no market data found for this card", "sources": ""}`,
          },
        ],
      },
    ];

    let data;
    // Web search with fallback
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
        details: result.reason || "No pricing data available for this card. Check eBay sold listings or PriceCharting directly."
      });
    }
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
