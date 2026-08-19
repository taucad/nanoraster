'use client';

import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  demoControls,
  isLightingKey,
  isMaterialKey,
  readDemoLights,
  readDemoOptions,
  readDemoViews,
  substituteDemoValues,
  type DemoValue,
} from '@/lib/demo-options';
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

/** Backgrounds travel to the renderer as an RGBA tuple, so `#RRGGBB[AA]` is expanded here. */
const hexToRgba = (hex: string): readonly number[] => {
  const channels = (hex.slice(1).match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16) / 255);
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
};

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
 * Angles a batch request never carries: every view states its own pair, and
 * the renderer rejects the shared request outright if either key appears.
 */
const angleKeys = new Set(['phi', 'theta']);

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
  const batch = views.length > 0;
  const controls = demoControls(code).filter((control) => !batch || !angleKeys.has(control.key));
  const [values, setValues] = useState<Record<string, DemoValue>>(() => readDemoOptions(code));
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');
  const [srcs, setSrcs] = useState<readonly string[]>([]);
  const [evidence, setEvidence] = useState<Evidence | undefined>();
  const urlsRef = useRef<readonly string[]>([]);

  const draw = useCallback(
    async (current: Record<string, DemoValue>): Promise<void> => {
      if (!hasWebGpu()) {
        setState('unsupported');
        return;
      }

      setState('rendering');
      try {
        const [renderer, source] = await Promise.all([loadWasmRenderer(), loadDemoModel()]);

        // Material factors live in the model, not the request, so they are
        // patched into the GLB and kept out of the options entirely.
        const entries = Object.entries(current);
        const material = Object.fromEntries(entries.filter(([key]) => isMaterialKey(key)));
        const rig = Object.fromEntries(entries.filter(([key]) => isLightingKey(key)));
        const options = Object.fromEntries(
          entries.filter(
            ([key]) => !isMaterialKey(key) && !isLightingKey(key) && !(batch && angleKeys.has(key)),
          ),
        );
        const glb = Object.keys(material).length > 0 ? patchMaterialFactors(source, material) : source;

        // Labels are required on every view once they are switched on, so a
        // view that declares none falls back to its own identifier.
        const labelled = views.map((view) => {
          const label = view.label ?? (current['includeLabel'] === true ? view.id : undefined);
          return {
            id: view.id,
            phi: view.phi,
            theta: view.theta,
            ...(label === undefined ? {} : { label }),
          };
        });

        // The demo's own background and format are only fallbacks: an example
        // that states either one drives the render instead. The singular
        // `label` belongs to a one-image request; a batch labels each view.
        const request: Record<string, unknown> = {
          background: [0.04, 0.06, 0.08, 1],
          format: 'png',
          ...options,
          ...RENDER_SIZE,
          ...(current['includeLabel'] === true && !batch ? { label: 'gear' } : {}),
          ...(batch ? { views: labelled } : {}),
          // Rig values travel inside `lighting`, alongside the lights the example declares.
          ...(lights === undefined ? {} : { lighting: { lights, ...rig } }),
        };
        if (typeof request['background'] === 'string') {
          request['background'] = hexToRgba(request['background']);
        }

        const json = JSON.stringify(request);
        const started = performance.now();
        const bytes = batch
          ? await renderer.render_glb_to_images(glb, json)
          : [await renderer.render_glb_to_image(glb, json)];
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
    },
    [batch, lights, views],
  );

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
  const badge = (index: number): React.JSX.Element | undefined =>
    evidence === undefined ? undefined : (
      <p className={styles.badge} data-badge>
        {evidence.mime} · {((evidence.sizes[index] ?? 0) / 1024).toFixed(1)} KB · {evidence.ms} ms
      </p>
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
