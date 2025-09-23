# Gehon ジェネレーター

AI が日本語の昔話やオリジナルストーリーをもとに絵本を生成する Next.js アプリです。Gemini で本文を作成し、各ページのイラストも自動生成します。Cloud Run へ Docker イメージとしてデプロイする構成を想定しています。

このリポジトリは以下の画像エンジンをサポートします:

- `preview`: Gemini 2.5 Flash Image（別名 Nano Banana / `gemini-2.5-flash-image-preview`）
- `gemini`: Gemini Images API（`models/imagegeneration:generate` + `model=imagen-3.0-fast-generate-001` 等）
- `vertex`: Vertex AI Predict（`publishers/google/models/imagen-3.0-fast-generate-001:predict`）

いずれも 1 枚の画像を生成し、失敗時は次のエンジンへフォールバックします。

## 開発環境のセットアップ

```bash
npm install
npm run dev
```

開発サーバーは `http://localhost:3000` で起動します。フォームからリクエストすると `/api/gehon` が呼ばれ、Gemini へリクエストが飛びます。

### 必要な環境変数

| 変数名 | 用途 | 設定場所 |
| --- | --- | --- |
| `GEMINI_API_KEY` | Gemini API へのアクセストークン | ローカル: `.env.local`, 本番: Secret Manager |
| `GEHON_STORY_MODEL` | ストーリー生成モデル ID (既定: `gemini-2.5-flash`) | Cloud Run 環境変数 |
| `GEHON_ILLUSTRATION_MODEL` | Imagen モデル ID (既定: `imagen-3.0-fast-generate-001`) | Cloud Run 環境変数 |
| `GEHON_IMAGEN_LOCATION` | Imagen を呼び出すリージョン (既定: `us-central1`) | Cloud Run 環境変数 |
| `GEHON_IMAGEN_PROJECT_ID` | Imagen 呼び出しに使用する GCP プロジェクト ID。未設定時はメタデータから自動取得 | Cloud Run 環境変数 |
| `GEHON_IMAGEN_ACCESS_TOKEN` | ローカル開発用アクセストークン（`gcloud auth application-default print-access-token` 等で取得） | ローカルのみ |
| `GEHON_IMAGE_PRIMARY` | 画像生成の優先エンジン。`preview` / `gemini` / `vertex`（既定: `gemini`） | Cloud Run 環境変数 |
| `GEHON_PREVIEW_MODEL` | プレビュー画像モデル ID（既定: `gemini-2.5-flash-image-preview`） | Cloud Run 環境変数 |
| `GEHON_DEBUG_PROMPT` | `1`/`true` でサーバーログとレスポンスにプロンプトを含める | 任意 |

ローカルでは `.env.local` に `GEMINI_API_KEY=...` を記述してください。Cloud Run では Secret Manager にシークレットを登録し、Cloud Build 経由で注入します。

## イラスト生成フロー

- `/api/gehon` が本文とイラストの両方を生成します。
- 各ページの説明文をもとに画像生成を呼び出し、`data:image/...;base64,...` もしくは GCS の公開 URL を返します。
- 生成が失敗した場合は次のエンジンへフォールバックし、それでも失敗時は SVG プレースホルダーへ退避します。
- シード値をページごとに固定し、できるだけ一貫した絵柄になるようにしています。

### 利用エンジンの詳細

- Preview（Nano Banana）: REST の `generateContent` を使用。応答は `candidates[].content.parts[].inlineData`（または `inline_data`）に画像が含まれます。公式ガイドに従い `generationConfig.responseMimeType` に画像 MIME は指定しません。
- Gemini Images API: `v1beta/models/imagegeneration:generate` に POST し、ボディで `model`（例: `imagen-3.0-fast-generate-001`）を指定します。
- Vertex: AI Platform の Predict REST を利用します。リージョンは `GEHON_IMAGEN_LOCATION`（既定: `us-central1`）。

