/**
 * OPINION CLUSTERING AND BRIDGE-FINDING.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 *
 * Ranking statements by total agreement is majority tyranny with extra steps:
 * the largest bloc's positions float to the top, the minority reads the result,
 * concludes the tool is not for them, and leaves. That is the failure mode this
 * whole file exists to avoid.
 *
 * Instead: place people in an opinion space from their voting patterns, find
 * the groups that actually exist, and then surface the statements that earn
 * agreement ACROSS those groups. A statement agreed by 90% of a 70% majority
 * and 10% of everyone else is *popular* and scores terribly here. A statement
 * agreed by 65% of every group is less popular and ranks far above it.
 *
 * THE PIPELINE
 *   1. Build a participant × statement matrix from votes (−1 / 0 / +1).
 *   2. Impute missing entries with the statement mean, then centre.
 *   3. Extract 2 principal components by power iteration (NIPALS).
 *   4. k-means in that 2D space, k chosen by silhouette.
 *   5. Per-group agree rates, then consensus = min over groups.
 *
 * DETERMINISM IS A CORRECTNESS REQUIREMENT HERE, NOT A NICETY.
 * Two offline devices holding the same votes must produce the same groups, or
 * they will disagree about what the community thinks while both believing they
 * are right. Three specific traps, each handled below:
 *   · eigenvector SIGN AMBIGUITY (mirror-image maps — see fixSign)
 *   · k-means initialisation (seeded PRNG derived from the data, never
 *     Math.random, which is also unavailable in workflow scripts)
 *   · floating-point accumulation order (every key sorted before iteration)
 * ───────────────────────────────────────────────────────────────────────────
 */

import { VoteValue, type PubKeyId, type Statement, type Vote } from '../db/schema'
import { log } from '../telemetry'

/* ─────────────────────────── thresholds ─────────────────────────── */

/** Below these, clusters are noise wearing the costume of insight. */
export const MIN_PARTICIPANTS = 5
export const MIN_STATEMENTS = 5
/** A participant who voted twice tells us nothing about where they sit. */
export const MIN_VOTES_PER_PARTICIPANT = 3
/** A statement with two votes cannot have a meaningful per-group rate. */
export const MIN_VOTES_PER_STATEMENT = 3

const POWER_ITERATIONS = 64
const KMEANS_ITERATIONS = 50
const K_CANDIDATES = [2, 3, 4] as const
/** Laplace smoothing, so a single agreeing vote is not "100% agreement". */
const SMOOTHING = 1

/**
 * A group smaller than this cannot produce a meaningful agree rate — three
 * people are an anecdote, and letting one set the consensus floor means one
 * person's opinion silently vetoes every bridging statement.
 */
const MIN_GROUP_SIZE = 3

/**
 * Votes a group must have cast on a statement before its rate counts towards
 * consensus.
 *
 * Without this, a group that simply has not seen a statement contributes its
 * Laplace prior of 0.5 and drags the floor down — indistinguishable from a
 * group that saw it and split evenly. "We have no evidence" and "they are
 * divided" are completely different findings and must not share a number.
 */
const MIN_GROUP_VOTES = 2

/**
 * Silhouette below this means there is no real group structure — the room is
 * one population, not several. Reporting k=2 anyway invents a division and then
 * asks people to see themselves in it.
 */
const SINGLE_GROUP_SILHOUETTE = 0.25

/**
 * A larger k must beat the best smaller k by this much to be preferred.
 *
 * Silhouette rises easily when you cut a continuous cloud into finer pieces,
 * especially with few statements. Without a parsimony margin the analysis
 * confidently splits one bloc into three sub-factions that nobody in the room
 * would recognise.
 */
const K_PARSIMONY_MARGIN = 0.12

/**
 * Statements needed per group before that many groups can be claimed.
 *
 * A group is only distinguishable by the statements it votes differently on, so
 * resolving k groups needs roughly 3k statements. Without this bound, a
 * 7-statement conversation cheerfully reports four factions with a high
 * silhouette — the clusters are well separated in the projection, and they are
 * still an artefact of having two noisy axes and twenty-one people.
 *
 * Bounding k by the evidence is the difference between "we found four groups"
 * and "we found four groups' worth of noise".
 */
