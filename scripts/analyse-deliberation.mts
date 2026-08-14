/**
 * The compute layer's second job: opinion analysis over the whole commons.
 *
 *   public/commons/snapshot.json  →  public/commons/deliberation.json
 *
 * WHY THIS IS A .mts AND THE AGGREGATOR IS PLAIN .mjs
 * `aggregate-bundles.mjs` is dependency-free JavaScript because it
 * reimplements canonicalization and signature verification, and those must be
 * readable — and reimplementable in Python — by someone who has never opened
 * the Next.js toolchain. It is a security boundary, so the duplication buys
 * something.
 *
 * Clustering is not a security boundary. It is arithmetic, and its output is
 * advisory: every device recomputes the same thing locally from its own view.
 * So this script imports the EXACT module the phone runs. One implementation,
 * therefore no drift — and because the algorithm is deterministic, a device
 * holding the same votes computes byte-identical results.
 *
 *   npm run analyse
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  analyseConversation,
  rankBridging,
  rankDivisive,
  type OpinionMap,
} from '../src/lib/deliberate/cluster'
import type { Conversation, Statement, Vote } from '../src/lib/db/schema'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

const ROOT = process.cwd()
const OUT = join(ROOT, 'public', 'commons')
const MANIFEST = join(OUT, 'manifest.json')
const RESULT = join(OUT, 'deliberation.json')

/** Snapshot filenames carry a content hash, so the manifest is the only index. */
async function locateSnapshot(): Promise<string | null> {
  if (!existsSync(MANIFEST)) return null
  const manifest = JSON.parse(await readFile(MANIFEST, 'utf8')) as {
    entries?: Array<{ path: string }>
  }
  const path = manifest.entries?.[0]?.path
  if (!path) return null
  const full = join(OUT, path)
  return existsSync(full) ? full : null
}

interface SnapshotOp {
  entity: string
  entityId: string
  op: 'put' | 'tombstone'
  body: string
}

async function main(): Promise<void> {
  const started = Date.now()

  const snapshotPath = await locateSnapshot()
  if (!snapshotPath) {
    console.log('No snapshot to analyse — run `npm run aggregate` first.')
    return
  }

  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as { ops?: SnapshotOp[] }
  const ops = snapshot.ops ?? []

  const conversations: Conversation[] = []
  const statements: Statement[] = []
  const votes: Vote[] = []

  for (const op of ops) {
    // Tombstones carry a minimal body; the record is already excluded from the
    // snapshot's live set, so skipping them here is correct.
    if (op.op !== 'put') continue
    let record: unknown
    try {
      record = JSON.parse(op.body)
    } catch {
      continue
    }
    if (op.entity === 'conversation') conversations.push(record as Conversation)
    else if (op.entity === 'statement') statements.push(record as Statement)
    else if (op.entity === 'vote') votes.push(record as Vote)
  }

  const results: Record<
    string,
    {
      title: string
      map: OpinionMap
      bridging: string[]
      divisive: string[]
    }
  > = {}

  // Sorted so the output file is stable between runs — otherwise every CI run
  // produces a diff and the commit history becomes noise.
  const ordered = [...conversations].sort((a, b) => (a.id < b.id ? -1 : 1))

  for (const conversation of ordered) {
    const theirs = statements.filter((s) => s.conversationId === conversation.id)
    const cast = votes.filter((v) => v.conversationId === conversation.id)
    const map = analyseConversation(theirs, cast)

    results[conversation.id] = {
      title: conversation.title,
      map,
      bridging: rankBridging(map.statements)
        .slice(0, 10)
        .map((s) => s.statementId),
      divisive: rankDivisive(map.statements)
        .slice(0, 10)
        .map((s) => s.statementId),
    }
  }

  await mkdir(OUT, { recursive: true })
  const payload = {
    v: 1,
    // No timestamp: a wall clock here would change the file on every run even
    // when nothing about the analysis changed, defeating the stable-diff aim.
    conversations: results,
  }
  await writeFile(RESULT, JSON.stringify(payload, null, 2))

  console.log(`lacinia analyse — ${Date.now() - started}ms`)
  console.log(`  conversations  ${ordered.length}`)
  console.log(`  statements     ${statements.length}`)
  console.log(`  votes          ${votes.length}`)
  for (const [id, result] of Object.entries(results)) {
    const status =
      result.map.status === 'ok'
        ? `${result.map.k} group${result.map.k === 1 ? '' : 's'}, silhouette ${result.map.silhouette}`
        : result.map.reason
    console.log(`  · ${result.title.slice(0, 40).padEnd(40)} ${status}`)
    if (result.map.status === 'ok' && result.bridging[0]) {
      const top = result.map.statements.find((s) => s.statementId === result.bridging[0])
      console.log(`      bridges best: ${result.bridging[0]} (consensus ${top?.consensus})`)
    }
    void id
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
