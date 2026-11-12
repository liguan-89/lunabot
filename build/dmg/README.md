`background.svg` is the macOS install window art (720 × 440 pt, drawn around the `dmg.contents` icon centres in `electron-builder.yml`); after editing it, run `node build/dmg/render.mjs` to rewrite `build/background.png` and `build/background@2x.png`.

The letters are outlines, not `<text>`: `render.mjs` rasterises with system fonts disabled. `gen-background.py` rebuilds the monochrome version from Avenir Next on this Mac and writes `background.svg`.
