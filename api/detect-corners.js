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
    // Extract base64 data - handle both data URL and raw base64
    let base64Data = image;
    if (image.includes(',')) {
      const parts = image.split(',');
      base64Data = parts[1];
    }

    // Validate base64 data
    if (!base64Data || base64Data.length < 100) {
      return res.status(400).json({ error: 'Invalid image data - image too small' });
    }

    // Clean up base64 string (remove whitespace)
    base64Data = base64Data.replace(/\s/g, '');

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
              text: 'Analyze this trading card photo. Find the four outer corners of the card. Return coordinates as JSON with "tl", "tr", "br", "bl" (top-left, top-right, bottom-right, bottom-left). Each has "x" and "y" as percentages (0-100). Include "confidence" from 0-1. Return ONLY JSON, no other text.'
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
      const errorData = await response.json().catch(() => ({}));
      const errorMsg = errorData.error?.message || response.statusText || `HTTP ${response.status}`;
      throw new Error(errorMsg);
    }

    const data = await response.json();
    if (!data.content || !data.content[0] || !data.content[0].text) {
      throw new Error('Invalid response from Claude API');
    }

    const text = data.content[0].text;
    const result = JSON.parse(text);

    return res.status(200).json(result);
  } catch (error) {
    console.error('AI detection error:', error.message);
    return res.status(500).json({
      error: error.message || 'Failed to analyze image. Ensure your API key is valid.'
    });
  }
}
