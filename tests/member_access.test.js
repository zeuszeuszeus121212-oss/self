/**
 * tests/member_access.test.js — Disor Bot v7.4.3 "Sovereign"
 * ─────────────────────────────────────────────────────────────
 * يغطي طلبات المالك (الجولة السادسة):
 *   1. إصلاح Invalid emoji — إيموجيات المزودين كلها آمنة للقوائم المنسدلة
 *      (كان ✦ يفشل بناء القائمة كاملة بخطأ COMPONENT_INVALID_EMOJI)
 *   2. إزالة مؤشر «يكتب...» — لا استدعاءات sendTyping في مسارات الرد
 *   3. العضو العادي يتكلم مع الوكيل:
 *      • برومبت member بلا أي ذكر لأدوات إدارة السيرفر + رفض واثق لا يذكر "منعني النظام"
 *      • حجب أدوات الإدارة في وقت التشغيل برسالة محايدة
 *      • getAccessLevel محصّن ضد member=null ولا يُسقط مسار المحادثة
 *   4. الإيموجيات: عرض المتاح فقط (غير المقفل) في السياق وأداة get_emojis
 */

'use strict';
const assert = require('assert');
const fs = require('fs');
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
    MAX_ATTACHMENT_BYTES: 1_000_000,
    TEXT_EXTENSIONS: new Set(['.txt', '.md', '.json']),
    TEXT_CONTENT_TYPES: new Set(['text/', 'application/json']),
};
require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: fakeConfig };

const providers = require('../providers');
const { buildSystem } = require('../tools/systemPrompt');
const { runAgent } = require('../tools/agent');
const utils = require('../utils');

const results = [];
function check(name, fn) {
    try { fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, err: e.message }); }
}

// ── أدوات مساعدة ──
function makeMember(perms = ['SendMessages', 'ViewChannel']) {
    return {
        id: '111111111111111111',
        permissions: { has: (p) => perms.includes(p) },
    };
}
function makeAdmin() {
    return {
        id: '222222222222222222',
        permissions: { has: (p) => p === 'Administrator' || p === 'SendMessages' },
    };
}

// ═══════════════════════════════════════════════════════════
//  1) إيموجيات المزودين — كلها آمنة للقوائم المنسدلة
// ═══════════════════════════════════════════════════════════
check('1) كل إيموجيات listProviders ضمن القائمة الآمنة (لا Invalid emoji)', () => {
    const { MENU_SAFE_EMOJIS } = utils;
    for (const p of providers.listProviders()) {
        assert.ok(MENU_SAFE_EMOJIS.has(p.emoji), `إيموجي المزود ${p.id} (${p.emoji}) غير آمن للقوائم`);
        // لا يونيكود غريب خارج مجموعة الإيموجي الواحد + variation selector
        for (const ch of p.emoji) {
            const cp = ch.codePointAt(0);
            assert.ok(cp === 0xFE0F || cp >= 0x1F000 || (cp >= 0x2190 && cp <= 0x2BFF),
                `حرف غير متوقع U+${cp.toString(16)} في إيموجي ${p.id}`);
        }
    }
});

check('1-ب) gemini تحديداً لا يعيد ✦ (السبب الأصلي لانهيار الإنشاء وصفحة المزود)', () => {
    const gem = providers.listProviders().find(p => p.id === 'gemini');
    assert.ok(gem, 'مزود gemini مفقود');
    assert.notStrictEqual(gem.emoji, '✦');
});

check('1-ج) safeMenuEmoji يستبدل غير الآمن بالبديل', () => {
    assert.strictEqual(utils.safeMenuEmoji('✦'), '🧠');
    assert.strictEqual(utils.safeMenuEmoji(''), '🧠');
    assert.strictEqual(utils.safeMenuEmoji(undefined), '🧠');
    assert.strictEqual(utils.safeMenuEmoji('🐋', '⚙️'), '🐋');
    assert.strictEqual(utils.safeMenuEmoji('🚀', '⚙️'), '⚙️');
});

// ═══════════════════════════════════════════════════════════
//  2) لا مؤشر كتابة في مسارات الرد
// ═══════════════════════════════════════════════════════════
check('2) agentRuntime وaccountAgent بلا أي استدعاء sendTyping/startTyping', () => {
    for (const f of ['agentRuntime.js', 'accountAgent.js']) {
        const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
        assert.ok(!src.includes('sendTyping'), `${f} ما زال يستدعي sendTyping`);
        assert.ok(!src.includes('startTypingLoop'), `${f} ما زال يستدعي startTypingLoop`);
        assert.ok(!src.includes('startHumanTyping'), `${f} ما زال يستدعي startHumanTyping`);
    }
});

