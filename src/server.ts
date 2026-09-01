import { DEFAULT_CACHE_MAX_ENTRIES, TtlCache } from "./cache";
import { renderLandingPage, renderWrapperHtml } from "./html";
import { resolveTikTok, TikTokResolveError, type ResolvedTikTok } from "./tiktok";

const DEFAULT_PORT = 5_650;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_CACHE_TTL_SECONDS = 21_600;
const DEFAULT_FETCH_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_CONCURRENT_RESOLUTIONS = 20;
const CRAWLER_PATTERN = /whatsapp|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|discordbot|telegrambot/i;

export type Resolver = (url: string) => Promise<ResolvedTikTok>;

export interface AppOptions {
  cache?: TtlCache;
  resolver?: Resolver;
  cacheTtlSeconds?: number;
  cacheMaxEntries?: number;
  fetchTimeoutMs?: number;
  maxConcurrentResolutions?: number;
}

class ResolutionCapacityError extends Error {
  public constructor() {
    super("Too many TikTok resolutions are in progress.");
    this.name = "ResolutionCapacityError";
  }
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envNumber(name: string, fallback: number): number {
  return positiveNumber(Bun.env[name], fallback);
}

function envNonNegativeInteger(name: string, fallback: number): number {
  const value = Bun.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Bun.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function createResolutionLimiter(maxConcurrent: number): <T>(operation: () => Promise<T>) => Promise<T> {
  let active = 0;

  return async function runWithLimit<T>(operation: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrent) {
      throw new ResolutionCapacityError();
    }

    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
    }
  };
}

function isCrawler(request: Request): boolean {
  return CRAWLER_PATTERN.test(request.headers.get("user-agent") ?? "");
}

function headers(contentType: string): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-type": contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: headers("text/html; charset=utf-8") });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers("application/json; charset=utf-8"),
  });
}

function methodNotAllowed(): Response {
  const response = new Response("Method Not Allowed", { status: 405, headers: headers("text/plain; charset=utf-8") });
  response.headers.set("allow", "GET");
  return response;
}

function errorStatus(error: unknown): number {
  if (error instanceof ResolutionCapacityError) {
    return 503;
  }

  if (!(error instanceof TikTokResolveError)) {
    return 502;
  }

  switch (error.code) {
    case "INVALID_URL":
      return 400;
    case "TIMEOUT":
      return 504;
    case "REDIRECT_NOT_ALLOWED":
    case "TOO_MANY_REDIRECTS":
    case "FETCH_FAILED":
      return 502;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "TikTok resolution failed.";
}

function errorResponse(error: unknown, json: boolean): Response {
  const status = errorStatus(error);
  if (json) {
    return jsonResponse({ error: errorMessage(error) }, status);
  }

  return htmlResponse(`<h1>Unable to resolve TikTok URL</h1><p>${errorMessage(error)}</p>`, status);
}

function resolvedValue(cached: ReturnType<TtlCache["get"]>): ResolvedTikTok {
  if (!cached) {
    throw new Error("Expected a cached result.");
  }

  const { expiresAt: _expiresAt, ...resolved } = cached;
  return resolved;
}

function inputUrl(requestUrl: URL): string | undefined {
  const value = requestUrl.searchParams.get("url")?.trim();
  return value || undefined;
}

export function createApp(options: AppOptions = {}): (request: Request) => Promise<Response> {
  const cacheTtlSeconds =
    options.cacheTtlSeconds === undefined
      ? envNumber("CACHE_TTL_SECONDS", DEFAULT_CACHE_TTL_SECONDS)
      : Number.isFinite(options.cacheTtlSeconds) && options.cacheTtlSeconds >= 0
        ? options.cacheTtlSeconds
        : DEFAULT_CACHE_TTL_SECONDS;
  const fetchTimeoutMs =
    options.fetchTimeoutMs === undefined
      ? envNumber("FETCH_TIMEOUT_MS", DEFAULT_FETCH_TIMEOUT_MS)
      : Number.isFinite(options.fetchTimeoutMs) && options.fetchTimeoutMs > 0
        ? options.fetchTimeoutMs
        : DEFAULT_FETCH_TIMEOUT_MS;
  const cacheMaxEntries =
    options.cacheMaxEntries === undefined
      ? envNonNegativeInteger("CACHE_MAX_ENTRIES", DEFAULT_CACHE_MAX_ENTRIES)
      : Number.isFinite(options.cacheMaxEntries) && options.cacheMaxEntries >= 0
        ? Math.floor(options.cacheMaxEntries)
        : DEFAULT_CACHE_MAX_ENTRIES;
  const maxConcurrentResolutions =
    options.maxConcurrentResolutions === undefined
      ? envPositiveInteger("MAX_CONCURRENT_RESOLUTIONS", DEFAULT_MAX_CONCURRENT_RESOLUTIONS)
      : Number.isFinite(options.maxConcurrentResolutions) && options.maxConcurrentResolutions >= 1
        ? Math.floor(options.maxConcurrentResolutions)
        : DEFAULT_MAX_CONCURRENT_RESOLUTIONS;
  const cache =
    options.cache ??
    new TtlCache(cacheTtlSeconds * 1_000, cacheMaxEntries);
  const resolver =
    options.resolver ??
    ((url: string) =>
      resolveTikTok(url, {
        timeoutMs: fetchTimeoutMs,
      }));
  const inFlight = new Map<string, Promise<ResolvedTikTok>>();
  const resolveWithLimit = createResolutionLimiter(maxConcurrentResolutions);

  async function resolveCached(originalUrl: string): Promise<ResolvedTikTok> {
    const cached = cache.get(originalUrl);
    if (cached) {
      return resolvedValue(cached);
    }

    const existing = inFlight.get(originalUrl);
    if (existing) {
      return existing;
    }

    const pending = resolveWithLimit(() => resolver(originalUrl))
      .then((resolved) => {
        cache.set(originalUrl, resolved);
        return resolved;
      })
      .finally(() => {
        inFlight.delete(originalUrl);
      });

    inFlight.set(originalUrl, pending);
    return pending;
  }

  return async function app(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return methodNotAllowed();
    }

    const requestUrl = new URL(request.url);
    if (requestUrl.pathname === "/") {
      return htmlResponse(renderLandingPage());
    }

    if (requestUrl.pathname !== "/share" && requestUrl.pathname !== "/resolve") {
      return new Response("Not Found", { status: 404, headers: headers("text/plain; charset=utf-8") });
    }

    const sourceUrl = inputUrl(requestUrl);
    const wantsJson = requestUrl.pathname === "/resolve";
    if (!sourceUrl) {
      return errorResponse(new TikTokResolveError("INVALID_URL", "The url query parameter is required."), wantsJson);
    }

    try {
      const resolved = await resolveCached(sourceUrl);
      if (wantsJson) {
        return jsonResponse(resolved);
      }

      return htmlResponse(renderWrapperHtml(resolved, !isCrawler(request)));
    } catch (error) {
      return errorResponse(error, wantsJson);
    }
  };
}

export function startServer() {
  const port = Math.max(1, Math.floor(envNumber("PORT", DEFAULT_PORT)));
  const hostname = Bun.env.HOST || DEFAULT_HOST;
  const server = Bun.serve({
    hostname,
    port,
    fetch: createApp(),
  });

  console.log(`og-redirectx listening on http://${hostname}:${server.port}`);
  return server;
}

if (import.meta.main) {
  startServer();
}
