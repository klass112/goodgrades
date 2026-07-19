import { afterEach, describe, expect, it, vi } from 'vitest'
import { type LogLevel, createLogger } from './logger.js'

interface CapturedLine {
  line: string
  level: LogLevel
}

function captureSink() {
  const lines: CapturedLine[] = []
  const sink = (line: string, level: LogLevel) => lines.push({ line, level })
  return { sink, lines }
}

const FIXED_TIME = new Date('2026-07-19T00:00:00.000Z')
const clock = () => FIXED_TIME

describe('createLogger', () => {
  it('emits one line of valid JSON with level, time, msg, and extra fields', () => {
    const { sink, lines } = captureSink()
    const logger = createLogger({ sink, clock })

    logger.info('hello', { foo: 'bar' })

    expect(lines).toHaveLength(1)
    const parsed = lines[0] ? JSON.parse(lines[0].line) : undefined
    expect(parsed).toEqual({
      foo: 'bar',
      level: 'info',
      time: '2026-07-19T00:00:00.000Z',
      msg: 'hello',
    })
  })

  it('routes debug/info to the sink tagged with their own level, not just written to one stream', () => {
    const { sink, lines } = captureSink()
    const logger = createLogger({ sink, clock, level: 'debug' })

    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(lines.map((l) => l.level)).toEqual(['debug', 'info', 'warn', 'error'])
  })

  it('defaults to console.log for info/debug and console.error for warn/error', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const logger = createLogger({ clock, level: 'debug' })
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')

    expect(logSpy).toHaveBeenCalledTimes(2)
    expect(errorSpy).toHaveBeenCalledTimes(2)

    logSpy.mockRestore()
    errorSpy.mockRestore()
  })

  describe('level filtering', () => {
    it('drops lines below the configured level', () => {
      const { sink, lines } = captureSink()
      const logger = createLogger({ sink, clock, level: 'warn' })

      logger.debug('dropped')
      logger.info('dropped')
      logger.warn('kept')
      logger.error('kept')

      expect(lines).toHaveLength(2)
      expect(lines.map((l) => JSON.parse(l.line).msg)).toEqual(['kept', 'kept'])
    })

    it('defaults to info when no level option and no LOG_LEVEL env var are set', () => {
      const { sink, lines } = captureSink()
      const logger = createLogger({ sink, clock })

      logger.debug('dropped')
      logger.info('kept')

      expect(lines).toHaveLength(1)
    })

    describe('LOG_LEVEL env var', () => {
      const original = process.env.LOG_LEVEL

      afterEach(() => {
        if (original === undefined) {
          // Not `= undefined`: process.env coerces assignments to strings, so that
          // would leave the literal string "undefined" behind instead of clearing it.
          // biome-ignore lint/performance/noDelete: correctness, not style — see above.
          delete process.env.LOG_LEVEL
        } else {
          process.env.LOG_LEVEL = original
        }
      })

      it('is respected when no explicit level option is passed', () => {
        process.env.LOG_LEVEL = 'error'
        const { sink, lines } = captureSink()
        const logger = createLogger({ sink, clock })

        logger.warn('dropped')
        logger.error('kept')

        expect(lines).toHaveLength(1)
      })

      it('is overridden by an explicit level option', () => {
        process.env.LOG_LEVEL = 'error'
        const { sink, lines } = captureSink()
        const logger = createLogger({ sink, clock, level: 'debug' })

        logger.debug('kept anyway')

        expect(lines).toHaveLength(1)
      })
    })
  })

  describe('error serialization', () => {
    it('serializes an Error field into name/message/stack rather than {}', () => {
      const { sink, lines } = captureSink()
      const logger = createLogger({ sink, clock })

      logger.error('boom', { err: new TypeError('bad input') })

      const parsed = lines[0] ? JSON.parse(lines[0].line) : undefined
      expect(parsed.err.name).toBe('TypeError')
      expect(parsed.err.message).toBe('bad input')
      expect(typeof parsed.err.stack).toBe('string')
      expect(parsed.err.stack.length).toBeGreaterThan(0)
    })
  })

  describe('redaction', () => {
    it('redacts obviously sensitive keys case-insensitively', () => {
      const { sink, lines } = captureSink()
      const logger = createLogger({ sink, clock })

      logger.info('request', {
        Authorization: 'Bearer secret-token',
        cookie: 'session=abc',
        password: 'hunter2',
        TOKEN: 'xyz',
        secret: 'shh',
        userId: 'u_123',
      })

      const parsed = lines[0] ? JSON.parse(lines[0].line) : undefined
      expect(parsed.Authorization).toBe('[redacted]')
      expect(parsed.cookie).toBe('[redacted]')
      expect(parsed.password).toBe('[redacted]')
      expect(parsed.TOKEN).toBe('[redacted]')
      expect(parsed.secret).toBe('[redacted]')
      expect(parsed.userId).toBe('u_123')
    })

    it('redacts sensitive keys bound via context, not just per-call fields', () => {
      const { sink, lines } = captureSink()
      const logger = createLogger({ sink, clock, context: { token: 'bound-secret' } })

      logger.info('hello')

      const parsed = lines[0] ? JSON.parse(lines[0].line) : undefined
      expect(parsed.token).toBe('[redacted]')
    })
  })

  describe('child', () => {
    it('merges bound fields into every line the child emits', () => {
      const { sink, lines } = captureSink()
      const logger = createLogger({ sink, clock, context: { service: 'api' } })
      const child = logger.child({ requestId: 'req-1' })

      child.info('handled')

      const parsed = lines[0] ? JSON.parse(lines[0].line) : undefined
      expect(parsed).toMatchObject({ service: 'api', requestId: 'req-1', msg: 'handled' })
    })

    it('composes across multiple levels of child()', () => {
      const { sink, lines } = captureSink()
      const logger = createLogger({ sink, clock })
      const grandchild = logger.child({ a: 1 }).child({ b: 2 })

      grandchild.info('nested')

      const parsed = lines[0] ? JSON.parse(lines[0].line) : undefined
      expect(parsed).toMatchObject({ a: 1, b: 2, msg: 'nested' })
    })

    it('inherits the parent level threshold', () => {
      const { sink, lines } = captureSink()
      const logger = createLogger({ sink, clock, level: 'error' })
      const child = logger.child({ requestId: 'req-1' })

      child.warn('dropped')
      child.error('kept')

      expect(lines).toHaveLength(1)
    })
  })
})
