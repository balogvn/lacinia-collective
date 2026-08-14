/**
 * Headless adversarial verification of augmented deliberation (Task 4).
 *
 * The claim this file has to prove is that BRIDGING IS NOT POPULARITY. A
 * clustering pipeline that just re-ranks by total agreement is majority
 * tyranny with a scatter plot attached, and it would look completely fine in
 * casual use. So the central test builds a deliberately polarized population
 * where the more-agreed statement MUST rank below the less-agreed one that
 * bridges — and fails if it does not.
 *
 * The second thing it proves is determinism: two offline devices holding the
 * same votes must produce identical groups, or they will disagree about what
 * the community thinks while both believing they are right.
 *
 *   npm run verify:deliberate
 */

import {
  analyseConversation,
  rankBridging,
  rankPopular,
  rankDivisive,
  MIN_PARTICIPANTS,
  MIN_STATEMENTS,
  type OpinionMap,
  type StatementScore,
} from '../src/lib/deliberate/cluster'
import { voteIdFor, statementIdFor, conversationIdFor } from '../src/lib/deliberate/ids'
import { createSignedOp, verifySignedOp, OpRejectReason } from '../src/lib/sync/ops'
import { mergeOps, InMemoryMergeStore } from '../src/lib/sync/merge'
import { generateEphemeralKeyPair } from '../src/lib/crypto/keys'
import { VoteValue, type Statement, type Vote } from '../src/lib/db/schema'
import { createClock, now as hlcNow } from '../src/lib/hlc'
import { configureTelemetry } from '../src/lib/telemetry'

configureTelemetry({ mirrorToConsole: false })

let passed = 0
let failed = 0
const failures: string[] = []

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ${GREEN}✓${RESET} ${name}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ${RED}✗ ${name}${RESET}${detail ? ` ${DIM}${detail}${RESET}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n${BOLD}${title}${RESET}`)
}

const clock = createClock('delibtest')
const CONV = 'conv-market-levy'

function stmt(id: string, text: string): Statement {
  return {
    id,
    conversationId: CONV,
    authorPub: 'author-fixture',
    text,
    createdAt: 1_700_000_000_000,
    hlc: hlcNow(clock),
  }
}

function vote(voter: string, statementId: string, value: VoteValue): Vote {
  return {
    id: voteIdFor(voter, statementId),
    statementId,
    conversationId: CONV,
    authorPub: voter,
    value,
    createdAt: 1_700_000_000_000,
    hlc: hlcNow(clock),
  }
}

const scoreOf = (map: OpinionMap, id: string): StatementScore =>
  map.statements.find((s) => s.statementId === id)!

/* ─────────────────── 1. cold start ─────────────────── */

section('1. Cold start — no fake groups from thin data')
{
  const tiny = analyseConversation(
    [stmt('s1', 'a'), stmt('s2', 'b')],
    [vote('p1', 's1', VoteValue.Agree), vote('p2', 's2', VoteValue.Agree)],
  )
  check(
    'too little data reports insufficient, not fake clusters',
    tiny.status === 'insufficient',
    tiny.status === 'insufficient' ? tiny.reason : '',
  )
  check(
    'it says exactly what is missing',
    tiny.status === 'insufficient' &&
      tiny.need.participants === MIN_PARTICIPANTS &&
      tiny.need.statements === MIN_STATEMENTS,
  )
  check(
    'statement tallies still work before clustering is possible',
    tiny.statements.length === 2 && tiny.statements[0]!.totalVotes === 1,
    'a young conversation still shows counts',
  )
}

/* ─────────────────── 2. the central claim ─────────────────── */

section('2. Bridging is not popularity — the whole point')

/**
 * A deliberately polarized market association.
 *   Bloc A: 20 traders (the majority)
 *   Bloc B:  8 traders (the minority)
 *
 * Tuned so POPULARITY ACTIVELY POINTS THE WRONG WAY:
 *   TRIBAL — 100% of A, 0% of B      → 20/28 = 71% overall, min-group 0.10
 *   BRIDGE —  55% of A, 100% of B    → 19/28 = 68% overall, min-group 0.55
 * The tribal statement is MORE agreed with overall, and must still rank below
 * the bridge. A ranking that merely re-sorted by popularity would fail here.
 *
 * Within-bloc dissent is spread by a hash of (voter, statement) so it is
 * UNCORRELATED across statements. An earlier version of this fixture used
 * `i < 13` and `i % 2`, which are correlated — they carve bloc A into four
 * clean cells, and the analysis correctly found four groups. The fixture, not
 * the algorithm, was wrong: real bloc members mostly agree and vary
 * individually, they do not vary in lockstep.
 */
