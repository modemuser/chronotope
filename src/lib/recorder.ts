// H.264/MP4 recorder driven by WebCodecs VideoEncoder + mp4-muxer.
//
// Each call to encodeCanvas() captures the current pixel state of the
// supplied canvas as a VideoFrame, hands it to the encoder, then closes
// the frame. encoder.output is wired to the muxer so encoded chunks
// stream into the in-memory MP4 container as they arrive. finalize()
// flushes the encoder and returns a Blob.
//
// Browser support: Chrome/Edge 94+, Safari 16.4+, Firefox 130+.

import { ArrayBufferTarget, Muxer } from "mp4-muxer";

// H.264 baseline profile, level 4.2. Baseline forbids B-frames, so the
// encoder always emits chunks in presentation order (DTS == PTS, no
// reordering) — required because mp4-muxer rejects out-of-order DTS.
// Higher profiles (main / high) compress slightly better but pull
// B-frames in `latencyMode: "quality"`, which breaks muxing.
// Level 4.2 covers 1080p30+ comfortably; our viz canvas tops out at
// 1600 × 1200.
const H264_CODEC = "avc1.42E02A";

// Force a keyframe every KEYFRAME_EVERY frames so seeking in the produced
// MP4 lands within ~1s of the requested time.
const KEYFRAME_EVERY = 30;

export interface Mp4RecorderOptions {
  width: number;
  height: number;
  fps: number;
  bitrate?: number;
  // Surfaces async encoder errors so callers can show them in the UI
  // rather than dropping frames silently.
  onError?: (err: Error) => void;
}

export class Mp4Recorder {
  private encoder: VideoEncoder;
  private muxer: Muxer<ArrayBufferTarget>;
  private fps: number;
  private frameDurationUs: number;
  private framesEncoded = 0;
  private chunksOut = 0;
  // Two flags so we can stop accepting new input without ignoring output
  // callbacks for chunks already in the encoder's pipeline. flush()
  // resolves only after all pending output has fired, so finalized=true
  // happens *after* the drain.
  private acceptingInput = true;
  private finalized = false;
  private encoderError: Error | null = null;

  constructor(opts: Mp4RecorderOptions) {
    this.fps = opts.fps;
    this.frameDurationUs = Math.round(1_000_000 / opts.fps);

    // Don't pass frameRate to the muxer — that option quantizes timestamps
    // and misaligns with non-integer source fps (e.g. 29.97), producing
    // garbled output or refusing to mux. Raw timestamps work for any
    // framerate.
    this.muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: {
        codec: "avc",
        width: opts.width,
        height: opts.height,
      },
      fastStart: "in-memory",
    });

    this.encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (this.finalized) return;
        try {
          this.muxer.addVideoChunk(chunk, meta);
          this.chunksOut++;
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          this.encoderError = err;
          opts.onError?.(err);
        }
      },
      error: (e) => {
        const err = e instanceof Error ? e : new Error(String(e));
        this.encoderError = err;
        opts.onError?.(err);
      },
    });
    // - `framerate` omitted: some backends treat it as a wall-clock cap
    //   and drop input that arrives faster, which is what we do.
    // - `hardwareAcceleration: "prefer-software"`: the macOS hardware
    //   encoder (VideoToolbox) silently uses high profile + B-frames
    //   regardless of the codec string. With B-frames, chunks arrive in
    //   DTS order with PTS != DTS, but mp4-muxer writes v0 ctts boxes
    //   (unsigned offsets) which can't represent the negative
    //   PTS-DTS deltas B-frames produce. The software encoder respects
    //   the baseline-profile codec string strictly: no B-frames, no
    //   reordering, PTS == DTS, no muxing surprises.
    this.encoder.configure({
      codec: H264_CODEC,
      width: opts.width,
      height: opts.height,
      bitrate: opts.bitrate ?? 6_000_000,
      latencyMode: "quality",
      bitrateMode: "variable",
      hardwareAcceleration: "prefer-software",
    });
  }

  // Capture the current canvas pixels and feed them to the encoder. Async
  // so we can apply backpressure on `encoder.encodeQueueSize` (otherwise a
  // fast renderer pushes more than the encoder can hold and frames
  // silently disappear) and so we can take an explicit ImageBitmap
  // snapshot — that way we never race with subsequent canvas mutations.
  async encodeCanvas(
    canvas: HTMLCanvasElement,
    frameIndex: number,
  ): Promise<void> {
    if (!this.acceptingInput || this.encoderError) return;

    // Backpressure: wait for the encoder's queue to drain.
    while (this.encoder.encodeQueueSize > 30) {
      await new Promise<void>((r) => setTimeout(r, 0));
      if (!this.acceptingInput || this.encoderError) return;
    }

    const tsUs = Math.round((frameIndex * 1_000_000) / this.fps);
    const bitmap = await createImageBitmap(canvas);
    if (!this.acceptingInput || this.encoderError) {
      bitmap.close();
      return;
    }
    const frame = new VideoFrame(bitmap, {
      timestamp: tsUs,
      duration: this.frameDurationUs,
    });
    try {
      this.encoder.encode(frame, {
        keyFrame: this.framesEncoded % KEYFRAME_EVERY === 0,
      });
      this.framesEncoded++;
    } finally {
      frame.close();
      bitmap.close();
    }
  }

  async finalize(): Promise<Blob | null> {
    if (this.finalized) return null;
    // Stop accepting new input but let output callbacks for already-queued
    // chunks fire and reach the muxer.
    this.acceptingInput = false;
    try {
      await this.encoder.flush();
    } catch (e) {
      this.encoderError = e instanceof Error ? e : new Error(String(e));
    }
    this.finalized = true;
    try {
      this.encoder.close();
    } catch {}
    if (this.encoderError) throw this.encoderError;
    if (this.framesEncoded === 0) return null;
    if (this.chunksOut < this.framesEncoded) {
      // eslint-disable-next-line no-console
      console.warn(
        `Mp4Recorder: encoder produced ${this.chunksOut} chunks for ` +
          `${this.framesEncoded} input frames (${(
            (this.chunksOut / this.framesEncoded) *
            100
          ).toFixed(1)}% — frames were dropped).`,
      );
    }
    this.muxer.finalize();
    return new Blob([this.muxer.target.buffer], { type: "video/mp4" });
  }

  // Lets the UI surface a drop ratio after finalize().
  get stats() {
    return {
      framesEncoded: this.framesEncoded,
      chunksOut: this.chunksOut,
    };
  }

  abort() {
    if (this.finalized) return;
    this.acceptingInput = false;
    this.finalized = true;
    try {
      this.encoder.close();
    } catch {}
  }
}

export function videoEncoderSupported(): boolean {
  return typeof VideoEncoder !== "undefined";
}
