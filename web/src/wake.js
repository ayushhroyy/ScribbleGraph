/* On-device wake word ("Scribble") — log-mel spectrograms + DTW template match.
   No model download, no API calls: utterances leave the browser only after
   the wake word is recognized locally. */

const SR = 16000, NFFT = 512, HOP = 160, MELS = 26;
const PREFIX_CAP_S = 1.35; // template-match only the utterance prefix

/* ---------- dsp primitives ---------- */

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m) => 700 * (10 ** (m / 2595) - 1);

let FILTERBANK = null;
function filterbank() {
  if (FILTERBANK) return FILTERBANK;
  const nb = NFFT / 2 + 1, fmin = 80, fmax = 4000;
  const mmin = hz2mel(fmin), mmax = hz2mel(fmax);
  const hz = [];
  for (let i = 0; i < MELS + 2; i++) hz.push(mel2hz(mmin + ((mmax - mmin) * i) / (MELS + 1)));
  const bins = hz.map((f) => Math.min(nb - 1, Math.floor((f * NFFT) / SR)));
  const fb = Array.from({ length: MELS }, () => new Float32Array(nb));
  for (let m = 0; m < MELS; m++) {
    const a = bins[m], b = bins[m + 1], c = bins[m + 2];
    for (let k = a; k <= b && k < nb; k++) fb[m][k] = (k - a) / (b - a || 1);
    for (let k = b + 1; k <= c && k < nb; k++) fb[m][k] = (c - k) / (c - b || 1);
  }
  FILTERBANK = fb;
  return fb;
}

const HAMM = Array.from({ length: NFFT }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (NFFT - 1)));

/* ---------- feature extraction ---------- */

function specOf(pcm, frameCap) {
  const fb = filterbank();
  const nb = NFFT / 2 + 1;
  const frames = [];
  for (let start = 0; start + NFFT <= pcm.length && frames.length < frameCap; start += HOP) {
    const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
    for (let i = 0; i < NFFT; i++) re[i] = pcm[start + i] * HAMM[i];
    fft(re, im);
    const mel = new Float32Array(MELS);
    for (let m = 0; m < MELS; m++) {
      let e = 0;
      for (let k = 0; k < nb; k++) e += fb[m][k] * (re[k] * re[k] + im[k] * im[k]);
      mel[m] = Math.log(e + 1e-10);
    }
    frames.push(mel);
  }
  if (!frames.length) return frames;
  // cmvn (per-mel-dim mean/variance normalize) → speaker/level robust
  for (let m = 0; m < MELS; m++) {
    let mean = 0;
    for (const f of frames) mean += f[m];
    mean /= frames.length;
    let va = 0;
    for (const f of frames) va += (f[m] - mean) ** 2;
    va = Math.sqrt(va / frames.length + 1e-6);
    for (const f of frames) f[m] = (f[m] - mean) / va;
  }
  return frames;
}

function resample(input, from, to) {
  if (from === to) return input;
  const n = Math.floor((input.length * to) / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = (i * from) / to;
    const i0 = Math.floor(pos), i1 = Math.min(input.length - 1, i0 + 1);
    out[i] = input[i0] + (input[i1] - input[i0]) * (pos - i0);
  }
  return out;
}

function trimSilence(pcm) {
  const FL = 160, TH = 0.012;
  let first = -1, last = -1;
  for (let i = 0; i + FL <= pcm.length; i += FL) {
    let s = 0;
    for (let k = 0; k < FL; k++) s += pcm[i + k] * pcm[i + k];
    if (Math.sqrt(s / FL) > TH) { if (first < 0) first = i; last = i + FL; }
  }
  if (first < 0) return { pcm, dur: 0 };
  return { pcm: pcm.subarray(first, last), dur: (last - first) / SR };
}

/* ---------- DTW ---------- */

function fdist(u, v) {
  let s = 0;
  for (let k = 0; k < u.length; k++) s += (u[k] - v[k]) ** 2;
  return Math.sqrt(s);
}

function dtw(a, b) {
  const n = a.length, m = b.length;
  if (!n || !m) return 99;
  const band = Math.max(10, Math.floor(0.3 * Math.max(n, m)));
  const INF = 1e9;
  let prev = new Float64Array(m + 1).fill(INF);
  let cur = new Float64Array(m + 1).fill(INF);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(INF); cur[0] = INF;
    const lo = Math.max(1, i - band), hi = Math.min(m, i + band);
    for (let j = lo; j <= hi; j++) {
      const d = fdist(a[i - 1], b[j - 1]);
      cur[j] = d + Math.min(prev[j], cur[j - 1], prev[j - 1]);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[m] / (n + m);
}

/* ---------- public api ---------- */

export async function blobToSpec(blob, capSec = PREFIX_CAP_S) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    await ctx.close().catch(() => {});
    let pcm = Float32Array.from(buf.getChannelData(0));
    pcm = resample(pcm, buf.sampleRate, SR);
    const t = trimSilence(pcm);
    if (!t.dur) return null;
    return { spec: specOf(t.pcm, Math.floor((capSec * SR) / HOP)), dur: t.dur };
  } catch {
    return null; // undecodable container → caller falls back to STT text check
  }
}

export async function enrollFromBlobs(blobs) {
  const specs = [];
  for (const b of blobs) {
    const r = await blobToSpec(b, 2.0);
    if (r && r.spec.length >= 20) specs.push(r.spec);
  }
  if (specs.length < 2) return null;
  // threshold = a bit above the worst pairwise distance between samples
  const pair = [];
  for (let i = 0; i < specs.length; i++)
    for (let j = i + 1; j < specs.length; j++) pair.push(dtw(specs[i], specs[j]));
  const thr = Math.min(20, Math.max(4, Math.max(...pair) * 1.7 + 1));
  return { templates: specs.map((s) => Array.from(s, (f) => Array.from(f))), thr };
}

export async function isWakeWord(blob, wake) {
  const r = await blobToSpec(blob);
  if (!r) return { hit: false, undecoded: true, dur: 0 };
  const spec = r.spec.map((f) => Float32Array.from(f));
  if (spec.length < 12) return { hit: false, undecoded: false, dur: r.dur }; // too short to be the word
  let best = 1e9;
  for (const t of wake.templates) best = Math.min(best, dtw(spec, t.map((f) => Float32Array.from(f))));
  return { hit: best <= wake.thr, score: best, dur: r.dur, undecoded: false };
}

/* ---------- storage ---------- */

export function saveWake(data) {
  try { localStorage.setItem("sg.wake", JSON.stringify(data)); } catch {}
}
export function loadWake() {
  try {
    const d = JSON.parse(localStorage.getItem("sg.wake"));
    if (d?.templates?.length >= 2 && d.thr) return d;
  } catch {}
  return null;
}
export function clearWake() {
  try { localStorage.removeItem("sg.wake"); } catch {}
}
