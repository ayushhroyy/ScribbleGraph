import { useEffect, useState } from "react";
import Nav from "../components/Nav.jsx";
import { api } from "../lib.js";

export default function Flashcards() {
  const [cards, setCards] = useState(null);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [session, setSession] = useState({ done: 0, correct: 0 });
  const [genSession, setGenSession] = useState("");
  const [sessions, setSessions] = useState([]);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    load();
    api("/api/sessions").then((d) => setSessions((d.sessions ?? []).filter((s) => s.status !== "processing"))).catch(() => {});
  }, []);

  async function generate() {
    if (!genSession) return;
    setGenerating(true);
    try {
      await api("/api/flashcards/generate", { method: "POST", body: { sessionId: genSession } });
      await load();
    } finally {
      setGenerating(false);
    }
  }

  async function load() {
    setCards(null);
    const d = await api("/api/flashcards/due").catch(() => ({ cards: [] }));
    setCards(d.cards ?? []);
    setI(0);
    setFlipped(false);
    setSession({ done: 0, correct: 0 });
  }

  async function grade(correct) {
    const card = cards[i];
    setSession((r) => ({ done: r.done + 1, correct: r.correct + (correct ? 1 : 0) }));
    api(`/api/flashcards/${card.id}/review`, { method: "POST", body: { correct } }).catch(() => {});
    if (i + 1 < cards.length) {
      setI(i + 1);
      setFlipped(false);
    } else {
      setCards([]);
    }
  }

  const card = cards?.[i];

  return (
    <Shell>
      <div className="flex items-center justify-between fade-up">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Flashcards</h1>
          <p className="text-[13px] text-zinc-500 mt-1.5">Spaced repetition from your notes.</p>
        </div>
        <button onClick={load} className="btn btn-ghost !py-2 !px-3.5 text-[13px]">Refresh</button>
      </div>

      {cards === null ? (
        <div className="card skeleton h-64 mt-7" />
      ) : !card ? (
        <div className="card py-16 px-6 mt-7 flex flex-col items-center gap-3 fade-up">
          {session.done > 0 ? (
            <>
              <div className="text-4xl">{session.correct === session.done ? "🎉" : "👍"}</div>
              <p className="text-sm font-medium">Session complete</p>
              <p className="text-[13px] text-zinc-500 mono">{session.correct}/{session.done} correct</p>
            </>
          ) : (
            <>
              <span className="w-12 h-12 rounded-2xl bg-white/[0.04] flex items-center justify-center text-zinc-600"><CardsGlyph /></span>
              <p className="text-sm text-zinc-400">No cards due right now</p>
              <div className="flex flex-col sm:flex-row gap-2 w-full max-w-sm mt-2">
                <select
                  value={genSession}
                  onChange={(e) => setGenSession(e.target.value)}
                  className="card !bg-[#101013] px-3.5 py-2.5 text-[13px] appearance-none flex-1"
                >
                  <option value="">Generate from session…</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>{s.title} · {s.page_count}p</option>
                  ))}
                </select>
                <button onClick={generate} disabled={!genSession || generating} className="btn btn-primary !py-2.5 shrink-0">
                  {generating ? <Spinner /> : "Generate"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-3 mt-7 fade-up">
            <span className="mono text-[11px] text-zinc-500">{i + 1} / {cards.length}</span>
            <div className="flex-1 h-0.5 rounded-full bg-white/[0.06] overflow-hidden">
              <div className="h-full bg-[#7c6cff] transition-all duration-500" style={{ width: `${((i + 1) / cards.length) * 100}%` }} />
            </div>
            <span className="pill !text-[10px] mono">box {card.leitner_box}</span>
          </div>

          <button
            onClick={() => setFlipped(!flipped)}
            className="card card-hover w-full min-h-64 md:min-h-72 mt-3 flex items-center justify-center p-8 text-center fade-up"
          >
            <div>
              <div className={flipped ? "text-[14px] text-zinc-300 leading-relaxed whitespace-pre-wrap" : "text-lg md:text-xl font-medium leading-snug"}>
                {flipped ? card.back : card.front}
              </div>
              {!flipped && (
                <div className="text-[10px] text-zinc-600 mt-8 uppercase tracking-[0.2em]">tap to flip</div>
              )}
            </div>
          </button>

          {flipped && (
            <div className="flex gap-2.5 mt-4 fade-up">
              <button onClick={() => grade(false)} className="btn btn-ghost flex-1 !py-3">Missed it</button>
              <button onClick={() => grade(true)} className="btn btn-primary flex-1 !py-3">Knew it</button>
            </div>
          )}
        </>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1 w-full max-w-xl mx-auto px-5 md:px-6 py-8 md:py-10 pb-28 md:pb-12">{children}</main>
    </div>
  );
}
const CardsGlyph = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="7" width="14" height="12" rx="2.5" /><path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4H19a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2" />
  </svg>
);
const Spinner = () => <span className="w-4 h-4 rounded-full border-2 border-white/25 border-t-white animate-spin" />;
