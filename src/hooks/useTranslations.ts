'use client'

import { useCallback, useEffect, useState } from 'react'

import {
  listTranslations,
  saveTranslation,
  withdrawTranslation,
  getReaderLanguages,
  setReaderLanguages,
} from '@/lib/db/repo'
import { createTranslation } from '@/lib/lang/translation'
import { guessLanguage } from '@/lib/lang/languages'
import type { KeyPair } from '@/lib/crypto/keys'
import type { Translation, TranslationTarget } from '@/lib/db/schema'
import { log } from '@/lib/telemetry'

export function useTranslations() {
  const [translations, setTranslations] = useState<Translation[]>([])
  const [readerLangs, setReaderLangs] = useState<string[]>([])
  const [ready, setReady] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [all, reads] = await Promise.all([listTranslations(), getReaderLanguages()])
      setTranslations(all)
      // A first-run default the reader can change, never written to storage on
      // their behalf — a guessed language silently persisted would put items in
      // someone's translation queue on the strength of a browser setting.
      setReaderLangs(reads.length > 0 ? reads : [guessLanguage() ?? 'en'])
      setReady(true)
    } catch (err) {
      log.error('db', 'translation refresh failed', { error: String(err) })
      setReady(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const translate = useCallback(
    async (
      keyPair: KeyPair,
      input: { targetId: string; targetEntity: TranslationTarget; lang: string; text: string; sourceLang?: string },
    ) => {
      await saveTranslation(createTranslation(keyPair, input))
      await refresh()
    },
    [refresh],
  )

  const withdraw = useCallback(
    async (translationId: string) => {
      await withdrawTranslation(translationId)
      await refresh()
    },
    [refresh],
  )

  const setReads = useCallback(
    async (langs: readonly string[]) => {
      await setReaderLanguages(langs)
      await refresh()
    },
    [refresh],
  )

  return { ready, translations, readerLangs, translate, withdraw, setReads, refresh }
}
