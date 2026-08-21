'use client';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  demoControls,
  isRawDemo,
  readDemoLights,
  readDemoLabel,
  readDemoOptions,
  readDemoViews,
  substituteDemoValues,
  type DemoValue,
} from '@/lib/demo-options';
import { angleKeys, buildDemoRequest } from '@/lib/demo-request';
import { hexToLinear, linearToHex, patchMaterialFactors } from '@/lib/glb-material';
import { hasWebGpu, loadDemoModel, loadWasmRenderer } from '@/lib/wasm-renderer';

import styles from './render-demo.module.css';

/** Twice the widest size the stage is displayed at, so 2× screens stay sharp. */
const RENDER_SIZE = { height: 720, width: 960 };

/**
 * The code block sits flush inside the demo's own frame, so Fumadocs' card
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

/** Panels past this many controls read better in two columns than in one tall list. */
const twoColumnControls = 8;

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
  lang = 'typescript',
}: {
  readonly code: string;
  readonly lang?: string;
  /** The MDX fence stays a child for the projection; the block below renders instead. */
  readonly children?: React.ReactNode;
}): React.JSX.Element => {
  const views = useMemo(() => readDemoViews(code), [code]);
  const lights = useMemo(() => readDemoLights(code), [code]);
  const label = useMemo(() => readDemoLabel(code), [code]);
  const batch = views.length > 0;
  const raw = isRawDemo(code);
  const controls = demoControls(code).filter((control) => !batch || !angleKeys.has(control.key));
  const [values, setValues] = useState<Record<string, DemoValue>>(() => readDemoOptions(code));
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
          const [renderer, source] = await Promise.all([loadWasmRenderer(), loadDemoModel()]);

          const { material, request } = buildDemoRequest(values, { label, lights, size: RENDER_SIZE, views });
          const glb = Object.keys(material).length > 0 ? patchMaterialFactors(source, material) : source;

          const json = JSON.stringify(request);
          const started = performance.now();

          // `format: 'raw'` runs the same request through the same entry point
          // and stops before the encoder, so the timing below is render and
          // readback with no encoder in it. The bytes are straight-alpha sRGB
          // RGBA8, top row first, which is what `ImageData` reads — so the tile
          // shows the render itself, with nothing decoding it on the way in.
          if (raw) {
            const bytes = await renderer.render_image(glb, json);
            const ms = Math.round(performance.now() - started);
            const { width, height } = RENDER_SIZE;
            setFrame(new ImageData(new Uint8ClampedArray(bytes.buffer), width, height));
            setEvidence({ mime: 'raw rgba', ms, sizes: [bytes.byteLength] });
            setState('idle');
            return;
          }

          const bytes = batch
            ? (await renderer.render_images(glb, json)).images
            : [await renderer.render_image(glb, json)];
          const ms = Math.round(performance.now() - started);

          for (const url of urlsRef.current) URL.revokeObjectURL(url);
          const type = mimeTypes[String(request['format'])] ?? 'image/png';
          urlsRef.current = bytes.map((part) => URL.createObjectURL(new Blob([part], { type })));
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
        while (values !== null) {
          await render(values);
          values = pendingRef.current;
          pendingRef.current = null;
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [batch, label, lights, raw, views],
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

  useEffect(
    () => () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const update = (key: string, value: DemoValue): void => {
    const next = { ...values, [key]: value };
    setValues(next);
    void draw(next);
  };

  const shown = useMemo(() => substituteDemoValues(code, values), [code, values]);

  // The bytes the request produced, under the image they produced: the same
  // evidence `image.bytes.length` and `mimeType` carry in the example itself.
  // `note` records what the number leaves out, which only the raw tile needs.
  const badge = (index: number, note?: string): React.JSX.Element | undefined =>
    evidence === undefined ? undefined : (
      <p className={styles.badge} data-badge>
        {evidence.mime} · {((evidence.sizes[index] ?? 0) / 1024).toFixed(1)} KB · {evidence.ms} ms
        {note === undefined ? '' : ` · ${note}`}
      </p>
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

  // One image per declared view, captioned with the angles the code states.
  const sheet = batch ? (
    views.map((view, index) => (
      <figure className={styles.tile} key={view.id}>
        <img
          alt={`Live nanoraster render of the ${view.id} view`}
          className={styles.image}
          src={srcs[index] ?? ''}
        />
        <figcaption className={styles.caption}>
          {view.id} · φ {view.phi}° θ {view.theta}°
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
    <div className={styles.demo}>
      <DynamicCodeBlock code={shown} codeblock={codeblockProps} lang={lang} />

      <div className={styles.panel}>
        <div className={batch ? styles.sheet : styles.stage}>
          {state === 'unsupported' ? (
            <p className={styles.notice}>
              This browser has no WebGPU support, so the live render is unavailable. The example above runs
              unchanged in Node.js.
            </p>
          ) : state === 'failed' ? (
            <p className={styles.notice}>Render failed: {message}</p>
          ) : raw ? (
            frame === undefined ? (
              <p className={styles.notice}>Rendering…</p>
            ) : (
              painted
            )
          ) : srcs.length > 0 ? (
            sheet
          ) : (
            <p className={styles.notice}>Rendering…</p>
          )}
        </div>

        <div
          className={styles.controls}
          data-columns={controls.length >= twoColumnControls ? 'two' : undefined}
        >
          {controls.map((control) => (
            <label className={styles.control} key={control.key}>
              <span>{control.key}</span>

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
                  onChange={(event) => {
                    update(control.key, event.currentTarget.checked);
                  }}
                  type="checkbox"
                />
              )}
            </label>
          ))}

          {state === 'rendering' ? <p className={styles.status}>rendering…</p> : undefined}
        </div>
      </div>
    </div>
  );
};
