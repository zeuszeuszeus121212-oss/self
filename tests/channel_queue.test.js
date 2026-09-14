/**
 * tests/channel_queue.test.js — اختبارات قائمة انتظار الرسائل (v7.9.0)
 * ─────────────────────────────────────────────────────────────
 * يغطي: الترتيب الصارم (الأول ثم الثاني)، wasBusy للتعليم بـ 👀،
 * عدم كسر القائمة عند فشل مهمة، التوازي بين القنوات المختلفة،
 * والتنظيف الذاتي بعد انتهاء كل المهام.
 */

'use strict';
const assert = require('assert');
const { enqueueChannelTask, agentChannelKey, isChannelBusy, channelDepth, _resetQueue } = require('../channelQueue');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function run() {
    _resetQueue();

    // ── 1) الترتيب الصارم — مهام القناة الواحدة تُنفذ بالترتيب ──
    {
        const order = [];
        const mk = (n, ms) => async () => { order.push(`${n}-start`); await sleep(ms); order.push(`${n}-end`); return n; };
        const a = enqueueChannelTask('g1:c1', mk(1, 30));
        const b = enqueueChannelTask('g1:c1', mk(2, 5));
        const c = enqueueChannelTask('g1:c1', mk(3, 1));
        assert.equal(a.wasBusy, false, 'المهمة الأولى قناة حرة');
        assert.equal(b.wasBusy, true, 'المهمة الثانية قناة مشغولة — 👀');
        assert.equal(c.wasBusy, true, 'المهمة الثالثة قناة مشغولة — 👀');
        await Promise.all([a.promise, b.promise, c.promise]);
        assert.deepStrictEqual(order, ['1-start', '1-end', '2-start', '2-end', '3-start', '3-end'], 'ترتيب صارم: الأول كاملاً ثم الثاني');
        ok('1) الترتيب الصارم — يرد على الأول كاملاً ثم يأتي للثاني');
    }

    // ── 2) قنوات مختلفة تعمل متوازية بلا تأثير ──
    {
        _resetQueue();
        let t0 = null, finished = 0;
        const long = enqueueChannelTask('gA:cA', async () => { await sleep(60); finished++; });
        const short = enqueueChannelTask('gB:cB', async () => { finished++; });
        await short.promise;
        assert.equal(finished, 1, 'القناة الثانية خلصت قبل انتهاء الأولى (توازٍ)');
        await long.promise;
        assert.equal(finished, 2);
        ok('2) التوازي بين القنوات — قائمة كل قناة مستقلة');
    }

    // ── 3) فشل مهمة لا يكسر القائمة أبداً ──
    {
        _resetQueue();
        const first = enqueueChannelTask('g2:c1', async () => { throw new Error('انفجرت المهمة الأولى'); });
        let ran = false;
        const second = enqueueChannelTask('g2:c1', async () => { ran = true; return 'نجحت'; });
        await assert.rejects(first.promise, /انفجرت/, 'الوعد المرفوض يصل لمستدعيه (ليُدار بـ catch)');
        assert.equal(await second.promise, 'نجحت');
        assert.ok(ran, 'المهمة الثانية اشتغلت رغم فشل الأولى');
        ok('3) فشل مهمة لا يكسر القائمة — التالي يُنفذ دائماً');
    }

    // ── 4) التنظيف الذاتي — بلا تسريب ذاكرة ──
    {
        _resetQueue();
        const r = enqueueChannelTask('g3:c1', async () => 1);
        assert.equal(channelDepth('g3:c1'), 1, 'عمق=1 أثناء التنفيذ');
        await r.promise;
        await sleep(10);
        assert.equal(channelDepth('g3:c1'), 0, 'العمق صفر بعد الانتهاء');
        assert.equal(isChannelBusy('g3:c1'), false);
        // قناة ثانية متتالية تنتهي نظيفة أيضاً
        const r2 = enqueueChannelTask('g3:c2', async () => 2);
        await r2.promise; await sleep(10);
        assert.equal(channelDepth('g3:c2'), 0);
        ok('4) التنظيف الذاتي — عدّادات القنوات تعود للصفر (بلا تسريب)');
    }

    // ── 5) wasBusy في موجة متتالية — الأول حُر ثم الموجة الجديدة مشغولة ──
    {
        _resetQueue();
        const resolveLater = [];
        const gate = new Promise(res => resolveLater.push(res));
        const first = enqueueChannelTask('g4:c1', () => gate);
        const second = enqueueChannelTask('g4:c1', async () => 'ثاني');
        assert.equal(second.wasBusy, true);
        resolveLater[0]();
        await first.promise;
        await sleep(15); // ننتظر دورة التنظيف الذاتي (release يعمل في continuation)
        const third = enqueueChannelTask('g4:c1', async () => 'ثالث');
        assert.equal(third.wasBusy, false, 'انتهت الموجة الأولى — المهمة الجديدة حرة');
        await third.promise;
        ok('5) wasBusy دقيق — يعكس حالة القناة لحظة الدخول فقط');
    }

    // ── 6) مفتاح افتراضي آمن — بلا مفتاح لا يرمي ──
    {
        _resetQueue();
        const r = enqueueChannelTask(null, async () => 'ok');
        assert.equal(await r.promise, 'ok');
        ok('6) مفاتيح ناقصة تُعامل بأمان (بلا انهيار)');
    }

    // ── 7) v7.12 — وكيلاان مختلفان في نفس القناة يعملان متوازيين ──
    // (شكوى المالك: النظام كان يطبّق الانتظار على كل الوكلاء معاً)
    {
        _resetQueue();
        const order = [];
        const keyA = agentChannelKey('agentAAA', 'g1', 'c1');
        const keyB = agentChannelKey('agentBBB', 'g1', 'c1');
        assert.notEqual(keyA, keyB, 'مفتاحان مختلفان لوكيلين مختلفين رغم نفس القناة');
        // الوكيل A يبدأ مهمة طويلة
        const a = enqueueChannelTask(keyA, async () => { await sleep(80); order.push('A'); });
        // الوكيل B في نفس السيرفر/القناة — يجب أن يعمل فوراً بلا انتظار
        const b = enqueueChannelTask(keyB, async () => { order.push('B'); });
        assert.equal(a.wasBusy, false, 'الوكيل A: قائمته حرة');
        assert.equal(b.wasBusy, false, 'الوكيل B: قائمته حرة — لا ينتظر الوكيل A أبداً');
        await b.promise;
        assert.deepStrictEqual(order, ['B'], 'B انتهى قبل A — التوازي بين الوكلاء يعمل');
        await a.promise;
        assert.deepStrictEqual(order, ['B', 'A'], 'الترتيب النهائي سليم');

        // وفي المقابل: نفس الوكيل + نفس القناة = انتظار صارم (السلوك الأصلي محفوظ)
        const c1 = enqueueChannelTask(keyA, async () => { await sleep(50); order.push('C1'); });
        const c2 = enqueueChannelTask(keyA, async () => { order.push('C2'); });
        assert.equal(c1.wasBusy, false, 'نفس الوكيل: أول مهمة حرة');
        assert.equal(c2.wasBusy, true, 'نفس الوكيل: الثانية منتظرة (👀) — واحد واحد بس');
        await c1.promise; await c2.promise;
        ok('7) وكيلاان بنفس القناة متوازيان تماماً + نفس الوكيل يبقى بالترتيب الصارم');
    }

    console.log(`\n🎯 channel_queue: ${passed}/7 اختبارات ناجحة`);
}

run().catch((e) => { console.error('❌ FATAL:', e); process.exit(1); });
