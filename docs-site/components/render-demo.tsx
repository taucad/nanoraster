'use client';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  cleanLabel,
  demoAxes,
  demoAxisOf,
  demoAxisVector,
  demoControlTemplates,
  demoControls,
  demoDirectionFromOrbit,
  demoOrbitFromDirection,
  demoPlaneOffset,
  demoPlanePoint,
  demoQuantize,
  describeDemoView,
  isVector,
  isRawDemo,
  readDemoOptions,
  substituteDemoValues,
  type DemoAxis,
  type DemoView,
  type DemoDescriptor,
  type DemoControl,
  type DemoValue,
} from '@/lib/demo-options';
import { buildDemoRequest } from '@/lib/demo-request';
import { hexToLinear, linearToHex, patchMaterialFactors } from '@/lib/glb-material';
import { demoModelUrl, hasWebGpu, loadDemoModel, loadWasmRenderer } from '@/lib/wasm-renderer';

import styles from './render-demo.module.css';

/** Twice the widest size the stage is displayed at, so 2× screens stay sharp. */
const RENDER_SIZE = { height: 720, width: 960 };

/**
 * The code block sits inside the demo's own frame, so Fumadocs' card
 * border, radius, shadow and margin are turned off on its `<figure>`.
 */
const codeblockProps = { className: 'my-0 rounded-none border-0 shadow-none' };

const mimeTypes: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

type State = 'idle' | 'rendering' | 'unsupported' | 'failed';

/**
 * What the last render actually produced: the type of the bytes, their length
 * per image, and the wall time the call took. A batch is timed once, so every
 * tile of a sheet reports the same duration and its own size.
 */
type Evidence = { readonly mime: string; readonly ms: number; readonly sizes: readonly number[] };

/**
 * Turn a renderer failure into a sentence a reader can act on.
 *
 * `parse: fitted camera has no eligible geometry to frame` names an internal
 * concept and leads with a stage that is not where it happened.
 */
const readerFacing = (message: string): string =>
  message.includes('no eligible geometry to frame')
    ? 'Nothing is left to frame — switch surfaces or lines back on.'
    : `Render failed: ${message}`;

/** Keep a rewritten literal short enough to read in the example. */
const readable = (value: number): number => Number(value.toPrecision(4));

/**
 * Render the page's own example in the browser, with controls bound to the
 * option values that example already sets.
 *
 * The example is the single source of truth: `code` carries the fenced block
 * verbatim, the starting values are read out of it, and the same block is
 * emitted to the markdown endpoints agents read. Nothing here is authored
 * twice, so a demo cannot drift from the code beside it.
 *
 * The block on screen is rewritten as the controls move, so the reader copies
 * the request they tuned; `code` itself is untouched and stays what the
 * markdown projection carries.
 */
