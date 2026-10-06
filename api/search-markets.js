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
            text: `I'm showing you a photo of a collectible trading card. Use web search to find BOTH sold prices and current asking prices for this exact card in multiple grades.

Card Details:
- Set/Year: ${cardSet}
- Card Number/Player: ${cardNumber}
- Print Type: ${printInfo}

For each grade, search for:
1. SOLD PRICES (eBay sold listings from last 30 days - actual prices cards sold for)
2. CURRENT ASKING PRICES (active eBay listings, TCGPlayer, Cardstock - what sellers are asking now)

Grades to research:
1. Raw/Ungraded (near mint condition, ungraded)
2. PSA 8 (Near Mint/Mint graded)
3. PSA 9 (Mint graded)
4. PSA 10 (Gem Mint graded)

Search from:
- eBay sold listings (for sold prices)
- Active eBay listings (for current asking prices)
- TCGPlayer, Cardstock.com, Sports Card Pro
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
    "TCGPlayer": { ... },
    "Cardstock": { ... },
    "Sports Card Pro": { ... }
  },
  "confidence": "low" or "medium" or "high"
}

Use null for any price you cannot find. Prices can be with or without $ symbols and commas.`,
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

    // Check if we have sources in the result
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

    // If no sources found, return error with what we got
    console.error("No sources found in result. Full result:", JSON.stringify(result));
    return res.status(502).json({
      error: "No price sources found in Claude's response",
      result: result
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
