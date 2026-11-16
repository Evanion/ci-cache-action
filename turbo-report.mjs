// Turborepo run summaries become run reports. Turbo writes
// .turbo/runs/<id>.json when TURBO_RUN_SUMMARY=true; the post step of the
// action converts each summary written during the job and posts it to
// <server>/v1/runs, the endpoint the Nx reporter posts to. Node 20 built-ins
// only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const GITHUB_OS = { Linux: 'linux', Windows: 'windows', macOS: 'macos' };
const GITHUB_ARCH = { X64: 'x64', ARM64: 'arm64' };

const MAX_LABEL = 64;
const MAX_CPUS = 512;
// The text the server refuses in a label: controls, line separators,
// bidirectional overrides, lone surrogates and invisible characters.
const UNSAFE_LABEL = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\u200b-\\u200d\\ufeff]' +
    '|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
);

const lookup = (table, key) =>
  typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;

const isObject = (v) =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

function runnerOf(env, cpus) {
  const runner = { provider: 'github' };
  const environment = env.RUNNER_ENVIRONMENT;
  if (environment === 'github-hosted') runner.hosted = true;
  else if (environment === 'self-hosted') runner.hosted = false;
  const os = lookup(GITHUB_OS, env.RUNNER_OS);
  if (os) runner.os = os;
  const arch = lookup(GITHUB_ARCH, env.RUNNER_ARCH);
  if (arch) runner.arch = arch;
  if (Number.isInteger(cpus) && cpus >= 1 && cpus <= MAX_CPUS) {
    runner.cpus = cpus;
  }
  const label = (env.CI_CACHE_RUNNER_LABEL ?? '').trim();
  if (
    label.length >= 1 &&
    label.length <= MAX_LABEL &&
    !UNSAFE_LABEL.test(label)
  ) {
    runner.label = label;
  }
  return runner;
}

function statusOf(task) {
  const { status, source } = task.cache ?? {};
  if (status === 'HIT' && source === 'REMOTE') return 'remote-cache';
  if (status === 'HIT' && source === 'LOCAL') return 'local-cache';
  if (status === 'MISS') {
    return task.execution?.exitCode === 0 ? 'success' : 'failure';
  }
  return null;
}

/**
 * The run report for a Turbo run summary, or null when the summary has no
 * usable task or no run times. `cpus` is `os.availableParallelism()`.
 */
export function toRunReport(summary, env, cpus) {
  if (!isObject(summary) || typeof summary.id !== 'string') return null;
  const run = summary.execution;
  if (!isObject(run) || !isTime(run.startTime) || !isTime(run.endTime)) {
    return null;
  }
  const tasks = [];
  for (const t of Array.isArray(summary.tasks) ? summary.tasks : []) {
    if (!isObject(t)) continue;
    const { startTime, endTime } = isObject(t.execution) ? t.execution : {};
    if (!isTime(startTime) || !isTime(endTime)) continue;
    const status = statusOf(t);
    if (status === null) continue;
    tasks.push({
      hash: t.hash,
      project: t.package,
      target: t.task,
      status,
      startTime,
      endTime,
      cacheable: t.resolvedTaskDefinition?.cache !== false,
    });
  }
  if (tasks.length === 0) return null;
  return {
    runId: summary.id,
    startTime: run.startTime,
    endTime: run.endTime,
    ci: true,
    tool: 'turbo',
    runner: runnerOf(env, cpus),
    tasks,
  };
}

const MAX_FILES = 20;
const MAX_DEPTH = 4;
const POST_TIMEOUT_MS = 15_000;

/** Every `.turbo/runs/*.json` within four directories of `root`, with its mtime. */
function summaryFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const path = join(dir, e.name);
      if (e.name === '.turbo') {
        try {
          for (const f of readdirSync(join(path, 'runs'))) {
            if (!f.endsWith('.json')) continue;
            const file = join(path, 'runs', f);
            found.push({ file, name: f, mtimeMs: statSync(file).mtimeMs });
          }
        } catch {
          // No runs directory, or a file that vanished.
        }
      } else if (
        e.name !== 'node_modules' &&
        e.name !== '.git' &&
        depth < MAX_DEPTH
      ) {
        walk(path, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * Posts a report for each summary Turbo wrote after the marker file was
 * created, oldest first. Nothing here throws: a failure prints one warning.
 */
export async function postTurboReports({
  env,
  cpus,
  marker,
  log = console.log,
  fetchFn = fetch,
}) {
  const token = env.TURBO_TOKEN;
  // In write mode TURBO_TOKEN is a one-hour OIDC token; a job that ran longer
  // gets a 401 with it, and the project's read token still reports.
  const readToken = (
    env.INPUT_READ_TOKEN ??
    env['INPUT_READ-TOKEN'] ??
    ''
  ).trim();
  const fallback = readToken !== '' && readToken !== token ? readToken : null;
  const warn = (name, reason) => {
    const safe = oneLine(
      [token, fallback].reduce(
        (text, secret) => (secret ? text.split(secret).join('***') : text),
        reason,
      ),
    );
    log(`::warning::ci-cache: run report not sent: ${name}: ${safe}`);
  };
  let since;
  try {
    since = statSync(marker).mtimeMs;
  } catch {
    return;
  }
  const server = (env.INPUT_SERVER ?? '').trim().replace(/\/+$/, '');
  const files = summaryFiles(env.GITHUB_WORKSPACE ?? process.cwd())
    .filter((f) => f.mtimeMs > since)
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
    .slice(0, MAX_FILES);
  for (const { file, name } of files) {
    try {
      let summary;
      try {
        summary = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        warn(name, 'not valid JSON');
        continue;
      }
      const report = toRunReport(summary, env, cpus);
      if (report === null) {
        warn(name, 'no task with a start and end time');
        continue;
      }
      if (server === '') {
        warn(name, 'the server input is empty');
        continue;
      }
      const body = JSON.stringify(report);
      const postWith = (bearer) =>
        fetchFn(`${server}/v1/runs`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/json',
          },
          body,
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
      let res = await postWith(token);
      if (res.status === 401 && fallback !== null) {
        res = await postWith(fallback);
      }
      if (!res.ok) warn(name, `server answered ${res.status}`);
    } catch (error) {
      warn(name, error instanceof Error ? error.message : String(error));
    }
  }
}
