import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'
import solid from 'vite-plugin-solid'

/**
 * Writes .br and .gz next to every text file of the build, compressed once at maximum level. The
 * server sends those as they are, instead of compressing the UI again for every request.
 */
function precompress(): Plugin {
  const TEXT = /\.(js|mjs|css|html|svg|json|webmanifest|txt)$/
  let outDir = ''
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? walk(path) : [path]
    })
  return {
    name: 'agentdeck-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      for (const path of walk(outDir)) {
        if (!TEXT.test(path)) continue
        const data = readFileSync(path)
        if (data.length < 1024) continue
        writeFileSync(
          `${path}.br`,
          brotliCompressSync(data, {
            params: {
              [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
              [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
            },
          }),
        )
        writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }))
      }
    },
  }
}

export default defineConfig({
  root: 'web',
  plugins: [solid(), precompress()],
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  server: { proxy: { '/api': 'http://localhost:8790' } },
})
