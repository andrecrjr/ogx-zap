import { isAllowedImageUrl, TikTokUrlError, validateTikTokUrl } from "./security";

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_REDIRECTS = 10;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_METADATA_TEXT_LENGTH = 2_000;

export type MetadataSource = "redirect-og_info" | "redirect-url" | "html" | "fallback";

export interface ResolvedTikTok {
  originalUrl: string;
  destinationUrl: string;
  title: string;
  description: string;
  image: string;
  metadataSource: MetadataSource;
}

export type TikTokResolveErrorCode =
  | "INVALID_URL"
  | "REDIRECT_NOT_ALLOWED"
  | "TOO_MANY_REDIRECTS"
  | "TIMEOUT"
  | "FETCH_FAILED";

export class TikTokResolveError extends Error {
  public constructor(
    public readonly code: TikTokResolveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TikTokResolveError";
  }
}

export interface ResolveTikTokOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  fetchImpl?: typeof fetch;
}

interface Candidate {
  value: string;
  rank: number;
}

interface MetadataState {
  title?: Candidate;
  description?: Candidate;
  image?: Candidate;
  sawOgInfo: boolean;
  sawRedirectMetadata: boolean;
  sawHtmlMetadata: boolean;
}

function createMetadataState(): MetadataState {
  return {
    sawOgInfo: false,
    sawRedirectMetadata: false,
    sawHtmlMetadata: false,
  };
}

function cleanText(value: string, plusAsSpace = false): string | undefined {
  const cleaned = (plusAsSpace ? value.replace(/\+/g, " ") : value).trim();
  if (!cleaned) {
    return undefined;
  }

  return cleaned.slice(0, MAX_METADATA_TEXT_LENGTH);
}

function setCandidate(
  state: MetadataState,
  field: "title" | "description" | "image",
  value: string | undefined,
  rank: number,
): void {
  if (!value) {
    return;
  }

  const current = state[field];
  if (!current || rank < current.rank) {
    state[field] = { value, rank };
  }
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function getRawString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? cleanText(value) : undefined;
}

function getText(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? cleanText(value, true) : undefined;
}

function parseOgInfo(value: string): Record<string, unknown> | undefined {
  const candidates = [value];

  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) {
      candidates.push(decoded);
    }
  } catch {
    // URLSearchParams already performs one decode. An invalid second layer is ignored.
  }

  for (const candidate of candidates) {
    try {
      const parsed = parseRecord(JSON.parse(candidate) as unknown);
      if (parsed) {
        return parsed;
      }
    } catch {
      // Continue so a later duplicate or double-encoded parameter can still work.
    }
  }

  return undefined;
}

function addOgInfo(state: MetadataState, info: Record<string, unknown>, baseUrl: URL): void {
  state.sawOgInfo = true;
  setCandidate(state, "title", getText(info, "title"), 10);
  setCandidate(state, "description", getText(info, "description"), 10);

  const image = getRawString(info, "image");
  setCandidate(state, "image", image ? isAllowedImageUrl(image, baseUrl) : undefined, 10);
}

export function extractMetadataFromUrl(url: URL, state: MetadataState): void {
  const params = url.searchParams;

  for (const ogInfoValue of params.getAll("og_info")) {
    const ogInfo = parseOgInfo(ogInfoValue);
    if (ogInfo) {
      addOgInfo(state, ogInfo, url);
    }
  }

  const contentImage = params.get("content_image");
  if (contentImage) {
    state.sawRedirectMetadata = true;
    setCandidate(state, "image", isAllowedImageUrl(contentImage, url), 20);
  }

  const title = params.get("title");
  if (title) {
    state.sawRedirectMetadata = true;
    setCandidate(state, "title", cleanText(title, true), 25);
  }

  const image = params.get("image");
  if (image) {
    state.sawRedirectMetadata = true;
    setCandidate(state, "image", isAllowedImageUrl(image, url), 25);
  }
}

function parseAttributes(tag: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const attributePattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

  for (const match of tag.matchAll(attributePattern)) {
    const name = match[1]?.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4];
    if (name && value !== undefined) {
      attributes.set(name, decodeHtmlEntities(value));
    }
  }

  return attributes;
}

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/gi, (entity, body: string) => {
    if (body.toLowerCase().startsWith("#x")) {
      const codePoint = Number.parseInt(body.slice(2), 16);
      return decodeCodePoint(entity, codePoint);
    }

    if (body.startsWith("#")) {
      const codePoint = Number.parseInt(body.slice(1), 10);
      return decodeCodePoint(entity, codePoint);
    }

    return namedEntities[body.toLowerCase()] ?? entity;
  });
}

function decodeCodePoint(entity: string, codePoint: number): string {
  if (Number.isNaN(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }

  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return entity;
  }
}

export function extractMetadataFromHtml(html: string, baseUrl: URL, state: MetadataState): void {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const key = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase();
    const content = cleanText(attributes.get("content") ?? "");
    if (!key || !content) {
      continue;
    }

    if (key === "og:title") {
      setCandidate(state, "title", content, 30);
      state.sawHtmlMetadata = true;
    } else if (key === "twitter:title") {
      setCandidate(state, "title", content, 40);
      state.sawHtmlMetadata = true;
    } else if (key === "og:description") {
      setCandidate(state, "description", content, 30);
      state.sawHtmlMetadata = true;
    } else if (key === "twitter:description") {
      setCandidate(state, "description", content, 40);
      state.sawHtmlMetadata = true;
    } else if (key === "og:image") {
      setCandidate(state, "image", isAllowedImageUrl(content, baseUrl), 30);
      state.sawHtmlMetadata = true;
    } else if (key === "twitter:image") {
      setCandidate(state, "image", isAllowedImageUrl(content, baseUrl), 40);
      state.sawHtmlMetadata = true;
    }
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const documentTitle = cleanText(titleMatch?.[1] ? decodeHtmlEntities(titleMatch[1]) : "");
  if (documentTitle) {
    setCandidate(state, "title", documentTitle, 50);
    state.sawHtmlMetadata = true;
  }
}

