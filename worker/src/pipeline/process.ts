import { ocrImage, embed } from "../mistral";
import type { Env } from "../types";
import { chunkMarkdown } from "./chunk";
import { upsertVectors, queryVectors } from "./vec";

export type { Env };

export const LINK_THRESHOLD = 0.8;

export async function processPage(env: Env, pageId: string, sessionId: string, r2Key: string) {
  const obj = await env.BUCKET.get(r2Key);
  if (!obj) throw new Error(`R2 object missing: ${r2Key}`);
  const buf = await obj.arrayBuffer();
  const base64 = arrayBufferToBase64(buf);

  await setStatus(env, pageId, "ocr");
  const { pages } = await ocrImage(env, base64);
  const page = pages[0];
  if (!page) {
    await setStatus(env, pageId, "done", 0);
    return;
  }

  // store figure/table crops from OCR bboxes
  if (page.images?.length) {
    for (const img of page.images) {
      await env.DB.prepare(
        "INSERT INTO regions (id, page_id, label, bbox, r2_key) VALUES (?1,?2,?3,?4,NULL)"
      )
        .bind(
          crypto.randomUUID(),
          pageId,
          guessRegionLabel(img),
          JSON.stringify([
            img.top_left_x,
            img.top_left_y,
            img.bottom_right_x,
            img.bottom_right_y,
          ])
        )
        .run();
    }
  }

  const markdown = page.markdown ?? "";
  const avgConf = extractAvgConfidence(page as any);
  await env.DB.prepare(
    "UPDATE pages SET markdown = ?1, avg_confidence = ?2, status = 'embedded', width = ?3, height = ?4 WHERE id = ?5"
  )
    .bind(markdown, avgConf, page.dimensions?.width ?? null, page.dimensions?.height ?? null, pageId)
    .run();

  // chunk + embed + vectorize + backlinks
  const pieces = chunkMarkdown(markdown);
  if (pieces.length) {
    const embeddings = await embed(env, pieces);
    const vectors = pieces.map((_, i) => ({
      id: crypto.randomUUID(),
      values: embeddings[i],
      metadata: { page_id: pageId, session_id: sessionId },
    }));
    for (let i = 0; i < vectors.length; i++) {
      await env.DB.prepare("INSERT INTO chunks (id, page_id, idx, text) VALUES (?1,?2,?3,?4)")
        .bind(vectors[i].id, pageId, i, pieces[i])
        .run();
    }
    await upsertVectors(env, vectors);

    await findBacklinks(env, pageId, vectors);
  }

  await setStatus(env, pageId, "done", avgConf);
  await maybeFinalizeSession(env, sessionId);
}

async function findBacklinks(env: Env, pageId: string, vectors: { id: string; values: number[]; metadata: Record<string, unknown> }[]) {
  for (const v of vectors) {
    const hits = await queryVectors(env, v.values, 8);
    for (const match of hits) {
      if (match.score < LINK_THRESHOLD) continue;
      const otherId = String(match.id);
      if (otherId === v.id) continue;
      const meta = (match.metadata ?? {}) as Record<string, unknown>;
      if (meta.page_id === pageId) continue;
      const a = v.id < otherId ? v.id : otherId;
      const b = v.id < otherId ? otherId : v.id;
      // guard against stale Vectorize vectors whose chunks were deleted
      const exists = await env.DB.prepare("SELECT 1 FROM chunks WHERE id IN (?1, ?2)")
        .bind(a, b)
        .first();
      if (!exists) continue;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO backlinks (id, chunk_a, chunk_b, score, created_at) VALUES (?1,?2,?3,?4,?5)"
      )
        .bind(crypto.randomUUID(), a, b, match.score, Date.now())
        .run();
    }
  }
}

