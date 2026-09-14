/**
 * tests/channel_queue.test.js — اختبارات قائمة انتظار الرسائل (v7.9.0)
 * ─────────────────────────────────────────────────────────────
 * يغطي: الترتيب الصارم (الأول ثم الثاني)، wasBusy للتعليم بـ 👀،
 * عدم كسر القائمة عند فشل مهمة، التوازي بين القنوات المختلفة،
 * والتنظيف الذاتي بعد انتهاء كل المهام.
 */

'use strict';
const assert = require('assert');
const { enqueueChannelTask, isChannelBusy, channelDepth, _resetQueue } = require('../channelQueue');

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

    console.log(`\n🎯 channel_queue: ${passed}/6 اختبارات ناجحة`);
}

run().catch((e) => { console.error('❌ FATAL:', e); process.exit(1); });