const STATEMENTS_PER_GROUP = 3

/* ─────────────────────────── types ─────────────────────────── */

export interface ParticipantPoint {
  pubKey: PubKeyId
  x: number
  y: number
  group: number
  votesCast: number
}

export interface GroupSummary {
  id: number
  size: number
  centroid: { x: number; y: number }
  /** Statements this group agrees with far more than the others do. */
  distinctive: Array<{ statementId: string; agree: number; gap: number }>
}

export interface StatementScore {
  statementId: string
  agrees: number
  disagrees: number
  passes: number
  totalVotes: number
  /** Plain agree rate across everyone. Popularity, not bridging. */
  overallAgree: number
  byGroup: Array<{ group: number; agree: number; votes: number }>
  /** min over groups of the agree rate — THE bridging metric. */
  consensus: number
  /** max − min across groups. High means the statement splits the room. */
  divisiveness: number
}

export type OpinionMap =
  | {
      status: 'insufficient'
      reason: string
      need: { participants: number; statements: number }
      have: { participants: number; statements: number }
      statements: StatementScore[]
    }
  | {
      status: 'ok'
      participants: ParticipantPoint[]
      groups: GroupSummary[]
      statements: StatementScore[]
      k: number
      /** Fraction of variance captured by the two components, roughly. */
      strength: number
      silhouette: number
    }

/* ─────────────────────── deterministic PRNG ─────────────────────── */

/** FNV-1a over the sorted ids — the seed is a function of the data itself. */
function seedFrom(keys: readonly string[]): number {
  let h = 2166136261 >>> 0
  for (const key of keys) {
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i)
      h = Math.imul(h, 16777619) >>> 0
    }
    h = Math.imul(h ^ 0x2d, 16777619) >>> 0
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ─────────────────────── main entry point ─────────────────────── */

