import { describe, expect, it } from 'vitest'
import { DeliberateTestError, readBoomMarker, triggerDeliberateError } from './debug-error.js'

describe('readBoomMarker', () => {
  it('returns null when the param is absent, so normal visits never throw', () => {
    expect(readBoomMarker('')).toBeNull()
    expect(readBoomMarker('?other=1')).toBeNull()
  })

  it('reads the marker so a triggered error can be traced back to who fired it', () => {
    expect(readBoomMarker('?boom=deploy-check')).toBe('deploy-check')
  })

  it('treats a bare ?boom as a valid trigger', () => {
    expect(readBoomMarker('?boom')).toBe('unnamed')
    expect(readBoomMarker('?boom=')).toBe('unnamed')
  })
})

describe('triggerDeliberateError', () => {
  it('throws a named error carrying the marker', () => {
    expect(() => triggerDeliberateError('abc')).toThrow(DeliberateTestError)
    expect(() => triggerDeliberateError('abc')).toThrow(/\[abc\]/)
  })

  it('produces a multi-frame stack — a single frame would not prove traces are usable', () => {
    try {
      triggerDeliberateError('stack-check')
      expect.unreachable('expected a throw')
    } catch (error) {
      const stack = (error as Error).stack ?? ''
      expect(stack).toContain('formatReportRow')
      expect(stack).toContain('buildReport')
    }
  })
})
