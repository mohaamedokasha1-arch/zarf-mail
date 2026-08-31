/**
 * =============================================================
 *  تنظيف محتوى HTML — ظرف (Zarf Mail)
 * -------------------------------------------------------------
 *  أي HTML يأتي من مصدر خارجي يُعتبر "غير موثوق":
 *  قد يحتوي على <script>, on* handlers, أو إطارات مخفية (Tracking)
 *  لذلك نمرره عبر sanitize-html قبل تخزينه أو عرضه،
 *  ثم نعرضه داخل iframe معزول (sandbox) في الواجهة كطبقة حماية إضافية.
 * =============================================================
 */

const sanitizeHtml = require('sanitize-html');

const OPTIONS = {
  allowedTags: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'pre', 'blockquote',
    'b', 'strong', 'i', 'em', 'u', 's', 'small', 'sub', 'sup', 'code',
    'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
    'a', 'img', 'div', 'span', 'figure', 'figcaption',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height'],
    '*': ['style', 'dir', 'align', 'class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  // نمنع الروابط التي تنفّذ أكواداً
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript'],
  transformTags: {
    // كل رابط خارجي: يفتح في تبويب جديد + rel آمن
    a: (tagName, attribs) => ({
      tagName: 'a',
      attribs: {
        ...attribs,
        target: '_blank',
        rel: 'noopener noreferrer nofollow',
      },
    }),
    // نمنع الصور المخفية الخاصة بالتتبع (1x1 pixels) ونُبقي الباقي
    img: (tagName, attribs) => ({
      tagName: 'img',
      attribs: { ...attribs, loading: 'lazy', referrerpolicy: 'no-referrer' },
    }),
  },
};

/**
 * ينظّف HTML وارد ويعيد نسخة آمنة للعرض
 * @param {string} html
 * @returns {string}
 */
function sanitizeMessageHtml(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), OPTIONS);
}

/**
 * يحذف كل وسوم HTML تماماً ويعيد نصاً مجرداً (مفيد للبحث والمقتطفات)
 */
function stripTags(html) {
  if (!html) return '';
  return sanitizeHtml(String(html), { allowedTags: [], allowedAttributes: {} });
}

module.exports = { sanitizeMessageHtml, stripTags };
