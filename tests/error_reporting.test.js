/**
 * tests/error_reporting.test.js — اختبارات سياسة وجه البوكر (v7.8.0)
 * ─────────────────────────────────────────────────────────────
 * يغطي: نظافة الوجوه العامة (صفر تسريب تقني)، العشوائية، المحاولة
 * الصامتة الواحدة للمزود المفرد، إخفاء التفاصيل عن القناة العامة مع
 * وصول التقرير المفصل لقناة الإشعارات، تهدئة تكرار نفس الخطأ،
 * ورسالة حد الخطوات في وضع المحادثة بلا أي ذكر للأدوات.
 */

'use strict';
const assert = require('assert');
const path = require('path');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    memories_col: null, reminders_col: null, knowledge_col: null,
    agents_col: { findOne: async () => null },
    logs_col: { insertOne: async () => {} },
    settings_col: { findOne: async () => null },
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const providers = require('../providers');
const errorReporter = require('../errorReporter');
const { runAgent } = require('../tools');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

// كلمات ممنوعة منعناً باتاً في أي رد عام — أي ظهور منها = تسريب
const FORBIDDEN_IN_PUBLIC = ['⚠️', '❌', 'خطأ', 'نموذج', 'مزود', 'توكن', 'أدوات', 'نظام', 'API', 'DeepSeek', 'Qwen', 'OpenAI', 'Gemini', 'undefined', 'null', 'Token'];

