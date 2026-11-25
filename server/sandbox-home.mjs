#!/usr/bin/env node
// Runs as a project user. Copies CLI logins between the server's home and the project's home
// without the project user ever reading the server's home: the server sends and receives the
// file contents through stdin and stdout.
//   in:  stdin is [{ path, data (base64), mtime }]; each file is written when it is newer
//   out: argv lists paths; stdout is [{ path, data, mtime }] of those that exist
//   rm:  argv lists paths to delete
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, normalize } from 'node:path'

const home = homedir()
const inside = (path) => {
  const relative = normalize(path)
  if (relative.startsWith('..') || relative.startsWith('/')) throw new Error('path outside home: ' + path)
  return join(home, relative)
}
const mtimeOf = (file) => {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

const [mode, ...paths] = process.argv.slice(2)
if (mode === 'in') {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  for (const { path, data, mtime } of JSON.parse(input || '[]')) {
    const file = inside(path)
    if (mtimeOf(file) >= mtime) continue
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, Buffer.from(data, 'base64'), { mode: 0o600 })
    chmodSync(file, 0o600)
    utimesSync(file, new Date(), new Date(mtime))
  }
} else if (mode === 'out') {
  const files = []
  for (const path of paths) {
    const file = inside(path)
    const mtime = mtimeOf(file)
    if (mtime) files.push({ path, data: readFileSync(file).toString('base64'), mtime })
  }
  process.stdout.write(JSON.stringify(files))
} else if (mode === 'rm') {
  for (const path of paths) rmSync(inside(path), { force: true })
} else {
  console.error('usage: sandbox-home.mjs in|out|rm [paths]')
  process.exit(2)
}
