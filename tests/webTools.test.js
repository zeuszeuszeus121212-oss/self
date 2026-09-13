/**
 * tests/webTools.test.js — اختبارات read_url (بدون شبكة حقيقية إطلاقاً)
 * ─────────────────────────────────────────────────────────────
 * v7.4: أداة البحث (web_search) حُذفت نهائياً — البحث مسؤولية النموذج المدمج.
 * تبقى اختبارات: حماية SSRF، read_url (HTML/JSON/نص/رفض)، حد الطول، فشل الشبكة.
 */

'use strict';
const assert = require('assert');
const webTools = require('../tools/webTools');

// ── fixtures ──
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
    // ── 1) web_search محذوفة نهائياً من الوحدة ──
    {
        assert.strictEqual(typeof webTools.webSearch, 'undefined', 'webSearch يجب أن تكون محذوفة');
        assert.strictEqual(typeof webTools.parseDdgLite, 'undefined', 'محلل DDG يجب أن يكون محذوفاً');
        ok('1) web_search حُذفت نهائياً من webTools (البحث مسؤولية النموذج المدمج)');
    }

    // ── 2) حماية SSRF ──
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
        ok('2) حماية SSRF + تطبيع الروابط');
    }

    // ── 3) فشل الشبكة → نتيجة آمنة ──
    {
        webTools.__setHttp(async () => { throw new Error('ETIMEDOUT'); });
        const r2 = await webTools.readUrl({ url: 'https://ok.com' });
        assert.strictEqual(r2.ok, false);
        webTools.__resetHttp();
        ok('3) فشل الشبكة → أخطاء آمنة بدون انهيار');
    }

    // ── 4) read_url: مقال HTML → نص نظيف ──
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
        ok('4) read_url → استخراج نص نظيف بفك الكيانات');
    }

    // ── 5) read_url: JSON + نص + رفض PDF + خطأ HTTP ──
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
        ok('5) read_url: JSON/نص/رفض PDF/HTTP 404');
    }

    // ── 6) حد الطول 8000 حرف ──
    {
        const bigHtml = `<html><head><title>Big</title></head><body><article>${'<p>كلمة مكررة طويلة جداً. </p>'.repeat(1500)}</article></body></html>`;
        webTools.__setHttp(async () => ({ status: 200, headers: { 'content-type': 'text/html' }, data: bigHtml }));
        const r = await webTools.readUrl({ url: 'https://big.com' });
        assert.strictEqual(r.ok, true);
        assert.ok(r.content.length <= 8000, `الطول ${r.content.length} يجب ألا يتجاوز 8000`);
        assert.strictEqual(r.truncated, true);
        webTools.__resetHttp();
        ok('6) read_url → قص عند 8000 حرف مع علم truncated');
    }

    console.log(`\n════════════════════════════════`);
    console.log(`webTools: ${passed}/6 ناجحة`);
    if (passed !== 6) process.exit(1);
}

run().catch(e => { console.error('❌ FAILED:', e.message); process.exit(1); });
