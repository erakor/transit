import { describe, expect, it } from 'vitest'
import * as z from 'zod'
import { coordinateParam, countParam, optionalParam, parseQuery, requiredParam } from '#src/schema.js'
import { ArrivalsQuery, ArrivalsResponse } from '#src/subway/schemas.js'

const Query = z.object({ name: requiredParam('name', 'A name.'), n: countParam('n', 3, 10, 'How many.') })
const parse = (qs: string) => parseQuery(Query, new URL(`https://x.test/${qs}`))

describe('parseQuery', () => {
  it.each([
    ['?name=a', { name: 'a', n: 3 }],
    ['?name=a&n=', { name: 'a', n: 3 }],
    ['?name=a&n=7', { name: 'a', n: 7 }],
    ['?name=a&n=99', { name: 'a', n: 10 }],
    ['?name=a&n=99999999999999999999', { name: 'a', n: 10 }],
    ['?name=a&n=&n=5', { name: 'a', n: 3 }],
    ['?name=a&constructor=b', { name: 'a', n: 3 }],
    ['?name=a&name=b&n=2&n=5', { name: 'a', n: 2 }],
    ['?name=a&other=1', { name: 'a', n: 3 }],
    ['?name=%20a%20&n=05', { name: 'a', n: 5 }],
  ])('parses %s', (qs, query) => {
    expect(parse(qs)).toEqual({ ok: true, query })
  })

  it.each([
    ['', 'name is required'],
    ['?name=', 'name is required'],
    ['?name=%20', 'name is required'],
    ['?name=&name=b', 'name is required'],
    ['?name=a&n=0', 'n must be a positive integer'],
    ['?name=a&n=-2', 'n must be a positive integer'],
    ['?name=a&n=two', 'n must be a positive integer'],
    // Number() reads these, the digits-only rule doesn't.
    ['?name=a&n=1e1', 'n must be a positive integer'],
    ['?name=a&n=0x10', 'n must be a positive integer'],
    ['?name=a&n=%205', 'n must be a positive integer'],
  ])('rejects %s with a 400', async (qs, error) => {
    const r = parse(qs)
    if (r.ok) throw new Error('expected a failure')
    expect(r.response.status).toBe(400)
    expect(r.response.headers.get('cache-control')).toBe('no-store')
    expect(await r.response.json()).toEqual({ error })
  })
})

describe('parameter helpers', () => {
  const Query = z.object({
    q: optionalParam('q', 'Text.', 5),
    id: optionalParam('id', 'An id.'),
    lat: coordinateParam('lat', 90, 'Latitude.').optional(),
    name: requiredParam('name', 'A name.', 5).optional(),
  })
  const parse = (qs: string) => parseQuery(Query, new URL(`https://x.test/${qs}`))
  const error = async (qs: string) => {
    const r = parse(qs)
    if (r.ok) throw new Error('expected a failure')
    return (await r.response.json()).error
  }

  it('trims optional text and reads blank as absent', () => {
    expect(parse('?q=%20ab%20&id=%20')).toEqual({ ok: true, query: { q: 'ab' } })
  })

  it('caps text length after trimming', async () => {
    expect(parse('?q=%20abcde%20&name=abcde')).toMatchObject({ ok: true, query: { q: 'abcde', name: 'abcde' } })
    expect(await error('?q=abcdef')).toBe('q is too long')
    expect(await error('?name=abcdef')).toBe('name is too long')
  })

  it.each([
    ['0', 0],
    ['-90', -90],
    ['%2B40.5', 40.5],
    ['.5', 0.5],
    ['4e1', 40],
    ['%2040.7%20', 40.7],
  ])('reads the coordinate %s', (lat, value) => {
    expect(parse(`?lat=${lat}`)).toEqual({ ok: true, query: { lat: value } })
  })

  it.each([
    ['%20', 'lat is required'],
    ...['90.1', '-91', '0x10', 'abc', '1,5', 'Infinity'].map(v => [v, 'lat must be a number between -90 and 90']),
  ])('rejects the coordinate %s', async (lat, message) => {
    expect(await error(`?lat=${lat}`)).toBe(message)
  })
})

describe('arrivals schemas', () => {
  // The base of the generated docs. `io: "input"` describes what a client sends; the default has
  // to survive into it (why countParam uses .prefault()).
  it('convert to JSON Schema with defaults and descriptions', () => {
    const query = z.toJSONSchema(ArrivalsQuery, { io: 'input' })
    expect(query.required).toEqual(['stop'])
    expect(query.properties?.limit).toMatchObject({
      type: 'string',
      default: '3',
      description: expect.stringMatching(/^Trains per route and direction\. Default 3, at most 10/),
    })
    expect(z.toJSONSchema(ArrivalsResponse).additionalProperties).toBe(false)
  })
})
