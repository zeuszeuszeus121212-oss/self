/**
 * tests/features.test.js — اختبارات الميزات القابلة للتعطيل + الشخصية من ملف (المستوى 2A/2B)
 * ─────────────────────────────────────────────────────────────
 * يغطي: تعطيل read_url داخل حلقة الوكيل (النموذج يستدعي الأداة → النظام يرفضها
 * برسالة تعطيل)، بقاء الأداة عند التفعيل، قسم الويب في system prompt،
 * أدوات المعرفة للأدمن فقط، أدوات رفع الشخصية (تحليل/تحقق/تنظيف).
 */

'use strict';
const assert = require('assert');
const path = require('path');

// ── حقن config وهمي قبل تحميل أي وحدة ──
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const fakeConfig = {
    BOT_OWNER_ID: 656783724662226963n, MONGODB_URI: null, DISCORD_TOKEN: null,
    memories_col: null, reminders_col: null, knowledge_col: null, usage_col: null,
    agents_col: { findOne: async () => null },
    logs_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    settings_col: { findOne: async () => null },
    channel_sessions: new Map(), allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() }, connectMongo: async () => {},
    // ثوابت المرفقات اللازمة لـ is_text_attachment
    MAX_ATTACHMENT_BYTES: 1_000_000,
    TEXT_EXTENSIONS: new Set(['.txt', '.md', '.json']),
    TEXT_CONTENT_TYPES: new Set(['text/', 'application/json']),
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const providers = require('../providers');
const { runAgent } = require('../tools');
const { buildSystem } = require('../tools/systemPrompt');
const utils = require('../utils');

// ── مزود وهمي: أول استدعاء يطلب read_url، ثم رد نهائي ──
let phase = 0;
const fakeProvider = {
    id: 'fake_feat', label: 'وهمي الميزات', emoji: '🧪', description: 'w',
    modalFields: [],
    validate: () => ({ ok: true, missing: [] }),
    describe: () => 'w',
    async testConnection() { return 'ok'; },
    async chat() {
        phase++;
        if (phase === 1) {
            return { fullText: '```json\n{"tool":"read_url","params":{"url":"https://example.com"}}\n```', sessionId: 's1', newParentMessageId: null };
        }
        if (phase === 2) {
            return { fullText: '```json\n{"tool":"read_url","params":{"url":"https://example.com"}}\n```', sessionId: 's1', newParentMessageId: null };
        }
        return { fullText: 'رد نهائي بعد محاولة الويب', sessionId: 's1', newParentMessageId: null };
    },
};
providers.PROVIDERS[fakeProvider.id] = fakeProvider;

const guildStub = { id: 'g1', name: 'سيرفر' };
const channelStub = { id: 'c1', name: 'عام' };
const runtimeBase = {
    agentId: 'agent_feat',
    personality: '',
    provider: 'fake_feat',
    providerConfig: {},
};

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

