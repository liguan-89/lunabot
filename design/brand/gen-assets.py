"""Builds the self-contained Luna Bot brand vectors from the app's bot-face geometry.

Run: python3 design/brand/gen-assets.py
Outputs SVGs next to this script; no font dependency (the wordmark is outlined).
"""

import math
from pathlib import Path

from fontTools.ttLib import TTCollection, TTFont
from fontTools.pens.svgPathPen import SVGPathPen

HERE = Path(__file__).resolve().parent
FONT_TTC = "/System/Library/Fonts/Avenir Next.ttc"

INK = "#0A0A0A"
CREAM = "#F7F3ED"
EYE = "#1C1C1E"

TILT = math.radians(-19.1)
EYE_TILT = math.radians(-19.1 + 2.4)
OFFSET, DROP = 0.342, -0.150
LEN, WID = 0.245, 0.125

CAP = 708
WORD = "LUNA BOT"
O_INDEX = 6  # L U N A space B O T


def heavy_font() -> TTFont:
    collection = TTCollection(FONT_TTC)
    for font in collection.fonts:
        if font["name"].getDebugName(4) == "Avenir Next Heavy":
            return font
    raise RuntimeError("Avenir Next Heavy not found")


FONT = heavy_font()
CMAP = FONT.getBestCmap()
GLYPHS = FONT.getGlyphSet()
HMTX = FONT["hmtx"]


def glyph_paths(text: str):
    """Return (svg, advances) for text in font units, baseline at y=0, y-down."""
    x = 0.0
    parts = []
    advances = []
    for ch in text:
        name = CMAP[ord(ch)]
        pen = SVGPathPen(GLYPHS)
        GLYPHS[name].draw(pen)
        parts.append(f'<path transform="translate({x:.3f} {CAP}) scale(1 -1)" d="{pen.getCommands()}"/>')
        advances.append(HMTX[name][0])
        x += HMTX[name][0]
    return "".join(parts), advances, x


WORD_SVG, ADV, WORD_W = glyph_paths(WORD)
O_X = sum(ADV[:O_INDEX])
O_ADV = ADV[O_INDEX]
DEXB_X = sum(ADV[:O_INDEX])


def eye_geometry(cx, cy, R):
    c, s = math.cos(TILT), math.sin(TILT)
    eyes = []
    for side in (-1, 1):
        ox = side * OFFSET * R * c
        oy = DROP * R + side * OFFSET * R * s
        w, h = WID * 2 * R, LEN * 2 * R
        eyes.append((cx + ox, cy + oy, w, h))
    return eyes


