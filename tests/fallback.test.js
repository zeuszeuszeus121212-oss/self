/**
 * tests/fallback.test.js — اختبارات سلسلة Fallback بين المزودين
 * ─────────────────────────────────────────────────────────────
 * يغطي: بناء السلسلة (تفعيل/تعطيل/تخطيط غير الجاهز/التكرار/الحد الأقصى)،
 * تحويل فعلي داخل حلقة الوكيل عند فشل الأساسي، إعادة جلسة للبديل،
 * بقاء السلوك القديم عند التعطيل، وسلوك الحلقة بعد التحويل.
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
    logs_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    settings_col: { findOne: async () => null },
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const providers = require('../providers');
const { runAgent } = require('../tools');

// ── مزودات وهمية تُحقن في السجل ──
let callLog = [];
const fakePrimary = {
    id: 'fake_primary', label: 'الأساسي الوهمي', emoji: '🔴', description: 'w',
    modalFields: [],
    validate: () => ({ ok: true, missing: [] }),
    describe: () => 'w',
    async testConnection() { return 'ok'; },
    async chat() { callLog.push('primary_fail'); throw new Error('انفجار الخادم الأساسي'); },
};
const fakeBackup = {
    id: 'fake_backup', label: 'الاحتياطي الوهمي', emoji: '🟢', description: 'w',
    modalFields: [],
    validate: () => ({ ok: true, missing: [] }),
    describe: () => 'w',
    async testConnection() { return 'ok'; },
    async chat({ prompt, sessionId }) {
        callLog.push({ backup_ok: true, sessionId });
        return { fullText: `رد نهائي من الاحتياطي (جلسة: ${sessionId || 'جديدة'})`, sessionId: 'bak_sid_1', newParentMessageId: 'bak_pm_1' };
    },
};

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

async function run() {
    // حقن المزودات الوهمية في السجل
    providers.PROVIDERS[fakePrimary.id] = fakePrimary;
    providers.PROVIDERS[fakeBackup.id] = fakeBackup;

    // ── 1) buildFallbackChain: تعطيل → الأساسي فقط ──
    {
        const chain = providers.buildFallbackChain({
            provider: 'fake_primary',
            providerConfig: {},
            fallback_enabled: false,
            fallback_chain: ['fake_backup'],
        });
        assert.strictEqual(chain.length, 1);
        assert.strictEqual(chain[0].id, 'fake_primary');
        ok('1) fallback معطل → الأساسي فقط (السلوك القديم)');
    }

    // ── 2) تفعيل → الأساسي ثم البديل ──
    {
        const chain = providers.buildFallbackChain({
            provider: 'fake_primary',
            providerConfig: {},
            fallback_enabled: true,
            fallback_chain: ['fake_backup', 'fake_primary', 'غير_موجود'],
            fallback_configs: {},
        });
        assert.strictEqual(chain.length, 2, `الأساسي + البديل فقط (تخطي المكرر وغير الموجود): ${chain.map(c => c.id)}`);
        assert.strictEqual(chain[1].id, 'fake_backup');
        ok('2) السلسلة: تخطي المكرر وغير الموجود');
    }

    // ── 3) بديل غير جاهز (validate يفشل) → يُتخطى ──
    {
        providers.PROVIDERS.fake_broken = { ...fakeBackup, id: 'fake_broken', validate: () => ({ ok: false, missing: ['x'] }) };
        const chain = providers.buildFallbackChain({
            provider: 'fake_primary', providerConfig: {},
            fallback_enabled: true, fallback_chain: ['fake_broken', 'fake_backup'], fallback_configs: {},
        });
        assert.strictEqual(chain.length, 2);
        assert.strictEqual(chain[1].id, 'fake_backup');
        delete providers.PROVIDERS.fake_broken;
        ok('3) بديل ناقص الإعدادات → يتخطاه بصمت');
    }

    // ── 4) الحد الأقصى 4 مستويات ──
    {
        for (let i = 1; i <= 6; i++) providers.PROVIDERS[`fake_x${i}`] = { ...fakeBackup, id: `fake_x${i}` };
        const chain = providers.buildFallbackChain({
            provider: 'fake_primary', providerConfig: {},
            fallback_enabled: true,
            fallback_chain: ['fake_x1', 'fake_x2', 'fake_x3', 'fake_x4', 'fake_x5', 'fake_x6'],
            fallback_configs: {},
        });
        assert.strictEqual(chain.length, 4);
        for (let i = 1; i <= 6; i++) delete providers.PROVIDERS[`fake_x${i}`];
        ok('4) حد السلسلة الأقصى 4 مستويات');
    }

    // ── 5) الحلقة الكاملة: فشل الأساسي → البديل يجيب ──
    {
        callLog = [];
        const result = await runAgent(
            null, null, 'سلام عليكم', '[معلومات المستخدم]', '[سياق]', 'وكيل الاختبار',
            'sess_old', null, 'g1', 'default', false, 'member', null,
            {
                agentId: 'AG1',
                provider: 'fake_primary',
                providerConfig: {},
                fallback_enabled: true,
                fallback_chain: ['fake_backup'],
                fallback_configs: {},
            },
            { userId: 'U1', channelId: 'C1' },
        );
        assert.ok(callLog.includes('primary_fail'), 'الأساسي يجب أن يُجرَّب أولاً');
        const backupCall = callLog.find(c => typeof c === 'object' && c.backup_ok);
        assert.ok(backupCall, 'البديل يجب أن يُستدعى');
        assert.strictEqual(backupCall.sessionId, null, 'جلسة جديدة للبديل (جلسات الأساسي لا تصلحه)');
        assert.strictEqual(result.reply, 'رد نهائي من الاحتياطي (جلسة: جديدة)');
        assert.strictEqual(result.newSid, 'bak_sid_1', 'جلسة البديل تُعاد للـ runtime');
        ok('5) حلقة كاملة: فشل أساسي → بديل يجيب + جلسة نظيفة');
    }

    // ── 6) فشل الكل → وجه بشري محايد للقناة العامة + تقرير مفصل لقناة الإشعارات ──
    {
        // 🕶️ حقن مُخبِر مؤقت لالتقاط التقرير المفصل
        const errorReporter = require('../errorReporter');
        errorReporter._resetForTests();
        const reports = [];
        errorReporter.setManagerNotifier(async (r) => { reports.push(r); });

        providers.PROVIDERS.fake_backup2 = { ...fakeBackup, id: 'fake_backup2', async chat() { throw new Error('البديل الثاني مات'); } };
        const result = await runAgent(
            null, null, 'مرحبا', '', '', 'وكيل', null, null, 'g1', 'default', false, 'member', null,
            {
                agentId: 'AG1', provider: 'fake_primary', providerConfig: {},
                fallback_enabled: true, fallback_chain: ['fake_backup2'], fallback_configs: {},
            },
            { userId: 'U1' },
        );
        // القناة العامة: وجه بشري محايد — صفر تفاصيل تقنية
        assert.ok(errorReporter.isPublicFace(result.reply), `الرد العام يجب أن يكون وجهاً بشرياً: ${result.reply}`);
        assert.ok(!result.reply.includes('البديل الثاني مات'), 'لا يجوز تسريب رسالة الخطأ للقناة العامة');
        assert.ok(!result.reply.includes('مزود') && !result.reply.includes('نموذج') && !result.reply.includes('⚠️'), 'لا ذكر لمزود/نموذج/تحذير في الرد العام');
        // قناة الإشعارات: التقرير الكامل وصل
        await new Promise(r => setTimeout(r, 60));
        assert.strictEqual(reports.length, 1, `تقرير واحد للإشعارات: ${reports.length}`);
        assert.strictEqual(reports[0].type, 'agent_error');
        assert.strictEqual(reports[0].level, 'error');
        assert.ok(String(reports[0].message).includes('البديل الثاني مات'), 'التقرير المفصل يحتوي التشخيص الحقيقي');
        assert.ok(String(reports[0].message).includes('AG1'), 'التقرير يحدد الوكيل');
        assert.ok(String(reports[0].message).includes('الاحتياطي الوهمي'), 'التقرير يذكر المزود الفاشل');
        delete providers.PROVIDERS.fake_backup2;
        errorReporter._resetForTests();
        ok('6) فشل السلسلة كلها → وجه بشري للعامة + تقرير مفصل للإشعارات');
    }

    // ── 7) الأساسي يعمل → البديل لا يُلمس إطلاقاً ──
    {
        callLog = [];
        providers.PROVIDERS.fake_healthy = {
            ...fakePrimary, id: 'fake_healthy',
            async chat({ sessionId, parentMessageId }) {
                callLog.push('healthy_ok');
                // مزود حقيقي يُكمل نفس الجلسة ويعيدها
                return { fullText: 'رد الأساسي السليم', sessionId: sessionId || 'fresh_sid', newParentMessageId: parentMessageId };
            },
        };
        const result = await runAgent(
            null, null, 'مرحبا', '', '', 'وكيل', 'sid_kept', 'pm_kept', 'g1', 'default', false, 'member', null,
            {
                agentId: 'AG1', provider: 'fake_healthy', providerConfig: {},
                fallback_enabled: true, fallback_chain: ['fake_backup'], fallback_configs: {},
            },
            { userId: 'U1' },
        );
        assert.strictEqual(result.reply, 'رد الأساسي السليم');
        assert.strictEqual(result.newSid, 'sid_kept', 'الجلسة الأصلية حُفظت');
        assert.ok(!callLog.some(c => typeof c === 'object' && c.backup_ok), 'البديل لم يُستدعَ');
        delete providers.PROVIDERS.fake_healthy;
        ok('7) الأساسي سليم → صفر استدعاءات للبديل + الجلسة محفوظة');
    }

    // ── 8) تنظيف المزودات الوهمية من السجل ──
    {
        delete providers.PROVIDERS[fakePrimary.id];
        delete providers.PROVIDERS[fakeBackup.id];
        assert.ok(!providers.PROVIDERS.fake_primary && !providers.PROVIDERS.fake_backup);
        ok('8) السجل نظيف بعد الاختبار');
    }

    console.log(`\n════════════════════════════════`);
    console.log(`fallback: ${passed}/8 ناجحة`);
}

run().catch(e => { console.error('❌ FAILED:', e.message); process.exit(1); });