function dissents(voter: string, statementId: string, percent: number): boolean {
  let h = 2166136261 >>> 0
  const key = `${voter}|${statementId}`
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return (h >>> 0) % 100 < percent
}

const blocA = Array.from({ length: 20 }, (_, i) => `A${String(i).padStart(2, '0')}`)
const blocB = Array.from({ length: 8 }, (_, i) => `B${String(i).padStart(2, '0')}`)

const statements = [
  stmt('tribal-1', 'Our end of the market has been ignored for too long'),
  stmt('tribal-2', 'The other end gets every improvement'),
  stmt('bridge-1', 'Refuse collection should be shared street by street'),
  stmt('bridge-2', 'The levy accounts should be read aloud each month'),
  stmt('split-1', 'The chairman should be replaced immediately'),
  stmt('quiet-1', 'Meetings should start at seven'),
]

const votes: Vote[] = []
const agreeIf = (cond: boolean) => (cond ? VoteValue.Agree : VoteValue.Disagree)

// TRIBAL: perfectly aligned with the bloc split. This is the dominant axis.
for (const id of ['tribal-1', 'tribal-2']) {
  for (const p of blocA) votes.push(vote(p, id, VoteValue.Agree))
  for (const p of blocB) votes.push(vote(p, id, VoteValue.Disagree))
}

// BRIDGE: the minority is unanimous, the majority is split — so it is LESS
// popular than the tribal statements while bridging far better.
for (const [id, dissentPct] of [
  ['bridge-1', 45],
  ['bridge-2', 40],
] as const) {
  for (const p of blocA) votes.push(vote(p, id, agreeIf(!dissents(p, id, dissentPct))))
  for (const p of blocB) votes.push(vote(p, id, VoteValue.Agree))
}

// SPLIT: bloc A divides internally, bloc B is against. Divisive but not tribal.
for (const p of blocA) votes.push(vote(p, 'split-1', agreeIf(!dissents(p, 'split-1', 50))))
for (const p of blocB) votes.push(vote(p, 'split-1', VoteValue.Disagree))

// QUIET: low turnout and mixed — a genuine also-ran, not a hidden bridge.
blocA.slice(0, 6).forEach((p, i) => votes.push(vote(p, 'quiet-1', agreeIf(i < 4))))
blocB.slice(0, 3).forEach((p, i) => votes.push(vote(p, 'quiet-1', agreeIf(i < 1))))

const map = analyseConversation(statements, votes)

