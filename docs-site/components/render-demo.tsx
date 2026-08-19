'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  demoControls,
  formatValue,
  isMaterialKey,
  readDemoOptions,
  toRequestOptions,
  type DemoValue,
} from '@/lib/demo-options';
import { hexToLinear, linearToHex, patchMaterialFactors } from '@/lib/glb-material';
import { hasWebGpu, loadDemoModel, loadWasmRenderer } from '@/lib/wasm-renderer';

import styles from './render-demo.module.css';

const RENDER_SIZE = { height: 360, width: 480 };

type State = 'idle' | 'rendering' | 'unsupported' | 'failed';

/**
 * Render the page's own example in the browser, with controls bound to the
 * option values that example already sets.
 *
 * The example is the single source of truth: `code` carries the fenced block
 * verbatim, the starting values are read out of it, and the same block is
 * emitted to the markdown endpoints agents read. Nothing here is authored
 * twice, so a demo cannot drift from the code beside it.
 */
export const RenderDemo = ({
  code,
  children,
}: {
  readonly code: string;
  readonly lang?: string;
  readonly children?: React.ReactNode;
}): React.JSX.Element => {
  const controls = demoControls(code);
  const [values, setValues] = useState<Record<string, DemoValue>>(() => readDemoOptions(code));
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');
  const [src, setSrc] = useState('');
  const urlRef = useRef('');

  const draw = useCallback(async (current: Record<string, DemoValue>): Promise<void> => {
    if (!hasWebGpu()) {
      setState('unsupported');
      return;
    }

    setState('rendering');
    try {
      const [renderer, source] = await Promise.all([loadWasmRenderer(), loadDemoModel()]);

      // Material factors live in the model, not the request, so they are
      // patched into the GLB and kept out of the options entirely.
      const material = Object.fromEntries(Object.entries(current).filter(([key]) => isMaterialKey(key)));
      const options = toRequestOptions(current);
      const glb = Object.keys(material).length > 0 ? patchMaterialFactors(source, material) : source;

      const bytes = await renderer.render_glb_to_image(
        glb,
        JSON.stringify({
          ...options,
          background: [0.04, 0.06, 0.08, 1],
          format: 'png',
          ...RENDER_SIZE,
          ...(current['includeLabel'] === true ? { label: 'gear' } : {}),
        }),
      );

      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      setSrc(urlRef.current);
      setState('idle');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setState('failed');
    }
  }, []);

  // Only the first paint is automatic; later renders follow a control change.
  const drawnOnce = useRef(false);
  useEffect(() => {
    if (drawnOnce.current) return;
    drawnOnce.current = true;
    void draw(values);
  }, [draw, values]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const update = (key: string, value: DemoValue): void => {
    const next = { ...values, [key]: value };
    setValues(next);
    void draw(next);
  };

  return (
    <div className={styles.demo}>
      {children}

      <div className={styles.panel}>
        <div className={styles.stage}>
          {state === 'unsupported' ? (
            <p className={styles.notice}>
              This browser has no WebGPU support, so the live render is unavailable. The example above runs
              unchanged in Node.js.
            </p>
          ) : state === 'failed' ? (
            <p className={styles.notice}>Render failed: {message}</p>
          ) : src ? (
            <img alt="Live nanoraster render of the demo model" className={styles.image} src={src} />
          ) : (
            <p className={styles.notice}>Rendering…</p>
          )}
        </div>

        <div className={styles.controls}>
          <p className={styles.readout}>
            {controls.map(({ key }) => `${key}: ${formatValue(values[key] ?? '')}`).join('  ·  ')}
          </p>

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
                  {control.choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice}
                    </option>
                  ))}
                </select>
              ) : control.kind === 'colour' ? (
                <input
                  onChange={(event) => {
                    update(control.key, hexToLinear(event.currentTarget.value));
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
