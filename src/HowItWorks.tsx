// Choreographed Three.js explainer for the chronotope: a diagonal slice
// through a block universe of stacked frames.
//
// Geometry: each sampled frame becomes a flat W×H slice in the xy plane;
// stacking them along z gives a 3D block where the third axis is time.
// Frame 0 lands closest to the camera; each subsequent capture flies in
// from the video position and lands further back, parented to a
// `loafGroup` pivoted at the block center.
//
// The chronotope picks column x from frame f(x) = x·(N-1)/(W-1). On the
// block's top face this maps to a diagonal from (x=0, z=Z_TOTAL) to
// (x=W, z=0). In scene 3 each slice is split at that diagonal and the
// far halves drop away. The remaining halves form a staircase whose
// right edges are exactly the kept columns. Scene 4 rotates the block
// so the frame normals point at the camera; depth-testing makes the
// front-most slice at each x show its kept column, and the staircase
// reveals itself as the chronotope at native 16:9 aspect.

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

const SAMPLE_URL = "/verdon.mp4";
const N_FRAMES = 16; // slabs in the demo stack
// Bigger than the slab's on-screen footprint at peak zoom (scene 4
// reveal) so the chronotope reads sharp, not pixely. 32 frames at
// 960×540×4 ≈ 66 MB of canvas-backed memory — acceptable.
const FRAME_TEX_W = 960;
const FRAME_TEX_H = 540;

// Geometry constants — abstract units. W maps to plane width.
const W = 16;
const H = 9;
const Z_TOTAL = 12;
const SLAB_GAP = Z_TOTAL / (N_FRAMES - 1);

interface Scene {
  title: string;
  body: string;
  duration: number;
}

const SCENES: Scene[] = [
  { title: "1. Sample frames as the video plays", body: "Stack them in time — a block universe with time as the third axis.", duration: 12.0 },
  { title: "2. Mark a diagonal across the block", body: "From the first column of the first frame to the last column of the last.", duration: 2.2 },
  { title: "3. Slice along it, drop the cut-off half", body: "What's left is bounded by the slanted cut.", duration: 4.0 },
  { title: "4. The slice is the chronotope", body: "Each column comes from a different moment in time.", duration: 3.0 },
];

const TOTAL_DURATION = SCENES.reduce((a, s) => a + s.duration, 0);
const SCENE_STARTS = SCENES.reduce<number[]>((acc, _s, i) => {
  acc.push(i === 0 ? 0 : acc[i - 1] + SCENES[i - 1].duration);
  return acc;
}, []);
// Window during scene 1 across which the N captures fire. Slightly less
// than the full scene so things settle before scene 2 begins.
const CAPTURE_WINDOW = SCENES[0].duration * 0.85;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function sceneProgress(t: number, i: number): number {
  return Math.max(0, Math.min(1, (t - SCENE_STARTS[i]) / SCENES[i].duration));
}

function sceneIndexAtTime(t: number): number {
  for (let i = SCENES.length - 1; i >= 0; i--) {
    if (t >= SCENE_STARTS[i]) return i;
  }
  return 0;
}

// Module-level cache of the per-frame canvases keyed by (url::n). Survives
// component unmount, so closing & reopening the modal doesn't re-seek.
const frameCache = new Map<string, HTMLCanvasElement[]>();

function canvasesToTextures(
  canvases: HTMLCanvasElement[],
): THREE.CanvasTexture[] {
  // CanvasTexture is bound to a specific GL context's upload state, so on
  // each mount we wrap the cached canvases in fresh textures.
  return canvases.map((c) => {
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
}

// Extract N evenly-spaced frames from a video URL into per-frame canvases
// (wrapped in CanvasTextures). `onProgress` fires after each capture with
// fraction in [0, 1]. Returns instantly from cache on subsequent calls.
async function extractFrames(
  url: string,
  n: number,
  onProgress?: (frac: number) => void,
): Promise<THREE.CanvasTexture[]> {
  const cacheKey = `${url}::${n}::${FRAME_TEX_W}x${FRAME_TEX_H}`;
  const cached = frameCache.get(cacheKey);
  if (cached) {
    onProgress?.(1);
    return canvasesToTextures(cached);
  }

  const video = document.createElement("video");
  video.src = url;
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadedmetadata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("video load failed")), { once: true });
  });

  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("video has no duration");
  }

  const canvases: HTMLCanvasElement[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (duration - 0.1);
    await new Promise<void>((resolve) => {
      const onSeeked = () => {
        video.removeEventListener("seeked", onSeeked);
        resolve();
      };
      video.addEventListener("seeked", onSeeked);
      video.currentTime = t;
    });
    const c = document.createElement("canvas");
    c.width = FRAME_TEX_W;
    c.height = FRAME_TEX_H;
    const cctx = c.getContext("2d");
    if (!cctx) throw new Error("no 2d context");
    cctx.drawImage(video, 0, 0, FRAME_TEX_W, FRAME_TEX_H);
    canvases.push(c);
    onProgress?.((i + 1) / n);
  }

  frameCache.set(cacheKey, canvases);
  return canvasesToTextures(canvases);
}

