import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

// The shipped example overlay under apps/cli is the subject: mounting it over
// a real shipped profile must yield durable clock readings whose display zone
// prefers the request's browser zone and falls back to the overlay's timeZone.
const exampleOverlay = fileURLToPath(new URL(
  '../../../../apps/cli/config/examples/time-context/cordis.patch.yml',
  import.meta.url,
))
const companionOverlay = fileURLToPath(new URL(
  './fixtures/web-example.patch.yml',
  import.meta.url,
))
const driver = fileURLToPath(new URL(
  './fixtures/web-example-driver.ts',
  import.meta.url,
))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

function timeContextReadings(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== 'time-context') return []
    return event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
  })
}

describe('time-context through the shipped Web clock overlay example', () => {
  it('prefers the request browser zone and falls back to the example timeZone', async () => {
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'time-context web overlay smoke',
      tempDirPrefix: 'time-context-web-example-',
      binScript: driver,
      libBinScript: driver,
      binArgs: [exampleOverlay, companionOverlay],
      configPath: exampleOverlay,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(2)

    const readings = timeContextReadings(events)
    const starts = events.filter(event => event.type === 'step/start')
    const contextEvents = events.filter(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && event.data.source.kind === 'plugin'
        && event.data.source.plugin === 'time-context')
    expect(readings).toHaveLength(2)
    expect(starts).toHaveLength(2)
    for (let index = 0; index < contextEvents.length; index += 1) {
      expect(contextEvents[index]!.seq).toBeGreaterThan(starts[index]!.seq)
      expect(contextEvents[index]!.surfaceOp).toBe('append')
      expect(contextEvents[index]!.data.source).toMatchObject({
        kind: 'plugin',
        plugin: 'time-context',
        form: 'snapshot',
        sections: [{ name: 'time-context' }],
      })
    }

    // A browser-zoned prompt wins over the overlay's configured fallback zone.
    const firstLines = readings[0]!.split('\n')
    expect(firstLines[0]).toMatch(
      /^Time sampled while preparing turn 1, step 1: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\+|-)\d{2}:\d{2}\[America\/New_York\]$/,
    )
    expect(firstLines[1]).toBe(
      'Browser time zone for this request: America/New_York. '
      + 'Interpret otherwise-unqualified dates and times in this zone.',
    )
    // A zone-less prompt displays in the overlay's Asia/Shanghai fallback and
    // keeps the ask-to-clarify policy instead of guessing.
    const secondLines = readings[1]!.split('\n')
    expect(secondLines[0]).toMatch(
      /^Time sampled while preparing turn 2, step 1: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00\[Asia\/Shanghai\]$/,
    )
    expect(secondLines[1]).toBe(
      'Browser time zone for this request: unavailable. '
      + 'Ask the user to clarify otherwise-unqualified dates and times.',
    )
    expect(secondLines[2]).toMatch(
      /^Elapsed since the preceding model-visible message: (?:\d+d )?(?:\d+h )?(?:\d+m )?\d+s\.$/,
    )

    const headers = events.filter(event => event.type === 'request/header')
    expect(JSON.stringify(headers)).not.toContain('Time sampled while preparing')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
