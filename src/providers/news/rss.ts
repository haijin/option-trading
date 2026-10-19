/** A small RSS 2.0 reader: enough for the Yahoo Finance and CNBC feeds, with no XML dependency. */

export interface RssItem {
  title: string;
  link: string;
  description: string | null;
  pubDate: Date | null;
  guid: string | null;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the XML and HTML entities a feed or HKEXnews uses; unknown entities are left as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    if (body.startsWith('#')) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/** Tags removed, entities decoded (twice: feeds often double-encode), whitespace collapsed. */
export function plainText(s: string): string {
  const noCdata = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const once = decodeEntities(noCdata).replace(/<[^>]*>/g, ' ');
  return decodeEntities(once)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? (m[1] as string) : null;
}

/** Items of an RSS 2.0 document, in document order. Items without a title or link are dropped. */
export function parseRss(xml: string): RssItem[] {
  const out: RssItem[] = [];
  for (const m of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = m[1] as string;
    const title = plainText(tag(block, 'title') ?? '');
    const link = plainText(tag(block, 'link') ?? '');
    if (!title || !link) continue;
    const desc = tag(block, 'description');
    const pub = tag(block, 'pubDate');
    const guid = tag(block, 'guid');
    const ms = pub ? Date.parse(plainText(pub)) : Number.NaN;
    out.push({
      title,
      link,
      description: desc ? plainText(desc).slice(0, 600) || null : null,
      pubDate: Number.isFinite(ms) ? new Date(ms) : null,
      guid: guid ? plainText(guid) : null,
    });
  }
  return out;
}
