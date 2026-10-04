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
    const { imageBase64 } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "No image provided" });
    }

    const apiKey = process.env.CLAUDE_API_KEY?.trim().replace(/^["']|["']$/g, "");
    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }

    const imageData = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: imageData,
            },
          },
          {
            type: "text",
            text: `This photo shows the front of a collectible trading card. Identify the exact card (player or character, year, set, card number, and any parallel or variant), then use web search to find recent SOLD prices in USD (eBay sold listings, PriceCharting, 130point, PSA auction prices, or similar) for four conditions: raw (ungraded, near mint), PSA 8, PSA 9, and PSA 10. Use a typical recent sale price for each, not the highest asking price. If you can't find a reliable price for a condition, use null for it.

After researching, end your reply with only this JSON object: {"card": "full card name, e.g. 2018 Panini Prizm Luka Doncic #280", "raw": number or null, "psa8": number or null, "psa9": number or null, "psa10": number or null, "confidence": "low" or "medium" or "high", "notes": "one short sentence on where the prices came from"}`,
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
          max_tokens: 16000,
          fallbacks: "default",
          output_config: { effort: "medium" },
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
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

    const text = (data.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    let result = extractPriceJson(text);
    if (!result) {
      // The research turn ended without the JSON (e.g. still mid-search), so ask
      // once more for just the summary, constrained to the schema.
      result = await summarizePrices(apiKey, messages, data.content || []);
    }
    if (!result) {
      return res.status(502).json({ error: "No price data in Claude's reply" });
    }

    for (const key of ["raw", "psa8", "psa9", "psa10"]) {
      result[key] = toPrice(result[key]);
    }
    res.status(200).json(result);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}

// Accepts 1200, "1200", "$1,200", "$1,100-1,300" (takes the first number).
function toPrice(value) {
  if (typeof value === "number") return isFinite(value) && value > 0 ? value : null;
  if (typeof value !== "string") return null;
  const match = value.replace(/,/g, "").match(/\d+(\.\d+)?/);
  const n = match ? Number(match[0]) : NaN;
  return isFinite(n) && n > 0 ? n : null;
}

// Finds the last balanced {...} in the text that parses and has price keys.
function extractPriceJson(text) {
  for (let start = text.lastIndexOf("{"); start !== -1; start = text.lastIndexOf("{", start - 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          if (obj && typeof obj === "object" && ("psa10" in obj || "raw" in obj)) return obj;
        } catch {}
        break;
      }
    }
  }
  return null;
}

async function summarizePrices(apiKey, messages, lastContent) {
  const nullableNumber = { anyOf: [{ type: "number" }, { type: "null" }] };
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
      max_tokens: 4000,
      fallbacks: "default",
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              card: { type: "string" },
              raw: nullableNumber,
              psa8: nullableNumber,
              psa9: nullableNumber,
              psa10: nullableNumber,
              confidence: { type: "string", enum: ["low", "medium", "high"] },
              notes: { type: "string" },
            },
            required: ["card", "raw", "psa8", "psa9", "psa10", "confidence", "notes"],
            additionalProperties: false,
          },
        },
      },
      messages: [
        messages[0],
        {
          role: "assistant",
          content: lastContent
            .filter((c) => c.type === "text" && c.text)
            .map((c) => ({ type: "text", text: c.text })),
        },
        {
          role: "user",
          content: "Based on what you found, give the final prices as the JSON object only. Use plain numbers in USD, or null if unknown.",
        },
      ].filter((m) => typeof m.content === "string" || m.content.length),
    }),
  });
  if (!response.ok) {
    console.error("Price summary error:", await response.text());
    return null;
  }
  const data = await response.json();
  const text = (data.content || []).find((c) => c.type === "text")?.text;
  try {
    return text ? JSON.parse(text.trim()) : null;
  } catch {
    return null;
  }
}
