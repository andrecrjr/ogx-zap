import { afterEach, describe, expect, test } from "bun:test";
import { TtlCache } from "../src/cache";
import { createApp } from "../src/server";
import { resolveTikTok } from "../src/tiktok";

const sampleUrl = "https://vt.tiktok.com/ZS9BQuCR7LVVT-740rk/";
const originalFetch = globalThis.fetch;

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

function setFetch(handler: FetchHandler): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init ?? {});
  }) as typeof fetch;
}

function redirectResponse(location: string, status = 301): Response {
  return new Response(null, { status, headers: { location } });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveTikTok", () => {
  test("extracts og_info from the sample vt.tiktok.com redirect before following it", async () => {
    const image = "https://p16-oec-sg.ibyteimg.com/product-original.jpeg?token=abc";
    const encodedTitle = "Saída+de+Praia+-+Vestido+Longo";
    const title = "Saída de Praia - Vestido Longo";
    const ogInfo = encodeURIComponent(JSON.stringify({ title: encodedTitle, image, description: "" }));
    const location = `https://shop.tiktok.com/br/pdp/1736904312711316489?og_info=${ogInfo}`;
    const calls: Array<{ url: string; redirect: string | undefined }> = [];

    setFetch((url, init) => {
      calls.push({ url, redirect: init.redirect });
      if (calls.length === 1) {
        return redirectResponse(location);
      }

      return new Response(
        `<html><head><title>Fallback title</title><meta property="og:image" content="https://example.com/fallback.jpg"></head></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    });

    const result = await resolveTikTok(sampleUrl);

    expect(result).toEqual({
      originalUrl: sampleUrl,
      destinationUrl: location,
      title,
      description: "",
      image,
      metadataSource: "redirect-og_info",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe(sampleUrl);
    expect(calls[1]?.url).toBe(location);
    expect(calls.every((call) => call.redirect === "manual")).toBe(true);
  });

  test("keeps redirect metadata ahead of final HTML metadata", async () => {
    const location =
      "https://shop.tiktok.com/br/pdp/123?content_image=https%3A%2F%2Fcdn.example%2Foriginal.jpg&title=Redirect%20title";

    setFetch((url) =>
      url === sampleUrl
        ? redirectResponse(location)
        : new Response(
            `<meta property="og:title" content="HTML title"><meta property="og:description" content="HTML description"><meta property="og:image" content="https://cdn.example/html.jpg">`,
            { status: 200, headers: { "content-type": "text/html" } },
          ),
    );

    await expect(resolveTikTok(sampleUrl)).resolves.toMatchObject({
      title: "Redirect title",
      image: "https://cdn.example/original.jpg",
      description: "HTML description",
      metadataSource: "redirect-url",
    });
  });

  test("rejects a disallowed redirect before fetching it", async () => {
    let calls = 0;
    setFetch(() => {
      calls += 1;
      return redirectResponse("https://example.com/not-tiktok");
    });

    await expect(resolveTikTok(sampleUrl)).rejects.toMatchObject({
      code: "REDIRECT_NOT_ALLOWED",
    });
    expect(calls).toBe(1);
  });

  test("never fetches the metadata image URL", async () => {
    const image = "https://p16-oec-sg.ibyteimg.com/original.jpeg";
    const location = `https://shop.tiktok.com/br/pdp/123?og_info=${encodeURIComponent(JSON.stringify({ image }))}`;
    const calls: string[] = [];

    setFetch((url) => {
      calls.push(url);
      return calls.length === 1 ? redirectResponse(location) : new Response(null, { status: 200 });
    });

    const result = await resolveTikTok(sampleUrl);

    expect(result.image).toBe(image);
    expect(calls).toEqual([sampleUrl, location]);
    expect(calls).not.toContain(image);
  });

  test("times out a stalled upstream request", async () => {
    setFetch((_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
          once: true,
        });
      }),
    );

    await expect(resolveTikTok(sampleUrl, { timeoutMs: 10 })).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });

  test("rejects arbitrary and private input URLs", async () => {
    await expect(resolveTikTok("https://example.com/video")).rejects.toMatchObject({
      code: "INVALID_URL",
    });
    await expect(resolveTikTok("http://127.0.0.1/video")).rejects.toMatchObject({
      code: "INVALID_URL",
    });
    await expect(resolveTikTok("file:///tmp/video")).rejects.toMatchObject({
      code: "INVALID_URL",
    });
  });
});