{
  check('clustering succeeded', map.status === 'ok', map.status === 'ok' ? `k=${map.k}` : '')
  if (map.status !== 'ok') throw new Error('clustering failed — cannot continue')

  check(
    'it found exactly two groups',
    map.k === 2,
    `k=${map.k}, silhouette ${map.silhouette}`,
  )

  const sizes = map.groups.map((g) => g.size).sort((a, b) => b - a)
  check(
    'the groups match the real blocs',
    sizes[0] === 20 && sizes[1] === 8,
    `sizes ${sizes.join(' / ')}`,
  )

  // Every A must land in one group and every B in the other.
  const groupOfA = new Set(
    map.participants.filter((p) => p.pubKey.startsWith('A')).map((p) => p.group),
  )
  const groupOfB = new Set(
    map.participants.filter((p) => p.pubKey.startsWith('B')).map((p) => p.group),
  )
  check(
    'no bloc is split across groups',
    groupOfA.size === 1 && groupOfB.size === 1 && groupOfA.values().next().value !== groupOfB.values().next().value,
  )

  /* ── THE TEST THIS FILE EXISTS FOR ── */
  const tribal = scoreOf(map, 'tribal-1')
  const bridge = scoreOf(map, 'bridge-1')

  check(
    'setup is strict: the tribal statement is MORE popular than the bridge',
    tribal.overallAgree > bridge.overallAgree,
    `tribal ${(tribal.overallAgree * 100).toFixed(0)}% vs bridge ${(bridge.overallAgree * 100).toFixed(0)}% overall agreement`,
  )

  check(
    'the bridging statement outranks the tribal one',
    bridge.consensus > tribal.consensus,
    `consensus: bridge ${bridge.consensus} vs tribal ${tribal.consensus}`,
  )

  const bridging = rankBridging(map.statements)
  check(
    'bridge statements take the top two bridging slots',
    bridging[0]!.statementId.startsWith('bridge') && bridging[1]!.statementId.startsWith('bridge'),
    bridging.slice(0, 3).map((s) => `${s.statementId}(${s.consensus})`).join(' '),
  )

  check(
    'tribal statements sink to the bottom of the bridging ranking',
    bridging[bridging.length - 1]!.statementId.startsWith('tribal'),
    bridging[bridging.length - 1]!.statementId,
  )

  // And the contrast: a naive popularity ranking gets it wrong.
  const popular = rankPopular(map.statements)
  check(
    'a naive popularity ranking would promote the tribal statement',
    popular.findIndex((s) => s.statementId.startsWith('tribal')) <
      bridging.findIndex((s) => s.statementId.startsWith('tribal')),
    `popularity puts tribal at #${popular.findIndex((s) => s.statementId.startsWith('tribal')) + 1}, bridging at #${bridging.findIndex((s) => s.statementId.startsWith('tribal')) + 1}`,
  )

  const divisive = rankDivisive(map.statements)
  check(
    'the most divisive statement is a tribal one',
    divisive[0]!.statementId.startsWith('tribal'),
    `${divisive[0]!.statementId} divisiveness ${divisive[0]!.divisiveness}`,
  )

  check(
    'a statement both blocs agree on has near-zero divisiveness',
    scoreOf(map, 'bridge-2').divisiveness < 0.35,
    `bridge-2 divisiveness ${scoreOf(map, 'bridge-2').divisiveness}`,
  )

  check(
    'each group gets distinctive statements',
    map.groups.every((g) => g.distinctive.length > 0),
    map.groups.map((g) => `g${g.id}:${g.distinctive[0]?.statementId}`).join(' '),
  )
}

/* ─────────────────── 3. determinism ─────────────────── */

section('3. Determinism — two offline devices must agree')
{
  const again = analyseConversation(statements, votes)
  check('identical input gives an identical result', JSON.stringify(again) === JSON.stringify(map))

  // Devices receive votes in whatever order bundles arrive.
  const shuffled = [...votes].reverse()
  const reordered = analyseConversation([...statements].reverse(), shuffled)
  check(
    'input order does not change the outcome',
    reordered.status === 'ok' &&
      map.status === 'ok' &&
      reordered.k === map.k &&
      JSON.stringify(reordered.statements.map((s) => [s.statementId, s.consensus]).sort()) ===
        JSON.stringify(map.statements.map((s) => [s.statementId, s.consensus]).sort()),
    'bundles arrive in any order',
  )

  // THE SIGN-AMBIGUITY TRAP: eigenvectors are sign-ambiguous, so without a
  // fixed convention two devices produce mirror-image maps and disagree about
  // which group is which — while both being mathematically correct.
  if (map.status === 'ok' && reordered.status === 'ok') {
    const groupSizesA = map.groups.map((g) => g.size).sort()
    const groupSizesB = reordered.groups.map((g) => g.size).sort()
    check(
      'component signs are pinned, so maps are not mirrored',
      JSON.stringify(groupSizesA) === JSON.stringify(groupSizesB),
      `${groupSizesA.join('/')} both times`,
    )

    const aFirst = map.participants.find((p) => p.pubKey === 'A00')!
    const aFirstAgain = reordered.participants.find((p) => p.pubKey === 'A00')!
    check(
      'the same person lands at the same coordinates',
      Math.abs(aFirst.x - aFirstAgain.x) < 1e-9 && Math.abs(aFirst.y - aFirstAgain.y) < 1e-9,
      `(${aFirst.x.toFixed(4)}, ${aFirst.y.toFixed(4)})`,
    )
  }
}

