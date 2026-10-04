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
    const { imageBase64, side } = req.body;

    if (!imageBase64) {
      return res.status(400).json({ error: "No image provided" });
    }

    const apiKey = process.env.CLAUDE_API_KEY?.trim().replace(/^["']|["']$/g, "");
    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }

    // Convert base64 to data URL format if needed
    const imageData = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const requestBody = {
      model: "claude-sonnet-5-5",
      // Thinking is always on for this model and counts toward max_tokens.
      max_tokens: 16000,
      fallbacks: "default",
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              left: { type: "number" },
              top: { type: "number" },
              right: { type: "number" },
              bottom: { type: "number" },
            },
            required: ["left", "top", "right", "bottom"],
            additionalProperties: false,
          },
        },
      },
      messages: [
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
              text: `This photo shows a physical trading card, possibly photographed against a background. Find the four edges of the card ITSELF (not the background) as fractions of the full image width and height, where 0,0 is the top-left corner of the photo and 1,1 is the bottom-right corner of the photo. If the card already fills the entire photo edge-to-edge with no visible background, use left:0, top:0, right:1, bottom:1. Reply with only this JSON shape: {"left": number, "top": number, "right": number, "bottom": number}`,
            },
          ],
        },
      ],
    };

    console.log("Sending request to Anthropic API");
    console.log("Image data length:", imageData.length);
    console.log("API key present:", !!apiKey);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify(requestBody),
    });

    console.log("Response status:", response.status);

    if (!response.ok) {
      const error = await response.text();
      console.error("Anthropic API error response:", error);
      return res.status(response.status).json({ error: `API error: ${error}` });
    }

    const data = await response.json();
    if (data.stop_reason === "refusal") {
      return res.status(422).json({
        error: "Claude declined to analyze this image",
        category: data.stop_details?.category ?? null,
      });
    }
    if (data.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "Claude response was truncated" });
    }

    const textContent = data.content.find((c) => c.type === "text");
    if (!textContent || textContent.type !== "text") {
      return res.status(500).json({ error: "No text response from Claude" });
    }

    const result = JSON.parse(textContent.text.trim());
    res.status(200).json(result);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
