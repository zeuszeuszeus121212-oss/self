/**
 * tools/webTools.js — Disor Bot v7.2 "Real Agent"
 * ═══════════════════════════════════════════════════════════
 * أدوات الويب الحقيقية للوكيل — حواس خارج ديسكورد:
 *   • webSearch({query, count, lang})  → نتائج بحث فعلي
 *       - افتراضياً: DuckDuckGo Lite (بدون أي مفاتيح)
 *       - اختيارياً: Brave Search API  (BRAVE_API_KEY) أو SerpAPI (SERPAPI_KEY)
 *   • readUrl({url})                    → جلب صفحة وتنظيفها لنص مقروء
 *       - حماية: منع SSRF، فحص content-type، حد حجم، timeout
 *
 * قابلية الاختبار: يمكن حقن طبقة HTTP وهمية عبر __setHttp() —
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
const SEARCH_TIMEOUT_MS = 15_000;

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
//  web_search — DuckDuckGo Lite (بدون مفاتيح) + Brave/SerpAPI اختياري
// ═══════════════════════════════════════════════════════════

async function webSearch({ query, count = 8, lang = 'en' } = {}) {
    const q = String(query || '').trim();
    if (!q) return { ok: false, error: 'استعلام البحث فارغ', results: [] };
    count = Math.min(Math.max(Number(count) || 8, 1), 15);

    const { BRAVE_API_KEY, SERPAPI_KEY } = process.env;

    try {
        if (BRAVE_API_KEY) return await braveSearch(q, count, BRAVE_API_KEY);
        if (SERPAPI_KEY) return await serpApiSearch(q, count, SERPAPI_KEY);
        return await ddgSearch(q, count, lang);
    } catch (e) {
        return { ok: false, error: `فشل البحث: ${String(e.message).slice(0, 200)}`, results: [] };
    }
}

/** DuckDuckGo Lite — تحليل HTML بدون مفاتيح */
async function ddgSearch(q, count, lang) {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}${lang ? `&kl=${lang}-${lang}` : ''}`;
    const resp = await httpGet({
        url,
        headers: {
            'User-Agent': UA_BROWSER,
            'Accept': 'text/html,application/xhtml+xml',
            'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
        },
        timeout: SEARCH_TIMEOUT_MS,
    });
    if (resp.status !== 200) {
        return { ok: false, error: `DuckDuckGo رجع HTTP ${resp.status}`, results: [] };
    }
    const results = parseDdgLite(String(resp.data)).slice(0, count);
    if (!results.length) {
        return { ok: true, results: [], note: 'لا نتائج لهذا الاستعلام' };
    }
    return { ok: true, provider: 'duckduckgo', results };
}

/** تحليل صفحة DDG Lite — يعمل بـ cheerio إن وجد وإلا regex */
function parseDdgLite(html) {
    const results = [];
    if (cheerio) {
        const $ = cheerio.load(html);
        $('a.result-link').each((_, el) => {
            const href = $(el).attr('href') || '';
            const title = clean($(el).text());
            const snippet = clean($(el).closest('tr').next().find('td.result-snippet').text());
            const realUrl = unwrapDdg(href);
            if (realUrl && title) results.push({ title, url: realUrl, snippet });
        });
        return dedupe(results);
    }

    // regex fallback: روابط بترتيب، ثم snippets
    const linkRe = /<a[^>]+class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snipRe = /class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
    const snippets = [];
    let sm;
    while ((sm = snipRe.exec(html)) !== null) snippets.push(clean(stripTags(sm[1])));
    let lm; let i = 0;
    while ((lm = linkRe.exec(html)) !== null) {
        const realUrl = unwrapDdg(lm[1]);
        const title = clean(stripTags(lm[2]));
        if (realUrl && title) {
            results.push({ title, url: realUrl, snippet: snippets[i] || '' });
        }
        i++;
    }
    return dedupe(results);
}

/** روابط DDG تكون موجّهة عبر /l/?uddg= — نستخرج الرابط الحقيقي */
function unwrapDdg(href) {
    try {
        if (href.startsWith('//duckduckgo.com/l/') || href.includes('duckduckgo.com/l/')) {
            const u = new URL(href.startsWith('//') ? 'https:' + href : href);
            const real = u.searchParams.get('uddg');
            if (real) return decodeURIComponent(real);
            return null;
        }
        if (/^https?:\/\//i.test(href)) return href;
        return null;
    } catch (_) {
        return null;
    }
}

/** Brave Search API — يتطلب BRAVE_API_KEY */
async function braveSearch(q, count, key) {
    const resp = await httpGet({
        url: `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${count}`,
        headers: {
            'Accept': 'application/json',
            'X-Subscription-Token': key,
            'User-Agent': UA_BROWSER,
        },
        timeout: SEARCH_TIMEOUT_MS,
    });
    if (resp.status !== 200) return { ok: false, error: `Brave رجع HTTP ${resp.status}`, results: [] };
    let data;
    try { data = JSON.parse(resp.data); } catch (_) { return { ok: false, error: 'Brave رجع JSON غير صالح', results: [] }; }
    const items = (data.web && Array.isArray(data.web.results)) ? data.web.results : [];
    const results = items.slice(0, count).map(r => ({
        title   : clean(String(r.title || '')),
        url     : String(r.url || ''),
        snippet : clean(String(r.description || '')),
    })).filter(r => r.url);
    return { ok: true, provider: 'brave', results };
}

/** SerpAPI — يتطلب SERPAPI_KEY */
async function serpApiSearch(q, count, key) {
    const resp = await httpGet({
        url: `https://serpapi.com/search.json?q=${encodeURIComponent(q)}&num=${count}&api_key=${encodeURIComponent(key)}`,
        headers: { 'User-Agent': UA_BROWSER },
        timeout: SEARCH_TIMEOUT_MS,
    });
    if (resp.status !== 200) return { ok: false, error: `SerpAPI رجع HTTP ${resp.status}`, results: [] };
    let data;
    try { data = JSON.parse(resp.data); } catch (_) { return { ok: false, error: 'SerpAPI رجع JSON غير صالح', results: [] }; }
    const items = Array.isArray(data.organic_results) ? data.organic_results : [];
    const results = items.slice(0, count).map(r => ({
        title   : clean(String(r.title || '')),
        url     : String(r.link || ''),
        snippet : clean(String(r.snippet || '')),
    })).filter(r => r.url);
    return { ok: true, provider: 'serpapi', results };
}

function dedupe(results) {
    const seen = new Set();
    const out = [];
    for (const r of results) {
        const key = r.url.replace(/\/+$/, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r);
    }
    return out;
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
    webSearch,
    readUrl,
    // داخلية — للاختبارات والصيانة
    parseDdgLite,
    unwrapDdg,
    normalizeUrl,
    isBlockedHost,
    extractText,
    extractTitle,
    clean,
    stripTags,
    __setHttp,
    __resetHttp,
};
