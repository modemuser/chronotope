# chronotope — plan

A client-side-only webapp that generates chronotope stills + animations
from user-uploaded videos. Deployed as static assets behind a Cloudflare
Worker. No server-side video processing, no uploads leaving the browser.

## Goal

Browser port of the Python `column_time_scan.py` prototype:

- User picks a video file (drag-drop on the page or file picker).
- App decodes frames in order, copies column `x` from frame `f(x)` onto an
  output canvas.
- User downloads the resulting JPEG **and** an MP4 of the build animation.

**Privacy/cost win:** the video never leaves the user's machine. The Worker
serves static HTML/JS and nothing else.

## Architecture

```
[Browser]
  ├─ index.html
  ├─ main.tsx                ← React entry
  ├─ App.tsx                 ← UI, drag/drop, phase state machine
  └─ lib/
      ├─ chronotope.ts       ← pure column → frame mapping
      ├─ decode.ts           ← mp4box.js + WebCodecs VideoDecoder
      ├─ render.ts           ← drives decode, paints chronotope + viz canvas
      └─ recorder.ts         ← WebCodecs VideoEncoder → mp4-muxer

[Cloudflare Worker]
  └─ Static Assets binding serves the built bundle from dist/
     (no runtime logic; the Worker is a static host with edge caching)
```

Everything runs on the main thread; rAF yields keep the UI responsive
during the decode + encode loop.

## Stack

| Concern         | Choice                           | Why                                                            |
| --------------- | -------------------------------- | -------------------------------------------------------------- |
| Language        | TypeScript                       | Catches off-by-ones in pixel code.                             |
| Build           | Vite                             | Fast HMR, ESM-first, trivial CF Workers integration.           |
| UI              | React 19                         | Familiar, fine bundle size for a tool this small.              |
| Container parse | mp4box.js                        | MP4 → encoded chunks for WebCodecs.                            |
| Video decode    | WebCodecs `VideoDecoder`         | Hardware-accelerated H.264/HEVC, zero wasm payload.            |
| Video encode    | WebCodecs `VideoEncoder`         | H.264 output without bundling ffmpeg.wasm just for the encode. |
| MP4 muxing      | mp4-muxer                        | In-memory container builder; tiny dep.                         |
| Deployment      | wrangler + Workers Static Assets | One config, one command.                                       |

## Core processing pipeline

`render.ts` runs once per `(file, reverse, sweep)` change:

1. `mp4box.js` parses the file → encoded chunk samples.
2. `VideoDecoder` produces `VideoFrame`s in presentation order; the
   consumer in `decode.ts` awaits `onFrame` serially so callers can apply
   backpressure.
3. For each frame index `i`:
   - paint columns `c` where `frame_for_column[c] === i` from the
     `VideoFrame` onto the off-DOM chronotope canvas;
   - composite source frame + chronotope + sweep marker into the visible
     viz canvas;
   - `onVizFrame(i)` → `Mp4Recorder.encodeCanvas()` snapshots the viz via
     `createImageBitmap` and feeds it to `VideoEncoder`.
4. After the last frame, `Mp4Recorder.finalize()` flushes the encoder and
   the muxer → an MP4 `Blob`.
5. JPEG export flattens the chronotope canvas onto black on demand.

The render goes as fast as decoder + encoder allow. Backpressure on
`encoder.encodeQueueSize` keeps the queue from running away. Yields to
`requestAnimationFrame` once the main thread has been blocked >16 ms so
the progress bar updates.

## UI features

**Done (MVP + bonus):**

- Drag-and-drop anywhere on the viewport, plus click-to-pick.
- File type + size validation (MP4/MOV/WebM, ≤ 2 GiB).
- Sample picker (Verdon, Vosges) bundled in `public/`.
- Build phase: hidden canvas + progress bar (`X / Y frames`).
- Done phase: native `<video>` with controls for scrubbing the result.
- Source metadata panel (resolution, frames, fps, bitrate, codec).
- Direction toggle (left-to-right ↔ right-to-left scan).
- Sweep-marker toggle.
- JPEG download (chronotope still).
- MP4 download (build animation).
- Friendly errors for non-videos, oversize files, encoder drops.

**Planned:**

- **Frame range** — start/end frame inputs in the controls row, so users
  can carve out a portion of a long source.
- **ffmpeg.wasm fallback** — lazy-loaded when
  `VideoDecoder.isConfigSupported()` says no (HEVC on Firefox, exotic
  containers). Stays out of the main bundle.
- **Cloudflare Workers deployment** — `wrangler deploy` produces a live
  URL; CI pipeline keeps it green.

## Cloudflare Workers deployment

`wrangler.toml` (to be added):

```toml
name = "chronotope"
compatibility_date = "2026-01-01"

[assets]
directory = "./dist"
not_found_handling = "single-page-application"
```

Build + deploy:

```sh
pnpm build           # vite build → dist/
pnpm wrangler deploy
```

CI (GitHub Actions): on PR run typecheck + build; on push to `main`,
`wrangler deploy --env=production` using a scoped API token in repo
secrets.

Caching: hashed filenames from Vite (`main-abc123.js`) make cache-busting
automatic. `index.html` short `Cache-Control` so deploys propagate;
everything else `immutable`.

## Notes that bit during implementation

- **H.264 baseline profile + `hardwareAcceleration: "prefer-software"`.**
  Hardware encoders (VideoToolbox on macOS) silently emit B-frames in
  `latencyMode: "quality"`. mp4-muxer writes v0 ctts boxes that can't
  represent the negative PTS−DTS deltas B-frames produce. Software
  baseline guarantees PTS == DTS, no reordering, no muxing surprises.
- **`acceptingInput` vs `finalized` flags in the recorder.** `finalize()`
  flips `acceptingInput = false` _before_ `await encoder.flush()` but
  `finalized = true` _after_. Otherwise output callbacks for the ~30
  frames in the encoder pipeline get rejected when `flush()` drains them
  and the MP4 ends up ~1 second short of the source.
- **Don't position the canvas off-screen during render.** Browsers skip
  canvas backing-buffer updates and the encoder reads empty pixels.
  Cover the canvas with an opaque overlay (or hide its parent via
  `display:none`) instead — and use `createImageBitmap(canvas)` to take
  an explicit snapshot.
- **Drop `frameRate` from mp4-muxer's video options.** It quantizes
  timestamps and breaks non-integer source fps (29.97). Raw chunk
  timestamps work for any framerate.

## Roadmap

1. **Cloudflare deploy + CI** — wrangler config, GH Actions for typecheck +
   build on PR, deploy on push to `main`.
2. **Frame range** — UI + plumbing through `renderChronotope` opts; the
   pacer already supports skipping leading frames if we wire it.
3. **ffmpeg.wasm fallback** — codec probe; lazy-load on miss; keep the
   ~30 MB out of the main bundle.
