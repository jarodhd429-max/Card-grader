export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  const apiKey = process.env.CLAUDE_API_KEY;

  return res.status(200).json({
    hasApiKey: !!apiKey,
    apiKeyLength: apiKey?.length || 0,
    apiKeyStart: apiKey ? apiKey.substring(0, 10) : "NONE",
    allEnvVars: Object.keys(process.env).filter(k => k.includes("CLAUDE") || k.includes("API")),
  });
}
