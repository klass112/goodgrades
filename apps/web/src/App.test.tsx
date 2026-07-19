import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { App } from './App.js'

describe('App', () => {
  it('renders the build metadata so a deploy can be identified from the page itself', () => {
    render(<App commit="abc1234" builtAt="2026-07-19T00:00:00Z" />)

    expect(screen.getByTestId('commit').textContent).toBe('abc1234')
    expect(screen.getByTestId('built-at').textContent).toBe('2026-07-19T00:00:00Z')
  })

  it('renders normally when no boom marker is present', () => {
    render(<App commit="abc1234" builtAt="2026-07-19T00:00:00Z" />)

    expect(screen.getByRole('heading', { name: 'GoodGrades' })).toBeDefined()
  })

  it('throws during render when a boom marker is set, so the error boundary reports it', () => {
    // React logs the caught render error; silence it to keep test output readable.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() =>
      render(<App commit="abc1234" builtAt="2026-07-19T00:00:00Z" boomMarker="test" />),
    ).toThrow(/Deliberate test error \[test\]/)

    consoleError.mockRestore()
  })
})
