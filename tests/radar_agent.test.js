/**
 * tests/radar_agent.test.js — الجولة السادسة عشرة (v7.12)
 * ═══════════════════════════════════════════════════════════
 * يحمي إعادة تصميم /الرصد بطلب المالك («التصميم القديم خرا — لا أفهم شيء»):
 *  1) /الرصد تبدأ بقائمة اختيار الوكيل — لا قائمة سيرفرات مختلطة أبداً.
 *  2) اختيار وكيل → سيرفراته هو فقط (عبر apps + نشاطه) — بلا خلط وكلاء.
 *  3) كل سيرفر كتلة مستقلة مفصولة بخط مرئي حقيقي (Separator divider) —
 *     والترتيب Markdown نظيف (### + أسطر مفاتيح).
 *  4) getAgentRadar: إحصائيات النشاط لهذا الوكيل فقط، والنبضة الحية
 *     لوكيل آخر لا تظهر على وكيله.
 *  5) المسارات الجديدة (radar_agent/radar_guild بسياق الوكيل) + توافق
 *     الصيغة القديمة radar_guild:<guildId>.
 *  6) كل الصفحات Components V2 سليمة (flags/بلا embeds/نص ≤ 4000/مكونات ≤ 40).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');
const { ObjectId } = require('mongodb');

// ---------- حقن config وهمي في require cache (بدون MongoDB حقيقي) ----------
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const OWNER_ID = '656783724662226963';

const AGENT_A_ID = '507f1f77bcf86cd799439011';
const AGENT_B_ID = '507f1f77bcf86cd799439022';

const AGENT_A = {
    _id: new ObjectId(AGENT_A_ID),
    name: 'وكيل الترجمة',
    provider: 'deepseek',
    discord_token: 'tok',
    token_type: 'bot',
    status: 'running',
    kind: 'chat',
    discord_bot_id: '999000111222333',
    discord_bot_name: 'translator-bot',
};
const AGENT_B = {
    _id: new ObjectId(AGENT_B_ID),
    name: 'وكيل الإدارة',
    provider: 'qwen',
    discord_token: 'tok2',
    token_type: 'bot',
    status: 'stopped',
    kind: 'agent',
    discord_bot_id: '444555666777888',
};

// سجل الرصد الوهمي
const REGISTRY_DOCS = [
    { guild_id: 'g1', name: 'سيرفر المانها', member_count: 1200, joined_at: new Date('2025-01-01'), added_by_id: 'u1', added_by_tag: 'zeus', owner_id: 'u1', left: false, apps: [{ id: '999000111222333', name: 'translator-bot' }] },
    { guild_id: 'g2', name: 'سيرفر الإدارة', member_count: 50, joined_at: new Date('2025-02-01'), added_by_id: 'u2', added_by_tag: 'owner2', owner_id: 'u2', left: false, apps: [{ id: '444555666777888', name: 'admin-bot' }] },
    { guild_id: 'g3', name: 'سيرفر مشترك', member_count: 300, joined_at: new Date('2025-03-01'), added_by_id: 'u3', added_by_tag: 'owner3', owner_id: 'u3', left: false, apps: [{ id: '999000111222333', name: 'translator-bot' }, { id: '444555666777888', name: 'admin-bot' }] },
];
// نشاط وهمي: A تكلم في g1 (مرتان) وg3 (مرة) — B تكلم في g2 فقط
const ACTIVITY_DOCS = [
    { agent_id: AGENT_A_ID, agent_name: 'وكيل الترجمة', guild_id: 'g1', channel_id: 'c1', channel_name: 'عام', user_id: 'u1', username: 'zeus', created_at: new Date('2025-06-01T10:00:00Z') },
    { agent_id: AGENT_A_ID, agent_name: 'وكيل الترجمة', guild_id: 'g1', channel_id: 'c1', channel_name: 'عام', user_id: 'u2', username: 'sami', created_at: new Date('2025-06-02T10:00:00Z') },
    { agent_id: AGENT_A_ID, agent_name: 'وكيل الترجمة', guild_id: 'g3', channel_id: 'c9', channel_name: 'دردشة', user_id: 'u3', username: 'kareem', created_at: new Date('2025-06-03T10:00:00Z') },
    { agent_id: AGENT_B_ID, agent_name: 'وكيل الإدارة', guild_id: 'g2', channel_id: 'c2', channel_name: 'أوامر', user_id: 'u2', username: 'owner2', created_at: new Date('2025-06-04T10:00:00Z') },
];

function matchRegistry(q) {
    if (q['apps.id']) return REGISTRY_DOCS.filter(d => (d.apps || []).some(a => a.id === q['apps.id']));
    if (q.guild_id && q.guild_id.$in) return REGISTRY_DOCS.filter(d => q.guild_id.$in.includes(String(d.guild_id)));
    if (q.guild_id) return REGISTRY_DOCS.filter(d => String(d.guild_id) === String(q.guild_id));
    return REGISTRY_DOCS.slice();
}

function chain(docs) {
    return {
        sort: () => chain(docs),
        skip: () => chain(docs),
        limit: () => chain(docs),
        toArray: async () => docs.slice(),
    };
}

const fakeConfig = {
    BOT_OWNER_ID: BigInt(OWNER_ID),
    MONGODB_URI: null,
    DISCORD_TOKEN: null,
    USER_TOKEN: null,
    DEEPSEEK_TOKEN: null,
    CONTROL_ROLE_NAME: '',
    RAILWAY_URL: '',
    POW_PROXY_TELEGRAM: '',
    DEFAULT_POW_PROVIDER: 'railway',
    MAX_CHANNELS_PER_GUILD: 5,
    MAX_ATTACHMENT_BYTES: 1000000,
    TEXT_EXTENSIONS: new Set(['.txt', '.md', '.json']),
    TEXT_CONTENT_TYPES: new Set(['text/', 'application/json']),
    mongoClient: null,
    connectMongo: async () => {},
    channel_sessions: new Map(),
    allowed_channels_cache: new Map(),
    sessionLock: { acquire: async (fn) => fn() },
    agents_col: {
        findOne: async (q) => {
            const id = q && q._id ? String(q._id) : null;
            if (id === AGENT_A_ID) return JSON.parse(JSON.stringify(AGENT_A));
            if (id === AGENT_B_ID) return JSON.parse(JSON.stringify(AGENT_B));
            return null;
        },
        updateOne: async () => ({ modifiedCount: 1 }),
        find: () => chain([AGENT_A, AGENT_B]),
        countDocuments: async () => 2,
    },
    guild_registry_col: {
        find: (q) => chain(matchRegistry(q || {})),
        findOne: async (q) => matchRegistry(q || {}).find(Boolean) || null,
    },
    guild_activity_col: {
        distinct: async (field, q) => {
            const rows = ACTIVITY_DOCS.filter(d => !q || !q.agent_id || d.agent_id === q.agent_id);
            return [...new Set(rows.map(d => String(d[field])))];
        },
        aggregate: (pipe) => {
            const match = (pipe.find(s => s.$match) || {}).$match || {};
            const rows = ACTIVITY_DOCS.filter(d => Object.entries(match).every(([k, v]) => d[k] === v));
            const groups = new Map();
            for (const d of rows) {
                const g = groups.get(d.guild_id) || { _id: d.guild_id, total: 0, last: null };
                g.total++;
                if (!g.last || d.created_at > g.last) g.last = d.created_at;
                groups.set(d.guild_id, g);
            }
            return { toArray: async () => [...groups.values()] };
        },
        find: (q) => chain(ACTIVITY_DOCS.filter(d => String(d.guild_id) === String((q || {}).guild_id))).sort().limit(),
        countDocuments: async () => ACTIVITY_DOCS.length,
    },
    logs_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }), insertOne: async () => {} },
    settings_col: { findOne: async () => null, updateOne: async () => ({}) },
    providers_col: null,
    knowledge_col: {
        find: () => ({ limit: () => ({ toArray: async () => [] }), toArray: async () => [] }),
        countDocuments: async () => 0,
        distinct: async () => [],
        aggregate: () => ({ toArray: async () => [] }),
    },
    usage_col: { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) },
    account_settings_col: { findOne: async () => null, updateOne: async () => ({}) },
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const dashboard = require('../managerDashboard');
const guildRegistry = require('../guildRegistry');

let passed = 0;
const ok = (n) => { passed++; console.log(`✅ ${n}`); };

const fakeManager = { runtimes: new Map(), async notify() {}, async logAgent() {} };

function makeInteraction({ customId, isButton = false, isSelect = false, values = [] } = {}) {
    const captured = {};
    return {
        isChatInputCommand: () => false,
        isButton: () => isButton,
        isStringSelectMenu: () => isSelect,
        isModalSubmit: () => false,
        isChannelSelectMenu: () => false,
        isRoleSelectMenu: () => false,
        customId,
        guildId: '111111111111111111',
        user: { id: OWNER_ID },
        member: { permissions: { has: () => true }, roles: { cache: new Map() } },
        values,
        replied: false,
        deferred: false,
        async update(p) { captured.update = p; return p; },
        async reply(p) { captured.reply = p; return p; },
        async followUp(p) { captured.followUp = p; return p; },
        __captured: captured,
    };
}

/** فحص payload بمعايير Components V2 الصارمة (نسخة v2_design) */
function assertV2Payload(payload, label) {
    assert.ok(payload && typeof payload === 'object', `${label}: payload موجود`);
    assert.strictEqual(payload.flags, 32768, `${label}: flags = IsComponentsV2`);
    assert.ok(!('embeds' in payload), `${label}: لا embeds`);
    assert.ok(!('content' in payload), `${label}: لا content مع V2`);
    assert.ok(Array.isArray(payload.components) && payload.components.length >= 1, `${label}: مكوّنات موجودة`);
    const json = JSON.parse(JSON.stringify(payload, (k, v) => (v && typeof v.toJSON === 'function' ? v.toJSON() : v)));
    let textTotal = 0, count = 0, dividers = 0;
    (function walk(comp) {
        if (!comp || typeof comp !== 'object') return;
        count++;
        if (comp.content && typeof comp.content === 'string') textTotal += comp.content.length;
        if (comp.type === 14 && comp.divider) dividers++;
        assert.ok(count <= 40, `${label}: عدد المكوّنات ≤ 40`);
        for (const child of comp.components || []) walk(child);
    })(json);
    assert.ok(textTotal <= 4000, `${label}: النص ${textTotal} ≤ 4000`);
    return { json, dividers };
}

