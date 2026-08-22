# ScribbleGraph

AI OCR handwritten notes digitizer & concept tagger. Capture notebook pages with auto-capture camera → OCR → semantic chunking → cross-day concept linking → RAG chat, quizzes, flashcards, and a concept graph.

## Stack

- **Frontend**: React + Vite + Tailwind v4 (SPA served as Worker static assets)
- **API**: Hono on Cloudflare Workers (queue consumer for processing pipeline)
- **Storage**: R2 (page images) · D1 (metadata/OCR/chunks) · Vectorize (embeddings, D1 fallback locally)
- **AI**: Mistral — OCR (`mistral-ocr-latest`), embeddings (`mistral-embed`), chat (`mistral-small-latest`)
- **Capture**: `js-document-autocapture` (client-side auto page detection + guidance)

## Setup

```bash
npm install --workspaces --include-workspace-root
cp worker/.dev.vars.example worker/.dev.vars   # add your Mistral API key
npm run build -w web                            # build SPA into web/dist (served by worker)
npm run dev -w worker                           # wrangler dev on :8787
```

Open http://localhost:8787 (serves the built SPA + API together).

Frontend hot-reload mode (optional): `npm run dev -w web` → http://localhost:5173 (proxies /api + /media to :8787).

### First run

```bash
npx wrangler d1 execute scribblegraph-db --local --file=schema.sql   # init DB
curl -X POST http://localhost:8787/api/dev/seed                      # seed 3 days of demo notes
```

## API

| Route | Purpose |
|---|---|
| `POST /api/sessions` | Create capture session |
| `POST /api/sessions/:id/pages` | Upload page image → R2 → queue |
| `GET /api/sessions/:id` · `GET /api/pages/:id` | Session/page + backlinks |
| `GET /api/graph` | Concept graph nodes/edges |
| `POST /api/chat` | RAG Q&A over your notes (with sources) |
| `POST /api/quiz/generate` · `POST /api/quiz/:id/answer` | MCQ quiz |
| `POST /api/flashcards/generate` · `GET /api/flashcards/due` · `POST /api/flashcards/:id/review` | Leitner flashcards |
| `POST /api/dev/seed` | Demo data (3 sessions across 15 days) |

## Deploy (when ready)

```bash
# create resources once:
npx wrangler r2 bucket create scribblegraph
npx wrangler d1 create scribblegraph-db           # put id in wrangler.jsonc
npx wrangler vectorize create scribblegraph-chunks --dimensions 1024 --metric cosine
npx wrangler queues create process-page
npx wrangler secret put MISTRAL_API_KEY
npx wrangler d1 execute scribblegraph-db --remote --file=schema.sql

npm run build -w web && npm run deploy -w worker
```
