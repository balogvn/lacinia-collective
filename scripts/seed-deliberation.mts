/**
 * Seeds a polarized conversation into `commons/inbox/` so the deliberation
 * pipeline can be exercised against a real commons and a real network pull.
 *
 * The population is deliberately split into two blocs with a genuine fault
 * line, because a conversation where everyone agrees demonstrates nothing about
 * bridge-finding.
 *
 *   npx tsx scripts/seed-deliberation.mts && npm run aggregate && npm run analyse
 */

import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { createSignedOp, type SignedOp } from '../src/lib/sync/ops'
import { createBundle } from '../src/lib/sync/bundle'
import { generateEphemeralKeyPair, type KeyPair } from '../src/lib/crypto/keys'
import { conversationIdFor, statementIdFor, voteIdFor } from '../src/lib/deliberate/ids'
import { createClock, now as hlcNow } from '../src/lib/hlc'
import { VoteValue, FlagReason } from '../src/lib/db/schema'
import { createFlag } from '../src/lib/moderate/flag'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

const clock = createClock('delibsd')
const tick = () => hlcNow(clock)
const CREATED = 1_700_000_000_000

const convener = generateEphemeralKeyPair()
const blocA: KeyPair[] = Array.from({ length: 14 }, () => generateEphemeralKeyPair())
const blocB: KeyPair[] = Array.from({ length: 7 }, () => generateEphemeralKeyPair())

const ops: SignedOp[] = []

/* ── the conversation ── */
const conversationId = conversationIdFor(convener.pubKeyId, 'The market levy', CREATED)
const conversation = {
  id: conversationId,
  authorPub: convener.pubKeyId,
  title: 'The market levy',
  prompt: 'What should change about how the daily levy is collected and spent?',
  locality: { state: 'Lagos', lga: 'Ikorodu' },
  createdAt: CREATED,
  closesAt: CREATED + 90 * 86_400_000,
  hlc: tick(),
}
ops.push(
  createSignedOp(convener, {
    hlc: conversation.hlc,
    entity: 'conversation',
    entityId: conversationId,
    op: 'put',
    record: conversation,
  }),
)

/* ── statements, each authored by a real bloc member ── */
const SEED_STATEMENTS: Array<{ text: string; author: KeyPair; kind: 'tribal' | 'bridge' | 'split' }> =
  [
    { text: 'Our end of the market has been ignored for years', author: blocA[0]!, kind: 'tribal' },
    { text: 'The lock-up owners decide everything among themselves', author: blocB[0]!, kind: 'tribal' },
    { text: 'The levy accounts should be read aloud at every monthly meeting', author: blocB[1]!, kind: 'bridge' },
    { text: 'Refuse collection should be shared street by street, not by stall size', author: blocA[1]!, kind: 'bridge' },
    { text: 'Anyone collecting the levy should wear a numbered badge', author: blocA[2]!, kind: 'bridge' },
    { text: 'The chairman should be replaced before the next season', author: blocA[3]!, kind: 'split' },
    { text: 'Traders under twenty-five should have two seats on the committee', author: blocB[2]!, kind: 'split' },
  ]

const statementIds: string[] = []

SEED_STATEMENTS.forEach((entry, i) => {
  const createdAt = CREATED + i * 60_000
  const id = statementIdFor(entry.author.pubKeyId, conversationId, entry.text, createdAt)
  statementIds.push(id)
  const hlc = tick()
  ops.push(
    createSignedOp(entry.author, {
      hlc,
      entity: 'statement',
      entityId: id,
      op: 'put',
      record: {
        id,
        conversationId,
        authorPub: entry.author.pubKeyId,
        text: entry.text,
        createdAt,
        hlc,
      },
    }),
  )
})

/* ── votes ── */

/** Deterministic per-(voter, statement) dissent, uncorrelated across statements. */
function dissents(voter: string, statementId: string, percent: number): boolean {
  let h = 2166136261 >>> 0
  const key = `${voter}|${statementId}`
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h >>> 0) % 100 < percent
}

