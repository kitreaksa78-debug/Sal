/**
 * Cleaning up what the owner pastes into the two service cards.
 *
 * Both cards are filled from a Colab cell's closing report, which prints the pair
 * like this:
 *
 *     URL      : https://xxxx.trycloudflare.com
 *     API Key  : 3f9c...
 *
 * Selecting that text on a phone hands over the **label as well**, and a copy of
 * just the host (`xxxx.trycloudflare.com`) has no scheme at all. Both used to be
 * refused — the route demanded something starting with `https://`, and a stored
 * host without a scheme could never be reached — so a task the owner does every
 * time the session dies turned into a puzzle. The values are therefore normalised
 * here, once, for both cards and for the values a deployment sets in its own
 * environment.
 *
 * This module is deliberately dependency-free: the panels in `src/` import it too,
 * so the field can show the cleaned value before anything is saved.
 */

/** Punctuation a terminal or a chat app wraps around a copied value. */
function stripWrap(value: string): string {
  return value
    .replace(/^[`'"<(]+/, '')
    .replace(/[`'">),;.]+$/, '')
    .trim();
}

/** A complete URL inside a longer paste — a log line, a label, a whole block. */
const URL_IN_TEXT = /https?:\/\/[^\s"'`<>]+/i;

/**
 * Something that can only be a host: a dotted name, an IPv4 address, or
 * `localhost`, each optionally with a port and a path. Used when the paste has no
 * scheme, so plain words (`URL`, `:` from the label) are skipped instead of being
 * turned into `https://URL`.
 */
const HOST_LIKE =
  /^(?:localhost|(?:[a-z0-9-]+\.)+[a-z0-9-]+)(?::\d+)?(?:[/?#]\S*)?$/i;

/**
 * The URL inside whatever was pasted, with a scheme, without a trailing slash.
 * Returns `''` when the paste holds nothing that could be a service address, which
 * is what lets the callers answer with a clear "that is not a URL" instead of
 * saving a dead value.
 */
export function normaliseServiceUrl(input: unknown): string {
  const raw = String(input ?? '').trim();
  if (!raw) return '';

  const marked = URL_IN_TEXT.exec(raw);
  let value: string;
  if (marked) {
    value = stripWrap(marked[0]);
  } else {
    const token = raw
      .split(/\s+/)
      .map(stripWrap)
      .find((part) => HOST_LIKE.test(part));
    if (!token) return '';
    value = token;
  }

  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  try {
    const parsed = new URL(value);
    if (!parsed.hostname) return '';
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
  } catch {
    return '';
  }
}

/** `DEMUCS_API_KEY=…` — the name the Colab script and the READMEs use. */
const LABELLED_KEY =
  /^(?:[A-Za-z0-9]+_)+\s*(?:KEY|TOKEN|SECRET)\s*[:=]\s*(.+)$/i;

/** `API Key : …` / `key: …` — how the Colab report spells the same field. */
const PLAIN_LABEL = /^(?:api[\s_-]*)?(?:key|token|secret)\s*[:=]\s*(.+)$/i;

function labelOf(line: string): string | null {
  const match = LABELLED_KEY.exec(line) ?? PLAIN_LABEL.exec(line);
  return match ? match[1] : null;
}

/**
 * The key inside whatever was pasted.
 *
 * A whole block is handled as well as a single value: the line that carries a key
 * label wins over the first line, so pasting the Colab report into the key field
 * fills the key rather than the URL that happens to be printed above it. Returns
 * `''` when no key can be recognised, which callers read as "keep the stored one".
 */
export function normaliseServiceKey(input: unknown): string {
  const lines = String(input ?? '')
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';

  const labelled = lines.map(labelOf).find((value): value is string => Boolean(value));
  const value = labelled ?? lines[0];

  return stripWrap(value.replace(/^bearer\s+/i, ''));
}

/**
 * Both values out of one paste, for the panels' paste handlers.
 *
 * `url` is `''` when the text holds no address and `apiKey` is `''` when it holds
 * no labelled key, so a plain paste leaves the other field alone. The key is only
 * taken from a labelled line: without that rule every pasted URL would look like a
 * key, and the field would be filled with the address.
 */
export function parseServicePaste(input: unknown): { url: string; apiKey: string } {
  const text = String(input ?? '').trim();
  if (!text) return { url: '', apiKey: '' };

  const url = normaliseServiceUrl(text);
  const labelled = text
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(labelOf)
    .find((value): value is string => Boolean(value));

  return {
    url,
    apiKey: labelled ? normaliseServiceKey(labelled) : '',
  };
}

/**
 * What the owner is told when what they pasted cannot be read as an address.
 * Names the two shapes that actually arrive from Colab, so the fix is obvious.
 */
export const SERVICE_URL_REJECTED_MESSAGE =
  'URL មិនត្រឹមត្រូវទេ។ សូម paste URL ដែល Colab បង្ហាញ (ឧ. https://xxxx.trycloudflare.com) — ' +
  'paste ទាំងបន្ទាត់ «URL : …» ក៏បាន ព្រោះប្រព័ន្ធស្រង់យកតែ URL។ ' +
  '(That does not look like a service address. Paste the URL Colab printed, e.g. https://xxxx.trycloudflare.com — ' +
  'pasting the whole “URL : …” line works too, only the address is kept.)';
