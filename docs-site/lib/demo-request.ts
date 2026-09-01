import type { DemoDescriptor, DemoPathPart, DemoValue } from './demo-options';
import type { MaterialFactors } from './glb-material';

/** Backgrounds travel to the renderer as an RGBA tuple, so `#RRGGBB[AA]` is expanded here. */
const hexToRgba = (hex: string): readonly number[] => {
  const channels = (hex.slice(1).match(/../gu) ?? []).map((pair) => Number.parseInt(pair, 16) / 255);
  return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
};

const assign = (root: Record<string, unknown>, path: readonly DemoPathPart[], value: DemoValue): void => {
  let target: unknown = root;
  for (const part of path.slice(0, -1)) {
    target = Array.isArray(target)
      ? target[Number(part)]
      : (target as Record<string, unknown> | undefined)?.[String(part)];
  }
  if (target === undefined || target === null) return;
  const key = path.at(-1);
  if (key === undefined) return;
  if (value === '' && key === 'label') {
    if (!Array.isArray(target)) (target as Record<string, unknown>)[key] = undefined;
    return;
  }
  if (Array.isArray(target)) target[Number(key)] = value;
  else (target as Record<string, unknown>)[String(key)] = value;
};

/** Apply controls to the exact object literal parsed during the docs build. */
export const buildDemoRequest = (
  descriptor: DemoDescriptor,
  current: Record<string, DemoValue>,
  size: { readonly height: number; readonly width: number },
): { readonly material: MaterialFactors; readonly request: Record<string, unknown> } => {
  const request = structuredClone(descriptor.request) as Record<string, unknown>;
  const material: Record<string, DemoValue> = { ...descriptor.material };
  for (const binding of descriptor.bindings) {
    const value = current[binding.key] ?? binding.value;
    if (binding.scope === 'material') {
      material[binding.control] = value;
    } else {
      assign(request, binding.path, value);
    }
  }
  Object.assign(request, size);
  request['background'] ??= [0.04, 0.06, 0.08, 1];
  request['format'] ??= 'png';
  if (typeof request['background'] === 'string') request['background'] = hexToRgba(request['background']);
  return { material, request };
};
