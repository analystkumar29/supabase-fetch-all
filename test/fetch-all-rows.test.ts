import { describe, expect, it, vi } from 'vitest'
import { fetchAllRows, FetchAllRowsError } from '../src/index.js'
import { FakeSupabase } from './fake-postgrest.js'

type Item = { id: number; group: string }

/**
 * A fake table of `count` items with ids 1..count. `group` cycles through
 * 'a', 'b' and 'c', so it's a column with lots of ties.
 */
function itemsTable(count: number, serverMaxRows?: number) {
  const rows: Item[] = Array.from({ length: count }, (_, i) => ({ id: i + 1, group: 'abc'.charAt(i % 3) }))
  const db = new FakeSupabase({ name: 'items', columns: ['id', 'group'], rows }, serverMaxRows)
  return { db, rows, items: () => db.from('items').select('*') }
}

const ids = (rows: Item[]) => rows.map((row) => row.id)
const oneTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1)

/** Await a promise that should reject with a FetchAllRowsError, and return the error. */
async function rejection(promise: Promise<unknown>): Promise<FetchAllRowsError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(FetchAllRowsError)
    return error as FetchAllRowsError
  }
  throw new Error('expected the promise to reject')
}

describe('the bug, reproduced by the fake server', () => {
  it('a plain select, .limit(5000) and .range(0, 4999) all return 1,000 of 2,350 rows, with no error', async () => {
    const { db } = itemsTable(2350)
    const responses = [
      await db.from('items').select('*'),
      await db.from('items').select('*').limit(5000),
      await db.from('items').select('*').range(0, 4999),
    ]
    for (const { data, error } of responses) {
      expect(error).toBeNull()
      expect(data).toHaveLength(1000)
    }
  })
})

describe('fetchAllRows', () => {
  it('reads all 2,350 rows in 3 pages, in order, building a fresh query for each page', async () => {
    const { db, items } = itemsTable(2350)
    const makeQuery = vi.fn(items)

    const result = await fetchAllRows(makeQuery, { orderBy: 'id' })

    expect(ids(result.rows)).toEqual(oneTo(2350))
    expect(result.pages).toBe(3)
    expect(result.truncated).toBe(false)
    expect(makeQuery).toHaveBeenCalledTimes(3)
    expect(db.requests).toEqual([
      { offset: 0, limit: 1000, returned: 1000 },
      { offset: 1000, limit: 1000, returned: 1000 },
      { offset: 2000, limit: 1000, returned: 350 },
    ])
  })

  it('handles an exact multiple of the page size: 2,000 rows take 3 pages, the last one empty', async () => {
    const { db, items } = itemsTable(2000)

    const result = await fetchAllRows(items, { orderBy: 'id' })

    expect(ids(result.rows)).toEqual(oneTo(2000))
    expect(result.pages).toBe(3)
    expect(db.requests.map((request) => request.returned)).toEqual([1000, 1000, 0])
  })

  it('returns no rows for an empty table, after one request', async () => {
    const { items } = itemsTable(0)

    const result = await fetchAllRows(items, { orderBy: 'id' })

    expect(result).toEqual({ rows: [], pages: 1, truncated: false })
  })

  it('confirms a short first page with one more request', async () => {
    const { db, items } = itemsTable(42)

    const result = await fetchAllRows(items, { orderBy: 'id' })

    expect(ids(result.rows)).toEqual(oneTo(42))
    expect(result.pages).toBe(2)
    expect(db.requests).toEqual([
      { offset: 0, limit: 1000, returned: 42 },
      { offset: 42, limit: 42, returned: 0 },
    ])
  })

  it('reads everything when the server caps pages below pageSize (max rows = 500)', async () => {
    const { items } = itemsTable(2350, 500)

    const result = await fetchAllRows(items, { orderBy: 'id' })

    expect(ids(result.rows)).toEqual(oneTo(2350))
    expect(result.pages).toBe(5)
  })

  it('reads everything when pageSize is set above the server cap', async () => {
    const { db, items } = itemsTable(2350)

    const result = await fetchAllRows(items, { orderBy: 'id', pageSize: 5000 })

    expect(ids(result.rows)).toEqual(oneTo(2350))
    expect(db.requests.map((request) => request.returned)).toEqual([1000, 1000, 350])
  })

  it('uses a smaller pageSize when asked', async () => {
    const { items } = itemsTable(2350)

    const result = await fetchAllRows(items, { orderBy: 'id', pageSize: 250 })

    expect(ids(result.rows)).toEqual(oneTo(2350))
    expect(result.pages).toBe(10)
  })

  it('adds orderBy after any order already in makeQuery, as the tie-breaker', async () => {
    const { db } = itemsTable(2350)

    const { rows } = await fetchAllRows(() => db.from('items').select('*').order('group', { ascending: false }), {
      orderBy: 'id',
    })

    const expected = [...rows].sort((a, b) => b.group.localeCompare(a.group) || a.id - b.id)
    expect(rows).toEqual(expected)
    expect(new Set(ids(rows)).size).toBe(2350)
  })

  it('shows why orderBy must be unique: ordering by a column with ties repeats some rows and skips others', async () => {
    const { items } = itemsTable(2350)

    const { rows } = await fetchAllRows(items, { orderBy: 'group' })

    expect(rows).toHaveLength(2350) // the count looks right...
    expect(new Set(ids(rows)).size).toBeLessThan(2350) // ...but some rows came back twice and others never
  })

  it('passes filters in makeQuery through to every page', async () => {
    const { db } = itemsTable(2350)

    const { rows, pages } = await fetchAllRows(() => db.from('items').select('*').eq('group', 'b'), {
      orderBy: 'id',
    })

    expect(rows).toHaveLength(783)
    expect(rows.every((row) => row.group === 'b')).toBe(true)
    expect(pages).toBe(2)
  })
})

