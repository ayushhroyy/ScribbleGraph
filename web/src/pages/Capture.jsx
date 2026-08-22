import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { blip, buzz, uploadSession } from "../lib.js";

/**
 * We do NOT use the library's internal auto-capture (its score gates are
 * strict & hard-coded: score>=0.58, edgeContrast>=0.18 — plain notebook
 * pages on a desk fail them forever). Instead we drive capture ourselves
 * from `frame` events + `captureManual()`, with forgiving thresholds.
 */
const AREA_MIN = 0.05; // page fills ≥5% of frame
const STABLE_MS = 900; // quad still for ~0.9s
const MOVE_TOL = 0.03; // relative movement tolerance per frame
const COOLDOWN_MS = 1300;

export default function Capture() {
  const nav = useNavigate();
  const videoRef = useRef(null);
  const scannerRef = useRef(null);
  const autoRef = useRef(true);
  const lockRef = useRef(false); // shutter / snap in progress
  const coolRef = useRef(0); // cooldown until ts
  const anchorRef = useRef(null); // {center, area, t} stability anchor
  const stableAccRef = useRef(0);
  const fileRef = useRef();

  const [ready, setReady] = useState(false);
  const [auto, setAuto] = useState(true);
  const [captures, setCaptures] = useState([]);
  const [urls, setUrls] = useState([]);
  const [error, setError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [hint, setHint] = useState("Starting camera…");
  const [toast, setToast] = useState(null);
  const [diag, setDiag] = useState(null);
  const [showDiag, setShowDiag] = useState(false);

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { createScanner } = await import("js-document-autocapture");
        if (dead || !videoRef.current) return;
        const scanner = createScanner({
          videoElement: videoRef.current,
          autoCapture: false, // we trigger captures ourselves
          cocoSsd: false,
        });

        scanner.on("error", (e) => setError(e?.message ?? "Camera error"));

        scanner.on("frame", (f) => {
          const det = f.detection;
          const cand = det?.bestCandidate;
          const now = performance.now();
          const v = videoRef.current;
          const diagSq = v ? Math.hypot(v.videoWidth || 1, v.videoHeight || 1) : 1;

          // diagnostics line (always computed, shown if toggled)
          const dline = cand
            ? `src ${cand.source ?? "?"} · score ${(cand.score * 100).toFixed(0)}% · area ${((cand.metrics?.areaFraction ?? 0) * 100).toFixed(0)}% · stable ${stableAccRef.current.toFixed(0)}ms`
            : det?.status === "rejected"
              ? `no doc (${det.rejectionReason ?? "?"})`
              : "no doc";
          setDiag(dline);

          const fail = (msg, reset = true) => {
            setHint(msg);
            if (reset) { anchorRef.current = null; stableAccRef.current = 0; }
          };

          if (!cand || det.status !== "found") return fail("Point at your notebook");
          const area = cand.metrics?.areaFraction ?? 0;
          if (area < AREA_MIN) return fail("Move closer");

          // brightness gate only (ignore the lib's strict blur/glare gates)
          const bright = f.quality?.brightness;
          if (bright && !bright.ok) return fail(bright.averageLuma < 60 ? "Too dark" : "Too bright");

          // ---- our own stability: quad center+size must stay put ----
          const q = cand.quad;
          const cx = (q.topLeft.x + q.topRight.x + q.bottomRight.x + q.bottomLeft.x) / 4;
          const cy = (q.topLeft.y + q.topRight.y + q.bottomRight.y + q.bottomLeft.y) / 4;
          const a = anchorRef.current;
          if (!a) {
            anchorRef.current = { cx, cy, area, t: now };
            stableAccRef.current = 0;
            return fail("Hold steady…", false);
          }
          const move = (Math.hypot(cx - a.cx, cy - a.cy) / diagSq) + Math.abs(area - a.area) / Math.max(a.area, 1e-6) * 0.5;
          if (move > MOVE_TOL) {
            anchorRef.current = { cx, cy, area, t: now };
            stableAccRef.current = 0;
            return fail("Hold steady…", false);
          }
          stableAccRef.current += now - a.t;
          anchorRef.current.t = now;

          if (stableAccRef.current < STABLE_MS) return fail("Hold steady…", false);
          setHint("Captured");

          // ---- fire ----
          if (autoRef.current && now > coolRef.current && !lockRef.current) {
            coolRef.current = now + COOLDOWN_MS;
            anchorRef.current = null;
            stableAccRef.current = 0;
            snap(true);
          }
        });

        await scanner.start();
        if (dead) return void scanner.destroy();
        scannerRef.current = scanner;
        setReady(true);
        setHint("Point at your notebook");
      } catch (e) {
        setError(e?.message ?? String(e));
      }
    })();
    return () => {
      dead = true;
      try { scannerRef.current?.destroy(); } catch {}
    };
  }, []);

  async function snap(fromAuto = false) {
    const scanner = scannerRef.current;
    if (!scanner || lockRef.current) return;
    lockRef.current = true;
    setSnapping(true);
    try {
      const result = await scanner.captureManual();
      blip(fromAuto ? 920 : 1040);
      buzz();
      setCaptures((p) => [...p, result.blob]);
      setUrls((p) => [...p, URL.createObjectURL(result.blob)]);
    } catch (e) {
      flash(e?.message ?? "Couldn't capture — try again");
    } finally {
      lockRef.current = false;
      setTimeout(() => setSnapping(false), 350);
    }
  }

  function flash(msg) {
    setToast(msg);
    setTimeout(() => setToast(null), 2200);
  }

  function toggleAuto() {
    setAuto((a) => {
      autoRef.current = !a;
      flash(!a ? "Auto-capture on" : "Manual mode — use the shutter");
      return !a;
    });
  }

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
      <video ref={videoRef} autoPlay muted playsInline className="absolute inset-0 w-full h-full object-cover" />

      {/* framing mask */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-[6%] rounded-3xl" style={{ boxShadow: "0 0 0 100vmax rgba(0,0,0,0.5)" }} />
        {ready && <div className="absolute inset-[6%] rounded-3xl border border-white/25" />}
        {ready && auto && hint === "Hold steady…" && (
          <div className="absolute inset-x-[10%] top-[8%] h-0.5 bg-[#7c6cff] scanline rounded-full" />
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
              {captures.length} {captures.length === 1 ? "page" : "pages"}
            </>
          ) : "0 pages"}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowDiag((s) => !s)} disabled={!ready} className={`pill text-white/70 ${ready ? "" : "opacity-40"}`} title="Diagnostics">
            ⓘ
          </button>
          <button onClick={toggleAuto} disabled={!ready} className={`pill text-white/90 ${ready ? "" : "opacity-40"}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${auto ? "bg-[#7c6cff]" : "bg-zinc-500"}`} />
            {auto ? "Auto" : "Manual"}
          </button>
        </div>
      </div>

      <div className="flex-1" />

      {/* diagnostics */}
      {showDiag && diag && (
        <div className="relative z-20 flex justify-center mb-2 px-6">
          <span className="pill mono !text-[10px] text-white/70">{diag}</span>
        </div>
      )}

      {toast && (
        <div className="relative z-20 flex justify-center mb-2 px-6">
          <span className="pill text-white/90 fade-up">{toast}</span>
        </div>
      )}

      {/* guidance */}
      {ready && (
        <div className="relative z-10 flex justify-center mb-4 px-6">
          <div className={`pill text-white/90 text-xs ${hint === "Hold steady…" ? "!border-[#7c6cff]/50" : ""}`}>
            {!auto ? (captures.length ? "Frame the page, tap the shutter" : "Tap the shutter to capture") :
             hint === "Captured" ? <span className="text-[#34d399]">✓ Captured</span> : hint}
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
          <div className="flex items-center justify-center gap-6 max-w-sm mx-auto">
            <button
              onClick={() => { setCaptures((p) => p.slice(0, -1)); setUrls((p) => p.slice(0, -1)); }}
              disabled={!captures.length}
              className="w-11 h-11 rounded-full bg-black/50 backdrop-blur border border-white/10 flex items-center justify-center text-white/80 disabled:opacity-30"
            >
              <UndoIcon />
            </button>
            <button
              onClick={() => snap()}
              disabled={!ready || snapping}
              className="w-[72px] h-[72px] rounded-full border-[3px] border-white/90 flex items-center justify-center active:scale-95 transition-transform disabled:opacity-50"
            >
              <span className={`w-[56px] h-[56px] rounded-full flex items-center justify-center transition-colors ${snapping ? "bg-[#34d399]" : "bg-white"}`}>
                {snapping ? <CheckIcon /> : <ShutterIcon />}
              </span>
            </button>
            <button onClick={finish} disabled={!captures.length || uploading} className="btn btn-primary !rounded-full !px-5 !py-3">
              {uploading ? <><Spinner /> …</> : "Done"}
            </button>
          </div>
        )}
        <p className="text-center text-[11px] text-white/35 mt-3">
          {auto ? "Auto-captures each page — or tap the shutter anytime" : "Tap the shutter for each page"}
        </p>
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
const ShutterIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#09090b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 8h3l2-3h6l2 3h3v12H4z" /> <circle cx="12" cy="13.5" r="3.5" />
  </svg>
);
const CheckIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#09090b" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
);
const Spinner = () => <span className="w-4 h-4 rounded-full border-2 border-white/25 border-t-white animate-spin" />;