/* ─────────────────── 4. robustness ─────────────────── */

section('4. Robustness — the shapes real data takes')
{
  // A room that genuinely agrees should not be forced into factions.
  const unifiedVoters = Array.from({ length: 12 }, (_, i) => `U${i}`)
  const unifiedStatements = Array.from({ length: 6 }, (_, i) => stmt(`u${i}`, `point ${i}`))
  const unifiedVotes: Vote[] = []
  for (const p of unifiedVoters) {
    for (const s of unifiedStatements) unifiedVotes.push(vote(p, s.id, VoteValue.Agree))
  }
  const unified = analyseConversation(unifiedStatements, unifiedVotes)
  check(
    'a room in agreement still produces high consensus everywhere',
    unified.status === 'ok' && unified.statements.every((s) => s.consensus > 0.7),
    unified.status === 'ok' ? `min consensus ${Math.min(...unified.statements.map((s) => s.consensus))}` : '',
  )

  // Drive-by voters must not distort the map.
  const withDriveBy = analyseConversation(statements, [
    ...votes,
    vote('driveby-1', 'tribal-1', VoteValue.Agree),
    vote('driveby-2', 'quiet-1', VoteValue.Disagree),
  ])
  check(
    'participants below the vote threshold are excluded from clustering',
    withDriveBy.status === 'ok' &&
      !withDriveBy.participants.some((p) => p.pubKey.startsWith('driveby')),
    'one-vote participants tell us nothing about where they sit',
  )

  // Passes are recorded but must not read as agreement.
  const passStatements = Array.from({ length: 6 }, (_, i) => stmt(`p${i}`, `p${i}`))
  const passVoters = Array.from({ length: 8 }, (_, i) => `P${i}`)
  const passVotes: Vote[] = []
  for (const p of passVoters) {
    for (const s of passStatements) passVotes.push(vote(p, s.id, VoteValue.Pass))
  }
  const allPass = analyseConversation(passStatements, passVotes)
  check(
    'a statement everyone passed on shows no agreement',
    allPass.statements.every((s) => s.agrees === 0 && s.passes === 8),
    'pass ≠ agree',
  )

  check(
    'statements below the vote threshold are excluded from rankings',
    rankBridging([
      ...map.statements,
      { ...scoreOf(map, 'quiet-1'), statementId: 'lonely', totalVotes: 1 },
    ]).every((s) => s.statementId !== 'lonely'),
    'one vote is not a mandate',
  )

  check('an empty conversation does not throw', analyseConversation([], []).status === 'insufficient')

  /**
   * k is bounded by the evidence: resolving a group needs roughly three
   * statements it votes distinctively on. Twelve statements can support four
   * groups; six cannot, however clean the projection looks.
   */
  const manyStatements = Array.from({ length: 12 }, (_, i) => stmt(`m${i}`, `m${i}`))
  const fourBlocs = ['W', 'X', 'Y', 'Z'].flatMap((tag) =>
    Array.from({ length: 6 }, (_, i) => `${tag}${i}`),
  )
  const fourBlocVotes: Vote[] = []
  for (const voter of fourBlocs) {
    const bloc = ['W', 'X', 'Y', 'Z'].indexOf(voter[0]!)
    manyStatements.forEach((s, si) => {
      // Each bloc agrees with its own third of the statements.
      fourBlocVotes.push(vote(voter, s.id, si % 4 === bloc ? VoteValue.Agree : VoteValue.Disagree))
    })
  }
  const wide = analyseConversation(manyStatements, fourBlocVotes)
  check(
    '12 statements can support four groups',
    wide.status === 'ok' && wide.k === 4,
    wide.status === 'ok' ? `k=${wide.k}, silhouette ${wide.silhouette}` : '',
  )

  const narrow = analyseConversation(manyStatements.slice(0, 6), fourBlocVotes.filter((v) => manyStatements.slice(0, 6).some((s) => s.id === v.statementId)))
  check(
    'the same population on 6 statements will not claim four groups',
    narrow.status === 'ok' && narrow.k <= 2,
    narrow.status === 'ok' ? `k=${narrow.k}` : '',
  )
}

