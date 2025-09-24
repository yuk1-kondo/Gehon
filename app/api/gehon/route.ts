import { NextResponse } from "next/server";
import { Storage } from "@google-cloud/storage";

interface AIPage {
  idx: number;
  right_text_ja: string;
  left_image_desc: string;
}

// API レスポンス用ページ型（ループ内での再宣言を避ける）
type EngineName = "preview" | "gemini" | "vertex";
interface PageResult {
  idx: number;
  text: string;
  imageDataUrl: string;
  promptPreview?: string;
  promptFull?: string;
  engine?: EngineName | "fallback";
  leftImageDesc?: string; // textOnly モード用
  audioDataUrl?: string; // tts=1 のときに各ページの音声を付与
}

interface StoryDefinition {
  title: string;
  summary: string;
}

const STORY_LIBRARY: Record<string, StoryDefinition> = {
  north_wind_and_sun: {
    title: "北風と太陽",
    summary:
      "旅人の上着を脱がせようと競い合う北風と太陽の物語。力ではなく温かさが勝つことを教えてくれます。",
  },
  golden_axe: {
    title: "金の斧",
    summary:
      "正直者の木こりが誠実さを試され、金銀の斧を授かる寓話。正直さと善行の大切さを伝えます。",
  },
  hare_and_tortoise: {
    title: "うさぎとかめ",
    summary:
      "速さを自慢するうさぎと、地道に歩むかめのかけっこ。最後まで諦めず続ける価値を語る物語。",
  },
  momotaro: {
    title: "桃太郎",
    summary:
      "桃から生まれた桃太郎が犬・猿・雉とともに鬼退治へ向かい、宝を取り戻す冒険譚。勇気と仲間の力を描きます。",
  },
  urashima_taro: {
    title: "浦島太郎",
    summary:
      "亀を助けた浦島太郎が竜宮城で歓迎され、不思議な玉手箱を授かる物語。時間と選択の不思議さがテーマです。",
  },
  kaguyahime: {
    title: "かぐや姫",
    summary:
      "竹から生まれた美しいかぐや姫が、育ての親に幸せをもたらし、月へ帰る哀しい昔話。優しさと別れが描かれます。",
  },
  issun_boshi: {
    title: "一寸法師",
    summary:
      "小さな体で都へ旅立った一寸法師が、知恵と勇気で鬼を退治し、立派な侍になる物語。努力と成長を伝えます。",
  },
};

const STORY_MODEL = process.env.GEHON_STORY_MODEL || "gemini-2.5-flash";
const IMAGEN_MODEL =
  process.env.GEHON_IMAGEN_MODEL || process.env.GEHON_ILLUSTRATION_MODEL || "imagen-3.0-fast-generate-001";
const IMAGEN_LOCATION = process.env.GEHON_IMAGEN_LOCATION || "us-central1";
// 画像生成の優先エンジン: "gemini" | "vertex"（既定: gemini）
// preview = Gemini 2.5 Flash Image Preview（Nano Banana）
const IMAGE_PRIMARY = (process.env.GEHON_IMAGE_PRIMARY || "gemini").toLowerCase();
const PREVIEW_IMAGE_MODEL = process.env.GEHON_PREVIEW_MODEL || "gemini-2.5-flash-image-preview";
const IMAGE_BUCKET = process.env.GEHON_IMAGE_BUCKET || ""; // 任意設定。未設定ならアップロードはスキップ

const GEMINI_ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// Gemini Images API はモデルを URL ではなくボディで指定する "imagegeneration:generate" エンドポイントを使用
const GEMINI_IMAGES_ENDPOINT =
  `https://generativelanguage.googleapis.com/v1beta/models/imagegeneration:generate`;
// Google Cloud Text-to-Speech REST API
const TTS_ENDPOINT = `https://texttospeech.googleapis.com/v1/text:synthesize`;

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const METADATA_PROJECT_URL = "http://metadata.google.internal/computeMetadata/v1/project/project-id";