interface FrameSlab {
  group: THREE.Group;
  // Single full-width plane shown during scenes 1-2 (no seam). At the
  // start of scene 3 we hide `full` and reveal `left` + `right`, which
  // tile to the same texture — `right` then lifts and fades.
  full: THREE.Mesh;
  left: THREE.Mesh;
  right: THREE.Mesh;
  restPos: THREE.Vector3;
}

interface HowItWorksProps {
  inModal?: boolean;
  onClose?: () => void;
}

export function HowItWorks({ inModal = false, onClose }: HowItWorksProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef(0);
  const playingRef = useRef(true);
  const framesReadyRef = useRef(false);
  const [sceneIdx, setSceneIdx] = useState(0);
  const [progressPct, setProgressPct] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadProgress, setLoadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Imperative restart/pause toggles — invoked from buttons.
  const restartRef = useRef<() => void>(() => {});
  const togglePlayRef = useRef<() => void>(() => {});

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let raf = 0;
    let lastWallMs = performance.now();

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x0c0c10, 1);

    const scene = new THREE.Scene();
    // Ortho camera so slabs at different z appear at the same width — no
    // perspective foreshortening between front and back of the stack.
    // We size the frustum based on container aspect in resize().
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -100, 200);
    // Fixed iso top-right view. Direction picked so we see the top edges
    // of all slabs (a strip along z), the right edges, and the front face.
    const camCenter = new THREE.Vector3(W / 2, H / 2, Z_TOTAL / 2);
    const camDir = new THREE.Vector3(0.85, 0.7, 1).normalize();
    camera.position.copy(camCenter).addScaledVector(camDir, 40);
    camera.lookAt(camCenter);

    scene.add(new THREE.AmbientLight(0xffffff, 1));

    container.appendChild(renderer.domElement);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";

    // Camera basis (right / up / back) — used to position and orient the
    // video plane in screen space (lower-left, parallel to viewport).
    camera.updateMatrixWorld();
    const camRight = new THREE.Vector3().setFromMatrixColumn(
      camera.matrixWorld,
      0,
    );
    const camUp = new THREE.Vector3().setFromMatrixColumn(
      camera.matrixWorld,
      1,
    );

    const slabs: FrameSlab[] = [];
    // Mesh (thin cylinder) so we get a fat, visible line — WebGL caps
    // THREE.Line linewidth at 1 px on most platforms.
    let diagonalLine: THREE.Mesh | null = null;
    let videoPlane: THREE.Mesh | null = null;
    let videoTexture: THREE.VideoTexture | null = null;
    let vidEl: HTMLVideoElement | null = null;

    // Parent for the slabs + diagonal + chronotope plane. Pivoted at the
    // loaf center so we can rotate the whole "sliced stack" in scene 4 to
    // bring the slanted cut surface face-on with the camera.
    const loafGroup = new THREE.Group();
    loafGroup.position.copy(camCenter);
    scene.add(loafGroup);

    // Updated each resize so the scene 4 zoom-to-fit knows the right
    // target zoom for the current container aspect.
    let revealZoom = 1;
    // Source video preview is the same size and orientation as a slab
    // (iso, in xy plane). Slabs spawn from it without any rotation —
    // they just translate from top-right to the loaf in lower-left.
    const VID_SCALE = 1.0;
    const W_VID = W * VID_SCALE;
    const H_VID = H * VID_SCALE;

    // Loaf-rest world position: world origin of loafGroup when scenes 2-4
    // are running (centered, used for the rotate reveal pivot). During
    // scene 1 the loaf is offset to the lower-left so frames have room
    // to fly across the screen from the top-right video.
    const loafCenterPos = camCenter.clone();
    const loafLowerLeftPos = camCenter.clone();
    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      const halfH = 11;
      const aspect = w / h;
      const halfW = halfH * aspect;
      camera.left = -halfW;
      camera.right = halfW;
      camera.top = halfH;
      camera.bottom = -halfH;
      camera.updateProjectionMatrix();
      // Final reveal: chronotope (W × H) should fill the viewport with
      // a small margin. Pick the zoom that fits in the tighter dimension.
      const zoomY = (2 * halfH) / H;
      const zoomX = (2 * halfW) / W;
      revealZoom = Math.min(zoomY, zoomX) * 0.92;
      // Iso-projected screen footprints. A slab (W×H plane in xy at any z)
      // projects to a parallelogram whose bounding box has half-extent:
      //   maxAbs(±W/2 · camR.x ± H/2 · camR.y) along screen x
      //   maxAbs(±W/2 · camU.x ± H/2 · camU.y) along screen y
      // For the loaf, also include ±Z/2 along the camRight/camUp z terms.
      const slabHalfX =
        Math.abs((W / 2) * camRight.x) + Math.abs((H / 2) * camRight.y);
      const slabHalfY =
        Math.abs((W / 2) * camUp.x) + Math.abs((H / 2) * camUp.y);
      const loafHalfX =
        slabHalfX + Math.abs((Z_TOTAL / 2) * camRight.z);
      const loafHalfY =
        slabHalfY + Math.abs((Z_TOTAL / 2) * camUp.z);

      const margin = 1.0;
      // Video center in screen — top-right corner.
      if (videoPlane) {
        const screenX = halfW - margin - slabHalfX;
        const screenY = halfH - margin - slabHalfY;
        videoPlane.position
          .copy(camCenter)
          .addScaledVector(camRight, screenX)
          .addScaledVector(camUp, screenY);
      }
      // Loaf center for scene 1: as far into the lower-left as possible
      // without clipping. Loaf at center for scenes 2-4.
      const loafSx = -halfW + margin + loafHalfX;
      const loafSy = -halfH + margin + loafHalfY;
      loafLowerLeftPos
        .copy(camCenter)
        .addScaledVector(camRight, loafSx)
        .addScaledVector(camUp, loafSy);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // Public controls.
    const resetVideo = () => {
      if (vidEl) {
        try {
          vidEl.currentTime = 0;
        } catch {}
      }
    };
    restartRef.current = () => {
      timeRef.current = 0;
      playingRef.current = true;
      setPlaying(true);
      resetVideo();
    };
    togglePlayRef.current = () => {
      const next = !playingRef.current;
      playingRef.current = next;
      setPlaying(next);
      if (timeRef.current >= TOTAL_DURATION && next) {
        timeRef.current = 0;
        resetVideo();
      }
    };

    const tick = () => {
      const now = performance.now();
      const dt = (now - lastWallMs) / 1000;
      lastWallMs = now;

      // Hold the timeline at the very start until async frame extraction
      // finishes, so slabs don't pop into existence mid-capture. (The first
      // capture lands at t≈0 with the new combined scene 1.)
      const holdT = 0.05;
      if (playingRef.current) {
        if (!framesReadyRef.current && timeRef.current >= holdT) {
          timeRef.current = holdT;
        } else {
          timeRef.current = Math.min(TOTAL_DURATION, timeRef.current + dt);
          if (timeRef.current >= TOTAL_DURATION) {
            playingRef.current = false;
            setPlaying(false);
          }
        }
      }

      const t = timeRef.current;
      animate(t);
      renderer.render(scene, camera);

      // Cheap React state updates: only when scene changes or every ~10
      // frames for the progress bar.
      const idx = sceneIndexAtTime(t);
      setSceneIdx((prev) => (prev === idx ? prev : idx));
      setProgressPct((t / TOTAL_DURATION) * 100);

      raf = requestAnimationFrame(tick);
    };

    function animate(t: number) {
      const p3 = sceneProgress(t, 2); // cut + lift + reveal
      const p4 = sceneProgress(t, 3); // flatten

      // Source video sync: keep paused at t=0 until frames are loaded
      // (otherwise the timeline holds at t≈0 while the video runs free,
      // and drift-correction snaps it back, producing a visible loop).
      // Once ready, play at adjusted rate so video.currentTime tracks
      // the snapshot timeline.
      if (vidEl && vidEl.duration > 0) {
        if (!framesReadyRef.current) {
          if (!vidEl.paused) vidEl.pause();
          if (vidEl.currentTime > 0.05) {
            try { vidEl.currentTime = 0; } catch {}
          }
        } else {
          const captureEnd = SCENE_STARTS[0] + CAPTURE_WINDOW;
          if (t < captureEnd) {
            const targetVidT = Math.max(
              0,
              Math.min(vidEl.duration, (t / CAPTURE_WINDOW) * vidEl.duration),
            );
            if (Math.abs(vidEl.currentTime - targetVidT) > 0.4) {
              vidEl.currentTime = targetVidT;
            }
            if (vidEl.paused) vidEl.play().catch(() => {});
          } else if (!vidEl.paused) {
            vidEl.pause();
          }
        }
      }

      // Camera is fixed (set up in init). No camera animation per user
      // feedback — the only motion in the final scenes is the chronotope
      // plane lifting/flattening.

      // ---------- Video plane (scene 1) ----------
      // Top-right thumbnail. Hidden until frames are loaded; vanishes
      // hard the instant the last slab starts moving (t = CAPTURE_WINDOW)
      // — no fade afterwards. Position + orientation set in resize().
      if (videoPlane) {
        const visible = framesReadyRef.current && t < CAPTURE_WINDOW;
        const mat = videoPlane.material as THREE.MeshBasicMaterial;
        mat.opacity = visible ? 1 : 0;
        mat.transparent = true;
        videoPlane.visible = visible;
      }

      // ---------- Loaf placement (scenes 1 → 2 transition) ----------
      // Loaf sits in the lower-left during capture so frames have room
      // to fly across from the top-right video. Once captures are done
      // (last 15% of scene 1), it slides smoothly to camCenter for the
      // diagonal/cut/reveal scenes.
      const settleK = smoothstep(CAPTURE_WINDOW, SCENE_STARTS[1], t);
      loafGroup.position.copy(loafLowerLeftPos).lerp(loafCenterPos, settleK);

      // ---------- Slabs (scene 1): fly from video into stack ----------
      // Iso orientation throughout — slabs are parallel to the video and
      // to each other, so they just translate from the video's world
      // position to their loaf-local rest spot.
      const N = slabs.length;
      const flyDur = 0.55;
      // videoPlane.position is in world. Convert to loafGroup-local
      // (loafGroup has identity rotation here, so just subtract its
      // current position — which is itself moving during the settle).
      const spawnLocal =
        videoPlane && framesReadyRef.current
          ? videoPlane.position.clone().sub(loafGroup.position)
          : new THREE.Vector3(0, 0, Z_TOTAL / 2 + 1.2);
      const splitMode = t >= SCENE_STARTS[2];
      for (let i = 0; i < N; i++) {
        const s = slabs[i];
        const captureStart =
          SCENE_STARTS[0] + (i / Math.max(1, N - 1)) * CAPTURE_WINDOW;
        const localT = t - captureStart;
        const k = smoothstep(0, flyDur, localT);

        s.group.position.copy(spawnLocal).lerp(s.restPos, k);
        s.group.visible = t >= captureStart;

        // Render mode: full single plane vs. split halves.
        s.full.visible = !splitMode;
        s.left.visible = splitMode;
        s.right.visible = splitMode;
      }

      // ---------- Diagonal line (scene 2 → scene 4) ----------
      // Drawn during scene 2, stays through the cut in scene 3, then
      // fades out during the rotation in scene 4.
      if (diagonalLine) {
        const p2 = sceneProgress(t, 1);
        const op = smoothstep(0.0, 0.3, p2);
        const fadeOut = smoothstep(0.0, 0.5, p4);
        const draw = smoothstep(0.0, 0.55, p2);
        const mat = diagonalLine.material as THREE.MeshBasicMaterial;
        mat.opacity = op * (1 - fadeOut);
        mat.transparent = true;
        diagonalLine.visible = mat.opacity > 0.01;
        const diagLen = Math.sqrt(W * W + Z_TOTAL * Z_TOTAL);
        diagonalLine.scale.y = Math.max(0.0001, draw * diagLen);
      }

      // ---------- Cut + drop (scene 3) ----------
      // Right halves drop down and slide outward (toward +x, the side they
      // came from) — like cut-off slices falling off the cutting board.
      // No opacity fade — both halves keep identical opaque materials so
      // there's no seam at t=0 when they're still coplanar.
      if (splitMode) {
        const k = smoothstep(0.0, 0.7, p3);
        const dropY = k * (H * 2.0);
        const slideX = k * (W * 0.4);
        for (const s of slabs) {
          s.right.position.y = -dropY;
          s.right.position.x = s.right.userData.restX + slideX;
          s.right.visible = k < 1.0;
        }
      }

      // ---------- Loaf rotation + zoom (scene 4): reveal ----------
      // Rotate the entire sliced stack so the slabs face the camera and
      // the loaf's "up" lines up with the screen — the chronotope reads
      // as an upright 16:9 rectangle. Concurrently zoom the ortho camera
      // so the chronotope fills the viewport.
      loafGroup.quaternion.copy(identityQuat).slerp(revealQuat, p4);
      const newZoom = 1 + (revealZoom - 1) * p4;
      if (Math.abs(camera.zoom - newZoom) > 1e-4) {
        camera.zoom = newZoom;
        camera.updateProjectionMatrix();
      }
    }

    // Pre-computed quaternions used by animate() each frame.
    const identityQuat = new THREE.Quaternion();
    // Reveal: rotate the loaf so its local axes match the camera's view
    // basis — local +z → camDir (slabs face camera), local +y → camera's
    // up. That way the chronotope's columns end up horizontal on screen
    // (upright, not tilted) and the slanted plane's diagLen × H footprint
    // foreshortens to exactly W × H = 16:9 in screen space.
    const revealFwd = camDir.clone();
    const revealRight = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), revealFwd)
      .normalize();
    const revealUp = new THREE.Vector3()
      .crossVectors(revealFwd, revealRight)
      .normalize();
    const revealQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(revealRight, revealUp, revealFwd),
    );

    // Hidden video for the live texture during scene 1. Plays through its
    // full duration exactly during the capture window so each snapshot
    // fires at the moment the video reaches that frame's timestamp.
    {
      const v = document.createElement("video");
      v.src = SAMPLE_URL;
      v.crossOrigin = "anonymous";
      v.muted = true;
      v.playsInline = true;
      v.loop = false;
      v.preload = "auto";
      v.addEventListener(
        "loadedmetadata",
        () => {
          if (v.duration > 0) v.playbackRate = v.duration / CAPTURE_WINDOW;
        },
        { once: true },
      );
      vidEl = v;

      videoTexture = new THREE.VideoTexture(v);
      videoTexture.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshBasicMaterial({
        map: videoTexture,
        transparent: true,
      });
      // Plane sized to the small preview footprint, oriented to face the
      // camera (parallel to viewport). Positioned in resize() so it sits
      // in the lower-left of the frustum regardless of container aspect.
      // Iso-oriented (identity rotation) so it's parallel to the slabs.
      videoPlane = new THREE.Mesh(new THREE.PlaneGeometry(W_VID, H_VID), mat);
      scene.add(videoPlane);
    }

    // Diagonal cut line on the top face (loaf-local y = +H/2 + epsilon).
    // Modelled as a thin cylinder along the diagonal so we get a fat,
    // clearly-visible stroke. The cylinder is shifted so its origin is at
    // one end (front-left top corner); the draw animation scales it along
    // its axis from 0 → diagLen.
    {
      const startPoint = new THREE.Vector3(-W / 2, H / 2 + 0.05, Z_TOTAL / 2);
      const endPoint = new THREE.Vector3(W / 2, H / 2 + 0.05, -Z_TOTAL / 2);
      const dir = endPoint.clone().sub(startPoint).normalize();
      const radius = 0.11;
      const geom = new THREE.CylinderGeometry(radius, radius, 1, 14, 1, false);
      // Default cylinder is centered on origin along +y. Shift so its
      // base sits at the origin and it grows along +y.
      geom.translate(0, 0.5, 0);
      const mat = new THREE.MeshBasicMaterial({
        color: 0xff3355,
        transparent: true,
        opacity: 0,
      });
      diagonalLine = new THREE.Mesh(geom, mat);
      diagonalLine.position.copy(startPoint);
      diagonalLine.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir,
      );
      diagonalLine.visible = false;
      loafGroup.add(diagonalLine);
    }

    raf = requestAnimationFrame(tick);
    resize();

    (async () => {
      try {
        const textures = await extractFrames(SAMPLE_URL, N_FRAMES, (frac) => {
          if (!disposed) setLoadProgress(frac);
        });
        if (disposed) return;

        for (let i = 0; i < N_FRAMES; i++) {
          const tex = textures[i];
          const xCut = (i / (N_FRAMES - 1)) * W;
          const wL = Math.max(xCut, 0.0001);
          const wR = Math.max(W - xCut, 0.0001);

          // Children are positioned with the slab's visual CENTER at the
          // group origin (slab-local x=0), so the group's quaternion
          // pivots around the slab's middle — matching how the video
          // plane is anchored at its center.
          //
          // Full slab — one plane, no seam. Used during scenes 1-2.
          const full = new THREE.Mesh(
            new THREE.PlaneGeometry(W, H),
            new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
          );
          full.position.set(0, 0, 0);

          // Left half: world-x ∈ [0, xCut] when at rest, slab-local
          // x ∈ [-W/2, -W/2 + wL]. Hidden until scene 3.
          const leftGeom = new THREE.PlaneGeometry(wL, H);
          const uvL = leftGeom.getAttribute("uv");
          for (let v = 0; v < uvL.count; v++) {
            uvL.setX(v, uvL.getX(v) * (xCut / W));
          }
          uvL.needsUpdate = true;
          const left = new THREE.Mesh(
            leftGeom,
            new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
          );
          left.position.set(-W / 2 + wL / 2, 0, 0);
          left.visible = false;

          // Right half: world-x ∈ [xCut, W] at rest, slab-local
          // x ∈ [-W/2 + xCut, +W/2]. Same material as `left` so no seam
          // when coplanar at scene 3 t=0.
          const rightGeom = new THREE.PlaneGeometry(wR, H);
          const uvR = rightGeom.getAttribute("uv");
          for (let v = 0; v < uvR.count; v++) {
            const u = uvR.getX(v);
            uvR.setX(v, xCut / W + u * (1 - xCut / W));
          }
          uvR.needsUpdate = true;
          const right = new THREE.Mesh(
            rightGeom,
            new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }),
          );
          right.position.set(-W / 2 + xCut + wR / 2, 0, 0);
          right.userData.restX = right.position.x;
          right.visible = false;

          const group = new THREE.Group();
          group.add(full);
          group.add(left);
          group.add(right);
          // Loaf-local rest pos: group origin = slab's visual center.
          // World-x at rest = camCenter.x = W/2 (slab spans world x ∈ [0, W]).
          // Frame 0 ends up closest to camera (z = +Z_TOTAL/2 in local
          // frame); each subsequent capture slides further back.
          const restPos = new THREE.Vector3(
            0,
            0,
            Z_TOTAL / 2 - i * SLAB_GAP,
          );
          group.position.copy(restPos);
          group.visible = false;
          loafGroup.add(group);
          slabs.push({ group, full, left, right, restPos });
        }

        framesReadyRef.current = true;
        setLoading(false);
      } catch (e) {
        if (!disposed) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
      videoTexture?.dispose();
      vidEl?.pause();
    };
  }, []);

  const cur = SCENES[sceneIdx];

  return (
    <div className={`how${inModal ? " how-in-modal" : ""}`}>
      <header className="how-header">
        {inModal ? (
          <h1 className="how-title">The idea</h1>
        ) : (
          <>
            <a className="how-back" href="/">← chronotope</a>
            <h1 className="how-title">The idea</h1>
          </>
        )}
        {inModal && onClose && (
          <button
            type="button"
            className="how-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        )}
      </header>

      <div className="how-stage" ref={containerRef}>
        {loading && (
          <div className="how-loading">
            <ProgressRing progress={loadProgress} />
            <div>Sampling frames… {Math.round(loadProgress * 100)}%</div>
          </div>
        )}
      </div>

      <div className="how-caption">
        <div className="how-step">{cur.title}</div>
        <div className="how-body">{cur.body}</div>
      </div>

      <div className="how-controls">
        <button className="secondary" onClick={() => togglePlayRef.current()}>
          {playing ? "Pause" : progressPct >= 100 ? "Replay" : "Play"}
        </button>
        <button className="secondary" onClick={() => restartRef.current()}>
          Restart
        </button>
        <div className="how-progress">
          <div className="how-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {error && <div className="error">{error}</div>}
    </div>
  );
}

function ProgressRing({ progress }: { progress: number }) {
  const r = 14;
  const c = 2 * Math.PI * r;
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true">
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        stroke="var(--border)"
        strokeWidth="2"
      />
      <circle
        cx="18"
        cy="18"
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - progress)}
        transform="rotate(-90 18 18)"
        style={{ transition: "stroke-dashoffset 80ms linear" }}
      />
    </svg>
  );
}
