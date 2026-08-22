import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Nav from "../components/Nav.jsx";
import { api, timeAgo, PAGE_STATUS } from "../lib.js";

export default function Session() {
  const { id } = useParams();
  const [data, setData] = useState(null);

  useEffect(() => {
    let alive = true;
    (async function poll() {
      try {
        const d = await api(`/api/sessions/${id}`);
        if (!alive) return;
        setData(d);
        const busy = (d.counts?.active ?? 0) > 0 || d.session.status === "processing";
        if (busy) setTimeout(poll, 2500);
      } catch {}
    })();
    return () => { alive = false; };
  }, [id]);

  if (!data)
    return (
      <Shell>
        <div className="card skeleton h-28" />
      </Shell>
    );

  const { session, pages, counts } = data;
  const total = pages.length || 1;
  const donePct = Math.round(((counts?.done ?? 0) / total) * 100);
  const hasErrors = (counts?.errors ?? 0) > 0;
  const busy = (counts?.active ?? 0) > 0;

  return (
    <Shell>
      <div className="flex items-start justify-between gap-3 fade-up">
        <div className="min-w-0">
          <Link to="/" className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors inline-flex items-center gap-1">
            <BackIcon /> Notes
          </Link>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight mt-2 truncate">
            {session.title ?? "Processing…"}
          </h1>
          <p className="text-[13px] text-zinc-500 mt-1">
            {timeAgo(session.created_at)} · {pages.length} {pages.length === 1 ? "page" : "pages"}
          </p>
        </div>
        {!busy && !hasErrors && pages.length > 0 && (
          <div className="flex gap-2 shrink-0">
            <Link to={`/quiz?session=${id}`} className="btn btn-ghost !py-2 !px-3.5 text-[13px]">Quiz</Link>
            <Link to="/ask" className="btn btn-primary !py-2 !px-3.5 text-[13px]">Ask AI</Link>
          </div>
        )}
      </div>

      {/* progress */}
      {busy && (
        <div className="card p-4 mt-6 fade-up">
          <div className="flex items-center justify-between text-[13px] mb-2.5">
            <span className="flex items-center gap-2">
              <Spinner />
              <span className="font-medium">Processing your notes</span>
            </span>
            <span className="mono text-zinc-400">{donePct}%</span>
          </div>
          <div className="h-1 rounded-full bg-white/[0.07] overflow-hidden">
            <div className="h-full rounded-full bg-[#7c6cff] transition-all duration-700" style={{ width: `${donePct}%` }} />
          </div>
          <div className="flex gap-4 mt-3 text-[11px] text-zinc-500">
            <Step label="OCR" active />
            <Step label="Diagrams" active />
            <Step label="Cross-day links" active />
          </div>
        </div>
      )}

      {hasErrors && !busy && (
        <div className="card !border-[#f87171]/25 p-4 mt-6 flex items-center gap-3 fade-up">
          <span className="w-8 h-8 rounded-xl bg-[#f87171]/10 flex items-center justify-center"><WarnIcon /></span>
          <div className="text-[13px] flex-1">
            <span className="font-medium">{counts.errors} {counts.errors === 1 ? "page" : "pages"} failed to process</span>
            <span className="text-zinc-500"> — tap a page to retry</span>
          </div>
        </div>
      )}

      {/* pages grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 mt-6">
        {pages.map((p, i) => (
          <PageCard key={p.id} page={p} i={i} />
        ))}
      </div>
    </Shell>
  );
}

function PageCard({ page, i }) {
  const st = PAGE_STATUS[page.status] ?? {};
  const [retrying, setRetrying] = useState(false);
  const failed = page.status === "error";

  async function retry(e) {
    e.preventDefault();
    setRetrying(true);
    try { await api(`/api/pages/${page.id}/reprocess`, { method: "POST" }); window.location.reload(); } catch {}
  }

  return (
    <Link
      to={failed ? "#" : `/note/${page.id}`}
      onClick={failed ? retry : undefined}
      className="card card-hover overflow-hidden block fade-up"
      style={{ animationDelay: `${i * 0.03}s` }}
    >
      <div className="relative aspect-[3/4] bg-[#0d0d10]">
        <img src={`/media/${page.r2_key}`} alt="" loading="lazy" className="w-full h-full object-cover" />
        {failed || st.label ? (
          <div className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(9,9,11,0.55)" }}>
            {failed ? (
              <span className="pill !border-[#f87171]/40 text-[#f87171]">
                {retrying ? "Retrying…" : "Tap to retry"}
              </span>
            ) : (
              <span className="pill text-white/85">
                <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: st.color }} />
                {st.label}…
              </span>
            )}
          </div>
        ) : null}
        {page.status === "done" && page.avg_confidence != null && (
          <span className="pill absolute top-2 right-2 !bg-black/60 mono !text-[10px]" style={{ color: confColor(page.avg_confidence) }}>
            {(page.avg_confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>
      <div className="px-3 py-2.5 flex items-center justify-between">
        <span className="text-[13px] font-medium text-zinc-200">Page {page.idx + 1}</span>
        {page.status === "done" && <span className="w-1.5 h-1.5 rounded-full bg-[#34d399]" />}
      </div>
    </Link>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1 w-full max-w-5xl mx-auto px-5 md:px-6 py-8 md:py-10 pb-28 md:pb-12">{children}</main>
    </div>
  );
}
const confColor = (c) => (c >= 0.9 ? "#34d399" : c >= 0.8 ? "#fbbf24" : "#f87171");
const Spinner = () => <span className="w-4 h-4 rounded-full border-2 border-white/15 border-t-[#7c6cff] animate-spin" />;
const Step = ({ label }) => (
  <span className="flex items-center gap-1.5">
    <span className="w-1 h-1 rounded-full bg-[#7c6cff]" /> {label}
  </span>
);
const BackIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
);
const WarnIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="1.8" strokeLinecap="round"><path d="M12 8v5M12 16.5v.5M10.3 3.9 2.8 17a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
);