const escapeForSvg = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const generateSvgPlaceholder = (text: string) => {
  const sanitizedLines = escapeForSvg(text)
    .split("\n")
    .map((line, index) => `<tspan x="50%" dy="${index === 0 ? 0 : "1.2em"}">${line}</tspan>`)
    .join("");

  const svg = `
    <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f0e6d2"/>
      <text x="50%" y="50%" font-family="'Noto Sans JP', sans-serif" font-size="20" fill="#5c5c5c" text-anchor="middle" dominant-baseline="middle" style="white-space: pre-wrap;">
        ${sanitizedLines}
      </text>
    </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
};

// File -> data URL 変換（Next.js Route Handler の File を想定）
const fileToDataUrl = async (f: File | null | undefined): Promise<string | null> => {
  if (!f) return null;
  try {
    const buf = Buffer.from(await f.arrayBuffer());
    const mime = f.type || "application/octet-stream";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
};

// 画像の inlineData/inline_data を抽出（Gemini generateContent 応答）
const extractInlineImageDataUrl = (data: unknown): string | null => {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

  const candidates: unknown[] = isObject(data) && Array.isArray((data as Record<string, unknown>).candidates)
    ? ((data as Record<string, unknown>).candidates as unknown[])
    : [];

  for (const c of candidates) {
    if (!isObject(c)) continue;
    const content = (c.content && isObject(c.content)) ? (c.content as Record<string, unknown>) : undefined;
    const parts = content && Array.isArray(content.parts) ? (content.parts as unknown[]) : [];
    for (const p of parts) {
      if (!isObject(p)) continue;
      const inline1 = isObject(p.inlineData) ? (p.inlineData as Record<string, unknown>) : undefined; // { mimeType, data }
      const inline2 = isObject(p.inline_data) ? (p.inline_data as Record<string, unknown>) : undefined; // { mime_type, data }
      const mime = (inline1?.mimeType as string | undefined) || (inline2?.mime_type as string | undefined);
      const b64 = (inline1?.data as string | undefined) || (inline2?.data as string | undefined);
      if (mime && b64) return `data:${mime};base64,${b64}`;
    }
  }

  // 一部実装の代替フィールド
  if (isObject(data)) {
    const image = isObject((data as Record<string, unknown>).image)
      ? ((data as Record<string, unknown>).image as Record<string, unknown>)
      : undefined;
    const b64Alt =
      (image && typeof image.base64Data === "string" ? (image.base64Data as string) : undefined) ||
      (typeof (data as Record<string, unknown>).bytesBase64Encoded === "string"
        ? ((data as Record<string, unknown>).bytesBase64Encoded as string)
        : undefined);
    if (b64Alt) return `data:image/png;base64,${b64Alt}`;
  }
  return null;
};

// data URL を { mimeType, base64 } に分解
const parseDataUrl = (
  dataUrl: string | null | undefined,
): { mimeType: string; base64: string } | null => {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  return { mimeType: m[1], base64: m[2] };
};

// --- 画像類似度: aHash(8x8, grayscale) の簡易実装 --------------------------
// 依存を抑えるため、PNG/JPEG の最小限デコードに失敗したら null を返す。
// Cloud Run ランタイム負荷を避けるため 64px までに縮小して平均輝度でハッシュ。
// (removed unused NextConfig import)
let decodePng: ((buf: Buffer) => { width: number; height: number; data: Uint8Array }) | null = null;
let decodeJpeg: ((buf: Buffer) => { width: number; height: number; data: Uint8Array }) | null = null;

try {
  // 可能なら動的 import（ビルド時に存在しない場合でも実行時に解決されればOK）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pngjs = require("pngjs");
  decodePng = (buf: Buffer) => {
    const PNG = pngjs.PNG;
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: png.data };
  };
} catch {}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const jpeg = require("jpeg-js");
  decodeJpeg = (buf: Buffer) => {
    const out = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 32 });
    return { width: out.width, height: out.height, data: out.data };
  };
} catch {}

const toGrayscaleAHash64 = (mime: string, b64: string): string | null => {
  try {
    const buf = Buffer.from(b64, "base64");
    let decoded: { width: number; height: number; data: Uint8Array } | null = null;
    if (mime.includes("png") && decodePng) decoded = decodePng(buf);
    if (!decoded && mime.includes("jpeg") && decodeJpeg) decoded = decodeJpeg(buf);
    if (!decoded && decodePng) decoded = decodePng(buf); // 最後の望み
    if (!decoded) return null;

    const { width, height, data } = decoded;
    // 8x8 に最近傍縮小（RGBA または RGB を仮定）
    const getPixel = (x: number, y: number) => {
      const xi = Math.min(width - 1, Math.max(0, Math.round((x / 8) * (width - 1))));
      const yi = Math.min(height - 1, Math.max(0, Math.round((y / 8) * (height - 1))));
      const idx = (yi * width + xi) * 4;
      const r = data[idx] ?? 0;
      const g = data[idx + 1] ?? 0;
      const b = data[idx + 2] ?? 0;
      // 輝度（BT.601 近似）
      return 0.299 * r + 0.587 * g + 0.114 * b;
    };

    const vals: number[] = [];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        vals.push(getPixel(x, y));
      }
    }
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return vals.map((v) => (v >= avg ? "1" : "0")).join(""); // 64-bit ビット列文字列
  } catch {
    return null;
  }
};

const hammingDistance = (a: string, b: string): number => {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) d += a[i] === b[i] ? 0 : 1;
  d += Math.abs(a.length - b.length);
  return d;
};

const hashString = (value: string) => {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
};

// 絵柄の統一: 日本の昔話絵本風のアートディレクションとネガティブ要素
const ART_DIRECTION = {
  styleTitle: "日本の昔話・水彩絵本スタイル",
  styleKeywords: [
    "やわらかな水彩",
    "手描きのラフな線",
    "低コントラスト",
    "和紙の質感",
    "子ども向けの簡潔な形状",
    "落ち着いた和色",
  ],
  palette: [
    { name: "生成り", hex: "#F3EAD3" },
    { name: "藍色", hex: "#274A78" },
    { name: "朱色", hex: "#E95464" },
    { name: "松葉色", hex: "#6B8E23" },
    { name: "墨色", hex: "#2B2B2B" },
  ],
  composition: [
    "主人公を画面中央〜やや下に配置",
    "背景は簡素化し、余白を活かす",
    "やわらかな陰影と淡い彩度",
  ],
  character: {
    body: "二頭身〜二・五頭身のデフォルメ",
    face: "丸い目・小さな鼻と口・頬に薄い紅",
    line: "茶系または薄墨の輪郭線",
  },
  avoid: [
    "写真風・フォトリアル・実写",
    "3D・CGI・レンダリング・ハイパーリアル",
    "過度なディテール・高コントラスト",
    "現代的な機械・電子機器・英字/数字・ブランド名・型番",
    "©記号・署名・ロゴ・ウォーターマーク",
    "暴力的・恐怖を与える表現・成人向け表現",
    // 追加: 主人公は人間。獣耳・擬人化・ケモ耳などは避ける
    "獣耳・ケモ耳・擬人化・獣人・半人半獣・ヒト型の動物",
  ],
} as const;

const buildIllustrationPrompt = (
  storyTitle: string,
  pageDescription: string,
  childNameDisplay: string,
  storyTextSnippet?: string,
) => {
  const paletteText = ART_DIRECTION.palette
    .map((p) => `${p.name}(${p.hex})`)
    .join("、");
  const styleText = ART_DIRECTION.styleKeywords.join("、");
  const compText = ART_DIRECTION.composition.join("、");
  const avoidText = ART_DIRECTION.avoid.join("、");

  const storyGuide = storyTextSnippet ? `物語本文の要点: ${storyTextSnippet}\n` : "";
  return (
    `スタイル: ${ART_DIRECTION.styleTitle}。${styleText}。 children's book watercolor illustration, hand-drawn, soft brush.\n` +
    `和色パレット: ${paletteText} を基調。\n` +
    `画面構成: ${compText}。背景はやや抽象化し、塗りのにじみを活かす。\n` +
    `主人公: 「${childNameDisplay}」。毎ページで同一人物として描写し、髪型・服装・体型・配色を一貫させる。\n` +
    `前提: 主人公は人間の子ども「${childNameDisplay}」。動物を主役にしない（動物は脇役にとどめる）。\n` +
    `物語の題材: 「${storyTitle}」の日本の昔話風解釈。\n` +
    storyGuide +
    `ページの内容指示: ${pageDescription}。\n` +
    `主人公「${childNameDisplay}」が場面の中心で何らかの役割や行動を担っている様子を明確に描写。\n` +
    `質感: 和紙の紙地に水彩で淡く着彩。手描きの筆致。描き込みは控えめ。\n` +
    `重要: これは写真ではなく、水彩の手描きイラストです。実写やカメラ/レンズ/被写界深度の表現は禁止。写実的な毛並みや肌質も禁止。\n` +
    `避けるべき表現: ${avoidText}（英数字や英語文字列、カメラ/レンズ用語、ブランド名・型番、現代ガジェットの描写を含めない）。\n` +
    `最終画像はイラストのみ（文字・サイン・フレームなし）。`
  );
};

