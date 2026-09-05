/**
 * Client bundle build: emits the loader's lazy-CJS factory artifact that
 * dsh serves at /plugins/<id>/client.js.
 *
 * Mirrors dsh-plugin-model-proxy/scripts/build-client.mjs: bundle the client
 * source to one CJS file, keep the platform module-table specifiers external
 * (they become require() calls the loader answers), and wrap the body in the
 * registration handoff. Plain tsc emits raw ESM that never registers
 * ("bundle ... loaded without registering").
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** Module-table words the loader answers (same baseline as model-proxy). */
const MODULE_TABLE_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
]

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  jsx: 'automatic',
  sourcemap: true,
  external: MODULE_TABLE_EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: '\nreturn module.exports; } });',
  },
})

// Test-only side artifacts: plain ESM transforms of dependency-free client
// modules so `node --test` can exercise them without a DOM or the loader
// bundle. Live OUTSIDE lib/ on purpose — `files: ["lib/"]` publishes
// everything under there verbatim.
await build({
  entryPoints: ['src/client/controller.ts'],
  outdir: '.test-build',
  bundle: false,
  format: 'esm',
  target: 'es2024',
})
