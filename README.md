# supabase-fetch-all

Read every row of a Supabase query, including the rows past the 1,000-row limit that the API applies without telling you.

```ts
const { rows } = await fetchAllRows(() => supabase.from('events').select('id, kind'), { orderBy: 'id' })
```

## The problem

One of my tables grew past 1,000 rows, and every "read all" quietly stopped at 1,000. Supabase's REST layer (PostgREST) caps every response at its max rows setting, 1,000 by default, and returns no error or warning when it does. Asking for more with `.limit(5000)` or `.range(0, 4999)` still gets exactly 1,000 rows, so a cut-off read looks identical to a complete one. This package reads the rows one page at a time in a stable order, and throws when it can't be sure it got all of them.

The cap is the **Max rows** setting in your Supabase project's API settings (`max_rows` in `supabase/config.toml` locally, `db-max-rows` on self-hosted PostgREST). Raising it only moves the cliff further out.

## Reproduce it

In a scratch Supabase project, create a table with 2,350 rows in the SQL editor:

```sql
create table events (
  id bigint generated always as identity primary key,
  kind text not null
);
insert into events (kind) select 'demo' from generate_series(1, 2350);

alter table events enable row level security;
create policy "anyone can read events" on events for select using (true);
```

Then ask for all of them three different ways:

```ts
const plain = await supabase.from('events').select('id')
const limited = await supabase.from('events').select('id').limit(5000)
const ranged = await supabase.from('events').select('id').range(0, 4999)

console.log(plain.data?.length, limited.data?.length, ranged.data?.length) // 1000 1000 1000
console.log(plain.error, limited.error, ranged.error) // null null null
```

With this package:

```ts
const { rows, pages } = await fetchAllRows(() => supabase.from('events').select('id'), { orderBy: 'id' })
console.log(rows.length, pages) // 2350 3
```

The tests reproduce the same behaviour without a network: see "the bug, reproduced by the fake server" in [`test/fetch-all-rows.test.ts`](test/fetch-all-rows.test.ts).

## Install

It isn't on npm yet. Install it from GitHub (npm builds it during the install):

```bash
npm install github:analystkumar29/supabase-fetch-all
```

It has no runtime dependencies. It works with `@supabase/supabase-js` v2 queries (the tests use 2.118) but doesn't import supabase-js: any query builder with `.order()` and `.range()` that resolves to `{ data, error }` will do. The package runs on Node 20 and newer; current supabase-js needs Node 22 or newer.

## Usage

```ts
import { createClient } from '@supabase/supabase-js'
import { fetchAllRows, FetchAllRowsError } from 'supabase-fetch-all'

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_KEY!)

try {
  const { rows, pages } = await fetchAllRows(
    // Build the query: select and filters, but no .range(). fetchAllRows adds the paging.
    () => supabase.from('events').select('id, kind').eq('kind', 'demo'),
    {
      orderBy: 'id', // a column with unique values; the primary key is best
      // Optional: count with the same filters and throw if the totals disagree.
      verifyCount: () => supabase.from('events').select('*', { count: 'exact', head: true }).eq('kind', 'demo'),
    },
  )
  console.log(`${rows.length} rows in ${pages} pages`)
} catch (error) {
  if (error instanceof FetchAllRowsError) console.error(error.code, error.message, error.cause)
  throw error
}
```

If you use generated types (`supabase gen types typescript`), `rows` is typed from your select string. Without them, pass the row type yourself: `fetchAllRows<MyRow>(...)`. A runnable script is in [`examples/basic.ts`](examples/basic.ts).

## API

### `fetchAllRows(makeQuery, options)`

Returns `Promise<{ rows, pages, truncated }>`.

| Parameter | Type | Default | What it does |
| --- | --- | --- | --- |
| `makeQuery` | `() => query` | required | Builds a new query for each page: `.select()` plus any filters, but no `.range()`. It may include its own `.order()`; `orderBy` is added after it. |
| `options.orderBy` | `string` | required | A column with unique values, usually the primary key. Added as the last `.order()` on every page. |
| `options.pageSize` | `number` | `1000` | Rows to ask for per request. |
| `options.maxRows` | `number` | `100000` | The most rows to read. `Infinity` turns the limit off. |
| `options.onTruncated` | `'throw'` or `'return'` | `'throw'` | What to do when more than `maxRows` rows match. |
| `options.verifyCount` | `() => countQuery` | none | A count query with the same filters, built with `select('*', { count: 'exact', head: true })`. It runs once after the pages; fetchAllRows throws if the count differs from the rows read. |

| Result field | Type | Meaning |
| --- | --- | --- |
| `rows` | `Row[]` | Every matching row, in order. |
| `pages` | `number` | Page requests made. The `verifyCount` query isn't counted. |
| `truncated` | `boolean` | `true` only with `onTruncated: 'return'`, when more than `maxRows` rows matched. |

### `FetchAllRowsError`

Thrown whenever fetchAllRows can't promise that it read every row. `error.code` is one of:

| Code | When |
| --- | --- |
| `QUERY_FAILED` | A page or the count query returned an error (the original PostgREST error is on `error.cause`), or a page didn't return a list of rows. |
| `TRUNCATED` | More than `maxRows` rows match and `onTruncated` is `'throw'`. |
| `COUNT_MISMATCH` | The `verifyCount` query's count differs from the number of rows read, or it returned no count. |

Invalid options throw a `TypeError` or `RangeError` before any request is sent. If your query throws by itself (for example with `.throwOnError()`), that exception passes through unchanged.

