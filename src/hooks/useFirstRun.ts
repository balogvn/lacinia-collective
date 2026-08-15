'use client'

import { useCallback, useEffect, useState } from 'react'

import { assessDevice, rootHasVouched, FirstRun } from '@/lib/firstRun'
import { getSyncSources, getAnchors, listVouchers } from '@/lib/db/repo'
import { getDB } from '@/lib/db/db'

/**
 * Which first-run state this device is in.
 *
 * Counts records rather than trusting any single table: a device can hold
 * listings and no statements, or the reverse, and "has anything at all arrived"
 * is the question that decides whether the app looks alive.
 */
export function useFirstRun(hasIdentity: boolean): { state: FirstRun; refresh: () => Promise<void> } {
  const [state, setState] = useState<FirstRun>(FirstRun.Ready)

  const refresh = useCallback(async () => {
    try {
      const [sources, anchors, vouchers] = await Promise.all([
        getSyncSources(),
        getAnchors(),
        listVouchers(),
      ])
      const db = getDB()
      const [listings, statements, identities] = await Promise.all([
        db.listings.count(),
        db.statements.count(),
        db.identities.count(),
      ])

      setState(
        assessDevice({
          hasIdentity,
          sourceCount: sources.length,
          anchorCount: anchors.length,
          // The device's own identity is not a record it received, so it does
          // not count towards "is there anything here" — otherwise creating a
          // key would make an empty app look populated.
          recordCount: listings + statements + Math.max(0, identities - (hasIdentity ? 1 : 0)),
          rootHasVouched: rootHasVouched(anchors, vouchers),
        }),
      )
    } catch {
      /* storage unavailable — the workbench surfaces that error itself */
    }
  }, [hasIdentity])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { state, refresh }
}
