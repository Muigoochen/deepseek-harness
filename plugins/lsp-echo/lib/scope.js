// Keyspace scoping shared by the plugin entry and the snapshot writer. Both
// must agree on which keys belong to an engine, including the keys an engine
// produces without any file extension (the cpp bridge's `<link>` for a link or
// build-system failure) — an extension table cannot see those, so they are
// handled explicitly here and in `writeSnapshot`.

/**
 * Lower-cased extension of a snapshot key, `''` when it has none.
 * @param {string} file snapshot key (project-relative path) or a synthetic key
 * @returns {string} extension including the dot
 */
export function extOf(file) {
  const i = file.lastIndexOf('.')
  return i >= 0 ? file.slice(i).toLowerCase() : ''
}

/**
 * Narrow a merged payload to one engine's keyspace, so injected text carries
 * only what this round's engine was asked about. A key without an extension is
 * engine-synthetic: it is kept only for the engine that declares it in
 * `syntheticKeys`, so the cpp bridge's link/build bucket appears in cpp rounds
 * and never rides along in another engine's round.
 * @param {object} payload merged snapshot payload
 * @param {string[]} [extList] extensions owned by the engine
 * @param {string[]} [syntheticKeys] extensionless keys this engine owns
 * @returns {{files: object, summary: {files_checked: number, errors: number, warnings: number, files_with_errors: string[]}}}
 */
export function engineScope(payload, extList, syntheticKeys) {
  const files = payload && payload.files && typeof payload.files === 'object' ? payload.files : {}
  const own = new Set((extList || []).map((e) => String(e).toLowerCase()))
  const synth = new Set(syntheticKeys || [])
  const out = {}
  let errors = 0
  let warnings = 0
  const filesWithErrors = []
  for (const rel of Object.keys(files)) {
    const ext = extOf(rel)
    if (ext ? !own.has(ext) : !synth.has(rel)) continue
    const rec = files[rel]
    out[rel] = rec
    errors += (rec && rec.errors) || 0
    warnings += (rec && rec.warnings) || 0
    if (rec && rec.errors > 0 && !synth.has(rel)) filesWithErrors.push(rel)
  }
  return {
    files: out,
    // A synthetic bucket contributes its errors but is not a checked file.
    summary: {
      files_checked: Object.keys(out).filter((rel) => !synth.has(rel)).length,
      errors,
      warnings,
      files_with_errors: filesWithErrors,
    },
  }
}
