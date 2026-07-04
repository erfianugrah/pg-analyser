#!/usr/bin/env bash
# sbperf work profile: load the gitignored customer-audit config (no-PAT +
# self-hosted Grafana + customer connstrings) and run sbperf with it.
#
#   ./work.sh full                 # sweep every db-url in the profile
#   ./work.sh full --ref <label>   # single project
#   ./work.sh analyze --ref <label>
#
# The profile is sourced with `set -a` so its assignments EXPORT and override
# your personal .env (Bun won't override an already-set env var). SBPERF_NO_PAT
# in the profile forces the personal CLI token to be ignored. Override the
# profile path with SBPERF_PROFILE=<file>.
set -euo pipefail
cd "$(dirname "$0")"

PROFILE="${SBPERF_PROFILE:-sbperf.work.env}"
if [[ ! -f "$PROFILE" ]]; then
  echo "sbperf work profile not found: $PROFILE" >&2
  echo "copy sbperf.work.env.example to $PROFILE and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$PROFILE"
set +a

exec bun run src/index.ts "$@"
