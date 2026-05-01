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

const SAMPLES: { key: string; label: string; url: string }[] = [
  { key: "vosges_snow", label: "Cotton candy snow", url: "/vosges_snow.mp4" },
  { key: "verdon", label: "Blue hour", url: "/verdon.mp4" },
];
const N_FRAMES = 24; // slabs in the demo stack
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
// Box thickness shared by every slab + the source video preview.
const SLAB_THICK = 0.045;
// Off-white photo-paper color for the side faces of every slab and
// of the video preview Box.
const SIDE_COLOR = 0xf2f0eb;

interface Scene {
  title: string;
  body: string;
  duration: number;
}

// Scene 1 (mark diagonal) and 2 (drop off-cut) share a caption — the
// animation splits them into distinct phases for clarity, but for the
// reader they're one conceptual step: cut the block diagonally.
const SCENES: Scene[] = [
  { title: "1. Stack frames in time", body: "Time becomes the third axis.", duration: 12.0 },
  { title: "2. Slice diagonally", body: "Corner to corner across the block.", duration: 2.2 },
  { title: "2. Slice diagonally", body: "Corner to corner across the block.", duration: 4.0 },
  { title: "3. The slice is the chronotope", body: "Each column is a different moment.", duration: 3.0 },
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
// component unmount; on subsequent opens we reuse the same canvases so
// their content is already populated (no blank-frame flash for a beat).
const frameCache = new Map<string, HTMLCanvasElement[]>();

// Allocate (or reuse) N empty per-slab canvases + matching CanvasTextures.
// Each slab gets its own texture; the canvas is drawn into during scene 1
// at the moment the corresponding slab is captured.
function allocateFrameTextures(
  url: string,
  n: number,
): { canvases: HTMLCanvasElement[]; textures: THREE.CanvasTexture[] } {
  const cacheKey = `${url}::${n}::${FRAME_TEX_W}x${FRAME_TEX_H}`;
  let canvases = frameCache.get(cacheKey);
  if (!canvases) {
    canvases = [];
    for (let i = 0; i < n; i++) {
      const c = document.createElement("canvas");
      c.width = FRAME_TEX_W;
      c.height = FRAME_TEX_H;
      canvases.push(c);
    }
    frameCache.set(cacheKey, canvases);
  }
  // CanvasTexture is GL-context-bound, so we always make fresh textures.
  const textures = canvases.map((c) => {
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  });
  return { canvases, textures };
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
  const [sampleIdx, setSampleIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const sample = SAMPLES[sampleIdx];

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
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;

    const scene = new THREE.Scene();
    // Perspective camera with a narrow FOV at long distance so the
    // foreshortening between front and back slabs is subtle (~15%) but
    // present — gives the stack real 3D depth without distorting the
    // chronotope reveal. Aspect set in resize().
    const CAM_DISTANCE = 60;
    const CAM_FOV = 20;
    const camera = new THREE.PerspectiveCamera(CAM_FOV, 1, 0.1, 300);
    const camCenter = new THREE.Vector3(W / 2, H / 2, Z_TOTAL / 2);
    const camDir = new THREE.Vector3(0.85, 0.7, 1).normalize();
    camera.position.copy(camCenter).addScaledVector(camDir, CAM_DISTANCE);
    camera.lookAt(camCenter);

    // Lighting: bright ambient so the (Lambert) photo-paper side faces
    // stay near-white, plus a directional source roughly parallel to the
    // stack axis (low-front position) so each slab casts a soft shadow
    // onto the white sides of the slabs behind it. Front faces of slabs
    // use unlit MeshBasicMaterial so the video textures stay at their
    // source brightness — only the sides receive light/shadow.
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.85);
    dirLight.position.set(camCenter.x, camCenter.y - 12, camCenter.z + 30);
    dirLight.target.position.copy(camCenter);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.set(2048, 2048);
    dirLight.shadow.bias = -0.0008;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 80;
    dirLight.shadow.camera.left = -22;
    dirLight.shadow.camera.right = 22;
    dirLight.shadow.camera.top = 22;
    dirLight.shadow.camera.bottom = -22;
    scene.add(dirLight);
    scene.add(dirLight.target);

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

    // Updated each resize. revealZoom = camera.zoom that fills the
    // viewport with the chronotope at scene 4. baseZoom = camera.zoom
    // for scenes 1-3, picked so the lower-left loaf + top-right video
    // (or top + bottom in portrait) both fit.
    let revealZoom = 1;
    let baseZoom = 1;
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
      const aspect = w / h;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      // World half-extents at the camCenter plane (where the loaf sits) —
      // used for placing the video plane and computing scene-4 zoom.
      const halfH =
        CAM_DISTANCE * Math.tan(THREE.MathUtils.degToRad(CAM_FOV / 2));
      const halfW = halfH * aspect;
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
      // Pick layout based on aspect: side-by-side on landscape, stacked
      // top/bottom on portrait/square (where horizontal space is tight).
      const isPortrait = aspect < 1.2;

      // Required content half-extents for the chosen layout.
      const requiredHalfW = isPortrait
        ? Math.max(loafHalfX, slabHalfX) + margin
        : loafHalfX + slabHalfX + 2 * margin;
      const requiredHalfH = isPortrait
        ? loafHalfY + slabHalfY + 2 * margin
        : Math.max(loafHalfY, slabHalfY) + margin;

      // Base zoom for scenes 1-3: pulled back enough that the chosen
      // layout's content fits the viewport. For a wide landscape this
      // stays at 1.0; for narrow portraits it shrinks below 1.
      baseZoom = Math.min(
        halfW / requiredHalfW,
        halfH / requiredHalfH,
        1.0,
      );

      // Effective viewport half-extents AFTER applying baseZoom — these
      // are what we use to place objects at the visible edges. Without
      // this, content stays bunched near center on portrait.
      const effHalfW = halfW / baseZoom;
      const effHalfH = halfH / baseZoom;

      // Video position (top-right on landscape, top-center on portrait).
      if (videoPlane) {
        const screenX = isPortrait ? 0 : effHalfW - margin - slabHalfX;
        const screenY = effHalfH - margin - slabHalfY;
        videoPlane.position
          .copy(camCenter)
          .addScaledVector(camRight, screenX)
          .addScaledVector(camUp, screenY);
      }
      // Loaf rest pos for scene 1 (bottom-left landscape, bottom-center
      // portrait). Loaf moves to camCenter for scenes 2-4.
      const loafSx = isPortrait ? 0 : -effHalfW + margin + loafHalfX;
      const loafSy = -effHalfH + margin + loafHalfY;
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
    const resetCaptureFlags = () => {
      for (const s of slabs) s.group.userData.captured = false;
    };
    restartRef.current = () => {
      timeRef.current = 0;
      playingRef.current = true;
      setPlaying(true);
      resetVideo();
      resetCaptureFlags();
    };
    togglePlayRef.current = () => {
      const next = !playingRef.current;
      playingRef.current = next;
      setPlaying(next);
      if (timeRef.current >= TOTAL_DURATION && next) {
        timeRef.current = 0;
        resetVideo();
        resetCaptureFlags();
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
            // Match the playbackRate cap above: target time tops out at
            // duration-0.1 so we never seek into the `ended` zone.
            const lastT = Math.max(0, vidEl.duration - 0.1);
            const targetVidT = Math.max(
              0,
              Math.min(lastT, (t / CAPTURE_WINDOW) * lastT),
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
        videoPlane.visible =
          framesReadyRef.current && t < CAPTURE_WINDOW;
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

        // On-the-fly frame capture: the moment a slab's captureStart is
        // reached, paint the current source-video frame into its canvas
        // and flag the texture for upload. Video is already synced to
        // i/(N-1)·duration at this scene time, so this matches the old
        // upfront-extracted frame. Visibility is gated on captured so
        // slab 0 doesn't render black for a frame if the video isn't yet
        // ready when t crosses 0.
        if (
          !s.group.userData.captured &&
          t >= captureStart &&
          vidEl &&
          vidEl.readyState >= 2
        ) {
          const ctx = frameCanvases[i].getContext("2d");
          if (ctx) {
            ctx.drawImage(vidEl, 0, 0, FRAME_TEX_W, FRAME_TEX_H);
            textures[i].needsUpdate = true;
            s.group.userData.captured = true;
          }
        }
        s.group.visible =
          t >= captureStart && s.group.userData.captured === true;

        // Fly-in opacity: invisible at spawn (slab is at the video plane,
        // both coincide in z) → fully opaque on landing. Two things have
        // to be true for the slab to actually show as transparent over
        // the video: (a) opacity=k via transparent material with
        // depthWrite=false (so the half-faded slab doesn't punch holes
        // in the depth buffer); (b) renderOrder=1 so the slab always
        // renders AFTER the videoPlane (renderOrder=0) — without this,
        // when the two coincide the back-to-front sort can land the
        // videoPlane after the slab and the opaque video alpha=1 wipes
        // the slab out (the "spawns behind the video" symptom). On
        // landing, flip back to opaque + renderOrder=0 so the loaf
        // renders in the normal opaque pass.
        const fullArr = s.full.material as THREE.Material[];
        const sideMatI = fullArr[0] as THREE.MeshLambertMaterial;
        const frontMatI = fullArr[4] as THREE.MeshBasicMaterial;
        // Last slab spawns exactly when the videoPlane vanishes — there's
        // nothing behind it to fade over, so fading would just dissolve
        // it against the dark bg. Treat it as solid from spawn.
        const isLastSlab = i === N - 1;
        const flying = !splitMode && !isLastSlab && k < 1 - 0.005;
        if (sideMatI.transparent !== flying) {
          sideMatI.transparent = flying;
          sideMatI.depthWrite = !flying;
          sideMatI.needsUpdate = true;
          frontMatI.transparent = flying;
          frontMatI.depthWrite = !flying;
          frontMatI.needsUpdate = true;
          s.full.renderOrder = flying ? 1 : 0;
        }
        const flyOpacity = flying ? k : 1;
        sideMatI.opacity = flyOpacity;
        frontMatI.opacity = flyOpacity;

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
        // Two fade phases: dissolves alongside the dropping cut-off
        // halves in scene 3, then any residue fades over scene 4.
        const fadeOut3 = smoothstep(0.2, 0.9, p3);
        const fadeOut4 = smoothstep(0.0, 0.5, p4);
        const draw = smoothstep(0.0, 0.55, p2);
        const mat = diagonalLine.material as THREE.MeshLambertMaterial;
        mat.opacity = op * (1 - fadeOut3) * (1 - fadeOut4);
        mat.transparent = true;
        diagonalLine.visible = mat.opacity > 0.01;
        // Diagonal goes from (W/N, Z) to (W, 0) in (x, z), so the actual
        // length differs slightly from the loaf's full diagonal.
        const dW = W * ((N_FRAMES - 1) / N_FRAMES);
        const diagLen = Math.sqrt(dW * dW + Z_TOTAL * Z_TOTAL);
        diagonalLine.scale.y = Math.max(0.0001, draw * diagLen);
        // Drop with the cut-off halves during scene 3 (matches the same
        // dropY / slideX as `s.right.position`).
        const k3 = smoothstep(0.0, 0.7, p3);
        const dropY = k3 * (H * 2.0);
        const slideX = k3 * (W * 0.4);
        const rest = diagonalLine.userData.restPos as THREE.Vector3;
        diagonalLine.position.set(
          rest.x + slideX,
          rest.y - dropY,
          rest.z,
        );
      }

      // ---------- Cut + drop (scene 3) ----------
      // Right halves drop down and slide outward (toward +x). They also
      // dissolve (opacity fade) over the second half of the drop so on
      // tall viewports — where the drop distance can't reach the bottom
      // edge — they still vanish before the rotation reveal.
      if (splitMode) {
        const k = smoothstep(0.0, 0.7, p3);
        const dropY = k * (H * 2.0);
        const slideX = k * (W * 0.4);
        const dropOpacity = 1 - smoothstep(0.2, 0.9, p3);
        for (const s of slabs) {
          s.right.position.y = -dropY;
          s.right.position.x = s.right.userData.restX + slideX;
          s.right.visible = dropOpacity > 0.01;
          const arr = s.right.material as THREE.Material[];
          // Materials at index 0 (side, shared in 0/1/2/3/5) and 4 (front)
          // are cloned per slab — safe to set opacity here without
          // affecting full/left slab materials.
          (arr[0] as THREE.MeshLambertMaterial).opacity = dropOpacity;
          (arr[4] as THREE.MeshBasicMaterial).opacity = dropOpacity;
        }
      }

      // ---------- Loaf rotation + zoom (scene 4): reveal ----------
      // Rotate the entire sliced stack so the slabs face the camera and
      // the loaf's "up" lines up with the screen — the chronotope reads
      // as an upright 16:9 rectangle. Concurrently zoom the ortho camera
      // so the chronotope fills the viewport.
      loafGroup.quaternion.copy(identityQuat).slerp(revealQuat, p4);
      // baseZoom (set in resize) fits the loaf+video layout for the
      // current aspect; lerp to revealZoom over scene 4 to fill the
      // viewport with the chronotope.
      const newZoom = baseZoom + (revealZoom - baseZoom) * p4;
      if (Math.abs(camera.zoom - newZoom) > 1e-4) {
        camera.zoom = newZoom;
        camera.updateProjectionMatrix();
      }
      // Collapse the loaf along its z axis so the slabs lose their
      // depth offsets and thickness — at the reveal they're essentially
      // coplanar and the chronotope chunks join seamlessly with no
      // perspective scale differences between adjacent slabs.
      loafGroup.scale.z = 1 - 0.985 * p4;

      // Fade the directional light (and ramp ambient up) as the rotation
      // begins, so the side faces lose their cast shadows and the
      // chronotope reveal lands shadow-free and uniformly bright.
      const shadowK = 1 - smoothstep(0, 0.4, p4);
      dirLight.intensity = 0.85 * shadowK;
      ambientLight.intensity = 0.7 + (1 - shadowK) * 0.3;
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
      v.src = sample.url;
      v.crossOrigin = "anonymous";
      v.muted = true;
      v.playsInline = true;
      v.loop = false;
      v.preload = "auto";
      v.addEventListener(
        "loadedmetadata",
        () => {
          // Cap playback so the video ends at duration-0.1 by the time
          // the last slab's captureStart fires. Without this, some
          // browsers reset the video frame after `ended`, so the last
          // drawImage() captures frame 0 instead of the last frame.
          if (v.duration > 0) {
            v.playbackRate = Math.max(
              0.1,
              (v.duration - 0.1) / CAPTURE_WINDOW,
            );
          }
        },
        { once: true },
      );
      vidEl = v;

      videoTexture = new THREE.VideoTexture(v);
      videoTexture.colorSpace = THREE.SRGBColorSpace;
      // Same thin Box treatment as the slabs: video texture on the +z
      // front face (Basic, unlit), photopaper-white Lambert on the sides.
      // Iso-oriented (identity rotation) so it's parallel to the slabs.
      const frontMat = new THREE.MeshBasicMaterial({
        map: videoTexture,
        transparent: true,
      });
      const sideMatVid = new THREE.MeshLambertMaterial({ color: SIDE_COLOR });
      videoPlane = new THREE.Mesh(
        new THREE.BoxGeometry(W_VID, H_VID, SLAB_THICK),
        [
          sideMatVid, // +x
          sideMatVid, // -x
          sideMatVid, // +y
          sideMatVid, // -y
          frontMat, // +z (video, unlit)
          sideMatVid, // -z
        ],
      );
      videoPlane.castShadow = true;
      videoPlane.receiveShadow = true;
      scene.add(videoPlane);
    }

    // Diagonal cut line on the top face (loaf-local y = +H/2 + epsilon).
    // Modelled as a thin cylinder along the diagonal so we get a fat,
    // clearly-visible stroke. The cylinder is shifted so its origin is at
    // one end (start), then scaled along its axis from 0 → diagLen.
    //
    // Endpoints match where the cut actually falls on the first and last
    // slabs: on slab 0 at x = -W/2 + W/N (its xCut), and on slab N-1 at
    // x = +W/2 (its xCut = W).
    {
      const startPoint = new THREE.Vector3(
        -W / 2 + W / N_FRAMES,
        H / 2 + 0.05,
        Z_TOTAL / 2,
      );
      const endPoint = new THREE.Vector3(W / 2, H / 2 + 0.05, -Z_TOTAL / 2);
      const dir = endPoint.clone().sub(startPoint).normalize();
      const radius = 0.15;
      const geom = new THREE.CylinderGeometry(radius, radius, 1, 18, 1, false);
      // Default cylinder is centered on origin along +y. Shift so its
      // base sits at the origin and it grows along +y.
      geom.translate(0, 0.5, 0);
      // Lambert (not Basic) so the cylinder responds to the directional
      // light — its sides shade across the curve, giving a 3D look
      // instead of reading as a flat 2D stroke.
      const mat = new THREE.MeshLambertMaterial({
        color: 0xff3355,
        transparent: true,
        opacity: 0,
      });
      diagonalLine = new THREE.Mesh(geom, mat);
      diagonalLine.position.copy(startPoint);
      diagonalLine.userData.restPos = startPoint.clone();
      diagonalLine.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 1, 0),
        dir,
      );
      diagonalLine.castShadow = true;
      diagonalLine.receiveShadow = true;
      diagonalLine.visible = false;
      loafGroup.add(diagonalLine);
    }

    raf = requestAnimationFrame(tick);
    resize();

    // Allocate empty per-slab canvases + textures synchronously; we draw
    // into them on the fly during scene 1 (no upfront seek pump).
    const { canvases: frameCanvases, textures } = allocateFrameTextures(
      sample.url,
      N_FRAMES,
    );

    // Build slabs immediately. Their textures start empty; each is filled
    // in animate() when the corresponding slab's captureStart is reached.
    {
      // Shared white photo-paper material for the side faces. Lambert
      // so it responds to the directional light and receives shadows
      // from adjacent slabs. BoxGeometry face/group order:
      //   0: +x   1: -x   2: +y   3: -y   4: +z (front)   5: -z
      const sideMat = new THREE.MeshLambertMaterial({ color: SIDE_COLOR });

        for (let i = 0; i < N_FRAMES; i++) {
          const tex = textures[i];
          // Each slab represents a chunk of W/N columns of the
          // chronotope, so slab i keeps columns [0, (i+1)·W/N]. This
          // gives slab 0 a non-zero (W/N) keep-strip — without it the
          // first slab vanishes entirely after the cut.
          const xCut = ((i + 1) / N_FRAMES) * W;
          const wL = Math.max(xCut, 0.0001);
          const wR = Math.max(W - xCut, 0.0001);

          // Helper to build a Box-slab with the video texture on its +z
          // face and dark gray everywhere else. uMin/uMax remap the +z
          // face's u coordinate so the slab shows the right slice of the
          // texture (full for `full`, left portion for `left`, right
          // portion for `right`).
          const makeSlab = (
            boxW: number,
            uMin: number,
            uMax: number,
          ): THREE.Mesh => {
            const geom = new THREE.BoxGeometry(boxW, H, SLAB_THICK);
            const uvs = geom.getAttribute("uv");
            // BoxGeometry +z face vertices are uv indices 16..19.
            for (let v = 16; v <= 19; v++) {
              const u = uvs.getX(v);
              uvs.setX(v, uMin + u * (uMax - uMin));
            }
            uvs.needsUpdate = true;
            const frontMat = new THREE.MeshBasicMaterial({ map: tex });
            const mesh = new THREE.Mesh(geom, [
              sideMat, // +x
              sideMat, // -x
              sideMat, // +y
              sideMat, // -y
              frontMat, // +z (textured front, unlit)
              sideMat, // -z
            ]);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            return mesh;
          };

          // Full slab — full texture. Used during scenes 1-2. Materials
          // cloned per-slab and marked transparent (with depthWrite off)
          // so the fly-in fade doesn't bleed into the shared sideMat used
          // by left, and the partially-faded slab doesn't punch holes in
          // the depth buffer. Switched back to opaque on landing.
          const full = makeSlab(W, 0, 1);
          {
            const arr = full.material as THREE.Material[];
            const cloneSide = (
              arr[0] as THREE.MeshLambertMaterial
            ).clone();
            cloneSide.transparent = true;
            cloneSide.depthWrite = false;
            const cloneFront = (
              arr[4] as THREE.MeshBasicMaterial
            ).clone();
            cloneFront.transparent = true;
            cloneFront.depthWrite = false;
            full.material = [
              cloneSide,
              cloneSide,
              cloneSide,
              cloneSide,
              cloneFront,
              cloneSide,
            ];
          }
          full.position.set(0, 0, 0);
          // Match the flying state set in animate(): renders after the
          // videoPlane (renderOrder=0) so the half-faded slab composites
          // over the video instead of being wiped by it. Flipped back to
          // 0 on landing.
          full.renderOrder = 1;

          // Left half: x ∈ [0, xCut], texture u ∈ [0, xCut/W]. Hidden
          // until scene 3.
          const left = makeSlab(wL, 0, xCut / W);
          left.position.set(-W / 2 + wL / 2, 0, 0);
          left.visible = false;

          // Right half: x ∈ [xCut, W], texture u ∈ [xCut/W, 1].
          // Clone the materials so the per-slab fade in scene 3 doesn't
          // bleed into the shared sideMat used by full + left.
          const right = makeSlab(wR, xCut / W, 1);
          {
            const arr = right.material as THREE.Material[];
            const cloneSide = (
              arr[0] as THREE.MeshLambertMaterial
            ).clone();
            cloneSide.transparent = true;
            const cloneFront = (
              arr[4] as THREE.MeshBasicMaterial
            ).clone();
            cloneFront.transparent = true;
            right.material = [
              cloneSide,
              cloneSide,
              cloneSide,
              cloneSide,
              cloneFront,
              cloneSide,
            ];
          }
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
    }

    // framesReadyRef goes true once the video has decoded enough that
    // drawImage(vidEl, ...) yields a real frame — happens fast (no seek
    // pump). Until then the timeline holds at t=0.
    if (vidEl) {
      const markReady = () => {
        if (disposed) return;
        framesReadyRef.current = true;
      };
      if (vidEl.readyState >= 2) {
        markReady();
      } else {
        vidEl.addEventListener("canplay", markReady, { once: true });
      }
      vidEl.addEventListener(
        "error",
        () => {
          if (!disposed) setError("Couldn't load the sample video.");
        },
        { once: true },
      );
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.dispose();
      renderer.domElement.remove();
      videoTexture?.dispose();
      vidEl?.pause();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample.url]);

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

      <div className="how-stage" ref={containerRef} />

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
        <div className="how-samples">
          {SAMPLES.map((s, i) => (
            <button
              key={s.key}
              type="button"
              className="link"
              aria-pressed={i === sampleIdx}
              onClick={() => setSampleIdx(i)}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="how-progress">
          <div className="how-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
      </div>

      {error && <div className="error">{error}</div>}
    </div>
  );
}