describe('maxRows', () => {
  it('throws TRUNCATED by default when more rows match than maxRows', async () => {
    const { items } = itemsTable(2350)

    const error = await rejection(fetchAllRows(items, { orderBy: 'id', maxRows: 1500 }))

    expect(error.code).toBe('TRUNCATED')
    expect(error.message).toContain('more than 1500 rows match')
  })

  it("returns the first maxRows rows with truncated: true when onTruncated is 'return'", async () => {
    const { items } = itemsTable(2350)

    const result = await fetchAllRows(items, { orderBy: 'id', maxRows: 1500, onTruncated: 'return' })

    expect(ids(result.rows)).toEqual(oneTo(1500))
    expect(result.truncated).toBe(true)
    expect(result.pages).toBe(2)
  })

  it('is not truncated when the table has exactly maxRows rows', async () => {
    const { items } = itemsTable(2000)

    const result = await fetchAllRows(items, { orderBy: 'id', maxRows: 2000 })

    expect(result.rows).toHaveLength(2000)
    expect(result.truncated).toBe(false)
  })

  it('accepts Infinity to turn the limit off', async () => {
    const { items } = itemsTable(2350)

    const result = await fetchAllRows(items, { orderBy: 'id', maxRows: Infinity })

    expect(result.rows).toHaveLength(2350)
  })
})

