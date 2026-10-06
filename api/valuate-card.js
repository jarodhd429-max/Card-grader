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

For each grade, find both:
1. SOLD PRICES (eBay sold listings from last 30 days - actual prices)
2. CURRENT ASKING PRICES (active listings - what sellers want now)

Grades to research:
1. Raw/Ungraded (near mint condition, ungraded)
2. PSA 8 (Near Mint/Mint graded)
3. PSA 9 (Mint graded)
4. PSA 10 (Gem Mint graded)

Search from:
- eBay sold listings (for sold prices)
- Active eBay listings (for asking prices)
- PriceCharting, Sports Card Pro, Cardstock.com
- PSA auction prices
- 130point.com if available

Return ONLY a JSON object with prices organized by source. Example format:
{"sources": {"eBay": {"raw": null, "psa8": "$100", "psa9": "$200", "psa10": "$500", "askingRaw": "$120", "askingPSA8": "$150", "askingPSA9": "$250", "askingPSA10": "$600"}, "Cardstock": {"raw": "$110", ...}, "Sports Card Pro": {...}}, "confidence": "low/medium/high"}

List each source you find pricing from separately. Use null for any grade/source combo you cannot find data for.`,
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
      if (typeof price === 'string') {
        const cleaned = price.replace(/[$,]/g, '');
        const num = Number(cleaned);
        if (!isFinite(num) || num <= 0) return null;
        return num >= 1000 ? `$${(num / 1000).toFixed(1)}k` : `$${Math.round(num)}`;
      }
      const num = Number(price);
      if (!isFinite(num) || num <= 0) return null;
      return num >= 1000 ? `$${(num / 1000).toFixed(1)}k` : `$${Math.round(num)}`;
    };

    // If sources are provided by source, format them
    if (result.sources && typeof result.sources === 'object') {
      const formatted = {};
      for (const [source, prices] of Object.entries(result.sources)) {
        formatted[source] = {
          raw: formatPrice(prices.raw),
          psa8: formatPrice(prices.psa8),
          psa9: formatPrice(prices.psa9),
          psa10: formatPrice(prices.psa10),
          askingRaw: formatPrice(prices.askingRaw),
          askingPSA8: formatPrice(prices.askingPSA8),
          askingPSA9: formatPrice(prices.askingPSA9),
          askingPSA10: formatPrice(prices.askingPSA10)
        };
      }
      return res.status(200).json({
        bySource: formatted,
        confidence: result.confidence || "low"
      });
    }

    // Fallback to old format if needed
    return res.status(200).json({
      raw: formatPrice(result.raw),
      psa8: formatPrice(result.psa8),
      psa9: formatPrice(result.psa9),
      psa10: formatPrice(result.psa10),
      askingRaw: formatPrice(result.askingRaw),
      askingPSA8: formatPrice(result.askingPSA8),
      askingPSA9: formatPrice(result.askingPSA9),
      askingPSA10: formatPrice(result.askingPSA10),
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