export function analyseConversation(
  statements: readonly Statement[],
  votes: readonly Vote[],
): OpinionMap {
  // Sorted for float-accumulation determinism, and so indices are stable
  // across devices regardless of IndexedDB iteration order.
  const liveStatements = statements.filter((s) => !s.deleted).sort((a, b) => (a.id < b.id ? -1 : 1))
  const liveVotes = votes.filter((v) => !v.deleted)

  const stmtIndex = new Map<string, number>()
  liveStatements.forEach((s, i) => stmtIndex.set(s.id, i))

  // Count votes per participant so we can exclude drive-by voters, whose
  // position is dominated by which two statements they happened to see.
  const perParticipant = new Map<PubKeyId, Vote[]>()
  for (const vote of liveVotes) {
    if (!stmtIndex.has(vote.statementId)) continue
    const bucket = perParticipant.get(vote.authorPub)
    if (bucket) bucket.push(vote)
    else perParticipant.set(vote.authorPub, [vote])
  }

  const participants = [...perParticipant.entries()]
    .filter(([, vs]) => vs.length >= MIN_VOTES_PER_PARTICIPANT)
    .map(([pubKey]) => pubKey)
    .sort()

  const S = liveStatements.length
  const P = participants.length

  // Statement-level tallies are computed even when clustering is impossible,
  // so a young conversation still shows counts rather than nothing at all.
  const flatScores = tallyStatements(liveStatements, liveVotes, null, [])

  if (P < MIN_PARTICIPANTS || S < MIN_STATEMENTS) {
    return {
      status: 'insufficient',
      reason:
        P < MIN_PARTICIPANTS
          ? `${MIN_PARTICIPANTS} people need to vote before groups can be found — ${P} so far.`
          : `${MIN_STATEMENTS} statements are needed before groups can be found — ${S} so far.`,
      need: { participants: MIN_PARTICIPANTS, statements: MIN_STATEMENTS },
      have: { participants: P, statements: S },
      statements: flatScores,
    }
  }

  const partIndex = new Map<PubKeyId, number>()
  participants.forEach((p, i) => partIndex.set(p, i))

  /* ── 1. build the matrix, tracking what was actually observed ── */
  const matrix = new Float64Array(P * S)
  const observed = new Uint8Array(P * S)

  for (const vote of liveVotes) {
    const p = partIndex.get(vote.authorPub)
    const s = stmtIndex.get(vote.statementId)
    if (p === undefined || s === undefined) continue
    matrix[p * S + s] = vote.value
    observed[p * S + s] = 1
  }

  /* ── 2. impute missing with the statement mean, then centre ──
     Mean imputation says "assume an unseen statement lands where the room
     landed", which biases towards the centre. That is the conservative
     direction: it makes light voters look moderate rather than inventing a
     strong opinion they never expressed. */
  for (let s = 0; s < S; s++) {
    let sum = 0
    let count = 0
    for (let p = 0; p < P; p++) {
      if (observed[p * S + s]) {
        sum += matrix[p * S + s]!
        count++
      }
    }
    const mean = count > 0 ? sum / count : 0
    for (let p = 0; p < P; p++) {
      const idx = p * S + s
      matrix[idx] = (observed[idx] ? matrix[idx]! : mean) - mean
    }
  }

  /* ── 3. two components by power iteration ── */
  const rng = mulberry32(seedFrom(liveStatements.map((s) => s.id)))
  const comp1 = powerIteration(matrix, P, S, rng)
  deflate(matrix, P, S, comp1)
  const comp2 = powerIteration(matrix, P, S, rng)

  const totalEnergy = comp1.sigma + comp2.sigma
  const strength = totalEnergy > 0 ? comp1.sigma / totalEnergy : 0

  const coords: Array<[number, number]> = participants.map((_, i) => [
    comp1.u[i]! * comp1.sigma,
    comp2.u[i]! * comp2.sigma,
  ])

  /* ── 4. k-means, k chosen by silhouette with a parsimony bias ──
     Candidates that produce a group below MIN_GROUP_SIZE are rejected outright:
     an empty or two-person cluster contributes a meaningless agree rate that
     then sets the consensus floor for every statement in the conversation. */
  let best: { k: number; labels: number[]; centroids: Array<[number, number]>; score: number } | null =
    null

  // Never claim more groups than the number of statements can resolve.
  const maxK = Math.max(2, Math.min(4, Math.floor(S / STATEMENTS_PER_GROUP)))

  for (const k of K_CANDIDATES) {
    if (k >= P || k > maxK) continue
    const result = kmeans(coords, k, mulberry32(seedFrom([...liveStatements.map((s) => s.id), `k${k}`])))

    const sizes = new Array<number>(k).fill(0)
    for (const label of result.labels) sizes[label]! += 1
    if (sizes.some((size) => size < MIN_GROUP_SIZE)) continue

    const score = silhouette(coords, result.labels, k)
    // A bigger k must clear the margin. Ties and near-ties go to the smaller k,
    // which is both more robust and easier for a person to recognise.
    if (!best || score > best.score + K_PARSIMONY_MARGIN) best = { k, ...result, score }
  }

  // No structure worth naming — report one group rather than inventing a
  // division. "Everyone here broadly agrees" is a real and useful finding.
  if (!best || best.score < SINGLE_GROUP_SILHOUETTE) {
    const singleScores = tallyStatements(liveStatements, liveVotes, null, [])
    const points: ParticipantPoint[] = participants.map((pubKey, i) => ({
      pubKey,
      x: +coords[i]![0].toFixed(6),
      y: +coords[i]![1].toFixed(6),
      group: 0,
      votesCast: perParticipant.get(pubKey)?.length ?? 0,
    }))
    log.info('trust', 'opinion map: single group, no separation found', {
      participants: P,
      silhouette: best ? +best.score.toFixed(3) : 0,
    })
    return {
      status: 'ok',
      participants: points,
      groups: [
        {
          id: 0,
          size: P,
          centroid: { x: 0, y: 0 },
          distinctive: [],
        },
      ],
      statements: singleScores,
      k: 1,
      strength: +strength.toFixed(4),
      silhouette: best ? +best.score.toFixed(4) : 0,
    }
  }

  const points: ParticipantPoint[] = participants.map((pubKey, i) => ({
    pubKey,
    x: +coords[i]![0].toFixed(6),
    y: +coords[i]![1].toFixed(6),
    group: best!.labels[i]!,
    votesCast: perParticipant.get(pubKey)?.length ?? 0,
  }))

  /* ── 5. per-group agree rates and bridging ── */
  const scores = tallyStatements(liveStatements, liveVotes, points, [...Array(best.k).keys()])

  const groups: GroupSummary[] = [...Array(best.k).keys()].map((id) => {
    const members = points.filter((p) => p.group === id)
    return {
      id,
      size: members.length,
      centroid: {
        x: +best!.centroids[id]![0].toFixed(6),
        y: +best!.centroids[id]![1].toFixed(6),
      },
      distinctive: distinctiveFor(id, scores).slice(0, 3),
    }
  })

  log.info('trust', 'opinion map computed', {
    participants: P,
    statements: S,
    k: best.k,
    silhouette: +best.score.toFixed(3),
  })

  return {
    status: 'ok',
    participants: points,
    groups,
    statements: scores,
    k: best.k,
    strength: +strength.toFixed(4),
    silhouette: +best.score.toFixed(4),
  }
}