// ═══════════════════════════════════════════════════════════
//  3) العضو العادي — برومبت محادثة فقط + رفض واثق + حجب فعلي
// ═══════════════════════════════════════════════════════════
const ADMIN_TOOL_MARKERS = [
    'get_members', 'clone_server', 'kick_member', 'ban_member', 'delete_channel',
    'create_role', 'execute', 'get_audit_log', 'mass_dm', 'nuke_channel', 'timeout_member',
];

check('3-أ) برومبت العضو لا يذكر أي أداة إدارية نهائياً', () => {
    const sys = buildSystem('Disor', 'default', false, 'member', '', {}, {});
    for (const m of ADMIN_TOOL_MARKERS) {
        assert.ok(!sys.includes(m), `برومبت العضو يذكر أداة إدارية: ${m}`);
    }
    assert.ok(!sys.includes('أدوات إدارية لقراءة السيرفر'), 'برومبت العضو يعلن أدوات إدارية');
});

check('3-ب) برومبت العضو يتضمن قاعدة الرفض الواثق (بلا "لا أستطيع/منعني النظام")', () => {
    const sys = buildSystem('Disor', 'default', false, 'member', '', {}, {});
    assert.ok(sys.includes('من قال لك إنني أنفذ هذا؟'), 'مثال الرفض الواثق مفقود');
    assert.ok(sys.includes('ممنوع تقول "لا أستطيع"'), 'قاعدة عدم قول "لا أستطيع" مفقودة');
    assert.ok(sys.includes('ممنوع "النظام منعني"'), 'قاعدة عدم قول "النظام منعني" مفقودة');
});

check('3-ج) برومبت العضو يحتفظ بأدواته الشخصية وقواعد التنسيق', () => {
    const sys = buildSystem('Disor', 'default', false, 'member', '', { read_url: true }, {});
    for (const m of ['read_url', 'generate_image', 'create_file', 'remember', 'recall', 'set_reminder', 'cancel_reminder', 'ممنوع الكذب', 'تنسيق Discord']) {
        assert.ok(sys.includes(m), `ناقص من برومبت العضو: ${m}`);
    }
});

check('3-د) برومبت الأدمن/المالك يحتفظ بكل أدوات الإدارة كما هي', () => {
    for (const lvl of ['admin', 'owner']) {
        const sys = buildSystem('Disor', 'default', false, lvl, '', {}, {});
        for (const m of ['clone_server', 'kick_member', 'أدوات إدارية لقراءة السيرفر', 'أدوات التنفيذ']) {
            assert.ok(sys.includes(m), `أدمن (${lvl}) فقد: ${m}`);
        }
    }
});

check('3-هـ) العضو الشخصية المخصصة تُحترم في نسخة العضو', () => {
    const sys = buildSystem('Disor', 'default', false, 'member', 'أنت قائد جيش السحاب.', {}, {});
    assert.ok(sys.startsWith('أنت قائد جيش السحاب.'));
});

check('3-و) قراءة الروابط معطلة تُحترم في نسخة العضو بلا أثر read_url كأداة', () => {
    const sys = buildSystem('Disor', 'default', false, 'member', '', { read_url: false }, {});
    assert.ok(!sys.includes('read_url وgenerate_image'), 'قائمة الأدوات ما زالت تتضمن read_url');
    assert.ok(sys.includes('generate_image'), 'بقية الأدوات الشخصية موجودة');
});

check('3-ز) getAccessLevel محصّن — null/عضو غريب → member بلا انهيار', () => {
    assert.strictEqual(utils.getAccessLevel(null), 'member');
    assert.strictEqual(utils.getAccessLevel(undefined), 'member');
    assert.strictEqual(utils.getAccessLevel({}), 'member');
    assert.strictEqual(utils.getAccessLevel(makeMember()), 'member');
    assert.strictEqual(utils.getAccessLevel(makeAdmin()), 'admin');
    assert.strictEqual(utils.getAccessLevel({ id: '656783724662226963' }), 'owner');
});

check('3-ح) حجب التنفيذ للعضو برسالة محايدة (لا صلاحيات/لا منع نظام)', () => {
    const r = utils.executeAllowedForAccess('kick_member', 'member', {});
    assert.strictEqual(r.allowed, false);
    assert.ok(!r.reason.includes('صلاحيات'), 'السبب يذكر صلاحيات');
    assert.ok(!r.reason.includes('منع'), 'السبب يذكر منع');
    assert.ok(!r.reason.includes('⛔'), 'السبب يحمل حرف إدارة');
    // الأدمن يبقى مقيّداً بالسيرفر الحالي، والمالك كله مسموح
    assert.strictEqual(utils.executeAllowedForAccess('kick_member', 'owner', {}).allowed, true);
    assert.strictEqual(utils.executeAllowedForAccess('clone_server', 'admin', {}).allowed, false);
});

