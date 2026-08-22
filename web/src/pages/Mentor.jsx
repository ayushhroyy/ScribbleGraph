import { useEffect, useRef, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import Nav from "../components/Nav.jsx";
import { api, blip } from "../lib.js";
import { enrollFromBlobs, isWakeWord, saveWake, loadWake } from "../wake.js";

/* ------------------------------------------------------------------ */
/* voice engine: MediaRecorder + AnalyserNode silence detection        */
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
      this.onSpeech = onSpeech;
    this.stream = null;
    this.ctx = null;
    this.analyser = null;
    this.rec = null;
    this.chunks = [];
    this.raf = null;
    this.spoke = false;
    this.lastLoud = 0;
    this.lastQuiet = 0;
    this.stopped = false;
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
    this.lastLoud = 0;
    this.lastQuiet = performance.now();
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);

    const buf = new Uint8Array(this.analyser.frequencyBinCount);
    const THRESH = 14; // rms-ish amplitude out of 128
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
        if (!this.spoke) this.onSpeech?.();
        this.lastLoud = now;
        this.spoke = true;
      } else if (this.spoke && now - this.lastLoud > 1400) {
        this.stop(); // silence after speech → end of question
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

/* ------------------------------------------------------------------ */

const IDLE = "idle", THINKING = "thinking", SPEAKING = "speaking", RECORDING = "recording", HOT = "hot";

/* ---- wake word: fuzzy "scribble" match + question extraction ---- */
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
  for (let i = 0; i < Math.min(words.length, 4); i++) {
    if (lev(words[i], "scribble") <= 2 || lev(words[i], "scribbles") <= 2 || lev(words[i], "skribbl") <= 2) { at = i; break; }
  }
  if (at === -1) return { word: null, question: "" };
  let rest = words.slice(at + 1);
  while (rest.length && /^(hey|ok|okay|hi|yo|please|can|you|could|would)$/.test(rest[0])) rest.shift();
  return { word: words[at], question: rest.join(" ").trim() };
}

