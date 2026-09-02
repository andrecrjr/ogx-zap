import type { ResolvedTikTok } from "./tiktok";

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character] ?? character);
}

function escapeJavaScriptString(value: string): string {
  const serialized = JSON.stringify(value);
  return serialized.replace(/[<>&\u2028\u2029]/g, (character) => {
    switch (character) {
      case "<":
        return "\\u003C";
      case ">":
        return "\\u003E";
      case "&":
        return "\\u0026";
      case "\u2028":
        return "\\u2028";
      case "\u2029":
        return "\\u2029";
      default:
        return character;
    }
  });
}

function meta(attribute: "property" | "name", key: string, value: string): string {
  return `<meta ${attribute}="${escapeHtml(key)}" content="${escapeHtml(value)}">`;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function renderWrapperHtml(result: ResolvedTikTok, redirectBrowser: boolean): string {
  const imageTags = result.image
    ? [
        meta("property", "og:image", result.image),
        ...(isHttpsUrl(result.image)
          ? [meta("property", "og:image:secure_url", result.image)]
          : []),
        meta("name", "twitter:image", result.image),
      ].join("")
    : "";
  const redirectScript = redirectBrowser
    ? `<script>location.replace(${escapeJavaScriptString(result.destinationUrl)});</script>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${meta(
    "property",
    "og:type",
    "website",
  )}${meta("property", "og:title", result.title)}${meta(
    "property",
    "og:description",
    result.description,
  )}${imageTags}${meta("name", "twitter:card", "summary_large_image")}${meta(
    "name",
    "twitter:title",
    result.title,
  )}${meta("name", "twitter:description", result.description)}${redirectScript}</head><body><a href="${escapeHtml(
    result.destinationUrl,
  )}">Open TikTok</a></body></html>`;
}

export function renderLandingPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TikTok OG Link Generator</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { max-width: 720px; margin: 0 auto; padding: 3rem 1rem; }
    h1 { margin-bottom: .5rem; }
    p { color: #6b7280; }
    form { display: flex; gap: .5rem; margin: 2rem 0 1rem; }
    input { box-sizing: border-box; min-width: 0; flex: 1; padding: .75rem; border: 1px solid #9ca3af; border-radius: .5rem; }
    button, a.button { padding: .75rem 1rem; border: 0; border-radius: .5rem; background: #111827; color: white; cursor: pointer; text-decoration: none; }
    button:disabled { opacity: .6; cursor: wait; }
    #error { color: #b91c1c; }
    #result { margin-top: 2rem; padding: 1rem; border: 1px solid #d1d5db; border-radius: .75rem; }
    #preview-image { display: block; max-width: 100%; max-height: 360px; margin: 1rem 0; border-radius: .5rem; }
    .share { display: flex; gap: .5rem; margin: .5rem 0 2rem; }
    .share input { font-size: .9rem; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: .5rem 1rem; }
    dt { font-weight: 700; }
    dd { margin: 0; overflow-wrap: anywhere; }
    @media (max-width: 560px) { form, .share { flex-direction: column; } }
  </style>
</head>
<body>
  <h1>TikTok OG Link Generator</h1>
  <p>Paste a TikTok link to inspect its metadata and create a WhatsApp-friendly share URL.</p>
  <form id="converter">
    <input id="source-url" type="url" required placeholder="https://vt.tiktok.com/..." autocomplete="url">
    <button id="convert" type="submit">Convert</button>
  </form>
  <p id="error" hidden></p>
  <section id="result" hidden>
    <h3>Share URL</h3>
    <div class="share">
      <input id="share-url" readonly>
      <button id="copy-url" type="button">Copy</button>
      <button id="copy-only-url" type="button">Copy URL</button>
      <button id="whatsapp-status" type="button">WhatsApp / Status</button>
      <a id="open-share" class="button" target="_blank" rel="noreferrer">Open</a>
    </div>
    <h2 id="result-title"></h2>
    <img id="preview-image" alt="" hidden>
    <p id="result-description"></p>
    <dl>
      <dt>Destination</dt><dd><a id="destination-link" target="_blank" rel="noreferrer"></a></dd>
      <dt>Metadata source</dt><dd id="metadata-source"></dd>
    </dl>
  </section>
  <script>
    const form = document.querySelector('#converter');
    const input = document.querySelector('#source-url');
    const button = document.querySelector('#convert');
    const error = document.querySelector('#error');
    const result = document.querySelector('#result');
    const title = document.querySelector('#result-title');
    const description = document.querySelector('#result-description');
    const image = document.querySelector('#preview-image');
    const destination = document.querySelector('#destination-link');
    const source = document.querySelector('#metadata-source');
    const shareInput = document.querySelector('#share-url');
    const shareLink = document.querySelector('#open-share');
    const copy = document.querySelector('#copy-url');
    const copyOnlyUrl = document.querySelector('#copy-only-url');
    const whatsappStatus = document.querySelector('#whatsapp-status');
    const shareHooks = [
      'Olha o que eu achei! 👀',
      'Veja essa promoção antes que acabe! 🔥',
      'Encontrei uma oferta imperdível!',
      'Você precisa ver isso 😱',
      'Olha essa oportunidade!',
      'Achei exatamente o que você estava procurando!',
      'Esse preço está bom demais para ignorar!',
      'Corre conferir essa promoção! 🏃',
      'Descobri uma oferta que vale a pena!',
      'Não deixa essa passar!',
    ];

    function clipboardText() {
      const hook = shareHooks[Math.floor(Math.random() * shareHooks.length)];
      return 'TikTok: ' + hook + ' ' + (title.textContent || 'TikTok') + '\\n' + shareInput.value;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      error.hidden = true;
      result.hidden = true;
      button.disabled = true;
      button.textContent = 'Resolving...';

      try {
        const originalUrl = input.value.trim();
        const response = await fetch('/resolve?url=' + encodeURIComponent(originalUrl), { headers: { accept: 'application/json' } });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not resolve this TikTok URL.');

        title.textContent = data.title || 'TikTok';
        description.textContent = data.description || 'No description found.';
        destination.textContent = data.destinationUrl;
        destination.href = data.destinationUrl;
        source.textContent = data.metadataSource;

        if (data.image) {
          image.src = data.image;
          image.alt = data.title || 'TikTok preview';
          image.hidden = false;
        } else {
          image.removeAttribute('src');
          image.hidden = true;
        }

        shareInput.value = data.shareUrl;
        shareLink.href = data.shareUrl;
        result.hidden = false;
      } catch (requestError) {
        error.textContent = requestError instanceof Error ? requestError.message : 'Could not resolve this TikTok URL.';
        error.hidden = false;
      } finally {
        button.disabled = false;
        button.textContent = 'Convert';
      }
    });

    async function copyValue(value, button) {
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        const fallback = document.createElement('textarea');
        fallback.value = value;
        fallback.style.position = 'fixed';
        fallback.style.opacity = '0';
        document.body.append(fallback);
        fallback.select();
        document.execCommand('copy');
        fallback.remove();
      }
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = button === copyOnlyUrl ? 'Copy URL' : 'Copy'; }, 1200);
    }

    copy.addEventListener('click', () => copyValue(clipboardText(), copy));
    copyOnlyUrl.addEventListener('click', () => copyValue(shareInput.value, copyOnlyUrl));

    whatsappStatus.addEventListener('click', async () => {
      const text = clipboardText();
      if (navigator.share) {
        try {
          await navigator.share({ title: 'TikTok', text });
          return;
        } catch (shareError) {
          if (shareError && shareError.name === 'AbortError') return;
        }
      }

      window.location.href = 'https://wa.me/?text=' + encodeURIComponent(text);
    });
  </script>
</body>
</html>`;
}