export async function maybeFinalizeSession(env: Env, sessionId: string) {
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pages WHERE session_id = ?1 AND status NOT IN ('done','error')"
  )
    .bind(sessionId)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) > 0) return;

  const errored = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pages WHERE session_id = ?1 AND status = 'error'"
  )
    .bind(sessionId)
    .first<{ n: number }>();
  const finalStatus = (errored?.n ?? 0) > 0 ? "partial" : "ready";

  const session = await env.DB.prepare("SELECT id, created_at FROM sessions WHERE id = ?1")
    .bind(sessionId)
    .first<{ id: string; created_at: number }>();
  if (!session) return;

  const rows = await env.DB.prepare(
    `SELECT c.id, c.text FROM chunks c JOIN pages p ON p.id = c.page_id
     WHERE p.session_id = ?1 ORDER BY p.idx, c.idx LIMIT 40`
  )
    .bind(sessionId)
    .all<{ id: string; text: string }>();

  const chunks = rows.results ?? [];
  const numbered = chunks.map((r, i) => `[${i + 1}] ${r.text}`).join("\n\n").slice(0, 10000);

  let title = `Notes · ${new Date(session.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  let concepts: { name: string; subject: string; chunks: number[] }[] = [];
  if (numbered.length > 80) {
    const { chat } = await import("../mistral");
    try {
      const raw = await chat(
        env,
        [
          {
            role: "user",
            content: `You are tagging study notes. The chunks below are numbered [1]..[${chunks.length}].

Return ONLY valid JSON:
{"title":"short session title (max 6 words)","concepts":[{"name":"concept name","subject":"math|physics|chemistry|circuits|cs|other","chunks":[1,2]}]}

Rules: 3-8 distinct concepts. "chunks" lists the numbers where the concept appears.

Notes:
${numbered}`,
          },
        ],
        { temperature: 0.2 }
      );
      const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
      if (parsed.title) title = parsed.title;
      if (Array.isArray(parsed.concepts)) concepts = parsed.concepts.slice(0, 10);
    } catch {
      /* keep fallbacks */
    }
  }

  await env.DB.prepare("UPDATE sessions SET title = ?1, status = ?2 WHERE id = ?3")
    .bind(title.slice(0, 80).trim(), finalStatus, sessionId)
    .run();

  // store concepts + links
  const COLORS: Record<string, string> = {
    math: "#7C6CFF",
    physics: "#4CC9F0",
    circuits: "#F72585",
    chemistry: "#4ADE80",
    cs: "#FBBF24",
    other: "#9CA3AF",
  };
  for (const con of concepts) {
    const name = String(con.name).slice(0, 60);
    const subject = String(con.subject || "other").toLowerCase();
    await env.DB.prepare(
      "INSERT INTO concepts (id, name, subject, color) VALUES (?1,?2,?3,?4) ON CONFLICT(name) DO NOTHING"
    )
      .bind(uuidOf(name), name, subject, COLORS[subject] ?? COLORS.other)
      .run();
    for (const idx of con.chunks ?? []) {
      const chunk = chunks[Number(idx) - 1];
      if (!chunk) continue;
      await env.DB.prepare(
        "INSERT OR IGNORE INTO concept_links (concept_id, chunk_id) VALUES (?1,?2)"
      )
        .bind(uuidOf(name), chunk.id)
        .run();
    }
  }
}

function uuidOf(name: string): string {
  // deterministic id per concept name (stable across sessions)
  const hex = Array.from(new TextEncoder().encode(`sg:${name}`))
    .reduce((a, b) => (a * 31 + b) % 0xffffffff, 7)
    .toString(16)
    .padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex}0000`.slice(0, 36);
}

function guessRegionLabel(img: { id: string }): string {
  if (/table/i.test(img.id)) return "table";
  if (/chart|plot|graph/i.test(img.id)) return "chart";
  if (/formula|eq/i.test(img.id)) return "formula";
  return "figure";
}

function extractAvgConfidence(page: any): number | null {
  const words = page?.confidence_scores?.words ?? page?.words ?? null;
  if (Array.isArray(words) && words.length) {
    const vals = words.map((w: any) => w.confidence).filter((c: any) => typeof c === "number");
    if (vals.length) return vals.reduce((a: number, b: number) => a + b, 0) / vals.length;
  }
  return null;
}

async function setStatus(env: Env, pageId: string, status: string, conf?: number | null) {
  await env.DB.prepare("UPDATE pages SET status = ?1 WHERE id = ?2").bind(status, pageId).run();
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
