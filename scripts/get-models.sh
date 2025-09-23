#!/bin/bash
set -euo pipefail

PROJECT_ID=${1:-$GOOGLE_CLOUD_PROJECT}
LOCATION=${2:-us-central1}

if [[ -z "${PROJECT_ID:-}" ]]; then
  echo "プロジェクトIDを指定するか GOOGLE_CLOUD_PROJECT を設定してください" >&2
  exit 1
fi

gcloud ai models list \
  --project="$PROJECT_ID" \
  --region="$LOCATION" \
  --filter="publisherModelTemplate~imagen-3" || true
