#!/usr/bin/env node
// Local gateway between Nx or Turborepo and the cache Worker. Cloudflare's edge
// refuses a request body over 100 MB with 413 before the Worker runs, and Nx
// fails the task on a 413 (Turborepo logs a failed upload and skips it). So a
// PUT over the threshold goes through an upload slot straight to R2; every
// other request is proxied unchanged.
//
// Env: CI_CACHE_GATEWAY_UPSTREAM (Worker origin), CI_CACHE_GATEWAY_THRESHOLD
// (bytes), CI_CACHE_GATEWAY_PORT_FILE (receives the bound port),
// CI_CACHE_GATEWAY_CONTROL_TIMEOUT_MS (optional, default 30000),
// CI_CACHE_GATEWAY_READ_ONLY ("1" in read mode). It logs to
// stderr; the action's post step copies the "not cached" lines into the job.
//
// Toward Nx a failure of the gateway's own is a 404 (a miss) for a read and a
// 403 for a write, both of which Nx lets pass, or a 409 for "already cached".
// Never 413, 429, 5xx or a reset: Nx retries or fails on those and then fails
// the CI task. Node 20 built-ins only.
//
// Turborepo (/v8/artifacts/:hash) gets its own answers: a write refused in
// read mode is 403 with a JSON error body, which makes Turbo stop uploading
// for the rest of the run; any other write failure is 400, which Turbo logs
// for that one upload; a stored or already-stored large upload is 202. A read
// failure is 404, as for Nx.
import { renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const env = process.env;
const upstream = new URL(env.CI_CACHE_GATEWAY_UPSTREAM ?? '');
const threshold = Number(env.CI_CACHE_GATEWAY_THRESHOLD ?? 99614720);
const controlTimeoutMs = Number(
  env.CI_CACHE_GATEWAY_CONTROL_TIMEOUT_MS ?? 30000,
);
const portFile = env.CI_CACHE_GATEWAY_PORT_FILE;
// A read token may not write: a cache PUT gets its 403 here, so the body
// never crosses the network and one over 100 MB never meets Cloudflare's 413.
const readOnly = env.CI_CACHE_GATEWAY_READ_ONLY === '1';

const HASH_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CACHE_PUT_RE = /^\/(v1\/cache|v8\/artifacts)\/([^/?]*)(?:\?.*)?$/;
// The x-artifact-* request headers Turbo sends, as the slot request's `meta`.
const META_HEADERS = {
  duration: 'x-artifact-duration',
  tag: 'x-artifact-tag',
  sha: 'x-artifact-sha',
  dirtyHash: 'x-artifact-dirty-hash',
};
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

const clientFor = (url) => (url.protocol === 'https:' ? https : http);

const forwardable = (headers) => {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
      out[name] = value;
    }
  }
  return out;
};

/** One line in the gateway log; post.mjs copies the "not cached" ones into the job. */
const warn = (line) => process.stderr.write(`${line}\n`);

/** A short reason for the log: a system error code, "timed out", or the message. */
const reasonOf = (error) => {
  if (error?.name === 'TimeoutError') return 'timed out';
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.message : String(error);
};

/**
 * Resolves once the whole request body has been read. Answering before that
 * would close a connection Nx is still writing to, and Nx retries a reset.
 */
const drained = (req) =>
  new Promise((resolve) => {
    if (req.readableEnded || req.destroyed) return resolve();
    req.unpipe();
    req.on('end', resolve);
    req.on('error', resolve);
    req.on('close', resolve);
    req.resume();
  });

/** The tool a request path belongs to, or null for any other path. */
const toolOf = (url) => {
  const match = CACHE_PUT_RE.exec(url ?? '');
  return match
    ? { tool: match[1] === 'v1/cache' ? 'nx' : 'turbo', hash: match[2] }
    : null;
};

/** Turbo reads this body as a refusal it understands: {"error":{"code","message"}}. */
const turboError = (code, message) => ({ error: { code, message } });

const answer = async (req, res, status, json) => {
  await drained(req);
  if (res.headersSent) return void res.end();
  if (json === undefined) {
    res.writeHead(status, { 'content-length': '0' });
    return void res.end();
  }
  const body = JSON.stringify(json);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
};

// `forbidden` is the code that turns Turbo 2.11's uploads off for the run.
const READ_ONLY_TURBO = turboError(
  'forbidden',
  "This run's token may not write.",
);

/** Answers a write that did not happen: Turbo 400 with a reason, Nx 403. */
const answerWriteFailed = (req, res, tool, reason) =>
  tool === 'turbo'
    ? answer(
        req,
        res,
        400,
        turboError('upload_failed', `Artifact not cached: ${reason}`),
      )
    : answer(req, res, 403);

