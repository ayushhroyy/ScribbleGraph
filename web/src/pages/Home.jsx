import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import Nav from "../components/Nav.jsx";
import { api, timeAgo, uploadSession } from "../lib.js";

export default function Home() {
  const [data, setData] = useState(null);
  const [uploading, setUploading] = useState(null); // {done,total}
  const fileRef = useRef();
  const nav = useNavigate();

  useEffect(() => {
    api("/api/dashboard").then(setData).catch(() => setData({ sessions: [], chats: [], stats: {} }));
  }, []);

  async function onFiles(e) {
    const files = [...e.target.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    setUploading({ done: 0, total: files.length });
    try {
      const id = await uploadSession(files, (done, total) => setUploading({ done, total }));
      nav(`/session/${id}`);
    } catch {
      setUploading(null);
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1 w-full max-w-5xl mx-auto px-5 md:px-6 py-8 md:py-12 pb-28 md:pb-12">
        {/* hero */}
        <div className="fade-up">
          <p className="text-[13px] text-zinc-500">{greeting()}</p>
          <h1 className="text-[26px] md:text-4xl font-semibold tracking-tight mt-1 leading-tight">
            Your notebook, <span className="text-[#a99fff]">connected.</span>
          </h1>
          <p className="text-zinc-500 text-sm mt-2 max-w-md">
            Capture handwritten notes — they get digitized, tagged, and linked across days.
          </p>
        </div>

        {/* actions */}
        <div className="flex items-center gap-2.5 mt-7 fade-up" style={{ animationDelay: "0.05s" }}>
          <Link to="/capture" className="btn btn-primary !px-5 !py-3">
            <CameraGlyph /> Capture pages
          </Link>
          <button onClick={() => fileRef.current?.click()} className="btn btn-ghost !py-3">
            Upload
          </button>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
        </div>

        {uploading && (
          <div className="card p-4 mt-5 flex items-center gap-3 fade-up">
            <Spinner />
            <div className="text-sm">
              <span className="font-medium">Uploading {uploading.done}/{uploading.total}</span>
              <span className="text-zinc-500"> — processing starts automatically</span>
            </div>
          </div>
        )}

        {/* stats */}
        {data?.stats && (
          <div className="flex items-center gap-5 mt-8 text-sm fade-up" style={{ animationDelay: "0.1s" }}>
            <Stat value={data.stats.pages} label="pages" />
            <Dot />
            <Stat value={data.stats.concepts} label="concepts" />
            <Dot />
            <Stat value={data.stats.connections} label="links" />
          </div>
        )}

        {/* recent sessions */}
        <section className="mt-10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[13px] font-semibold text-zinc-400 tracking-wide">Recent notes</h2>
          </div>

          {!data ? (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="card skeleton aspect-[4/3]" />
              ))}
            </div>
          ) : data.sessions.length === 0 ? (
            <button onClick={() => nav("/capture")} className="card card-hover w-full py-14 flex flex-col items-center gap-3 fade-up">
              <span className="w-12 h-12 rounded-2xl bg-[var(--accent-soft)] flex items-center justify-center">
                <CameraGlyph />
              </span>
              <span className="text-sm text-zinc-300 font-medium">Capture your first pages</span>
              <span className="text-xs text-zinc-600">or upload photos from this device</span>
            </button>
          ) : (
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
              {data.sessions.map((s, i) => (
                <SessionCard key={s.id} s={s} i={i} />
              ))}
            </div>
          )}
        </section>

        {/* recent chats */}
        {data?.chats?.length > 0 && (
          <section className="mt-10">
            <h2 className="text-[13px] font-semibold text-zinc-400 tracking-wide mb-3">Recent chats</h2>
            <div className="card divide-y divide-white/[0.05] overflow-hidden">
              {data.chats.slice(0, 4).map((c) => (
                <Link key={c.id} to={`/ask?chat=${c.id}`} className="flex items-center justify-between px-4 py-3.5 hover:bg-white/[0.03] transition-colors">
                  <span className="text-sm text-zinc-200 truncate pr-4">{c.title}</span>
                  <span className="text-xs text-zinc-600 shrink-0">{timeAgo(c.created_at)}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function SessionCard({ s, i }) {
  const busy = s.status === "processing";
  return (
    <Link
      to={`/session/${s.id}`}
      className="card card-hover overflow-hidden block fade-up"
      style={{ animationDelay: `${0.03 * i}s` }}
    >
      <div className="relative aspect-[4/3] bg-[#0d0d10] overflow-hidden">
        {s.thumb ? (
          <img
            src={`/media/${s.thumb}`}
            alt=""
            loading="lazy"
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-zinc-700">
            <NoteGlyph />
          </div>
        )}
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0) 55%, rgba(0,0,0,.72))" }} />
        <div className="absolute bottom-0 inset-x-0 p-3.5">
          <div className="text-[13.5px] font-medium text-white leading-snug line-clamp-2">
            {s.title ?? "Processing…"}
          </div>
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-zinc-400">
            <span>{timeAgo(s.created_at)}</span>
            <span className="w-0.5 h-0.5 rounded-full bg-zinc-600" />
            <span>{s.page_count} {s.page_count === 1 ? "page" : "pages"}</span>
            {busy && (
              <>
                <span className="w-0.5 h-0.5 rounded-full bg-zinc-600" />
                <span className="text-[#fbbf24] flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#fbbf24] animate-pulse" />
                  processing
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

function Stat({ value, label }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="mono text-lg font-semibold">{value ?? 0}</span>
      <span className="text-zinc-600 text-xs">{label}</span>
    </span>
  );
}
const Dot = () => <span className="w-1 h-1 rounded-full bg-zinc-700" />;

function CameraGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3l2-3h6l2 3h3v12H4z" /> <circle cx="12" cy="13.5" r="3.5" />
    </svg>
  );
}
function NoteGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M5 4h11l3 3v13H5zM8 9h8M8 13h8M8 17h5" />
    </svg>
  );
}
function Spinner() {
  return (
    <span className="w-5 h-5 rounded-full border-2 border-white/15 border-t-[#7c6cff] animate-spin" />
  );
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Late night session";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