def face(cx, cy, R, body="cream", eye=EYE, uid="face"):
    fill = "url(#cream)" if body == "cream" else "url(#graphite)"
    parts = [f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{R:.3f}" fill="{fill}"/>']
    for ex, ey, w, h in eye_geometry(cx, cy, R):
        parts.append(
            f'<g transform="rotate({math.degrees(EYE_TILT):.3f} {ex:.3f} {ey:.3f})">'
            f'<rect x="{ex - w / 2:.3f}" y="{ey - h / 2:.3f}" width="{w:.3f}" height="{h:.3f}" '
            f'rx="{w / 2:.3f}" fill="{eye}"/></g>'
        )
    return "".join(parts)


def flat_face(cx, cy, R, fill, eye=EYE):
    """The wordmark O: a flat disc, so it reads as a letter rather than a ball."""
    parts = [f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{R:.3f}" fill="{fill}"/>']
    for ex, ey, w, h in eye_geometry(cx, cy, R):
        parts.append(
            f'<g transform="rotate({math.degrees(EYE_TILT):.3f} {ex:.3f} {ey:.3f})">'
            f'<rect x="{ex - w / 2:.3f}" y="{ey - h / 2:.3f}" width="{w:.3f}" height="{h:.3f}" '
            f'rx="{w / 2:.3f}" fill="{eye}"/></g>'
        )
    return "".join(parts)


def mono_face(cx, cy, R, uid="mono"):
    """One-colour face: the disc and the two pills are one even-odd path, so the
    eyes are true holes (a mask is not reliable in every SVG rasteriser)."""
    def rot(px, py):
        c, s = math.cos(EYE_TILT), math.sin(EYE_TILT)
        return cx + px * c - py * s, cy + px * s + py * c

    d = [
        f"M {cx - R:.3f} {cy:.3f} A {R:.3f} {R:.3f} 0 1 0 {cx + R:.3f} {cy:.3f} "
        f"A {R:.3f} {R:.3f} 0 1 0 {cx - R:.3f} {cy:.3f} Z"
    ]
    for ex, ey, w, h in eye_geometry(cx, cy, R):
        r = w / 2
        half = (h - w) / 2
        tx, ty = ex - cx, ey - cy
        pts = [rot(tx - r, ty - half), rot(tx + r, ty - half), rot(tx + r, ty + half), rot(tx - r, ty + half)]
        d.append(
            f"M {pts[0][0]:.3f} {pts[0][1]:.3f} A {r:.3f} {r:.3f} 0 0 1 {pts[1][0]:.3f} {pts[1][1]:.3f} "
            f"L {pts[2][0]:.3f} {pts[2][1]:.3f} A {r:.3f} {r:.3f} 0 0 1 {pts[3][0]:.3f} {pts[3][1]:.3f} Z"
        )
    return f'<path fill="currentColor" fill-rule="evenodd" d="{" ".join(d)}"/>'


DEFS = f'''<defs>
<radialGradient id="cream" cx="0.31" cy="0.16" r="0.78">
  <stop offset="0" stop-color="#FCFAF6"/><stop offset="0.55" stop-color="{CREAM}"/><stop offset="1" stop-color="#D6D2CA"/>
</radialGradient>
<radialGradient id="graphite" cx="0.31" cy="0.16" r="0.78">
  <stop offset="0" stop-color="#2C2C2C"/><stop offset="0.55" stop-color="#111111"/><stop offset="1" stop-color="#000000"/>
</radialGradient>
</defs>'''


def svg(viewbox, body, width=None, height=None):
    size = f' width="{width}" height="{height}"' if width else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{viewbox}"{size}>{body}</svg>'


def write(name, content):
    (HERE / name).write_text(content)
    print("wrote", name)


# --- wordmarks -------------------------------------------------------------
write("wordmark-plain.svg", svg(f"0 -30 {WORD_W:.0f} {CAP + 60:.0f}", DEFS + f'<g fill="currentColor">{WORD_SVG}</g>'))

# O as the bot face, replacing the O glyph
o_d = 720
o_left = O_X + (O_ADV - o_d) / 2
o_center = (o_left + o_d / 2, CAP / 2)
def o_wordmark(text_color, body, eye, uid):
    luna_b, _, _ = glyph_paths("LUNA B")
    t_pen = SVGPathPen(GLYPHS)
    GLYPHS[CMAP[ord("T")]].draw(t_pen)
    return (
        f'<g fill="{text_color}">{luna_b}'
        f'<path transform="translate({O_X + O_ADV:.3f} {CAP}) scale(1 -1)" d="{t_pen.getCommands()}"/></g>'
        + flat_face(o_center[0], o_center[1], o_d / 2, fill=("#F7F3ED" if body == "cream" else "#0A0A0A"), eye=eye)
    )


write("wordmark-o-white.svg", svg(f"0 -30 {WORD_W:.0f} {CAP + 60:.0f}", DEFS + o_wordmark(CREAM, "cream", EYE, "o-white")))
write("wordmark-o-black.svg", svg(f"0 -30 {WORD_W:.0f} {CAP + 60:.0f}", DEFS + o_wordmark(INK, "graphite", "#FFFFFF", "o-black")))

# --- marks -----------------------------------------------------------------
MARK = 1000
write("mark-white.svg", svg(f"0 0 {MARK} {MARK}", DEFS + face(500, 500, 500, "cream", EYE, "markw")))
write("mark-black.svg", svg(f"0 0 {MARK} {MARK}", DEFS + face(500, 500, 500, "graphite", "#FFFFFF", "markb")))
write("mark-mono.svg", svg(f"0 0 {MARK} {MARK}", mono_face(500, 500, 500, "markm")))

# --- lockups ---------------------------------------------------------------
LOCK_MARK = 1050
LOCK_GAP = 400
LOCK_W = LOCK_MARK + LOCK_GAP + WORD_W
LOCK_H = 1050
LOCK_TOP = -171


def lockup(text_color, body, eye, uid, plain=True):
    body_svg = face(LOCK_MARK / 2, CAP / 2, LOCK_MARK / 2, body=body, eye=eye, uid=uid)
    word = f'<g fill="{text_color}">{WORD_SVG}</g>'
    return svg(
        f"0 {LOCK_TOP} {LOCK_W:.0f} {LOCK_H}",
        DEFS + f'<g transform="translate({LOCK_MARK + LOCK_GAP:.3f} 0)">{word}</g>' + body_svg,
    )


write("lockup-white.svg", lockup(CREAM, "cream", EYE, "lockw"))
write("lockup-black.svg", lockup(INK, "graphite", "#FFFFFF", "lockb"))

# --- icons -----------------------------------------------------------------
def icon(full_bleed=True):
    # A crop: more left margin, face bleeds off right and bottom.
    cx, cy, R = 650, 650, 560
    body = face(cx, cy, R)
    if full_bleed:
        return svg(
            "0 0 1024 1024",
            DEFS + '<defs><clipPath id="tile"><rect width="1024" height="1024" rx="224"/></clipPath></defs>'
            '<rect width="1024" height="1024" rx="224" fill="#000"/>'
            f'<g clip-path="url(#tile)">{body}</g>',
        )
    # macOS grid: 824 tile inset 100, radius 185.4.
    return svg(
        "0 0 1024 1024",
        DEFS + '<defs><clipPath id="tile"><rect x="100" y="100" width="824" height="824" rx="185.4"/></clipPath></defs>'
        f'<g clip-path="url(#tile)"><g transform="translate(100 100) scale(0.8046875)">'
        '<rect width="1024" height="1024" fill="#000"/>'
        f'{body}</g></g>',
    )


write("icon.svg", icon(True))
write("icon-macos.svg", icon(False))

# --- preview ---------------------------------------------------------------
W, H = 1400, 980
prev = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">', DEFS,
        f'<rect width="{W}" height="{H}" fill="#F4F4F2"/>']
prev.append('<text x="48" y="64" font-family="Avenir Next, Helvetica, sans-serif" font-size="13" font-weight="700" letter-spacing="3" fill="#6E6E6A">MARKS / WHITE · BLACK · MONO</text>')
prev.append('<rect x="48" y="92" width="200" height="200" rx="20" fill="#000"/>')
prev.append(f'<g transform="translate(68 112) scale(0.16)">{face(500,500,500,"cream",EYE,"p1")}</g>')
prev.append('<rect x="280" y="92" width="200" height="200" rx="20" fill="#E9E9E4"/>')
prev.append(f'<g transform="translate(300 112) scale(0.16)">{face(500,500,500,"graphite","#FFFFFF","p2")}</g>')
prev.append('<rect x="512" y="92" width="200" height="200" rx="20" fill="#E9E9E4"/>')
prev.append(f'<g transform="translate(532 112) scale(0.16)">{mono_face(500,500,500,"p3")}</g>')
prev.append('<text x="48" y="360" font-family="Avenir Next, Helvetica, sans-serif" font-size="13" font-weight="700" letter-spacing="3" fill="#6E6E6A">LOCKUP / WHITE ON BLACK</text>')
prev.append('<rect x="48" y="384" width="1304" height="240" rx="24" fill="#000"/>')
prev.append(f'<g transform="translate(80 440) scale(0.18)">{face(525,354,525,"cream",EYE,"p4")}<g fill="{CREAM}" transform="translate(1450 0)">{WORD_SVG}</g></g>')
prev.append('<text x="48" y="700" font-family="Avenir Next, Helvetica, sans-serif" font-size="13" font-weight="700" letter-spacing="3" fill="#6E6E6A">WORDMARK / O IS THE BOT</text>')
prev.append('<rect x="48" y="724" width="640" height="220" rx="22" fill="#000"/>')
prev.append(f'<g transform="translate(78 798) scale(0.105)">{o_wordmark(CREAM,"cream",EYE,"p5")}</g>')
prev.append('<rect x="712" y="724" width="640" height="220" rx="22" fill="#E9E9E4"/>')
prev.append(f'<g transform="translate(742 798) scale(0.105)">{o_wordmark(INK,"graphite","#FFFFFF","p6")}</g>')
prev.append('</svg>')
(HERE / "assets-preview.svg").write_text("".join(prev))
print("wrote assets-preview.svg")
