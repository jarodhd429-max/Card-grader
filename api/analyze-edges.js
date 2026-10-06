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
3. Surface quality: Any visible scratches, dents, stains, or print defects on the card itself?

Note: Centering is measured separately using the dot markers and is shown in the centering breakdown table above.

IMPORTANT: If the card is in a top loader (clear plastic holder), assume any visible scratches or wear are on the top loader surface, NOT on the card. Grade the card's surface condition based on what you can see of the actual card, ignoring top loader defects.

Grade each factor on a numeric scale (1-10):
- 10: Gem Mint - Virtually no flaws
- 9: Mint - Nearly perfect with only minor imperfections
- 8: Near Mint-Mint - Slight wear, very few marks
- 7: Near Mint - Minor wear but well-preserved
- 6: Excellent-Mint - Light wear and aging
- 5: Excellent - Moderate wear, some visible defects
- 4: Very Good-Excellent - Significant wear but still nice
- 3: Very Good - Heavy wear, obvious defects
- 2: Good - Substantial wear throughout
- 1: Poor - Heavily damaged or worn

Return ONLY a JSON object with this exact format:
{"corners": numeric_grade, "edges": numeric_grade, "surface": numeric_grade, "grade": overall_grade, "inTopLoader": boolean, "summary": "brief assessment"}

The overall grade should be the average of the three condition factors (corners, edges, surface). Centering is graded separately using dot placement. Set inTopLoader to true if the card is in a top loader. Provide the overall grade as both a numeric value (1-10) and include it in the summary.`,
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

    // Convert numeric grades to numeric values if needed
    const corners = typeof result.corners === "number" ? result.corners : 5;
    const edges = typeof result.edges === "number" ? result.edges : 5;
    let surface = typeof result.surface === "number" ? result.surface : 5;

    // If card is in a top loader, boost surface grade
    const inTopLoader = result.inTopLoader === true;
    if (inTopLoader) {
      if (surface + 3 <= 10) {
        surface = surface + 3;
      } else if (surface + 2 <= 10) {
        surface = surface + 2;
      }
      // If both would exceed 10, keep surface as is (capped at 10)
      surface = Math.min(10, surface);
    }

    // Calculate overall grade as average of the three factors (corners, edges, surface)
    // Centering is graded separately using dot placement
    const overallGrade = Math.round((corners + edges + surface) / 3);

    // Map numeric grade to PSA-like text grade
    let gradeText = "Unknown";
    if (overallGrade >= 9) gradeText = "Gem Mint";
    else if (overallGrade >= 8) gradeText = "Mint";
    else if (overallGrade >= 7) gradeText = "Near Mint";
    else if (overallGrade >= 6) gradeText = "Excellent";
    else if (overallGrade >= 5) gradeText = "Very Good";
    else if (overallGrade >= 4) gradeText = "Good";
    else if (overallGrade >= 3) gradeText = "Fair";
    else gradeText = "Poor";

    return res.status(200).json({
      corners: corners,
      edges: edges,
      surface: surface,
      grade: overallGrade,
      gradeText: gradeText,
      inTopLoader: inTopLoader,
      summary: result.summary || "Unable to assess",
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: error instanceof Error ? error.message : "Internal server error",
    });
  }
}
