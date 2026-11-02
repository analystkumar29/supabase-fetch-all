/**
 * Read every row of a Supabase table with supabase-js and fetchAllRows.
 *
 * It only reads. Point it at a table with more than 1,000 rows, such as the
 * `events` table from the README:
 *
 *   SUPABASE_URL=https://<project>.supabase.co SUPABASE_KEY=<anon or publishable key> npx tsx examples/basic.ts
 *
 * Row Level Security still applies: you only see the rows your key may read.
 */
import { createClient } from '@supabase/supabase-js'
// In your own project: import { fetchAllRows, FetchAllRowsError } from 'supabase-fetch-all'
import { fetchAllRows, FetchAllRowsError } from '../src/index.js'

type Event = { id: number; kind: string }

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_KEY
if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_KEY first.')
  process.exit(1)
}

const supabase = createClient(url, key)

// The bug: one request, no error, and at most 1,000 rows however many exist.
const naive = await supabase.from('events').select('id, kind').limit(5000)
console.log(`.limit(5000) returned ${naive.data?.length ?? 0} rows, error: ${naive.error?.message ?? 'none'}`)

// The fix: page through in a stable order, then double-check the total.
try {
  const { rows, pages } = await fetchAllRows<Event>(() => supabase.from('events').select('id, kind'), {
    orderBy: 'id',
    verifyCount: () => supabase.from('events').select('*', { count: 'exact', head: true }),
  })
  console.log(`fetchAllRows read ${rows.length} rows in ${pages} pages, and the count query agrees`)
} catch (error) {
  if (!(error instanceof FetchAllRowsError)) throw error
  console.error(`${error.code}: ${error.message}`)
  process.exitCode = 1
}