export const RenderDemo = ({
  code,
  codeBelowControls = false,
  descriptor,
  descriptorJson,
  lang = 'typescript',
  model = demoModelUrl,
}: {
  readonly code: string;
  readonly codeBelowControls?: boolean;
  readonly descriptor?: DemoDescriptor;
  readonly descriptorJson?: string;
  readonly lang?: string;
  readonly model?: string;
  /** The MDX fence stays a child for the projection; the block below renders instead. */
  readonly children?: React.ReactNode;
}): React.JSX.Element => {
  const parsedDescriptor = useMemo(
    () => descriptor ?? (JSON.parse(descriptorJson ?? '{}') as DemoDescriptor),
    [descriptor, descriptorJson],
  );
  const views = parsedDescriptor.views;
  const batch = views.length > 0;
  const raw = isRawDemo(parsedDescriptor);
  // The first view that declares a camera, so the panel opens on a group that
  // has camera controls in it rather than on a bare label.
  const defaultViewId = (views.find(({ camera }) => camera !== undefined) ?? views.at(0))?.id ?? '';
  const [selectedViewId, setSelectedViewId] = useState(defaultViewId);
  const controls = demoControls(parsedDescriptor, selectedViewId);
  const declaredWorld = parsedDescriptor.request['world'];
  const [values, setValues] = useState<Record<string, DemoValue>>(() => readDemoOptions(parsedDescriptor));
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');
  const [srcs, setSrcs] = useState<readonly string[]>([]);
  const [frame, setFrame] = useState<ImageData | undefined>();
  const [evidence, setEvidence] = useState<Evidence | undefined>();
  const urlsRef = useRef<readonly string[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // At most one render is in flight; the newest values always render last.
  // Renders are not cancellable, so without the guard a drag would stack
  // concurrent renders and the intermediate frames would waste GPU time the
  // final frame is waiting on. The pending slot coalesces every value change
  // that arrives mid-render into one trailing rerun (last writer wins), which
  // also serializes access to the shared renderer handle.
  const inFlightRef = useRef(false);
  const pendingRef = useRef<Record<string, DemoValue> | null>(null);
  // Renders are not cancellable, so one can still be in flight when the
  // component goes away. Its URLs would outlive the document that could revoke
  // them, and its trailing value would render for nobody.
  const mountedRef = useRef(true);
  // The azimuth track's two ends name one direction, and recovering the angle
  // from the stored vector always yields the canonical +180. Which end the
  // reader dragged to is remembered here, so a handle at -180 stays put
  // instead of teleporting to the far end — and the rewritten example prints
  // the same end the slider shows.
  const azimuthEndsRef = useRef<Record<string, number>>({});

  const draw = useCallback(
    async (current: Record<string, DemoValue>): Promise<void> => {
      if (!hasWebGpu()) {
        setState('unsupported');
        return;
      }
      if (inFlightRef.current) {
        pendingRef.current = current;
        return;
      }

      const render = async (values: Record<string, DemoValue>): Promise<void> => {
        setState('rendering');
        try {
          const [renderer, source] = await Promise.all([loadWasmRenderer(), loadDemoModel(model)]);

          const { material, request } = buildDemoRequest(parsedDescriptor, values, RENDER_SIZE);
          const glb = Object.keys(material).length > 0 ? patchMaterialFactors(source, material) : source;

          const json = JSON.stringify(request);
          const started = performance.now();

          // `format: 'raw'` runs the same request through the same entry point
          // and stops before the encoder, so the timing below is render and
          // readback with no encoder in it. The bytes are straight-alpha sRGB
          // RGBA8, top row first, which is what `ImageData` reads — so the tile
          // shows the render itself, with nothing decoding it on the way in.
          if (raw) {
            // wasm-bindgen types every returned view as `Uint8Array<ArrayBufferLike>`;
            // the bindings only ever hand back plain `ArrayBuffer` storage,
            // which is what `ImageData` and `Blob` accept.
            const bytes = (await renderer.render_image(glb, json)) as Uint8Array<ArrayBuffer>;
            const ms = Math.round(performance.now() - started);
            const { width, height } = RENDER_SIZE;
            setFrame(new ImageData(new Uint8ClampedArray(bytes.buffer), width, height));
            setEvidence({ mime: 'raw rgba', ms, sizes: [bytes.byteLength] });
            setState('idle');
            return;
          }

          const bytes = (
            batch
              ? (await renderer.render_images(glb, json)).images
              : [await renderer.render_image(glb, json)]
          ) as Uint8Array<ArrayBuffer>[];
          const ms = Math.round(performance.now() - started);

          for (const url of urlsRef.current) URL.revokeObjectURL(url);
          const type = mimeTypes[String(request['format'])] ?? 'image/png';
          const next = bytes.map((part) => URL.createObjectURL(new Blob([part], { type })));
          if (!mountedRef.current) {
            for (const url of next) URL.revokeObjectURL(url);
            urlsRef.current = [];
            return;
          }
          urlsRef.current = next;
          setSrcs(urlsRef.current);
          setEvidence({ mime: type, ms, sizes: bytes.map((part) => part.byteLength) });
          setState('idle');
        } catch (error) {
          setMessage(error instanceof Error ? error.message : String(error));
          setState('failed');
        }
      };

      inFlightRef.current = true;
      try {
        let values: Record<string, DemoValue> | null = current;
        while (values !== null && mountedRef.current) {
          await render(values);
          values = pendingRef.current;
          pendingRef.current = null;
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [batch, model, parsedDescriptor, raw, views],
  );

  // The canvas only exists once there is a frame to paint, so the paint waits
  // for the element the frame put on the page.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (frame === undefined || canvas === null) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    canvas.getContext('2d')?.putImageData(frame, 0, 0);
  }, [frame]);

  // Only the first paint is automatic; later renders follow a control change.
  const drawnOnce = useRef(false);
  useEffect(() => {
    if (drawnOnce.current) return;
    drawnOnce.current = true;
    void draw(values);
  }, [draw, values]);

  useEffect(() => {
    // Reset on mount as well as unmount: StrictMode mounts, unmounts, and
    // mounts again, and a flag left false there would discard every render.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  const apply = (next: Record<string, DemoValue>): void => {
    setValues(next);
    void draw(next);
  };

  const vectorOf = (key: string): readonly number[] => {
    const value = values[key];
    return isVector(value) ? value : [0, 0, 0];
  };

  /** What a view is called on the selector: its own label, edits included. */
  const viewLabel = (view: DemoView): string => {
    const key = `view.${view.id}.label`;
    return String((key in values ? values[key] : view.label) ?? view.id);
  };

  /** True when this toggle is the only visible geometry the render has left. */
  const visibility = controls.filter(({ key }) => key === 'surfaces' || key === 'lines');
  const lastVisibleGeometry = (key: string): boolean =>
    visibility.length > 1 &&
    values[key] === true &&
    visibility.filter(({ key: other }) => values[other] === true).length === 1;

  // A control writes no more decimals than its own step can express, so a drag
  // cannot change the width of the line it rewrites in the example. Rounding
  // the value rather than its printed form keeps the request that runs
  // identical to the request on screen.
  const templates = demoControlTemplates(parsedDescriptor.diagonal);
  const quantize = (key: string, value: DemoValue): DemoValue =>
    demoQuantize(
      templates[parsedDescriptor.bindings.find((binding) => binding.key === key)?.control ?? ''],
      value,
    );

  const update = (key: string, value: DemoValue): void => {
    const next = { ...values, [key]: quantize(key, value) };
    // A section plane's point is driven as a distance along its own normal, so
    // turning the normal has to carry the point with it — otherwise the plane
    // teleports to wherever the old point projects onto the new normal.
    if (key.endsWith('.normal') && Array.isArray(value)) {
      const pointKey = `${key.slice(0, -'.normal'.length)}.point`;
      if (pointKey in values) {
        next[pointKey] = quantize(
          pointKey,
          demoPlanePoint(demoPlaneOffset(vectorOf(pointKey), vectorOf(key)), value),
        );
      }
    }
    apply(next);
  };

  /** The raw Cartesian value, kept reachable behind the disclosure it lives in. */
  const rawVector = (control: DemoControl, names: readonly string[]): React.JSX.Element => (
    <span className={styles.vector}>
      {[0, 1, 2].map((index) => (
        <input
          aria-label={`${control.label} ${names[index]}`}
          key={index}
          onChange={(event) => {
            const vector = Array.from(vectorOf(control.key));
            vector[index] = Number(event.currentTarget.value);
            update(control.key, vector);
          }}
          // No `min`/`max`/`step`: this is the escape hatch under a bounded
          // control, and the renderer's own validation is the real contract.
          // A stepped box would also mark every authored decimal `:invalid`.
          step="any"
          type="number"
          value={vectorOf(control.key)[index] ?? 0}
        />
      ))}
    </span>
  );

  /**
   * A direction, as the two angles that actually change the render.
   *
   * `framing: 'fit'` normalises the vector, so its magnitude is not a degree
   * of freedom: a third of a three-box control did nothing. Azimuth is
   * measured from `world.forward` toward the caller's right, which is the
   * convention `directionFromOrbit` defines and the guides teach.
   */
  const orbitRows = (control: DemoControl): React.JSX.Element => {
    const orbit = demoOrbitFromDirection(vectorOf(control.key), declaredWorld);
    const canonical = Math.round(orbit.azimuth);
    const azimuth = canonical === 180 && azimuthEndsRef.current[control.key] === -180 ? -180 : canonical;
    const elevation = Math.round(orbit.elevation);
    // Exact at the pole: `orbitFromDirection` clamps its sine before `asin`,
    // so a direction on the world's up axis reports ±90 with no float dust.
    const atPole = Math.abs(orbit.elevation) === 90;
    // The elevation track stops a degree short of the poles, the way orbit
    // controls conventionally do: at exactly ±90 the direction is the world's
    // own up axis and the azimuth is no longer recoverable from it, so the
    // azimuth handle would snap to a canonical bearing. One degree out, both
    // angles stay live. An example that authors an exact pole keeps it — the
    // value sits at the track's end with a truthful label until dragged, and
    // reset restores it — because a plan view or a horizontal cut is exactly
    // ±90 by meaning, and typed or authored directions are where the
    // renderer's canonical pole orientation is the right convention.
    const move = (next: { azimuth: number; elevation: number }): void => {
      update(control.key, demoDirectionFromOrbit(next, declaredWorld));
    };
    return (
      <div className={styles.group} key={control.key}>
        <label className={styles.control}>
          <span title={control.title}>
            {control.label} · azimuth <span className={styles.reading}>{azimuth}</span>°
          </span>
          <input
            aria-label={`${control.label} azimuth`}
            // At an authored pole the handle would spring back to the
            // canonical bearing on release; a disabled track says why instead.
            disabled={atPole}
            max={180}
            min={-180}
            title={
              atPole
                ? 'At the pole every azimuth names the same direction — lower the elevation to steer.'
                : undefined
            }
            onChange={(event) => {
              const next = Number(event.currentTarget.value);
              if (next === -180) azimuthEndsRef.current[control.key] = -180;
              else delete azimuthEndsRef.current[control.key];
              move({ azimuth: next, elevation });
            }}
            step={1}
            type="range"
            value={azimuth}
          />
        </label>
        <label className={styles.control}>
          <span>
            elevation <span className={styles.reading}>{elevation}</span>°
          </span>
          <input
            aria-label={`${control.label} elevation`}
            max={89}
            min={-89}
            onChange={(event) => {
              move({ azimuth, elevation: Number(event.currentTarget.value) });
            }}
            step={1}
            type="range"
            value={elevation}
          />
        </label>
        {control.key.endsWith('.normal') ? (
          <div className={styles.control}>
            <span>facing</span>
            <button
              className={styles.action}
              onClick={() => {
                update(
                  control.key,
                  vectorOf(control.key).map((part) => -part),
                );
              }}
              type="button"
            >
              flip the normal
            </button>
          </div>
        ) : undefined}
        <details className={styles.advanced}>
          <summary>advanced · {control.label} XYZ</summary>
          {rawVector(control, ['x', 'y', 'z'])}
        </details>
      </div>
    );
  };

  const shown = useMemo(
    () =>
      parsedDescriptor.code === code
        ? substituteDemoValues(parsedDescriptor, values, azimuthEndsRef.current)
        : code,
    [code, parsedDescriptor, values],
  );

  // The bytes the request produced, under the image they produced: the same
  // evidence `image.bytes.length` and `mimeType` carry in the example itself.
  // `note` records what the number leaves out, which only the raw tile needs.
  // The row renders before any evidence exists too, so the first frame lands
  // in a panel that already reserved the badge's height.
  const badge = (index: number, note?: string): React.JSX.Element => (
    <p className={styles.badge} data-badge>
      <span className={styles.evidence}>
        {evidence === undefined ? (
          // A collapsible space would leave the empty row without a line box to size.
          '\u00A0'
        ) : (
          <>
            {evidence.mime} · {RENDER_SIZE.width}×{RENDER_SIZE.height} ·{' '}
            {((evidence.sizes[index] ?? 0) / 1024).toFixed(1)} KB · {evidence.ms} ms
            {note === undefined ? '' : ` · ${note}`}
          </>
        )}
      </span>
      {state === 'rendering' && index === 0 ? <span className={styles.status}>rendering…</span> : undefined}
    </p>
  );

  // The placeholder standing in for a single render that has not arrived:
  // the frame's own shape plus the badge row that will appear under it.
  const pending = (
    <figure className={styles.single}>
      <p className={`${styles.notice} ${styles.pending}`}>Rendering…</p>
      {badge(0)}
    </figure>
  );

  // Raw pixels have no file to point an <img> at, so the frame goes straight
  // into a canvas. What is on screen is the render itself: no encoder ran, and
  // the badge says so beside the bytes.
  const painted = (
    <figure className={styles.single}>
      <canvas className={styles.image} ref={canvasRef} />
      {badge(0, 'no encode, no decode')}
    </figure>
  );

  // One image per declared view, captioned with the camera contract the code states.
  const sheet = batch ? (
    views.map((view, index) => (
      <figure className={styles.tile} key={view.id}>
        <img
          alt={`Live nanoraster render of the ${view.id} view`}
          className={styles.image}
          src={srcs[index] ?? ''}
        />
        <figcaption className={styles.caption}>
          {view.id} · {describeDemoView(view)}
        </figcaption>
        {badge(index)}
      </figure>
    ))
  ) : (
    <figure className={styles.single}>
      <img alt="Live nanoraster render of the demo model" className={styles.image} src={srcs[0] ?? ''} />
      {badge(0)}
    </figure>
  );

  return (
    <div className={styles.demo} data-render-demo data-render-state={state}>
      {codeBelowControls ? undefined : (
        <DynamicCodeBlock code={shown} codeblock={codeblockProps} lang={lang} />
      )}

      <div className={styles.panel} data-code-below-controls={codeBelowControls || undefined}>
        <div className={batch ? styles.sheet : styles.stage}>
          {state === 'unsupported' ? (
            <p className={styles.notice}>
              This browser has no WebGPU support, so the live render is unavailable. The example above runs
              unchanged in Node.js.
            </p>
          ) : state === 'failed' ? (
            <p className={styles.notice}>{readerFacing(message)}</p>
          ) : raw ? (
            frame === undefined ? (
              pending
            ) : (
              painted
            )
          ) : srcs.length > 0 ? (
            sheet
          ) : batch ? (
            // A sheet's height comes from its declared tiles, not one frame's
            // aspect, so its placeholder keeps the sheet minimum instead.
            <p className={`${styles.notice} ${styles.pending}`}>Rendering…</p>
          ) : (
            pending
          )}
        </div>

        <div className={styles.controls}>
          {views.length > 1 ? (
            <label className={styles.control}>
              <span>view</span>
              <select
                onChange={(event) => {
                  setSelectedViewId(event.currentTarget.value);
                }}
                value={selectedViewId}
              >
                {views.map((view) => (
                  <option key={view.id} value={view.id}>
                    {viewLabel(view)}
                  </option>
                ))}
              </select>
            </label>
          ) : undefined}
          {controls.map((control) => {
            if (control.kind === 'orbit') return orbitRows(control);
            if (control.kind === 'axis' && demoAxisOf(values[control.key]) !== undefined) {
              return (
                <label className={styles.control} key={control.key}>
                  <span title={control.title}>{control.label}</span>
                  <select
                    onChange={(event) => {
                      update(control.key, demoAxisVector(event.currentTarget.value as DemoAxis));
                    }}
                    value={demoAxisOf(values[control.key])}
                  >
                    {demoAxes.map((axis) => (
                      <option key={axis} value={axis}>
                        {axis}
                      </option>
                    ))}
                  </select>
                </label>
              );
            }
            if (control.kind === 'axis') {
              // An `up` that names no axis keeps the boxes that can express it.
              return (
                <label className={styles.control} key={control.key}>
                  <span title={control.title}>{control.label}</span>
                  {rawVector(control, ['x', 'y', 'z'])}
                </label>
              );
            }
            if (control.kind === 'offset') {
              // One signed distance along the plane's own normal: the only
              // direction moving the point can cut in, over a travel of half
              // the model rather than a step that ejects the plane from it.
              const normal = vectorOf(`${control.key.slice(0, -'.point'.length)}.normal`);
              const offset = demoPlaneOffset(vectorOf(control.key), normal);
              return (
                <label className={styles.control} key={control.key}>
                  <span title={control.title}>
                    {control.label} ·{' '}
                    <span className={`${styles.reading} ${styles.measure}`}>{readable(offset)}</span>
                  </span>
                  <input
                    max={control.max}
                    min={control.min}
                    onChange={(event) => {
                      update(control.key, demoPlanePoint(Number(event.currentTarget.value), normal));
                    }}
                    step={control.step}
                    type="range"
                    value={offset}
                  />
                </label>
              );
            }
            if (control.kind === 'log') {
              // Lengths that span decades: `near: 0.005` sat at 0.4 % of a
              // linear track, and `far: 1` was below its own floor.
              // The pair is bounded by each other as well: `near < far` is a
              // renderer contract, and a slider that can break it is one more
              // unrecoverable state on a panel with no undo but reset.
              const near = control.key.endsWith('.near');
              const paired = Number(
                values[
                  near
                    ? `${control.key.slice(0, -'near'.length)}far`
                    : `${control.key.slice(0, -'far'.length)}near`
                ],
              );
              const pairs = Number.isFinite(paired) && paired > 0;
              const low = Math.log10(!near && pairs ? Math.max(control.min, paired) : control.min);
              const high = Math.log10(near && pairs ? Math.min(control.max, paired) : control.max);
              const current = Number(values[control.key] ?? control.min);
              return (
                <label className={styles.control} key={control.key}>
                  <span title={control.title}>
                    {control.label} ·{' '}
                    <span className={`${styles.reading} ${styles.measure}`}>{readable(current)}</span>
                  </span>
                  <input
                    max={high}
                    min={low}
                    onChange={(event) => {
                      update(control.key, readable(10 ** Number(event.currentTarget.value)));
                    }}
                    step={(high - low) / 200}
                    type="range"
                    value={Math.log10(current)}
                  />
                </label>
              );
            }
            if (control.kind === 'triple') {
              const names = control.key.endsWith('.color') ? ['red', 'green', 'blue'] : ['x', 'y', 'z'];
              return (
                <label className={styles.control} key={control.key}>
                  <span title={control.title}>{control.label}</span>
                  <span className={styles.stack}>
                    {[0, 1, 2].map((index) => (
                      <input
                        aria-label={`${control.label} ${names[index]}`}
                        key={index}
                        max={control.max}
                        min={control.min}
                        onChange={(event) => {
                          const vector = Array.from(vectorOf(control.key));
                          vector[index] = Number(event.currentTarget.value);
                          update(control.key, vector);
                        }}
                        step={control.step}
                        type="range"
                        value={vectorOf(control.key)[index] ?? 0}
                      />
                    ))}
                  </span>
                </label>
              );
            }
            return (
              <label className={styles.control} key={control.key}>
                <span title={control.title}>{control.label}</span>

                {control.kind === 'range' ? (
                  <input
                    // PNG is the one format that ignores quality entirely.
                    disabled={control.key === 'quality' && values['format'] === 'png'}
                    max={control.max}
                    min={control.min}
                    onChange={(event) => {
                      update(control.key, Number(event.currentTarget.value));
                    }}
                    step={control.step}
                    type="range"
                    value={Number(values[control.key] ?? 0)}
                  />
                ) : control.kind === 'choice' ? (
                  <select
                    onChange={(event) => {
                      update(control.key, event.currentTarget.value);
                    }}
                    value={String(values[control.key] ?? '')}
                  >
                    {control.choices.map((choice, index) => (
                      <option key={choice} value={choice}>
                        {control.labels?.[index] ?? choice}
                      </option>
                    ))}
                  </select>
                ) : control.kind === 'text' ? (
                  <input
                    maxLength={64}
                    onChange={(event) => {
                      update(control.key, cleanLabel(event.currentTarget.value));
                    }}
                    placeholder="no label"
                    title="The renderer's label alphabet is printable ASCII, up to 64 characters."
                    type="text"
                    value={String(values[control.key] ?? '')}
                  />
                ) : control.kind === 'colour' ? (
                  <input
                    onChange={(event) => {
                      // Rounded so the literal written back into the example
                      // stays readable; four places is well below a visible step.
                      update(
                        control.key,
                        hexToLinear(event.currentTarget.value).map((part) => Number(part.toFixed(4))),
                      );
                    }}
                    type="color"
                    value={linearToHex(
                      Array.isArray(values[control.key]) ? (values[control.key] as number[]) : [1, 1, 1, 1],
                    )}
                  />
                ) : (
                  <input
                    checked={values[control.key] === true}
                    // Turning off the last kind of visible geometry leaves the
                    // fitted camera nothing to frame, which fails the render
                    // and cannot be undone from the panel.
                    disabled={lastVisibleGeometry(control.key)}
                    onChange={(event) => {
                      update(control.key, event.currentTarget.checked);
                    }}
                    title={
                      lastVisibleGeometry(control.key)
                        ? 'The last visible kind of geometry has to stay on.'
                        : undefined
                    }
                    type="checkbox"
                  />
                )}
              </label>
            );
          })}
          <button
            className={styles.reset}
            onClick={() => {
              setSelectedViewId(defaultViewId);
              azimuthEndsRef.current = {};
              apply(readDemoOptions(parsedDescriptor));
            }}
            type="button"
          >
            reset to the example
          </button>
        </div>

        {codeBelowControls ? (
          <div className={styles.code}>
            <DynamicCodeBlock code={shown} codeblock={codeblockProps} lang={lang} />
          </div>
        ) : undefined}
      </div>
    </div>
  );
};
