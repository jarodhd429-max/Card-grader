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
    const { cardSet, cardNumber, printType, condition, cardImage } = req.body;

    if (!cardSet || !cardNumber) {
      return res.status(400).json({ error: "Card set and number required" });
    }

    // If we have a card image, use the vision-based market search
    if (cardImage) {
      try {
        const response = await fetch(`${req.headers.host?.includes('localhost') ? 'http' : 'https'}://${req.headers.host}/api/search-markets`, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify({
            cardImage,
            cardSet,
            cardNumber,
            printType,
            condition
          })
        });

        if (response.ok) {
          const data = await response.json();
          return res.status(200).json(data);
        }
      } catch (e) {
        console.error("Error calling search-markets:", e);
        // Fall back to generic search below
      }
    }

    // Fallback: Generic market search without vision
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
            text: `Research the market value for this trading card in multiple grades:
- Set/Year: ${cardSet}
- Card Number/Player: ${cardNumber}
- Print Type: ${printInfo}

Find recent SOLD prices in USD for these specific grades:
1. Raw/Ungraded (near mint condition, ungraded)
2. PSA 8 (Near Mint/Mint graded)
3. PSA 9 (Mint graded)
4. PSA 10 (Gem Mint graded)

Search from:
- eBay sold listings (last 30 days - actual sold prices)
- PriceCharting or similar card price guides
- PSA auction prices
- Cardstock.com if available

Return ONLY a JSON object with this exact format:
{"raw": number or null, "psa8": number or null, "psa9": number or null, "psa10": number or null, "confidence": "low/medium/high", "sources": "where prices came from"}

If you cannot find pricing data for a grade, use null for that grade.`,
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

    // Format prices for each grade
    const formatPrice = (price) => {
      if (price === null || price === undefined) return null;
      const num = Number(price);
      if (!isFinite(num) || num <= 0) return null;
      return num >= 1000 ? `$${(num / 1000).toFixed(1)}k` : `$${Math.round(num)}`;
    };

    return res.status(200).json({
      raw: formatPrice(result.raw),
      psa8: formatPrice(result.psa8),
      psa9: formatPrice(result.psa9),
      psa10: formatPrice(result.psa10),
      confidence: result.confidence || "low",
      sources: result.sources || "eBay and PriceCharting"
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
