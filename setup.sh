#!/usr/bin/env bash
# Exports the CI cache env vars for the build tool to $GITHUB_ENV.
# Run by main.mjs. Inputs (env): INPUT_TOOL, INPUT_SERVER, INPUT_READ_TOKEN.
# Only tool nx is supported, so the exports are Nx's. Uses a 1-hour write
# token from the server's GitHub OIDC exchange when the job has an OIDC token
# and the server says the run may write, else the read token.
# A pull_request run's write token is confined to that PR's namespace (pr-<n>).
# It starts gateway.mjs on 127.0.0.1 and points Nx at it. The gateway turns a
# request the server stops answering into a miss, so Nx never waits on it
# until the job times out, and in write mode sends an artifact over
# Cloudflare's 100 MB body limit straight to R2. A server that does not answer
# at setup, or a gateway that does not start, turns the remote cache off for
# the run: the job builds everything itself.
# Optional input (env): INPUT_LARGE_UPLOAD_THRESHOLD, bytes, default 95 MiB.
# CI_CACHE_NODE (env, set by main.mjs): the node binary that runs the gateway.
set -euo pipefail

TOKEN_RE='^nxc_[A-Za-z0-9_-]{43}$'
JWT_RE='^[A-Za-z0-9._-]+$'
NAMESPACE_RE='^pr-[1-9][0-9]{0,9}$'
SERVER_RE='^(https://[A-Za-z0-9.-]+|http://(localhost|127\.0\.0\.1))(:[0-9]+)?$'

# The tool check runs before anything else, so a reserved or unknown tool fails
# the step even in a run without a read token.
tool="${INPUT_TOOL:-}"
tool="${tool#"${tool%%[![:space:]]*}"}"
tool="${tool%"${tool##*[![:space:]]}"}"
case "${tool:-nx}" in
nx) ;;
turbo)
  echo "::error::tool 'turbo' is not supported yet (Evanion/cache#149)" >&2
  exit 1
  ;;
generic)
  echo "::error::tool 'generic' is not supported yet (Evanion/cache#159)" >&2
  exit 1
  ;;
*)
  echo "::error::tool must be nx" >&2
  exit 1
  ;;
esac

server="${INPUT_SERVER:-}"
read_token="${INPUT_READ_TOKEN:-}"
threshold="${INPUT_LARGE_UPLOAD_THRESHOLD:-99614720}"
action_dir="${GITHUB_ACTION_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

if [[ -z "$read_token" ]]; then
  echo "::warning::read-token is empty (fork PR or Dependabot run?). Remote cache is disabled for this run."
  exit 0
fi
if [[ ! "$read_token" =~ $TOKEN_RE ]]; then
  echo "::error::read-token is not a valid cache token." >&2
  exit 1
fi
echo "::add-mask::$read_token"

if [[ -z "$server" ]]; then
  echo "::error::server is empty. Pass the 'server' input (for example vars.CI_CACHE_SERVER)." >&2
  exit 1
fi
server="${server%/}"
if [[ ! "$server" =~ $SERVER_RE ]]; then
  echo "::error::server must be an https origin without path, for example https://cache.example.com." >&2
  exit 1
fi

token="$read_token"
mode="read"
# Set when a request to the server got no answer: curl failed to connect or
# hit --max-time.
unreachable=""
# For a request to the server that gets no answer, curl writes how far it got
# to stderr, which goes to this file: DNS, connect, TLS and first-byte times in
# seconds from the start (0 for a step it never finished) and the address. The
# log line then says which step went silent.
times_file="${RUNNER_TEMP:-/tmp}/ci-cache-curl-times"
CURL_TIMES='%{stderr}dns %{time_namelookup} s, connect %{time_connect} s, tls %{time_appconnect} s, first byte %{time_starttransfer} s, remote %{remote_ip}'

# Why a request to the server got no answer: curl's exit code (6 DNS, 7
# connect, 28 timeout, 35 TLS), how far it got, and when.
no_answer() {
  local rc="$1" times=""
  [[ -f "$times_file" ]] && times="$(tr -d '\n' <"$times_file")"
  [[ "$times" == *"remote " ]] && times+="none"
  echo "curl exit $rc, ${times:-no timings}, at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

exchange() {
  local id_json jwt audience resp code body err

  echo "::add-mask::$ACTIONS_ID_TOKEN_REQUEST_TOKEN"
  audience="$(jq -rn --arg s "$server" '$s | @uri')"
  # Header and body go through stdin so no token appears in a process argv.
  id_json="$(printf 'Authorization: bearer %s\n' "$ACTIONS_ID_TOKEN_REQUEST_TOKEN" |
    curl -sf --max-time 15 -H @- \
      "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=$audience")" || {
    echo "OIDC: id token request failed"
    return 1
  }
  jwt="$(jq -r '.value // empty' <<<"$id_json" 2>/dev/null || true)"
  if [[ ! "$jwt" =~ $JWT_RE ]]; then
    echo "OIDC: id token response was not a token"
    return 1
  fi
  echo "::add-mask::$jwt"

  resp="$(JWT="$jwt" jq -n '{token: env.JWT}' |
    curl -s --max-time 15 -w "\n%{http_code}$CURL_TIMES" -X POST \
      -H 'Content-Type: application/json' --data @- \
      "$server/v1/oidc/github" 2>"$times_file")" || {
    echo "OIDC: exchange request failed ($(no_answer $?))"
    unreachable=1
    return 1
  }
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"

  if [[ "$code" != "200" ]]; then
    err="$(jq -r '.error // empty' <<<"$body" 2>/dev/null || true)"
    [[ "$err" =~ ^[a-z0-9-]{1,64}$ ]] || err="unknown"
    echo "OIDC: exchange refused (HTTP $code, $err)"
    return 1
  fi

  new_token="$(jq -r '.token // empty' <<<"$body" 2>/dev/null || true)"
  if [[ ! "$new_token" =~ $TOKEN_RE ]]; then
    echo "OIDC: exchange returned a malformed token"
    return 1
  fi
  # null for a shared token; pr-<n> for a pull request's namespaced one.
  new_namespace="$(jq -r 'if .namespace == null then "" elif (.namespace | type) == "string" then .namespace else "invalid" end' <<<"$body" 2>/dev/null || echo invalid)"
  if [[ -n "$new_namespace" && ! "$new_namespace" =~ $NAMESPACE_RE ]]; then
    echo "OIDC: exchange returned a malformed namespace"
    return 1
  fi
  echo "::add-mask::$new_token"
}