/* ─────────────────────── linear algebra ─────────────────────── */

interface Component {
  u: Float64Array
  s: Float64Array
  sigma: number
}

/**
 * One principal component by power iteration (NIPALS) directly on the matrix.
 *
 * Chosen over building an S×S covariance matrix because that is O(S²) memory —
 * 200 statements would be a 320KB allocation on a phone, and 1,000 would be
 * 8MB. This is O(P·S) per iteration with no extra allocation.
 */
function powerIteration(m: Float64Array, P: number, S: number, rng: () => number): Component {
  const s = new Float64Array(S)
  for (let i = 0; i < S; i++) s[i] = rng() * 2 - 1
  normalise(s)

  const u = new Float64Array(P)
  let sigma = 0

  for (let iter = 0; iter < POWER_ITERATIONS; iter++) {
    // u = M · s
    for (let p = 0; p < P; p++) {
      let acc = 0
      const row = p * S
      for (let j = 0; j < S; j++) acc += m[row + j]! * s[j]!
      u[p] = acc
    }
    if (normalise(u) === 0) break

    // s = Mᵀ · u
    for (let j = 0; j < S; j++) {
      let acc = 0
      for (let p = 0; p < P; p++) acc += m[p * S + j]! * u[p]!
      s[j] = acc
    }
    sigma = normalise(s)
    if (sigma === 0) break
  }

  fixSign(u, s)
  return { u, s, sigma }
}

/**
 * Resolve the eigenvector sign ambiguity deterministically.
 *
 * (u, s) and (−u, −s) describe the identical component — the maths cannot tell
 * them apart. Left alone, two devices with identical votes can produce
 * mirror-image opinion maps, put the same person on opposite sides, and both be
 * "correct". Every downstream group id would then disagree across the network.
 *
 * Convention: the loading with the largest magnitude is positive. Stable
 * because that entry is, by construction, the furthest from zero.
 */
function fixSign(u: Float64Array, s: Float64Array): void {
  let maxIdx = 0
  let maxAbs = -1
  for (let i = 0; i < s.length; i++) {
    const abs = Math.abs(s[i]!)
    // Strict > keeps the FIRST maximum on an exact tie, which is deterministic.
    if (abs > maxAbs) {
      maxAbs = abs
      maxIdx = i
    }
  }
  if (s[maxIdx]! < 0) {
    for (let i = 0; i < s.length; i++) s[i] = -s[i]!
    for (let i = 0; i < u.length; i++) u[i] = -u[i]!
  }
}

function normalise(v: Float64Array): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i]! * v[i]!
  const norm = Math.sqrt(sum)
  if (norm === 0) return 0
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm
  return norm
}

function deflate(m: Float64Array, P: number, S: number, c: Component): void {
  for (let p = 0; p < P; p++) {
    const scale = c.sigma * c.u[p]!
    const row = p * S
    for (let j = 0; j < S; j++) m[row + j] = m[row + j]! - scale * c.s[j]!
  }
}

