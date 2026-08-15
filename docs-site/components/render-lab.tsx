'use client';

import { useEffect, useRef, useState } from 'react';
import type { RenderProjection, RenderUpAxis } from 'nanoraster';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { anglesFromOffset, offsetFromAngles } from './camera-math';
import styles from './render-lab.module.css';

type Camera = {
  readonly phi: number;
  readonly theta: number;
};

type Settings = {
  readonly background: string;
  readonly height: number;
  readonly includeAxes: boolean;
  readonly includeScale: boolean;
  readonly margin: number;
  readonly projection: RenderProjection;
  readonly quality: number;
  readonly up: RenderUpAxis;
  readonly width: number;
};

type Capture = {
  readonly bytes: number;
  readonly camera: Camera;
  readonly elapsedMs: number;
  readonly position: readonly [number, number, number];
  readonly url: string;
};

type Viewport = {
  readonly controls: OrbitControls;
  readonly orthographic: THREE.OrthographicCamera;
  readonly perspective: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  active: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  baseDistance: number;
  bounds: THREE.Box3;
  center: THREE.Vector3;
  model?: THREE.Group;
  radius: number;
  synchronizing: boolean;
};

type WasmRenderer = {
  readonly default: (input: { readonly module_or_path: URL }) => Promise<unknown>;
  readonly render_glb_to_image: (
    glb: Uint8Array<ArrayBuffer>,
    optionsJson: string,
  ) => Promise<Uint8Array<ArrayBuffer>>;
};

const DEFAULT_CAMERA: Camera = { phi: 60, theta: -45 };
const DEFAULT_SETTINGS: Settings = {
  background: '#0c1015',
  height: 480,
  includeAxes: true,
  includeScale: false,
  margin: 0.1,
  projection: 'perspective',
  quality: 0.92,
  up: 'y',
  width: 640,
};
const CAMERA_DISTANCE_RATIO = (2 * Math.tan(Math.PI / 6)) / Math.tan(Math.PI / 8);
const CAMERA_FOV = 45;
const DEFAULT_GLB = '/demo/gear-12-metal.glb';
let wasmRenderer: Promise<WasmRenderer> | undefined;

const loadWasmRenderer = async (): Promise<WasmRenderer> => {
  wasmRenderer ??= (async () => {
    const moduleUrl = new URL('/demo/render_wasm.js', window.location.href).href;
    const module = (await import(/* webpackIgnore: true */ moduleUrl)) as unknown as WasmRenderer;
    await module.default({
      module_or_path: new URL('/demo/render_wasm_bg.wasm', window.location.href),
    });
    return module;
  })();
  return wasmRenderer;
};

const colorChannels = (hex: string): readonly [number, number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
  1,
];

const round = (value: number, precision = 1): number => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

const axisVector = (up: RenderUpAxis): THREE.Vector3 => {
  if (up === 'x') return new THREE.Vector3(1, 0, 0);
  if (up === 'z') return new THREE.Vector3(0, 0, 1);
  return new THREE.Vector3(0, 1, 0);
};

const boxCorners = ({ min, max }: THREE.Box3): THREE.Vector3[] =>
  Array.from(
    { length: 8 },
    (_, index) =>
      new THREE.Vector3(index & 1 ? max.x : min.x, index & 2 ? max.y : min.y, index & 4 ? max.z : min.z),
  );

const fitPerspective = (
  camera: THREE.PerspectiveCamera,
  bounds: THREE.Box3,
  target: THREE.Vector3,
  padding: number,
): void => {
  const forward = target.clone().sub(camera.position).normalize();
  let right = forward.clone().cross(camera.up);
  if (right.lengthSq() < 1e-6) right = forward.clone().cross(new THREE.Vector3(1, 0, 0));
  right.normalize();
  const up = right.clone().cross(forward).normalize();
  let horizontal = 0;
  let vertical = 0;
  for (const corner of boxCorners(bounds)) {
    const offset = corner.sub(camera.position);
    const depth = offset.dot(forward);
    if (depth <= 1e-6) continue;
    horizontal = Math.max(horizontal, Math.abs(offset.dot(right) / depth));
    vertical = Math.max(vertical, Math.abs(offset.dot(up) / depth));
  }
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const verticalZoom = vertical > 1e-6 ? tangent / vertical : Number.POSITIVE_INFINITY;
  const horizontalZoom =
    horizontal > 1e-6 ? (camera.aspect * tangent) / horizontal : Number.POSITIVE_INFINITY;
  camera.zoom = Math.max(0.001, Math.min(verticalZoom, horizontalZoom) * padding);
  camera.updateProjectionMatrix();
};