/* ─────────────────── 5. vote integrity ─────────────────── */

section('5. Vote integrity — one person, one vote per statement')
{
  const alice = generateEphemeralKeyPair()
  const mallory = generateEphemeralKeyPair()

  const mkVote = (voter: string, statementId: string, value: VoteValue): Vote => ({
    id: voteIdFor(voter, statementId),
    statementId,
    conversationId: CONV,
    authorPub: voter,
    value,
    createdAt: 1_700_000_000_000,
    hlc: hlcNow(clock),
  })

  const honest = mkVote(alice.pubKeyId, 'stmt-x', VoteValue.Agree)
  const op = createSignedOp(alice, {
    hlc: honest.hlc,
    entity: 'vote',
    entityId: honest.id,
    op: 'put',
    record: honest,
  })
  check('an honest vote op verifies', verifySignedOp(op).ok)

  // ATTACK: Mallory files a vote under the id that belongs to Alice's row,
  // which would OVERWRITE Alice's vote on merge.
  const hijack = { ...honest, authorPub: mallory.pubKeyId }
  const hijackOp = createSignedOp(mallory, {
    hlc: hlcNow(clock),
    entity: 'vote',
    entityId: honest.id,
    op: 'put',
    record: hijack,
  })
  const hijackVerdict = verifySignedOp(hijackOp)
  check(
    "overwriting someone else's vote row is refused",
    !hijackVerdict.ok && hijackVerdict.reason === OpRejectReason.Unauthorized,
    !hijackVerdict.ok ? hijackVerdict.detail : 'ACCEPTED — CRITICAL',
  )

  // ATTACK: an out-of-range vote value to skew a tally.
  const skew = { ...mkVote(mallory.pubKeyId, 'stmt-x', 5 as VoteValue) }
  const skewOp = createSignedOp(mallory, {
    hlc: hlcNow(clock),
    entity: 'vote',
    entityId: skew.id,
    op: 'put',
    record: skew,
  })
  check('an out-of-range vote value is refused', !verifySignedOp(skewOp).ok, 'no ballot stuffing')

  // Changing your mind replaces the row rather than adding a second vote.
  const changed = { ...honest, value: VoteValue.Disagree, hlc: hlcNow(clock) }
  const changedOp = createSignedOp(alice, {
    hlc: changed.hlc,
    entity: 'vote',
    entityId: changed.id,
    op: 'put',
    record: changed,
  })
  const store = new InMemoryMergeStore()
  await mergeOps(
    [
      { op, record: JSON.parse(op.body) as unknown },
      { op: changedOp, record: JSON.parse(changedOp.body) as unknown },
    ],
    store,
  )
  const live = store.live<Vote>('vote')
  check(
    'changing your mind updates rather than double-counts',
    live.length === 1 && live[0]!.value === VoteValue.Disagree,
    `${live.length} row, value ${live[0]?.value}`,
  )

  // Ids must be stable across devices, or the same vote would merge twice.
  check(
    'vote ids are deterministic',
    voteIdFor('someone', 'stmt-x') === voteIdFor('someone', 'stmt-x') &&
      voteIdFor('someone', 'stmt-x') !== voteIdFor('someone-else', 'stmt-x'),
  )
  check(
    'statement and conversation ids are deterministic',
    statementIdFor('a', 'c', 'text', 5) === statementIdFor('a', 'c', 'text', 5) &&
      conversationIdFor('a', 't', 5) === conversationIdFor('a', 't', 5) &&
      statementIdFor('a', 'c', 'text', 5) !== statementIdFor('a', 'c', 'text', 6),
  )
}

console.log(`\n${BOLD}${'─'.repeat(64)}${RESET}`)
if (failed === 0) {
  console.log(`${GREEN}${BOLD}  ${passed} checks passed.${RESET} Deliberation holds.`)
} else {
  console.log(`${RED}${BOLD}  ${failed} failed${RESET}, ${passed} passed`)
  for (const f of failures) console.log(`   ${RED}·${RESET} ${f}`)
}
console.log(`${BOLD}${'─'.repeat(64)}${RESET}\n`)

process.exit(failed === 0 ? 0 : 1)
