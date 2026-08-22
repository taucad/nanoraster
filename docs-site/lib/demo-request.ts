import {
  isLightingKey,
  isMaterialKey,
  isViewLabelKey,
  viewLabelKey,
  type DemoLight,
  type DemoValue,
  type DemoView,
} from './demo-options';
import type { MaterialFactors } from './glb-material';

/**
 * Angles a batch request never carries: every view states its own pair, and
 * the renderer rejects the shared request outright if either key appears.
 */
export const angleKeys: ReadonlySet<string> = new Set(['phi', 'theta']);

/** Backgrounds travel to the renderer as an RGBA tuple, so `#RRGGBB[AA]` is expanded here. */
const hexToRgba = (hex: string): readonly number[] => {
  const channels = (hex.slice(1).match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16) / 255);
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
};

/**
 * Project a demo's control values into what the renderer actually receives.
 *
 * Material factors live in the model, not the request, so they are returned
 * separately for the GLB patch and kept out of the options entirely. Rig
 * values travel inside `lighting`, alongside the lights the example declares.
 * The demo's own background and format are only fallbacks: an example that
 * states either one drives the render instead. The singular `label` belongs to
 * a one-image request; a batch labels each view. An empty label, singular or
 * per view, is no label at all.
 */
export const buildDemoRequest = (
  current: Record<string, DemoValue>,
  {
    views,
    lights,
    size,
  }: {
    readonly views: readonly DemoView[];
    readonly lights: readonly DemoLight[] | undefined;
    readonly size: { readonly height: number; readonly width: number };
  },
): { readonly material: MaterialFactors; readonly request: Record<string, unknown> } => {
  const batch = views.length > 0;
  const entries = Object.entries(current);
  const material = Object.fromEntries(entries.filter(([key]) => isMaterialKey(key))) as MaterialFactors;
  const rig = Object.fromEntries(entries.filter(([key]) => isLightingKey(key)));
  const options = Object.fromEntries(
    entries.filter(
      ([key]) =>
        !isMaterialKey(key) &&
        !isLightingKey(key) &&
        !isViewLabelKey(key) &&
        key !== 'label' &&
        !(batch && angleKeys.has(key)),
    ),
  );
  const label =
    typeof current['label'] === 'string' && current['label'] !== '' ? current['label'] : undefined;

  // A view is labelled when it says so and not otherwise: the control's value
  // when one has been edited, else the example's own.
  const labelled = views.map((view) => {
    const edited = current[viewLabelKey(view.id)];
    const text = typeof edited === 'string' ? edited : view.label;
    return {
      id: view.id,
      phi: view.phi,
      theta: view.theta,
      ...(text === undefined || text === '' ? {} : { label: text }),
    };
  });

  const request: Record<string, unknown> = {
    background: [0.04, 0.06, 0.08, 1],
    format: 'png',
    ...options,
    ...size,
    ...(label === undefined || batch ? {} : { label }),
    ...(batch ? { views: labelled } : {}),
    ...(lights === undefined ? {} : { lighting: { lights, ...rig } }),
  };
  if (typeof request['background'] === 'string') {
    request['background'] = hexToRgba(request['background']);
  }

  return { material, request };
};
