import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

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

    // Convert base64 to buffer if needed for the API
    const imageData = imageBase64.includes(",")
      ? imageBase64.split(",")[1]
      : imageBase64;

    const message = await client.messages.create({
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
    });

    const textContent = message.content.find((c) => c.type === "text");
    if (!textContent || textContent.type !== "text") {
      return res.status(500).json({ error: "No text response from Claude" });
    }

    const jsonStr = textContent.text.trim();
    const result = JSON.parse(jsonStr);

    res.status(200).json(result);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
