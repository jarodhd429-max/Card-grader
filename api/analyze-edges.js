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
    const { cardImage } = req.body;

    if (!cardImage) {
      return res.status(400).json({ error: "Card image required" });
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

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze this trading card image and evaluate the quality of its edges and corners for grading purposes. Look for:

1. Corner condition: Are the corners sharp or rounded? Any whitening, creasing, or damage?
2. Edge condition: Are the edges clean and crisp? Any wear, chipping, or discoloration?
3. Print centering: Is the image well-centered on the card?
4. Surface quality: Any visible scratches, dents, stains, or print defects?

Provide a brief assessment in 2-3 sentences describing the edge and corner quality. Grade each on a scale: Excellent, Very Good, Good, Fair, or Poor.

Return ONLY a JSON object with this exact format:
{"corners": "grade", "edges": "grade", "centering": "grade", "surface": "grade", "summary": "brief assessment"}

Use "Excellent" (9-10), "Very Good" (8-9), "Good" (6-8), "Fair" (4-6), or "Poor" (1-4).`,
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

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 500,
        messages,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Anthropic API error response:", error);
      return res.status(response.status).json({ error: `API error: ${error}` });
    }

    const data = await response.json();

    if (data.stop_reason === "refusal") {
      return res.status(422).json({
        error: "Claude declined to analyze this card",
        category: data.stop_details?.category ?? null,
      });
    }

    const text = data.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");

    // Extract JSON from response
    const start = text.lastIndexOf("{");
    const end = text.indexOf("}", start);
    if (start === -1 || end === -1) {
      return res.status(502).json({ error: "No analysis data in Claude's reply" });
    }

    const result = JSON.parse(text.slice(start, end + 1));

    return res.status(200).json({
      corners: result.corners || "Unknown",
      edges: result.edges || "Unknown",
      centering: result.centering || "Unknown",
      surface: result.surface || "Unknown",
      summary: result.summary || "Unable to assess",
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
