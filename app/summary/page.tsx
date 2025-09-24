"use client";

import { useEffect, useState } from "react";

interface PageItem {
  idx: number;
  text: string;
  imageDataUrl: string;
  audioDataUrl?: string;
}

interface StoryPayload {
  storyTitle: string;
  honorific: "kun" | "chan" | "none";
  childName: string;
  pages: PageItem[];
}

export default function SummaryPage() {
  const [data, setData] = useState<StoryPayload | null>(null);
  const [ttsLoading, setTtsLoading] = useState(false);
  const [ttsAudioUrl, setTtsAudioUrl] = useState<string | null>(null);
  const [showFurigana, setShowFurigana] = useState(false);
  const [rubyHtmlMap, setRubyHtmlMap] = useState<Record<number, string>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem("gehon_story");
      if (raw) {
        setData(JSON.parse(raw));
        return;
      }
      // フォールバック: sessionStorage からの読み込み
      try {
        const raw2 = sessionStorage.getItem("gehon_story");
        if (raw2) setData(JSON.parse(raw2));
      } catch {}
    } catch {}
  }, []);

  if (!data) {
    return (
      <main className="container mx-auto p-4">
        <h1 className="text-2xl font-bold mb-4">PDF出力</h1>
        <p className="text-gray-600">データが見つかりませんでした。まずはトップで絵本を生成してください。</p>
      </main>
    );
  }

  const displayName = data.honorific === 'kun' ? `${data.childName}くん` : data.honorific === 'chan' ? `${data.childName}ちゃん` : data.childName;

  return (
    <main className="container mx-auto p-4 print:p-0">
      <header className="mb-4 flex items-center justify-between print:hidden">
        <div>
          <h1 className="text-2xl font-bold">PDF出力プレビュー</h1>
          <div className="text-gray-600">題材: {data.storyTitle} ／ 主人公: {displayName}</div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="px-4 py-2 bg-sky-600 text-white rounded"
            onClick={async () => {
              if (!data) return;
              setShowFurigana((v) => !v);
              // 初回ON時にまとめて生成
              if (Object.keys(rubyHtmlMap).length === 0) {
                const entries = await Promise.all(
                  data.pages.map(async (p) => {
                    try {
                      const resp = await fetch('/api/furigana', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ text: p.text, to: 'hiragana', mode: 'furigana' }),
                      });
                      if (!resp.ok) throw new Error('furigana failed');
                      const j = await resp.json();
                      return [p.idx, String(j.html || '')] as const;
                    } catch {
                      return [p.idx, ''] as const;
                    }
                  })
                );
                const map: Record<number, string> = {};
                for (const [idx, html] of entries) map[idx] = html;
                setRubyHtmlMap(map);
              }
            }}
          >
            {showFurigana ? 'ふりがな非表示' : 'ふりがな表示'}
          </button>
          <button
            className="px-4 py-2 bg-emerald-600 text-white rounded disabled:bg-gray-400"
            disabled={ttsLoading}
            onClick={async () => {
              try {
                setTtsLoading(true);
                setTtsAudioUrl(null);
                const fullText = data.pages
                  .sort((a,b) => a.idx - b.idx)
                  .map(p => p.text)
                  .join('\n');
                const resp = await fetch('/api/tts', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ text: fullText }),
                });
                if (!resp.ok) {
                  const err = await resp.json().catch(() => ({}));
                  throw new Error(err.error || 'TTS生成に失敗しました');
                }
                const j = await resp.json();
                const url: string | undefined = j?.dataUrl;
                if (url) setTtsAudioUrl(url);
              } catch (e) {
                console.error(e);
                alert('音声生成に失敗しました。しばらくしてからもう一度お試しください。');
              } finally {
                setTtsLoading(false);
              }
            }}
          >
            {ttsLoading ? '音声生成中…' : '物語を読み上げる'}
          </button>
          <button
            className="px-4 py-2 bg-purple-600 text-white rounded"
            onClick={() => window.print()}
          >
            PDFとして保存
          </button>
        </div>
      </header>

      {ttsAudioUrl && (
        <div className="mb-4 print:hidden">
          <audio controls src={ttsAudioUrl} className="w-full" autoPlay />
        </div>
      )}

      <section className="grid grid-cols-1 gap-6">
        {data.pages.map((p) => (
          <article key={p.idx} className="break-inside-avoid print:break-inside-avoid border rounded-md p-4">
            <div className="text-sm text-gray-500 mb-2">P{p.idx}</div>
            {p.imageDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.imageDataUrl} alt={`P${p.idx}`} className="w-full max-h-[480px] object-contain mb-3" />
            ) : (
              <div className="mb-3 text-sm text-amber-600 print:hidden">
                画像が保存されていないため、このページのPDFには画像が含まれません。
              </div>
            )}
            {showFurigana && rubyHtmlMap[p.idx] ? (
              <div className="text-lg leading-relaxed" dangerouslySetInnerHTML={{ __html: rubyHtmlMap[p.idx] }} />
            ) : (
              <div className="whitespace-pre-wrap text-lg leading-relaxed">{p.text}</div>
            )}
          </article>
        ))}
      </section>

      <style jsx global>{`
        @media print {
          .print\\:hidden { display: none !important; }
          .print\\:p-0 { padding: 0 !important; }
          img { page-break-inside: avoid; }
          article { page-break-inside: avoid; }
          body { -webkit-print-color-adjust: exact; }
        }
      `}</style>
    </main>
  );
}
