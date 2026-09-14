/**
 * tests/permissions.test.js — اختبارات «بلا أدمن» (v7.13.0)
 * ═══════════════════════════════════════════════════════════════════════
 * شكوى المالك: «لو عملت وكيل بحساب وكان رتبته ليست أدمن ستريتر،
 * لا أستطيع التكلم معه — يضع إيموجي فقط ولا يرد. لا يُشترط أن تكون
 * رتبته أدمن ستريتر لكي يعمل!»
 *
 * يغطي:
 *   1) فحص القدرة على الرد — كامل الصلاحيات = يعمل بلا أدمن.
 *   2) نقص «إرسال الرسائل»/«عرض القناة» = حجب قبل استهلاك الـ AI.
 *   3) نقص صلاحيات التحسين فقط (السجل/التفاعلات) = لا حجب.
 *   4) غياب المعلومات = fail-open (لا حجب أبداً بلا يقين).
 *   5) كشف خطأ 50013 Missing Permissions بأي شكل.
 *   6) ساعة التوقف: مهمة عالقة لا تحتجز القائمة — التالية تمر فوراً
 *      (إعادة إنتاج شكوى «كل الرسائل 👀 إلى الأبد» وإصلاحها فعلياً).
 *   7) بطاقة /شرح بالتشخيص: تُظهر الصلاحيات + «الأدمن غير مطلوبة»
 *      + بدون تشخيص تبقى كما كانت (توافق اختبار العزل).
 *   8) تقرير «صلاحيات» و«مهلة» يصل لقناة الإشعارات بتشخيص عربي واضح.
 *   9) عقد المصدر: البوابة والساعة والتشخيص مثبتة فعلاً في agentRuntime.
 * ═══════════════════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n,
    MONGODB_URI: null, DISCORD_TOKEN: null, USER_TOKEN: null, DEEPSEEK_TOKEN: null,
    CONTROL_ROLE_NAME: '', RAILWAY_URL: '', POW_PROXY_TELEGRAM: '', DEFAULT_POW_PROVIDER: 'railway',
    MAX_CHANNELS_PER_GUILD: 5, MAX_ATTACHMENT_BYTES: 1000000,
    TEXT_EXTENSIONS: new Set(['.txt', '.md', '.json']), TEXT_CONTENT_TYPES: new Set(['text/', 'application/json']),
    mongoClient: null, connectMongo: async () => {},
    memories_col: null, reminders_col: null, knowledge_col: null, providers_col: null,
    agents_col: { findOne: async () => null },
    logs_col: { insertOne: async () => {} },
    settings_col: { findOne: async () => null },
    usage_col: { find() { return { sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }; }, async updateOne() { return { modifiedCount: 1 }; } },
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() },
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const {
    REPLY_REQUIRED_PERMS,
    REPLY_WARN_PERMS,
    PERM_LABELS_AR,
    checkReplyAbility,
    isMissingPermissionsError,
    withTaskTimeout,
    buildPermissionDiagLines,
} = require('../permissions');
const { enqueueChannelTask, agentChannelKey, _resetQueue } = require('../channelQueue');
const errorReporter = require('../errorReporter');
const { buildIntroPayload, agentBotCommands } = require('../agentRuntime');
const fs = require('fs');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

/** PermissionsBitField وهمي — نفس عقد .has */
function fakePerms(hasList) {
    return { has: (p) => hasList.includes(p) };
}
const FULL = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions'];

