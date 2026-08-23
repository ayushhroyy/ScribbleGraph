import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import Nav from "../components/Nav.jsx";
import { api } from "../lib.js";

export default function Ask() {
  const [params] = useSearchParams();
  const [chatId, setChatId] = useState(params.get("chat"));
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [chats, setChats] = useState([]);
  const endRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    api("/api/chats").then((d) => setChats(d.chats ?? [])).catch(() => {});
  }, [chatId]);

  useEffect(() => {
    if (!chatId) return setMessages([]);
    api(`/api/chats/${chatId}`)
      .then((d) =>
        setMessages(
          (d.messages ?? []).flatMap((m) => {
            const out = [{ role: m.role, content: m.content }];
            if (m.sources_json) {
              try {
                const src = JSON.parse(m.sources_json);
                if (src.length) out.push({ role: "sources", sources: src });
              } catch {}
            }
            return out;
          })
        )
      )
      .catch(() => {});
  }, [chatId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send() {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", content: q }]);
    setBusy(true);
    try {
      const res = await api("/api/chat", { method: "POST", body: { chatId, question: q } });
      setChatId(res.chatId);
      setMessages((m) => [...m, { role: "assistant", content: res.answer, mode: res.mode }, { role: "sources", sources: res.sources, mode: res.mode }]);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Something went wrong — check that your notes are processed, then try again.", error: true }]);
    } finally {
      setBusy(false);
    }
  }

  const starters = ["Summarize my last session", "Explain a concept from my notes", "Quiz me on definitions"];

  return (
    <div className="h-screen flex flex-col">
      <Nav />
      <main className="flex-1 flex min-h-0 max-w-6xl w-full mx-auto">
        {/* history sidebar */}
        <aside className="w-60 shrink-0 border-r border-white/[0.05] p-4 hidden md:block overflow-y-auto">
          <button onClick={() => { setChatId(null); setMessages([]); }} className="btn btn-ghost w-full !text-[13px]">
            + New chat
          </button>
          <div className="mt-4 space-y-0.5">
            {chats.map((c) => (
              <button
                key={c.id}
                onClick={() => setChatId(c.id)}
                className={`w-full text-left px-3 py-2 rounded-lg text-[13px] truncate transition-colors ${
                  chatId === c.id ? "bg-white/[0.07] text-white" : "text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.03]"
                }`}
              >
                {c.title}
              </button>
            ))}
          </div>
        </aside>

        {/* chat column */}
        <section className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto px-4 md:px-8 py-8">
            {messages.length === 0 && !busy && (
              <div className="h-full flex flex-col items-center justify-center gap-5 fade-up">
                <span className="w-14 h-14 rounded-2xl bg-[var(--accent-soft)] flex items-center justify-center">
                  <AskGlyph />
                </span>
                <div className="text-center">
                  <h2 className="text-lg font-semibold">Ask anything</h2>
                  <p className="text-zinc-500 text-[13px] mt-1">Grounded in your notes when they match — general knowledge otherwise.</p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {starters.map((st) => (
                    <button
                      key={st}
                      onClick={() => { setInput(st); inputRef.current?.focus(); }}
                      className="pill text-zinc-300 hover:border-white/25 transition-colors"
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="max-w-2xl mx-auto space-y-4">
              {messages.map((m, i) =>
                m.role === "sources" ? (
                  m.sources?.length ? <SourceChips key={i} sources={m.sources} />
                  : m.mode === "general" ? (
                    <div key={i} className="flex fade-up">
                      <span className="pill !text-[10.5px] text-zinc-400">
                        <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" /> general knowledge — not from your notes
                      </span>
                    </div>
                  ) : null
                ) : (
                  <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"} fade-up`}>
                    <div
                      className={`max-w-[85%] md:max-w-[75%] rounded-2xl px-4 py-3 text-[13.5px] leading-relaxed whitespace-pre-wrap ${
                        m.role === "user"
                          ? "bg-[#7c6cff] text-white rounded-br-md"
                          : m.error
                          ? "card !border-[#f87171]/25 text-[#fca5a5] rounded-bl-md"
                          : "card rounded-bl-md text-zinc-200"
                      }`}
                    >
                      {m.content}
                    </div>
                  </div>
                )
              )}
              {busy && (
                <div className="flex gap-1.5 items-center h-6 px-2">
                  {[0, 1, 2].map((i) => (
                    <span key={i} className="w-1.5 bg-zinc-500 rounded-full animate-bounce" style={{ height: 6 + i * 5, animationDelay: `${i * 0.15}s` }} />
                  ))}
                </div>
              )}
              <div ref={endRef} />
            </div>
          </div>

          {/* composer */}
          <div className="border-t border-white/[0.06] px-4 md:px-8 py-3.5 pb-safe bg-[#09090b]/90 backdrop-blur">
            <div className="max-w-2xl mx-auto flex gap-2">
              <input
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Ask anything…"
                className="flex-1 card !bg-[#101013] px-4 py-3 text-[13.5px]"
              />
              <button onClick={send} disabled={busy || !input.trim()} className="btn btn-primary !px-4 shrink-0">
                <SendIcon />
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function SourceChips({ sources }) {
  if (!sources?.length) return null;
  return (
    <div className="flex flex-wrap gap-2 fade-up">
      {sources.slice(0, 5).map((s, i) => (
        <div key={i} className="card !bg-[#0d0d10] px-3 py-2 max-w-[220px]">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#34d399] shrink-0" />
            <span className="text-[11.5px] font-medium text-zinc-200 truncate">{s.pageTitle}</span>
          </div>
          <div className="text-[10.5px] text-zinc-500 mt-0.5">{s.dayLabel}</div>
        </div>
      ))}
    </div>
  );
}

const AskGlyph = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#a99fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a8 8 0 0 1-8 8H4l2.5-3A8 8 0 1 1 21 12z" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.4 2.3c-.8.3-.9 1-.9 1.7" />
    <circle cx="12" cy="16.6" r="0.4" fill="#a99fff" />
  </svg>
);
const SendIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 12 20 4l-4 16-4.5-6.5L4 12z" />
  </svg>
);
