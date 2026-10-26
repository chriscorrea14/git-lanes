// Renders media/icons/lanes-extension.svg to the 128px PNG used as the extension icon.
import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const svg = readFileSync('media/icons/lanes-extension.svg', 'utf8');
const png = new Resvg(svg, { fitTo: { mode: 'width', value: 128 }, background: 'rgba(0,0,0,0)' }).render().asPng();
writeFileSync('media/icons/icon.png', png);
console.log(`wrote media/icons/icon.png (${png.length} bytes)`);