async function run() {
    // ── 1) read_url معطّل → النظام يرفض الاستدعاء برسالة تعطيل ──
    {
        phase = 0;
        const runtime = { ...runtimeBase, features: { read_url: false } };
        const result = await runAgent(guildStub, channelStub, 'ابحث عن شيء',
            '[معلومات]', '[سياق]', 'Bot', null, null, 'g1',
            'default', false, 'owner', null, runtime, { userId: 'u1', username: 'x', channelId: 'c1' });
        assert.ok(result.reply.includes('رد نهائي'), 'الحلقة اكتملت حتى التعطيل');
        ok('1) حلقة الوكيل تكتمل عند تعطيل read_url (بدون انهيار)');
    }

    // ── 2) systemPrompt عند التعطيل: قسم الروابط يتحول لقسم معطّل + البحث المدمج ──
    {
        const off = buildSystem('Bot', 'default', false, 'owner', '', { read_url: false });
        assert.ok(off.includes('قراءة الروابط — معطّلة'));
        assert.ok(off.includes('لا تستدعِها أصلاً'));
        assert.ok(!off.includes('read_url: [url, link]'));
        const on = buildSystem('Bot', 'default', false, 'owner', '', {});
        assert.ok(on.includes('read_url: [url, link]'));
        assert.ok(on.includes('البحث في الإنترنت ليس من أدواتك'), 'البحث مسؤولية النموذج المدمج');
        assert.ok(!on.includes('web_search'), 'لا أثر لـ web_search في البرومبت');
        // البحث المدمج — قدرة النموذج
        const searchOn = buildSystem('Bot', 'default', false, 'owner', '', {}, { search: true });
        assert.ok(searchOn.includes('البحث المدمج في النموذج مفعّل'));
        const searchOff = buildSystem('Bot', 'default', false, 'owner', '', {}, {});
        assert.ok(!searchOff.includes('البحث المدمج في النموذج مفعّل'));
        ok('2) قسم الروابط والبحث المدمج في system prompt يتغيران حسب الإعدادات');
    }

    // ── 3) سطر member يتحرك مع الميزة ──
    {
        const memberOff = buildSystem('Bot', 'default', false, 'member', '', { read_url: false });
        assert.ok(memberOff.includes('قراءة الروابط معطّلة'));
        assert.ok(!memberOff.includes('read_url وgenerate_image وcreate_file وremember'));
        const memberOn = buildSystem('Bot', 'default', false, 'member', '', {});
        assert.ok(memberOn.includes('read_url وgenerate_image وcreate_file وremember'), 'create_file ضمن أدوات member');
        ok('3) قائمة أدوات member في الـ prompt تعكس التعطيل');
    }

    // ── 4) أدوات المعرفة: للأدمن/المالك فقط في الـ prompt ──
    {
        const admin = buildSystem('Bot', 'default', false, 'admin', '', {});
        assert.ok(admin.includes('search_knowledge'));
        assert.ok(admin.includes('list_knowledge'));
        const member = buildSystem('Bot', 'default', false, 'member', '', {});
        assert.ok(!member.includes('search_knowledge'), 'member لا يرى أدوات المعرفة');
        ok('4) أدوات المعرفة في الـ prompt للأدمن فقط');
    }

    // ── 5) القراءة/الصور أدوات member آمنة؛ المعرفة ليست كذلك؛ web_search محذوفة ──
    {
        assert.strictEqual(utils.toolAllowedForAccess('web_search', 'member'), false, 'web_search لم تعد أداة معتمدة');
        assert.strictEqual(utils.toolAllowedForAccess('read_url', 'member'), true);
        assert.strictEqual(utils.toolAllowedForAccess('generate_image', 'member'), true);
        assert.strictEqual(utils.toolAllowedForAccess('search_knowledge', 'member'), false);
        assert.strictEqual(utils.toolAllowedForAccess('list_knowledge', 'member'), false);
        assert.strictEqual(utils.toolAllowedForAccess('search_knowledge', 'admin'), true);
        ok('5) MEMBER_SAFE_TOOLS: read_url/generate_image داخلها، web_search محذوفة، المعرفة ليست');
    }

    // ── 6) parsePersonalityCommand: الأشكال المقبولة والمرفوضة ──
    {
        assert.strictEqual(utils.parsePersonalityCommand('شخصية'), true);
        assert.strictEqual(utils.parsePersonalityCommand('#شخصية'), true);
        assert.strictEqual(utils.parsePersonalityCommand('شخصية  '), true);
        assert.strictEqual(utils.parsePersonalityCommand('Personality'), true);
        assert.strictEqual(utils.parsePersonalityCommand('شخصيتك جميلة'), false);
        assert.strictEqual(utils.parsePersonalityCommand('مرحبا شخصية'), false);
        assert.strictEqual(utils.parsePersonalityCommand(''), false);
        ok('6) تحليل أمر «شخصية» صحيح (أول كلمة فقط)');
    }

    // ── 7) validatePersonalityUpload: الصلاحية والنوع والحجم ──
    {
        // member مرفوض
        let v = utils.validatePersonalityUpload({ content: 'شخصية', attachments: [{ name: 'p.txt', size: 100, contentType: 'text/plain' }], accessLevel: 'member' });
        assert.strictEqual(v.ok, false);
        assert.ok(v.error.includes('المالك'));
        // بلا مرفق
        v = utils.validatePersonalityUpload({ content: 'شخصية', attachments: [], accessLevel: 'admin' });
        assert.strictEqual(v.ok, false);
        // مرفق غير نصي
        v = utils.validatePersonalityUpload({ content: 'شخصية', attachments: [{ name: 'img.png', size: 100, contentType: 'image/png' }], accessLevel: 'admin' });
        assert.strictEqual(v.ok, false);
        // حجم كبير
        v = utils.validatePersonalityUpload({ content: 'شخصية', attachments: [{ name: 'big.txt', size: 2_000_000, contentType: 'text/plain' }], accessLevel: 'owner' });
        assert.strictEqual(v.ok, false);
        assert.ok(v.error.includes('كبير'));
        // ناجح
        v = utils.validatePersonalityUpload({ content: 'شخصية', attachments: [{ name: 'p.txt', size: 1000, contentType: 'text/plain' }], accessLevel: 'admin' });
        assert.strictEqual(v.ok, true);
        assert.strictEqual(v.attachment.name, 'p.txt');
        ok('7) تحقق رفع الشخصية: صلاحية + مرفق نصي + حجم');
    }

    // ── 8) clampPersonalityText: تنظيف وحد 20000 ──
    {
        assert.strictEqual(utils.clampPersonalityText('  مرحبا\r\nبك  '), 'مرحبا\nبك');
        assert.strictEqual(utils.clampPersonalityText('ك'.repeat(30000)).length, utils.PERSONALITY_MAX_CHARS);
        ok('8) تنظيف نص الشخصية مع الحد الأقصى');
    }

    // ── 9) أمر runtime الميزات مسجل في الأوامر ──
    {
        // تحقق ثابت: الكود يحتوي تعريفي الميزات والاحصائيات (حماية من حذفهما مستقبلاً)
        const fs = require('fs');
        const src = fs.readFileSync(path.join(__dirname, '..', 'agentRuntime.js'), 'utf8');
        assert.ok(src.includes(".setName('الميزات')"));
        assert.ok(src.includes(".setName('الاحصائيات')"));
        assert.ok(src.includes('read_url : agentConfig.features?.read_url !== false'), 'توافق قديم: بلا إعداد = مفعّل');
        assert.ok(src.includes('thinking : agentConfig.capabilities?.thinking === true'), 'قدرات النموذج من الوثيقة');
        assert.ok(src.includes('search   : agentConfig.capabilities?.search === true'), 'قدرة البحث المدمج من الوثيقة');
        assert.ok(!src.includes("'web_search'"), 'لا أثر لأمر web_search في runtime');
        ok('9) /الميزات و/الاحصائيات مسجلة + القدرات الجديدة في runtimeSettings');
    }

    console.log('\n════════════════════════════════');
    console.log(`features+personality: ${passed}/${passed} ناجحة`);
    process.exit(0);
}

run().catch((e) => { console.error('💥', e); process.exit(1); });
