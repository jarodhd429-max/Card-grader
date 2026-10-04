import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  apiKey: process.env.CLAUDE_API_KEY,
});

export default async function handler(req, res) {
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
      max_tokens: 500,
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
              text: `This photo shows the ${side} of a collectible trading card, already cropped to its physical edges. Acting as an experienced trading card grader, assess the visible CORNER wear, EDGE wear, and SURFACE condition (scratches, print lines, indentations, gloss loss, staining). Ignore centering entirely - it is measured separately. Score each from 1 (heavily worn or damaged) to 10 (flawless). Reply with only this JSON shape and nothing else: {"corner_score": number, "edge_score": number, "surface_score": number, "confidence": "low" or "medium" or "high", "notes": "one or two short sentences on what you actually observed in the photo"}`,
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
