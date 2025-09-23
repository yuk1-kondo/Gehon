import { NextResponse } from "next/server";

// Google Cloud Text-to-Speech (v1) を REST で呼び出し
// 認証は Cloud Run のデフォルトサービスアカウント、または環境変数 GEHON_TTS_ACCESS_TOKEN を使用
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

const fetchAccessToken = async () => {
  if (process.env.GEHON_TTS_ACCESS_TOKEN) {
    return process.env.GEHON_TTS_ACCESS_TOKEN;
  }
  try {
    const r = await fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
    if (!r.ok) throw new Error(`metadata token ${r.status}`);
    const j = (await r.json()) as { access_token?: string };
    if (!j.access_token) throw new Error("no access_token");
    return j.access_token;
  } catch (e) {
    throw new Error("TTS のアクセストークンを取得できませんでした。Cloud Run 上で実行するか GEHON_TTS_ACCESS_TOKEN を設定してください。");
  }
};

// 合成する音声のデフォルト設定（日本語・女性ボイス/子ども向け想定）
const DEFAULT_VOICE = {
  languageCode: "ja-JP",
  name: process.env.GEHON_TTS_VOICE || "ja-JP-Neural2-C",
};
const DEFAULT_AUDIO_CONFIG = {
  audioEncoding: "MP3",
  speakingRate: Number(process.env.GEHON_TTS_RATE || 1.0),
  pitch: Number(process.env.GEHON_TTS_PITCH || 0.0),
};

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const text: string = String(body?.text || "").trim();
    if (!text) return NextResponse.json({ error: "text が空です" }, { status: 400 });

    const accessToken = await fetchAccessToken();
    const resp = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        input: { text },
        voice: DEFAULT_VOICE,
        audioConfig: DEFAULT_AUDIO_CONFIG,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text();
      return NextResponse.json({ error: `TTS failed: ${resp.status} ${t}` }, { status: 500 });
    }
    const data = await resp.json();
    const audioB64: string | undefined = data?.audioContent;
    if (!audioB64) return NextResponse.json({ error: "audioContent が空です" }, { status: 500 });
    return NextResponse.json({
      mimeType: "audio/mpeg",
      dataUrl: `data:audio/mpeg;base64,${audioB64}`,
    });
  } catch (e) {
    return NextResponse.json({ error: `内部エラー: ${(e as Error).message}` }, { status: 500 });
  }
}

// GET ?text=... でも簡易呼び出し
export async function GET(request: Request) {
  const url = new URL(request.url);
  const text = (url.searchParams.get("text") || "").trim();
  if (!text) return NextResponse.json({ error: "text が空です" }, { status: 400 });
  return POST(new Request(request.url, { method: "POST", body: JSON.stringify({ text }) }));
}
