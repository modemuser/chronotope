declare module "mp4box" {
  // mp4box stamps a `fileStart` byte offset onto the buffers it appends.
  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }

  export interface MP4Sample {
    number: number;
    track_id: number;
    timescale: number;
    description_index: number;
    description: any;
    is_rap: boolean;
    is_sync: boolean;
    is_leading: number;
    depends_on: number;
    is_depended_on: number;
    has_redundancy: number;
    degradation_priority: number;
    offset: number;
    size: number;
    cts: number;
    dts: number;
    duration: number;
    data: ArrayBuffer;
  }

  export interface MP4VideoTrack {
    id: number;
    codec: string;
    nb_samples: number;
    movie_duration: number;
    track_width: number;
    track_height: number;
    timescale: number;
    duration: number;
    video: { width: number; height: number };
  }

  export interface MP4Info {
    duration: number;
    timescale: number;
    isFragmented: boolean;
    isProgressive: boolean;
    hasIOD: boolean;
    brands: string[];
    created: Date;
    modified: Date;
    tracks: MP4VideoTrack[];
    videoTracks: MP4VideoTrack[];
    audioTracks: MP4VideoTrack[];
  }

  export interface MP4File {
    onReady: (info: MP4Info) => void;
    onError: (e: string) => void;
    onSamples: (id: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer: (buf: MP4ArrayBuffer) => number;
    flush: () => void;
    setExtractionOptions: (id: number, user: unknown, opts: { nbSamples?: number }) => void;
    start: () => void;
    stop: () => void;
    moov: { traks: any[] };
  }

  export function createFile(keepMdatData?: boolean): MP4File;

  export class DataStream {
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    static BIG_ENDIAN: boolean;
    static LITTLE_ENDIAN: boolean;
    buffer: ArrayBuffer;
  }

  const _default: {
    createFile: typeof createFile;
    DataStream: typeof DataStream;
  };
  export default _default;
}
