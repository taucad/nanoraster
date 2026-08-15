export type CameraAngles = { readonly phi: number; readonly theta: number };

export type CameraUpAxis = 'x' | 'y' | 'z';

type Vector3Tuple = readonly [x: number, y: number, z: number];

const degrees = 180 / Math.PI;
const radians = Math.PI / 180;

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

/** Convert NanoRaster spherical angles to an eye offset. */
export const offsetFromAngles = (
  { phi, theta }: CameraAngles,
  distance: number,
  up: CameraUpAxis,
): Vector3Tuple => {
  const polar = phi * radians;
  const azimuth = theta * radians;
  const planar = distance * Math.sin(polar);
  const axial = distance * Math.cos(polar);
  if (up === 'x') return [axial, planar * Math.cos(azimuth), planar * Math.sin(azimuth)];
  if (up === 'z') return [planar * Math.cos(azimuth), planar * Math.sin(azimuth), axial];
  return [planar * Math.cos(azimuth), axial, -planar * Math.sin(azimuth)];
};

/** Read NanoRaster spherical angles from a camera eye offset. */
export const anglesFromOffset = ([x, y, z]: Vector3Tuple, up: CameraUpAxis): CameraAngles => {
  const distance = Math.hypot(x, y, z);
  if (distance === 0) return { phi: 60, theta: -45 };
  if (up === 'x') {
    return { phi: Math.acos(clamp(x / distance, -1, 1)) * degrees, theta: Math.atan2(z, y) * degrees };
  }
  if (up === 'z') {
    return { phi: Math.acos(clamp(z / distance, -1, 1)) * degrees, theta: Math.atan2(y, x) * degrees };
  }
  return { phi: Math.acos(clamp(y / distance, -1, 1)) * degrees, theta: Math.atan2(-z, x) * degrees };
};