const fetchJson = async (input: RequestInfo | URL, init?: RequestInit) => {
  const response = await fetch(input, init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed with status ${response.status}: ${text}`);
  }
  return response.json();
};

const generateStory = async (prompt: string) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEYが設定されていません。");
  }

  const systemInstruction = {
    role: "system",
    parts: [
      {
        text: `You are a picture-book maker for children.
Output STRICT JSON with an object {"pages":[...]} of length 10 (five spreads).
Each item must include:
- "idx": 1..10
- "right_text_ja": 150-200 Japanese characters, warm/simple words, include the child’s name at least once.
- "left_image_desc": a 1-sentence visual description (in Japanese) for a watercolor-style illustration (NO camera/lens/photography terms).

Constraints:
- Style: Japanese folktale picture-book tone (昔話の語り口)。
- Time/props: Avoid modern items and technology (no phones, cars, PCs, brands, product names, alphanumerics). Keep pre-modern vibe unless source explicitly needs otherwise.
- Safety: Avoid scary/violent/sexual expressions.
- Names: If the provided child name contains English letters/numbers or looks like a brand or product code, replace it with a simple Japanese given name (ひらがな/やさしい日本語) suitable for children.

No extra commentary. JSON only.`,
      },
    ],
  };

  const body = {
    systemInstruction,
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.8,
      topK: 1,
      topP: 1,
      maxOutputTokens: 8192,
      responseMimeType: "application/json",
    },
  };

  const data = await fetchJson(`${GEMINI_ENDPOINT(STORY_MODEL)}?key=${apiKey}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const candidates = data?.candidates ?? [];
  const collected: string[] = [];

  for (const candidate of candidates) {
    const parts = candidate?.content?.parts ?? [];
    for (const part of parts) {
      if (typeof part?.text === "string" && part.text.trim()) {
        collected.push(part.text as string);
      }
    }
  }

  if (typeof data?.text === "string" && data.text.trim()) {
    collected.push(data.text as string);
  }

  if (collected.length === 0) {
    console.error("Gemini から本文テキストを取得できませんでした", JSON.stringify(data));
    throw new Error("Gemini から本文が返りませんでした。");
  }

  return collected.join("\n");
};

const tryParseJson = (raw: string): { pages: AIPage[] } | null => {
  const normalized = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  if (!normalized) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    const start = normalized.indexOf("{");
    const end = normalized.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) {
      return null;
    }

    const candidate = normalized.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  }
};

const resolveProjectId = async () => {
  const envProject =
    process.env.GEHON_IMAGEN_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCLOUD_PROJECT;

  if (envProject) {
    return envProject;
  }

  try {
    const response = await fetch(METADATA_PROJECT_URL, {
      headers: { "Metadata-Flavor": "Google" },
    });
    if (response.ok) {
      return response.text();
    }
  } catch (error) {
    console.warn("プロジェクトIDの自動取得に失敗しました", error);
  }

  return null;
};

const fetchAccessToken = async () => {
  if (process.env.GEHON_IMAGEN_ACCESS_TOKEN) {
    return process.env.GEHON_IMAGEN_ACCESS_TOKEN;
  }

  try {
    const response = await fetch(METADATA_TOKEN_URL, {
      headers: { "Metadata-Flavor": "Google" },
    });
    if (response.ok) {
      const payload = (await response.json()) as { access_token?: string };
      if (payload.access_token) {
        return payload.access_token;
      }
    }
  } catch (error) {
    console.warn("アクセストークンの自動取得に失敗しました", error);
  }

  throw new Error(
    "Imagen API を呼び出すためのアクセストークンを取得できませんでした。Cloud Run で実行するか GEHON_IMAGEN_ACCESS_TOKEN を設定してください。",
  );
};

// TTS 生成（ja-JP）。成功時 MP3 data URL を返す
const synthesizeTts = async (text: string): Promise<string | null> => {
  try {
    const accessToken = await fetchAccessToken();
    const voice = process.env.GEHON_TTS_VOICE || "ja-JP-Neural2-C";
    const speakingRate = Number(process.env.GEHON_TTS_RATE || 1.0);
    const pitch = Number(process.env.GEHON_TTS_PITCH || 0.0);
    const reqBody = {
      input: { text },
      voice: { languageCode: "ja-JP", name: voice },
      audioConfig: { audioEncoding: "MP3", speakingRate, pitch },
    } as const;
    const resp = await fetch(TTS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(reqBody),
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.warn("TTS 呼び出し失敗:", resp.status, t);
      return null;
    }
    const data = await resp.json();
    const audioB64 = data?.audioContent;
    if (!audioB64) return null;
    return `data:audio/mpeg;base64,${audioB64}`;
  } catch (e) {
    console.warn("TTS 生成中にエラー:", e);
    return null;
  }
};

