import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { SettingsIcon } from '../src/components/Icons'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('icons', () => {
  it('renders the settings icon as a gear with a center circle', () => {
    const markup = renderToStaticMarkup(React.createElement(SettingsIcon))

    assert.match(markup, /circle cx="12" cy="12" r="3"/)
    assert.match(markup, /10\.325 4\.317/)
  })
})
