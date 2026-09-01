const ALLOWED_HOSTS = new Set([
  "vt.tiktok.com",
  "tiktok.com",
  "www.tiktok.com",
  "shop.tiktok.com",
]);

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

export type UrlValidationKind = "initial" | "redirect";

export class TikTokUrlError extends Error {
  public readonly code: "INVALID_URL" | "REDIRECT_NOT_ALLOWED";
  public readonly kind: UrlValidationKind;

  public constructor(kind: UrlValidationKind, message: string) {
    super(message);
    this.name = "TikTokUrlError";
    this.kind = kind;
    this.code = kind === "initial" ? "INVALID_URL" : "REDIRECT_NOT_ALLOWED";
  }
}

function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");

  if (host.includes(":")) {
    return true;
  }

  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => {
      if (!/^\d{1,3}$/.test(octet)) {
        return false;
      }

      const value = Number(octet);
      return value >= 0 && value <= 255;
    })
  );
}

function reject(kind: UrlValidationKind, reason: string): never {
  throw new TikTokUrlError(
    kind,
    kind === "initial"
      ? `Only valid TikTok URLs are accepted (${reason}).`
      : `TikTok redirect rejected (${reason}).`,
  );
}

export function validateTikTokUrl(
  input: string,
  kind: UrlValidationKind = "initial",
): URL {
  if (!input || input.length > 16_384) {
    reject(kind, "URL is missing or too long");
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    reject(kind, "malformed URL");
  }

  if (!HTTP_PROTOCOLS.has(url.protocol)) {
    reject(kind, "protocol is not HTTP(S)");
  }

  if (url.username || url.password) {
    reject(kind, "credentials are not allowed");
  }

  const expectedPort = url.protocol === "https:" ? "443" : "80";
  if (url.port && url.port !== expectedPort) {
    reject(kind, "non-standard ports are not allowed");
  }

  const hostname = url.hostname.toLowerCase();
  if (isIpLiteral(hostname)) {
    reject(kind, "IP literals, including private and link-local IPs, are not allowed");
  }

  if (!ALLOWED_HOSTS.has(hostname)) {
    reject(kind, "host is not an allowed TikTok host");
  }

  return url;
}

export function isAllowedImageUrl(value: string, baseUrl?: URL): string | undefined {
  const raw = value.trim();
  if (!raw || raw.length > 16_384) {
    return undefined;
  }

  let imageUrl: URL;
  try {
    imageUrl = new URL(raw, baseUrl);
  } catch {
    return undefined;
  }

  if (!HTTP_PROTOCOLS.has(imageUrl.protocol) || imageUrl.username || imageUrl.password) {
    return undefined;
  }

  // Preserve absolute metadata URLs byte-for-byte. This is intentionally not a fetch.
  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  return imageUrl.toString();
}

