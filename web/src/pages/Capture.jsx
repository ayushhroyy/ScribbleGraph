import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { blip, buzz, uploadSession } from "../lib.js";

const GUIDE = {
  DOCUMENT_NOT_FOUND: "Point at your notebook",
  MOVE_CLOSER: "Move closer",
  HOLD_STEADY: "Hold steady…",
  CAPTURING: "Captured",
};

export default function Capture() {
  const nav = useNavigate();
  const videoRef = useRef(null);
  const scannerRef = useRef(null);
  const fileRef = useRef();
  const [guidance, setGuidance] = useState("Starting camera…");
  const [ready, setReady] = useState(false);
  const [captures, setCaptures] = useState([]);
  const [urls, setUrls] = useState([]);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { createScanner } = await import("js-document-autocapture");
        if (dead || !videoRef.current) return;
        const scanner = createScanner({ videoElement: videoRef.current, autoCapture: true, cocoSsd: false });
        scanner.on("guidance", (code) => setGuidance(GUIDE[code] ?? code.replaceAll("_", " ").toLowerCase()));
        scanner.on("capture", (result) => {
          blip();
          buzz();
          setCaptures((p) => [...p, result.blob]);
          setUrls((p) => [...p, URL.createObjectURL(result.blob)]);
        });
        scanner.on("error", (e) => setError(e?.message ?? "Camera error"));
        await scanner.start();
        if (dead) return void scanner.destroy();
        scannerRef.current = scanner;
        setReady(true);
        setGuidance("Point at your notebook");
      } catch (e) {
        setError(e?.message ?? String(e));
      }
    })();
    return () => {
      dead = true;
      try { scannerRef.current?.destroy(); } catch {}
    };
  }, []);

  async function finish() {
    if (!captures.length) return;
    setUploading(true);
    try {
      const id = await uploadSession(captures);
      nav(`/session/${id}`);
    } catch {
      setUploading(false);
    }
  }

  async function onFiles(e) {
    const files = [...e.target.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    setUploading(true);
    try {
      const id = await uploadSession(files);
      nav(`/session/${id}`);
    } catch {
      setUploading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col pt-safe">
      {/* video */}
      <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-cover" />

      {/* framing mask */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-[6%] rounded-3xl" style={{ boxShadow: "0 0 0 100vmax rgba(0,0,0,0.55)" }} />
        {ready && (
          <>
            <div className="absolute inset-[6%] rounded-3xl border border-white/25" />
            {guidance === "Hold steady…" && (
              <div className="absolute inset-x-[10%] top-[8%] h-0.5 bg-[#7c6cff] scanline rounded-full" />
            )}
          </>
        )}
      </div>

      {/* top bar */}
      <div className="relative z-10 flex items-center justify-between px-4 h-16">
        <button onClick={() => nav("/")} className="w-10 h-10 rounded-full bg-black/50 backdrop-blur flex items-center justify-center text-white/90">
          <XIcon />
        </button>
        <div className="pill text-white/90">
          {captures.length > 0 ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-[#34d399]" />
              {captures.length} {captures.length === 1 ? "page" : "pages"} captured
            </>
          ) : (
            "0 pages"
          )}
        </div>
        <div className="w-10 h-10" />
      </div>

      <div className="flex-1" />

      {/* guidance */}
      {ready && (
        <div className="relative z-10 flex justify-center mb-4 px-6">
          <div className={`pill text-white/90 text-xs ${guidance === "Hold steady…" ? "!border-[#7c6cff]/50" : ""}`}>
            {guidance === "Captured" ? <span className="text-[#34d399]">✓ {guidance}</span> : guidance}
          </div>
        </div>
      )}

      {/* thumbnails */}
      {urls.length > 0 && (
        <div className="relative z-10 flex gap-2 px-4 overflow-x-auto no-scrollbar mb-4">
          {urls.map((u, i) => (
            <div key={i} className="relative shrink-0">
              <img src={u} alt="" className="h-16 w-12 object-cover rounded-xl border border-white/20" />
              <span className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-[#7c6cff] text-[10px] font-semibold flex items-center justify-center">
                {i + 1}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* bottom controls */}
      <div className="relative z-10 pb-safe px-6 pb-4">
        {error ? (
          <div className="card !bg-[#101013]/95 backdrop-blur p-6 text-center max-w-sm mx-auto fade-up">
            <p className="text-sm font-medium text-zinc-200">Camera unavailable</p>
            <p className="text-xs text-zinc-500 mt-1.5 leading-relaxed">{error}</p>
            <button onClick={() => fileRef.current?.click()} className="btn btn-primary w-full mt-4">
              Upload photos instead
            </button>
            <button onClick={() => nav("/")} className="btn btn-ghost w-full mt-2">Back home</button>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
          </div>
        ) : (
          <div className="flex items-center justify-center gap-4 max-w-sm mx-auto">
            <button
              onClick={() => { setCaptures((p) => p.slice(0, -1)); setUrls((p) => p.slice(0, -1)); }}
              disabled={!captures.length}
              className="w-11 h-11 rounded-full bg-black/50 backdrop-blur border border-white/10 flex items-center justify-center text-white/80 disabled:opacity-30"
            >
              <UndoIcon />
            </button>
            <button
              onClick={finish}
              disabled={!captures.length || uploading}
              className="btn btn-primary !rounded-full !px-8 !py-3.5 flex-1"
            >
              {uploading ? <><Spinner /> Uploading…</> : `Done · ${captures.length}`}
            </button>
          </div>
        )}
        <p className="text-center text-[11px] text-white/35 mt-3">Flip pages slowly — each page auto-captures</p>
      </div>
    </div>
  );
}

const XIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const UndoIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
);
const Spinner = () => <span className="w-4 h-4 rounded-full border-2 border-white/25 border-t-white animate-spin" />;
