import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const configs = [
  {
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  },
  {
    entryPoints: ['media/webview/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
  },
].map((c) => ({ bundle: true, sourcemap: true, target: 'es2022', ...c }));

if (watch) {
  for (const c of configs) await (await esbuild.context(c)).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
