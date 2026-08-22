#!/usr/bin/env python3
"""Generate per-asset HTML files for transparent PNG export."""
import html, json, os, pathlib

ROOT = pathlib.Path("/Users/ayush/Desktop/ScribbleGraph/presentation")
SHOTS = ROOT / "shots"
TMP = pathlib.Path("/tmp/sg-assets")
TMP.mkdir(exist_ok=True)

VISUALS = {
  "home": {
    "img": "home.png", "h": 760,
    "callouts": [("1","Capture","start a scan from camera or photos"),
                 ("2","Your sessions","each capture becomes a titled note card"),
                 ("3","Stats","pages, concepts and cross-links found so far")],
  },
  "session": {
    "img": "session.png", "h": 760,
    "callouts": [("1","Live progress","each page shows its pipeline stage"),
                 ("2","OCR confidence","handwriting quality scored per page"),
                 ("3","Auto-titled","AI names the session from its content")],
  },
  "note": {
    "img": "note.png", "h": 760,
    "callouts": [("1","Original scan","always kept, clickable regions"),
                 ("2","Extracted text","editable if OCR misreads a word"),
                 ("3","Related notes","cards linking to other days")],
  },
  "graph": {
    "img": "graph.png", "h": 760,
    "callouts": [("1","Nodes","concepts the AI found in your notes"),
                 ("2","Colors","grouped by subject (math, physics, circuits…)"),
                 ("3","Lines","concepts that appear together in your pages")],
  },
  "ask": {
    "img": "ask.png", "h": 760,
    "callouts": [("1","Answer","written only from your own notes, not the internet"),
                 ("2","Sources","every answer cites the exact page and day it came from")],
  },
  "quiz": {
    "img": "quiz.png", "h": 760,
    "callouts": [("1","Pick a session","questions are generated from those pages"),
                 ("2","Explanations","each answer is explained using your own notes")],
  },
  "cards": {
    "img": "cards.png", "h": 760,
    "callouts": [("1","Tap to flip","question front, answer back"),
                 ("2","Spaced repetition","missed cards return sooner, knew-it cards later")],
  },
}

HEADLINES = [
  ("01", None, "ScribbleGraph"),
  ("02", "The problem", "Your best notes are trapped on paper."),
  ("03", "The app · home", "Everything in one place."),
  ("04", "Step 1 · capture", "Just flip the pages. The camera does the rest."),
  ("05", "Step 2 · process", "Every page gets digitized in seconds."),
  ("06", "Step 3 · read", "Scan and text, side by side."),
  ("07", "The magic", "It remembers what you wrote 2 weeks ago."),
  ("08", "Step 4 · explore", "Your whole subject, as a map."),
  ("09", "Step 5 · ask", "Ask your notes anything."),
  ("10", "Step 6 · study", "It turns your notes into a quiz."),
  ("11", "Step 6 · study", "And flashcards that repeat what you forget."),
  ("12", "How it's built", "Simple stack. Real product. Live today."),
]

FONT = "-apple-system,'Segoe UI',Inter,sans-serif"

def visual_html(name, d):
    cos = "".join(
        f'''<span style="display:inline-flex;align-items:center;gap:8px;color:#e4e4e7;font-size:15px;white-space:nowrap">
<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:99px;background:#7c6cff;color:#fff;font-size:12px;font-weight:700">{n}</span>
<b style="color:#a99fff;font-weight:700">{html.escape(t)}</b>&nbsp;—&nbsp;{html.escape(s)}</span>'''
        for n, t, s in d["callouts"])
    return f'''<!doctype html><html><head><style>html,body{{margin:0;background:transparent}}</style></head>
<body style="font-family:{FONT}">
<div style="display:flex;flex-direction:column;align-items:center;gap:22px;padding:16px;width:1228px">
<img src="file://{SHOTS}/{d['img']}" style="max-width:1196px;max-height:560px;border-radius:14px;border:1px solid rgba(255,255,255,.12);box-shadow:0 26px 70px rgba(0,0,0,.5)">
<div style="display:flex;gap:28px;flex-wrap:wrap;justify-content:center;max-width:1150px">{cos}</div>
</div></body></html>'''

def text_html(kicker, headline, dark=False):
    ink = "#18181b" if dark else "#fafafa"
    kick = "#7c6cff" if dark else "#a99fff"
    k = f'<div style="color:{kick};font-size:15px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;margin-bottom:10px">{html.escape(kicker)}</div>' if kicker else ""
    return f'''<!doctype html><html><head><style>html,body{{margin:0;background:transparent}}</style></head>
<body style="font-family:{FONT}">
<div style="display:inline-block;padding:18px 22px">{k}
<div style="font-size:46px;font-weight:800;letter-spacing:-.02em;line-height:1.15;color:{ink};white-space:nowrap">{html.escape(headline)}</div>
</div></body></html>'''

manifest = []
for name, d in VISUALS.items():
    p = TMP / f"v-{name}.html"
    p.write_text(visual_html(name, d))
    manifest.append({"file": f"{name}-visual.png", "html": str(p), "w": 1260, "h": d["h"]})

for num, kicker, headline in HEADLINES:
    for variant, dark in (("white", False), ("dark", True)):
        p = TMP / f"t-{num}-{variant}.html"
        p.write_text(text_html(kicker, headline, dark))
        manifest.append({"file": f"{num}-{headline.split('.')[0][:24].strip().replace(' ','-').lower()}-{variant}.png",
                         "html": str(p), "w": 1100, "h": 160})

(TMP / "manifest.json").write_text(json.dumps(manifest, indent=1))
print(f"{len(manifest)} assets prepared")
for m in manifest:
    print(" ", m["file"])
