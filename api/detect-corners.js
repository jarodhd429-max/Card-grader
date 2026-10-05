export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { image } = req.body;
  if (!image) {
    return res.status(400).json({ error: 'No image provided' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    // Extract base64 data if it has the data URL prefix
    const base64Data = image.includes(',') ? image.split(',')[1] : image;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analyze this trading card photo. Identify the four corners of the card (outer corners of the white/colored border). Return the coordinates as JSON with keys "tl", "tr", "br", "bl" (top-left, top-right, bottom-right, bottom-left), each with "x" and "y" as percentages of image width/height (0-100). Also provide a "confidence" score from 0-1. Return ONLY valid JSON, no other text. Example: {"tl":{"x":10,"y":15},"tr":{"x":90,"y":20},"br":{"x":92,"y":85},"bl":{"x":8,"y":80},"confidence":0.95}'
            },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: base64Data
              }
            }
          ]
        }]
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const text = data.content[0].text;
    const result = JSON.parse(text);

    return res.status(200).json(result);
  } catch (error) {
    console.error('AI detection error:', error);
    return res.status(500).json({
      error: error.message || 'Failed to analyze image'
    });
  }
}