async function run() {
    // ── 1) كامل الصلاحيات بلا أدمن = يعمل ──
    {
        const a = checkReplyAbility({ perms: fakePerms(FULL), hasBotMember: true });
        assert.strictEqual(a.ok, true, 'الحد الأدنى يكفي بلا أدمن');
        assert.strictEqual(a.isAdmin, false, 'لا يوجد أدمن هنا');
        assert.deepStrictEqual(a.missing, [], 'لا نواقص');
        ok('1) الوكيل يرد بلا رتبة أدمن — الحد الأدنى (عرض+إرسال) يكفي تماماً');
    }

    // ── 2) نقص إرسال الرسائل = حجب مبكر قبل أي استهلاك AI ──
    {
        const a = checkReplyAbility({ perms: fakePerms(['ViewChannel']), hasBotMember: true });
        assert.strictEqual(a.ok, false);
        assert.deepStrictEqual(a.missing, ['SendMessages']);
        const names = a.missing.map((p) => PERM_LABELS_AR[p]).join('، ');
        assert.ok(names.includes('إرسال الرسائل'), 'التقرير يسمّي الناقص بالعربية');
        ok('2) «إرسال الرسائل» مفقودة → حجب مبكر مع تسمية الناقص بالعربية');
    }

    // ── 3) نقص عرض القناة = حجب ──
    {
        const a = checkReplyAbility({ perms: fakePerms(['SendMessages']), hasBotMember: true });
        assert.strictEqual(a.ok, false);
        assert.ok(a.missing.includes('ViewChannel'));
        ok('3) «عرض القناة» مفقودة → حجب مبكر أيضاً');
    }

    // ── 4) نقص تحسينات فقط = لا حجب (تحذيرات لا أكثر) ──
    {
        const a = checkReplyAbility({ perms: fakePerms(['ViewChannel', 'SendMessages']), hasBotMember: true });
        assert.strictEqual(a.ok, true, 'الرد ممكن حتى بلا سجل/تفاعلات');
        assert.deepStrictEqual(a.warnings, [...REPLY_WARN_PERMS]);
        ok('4) بلا قراءة سجل/تفاعلات → الرد مستمر (تحذير فقط، لا حجب)');
    }

    // ── 5) غياب المعلومات = fail-open ──
    {
        for (const p of [{ perms: null, hasBotMember: true }, { perms: fakePerms([]), hasBotMember: false }, { perms: {} , hasBotMember: true }]) {
            const a = checkReplyAbility(p);
            assert.strictEqual(a.ok, true, 'لا حجب بلا يقين');
            assert.strictEqual(a.unknown, true);
        }
        ok('5) غياب عضوية/صلاحيات → fail-open (لا صمت خاطئ أبداً)');
    }

    // ── 6) كشف 50013 بأي شكل ──
    {
        assert.strictEqual(isMissingPermissionsError({ code: 50013 }), true);
        assert.strictEqual(isMissingPermissionsError(Object.assign(new Error('x'), { name: 'DiscordAPIError[50013]' })), true);
        assert.strictEqual(isMissingPermissionsError(new Error('Missing Permissions')), true);
        assert.strictEqual(isMissingPermissionsError(new Error('انقطاع شبكة')), false);
        assert.strictEqual(isMissingPermissionsError(null), false);
        assert.strictEqual(isMissingPermissionsError({ code: 10003 }), false);
        ok('6) خطأ الصلاحيات 50013 يُكشف بأي شكل (code/اسم/نص) — غيره يُترك لسلامته');
    }

    // ── 7) ساعة التوقف: مهمة عالقة لا تحتجز القائمة (إعادة إنتاج الشكوى) ──
    {
        _resetQueue();
        const key = agentChannelKey('agentA', 'g1', 'c1');
        const order = [];

        // الرسالة الأولى: مهمة عالقة للأبد — لكن بساعة التوقف
        enqueueChannelTask(key, async () => {
            order.push('A-start');
            const outcome = await withTaskTimeout(() => new Promise(() => {}), 50); // تعلق أبدياً
            if (outcome.timedOut) order.push('A-timeout');
        });
        await new Promise((r) => setTimeout(r, 10));

        // الرسالة الثانية: يجب أن تعمل فور تحرر الساعة — لا 👀 إلى الأبد
        enqueueChannelTask(key, async () => { order.push('B-runs'); });

        await new Promise((r) => setTimeout(r, 120));
        assert.ok(order.includes('A-timeout'), 'المهمة العالقة حررت بالساعة');
        assert.ok(order.includes('B-runs'), 'الرسالة التالية عملت — لا انسداد أبدي');
        assert.ok(order.indexOf('A-timeout') < order.indexOf('B-runs'), 'الترتيب محفوظ');
        _resetQueue();
        ok('7) مهمة عالقة أبدياً ← الساعة حررت القائمة والرسالة التالية مرت (نهاية عصر 👀 الأبدي)');
    }

    // ── 8) الساعة تمرر القيمة وترمي فشل العمل قبل المهلة ──
    {
        const good = await withTaskTimeout(async () => 42, 1000);
        assert.strictEqual(good.timedOut, false);
        assert.strictEqual(good.result, 42);

        await assert.rejects(
            () => withTaskTimeout(async () => { throw new Error('فشل سريع'); }, 1000),
            /فشل سريع/,
        );

        // فشل متأخر بعد المهلة — لا unhandled rejection يطيح العملية
        let unhandled = 0;
        const onUh = () => { unhandled++; };
        process.on('unhandledRejection', onUh);
        await withTaskTimeout(() => new Promise((_, rej) => setTimeout(() => rej(new Error('متأخر')), 80)), 30);
        await new Promise((r) => setTimeout(r, 150));
        process.removeListener('unhandledRejection', onUh);
        assert.strictEqual(unhandled, 0, 'الفشل المتأخر بعد المهلة مبتلع');
        ok('8) الساعة تمرر النتائج وترمي الفشل السريع — والمتأخر بعد المهلة لا يطيح العملية');
    }

    // ── 9) بطاقة /شرح بالتشخيص: الحد الأدنى يكفي والأدمن غير مطلوبة ──
    {
        const diag = buildPermissionDiagLines(fakePerms(['ViewChannel']));
        const text = diag.join('\n');
        assert.ok(text.includes('إرسال الرسائل'), 'يسمي الناقص');
        assert.ok(text.includes('سبب صمتي'), 'يشرح سبب الصمت بلغة صاحب الموقف');
        assert.ok(text.includes('غير مطلوبة'), 'يجدد القاعدة: الأدمن غير مطلوبة');
        assert.ok(text.includes('الإصلاح'), 'يعطي خطوة الإصلاح');

        const allGood = buildPermissionDiagLines(fakePerms(FULL)).join('\n');
        assert.ok(!allGood.includes('❌'), 'كل شيء متاح');
        assert.ok(allGood.includes('غير مطلوبة'), 'القاعدة موجودة حتى لو كل شيء سليم');

        const unknown = buildPermissionDiagLines(null).join('\n');
        assert.ok(unknown.includes('تعذّر') || unknown.includes('تعذر'), 'حالة المجهول موجودة');

        // البطاقة نفسها: مع التشخيص تحتويه، وبدونه تبقى كما كانت (توافق العزل)
        const withDiag = buildIntroPayload('Sukuna', diag);
        assert.ok(JSON.stringify(withDiag).includes('فحص قدرتي'), 'البطاقة تعرض التشخيص');
        assert.ok(!JSON.stringify(withDiag).includes('embeds'), 'V2 صرفة');
        const withoutDiag = JSON.stringify(buildIntroPayload('Sukuna'));
        assert.ok(!withoutDiag.includes('فحص قدرتي'), 'بدون تشخيص = البطاقة الأصلية حرفياً');
        ok('9) /شرح تعرض فحص صلاحيات حي + خطوة الإصلاح + «الأدمن غير مطلوبة» — وتبقى نظيفة بدونه');
    }

    // ── 10) التقارير: مصدرا permissions/timeout يصلان للمالك بتشخيص عربي ──
    {
        errorReporter._resetForTests();
        const reports = [];
        errorReporter.setManagerNotifier(async (r) => { reports.push(r); });

        await errorReporter.reportAgentError({
            agentId: 'P1', agentName: 'وكيل الصلاحيات', client: null, source: 'permissions',
            guild: { id: 'g1', name: 'سيرفر' }, channel: { id: 'c1', name: 'عام' },
            user: { id: 'u1', username: 'zeus' }, error: new Error('البوت صامت في #عام — صلاحيات ناقصة: «إرسال الرسائل»'),
            context: 'الأدمن غير مطلوب',
        });
        await errorReporter.reportAgentError({
            agentId: 'P1', agentName: 'وكيل الصلاحيات', client: null, source: 'timeout',
            guild: { id: 'g1', name: 'سيرفر' }, channel: { id: 'c1', name: 'عام' },
            error: new Error('تجاوز الحد الزمني (180 ثانية)'),
        });

        assert.strictEqual(reports.length, 2, 'التقريران وصلا');
        const permReport = reports[0].message;
        assert.ok(permReport.includes('لا يملك صلاحية الرد'), 'تشخيص الصلاحيات واضح');
        assert.ok(permReport.includes('الأدمن غير مطلوب'), 'القاعدة مذكورة في التقرير');
        assert.ok(permReport.includes('#عام') && permReport.includes('سيرفر'), 'الموقع محدد');
        const timeoutReport = reports[1].message;
        assert.ok(timeoutReport.includes('الحد الزمني'), 'تشخيص المهلة واضح');
        assert.ok(timeoutReport.includes('حُررت قائمة الانتظار'), 'يطمئن: القائمة تحررت');
        errorReporter._resetForTests();
        ok('10) المالك يرى تقريراً عربياً واضحاً للصمت والعلق — بلا إيموجي غامض');
    }

    // ── 11) عقد المصدر: البوابة/الساعة/الكشف/التشخيص مثبتة في agentRuntime ──
    {
        const src = fs.readFileSync(path.join(__dirname, '..', 'agentRuntime.js'), 'utf8');
        assert.ok(src.includes("require('./permissions')"), 'permissions مستورد');
        // البوابة قبل استخراج النص وقبل القائمة — بلا استهلاك AI
        const gatePos = src.indexOf("if (tokenType === 'bot') {");
        const gateGuard = src.indexOf('checkReplyAbility({ perms: chPerms');
        const contentPos = src.indexOf('let content = message.content;');
        const queuePos = src.indexOf('enqueueChannelTask(chQueueKey');
        assert.ok(gateGuard > 0 && contentPos > gateGuard, 'الفحص قبل أي معالجة نص');
        assert.ok(queuePos > gateGuard, 'الفحص قبل القائمة');
        assert.ok(src.includes('withTaskTimeout('), 'ساعة التوقف حول الرد');
        assert.ok(src.includes('DEFAULT_TASK_TIMEOUT_MS'), 'المهلة من الثابت الموحد');
        assert.ok(src.includes("isMissingPermissionsError(error)"), 'كشف 50013 في المصيد');
        assert.ok(src.includes("react(permFail ? '🔐' : '❌')"), 'إيموجي صلاحيات مميز');
        assert.ok(src.includes("react('🔇')"), 'إشارة الصمت المبكرة');
        assert.ok(src.includes("react('⏰')"), 'إشارة المهلة');
        assert.ok(src.includes('buildPermissionDiagLines(chPerms)'), '/شرح تعرض تشخيصاً حياً');
        // الأمر الوحيد ما زال /شرح
        const cmds = agentBotCommands();
        assert.strictEqual(cmds.length, 1);
        assert.strictEqual(cmds[0].toJSON().name, 'شرح');
        assert.ok(REPLY_REQUIRED_PERMS.length === 2, 'الحد الأدنى منطلقين فقط');
        ok('11) عقد المصدر مثبت: فحص مبكر ← ساعة توقف ← كشف 50013 ← /شرح تشخيصي');
    }

    console.log(`\n🎉 permissions.test: ${passed}/${passed} ناجح`);
}

run().catch((e) => { console.error('❌', e); process.exit(1); });