The exported types are `FetchAllRowsOptions`, `FetchAllRowsResult<Row>`, `FetchAllRowsErrorCode`, `PageableQuery<Row>`, `PageResponse<Row>` and `CountResponse`.

## How it works

The whole thing is one loop in [`src/index.ts`](src/index.ts):

1. Build a new query with `makeQuery()`, then add `.order(orderBy)` and `.range(from, from + pageSize - 1)`.
2. If PostgREST returned an error, throw it.
3. Add the page's rows to the result.
4. A full page means there may be more rows, so the next page starts right after the rows read so far. An empty page, or a short page after a full one, means that was the end. A short *first* page gets one more request to be sure (see the design decisions below).
5. Stop as soon as more than `maxRows` rows have been read. Reading one page past the limit is how it knows the result would be truncated.
6. If `verifyCount` was given, run it and compare.

## Design decisions

**Why a function instead of a query.** A supabase-js query builder changes in place when you call `.order()` or `.range()` on it, so the same builder can't be reused for page two. Calling `makeQuery()` gives me a fresh one for every page.

**Why `orderBy` is required, and should be unique.** Each page is a separate SQL query with `OFFSET` and `LIMIT`. Postgres only promises the order you ask for: without `ORDER BY`, or among rows that tie on the sort column, two queries can return rows in a different order. Then a row can land on two pages, or on none. One test orders by a column with only three distinct values; it gets the right *number* of rows, with some repeated and others missing. Ordering by the primary key makes every page boundary exact. If you want a different order, put it in `makeQuery`, and `orderBy` becomes the tie-breaker.

**Why it throws by default.** The original bug was a partial result that looked complete, so the safe default is to never hand one back silently. If more than `maxRows` rows match, if a page fails, or if the count doesn't match, you get an error instead of fewer rows. For anything that involves money, like totals, invoices or payouts, a crash that someone notices beats a wrong number that nobody does. `onTruncated: 'return'` exists for places where a partial list is fine, like a preview, and even then `truncated: true` says so.

**Why errors are thrown, not returned.** PostgREST errors are plain objects (`{ message, details, hint, code }`), and a lot of code reads `data` and never looks at `error`. When I first rolled out my own fix, one call ordered by a column that didn't exist on that table: the request failed, the error printed as `[object Object]`, and the "read all" came back with zero rows. Here the failure is a `FetchAllRowsError` whose message includes PostgREST's own message, with the original error on `.cause`.

**Why a short first page costs one more request.** A page with fewer rows than requested is normally the last page. But if the server's max rows is lower than `pageSize` (someone lowered the setting, or you passed `pageSize: 5000`), every page comes back short, and stopping there would bring the original bug back. On the first page the two cases look the same, so fetchAllRows asks once more, right after those rows, using the page size the server actually returned. An empty answer means it's done. A result of 1 to 999 rows therefore takes two requests; that's the price of never mistaking the cap for the end of the table.

**Why `verifyCount`.** It's a second check that doesn't trust the paging at all: an exact count with the same filters, compared with the number of rows read. It catches anything that loses rows without an error, including rows added or removed while reading. It's optional because an exact count is an extra query, and it can be slow on very large tables.

## Limitations

- **Offset paging slows down deep into very large tables.** Page *n* is `OFFSET n × 1000 LIMIT 1000`, and Postgres still steps over every skipped row. That's fine for thousands or tens of thousands of rows. For very large or fast-changing tables, use keyset pagination instead: remember the last id you saw and ask for the rows after it, which uses the index and can't skip rows when earlier ones are deleted. It isn't built in because it needs a single sortable, unique column, and it changes your filters.

  ```ts
  let lastId = 0
  while (true) {
    const { data, error } = await supabase.from('events').select('id, kind').gt('id', lastId).order('id').limit(1000)
    if (error) throw error
    if (data.length === 0) break
    // ...use this batch...
    lastId = data[data.length - 1].id
  }
  ```

- **The pages aren't one snapshot.** Each page is its own request and its own transaction. Rows inserted, deleted or re-sorted while you read can be skipped or read twice. `verifyCount` catches it when the total changes, but not when, say, one row is deleted and another inserted. If you need a consistent answer, do the work inside the database, for example with a view or a Postgres function that returns the total you need, instead of shipping every row to the client.
- **Everything is held in memory**, and pages are read one after another. For hundreds of thousands of rows, process them in batches (as in the keyset loop above) or move the work into SQL.
- **Testing.** The tests run against an in-memory fake of PostgREST and against the real supabase-js query builder with a fake `fetch`. They don't run against a live Supabase project.

## Running the tests

```bash
npm ci
npm test           # vitest
npm run typecheck  # tsc, including the type tests in test/supabase-js.test.ts
npm run build      # compiles src/ to dist/
```

The fake server in [`test/fake-postgrest.ts`](test/fake-postgrest.ts) caps every response at 1,000 rows whatever `.limit()` or `.range()` asks for, returns PostgREST-style errors for unknown columns, and returns rows that tie on the sort column in a different order on alternate requests. That way the tests show the bug first, then the fix. CI runs these steps on Node 20, 22 and 24. The tests that start a real supabase-js client are skipped on Node 20, because current supabase-js needs Node 22 or newer.

## License

[MIT](LICENSE) © Manoj Kumar

More about me and my work: [manojkumar-ca.vercel.app](https://manojkumar-ca.vercel.app)
