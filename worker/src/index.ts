import { Hono, type Context } from "hono";
import { chat, embed } from "./mistral";
import { processPage, maybeFinalizeSession, LINK_THRESHOLD, type Env } from "./pipeline/process";
import { queryVectors } from "./pipeline/vec";

const app = new Hono<{ Bindings: Env }>();

const uuid = () => crypto.randomUUID();

/* ---------- sessions & pages ---------- */

app.post("/api/sessions", async (c) => {
  const id = uuid();
  await c.env.DB.prepare("INSERT INTO sessions (id, title, created_at, status) VALUES (?1, ?2, ?3, 'processing')")
    .bind(id, null, Date.now())
    .run();
  return c.json({ id });
});

app.get("/api/sessions", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.*, 
       (SELECT r2_key FROM pages WHERE session_id = s.id ORDER BY idx LIMIT 1) AS thumb,
       (SELECT COUNT(*) FROM backlinks b JOIN chunks ca ON ca.id = b.chunk_a JOIN pages pa ON pa.id = ca.page_id WHERE pa.session_id = s.id) AS links
     FROM sessions s ORDER BY s.created_at DESC LIMIT 50`
  ).all();
  return c.json({ sessions: results });
});

app.get("/api/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const session = await c.env.DB.prepare("SELECT * FROM sessions WHERE id = ?1").bind(id).first();
  if (!session) return c.json({ error: "not found" }, 404);
  const { results: pages } = await c.env.DB.prepare(
    "SELECT id, idx, r2_key, status, avg_confidence, width, height FROM pages WHERE session_id = ?1 ORDER BY idx"
  )
    .bind(id)
    .all();

  const [counts] = (
    await c.env.DB.prepare(
      `SELECT
        SUM(CASE WHEN status IN ('queued','ocr','embedded') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
       FROM pages WHERE session_id = ?1`
    )
      .bind(id)
      .all()
  ).results as unknown as { active: number; errors: number; done: number }[];

  return c.json({ session, pages, counts: counts ?? { active: 0, errors: 0, done: 0 } });
});

app.post("/api/pages/:id/reprocess", async (c) => {
  const pageId = c.req.param("id");
  const page = await c.env.DB.prepare("SELECT r2_key, session_id FROM pages WHERE id = ?1")
    .bind(pageId)
    .first<{ r2_key: string; session_id: string }>();
  if (!page) return c.json({ error: "not found" }, 404);
  await c.env.DB.prepare("UPDATE pages SET status = 'queued' WHERE id = ?1").bind(pageId).run();
  await c.env.DB.prepare("UPDATE sessions SET status = 'processing' WHERE id = ?1")
    .bind(page.session_id)
    .run();
  await c.env.QUEUE.send({ pageId, sessionId: page.session_id, r2Key: page.r2_key });
  return c.json({ ok: true });
});

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

app.post("/api/sessions/:id/pages", async (c) => {
  const sessionId = c.req.param("id");
  const form = await c.req.formData();
  const file = form.get("file") as File | null;
  if (!file) return c.json({ error: "file required" }, 400);

  const countRow = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM pages WHERE session_id = ?1"
  )
    .bind(sessionId)
    .first<{ n: number }>();
  const idx = countRow?.n ?? 0;

  const ext = (file.name.split(".").pop() ?? "jpg").toLowerCase();
  const r2Key = `pages/${sessionId}/${idx}.${MIME[ext] ? ext : "jpg"}`;
  await c.env.BUCKET.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || "image/jpeg" },
  });

  const pageId = uuid();
  await c.env.DB.prepare(
    "INSERT INTO pages (id, session_id, idx, r2_key, status, created_at) VALUES (?1,?2,?3,?4,'queued',?5)"
  )
    .bind(pageId, sessionId, idx, r2Key, Date.now())
    .run();
  await c.env.DB.prepare("UPDATE sessions SET page_count = ?2 WHERE id = ?1")
    .bind(sessionId, idx + 1)
    .run();

  if ((c.req.header("x-dry-run") ?? "") !== "1") {
    await c.env.QUEUE.send({ pageId, sessionId, r2Key });
  }
  return c.json({ pageId, idx });
});

app.get("/api/pages/:id", async (c) => {
  const id = c.req.param("id");
  const page = await c.env.DB.prepare(
    "SELECT p.*, s.id AS session_id, s.title AS session_title FROM pages p JOIN sessions s ON s.id = p.session_id WHERE p.id = ?1"
  )
    .bind(id)
    .first<any>();
  if (!page) return c.json({ error: "not found" }, 404);

  const { results: regions } = await c.env.DB.prepare(
    "SELECT * FROM regions WHERE page_id = ?1"
  )
    .bind(id)
    .all();

  const { results: backlinks } = await c.env.DB.prepare(
    `SELECT DISTINCT p2.id AS page_id, p2.session_id, p2.idx AS page_idx, s.title AS session_title,
       s.created_at AS session_date, bl.score
     FROM backlinks bl
     JOIN chunks c1 ON c1.id IN (bl.chunk_a, bl.chunk_b) AND c1.page_id = ?1
     JOIN chunks c2 ON c2.id IN (bl.chunk_a, bl.chunk_b) AND c2.page_id != ?1
     JOIN pages p2 ON p2.id = c2.page_id
     JOIN sessions s ON s.id = p2.session_id
     ORDER BY bl.score DESC LIMIT 20`
  )
    .bind(id)
    .all();

  return c.json({ page, regions, backlinks });
});

app.patch("/api/pages/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ markdown?: string }>();
  if (typeof body.markdown === "string") {
    await c.env.DB.prepare("UPDATE pages SET markdown = ?1 WHERE id = ?2")
      .bind(body.markdown, id)
      .run();
  }
  return c.json({ ok: true });
});

app.get("/media/:key{.+}", async (c) => {
  const key = c.req.param("key");
  const obj = await c.env.BUCKET.get(key);
  if (!obj) return c.text("not found", 404);
  return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream" } });
});

/* ---------- dashboard ---------- */

app.get("/api/dashboard", async (c) => {
  const sessions = await c.env.DB.prepare(
    `SELECT s.id, s.title, s.created_at, s.page_count, s.status,
       (SELECT r2_key FROM pages WHERE session_id = s.id ORDER BY idx LIMIT 1) AS thumb
     FROM sessions s ORDER BY s.created_at DESC LIMIT 8`
  ).all();
  const chats = await c.env.DB.prepare(
    "SELECT id, title, created_at FROM chats ORDER BY created_at DESC LIMIT 5"
  ).all();
  const [stats] = await Promise.all([
    c.env.DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM pages) AS pages,
        (SELECT COUNT(*) FROM concepts) AS concepts,
        (SELECT COUNT(*) FROM backlinks) AS connections`
    ).first(),
  ]);
  return c.json({ sessions: sessions.results, chats: chats.results, stats });
});

