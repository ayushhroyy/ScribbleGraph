import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import Nav from "../components/Nav.jsx";
import { api, blip } from "../lib.js";

/* ------------------------------------------------------------------ */
/* wake word helpers (text-level, fuzzy)                               */
/* ------------------------------------------------------------------ */

function lev(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > 3) return 9;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}

function parseWake(text) {
  const words = text.toLowerCase().replace(/[^a-z\s']/g, "").split(/\s+/).filter(Boolean);
  let at = -1;
  for (let i = 0; i < Math.min(words.length, 5); i++) {
    if (lev(words[i], "scribble") <= 2 || lev(words[i], "scribbles") <= 2 || lev(words[i], "skribbl") <= 2 || lev(words[i], "scribe") <= 1) { at = i; break; }
  }
  if (at === -1) return { word: null, question: "" };
  let rest = words.slice(at + 1);
  while (rest.length && /^(hey|ok|okay|hi|yo|please|can|you|could|would)$/.test(rest[0])) rest.shift();
  return { word: words[at], question: rest.join(" ").trim() };
}

/* ------------------------------------------------------------------ */
/* fallback voice engine (MediaRecorder + Voxtral STT)                 */
/* used only when the browser has no built-in speech recognition       */
/* ------------------------------------------------------------------ */

function pickMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"]) {
    if (MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "";
}

class VoiceEngine {
  constructor({ onSilenceEnd, onLevel } = {}) {
    this.onSilenceEnd = onSilenceEnd;
    this.onLevel = onLevel;
    this.stream = null; this.ctx = null; this.analyser = null;
    this.rec = null; this.chunks = []; this.raf = null;
    this.spoke = false; this.lastLoud = 0; this.stopped = false;
  }

  async start() {
    this.stopped = false;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);

    const mime = pickMime();
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.chunks = [];
    this.spoke = false;
    this.lastLoud = performance.now();
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);

    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    const THRESH = 14;
    const loop = () => {
      if (this.stopped) return;
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      const level = Math.sqrt(sum / buf.length) * 128;
      this.onLevel?.(level);
      const now = performance.now();
      if (level > THRESH) {
        this.lastLoud = now;
        this.spoke = true;
      } else if (this.spoke && now - this.lastLoud > 1400) {
        this.stop();
        this.onSilenceEnd?.();
        return;
      }
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  async stop() {
    if (this.stopped) return null;
    this.stopped = true;
    cancelAnimationFrame(this.raf);
    const rec = this.rec;
    const done = new Promise((resolve) => {
      if (!rec || rec.state === "inactive") return resolve(new Blob(this.chunks, { type: rec?.mimeType || "audio/webm" }));
      rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType || "audio/webm" }));
      rec.stop();
    });
    const blob = await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    return blob;
  }
}

async function stt(blob) {
  const fd = new FormData();
  fd.append("audio", blob, "q.webm");
  const { text } = await api("/api/mentor/transcribe", { method: "POST", body: fd });
  return (text ?? "").trim();
}

/* ------------------------------------------------------------------ */

const IDLE = "idle", RECORDING = "recording", THINKING = "thinking", SPEAKING = "speaking", HOT = "hot";
const SR = typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition);

