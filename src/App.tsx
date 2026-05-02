import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  exportChronotopeJpeg,
  renderChronotope,
  type ThumbnailStrip,
} from "./lib/render";
import { Mp4Recorder, videoEncoderSupported } from "./lib/recorder";
import type { VideoMeta } from "./lib/decode";
import type { Shape } from "./lib/chronotope";

const HowItWorks = lazy(() =>
  import("./HowItWorks").then((m) => ({ default: m.HowItWorks })),
);

type Phase = "idle" | "rendering" | "done" | "error";

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

function isProbablyVideoFile(f: File): boolean {
  if (f.type.startsWith("video/")) return true;
  // Some browsers / drag-drop sources don't set type. Fall back to
  // extension. Accept the formats WebCodecs typically decodes.
  return /\.(mp4|mov|m4v|webm)$/i.test(f.name);
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Curve glyphs for the three shape modes — each draws f(x) over the button.
function LinearShapeIcon() {
  return (
    <svg
      aria-hidden="true"
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="2" y1="13" x2="14" y2="3" />
    </svg>
  );
}

function VShapeIcon() {
  return (
    <svg
      aria-hidden="true"
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="2,3 8,13 14,3" />
    </svg>
  );
}

function ParabolaShapeIcon() {
  return (
    <svg
      aria-hidden="true"
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 3 Q 8 23 14 3" />
    </svg>
  );
}

// Lucide-style info circle — opens the options/details explainer.
function InfoIcon() {
  return (
    <svg
      aria-hidden="true"
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="11" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

// Three-step staircase rising to the right — toggle between smooth and
// stripes (discrete) chronotope modes.
function StairsIcon() {
  return (
    <svg
      aria-hidden="true"
      width="1em"
      height="1em"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="2,14 2,10 6,10 6,6 10,6 10,2 14,2" />
    </svg>
  );
}

// Lucide-style download glyph. Sized via currentColor + em so it inherits
// the parent button's color and font-size.
function DownloadIcon() {
  return (
    <svg
      aria-hidden="true"
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// Trigger a one-shot download of a Blob without holding a long-lived URL.
function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

interface RenderState {
  videoBlob: Blob | null;
  videoUrl: string | null;
}

export function App() {
  const [file, setFile] = useState<File | null>(null);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ frame: 0, total: 0 });
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reverse, setReverse] = useState(false);
  const [shape, setShape] = useState<Shape>("linear");
  const [showSweep, setShowSweep] = useState(true);
  const [stripes, setStripes] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);

  const vizCanvasRef = useRef<HTMLCanvasElement>(null);
  const colorBarRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Thumbnail strip captured by the most recent render. Used to repaint
  // the colour bar from a different sample point on hover, without
  // re-decoding the source video.
  const thumbnailsRef = useRef<ThumbnailStrip | null>(null);

  // Repaint the colour bar from a sample point at fractional (x, y) in
  // the source frame. Reads thumbnail RGB bytes directly — no canvas
  // readback per call — and pushes a single putImageData of length
  // nFrames × 1 to the bar canvas.
  const paintColorBar = (xFrac: number, yFrac: number) => {
    const tn = thumbnailsRef.current;
    const bar = colorBarRef.current;
    if (!tn || !bar) return;
    const tx = Math.max(
      0,
      Math.min(tn.thumbW - 1, Math.floor(xFrac * tn.thumbW)),
    );
    const ty = Math.max(
      0,
      Math.min(tn.thumbH - 1, Math.floor(yFrac * tn.thumbH)),
    );
    const buf = new Uint8ClampedArray(tn.nFrames * 4);
    for (let i = 0; i < tn.nFrames; i++) {
      const c = i % tn.cols;
      const r = Math.floor(i / tn.cols);
      const off = ((r * tn.thumbH + ty) * tn.stripW + (c * tn.thumbW + tx)) * 4;
      buf[i * 4] = tn.data[off];
      buf[i * 4 + 1] = tn.data[off + 1];
      buf[i * 4 + 2] = tn.data[off + 2];
      buf[i * 4 + 3] = 255;
    }
    const ctx = bar.getContext("2d");
    if (!ctx) return;
    ctx.putImageData(new ImageData(buf, tn.nFrames, 1), 0, 0);
  };
  const renderStateRef = useRef<RenderState | null>(null);
  const chronotopeRef = useRef<HTMLCanvasElement | null>(null);

  // On phones/tablets the WebCodecs VideoEncoder is either missing or buggy
  // (iOS WebKit produces broken H.264 chunks in practice). Skip the MP4
  // recording path there and let the user watch the chronotope build live
  // on the viz canvas instead. Detection: coarse pointer + no hover.
  const isMobile = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none) and (pointer: coarse)").matches,
    [],
  );

  // onPick is referenced from event handlers attached to `document`. Stash
  // it in a ref so the listener doesn't need to re-attach on every render.
  const onPickRef = useRef<(f: File) => void>(() => {});
  onPickRef.current = (f: File) => {
    if (!isProbablyVideoFile(f)) {
      setErrorMsg(
        `“${f.name}” doesn't look like a video. Drop an MP4, MOV, or WebM.`,
      );
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setErrorMsg(
        `“${f.name}” is ${humanBytes(f.size)} — too big for the in-memory ` +
          `parser (cap is 2 GB). Trim or compress with ffmpeg first.`,
      );
      return;
    }
    setMeta(null);
    setProgress({ frame: 0, total: 0 });
    setErrorMsg(null);
    setFile(f);
  };

  // ESC closes the How-it-works modal.
  useEffect(() => {
    if (!howOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHowOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [howOpen]);

  // Whole-document drag-and-drop. Counter pattern handles dragenter/leave
  // bubbling through children: net counter is 1 while a drag is over any
  // descendant of the document.
  useEffect(() => {
    let counter = 0;
    const onEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      counter++;
      if (counter === 1) setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      counter = Math.max(0, counter - 1);
      if (counter === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      e.preventDefault();
      counter = 0;
      setDragging(false);
      const f = e.dataTransfer.files?.[0];
      if (f) onPickRef.current(f);
    };
    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("dragover", onOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onEnter);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("drop", onDrop);
    };
  }, []);

  // Auto-run the render whenever the inputs change.
  useEffect(() => {
    if (!file || !vizCanvasRef.current) return;

    const ctl = new AbortController();
    const recBox: { rec: Mp4Recorder | null } = { rec: null };

    renderStateRef.current = {
      videoBlob: null,
      videoUrl: null,
    };
    chronotopeRef.current = null;

    setPhase("rendering");
    setErrorMsg(null);
    setProgress({ frame: 0, total: 0 });
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    let cleanedUp = false;

    (async () => {
      try {
        const result = await renderChronotope(file, {
          signal: ctl.signal,
          reverse,
          shape,
          sweep: showSweep,
          steps: stripes ? 24 : undefined,
          viz: vizCanvasRef.current!,
          livePace: isMobile,
          onChronotopeReady: (c) => {
            chronotopeRef.current = c;
          },
          onMeta: (m) => {
            setMeta(m);
            if (isMobile || !videoEncoderSupported() || !vizCanvasRef.current)
              return;
            const fps =
              m.fps && Number.isFinite(m.fps) && m.fps > 0 ? m.fps : 30;
            try {
              const r = new Mp4Recorder({
                width: vizCanvasRef.current.width,
                height: vizCanvasRef.current.height,
                fps,
                bitrate: 6_000_000,
                onError: (err) => {
                  setErrorMsg(`Recording error: ${err.message}`);
                  // eslint-disable-next-line no-console
                  console.error("Mp4Recorder error:", err);
                },
              });
              recBox.rec = r;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              setErrorMsg(`Recording disabled: ${msg}`);
              // eslint-disable-next-line no-console
              console.warn("Mp4Recorder init failed:", err);
            }
          },
          onVizFrame: (index) => {
            const r = recBox.rec;
            const c = vizCanvasRef.current;
            if (!r || !c) return;
            // Return the promise so render.ts awaits before the next
            // frame — without this, `encoder.encodeQueueSize`
            // backpressure races and the encoder errors out.
            return r.encodeCanvas(c, index);
          },
          onProgress: (p) => setProgress(p),
        });
        if (cleanedUp) return;

        // Stash the per-frame thumbnail strip and prime the colour bar
        // canvas. Sizing happens here (not in JSX) so the canvas backing
        // buffer matches frame count exactly.
        thumbnailsRef.current = result.thumbnails;
        const bar = colorBarRef.current;
        if (bar) {
          bar.width = result.thumbnails.nFrames;
          bar.height = 1;
          paintColorBar(0.5, 0.5);
        }

        if (recBox.rec) {
          const blob = await recBox.rec.finalize();
          if (cleanedUp) return;
          if (blob && renderStateRef.current) {
            renderStateRef.current.videoBlob = blob;
            const url = URL.createObjectURL(blob);
            renderStateRef.current.videoUrl = url;
            setVideoUrl(url);
          }
          // Surface encoder drop ratio if the backend silently dropped
          // frames despite all our backpressure / latency tweaks.
          const s = recBox.rec.stats;
          if (s.framesEncoded > 0 && s.chunksOut < s.framesEncoded) {
            const pct = ((s.chunksOut / s.framesEncoded) * 100).toFixed(0);
            setErrorMsg(
              `Heads up: the H.264 encoder dropped frames ` +
                `(${s.chunksOut} / ${s.framesEncoded} = ${pct}%). ` +
                `The MP4 will be shorter than the source.`,
            );
          }
        }

        setPhase("done");
      } catch (e) {
        recBox.rec?.abort();
        if (cleanedUp) return;
        if ((e as DOMException)?.name === "AbortError") {
          // Restart or unmount — the next effect run will set phase.
          return;
        }
        setPhase("error");
        const msg = e instanceof Error ? e.message : String(e);
        // Friendlier messages for common failures.
        if (/quota|memory|allocation|maximum/i.test(msg)) {
          setErrorMsg(
            `Couldn't load this file (${msg}). It's likely too large to ` +
              `parse in memory — trim or compress with ffmpeg first.`,
          );
        } else {
          setErrorMsg(msg);
        }
        // eslint-disable-next-line no-console
        console.error(e);
      }
    })();

    return () => {
      cleanedUp = true;
      ctl.abort();
      recBox.rec?.abort();
      if (renderStateRef.current?.videoUrl) {
        URL.revokeObjectURL(renderStateRef.current.videoUrl);
      }
      renderStateRef.current = null;
      chronotopeRef.current = null;
    };
  }, [file, reverse, shape, showSweep, stripes]);

  const onToggleReverse = () => setReverse((r) => !r);
  const onToggleSweep = () => setShowSweep((s) => !s);
  const onToggleStripes = () => setStripes((s) => !s);

  const SHAPE_OPTIONS: ReadonlyArray<{
    value: Shape;
    label: string;
    title: string;
    icon: () => ReactElement;
  }> = [
    {
      value: "linear",
      label: "Linear",
      title: "Linear sweep — edge to edge",
      icon: LinearShapeIcon,
    },
    {
      value: "v",
      label: "Bi-linear",
      title:
        "Bi-linear — two linear arms folded at the centre, motion converges into an arrowhead. Reverse for an outward expansion.",
      icon: VShapeIcon,
    },
    {
      value: "parabola",
      label: "Parabola",
      title:
        "Parabola — softer curve, holds the apex frame. Try with reverse for a halo.",
      icon: ParabolaShapeIcon,
    },
  ];

  const baseName = file ? file.name.replace(/\.[^.]+$/, "") : "chronotope";

  const onDownloadJpeg = async () => {
    const c = chronotopeRef.current;
    if (!c) return;
    const blob = await exportChronotopeJpeg(c);
    triggerBlobDownload(blob, `${baseName}_chronotope.jpg`);
  };

  const onDownloadVideo = () => {
    const blob = renderStateRef.current?.videoBlob;
    if (!blob) return;
    triggerBlobDownload(blob, `${baseName}_chronotope_viz.mp4`);
  };

  const loadSample = async (filename: string) => {
    try {
      const res = await fetch(`/${filename}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      onPickRef.current(
        new File([blob], filename, { type: blob.type || "video/mp4" }),
      );
    } catch (e) {
      setErrorMsg(
        `Couldn't load sample video: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  };

  const showJpegBtn = phase === "done" && !!meta;
  const showVideoBtn = phase === "done" && !!videoUrl;
  const pct =
    progress.total > 0
      ? Math.min(100, (progress.frame / progress.total) * 100)
      : 0;

  return (
    <>
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-overlay-card">
            <strong>Drop video to render</strong>
            <span>MP4 / MOV (H.264 or HEVC)</span>
          </div>
        </div>
      )}

      <div className="app">
        <header>
          <h1 className="entry">
            <span className="word">chronotope</span>
            <span className="pron">/ˈkrɒn.ə.toʊp/</span>
            <span className="pos">noun</span>
          </h1>
          <p className="definition">
            A still picture where{" "}
            <button
              type="button"
              className="link"
              onClick={() => setHowOpen(true)}
            >
              time becomes space
            </button>{" "}
            — each column captures a different moment of a video. From Greek{" "}
            <em>chronos</em> (time) and <em>topos</em> (place).
          </p>
          <p className="example">
            <em>e.g.</em> a 2-hour sunset packed into one still image.
          </p>
          <p>
            Drop a timelapse video to make one. Nothing leaves your browser.
          </p>
          <p>
            Try a sample:{" "}
            <button
              type="button"
              className="link"
              onClick={() => loadSample("verdon.mp4")}
            >
              Blue hour
            </button>
            {" | "}
            <button
              type="button"
              className="link"
              onClick={() => loadSample("vosges_snow.mp4")}
            >
              Cotton candy snow
            </button>
          </p>
        </header>

        {errorMsg && <div className="error">{errorMsg}</div>}

        {!file ? (
          <button
            type="button"
            className="empty-state"
            onClick={() => fileInputRef.current?.click()}
          >
            <strong>Drop a video on this page</strong>
            <span>or click here to choose · MP4 / MOV (H.264 or HEVC)</span>
          </button>
        ) : (
          <>
            <div
              className="preview"
              onMouseMove={(e) => {
                // Live-resample the colour bar from whatever pixel is
                // under the cursor. Hover (not click) so the video's
                // play/pause toggle isn't affected.
                if (!thumbnailsRef.current) return;
                const r = e.currentTarget.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return;
                paintColorBar(
                  (e.clientX - r.left) / r.width,
                  (e.clientY - r.top) / r.height,
                );
              }}
              style={{
                ...(meta && {
                  aspectRatio: `${meta.width} / ${meta.height}`,
                }),
                // Hide the preview wrapper during render on desktop so the
                // user only sees the progress bar — the MP4 plays back after.
                // On mobile we skip MP4 encoding, so keep the canvas visible
                // and let the user watch the chronotope build live.
                ...(phase === "rendering" && !isMobile && { display: "none" }),
              }}
            >
              <canvas ref={vizCanvasRef} className="layer" />
              {phase === "done" && videoUrl && (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <video
                  className="layer"
                  src={videoUrl}
                  controls
                  autoPlay
                  playsInline
                />
              )}
            </div>
            <canvas
              ref={colorBarRef}
              className="color-bar"
              aria-label="Colour of the sampled pixel over time"
              style={phase === "done" ? undefined : { display: "none" }}
            />
          </>
        )}

        {phase === "rendering" && (
          <div className="progress">
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="progress-text">
              Rendering… {progress.frame} / {progress.total || "?"} frames
              {progress.total > 0 ? ` (${pct.toFixed(0)}%)` : ""}
            </div>
          </div>
        )}

        {file && (
          <div className="controls">
            <button
              className="secondary"
              onClick={onToggleReverse}
              title={
                reverse
                  ? "Right-to-left scan: leftmost column is the last frame"
                  : "Left-to-right scan: leftmost column is the first frame"
              }
            >
              {reverse ? "←" : "→"}
            </button>
            <div className="shape-group" role="group" aria-label="Shape">
              {SHAPE_OPTIONS.map((opt) => {
                const Icon = opt.icon;
                const active = shape === opt.value;
                return (
                  <button
                    key={opt.value}
                    className="secondary toggle"
                    onClick={() => setShape(opt.value)}
                    aria-pressed={active}
                    aria-label={opt.label}
                    title={opt.title}
                  >
                    <Icon />
                  </button>
                );
              })}
            </div>
            <button
              className="secondary toggle"
              onClick={onToggleSweep}
              aria-pressed={showSweep}
              title={
                showSweep
                  ? "Sweep marker on — click to hide"
                  : "Sweep marker off — click to show"
              }
            >
              |
            </button>
            <button
              className="secondary toggle"
              onClick={onToggleStripes}
              aria-pressed={stripes}
              title={
                stripes
                  ? "Discrete: 24 stripes, one frame each — click for smooth"
                  : "Smooth: every column its own frame — click for stripes"
              }
            >
              <StairsIcon />
            </button>
            <button
              className="info-button"
              onClick={() => setInfoOpen((o) => !o)}
              aria-pressed={infoOpen}
              aria-label="Info"
              title={
                infoOpen
                  ? "Hide options & video details"
                  : "Show options & video details"
              }
            >
              <InfoIcon />
            </button>
            <div className="controls-right">
              {showJpegBtn && (
                <button onClick={onDownloadJpeg}>
                  <DownloadIcon />
                  <span>Image</span>
                </button>
              )}
              {showVideoBtn && (
                <button onClick={onDownloadVideo}>
                  <DownloadIcon />
                  <span>Animation</span>
                </button>
              )}
              <button
                className="secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                Open…
              </button>
            </div>
          </div>
        )}

        {infoOpen && file && (
          <div className="info-panel">
            <ul className="info-list">
              <li>
                <span className="info-glyph">→</span>
                <span className="info-name">Reverse</span>
                <span>
                  Flip the time axis. For bi-linear and parabola this
                  inverts the default inward fold into an outward burst.
                </span>
              </li>
              <li className="group-start">
                <span className="info-glyph">
                  <LinearShapeIcon />
                </span>
                <span className="info-name">Linear</span>
                <span>
                  Diagonal sweep — every column gets one frame, edge to
                  edge.
                </span>
              </li>
              <li>
                <span className="info-glyph">
                  <VShapeIcon />
                </span>
                <span className="info-name">Bi-linear</span>
                <span>
                  Time folds around the centre — motion converges into an
                  arrowhead. Reverse swaps to an outward expansion.
                </span>
              </li>
              <li>
                <span className="info-glyph">
                  <ParabolaShapeIcon />
                </span>
                <span className="info-name">Parabola</span>
                <span>
                  Softer fold that holds the centre frame across most of
                  the width — radial halo around timelapse motion by
                  default.
                </span>
              </li>
              <li className="group-start">
                <span className="info-glyph">|</span>
                <span className="info-name">Sweep marker</span>
                <span>
                  Faint vertical line showing where the build has reached.
                  Two markers for bi-linear/parabola — one per arm.
                </span>
              </li>
              <li className="group-start">
                <span className="info-glyph">
                  <StairsIcon />
                </span>
                <span className="info-name">Stripes</span>
                <span>
                  Quantise into 24 vertical stripes — each shows a single
                  source frame.
                </span>
              </li>
            </ul>
            {meta && (
              <div className="info-meta">
                <div className="meta-item">
                  <span className="label">Resolution</span>
                  <span className="value">
                    {meta.width} × {meta.height}
                  </span>
                </div>
                <div className="meta-item">
                  <span className="label">Frames</span>
                  <span className="value">{meta.totalFrames}</span>
                </div>
                <div className="meta-item">
                  <span className="label">FPS</span>
                  <span className="value">
                    {meta.fps > 0 ? meta.fps.toFixed(2) : "—"}
                  </span>
                </div>
                <div className="meta-item">
                  <span className="label">Bitrate</span>
                  <span className="value">
                    {meta.bitrate > 0
                      ? `${(meta.bitrate / 1_000_000).toFixed(1)} Mbps`
                      : "—"}
                  </span>
                </div>
                <div className="meta-item">
                  <span className="label">Codec</span>
                  <span
                    className="value"
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: 13,
                    }}
                  >
                    {meta.codec}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="video/*"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPickRef.current(f);
            e.target.value = "";
          }}
        />

        <div className="footer-links">
          <a
            href="/idea"
            onClick={(e) => {
              // Plain left-click → modal. Right-click / cmd+click /
              // middle-click fall through to the href.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)
                return;
              e.preventDefault();
              setHowOpen(true);
            }}
          >
            the idea
          </a>
          <span className="footer-sep" aria-hidden="true">
            |
          </span>
          <a
            href="https://github.com/modemuser/chronotope"
            target="_blank"
            rel="noopener noreferrer"
          >
            github
          </a>
        </div>

        {howOpen && (
          <div
            className="how-modal-backdrop"
            onClick={() => setHowOpen(false)}
            role="dialog"
            aria-modal="true"
            aria-label="The idea"
          >
            <div
              className="how-modal-panel"
              onClick={(e) => e.stopPropagation()}
            >
              <Suspense fallback={null}>
                <HowItWorks inModal onClose={() => setHowOpen(false)} />
              </Suspense>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
