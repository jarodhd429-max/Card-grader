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
    const { frontImage, backImage } = req.body;

    // Handle both new format (frontImage/backImage) and legacy format (image)
    const image = req.body.image || frontImage;

    if (!image) {
      return res.status(400).json({ error: "No image provided" });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "API key not configured" });
    }

    // Extract base64 data
    let frontBase64 = image;
    if (image.includes(",")) {
      const parts = image.split(",");
      frontBase64 = parts[1];
    }
    frontBase64 = frontBase64.replace(/\s/g, "");

    let backBase64 = "";
    if (backImage) {
      backBase64 = backImage.includes(",") ? backImage.split(",")[1] : backImage;
      backBase64 = backBase64.replace(/\s/g, "");
    }

    // Validate base64 data
    if (!frontBase64 || frontBase64.length < 100) {
      return res.status(400).json({ error: "Invalid image data" });
    }

    // Build content array with both images
    const contentArray = [
      {
        type: "text",
        text: `Analyze this trading card image (and back if provided) and extract the following information. Return ONLY a JSON object with no other text:

- set: The card set name and year (e.g., "2018 Panini Prizm" or "1996 Upper Deck")
- cardNumber: The card number or "N/A" if not clearly visible
- playerOrCharacter: The player or character name on the card
- printType: One of: "base", "parallel-rare", "rookie", "insert", "auto", "relics" or "unknown"
- parallelType: If printType is parallel-rare, specify the variant (e.g., "Gold", "Silver", "Rainbow Foil", "Mosaic", "Pulsar", "Atomic", "Velocity", etc.). Otherwise empty string ""
- description: A one-sentence description of the card (e.g., "2023 Topps Chrome Mookie Betts #100 base print")

Detect the print type by looking for:
- Holographic or special finish = parallel-rare (also identify the specific variant)
- Rookie card marking = rookie
- Autograph sticker/signature = auto
- Game-worn/memorabilia swatch = relics
- Insert set indicator = insert
- Otherwise = base

Return JSON like: {"set": "2023 Topps", "cardNumber": "#100", "playerOrCharacter": "Mookie Betts", "printType": "base", "parallelType": "", "description": "2023 Topps Mookie Betts #100 base print"}`,
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: frontBase64,
        },
      },
    ];

    // Add back image if provided
    if (backBase64) {
      contentArray.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: backBase64,
        },
      });
    }

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
            content: contentArray,
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
    const cardNumber = cardInfo.cardNumber || "Unknown";
    const playerOrCharacter = cardInfo.playerOrCharacter || "";
    const printType = cardInfo.printType || "base";
    const parallelType = cardInfo.parallelType || "";
    const description = cardInfo.description || `${set} - ${cardNumber}`;

    return res.status(200).json({
      set: set,
      cardNumber: cardNumber,
      playerOrCharacter: playerOrCharacter,
      printType: printType,
      parallelType: parallelType,
      description: description,
    });
  } catch (error) {
    console.error("AI identification error:", error.message);
    return res.status(500).json({
      error: error.message || "Failed to identify card. Make sure the card is clearly visible in the photo.",
    });
  }
}
