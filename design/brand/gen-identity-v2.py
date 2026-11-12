"""Generates design/brand/dexbot-identity-v2.svg from the app's own bot-face geometry.

Eye geometry is copied from BotFaceGeometry in
android/app/src/main/kotlin/com/openmausbot/companion/ui/BotFace.kt, so the
brand face and the in-app face stay one drawing.

v2: A crop with more left margin, white-on-black as the primary lockup, and
the O-as-bot wordmark as the chosen wordmark.
"""

import math
from pathlib import Path

W, H = 1600, 1520
INK, MUTED, RULE = "#0A0A0A", "#6E6E6A", "#DADAD4"
CREAM, EYE = "#F7F3ED", "#1C1C1E"

TILT = math.radians(-19.1)
EYE_TILT = math.radians(-19.1 + 2.4)
OFFSET, DROP = 0.342, -0.150
LEN, WID = 0.245, 0.125


def face(cx, cy, R, open_=(1, 1), gaze=(0, 0), body="cream", eye=EYE):
    fill = "url(#cream)" if body == "cream" else "url(#graphite)"
    parts = [f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{R:.3f}" fill="{fill}"/>']
    c, s = math.cos(TILT), math.sin(TILT)
    gx = gaze[0] * R * c - gaze[1] * R * s
    gy = gaze[0] * R * s + gaze[1] * R * c
    for side, o in ((-1, open_[0]), (1, open_[1])):
        ox = side * OFFSET * R * c + gx
        oy = DROP * R + side * OFFSET * R * s + gy
        w, h = WID * 2 * R, max(LEN * 2 * R * o, WID * 2 * R * 0.34)
        parts.append(
            f'<g transform="rotate({math.degrees(EYE_TILT):.3f} {cx + ox:.3f} {cy + oy:.3f})">'
            f'<rect x="{cx + ox - w / 2:.3f}" y="{cy + oy - h / 2:.3f}" width="{w:.3f}" height="{h:.3f}" '
            f'rx="{w / 2:.3f}" fill="{eye}"/></g>'
        )
    return "".join(parts)


def flat_face(cx, cy, R, fill, eye=EYE):
    parts = [f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{R:.3f}" fill="{fill}"/>']
    c, s = math.cos(TILT), math.sin(TILT)
    for side in (-1, 1):
        ox = side * OFFSET * R * c
        oy = DROP * R + side * OFFSET * R * s
        w, h = WID * 2 * R, LEN * 2 * R
        parts.append(
            f'<g transform="rotate({math.degrees(EYE_TILT):.3f} {cx + ox:.3f} {cy + oy:.3f})">'
            f'<rect x="{cx + ox - w / 2:.3f}" y="{cy + oy - h / 2:.3f}" width="{w:.3f}" height="{h:.3f}" '
            f'rx="{w / 2:.3f}" fill="{eye}"/></g>'
        )
    return "".join(parts)


def icon(x, y, size, variant, uid):
    s = size / 1024
    if variant == "tight":
        cx, cy, R = 650, 650, 560
    elif variant == "mid":
        cx, cy, R = 560, 600, 500
    else:
        cx, cy, R = 512, 512, 400
    body = face(cx, cy, R)
    return (
        f'<g transform="translate({x} {y}) scale({s})">'
        f'<defs><clipPath id="{uid}"><rect width="1024" height="1024" rx="224"/></clipPath></defs>'
        f'<rect width="1024" height="1024" rx="224" fill="#000"/>'
        f'<g clip-path="url(#{uid})">{body}</g></g>'
    )


def mark(x, y, d, body="cream", eye=EYE):
    return face(x + d / 2, y + d / 2, d / 2, body=body, eye=eye)


def text(x, y, txt, size, weight=400, fill=INK, tracking=0, anchor="start", family="Avenir Next, Helvetica Neue, sans-serif"):
    return (
        f'<text x="{x}" y="{y}" font-family="{family}" font-size="{size}" font-weight="{weight}" '
        f'letter-spacing="{tracking}" fill="{fill}" text-anchor="{anchor}">{txt}</text>'
    )


def plain_wordmark(x, y, size, fill=INK, tracking=1.5):
    return text(x, y, "DEX BOT", size, 800, fill, tracking)


def o_wordmark(x, y, size, fill=INK, body="graphite", eye="#FFFFFF"):
    # measured at 100px: DEX B = 312.19, O advance = 82.5
    wb = 312.19 / 100 * size
    o_adv = 82.5 / 100 * size
    d = 78 / 100 * size
    cy = y - 35.5 / 100 * size
    parts = [text(x, y, "DEX B", size, 800, fill, 1.5)]
    parts.append(flat_face(x + wb + d / 2, cy, d / 2, fill=("#F7F3ED" if body == "cream" else "#0A0A0A"), eye=eye))
    parts.append(text(x + wb + o_adv, y, "T", size, 800, fill, 1.5))
    return "".join(parts)


svg = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">']
svg.append(
    f'''<defs>
<radialGradient id="cream" cx="0.31" cy="0.16" r="0.78">
  <stop offset="0" stop-color="#FCFAF6"/><stop offset="0.55" stop-color="{CREAM}"/><stop offset="1" stop-color="#D6D2CA"/>
</radialGradient>
<radialGradient id="graphite" cx="0.31" cy="0.16" r="0.78">
  <stop offset="0" stop-color="#2C2C2C"/><stop offset="0.55" stop-color="#111111"/><stop offset="1" stop-color="#000000"/>
</radialGradient>
</defs>'''
)
svg.append(f'<rect width="{W}" height="{H}" fill="#F4F4F2"/>')

# header
svg.append(text(64, 70, "DEX BOT  /  IDENTITY 02", 14, 700, MUTED, 4))
svg.append(text(64, 146, "One circle. Two eyes.", 58, 800, INK, -1))
svg.append(text(64, 188, "The app’s own bot face: a flat disc, two tilted pills, no mouth. White on black, and nothing else.", 18, 400, MUTED))
svg.append(text(1536, 70, "2026  ·  v2", 14, 500, MUTED, 2, "end"))

# section 1
svg.append(text(64, 252, "01  ·  ICON", 13, 700, MUTED, 3))
svg.append(f'<line x1="64" y1="268" x2="1536" y2="268" stroke="{RULE}" stroke-width="1"/>')
labels = [("tight", "A · TIGHT", "chosen · more left margin"), ("mid", "B · BALANCED", "more of the face"), ("full", "C · FULL MARK", "no crop, clearest")]
for i, (v, lab, sub) in enumerate(labels):
    x = 64 + i * 254
    svg.append(icon(x, 296, 230, v, f"clip-{v}"))
    svg.append(text(x, 556, lab, 15, 700, INK, 1))
    svg.append(text(x, 578, sub, 13, 400, MUTED))
svg.append(icon(920, 296, 280, "tight", "clip-hero"))
svg.append(text(1232, 338, "The bot is the icon.", 26, 800, INK, -0.5))
svg.append(text(1232, 372, "White face, black frame.", 15, 400, MUTED))
svg.append(text(1232, 394, "One shape, no second colour.", 15, 400, MUTED))
svg.append(text(1232, 440, "48 / 32 / 16 px", 12, 700, MUTED, 2))
svg.append(icon(1232, 456, 48, "tight", "clip-16"))
svg.append(icon(1292, 456, 32, "tight", "clip-32"))
svg.append(icon(1336, 456, 16, "tight", "clip-48"))

# section 2: primary lockup, white on black
svg.append(text(64, 660, "02  ·  LOCKUP", 13, 700, MUTED, 3))
svg.append(f'<line x1="64" y1="676" x2="1536" y2="676" stroke="{RULE}" stroke-width="1"/>')
svg.append('<rect x="64" y="704" width="1472" height="210" rx="28" fill="#000"/>')
svg.append(mark(110, 754, 110, body="cream"))
svg.append(plain_wordmark(252, 838, 78, CREAM))
svg.append(text(64, 950, "PRIMARY  /  WHITE ON BLACK", 12, 700, MUTED, 2))
svg.append(text(1100, 826, "The face is the mark.", 15, 400, "#8C8C88"))
svg.append(text(1100, 850, "The wordmark is the name.", 15, 400, "#8C8C88"))

# section 3: wordmark, white on black cards
svg.append(text(64, 1010, "03  ·  WORDMARK", 13, 700, MUTED, 3))
svg.append(f'<line x1="64" y1="1026" x2="1536" y2="1026" stroke="{RULE}" stroke-width="1"/>')
svg.append(text(64, 1064, "A  /  plain", 13, 700, MUTED, 1))
svg.append(text(808, 1064, "B  /  the O is the bot", 13, 700, MUTED, 1))
svg.append('<rect x="64" y="1082" width="700" height="190" rx="24" fill="#000"/>')
svg.append(plain_wordmark(104, 1192, 80, CREAM))
svg.append('<rect x="808" y="1082" width="728" height="190" rx="24" fill="#000"/>')
svg.append(o_wordmark(848, 1192, 80, CREAM, body="cream", eye=EYE))
svg.append(text(64, 1310, "Two eyes only. No mouth: the face carries attention, not expression.", 15, 400, MUTED))

# expression band
svg.append('<rect x="0" y="1348" width="1600" height="172" fill="#000"/>')
svg.append(text(64, 1388, "04  ·  FACE  /  ATTENTION, NOT EXPRESSION", 12, 700, "#8C8C88", 3))
expressions = [
    ("idle", (1, 1), (0, 0)),
    ("blink", (0.1, 0.1), (0, 0)),
    ("wink", (0.1, 1), (0, 0)),
    ("thinking", (0.72, 0.72), (-0.06, -0.06)),
    ("working", (0.58, 0.58), (0, 0)),
    ("sleepy", (0.1, 0.1), (0, 0.05)),
]
for i, (name, op, gz) in enumerate(expressions):
    cx = 160 + i * 256
    svg.append(face(cx, 1440, 42, op, gz))
    svg.append(text(cx, 1506, name, 11, 700, "#8C8C88", 2, "middle"))

svg.append("</svg>")
Path("design/brand/dexbot-identity-v2.svg").write_text("".join(svg))
