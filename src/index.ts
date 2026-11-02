/**
 * supabase-fetch-all
 *
 * Supabase's REST layer (PostgREST) never returns more rows in one response
 * than its "max rows" setting, which is 1,000 by default. It doesn't send an
 * error when it cuts a response short, and `.limit(5000)` or `.range(0, 4999)`
 * don't lift the cap. The only way past it is to ask for the rows one window
 * at a time. `fetchAllRows` does that, and it throws instead of quietly
 * returning part of the data.
 */

/** What one page request resolves to. supabase-js responses already have this shape. */
export interface PageResponse<Row> {
  data: Row[] | null
  error: unknown
}

/** What a count query resolves to, e.g. `select('*', { count: 'exact', head: true })`. */
export interface CountResponse {
  count: number | null
  error: unknown
}

/**
 * The two query-builder methods fetchAllRows calls. A supabase-js query such as
 * `supabase.from('events').select('id, kind').eq('kind', 'click')` already has
 * this shape, which is why this package doesn't depend on supabase-js.
 */
export interface PageableQuery<Row> {
  order(column: string): PageableQuery<Row>
  range(from: number, to: number): PromiseLike<PageResponse<Row>>
}

export interface FetchAllRowsOptions {
  /**
   * A column with unique values, usually the primary key. fetchAllRows adds it
   * as the last `.order()` key of every page, so rows can't swap places between
   * pages. Required: without a unique order, paging can repeat or skip rows.
   */
  orderBy: string
  /** Rows to ask for per request. Default 1000, Supabase's default max rows. */
  pageSize?: number
  /** Most rows to read in total. Default 100,000. `Infinity` turns the limit off. */
  maxRows?: number
  /**
   * What to do when more than `maxRows` rows match. `'throw'` (the default)
   * throws a FetchAllRowsError; `'return'` returns the first `maxRows` rows with
   * `truncated: true`.
   */
  onTruncated?: 'throw' | 'return'
  /**
   * A count query with the same filters, for example
   * `() => supabase.from('events').select('*', { count: 'exact', head: true })`.
   * When given, fetchAllRows runs it after reading and throws if the count
   * doesn't match the number of rows it read.
   */
  verifyCount?: () => PromiseLike<CountResponse>
}

export interface FetchAllRowsResult<Row> {
  /** Every matching row, in order. */
  rows: Row[]
  /** How many page requests were made. The verifyCount query isn't counted. */
  pages: number
  /** `true` only when onTruncated is `'return'` and more than maxRows rows matched. */
  truncated: boolean
}

export type FetchAllRowsErrorCode = 'QUERY_FAILED' | 'TRUNCATED' | 'COUNT_MISMATCH'

/** Thrown when fetchAllRows can't promise that it read every row. */
export class FetchAllRowsError extends Error {
  readonly code: FetchAllRowsErrorCode

  constructor(code: FetchAllRowsErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'FetchAllRowsError'
    this.code = code
  }
}

const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_MAX_ROWS = 100_000

/**
 * Read every row of a query, one page at a time.
 *
 * `makeQuery` must build a new query each time it's called, because a
 * supabase-js query builder is changed by every method you call on it and
 * can't be reused for the next page. Put your select and filters in it;
 * fetchAllRows adds `.order(orderBy)` and `.range(from, to)` itself.
 *
 * @example
 * const { rows } = await fetchAllRows(
 *   () => supabase.from('events').select('id, kind').eq('kind', 'click'),
 *   { orderBy: 'id' },
 * )
 */
export async function fetchAllRows<Row>(
  makeQuery: () => PageableQuery<Row>,
  options: FetchAllRowsOptions,
): Promise<FetchAllRowsResult<Row>> {
  const { orderBy, maxRows = DEFAULT_MAX_ROWS, onTruncated = 'throw', verifyCount } = options
  let pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE
  assertValidOptions(orderBy, pageSize, maxRows, onTruncated)

  const rows: Row[] = []
  let pages = 0

  // Reading up to one page past maxRows is how we find out whether more rows exist.
  while (rows.length <= maxRows) {
    const from = rows.length
    const to = from + pageSize - 1
    const { data, error } = await makeQuery().order(orderBy).range(from, to)
    pages += 1

    if (error) {
      throw new FetchAllRowsError(
        'QUERY_FAILED',
        `fetchAllRows: page ${pages} (rows ${from}-${to}) failed: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (!Array.isArray(data)) {
      throw new FetchAllRowsError(
        'QUERY_FAILED',
        `fetchAllRows: page ${pages} returned no list of rows. Don't use head: true, .single() or .maybeSingle() inside makeQuery.`,
      )
    }

    // A loop rather than rows.push(...data): spreading a very large page can overflow the call stack.
    for (const row of data) rows.push(row)

    // Three cases:
    // - A full page: there may be more rows, so keep going.
    // - An empty page, or a short page after a full one: that was the last page.
    // - A short first page: usually that's the whole result, but it's also what
    //   you'd see if the server's max rows were lower than pageSize. The two look
    //   the same, so ask once more, right after these rows, using the page size
    //   the server actually gave us. An empty answer ends the loop.
    if (data.length >= pageSize) continue
    if (data.length === 0 || pages > 1) break
    pageSize = data.length
  }

  if (rows.length > maxRows) {
    if (onTruncated === 'throw') {
      throw new FetchAllRowsError(
        'TRUNCATED',
        `fetchAllRows: more than ${maxRows} rows match, which is the maxRows limit. Narrow the query, raise maxRows, or pass onTruncated: 'return' to accept the first ${maxRows}.`,
      )
    }
    return { rows: rows.slice(0, maxRows), pages, truncated: true }
  }

  if (verifyCount) {
    const { count, error } = await verifyCount()
    if (error) {
      throw new FetchAllRowsError(
        'QUERY_FAILED',
        `fetchAllRows: the verifyCount query failed: ${errorMessage(error)}`,
        { cause: error },
      )
    }
    if (count === null) {
      throw new FetchAllRowsError(
        'COUNT_MISMATCH',
        "fetchAllRows: the verifyCount query returned no count. Pass { count: 'exact', head: true } to .select().",
      )
    }
    if (count !== rows.length) {
      throw new FetchAllRowsError(
        'COUNT_MISMATCH',
        `fetchAllRows: read ${rows.length} rows, but the count query says ${count}. The data may have changed while reading, or the two queries use different filters.`,
      )
    }
  }

  return { rows, pages, truncated: false }
}

/** PostgREST errors are plain objects ({ message, details, hint, code }), not Error instances. */
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : String(error)
}

function assertValidOptions(orderBy: unknown, pageSize: number, maxRows: number, onTruncated: unknown): void {
  if (typeof orderBy !== 'string' || orderBy.trim() === '') {
    throw new TypeError('fetchAllRows: orderBy must name a column with unique values, such as the primary key.')
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`fetchAllRows: pageSize must be a whole number of at least 1 (got ${String(pageSize)}).`)
  }
  if (maxRows !== Infinity && (!Number.isInteger(maxRows) || maxRows < 1)) {
    throw new RangeError(`fetchAllRows: maxRows must be a whole number of at least 1, or Infinity (got ${String(maxRows)}).`)
  }
  if (onTruncated !== 'throw' && onTruncated !== 'return') {
    throw new TypeError(`fetchAllRows: onTruncated must be 'throw' or 'return' (got ${String(onTruncated)}).`)
  }
}