/* ---------- concept graph ---------- */

app.get("/api/graph", async (c) => {
  const { results: concepts } = await c.env.DB.prepare(
    "SELECT * FROM concepts LIMIT 120"
  ).all();
  const { results: edgesRaw } = await c.env.DB.prepare(
    `SELECT cl1.concept_id AS a, cl2.concept_id AS b, COUNT(*) AS w
     FROM concept_links cl1
     JOIN concept_links cl2 ON cl1.chunk_id = cl2.chunk_id AND cl1.concept_id < cl2.concept_id
     GROUP BY a, b ORDER BY w DESC LIMIT 300`
  ).all();
  return c.json({
    nodes: concepts.map((n: any) => ({ id: n.name, subject: n.subject, color: n.color })),
    edges: edgesRaw,
  });
});

/* ---------- ask AI (RAG) ---------- */

app.get("/api/chats", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, title, created_at FROM chats ORDER BY created_at DESC LIMIT 20"
  ).all();
  return c.json({ chats: results });
});

app.get("/api/chats/:id", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT role, content, sources_json FROM messages WHERE chat_id = ?1 ORDER BY created_at"
  )
    .bind(c.req.param("id"))
    .all();
  return c.json({ messages: results });
});

app.post("/api/chat", async (c) => {
  const { chatId, question } = await c.req.json<{ chatId?: string; question: string }>();
  let id = chatId as string | undefined;
  if (!id) {
    id = uuid();
    await c.env.DB.prepare("INSERT INTO chats (id, title, created_at) VALUES (?1,?2,?3)")
      .bind(id, question.slice(0, 60), Date.now())
      .run();
  }

  const save = async (answer: string, sources: unknown[], mode: string) => {
    await c.env.DB.prepare("INSERT INTO messages (id, chat_id, role, content, sources_json, created_at) VALUES (?1,?2,'user',?3,NULL,?4)")
      .bind(uuid(), id, question, Date.now())
      .run();
    await c.env.DB.prepare("INSERT INTO messages (id, chat_id, role, content, sources_json, created_at) VALUES (?1,?2,'assistant',?3,?4,?5)")
      .bind(uuid(), id, answer, JSON.stringify(sources), Date.now() + 1)
      .run();
    return c.json({ chatId: id, answer, sources, mode });
  };

  // small-talk fast path: greetings/thanks/bye → instant reply, zero API calls
  const small = question.trim().toLowerCase().replace(/[^a-z\s]/g, "").trim();
  if (/^(hi+|h+e+y+|h+l+o+|hello+|yo+|sup|hola|namaste|hii+|heyy+|good (morning|afternoon|evening))\s*(there|scribble|buddy|pal)?$/.test(small)) {
    return save(
      "Hey! I'm Scribble. Ask me anything — I'll use your notes when they're relevant, and general knowledge otherwise. Try \"explain Fourier transforms\" or \"quiz me on acids and bases\".",
      [], "greeting"
    );
  }
  if (/^(thanks|thank you|ty|thx|bye|goodbye|good night|gn)(\s+(scribble|buddy|pal))?$/.test(small)) {
    return save("Anytime! Ping me whenever you want to study. 📚", [], "greeting");
  }

  const [qvec] = await embed(c.env, [question]);
  const matches = await queryVectors(c.env, qvec, 8);
  // mistral-embed baseline similarity is ~0.72 for unrelated text — only
  // genuinely relevant chunks pass, so answers stop quoting random sessions
  const RELEVANT = 0.75;

  const byPage = new Map<string, { score: number; text: string; row: any }>();
  const hits = matches.filter((m) => m.score >= RELEVANT).sort((a, b) => b.score - a.score);
  for (const m of hits) {
    const row = await c.env.DB.prepare(
      `SELECT ch.text, p.id AS page_id, p.idx AS page_idx, p.session_id, s.created_at AS session_date, s.title
       FROM chunks ch JOIN pages p ON p.id = ch.page_id JOIN sessions s ON s.id = p.session_id
       WHERE ch.id = ?1`
    )
      .bind(String(m.id))
      .first<any>();
    if (!row) continue;
    const prev = byPage.get(row.page_id);
    if (prev) {
      if (m.score > prev.score) { prev.score = m.score; prev.text = row.text; }
      prev.text = prev.text === row.text ? prev.text : `${prev.text}\n${row.text}`;
      continue;
    }
    byPage.set(row.page_id, { score: m.score, text: row.text, row });
  }
  const picked = [...byPage.values()].sort((a, b) => b.score - a.score).slice(0, 4);

  const sources: { sessionId: string; pageTitle: string; dayLabel: string; text: string }[] = [];
  const contextParts: string[] = [];
  for (const p of picked) {
    const d = new Date(p.row.session_date).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    sources.push({ sessionId: p.row.session_id, pageTitle: p.row.title ?? "Notes", dayLabel: `${d} · Page ${p.row.page_idx + 1}`, text: p.text.slice(0, 200) });
    contextParts.push(`[Source: ${p.row.title ?? "notes"}, ${d}, page ${p.row.page_idx + 1}]\n${p.text}`);
  }

  // RAG is a plug-in: notes ground the answer when relevant, otherwise the
  // assistant answers from general knowledge instead of refusing.
  const identity =
    "You are Scribble, the voice and chat assistant of the ScribbleGraph study app — the user calls you by your wake word \"Scribble\". Be warm and conversational; greet greetings, and if asked who you are, explain that you help them study their captured notes.";
  const answer = await chat(c.env, [
    {
      role: "system",
      content: identity + " " + (picked.length
        ? "The user's notes below are your primary source — use them and cite inline like (Source title, Page N). You may supplement with general knowledge when the notes are incomplete; keep note-based claims cited and extra context clearly yours."
        : "The user's notes don't cover this topic, so answer from general knowledge as a great study mentor: clear, structured, example-driven. If it's worth saving, suggest capturing notes on it so future answers can cite their own pages."),
    },
    {
      role: "user",
      content: picked.length
        ? `My notes:\n\n${contextParts.join("\n\n")}\n\nQuestion: ${question}`
        : question,
    },
  ]);

  return save(answer, sources, picked.length ? "notes" : "general");
});