/* ─────────────────────── clustering ─────────────────────── */

function distance2(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  return dx * dx + dy * dy
}

function kmeans(
  points: Array<[number, number]>,
  k: number,
  rng: () => number,
): { labels: number[]; centroids: Array<[number, number]> } {
  // k-means++ seeding, driven by the seeded PRNG so the result is reproducible.
  const centroids: Array<[number, number]> = [points[Math.floor(rng() * points.length)]!]

  while (centroids.length < k) {
    const d2 = points.map((p) => Math.min(...centroids.map((c) => distance2(p, c))))
    const total = d2.reduce((a, b) => a + b, 0)
    if (total === 0) {
      centroids.push(points[centroids.length % points.length]!)
      continue
    }
    let target = rng() * total
    let chosen = points.length - 1
    for (let i = 0; i < points.length; i++) {
      target -= d2[i]!
      if (target <= 0) {
        chosen = i
        break
      }
    }
    centroids.push(points[chosen]!)
  }

  const labels = new Array<number>(points.length).fill(0)

  for (let iter = 0; iter < KMEANS_ITERATIONS; iter++) {
    let moved = false
    for (let i = 0; i < points.length; i++) {
      let bestK = 0
      let bestD = Infinity
      for (let c = 0; c < k; c++) {
        const d = distance2(points[i]!, centroids[c]!)
        // Strict < breaks ties towards the lower cluster index — deterministic.
        if (d < bestD) {
          bestD = d
          bestK = c
        }
      }
      if (labels[i] !== bestK) {
        labels[i] = bestK
        moved = true
      }
    }

    for (let c = 0; c < k; c++) {
      let sx = 0
      let sy = 0
      let n = 0
      for (let i = 0; i < points.length; i++) {
        if (labels[i] === c) {
          sx += points[i]![0]
          sy += points[i]![1]
          n++
        }
      }
      if (n > 0) centroids[c] = [sx / n, sy / n]
    }

    if (!moved) break
  }

  return { labels, centroids }
}

/**
 * Mean silhouette — how well-separated the clusters are, in [−1, 1].
 *
 * This is what picks k. Without it k is an arbitrary constant, and the map
 * would confidently draw three groups into a room that only has two.
 */
function silhouette(points: Array<[number, number]>, labels: number[], k: number): number {
  if (points.length <= k) return -1

  let total = 0
  for (let i = 0; i < points.length; i++) {
    const own = labels[i]!
    const meanTo = (cluster: number): number => {
      let sum = 0
      let n = 0
      for (let j = 0; j < points.length; j++) {
        if (j === i || labels[j] !== cluster) continue
        sum += Math.sqrt(distance2(points[i]!, points[j]!))
        n++
      }
      return n === 0 ? 0 : sum / n
    }

    const a = meanTo(own)
    let b = Infinity
    for (let c = 0; c < k; c++) {
      if (c === own) continue
      const size = labels.filter((l) => l === c).length
      if (size === 0) continue
      b = Math.min(b, meanTo(c))
    }

    if (!Number.isFinite(b)) continue
    const denom = Math.max(a, b)
    total += denom === 0 ? 0 : (b - a) / denom
  }

  return total / points.length
}

/* ─────────────────────── bridging scores ─────────────────────── */

