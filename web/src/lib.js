export async function api(path, opts = {}) {
  const isForm = opts.body instanceof FormData;
  const res = await fetch(path, {
    ...opts,
    headers: isForm ? {} : { "Content-Type": "application/json" },
    body: isForm ? opts.body : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.json())?.error ?? "";
    } catch {}
    throw new Error(detail || `${res.status}`);
  }
  return res.json();
}

export function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** create a session and upload an ordered list of image files */
export async function uploadSession(files, onProgress) {
  const { id } = await api("/api/sessions", { method: "POST" });
  let i = 0;
  for (const f of files) {
    const fd = new FormData();
    fd.append("file", f, f.name || `page-${i}.jpg`);
    await api(`/api/sessions/${id}/pages`, { method: "POST", body: fd });
    onProgress?.(++i, files.length);
  }
  return id;
}

export function blip(freq = 920) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = Ctx ? new Ctx() : null;
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.22);
  } catch {}
}

export const buzz = (p = 30) => navigator.vibrate?.(p);

export const PAGE_STATUS = {
  queued: { label: "Queued", color: "#a1a1aa" },
  ocr: { label: "Reading", color: "#fbbf24" },
  embedded: { label: "Linking", color: "#38bdf8" },
  done: { label: null, color: null },
  error: { label: "Failed", color: "#f87171" },
};