/* ---------- mentor (voice) ---------- */

app.post("/api/mentor/transcribe", async (c) => {
  const form = await c.req.formData();
  const file = form.get("audio") as File | null;
  if (!file) return c.json({ error: "audio required" }, 400);
  const fd = new FormData();
  fd.append("file", file, file.name || "audio.webm");
  fd.append("model", c.env.STT_MODEL);
  const res = await fetch("https://api.mistral.ai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${c.env.MISTRAL_API_KEY}` },
    body: fd,
  });
  if (!res.ok) return c.json({ error: await res.text() }, 502);
  const json: { text?: string } = await res.json();
  return c.json({ text: (json.text ?? "").trim() });
});

app.post("/api/mentor/speak", async (c) => {
  const { text } = await c.req.json<{ text: string }>();
  if (!text) return c.json({ error: "text required" }, 400);
  // speak a trimmed portion for snappy playback; full text lives in the UI
  let spoken = text.slice(0, 650);
  const cut = spoken.lastIndexOf(". ");
  if (cut > 120) spoken = spoken.slice(0, cut + 1);
  const res = await fetch("https://api.mistral.ai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${c.env.MISTRAL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: c.env.TTS_MODEL,
      input: spoken,
      voice_id: c.env.TTS_VOICE,
    }),
  });
  if (!res.ok) return c.json({ error: await res.text() }, 502);
  const json: { audio_data?: string } = await res.json();
  if (!json.audio_data) return c.json({ error: "no audio" }, 502);
  const bytes = Uint8Array.from(atob(json.audio_data), (ch) => ch.charCodeAt(0));
  return new Response(bytes, {
    headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
  });
});

