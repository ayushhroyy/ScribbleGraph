import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import Nav from "../components/Nav.jsx";
import { api, fmtDate } from "../lib.js";

const REGION_COLORS = { figure: "#4CC9F0", chart: "#38bdf8", table: "#FBBF24", formula: "#F72585" };

export default function Note() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [md, setMd] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async function poll() {
      try {
        const d = await api(`/api/pages/${id}`);
        if (!alive) return;
        setData(d);
        setMd(d.page.markdown ?? "");
        if (d.page.status !== "done" && d.page.status !== "error") setTimeout(poll, 2500);
      } catch {}
    })();
    return () => { alive = false; };
  }, [id]);

  async function save() {
    setSaving(true);
    try {
      await api(`/api/pages/${id}`, { method: "PATCH", body: { markdown: md } });
      setData((d) => ({ ...d, page: { ...d.page, markdown: md } }));
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (!data)
    return (
      <Shell><div className="card skeleton h-72" /></Shell>
    );

  const { page, regions, backlinks } = data;

  return (
    <Shell>
      {/* header */}
      <div className="flex items-center justify-between gap-3 fade-up">
        <div className="min-w-0">
          <Link to={`/session/${page.session_id}`} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors inline-flex items-center gap-1">
            <BackIcon /> {page.session_title ?? "Session"}
          </Link>
          <h1 className="text-lg md:text-xl font-semibold tracking-tight mt-1.5">Page {page.idx + 1}</h1>
        </div>
        {page.status === "done" && (
          <button onClick={() => (editing ? save() : setEditing(true))} className="btn btn-ghost !py-2 !px-3.5 text-[13px] shrink-0">
            {editing ? (saving ? "Saving…" : "Save") : "Correct"}
          </button>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-5 mt-6">
        {/* scan */}
        <div className="fade-up">
          <div className="card p-2.5 relative overflow-hidden">
            <div className="relative rounded-xl overflow-hidden bg-[#0d0d10]">
              <img src={`/media/${page.r2_key}`} alt="scan" className="w-full" />
              {regions.map((r) => {
                const [x1, y1, x2, y2] = JSON.parse(r.bbox || "[]");
                if (!page.width || !page.height || x2 <= x1 || y2 <= y1) return null;
                const color = REGION_COLORS[r.label] ?? "#4CC9F0";
                return (
                  <div key={r.id} className="absolute rounded-md" style={{
                    left: `${(x1 / page.width) * 100}%`, top: `${(y1 / page.height) * 100}%`,
                    width: `${((x2 - x1) / page.width) * 100}%`, height: `${((y2 - y1) / page.height) * 100}%`,
                    border: `1.5px solid ${color}`, boxShadow: `0 0 14px ${color}44`, background: `${color}0d`,
                  }}>
                    <span className="absolute -top-5 left-0 text-[9px] mono px-1.5 rounded" style={{ background: color, color: "#000" }}>
                      {r.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          {regions.length > 0 && (
            <p className="text-[11px] text-zinc-600 mt-2 px-1">
              {regions.length} {regions.length === 1 ? "region" : "regions"} auto-extracted — diagrams, tables & formulas
            </p>
          )}
        </div>

        {/* text */}
        <div className="fade-up" style={{ animationDelay: "0.05s" }}>
          <div className="flex items-center justify-between mb-2.5 px-1">
            <span className="text-[11px] font-semibold text-zinc-500 tracking-wider uppercase">Extracted text</span>
            {page.avg_confidence != null && (
              <span className="mono text-[11px]" style={{ color: confColor(page.avg_confidence) }}>
                {page.avg_confidence < 0.85 ? "needs review · " : ""}{(page.avg_confidence * 100).toFixed(0)}% confidence
              </span>
            )}
          </div>
          {editing ? (
            <textarea
              value={md}
              onChange={(e) => setMd(e.target.value)}
              className="w-full h-[50vh] lg:h-[60vh] card p-4 mono text-[13px] leading-relaxed resize-none bg-[#0c0c0e]"
            />
          ) : (
            <div className="card p-4 mono text-[13px] leading-relaxed text-zinc-300 whitespace-pre-wrap max-h-[50vh] lg:max-h-[60vh] overflow-auto">
              {page.markdown || (page.status === "error" ? "Processing failed — retry from the session page." : page.status === "done" ? "No text detected on this page." : "Reading your handwriting…")}
            </div>
          )}
        </div>
      </div>

      {/* backlinks */}
      {backlinks?.length > 0 && (
        <section className="mt-10 fade-up">
          <h2 className="text-[11px] font-semibold text-zinc-500 tracking-wider uppercase mb-3 px-1">
            Linked from other days
          </h2>
          <div className="flex gap-3 overflow-x-auto no-scrollbar pb-1 -mx-1 px-1">
            {backlinks.map((b, i) => (
              <Link key={i} to={`/note/${b.page_id}`} className="card card-hover p-4 w-56 shrink-0 block">
                <div className="text-[13px] font-medium truncate">{b.session_title ?? "Notes"}</div>
                <div className="flex items-center justify-between mt-2 text-[11px] text-zinc-500">
                  <span>{b.session_date ? fmtDate(b.session_date) : ""} · p.{(b.page_idx ?? 0) + 1}</span>
                  <span className="mono text-[#a99fff]">{(b.score * 100).toFixed(0)}%</span>
                </div>
                <div className="mt-2.5 h-0.5 rounded-full bg-white/[0.06] overflow-hidden">
                  <div className="h-full bg-[#7c6cff]/60" style={{ width: `${b.score * 100}%` }} />
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Nav />
      <main className="flex-1 w-full max-w-6xl mx-auto px-5 md:px-6 py-8 md:py-10 pb-28 md:pb-12">{children}</main>
    </div>
  );
}
const confColor = (c) => (c >= 0.9 ? "#34d399" : c >= 0.8 ? "#fbbf24" : "#f87171");
const BackIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
);
