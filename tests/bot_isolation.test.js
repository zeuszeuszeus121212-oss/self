/**
 * tests/bot_isolation.test.js — اختبارات العزل الأمني لبوّتات الوكلاء
 * ═══════════════════════════════════════════════════════════════════════
 * الثغرة التي كان يبلّغ عنها المالك:
 *   «أي بوت أصنعه يستورد أوامر بوت المانجر — من يأخذ البوت الجديد
 *    يستطيع التحكم في المانجر: صنع وكلاء، تعطيل، كل شيء!»
 *
 * يغطي:
 *   1) بوت الوكيل يسجل أمراً واحداً فقط: /شرح — لا لوحة ولا أوامر وكيل.
 *   2) بطاقة /شرح: Components V2 صرفة (بلا content/embeds) بنص ≤ 4000
 *      وتذكر «زيوس» واسم البوت.
 *   3) حارس لوحة المدير (makeManagementProxy): تفاعل من عميل غير بوت
 *      المدير يُرفض محايداً ولا يصل لمعالج اللوحة أبداً؛ تفاعل بوت
 *      المدير نفسه يُمرر كالمعتاد.
 *   4) اتساق القائمتين: كل أداة في CHAT_MODE_TOOLS ليست من أدوات
 *      الإدارة، وبطاقة /شرح لا تكشف أي أسماء أدوات أو نظام داخلي.
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
    agents_col: {
        findOne: async () => null,
        updateOne: async () => ({ modifiedCount: 1 }),
        insertOne: async (doc) => ({ insertedId: doc._id || 'new' }),
        find: () => ({ limit: () => ({ toArray: async () => [] }) }),
        countDocuments: async () => 0,
    },
    logs_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }), insertOne: async () => {} },
    settings_col: { findOne: async () => null },
    usage_col: { find() { return { sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }; }, async updateOne() { return { modifiedCount: 1 }; } },
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() },
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const { MessageFlags } = require('discord.js');
const { agentBotCommands, buildIntroPayload } = require('../agentRuntime');
const { makeManagementProxy } = require('../bot');
const { CHAT_MODE_TOOLS } = require('../tools/agent');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

/** جمع كل النص داخل payload V2 (حاويات → TextDisplay) */
function payloadText(payload) {
    let out = '';
    (function walk(comp) {
        if (!comp || typeof comp !== 'object') return;
        const c = (typeof comp.content === 'string') ? comp.content
            : (comp.data && typeof comp.data.content === 'string') ? comp.data.content : null;
        if (c) out += c + '\n';
        for (const child of comp.components || []) walk(child);
    })(payload);
    return out;
}