describe('errors', () => {
  it('throws QUERY_FAILED with the PostgREST error, where a naive read gets an empty list', async () => {
    const { db, items } = itemsTable(2350)

    // The naive pattern: look at data, ignore error, and quietly get nothing.
    const { data } = await db.from('items').select('*').order('created_at')
    expect(data ?? []).toEqual([])

    const error = await rejection(fetchAllRows(items, { orderBy: 'created_at' }))
    expect(error.code).toBe('QUERY_FAILED')
    expect(error.message).toBe('fetchAllRows: page 1 (rows 0-999) failed: column items.created_at does not exist')
    expect(error.cause).toMatchObject({ code: '42703' })
  })

  it('stops at a page that fails halfway through and returns no partial rows', async () => {
    const { db, items } = itemsTable(2350)
    db.failRequest(2, {
      code: '57014',
      message: 'canceling statement due to statement timeout',
      details: null,
      hint: null,
    })

    const error = await rejection(fetchAllRows(items, { orderBy: 'id' }))

    expect(error.code).toBe('QUERY_FAILED')
    expect(error.message).toBe(
      'fetchAllRows: page 2 (rows 1000-1999) failed: canceling statement due to statement timeout',
    )
  })

  it('refuses a page query that returns no list of rows, such as one with head: true', async () => {
    const { db } = itemsTable(2350)

    const error = await rejection(fetchAllRows(() => db.from('items').select('*', { head: true }), { orderBy: 'id' }))

    expect(error.code).toBe('QUERY_FAILED')
    expect(error.message).toContain('returned no list of rows')
  })

  it('checks its options before making any request', async () => {
    const { db, items } = itemsTable(10)
    const bad = (options: object) => fetchAllRows(items, { orderBy: 'id', ...options })

    await expect(bad({ orderBy: '' })).rejects.toThrow(TypeError)
    await expect(bad({ pageSize: 0 })).rejects.toThrow(RangeError)
    await expect(bad({ pageSize: 2.5 })).rejects.toThrow(RangeError)
    await expect(bad({ maxRows: 0 })).rejects.toThrow(RangeError)
    await expect(bad({ onTruncated: 'ignore' })).rejects.toThrow(TypeError)
    expect(db.requests).toHaveLength(0)
  })
})

describe('verifyCount', () => {
  it('passes when the count matches, at the cost of one count query', async () => {
    const { db, items } = itemsTable(2350)
    const countQuery = vi.fn(() => db.from('items').select('*', { count: 'exact', head: true }))

    const result = await fetchAllRows(items, { orderBy: 'id', verifyCount: countQuery })

    expect(result.rows).toHaveLength(2350)
    expect(countQuery).toHaveBeenCalledTimes(1)
  })

  it('throws COUNT_MISMATCH when the table changes between reading and counting', async () => {
    const { db, rows, items } = itemsTable(2350)

    const error = await rejection(
      fetchAllRows(items, {
        orderBy: 'id',
        verifyCount: () => {
          rows.push({ id: 2351, group: 'a' }) // someone inserts a row while we read
          return db.from('items').select('*', { count: 'exact', head: true })
        },
      }),
    )

    expect(error.code).toBe('COUNT_MISMATCH')
    expect(error.message).toContain('read 2350 rows, but the count query says 2351')
  })

  it("throws COUNT_MISMATCH when the count query has no count (count: 'exact' forgotten)", async () => {
    const { db, items } = itemsTable(2350)

    const error = await rejection(
      fetchAllRows(items, { orderBy: 'id', verifyCount: () => db.from('items').select('*', { head: true }) }),
    )

    expect(error.code).toBe('COUNT_MISMATCH')
    expect(error.message).toContain('returned no count')
  })

  it('throws QUERY_FAILED when the count query itself fails', async () => {
    const { db, items } = itemsTable(2350)

    const error = await rejection(
      fetchAllRows(items, {
        orderBy: 'id',
        verifyCount: () => db.from('items').select('*', { count: 'exact', head: true }).eq('status', 'open'),
      }),
    )

    expect(error.code).toBe('QUERY_FAILED')
    expect(error.message).toContain('column items.status does not exist')
  })

  it('is skipped when the result is truncated on purpose', async () => {
    const { db, items } = itemsTable(2350)
    const countQuery = vi.fn(() => db.from('items').select('*', { count: 'exact', head: true }))

    const result = await fetchAllRows(items, {
      orderBy: 'id',
      maxRows: 100,
      onTruncated: 'return',
      verifyCount: countQuery,
    })

    expect(result.truncated).toBe(true)
    expect(countQuery).not.toHaveBeenCalled()
  })
})
