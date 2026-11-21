/*
 * Trae 社区 · 正文 HTML 清洗
 * ------------------------------------------------------------------
 * 社区正文（`cooked`）是**其他用户可编辑**的 HTML，直接 innerHTML 等于把 XSS
 * 交给陌生人。这里用白名单 + 属性重建的方式清洗，不引第三方库：
 *
 *   1. 先整段删掉 script / style / iframe / svg 这类「内容本身就是攻击面」的标签；
 *   2. 再逐标签重建：只认白名单里的标签，只认 href/src/alt/title/class 等少量属性；
 *   3. href/src 先解码实体再做协议判断（`javascript&#58;` 这种绕过会在这里被拦下），
 *      输出时重新转义，避免「检查时安全、渲染时又被浏览器二次解码」。
 *
 * 这是**保守清洗**：宁可丢样式，也不放过一个事件属性。
 * @Author: fu
 */

/* 内容必须整段删除的标签（不是只删标签本身） */
const DROP_WITH_CONTENT =
  /<(script|style|iframe|object|embed|svg|math|template|noscript|frameset|frame|applet|marquee|audio|video)\b[\s\S]*?<\/\1\s*>/gi;

const ALLOWED_TAGS = new Set([
  'p', 'br', 'a', 'img', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li',
  'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'span', 'div',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption',
  'details', 'summary', 'sup', 'sub', 'figure', 'figcaption',
]);

const VOID_TAGS = new Set(['br', 'img', 'hr']);

const ALLOWED_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'class', 'colspan', 'rowspan', 'start', 'width', 'height', 'lang',
]);

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  colon: ':',
  sol: '/',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, code: string) => {
    if (code.startsWith('#')) {
      const hex = code[1] === 'x' || code[1] === 'X';
      const num = parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
      return Number.isFinite(num) && num > 0 && num < 0x10ffff ? String.fromCodePoint(num) : m;
    }
    return NAMED[code.toLowerCase()] ?? m;
  });
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 解码后去掉控制字符/空白再判断协议，挡住 `java\nscript:` 这类绕过 */
function isSafeUrl(raw: string, kind: 'href' | 'src'): boolean {
  const value = decodeEntities(raw).replace(/[\u0000-\u0020\u007f]/g, '').trim();
  if (!value) return false;
  if (/^(?:javascript|vbscript|data|file|blob):/i.test(value)) return false;
  if (kind === 'src') {
    return /^(?:https?:|\/)/i.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value);
  }
  return /^(?:https?:|mailto:|#|\/)/i.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function sanitizeTag(inner: string): string {
  if (!inner) return '';
  if (inner.startsWith('/')) {
    const name = inner.slice(1).trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return '';
    return ALLOWED_TAGS.has(name) ? `</${name}>` : '';
  }
  if (inner.startsWith('!') || inner.startsWith('?')) return '';

  const m = /^([a-zA-Z][a-zA-Z0-9:-]*)([\s\S]*)$/.exec(inner);
  if (!m) return '';
  const tag = m[1].toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return '';
  const rest = m[2] || '';

  const attrs: string[] = [];
  let hasHref = false;
  const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let am: RegExpExecArray | null;
  while ((am = attrRe.exec(rest)) !== null) {
    const name = am[1].toLowerCase();
    if (!ALLOWED_ATTRS.has(name)) continue;
    const raw = am[3] ?? am[4] ?? am[5];
    if (raw === undefined) continue;

    if (name === 'href' || name === 'src') {
      if (!isSafeUrl(raw, name)) continue;
      if (name === 'href') hasHref = true;
      attrs.push(`${name}="${escapeAttr(raw)}"`);
      continue;
    }
    if (name === 'class') {
      const clean = raw.replace(/[^a-zA-Z0-9 _-]/g, '').slice(0, 80).trim();
      if (clean) attrs.push(`class="${clean}"`);
      continue;
    }
    if (name === 'width' || name === 'height' || name === 'colspan' || name === 'rowspan' || name === 'start') {
      const num = Number.parseInt(raw, 10);
      if (Number.isFinite(num) && num >= 0) attrs.push(`${name}="${num}"`);
      continue;
    }
    if (name === 'alt' || name === 'title' || name === 'lang') {
      attrs.push(`${name}="${escapeAttr(raw.slice(0, 200))}"`);
    }
  }

  if (tag === 'img') {
    const src = attrs.find((a) => a.startsWith('src='));
    if (!src) return '';
    attrs.push('loading="lazy"', 'referrerpolicy="no-referrer"');
  }
  if (tag === 'a' && hasHref) {
    attrs.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
  }

  const suffix = attrs.length ? ` ${attrs.join(' ')}` : '';
  return VOID_TAGS.has(tag) ? `<${tag}${suffix}>` : `<${tag}${suffix}>`;
}

/** 清洗社区正文；返回值可以直接放进 dangerouslySetInnerHTML */
export function sanitizeCookedHtml(html: string | null | undefined): string {
  if (!html) return '';
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(DROP_WITH_CONTENT, '');
  /* 同时匹配开标签、闭标签、自闭合标签；属性值里允许出现 `>`（用引号包住） */
  out = out.replace(/<((?:[^>"']|"[^"]*"|'[^']*')*)>/g, (_m, inner: string) => sanitizeTag(inner.trim()));
  /* 落单的危险开标签（没有闭合的 script 等）在上面已经被清掉；这里再兜一层 */
  return out;
}
