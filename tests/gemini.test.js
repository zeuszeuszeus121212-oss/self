/**
 * tests/gemini.test.js — اختبارات مزود Gemini (الكوكيز) بخادم وهمي محلي
 * ─────────────────────────────────────────────────────────────
 * يغطي: التحقق من الكوكيز، تحليل/دمج الكوكيز، استخراج SNlM0e/FdrFJe،
 * تفكيك الرد المتدفق التزايدي، تتبع محادثة Gemini، إعادة استخدام الجلسة،
 * اختبار الاتصال الحقيقي — كل ذلك دون لمس gemini.google.com.
 */

'use strict';
const assert = require('assert');
const http = require('http');
const path = require('path');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    memories_col: null, reminders_col: null, knowledge_col: null, usage_col: null,
    providers_col: null, agents_col: null, logs_col: null, settings_col: null,
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
    MAX_ATTACHMENT_BYTES: 1_000_000,
    TEXT_EXTENSIONS: new Set(['.txt', '.md', '.json']),
    TEXT_CONTENT_TYPES: new Set(['text/', 'application/json']),
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const gemini = require('../providers/gemini');
const { __internals } = gemini;

let tokenFetches = 0;
let streamRequests = 0;
let lastFReqContext = null;
let PORT = 0;

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/u/1/app')) {
        tokenFetches++;
        res.setHeader('Set-Cookie', 'SIDCC=NEW-SIDCC-VALUE; Path=/; Secure');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><head></head><body><script>window.WIZ_global_data = {"SNlM0e":"TEST-AT-TOKEN-123","FdrFJe":"12345-67890"};</script>صفحة</body></html>');
        return;
    }
    if (req.method === 'POST' && req.url.includes('StreamGenerate')) {
        streamRequests++;
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            try {
                const params = new URLSearchParams(body);
                const outer = JSON.parse(params.get('f.req'));
                const d1 = JSON.parse(outer[1]);
                lastFReqContext = d1[2]; // سياق المحادثة — يتتبع threading
            } catch (_) { lastFReqContext = null; }

            // خطان متتاليان: الرد يتوسع تزايدياً (كما يفعل gemini فعلاً)
            const c2a = [null, ['conv-777', 'resp-777'], null, { '26': 'AT-NEW-TOKEN' }, [['choice-A', ['مرحبا ']]]];
            const c2b = [null, ['conv-777', 'resp-777'], null, { '26': 'AT-NEW-TOKEN' }, [['choice-A', ['مرحبا من Gemini!']]]];
            const line1 = JSON.stringify([[null, null, JSON.stringify(c2a)]]);
            const line2 = JSON.stringify([[null, null, JSON.stringify(c2b)]]);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.write(line1 + '\n');
            setTimeout(() => { res.end(line2 + '\n'); }, 10);
        });
        return;
    }
    res.writeHead(404); res.end('nope');
});

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

