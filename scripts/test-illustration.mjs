import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_ID =
  process.env.GEHON_IMAGEN_PROJECT_ID ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  process.env.GCLOUD_PROJECT;
const LOCATION = process.env.GEHON_IMAGEN_LOCATION || "us-central1";
const MODEL_ID =
  process.argv[2] ||
  process.env.GEHON_IMAGEN_MODEL ||
  process.env.GEHON_ILLUSTRATION_MODEL ||
  "imagen-3.0-fast-generate-001";
const PROMPT =
  process.argv[3] ||
  "水彩画風で、竹から生まれた少女が夜空を見上げるシーン";

if (!PROJECT_ID) {
  console.error("プロジェクトIDが取得できません。GEHON_IMAGEN_PROJECT_ID を設定してください。");
  process.exit(1);
}

const vertexEndpoint = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT_ID}/locations/${LOCATION}/publishers/google/models/${MODEL_ID}:predict`;
const geminiImagesEndpoint = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateImages`;

const getAccessToken = async () => {
  if (process.env.GEHON_IMAGEN_ACCESS_TOKEN) {
    return process.env.GEHON_IMAGEN_ACCESS_TOKEN;
  }
  throw new Error("GEHON_IMAGEN_ACCESS_TOKEN を設定するか、Cloud Run 等の GCP 環境で実行してください。");
};

const main = async () => {
  console.log(`モデル: ${MODEL_ID}`);
  console.log(`プロンプト: ${PROMPT}`);

  // NOTE: ウォーターマーク有効時は seed 非対応のため未使用
  // 1) GEMINI_API_KEY があれば Gemini API の画像生成を試す
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    console.log("Gemini API :generateImages を試します...");
    const resGemini = await fetch(`${geminiImagesEndpoint(MODEL_ID)}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: { text: PROMPT },
        imageGenerationConfig: { numberOfImages: 1, aspectRatio: "1:1" },
      }),
    });
    if (resGemini.ok) {
      const payload = await resGemini.json();
      const candidate = payload?.generatedImages?.[0] || payload?.predictions?.[0] || payload?.images?.[0];
      const base64 =
        candidate?.image?.base64Data ||
        candidate?.image?.inlineData?.data ||
        candidate?.bytesBase64Encoded ||
        candidate?.imageBytes ||
        candidate?.b64_json;
      if (base64) {
        const buffer = Buffer.from(base64, "base64");
        const outPath = path.resolve(__dirname, "test-image.png");
        fs.writeFileSync(outPath, buffer);
        console.log(`画像を保存しました: ${outPath}`);
        return;
      }
      console.error("Gemini 画像レスポンスから base64 を抽出できませんでした", payload);
    } else {
      console.error("Gemini API 呼び出しに失敗", await resGemini.text());
    }
  }

  // 2) フォールバック: Vertex AI Predict を使用
  console.log("Vertex AI Predict を試します...");
  const token = await getAccessToken();
  const response = await fetch(vertexEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      instances: [
        { prompt: PROMPT, negativePrompt: "恐怖・暴力・成人向けの表現は避けてください。" },
      ],
      parameters: { sampleCount: 1, aspectRatio: "1:1" },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Imagen API 呼び出しに失敗しました (status ${response.status}): ${text}`);
  }

  const payload = await response.json();
  const prediction = payload?.predictions?.[0] || payload?.generatedImages?.[0] || payload?.images?.[0];
  if (!prediction) throw new Error(`レスポンスに画像が含まれていません: ${JSON.stringify(payload)}`);
  const base64 =
    prediction?.bytesBase64Encoded ||
    prediction?.imageBytes ||
    prediction?.b64_json ||
    prediction?.image?.base64Data ||
    prediction?.image?.bytesBase64Encoded;
  if (!base64) throw new Error(`base64 画像を抽出できませんでした: ${JSON.stringify(payload)}`);

  const buffer = Buffer.from(base64, "base64");
  const outPath = path.resolve(__dirname, "test-image.png");
  fs.writeFileSync(outPath, buffer);
  console.log(`画像を保存しました: ${outPath}`);
};

main().catch((error) => {
  console.error("画像生成に失敗しました:", error);
  process.exit(1);
});