const TURBO_PATH_RE = /^\/v8\/artifacts(?:\/|$)/;

/** Answers a Turbo request whose upstream answered 5xx: reads miss, everything else is a 400 with a reason. */
const answerTurboUpstreamError = (req, res, status) => {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return answer(req, res, 404);
  }
  return answer(
    req,
    res,
    400,
    turboError(
      req.method === 'PUT' ? 'upload_failed' : 'upstream_error',
      `Cache server answered HTTP ${status}`,
    ),
  );
};

/** Answers a write the server already holds: Turbo 202, Nx 409. */
const answerExists = (req, res, tool) =>
  tool === 'turbo'
    ? answer(req, res, 202, { urls: [] })
    : answer(req, res, 409);

/**
 * The answer to a failure of the gateway's own. Nx reads a GET 404 as a miss
 * and builds the task; it fails the task on a GET 401, 403, 5xx or reset. It
 * ignores a 403 to a write.
 */
const failureStatus = (method) =>
  method === 'GET' || method === 'HEAD' ? 404 : 403;

/** Destroys `out` when Nx goes away before its response is finished. */
const dropWithClient = (res, out) =>
  res.on('close', () => {
    if (!res.writableFinished) out.destroy(new Error('client went away'));
  });

/** Proxies one request to the Worker, streaming both bodies. */
const proxy = (req, res) => {
  const target = new URL(req.url ?? '/', upstream);
  const out = clientFor(target).request(target, {
    method: req.method,
    headers: forwardable(req.headers),
  });
  dropWithClient(res, out);
  // The socket gets the control timeout for silence in either direction: the
  // connect, a request body the Worker stops reading, the wait for response
  // headers, and a response body that stops flowing. A body that keeps
  // flowing gets no limit, however long it takes. Without this, a connection
  // the network drops silently leaves Nx waiting until the job times out.
  out.setTimeout(controlTimeoutMs, () =>
    out.destroy(new Error('upstream timeout')),
  );
  // Where a request stood when it failed, for the log: which phase went
  // silent, whether the socket was a kept-alive one from an earlier request,
  // and which address it talked to.
  let phase = 'connect';
  let socketKind = 'new';
  let remote = 'unknown';
  out.on('socket', (socket) => {
    if (out.reusedSocket) socketKind = 'reused';
    const connected = () => {
      remote = socket.remoteAddress ?? 'unknown';
      if (phase === 'connect') phase = 'request';
    };
    if (socket.connecting) socket.once('connect', connected);
    else connected();
  });
  out.on('finish', () => {
    if (phase !== 'body') phase = 'headers';
  });
  const where = () =>
    `(phase: ${phase}, socket: ${socketKind}, remote: ${remote}, at: ${new Date().toISOString()})`;
  const why = (error, silence) =>
    error?.message === 'upstream timeout'
      ? `${silence} for ${controlTimeoutMs} ms`
      : reasonOf(error);

  out.on('response', (upstreamRes) => {
    const status = upstreamRes.statusCode ?? 502;
    if (status >= 500 && TURBO_PATH_RE.test(target.pathname)) {
      // Turbo treats a 5xx as a failed build step. It reads a 404 as a miss
      // and a 400 as an upload it may drop.
      upstreamRes.resume();
      process.stderr.write(
        `ci-cache gateway: ${req.method} ${target.pathname} failed: upstream answered HTTP ${status} ${where()}\n`,
      );
      return void answerTurboUpstreamError(req, res, status);
    }
    phase = 'body';
    res.writeHead(
      upstreamRes.statusCode ?? 502,
      forwardable(upstreamRes.headers),
    );
    upstreamRes.pipe(res);
    upstreamRes.on('error', () => res.destroy());
  });
  out.on('error', (error) => {
    if (res.headersSent || res.destroyed) {
      // The response to Nx ends short: Nx gets an error for this request
      // instead of waiting until the job times out.
      if (!res.writableFinished && !res.destroyed) {
        process.stderr.write(
          `ci-cache gateway: ${req.method} ${target.pathname} stalled: ${why(error, 'no data')} ${where()}\n`,
        );
      }
      return void res.destroy();
    }
    process.stderr.write(
      `ci-cache gateway: ${req.method} ${target.pathname} failed: ${why(error, 'no answer')} ${where()}\n`,
    );
    const route = req.method === 'PUT' ? toolOf(req.url) : null;
    void (route?.tool === 'turbo'
      ? answerWriteFailed(req, res, 'turbo', why(error, 'no answer'))
      : answer(req, res, failureStatus(req.method)));
  });
  req.pipe(out);
};