async function run() {
    // ── 1) نظافة الوجوه العامة — صفر كلمات تقنية ──
    {
        assert.ok(errorReporter.PUBLIC_FACES.length >= 5, 'مجموعة وجوه كافية للتنويع');
        for (const face of errorReporter.PUBLIC_FACES) {
            assert.ok(typeof face === 'string' && face.trim().length > 10, `وجه غير صالح: ${face}`);
            for (const word of FORBIDDEN_IN_PUBLIC) {
                assert.ok(!face.includes(word), `الوجه يحتوي كلمة ممنوعة «${word}»: ${face}`);
            }
        }
        ok('1) الوجوه العامة نظيفة تماماً — بلا أي كلمة تقنية');
    }

    // ── 2) العشوائية والاتساق — كل السحوبات ضمن المجموعة ──
    {
        for (let i = 0; i < 60; i++) {
            const face = errorReporter.randomPublicFace();
            assert.ok(errorReporter.isPublicFace(face), `سحبة خارج المجموعة: ${face}`);
        }
        const seen = new Set();
        for (let i = 0; i < 200; i++) seen.add(errorReporter.randomPublicFace());
        assert.ok(seen.size >= 2, 'يجب أن يوجد تنويع فعلي وليس وجهاً واحداً');
        ok(`2) العشوائية سليمة — ${seen.size} وجه مختلف ظهر في 200 سحبة`);
    }

    // ── 3) مزود مفرد يفشل → محاولة صامتة واحدة ثم وجه بلا تفاصيل + تقرير كامل ──
    {
        errorReporter._resetForTests();
        const reports = [];
        errorReporter.setManagerNotifier(async (r) => { reports.push(r); });

        let calls = 0;
        providers.PROVIDERS.fake_alone = {
            id: 'fake_alone', label: 'المزود المنفرد', emoji: '🟠', description: 'w',
            modalFields: [], validate: () => ({ ok: true, missing: [] }), describe: () => 'w',
            async testConnection() { return 'ok'; },
            async chat() { calls++; throw new Error('انقطاع وهمي عابر'); },
        };

        const result = await runAgent(
            { id: 'g9', name: 'سيرفر الاختبار' }, { id: 'c9', name: 'عام' }, 'مرحبا', '', '', 'وكيل التجربة',
            null, null, 'g9', 'default', false, 'member', null,
            { agentId: 'ER1', agentName: 'وكيل التجربة', provider: 'fake_alone', providerConfig: {} },
            { userId: 'U9', username: 'مستخدم', channelId: 'c9' },
        );

        assert.strictEqual(calls, 2, `محاولة صامتة واحدة قبل الاستسلام (استدعاءان): ${calls}`);
        assert.ok(errorReporter.isPublicFace(result.reply), `الرد العام وجه بشري: ${result.reply}`);
        for (const word of FORBIDDEN_IN_PUBLIC) {
            assert.ok(!result.reply.includes(word), `تسريب «${word}» في الرد العام!`);
        }

        await new Promise(r => setTimeout(r, 60));
        assert.strictEqual(reports.length, 1, `تقرير واحد للإشعارات: ${reports.length}`);
        const msg = String(reports[0].message);
        assert.strictEqual(reports[0].type, 'agent_error');
        assert.ok(msg.includes('انقطاع وهمي عابر'), 'التشخيص الحقيقي في التقرير');
        assert.ok(msg.includes('المزود المنفرد'), 'اسم المزود في التقرير');
        assert.ok(msg.includes('ER1') && msg.includes('وكيل التجربة'), 'الوكيل محدد بالاسم والمعرف');
        assert.ok(msg.includes('سيرفر الاختبار') && msg.includes('c9'), 'موقع الحدث في التقرير');
        assert.ok(msg.includes('U9') && msg.includes('مستخدم'), 'المتفاعل محدد في التقرير');

        delete providers.PROVIDERS.fake_alone;
        ok('3) مزود مفرد: محاولة صامتة + وجه عام نظيف + تقرير مفصل وصل');
    }

    // ── 4) تهدئة التكرار — نفس الخطأ لا يغرق القناة ──
    {
        errorReporter._resetForTests();
        const reports = [];
        errorReporter.setManagerNotifier(async (r) => { reports.push(r); });

        const base = { agentId: 'TH1', source: 'provider', providerErrors: [], error: new Error('نفس العطل المتكرر') };
        const r1 = await errorReporter.reportAgentError({ ...base, now: 1000 });
        const r2 = await errorReporter.reportAgentError({ ...base, now: 2000 });
        const r3 = await errorReporter.reportAgentError({ ...base, now: 30000 });
        assert.strictEqual(r1.delivered, true);
        assert.strictEqual(r2.suppressed, true, 'التكرار خلال النافذة يُكبَط');
        assert.strictEqual(r3.suppressed, true, 'التكرار خلال النافذة (وسط) يُكبَط');
        assert.strictEqual(reports.length, 1, `تقرير واحد فقط: ${reports.length}`);

        // انتهاء النافذة → يُرسل مجدداً (مع عدّاد المكبوطة)
        const r4 = await errorReporter.reportAgentError({ ...base, now: 1000 + errorReporter.DEDUPE_WINDOW_MS + 1 });
        assert.strictEqual(r4.delivered, true, 'بعد انتهاء النافذة يُرسل من جديد');
        assert.ok(String(reports[1].message).includes('تكرر 2 مرة'), 'عدّاد المكبوطة مذكور في التقرير التالي');

        // خطأ مختلف → يُرسل فوراً بلا انتظار
        const r5 = await errorReporter.reportAgentError({ ...base, error: new Error('عطل مختلف تماماً'), now: 1001 });
        assert.strictEqual(r5.delivered, true, 'الخطأ المختلف لا يتأثر بالتهدئة');
        assert.strictEqual(reports.length, 3);

        errorReporter._resetForTests();
        ok('4) تهدئة التكرار: كبح داخل النافذة + عدّاد + انتهاء النافذة + الخطأ المختلف');
    }

    // ── 5) بلا مُخبِر ولا قناة → لا انهيار والوجه يعمل ──
    {
        errorReporter._resetForTests(); // بلا notifier
        let calls = 0;
        providers.PROVIDERS.fake_quiet = {
            id: 'fake_quiet', label: 'الصامت', emoji: '⚪', description: 'w',
            modalFields: [], validate: () => ({ ok: true, missing: [] }), describe: () => 'w',
            async testConnection() { return 'ok'; },
            async chat() { calls++; throw new Error('عطل بلا قناة'); },
        };
        const result = await runAgent(
            null, null, 'هاي', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'ER2', provider: 'fake_quiet', providerConfig: {} },
            { userId: 'U1' },
        );
        assert.strictEqual(calls, 2, 'المحاولة الصامتة تعمل حتى بلا قناة إشعارات');
        assert.ok(errorReporter.isPublicFace(result.reply), 'الوجه العام يعمل بلا مُخبِر');
        delete providers.PROVIDERS.fake_quiet;
        errorReporter._resetForTests();
        ok('5) بلا قناة إشعارات: لا انهيار — الوجه العام يعمل والتفاصيل في console فقط');
    }

    // ── 6) حد الخطوات في وضع المحادثة — بشرية بلا ذكر أدوات ──
    {
        errorReporter._resetForTests();
        providers.PROVIDERS.fake_looper = {
            id: 'fake_looper', label: 'الدوّار', emoji: '🔁', description: 'w',
            modalFields: [], validate: () => ({ ok: true, missing: [] }), describe: () => 'w',
            async testConnection() { return 'ok'; },
            async chat() {
                return { fullText: '```json\n{"tool":"get_channels","params":{}}\n```', sessionId: 's', newParentMessageId: 'p' };
            },
        };
        // 💬 محادثة: الرسالة بشرية — صفر ذكر لأدوات/خطوات/نظام
        const chatResult = await runAgent(
            null, null, 'ابدأ', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'ER3', kind: 'chat', provider: 'fake_looper', providerConfig: {} },
            { userId: 'U1' },
        );
        assert.ok(!chatResult.reply.includes('أدوات') && !chatResult.reply.includes('خطوات') && !chatResult.reply.includes('نظام'),
            `رسالة حد الخطوات في المحادثة لا تكشف شيئاً: ${chatResult.reply}`);
        for (const word of FORBIDDEN_IN_PUBLIC) {
            assert.ok(!chatResult.reply.includes(word), `تسريب «${word}» في رسالة الحد: ${chatResult.reply}`);
        }

        // 🤖 وكيل: الرسالة التشغيلية القديمة كما هي — مالك الوكيل يعرف ماذا يعني
        const agentResult = await runAgent(
            null, null, 'ابدأ', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'ER4', kind: 'agent', provider: 'fake_looper', providerConfig: {} },
            { userId: 'U1' },
        );
        assert.ok(agentResult.reply.includes('خطوات الأدوات'), 'وضع الوكيل يحتفظ برسالته التشغيلية');

        delete providers.PROVIDERS.fake_looper;
        errorReporter._resetForTests();
        ok('6) حد الخطوات: المحادثة بشرية بلا تسريب — الوكيل يحتفظ برسالته التشغيلية');
    }

    // ── 7) نجاح عادي لا يولد أي تقرير ──
    {
        errorReporter._resetForTests();
        const reports = [];
        errorReporter.setManagerNotifier(async (r) => { reports.push(r); });
        providers.PROVIDERS.fake_happy = {
            id: 'fake_happy', label: 'السليم', emoji: '🟢', description: 'w',
            modalFields: [], validate: () => ({ ok: true, missing: [] }), describe: () => 'w',
            async testConnection() { return 'ok'; },
            async chat() { return { fullText: 'أهلاً بك!', sessionId: 's1', newParentMessageId: 'p1' }; },
        };
        const result = await runAgent(
            null, null, 'مرحبا', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            { agentId: 'ER5', provider: 'fake_happy', providerConfig: {} },
            { userId: 'U1' },
        );
        await new Promise(r => setTimeout(r, 30));
        assert.strictEqual(result.reply, 'أهلاً بك!');
        assert.strictEqual(reports.length, 0, 'لا تقارير في المسار السليم');
        delete providers.PROVIDERS.fake_happy;
        errorReporter._resetForTests();
        ok('7) المسار السليم: صفر تقارير — التقرير للأعطال فقط');
    }

    console.log(`\n════════════════════════════════`);
    console.log(`error_reporting: ${passed}/7 ناجحة`);
}

run().catch(e => { console.error('❌ FAILED:', e.message); process.exit(1); });