function castVote(voter: KeyPair, statementId: string, value: VoteValue): void {
  const hlc = tick()
  const id = voteIdFor(voter.pubKeyId, statementId)
  ops.push(
    createSignedOp(voter, {
      hlc,
      entity: 'vote',
      entityId: id,
      op: 'put',
      record: {
        id,
        statementId,
        conversationId,
        authorPub: voter.pubKeyId,
        value,
        createdAt: CREATED,
        hlc,
      },
    }),
  )
}

SEED_STATEMENTS.forEach((entry, i) => {
  const statementId = statementIds[i]!
  const tribalForA = i === 0

  for (const voter of blocA) {
    let value: VoteValue
    if (entry.kind === 'tribal') {
      value = tribalForA ? VoteValue.Agree : VoteValue.Disagree
    } else if (entry.kind === 'bridge') {
      value = dissents(voter.pubKeyId, statementId, 40) ? VoteValue.Disagree : VoteValue.Agree
    } else {
      value = dissents(voter.pubKeyId, statementId, 50) ? VoteValue.Disagree : VoteValue.Agree
    }
    castVote(voter, statementId, value)
  }

  for (const voter of blocB) {
    let value: VoteValue
    if (entry.kind === 'tribal') {
      value = tribalForA ? VoteValue.Disagree : VoteValue.Agree
    } else if (entry.kind === 'bridge') {
      value = VoteValue.Agree
    } else {
      value = VoteValue.Disagree
    }
    castVote(voter, statementId, value)
  }
})

/* ── moderation: two campaigns with opposite outcomes ── */

function raiseFlag(from: KeyPair, targetId: string, reason: FlagReason): void {
  const hlc = tick()
  const flag = { ...createFlag(from, { targetId, targetEntity: 'statement', reason, conversationId }), hlc }
  ops.push(
    createSignedOp(from, {
      hlc,
      entity: 'flag',
      entityId: flag.id,
      op: 'put',
      record: flag,
    }),
  )
}

// CAMPAIGN 1 — THE FACTIONAL ATTACK. Every member of bloc A flags bloc B's
// tribal statement as abuse. Bloc B raises nothing. This must change nothing:
// one group objecting is a disagreement, and disagreement has its own button.
const blocBTribal = statementIds[1]!
for (const voter of blocA) raiseFlag(voter, blocBTribal, FlagReason.Abuse)

// CAMPAIGN 2 — GENUINE ABUSE. A statement both blocs independently object to.
// Roughly a third of each group flags it, nobody coordinating.
// Deliberately abusive — it exists to be caught by the moderation layer, and
// the demo is worthless if the only flagged statement is one nobody would
// actually flag. Phrased as an attack on the rival stall block within this
// fictional market, not on any real group: this ships on a public site, and
// synthetic test data has a way of being read out of context.
const abusiveText = 'The lock-up crowd are thieves and should be thrown out of the market'
const abusiveCreatedAt = CREATED + 999_000
const abusiveId = statementIdFor(blocA[9]!.pubKeyId, conversationId, abusiveText, abusiveCreatedAt)
{
  const hlc = tick()
  ops.push(
    createSignedOp(blocA[9]!, {
      hlc,
      entity: 'statement',
      entityId: abusiveId,
      op: 'put',
      record: {
        id: abusiveId,
        conversationId,
        authorPub: blocA[9]!.pubKeyId,
        text: abusiveText,
        createdAt: abusiveCreatedAt,
        hlc,
      },
    }),
  )
}
for (const voter of blocA.slice(0, 6)) raiseFlag(voter, abusiveId, FlagReason.Abuse)
for (const voter of blocB.slice(0, 4)) raiseFlag(voter, abusiveId, FlagReason.Abuse)

const bundle = createBundle(convener, ops)
const inbox = join(process.cwd(), 'commons', 'inbox')
await mkdir(inbox, { recursive: true })
await writeFile(join(inbox, 'seed-deliberation.json'), JSON.stringify(bundle, null, 2))

console.log(`Seeded a conversation with ${SEED_STATEMENTS.length + 1} statements`)
console.log(`  ${blocA.length + blocB.length} voters in two blocs, ${ops.length} signed ops`)
console.log(`  factional campaign: all ${blocA.length} of bloc A flagged one bloc B statement`)
console.log(`  corroborated: 6 of bloc A and 4 of bloc B flagged one abusive statement`)
console.log('')
console.log('  Next:  npm run aggregate && npm run analyse')
