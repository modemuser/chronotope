// WebCodecs-based MP4 frame decoder. Uses mp4box.js for container parsing.
// Frames are delivered to onFrame in presentation (display) order, one at a
// time. onFrame is awaited before the next frame is delivered, so callers
// can pace work (e.g. throttle to real-time playback).

import { createFile, DataStream } from "mp4box";
import type {
  MP4ArrayBuffer,
  MP4File,
  MP4Info,
  MP4Sample,
} from "mp4box";

export interface VideoMeta {
  width: number;
  height: number;
  totalFrames: number;
  fps: number;
  codec: string;
  // Overall file bitrate in bits/sec (file.size * 8 / duration). Includes
  // audio + container overhead, matching how ffprobe reports "bitrate".
  bitrate: number;
}

// onFrame is awaited serially. The frame is closed immediately after the
// returned promise settles — do not retain the VideoFrame past then.
export type FrameCallback = (
  frame: VideoFrame,
  index: number,
) => void | Promise<void>;

const QUEUE_HIGH_WATER = 8;

function codecDescription(track: any): Uint8Array {
  for (const entry of track.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      // Skip the 8-byte box header — VideoDecoder wants only the body.
      return new Uint8Array(stream.buffer, 8);
    }
  }
  throw new Error("No codec configuration box (avcC/hvcC/vpcC/av1C) found");
}

export async function decodeVideo(
  file: File,
  onMeta: (m: VideoMeta) => void,
  onFrame: FrameCallback,
  signal?: AbortSignal,
): Promise<void> {
  const buffer = (await file.arrayBuffer()) as MP4ArrayBuffer;
  buffer.fileStart = 0;

  const mp4box: MP4File = createFile();

  // ---- 1. Parse container, get metadata + samples ----
  const collected: MP4Sample[] = [];
  let trackId = -1;

  const ready = new Promise<VideoMeta>((resolve, reject) => {
    mp4box.onError = (e: string) => reject(new Error(`mp4box: ${e}`));
    mp4box.onReady = (info: MP4Info) => {
      const vt = info.videoTracks?.[0];
      if (!vt) {
        reject(new Error("No video track in file"));
        return;
      }
      trackId = vt.id;
      const durationSec = info.duration / info.timescale;
      const fps = durationSec > 0 ? vt.nb_samples / durationSec : 0;
      const bitrate = durationSec > 0 ? (file.size * 8) / durationSec : 0;
      resolve({
        width: vt.video.width,
        height: vt.video.height,
        totalFrames: vt.nb_samples,
        fps,
        codec: vt.codec,
        bitrate,
      });
    };
  });

  mp4box.onSamples = (_id, _user, samples) => {
    collected.push(...samples);
  };

  mp4box.appendBuffer(buffer);
  const meta = await ready;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

  mp4box.setExtractionOptions(trackId, null, { nbSamples: 100 });
  mp4box.start();
  mp4box.flush();

  if (collected.length === 0) {
    throw new Error("No samples extracted from track");
  }

  const trakBox = mp4box.moov.traks.find((t: any) => t.tkhd.track_id === trackId)
    ?? mp4box.moov.traks[0];
  const description = codecDescription(trakBox);

  onMeta(meta);

  // ---- 2. Decode + serialize delivery to onFrame ----
  //
  // The VideoDecoder calls its `output` callback whenever a frame is ready
  // — without waiting on us. To support paced (e.g. real-time) callers,
  // we buffer frames in a small queue and let a dedicated consumer await
  // onFrame serially. The sample feeder pauses when the queue is full so
  // memory doesn't grow unbounded for slow consumers.

  type Pending = { frame: VideoFrame; index: number };
  const queue: Pending[] = [];
  let frameIndex = 0;
  let decodeError: Error | null = null;
  let producerDone = false;

  let wakeConsumer: (() => void) | null = null;
  const notifyConsumer = () => {
    const w = wakeConsumer;
    if (w) {
      wakeConsumer = null;
      w();
    }
  };
  const waitForConsumerSignal = () =>
    new Promise<void>((resolve) => {
      wakeConsumer = resolve;
    });

  let wakeProducer: (() => void) | null = null;
  const notifyProducer = () => {
    const w = wakeProducer;
    if (w) {
      wakeProducer = null;
      w();
    }
  };
  const waitForProducerSignal = () =>
    new Promise<void>((resolve) => {
      wakeProducer = resolve;
    });

  const decoder = new VideoDecoder({
    output: (frame) => {
      queue.push({ frame, index: frameIndex++ });
      notifyConsumer();
    },
    error: (e) => {
      decodeError = e instanceof Error ? e : new Error(String(e));
      notifyConsumer();
      notifyProducer();
    },
  });

  decoder.configure({
    codec: meta.codec,
    codedWidth: meta.width,
    codedHeight: meta.height,
    description,
  });

  // --- Producer: feed encoded samples into the decoder ---
  const producer = (async () => {
    try {
      for (const sample of collected) {
        if (signal?.aborted) return;
        if (decodeError) return;

        // Pause feeding while the consumer queue or decoder backlog is full.
        while (
          queue.length >= QUEUE_HIGH_WATER ||
          decoder.decodeQueueSize > QUEUE_HIGH_WATER
        ) {
          if (signal?.aborted || decodeError) return;
          await waitForProducerSignal();
        }

        const chunk = new EncodedVideoChunk({
          type: sample.is_sync ? "key" : "delta",
          timestamp: (sample.cts * 1_000_000) / sample.timescale,
          duration: (sample.duration * 1_000_000) / sample.timescale,
          data: sample.data,
        });
        decoder.decode(chunk);
      }
      await decoder.flush();
    } finally {
      producerDone = true;
      notifyConsumer();
    }
  })();

  // --- Consumer: serially deliver frames to onFrame, paced by the caller ---
  try {
    while (true) {
      if (decodeError) throw decodeError;
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      if (queue.length === 0) {
        if (producerDone) break;
        await waitForConsumerSignal();
        continue;
      }

      const item = queue.shift()!;
      // Re-check after dequeue — a long await can race with abort.
      if (signal?.aborted) {
        item.frame.close();
        throw new DOMException("Aborted", "AbortError");
      }

      // Wake the producer in case it was waiting for queue room.
      notifyProducer();

      try {
        await onFrame(item.frame, item.index);
      } finally {
        item.frame.close();
      }
    }
  } catch (e) {
    // Drain remaining frames so VideoFrames don't leak.
    for (const it of queue) it.frame.close();
    queue.length = 0;
    notifyProducer();
    try {
      decoder.close();
    } catch {}
    await producer.catch(() => {});
    throw e;
  }

  await producer;
  try {
    decoder.close();
  } catch {}
  if (decodeError) throw decodeError;
}
