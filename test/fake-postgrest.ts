/**
 * A tiny in-memory stand-in for one Supabase/PostgREST table, used by the tests.
 * It copies the behaviour that matters here and nothing else:
 *
 * - Every response holds at most `maxRows` rows (1,000 by default, like Supabase),
 *   whatever .limit() or .range() asked for, and nothing in the response says
 *   it was cut short.
 * - Ordering or filtering by a column that doesn't exist returns a
 *   PostgREST-style error object instead of rows.
 * - Postgres doesn't promise any order for rows that tie on the sort key. The
 *   fake imitates that by reversing the table on every other request before
 *   sorting: a unique sort column hides it completely, a column with ties
 *   doesn't.
 * - `select('*', { count: 'exact', head: true })` returns a count and no rows.
 * - Like supabase-js, a query builder is changed in place by .eq(), .order(),
 *   .limit() and .range(), and only runs when it's awaited.
 *
 * Two ways in: `db.from(table)` is a hand-written query builder, and
 * `fakeFetch(db)` is a `fetch` you can give to the real supabase-js client.
 */

export type Row = Record<string, string | number>

export interface FakeError {
  code: string
  message: string
  details: string | null
  hint: string | null
}

export interface FakeResponse<T> {
  data: T[] | null
  error: FakeError | null
  count: number | null
  status: number
  statusText: string
}

/** One request that read rows: where it started, how many it asked for, how many came back. */
export interface LoggedRequest {
  offset: number
  limit: number | null
  returned: number
}

interface QueryState {
  table: string
  filters: Array<{ column: string; value: string | number }>
  orders: Array<{ column: string; ascending: boolean }>
  offset: number
  limit: number | null
  count: boolean
  head: boolean
}

export class FakeSupabase<T extends Row> {
  /** Every request that read rows, in order. Count-only (head) requests aren't logged. */
  readonly requests: LoggedRequest[] = []
  private requestCount = 0
  private readonly failures = new Map<number, FakeError>()

  constructor(
    private readonly table: { name: string; columns: readonly string[]; rows: T[] },
    /** The server-side cap: PostgREST's max rows setting. */
    readonly maxRows = 1000,
  ) {}

  from(table: string) {
    return {
      select: (_columns = '*', options: { count?: 'exact'; head?: boolean } = {}) =>
        new FakeQuery(this, {
          table,
          filters: [],
          orders: [],
          offset: 0,
          limit: null,
          count: options.count === 'exact',
          head: options.head === true,
        }),
    }
  }

  /** Make request number `n` (counting from 1) fail, e.g. to simulate a timeout halfway through. */
  failRequest(n: number, error: FakeError): void {
    this.failures.set(n, error)
  }

  /** Answer a query the way PostgREST would. */
  run(query: QueryState): FakeResponse<T> {
    this.requestCount += 1
    const injected = this.failures.get(this.requestCount)
    if (injected) return failure(injected)

    if (query.table !== this.table.name) {
      return failure({ code: '42P01', message: `relation "public.${query.table}" does not exist`, details: null, hint: null })
    }
    const missing = [...query.filters, ...query.orders].find(({ column }) => !this.table.columns.includes(column))
    if (missing) {
      return failure({ code: '42703', message: `column ${query.table}.${missing.column} does not exist`, details: null, hint: null })
    }

    const matching = this.table.rows.filter((row) =>
      query.filters.every(({ column, value }) => String(row[column]) === String(value)),
    )
    const count = query.count ? matching.length : null
    if (query.head) return { data: null, error: null, count, status: 200, statusText: 'OK' }

    // No promised order for ties: start from a different order on every other request.
    const start = this.requestCount % 2 === 0 ? [...matching].reverse() : [...matching]
    const sorted = start.sort((a, b) => compareRows(a, b, query.orders))

    // The server-side cap. The request's own limit only matters when it's smaller.
    const limit = Math.min(query.limit ?? Infinity, this.maxRows)
    const data = sorted.slice(query.offset, query.offset + limit)
    this.requests.push({ offset: query.offset, limit: query.limit, returned: data.length })
    return { data, error: null, count, status: 200, statusText: 'OK' }
  }
}

class FakeQuery<T extends Row> implements PromiseLike<FakeResponse<T>> {
  constructor(
    private readonly db: FakeSupabase<T>,
    private readonly state: QueryState,
  ) {}

  eq(column: string, value: string | number): this {
    this.state.filters.push({ column, value })
    return this
  }

  order(column: string, { ascending = true }: { ascending?: boolean } = {}): this {
    this.state.orders.push({ column, ascending })
    return this
  }

  limit(count: number): this {
    this.state.limit = count
    return this
  }

  range(from: number, to: number): this {
    this.state.offset = from
    this.state.limit = to - from + 1
    return this
  }

  then<A = FakeResponse<T>, B = never>(
    onfulfilled?: ((value: FakeResponse<T>) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    // Answer on a later tick, like a real network request.
    return Promise.resolve()
      .then(() => this.db.run(this.state))
      .then(onfulfilled, onrejected)
  }
}

/**
 * A `fetch` that answers supabase-js requests from a FakeSupabase. It reads the
 * same URL parameters PostgREST does (select, order, offset, limit, column=eq.value)
 * and the `Prefer: count=exact` header, so the real query builder can be tested
 * without a network.
 */
export function fakeFetch<T extends Row>(db: FakeSupabase<T>): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const params = url.searchParams
    const reserved = new Set(['select', 'order', 'offset', 'limit'])

    const filters = [...params]
      .filter(([key]) => !reserved.has(key))
      .map(([column, condition]) => {
        if (!condition.startsWith('eq.')) throw new Error(`fakeFetch only supports eq filters, got ${column}=${condition}`)
        return { column, value: condition.slice('eq.'.length) }
      })
    const orders = (params.get('order') ?? '')
      .split(',')
      .filter(Boolean)
      .map((part) => {
        const [column = '', direction] = part.split('.')
        return { column, ascending: direction !== 'desc' }
      })
    const offset = Number(params.get('offset') ?? 0)
    const prefer = new Headers(init?.headers).get('Prefer') ?? ''

    const result = db.run({
      table: url.pathname.split('/').pop() ?? '',
      filters,
      orders,
      offset,
      limit: params.has('limit') ? Number(params.get('limit')) : null,
      count: prefer.includes('count=exact'),
      head: init?.method === 'HEAD',
    })

    const total = result.count ?? '*'
    const rows = result.data?.length ?? 0
    const headers = {
      'Content-Type': 'application/json',
      'Content-Range': rows > 0 ? `${offset}-${offset + rows - 1}/${total}` : `*/${total}`,
    }
    const body = init?.method === 'HEAD' ? null : JSON.stringify(result.error ?? result.data)
    return new Response(body, { status: result.status, statusText: result.statusText, headers })
  }
}

function failure<T>(error: FakeError): FakeResponse<T> {
  return { data: null, error, count: null, status: 400, statusText: 'Bad Request' }
}

function compareRows(a: Row, b: Row, orders: QueryState['orders']): number {
  for (const { column, ascending } of orders) {
    const x = a[column]
    const y = b[column]
    if (x === y) continue
    const result = typeof x === 'number' && typeof y === 'number' ? x - y : String(x) < String(y) ? -1 : 1
    return ascending ? result : -result
  }
  return 0
}
