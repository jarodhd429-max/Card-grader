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

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }

    // Convert base64 to data URL format if needed
    const imageData = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const requestBody = {
      model: "claude-opus-4-1",
      max_tokens: 200,
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
              text: `This photo shows a physical trading card, possibly photographed against a background. Find the four edges of the card ITSELF (not the background) as fractions of the full image width and height, where 0,0 is the top-left corner of the photo and 1,1 is the bottom-right corner of the photo. If the card already fills the entire photo edge-to-edge with no visible background, use left:0, top:0, right:1, bottom:1. Reply with only this JSON shape and nothing else: {"left": number, "top": number, "right": number, "bottom": number}`,
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