/** جمع كل النص داخل payload */
function allText(json) {
    let out = '';
    (function walk(c) {
        if (!c || typeof c !== 'object') return;
        if (typeof c.content === 'string') out += c.content + '\n';
        if (c.label) out += c.label + '\n';
        for (const ch of c.components || []) walk(ch);
    })(json);
    return out;
}

/** جمع custom_ids */
function allCustomIds(json) {
    const ids = [];
    (function walk(c) {
        if (!c || typeof c !== 'object') return;
        if (c.custom_id) ids.push(c.custom_id);
        for (const ch of c.components || []) walk(ch);
    })(json);
    return ids;
}

async function run() {
    // ══════════════════════════════════════════════════════════
    // 1) الشاشة الأولى: قائمة اختيار الوكيل — لا سيرفرات مختلطة
    // ══════════════════════════════════════════════════════════
    {
        const page = await dashboard.renderRadarHome(fakeManager);
        const { json } = assertV2Payload(page, 'شاشة اختيار الوكيل');
        const select = (function find(c) {
            if (!c || typeof c !== 'object') return null;
            if (c.custom_id === 'dash:radar_agent_select') return c;
            for (const ch of c.components || []) { const f = find(ch); if (f) return f; }
            return null;
        })(json);
        assert.ok(select, 'قائمة اختيار الوكيل موجودة');
        assert.strictEqual(select.options.length, 2, 'الوكيلان في القائمة');
        assert.ok(select.options[0].label && select.options[0].value, 'خيارات صالحة');
        ok('1) /الرصد تبدأ بقائمة اختيار الوكيل (خياران) — بلا أي قائمة سيرفرات مختلطة');
    }

    // ══════════════════════════════════════════════════════════
    // 2) getAgentRadar — سيرفرات الوكيل هو فقط + إحصائياته هو فقط
    // ══════════════════════════════════════════════════════════
    {
        const rows = await guildRegistry.getAgentRadar(AGENT_A_ID, '999000111222333', 'وكيل الترجمة');
        const gids = rows.map(r => String(r.guild_id)).sort();
        assert.deepStrictEqual(gids, ['g1', 'g3'], 'الوكيل A: سيرفراه فقط (لا g2 الخاصة بـ B)');
        const g1 = rows.find(r => r.guild_id === 'g1');
        const g3 = rows.find(r => r.guild_id === 'g3');
        assert.strictEqual(g1.total_chats, 2, 'g1: نبضتا الوكيل A فقط');
        assert.strictEqual(g3.total_chats, 1, 'g3: نبضة الوكيل A');
        assert.ok(g1.last_activity && g1.last_activity.created_at, 'g1: آخر نشاط موجود');

        // الوكيل B بلا هوية بوت معروفة → سجل النشاط يلتقط سيرفره
        const rowsB = await guildRegistry.getAgentRadar(AGENT_B_ID, null, 'وكيل الإدارة');
        assert.deepStrictEqual(rowsB.map(r => String(r.guild_id)), ['g2'], 'الوكيل B: g2 فقط عبر نشاطه');
        assert.strictEqual(rowsB[0].total_chats, 1, 'g2: نبضة الوكيل B فقط');

        // بلا أي مصدر → فارغة بلا انهيار
        const none = await guildRegistry.getAgentRadar('ffffffffffffffffffffffff', null, 'مجهول');
        assert.strictEqual(none.length, 0, 'وكيل بلا سيرفرات → قائمة فارغة');
        ok('2) getAgentRadar: سيرفرات ونبضات كل وكيل معزولة تماماً عن الآخر');
    }

    // ══════════════════════════════════════════════════════════
    // 3) شاشة سيرفرات الوكيل — خطوط فاصلة حقيقية + Markdown مرتب
    // ══════════════════════════════════════════════════════════
    {
        const page = await dashboard.renderRadarAgent(fakeManager, AGENT_A_ID, 0);
        const { json, dividers } = assertV2Payload(page, 'شاشة سيرفرات الوكيل');
        const text = allText(json);
        assert.ok(text.includes('وكيل الترجمة'), 'اسم الوكيل ظاهر');
        assert.ok(text.includes('سيرفر المانها'), 'سيرفر g1 ظاهر');
        assert.ok(text.includes('سيرفر مشترك'), 'سيرفر g3 ظاهر');
        assert.ok(!text.includes('سيرفر الإدارة'), 'سيرفر الوكيل الآخر غير ظاهر إطلاقاً');
        assert.ok(text.includes('@zeus'), 'من أضافه ظاهر');
        assert.ok(text.includes('### 🏰'), 'عنوان Markdown لكل سيرفر');
        // خط مرئي فاصل حقيقي قبل كل كتلة سيرفر + الملخص + الأسفل
        assert.ok(dividers >= 4, `فواصل مرئية كافية (${dividers} ≥ 4)`);
        // أزرار التفاصيل تحمل سياق الوكيل
        const ids = allCustomIds(json).join('\n');
        assert.ok(ids.includes(`dash:radar_guild:${AGENT_A_ID}:g1`), 'زر تفاصيل g1 بسياق الوكيل');
        assert.ok(ids.includes(`dash:radar_agent:${AGENT_A_ID}:0`), 'زر تحديث/تنقل بسياق الوكيل');
        ok('3) سيرفرات الوكيل كتل مفصولة بخطوط مرئية حقيقية + Markdown نظيف + أزرار بسياق الوكيل');
    }

    // ══════════════════════════════════════════════════════════
    // 4) ضغط القائمة (Interaction حقيقي): اختيار وكيل → سيرفراته فوراً
    // ══════════════════════════════════════════════════════════
    {
        const i = makeInteraction({ customId: 'dash:radar_agent_select', isSelect: true, values: [AGENT_A_ID] });
        const handled = await dashboard.handleDashboardInteraction(i, fakeManager);
        assert.strictEqual(handled, true, 'التفاعل معالج');
        assert.ok(i.__captured.update, 'الصفحة حُدّثت');
        const { json } = assertV2Payload(i.__captured.update, 'صفحة ما بعد الاختيار');
        const text = allText(json);
        assert.ok(text.includes('سيرفر المانها'), 'سيرفرات الوكيل المختار ظهرت فوراً');
        ok('4) اختيار الوكيل من القائمة يعرض سيرفراته مباشرة (تفاعل حقيقي)');
    }

    // ══════════════════════════════════════════════════════════
    // 5) تفاصيل سيرفر: صيغة جديدة بسياق وكيل + توافق الصيغة القديمة
    // ══════════════════════════════════════════════════════════
    {
        // جديدة: dash:radar_guild:<agentId>:<guildId> — الرجوع لسيرفرات نفس الوكيل
        const iNew = makeInteraction({ customId: `dash:radar_guild:${AGENT_A_ID}:g1`, isButton: true });
        await dashboard.handleDashboardInteraction(iNew, fakeManager);
        assert.ok(iNew.__captured.update, 'تفاصيل السيرفر (جديدة) رُسمت');
        const newIds = allCustomIds(JSON.parse(JSON.stringify(iNew.__captured.update, (k, v) => (v && typeof v.toJSON === 'function' ? v.toJSON() : v)))).join('\n');
        assert.ok(newIds.includes(`dash:radar_agent:${AGENT_A_ID}:0`), 'زر الرجوع يذهب لسيرفرات نفس الوكيل');

        // قديمة: dash:radar_guild:<guildId> — توافق بلا انهيار
        const iOld = makeInteraction({ customId: 'dash:radar_guild:g1', isButton: true });
        await dashboard.handleDashboardInteraction(iOld, fakeManager);
        assert.ok(iOld.__captured.update, 'تفاصيل السيرفر (قديمة) رُسمت');

        ok('5) تفاصيل السيرفر بالصيغتين — والرجوع يعيد لسيرفرات نفس الوكيل');
    }

    // ══════════════════════════════════════════════════════════
    // 6) كتلة السيرفر تُظهر «خرج البوت» ونبضة حية — والتقسيم سليم
    // ══════════════════════════════════════════════════════════
    {
        const block = dashboard.radarGuildBlock({
            guild_id: 'g9', name: 'سيرفر مغادر', member_count: 10, joined_at: new Date('2025-01-05'),
            left: true, left_at: new Date('2025-05-05'), added_by_tag: 'x', added_by_id: 'x1',
            total_chats: 7, last_activity: { created_at: new Date('2025-05-01') }, qwen_badge: '✅ مفعّل (a@b.c)',
        });
        assert.ok(block.includes('خرج البوت منه'), 'حالة المغادرة ظاهرة');
        assert.ok(block.includes('2025'), 'التواريخ ظاهرة');
        assert.ok(block.includes('7'), 'عدد المحادثات ظاهر');

        const live = dashboard.radarGuildBlock({
            guild_id: 'g8', name: 'سيرفر حي', member_count: 5, joined_at: new Date(),
            left: false, total_chats: 1, last_activity: { created_at: new Date() },
            qwen_badge: '—', live: { username: 'fahad', channelName: 'قعدة' },
        });
        assert.ok(live.includes('يتكلم معه الآن') && live.includes('fahad'), 'النبضة الحية باسم المتكلم والقناة');
        ok('6) كتلة السيرفر تعرض المغادرة والنبضة الحية بدقة');
    }

    console.log('\n════════════════════════════════');
    console.log(`radar_agent: ${passed}/6 ناجحة`);
    if (passed !== 6) process.exit(1);
}

run().catch((e) => { console.error('💥', e); process.exit(1); });
