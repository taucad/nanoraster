// One-off: rotate the demo GLB's root node 90° about Y so the gear axis (+Z as
// authored) becomes +X. Then `phi: 90, theta: 0` (the tutorial's "front") looks at
// the gear's face. Rewrites only the JSON chunk; vertex data is untouched.
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../public/demo/gear-12-metal.glb', import.meta.url);
const glb = readFileSync(path);
const jsonLength = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8'));

const half = Math.SQRT1_2; // sin(45°) = cos(45°)
json.nodes[0].rotation = [0, half, 0, half]; // +90° about Y: (0,0,1) → (1,0,0)

let body = Buffer.from(JSON.stringify(json), 'utf8');
while (body.length % 4 !== 0) body = Buffer.concat([body, Buffer.from(' ')]);

const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
const chunkHeader = Buffer.alloc(8);
chunkHeader.writeUInt32LE(body.length, 0);
chunkHeader.writeUInt32LE(0x4e4f534a, 4); // JSON
const rest = glb.subarray(20 + jsonLength);
const out = Buffer.concat([header, chunkHeader, body, rest]);
out.writeUInt32LE(out.length, 8);
writeFileSync(path, out);
console.log(`rotated root node; ${glb.length} → ${out.length} bytes`);
