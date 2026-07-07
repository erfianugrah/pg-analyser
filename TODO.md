# TODO

The shipped feature state is documented in `AGENTS.md` (architecture, SQL tiers,
no-PAT mode, verified upstream facts) and the finding catalog in
`docs/heuristics.md`; the commit history is the changelog. This file tracks only
what is still open or deliberately out of scope.

## Open / ideas
Nothing outstanding from the planned backlog.

## Deferred (needs a precondition)
- Richer disk/IO beyond IOPS (latency, queue depth) - needs sustained snapshot
  history to be meaningful, so it waits on a store with real depth.

## Deliberately not doing (rationale, so it isn't re-litigated)
- **Gatekeeper transport** - removed; direct (PAT) transport only.
- **Remote push / running CI** - staying local by choice; the workflows remain
  in-repo for if that ever changes.
- **Wrapping `supabase inspect report`** - it dumps CSV of every inspect command
  (future-proof against new ones) but requires a DB connection string
  (`--db-url` / `--linked` = a password). sbperf's thesis is PAT-first via the
  read-only SQL runner, so we curate our own query set instead. The drift risk
  is covered by `scripts/check-api-drift.ts` (endpoints) and
  `scripts/check-inspect-drift.ts` (derived inspect queries) against upstream -
  no manual tracking, no CLI runtime dependency.
- **Verbatim-vendoring the CLI inspect SQL** - proven not achievable (the inspect
  queries use `LIKE ANY($1)` bind params the PAT read-only endpoint can't bind,
  and our findings need raw columns the CLI wraps in `pg_size_pretty()`). We keep
  our tested queries and let the advisory drift check nudge a re-review when
  upstream changes.
