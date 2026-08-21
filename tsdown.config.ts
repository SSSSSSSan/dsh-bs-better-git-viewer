/**
 * tsdown build for dsh-bs-better-git (independent of the DSH monorepo build;
 * pattern copied from DSH-split-panes / DSH-console). Emits two artifacts:
 * - out/index.js  — the HOST half (ESM, Node): the /bsgit/api route
 *   (git repository discovery + git commands via the system `git` binary).
 * - out/client.js — the BROWSER client bundle (CJS, __ModuleLoader__ wrap):
 *   registers a git tab into ctx.betterSidebar.
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** The shell's frozen module table (mirror of PLATFORM_MODULES in the DSH
 *  web client): these specifiers resolve through the loader's require. */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Package identity stamped into the loader handoff and the style tags.
 *  MUST equal package.json `name`. */
const ID = 'dsh-bs-better-git-viewer'

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_RAW_VIRTUAL_PREFIX = '\0dsh-css-raw:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** The style-tag injection body shared by module and raw CSS inlines. */
function styleTagCode(tagId: string, css: string): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ].join('\n')
}

/** The host-half library build. */
const hostConfig: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'out',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: true,
}

/** The browser client bundle. */
const clientConfig: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'out',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...PLATFORM_MODULES],
  noExternal: (source: string) => (PLATFORM_MODULES.includes(source as never) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      const prefix = source.endsWith('.module.css') ? CSS_VIRTUAL_PREFIX : CSS_RAW_VIRTUAL_PREFIX
      return prefix + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (virtualId.startsWith(CSS_RAW_VIRTUAL_PREFIX)) {
        const fileId = virtualId.slice(CSS_RAW_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const css = (await readFile(fileId)).toString()
        const tagId = `${ID}/${basename(fileId)}`
        return [styleTagCode(tagId, css), 'export default "";'].join('\n')
      }
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      const tagId = `${ID}/${basename(fileId)}`
      return [
        styleTagCode(tagId, code.toString()),
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [hostConfig, clientConfig]