describe("HTTP app", () => {
  const resolved = {
    originalUrl: sampleUrl,
    destinationUrl: "https://shop.tiktok.com/br/pdp/123?x=1&y=2",
    title: "A \"safe\" TikTok title",
    description: "A description & details",
    image: "https://p16-oec-sg.ibyteimg.com/original.jpeg",
    metadataSource: "redirect-og_info" as const,
  };

  test("uses the cache across resolve and share requests", async () => {
    let calls = 0;
    const app = createApp({
      cache: new TtlCache(60_000),
      resolver: async () => {
        calls += 1;
        return resolved;
      },
    });
    const query = `?url=${encodeURIComponent(sampleUrl)}`;

    const resolveResponse = await app(new Request(`http://localhost/resolve${query}`));
    const shareResponse = await app(new Request(`http://localhost/share${query}`));

    expect(resolveResponse.status).toBe(200);
    expect(shareResponse.status).toBe(200);
    expect(calls).toBe(1);
    expect(await resolveResponse.json()).toEqual({
      ...resolved,
      shareUrl: `http://localhost/share?url=${encodeURIComponent(sampleUrl)}`,
    });

    const cachedResolveResponse = await app(new Request(`http://localhost/resolve${query}`));
    expect(await cachedResolveResponse.json()).toEqual({
      ...resolved,
      shareUrl: `http://localhost/share?url=${encodeURIComponent(sampleUrl)}`,
    });
  });

  test("returns 503 when the concurrent resolution limit is reached", async () => {
    const otherUrl = "https://vt.tiktok.com/another/";
    let calls = 0;
    let release!: (value: typeof resolved) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<typeof resolved>((resolve) => {
      release = resolve;
    });
    const app = createApp({
      maxConcurrentResolutions: 1,
      resolver: async () => {
        calls += 1;
        markStarted();
        return pending;
      },
    });

    const first = app(new Request(`http://localhost/resolve?url=${encodeURIComponent(sampleUrl)}`));
    await started;
    const duplicate = app(new Request(`http://localhost/share?url=${encodeURIComponent(sampleUrl)}`));
    const rejected = await app(new Request(`http://localhost/resolve?url=${encodeURIComponent(otherUrl)}`));

    expect(rejected.status).toBe(503);
    release(resolved);
    expect((await first).status).toBe(200);
    expect((await duplicate).status).toBe(200);
    expect(calls).toBe(1);
  });

  test("omits browser navigation for crawlers and escapes wrapper values", async () => {
    const app = createApp({ resolver: async () => resolved });
    const response = await app(
      new Request(`http://localhost/share?url=${encodeURIComponent(sampleUrl)}`, {
        headers: { "user-agent": "facebookexternalhit/1.1" },
      }),
    );
    const html = await response.text();

    expect(html).toContain("property=\"og:image\" content=\"https://p16-oec-sg.ibyteimg.com/original.jpeg\"");
    expect(html).toContain("content=\"A &quot;safe&quot; TikTok title\"");
    expect(html).toContain("content=\"A description &amp; details\"");
    expect(html).not.toContain("location.replace");
  });

  test("adds browser navigation and fallback link for normal users", async () => {
    const app = createApp({ resolver: async () => resolved });
    const response = await app(
      new Request(`http://localhost/share?url=${encodeURIComponent(sampleUrl)}`, {
        headers: { "user-agent": "Mozilla/5.0" },
      }),
    );
    const html = await response.text();

    expect(html).toContain("location.replace(\"https://shop.tiktok.com/br/pdp/123?x=1\\u0026y=2\")");
    expect(html).toContain("<a href=\"https://shop.tiktok.com/br/pdp/123?x=1&amp;y=2\">Open TikTok</a>");
  });

  test("serves the paste-and-preview landing page", async () => {
    const app = createApp();
    const response = await app(new Request("http://localhost/"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("TikTok OG Link Generator");
    expect(html).toContain("/resolve?url=");
    expect(html).toContain("preview-image");
    expect(html).toContain("'TikTok: ' + (title.textContent || 'TikTok')");
    expect(html).toContain("id=\"whatsapp-status\"");
    expect(html).toContain("id=\"copy-only-url\"");
    expect(html).toContain("navigator.share");
    expect(html).toContain("shareInput.value = data.shareUrl;");
    expect(html).toContain("shareLink.href = data.shareUrl;");
    expect(html).not.toContain("shareUrl.searchParams.set('url', data.destinationUrl);");
    expect(html).toContain("copy.addEventListener('click', () => copyValue(clipboardText(), copy));");
    expect(html).toContain("copyOnlyUrl.addEventListener('click', () => copyValue(shareInput.value, copyOnlyUrl));");
    expect(html).toContain("await navigator.clipboard.writeText(value);");
    expect(html).toContain("fallback.value = value;");
    expect(html.indexOf("<h3>Share URL</h3>")).toBeLessThan(html.indexOf('<h2 id="result-title">'));
  });
});
