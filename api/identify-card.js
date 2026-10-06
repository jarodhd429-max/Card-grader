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
    const { image } = req.body;
    if (!image) {
      return res.status(400).json({ error: "No image provided" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }

    // Extract base64 data
    let base64Data = image;
    if (image.includes(",")) {
      const parts = image.split(",");
      base64Data = parts[1];
    }

    // Validate base64 data
    if (!base64Data || base64Data.length < 100) {
      return res.status(400).json({ error: "Invalid image data" });
    }

    // Clean up base64 string
    base64Data = base64Data.replace(/\s/g, "");

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5-5",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Analyze this trading card image and extract the following information. Return ONLY a JSON object with no other text:

- set: The card set name and year (e.g., "2018 Panini Prizm" or "1996 Upper Deck")
- cardNumber: The card number or "N/A" if not clearly visible
- playerOrCharacter: The player or character name on the card
- printType: One of: "base", "parallel-rare", "rookie", "insert", "auto", "relics" or "unknown"
- description: A one-sentence description of the card (e.g., "2023 Topps Chrome Mookie Betts #100 base print")

Detect the print type by looking for:
- Holographic or special finish = parallel-rare
- Rookie card marking = rookie
- Autograph sticker/signature = auto
- Game-worn/memorabilia swatch = relics
- Insert set indicator = insert
- Otherwise = base

Return JSON like: {"set": "2023 Topps", "cardNumber": "#100", "playerOrCharacter": "Mookie Betts", "printType": "base", "description": "2023 Topps Mookie Betts #100 base print"}`,
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
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Claude API error:", errorText);
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json();
    if (!data.content || !data.content[0] || !data.content[0].text) {
      throw new Error("Invalid response from Claude API");
    }

    const text = data.content[0].text;

    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Could not parse card information");
    }

    const cardInfo = JSON.parse(jsonMatch[0]);

    // Format the set to be more user-friendly
    const set = cardInfo.set || "Unknown Set";
    const cardNumber = cardInfo.cardNumber || cardInfo.playerOrCharacter || "Unknown";
    const printType = cardInfo.printType || "base";
    const description = cardInfo.description || `${set} - ${cardNumber}`;

    return res.status(200).json({
      set: set,
      cardNumber: cardNumber,
      printType: printType,
      description: description,
    });
  } catch (error) {
    console.error("AI identification error:", error.message);
    return res.status(500).json({
      error: error.message || "Failed to identify card. Make sure the card is clearly visible in the photo.",
    });
  }
}