// 呼称整形: name + (くん/ちゃん/なし)
type Honorific = "kun" | "chan" | "none";
const displayNameWithHonorific = (name: string, honorific: Honorific): string => {
  if (!name) return name;
  if (honorific === "kun") return `${name}くん`;
  if (honorific === "chan") return `${name}ちゃん`;
  return name;
};

// ページ比率は絵本らしさを優先して全ページ 3:4 に統一
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const aspectRatioForPage = (_idx: number): "1:1" | "3:4" => "3:4";

// 画像説明のリライト: 昔話・水彩絵本向けの1文に整形（失敗時はサニタイズ）
const rewriteImageDesc = async (
  storyTitle: string,
  childName: string,
  originalDesc: string,
): Promise<string> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return sanitizeImageDesc(originalDesc);

  const sys = {
    role: "system",
    parts: [
      {
        text:
          "You rewrite Japanese prompts for a watercolor Japanese folktale picture book. Output ONE short Japanese sentence only, no quotes. Remove modern/brand/camera terms, English letters and numbers. Keep pre-modern vibe, soft watercolor, child-friendly.",
      },
    ],
  };
  const userText = `題材: ${storyTitle}\n主人公: ${childName}\n元の説明: ${originalDesc}\n出力条件: 1文/日本語/水彩絵本/昔話風/現代物・英数字・ブランド・カメラ用語なし`;

  try {
    const body = {
      systemInstruction: sys,
      contents: [{ role: "user", parts: [{ text: userText }] }],
      generationConfig: { temperature: 0.6, topK: 1, topP: 1, maxOutputTokens: 256, responseMimeType: "text/plain" },
    };
    const resp = await fetch(`${GEMINI_ENDPOINT(STORY_MODEL)}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`rewriteImageDesc failed ${resp.status}`);
    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.text || "";
    const out = (typeof text === "string" ? text : "").trim();
    return out || sanitizeImageDesc(originalDesc);
  } catch (e) {
    console.warn("画像説明のリライトに失敗: ", e);
    return sanitizeImageDesc(originalDesc);
  }
};

const sanitizeImageDesc = (s: string) => {
  let t = s;
  // 英数字や製品コードっぽい連続英数を除去
  t = t.replace(/[A-Za-z0-9#_\-]{2,}/g, "");
  // カメラ/レンズ/写真撮影用語を削除
  t = t.replace(/(カメラ|レンズ|ボケ|被写界深度|スタジオ照明|スタジオ|撮影|フォト|写真|RAW|JPEG|背景紙)/g, "");
  // 現代ガジェット
  t = t.replace(/(スマホ|スマートフォン|パソコン|PC|ノートPC|タブレット|テレビ|ブランド|ロゴ)/g, "");
  // 余分な空白を整形
  t = t.replace(/\s+/g, " ").trim();
  // 最低限のフォールバック
  if (!t) t = "やわらかな水彩で描かれた、昔話の一場面。";
  return t;
};

// 物語本文のサニタイズ（ブランド/英数字/現代ガジェット語を排除）
const sanitizeRightTextJa = (s: string, _childNameDisplay: string) => {
  let t = s;
  // 連続英数字・型番風を除去
  t = t.replace(/[A-Za-z0-9#_\-]{2,}/g, "");
  // 現代ガジェット・ブランド系の一般語を弱め/除去
  t = t.replace(/(スマホ|スマートフォン|ディスプレイ|オーディオ|カメラ|レンズ|テレビ|パソコン|PC|ノートPC|タブレット|ブランド|ロゴ)/g, "");
  // © 記号など
  t = t.replace(/[©®™]/g, "");
  // 空白整理
  t = t.replace(/\s+/g, " ").replace(/\s*、\s*/g, "、").trim();
  return t;
};

// Gemini API (Imagen 3 via Gemini) を優先して画像生成
const generateIllustrationViaGemini = async (
  prompt: string,
  aspectRatio: string,
) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const endpoint = `${GEMINI_IMAGES_ENDPOINT}?key=${apiKey}`;

    const body = {
      model: IMAGEN_MODEL,
      prompt: { text: prompt },
      // フォトリアル回避のためネガティブプロンプトも併記（未対応の場合は無視される）
      negativePrompt:
        "photo, photograph, real photo, stock photo, snapshot, camera, lens, depth of field, dof, photorealistic, realistic, CGI, 3D, render, hyperrealistic, signature, watermark, logo, text, letters, numbers, brand, model number, modern device, phone, smartphone, pc, laptop, keyboard, screen, monitor, display, audio device, television, gore, blood, violence, scary, horror, realistic fur, real fur, animal photograph, anthropomorphic, furry, kemono, animal ears, beast ears, human-animal hybrid, kemomimi",
      imageGenerationConfig: {
        numberOfImages: 1,
        aspectRatio,
        // NOTE: ウォーターマーク有効時は seed 非対応のため未指定
      },
    } as Record<string, unknown>;

    const data = await fetchJson(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // 返却形式の取りうるバリエーションを広めに吸収
    const candidate =
      data?.generatedImages?.[0] ||
      data?.predictions?.[0] ||
      data?.images?.[0];

    const base64 =
      candidate?.image?.base64Data ||
      candidate?.image?.inlineData?.data ||
      candidate?.bytesBase64Encoded ||
      candidate?.imageBytes ||
      candidate?.b64_json;

    if (!base64) {
      console.error("Gemini 画像レスポンスから base64 を抽出できませんでした", data);
      return null;
    }

    const mimeType = candidate?.mimeType || "image/png";
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error("Gemini 画像生成に失敗しました", error);
    return null;
  }
};

// Gemini 2.5 Flash Image Preview（Nano Banana）経由で画像生成
const generateIllustrationViaGeminiPreview = async (
  prompt: string,
  aspectRatio: string,
  referenceImage?: { mimeType: string; dataBase64: string },
) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
  // 画像を1枚インラインで返すよう要求（互換のため両方の取り出し方を試す）
  type GenerateContentPart = { text?: string; inlineData?: { mimeType: string; data: string } };
  const parts: GenerateContentPart[] = [];
    if (referenceImage) {
      // 前ページ画像を参照として添付
      parts.push({ inlineData: { mimeType: referenceImage.mimeType, data: referenceImage.dataBase64 } });
      parts.push({
        text:
          `${prompt}\n` +
          `キャンバス比率: ${aspectRatio}（縦構図）\n` +
          `参照画像の雰囲気・色味・主人公の外見（髪型・服装・配色）を保ちつつ、上記の内容に従って新しい場面を水彩で描いてください。` ,
      });
    } else {
      parts.push({ text: `${prompt}\nキャンバス比率: ${aspectRatio}（縦構図）` });
    }

    const body = {
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      // Preview モデルは response_mime_type に画像 MIME を要求できないため指定しない
      generationConfig: {
        temperature: 0.7,
        topK: 1,
        topP: 1,
        maxOutputTokens: 1024,
      },
    };

    const data = await fetchJson(`${GEMINI_ENDPOINT(PREVIEW_IMAGE_MODEL)}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const url = extractInlineImageDataUrl(data);
    if (url) return url;
    console.error("Gemini Preview レスポンスから画像を抽出できませんでした", data);
    return null;
  } catch (error) {
    console.error("Gemini Preview 画像生成に失敗しました", error);
    return null;
  }
};

