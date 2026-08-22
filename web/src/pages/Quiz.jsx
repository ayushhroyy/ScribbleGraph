import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Nav from "../components/Nav.jsx";
import { api } from "../lib.js";

export default function Quiz() {
  const [params] = useSearchParams();
  const [sessionId, setSessionId] = useState(params.get("session"));
  const [sessions, setSessions] = useState([]);
  const [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api("/api/sessions").then((d) => setSessions((d.sessions ?? []).filter((s) => s.status !== "processing"))).catch(() => {});
  }, []);

  // ?autostart=1 — used for demos/screenshots: generate immediately
  useEffect(() => {
    if (params.get("autostart") && sessionId && !quiz && !busy && !result) generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  async function generate() {
    setBusy(true);
    setResult(null);
    setAnswers({});
    setError(null);
    try {
      const q = await api("/api/quiz/generate", { method: "POST", body: { sessionId } });
      setQuiz(q);
    } catch {
      setError("Couldn't generate a quiz — make sure the session has finished processing.");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    const ordered = quiz.questions.map((_, i) => answers[i] ?? -1);
    const r = await api(`/api/quiz/${quiz.quizId}/answer`, { method: "POST", body: { answers: ordered } });
    setResult(r);
  }

  const answered = quiz?.questions?.every((_, i) => answers[i] != null);

  return (
    <Shell>
      <h1 className="text-xl md:text-2xl font-semibold tracking-tight fade-up">Quiz</h1>
      <p className="text-[13px] text-zinc-500 mt-1.5 fade-up">Generated from your own notes.</p>

      {!quiz && (
        <div className="card p-5 mt-7 max-w-md fade-up">
          <label className="text-[11px] font-semibold text-zinc-500 tracking-wider uppercase">Session</label>
          <select
            value={sessionId ?? ""}
            onChange={(e) => setSessionId(e.target.value)}
            className="w-full mt-2 card !bg-[#101013] px-3.5 py-3 text-[13.5px] appearance-none"
          >
            <option value="">Select a session…</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.title} · {s.page_count}p</option>
            ))}
          </select>
          {error && <p className="text-[12px] text-[#fca5a5] mt-3">{error}</p>}
          <button onClick={generate} disabled={!sessionId || busy} className="btn btn-primary w-full mt-4">
            {busy ? <><Spinner /> Writing questions…</> : "Generate quiz"}
          </button>
        </div>
      )}

      {quiz?.questions && (
        <div className="space-y-4 mt-7 max-w-2xl">
          {quiz.questions.map((q, qi) => (
            <div key={qi} className="card p-5 fade-up" style={{ animationDelay: `${qi * 0.04}s` }}>
              <div className="text-[14px] font-medium leading-snug">{qi + 1}. {q.question}</div>
              <div className="mt-3.5 space-y-2">
                {q.options.map((opt, oi) => {
                  const chosen = answers[qi] === oi;
                  const correct = result && oi === q.answer;
                  const wrong = result && chosen && oi !== q.answer;
                  return (
                    <button
                      key={oi}
                      onClick={() => !result && setAnswers({ ...answers, [qi]: oi })}
                      className={`w-full text-left px-4 py-2.5 rounded-xl border text-[13.5px] transition-all ${
                        correct ? "!border-[#34d399] bg-[#34d399]/10" :
                        wrong ? "!border-[#f87171] bg-[#f87171]/10" :
                        chosen ? "!border-[#7c6cff] bg-[#7c6cff]/10" : "border-white/[0.07] hover:border-white/20"
                      }`}
                    >
                      {opt}
                    </button>
                  );
                })}
              </div>
              {result && q.explanation && (
                <p className="text-[12px] text-zinc-400 mt-3.5 pt-3.5 border-t border-white/[0.06] leading-relaxed">
                  {q.explanation}
                </p>
              )}
            </div>
          ))}

          {!result ? (
            <button onClick={submit} disabled={!answered} className="btn btn-primary w-full">
              Submit answers
            </button>
          ) : (
            <div className="card p-7 text-center fade-up">
              <div className="text-4xl font-semibold mono">{result.score}<span className="text-zinc-600 text-2xl">/{result.total}</span></div>
              <p className="text-zinc-500 text-[13px] mt-2">
                {result.score === result.total ? "Perfect — you know this." : result.score >= result.total / 2 ? "Solid — review the misses." : "Worth a re-read of this session."}
              </p>
              <div className="flex gap-2 justify-center mt-5">
                <button onClick={() => setQuiz(null)} className="btn btn-ghost">New quiz</button>
                <a href="/flashcards" className="btn btn-primary">Flashcards</a>
              </div>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1 w-full max-w-3xl mx-auto px-5 md:px-6 py-8 md:py-10 pb-28 md:pb-12">{children}</main>
    </div>
  );
}
const Spinner = () => <span className="w-4 h-4 rounded-full border-2 border-white/25 border-t-white animate-spin" />;
