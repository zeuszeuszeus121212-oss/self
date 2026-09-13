/**
 * tools/webTools.js — Disor Bot v7.4 "Nexus"
 * ═══════════════════════════════════════════════════════════
 * read_url فقط — جلب صفحة وتنظيفها لنص مقروء.
 *
 * ⚠️ ملاحظة v7.4: أداة البحث (web_search) حُذفت نهائياً —
 * كل نموذج أصبح يملك بحثاً مدمجاً أفضل (يُفعَّل من قدرات الوكيل:
 * capabilities.search) ولا حاجة لمتصفح بحث خارجي داخل البوت.
 * بقي read_url لأنه ليس بحثاً: قراءة رابط يلصقه المستخدم مباشرة.
 *
 * قابلية الاختبار: حقن طبقة HTTP وهمية عبر __setHttp() —
 * الاختبارات لا تلمس الشبكة الحقيقية إطلاقاً.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const axios = require('axios');

// cheerio اختياري — إن وُجد استُخدم لتحليل أقوى، وإلا regex آمن
let cheerio = null;
try { cheerio = require('cheerio'); } catch (_) {}

const UA_BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;   // 2MB حد للصفحة
const READ_TIMEOUT_MS = 20_000;
const MAX_READ_CHARS = 8_000;

// ── طبقة HTTP قابلة للحقن (للاختبارات) ──
let httpImpl = null;
function __setHttp(fn) { httpImpl = fn; } // fn({url, method, headers, data, timeout, maxBytes}) → {status, headers, data}
function __resetHttp() { httpImpl = null; }

async function httpGet({ url, headers = {}, timeout = READ_TIMEOUT_MS, responseType = 'text' }) {
    if (httpImpl) return httpGetAdapter(httpImpl, { url, headers, timeout });
    const resp = await axios.get(url, {
        headers,
        timeout,
        responseType: 'arraybuffer',
        maxContentLength: MAX_PAGE_BYTES,
        validateStatus: () => true,
    });
    const ct = String(resp.headers['content-type'] || '');
    let data = resp.data;
    if (responseType === 'text' || true) {
        data = bufferToText(Buffer.from(data));
    }
    return { status: resp.status, headers: resp.headers, contentType: ct, data };
}

async function httpGetAdapter(fn, { url, headers, timeout }) {
    const r = await fn({ url, method: 'GET', headers, timeout });
    return {
        status: r.status,
        headers: r.headers || {},
        contentType: r.contentType || String((r.headers || {})['content-type'] || ''),
        data: typeof r.data === 'string' ? r.data : bufferToText(Buffer.from(r.data || '')),
    };
}

function bufferToText(buf) {
    return buf.toString('utf8');
}

// ═══════════════════════════════════════════════════════════
//  حماية SSRF — منع جلب العناوين الداخلية
// ═══════════════════════════════════════════════════════════

function isBlockedHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (h === '0.0.0.0' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return true;
    if (h === '169.254.169.254') return true; // metadata clouds
    // نطاقات IP خاصة
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
        const [a, b] = [Number(m[1]), Number(m[2])];
        if (a === 10 || a === 127) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;
        if (a === 0) return true;
    }
    return false;
}

function normalizeUrl(raw) {
    let u = String(raw || '').trim();
    if (!u) return null;
    // أي مخطط معلن غير http/https يُرفض فوراً
    const schemeMatch = u.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (schemeMatch && !/^https?:\/\//i.test(u)) return null;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    try {
        const parsed = new URL(u);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        if (isBlockedHost(parsed.hostname)) return null;
        return parsed.toString();
    } catch (_) {
        return null;
    }
}

// ═══════════════════════════════════════════════════════════
//  read_url — جلب صفحة وتنظيفها لنص مقروء
// ═══════════════════════════════════════════════════════════

async function readUrl({ url } = {}) {
    const normalized = normalizeUrl(url);
    if (!normalized) {
        return { ok: false, error: 'رابط غير صالح أو محجوب (العناوين الداخلية ممنوعة)' };
    }

    let resp;
    try {
        resp = await httpGet({
            url   : normalized,
            headers: {
                'User-Agent'      : UA_BROWSER,
                'Accept'          : 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
                'Accept-Language' : 'en-US,en;q=0.9,ar;q=0.8',
            },
            timeout: READ_TIMEOUT_MS,
        });
    } catch (e) {
        return { ok: false, error: `فشل جلب الصفحة: ${String(e.message).slice(0, 200)}` };
    }

    if (resp.status !== 200) {
        return { ok: false, error: `الصفحة رجعت HTTP ${resp.status}` };
    }

    const ct = String(resp.contentType || resp.headers['content-type'] || '').toLowerCase();

    // JSON — نعرضه كما هو (مقصوص)
    if (ct.includes('application/json')) {
        return {
            ok     : true,
            url    : normalized,
            type   : 'json',
            content: String(resp.data).slice(0, MAX_READ_CHARS),
        };
    }

    // نص خام
    if (ct.startsWith('text/plain') || ct.startsWith('text/')) {
        if (ct.includes('html')) { /* تكمل للتحليل تحت */ }
        else {
            return { ok: true, url: normalized, type: 'text', content: String(resp.data).slice(0, MAX_READ_CHARS) };
        }
    }

    if (!ct.includes('html') && !ct.startsWith('text/')) {
        return { ok: false, error: `نوع المحتوى غير مدعوم للقراءة: ${ct || 'غير معروف'}` };
    }

    const html = String(resp.data);
    const title = extractTitle(html);
    const text = extractText(html);

    if (!text) {
        return { ok: false, error: 'الصفحة فارغة أو مبنية بجافاسكربت كاملاً لا يمكن قراءتها بدون متصفح' };
    }

    return {
        ok     : true,
        url    : normalized,
        type   : 'html',
        title,
        content: text.slice(0, MAX_READ_CHARS),
        truncated: text.length > MAX_READ_CHARS,
    };
}