function tallyStatements(
  statements: readonly Statement[],
  votes: readonly Vote[],
  points: ParticipantPoint[] | null,
  groupIds: number[],
): StatementScore[] {
  const groupOf = new Map<PubKeyId, number>()
  if (points) for (const p of points) groupOf.set(p.pubKey, p.group)

  const byStatement = new Map<string, Vote[]>()
  for (const vote of votes) {
    if (vote.deleted) continue
    const bucket = byStatement.get(vote.statementId)
    if (bucket) bucket.push(vote)
    else byStatement.set(vote.statementId, [vote])
  }

  return statements
    .filter((s) => !s.deleted)
    .map((statement) => {
      const cast = byStatement.get(statement.id) ?? []
      let agrees = 0
      let disagrees = 0
      let passes = 0
      for (const v of cast) {
        if (v.value === VoteValue.Agree) agrees++
        else if (v.value === VoteValue.Disagree) disagrees++
        else passes++
      }

      const decided = agrees + disagrees
      const overallAgree = decided === 0 ? 0 : agrees / decided

      const byGroup = groupIds.map((group) => {
        let a = 0
        let d = 0
        for (const v of cast) {
          if (groupOf.get(v.authorPub) !== group) continue
          if (v.value === VoteValue.Agree) a++
          else if (v.value === VoteValue.Disagree) d++
        }
        // Laplace smoothing: without it a single agreeing vote reads as 100%
        // agreement and a two-person group can dominate the ranking.
        return {
          group,
          agree: (a + SMOOTHING) / (a + d + 2 * SMOOTHING),
          votes: a + d,
        }
      })

      // EVIDENCE GATE. Only groups that actually voted on this statement may
      // set its floor. A group that has not seen it would otherwise contribute
      // the Laplace prior of 0.5 — numerically identical to "they saw it and
      // split evenly", which is a completely different finding. Left ungated,
      // an unseen statement looks divisive and every bridging score collapses
      // towards 0.5.
      const evidenced = byGroup.filter((g) => g.votes >= MIN_GROUP_VOTES).map((g) => g.agree)
      const consensus = evidenced.length > 0 ? Math.min(...evidenced) : overallAgree
      const divisiveness =
        evidenced.length > 1 ? Math.max(...evidenced) - Math.min(...evidenced) : 0

      return {
        statementId: statement.id,
        agrees,
        disagrees,
        passes,
        totalVotes: cast.length,
        overallAgree: +overallAgree.toFixed(4),
        byGroup: byGroup.map((g) => ({ ...g, agree: +g.agree.toFixed(4) })),
        consensus: +consensus.toFixed(4),
        divisiveness: +divisiveness.toFixed(4),
      }
    })
}

function distinctiveFor(
  group: number,
  scores: StatementScore[],
): Array<{ statementId: string; agree: number; gap: number }> {
  return scores
    .filter((s) => s.totalVotes >= MIN_VOTES_PER_STATEMENT)
    .map((s) => {
      const own = s.byGroup.find((g) => g.group === group)
      const others = s.byGroup.filter((g) => g.group !== group)
      if (!own || others.length === 0) return null
      const otherMean = others.reduce((acc, g) => acc + g.agree, 0) / others.length
      return { statementId: s.statementId, agree: own.agree, gap: +(own.agree - otherMean).toFixed(4) }
    })
    .filter((x): x is { statementId: string; agree: number; gap: number } => x !== null)
    .sort((a, b) => b.gap - a.gap)
}

/* ─────────────────────── ranking helpers ─────────────────────── */

/**
 * Statements that bridge — ranked by the WORST group's agreement, not the
 * average and not the total. One dissenting group is enough to sink a
 * statement, which is exactly the property that separates this from
 * popularity.
 */
export function rankBridging(scores: readonly StatementScore[]): StatementScore[] {
  return scores
    .filter((s) => s.totalVotes >= MIN_VOTES_PER_STATEMENT)
    .slice()
    .sort((a, b) => b.consensus - a.consensus || (a.statementId < b.statementId ? -1 : 1))
}

/** Statements that split the room. Shown as "where we differ", never hidden. */
export function rankDivisive(scores: readonly StatementScore[]): StatementScore[] {
  return scores
    .filter((s) => s.totalVotes >= MIN_VOTES_PER_STATEMENT)
    .slice()
    .sort((a, b) => b.divisiveness - a.divisiveness || (a.statementId < b.statementId ? -1 : 1))
}

/** Plain popularity — computed only so the UI can show how it differs. */
export function rankPopular(scores: readonly StatementScore[]): StatementScore[] {
  return scores
    .filter((s) => s.totalVotes >= MIN_VOTES_PER_STATEMENT)
    .slice()
    .sort((a, b) => b.overallAgree - a.overallAgree || (a.statementId < b.statementId ? -1 : 1))
}
