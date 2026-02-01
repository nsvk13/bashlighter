const esbuild = require('esbuild');
const path = require('path');

const isDev = process.argv.includes('--dev');

async function build() {
  await esbuild.build({
    entryPoints: [path.join(__dirname, 'client', 'src', 'extension.ts')],
    outfile: path.join(__dirname, 'client', 'out', 'extension.js'),
    bundle: true,
    platform: 'node',
    target: 'node18',
    sourcemap: isDev,
    minify: !isDev,
    format: 'cjs',
    external: ['vscode'],
  });

  console.log('Build completed successfully');
}

build().catch((err) => {
  console.error('Build failed:', err);
  process.exit(1);
});
