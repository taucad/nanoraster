import { describe, expect, it } from 'vitest';

import { anglesFromOffset, offsetFromAngles, type CameraUpAxis } from './camera-math';

describe('camera angle bridge', () => {
  it.each<CameraUpAxis>(['x', 'y', 'z'])('round-trips %s-up camera angles', (up) => {
    const expected = { phi: 63.5, theta: -112.25 };
    const actual = anglesFromOffset(offsetFromAngles(expected, 8, up), up);
    expect(actual.phi).toBeCloseTo(expected.phi, 10);
    expect(actual.theta).toBeCloseTo(expected.theta, 10);
  });
});