export default function Mentor() {
  const [phase, setPhase] = useState(IDLE); // call orb state
  const [callLive, setCallLive] = useState(false);
  const [callSecs, setCallSecs] = useState(0);
  const [messages, setMessages] = useState([]);
  const [chatId, setChatId] = useState(null);
  const [level, setLevel] = useState(0);
  const [autoListen, setAutoListen] = useState(true);
  const [voiceOn, setVoiceOn] = useState(true);
  const [wakeMode, setWakeMode] = useState(false);
  const [armed, setArmed] = useState(false); // wake word said, awaiting question
  const [wakeData, setWakeData] = useState(null); // enrolled on-device templates
  const [enrollStep, setEnrollStep] = useState(0); // 0 = off, 1..3 = teaching samples
  const [text, setText] = useState("");
  const [panel, setPanel] = useState(null); // notes | quiz | cards
  const [interim, setInterim] = useState("");
  const [error, setError] = useState(null);

  const engineRef = useRef(null);
  const audioRef = useRef(null);
  const busyRef = useRef(false);
  const endRef = useRef(null);
  const autoListenRef = useRef(autoListen);
  const startListeningRef = useRef(null);
  const wakeRef = useRef(false);
  const armedRef = useRef(false);
  const wakeDataRef = useRef(null);
  const enrollStepRef = useRef(0);
  const enrollBlobsRef = useRef([]);
  useEffect(() => { autoListenRef.current = autoListen; }, [autoListen]);
  useEffect(() => { wakeDataRef.current = wakeData; }, [wakeData]);
  useEffect(() => { enrollStepRef.current = enrollStep; }, [enrollStep]);
  useEffect(() => { setWakeData(loadWake()); }, []);

  /* call timer */
  useEffect(() => {
    if (!callLive) return;
    const t = setInterval(() => setCallSecs((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [callLive]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interim]);

  const mmss = `${String(Math.floor(callSecs / 60)).padStart(2, "0")}:${String(callSecs % 60).padStart(2, "0")}`;

  /* ---------------- voice turn ---------------- */

  const resumeAfterAnswer = () => {
    if (wakeRef.current || autoListenRef.current) startListeningRef.current?.(true);
    else setPhase(IDLE);
  };

  const speak = useCallback(async (answerText) => {
    if (!voiceOn) {
      resumeAfterAnswer();
      return;
    }
    try {
      setPhase(SPEAKING);
      const res = await fetch("/api/mentor/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: answerText }),
      });
      if (!res.ok) throw new Error("tts");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      audioRef.current?.pause();
      const a = new Audio(url);
      audioRef.current = a;
      a.onended = () => {
        URL.revokeObjectURL(url);
        resumeAfterAnswer();
      };
      await a.play();
    } catch {
      setPhase(IDLE);
    }
  }, [voiceOn]);

  const askMentor = useCallback(async (question) => {
    if (!question.trim() || busyRef.current) return;
    busyRef.current = true;
    setInterim("");
    setMessages((m) => [...m, { role: "user", content: question }]);
    setPhase(THINKING);
    try {
      const res = await api("/api/chat", { method: "POST", body: { chatId, question } });
      setChatId(res.chatId);
      setMessages((m) => [...m, { role: "assistant", content: res.answer, sources: res.sources }]);
      await speak(res.answer);
    } catch {
      setMessages((m) => [...m, { role: "assistant", content: "Sorry — something broke on that one. Try again.", error: true }]);
      setPhase(IDLE);
    } finally {
      busyRef.current = false;
    }
  }, [chatId, speak]);

  const restartHot = useCallback(() => {
    setPhase(HOT);
    startListeningRef.current?.(true);
  }, []);

  const handleUtterance = useCallback(async (blob, direct) => {
    const idlePhase = wakeRef.current ? HOT : IDLE;
    if (!blob || blob.size < 3000) {
      setInterim("");
      if (wakeRef.current && !direct) restartHot();
      else setPhase(idlePhase);
      return;
    }

    /* ---- on-device wake gate: costs zero API calls ----
       Utterances are matched against local "Scribble" templates and only
       sent to STT if the wake word is heard (or audio can't be decoded). */
    let localHit = false, localUndecoded = false;
    if (!direct && wakeRef.current && !armedRef.current && wakeDataRef.current) {
      let r;
      try { r = await isWakeWord(blob, wakeDataRef.current); }
      catch { r = { hit: false, undecoded: true, dur: 0 }; }
      localHit = r.hit;
      localUndecoded = !!r.undecoded;
      if (!localHit && !localUndecoded) return restartHot(); // not the word — audio never leaves the device
      if (localHit && r.dur <= 1.6) {
        // bare "Scribble" → arm; next utterance is the question
        armedRef.current = true;
        setArmed(true);
        return restartHot();
      }
      // wake + question in one breath (dur > 1.6), or undecodable → STT below
    }

    setPhase(THINKING);
    setInterim("…");
    try {
      const fd = new FormData();
      fd.append("audio", blob, "q.webm");
      const { text: said } = await api("/api/mentor/transcribe", { method: "POST", body: fd });
      if (!said) {
        setInterim("");
        if (wakeRef.current && !direct) restartHot();
        else setPhase(idlePhase);
        return;
      }
      setInterim(said);

      if (!direct && wakeRef.current && !armedRef.current) {
        const { word, question } = parseWake(said);
        if (!word && !localHit) return restartHot(); // STT agrees: no wake word
        if (word && question.split(/\s+/).length >= 2) return void askMentor(question);
        if (!word && localHit) return void askMentor(said); // local heard it, ASR mangled the word
        armedRef.current = true;
        setArmed(true);
        return restartHot();
      }

      armedRef.current = false;
      setArmed(false);
      askMentor(said);
    } catch {
      setInterim("");
      setError("Couldn't hear that — try again.");
      if (wakeRef.current && !direct) restartHot();
      else setPhase(idlePhase);
    }
  }, [askMentor, restartHot]);

  const startListening = useCallback(async (fromAuto = false) => {
    if (busyRef.current || engineRef.current || enrollStepRef.current) return;
    setError(null);
    try {
      const eng = new VoiceEngine({
        onLevel: (l) => setLevel(l),
        onSpeech: () => setPhase(RECORDING),
        onSilenceEnd: async () => {
          const blob = await eng.stop();
          engineRef.current = null;
          setLevel(0);
          handleUtterance(blob, false);
        },
      });
      engineRef.current = eng;
      setPhase(fromAuto && wakeRef.current ? HOT : RECORDING);
      await eng.start();
    } catch (e) {
      engineRef.current = null;
      setError(e?.message ?? "Mic unavailable — use text or check permissions.");
      setPhase(IDLE);
    }
  }, [handleUtterance]);

  startListeningRef.current = startListening;

  const stopListeningManually = async () => {
    const eng = engineRef.current;
    if (!eng) return;
    const blob = await eng.stop();
    engineRef.current = null;
    setLevel(0);
    armedRef.current = false;
    setArmed(false);
    handleUtterance(blob, true); // manual capture always bypasses the wake gate
  };

  /* ---- wake word enrollment (on-device templates) ---- */

  async function captureEnrollSample() {
    if (busyRef.current || engineRef.current) return;
    try {
      const eng = new VoiceEngine({
        onLevel: (l) => setLevel(l),
        onSpeech: () => setPhase(RECORDING),
        onSilenceEnd: async () => {
          const blob = await eng.stop();
          engineRef.current = null;
          setLevel(0);
          if (!enrollStepRef.current) return; // cancelled
          if (!blob || blob.size < 2500) return captureEnrollSample(); // too quiet, retry sample
          blip();
          enrollBlobsRef.current.push(blob);
          if (enrollBlobsRef.current.length >= 3) return void finishEnrollment();
          setEnrollStep(enrollBlobsRef.current.length + 1);
          captureEnrollSample();
        },
      });
      engineRef.current = eng;
      setPhase(RECORDING);
      await eng.start();
    } catch (e) {
      setError(e?.message ?? "Mic unavailable for setup");
      cancelEnrollment();
    }
  }

  async function finishEnrollment() {
    setEnrollStep(0);
    setPhase(THINKING);
    const data = await enrollFromBlobs(enrollBlobsRef.current);
    if (!data) {
      setError("Couldn't analyze those samples — try setup again.");
      setPhase(IDLE);
      return;
    }
    saveWake(data);
    setWakeData(data);
    blip(1200);
    setWakeMode(true);
    wakeRef.current = true;
    setInterim("");
    startListening(true);
  }

  function startEnrollment() {
    engineRef.current?.stop();
    engineRef.current = null;
    setLevel(0);
    enrollBlobsRef.current = [];
    setEnrollStep(1);
    captureEnrollSample();
  }

  function cancelEnrollment() {
    setEnrollStep(0);
    engineRef.current?.stop();
    engineRef.current = null;
    setLevel(0);
    if (wakeMode) startListening(true);
    else setPhase(IDLE);
  }

  function toggleWake() {
    if (enrollStep) return cancelEnrollment();
    if (wakeMode) {
      // off
      setWakeMode(false);
      wakeRef.current = false;
      armedRef.current = false;
      setArmed(false);
      engineRef.current?.stop();
      engineRef.current = null;
      setLevel(0);
      setPhase(IDLE);
      return;
    }
    if (wakeData) {
      setWakeMode(true);
      wakeRef.current = true;
      if (callLive) startListening(true);
    } else {
      startEnrollment(); // first use → teach the word
    }
  }

  function endCall() {
    engineRef.current?.stop();
    engineRef.current = null;
    audioRef.current?.pause();
    setCallLive(false);
    setPhase(IDLE);
    setLevel(0);
    setInterim("");
    setArmed(false);
    armedRef.current = false;
  }

  function send() {
    const q = text.trim();
    if (!q) return;
    setText("");
    askMentor(q);
  }

  /* ---------------- render ---------------- */

  return (
    <div className="h-screen flex flex-col">
      <Nav />
      <main className="flex-1 flex min-h-0 max-w-7xl w-full mx-auto">
        {/* call column */}
        <section className={`flex-1 flex flex-col min-w-0 ${panel ? "hidden lg:flex" : "flex"}`}>
          {!callLive ? (
            <StartScreen onStart={() => { setCallLive(true); setCallSecs(0); setMessages([]); setChatId(null); }} />
          ) : (
            <>
              {/* stage */}
              <div className="pt-6 pb-4 flex flex-col items-center gap-3 shrink-0">
                <Orb phase={phase} level={level} />
                <div className="pill mono text-white/70">{mmss}</div>
                <div className="text-[13px] text-zinc-400 h-5">
                  {enrollStep ? `Say "Scribble" — sample ${Math.min(enrollBlobsRef.current.length + 1, 3)}/3`
                  : phase === HOT ? (armed ? "Listening — ask your question" : 'Say "Scribble" (checked on-device)')
                  : phase === RECORDING ? (wakeMode && !armed ? "Heard something… checking" : "Listening — talk, then I auto-send on pause")
                  : phase === THINKING ? (interim && interim !== "…" ? `“${interim}”` : "Thinking…")
                  : phase === SPEAKING ? "Speaking…"
                  : wakeMode ? 'Say "Scribble" to ask'
                  : autoListen ? "Ready — say something"
                  : "Tap the mic"}
                </div>
                {enrollStep > 0 && (
                  <button onClick={cancelEnrollment} className="text-[11px] text-zinc-500 hover:text-white underline underline-offset-2">
                    cancel setup
                  </button>
                )}
                {error && <div className="text-[12px] text-[#fca5a5]">{error}</div>}
              </div>

              {/* transcript */}
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
                        {m.sources?.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {m.sources.map((s, k) => (
                              <span key={k} className="pill !text-[10.5px] text-zinc-300">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#34d399]" />{s.pageTitle} · {s.dayLabel}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  )}
                  <div ref={endRef} />
                </div>
              </div>

              {/* controls */}
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
                      onClick={() => (engineRef.current ? stopListeningManually() : startListening(false))}
                      disabled={phase === THINKING || phase === SPEAKING}
                      className={`w-11 h-11 rounded-full flex items-center justify-center shrink-0 transition-all disabled:opacity-40 ${
                        engineRef.current ? "bg-[#f87171] pulse" : "bg-[#7c6cff]"
                      }`}
                      title={engineRef.current ? "Stop & send" : "Talk"}
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
                        onClick={toggleWake}
                        className={`pill !text-[10.5px] transition-colors ${
                          enrollStep ? "!border-[#FBBF24]/60 text-[#FBBF24]" :
                          wakeMode ? "!border-[#7c6cff]/60 text-white" : "text-zinc-400 hover:text-zinc-200"
                        }`}
                        title='Wake word "Scribble" — matched on-device, audio only sent after it is heard'
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${wakeMode ? "bg-[#7c6cff] animate-pulse" : enrollStep ? "bg-[#FBBF24]" : "bg-zinc-600"}`} />
                        {enrollStep ? "teaching…" : wakeData ? 'wake "Scribble"' : 'set up "Scribble"'}
                      </button>
                      {wakeMode && wakeData && !enrollStep && (
                        <button onClick={startEnrollment} className="text-[10.5px] text-zinc-600 hover:text-zinc-300">
                          re-learn
                        </button>
                      )}
                      {!wakeMode && (
                        <label className="flex items-center gap-2 text-[11.5px] text-zinc-500 cursor-pointer select-none">
                          <input type="checkbox" checked={autoListen} onChange={(e) => setAutoListen(e.target.checked)} className="accent-[#7c6cff]" />
                          auto-listen
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

        {/* panels (inline while call continues) */}
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

function StartScreen({ onStart }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6 fade-up">
      <Orb phase="idle" level={0} big />
      <div className="text-center">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Study with your mentor</h1>
        <p className="text-zinc-500 text-[13.5px] mt-2 max-w-sm leading-relaxed">
          A voice call with your notes. Enable the wake word and just say “Scribble…” to ask anything — pull up quizzes and flashcards mid-call.
        </p>
      </div>
      <button onClick={onStart} className="btn btn-primary !rounded-full !px-8 !py-3.5 text-base">
        📞 Start call
      </button>
      <p className="text-[11px] text-zinc-600">mic permission required · voice by Mistral Voxtral</p>
    </div>
  );
}

function Orb({ phase, level, big }) {
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
  async function openSession(id) {
    setPages(null); setNote(null);
    const d = await api(`/api/sessions/${id}`);
    setPages(d.pages ?? []);
  }
  async function openPage(id) {
    const d = await api(`/api/pages/${id}`);
    setNote(d);
  }
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
