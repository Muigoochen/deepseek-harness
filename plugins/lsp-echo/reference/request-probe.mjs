// request-probe.mjs — what a check asks the bridge for, stage by stage.
//
//   node plugins/lsp-echo/reference/request-probe.mjs
//
// The cpp engine's fast path is only fast if the stage travels with the request
// (clientd request field and, on the fallback, `--stage`), and a request that does
// not name a stage must keep the engine's own default.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-request-probe-'))
process.env.DSH_HOME = HOME
const log = path.join(HOME, 'requests.jsonl')
const bridge = path.join(HOME, 'fake-bridge.mjs')
const project = path.join(HOME, 'proj')
fs.mkdirSync(path.join(project, 'src'), { recursive: true })
fs.writeFileSync(path.join(project, 'src', 'a.cpp'), 'int x;\n', 'utf8')
process.env.PROBE_LOG = log
process.env.PROBE_PROJECT = project

// A bridge that records every request and answers with an empty payload. A clientd
// that exits at once forces the one-shot `check` fallback.
fs.writeFileSync(bridge, `import fs from 'node:fs'
const log = process.env.PROBE_LOG
const payload = () => ({
  tool: 'fake', version: 1, project: process.env.PROBE_PROJECT, files: {}, syntheticKeys: [],
  summary: { files_checked: 0, errors: 0, warnings: 0, files_with_errors: [] },
})
const argv = process.argv.slice(2)
if (argv[0] === 'clientd') {
  if (process.env.PROBE_CLIENTD_DIES === '1') process.exit(1)
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => {
    buf += d
    const lines = buf.split('\\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.trim()) continue
      const req = JSON.parse(line)
      fs.appendFileSync(log, JSON.stringify({ via: 'clientd', req }) + '\\n')
      process.stdout.write(JSON.stringify({ id: req.id, ok: true, payload: payload() }) + '\\n')
    }
  })
} else {
  fs.appendFileSync(log, JSON.stringify({ via: 'check', argv }) + '\\n')
  const i = argv.indexOf('--out')
  fs.writeFileSync(argv[i + 1], JSON.stringify(payload()))
  process.exit(0)
}
`, 'utf8')

const { checkFiles, stopClientd } = await import(new URL('../lib/manager.js', import.meta.url))
const requests = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
const exts = ['.cpp']

let checks = 0
let failures = 0
function ok(cond, label, detail) {
  checks++
  if (cond) { console.log(`  ok   ${label}`); return }
  failures++
  console.log(`  FAIL ${label}${detail ? `  ${detail}` : ''}`)
}

// 1. the stage travels with the clientd request, next to the limits it shares a call site with
await checkFiles(bridge, project, [path.join(project, 'src', 'a.cpp')], 20_000, 'main', exts, exts, undefined, undefined, 40_000, true, 'auto')
let last = requests().filter((r) => r.via === 'clientd').pop()
ok(!!last && last.req.stage === 'auto', 'the clientd request carries stage: auto', JSON.stringify(last && last.req))
ok(!!last && last.req.budgetMs === 40_000 && last.req.noWait === true,
  'without dropping the budget and waiting policy it travels with', JSON.stringify(last && last.req))

// 2. no stage asked for means the engine's own default: the field must be absent,
// not filled in by the plugin (a baseline sweep and an unknown engine rely on it)
await checkFiles(bridge, project, [path.join(project, 'src', 'a.cpp')], 20_000, 'main', exts, exts)
last = requests().filter((r) => r.via === 'clientd').pop()
ok(!!last && !('stage' in last.req), 'a request that names no stage sends none', JSON.stringify(last && last.req))

// 3. the one-shot fallback asks for the same stage, or a fast check silently becomes
// a full build (and the bridge's default is the build). The pooled clientd has to go
// first: it would otherwise answer this call and the fallback would never run.
try {
  stopClientd(bridge, project)
  process.env.PROBE_CLIENTD_DIES = '1'
  const fallback = await checkFiles(bridge, project, [path.join(project, 'src', 'a.cpp')], 20_000, 'main', exts, exts, undefined, undefined, 40_000, true, 'auto')
  last = requests().filter((r) => r.via === 'check').pop()
  ok(!!last && last.argv[last.argv.indexOf('--stage') + 1] === 'auto',
    'the one-shot fallback carries --stage auto', JSON.stringify(last && last.argv))
  ok(!!fallback && fallback.tool === 'fake',
    'and the fallback result is the one this probe persisted', JSON.stringify(fallback && fallback.summary))

  // 4. the wiring the manager cannot show: the pre-step asks for the stage its
  // engine declares, and that declaration lives in engine.json (a source-shape
  // check: driving this plugin's pre-step needs a whole agent loop).
  const cppEngine = JSON.parse(fs.readFileSync(new URL('../checkers/cpp-gdextension/engine.json', import.meta.url), 'utf8'))
  const indexSrc = fs.readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok(typeof cppEngine.preStepStage === 'string' && cppEngine.preStepStage.length > 0,
    'the cpp engine declares the stage its pre-step check asks for', JSON.stringify(cppEngine.preStepStage))
  ok(/stage:\s*eng\.preStepStage/.test(indexSrc) && /eng\.budgetMs \|\| eng\.noWait/.test(indexSrc),
    'and the pre-step limits carry that declaration, not a hardcoded name',
    `stage: eng.preStepStage → ${/stage:\s*eng\.preStepStage/.test(indexSrc)}`)
} finally {
  fs.rmSync(HOME, { recursive: true, force: true })
}

console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${checks - failures}/${checks} checks`)
process.exit(failures ? 1 : 0)
