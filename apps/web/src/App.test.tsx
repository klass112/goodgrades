import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App.js'

describe('App', () => {
  it('renders the build metadata so a deploy can be identified from the page itself', () => {
    render(<App commit="abc1234" builtAt="2026-07-19T00:00:00Z" />)

    expect(screen.getByTestId('commit').textContent).toBe('abc1234')
    expect(screen.getByTestId('built-at').textContent).toBe('2026-07-19T00:00:00Z')
  })
})