async function run() {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
    const BASE = `http://127.0.0.1:${PORT}`;
    const cfg = {
        gemini_cookies: 'SID=g.abc; __Secure-1PSID=xyz.123; HSID=h1; SSID=s1',
        gemini_base_url: BASE,
    };

    // ── 1) validate: مفقود / شكل غير صحيح / سليم ──
    {
        assert.strictEqual(gemini.validate({}).ok, false);
        assert.strictEqual(gemini.validate({ gemini_cookies: 'foo=bar; baz=qux' }).ok, false, 'كوكيز بلا SID تُرفض');
        assert.strictEqual(gemini.validate({ gemini_cookies: 'SID=a; __Secure-1PSID=b' }).ok, true);
        ok('1) validate: مفقود/شكل غير صحيح/سليم');
    }

    // ── 2) تحليل ودمج الكوكيز ──
    {
        const parsed = __internals.parseCookieString('A=1; B=x=y; C');
        assert.strictEqual(parsed.A, '1');
        assert.strictEqual(parsed.B, 'x=y');
        assert.strictEqual(parsed.C, undefined);
        assert.strictEqual(__internals.cookiesToString({ A: '1', B: '2' }), 'A=1; B=2');

        const store = { SIDCC: 'OLD' };
        const updated = __internals.mergeSetCookies(store, ['SIDCC=NEW; Path=/; Secure', 'UNKNOWN=x; Path=/']);
        assert.deepStrictEqual(updated, ['SIDCC']);
        assert.strictEqual(store.SIDCC, 'NEW');
        assert.strictEqual(__internals.mergeSetCookies(store, ['SIDCC=NEW; Path=/']).length, 0, 'لا تحديث إن لم يتغير');
        ok('2) parseCookieString/cookiesToString/mergeSetCookies');
    }

    // ── 3) استخراج توكنات الصفحة ──
    {
        const { snlm0e, fdrfje } = __internals.extractTokens('x"SNlM0e":"TOK123"y"FdrFJe":"99-88"z');
        assert.strictEqual(snlm0e, 'TOK123');
        assert.strictEqual(fdrfje, '99-88');
        ok('3) extractTokens: SNlM0e + FdrFJe');
    }

    // ── 4) محادثة كاملة: جلب توكنات → stream → نص تزايدي + threading ──
    {
        const r1 = await gemini.chat({ prompt: 'مرحبا', sessionId: null, config: cfg, agentId: 'ag1' });
        assert.ok(r1.fullText.includes('مرحبا من Gemini!'), `النص التزايدي يجب أن يتكامل — وجدنا: ${r1.fullText}`);
        assert.ok(r1.sessionId.startsWith('gem:'), 'الجلسة الداخلية ببادئة gem:');
        assert.strictEqual(tokenFetches, 1, 'جلب توكنات واحد للمحادثة الأولى');
        assert.strictEqual(lastFReqContext[0], '', 'أول رسالة: سياق فارغ');

        // ثانية بنفس الجلسة: بلا جلب توكنات جديد + سياق المحادثة يُمرر
        const r2 = await gemini.chat({ prompt: 'كيف حالك', sessionId: r1.sessionId, config: cfg, agentId: 'ag1' });
        assert.ok(r2.fullText.includes('مرحبا من Gemini!'));
        assert.strictEqual(tokenFetches, 1, 'الجلسة تُعاد استخدامها — بلا جلب ثانٍ');
        assert.strictEqual(lastFReqContext[0], 'conv-777', 'conversation_id يُمرر في السياق (threading)');
        assert.strictEqual(lastFReqContext[9], 'AT-NEW-TOKEN', 'at_token يُحدّث من الرد السابق');
        ok('4) chat كامل: استخراج توكنات + تزايد + threading + إعادة استخدام الجلسة');
    }

    // ── 5) testConnection: نجاح حقيقي ضد الخادم الوهمي ──
    {
        tokenFetches = 0;
        const msg = await gemini.testConnection({ ...cfg });
        assert.ok(msg.includes('✅'), 'رسالة نجاح');
        assert.strictEqual(tokenFetches, 1);
        ok('5) testConnection: جلب توكنات فعلي ورسالة نجاح');
    }

    // ── 6) فشل الكوكيز الميتة: خطأ واضح (بلا SNlM0e) ──
    {
        const deadServer = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<html><body>صفحة دخول — لا توكنات</body></html>');
        });
        await new Promise((r) => deadServer.listen(0, '127.0.0.1', r));
        const dPort = deadServer.address().port;
        await assert.rejects(
            () => gemini.chat({ prompt: 'x', sessionId: null, config: { gemini_cookies: 'SID=a; __Secure-1PSID=b', gemini_base_url: `http://127.0.0.1:${dPort}` } }),
            (e) => e.geminiCookiesDead === true && e.message.includes('SNlM0e'),
            'كوكيز ميتة → خطأ يطلب كوكيز جديدة',
        );
        deadServer.close();
        ok('6) كوكيز ميتة → خطأ واضح يطلب كوكيز جديدة');
    }

    // ── 7) المزود مسجل في السجل بأحقول النوافذ الصحيحة ──
    {
        const providers = require('../providers');
        assert.strictEqual(providers.getProvider('gemini').id, 'gemini');
        assert.ok(providers.listProviders().some(p => p.id === 'gemini'), 'gemini يظهر في كل القوائم تلقائياً');
        const fields = providers.getProvider('gemini').modalFields;
        assert.ok(fields.some(f => f.id === 'gemini_cookies'), 'حقل الكوكيز موجود');
        assert.ok(providers.getProvider('gemini').validate({ gemini_cookies: 'SID=x; __Secure-1PSID=y' }).ok);
        ok('7) gemini مسجل في سجل المزودين بحقوله');
    }

    server.close();
    console.log(`\n════════════════════════════════`);
    console.log(`gemini: ${passed}/${passed} ناجحة`);
}

run().catch((e) => { console.error('💥', e); try { server.close(); } catch (_) {} process.exit(1); });