/* ---------- quiz ---------- */

app.post("/api/quiz/generate", async (c) => {
  const { sessionId } = await c.req.json<{ sessionId: string }>();
  const rows = await c.env.DB.prepare(
    `SELECT ch.text FROM chunks ch JOIN pages p ON p.id = ch.page_id WHERE p.session_id = ?1 LIMIT 25`
  )
    .bind(sessionId)
    .all<{ text: string }>();
  const corpus = (rows.results ?? []).map((r) => r.text).join("\n---\n").slice(0, 9000);
  const raw = await chat(c.env, [
    {
      role: "user",
      content: `Create 5 multiple-choice questions from these study notes. Return ONLY valid JSON array: [{"question":"...","options":["a","b","c","d"],"answer":0,"explanation":"..."}]\n\nNotes:\n${corpus}`,
    },
  ], { temperature: 0.4 });
  const jsonText = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  const questions = JSON.parse(jsonText);
  const id = uuid();
  await c.env.DB.prepare("INSERT INTO quizzes (id, session_id, questions_json, created_at) VALUES (?1,?2,?3,?4)")
    .bind(id, sessionId, JSON.stringify(questions), Date.now())
    .run();
  return c.json({ quizId: id, questions });
});

app.post("/api/quiz/:id/answer", async (c) => {
  const id = c.req.param("id");
  const { answers } = await c.req.json<{ answers: number[] }>();
  const quiz = await c.env.DB.prepare("SELECT questions_json FROM quizzes WHERE id = ?1").bind(id).first<any>();
  if (!quiz) return c.json({ error: "not found" }, 404);
  const questions = JSON.parse(quiz.questions_json);
  const score = questions.reduce((acc: number, q: any, i: number) => acc + (answers[i] === q.answer ? 1 : 0), 0);
  await c.env.DB.prepare("UPDATE quizzes SET score = ?1 WHERE id = ?2").bind(score, id).run();
  return c.json({ score, total: questions.length });
});

/* ---------- flashcards ---------- */

app.post("/api/flashcards/generate", async (c) => {
  const { sessionId } = await c.req.json<{ sessionId: string }>();
  const rows = await c.env.DB.prepare(
    `SELECT ch.text FROM chunks ch JOIN pages p ON p.id = ch.page_id WHERE p.session_id = ?1 LIMIT 20`
  )
    .bind(sessionId)
    .all<{ text: string }>();
  const corpus = (rows.results ?? []).map((r) => r.text).join("\n---\n").slice(0, 8000);
  const raw = await chat(c.env, [
    {
      role: "user",
      content: `Create 8 flashcards from these study notes. Return ONLY valid JSON array: [{"front":"...","back":"..."}]\n\nNotes:\n${corpus}`,
    },
  ], { temperature: 0.4 });
  const cards = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
  const now = Date.now();
  for (const card of cards) {
    await c.env.DB.prepare("INSERT INTO flashcards (id, front, back, leitner_box, due_at, created_at) VALUES (?1,?2,?3,1,?4,?5)")
      .bind(uuid(), card.front, card.back, now, now)
      .run();
  }
  return c.json({ created: cards.length });
});

app.get("/api/flashcards/due", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM flashcards WHERE due_at <= ?1 ORDER BY leitner_box ASC, due_at ASC LIMIT 20"
  )
    .bind(Date.now())
    .all();
  return c.json({ cards: results });
});

app.post("/api/flashcards/:id/review", async (c) => {
  const id = c.req.param("id");
  const { correct } = await c.req.json<{ correct: boolean }>();
  const card = await c.env.DB.prepare("SELECT leitner_box FROM flashcards WHERE id = ?1").bind(id).first<{ leitner_box: number }>();
  if (!card) return c.json({ error: "not found" }, 404);
  const box = Math.max(1, Math.min(5, card.leitner_box + (correct ? 1 : -1)));
  const intervals = [0, 1, 2, 4, 7, 14];
  const due = Date.now() + intervals[box] * 86400_000;
  await c.env.DB.prepare("UPDATE flashcards SET leitner_box = ?1, due_at = ?2 WHERE id = ?3")
    .bind(box, due, id)
    .run();
  return c.json({ box, dueAt: due });
});

/* ---------- dev: seed demo data ---------- */