/** A small JSON POST to the Worker with Nx's Authorization, under the control timeout. */
const control = (path, authorization, body) =>
  fetch(new URL(path, upstream), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(controlTimeoutMs),
  });

/** Streams the request body to a presigned URL with exactly its headers; resolves to R2's status. */
const upload = (req, res, url, headers) =>
  new Promise((resolve, reject) => {
    if (req.destroyed || res.destroyed) {
      return reject(new Error('client went away'));
    }
    const target = new URL(url);
    const out = clientFor(target).request(target, { method: 'PUT', headers });
    dropWithClient(res, out);
    out.on('response', (r2Res) => {
      r2Res.resume();
      resolve(r2Res.statusCode ?? 0);
    });
    out.on('error', reject);
    req.pipe(out);
  });

const isSlot = (v) =>
  typeof v === 'object' &&
  v !== null &&
  typeof v.url === 'string' &&
  /^https?:\/\//.test(v.url) &&
  typeof v.headers === 'object' &&
  v.headers !== null &&
  Object.values(v.headers).every((h) => typeof h === 'string');

/** A PUT over the threshold: slot, body to R2, complete. */
const largePut = async (req, res, tool, hash, size) => {
  const refuse = async (reason) => {
    warn(`ci-cache gateway: ${hash} not cached: ${reason}`);
    await answerWriteFailed(req, res, tool, reason);
  };
  if (!HASH_RE.test(hash)) return refuse('invalid hash');
  const authorization = req.headers.authorization;
  const meta = {};
  for (const [key, header] of Object.entries(META_HEADERS)) {
    const value = req.headers[header];
    if (typeof value === 'string') meta[key] = value;
  }
  const request = { hash, size };
  if (Object.keys(meta).length > 0) request.meta = meta;

  let slot;
  try {
    const slotRes = await control('/v1/uploads', authorization, request);
    if (slotRes.status === 409) {
      await slotRes.body?.cancel();
      return answerExists(req, res, tool);
    }
    if (slotRes.status !== 200) {
      await slotRes.body?.cancel();
      return refuse(`upload slot refused (HTTP ${slotRes.status})`);
    }
    slot = await slotRes.json();
  } catch (error) {
    return refuse(`upload slot request failed: ${reasonOf(error)}`);
  }
  if (!isSlot(slot)) return refuse('upload slot response was malformed');

  let status;
  try {
    status = await upload(req, res, slot.url, slot.headers);
  } catch (error) {
    return refuse(`upload failed: ${reasonOf(error)}`);
  }
  if (status === 412) return answerExists(req, res, tool);
  if (status < 200 || status > 299) {
    return refuse(`upload refused (HTTP ${status})`);
  }

  try {
    const done = await control('/v1/uploads/complete', authorization, { hash });
    await done.body?.cancel();
    if (done.status < 200 || done.status > 299) {
      return refuse(`complete failed (HTTP ${done.status})`);
    }
  } catch (error) {
    return refuse(`complete failed: ${reasonOf(error)}`);
  }
  return answer(
    req,
    res,
    tool === 'turbo' ? 202 : 200,
    tool === 'turbo' ? { urls: [] } : undefined,
  );
};

const handle = (req, res) => {
  const size = Number(req.headers['content-length']);
  const route = req.method === 'PUT' ? toolOf(req.url) : null;
  if (route && readOnly) {
    return void (route.tool === 'turbo'
      ? answer(req, res, 403, READ_ONLY_TURBO)
      : answer(req, res, 403));
  }
  if (route && Number.isSafeInteger(size) && size > threshold) {
    largePut(req, res, route.tool, route.hash, size).catch((error) => {
      warn(`ci-cache gateway: ${route.hash} not cached: ${reasonOf(error)}`);
      void answerWriteFailed(req, res, route.tool, reasonOf(error));
    });
    return;
  }
  proxy(req, res);
};

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (error) {
    // A request target `new URL` cannot parse, for one.
    process.stderr.write(
      `ci-cache gateway: ${req.method} request failed: ${reasonOf(error)}\n`,
    );
    answer(req, res, failureStatus(req.method)).catch(() => undefined);
  }
});

// One bad request must not take the gateway down: Nx would then fail every
// later task on a refused connection.
const survive = (error) =>
  process.stderr.write(
    `ci-cache gateway: unexpected error: ${reasonOf(error)}\n`,
  );
process.on('uncaughtException', survive);
process.on('unhandledRejection', survive);

// An upload of several GiB can take longer than Node's default 5 minutes.
server.requestTimeout = 0;

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  if (portFile) {
    // Written whole, then renamed, so a reader never sees a partial port.
    writeFileSync(`${portFile}.tmp`, String(port));
    renameSync(`${portFile}.tmp`, portFile);
  }
});
