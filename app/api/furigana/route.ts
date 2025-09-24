import { NextResponse } from "next/server";
import path from "path";

// Kuroshiroでふりがな生成（サーバー側）。初期化は使い回す。
type KuroshiroLike = {
  init: (analyzer: unknown) => Promise<void>;
  convert: (
    text: string,
    opts: { to: "hiragana" | "katakana"; mode: "furigana" | "okurigana" | "spaced" }
  ) => Promise<string>;
};

let kuroshiroReady: Promise<KuroshiroLike> | null = null;
let _kuro: KuroshiroLike | null = null;

async function getKuroshiro(): Promise<KuroshiroLike> {
  if (_kuro) return _kuro;
  if (!kuroshiroReady) {
    kuroshiroReady = (async () => {
      const KuroshiroCtor = (await import("kuroshiro")).default as unknown as {
        new (): KuroshiroLike;
      };
      const KuromojiAnalyzerCtor = (await import("kuroshiro-analyzer-kuromoji")).default as unknown as {
        new (opts: { dictPath: string }): unknown;
      };
      const kuro: KuroshiroLike = new KuroshiroCtor();
      // 辞書ディレクトリの解決
      const dictPath = process.env.KUROMOJI_DICT_PATH || path.join(process.cwd(), "node_modules/kuromoji/dict");
      await kuro.init(new KuromojiAnalyzerCtor({ dictPath }));
      _kuro = kuro;
      return kuro;
    })();
  }
  return kuroshiroReady;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
  const text: string = String(body?.text || "").trim();
  // 'hiragana' | 'katakana'
  const to: "hiragana" | "katakana" = body?.to === "katakana" ? "katakana" : "hiragana";
  // 'furigana' | 'okurigana' | 'spaced'
  const mode: "furigana" | "okurigana" | "spaced" = body?.mode === "okurigana" ? "okurigana" : "furigana";
    if (!text) return NextResponse.json({ error: "text が空です" }, { status: 400 });
    const kuro = await getKuroshiro();
    const html: string = await kuro.convert(text, { to, mode });
    return NextResponse.json({ html });
  } catch (e) {
    return NextResponse.json({ error: `内部エラー: ${(e as Error).message}` }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const text = (url.searchParams.get("text") || "").trim();
  if (!text) return NextResponse.json({ error: "text が空です" }, { status: 400 });
  return POST(new Request(request.url, { method: "POST", body: JSON.stringify({ text }) }));
}
