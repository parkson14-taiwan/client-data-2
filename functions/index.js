const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const openaiApiKey = defineSecret("OPENAI_API_KEY");
const DEFAULT_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

function assertImagePayload(data) {
  const imageDataUrl = String(data?.imageDataUrl || "");
  if (!imageDataUrl.startsWith("data:image/")) {
    throw new HttpsError("invalid-argument", "imageDataUrl must be a data:image URL.");
  }
  if (imageDataUrl.length > 8_000_000) {
    throw new HttpsError("invalid-argument", "Image payload is too large. Keep screenshots under 6MB.");
  }
  return imageDataUrl;
}

function extractOutputText(responseJson) {
  if (typeof responseJson.output_text === "string") return responseJson.output_text;
  const chunks = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
      if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch (firstError) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw firstError;
    return JSON.parse(match[0]);
  }
}

exports.analyzeScreenshotIntake = onCall(
  {
    secrets: [openaiApiKey],
    invoker: "public",
    timeoutSeconds: 60,
    memory: "512MiB",
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in is required.");
    }

    const imageDataUrl = assertImagePayload(request.data);
    const prompt = [
      "You are extracting CRM intake information from a screenshot for an events/catering/yacht CRM.",
      "Return only one valid JSON object. Do not include markdown.",
      "Use ISO date format YYYY-MM-DD when a date is visible or inferable.",
      "If a field is missing, return an empty string instead of guessing.",
      "Schema:",
      JSON.stringify({
        customer: { name: "", phone: "", address: "" },
        case: {
          eventDate: "",
          enquiryNo: "",
          eventType: "",
          services: [],
          pax: "",
          paymentStatus: "",
          eventPrice: 0,
          notes: "",
        },
        confidence: { overall: 0, fields: {} },
        warnings: [],
      }),
      "Recognize English, Traditional Chinese, Simplified Chinese, and casual WhatsApp-style messages.",
      "Services should use short English labels like Food, Drinks, Venue/Yacht, Staffing, Payment, General.",
    ].join("\n");

    const apiKey = openaiApiKey.value().trim();

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: prompt },
              { type: "input_image", image_url: imageDataUrl },
            ],
          },
        ],
      }),
    });

    const responseJson = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("OpenAI screenshot analysis failed", response.status, responseJson);
      throw new HttpsError("internal", "OpenAI analysis failed.");
    }

    const outputText = extractOutputText(responseJson);
    if (!outputText) {
      throw new HttpsError("internal", "OpenAI returned an empty response.");
    }

    try {
      return parseJsonObject(outputText);
    } catch (error) {
      console.error("Failed to parse OpenAI JSON", outputText, error);
      throw new HttpsError("internal", "AI response was not valid JSON.");
    }
  },
);