export default function Mentor() {
  const [phase, setPhase] = useState(IDLE);
  const [callLive, setCallLive] = useState(false);
  const [callSecs, setCallSecs] = useState(0);
  const [messages, setMessages] = useState([]);
  const [chatId, setChatId] = useState(null);
  const [level, setLevel] = useState(0);
  const [handsFree, setHandsFree] = useState(true);   // auto-listen after answers
  const [wakeMode, setWakeMode] = useState(false);    // must say "Scribble" first
  const [voiceOn, setVoiceOn] = useState(true);
  const [text, setText] = useState("");
  const [panel, setPanel] = useState(null);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState(null);

  const engineRef = useRef(null);       // fallback VoiceEngine
  const recogRef = useRef(null);        // SpeechRecognition
  const wantListenRef = useRef(false);  // should be listening when idle
  const wakeRef = useRef(false);
  const armedRef = useRef(false);       // wake word heard, awaiting question
  const bypassRef = useRef(false);      // next utterance skips wake gate (manual)
  const busyRef = useRef(false);        // thinking/speaking
  const audioRef = useRef(null);        // HTMLAudio fallback
  const audioCtxRef = useRef(null);     // unlocked WebAudio context
  const ttsSrcRef = useRef(null);       // playing TTS source node
  const endRef = useRef(null);

  const [armedUI, setArmedUI] = useState(false);
  const callLiveRef = useRef(false);
  const handsFreeRef = useRef(handsFree);
  useEffect(() => { handsFreeRef.current = handsFree; }, [handsFree]);
  useEffect(() => { wakeRef.current = wakeMode; if (!wakeMode) { armedRef.current = false; setArmedUI(false); } }, [wakeMode]);

  /* watchdog: if the call wants the mic but nothing is running (SR died,
     start() threw, a turn finished without resuming) — restart it. This is
     the safety net that guarantees the mic always comes back on. */
  useEffect(() => {
    if (!callLive) return;
    const t = setInterval(() => {
      if (!callLiveRef.current || !wantListenRef.current || busyRef.current) return;
      if (recogRef.current || engineRef.current) return;
      if (SR) startSR();
      else startFallbackRef.current?.();
    }, 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callLive]);

  useEffect(() => {
    if (!callLive) return;
    const t = setInterval(() => setCallSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [callLive]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interim]);

  const mmss = `${String(Math.floor(callSecs / 60)).padStart(2, "0")}:${String(callSecs % 60).padStart(2, "0")}`;

  /* ---------------- asking + speaking ---------------- */

  const askMentor = useCallback(async (question) => {
    if (!question.trim() || busyRef.current) return;
    busyRef.current = true;
    setInterim("");
    setMessages((m) => [...m, { role: "user", content: question }]);
    setPhase(THINKING);
    try {
      const res = await api("/api/chat", { method: "POST", body: { chatId, question } });
      setChatId(res.chatId);
      setMessages((m) => [...m, { role: "assistant", content: res.answer, sources: res.sources, mode: res.mode }]);
      await speak(res.answer);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Sorry — something broke on that one. Try again.", error: true }]);
      setPhase(IDLE);
    } finally {
      busyRef.current = false;
      // resume listening if hands-free
      if (wantListenRef.current && !busyRef.current) ensureListening();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, voiceOn, handsFree]);

  /* ---- audio playback: WebAudio (unlocked on the Start-call tap) with
          HTMLAudio fallback — plain <audio>.play() silently fails ~half the
          time on mobile without a gesture-locked context ---- */

  function unlockAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        const ctx = new Ctx();
        // silent blip inside the user gesture unlocks output on iOS/Android
        const b = ctx.createBuffer(1, 1, 22050);
        const s = ctx.createBufferSource();
        s.buffer = b;
        s.connect(ctx.destination);
        s.start(0);
        audioCtxRef.current = ctx;
      }
      audioCtxRef.current.resume?.().catch(() => {});
      return audioCtxRef.current;
    } catch {
      return null;
    }
  }

  function stopTTS() {
    try { ttsSrcRef.current?.stop(); } catch {}
    ttsSrcRef.current = null;
    audioRef.current?.pause();
  }

  async function fetchTTS(text) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("/api/mentor/speak", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (res.ok) return await res.blob();
        lastErr = new Error(`tts ${res.status}`);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr ?? new Error("tts failed");
  }

  function playBlob(blob) {
    return new Promise(async (resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };

      // path 1: WebAudio (most reliable once unlocked)
      try {
        const ctx = unlockAudio();
        if (ctx) {
          const arr = await blob.arrayBuffer();
          const audio = await ctx.decodeAudioData(arr.slice(0));
          stopTTS();
          const src = ctx.createBufferSource();
          src.buffer = audio;
          src.connect(ctx.destination);
          src.onended = done;
          ttsSrcRef.current = src;
          src.start();
          setTimeout(done, (audio.duration + 3) * 1000); // safety net
          return;
        }
      } catch {}

      // path 2: HTMLAudio fallback
      try {
        const url = URL.createObjectURL(blob);
        const a = new Audio(url);
        audioRef.current = a;
        a.onended = () => { URL.revokeObjectURL(url); done(); };
        a.onerror = () => { URL.revokeObjectURL(url); done(); };
        a.play().catch(() => { URL.revokeObjectURL(url); done(); });
        setTimeout(done, 120_000);
      } catch {
        done();
      }
    });
  }

  async function speak(answerText) {
    if (!voiceOn) return;
    setPhase(SPEAKING);
    // pause the mic while we talk so recognition doesn't hear the answer
    try { recogRef.current?.stop(); } catch {}
    recogRef.current = null;
    try {
      const blob = await fetchTTS(answerText);
      await playBlob(blob);
    } catch {
      setError("Voice failed — showing the answer instead.");
      setTimeout(() => setError(null), 4000);
    } finally {
      stopTTS();
    }
    setPhase(wakeRef.current ? HOT : IDLE);
  }

  /* ---------------- utterance routing ---------------- */

  function routeUtterance(said) {
    if (!said) return;
    const direct = bypassRef.current;
    bypassRef.current = false;

    if (!wakeRef.current || direct) {
      askMentor(said);
      return;
    }
    if (armedRef.current) {
      armedRef.current = false;
      setArmedUI(false);
      askMentor(said);
      return;
    }
    const { word, question } = parseWake(said);
    if (!word) return; // wake mode on, no wake word → ignore completely
    if (question && question.split(/\s+/).length >= 2) {
      askMentor(question);
      return;
    }
    armedRef.current = true; // just the word → arm for the question
    setArmedUI(true);
    blip(1240);
    setPhase(HOT);
  }

  /* ---------------- primary: browser SpeechRecognition ---------------- */

  function startSR() {
    if (recogRef.current) return;
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new R();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (e) => {
      if (busyRef.current) return;
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interimText += r[0].transcript;
      }
      if (interimText && !finalText) {
        setInterim(interimText);
        setPhase(RECORDING);
        // live wake detection: word heard mid-speech → show armed immediately
        if (wakeRef.current && !armedRef.current && !bypassRef.current && parseWake(interimText).word) {
          armedRef.current = true;
          setArmedUI(true);
          blip(1240);
        }
      }
      if (finalText.trim()) routeUtterance(finalText.trim());
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setError("Mic blocked — allow microphone access and try again.");
        wantListenRef.current = false;
      }
    };
    rec.onend = () => {
      recogRef.current = null;
      // Chrome stops after silence — restart while the call wants a mic
      if (wantListenRef.current && !busyRef.current) setTimeout(() => { if (wantListenRef.current && !recogRef.current) startSR(); }, 300);
    };

    try {
      rec.start();
      recogRef.current = rec;
      setPhase(wakeRef.current ? HOT : RECORDING);
    } catch {
      recogRef.current = null;
      // start() can throw InvalidStateError if the previous instance is still
      // shutting down — retry shortly instead of leaving the mic dead
      setTimeout(() => { if (wantListenRef.current && !busyRef.current && !recogRef.current) startSR(); }, 500);
    }
  }

  function stopSR() {
    wantListenRef.current = false;
    try { recogRef.current?.stop(); } catch {}
    recogRef.current = null;
    setInterim("");
    setPhase(IDLE);
  }

  /* ---------------- fallback: Voxtral loop ---------------- */

  const startFallback = useCallback(() => {
    if (engineRef.current || busyRef.current) return;
    const eng = new VoiceEngine({
      onLevel: (l) => setLevel(l),
      onSilenceEnd: async () => {
        const blob = await eng.stop();
        engineRef.current = null;
        setLevel(0);
        if (!blob || blob.size < 3000) {
          if (wantListenRef.current) startFallback();
          else setPhase(IDLE);
          return;
        }
        setPhase(THINKING);
        setInterim("…");
        try {
          const said = await stt(blob);
          setInterim(said);
          routeUtterance(said);
        } catch {
          setError("Couldn't hear that — try again.");
          setPhase(wakeRef.current ? HOT : IDLE);
        }
        // re-arm loop after routing (askMentor resumes listening itself)
        if (!busyRef.current && wantListenRef.current) setTimeout(() => { if (wantListenRef.current && !engineRef.current && !busyRef.current) startFallback(); }, 400);
      },
    });
    engineRef.current = eng;
    setPhase(wakeRef.current ? HOT : RECORDING);
    eng.start().catch((e) => {
      engineRef.current = null;
      setError(e?.message ?? "Mic unavailable — check permissions.");
      wantListenRef.current = false;
      setPhase(IDLE);
    });
  }, []);

  const startFallbackRef = useRef(null);
  startFallbackRef.current = startFallback;

  function ensureListening() {
    if (!callLiveRef.current || busyRef.current) return;
    wantListenRef.current = handsFreeRef.current || wakeRef.current ? true : wantListenRef.current;
    if (!wantListenRef.current) return;
    if (SR) startSR();
    else startFallbackRef.current?.();
  }

  /* ---------------- call controls ---------------- */

  function startCall() {
    unlockAudio(); // inside the user gesture — unlocks TTS output for the call
    callLiveRef.current = true;
    setCallLive(true);
    setCallSecs(0);
    setMessages([]);
    setChatId(null);
    setError(null);
    wantListenRef.current = true;
    setTimeout(() => { if (SR) startSR(); else startFallback(); }, 200);
  }

  function endCall() {
    wantListenRef.current = false;
    callLiveRef.current = false;
    stopSR();
    engineRef.current?.stop();
    engineRef.current = null;
    stopTTS();
    bypassRef.current = false;
    armedRef.current = false;
    setArmedUI(false);
    setCallLive(false);
    setPhase(IDLE);
    setLevel(0);
    setInterim("");
  }

  function micTap() {
    if (busyRef.current) return;
    if (!SR && engineRef.current) return; // fallback: silence-end handles send
    if (recogRef.current && !wakeRef.current) {
      // listening in plain mode → pause
      stopSR();
      return;
    }
    // start listening now; next utterance bypasses the wake gate
    wantListenRef.current = true;
    bypassRef.current = true;
    if (!recogRef.current) startSR();
    setPhase(RECORDING);
  }

  function send() {
    const q = text.trim();
    if (!q || busyRef.current) return;
    setText("");
    askMentor(q);
  }

  /* ---------------- render ---------------- */

  const listeningNow = SR ? !!recogRef.current : !!engineRef.current;

  return (
    <div className="h-screen flex flex-col">
      <Nav />
      <main className="flex-1 flex min-h-0 max-w-7xl w-full mx-auto">
        <section className={`flex-1 flex flex-col min-w-0 ${panel ? "hidden lg:flex" : "flex"}`}>
          {!callLive ? (
            <StartScreen onStart={startCall} sr={!!SR} />
          ) : (
            <>
              <div className="pt-6 pb-4 flex flex-col items-center gap-3 shrink-0">
                <Orb phase={phase} level={level} armed={armedUI} />
                <div className="pill mono text-white/70">{mmss}</div>
                <div className="text-[13px] text-zinc-400 h-5 text-center px-6">
                  {phase === THINKING ? (interim && interim !== "…" ? `“${interim}”` : "Thinking…")
                  : phase === SPEAKING ? "Speaking…"
                  : armedUI ? "Listening — ask your question"
                  : wakeMode ? (SR ? 'Say "Scribble" then your question' : 'Say "Scribble" then your question')
                  : listeningNow ? (interim ? `“${interim}”` : "Listening — just talk, it sends when you pause")
                  : handsFree ? "Starting mic…"
                  : "Tap the mic"}
                </div>
                {error && <div className="text-[12px] text-[#fca5a5]">{error}</div>}
              </div>

              <div className="flex-1 overflow-y-auto px-5 md:px-8 min-h-0">
                <div className="max-w-2xl mx-auto space-y-3">
                  {messages.length === 0 && (
                    <div className="text-center text-zinc-600 text-[13px] pt-6">
                      Ask anything from your notes — try “quiz me on acids and bases”
                    </div>
                  )}
                  {messages.map((m, i) =>
                    m.role === "user" ? (
                      <div key={i} className="flex justify-end">
                        <div className="max-w-[80%] rounded-2xl rounded-br-md bg-[#7c6cff] text-white px-4 py-2.5 text-[13.5px]">{m.content}</div>
                      </div>
                    ) : (
                      <div key={i} className="space-y-2">
                        <div className={`card rounded-bl-md px-4 py-3 text-[13.5px] leading-relaxed whitespace-pre-wrap ${m.error ? "!border-[#f87171]/25 text-[#fca5a5]" : ""}`}>
                          {m.content}
                        </div>
                        {m.sources?.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {m.sources.map((s, k) => (
                              <span key={k} className="pill !text-[10.5px] text-zinc-300">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#34d399]" />{s.pageTitle} · {s.dayLabel}
                              </span>
                            ))}
                          </div>
                        ) : m.mode === "general" ? (
                          <span className="pill !text-[10px] text-zinc-500">
                            <span className="w-1.5 h-1.5 rounded-full bg-zinc-600" /> general knowledge — not from your notes
                          </span>
                        ) : null}
                      </div>
                    )
                  )}
                  <div ref={endRef} />
                </div>
              </div>

              <div className="border-t border-white/[0.06] px-5 md:px-8 py-3 pb-safe">
                <div className="max-w-2xl mx-auto">
                  <div className="flex items-center gap-2">
                    <input
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && send()}
                      placeholder="…or type instead"
                      className="flex-1 card !bg-[#101013] px-4 py-2.5 text-[13px]"
                    />
                    <button
                      onClick={micTap}
                      disabled={phase === THINKING || phase === SPEAKING}
                      className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-all disabled:opacity-40 ${
                        listeningNow && !wakeMode ? "bg-[#f87171]" : "bg-[#7c6cff]"
                      }`}
                      title={listeningNow && !wakeMode ? "Pause mic" : "Talk now (skips wake word)"}
                    >
                      <MicIcon />
                    </button>
                    <button onClick={() => setVoiceOn(!voiceOn)} className={`w-11 h-11 rounded-full border flex items-center justify-center shrink-0 ${voiceOn ? "border-white/15 text-white/80" : "border-white/10 text-zinc-600"}`} title="Mentor voice on/off">
                      {voiceOn ? <SpeakerIcon /> : <SpeakerOffIcon />}
                    </button>
                    <button onClick={endCall} className="w-11 h-11 rounded-full bg-[#f87171]/90 flex items-center justify-center shrink-0" title="End call">
                      <PhoneDownIcon />
                    </button>
                  </div>
                  <div className="flex items-center justify-between mt-2.5 px-1">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setWakeMode(!wakeMode)}
                        className={`pill !text-[10.5px] transition-colors ${wakeMode ? "!border-[#7c6cff]/60 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
                        title='Only listens after it hears "Scribble"'
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${wakeMode ? "bg-[#7c6cff] animate-pulse" : "bg-zinc-600"}`} />
                        wake "Scribble"
                      </button>
                      {!wakeMode && (
                        <label className="flex items-center gap-2 text-[11.5px] text-zinc-500 cursor-pointer select-none">
                          <input type="checkbox" checked={handsFree} onChange={(e) => setHandsFree(e.target.checked)} className="accent-[#7c6cff]" />
                          hands-free
                        </label>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      {["notes", "quiz", "cards"].map((p) => (
                        <button key={p} onClick={() => setPanel(panel === p ? null : p)} className={`pill !text-[10.5px] ${panel === p ? "!border-[#7c6cff]/60 text-white" : "text-zinc-400"}`}>
                          {p === "notes" ? "📝 notes" : p === "quiz" ? "🧩 quiz" : "🃏 cards"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>

        {panel && (
          <aside className="w-full lg:w-[400px] shrink-0 border-l border-white/[0.06] overflow-y-auto p-4 fade-up">
            {panel === "notes" && <NotesPanel />}
            {panel === "quiz" && <QuizPanel />}
            {panel === "cards" && <CardsPanel />}
          </aside>
        )}
        {!panel && (
          <aside className="hidden lg:flex w-[190px] shrink-0 border-l border-white/[0.06] p-4 flex-col gap-2">
            <p className="text-[10px] uppercase tracking-widest text-zinc-600 font-semibold px-1">Open during call</p>
            {[["notes", "📝 Notes"], ["quiz", "🧩 Quiz"], ["cards", "🃏 Flashcards"]].map(([p, label]) => (
              <button key={p} onClick={() => setPanel(p)} className="btn btn-ghost !justify-start !text-[13px]">{label}</button>
            ))}
            <Link to="/ask" className="btn btn-ghost !justify-start !text-[13px] mt-auto">💬 Full chat history →</Link>
          </aside>
        )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StartScreen({ onStart, sr }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6 fade-up">
      <Orb phase="idle" level={0} />
      <div className="text-center">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Study with your mentor</h1>
        <p className="text-zinc-500 text-[13.5px] mt-2 max-w-sm leading-relaxed">
          A hands-free voice call with your notes. Just talk — it sends when you pause, then answers out loud. Turn on the wake word to say “Scribble…” first.
        </p>
      </div>
      <button onClick={onStart} className="btn btn-primary !rounded-full !px-8 !py-3.5 text-base">
        📞 Start call
      </button>
      <p className="text-[11px] text-zinc-600">
        mic permission required · {sr ? "live speech recognition" : "voice via Mistral Voxtral"}
      </p>
    </div>
  );
}

function Orb({ phase, level, big, armed }) {
  const size = big ? 120 : 84;
  const scale = phase === RECORDING ? 1 + Math.min(level / 120, 0.35) : 1;
  const color =
    phase === SPEAKING ? "#4CC9F0" :
    phase === THINKING ? "#FBBF24" :
    phase === RECORDING || phase === HOT ? (armed ? "#34d399" : "#7c6cff") :
    "#52525b";
  return (
    <div className="relative flex items-center justify-center" style={{ width: size * 1.9, height: size * 1.9 }}>
      <div className="absolute rounded-full transition-all duration-150" style={{ width: size * scale, height: size * scale, background: `radial-gradient(circle at 35% 30%, ${color}, ${color}44 60%, transparent 75%)`, filter: `blur(${phase === IDLE ? 14 : 8}px)` }} />
      <div className="absolute rounded-full border" style={{ width: size * 1.35, height: size * 1.35, borderColor: `${color}33` }} />
      {(phase === RECORDING || phase === SPEAKING) && (
        <div className="absolute rounded-full border animate-ping" style={{ width: size * 1.35, height: size * 1.35, borderColor: `${color}44` }} />
      )}
      <div className="relative rounded-full flex items-center justify-center transition-colors" style={{ width: size * 0.52, height: size * 0.52, background: color }}>
        <svg width={size * 0.26} height={size * 0.26} viewBox="0 0 24 24" fill="none" stroke="#09090b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2a4 4 0 0 1 4 4v5a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z" />
          <path d="M5 10v1a7 7 0 0 0 14 0v-1M12 19v3" />
        </svg>
      </div>
    </div>
  );
}

/* ---------------- inline panels ---------------- */

function NotesPanel() {
  const [sessions, setSessions] = useState(null);
  const [pages, setPages] = useState(null);
  const [note, setNote] = useState(null);
  useEffect(() => { api("/api/sessions").then((d) => setSessions(d.sessions ?? [])).catch(() => setSessions([])); }, []);
  async function openSession(id) { setPages(null); setNote(null); setPages((await api(`/api/sessions/${id}`)).pages ?? []); }
  async function openPage(id) { setNote(await api(`/api/pages/${id}`)); }
  return (
    <div className="space-y-2">
      <PanelTitle label="Notes" onBack={note ? () => setNote(null) : pages ? () => setPages(null) : null} />
      {note ? (
        <div className="space-y-3">
          <div className="text-[12px] font-medium truncate">{note.page.session_title} · p.{note.page.idx + 1}</div>
          <img src={`/media/${note.page.r2_key}`} alt="" className="w-full rounded-xl border border-white/10" />
          <div className="card p-3 mono text-[11.5px] leading-relaxed text-zinc-300 whitespace-pre-wrap max-h-72 overflow-auto">{note.page.markdown}</div>
        </div>
      ) : pages ? (
        <div className="grid grid-cols-3 gap-2">
          {pages.map((p) => (
            <button key={p.id} onClick={() => openPage(p.id)} className="card card-hover overflow-hidden">
              <img src={`/media/${p.r2_key}`} alt="" className="w-full aspect-[3/4] object-cover" />
              <div className="text-[10px] py-1.5 text-zinc-400">p.{p.idx + 1}</div>
            </button>
          ))}
        </div>
      ) : sessions === null ? (
        <div className="card skeleton h-40" />
      ) : (
        <div className="space-y-1.5">
          {sessions.map((s) => (
            <button key={s.id} onClick={() => openSession(s.id)} className="card card-hover w-full text-left px-3.5 py-2.5">
              <div className="text-[13px] font-medium truncate">{s.title ?? "Processing…"}</div>
              <div className="text-[10.5px] text-zinc-500">{s.page_count} pages</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function QuizPanel() {
  const [sessions, setSessions] = useState(null);
  const [quiz, setQuiz] = useState(null);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api("/api/sessions").then((d) => setSessions((d.sessions ?? []).filter((s) => s.status !== "processing"))).catch(() => setSessions([])); }, []);
  async function gen(sid) {
    setBusy(true);
    try { const q = await api("/api/quiz/generate", { method: "POST", body: { sessionId: sid } }); setQuiz(q); setResult(null); setAnswers({}); } catch {}
    setBusy(false);
  }
  return (
    <div className="space-y-2">
      <PanelTitle label="Quiz" onBack={quiz ? () => setQuiz(null) : null} />
      {!quiz ? (
        <div className="space-y-1.5">
          {sessions === null ? <div className="card skeleton h-40" /> :
            sessions.map((s) => (
              <button key={s.id} onClick={() => gen(s.id)} disabled={busy} className="card card-hover w-full text-left px-3.5 py-2.5">
                <div className="text-[13px] font-medium truncate">{s.title}</div>
                <div className="text-[10.5px] text-zinc-500">{busy ? "generating…" : `${s.page_count} pages`}</div>
              </button>
            ))}
        </div>
      ) : (
        <div className="space-y-3">
          {quiz.questions.map((q, qi) => (
            <div key={qi} className="card p-3">
              <div className="text-[12.5px] font-medium">{qi + 1}. {q.question}</div>
              <div className="mt-2 space-y-1.5">
                {q.options.map((o, oi) => {
                  const chosen = answers[qi] === oi;
                  const correct = result && oi === q.answer;
                  const wrong = result && chosen && oi !== q.answer;
                  return (
                    <button key={oi} onClick={() => !result && setAnswers({ ...answers, [qi]: oi })}
                      className={`w-full text-left px-3 py-2 rounded-lg border text-[12px] ${correct ? "!border-[#34d399] bg-[#34d399]/10" : wrong ? "!border-[#f87171] bg-[#f87171]/10" : chosen ? "!border-[#7c6cff]" : "border-white/[0.07]"}`}>
                      {o}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {!result ? (
            <button
              onClick={async () => {
                const r = await api(`/api/quiz/${quiz.quizId}/answer`, { method: "POST", body: { answers: quiz.questions.map((_, i) => answers[i] ?? -1) } });
                setResult(r);
              }}
              disabled={quiz.questions.some((_, i) => answers[i] == null)}
              className="btn btn-primary w-full !py-2.5 !text-[13px] disabled:opacity-40">
              Submit
            </button>
          ) : (
            <div className="card p-4 text-center">
              <div className="text-2xl font-bold mono">{result.score}/{result.total}</div>
              <button onClick={() => setQuiz(null)} className="btn btn-ghost w-full mt-3 !py-2 !text-xs">New quiz</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CardsPanel() {
  const [cards, setCards] = useState(null);
  const [i, setI] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [tally, setTally] = useState({ done: 0, correct: 0 });
  useEffect(() => { api("/api/flashcards/due").then((d) => setCards(d.cards ?? [])).catch(() => setCards([])); }, []);
  async function grade(correct) {
    const card = cards[i];
    setTally((t) => ({ done: t.done + 1, correct: t.correct + (correct ? 1 : 0) }));
    api(`/api/flashcards/${card.id}/review`, { method: "POST", body: { correct } }).catch(() => {});
    if (i + 1 < cards.length) { setI(i + 1); setFlipped(false); } else setCards([]);
  }
  return (
    <div className="space-y-2">
      <PanelTitle label="Flashcards" />
      {cards === null ? <div className="card skeleton h-40" /> : !cards[i] ? (
        <div className="card p-6 text-center text-zinc-500 text-[13px]">
          {tally.done ? `${tally.correct}/${tally.done} correct — done for now` : "No cards due"}
        </div>
      ) : (
        <>
          <div className="text-[10.5px] text-zinc-500 mono px-1">{i + 1}/{cards.length}</div>
          <button onClick={() => setFlipped(!flipped)} className="card card-hover w-full min-h-44 flex items-center justify-center p-5 text-center">
            <span className={flipped ? "text-[12px] text-zinc-300" : "text-[14px] font-medium"}>
              {flipped ? cards[i].back : cards[i].front}
            </span>
          </button>
          {flipped && (
            <div className="flex gap-2 fade-up">
              <button onClick={() => grade(false)} className="btn btn-ghost flex-1 !py-2 !text-xs">Missed</button>
              <button onClick={() => grade(true)} className="btn btn-primary flex-1 !py-2 !text-xs">Knew it</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function PanelTitle({ label, onBack }) {
  return (
    <div className="flex items-center justify-between px-1 pb-1">
      <span className="text-[11px] font-semibold text-zinc-400 tracking-wider uppercase">{label}</span>
      {onBack && <button onClick={onBack} className="text-[11px] text-zinc-500 hover:text-white">← back</button>}
    </div>
  );
}

const MicIcon = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a4 4 0 0 1 4 4v5a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z" /><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 19v3" />
  </svg>
);
const PhoneDownIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91" />
    <line x1="23" y1="1" x2="1" y2="23" />
  </svg>
);
const SpeakerIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /></svg>
);
const SpeakerOffIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="m22 9-6 6M16 9l6 6" /></svg>
);
