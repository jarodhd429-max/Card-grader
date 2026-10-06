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

IMPORTANT: Return ONLY valid JSON with this exact structure - no other text:
{
  "sources": {
    "eBay": {
      "raw": "100" or null,
      "psa8": "100" or null,
      "psa9": "200" or null,
      "psa10": "500" or null,
      "askingRaw": "120" or null,
      "askingPSA8": "150" or null,
      "askingPSA9": "250" or null,
      "askingPSA10": "600" or null
    },
    "TCGPlayer": { "raw": null, "psa8": "95", ... },
    "Cardstock": { "raw": "105", "psa8": null, ... },
    "PriceCharting": { "raw": null, "psa8": "110", ... },
    "Sports Card Pro": { "raw": "98", "psa8": null, ... }
  },
  "confidence": "low" or "medium" or "high"
}

CRITICAL: Include a separate object for EACH marketplace you find prices from. Do NOT return a flat format without source labels. ALWAYS use "sources" with individual marketplace names as keys. Use null for any price you cannot find. Prices can be with or without $ symbols and commas.`,
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

    // Extract JSON from response - find the largest JSON object
    let result;
    let jsonStr;
    const start = text.lastIndexOf("{");
    if (start === -1) {
      return res.status(502).json({ error: "No JSON in Claude's reply", response: text.substring(0, 200) });
    }

    // Find matching closing brace
    let braceCount = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      if (text[i] === "{") braceCount++;
      if (text[i] === "}") {
        braceCount--;
        if (braceCount === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) {
      return res.status(502).json({ error: "Malformed JSON in Claude's reply", response: text.substring(0, 200) });
    }

    jsonStr = text.slice(start, end + 1);
    try {
      result = JSON.parse(jsonStr);
    } catch (parseErr) {
      console.error("JSON parse error:", parseErr, "String:", jsonStr.substring(0, 500));
      return res.status(502).json({ error: "Invalid JSON in Claude's reply", details: parseErr.message, response: text.substring(0, 500) });
    }

    console.log("Parsed result:", JSON.stringify(result).substring(0, 500));

    // Format prices for each grade
    const formatPrice = (price) => {
      if (price === null || price === undefined || price === 'null' || price === 'nil' || price === 'none') return null;
      if (typeof price === 'string') {
        // Handle "nil", "none", "N/A" etc.
        if (price.toLowerCase() === 'nil' || price.toLowerCase() === 'none' || price.toLowerCase() === 'n/a' || price === '-') {
          return null;
        }
        const cleaned = price.replace(/[$,]/g, '').trim();
        const num = Number(cleaned);
        if (!isFinite(num) || num <= 0) return null;
        return num >= 1000 ? `$${(num / 1000).toFixed(1)}k` : `$${Math.round(num)}`;
      }
      const num = Number(price);
      if (!isFinite(num) || num <= 0) return null;
      return num >= 1000 ? `$${(num / 1000).toFixed(1)}k` : `$${Math.round(num)}`;
    };

    // Check if we have sources in the new format
    const sources = result.sources || result.bySource || {};

    if (sources && typeof sources === 'object' && Object.keys(sources).length > 0) {
      const formatted = {};
      for (const [source, prices] of Object.entries(sources)) {
        if (prices && typeof prices === 'object') {
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
      }
      if (Object.keys(formatted).length > 0) {
        return res.status(200).json({
          bySource: formatted,
          confidence: result.confidence || "low"
        });
      }
    }

    // Flat format is no longer supported - Claude must return prices organized by marketplace source
    if (result.raw !== undefined || result.psa8 !== undefined || result.psa9 !== undefined || result.psa10 !== undefined) {
      console.error("Claude returned flat format instead of marketplace-organized sources");
      return res.status(200).json({
        error: "Claude returned prices without marketplace labels. Requires prices organized by source (eBay, TCGPlayer, Cardstock, PriceCharting, Sports Card Pro, etc.)",
        rawResponse: JSON.stringify(result).substring(0, 300),
        confidence: result.confidence || "unknown",
        debug: { flatFormatDetected: true }
      });
    }

    // If no prices found at all, return error with debugging info
    console.error("No price data found in result. Full result:", JSON.stringify(result));
    return res.status(200).json({
      error: `No prices found. Result keys: ${Object.keys(result).join(', ')}`,
      rawResponse: JSON.stringify(result).substring(0, 500),
      confidence: result.confidence || "unknown"
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
