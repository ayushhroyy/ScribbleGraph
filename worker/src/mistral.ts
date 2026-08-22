import type { Env } from "./types";

const BASE = "https://api.mistral.ai/v1";

export interface OcrImage {
  id: string;
  top_left_x: number;
  top_left_y: number;
  bottom_right_x: number;
  bottom_right_y: number;
  image_base64?: string;
}

export interface OcrPage {
  index: number;
  markdown: string;
  images: OcrImage[];
  dimensions?: { dpi: number; height: number; width: number };
}

async function mistralFetch(env: Env, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mistral ${path} ${res.status}: ${text.slice(0, 500)}`);
  }
  return res.json();
}

export async function ocrImage(
  env: Env,
  base64: string,
  mimeType = "image/jpeg"
): Promise<{ pages: OcrPage[] }> {
  return mistralFetch(env, "/ocr", {
    model: env.OCR_MODEL,
    document: { type: "image_url", image_url: `data:${mimeType};base64,${base64}` },
    include_image_base64: false,
    confidence_scores_granularity: "word",
  });
}

export async function embed(env: Env, inputs: string[]): Promise<number[][]> {
  const out: number[][] = [];
  const BATCH = 32;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const json = await mistralFetch(env, "/embeddings", {
      model: env.EMBED_MODEL,
      input: batch,
    });
    const data: { embedding: number[] }[] = json.data;
    out.push(...data.map((d) => d.embedding));
  }
  return out;
}

export async function chat(
  env: Env,
  messages: { role: string; content: string }[],
  opts: { temperature?: number } = {}
): Promise<string> {
  const json = await mistralFetch(env, "/chat/completions", {
    model: env.CHAT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.3,
  });
  return json.choices[0].message.content as string;
}