// Vertex AI Predict (公開モデル) を呼ぶ
const generateIllustrationViaVertex = async (
  prompt: string,
  aspectRatio: string,
) => {
  try {
    const projectId = await resolveProjectId();
    if (!projectId) {
      console.error("Imagen API を呼び出すためのプロジェクト ID を解決できませんでした。");
      return null;
    }

    const accessToken = await fetchAccessToken();
    const endpoint = `https://${IMAGEN_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${IMAGEN_LOCATION}/publishers/google/models/${IMAGEN_MODEL}:predict`;

    const body = {
      instances: [
        {
          prompt,
          negativePrompt:
            "photo, photograph, real photo, stock photo, snapshot, camera, lens, depth of field, dof, photorealistic, realistic, CGI, 3D, render, hyperrealistic, signature, watermark, logo, text, letters, numbers, brand, model number, modern device, phone, smartphone, car, pc, laptop, keyboard, screen, monitor, display, audio device, television, gore, blood, violence, scary, horror, realistic fur, real fur, animal photograph, anthropomorphic, furry, kemono, animal ears, beast ears, human-animal hybrid, kemomimi",
        },
      ],
      parameters: {
        sampleCount: 1,
        aspectRatio,
        // NOTE: ウォーターマーク有効時は seed 非対応のため未指定
      },
    };

    const data = await fetchJson(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    const prediction =
      data?.predictions?.[0] || data?.generatedImages?.[0] || data?.images?.[0];
    if (!prediction) {
      console.error("Imagen API のレスポンスに画像が含まれていません", data);
      return null;
    }

    const base64 =
      prediction?.bytesBase64Encoded ||
      prediction?.imageBytes ||
      prediction?.b64_json ||
      prediction?.image?.base64Data ||
      prediction?.image?.bytesBase64Encoded;

    if (!base64) {
      console.error("Imagen API のレスポンスから base64 画像を抽出できませんでした", data);
      return null;
    }

    const mimeType = prediction?.mimeType || "image/png";
    return `data:${mimeType};base64,${base64}`;
  } catch (error) {
    console.error("Vertex Imagen 呼び出しでエラーが発生しました", error);
    return null;
  }
};

const generateIllustration = async (
  prompt: string,
  aspectRatio: string,
  primary: EngineName,
  previousDataUrl?: string | null,
): Promise<{ dataUrl: string | null; engine: EngineName | "fallback" }> => {
  const orderSets: Record<EngineName, EngineName[]> = {
    preview: ["preview", "gemini", "vertex"],
    gemini: ["gemini", "vertex", "preview"],
    vertex: ["vertex", "gemini", "preview"],
  };

  const baseOrder = orderSets[primary] || orderSets.gemini;
  // 参照画像がある場合は Preview を最優先（重複除去）
  const order = previousDataUrl
    ? Array.from(new Set(["preview", ...baseOrder])) as EngineName[]
    : baseOrder;

  const refParsed = parseDataUrl(previousDataUrl || undefined);
  for (const engine of order) {
    let res: string | null = null;
    if (engine === "preview") {
      res = await generateIllustrationViaGeminiPreview(
        prompt,
        aspectRatio,
        refParsed ? { mimeType: refParsed.mimeType, dataBase64: refParsed.base64 } : undefined,
      );
    }
    if (engine === "gemini") res = await generateIllustrationViaGemini(prompt, aspectRatio);
    if (engine === "vertex") res = await generateIllustrationViaVertex(prompt, aspectRatio);
    if (res) return { dataUrl: res, engine };
  }
  return { dataUrl: null, engine: "fallback" };
};

// （以前の並列処理ヘルパは未使用のため削除）

export async function POST(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEYが設定されていません。" }, { status: 500 });
  }

  try {
  const url = new URL(request.url);
    // debug フラグの解釈を寛容に（クエリ/ヘッダ/環境変数）
    const rawQueryValue = url.searchParams.get("debug");
    const hasDebugParam = url.searchParams.has("debug");
    const normalizedQuery = (rawQueryValue ?? "").toLowerCase();
    const queryEnables = hasDebugParam && !["0", "false", "off", "no"].includes(normalizedQuery);

    const rawHeader = (request.headers.get("x-debug-prompt") ?? "").toLowerCase();
    const headerEnables = ["1", "true", "yes", "on"].includes(rawHeader);

    const rawEnv = (process.env.GEHON_DEBUG_PROMPT ?? "").toLowerCase();
    const envEnables = ["1", "true", "yes", "on"].includes(rawEnv);

    const debugFlag = queryEnables || headerEnables || envEnables;
    if (debugFlag) {
      console.log(`[DEBUG] prompt visibility enabled (query=${rawQueryValue ?? "<none>"}, header=${rawHeader || "<none>"}, env=${rawEnv || "<none>"})`);
    }
  const formData = await request.formData();
    const childName = formData.get("name") as string;
    const honorificRaw = (formData.get("honorific") as string | null)?.toString() || "none";
    const honorific = (['kun','chan','none'].includes(honorificRaw) ? honorificRaw : 'none') as 'kun'|'chan'|'none';
    const childNameDisplay = displayNameWithHonorific(childName, honorific);
  const _ageHint = (formData.get("ageHint") as string) || ""; // 廃止（互換のため受理はするが未使用）
  const _traitsRaw = (formData.get("traits_raw") as string) || ""; // 廃止（互換のため受理はするが未使用）
    const storyId = formData.get("storyId") as string;
    const customStory = (formData.get("customStory") as string | null)?.trim() ?? "";

    if (!childName || !storyId) {
      return NextResponse.json({ error: "必須項目が入力されていません。" }, { status: 400 });
    }

    let storyInstruction: string;

    if (storyId === "custom") {
      if (!customStory) {
        return NextResponse.json({ error: "オリジナルストーリーの内容を入力してください。" }, { status: 400 });
      }
      storyInstruction = `ユーザーが希望するオリジナルストーリーの概要:\n${customStory}`;
    } else {
      const storyDefinition = STORY_LIBRARY[storyId];
      if (!storyDefinition) {
        return NextResponse.json({ error: "選択されたストーリーはサポートされていません。" }, { status: 400 });
      }
      storyInstruction = `元となる昔話のタイトル: ${storyDefinition.title}\nあらすじ: ${storyDefinition.summary}`;
    }

  const prompt = `以下の条件を満たす日本語の絵本を作成してください。\n主人公の名前: ${childName}\nストーリーの材料:\n${storyInstruction}\n各ページで主人公が具体的な役割や行動を担うようにしてください。子どもが共感できる温かい展開にし、恐怖や暴力的な描写は避けてください。`;

    let attempt = 0;
    let parsedResponse: { pages: AIPage[] } | null = null;
    let storyText = "";

    while (attempt < 2 && !parsedResponse) {
      attempt++;
      try {
        storyText = await generateStory(prompt);
        parsedResponse = tryParseJson(storyText);
        if (!parsedResponse) {
          console.error(`Attempt ${attempt} failed to parse story JSON`, storyText);
        }
      } catch (error) {
        console.error(`Attempt ${attempt} failed to generate story`, error);
      }
    }

    if (!parsedResponse || !parsedResponse.pages || parsedResponse.pages.length !== 10) {
      return NextResponse.json(
        {
          error: "AIレスポンスの解析に失敗しました。JSON形式でデータが返ってきませんでした。",
          ai_response: storyText || undefined,
        },
        { status: 500 },
      );
    }

    const deterministicSeedBase =
      hashString(`${childName}|${storyId}|${customStory}`) % 2147483647;

    const storyTitleForArt =
      storyId === "custom" ? "オリジナル" : (STORY_LIBRARY[storyId]?.title ?? "昔話");

    const storage = IMAGE_BUCKET ? new Storage() : null;

  // textOnly=1 なら本文のみ返す（画像生成スキップ）
  const ttsEnabledRaw = url.searchParams.get("tts") || "";
  const ttsEnabled = ["1","true","yes","on"].includes(ttsEnabledRaw.toLowerCase());
  const textOnlyRaw = url.searchParams.get("textOnly") || "";
  const textOnly = ["1", "true", "on", "yes"].includes(textOnlyRaw.toLowerCase());
  if (textOnly) {
    const pagesOnly: PageResult[] = [];
    for (const page of parsedResponse.pages) {
      const cleanedRightText = sanitizeRightTextJa(page.right_text_ja, childNameDisplay);
      const item: PageResult = {
        idx: page.idx,
        text: cleanedRightText,
        imageDataUrl: "", // 後段のステップAPIで生成
        leftImageDesc: sanitizeImageDesc(page.left_image_desc),
      };
      if (ttsEnabled) {
        try {
          const audio = await synthesizeTts(cleanedRightText);
          if (audio) item.audioDataUrl = audio;
        } catch (e) {
          console.warn(`[TTS] textOnly page=${page.idx} 音声生成に失敗`, e);
        }
      }
      pagesOnly.push(item);
    }
    return NextResponse.json(pagesOnly);
  }

  // リクエスト単位でエンジン優先度を上書きできる（例: /api/gehon?engine=preview）
  const engineOverride = (url.searchParams.get("engine") || "").toLowerCase() as EngineName | "";
  const imagePrimary: EngineName = (engineOverride || (IMAGE_PRIMARY as EngineName)) as EngineName;

  // スタイル継承のため、ページ順に逐次生成（前ページ画像を参照として渡す）
  const finalPages: PageResult[] = [];
  let previousRawDataUrl: string | null = null;

  // 主人公写真の初期参照（フォームで heroImage として受け取り）
  const heroDataUrl = await fileToDataUrl(formData.get('heroImage') as unknown as File);
  if (heroDataUrl) {
    previousRawDataUrl = heroDataUrl;
    if (debugFlag) console.log('[DEBUG] hero image attached as initial reference');
  }

  for (const page of parsedResponse.pages) {
    const aspect = aspectRatioForPage(page.idx);
    const cleanedDesc = await rewriteImageDesc(
      storyTitleForArt,
      childName,
      page.left_image_desc,
    );
    const cleanedRightText = sanitizeRightTextJa(page.right_text_ja, childNameDisplay);
    const storySnippet = cleanedRightText.slice(0, 120);
    const illustrationPrompt = buildIllustrationPrompt(
      storyTitleForArt,
      cleanedDesc,
      childNameDisplay,
      storySnippet,
    );
    if (debugFlag) {
      console.log(`[PROMPT][page=${page.idx}] aspect=${aspect} title=${storyTitleForArt}`);
      console.log(illustrationPrompt.slice(0, 500));
    }

    // 3候補生成（1ページ目はヒーロー参照、以降は前ページ参照）
    const results: { url: string | null; engine: EngineName | 'fallback' }[] = [];
    for (let i = 0; i < 3; i++) {
      const out = await generateIllustration(illustrationPrompt, aspect, imagePrimary, previousRawDataUrl);
      results.push({ url: out.dataUrl, engine: out.engine });
    }

    // 参照があれば aHash で最良を選択
    const pickBest = () => {
      if (!previousRawDataUrl) return { url: results.find(r => r.url)?.url || null, engine: results.find(r => r.url)?.engine };
      const prevMatch = previousRawDataUrl.match(/^data:([^;]+);base64,(.+)$/);
      const prevMime = prevMatch?.[1] || "";
      const prevB64 = prevMatch?.[2] || "";
      if (!prevB64) return { url: results.find(r => r.url)?.url || null, engine: results.find(r => r.url)?.engine };

      const prevHash = toGrayscaleAHash64(prevMime, prevB64);
      if (prevHash) {
        let bestIdx = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        results.forEach((r, i) => {
          const m = r.url?.match(/^data:([^;]+);base64,(.+)$/);
          const mime = m?.[1] || "";
          const b64 = m?.[2] || "";
          if (!b64) return;
          const h = toGrayscaleAHash64(mime, b64);
          if (!h) return;
          const d = hammingDistance(prevHash, h);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        });
        if (bestIdx >= 0) return { url: results[bestIdx].url || null, engine: results[bestIdx].engine };
      }
      // フォールバック: 旧ヒューリスティック
      let best: { idx: number; score: number } = { idx: -1, score: -1 };
      results.forEach((r, i) => {
        const m = r.url?.match(/^data:[^;]+;base64,(.+)$/);
        const b64 = m ? m[1] : "";
        if (!b64) return;
        const prevTail = previousRawDataUrl ? (previousRawDataUrl.split(",")[1] || "") : "";
        const lenScore = prevTail ? (1 - Math.abs(b64.length - prevTail.length) / Math.max(b64.length, prevTail.length)) : 0;
        const headPrev = prevTail.slice(0, 256);
        const headCur = b64.slice(0, 256);
        let same = 0;
        for (let j = 0; j < Math.min(headPrev.length, headCur.length); j++) {
          if (headPrev[j] === headCur[j]) same++;
        }
        const headScore = headPrev.length ? (same / Math.max(headPrev.length, headCur.length)) : 0;
        const score = 0.6 * headScore + 0.4 * lenScore;
        if (score > best.score) best = { idx: i, score };
      });
      return best.idx >= 0 ? { url: results[best.idx].url || null, engine: results[best.idx].engine } : { url: results.find(r => r.url)?.url || null, engine: results.find(r => r.url)?.engine };
    };

    const picked = pickBest();
    if (debugFlag) {
      const hasRef = !!previousRawDataUrl;
      console.log(`[ENGINE][page=${page.idx}] primary=${imagePrimary} pickedEngine=${picked.engine} refAttached=${hasRef}`);
    }

    // 次ページ参照用に、data URL のまま保持
    previousRawDataUrl = picked.url && picked.url.startsWith("data:image/") ? picked.url : null;

    // 可能なら GCS に保存して公開URLを返す（失敗時は data URL を返す）
    let imageUrl = picked.url ?? generateSvgPlaceholder(page.left_image_desc);
    if (storage && IMAGE_BUCKET && picked.url && picked.url.startsWith("data:image/")) {
      try {
        const match = picked.url.match(/^data:(.+);base64,(.+)$/);
        if (match) {
          const mime = match[1];
          const b64 = match[2];
          const buf = Buffer.from(b64, "base64");
          const ext = mime.includes("png") ? "png" : mime.includes("jpeg") ? "jpg" : "bin";
          const object = `stories/${deterministicSeedBase}/page-${page.idx}.${ext}`;
          const bucket = storage.bucket(IMAGE_BUCKET);
          const file = bucket.file(object);
          await file.save(buf, { contentType: mime, resumable: false, public: false });
          // 可能なら公開（権限が無ければ data URL のまま）
          let publicUrl: string | null = null;
          try {
            await file.makePublic();
            publicUrl = `https://storage.googleapis.com/${IMAGE_BUCKET}/${object}`;
          } catch {}
          if (publicUrl) {
            imageUrl = publicUrl;
          }
        }
      } catch (e) {
        console.warn("画像のGCS保存に失敗しました。data URLを返します", e);
      }
    }

    const result: PageResult = {
      idx: page.idx,
      text: cleanedRightText,
      imageDataUrl: imageUrl,
    };
    if (ttsEnabled) {
      try {
        const audio = await synthesizeTts(cleanedRightText);
        if (audio) result.audioDataUrl = audio;
      } catch (e) {
        console.warn(`[TTS] page=${page.idx} 音声生成に失敗`, e);
      }
    }
    if (debugFlag) {
      result.promptPreview = illustrationPrompt.slice(0, 160);
    }
    result.promptFull = illustrationPrompt;
  result.engine = picked.engine;
    finalPages.push(result);
  }

    return NextResponse.json(finalPages);
  } catch (error: unknown) {
    console.error("/api/gehonでエラーが発生しました:", error);
    return NextResponse.json(
      {
        error:
          (error instanceof Error && error.message) ||
          "内部サーバーエラーが発生しました。",
      },
      { status: 500 },
    );
  }
}