const fitOrthographic = (
  camera: THREE.OrthographicCamera,
  bounds: THREE.Box3,
  target: THREE.Vector3,
  aspect: number,
  padding: number,
): void => {
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  let halfWidth = 0;
  let halfHeight = 0;
  for (const corner of boxCorners(bounds)) {
    corner.applyMatrix4(camera.matrixWorldInverse);
    halfWidth = Math.max(halfWidth, Math.abs(corner.x));
    halfHeight = Math.max(halfHeight, Math.abs(corner.y));
  }
  halfWidth = Math.max(0.001, halfWidth / padding);
  halfHeight = Math.max(0.001, halfHeight / padding);
  if (halfWidth / halfHeight < aspect) halfWidth = halfHeight * aspect;
  else halfHeight = halfWidth / aspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.zoom = 1;
  camera.updateProjectionMatrix();
};

const disposeModel = (model: THREE.Object3D): void => {
  model.traverse((object) => {
    if (!(object instanceof THREE.LineSegments || object instanceof THREE.Mesh)) return;
    const geometry = object.geometry as THREE.BufferGeometry;
    const material = object.material as THREE.Material | THREE.Material[];
    geometry.dispose();
    const materials = Array.isArray(material) ? material : [material];
    for (const material of materials) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
};

const renderViewport = (viewport: Viewport): void => {
  viewport.renderer.render(viewport.scene, viewport.active);
};

const applyCamera = (viewport: Viewport, camera: Camera, settings: Settings): void => {
  viewport.synchronizing = true;
  const next = settings.projection === 'orthographic' ? viewport.orthographic : viewport.perspective;
  if (viewport.active !== next) {
    viewport.active = next;
    viewport.controls.object = next;
  }
  const [x, y, z] = offsetFromAngles(camera, viewport.baseDistance, settings.up);
  viewport.active.position.set(viewport.center.x + x, viewport.center.y + y, viewport.center.z + z);
  viewport.active.up.copy(axisVector(settings.up));
  viewport.controls.target.copy(viewport.center);
  viewport.active.lookAt(viewport.center);
  const width = viewport.renderer.domElement.clientWidth;
  const height = viewport.renderer.domElement.clientHeight;
  const aspect = width / Math.max(1, height);
  const padding = 1 - settings.margin;
  viewport.perspective.aspect = aspect;
  viewport.perspective.near = Math.max(0.001, viewport.baseDistance - 2 * viewport.radius);
  viewport.perspective.far = viewport.baseDistance + 2 * viewport.radius;
  viewport.orthographic.near = viewport.perspective.near;
  viewport.orthographic.far = viewport.perspective.far;
  if (next instanceof THREE.PerspectiveCamera)
    fitPerspective(next, viewport.bounds, viewport.center, padding);
  else fitOrthographic(next, viewport.bounds, viewport.center, aspect, padding);
  viewport.controls.minDistance = viewport.baseDistance * 0.9;
  viewport.controls.maxDistance = viewport.baseDistance * 1.8;
  viewport.controls.update();
  viewport.synchronizing = false;
  renderViewport(viewport);
};

const capturePosition = (viewport: Viewport): readonly [number, number, number] => [
  round(viewport.active.position.x, 2),
  round(viewport.active.position.y, 2),
  round(viewport.active.position.z, 2),
];

/** Interactive proof that a Three.js camera can drive a NanoRaster capture. */
export const RenderLab = (): React.JSX.Element => {
  const mountRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Viewport | undefined>(undefined);
  const loadModelRef = useRef<((bytes: Uint8Array<ArrayBuffer>, name: string) => Promise<void>) | undefined>(
    undefined,
  );
  const cameraRef = useRef<Camera>(DEFAULT_CAMERA);
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const captureUrlRef = useRef<string | undefined>(undefined);
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const [capture, setCapture] = useState<Capture>();
  const [glb, setGlb] = useState<Uint8Array<ArrayBuffer>>();
  const [modelName, setModelName] = useState('metal gear · 381 KB');
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState('Loading live GLB…');
  const [rendering, setRendering] = useState(false);

  cameraRef.current = camera;
  settingsRef.current = settings;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(DEFAULT_SETTINGS.background);
    scene.add(new THREE.HemisphereLight(0xe7f0ff, 0x202833, 2.6));
    const key = new THREE.DirectionalLight(0xffffff, 3.8);
    key.position.set(4, 6, 5);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x8dd9ff, 2.2);
    rim.position.set(-5, 1, -4);
    scene.add(rim);
    const perspective = new THREE.PerspectiveCamera(CAMERA_FOV, 4 / 3, 0.01, 1000);
    const orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
    const controls = new OrbitControls<THREE.Camera>(perspective, renderer.domElement);
    controls.enableDamping = false;
    controls.enablePan = false;
    controls.rotateSpeed = 0.75;
    controls.zoomSpeed = 0.8;
    const viewport: Viewport = {
      active: perspective,
      baseDistance: 3,
      bounds: new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)),
      center: new THREE.Vector3(),
      controls,
      orthographic,
      perspective,
      radius: 1,
      renderer,
      scene,
      synchronizing: false,
    };
    viewportRef.current = viewport;

    const resize = (): void => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      renderer.setSize(width, height, false);
      applyCamera(viewport, cameraRef.current, settingsRef.current);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    controls.addEventListener('change', () => {
      if (viewport.synchronizing) return;
      const offset = viewport.active.position.clone().sub(controls.target);
      const length = offset.length();
      const padding = THREE.MathUtils.clamp(
        (1 - settingsRef.current.margin) * (viewport.baseDistance / Math.max(length, 1e-6)),
        0.5,
        1,
      );
      offset.setLength(viewport.baseDistance);
      viewport.active.position.copy(controls.target).add(offset);
      const nextCamera = anglesFromOffset([offset.x, offset.y, offset.z], settingsRef.current.up);
      const rounded = { phi: round(nextCamera.phi), theta: round(nextCamera.theta) };
      cameraRef.current = rounded;
      setCamera(rounded);
      if (
        viewport.active === viewport.perspective &&
        Math.abs(1 - padding - settingsRef.current.margin) > 0.001
      ) {
        setSettings((current) => ({ ...current, margin: round(1 - padding, 3) }));
      }
      applyCamera(viewport, rounded, { ...settingsRef.current, margin: 1 - padding });
    });

    loadModelRef.current = async (bytes, name) => {
      setStatus(`Reading ${name}…`);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const loaded = await new GLTFLoader().parseAsync(buffer, '');
      if (viewport.model) {
        viewport.scene.remove(viewport.model);
        disposeModel(viewport.model);
      }
      viewport.model = loaded.scene;
      viewport.scene.add(loaded.scene);
      viewport.bounds = new THREE.Box3().setFromObject(loaded.scene);
      viewport.center = viewport.bounds.getCenter(new THREE.Vector3());
      viewport.radius = Math.max(viewport.bounds.getSize(new THREE.Vector3()).length() / 2, 0.001);
      viewport.baseDistance = viewport.radius * CAMERA_DISTANCE_RATIO;
      cameraRef.current = DEFAULT_CAMERA;
      setCamera(DEFAULT_CAMERA);
      applyCamera(viewport, DEFAULT_CAMERA, settingsRef.current);
      setStatus('Drag to orbit · scroll or pinch to frame');
    };

    resize();
    let cancelled = false;
    void fetch(DEFAULT_GLB)
      .then(async (response) => {
        if (!response.ok) throw new Error(`demo GLB returned ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (cancelled) return;
        setGlb(bytes);
        await loadModelRef.current?.(bytes, 'the demo gear');
      })
      .catch((error: unknown) => {
        setStatus(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
      observer.disconnect();
      controls.dispose();
      if (viewport.model) disposeModel(viewport.model);
      renderer.dispose();
      renderer.domElement.remove();
      viewportRef.current = undefined;
      loadModelRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scene.background = new THREE.Color(settings.background);
    applyCamera(viewport, camera, settings);
  }, [camera, settings]);

  useEffect(
    () => () => {
      if (captureUrlRef.current) URL.revokeObjectURL(captureUrlRef.current);
    },
    [],
  );

  const updateSettings = <Key extends keyof Settings>(key: Key, value: Settings[Key]): void => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const loadFile = async (file: File): Promise<void> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await loadModelRef.current?.(bytes, file.name);
      if (captureUrlRef.current) URL.revokeObjectURL(captureUrlRef.current);
      captureUrlRef.current = undefined;
      setCapture(undefined);
      setGlb(bytes);
      setModelName(`${file.name} · ${(bytes.byteLength / 1024).toFixed(0)} KB`);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const renderFrame = async (): Promise<void> => {
    const viewport = viewportRef.current;
    if (!viewport || !glb) return;
    if (!(navigator as Navigator & { gpu?: unknown }).gpu) {
      setStatus('WebGPU is unavailable in this browser.');
      return;
    }
    const offset = viewport.active.position.clone().sub(viewport.controls.target);
    const liveCamera = anglesFromOffset([offset.x, offset.y, offset.z], settings.up);
    const sampledCamera = { phi: round(liveCamera.phi), theta: round(liveCamera.theta) };
    setRendering(true);
    setStatus('NanoRaster is encoding WebP…');
    const started = performance.now();
    try {
      const renderer = await loadWasmRenderer();
      const bytes = await renderer.render_glb_to_image(
        glb,
        JSON.stringify({
          background: colorChannels(settings.background),
          format: 'webp',
          height: settings.height,
          includeAxes: settings.includeAxes,
          includeScale: settings.includeScale,
          margin: settings.margin,
          phi: sampledCamera.phi,
          projection: settings.projection,
          quality: settings.quality,
          theta: sampledCamera.theta,
          up: settings.up,
          width: settings.width,
        }),
      );
      if (captureUrlRef.current) URL.revokeObjectURL(captureUrlRef.current);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
      captureUrlRef.current = url;
      setCapture({
        bytes: bytes.byteLength,
        camera: sampledCamera,
        elapsedMs: performance.now() - started,
        position: capturePosition(viewport),
        url,
      });
      setStatus('WebP captured from the live camera');
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRendering(false);
    }
  };

  const usePreset = (next: Camera): void => {
    setCamera(next);
  };

  return (
    <section className={styles.lab} id="live-demo" aria-labelledby="lab-title">
      <div className={styles.labHeader}>
        <div>
          <p className={styles.eyebrow}>Live camera bridge</p>
          <h2 id="lab-title">Orbit here. Encode that exact view.</h2>
        </div>
        <p>
          Three.js owns the interactive camera. The capture button reads its spherical position and passes
          those angles to NanoRaster’s browser WebGPU renderer.
        </p>
      </div>

      <div className={styles.workbench}>
        <div className={styles.viewportPanel}>
          <div className={styles.panelBar}>
            <span>01 · live scene</span>
            <span className={styles.fileName}>{modelName}</span>
          </div>
          <div className={styles.viewport} ref={mountRef} aria-label="Interactive Three.js model viewport">
            <div className={styles.crosshair} aria-hidden="true" />
            <div className={styles.liveBadge}>THREE.JS · LIVE</div>
          </div>
          <div className={styles.telemetry}>
            <span>φ {camera.phi.toFixed(1)}°</span>
            <span>θ {camera.theta.toFixed(1)}°</span>
            <span>{settings.projection}</span>
            <span>{settings.up.toUpperCase()} up</span>
          </div>
        </div>

        <div className={styles.transfer} aria-hidden="true">
          <span>camera</span>
          <b>→</b>
          <span>webp</span>
        </div>

        <div className={styles.capturePanel}>
          <div className={styles.panelBar}>
            <span>02 · encoded frame</span>
            <span>
              {settings.width} × {settings.height}
            </span>
          </div>
          <div className={styles.captureFrame}>
            {capture ? (
              <img src={capture.url} alt="NanoRaster WebP capture of the current live camera view" />
            ) : (
              <div className={styles.emptyCapture}>
                <span>WEBP</span>
                <p>Move the camera, then capture this frame.</p>
              </div>
            )}
          </div>
          <div className={styles.telemetry}>
            {capture ? (
              <>
                <span>{capture.elapsedMs.toFixed(1)} ms</span>
                <span>{(capture.bytes / 1024).toFixed(1)} KB</span>
                <span>φ {capture.camera.phi.toFixed(1)}°</span>
                <span>θ {capture.camera.theta.toFixed(1)}°</span>
              </>
            ) : (
              <span>Waiting for capture</span>
            )}
          </div>
        </div>
      </div>

      <div className={styles.controlDeck}>
        <div className={styles.primaryControls}>
          <button
            className={styles.captureButton}
            disabled={rendering || !glb}
            onClick={() => void renderFrame()}
          >
            {rendering ? 'Encoding WebP…' : 'Capture current camera'}
          </button>
          <label className={styles.uploadButton}>
            Load your GLB
            <input
              accept=".glb,model/gltf-binary"
              type="file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void loadFile(file);
              }}
            />
          </label>
          <button
            className={styles.secondaryButton}
            onClick={() => {
              usePreset(DEFAULT_CAMERA);
            }}
          >
            Reset view
          </button>
          <p className={styles.status} aria-live="polite">
            {status}
          </p>
        </div>

        <div className={styles.presets} aria-label="Camera presets">
          <span>Views</span>
          <button
            onClick={() => {
              usePreset({ phi: 60, theta: -45 });
            }}
          >
            Iso
          </button>
          <button
            onClick={() => {
              usePreset({ phi: 90, theta: -90 });
            }}
          >
            Front
          </button>
          <button
            onClick={() => {
              usePreset({ phi: 90, theta: 0 });
            }}
          >
            Right
          </button>
          <button
            onClick={() => {
              usePreset({ phi: 1, theta: -90 });
            }}
          >
            Top
          </button>
        </div>

        <div className={styles.controlsGrid}>
          <label>
            <span>
              Polar angle <output>{camera.phi.toFixed(1)}°</output>
            </span>
            <input
              max="179"
              min="1"
              step="0.5"
              type="range"
              value={camera.phi}
              onChange={(event) => {
                setCamera((current) => ({ ...current, phi: Number(event.currentTarget.value) }));
              }}
            />
          </label>
          <label>
            <span>
              Azimuth <output>{camera.theta.toFixed(1)}°</output>
            </span>
            <input
              max="180"
              min="-180"
              step="0.5"
              type="range"
              value={camera.theta}
              onChange={(event) => {
                setCamera((current) => ({ ...current, theta: Number(event.currentTarget.value) }));
              }}
            />
          </label>
          <label>
            <span>
              Fit margin <output>{Math.round(settings.margin * 100)}%</output>
            </span>
            <input
              max="0.5"
              min="0"
              step="0.01"
              type="range"
              value={settings.margin}
              onChange={(event) => {
                updateSettings('margin', Number(event.currentTarget.value));
              }}
            />
          </label>
          <label>
            <span>
              WebP quality <output>{Math.round(settings.quality * 100)}%</output>
            </span>
            <input
              max="1"
              min="0.1"
              step="0.01"
              type="range"
              value={settings.quality}
              onChange={(event) => {
                updateSettings('quality', Number(event.currentTarget.value));
              }}
            />
          </label>
          <label>
            <span>Projection</span>
            <select
              value={settings.projection}
              onChange={(event) => {
                updateSettings('projection', event.currentTarget.value as RenderProjection);
              }}
            >
              <option value="perspective">Perspective</option>
              <option value="orthographic">Orthographic</option>
            </select>
          </label>
          <label>
            <span>Up axis</span>
            <select
              value={settings.up}
              onChange={(event) => {
                updateSettings('up', event.currentTarget.value as RenderUpAxis);
              }}
            >
              <option value="x">X up</option>
              <option value="y">Y up</option>
              <option value="z">Z up</option>
            </select>
          </label>
          <label>
            <span>Width</span>
            <input
              max="1600"
              min="192"
              step="16"
              type="number"
              value={settings.width}
              onChange={(event) => {
                updateSettings('width', THREE.MathUtils.clamp(Number(event.currentTarget.value), 192, 1600));
              }}
            />
          </label>
          <label>
            <span>Height</span>
            <input
              max="1600"
              min="192"
              step="16"
              type="number"
              value={settings.height}
              onChange={(event) => {
                updateSettings('height', THREE.MathUtils.clamp(Number(event.currentTarget.value), 192, 1600));
              }}
            />
          </label>
          <label>
            <span>Background</span>
            <input
              type="color"
              value={settings.background}
              onChange={(event) => {
                updateSettings('background', event.currentTarget.value);
              }}
            />
          </label>
          <label className={styles.checkControl}>
            <input
              checked={settings.includeAxes}
              type="checkbox"
              onChange={(event) => {
                updateSettings('includeAxes', event.currentTarget.checked);
              }}
            />
            <span>Axis indicator</span>
          </label>
          <label className={styles.checkControl}>
            <input
              checked={settings.includeScale}
              type="checkbox"
              onChange={(event) => {
                updateSettings('includeScale', event.currentTarget.checked);
              }}
            />
            <span>Physical scale</span>
          </label>
        </div>
      </div>

      {capture ? (
        <p className={styles.cameraEvidence}>
          Captured camera position [{capture.position.join(', ')}] → φ {capture.camera.phi.toFixed(1)}°, θ{' '}
          {capture.camera.theta.toFixed(1)}°
        </p>
      ) : null}
    </section>
  );
};