// ═══════════════════════════════════════════════════════════
//  4) الإيموجيات — المتاح فقط
// ═══════════════════════════════════════════════════════════
function fakeEmojiCache(emojis) {
    return {
        values: () => emojis.values(),
        size: emojis.length,
        filter: (fn) => ({ map: (fn2) => emojis.filter(fn).map(fn2), size: emojis.filter(fn).length }),
    };
}
check('4) get_emojis يستبعد المقفل والمحذوف ويعرض المتاح فقط', () => {
    const { toolGetEmojis } = require('../tools/readTools');
    const guild = {
        emojis: {
            cache: fakeEmojiCache([
                { id: '1', name: 'free', animated: false, available: true, deleted: false, url: 'u1' },
                { id: '2', name: 'locked', animated: false, available: false, deleted: false, url: 'u2' },
                { id: '3', name: 'deleted', animated: false, available: true, deleted: true, url: 'u3' },
                { id: '4', name: 'ok_anim', animated: true, available: true, deleted: false, url: 'u4' },
            ]),
        },
    };
    const out = toolGetEmojis(guild);
    assert.strictEqual(out.count, 2);
    assert.deepStrictEqual(out.emojis.map(e => e.name), ['free', 'ok_anim']);
    assert.strictEqual(out.locked_excluded, 2);
});

check('4-ب) buildBotContext يعرض المتاح فقط (تنفيذ معزول لجزء الفلترة)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'utils.js'), 'utf8');
    assert.ok(src.includes('e.available !== false && !e.deleted'), 'فلتر المتاح مفقود من buildBotContext');
});

// ═══════════════════════════════════════════════════════════
//  لوحة التحكم — أدمن ديسكورد يمرّ دائماً
// ═══════════════════════════════════════════════════════════
check('5) hasDashboardAccess يقبل صلاحية Administrator مباشرة', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'managerDashboard.js'), 'utf8');
    assert.ok(src.includes("interaction.member?.permissions?.has?.('Administrator')"),
        'بوابة الأدمن المباشرة مفقودة من hasDashboardAccess');
});

// ── تقرير ──
(async () => {
    // اختبار حلقة الوكيل الكاملة لعضو عادي (async)
    try {
        await runMemberLoopTest();
        results.push({ name: '3-ي) العضو داخل حلقة الوكيل: أداة إدارية تُرفض محايداً والمحادثة تكتمل', ok: true });
    } catch (e) {
        results.push({ name: '3-ي) العضو داخل حلقة الوكيل: أداة إدارية تُرفض محايداً والمحادثة تكتمل', ok: false, err: e.message });
    }

    const passed = results.filter(r => r.ok).length;
    console.log('\n════════════════════════════════');
    for (const r of results) {
        console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n   ↳ ${r.err}`}`);
    }
    console.log('════════════════════════════════');
    console.log(`member_access: ${passed}/${results.length} ناجحة`);
    if (passed !== results.length) process.exit(1);
})();

// فصل منطق الاختبار async لقراءة أوضح
async function runMemberLoopTest() {
    let phase = 0;
    const calls = [];
    const fake = {
        id: 'fake_member_loop', label: 'وهمي العضو', emoji: '🧪', description: 'w',
        modalFields: [], validate: () => ({ ok: true, missing: [] }), describe: () => 'w',
        async testConnection() { return 'ok'; },
        async chat({ prompt }) {
            calls.push(prompt);
            phase++;
            if (phase === 1) {
                return { fullText: '```json\n{"tool":"execute","action":"delete_channel","params":{"name":"العام"}}\n```', sessionId: 'sm2', newParentMessageId: null };
            }
            return { fullText: 'من قال لك إنني أنفذ هذا؟ 😉', sessionId: 'sm2', newParentMessageId: null };
        },
    };
    providers.PROVIDERS[fake.id] = fake;
    const result = await runAgent(
        { id: 'g1', name: 'س' }, { id: 'c1', name: 'عام' },
        'احذف قناة العام', '[معلومات المستخدم]\n  ID: 111', '[معلومات البوت]',
        'Disor', null, null, 'g1', 'default', false, 'member', {},
        { agentId: 'agent_member_loop', personality: '', features: {}, capabilities: {}, provider: 'fake_member_loop' },
        { userId: '111', username: 'عضو', channelId: 'c1' },
    );
    assert.ok(result.reply.includes('من قال لك'));
    assert.ok(calls[0].includes('من قال لك إنني أنفذ هذا؟'));
    assert.ok(calls[1].includes('غير متاحة في المحادثة العادية'), 'رسالة الحجب المحايدة لم تصل للنموذج');
}
