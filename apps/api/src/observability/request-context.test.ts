import { describe, expect, it } from 'vitest'
import { getRequestContext, runWithRequestContext } from './request-context.js'

describe('request context', () => {
  it('is undefined outside of runWithRequestContext', () => {
    expect(getRequestContext()).toBeUndefined()
  })

  it('exposes the bound requestId to code called within the same async chain', async () => {
    const result = await runWithRequestContext({ requestId: 'req-1' }, async () => {
      await Promise.resolve()
      return getRequestContext()
    })

    expect(result).toEqual({ requestId: 'req-1' })
  })

  it('is cleared again once the callback resolves', async () => {
    await runWithRequestContext({ requestId: 'req-1' }, async () => undefined)

    expect(getRequestContext()).toBeUndefined()
  })

  it('does not leak between concurrently running contexts', async () => {
    const seenInFirst: (string | undefined)[] = []
    const seenInSecond: (string | undefined)[] = []

    async function track(requestId: string, sink: (string | undefined)[], delayMs: number) {
      return runWithRequestContext({ requestId }, async () => {
        sink.push(getRequestContext()?.requestId)
        await new Promise((resolve) => setTimeout(resolve, delayMs))
        sink.push(getRequestContext()?.requestId)
      })
    }

    await Promise.all([track('req-a', seenInFirst, 10), track('req-b', seenInSecond, 0)])

    expect(seenInFirst).toEqual(['req-a', 'req-a'])
    expect(seenInSecond).toEqual(['req-b', 'req-b'])
  })
})
