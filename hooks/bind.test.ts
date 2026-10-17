import { describe, expect, test } from 'claude-code/testing'

import { evaluate, fillRoot, fillString, lookup, restoreBraces } from './bind'

const DATA = {
  r: {
    n: 3,
    items: [
      { name: 'a', status: 'failed', meta: { ns: 'x' } },
      { name: 'b', status: 'passed', meta: { ns: 'y' } },
    ],
  },
  sync: '2\t5',
  lines: ['one', 'two'],
}

describe('lookup', () => {
  test('walks dots and indexes', () => {
    expect(lookup(DATA, 'r.items[1].meta.ns')).toBe('y')
    expect(lookup(DATA, ' r.n ')).toBe(3)
    expect(lookup(DATA, 'r.missing.deeper')).toBeUndefined()
  })
})

describe('filters', () => {
  test('list filters', () => {
    expect(evaluate('r.items | length', DATA)).toBe(2)
    expect(evaluate('r.items | count:status=failed', DATA)).toBe(1)
    expect(evaluate('r.items | where:status!=failed | map:name', DATA)).toEqual(['b'])
    expect(evaluate('r.items | map:meta.ns | join:,\\s', DATA)).toBe('x, y')
    expect(evaluate('r.items | sort:name | last', DATA)).toEqual(DATA.r.items[1])
    expect(evaluate('lines | take:1', DATA)).toEqual(['one'])
    expect(evaluate('lines | first | upper', DATA)).toBe('ONE')
  })

  test('text filters and default', () => {
    expect(evaluate('sync | split:\\t | last', DATA)).toBe('5')
    expect(evaluate('nope | default:none', DATA)).toBe('none')
    expect(evaluate('lines | first | trim', DATA)).toBe('one')
  })

  test('an unknown filter throws', () => {
    expect(() => evaluate('r | nope', DATA)).toThrow('unknown filter "nope"')
  })
})

describe('filling', () => {
  test('a whole expression keeps its type; mixed text interpolates', () => {
    expect(fillString('{{r.n}}', DATA)).toBe(3)
    expect(fillString('n={{r.n}}, x={{nope}}', DATA)).toBe('n=3, x=—')
  })

  test('each repeats inside arrays, when picks a branch, text fields hold strings', () => {
    const tree = {
      type: 'box',
      children: [
        { type: 'each', items: '{{r.items}}', as: 'it', node: { type: 'text', text: '{{it.name}}' } },
        { type: 'when', test: '{{r.items | count:status=broken}}', node: { type: 'text', text: 'broken' }, else: { type: 'text', text: '{{r.n}}' } },
        { type: 'table', columns: ['l', 'n'], rows: [{ type: 'each', items: '{{lines}}', as: 'l', node: ['{{l}}', '{{r.n}}'] }] },
        { type: 'progress', value: '{{r.n}}', max: '{{nope}}' },
      ],
    }
    expect(fillRoot(tree, DATA)).toEqual({
      type: 'box',
      children: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
        { type: 'text', text: '3' },
        { type: 'table', columns: ['l', 'n'], rows: [['one', '3'], ['two', '3']] },
        { type: 'progress', value: 3 },
      ],
    })
  })

  test('each draws at most 200 nodes and says how many it left out', () => {
    const many = { xs: Array.from({ length: 205 }, (_, i) => i) }
    const filled = fillRoot({ type: 'box', children: [{ type: 'each', items: '{{xs}}', as: 'x', node: { type: 'text', text: '{{x}}' } }] }, many) as { children: unknown[] }
    expect(filled.children.length).toBe(201)
    expect(filled.children[200]).toEqual({ type: 'text', text: '+5 more', dim: true })
  })

  test('an each at the root becomes a box', () => {
    expect(fillRoot({ type: 'each', items: '{{lines}}', as: 'l', node: { type: 'text', text: '{{l}}' } }, DATA)).toEqual({
      type: 'box',
      children: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }],
    })
  })

  test('errors name the node', () => {
    expect(() => fillRoot({ type: 'text', text: '{{a | zap}}' }, {})).toThrow('tree.text: unknown filter "zap"')
  })
})

