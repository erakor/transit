import { describe, expect, it } from 'vitest'
import { checkToken, configuredTokens, presentedToken } from '#src/auth.js'

const env = { TRANSIT_TOKEN: 'alpha, beta' }
const h = (o: Record<string, string>) => new Headers(o)

describe('token check', () => {
  it('accepts the X-Transit-Token header', () => {
    expect(checkToken(h({ 'x-transit-token': 'alpha' }), env)).toEqual({ ok: true })
    expect(checkToken(h({ 'X-Transit-Token': ' beta ' }), env)).toEqual({ ok: true })
  })

  it('ignores the Authorization header', () => {
    expect(presentedToken(h({ authorization: 'Bearer alpha' }))).toBeUndefined()
    expect(checkToken(h({ authorization: 'Bearer alpha' }), env)).toMatchObject({
      ok: false,
      code: 'missing_token',
      error: 'missing token',
    })
  })

  it('rejects missing and wrong tokens with 401', () => {
    expect(checkToken(h({}), env)).toMatchObject({ ok: false, code: 'missing_token', error: 'missing token' })
    expect(checkToken(h({ authorization: 'Basic alpha' }), env)).toMatchObject({ ok: false, code: 'missing_token' })
    expect(checkToken(h({ 'x-transit-token': 'gamma' }), env)).toMatchObject({
      ok: false,
      code: 'invalid_token',
      error: 'invalid token',
    })
    expect(checkToken(h({ 'x-transit-token': 'alph' }), env)).toMatchObject({ ok: false, code: 'invalid_token' })
    expect(checkToken(h({ 'x-transit-token': 'alpha, beta' }), env)).toMatchObject({ ok: false, code: 'invalid_token' })
  })

  it('fails closed when no token is configured', () => {
    expect(configuredTokens({ TRANSIT_TOKEN: ' , ' })).toEqual([])
    expect(checkToken(h({ 'x-transit-token': '' }), {})).toMatchObject({ ok: false, code: 'not_configured' })
    expect(checkToken(h({ 'x-transit-token': 'anything' }), { TRANSIT_TOKEN: '' })).toMatchObject({
      ok: false,
      code: 'not_configured',
    })
  })
})
