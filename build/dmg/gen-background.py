"""Draws the DMG background in the Luna Bot monochrome identity.

The install window is 720 x 440 points, with the app icon centred at
(180, 206) and Applications at (540, 206). Every letter is outlined here:
build/dmg/render.mjs rasterises with system fonts disabled.
"""

import math
from pathlib import Path

from fontTools.ttLib import TTCollection
from fontTools.pens.svgPathPen import SVGPathPen

HERE = Path(__file__).resolve().parent
TTC = "/System/Library/Fonts/Avenir Next.ttc"

INK = "#0A0A0A"
MUTED = "#6E6E6A"
FAINT = "#9A9A96"
PAPER = "#F4F4F2"
RULE = "#DCDCD6"
CREAM = "#F7F3ED"

collection = TTCollection(TTC)
faces = {f["name"].getDebugName(4): f for f in collection.fonts}
DEMI = faces["Avenir Next Demi Bold"]
REGULAR = faces["Avenir Next Regular"]
HEAVY = faces["Avenir Next Heavy"]


def outlined(font, text, size, x, baseline, fill=INK, tracking=0.0, anchor="start"):
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    hmtx = font["hmtx"]
    upem = font["head"].unitsPerEm
    scale = size / upem
    widths = [hmtx[cmap[ord(ch)]][0] * scale for ch in text]
    width = sum(widths) + tracking * max(0, len(text) - 1)
    cursor = x - width / 2 if anchor == "middle" else x
    parts = []
    for ch, advance in zip(text, widths):
        name = cmap[ord(ch)]
        pen = SVGPathPen(glyphs)
        glyphs[name].draw(pen)
        d = pen.getCommands()
        if d:
            parts.append(
                f'<path fill="{fill}" transform="translate({cursor:.3f} {baseline}) '
                f'scale({scale:.6f} {-scale:.6f})" d="{d}"/>'
            )
        cursor += advance + tracking
    return "".join(parts), width


def face(cx, cy, r, body=CREAM, eye=INK):
    """The bot face: two tilted pills at the app's own angles."""
    tilt = math.radians(-19.1)
    et = math.radians(-16.7)
    c, s = math.cos(tilt), math.sin(tilt)
    out = [f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{r:.3f}" fill="{body}"/>']
    for side in (-1, 1):
        ex = cx + side * 0.342 * r * c
        ey = cy - 0.150 * r + side * 0.342 * r * s
        w, h = 0.125 * 2 * r, 0.245 * 2 * r
        out.append(
            f'<g transform="rotate({math.degrees(et):.3f} {ex:.3f} {ey:.3f})">'
            f'<rect x="{ex - w / 2:.3f}" y="{ey - h / 2:.3f}" width="{w:.3f}" height="{h:.3f}" '
            f'rx="{w / 2:.3f}" fill="{eye}"/></g>'
        )
    return "".join(out)


svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="440" viewBox="0 0 720 440">',
    f'''<defs>
<pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse">
  <circle cx="2" cy="2" r="1.1" fill="{INK}" opacity="0.04"/>
</pattern>
</defs>''',
    f'<rect width="720" height="440" fill="{PAPER}"/>',
    '<rect width="720" height="440" fill="url(#dots)"/>',
]

title, _ = outlined(DEMI, "Drag Luna Bot into Applications", 25, 360, 70, INK, tracking=-0.2, anchor="middle")
sub, _ = outlined(REGULAR, "The app installs in a moment. Your chats stay on this Mac.", 13.5, 360, 95, MUTED, anchor="middle")
svg.append(f'<g fill="{INK}">{title}</g>')
svg.append(sub)

# Landing slots. Finder draws the app icon and the Applications folder on top.
for x in (114, 474):
    svg.append(
        f'<rect x="{x}" y="140" width="132" height="132" rx="32" fill="#FFFFFF" '
        f'stroke="{RULE}" stroke-width="2"/>'
    )

# Arrow from the app to Applications.
svg.append(f'<path d="M 302 206 H 414" fill="none" stroke="{INK}" stroke-width="8" stroke-linecap="round"/>')
svg.append(f'<path d="M 396 186 L 422 206 L 396 226" fill="none" stroke="{INK}" stroke-width="8" '
           f'stroke-linecap="round" stroke-linejoin="round"/>')

# Bottom lockup: face + wordmark, then the Cloud address.
MARK_D = 28
word_cap = 14
word_size = word_cap / (708 / 1000)
word, word_w = outlined(HEAVY, "Luna Bot", word_size, 0, 0, INK, tracking=0.2)
lock_w = MARK_D + 10 + word_w
left = 360 - lock_w / 2
face_cy = 359
svg.append(face(left + MARK_D / 2, face_cy, MARK_D / 2, body=INK, eye=CREAM))
svg.append(f'<g transform="translate({left + MARK_D + 10:.3f} {face_cy + word_cap / 2:.3f})" fill="{INK}">{word}</g>')

url, _ = outlined(REGULAR, "cloud.dexai.vip", 11, 360, 393, FAINT, tracking=0.4, anchor="middle")
svg.append(url)

svg.append("</svg>")
(HERE / "background.svg").write_text("".join(svg))
print("wrote build/dmg/background.svg")