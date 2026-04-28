import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

async function build() {
  const extensionCtx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    external: ['vscode'],
    format: 'cjs',
    platform: 'node',
    sourcemap: true,
  });

  const webviewCtx = await esbuild.context({
    entryPoints: ['webview/editor.ts'],
    outfile: 'dist/webview.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    sourcemap: true,
  });

  if (watch) {
    await extensionCtx.watch();
    await webviewCtx.watch();
    console.log('Watching for changes...');
  } else {
    await extensionCtx.rebuild();
    await extensionCtx.dispose();
    await webviewCtx.rebuild();
    await webviewCtx.dispose();
    console.log('Build complete.');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
