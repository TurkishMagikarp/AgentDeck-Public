#!/usr/bin/env node
// File tools of the API agent (apiAgent.ts). In the sandbox this file runs as the project user,
// so the kernel decides what the agent may touch; the checks here keep it in its directory
// either way, also through symlinks.
//   node agentFiles.mjs <cwd> <tool>   reads { path, content?, old_text?, new_text? } on stdin
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const outside = (root, full) => {
  const rel = relative(root, full)
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
}

/** The real path of `path` below `cwd`, symlinks resolved. Throws when it leads outside. */
async function inside(cwd, path) {
  const root = await realpath(cwd)
  const full = resolve(root, path || '.')
  if (outside(root, full)) throw new Error('Path is outside the working directory')
  // The deepest part that exists decides where the path really leads.
  let existing = full
  for (;;) {
    try {
      existing = await realpath(existing)
      break
    } catch {
      const parent = dirname(existing)
      if (parent === existing) break
      existing = parent
    }
  }
  if (outside(root, existing)) throw new Error('Path is outside the working directory')
  return full
}

export async function fileTool(cwd, tool, args) {
  switch (tool) {
    case 'read_file':
      return readFile(await inside(cwd, args.path), 'utf8')
    case 'list_dir': {
      const entries = await readdir(await inside(cwd, args.path || '.'), { withFileTypes: true })
      return entries.map((entry) => entry.name + (entry.isDirectory() ? sep : '')).join('\n') || '(empty)'
    }
    case 'write_file': {
      const file = await inside(cwd, args.path)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(await inside(cwd, args.path), args.content ?? '')
      return 'written'
    }
    case 'edit_file': {
      const file = await inside(cwd, args.path)
      const before = await readFile(file, 'utf8')
      const count = before.split(args.old_text).length - 1
      if (count !== 1) return `old_text must match exactly once, it matches ${count} times`
      await writeFile(file, before.replace(args.old_text, () => args.new_text))
      return 'edited'
    }
    default:
      return `Unknown tool ${tool}`
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cwd, tool] = process.argv.slice(2)
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  fileTool(cwd, tool, JSON.parse(input || '{}')).then(
    (result) => process.stdout.write(result),
    (error) => {
      process.stdout.write(`Error: ${error.message}`)
      process.exitCode = 1
    },
  )
}
