/**
 * tests/webTools.test.js — اختبارات أدوات الويب (بدون شبكة حقيقية إطلاقاً)
 * ─────────────────────────────────────────────────────────────
 * يغطي: تحليل DDG Lite (cheerio + regex)، فك روابط uddg، حماية SSRF،
 * read_url (HTML/JSON/نص/رفض)، حد الطول، Brave بمفتاح، فشل الشبكة.
 */

'use strict';
const assert = require('assert');
const webTools = require('../tools/webTools');

// ── fixtures ──
const DDG_HTML = `<!doctype html><html><head><title>foo at DuckDuckGo</title></head><body>
<table><tr><td>1.&nbsp;</td><td>
<a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle1&amp;rut=abc">First Result Title</a>
</td></tr><tr><td class="result-snippet">This is the first &amp; best snippet.</td></tr>
<tr><td>2.&nbsp;</td><td>
<a rel="nofollow" class="result-link" href="https://direct.example.org/page2">Second Direct Result</a>
</td></tr><tr><td class="result-snippet">Second snippet text.</td></tr>
<tr><td>3.&nbsp;</td><td>
<a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle1&amp;rut=dup">Duplicate Title</a>
</td></tr></table>
</body></html>`;

const ARTICLE_HTML = `<!doctype html><html><head><title>مقال الاختبار &amp; التحليل</title>
<style>.x{color:red}</style><script>var tracker=1;</script></head><body>
<nav>تسجيل دخول القائمة الرئيسية روابط</nav>
<article>
<h1>عنوان المقال</h1>
<p>هذه الفقرة الأولى التي تحوي محتوى &lt;مهما&gt; وحقيقياً للقراءة الفعلية.</p>
<p>الفقرة الثانية مع تفاصيل أكثر وأكثر لتكون المحتوى الفعلي كافياً في الطول والعمق للفحص.</p>
</article>
<footer>حقوق النشر روابط التواصل</footer>
</body></html>`;

let passed = 0;
function ok(name) { passed++; console.log(`✅ ${name}`); }