function metadataSource(state: MetadataState): MetadataSource {
  if (state.sawOgInfo) {
    return "redirect-og_info";
  }

  if (state.sawRedirectMetadata) {
    return "redirect-url";
  }

  if (state.sawHtmlMetadata) {
    return "html";
  }

  return "fallback";
}

async function readBodyUpTo(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  let reachedLimit = false;

  try {
    while (bytesRead < maxBytes) {
      let onAbort: (() => void) | undefined;
      const abortPromise = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        onAbort = abort;
        if (signal.aborted) {
          abort();
          return;
        }

        signal.addEventListener("abort", abort, { once: true });
      });
      let readResult: Awaited<ReturnType<typeof reader.read>>;
      try {
        readResult = await Promise.race([reader.read(), abortPromise]);
      } finally {
        if (onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
      }
      const { done, value } = readResult;
      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      const remaining = maxBytes - bytesRead;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      text += decoder.decode(chunk, { stream: true });
      bytesRead += chunk.byteLength;

      if (chunk.byteLength < value.byteLength) {
        reachedLimit = true;
        break;
      }
    }

    text += decoder.decode();
    return text;
  } finally {
    if (reachedLimit) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
}

function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return !contentType || contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  deadline: number,
  signal: AbortSignal,
): Promise<Response> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) {
    throw new TikTokResolveError("TIMEOUT", "TikTok resolution timed out.");
  }

  try {
    return await fetchImpl(url, {
      redirect: "manual",
      signal,
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "og-redirectx/1.0",
      },
    });
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      throw new TikTokResolveError("TIMEOUT", "TikTok resolution timed out.");
    }

    throw new TikTokResolveError("FETCH_FAILED", "TikTok could not be reached.");
  }
}

function validationErrorToResolveError(error: TikTokUrlError): TikTokResolveError {
  return new TikTokResolveError(error.code, error.message);
}

export async function resolveTikTok(
  input: string,
  options: ResolveTikTokOptions = {},
): Promise<ResolvedTikTok> {
  let originalUrl: URL;
  try {
    originalUrl = validateTikTokUrl(input, "initial");
  } catch (error) {
    if (error instanceof TikTokUrlError) {
      throw validationErrorToResolveError(error);
    }
    throw error;
  }

  const configuredTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : DEFAULT_TIMEOUT_MS;
  const configuredMaxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxRedirects =
    Number.isFinite(configuredMaxRedirects) && configuredMaxRedirects >= 0
      ? Math.floor(configuredMaxRedirects)
      : DEFAULT_MAX_REDIRECTS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deadline = Date.now() + timeoutMs;
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const metadata = createMetadataState();

  extractMetadataFromUrl(originalUrl, metadata);

  let currentUrl = originalUrl;
  let redirectCount = 0;

  try {
    while (true) {
      const response = await fetchWithDeadline(
        fetchImpl,
        currentUrl.toString(),
        deadline,
        timeoutController.signal,
      );
      const location = response.headers.get("location");

      if (location !== null && location.trim() !== "") {
        if (redirectCount >= maxRedirects) {
          throw new TikTokResolveError("TOO_MANY_REDIRECTS", "TikTok returned too many redirects.");
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(location, currentUrl);
        } catch {
          throw new TikTokResolveError("REDIRECT_NOT_ALLOWED", "TikTok returned an invalid redirect.");
        }

        try {
          nextUrl = validateTikTokUrl(nextUrl.toString(), "redirect");
        } catch (error) {
          if (error instanceof TikTokUrlError) {
            throw validationErrorToResolveError(error);
          }
          throw error;
        }

        // The redirect URL is inspected before the next network request.
        extractMetadataFromUrl(nextUrl, metadata);
        response.body?.cancel().catch(() => undefined);
        currentUrl = nextUrl;
        redirectCount += 1;
        continue;
      }

      if (response.status >= 300 && response.status < 400) {
        throw new TikTokResolveError("FETCH_FAILED", "TikTok returned a redirect without a Location header.");
      }

      if (isHtmlResponse(response)) {
        try {
          const html = await readBodyUpTo(response, MAX_HTML_BYTES, timeoutController.signal);
          extractMetadataFromHtml(html, currentUrl, metadata);
        } catch (error) {
          if (timeoutController.signal.aborted || isAbortError(error)) {
            throw new TikTokResolveError("TIMEOUT", "TikTok resolution timed out.");
          }
          throw new TikTokResolveError("FETCH_FAILED", "TikTok returned unreadable metadata.");
        }
      }

      break;
    }
  } finally {
    clearTimeout(timeoutTimer);
  }

  return {
    originalUrl: originalUrl.toString(),
    destinationUrl: currentUrl.toString(),
    title: metadata.title?.value ?? "TikTok",
    description: metadata.description?.value ?? "",
    image: metadata.image?.value ?? "",
    metadataSource: metadataSource(metadata),
  };
}
