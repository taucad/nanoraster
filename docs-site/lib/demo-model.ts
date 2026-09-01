import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { glbJsonChunk } from './glb-material';
import { demoModelUrl } from './wasm-renderer';

type Vector = readonly [number, number, number];

type Node = {
  readonly mesh?: number;
  readonly children?: readonly number[];
  readonly matrix?: readonly number[];
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
};

type PositionedGltf = {
  readonly accessors?: readonly { readonly min?: readonly number[]; readonly max?: readonly number[] }[];
  readonly meshes?: readonly {
    readonly primitives?: readonly { readonly attributes?: Readonly<Record<string, number>> }[];
  }[];
  readonly nodes?: readonly Node[];
  readonly scenes?: readonly { readonly nodes?: readonly number[] }[];
  readonly scene?: number;
};

/** The node's own transform, as the map it applies to a point in its mesh's space. */
const nodeTransform = (node: Node): ((point: Vector) => Vector) => {
  const m = node.matrix;
  if (m !== undefined && m.length === 16) {
    // glTF matrices are column-major.
    return ([x, y, z]) => [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
  }
  const s = node.scale ?? [1, 1, 1];
  const t = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  return ([x, y, z]) => {
    const v: Vector = [x * s[0], y * s[1], z * s[2]];
    // q * v * q⁻¹, via the cross-product form.
    const cx = qy * v[2] - qz * v[1];
    const cy = qz * v[0] - qx * v[2];
    const cz = qx * v[1] - qy * v[0];
    return [
      v[0] + 2 * (qw * cx + qy * cz - qz * cy) + t[0],
      v[1] + 2 * (qw * cy + qz * cx - qx * cz) + t[1],
      v[2] + 2 * (qw * cz + qx * cy - qy * cx) + t[2],
    ];
  };
};

/**
 * The diagonal of a GLB's world-space position bounds, from the accessor
 * `min`/`max` the exporter already wrote — no vertex data is decoded.
 *
 * The scene graph is walked so a node's transform counts: `overlapping-cubes`
 * is two 40 mm cubes one of which is translated 20 mm, and its bounds are
 * 40 × 60 × 40 mm rather than the 40 mm one mesh declares.
 */
const glbDiagonal = (glb: Uint8Array): number => {
  const gltf = JSON.parse(glbJsonChunk(glb).json) as PositionedGltf;
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];

  const visit = (index: number, toWorld: (point: Vector) => Vector): void => {
    const node = gltf.nodes?.[index];
    if (node === undefined) return;
    const own = nodeTransform(node);
    const compose = (point: Vector): Vector => toWorld(own(point));
    for (const primitive of gltf.meshes?.[node.mesh ?? -1]?.primitives ?? []) {
      const accessor = gltf.accessors?.[primitive.attributes?.['POSITION'] ?? -1];
      const { min, max } = accessor ?? {};
      if (min === undefined || max === undefined) continue;
      // Eight corners, because a rotation turns the box's extremes into
      // corners that neither `min` nor `max` names on its own.
      for (let corner = 0; corner < 8; corner += 1) {
        const [x, y, z] = compose([
          (corner & 1 ? max : min)[0],
          (corner & 2 ? max : min)[1],
          (corner & 4 ? max : min)[2],
        ]);
        for (const [axis, part] of [x, y, z].entries()) {
          low[axis] = Math.min(low[axis], part);
          high[axis] = Math.max(high[axis], part);
        }
      }
    }
    for (const child of node.children ?? []) visit(child, compose);
  };

  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? (gltf.nodes ?? []).map((_, index) => index);
  for (const root of roots) visit(root, (point) => point);

  const diagonal = Math.hypot(...high.map((part, axis) => part - low[axis]));
  if (!Number.isFinite(diagonal) || diagonal <= 0) throw new Error('GLB declares no position bounds');
  return diagonal;
};

const diagonals = new Map<string, number>();

/**
 * The bounding-box diagonal of a demo's model, read once per docs build.
 *
 * Every length control is scaled by this, so it is resolved where the demo is
 * parsed rather than after the model lands in the browser: the controls are
 * right on their first paint, and an authored literal the controls cannot
 * express fails the build instead of reaching a reader.
 */
export const demoModelDiagonal = (url: string = demoModelUrl): number => {
  let diagonal = diagonals.get(url);
  if (diagonal === undefined) {
    // `process.cwd()` rather than `import.meta.dirname`: this runs inside the
    // Next server bundle too, where the module's own directory is not defined.
    const path = resolve(process.cwd(), 'public', url.replace(/^\//u, ''));
    diagonal = glbDiagonal(readFileSync(path));
    diagonals.set(url, diagonal);
  }
  return diagonal;
};
