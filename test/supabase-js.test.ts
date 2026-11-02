import { createClient } from '@supabase/supabase-js'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { fetchAllRows, type FetchAllRowsResult } from '../src/index.js'
import { fakeFetch, FakeSupabase } from './fake-postgrest.js'

// The shape `supabase gen types typescript` produces, for one small table.
type Database = {
  public: {
    Tables: {
      items: {
        Row: { id: number; group: string }
        Insert: { id?: number; group: string }
        Update: { id?: number; group?: string }
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

/** A real supabase-js client whose requests are answered by the fake server instead of the network. */
function clientWithItems(count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({ id: i + 1, group: 'abc'.charAt(i % 3) }))
  const db = new FakeSupabase({ name: 'items', columns: ['id', 'group'], rows })
  const answer = fakeFetch(db)
  const sent: Array<{ order: string | null; offset: string | null; limit: string | null }> = []

  const supabase = createClient<Database>('https://example.supabase.co', 'public-anon-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const { searchParams } = new URL(input instanceof Request ? input.url : String(input))
        sent.push({ order: searchParams.get('order'), offset: searchParams.get('offset'), limit: searchParams.get('limit') })
        return answer(input, init)
      },
    },
  })
  return { supabase, sent }
}

// supabase-js 2.118 refuses to start on Node 20 (it needs Node's built-in
// WebSocket, added in Node 22), so these tests only run on Node 22 and newer.
// fetchAllRows itself has no such requirement; the other test file runs everywhere.
const nodeMajor = Number(process.versions.node.split('.')[0])

describe.skipIf(nodeMajor < 22)('with the real supabase-js query builder', () => {
  it('reads past the 1,000-row cap that a plain .limit(5000) runs into', async () => {
    const { supabase, sent } = clientWithItems(2350)

    const naive = await supabase.from('items').select('id, group').limit(5000)
    expect(naive.error).toBeNull()
    expect(naive.data).toHaveLength(1000)

    const { rows, pages } = await fetchAllRows(() => supabase.from('items').select('id, group'), { orderBy: 'id' })

    expect(rows).toHaveLength(2350)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2350)
    expect(pages).toBe(3)
    expect(sent.slice(1)).toEqual([
      { order: 'id.asc', offset: '0', limit: '1000' },
      { order: 'id.asc', offset: '1000', limit: '1000' },
      { order: 'id.asc', offset: '2000', limit: '1000' },
    ])
  })

  it('throws the PostgREST error instead of returning an empty list', async () => {
    const { supabase } = clientWithItems(10)

    await expect(fetchAllRows(() => supabase.from('items').select('*'), { orderBy: 'created_at' })).rejects.toMatchObject({
      name: 'FetchAllRowsError',
      code: 'QUERY_FAILED',
      message: 'fetchAllRows: page 1 (rows 0-999) failed: column items.created_at does not exist',
      cause: { code: '42703' },
    })
  })

  it('verifies the total with a count query (HEAD request, Prefer: count=exact)', async () => {
    const { supabase } = clientWithItems(2350)

    const { rows } = await fetchAllRows(() => supabase.from('items').select('*').eq('group', 'b'), {
      orderBy: 'id',
      verifyCount: () => supabase.from('items').select('*', { count: 'exact', head: true }).eq('group', 'b'),
    })

    expect(rows).toHaveLength(783)
  })

  it('infers row types from the select string, and rejects queries it cannot page', () => {
    const { supabase } = clientWithItems(0)

    const read = () => fetchAllRows(() => supabase.from('items').select('id, group'), { orderBy: 'id' })
    expectTypeOf(read).returns.resolves.toEqualTypeOf<FetchAllRowsResult<{ id: number; group: string }>>()

    // @ts-expect-error orderBy is required
    void (() => fetchAllRows(() => supabase.from('items').select('id')))
    // @ts-expect-error .single() resolves to one row, not a page of rows
    void (() => fetchAllRows(() => supabase.from('items').select('id').single(), { orderBy: 'id' }))
  })
})
