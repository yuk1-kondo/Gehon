'use client';

import Image from 'next/image';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

// Define the structure of a page
interface Page {
  idx: number;
  text: string;
  imageDataUrl: string;
  promptFull?: string;
  engine?: 'preview' | 'gemini' | 'vertex' | 'fallback';
  leftImageDesc?: string;
  audioDataUrl?: string;
}

// Define the structure of the error object
interface ErrorState {
  message: string;
  aiResponse?: string;
}

interface StoryOption {
  id: string;
  name: string;
}

const storyOptions: StoryOption[] = [
  { id: 'north_wind_and_sun', name: '北風と太陽' },
  { id: 'golden_axe', name: '金の斧' },
  { id: 'hare_and_tortoise', name: 'うさぎとかめ' },
  { id: 'momotaro', name: '桃太郎' },
  { id: 'urashima_taro', name: '浦島太郎' },
  { id: 'kaguyahime', name: 'かぐや姫' },
  { id: 'issun_boshi', name: '一寸法師' },
  { id: 'custom', name: 'オリジナルストーリー（自由入力）' },
];

export default function Home() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState<ErrorState | null>(null);
  const [selectedStoryId, setSelectedStoryId] = useState<string>(storyOptions[0].id);
  const [customStory, setCustomStory] = useState<string>('');
  const [currentIndex, setCurrentIndex] = useState<number>(0);
  const [generating, setGenerating] = useState<boolean>(false);
  const [honorific, setHonorific] = useState<'kun' | 'chan' | 'none'>('none');
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(false);
  const [heroDataUrl, setHeroDataUrl] = useState<string | null>(null);
  const [showPrompt, setShowPrompt] = useState<boolean>(false);

  // 全ページ画像が揃ったか
  const allImagesReady = useMemo(() => pages.length > 0 && pages.every(p => !!p.imageDataUrl), [pages]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setPages([]);
    setError(null);

  const formData = new FormData(event.currentTarget);

    if (selectedStoryId === 'custom') {
      const trimmedStory = customStory.trim();
      if (!trimmedStory) {
        setError({ message: 'オリジナルストーリーの内容を入力してください。' });
        setLoading(false);
        return;
      }
      formData.set('customStory', trimmedStory);
    } else {
      formData.delete('customStory');
    }

    formData.set('storyId', selectedStoryId);

    try {
      const query = new URLSearchParams({ textOnly: '1', ...(ttsEnabled ? { tts: '1' } : {}) });
      const response = await fetch(`/api/gehon?${query.toString()}` , {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'APIリクエストに失敗しました', { cause: errorData.ai_response });
      }

      const resultPages: Page[] = await response.json();
      setPages(resultPages);
      setCurrentIndex(0);

      // 1枚目の画像を自動生成（3候補→ヒーロー写真と比較して最適選択）
      if (resultPages.length > 0) {
        setGenerating(true);
        try {
          const selectedStory = storyOptions.find(o => o.id === selectedStoryId);
          const storyTitle = selectedStoryId === 'custom' ? 'オリジナル' : (selectedStory?.name || '昔話');
          const body = {
            idx: resultPages[0].idx,
            storyTitle,
            childName: (document.getElementById('name') as HTMLInputElement)?.value || '',
            leftImageDesc: resultPages[0].leftImageDesc || '',
            rightText: resultPages[0].text || '',
            previousDataUrl: null as string | null,
            heroDataUrl, // 初期参照として使用
            honorific,
            previousPrompt: '',
          };
          const res = await fetch('/api/gehon', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || '1ページ目の画像生成に失敗しました');
          }
          const step = await res.json();
          setPages((prev) => {
            const updated = [...prev];
            if (updated[0]) {
              updated[0] = { ...updated[0], imageDataUrl: step.imageDataUrl, promptFull: step.promptFull };
            }
            return updated;
          });
        } catch (e) {
          console.error(e);
        } finally {
          setGenerating(false);
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        const cause = err.cause;
        const aiResponse =
          typeof cause === 'string'
            ? cause
            : cause
            ? JSON.stringify(cause)
            : undefined;
        setError({ message: err.message, aiResponse });
      } else {
        setError({ message: '不明なエラーが発生しました。' });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="container mx-auto p-4 font-sans">
      <header className="text-center mb-8">
        <h1 className="text-4xl font-bold">Gehonジェネレーター</h1>
        <p className="text-gray-600">オリジナルの絵本をAIで作成します</p>
      </header>

      <div className="max-w-lg mx-auto bg-white p-6 rounded-lg shadow-md mb-8">
        <form onSubmit={handleSubmit}>
          {/* Form fields... same as before */}
          <div className="mb-4"><label htmlFor="name" className="block text-gray-700 font-bold mb-2">お子様の名前</label><input type="text" id="name" name="name" required className="w-full px-3 py-2 border rounded-lg" /></div>
          <div className="mb-4">
            <label htmlFor="honorific" className="block text-gray-700 font-bold mb-2">呼び方（敬称）</label>
            <select
              id="honorific"
              name="honorific"
              className="w-full px-3 py-2 border rounded-lg"
              value={honorific}
              onChange={(e) => setHonorific(e.target.value as 'kun' | 'chan' | 'none')}
            >
              <option value="none">なし（呼び捨て）</option>
              <option value="kun">くん</option>
              <option value="chan">ちゃん</option>
            </select>
          </div>
          <div className="mb-4">
            <label htmlFor="storyId" className="block text-gray-700 font-bold mb-2">ストーリー</label>
            <select
              id="storyId"
              name="storyId"
              required
              className="w-full px-3 py-2 border rounded-lg"
              value={selectedStoryId}
              onChange={(event) => {
                const value = event.target.value;
                setSelectedStoryId(value);
                if (value !== 'custom') {
                  setCustomStory('');
                }
              }}
            >
              {storyOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </select>
          </div>
          {selectedStoryId === 'custom' && (
            <div className="mb-4">
              <label htmlFor="customStory" className="block text-gray-700 font-bold mb-2">
                オリジナルストーリーの内容
              </label>
              <textarea
                id="customStory"
                name="customStory"
                value={customStory}
                onChange={(event) => setCustomStory(event.target.value)}
                required
                rows={4}
                placeholder="例：夜空を旅する猫と星の妖精の物語"
                className="w-full px-3 py-2 border rounded-lg"
              />
              <p className="text-xs text-gray-500 mt-1">絵本にしたいテーマやあらすじを自由に書いてください。</p>
            </div>
          )}
          <div className="mb-4">
            <label htmlFor="heroImage" className="block text-gray-700 font-bold mb-2">主人公の写真（任意）</label>
            <input
              type="file"
              id="heroImage"
              name="heroImage"
              accept="image/*"
              className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) { setHeroDataUrl(null); return; }
                // FileReader で data URL を取得
                const reader = new FileReader();
                reader.onload = () => {
                  const result = reader.result;
                  if (typeof result === 'string') {
                    setHeroDataUrl(result);
                  }
                };
                reader.onerror = () => setHeroDataUrl(null);
                reader.readAsDataURL(f);
              }}
            />
            <p className="text-xs text-gray-500 mt-1">顔写真を使うと、1ページ目の絵柄の初期基準として参照します（手描き風で生成されます）。</p>
          </div>
          <div className="mb-6 flex items-center gap-2">
            <input
              type="checkbox"
              id="tts"
              name="tts"
              checked={ttsEnabled}
              onChange={(e) => setTtsEnabled(e.target.checked)}
              className="h-4 w-4"
            />
            <label htmlFor="tts" className="text-gray-700">読み上げ音声も生成（POST時）</label>
          </div>
          
          <button type="submit" disabled={loading} className="w-full bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded-lg disabled:bg-gray-400">
            {loading ? '生成中...' : '絵本を生成'}
          </button>
        </form>
      </div>

      {error && (
        <div className="max-w-4xl mx-auto my-4 p-4 bg-red-100 text-red-700 border border-red-400 rounded-lg">
          <p className="font-bold">エラーが発生しました: {error.message}</p>
          <div className="mt-4">
            <p className="font-semibold">AIからの未加工レスポンス:</p>
            <pre className="bg-gray-100 text-gray-800 p-2 rounded-md text-sm whitespace-pre-wrap">
              {error.aiResponse || "(レスポンスが空でした)"}
            </pre>
          </div>
        </div>
      )}

      {pages.length > 0 && (
        <div className="max-w-3xl mx-auto">
          <div className="bg-white shadow-lg rounded-lg overflow-hidden">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4">
                {pages[currentIndex]?.imageDataUrl ? (
                  <Image src={pages[currentIndex].imageDataUrl} alt={`ページ${pages[currentIndex].idx}のイラスト`} width={512} height={512} className="w-full h-auto object-contain rounded-md" unoptimized />
                ) : (
                  <div className="w-full h-[512px] bg-gray-100 flex items-center justify-center rounded-md text-gray-500 text-sm">
                    画像は未生成です
                  </div>
                )}
              </div>
              <div className="p-4 flex items-center">
                <div className="w-full">
                  <p className="text-gray-800 text-lg leading-relaxed whitespace-pre-wrap">{pages[currentIndex].text}</p>
                  {pages[currentIndex]?.audioDataUrl && (
                    <div className="mt-3">
                      <audio controls src={pages[currentIndex].audioDataUrl} className="w-full" />
                      <div className="text-xs text-gray-500 mt-1">このページの読み上げ音声</div>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <div className="flex justify-between items-center p-4 border-t">
              <div className="text-sm text-gray-500">{currentIndex + 1} / {pages.length}</div>
              <div className="space-x-2">
                <button
                  className="px-3 py-2 rounded bg-gray-100 text-gray-800 border"
                  onClick={() => setShowPrompt(v => !v)}
                >
                  {showPrompt ? 'プロンプトを隠す' : 'プロンプトを表示'}
                </button>
                <button
                  className="px-4 py-2 rounded bg-blue-500 text-white disabled:bg-gray-400"
                  disabled={generating}
                  onClick={async () => {
                    if (!pages[currentIndex]) return;
                    setGenerating(true);
                    try {
                      // 前ページの画像（存在すれば）を参照として利用
                      const previousDataUrl = currentIndex > 0 ? (pages[currentIndex - 1]?.imageDataUrl || null) : null;
                      // 選択されたストーリーの日本語タイトル（カタログ名）を利用
                      const selectedStory = storyOptions.find(o => o.id === selectedStoryId);
                      const storyTitle = selectedStoryId === 'custom' ? 'オリジナル' : (selectedStory?.name || '昔話');
                      const body = {
                        idx: pages[currentIndex].idx,
                        storyTitle,
                        childName: (document.getElementById('name') as HTMLInputElement)?.value || '',
                        leftImageDesc: pages[currentIndex].leftImageDesc || '',
                        rightText: pages[currentIndex].text || '',
                        previousDataUrl,
                        heroDataUrl, // 前参照がなければ初期参照として活用
                        honorific,
                        // 任意: 前ページのプロンプトも参考として送る（サーバー側で未使用でも無害）
                        previousPrompt: currentIndex > 0 ? (pages[currentIndex - 1]?.promptFull || '') : '',
                      };
                      const res = await fetch('/api/gehon', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                      });
                      if (!res.ok) {
                        const err = await res.json();
                        throw new Error(err.error || '画像生成に失敗しました');
                      }
                      const step = await res.json();
                      const updated = [...pages];
                      updated[currentIndex] = {
                        ...updated[currentIndex],
                        imageDataUrl: step.imageDataUrl,
                        promptFull: step.promptFull,
                      };
                      setPages(updated);
                    } catch (e: unknown) {
                      const message = (e instanceof Error && e.message) ? e.message : '画像生成に失敗しました';
                      setError({ message });
                    } finally {
                      setGenerating(false);
                    }
                  }}
                >
                  このページの画像を再生成
                </button>
                <button
                  className="px-4 py-2 rounded bg-green-600 text-white disabled:bg-gray-400"
                  disabled={generating || currentIndex >= pages.length - 1}
                  onClick={async () => {
                    if (generating) return;
                    if (currentIndex >= pages.length - 1) return;
                    const nextIndex = currentIndex + 1;
                    // すでに次ページに画像があるなら単純遷移
                    if (pages[nextIndex]?.imageDataUrl) {
                      setCurrentIndex(nextIndex);
                      return;
                    }
                    setGenerating(true);
                    try {
                      // 参照画像は原則「現在ページ」の画像。なければ過去に遡って最も近い画像を使用
                      let previousDataUrl: string | null = null;
                      let previousPrompt = '';
                      for (let i = currentIndex; i >= 0; i--) {
                        if (pages[i]?.imageDataUrl) {
                          previousDataUrl = pages[i].imageDataUrl;
                          previousPrompt = pages[i].promptFull || '';
                          break;
                        }
                      }
                      // ストーリータイトル
                      const selectedStory = storyOptions.find(o => o.id === selectedStoryId);
                      const storyTitle = selectedStoryId === 'custom' ? 'オリジナル' : (selectedStory?.name || '昔話');

                      const body = {
                        idx: pages[nextIndex].idx,
                        storyTitle,
                        childName: (document.getElementById('name') as HTMLInputElement)?.value || '',
                        leftImageDesc: pages[nextIndex].leftImageDesc || '',
                        rightText: pages[nextIndex].text || '',
                        previousDataUrl,
                        heroDataUrl,
                        honorific,
                        previousPrompt,
                      };
                      const res = await fetch('/api/gehon', {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body),
                      });
                      if (!res.ok) {
                        const err = await res.json();
                        throw new Error(err.error || '次ページの画像生成に失敗しました');
                      }
                      const step = await res.json();
                      const updated = [...pages];
                      updated[nextIndex] = {
                        ...updated[nextIndex],
                        imageDataUrl: step.imageDataUrl,
                        promptFull: step.promptFull,
                      };
                      setPages(updated);
                      setCurrentIndex(nextIndex);
                    } catch (e: unknown) {
                      const message = (e instanceof Error && e.message) ? e.message : '次ページの画像生成に失敗しました';
                      setError({ message });
                    } finally {
                      setGenerating(false);
                    }
                  }}
                >
                  次のページへ
                </button>
                <button
                  className="px-4 py-2 rounded bg-gray-200 text-gray-800 disabled:bg-gray-300"
                  disabled={generating || currentIndex <= 0}
                  onClick={() => setCurrentIndex((i) => Math.max(i - 1, 0))}
                >
                  前のページへ
                </button>
                {allImagesReady && (
                  <button
                    className="px-4 py-2 rounded bg-purple-600 text-white"
                    onClick={() => {
                      const childName = (document.getElementById('name') as HTMLInputElement)?.value || '';
                      const selectedStory = storyOptions.find(o => o.id === selectedStoryId);
                      const storyTitle = selectedStoryId === 'custom' ? 'オリジナル' : (selectedStory?.name || '昔話');
                      // localStorage容量対策: 画像のdata URLは非常に大きいため、HTTP(S)のURLのみ保存する
                      const slimPages = pages.map(p => ({
                        idx: p.idx,
                        text: p.text,
                        imageDataUrl: (p.imageDataUrl && /^https?:\/\//.test(p.imageDataUrl)) ? p.imageDataUrl : ''
                      }));
                      const payload = { storyTitle, honorific, childName, pages: slimPages };
                      try {
                        localStorage.setItem('gehon_story', JSON.stringify(payload));
                        try { sessionStorage.setItem('gehon_story', JSON.stringify(payload)); } catch {}
                      } catch (e) {
                        // それでも保存できない場合は、さらに縮小したデータで再保存を試みる
                        try {
                          const minimal = { storyTitle, honorific, childName, pages: slimPages.map(p => ({ idx: p.idx, text: p.text, imageDataUrl: '' })) };
                          localStorage.setItem('gehon_story', JSON.stringify(minimal));
                          try { sessionStorage.setItem('gehon_story', JSON.stringify(minimal)); } catch {}
                          alert('保存容量の上限により、一部画像はPDFに含まれません。サマリーページでテキストのみ出力されます。');
                        } catch {}
                      }
                      router.push('/summary');
                    }}
                  >
                    完成・PDFへ
                  </button>
                )}
              </div>
            </div>
            {showPrompt && pages[currentIndex]?.promptFull && (
              <div className="p-4 border-t">
                <div className="text-sm text-gray-500 mb-2">画像プロンプト（実際に送信）</div>
                <pre className="text-xs text-gray-700 bg-gray-50 p-2 rounded-md whitespace-pre-wrap break-words max-h-[256px] overflow-auto">{pages[currentIndex].promptFull}</pre>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
