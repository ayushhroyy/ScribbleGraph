import type { Env } from "../types";

/**
 * Vector store abstraction: uses Cloudflare Vectorize when available,
 * falls back to D1 brute-force cosine search for local dev (where the
 * Vectorize binding is not supported).
 */

export interface VecHit {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
}

async function vectorizeAvailable(env: Env): Promise<boolean> {
  try {
    await (env.VEC as any).describe?.();
    return true;
  } catch {
    return false;
  }
}

export async function upsertVectors(env: Env, vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[]): Promise<void> {
  // record ids in D1 ledger (used to purge Vectorize on reseed/reprocess)
  for (const v of vectors) {
    await env.DB.prepare(
      "INSERT OR REPLACE INTO vectors (chunk_id, page_id, session_id, vec_json) VALUES (?1,?2,?3,?4)"
    )
      .bind(v.id, String(v.metadata.page_id ?? ""), String(v.metadata.session_id ?? ""), "[]")
      .run();
  }
  if (await vectorizeAvailable(env)) {
    await env.VEC.upsert(vectors as VectorizeVector[]);
  } else {
    for (const v of vectors) {
      await env.DB.prepare(
        "UPDATE vectors SET vec_json = ?2 WHERE chunk_id = ?1"
      )
        .bind(v.id, JSON.stringify(v.values))
        .run();
    }
  }
}

/** remove every indexed vector (Vectorize + local fallback table) */
export async function purgeAllVectors(env: Env): Promise<number> {
  const { results } = await env.DB.prepare("SELECT chunk_id FROM vectors").all<{ chunk_id: string }>();
  const ids = (results ?? []).map((r) => r.chunk_id);
  if (await vectorizeAvailable(env)) {
    for (let i = 0; i < ids.length; i += 100) {
      await (env.VEC as any).deleteByIds(ids.slice(i, i + 100));
    }
  }
  if (ids.length) {
    await env.DB.prepare("DELETE FROM vectors").run();
  }
  return ids.length;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function queryVectors(env: Env, values: number[], topK: number): Promise<VecHit[]> {
  if (await vectorizeAvailable(env)) {
    const res = await env.VEC.query(values, { topK, returnMetadata: "all" });
    return res.matches.map((m: any) => ({ id: String(m.id), score: m.score ?? 0, metadata: m.metadata }));
  }
  const { results } = await env.DB.prepare("SELECT chunk_id, page_id, session_id, vec_json FROM vectors").all<{
    chunk_id: string;
    page_id: string;
    session_id: string;
    vec_json: string;
  }>();
  const rows = results ?? [];
  return rows
    .map((r: { chunk_id: string; page_id: string; session_id: string; vec_json: string }) => ({
      id: r.chunk_id,
      score: cosine(values, JSON.parse(r.vec_json)),
      metadata: { page_id: r.page_id, session_id: r.session_id },
    }))
    .sort((a: VecHit, b: VecHit) => b.score - a.score)
    .slice(0, topK);
}
