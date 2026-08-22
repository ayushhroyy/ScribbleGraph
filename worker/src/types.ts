export interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  VEC: VectorizeIndex;
  QUEUE: Queue<{ pageId: string; sessionId: string; r2Key: string }>;
  ASSETS: Fetcher;
  MISTRAL_API_KEY: string;
  OCR_MODEL: string;
  CHAT_MODEL: string;
  EMBED_MODEL: string;
  STT_MODEL: string;
  TTS_MODEL: string;
  TTS_VOICE: string;
}