function extractTitle(html) {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? clean(stripTags(m[1])).slice(0, 200) : '';
}

/** استخراج نص رئيسي من HTML — cheerio إن وجد وإلا regex نظيف */
function extractText(html) {
    if (cheerio) {
        const $ = cheerio.load(html);
        $('script, style, noscript, iframe, svg, nav, footer, header aside, form, button').remove();
        // محاولة مناطق المحتوى الرئيسي أولاً
        const mainSelectors = ['article', 'main', '[role="main"]', '.post-content', '.article-content', '#content', '.content'];
        let text = '';
        for (const sel of mainSelectors) {
            const node = $(sel).first();
            if (node.length && clean(node.text()).length > 300) {
                text = clean(node.text());
                break;
            }
        }
        if (!text) text = clean($('body').text());
        return text;
    }

    // regex fallback
    let h = html;
    h = h.replace(/<script[\s\S]*?<\/script>/gi, ' ')
         .replace(/<style[\s\S]*?<\/style>/gi, ' ')
         .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
         .replace(/<!--[\s\S]*?-->/g, ' ')
         .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n');
    h = stripTags(h);
    return clean(h);
}

// ═══════════════════════════════════════════════════════════
//  أدوات تنظيف نص مشتركة
// ═══════════════════════════════════════════════════════════

const ENTITIES = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
    '&#x27;': "'", '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–',
    '&hellip;': '…', '&rsquo;': '\u2019', '&lsquo;': '\u2018',
    '&ldquo;': '\u201C', '&rdquo;': '\u201D', '&#x2F;': '/', '&#x60;': '`',
};

function stripTags(s) {
    return String(s).replace(/<[^>]+>/g, ' ');
}

function clean(s) {
    let out = String(s || '');
    for (const [ent, ch] of Object.entries(ENTITIES)) {
        out = out.split(ent).join(ch);
    }
    out = out.replace(/&#(\d+);/g, (_, n) => {
        try { return String.fromCodePoint(Number(n)); } catch (_) { return ' '; }
    });
    return out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = {
    readUrl,
    // داخلية — للاختبارات والصيانة
    normalizeUrl,
    isBlockedHost,
    extractText,
    extractTitle,
    clean,
    stripTags,
    __setHttp,
    __resetHttp,
};