エンジン優先度は `GEHON_IMAGE_PRIMARY` で設定でき、リクエスト単位で `?engine=preview|gemini|vertex` で上書きできます。

```text
例）/api/gehon?engine=preview  … Preview → Gemini → Vertex の順にトライ
    /api/gehon?engine=vertex   … Vertex → Gemini → Preview の順
```

### デバッグ（プロンプトの可視化）

- クエリ `?debug=1`、もしくはヘッダー `x-debug-prompt: 1`、環境変数 `GEHON_DEBUG_PROMPT=1` のいずれかで有効化。
- レスポンスの各ページ要素に以下が含まれます:
  - `promptFull`: 実際に画像生成へ送ったプロンプト全文
  - `promptPreview`（debug 有効時）: プロンプト先頭 160 文字
  - `engine`: 実際に利用されたエンジン名（`preview`/`gemini`/`vertex`）
- サーバーログには `[PROMPT]` と `[ENGINE]` の行が出力されます。

検証用の `curl` 例:

```bash
curl -s -X POST 'https://<CloudRunのURL>/api/gehon?engine=preview&debug=1' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'name=たろう' \
  --data-urlencode 'ageHint=5' \
  --data-urlencode 'traits_raw=やさしい・好奇心旺盛' \
  --data-urlencode 'storyId=momotaro' \
| jq '.[0] | {engine, promptHead: .promptFull[0:80], imageHead: .imageDataUrl[0:40]}'
```

今後は Cloud Storage に画像を保存する実装や Imagen とのハイブリッドにも拡張できます。

## Cloud Build / Cloud Run でのデプロイ

1. Artifact Registry に Docker リポジトリ `gehon-web` を作成。
2. Secret Manager に `GEMINI_API_KEY` を登録し、Cloud Run のサービスアカウントに `roles/secretmanager.secretAccessor` を付与。
3. `gcloud builds submit --config cloudbuild.yaml` を実行。

`cloudbuild.yaml` では以下を自動で行います。

- Docker イメージをビルドし、`asia-northeast1-docker.pkg.dev` の Artifact Registry に push。
- Cloud Run にデプロイ (`--memory=2Gi`, `--timeout=360s` を指定)。
- `GEMINI_API_KEY` を Secret として渡し、`GEHON_STORY_MODEL` / `GEHON_ILLUSTRATION_MODEL` / `GEHON_IMAGEN_LOCATION` を環境変数として設定。

> ℹ️ **Imagen 利用時の権限について**
>
> Cloud Run の実行サービスアカウントに `roles/aiplatform.user` など Vertex AI を呼び出せるロールを付与し、Vertex AI API (`aiplatform.googleapis.com`) を有効化してください。ローカルで検証する場合は `GEHON_IMAGEN_ACCESS_TOKEN=$(gcloud auth application-default print-access-token)` を設定し、`node scripts/test-illustration.mjs` で Imagen から画像が取得できることを確認すると安心です。

> ℹ️ **Gemini API（Nano Banana / 画像生成）の注意点**
>
> - Preview モデル（`gemini-2.5-flash-image-preview`）は `generateContent` で画像が `inlineData` として返ります。`generationConfig.responseMimeType` に画像 MIME を指定すると 400 になるため指定しません。
> - Gemini Images API は `models/imagegeneration:generate` に POST し、URL 上のモデル名ではなく、ボディの `model` フィールドでモデルを指定します。

サービス URL はデプロイ完了後に Cloud Build のログに表示されます。外部公開する場合は、次のコマンドで `roles/run.invoker` を `allUsers` へ付与してください。

```bash
gcloud beta run services add-iam-policy-binding gehon-web \
  --region=asia-northeast1 \
  --member="allUsers" \
  --role="roles/run.invoker"
```

## テスト / リント

```bash
npm run lint
```

現時点でユニットテストはありません。必要に応じて追加してください。

## ライセンス

社内・個人利用向けプロジェクトのため、ライセンスは未定です。
