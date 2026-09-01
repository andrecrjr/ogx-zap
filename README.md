# og-redirectx

Minimal Bun server that turns TikTok URLs into WhatsApp-friendly Open Graph wrapper URLs.

It resolves TikTok redirects server-side, reads metadata from redirect query parameters such as `og_info`, and returns a tiny HTML wrapper. Image URLs are emitted directly from TikTok. The server never downloads, proxies, resizes, caches, or stores images.

## Run

```bash
bun install
bun run start
```

Open <http://localhost:5650> to use the preview form, or call the API directly:

```text
http://localhost:5650/resolve?url=https%3A%2F%2Fvt.tiktok.com%2FZS9BQuCR7LVVT-740rk%2F
```

Create a share URL with:

```text
https://mydomain.com/share?url=https%3A%2F%2Fvt.tiktok.com%2FZS9BQuCR7LVVT-740rk%2F
```

`/resolve` warms the in-memory cache. `/share` serves OG metadata immediately on later requests.

## Configuration

Copy `.env.example` to `.env` when local configuration is needed:

```env
PORT=5650
HOST=127.0.0.1
CACHE_TTL_SECONDS=21600
CACHE_MAX_ENTRIES=1000
MAX_CONCURRENT_RESOLUTIONS=20
FETCH_TIMEOUT_MS=3000
```

The local default binds only to `127.0.0.1`. The Docker image explicitly uses `0.0.0.0` inside the container so published ports remain reachable.

The in-memory cache keeps at most 1,000 entries by default. Set `CACHE_MAX_ENTRIES=0` to disable caching.

At most 20 distinct TikTok resolutions run at once by default. Additional uncached requests receive `503` until capacity is available.

## Behavior

- Uses `Bun.serve()` and the platform `fetch` API.
- Manually follows at most 10 redirects.
- Inspects every redirect `Location` before following it.
- Extracts `og_info.title`, `og_info.image`, and `og_info.description` before the next request.
- Falls back to redirect query values, OG tags, Twitter tags, and the final HTML title.
- Sends normal browsers to TikTok with JavaScript after the OG tags are written.
- Does not send that navigation script to WhatsApp, Facebook, or other recognized crawlers.
- Returns `504` when the TikTok timeout is reached and `502` for upstream/redirect failures.

Only these exact TikTok hosts are accepted for the input and redirect chain:

```text
vt.tiktok.com
tiktok.com
www.tiktok.com
shop.tiktok.com
```

IP literals, private/link-local addresses, localhost, credentials, arbitrary domains, and unsupported protocols are rejected. Image URLs are only checked as strings and are never requested by this server.

## Test

```bash
bun run typecheck
bun test
```

## Docker

```bash
docker build -t og-redirectx .
docker run --rm -p 3000:3000 og-redirectx
```