# Asks the server whether this run would get a write token: the shared cache
# for push, workflow_dispatch and schedule runs on the default branch or a
# branch the project trusts, the PR namespace for pull_request runs on
# refs/pull/<n>/merge. The rule lives only on the server; asking first keeps
# routine refusals out of its audit log. A server without the check (404)
# gets the exchange, which decides the same way.
uri() { jq -rn --arg v "$1" '$v | @uri'; }

eligible() {
  local resp code body answer
  # The read token goes through stdin so it never appears in a process argv.
  resp="$(printf 'Authorization: Bearer %s\n' "$read_token" |
    curl -s --max-time 15 -w "\n%{http_code}$CURL_TIMES" -H @- \
      "$server/v1/oidc/github/eligibility?event=$(uri "${GITHUB_EVENT_NAME:-}")&ref=$(uri "${GITHUB_REF:-}")&ref_type=$(uri "${GITHUB_REF_TYPE:-}")" 2>"$times_file")" || {
    echo "OIDC: eligibility check failed ($(no_answer $?))"
    unreachable=1
    return 1
  }
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  case "$code" in
  200) ;;
  404) return 0 ;;
  *)
    echo "OIDC: eligibility check failed (HTTP $code)"
    return 1
    ;;
  esac
  answer="$(jq -r 'if .eligible == true then "yes" else "no" end' <<<"$body" 2>/dev/null || echo no)"
  if [[ "$answer" != "yes" ]]; then
    echo "OIDC: this ${GITHUB_EVENT_NAME:-} run on ${GITHUB_REF:-} is not trusted for writes"
    return 1
  fi
}

new_token=""
new_namespace=""
if [[ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" && -n "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]] && eligible; then
  if exchange; then
    token="$new_token"
    mode="write"
    if [[ -n "$new_namespace" ]]; then
      mode="write ($new_namespace)"
    fi
  fi
fi

# Exports nothing, so Nx runs without a remote cache.
cache_off() {
  echo "$1 Remote cache is off for this run."
  echo "CI cache mode: off"
  exit 0
}

if [[ -n "$unreachable" ]]; then
  cache_off "::warning::The CI cache server $server did not answer within 15 s."
fi

if [[ ! "$threshold" =~ ^[1-9][0-9]{0,15}$ ]]; then
  echo "::warning::large-upload-threshold must be a byte count, for example 99614720. Using 99614720."
  threshold=99614720
fi

# Starts the gateway in the background and sets gateway_server to its origin.
# It gets no token: the environment loses the read token and the OIDC request
# token, and it forwards the Authorization header Nx sends. In read mode it
# answers cache writes itself, since the read token may not write.
start_gateway() {
  local dir="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
  local port_file="$dir/ci-cache-gateway.port"
  local log="$dir/ci-cache-gateway.log"
  local pid_file="$dir/ci-cache-gateway.pid"
  local read_only=""
  local pid port i

  [[ "$mode" == write* ]] || read_only=1
  rm -f "$port_file"
  CI_CACHE_GATEWAY_UPSTREAM="$server" \
    CI_CACHE_GATEWAY_THRESHOLD="$threshold" \
    CI_CACHE_GATEWAY_PORT_FILE="$port_file" \
    CI_CACHE_GATEWAY_READ_ONLY="$read_only" \
    nohup env -u INPUT_READ_TOKEN -u ACTIONS_ID_TOKEN_REQUEST_TOKEN \
    -u ACTIONS_ID_TOKEN_REQUEST_URL \
    "${CI_CACHE_NODE:-node}" "$action_dir/gateway.mjs" </dev/null >"$log" 2>&1 &
  pid=$!
  # post.mjs stops the gateway at the end of the job.
  printf '%s' "$pid" >"$pid_file"
  # Up to 5 s for the port file; a gateway that exits stops the wait early.
  for ((i = 0; i < 50; i++)); do
    [[ -s "$port_file" ]] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  port="$(cat "$port_file" 2>/dev/null || true)"
  if [[ ! "$port" =~ ^[1-9][0-9]{0,4}$ ]]; then
    kill "$pid" 2>/dev/null || true
    cache_off "::warning::ci-cache gateway did not start (log: $log)."
  fi
  gateway_server="http://127.0.0.1:$port"
}

gateway_server=""
start_gateway

{
  echo "NX_SELF_HOSTED_REMOTE_CACHE_SERVER=$gateway_server"
  echo "NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN=$token"
} >>"$GITHUB_ENV"

echo "CI cache mode: $mode"
if [[ "$mode" == write* ]]; then
  echo "CI cache large uploads: via gateway"
fi
