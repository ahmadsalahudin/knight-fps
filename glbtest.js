// decode path test outside browser
const fs = require('fs');
const src = fs.readFileSync('assets.js', 'utf8');
const m = src.match(/window\.ASSETS\["grass"\] = "data:model\/gltf-binary;base64,([^"]+)"/);
const bin = Buffer.from(m[1], 'base64');
const ab = new Uint8Array(bin.length); ab.set(bin);
const view = new DataView(ab.buffer);
const totalLen = view.getUint32(8, true);
console.log('magic ok:', view.getUint32(0, true) === 0x46546C67, '| header len:', totalLen, '| actual:', ab.byteLength);
let off = 12;
while (off < totalLen) {
  const cLen = view.getUint32(off, true);
  const cType = view.getUint32(off + 4, true);
  console.log('chunk at', off, 'type:', cType.toString(16), 'len:', cLen);
  off += 12 + cLen; off = (off + 3) & ~3;
  if (off + 8 > ab.byteLength && off < totalLen) { console.log('OVERRUN: off', off, 'totalLen', totalLen, 'byteLength', ab.byteLength); break; }
}
