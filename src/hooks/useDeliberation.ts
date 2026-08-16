'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  listConversations,
  listStatements,
  listVotes,
  saveConversation,
  saveStatement,
  castVote,
} from '@/lib/db/repo'
import { analyseConversation, type OpinionMap } from '@/lib/deliberate/cluster'
import { conversationIdFor, statementIdFor } from '@/lib/deliberate/ids'
import {
  VoteValue,
  type Conversation,
  type Statement,
  type Vote,
  type PubKeyId,
  type Locality,
} from '@/lib/db/schema'
import { log } from '@/lib/telemetry'

export interface DeliberationState {
  ready: boolean
  conversations: Conversation[]
  statements: Statement[]
  votes: Vote[]
  myVotes: Map<string, VoteValue>
  map: OpinionMap | null
  error: string | null
}

/**
 * Deliberation view for one conversation.
 *
 * The opinion map is recomputed locally on every change rather than fetched.
 * That is the point of a deterministic algorithm: the analysis works with the
 * network off, and when a device does sync it converges on the same answer as
 * everyone else rather than trusting a server's verdict about what the
 * community thinks.
 */
export function useDeliberation(conversationId: string | null, selfPub: PubKeyId | null) {
  const [state, setState] = useState<DeliberationState>({
    ready: false,
    conversations: [],
    statements: [],
    votes: [],
    myVotes: new Map(),
    map: null,
    error: null,
  })

  const refresh = useCallback(async () => {
    try {
      const conversations = await listConversations()
      const active = conversationId ?? conversations[0]?.id ?? null

      const [statements, votes] = active
        ? await Promise.all([listStatements(active), listVotes(active)])
        : [[], []]

      const myVotes = new Map<string, VoteValue>()
      if (selfPub) {
        for (const vote of votes) {
          if (vote.authorPub === selfPub) myVotes.set(vote.statementId, vote.value)
        }
      }

      const map = active ? analyseConversation(statements, votes) : null

      setState({ ready: true, conversations, statements, votes, myVotes, map, error: null })
    } catch (err) {
      log.error('db', 'deliberation refresh failed', { error: String(err) })
      setState((s) => ({ ...s, ready: true, error: err instanceof Error ? err.message : String(err) }))
    }
  }, [conversationId, selfPub])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openConversation = useCallback(
    async (input: {
      authorPub: PubKeyId
      title: string
      prompt: string
      locality?: Locality
      durationDays?: number
    }) => {
      const createdAt = Date.now()
      const id = conversationIdFor(input.authorPub, input.title, createdAt)
      await saveConversation({
        id,
        authorPub: input.authorPub,
        title: input.title.trim(),
        prompt: input.prompt.trim(),
        ...(input.locality ? { locality: input.locality } : {}),
        createdAt,
        closesAt: createdAt + (input.durationDays ?? 30) * 86_400_000,
        hlc: '',
      })
      await refresh()
      return id
    },
    [refresh],
  )

  const addStatement = useCallback(
    async (input: {
      authorPub: PubKeyId
      conversationId: string
      text: string
    }) => {
      const createdAt = Date.now()
      const id = statementIdFor(input.authorPub, input.conversationId, input.text.trim(), createdAt)
      await saveStatement({
        id,
        conversationId: input.conversationId,
        authorPub: input.authorPub,
        text: input.text.trim(),
        createdAt,
        hlc: '',
      })
      // Your own statement is an implicit agree — you wrote it because you
      // believe it, and leaving it unvoted would make your own position
      // invisible in the clustering.
      await castVote({
        authorPub: input.authorPub,
        statementId: id,
        conversationId: input.conversationId,
        value: VoteValue.Agree,
      })
      await refresh()
      return id
    },
    [refresh],
  )

  const vote = useCallback(
    async (statementId: string, value: VoteValue) => {
      if (!selfPub || !conversationId) return
      await castVote({ authorPub: selfPub, statementId, conversationId, value })
      await refresh()
    },
    [selfPub, conversationId, refresh],
  )

  return { ...state, refresh, openConversation, addStatement, vote }
}