// ステップ生成API: 1ページ画像を生成（前画像参照＋3候補→最良1枚を返す）
export async function PUT(request: Request) {
  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEYが設定されていません。" }, { status: 500 });
  }

  try {
    const url = new URL(request.url);
    const primary = (url.searchParams.get("engine") || IMAGE_PRIMARY) as EngineName;

    const payload = await request.json();
    const idx = Number(payload?.idx || 1);
    const storyTitle = String(payload?.storyTitle || "昔話");
    const childName = String(payload?.childName || "たろう");
    const _ageHint = String(payload?.ageHint || "6");
  const _traitsRaw = String(payload?.traitsRaw || "やさしい");
  const honorificRaw = String(payload?.honorific || 'none');
  const honorific = (['kun','chan','none'].includes(honorificRaw) ? honorificRaw : 'none') as 'kun'|'chan'|'none';
  const childNameDisplay = displayNameWithHonorific(childName, honorific);
    const leftImageDescRaw = String(payload?.leftImageDesc || "やわらかな水彩の一場面");
  const previousDataUrlIn = (typeof payload?.previousDataUrl === 'string') ? payload.previousDataUrl : null;
  const heroDataUrl = (typeof payload?.heroDataUrl === 'string') ? payload.heroDataUrl : null;
  const previousDataUrl = previousDataUrlIn || heroDataUrl;
    const previousPromptRaw = (typeof payload?.previousPrompt === 'string') ? payload.previousPrompt : '';

    const cleanedDesc = await rewriteImageDesc(
      storyTitle,
      childName,
      leftImageDescRaw,
    );
    const aspect = aspectRatioForPage(idx);
    const storySnippet = (typeof payload?.rightText === 'string' ? payload.rightText : '').slice(0, 120);
    let illustrationPrompt = buildIllustrationPrompt(
      storyTitle,
      cleanedDesc,
      childNameDisplay,
      storySnippet,
    );
    // 参考として前ページのプロンプト要点を短く加える（長すぎると品質に影響するため簡潔に）
    if (previousPromptRaw) {
      const hint = previousPromptRaw.replace(/\s+/g, ' ').slice(0, 240);
      illustrationPrompt += `\n参考: 前ページの指示の要点（スタイル継承の参考）: ${hint}`;
    }

    // 3候補生成（可能なら Preview を優先、参照画像も添付）
    const results: { url: string | null; engine: EngineName | 'fallback' }[] = [];
    for (let i = 0; i < 3; i++) {
      const out = await generateIllustration(illustrationPrompt, aspect, primary, previousDataUrl);
      results.push({ url: out.dataUrl, engine: out.engine });
    }

    // 類似度: 参照画像があれば aHash(8x8) を優先。失敗したら従来ヒューリスティック。
    const pickBest = () => {
      if (!previousDataUrl) return results.find(r => r.url)?.url || null;
      const prevMatch = previousDataUrl.match(/^data:([^;]+);base64,(.+)$/);
      const prevMime = prevMatch?.[1] || "";
      const prevB64 = prevMatch?.[2] || "";
      if (!prevB64) return results.find(r => r.url)?.url || null;

      const prevHash = toGrayscaleAHash64(prevMime, prevB64);
      if (prevHash) {
        let bestIdx = -1;
        let bestDist = Number.POSITIVE_INFINITY;
        results.forEach((r, i) => {
          const m = r.url?.match(/^data:([^;]+);base64,(.+)$/);
          const mime = m?.[1] || "";
          const b64 = m?.[2] || "";
          if (!b64) return;
          const h = toGrayscaleAHash64(mime, b64);
          if (!h) return;
          const d = hammingDistance(prevHash, h);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        });
        if (bestIdx >= 0) return results[bestIdx].url || null;
      }

      // フォールバック: 旧ヒューリスティック
      let best: { idx: number; score: number } = { idx: -1, score: -1 };
      results.forEach((r, i) => {
        const m = r.url?.match(/^data:[^;]+;base64,(.+)$/);
        const b64 = m ? m[1] : "";
        if (!b64) return;
        const lenScore = 1 - Math.abs(b64.length - prevB64.length) / Math.max(b64.length, prevB64.length);
        const headPrev = prevB64.slice(0, 256);
        const headCur = b64.slice(0, 256);
        let same = 0;
        for (let j = 0; j < Math.min(headPrev.length, headCur.length); j++) {
          if (headPrev[j] === headCur[j]) same++;
        }
        const headScore = same / Math.max(headPrev.length, headCur.length);
        const score = 0.6 * headScore + 0.4 * lenScore;
        if (score > best.score) best = { idx: i, score };
      });
      return best.idx >= 0 ? results[best.idx].url : (results.find(r => r.url)?.url || null);
    };

    const bestUrl = pickBest();
    if (!bestUrl) {
      return NextResponse.json({ error: '画像生成に失敗しました' }, { status: 500 });
    }

    return NextResponse.json({
      idx,
      imageDataUrl: bestUrl,
      promptFull: illustrationPrompt,
      used: results.map((r) => r.engine),
    });
  } catch (error) {
    console.error("/api/gehon (PUT) でエラーが発生しました:", error);
    return NextResponse.json({ error: '内部エラー' }, { status: 500 });
  }
}
