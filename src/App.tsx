import { useEffect, useMemo, useRef, useState } from "react";
import { exportChronotopeJpeg, renderChronotope } from "./lib/render";
import { Mp4Recorder, videoEncoderSupported } from "./lib/recorder";
import type { VideoMeta } from "./lib/decode";

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
  const [showSweep, setShowSweep] = useState(true);

  const vizCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
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
        await renderChronotope(file, {
          signal: ctl.signal,
          reverse,
          sweep: showSweep,
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
  }, [file, reverse, showSweep]);

  const onToggleReverse = () => setReverse((r) => !r);
  const onToggleSweep = () => setShowSweep((s) => !s);

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
            A single picture in which time becomes space — each vertical slice
            comes from a different moment in a video. From Greek{" "}
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
          <div
            className="preview"
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

        {file && phase !== "rendering" && (
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

        {phase === "rendering" && file && (
          // Even during render the user should be able to abort and pick
          // another file. Just one button — no playback or scrub controls
          // that would interfere with the in-flight encoding.
          <div className="controls">
            <div className="controls-right">
              <button
                className="secondary"
                onClick={() => fileInputRef.current?.click()}
              >
                Open…
              </button>
            </div>
          </div>
        )}

        {meta && (
          <div className="meta">
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

        <a
          className="footer-link"
          href="https://github.com/modemuser/chronotope"
          target="_blank"
          rel="noopener noreferrer"
        >
          github
        </a>
      </div>
    </>
  );
}
