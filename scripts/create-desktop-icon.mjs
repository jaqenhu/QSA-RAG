import { Resvg } from '@resvg/resvg-js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const custom = new URL('../desktop/icon.svg', import.meta.url);
const svg = readFileSync(existsSync(custom) ? custom : new URL('../favicon.svg', import.meta.url), 'utf8');
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map(width => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng());
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
pngs.forEach((png, i) => {
  const entry = 6 + i * 16;
  header[entry] = sizes[i] % 256; header[entry + 1] = sizes[i] % 256;
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += png.length;
});
writeFileSync(new URL('../desktop/icon.ico', import.meta.url), Buffer.concat([header, ...pngs]));
writeFileSync(new URL('../desktop/icon.png', import.meta.url), pngs.at(-1));
console.log(existsSync(custom) ? '已生成桌面图标。' : '已从现有 favicon 制作临时桌面图标。');
