import { zstdDecompressSync } from 'node:zlib'
import { readHeader, sessionDirs, dshHome } from './migrate.mjs'

const target = process.argv[2]
const all = sessionDirs(dshHome())
const found = all.find((s) => s.id === target)
if (!found) {
  console.log(JSON.stringify({ error: `session not found: ${target}` }))
  process.exit(1)
}
const { header, frames, buffer } = await readHeader(found.file)
const types = new Map()
const marks = []
let events = 0
let firstSeq = null
let lastSeq = null
for (const frame of frames.slice(1)) {
  const text = zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    events += 1
    types.set(ev.type, (types.get(ev.type) ?? 0) + 1)
    if (typeof ev.seq === 'number') {
      if (firstSeq === null) firstSeq = ev.seq
      lastSeq = ev.seq
    }
    if (ev.type === 'compaction/start') marks.push(`start@${ev.seq}`)
    if (ev.type === 'compaction/end') marks.push(`end@${ev.seq}`)
    if (ev.type === 'agent-preset/selected') marks.push(`preset-selected@${ev.seq} ${JSON.stringify(ev.data)}`)
  }
}
console.log(JSON.stringify({
  id: found.id,
  workspace: found.workspace,
  frames: frames.length,
  bytes: buffer.length,
  header,
  events,
  seqRange: [firstSeq, lastSeq],
  marks,
  topTypes: [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
}, null, 1))