const SEED_SESSIONS: { title: string; daysAgo: number; pages: string[] }[] = [
  {
    title: "Fourier Series — Lecture Notes",
    daysAgo: 15,
    pages: [
      `# Fourier Series Introduction

Any periodic function f(t) with period T can be written as a sum of sines and cosines.

f(t) = a0/2 + sum over n of [an cos(2 pi n t / T) + bn sin(2 pi n t / T)]

The coefficients are found by orthogonality of sinusoids:
an = (2/T) integral of f(t) cos(2 pi n t / T) dt from 0 to T
bn = (2/T) integral of f(t) sin(2 pi n t / T) dt from 0 to T

Orthogonality: integral of sin(mt) sin(nt) over a period is zero unless m = n.`,
      `# Orthogonality and Square Wave Example

The sinusoids form an orthogonal basis over one period. This is what lets us solve for each coefficient independently — project f(t) onto each sine and cosine.

Square wave example: only odd harmonics survive, each with amplitude proportional to 1/n. The spectrum is discrete: lines at 1f, 3f, 5f with decreasing height.

Energy concentrates at low frequencies — most of the square wave's power sits in the first few harmonics.`,
      `# Convergence of Fourier Series

Dirichlet conditions: if f is piecewise continuous and has finite extrema per period, the series converges to f(t) at points of continuity, and to the midpoint of the jump at discontinuities.

Gibbs phenomenon: near a jump discontinuity, the partial sums overshoot by about 9% of the jump height, regardless of how many terms are used.

The overshoot does not shrink with more terms — it only gets narrower.`,
      `# Practice Problems

1. Compute the Fourier series of a sawtooth wave of period T. Answer: only sine terms, bn proportional to (-1)^(n+1)/n.

2. Triangular wave: only cosine terms, even harmonics, amplitudes 1/n^2 — decays much faster than the square wave.

3. Sketch the first four partial sums of the square wave and mark the Gibbs overshoot near each discontinuity.`,
    ],
  },
  {
    title: "Fourier Transform — Derivations",
    daysAgo: 8,
    pages: [
      `# Fourier Transform Definition

Extending Fourier series to non-periodic signals: let the period T go to infinity.

F(omega) = integral of f(t) e^(-j omega t) dt over all time
f(t) = (1/2 pi) integral of F(omega) e^(j omega t) d omega

The transform decomposes a signal into complex exponentials e^(j omega t), which are eigenfunctions of linear time-invariant systems.`,
      `# Properties and Duality

Time shift: f(t - t0) transforms to F(omega) e^(-j omega t0).
Frequency shift (modulation): multiplying by e^(j omega0 t) shifts the spectrum.
Convolution theorem: convolution in time equals multiplication in frequency. This is why LTI systems multiply the spectrum by H(omega).

Parseval: energy in time domain equals energy in frequency domain divided by 2 pi.`,
      `# Transform Pairs

Rect pulse in time transforms to a sinc in frequency. A Gaussian transforms to another Gaussian — the only function that is its own shape under the transform.

Modulation: multiplying a signal by a cosine shifts its spectrum to two sidebands at plus and minus the carrier. This is exactly how AM radio works.

Wide in time means narrow in frequency, and vice versa — the uncertainty principle of signal processing.`,
    ],
  },
  {
    title: "RC Circuits — Lab",
    daysAgo: 12,
    pages: [
      `# RC Charging Circuit

Charging a capacitor through a resistor from voltage V:
v(t) = V (1 - e^(-t/RC))

The time constant tau = RC sets the speed: after one tau the capacitor reaches 63% of V, after five tau it is practically full.

Discharging follows v(t) = V e^(-t/RC) — mirror image, same constant.`,
      `# RC Low-Pass Filter

In the frequency domain the RC circuit is a low-pass filter. Frequency response:
H(omega) = 1 / (1 + j omega RC)

Cutoff frequency: fc = 1 / (2 pi RC). Below fc the output follows the input; above fc the output rolls off at -20 dB per decade.

The RC circuit is an LTI system — its behavior in frequency is fully described by H(omega), exactly the transfer function idea from the Fourier transform lectures.`,
      `# Lab Measurements

Oscilloscope: applied sine waves from 100 Hz to 10 kHz, measured output amplitude and phase shift.

At the cutoff frequency the output is 0.707 of the input (-3 dB) and the phase shift is -45 degrees. Measured fc matched the calculation 1/(2 pi RC) within 5%.

Above cutoff the amplitude drops steadily — consistent with the -20 dB/decade slope of a first order system.`,
    ],
  },
  {
    title: "Electromagnetic Waves",
    daysAgo: 6,
    pages: [
      `# Maxwell's Equations and Waves

Maxwell's equations in vacuum predict electromagnetic waves travelling at
c = 1 / sqrt(mu0 eps0) — which equals the measured speed of light. Light is an electromagnetic wave.

The wave equation comes straight from combining the curl equations: E and B are perpendicular to each other and to the direction of travel.`,
      `# Polarization and Refraction

Polarization describes the orientation of the electric field. Linear polarization: field oscillates in one plane.

Snell's law: n1 sin(theta1) = n2 sin(theta2). Light bends toward the normal entering a denser medium.

Beyond the critical angle total internal reflection occurs — the principle behind optical fibers.`,
    ],
  },
  {
    title: "Thermodynamics — Laws",
    daysAgo: 4,
    pages: [
      `# First Law of Thermodynamics

Energy conservation for a thermodynamic system:
delta U = Q - W

Q is heat added to the system, W is work done by the system. Sign conventions matter — getting them backwards is the most common exam mistake.

For an ideal gas, U depends only on temperature: delta U = n Cv delta T.`,
      `# Second Law and Entropy

Entropy of an isolated system never decreases. Heat flows spontaneously from hot to cold, never the reverse.

Carnot efficiency — the maximum possible for a heat engine:
efficiency = 1 - Tc / Th (temperatures in kelvin)

No real engine beats Carnot; it is the upper bound set by the second law.`,
    ],
  },
  {
    title: "Data Structures — Trees",
    daysAgo: 3,
    pages: [
      `# Binary Trees and Traversals

A binary tree: each node has at most two children. Three depth-first traversals:
- In-order: left, root, right — yields sorted output for a BST
- Pre-order: root, left, right — used to copy a tree
- Post-order: left, right, root — used to delete a tree

Level-order (BFS) uses a queue instead of recursion.`,
      `# BST Search and Big-O

Search in a balanced BST is O(log n) — each comparison halves the remaining tree. Worst case (sorted insertions) degenerates to a linked list, O(n).

Self-balancing trees (AVL, red-black) rotate on insert to guarantee the log depth.

Heaps: complete binary trees with the heap property; push and pop are O(log n), peek is O(1).`,
    ],
  },
  {
    title: "Integration Techniques — Calculus",
    daysAgo: 11,
    pages: [
      `# Integration by Parts

Formula from the product rule:
integral of u dv = uv - integral of v du

Choose u by LIATE (Log, Inverse trig, Algebraic, Trig, Exponential) — whichever comes first becomes u.

Classic example: integral of x e^x dx = x e^x - e^x + C.`,
      `# Substitution and Partial Fractions

u-substitution reverses the chain rule: pick u so that du appears in the integral.

Partial fractions split a rational function into simpler pieces:
(3x+2)/(x(x+1)) = A/x + B/(x+1)

Solve for A and B by matching coefficients, then integrate each term separately. Works for any proper rational function with factorable denominator.`,
    ],
  },
  {
    title: "Chemistry — Acids & Bases",
    daysAgo: 9,
    pages: [
      `# pH and Strong Acids

pH = -log10 [H+]. Each pH unit is a 10x change in acidity.

Strong acids (HCl, HNO3) dissociate completely — [H+] equals the acid concentration. Weak acids reach equilibrium described by Ka.

For weak acids: [H+] = sqrt(Ka · C) when dissociation is small.`,
      `# Buffers and Titration

A buffer resists pH change: a weak acid plus its conjugate base (e.g. acetic acid + acetate).

Henderson-Hasselbalch: pH = pKa + log([A-]/[HA]). Maximum buffering when pH = pKa.

At the half-equivalence point of a titration, pH equals pKa — that's where the curve is flattest.`,
    ],
  },
  {
    title: "Algorithms — Sorting & Big-O",
    daysAgo: 5,
    pages: [
      `# Sorting Complexity

Merge sort: O(n log n) always, but needs O(n) extra space. Stable.
Quick sort: O(n log n) average, O(n^2) worst case (bad pivots), in-place. Not stable.
Insertion sort: O(n^2), but O(n) on nearly-sorted data — great for small arrays.

Real libraries use hybrid: insertion sort for tiny partitions, quicksort for the middle, sometimes mergesort for stability.`,
      `# Hash Tables and Collisions

Hash table: average O(1) lookup, insert, delete. Worst case O(n) if everything collides.

Collision handling: chaining (linked lists per bucket) vs open addressing (probe for the next free slot).

Good hash functions spread keys uniformly — a bad one turns the table into one long list.`,
    ],
  },
  {
    title: "Mechanics — Newton's Laws",
    daysAgo: 2,
    pages: [
      `# Newton's Second Law and Free-Body Diagrams

F = ma. Draw every force on the object separately: weight, normal, tension, friction.

On an incline of angle theta, gravity splits into mg sin(theta) along the slope and mg cos(theta) into it. Friction opposes motion: f = mu N.

Solve by applying F = ma along each axis independently.`,
      `# Work, Energy and Momentum

Work-energy theorem: net work = change in kinetic energy. Conservative forces (gravity, springs) have potential energy; friction does not.

Momentum p = mv is conserved in every collision. Elastic collisions also conserve kinetic energy; inelastic ones lose some to heat and deformation.`,
    ],
  },
  {
    title: "Signals Revision Summary",
    daysAgo: 1,
    pages: [
      `# Revision: Fourier Methods

Fourier series handles periodic signals with discrete harmonics at multiples of the fundamental frequency. Fourier transform handles aperiodic signals with a continuous spectrum.

Key link: as period T grows, the spectral lines of the series get closer together and become the continuous transform in the limit.

Convolution theorem is the bridge between LTI system analysis and frequency response H(omega).`,
      `# Exam Checklist

- Series vs transform: periodic signals get lines, aperiodic get a continuous spectrum.
- Convolution in time = multiplication in frequency — use H(omega) to find the output of any LTI system.
- The RC low-pass filter from lab is the classic example: H(omega) = 1/(1 + j omega RC), cutoff 1/(2 pi RC), -20 dB/decade roll-off.
- Gibbs overshoot near jumps: 9%, does not shrink with more terms.
- Parseval: energy is the same in both domains.`,
    ],
  },
];

