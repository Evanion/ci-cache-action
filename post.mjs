// Post step of the setup action, run at the end of the job. It stops the
// gateway, copies its "not cached" lines into this step's summary and the
// job log, and copies its failed and stalled requests into the job log: a
// background process's own output reaches neither. Node 20 built-ins only.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.RUNNER_TEMP ?? '';
const read = (name) => {
  try {
    return readFileSync(join(dir, name), 'utf8');
  } catch {
    return null;
  }
};

const pid = Number(read('ci-cache-gateway.pid'));
if (Number.isSafeInteger(pid) && pid > 0) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // Already gone.
  }
}

const log = (read('ci-cache-gateway.log') ?? '').split('\n');
const lines = log.filter((l) => / not cached: /.test(l));
for (const line of lines) console.log(`::warning::${line}`);

// Requests the cache server did not answer, or stopped answering. Each one
// cost Nx a cache read or write; a run full of them points at the network
// between the runner and the server.
const MAX_FAILED = 20;
const failed = log.filter((l) => / (failed|stalled): /.test(l));
for (const line of failed.slice(0, MAX_FAILED)) {
  console.log(`::warning::${line}`);
}
if (failed.length > MAX_FAILED) {
  console.log(
    `::warning::ci-cache gateway: ${failed.length - MAX_FAILED} more requests to the cache server failed or stalled (log: ${join(dir, 'ci-cache-gateway.log')})`,
  );
}
if (lines.length > 0 && process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### CI cache: artifacts not cached',
      '',
      ...lines.map((l) => `- \`${l.replace(/`/g, "'")}\``),
      '',
    ].join('\n'),
  );
}