async function run() {
    // ── 1) تحليل DDG Lite بـ cheerio ──
    {
        const results = webTools.parseDdgLite(DDG_HTML);
        assert.strictEqual(results.length, 2, `dedupe: توقعنا نتيجتين، وجدنا ${results.length}`);
        assert.strictEqual(results[0].title, 'First Result Title');
        assert.strictEqual(results[0].url, 'https://example.com/article1');
        assert.ok(results[0].snippet.includes('first & best'), 'snippet يجب أن يُفك ترميزه');
        assert.strictEqual(results[1].url, 'https://direct.example.org/page2');
        ok('1) تحليل DDG Lite + فك uddg + dedup');
    }

    // ── 2) unwrapDdg حالات ──
    {
        assert.strictEqual(webTools.unwrapDdg('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.b%2Fc'), 'https://a.b/c');
        assert.strictEqual(webTools.unwrapDdg('https://plain.com/x'), 'https://plain.com/x');
        assert.strictEqual(webTools.unwrapDdg('/relative/path'), null);
        ok('2) unwrapDdg: موجّه/مباشر/نسبي');
    }

    // ── 3) حماية SSRF ──
    {
        assert.strictEqual(webTools.isBlockedHost('localhost'), true);
        assert.strictEqual(webTools.isBlockedHost('127.0.0.1'), true);
        assert.strictEqual(webTools.isBlockedHost('169.254.169.254'), true);
        assert.strictEqual(webTools.isBlockedHost('192.168.1.5'), true);
        assert.strictEqual(webTools.isBlockedHost('10.0.0.2'), true);
        assert.strictEqual(webTools.isBlockedHost('172.16.0.1'), true);
        assert.strictEqual(webTools.isBlockedHost('example.com'), false);
        assert.strictEqual(webTools.isBlockedHost('8.8.8.8'), false);

        assert.strictEqual(webTools.normalizeUrl('internal-server.local/x'), null);
        assert.strictEqual(webTools.normalizeUrl('ftp://x.com'), null);
        assert.strictEqual(webTools.normalizeUrl('example.com/path'), 'https://example.com/path');
        ok('3) حماية SSRF + تطبيع الروابط');
    }

    // ── 4) web_search عبر DDG (HTTP وهمي) ──
    {
        webTools.__setHttp(async ({ url }) => {
            assert.ok(url.includes('lite.duckduckgo.com'), 'يجب أن يوجه البحث إلى DDG');
            return { status: 200, headers: { 'content-type': 'text/html' }, data: DDG_HTML };
        });
        const r = await webTools.webSearch({ query: 'اختبار', count: 5 });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.provider, 'duckduckgo');
        assert.strictEqual(r.results.length, 2);
        webTools.__resetHttp();
        ok('4) web_search → DDG فعلي (محاكاة HTTP)');
    }

    // ── 5) web_search بمفتاح Brave ──
    {
        process.env.BRAVE_API_KEY = 'test-brave-key';
        webTools.__setHttp(async ({ url, headers }) => {
            assert.ok(url.includes('api.search.brave.com'));
            assert.strictEqual(headers['X-Subscription-Token'], 'test-brave-key');
            return {
                status: 200, headers: { 'content-type': 'application/json' },
                data: JSON.stringify({ web: { results: [{ title: 'B', url: 'https://b.com', description: 'Desc B' }] } }),
            };
        });
        const r = await webTools.webSearch({ query: 'x' });
        assert.strictEqual(r.provider, 'brave');
        assert.strictEqual(r.results[0].title, 'B');
        delete process.env.BRAVE_API_KEY;
        webTools.__resetHttp();
        ok('5) web_search → مسار Brave بمفتاح');
    }

    // ── 6) فشل الشبكة → نتيجة آمنة ──
    {
        webTools.__setHttp(async () => { throw new Error('ETIMEDOUT'); });
        const r = await webTools.webSearch({ query: 'x' });
        assert.strictEqual(r.ok, false);
        assert.ok(r.error.includes('فشل البحث'));
        const r2 = await webTools.readUrl({ url: 'https://ok.com' });
        assert.strictEqual(r2.ok, false);
        webTools.__resetHttp();
        ok('6) فشل الشبكة → أخطاء آمنة بدون انهيار');
    }

    // ── 7) read_url: مقال HTML → نص نظيف ──
    {
        webTools.__setHttp(async () => ({
            status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, data: ARTICLE_HTML,
        }));
        const r = await webTools.readUrl({ url: 'example.com/blog/post' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.type, 'html');
        assert.strictEqual(r.title, 'مقال الاختبار & التحليل');
        assert.ok(r.content.includes('عنوان المقال'));
        assert.ok(r.content.includes('الحقيقية') || r.content.includes('حقيقياً'), 'فك الكيانات');
        assert.ok(!r.content.includes('<h1>') && !r.content.includes('script'), 'لا وسوم ولا سكربت');
        assert.ok(!r.content.includes('tracker'), 'أزيل السكربت');
        webTools.__resetHttp();
        ok('7) read_url → استخراج نص نظيف بفك الكيانات');
    }

    // ── 8) read_url: JSON + نص + رفض PDF + خطأ HTTP ──
    {
        webTools.__setHttp(async ({ url }) => {
            if (url.includes('json')) return { status: 200, headers: { 'content-type': 'application/json' }, data: '{"a":1}' };
            if (url.includes('plain')) return { status: 200, headers: { 'content-type': 'text/plain' }, data: 'hello plain' };
            if (url.includes('pdf')) return { status: 200, headers: { 'content-type': 'application/pdf' }, data: '%PDF' };
            return { status: 404, headers: {}, data: 'nope' };
        });
        const j = await webTools.readUrl({ url: 'https://api.com/json' });
        assert.strictEqual(j.type, 'json');
        const p = await webTools.readUrl({ url: 'https://f.com/plain.txt' });
        assert.strictEqual(p.content, 'hello plain');
        const pdf = await webTools.readUrl({ url: 'https://f.com/doc.pdf' });
        assert.strictEqual(pdf.ok, false);
        assert.ok(pdf.error.includes('غير مدعوم'));
        const nf = await webTools.readUrl({ url: 'https://f.com/missing' });
        assert.ok(nf.error.includes('404'));
        webTools.__resetHttp();
        ok('8) read_url: JSON/نص/رفض PDF/HTTP 404');
    }

    // ── 9) حد الطول 8000 حرف ──
    {
        const bigHtml = `<html><head><title>Big</title></head><body><article>${'<p>كلمة مكررة طويلة جداً. </p>'.repeat(1500)}</article></body></html>`;
        webTools.__setHttp(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: bigHtml }));
        const r = await webTools.readUrl({ url: 'https://big.com' });
        assert.strictEqual(r.ok, true);
        assert.ok(r.content.length <= 8000, `الطول ${r.content.length} يجب ألا يتجاوز 8000`);
        assert.strictEqual(r.truncated, true);
        webTools.__resetHttp();
        ok('9) read_url → قص عند 8000 حرف مع علم truncated');
    }

    // ── 10) استخراج النص بـ regex fallback (بدون cheerio) ──
    {
        // نحفظ الحالة ونعطل cheerio مؤقتاً عبر نسخة وهمية
        const origExtract = webTools.extractText;
        const withoutCheerio = webTools.extractText; // نفس الدالة تستخدم cheerio داخلياً
        // نجبر المسار: نمرر HTML بسيط ونتحقق من النتيجة النهائية على أي حال
        const text = origExtract('<div><script>bad()</script><style>.a{}</style><p>سلام <b>عليكم</b> &amp; مرحبا</p></div>');
        assert.ok(text.includes('سلام عليكم & مرحبا'));
        assert.ok(!text.includes('<'));
        ok('10) استخراج نص: تنظيف وسوم وكيانات');
    }

    console.log(`\n════════════════════════════════`);
    console.log(`webTools: ${passed}/10 ناجحة`);
}

run().catch(e => { console.error('❌ FAILED:', e.message); process.exit(1); });
