import { useEffect, useRef, useState } from "react";
import Nav from "../components/Nav.jsx";
import { api } from "../lib.js";

export default function GraphPage() {
  const canvasRef = useRef(null);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const st = useRef({ sim: [], offset: { x: 0, y: 0 }, scale: 1, drag: null, pan: null, hover: null, pinch: null });

  useEffect(() => {
    api("/api/graph")
      .then((d) => { setNodes(d.nodes ?? []); setEdges(d.edges ?? []); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || nodes.length === 0) return;
    const s = st.current;
    const W = () => canvas.clientWidth, H = () => canvas.clientHeight;

    if (s.sim.length !== nodes.length) {
      s.sim = nodes.map((n, i) => {
        const a = (i / nodes.length) * Math.PI * 2;
        return { ...n, x: Math.cos(a) * Math.min(W(), H()) * 0.3 + W() / 2, y: Math.sin(a) * Math.min(W(), H()) * 0.3 + H() / 2, vx: 0, vy: 0 };
      });
      s.offset = { x: 0, y: 0 }; s.scale = 1;
    }
    const byName = Object.fromEntries(s.sim.map((n) => [n.id, n]));

    let raf;
    const tick = () => {
      for (let i = 0; i < s.sim.length; i++) {
        const a = s.sim[i];
        a.vx += (W() / 2 - a.x) * 0.0015;
        a.vy += (H() / 2 - a.y) * 0.0015;
        for (let j = i + 1; j < s.sim.length; j++) {
          const b = s.sim[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          const d2 = dx * dx + dy * dy || 1;
          if (d2 < 40000) {
            const f = 900 / d2, d = Math.sqrt(d2);
            dx /= d; dy /= d;
            a.vx -= dx * f; a.vy -= dy * f;
            b.vx += dx * f; b.vy += dy * f;
          }
        }
      }
      for (const e of edges) {
        const a = byName[e.a], b = byName[e.b];
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - 130) * 0.012 * Math.min(e.w, 5);
        a.vx += (dx / d) * f; a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
      }
      for (const n of s.sim) {
        if (s.drag === n) { n.vx = 0; n.vy = 0; continue; }
        n.vx *= 0.85; n.vy *= 0.85;
        n.x += n.vx; n.y += n.vy;
      }
      draw();
      raf = requestAnimationFrame(tick);
    };

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = W() * dpr; canvas.height = H() * dpr;
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W(), H());
      ctx.translate(s.offset.x, s.offset.y);
      ctx.scale(s.scale, s.scale);

      for (const e of edges) {
        const a = byName[e.a], b = byName[e.b];
        if (!a || !b) continue;
        const dim = selected && selected !== e.a && selected !== e.b;
        const hot = selected && (selected === e.a || selected === e.b);
        ctx.strokeStyle = hot ? "rgba(255,255,255,0.45)" : dim ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.1)";
        ctx.lineWidth = hot ? 2 : Math.min(e.w, 4) * 0.8;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
      for (const n of s.sim) {
        const deg = edges.reduce((acc, e) => acc + (e.a === n.id || e.b === n.id ? 1 : 0), 0);
        const r = 7 + Math.min(deg, 4) * 1.8;
        const isHot = selected === n.id || s.hover === n.id;
        const dim = selected && selected !== n.id && !edges.some((e) => (e.a === selected && e.b === n.id) || (e.b === selected && e.a === n.id));
        ctx.globalAlpha = dim ? 0.25 : 1;
        ctx.beginPath();
        ctx.arc(n.x, n.y, isHot ? r + 2.5 : r, 0, Math.PI * 2);
        ctx.fillStyle = n.color ?? "#9CA3AF";
        if (isHot) { ctx.shadowColor = n.color ?? "#9CA3AF"; ctx.shadowBlur = 20; }
        ctx.fill();
        ctx.shadowBlur = 0;
        if (s.scale > 0.55 || isHot) {
          ctx.fillStyle = isHot ? "#fff" : "rgba(255,255,255,0.7)";
          ctx.font = `${isHot ? 12.5 : 11.5}px Inter, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillText(n.id, n.x, n.y - r - 7);
        }
        ctx.globalAlpha = 1;
      }
    };

    const toWorld = (mx, my) => ({ x: (mx - s.offset.x) / s.scale, y: (my - s.offset.y) / s.scale });
    const pick = (mx, my) => {
      const p = toWorld(mx, my);
      return s.sim.find((n) => Math.hypot(n.x - p.x, n.y - p.y) < 18);
    };
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      const t = e.touches?.[0] ?? e;
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    };

    // pointer (mouse + touch unified via Pointer Events)
    const onDown = (e) => {
      canvas.setPointerCapture?.(e.pointerId);
      const m = pos(e);
      const n = pick(m.x, m.y);
      if (n) { s.drag = n; s.pan = null; } else s.pan = { x: m.x - s.offset.x, y: m.y - s.offset.y };
    };
    const onMove = (e) => {
      const m = pos(e);
      if (s.drag) {
        const p = toWorld(m.x, m.y);
        s.drag.x = p.x; s.drag.y = p.y;
      } else if (s.pan) {
        s.offset = { x: m.x - s.pan.x, y: m.y - s.pan.y };
      } else {
        const n = pick(m.x, m.y);
        s.hover = n?.id ?? null;
        canvas.style.cursor = n ? "pointer" : "grab";
      }
    };
    const onUp = () => { s.drag = null; s.pan = null; };
    const onClick = (e) => {
      const m = pos(e);
      const n = pick(m.x, m.y);
      setSelected(n ? (selected === n.id ? null : n.id) : null);
    };
    const onWheel = (e) => {
      e.preventDefault();
      const m = pos(e);
      zoomAt(m.x, m.y, e.deltaY < 0 ? 1.12 : 0.89);
    };
    const zoomAt = (mx, my, f) => {
      const ns = Math.min(4, Math.max(0.3, s.scale * f));
      s.offset.x = mx - ((mx - s.offset.x) / s.scale) * ns;
      s.offset.y = my - ((my - s.offset.y) / s.scale) * ns;
      s.scale = ns;
    };

    // pinch zoom
    const touches = (e) => [...e.touches].map((t) => {
      const r = canvas.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    });
    const onTouchStart = (e) => {
      if (e.touches.length === 2) {
        const [a, b] = touches(e);
        s.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
        s.drag = null; s.pan = null;
      }
    };
    const onTouchMove = (e) => {
      if (e.touches.length === 2 && s.pinch) {
        e.preventDefault();
        const [a, b] = touches(e);
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        zoomAt(s.pinch.cx, s.pinch.cy, dist / (s.pinch.dist || 1));
        s.pinch.dist = dist;
      }
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("touchstart", onTouchStart, { passive: true });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
    };
  }, [nodes, edges, selected]);

  const selNode = nodes.find((n) => n.id === selected);

  return (
    <div className="h-screen flex flex-col">
      <Nav />
      <main className="flex-1 relative min-h-0">
        <canvas ref={canvasRef} className="w-full h-full touch-none" />
        {loaded && nodes.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-zinc-600 px-6 text-center">
            <GraphGlyph />
            <span className="text-sm">No concepts yet — capture some notes first.</span>
          </div>
        )}
        {selNode && (
          <div className="absolute top-4 right-4 left-4 sm:left-auto card !bg-[#101013]/95 backdrop-blur p-4 sm:w-64 fade-up">
            <div className="flex items-center gap-2.5">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: selNode.color }} />
              <span className="font-semibold text-sm truncate">{selNode.id}</span>
            </div>
            <div className="text-[11px] text-zinc-500 mt-1 capitalize">{selNode.subject}</div>
            <button onClick={() => setSelected(null)} className="btn btn-ghost w-full mt-3 !py-2 !text-xs">Clear</button>
          </div>
        )}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 pill text-zinc-500 pointer-events-none hidden md:flex">
          drag · scroll to zoom · click to focus
        </div>
      </main>
    </div>
  );
}

const GraphGlyph = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="6" cy="6" r="2.6" /><circle cx="18" cy="8" r="2.6" /><circle cx="12" cy="18" r="2.6" />
    <path d="M8.3 7 15.4 7.9M7 8.4l3.8 7.3M16.8 10.4l-3.3 5.4" strokeLinecap="round" />
  </svg>
);
