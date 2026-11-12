"""Generates design/brand/dexbot-identity-v1.svg from the app's own bot-face geometry.

Eye geometry is copied from BotFaceGeometry in
android/app/src/main/kotlin/com/openmausbot/companion/ui/BotFace.kt, so the
brand face and the in-app face stay one drawing.
"""

import math
from pathlib import Path

W, H = 1600, 1420
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


def icon(x, y, size, variant, uid):
    s = size / 1024
    if variant == "tight":
        cx, cy, R = 580, 640, 560
    elif variant == "mid":
        cx, cy, R = 540, 580, 500
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


def o_wordmark(x, y, size, fill=INK, eye="#FFFFFF"):
    # measured at 100px: DEX B = 312.19, O advance = 82.5
    wb = 312.19 / 100 * size
    o_adv = 82.5 / 100 * size
    d = 78 / 100 * size
    cy = y - 35.5 / 100 * size
    parts = [text(x, y, "DEX B", size, 800, fill, 1.5)]
    parts.append(face(x + wb + d / 2, cy, d / 2, body="graphite", eye=eye))
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
svg.append(text(64, 70, "DEX BOT  /  IDENTITY 01", 14, 700, MUTED, 4))
svg.append(text(64, 146, "One circle. Two eyes.", 58, 800, INK, -1))
svg.append(text(64, 188, "The identity is the app’s own bot face: a flat disc, two tilted pills, no mouth. Black and white only.", 18, 400, MUTED))
svg.append(text(1536, 70, "2026  ·  v1", 14, 500, MUTED, 2, "end"))

# section 1
svg.append(text(64, 252, "01  ·  ICON", 13, 700, MUTED, 3))
svg.append(f'<line x1="64" y1="268" x2="1536" y2="268" stroke="{RULE}" stroke-width="1"/>')
labels = [("tight", "A · TIGHT", "the reference crop"), ("mid", "B · BALANCED", "more of the face"), ("full", "C · FULL MARK", "no crop, clearest")]
for i, (v, lab, sub) in enumerate(labels):
    x = 64 + i * 264
    svg.append(icon(x, 296, 240, v, f"clip-{v}"))
    svg.append(text(x, 566, lab, 15, 700, INK, 1))
    svg.append(text(x, 588, sub, 13, 400, MUTED))
svg.append(icon(940, 296, 260, "tight", "clip-hero"))
svg.append(text(1236, 338, "The bot is the icon.", 26, 800, INK, -0.5))
svg.append(text(1236, 372, "The face bleeds off the tile;", 15, 400, MUTED))
svg.append(text(1236, 394, "the black does the framing.", 15, 400, MUTED))
svg.append(text(1236, 440, "48 / 32 / 16 px", 12, 700, MUTED, 2))
svg.append(icon(1236, 456, 48, "tight", "clip-16"))
svg.append(icon(1296, 456, 32, "tight", "clip-32"))
svg.append(icon(1340, 456, 16, "tight", "clip-48"))

# section 2
svg.append(text(64, 660, "02  ·  LOCKUP", 13, 700, MUTED, 3))
svg.append(f'<line x1="64" y1="676" x2="1536" y2="676" stroke="{RULE}" stroke-width="1"/>')
svg.append(mark(64, 712, 96, body="graphite", eye="#FFFFFF"))
svg.append(plain_wordmark(196, 784, 70))
svg.append(text(64, 878, "HORIZONTAL  /  POSITIVE", 12, 700, MUTED, 2))

svg.append('<rect x="836" y="700" width="700" height="190" rx="24" fill="#000"/>')
svg.append(mark(872, 738, 72, body="cream"))
svg.append(plain_wordmark(980, 800, 60, "#FFFFFF"))
svg.append(text(872, 878, "REVERSED  /  WHITE ON BLACK", 12, 700, MUTED, 2))

# section 3
svg.append(text(64, 960, "03  ·  WORDMARK", 13, 700, MUTED, 3))
svg.append(f'<line x1="64" y1="976" x2="1536" y2="976" stroke="{RULE}" stroke-width="1"/>')
svg.append(text(64, 1014, "A  /  plain", 13, 700, MUTED, 1))
svg.append(plain_wordmark(64, 1094, 84))
svg.append(text(816, 1014, "B  /  the O is the bot", 13, 700, MUTED, 1))
svg.append(o_wordmark(816, 1094, 84))
svg.append(text(64, 1140, "Two eyes only. No mouth: the face carries attention, not expression.", 15, 400, MUTED))

# expression band
svg.append('<rect x="0" y="1180" width="1600" height="240" fill="#000"/>')
svg.append(text(64, 1222, "04  ·  FACE  /  ATTENTION, NOT EXPRESSION", 12, 700, "#8C8C88", 3))
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
    svg.append(face(cx, 1290, 52, op, gz))
    svg.append(text(cx, 1388, name, 12, 700, "#8C8C88", 2, "middle"))

svg.append("</svg>")
Path("design/brand/dexbot-identity-v1.svg").write_text("".join(svg))