describe('review fixes', () => {
  const T = { type: 'text', text: '{{x}}' }

  test('a spread inside each is flattened, never leaked', () => {
    const tree = { type: 'box', children: [{ type: 'each', items: '{{xs}}', as: 'x', node: { type: 'when', test: '{{x}}', node: T } }] }
    expect(fillRoot(tree, { xs: [1, 0, 2] })).toEqual({ type: 'box', children: [{ type: 'text', text: '1' }, { type: 'text', text: '2' }] })
    const nested = { type: 'box', children: [{ type: 'each', items: '{{ys}}', as: 'y', node: { type: 'each', items: '{{y}}', as: 'x', node: T } }] }
    expect(fillRoot(nested, { ys: [[1, 2], [3]] })).toEqual({
      type: 'box',
      children: [{ type: 'text', text: '1' }, { type: 'text', text: '2' }, { type: 'text', text: '3' }],
    })
  })

  test('each or when as an object property throws', () => {
    const tree = { type: 'box', children: { type: 'each', items: '{{xs}}', as: 'x', node: T } }
    expect(() => fillRoot(tree, { xs: [1] })).toThrow('each/when must be inside a list')
  })

  test('nested eaches share a budget of 2000', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i)
    const tree = {
      type: 'box',
      children: [{ type: 'each', items: '{{xs}}', as: 'a', node: { type: 'each', items: '{{xs}}', as: 'b', node: T } }],
    }
    expect(() => fillRoot(tree, { xs, x: 1 })).toThrow('tree: more than 2000 repeated nodes')
  })

  test('prototype names are not reachable', () => {
    expect(() => evaluate('r | constructor', DATA)).toThrow('unknown filter "constructor"')
    expect(lookup(DATA, 'r.constructor')).toBeUndefined()
    expect(lookup(DATA, '__proto__')).toBeUndefined()
    expect(lookup(DATA, 'r.prototype')).toBeUndefined()
    expect(lookup({ s: 'abc' }, 's.length')).toBeUndefined()
  })

  test('sort is numeric for numbers, plain for text, missing last', () => {
    expect(evaluate('xs | sort', { xs: [10, 9, null, 100] })).toEqual([9, 10, 100, null])
    const items = [{ v: 10 }, {}, { v: 9 }]
    expect(evaluate('items | sort:v | map:v', { items })).toEqual([9, 10, undefined])
    expect(evaluate('xs | sort', { xs: ['b', 'B', 'a'] })).toEqual(['B', 'a', 'b'])
  })

  test('where on an empty value matches missing fields', () => {
    expect(evaluate('items | count:status=', { items: [{ status: 'x' }, {}, { status: null }] })).toBe(2)
  })

  test('null is treated like missing', () => {
    expect(fillRoot({ type: 'box', title: '{{n}}', children: ['{{n}}', 'a'] }, { n: null })).toEqual({ type: 'box', children: ['—', 'a'] })
  })

  test('a missing string cell in an array keeps its column', () => {
    expect(fillRoot({ type: 'table', columns: ['a', 'b'], rows: [['{{a}}', '{{nope}}']] }, { a: 'x' })).toEqual({
      type: 'table',
      columns: ['a', 'b'],
      rows: [['x', '—']],
    })
  })

  test('an empty path is undefined', () => {
    expect(evaluate('', DATA)).toBeUndefined()
    expect(fillString('{{ }}', DATA)).toBeUndefined()
  })

  test('take needs a whole number', () => {
    expect(() => evaluate('lines | take:-1', DATA)).toThrow('take: expected a whole number ≥ 0')
    expect(() => evaluate('lines | take:x', DATA)).toThrow('take: expected a whole number ≥ 0')
    expect(() => evaluate('lines | take', DATA)).toThrow('take: expected a whole number ≥ 0')
  })
})

describe('template button prompts', () => {
  const button = (prompt: string) => ({ type: 'button', id: 'b', label: 'B', action: 'prompt', prompt })
  const promptOf = (tree: unknown, scope: Record<string, unknown>) => (fillRoot(tree, scope) as { prompt: string }).prompt

  test('form expressions are kept for the press; data is filled', () => {
    const cases: [string, string][] = [
      ['{{form.q}}', '{{form.q}}'],
      ['{{ form.q }}', '{{ form.q }}'],
      ['{{form.q | upper}}', '{{form.q | upper}}'],
      ['{{form}}', '{{form}}'],
      ['{{form[0]}}', '{{form[0]}}'],
      ['{{formal}}', 'yes'],
      ['{{n}} and {{form.q}}', '7 and {{form.q}}'],
    ]
    for (const [prompt, expected] of cases) expect(promptOf(button(prompt), { n: 7, formal: 'yes' }), prompt).toBe(expected)
  })

  test('braces in data are held so the press reads no bindings in them', () => {
    expect(promptOf(button('{{msg}}'), { msg: 'fix {{x}} }{' })).toBe('fix \uE000\uE000x\uE001\uE001 \uE001\uE000')
    expect(restoreBraces('fix \uE000\uE000x\uE001\uE001')).toBe('fix {{x}}')
  })

  test('a draw-time error names the prompt by its path', () => {
    expect(() => fillRoot({ type: 'box', children: [button('{{n | zap}}')] }, { n: 7 })).toThrow('tree.children[0].prompt: unknown filter "zap"')
  })

  test('inside an each, the row is filled and the form kept', () => {
    const tree = { type: 'box', children: [{ type: 'each', items: '{{rows}}', as: 'item', node: button('{{item.name}}: {{form.q}}') }] }
    const filled = fillRoot(tree, { rows: [{ name: 'a' }, { name: 'b' }] }) as { children: { prompt: string }[] }
    expect(filled.children.map(child => child.prompt)).toEqual(['a: {{form.q}}', 'b: {{form.q}}'])
  })

  test('an each may not take the name form', () => {
    const tree = { type: 'box', children: [{ type: 'each', items: '{{rows}}', as: 'form', node: { type: 'text', text: 'x' } }] }
    expect(() => fillRoot(tree, { rows: [1] })).toThrow('tree.children[0].as: "form" is reserved')
  })
})