async function run() {
    // ══════════════════════════════════════════════════════════
    // 1) بوت الوكيل: أمر واحد فقط /شرح — صفر أوامر إدارة أو وكيل
    // ══════════════════════════════════════════════════════════
    {
        const cmds = agentBotCommands();
        assert.strictEqual(cmds.length, 1, `بوت الوكيل يجب أن يسجل أمراً واحداً فقط — وجدنا ${cmds.length}`);
        const json = cmds[0].toJSON();
        assert.strictEqual(json.name, 'شرح', 'الأمر الوحيد هو /شرح');
        assert.ok(json.description && json.description.length > 0, 'للأمر وصف');
        ok('1) بوت الوكيل يسجل /شرح فقط — لا لوحة المدير ولا أي أمر آخر');
    }

    // ══════════════════════════════════════════════════════════
    // 2) بطاقة /شرح: V2 صرفة + نص ≤ 4000 + تذكر زيوس واسم البوت
    // ══════════════════════════════════════════════════════════
    {
        const payload = buildIntroPayload('Sukuna');
        assert.ok(payload.flags & MessageFlags.IsComponentsV2, 'الرسالة بعلم IsComponentsV2');
        assert.strictEqual(payload.content, undefined, 'لا content مختلط مع V2');
        assert.strictEqual(payload.embeds, undefined, 'لا embeds مع V2');
        assert.ok(Array.isArray(payload.components) && payload.components.length >= 1, 'مكونات V2 موجودة');
        const text = payloadText(payload);
        assert.ok(text.length <= 4000, `نص البطاقة ≤ 4000 — وجدنا ${text.length}`);
        assert.ok(text.includes('Sukuna'), 'البطاقة تحمل اسم البوت');
        assert.ok(text.includes('زيوس'), 'البطاقة تنسب التطوير لزيوس');
        assert.ok(text.includes('ذكاء اصطناعي'), 'البطاقة تصف البوت ذكاء اصطناعي للتفاعل مع الأعضاء');
        // لا تسريب لأي اسم أداة أو نظام داخلي في البطاقة
        const forbidden = ['tool', 'execute', 'recall', 'remember', 'get_messages', 'dashboard', 'لوحة', 'TOKEN'];
        const leaks = forbidden.filter(w => text.toLowerCase().includes(w.toLowerCase()));
        assert.deepStrictEqual(leaks, [], `بطاقة /شرح لا تكشف أي شيء داخلي — تسرب: ${leaks}`);
        ok('2) بطاقة /شرح: V2 احترافية نظيفة بلا أي تسريب داخلي');
    }

    // ══════════════════════════════════════════════════════════
    // 3) حارس لوحة المدير: عميل غريب → رفض محايد بلا تفويض
    // ══════════════════════════════════════════════════════════
    {
        let delegated = 0;
        const proxy = makeManagementProxy({
            managerUserId: () => '999000111222333444',
            delegate: async () => { delegated++; },
        });

        // أ) تفاعل من بوت وكيل (عميل غريب) → رفض، اللوحة لا تعمل
        let replied = null;
        const foreign = {
            client: { user: { id: '555666777888999000' } }, // بوت وكيل
            customId: 'dash:home',
            isChatInputCommand: () => false,
            replied: false, deferred: false,
            async reply(p) { replied = p; },
            async followUp() {},
        };
        const verdict1 = await proxy(foreign);
        assert.strictEqual(verdict1, false, 'التفاعل الغريب مرفوض');
        assert.strictEqual(delegated, 0, 'معالج اللوحة لم يُستدعِ إطلاقاً');
        assert.ok(replied, 'رد محايد أُرسل');
        assert.ok(replied.flags & MessageFlags.IsComponentsV2 && replied.flags & MessageFlags.Ephemeral, 'الرفض V2 خاص (Ephemeral)');
        assert.ok(payloadText(replied).includes('غير متاح هنا'), 'نص الرفض المحايد');

        // ب) تفاعل من بوت المدير نفسه → يُمرر للوحة
        let passedInteraction = null;
        const proxy2 = makeManagementProxy({
            managerUserId: () => '999000111222333444',
            delegate: async (i) => { passedInteraction = i; delegated++; },
        });
        const managerInteraction = {
            client: { user: { id: '999000111222333444' } }, // بوت المدير
            customId: 'dash:home',
            isChatInputCommand: () => false,
            replied: false, deferred: false,
            async reply() {}, async followUp() {},
        };
        const verdict2 = await proxy2(managerInteraction);
        assert.strictEqual(verdict2, true, 'تفاعل بوت المدير مقبول');
        assert.strictEqual(delegated, 1, 'التفويض تم مرة واحدة');
        assert.strictEqual(passedInteraction, managerInteraction, 'التفاعل الأصلي وصل للوحة كما هو');

        // ج) عميل بلا معرف → رفض آمن (لا انهيار)
        const verdict3 = await proxy({ client: {}, customId: 'dash:home', isChatInputCommand: () => false, replied: false, async reply() {}, async followUp() {} });
        assert.strictEqual(verdict3, false, 'غياب هوية العميل = رفض آمن');

        ok('3) حارس المدير: بوتات الوكلاء مرفوضة دائماً — اللوحة من بوت المدير حصراً');
    }

    // ══════════════════════════════════════════════════════════
    // 4) اتساق: أدوات المحادثة الأساسية قراءة/شخصية فقط — لا إدارة
    // ══════════════════════════════════════════════════════════
    {
        const managementTools = ['execute', 'read_url', 'generate_image', 'create_file',
            'search_knowledge', 'list_knowledge', 'get_audit_log', 'get_bans', 'get_webhooks',
            'moderation_overview', 'list_all_guilds', 'agent_config_audit'];
        const contaminated = CHAT_MODE_TOOLS.filter(t => managementTools.includes(t));
        assert.deepStrictEqual(contaminated, [], `قائمة المحادثة خالية من أدوات الإدارة — تلوث: ${contaminated}`);
        // الذاكرة والتذكيرات والقراءة كلها موجودة
        for (const t of ['remember', 'recall', 'forget_memory', 'set_reminder', 'list_reminders',
            'cancel_reminder', 'server_info', 'get_member_info', 'get_messages', 'search_messages',
            'get_pinned_messages', 'get_channels']) {
            assert.ok(CHAT_MODE_TOOLS.includes(t), `أداة أساسية موجودة: ${t}`);
        }
        ok('4) قائمة أدوات المحادثة: ذاكرة + تذكيرات + قراءة فقط — صفر إدارة');
    }

    console.log(`\n🎉 bot_isolation: ${passed}/${passed} اختباراً ناجحاً`);
}

run().catch((e) => {
    console.error('❌ فشل اختبارات العزل الأمني:', e);
    process.exit(1);
});