app.post("/api/dev/seed", async (c) => {
  try {
    return await seedHandler(c);
  } catch (e: any) {
    console.error("seed failed:", e?.stack ?? e);
    return c.json({ ok: false, error: `${e?.name ?? "Error"}: ${String(e?.message ?? e).slice(0, 300)}` }, 500);
  }
});

async function seedHandler(c: Context<{ Bindings: Env }>) {
  const { embed } = await import("./mistral");
  const { upsertVectors, purgeAllVectors } = await import("./pipeline/vec");
  const now = Date.now();

  // idempotent: clear previous seed data (children first) + purge stale vectors
  await c.env.DB.batch([
    "DELETE FROM messages",
    "DELETE FROM chats",
    "DELETE FROM flashcards",
    "DELETE FROM quizzes",
    "DELETE FROM concept_links",
    "DELETE FROM backlinks",
    "DELETE FROM chunks",
    "DELETE FROM regions",
    "DELETE FROM pages",
    "DELETE FROM sessions",
    "DELETE FROM concepts",
  ].map((sql) => c.env.DB.prepare(sql)));
  await purgeAllVectors(c.env);

  // phase 1: insert everything + upsert all vectors
  const allVectors: { id: string; values: number[]; metadata: Record<string, unknown> }[] = [];
  const regionPlan: { pageId: string; label: string; bbox: number[] }[] = [];
  for (let si = 0; si < SEED_SESSIONS.length; si++) {
    const s = SEED_SESSIONS[si];
    const sessionId = uuid();
    const ts = now - s.daysAgo * 86400_000;
    try {
    await c.env.DB.prepare(
      "INSERT INTO sessions (id, title, created_at, page_count, status) VALUES (?1,?2,?3,?4,'ready')"
    )
      .bind(sessionId, s.title, ts, s.pages.length)
      .run();

    for (let p = 0; p < s.pages.length; p++) {
      const pageId = uuid();
      const scan = (si + p) % 2 === 0 ? "seed/scan-text.jpg" : "seed/scan-diagram.jpg";
      const conf = 0.9 + ((si + p) % 3) * 0.02;
      await c.env.DB.prepare(
        "INSERT INTO pages (id, session_id, idx, r2_key, status, markdown, avg_confidence, width, height, created_at) VALUES (?1,?2,?3,?4,'done',?5,?6,800,1000,?7)"
      )
        .bind(pageId, sessionId, p, scan, s.pages[p], conf, ts + p * 60_000)
        .run();

      // overlay regions on a few diagram/text pages so the note view shows them
      if (si === 0 && p === 0) {
        regionPlan.push(
          { pageId, label: "formula", bbox: [90, 270, 700, 390] },
          { pageId, label: "figure", bbox: [110, 680, 690, 880] }
        );
      }
      if (si === 2 && p === 1) {
        regionPlan.push({ pageId, label: "chart", bbox: [100, 220, 710, 660] });
      }

      const { chunkMarkdown } = await import("./pipeline/chunk");
      const pieces = chunkMarkdown(s.pages[p]);
      const embeddings = await embed(c.env, pieces);
      const vectors = pieces.map((_, i) => ({
        id: uuid(),
        values: embeddings[i],
        metadata: { page_id: pageId, session_id: sessionId },
      }));
      await c.env.DB.batch(
        vectors.map((v, i) =>
          c.env.DB.prepare("INSERT INTO chunks (id, page_id, idx, text) VALUES (?1,?2,?3,?4)")
            .bind(v.id, pageId, i, pieces[i])
        )
      );
      allVectors.push(...vectors);
    }
    } catch (e: any) {
      throw new Error(`phase1[${s.title}]: ${e?.message ?? e}`);
    }
  }
  await c.env.DB.batch(
    regionPlan.map((r) =>
      c.env.DB.prepare("INSERT INTO regions (id, page_id, label, bbox) VALUES (?1,?2,?3,?4)")
        .bind(uuid(), r.pageId, r.label, JSON.stringify(r.bbox))
    )
  );
  await upsertVectors(c.env, allVectors);

  // phase 2: cross-day backlinks computed in-memory (deterministic; avoids
  // Vectorize's eventual-consistency lag right after upsert). The live
  // capture pipeline links via Vectorize queries against older, settled data.
  const inserted = new Set<string>();
  for (let i = 0; i < allVectors.length; i++) {
    for (let j = i + 1; j < allVectors.length; j++) {
      const v1 = allVectors[i], v2 = allVectors[j];
      if ((v1.metadata as any).page_id === (v2.metadata as any).page_id) continue;
      const score = cosine(v1.values, v2.values);
      if (score < LINK_THRESHOLD) continue;
      const key = `${v1.id}|${v2.id}`;
      if (inserted.has(key)) continue;
      inserted.add(key);
      await c.env.DB.prepare(
        "INSERT OR IGNORE INTO backlinks (id, chunk_a, chunk_b, score, created_at) VALUES (?1,?2,?3,?4,?5)"
      )
        .bind(uuid(), v1.id < v2.id ? v1.id : v2.id, v1.id < v2.id ? v2.id : v1.id, score, now)
        .run();
    }
  }

  // seed concepts for the graph — overlapping chunk slices create co-occurrence edges
  const concepts = [
    ["Fourier Series", "math", "#7C6CFF"],
    ["Fourier Transform", "math", "#7C6CFF"],
    ["Convolution Theorem", "math", "#7C6CFF"],
    ["Gibbs Phenomenon", "math", "#7C6CFF"],
    ["Parseval's Theorem", "math", "#7C6CFF"],
    ["RC Circuits", "circuits", "#F72585"],
    ["Time Constant", "circuits", "#F72585"],
    ["Low-Pass Filter", "circuits", "#F72585"],
    ["LTI Systems", "circuits", "#F72585"],
    ["Maxwell's Equations", "physics", "#4CC9F0"],
    ["Electromagnetic Waves", "physics", "#4CC9F0"],
    ["Snell's Law", "physics", "#4CC9F0"],
    ["Entropy", "physics", "#4CC9F0"],
    ["Carnot Cycle", "physics", "#4CC9F0"],
    ["Binary Trees", "cs", "#FBBF24"],
    ["Big-O Notation", "cs", "#FBBF24"],
  ];
  const chunkRows = ((await c.env.DB.prepare("SELECT id FROM chunks LIMIT 300").all()).results ?? []) as { id: string }[];
  try {
    await c.env.DB.batch(
      concepts.map(([name, subject, color], i) =>
        c.env.DB.prepare(
          "INSERT INTO concepts (id, name, subject, color) VALUES (?1,?2,?3,?4) ON CONFLICT(name) DO NOTHING"
        ).bind(`seed-concept-${i}`, name, subject, color)
      )
    );
    const linkStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < concepts.length; i++) {
      // overlapping windows (step 2, width 6) → neighboring concepts share chunks → graph edges
      for (const row of chunkRows.slice(i * 2, i * 2 + 6)) {
        linkStmts.push(
          c.env.DB.prepare("INSERT OR IGNORE INTO concept_links (concept_id, chunk_id) VALUES (?1,?2)")
            .bind(`seed-concept-${i}`, row.id)
        );
      }
    }
    await c.env.DB.batch(linkStmts);
  } catch (e: any) {
    throw new Error(`concepts: ${e?.message ?? e}`);
  }

  const stats = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM pages) AS pages, (SELECT COUNT(*) FROM concepts) AS concepts, (SELECT COUNT(*) FROM backlinks) AS connections`
  ).first();
  return c.json({ ok: true, stats });
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/* SPA fallback: anything not matched (client-side routes like /mentor) → static assets */
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<{ pageId: string; sessionId: string; r2Key: string }>, env: Env, _ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      try {
        await processPage(env, msg.body.pageId, msg.body.sessionId, msg.body.r2Key);
        msg.ack();
      } catch (e) {
        console.error("pipeline failed", e);
        if (msg.attempts >= 3) {
          // give up: surface the error to the UI instead of spinning forever
          await env.DB.prepare("UPDATE pages SET status = 'error' WHERE id = ?1")
            .bind(msg.body.pageId)
            .run()
            .catch(() => {});
          await maybeFinalizeSession(env, msg.body.sessionId).catch(() => {});
          msg.ack();
        } else {
          msg.retry();
        }
      }
    }
  },
};
