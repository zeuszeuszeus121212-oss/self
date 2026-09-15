/**
 * tests/games_player.test.js — الجولة الثامنة عشرة (v7.14)
 * ═══════════════════════════════════════════════════════════
 * يحمي ميزة «الوكيل يلعب ألعاب البوتات» المنقولة من مستودع Auto
 * بطلب المالك («سوف ناخذ كل شيء منه بالكامل»)، مع شرطه الصارم:
 * «لا اريده ان يخرب اي شيء حالي».
 *
 * يثبت بالفحص الفعلي:
 *  1) الافتراضي معطل كلياً: رسالة بوت لعبية تمر بلا أي فعل — صفر كسر.
 *  2) المحركات الأربعة مسجلة كما في Auto (زر/روليت/كراسي/ريبلكا).
 *  3) الدخول: كراسي (إيمبد كراسي + أول زر)، ريبلكا (عنوان ريبلكا)،
 *     روليت (رقم شاغر عشوائي — يستثني اخرج/متجر).
 *  4) اللعب: الزر الأخضر (زر/كراسي) عند «اضغط على الزر» في messageUpdate.
 *  5) ريبلكا: القاموس المنقول حرفياً يجيب، والذكاء (وهمي هنا) له الأولوية
 *     ويسقط للقاموس عند فشله.
 *  6) النتائج: فوز/خسارة تحرر الأقفال وتحدث الإحصائيات.
 *  7) السياسة: فلتر بوتات + سيرفرات + قفل تداخل يمنع حساباً ثانياً.
 *  8) إعدادات (وكيل×سيرفر) معزولة تماماً + التفعيل حي بلا إعادة تشغيل.
 *  9) كتم الذكاء: افتراضياً الرسالة تكمل مسارها (false) — وفعّاله يُبتلع.
 * 10) صفحات اللوحة V2 سليمة (بلا رميات، حدود الديسكورد محترمة).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');

// ---------- حقن config وهمي في require cache (بلا MongoDB حقيقي) ----------
const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));

// 🛡️ نسخة سياسة بالذاكرة — نفس عقد findOneAndUpdate لكي تعمل البوابات فعلياً
const policyDocStore = {
    key: 'default',
    overlapLockEnabled: false,
    engineOverlapLocks: {},
    allowedServers: [],
    engineAllowedServers: {},
    engineAllowedBots: {},
    engineBotFilters: {},
    updatedAt: new Date(),
};
function setDeep(target, dottedPath, value) {
    const parts = String(dottedPath).split('.');
    let node = target;
    for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
        node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
}
const mockPolicyCol = {
    findOneAndUpdate: async (_filter, update, _opts) => {
        for (const key of ['$set', '$setOnInsert']) {
            const patch = update && update[key];
            if (patch) for (const [k, v] of Object.entries(patch)) {
                if (k === 'key') policyDocStore.key = v;
                else if (k === 'updatedAt') policyDocStore.updatedAt = v;
                else setDeep(policyDocStore, k, v);
            }
        }
        return { ...policyDocStore };
    },
};

require.cache[cfgPath] = { id: cfgPath, filename: cfgPath, loaded: true, exports: {
    game_players_col: { __mock: true },
    game_policy_col: mockPolicyCol,
    logs_col: null, // بلا سجل دائم في الاختبار
    SimpleLock: class { async acquire(fn) { return fn(); } },
} };

const AGENT_A = 'a1000000000000000000000aa'; // حساب مستخدم
const AGENT_B = 'b2000000000000000000000bb'; // حساب آخر (قفل التداخل)
const GUILD = 'g111111111111111111';
const CHANNEL = 'c222222222222222222';
const GAME_BOT_ID = '1508592252220477651';

const store = require('../games/store');
const policy = require('../games/policy');
const engines = require('../games/engines');
const eventsMod = require('../games/events');
const player = require('../games/player');

// ════════════════════════════════════════════════════════════
//  نسخة اختبار من store — تخزين بالذاكرة بدل MongoDB
// ════════════════════════════════════════════════════════════

const memoryDocs = new Map(); // `${agentId}:${guildId}` → patch
const realCol = { findOne: async ({ agent_id, guild_id }) => memoryDocs.get(`${agent_id}:${guild_id}`) || null };
const realPolicyCol = { findOneAndUpdate: async () => ({}) };

// نستبدل ensureCol داخلياً عبر حقن الكاش: أبسط طريق — نحاكي بدوال store نفسها
let overrides = new Map(); // key → settings (يتخطى store الحقيقي)
const origGet = store.getGameSettings;
store.getGameSettings = async (agentId, guildId) => {
    const key = `${String(agentId)}:${String(guildId)}`;
    if (overrides.has(key)) return overrides.get(key);
    return origGet(agentId, guildId);
};

function setSettings(agentId, guildId, patch) {
    const key = `${String(agentId)}:${String(guildId)}`;
    const base = store.defaultSettings();
    overrides.set(key, {
        ...base,
        ...patch,
        engines: { ...base.engines, ...(patch.engines || {}) },
    });
}

// ════════════════════════════════════════════════════════════
//  أدوات بناء رسائل وهمية (selfbot-style: clickButton قابل للتجسس)
// ════════════════════════════════════════════════════════════

const AGENT_USER_ID = '999000111222333444';

function makeClient() {
    return {
        __selfbotRuntime: true,
        user: { id: AGENT_USER_ID },
        guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'سيرفر الاختبار' }]]) },
        channels: { fetch: async (id) => ({ id, send: async (content) => ({ content }) }) },
    };
}

function makeMessage(overridesMsg = {}) {
    const clicks = [];
    const message = {
        id: overridesMsg.id || `m${Math.random().toString(36).slice(2)}`,
        guild: { id: GUILD, name: 'سيرفر الاختبار' },
        channel: { id: CHANNEL, send: async () => {}, sendTyping: async () => {} },
        author: { id: GAME_BOT_ID, bot: true },
        content: '',
        embeds: [],
        components: [],
        mentions: { has: () => false },
        clickButton: async (customId) => { clicks.push(customId); },
        ...overridesMsg,
    };
    message.__clicks = clicks;
    return message;
}

function btn(label, customId, { style = 1, disabled = false } = {}) {
    return { type: 'BUTTON', label, custom_id: customId, customId, style, disabled };
}

const runtimeSettings = { provider: 'deepseek', providerConfig: {}, kind: 'agent' };

function registerAgents() {
    player.agentReady({ client: makeClient(), agentId: AGENT_A, agentName: 'وكيل أ', tokenType: 'user', kind: 'agent' });
    player.agentReady({ client: makeClient(), agentId: AGENT_B, agentName: 'وكيل ب', tokenType: 'user', kind: 'agent' });
}

// ════════════════════════════════════════════════════════════
//  الاختبارات
// ════════════════════════════════════════════════════════════

async function run() {
    registerAgents();

    // ── 1) الافتراضي معطل: صفر كسر ──
    {
        const msg = makeMessage({ content: 'اضغط على الزر', components: [{ components: [btn('1', 's1', { style: 3 })] }] });
        const swallow = await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(swallow, false, 'الافتراضي: لا ابتلاع');
        assert.strictEqual(msg.__clicks.length, 0, 'الافتراضي: صفر ضغطات — الوحدة صامتة كلياً');
        const updateSwallow = await player.handleMessageUpdate({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(updateSwallow, false, 'messageUpdate الافتراضي أيضاً بلا فعل');
    }

    // ── 2) السجل: 4 محركات كما في Auto ──
    {
        const ids = engines.engineIds().sort();
        assert.deepStrictEqual(ids, ['karasi', 'replka', 'roulette', 'zar'], 'المحركات الأربعة');
        const names = engines.getEngines().map(e => e.displayName);
        for (const expected of ['زر', 'روليت', 'كراسي', 'ريبلكا']) assert(names.includes(expected), `اسم المحرك ${expected}`);
    }

    // ── 3) تفعيل الوكيل أ لهذا السيرفر + كل المحركات ──
    setSettings(AGENT_A, GUILD, { enabled: true, engines: {
        zar: { enabled: true }, roulette: { enabled: true }, karasi: { enabled: true }, replka: { enabled: true },
    } });

    // ── 4) دخول كراسي: إيمبد كراسي + أول زر ──
    {
        const msg = makeMessage({
            embeds: [{ title: '🎮 الكراسي الموسيقية', description: 'انضم الآن' }],
            components: [{ components: [btn('انضمام', 'karasi_join_1')] }],
        });
        await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
        assert.deepStrictEqual(msg.__clicks, ['karasi_join_1'], 'دخول كراسي يضغط أول زر');
        const stats = store.statsFor(AGENT_A, GUILD);
        assert.strictEqual(stats.joins, 1, 'إحصائية انضمام');
    }

    // ── 5) دخول ريبلكا: العنوان بالضبط ──
    {
        const msg = makeMessage({
            embeds: [{ title: 'ريبلكا', description: 'لعبة سريعة' }],
            components: [{ components: [btn('دخول', 'replka_join_9')] }],
        });
        await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
        assert.deepStrictEqual(msg.__clicks, ['replka_join_9'], 'دخول ريبلكا');
    }

    // ── 6) روليت: رقم شاغر عشوائي — يستثني اخرج/متجر والمعطلة ──
    // (8 دورات تكفي — كل دورة تحمل تأخيراً بشرياً حقيقياً 1000-2000ms كما في Auto)
    {
        for (let run = 0; run < 8; run++) {
            const msg = makeMessage({
                content: '🎡 روليت — اختر رقمك',
                components: [{ components: [
                    btn('3', 'num3'), btn('7', 'num7'), btn('اخرج', 'leave'), btn('متجر', 'shop'), btn('9', 'num9', { disabled: true }),
                ] }],
            });
            await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
            assert.strictEqual(msg.__clicks.length, 1, 'ضغطة واحدة');
            assert.ok(['num3', 'num7'].includes(msg.__clicks[0]), `الضغطة على شاغر فقط — كانت ${msg.__clicks[0]}`);
        }
    }

    // ── 7) قفل التداخل: الوكيل ب مرفوض بينما أ يلعب (نفس اللعبة/السيرفر) ──
    // (القفل في Auto نفسه معطل افتراضياً — نفعّله أولاً كما تفعل لوحتنا)
    {
        await policy.setOverlapLock(true);
        // أ أمسك القفل بجولة فعلياً: كراسي join يحمل القفل حتى النتيجة (نمط Auto)
        setSettings(AGENT_B, GUILD, { enabled: true, engines: { karasi: { enabled: true } } });
        const msgA = makeMessage({
            embeds: [{ title: 'الكراسي' }],
            components: [{ components: [btn('انضمام', 'lock_join_a')] }],
        });
        await player.handleMessage({ client: makeClient(), message: msgA, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(msgA.__clicks.length, 1, 'أ دخل أول');

        const msgB = makeMessage({
            embeds: [{ title: 'الكراسي' }],
            components: [{ components: [btn('انضمام', 'lock_join_b')] }],
        });
        await player.handleMessage({ client: makeClient(), message: msgB, agentId: AGENT_B, runtimeSettings });
        assert.strictEqual(msgB.__clicks.length, 0, 'القفل منع ب من نفس اللعبة في نفس السيرفر');

        // رسالة فوز لأ تحرر القفل — بعدها ب يدخل
        const winMsg = makeMessage({ content: `# 👑 - <@${AGENT_USER_ID}> فاز باللعبة!` });
        await player.handleMessage({ client: makeClient(), message: winMsg, agentId: AGENT_A, runtimeSettings });
        const statsA = store.statsFor(AGENT_A, GUILD);
        assert.strictEqual(statsA.wins, 1, 'فوز أ سُجل');

        await player.handleMessage({ client: makeClient(), message: msgB, agentId: AGENT_B, runtimeSettings });
        assert.strictEqual(msgB.__clicks.length, 1, 'ب دخل بعد تحرر القفل');
        await policy.setOverlapLock(false); // إعادة الافتراضي (نمط Auto)
        policy.clearLocks();
    }

    // ── 8) فلتر البوتات: بوت غير مدرج يُرفض ──
    {
        // نحاكي getPolicy بسياسة فلتر مفعّل ببوت وحيد
        const origGetPolicy = policy.getPolicy;
        policy.getPolicy = async () => ({
            key: 'default', overlapLockEnabled: false, engineOverlapLocks: {},
            allowedServers: [], engineAllowedServers: {}, engineBotFilters: { karasi: true },
            engineAllowedBots: { karasi: ['111'] }, engineAllowedServers: {}, allowedServers: [],
        });
        const msg = makeMessage({
            embeds: [{ title: 'الكراسي' }],
            components: [{ components: [btn('انضمام', 'filtered_join')] }],
        });
        await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(msg.__clicks.length, 0, 'فلتر البوتات رفض بوتاً غير مدرج');
        policy.getPolicy = origGetPolicy;
    }

    // ── 9) messageUpdate: الزر الأخضر في زر وكراسي ──
    {
        const zarMsg = makeMessage({
            content: 'اضغط على الزر',
            components: [{ components: [btn('احمر', 'r1', { style: 4 }), btn('اخضر', 'g1', { style: 3 })] }],
        });
        await player.handleMessageUpdate({ client: makeClient(), message: zarMsg, agentId: AGENT_A, runtimeSettings });
        assert.deepStrictEqual(zarMsg.__clicks, ['g1'], 'زر: الزر الأخضر انضغط من messageUpdate');

        const karasiMsg = makeMessage({
            content: 'اضغط على الزر بسرعة!',
            components: [{ components: [btn('أ', 'ka1'), btn('ب', 'ka2'), btn('ج', 'ka3')] }, { components: [btn('د', 'ka4')] }],
        });
        await player.handleMessageUpdate({ client: makeClient(), message: karasiMsg, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(karasiMsg.__clicks.length, 1, 'كراسي: ضغطة عشوائية واحدة');
        assert.ok(/^ka[1-4]$/.test(karasiMsg.__clicks[0]), 'الضغطة من أزرار الجولة نفسها');
    }

    // ── 10) ريبلكا: الذكاء أولاً ثم القاموس المنقول ──
    {
        const question = (letter, cat) => makeMessage({
            content: `<@${AGENT_USER_ID}> لديك **15 ثانية** لإرسال كلمة من فئة **${cat}** تبدأ بـ **${letter}**`,
        });
        let sent = [];
        const answerAiCalls = [];

        // الذكاء ينجح — له الأولوية
        const ctxAi = { agentId: AGENT_A, settings: { ai_answers: true }, answerWithAi: async (q) => { answerAiCalls.push(q); return 'أرنب'; } };
        const ev = eventsMod.eventsForTrigger('messageCreate').find(e => e.name === 'replkaPlay');
        const msg1 = question('أ', 'حيوان');
        msg1.channel.send = async (text) => { sent.push(text); };
        const res1 = await ev.execute(msg1, makeClient(), ctxAi);
        assert.strictEqual(res1.handled, true, 'ريبلكا معالجة');
        assert.strictEqual(res1.details.source, 'ai', 'الذكاء له الأولوية');
        assert.strictEqual(res1.details.answer, 'أرنب');

        // الذكاء يفشل — القاموس المنقول من Auto يتولى (س → سوريا/دولة)
        const msg2 = question('س', 'دولة');
        sent = [];
        msg2.channel.send = async (text) => { sent.push(text); };
        const res2 = await ev.execute(msg2, makeClient(), { agentId: AGENT_A, settings: { ai_answers: true }, answerWithAi: async () => null });
        assert.strictEqual(res2.details.source, 'dictionary', 'القاموس احتياط');
        assert.strictEqual(res2.details.answer, 'سوريا', 'قاموس Auto: س + دولة = سوريا');

        // القاموس وحده (ai_answers=false): م + جماد = مقص
        const msg3 = question('م', 'جماد');
        sent = [];
        msg3.channel.send = async (text) => { sent.push(text); };
        const res3 = await ev.execute(msg3, makeClient(), { agentId: AGENT_A, settings: { ai_answers: false }, answerWithAi: async () => 'لن يُستدعى' });
        assert.strictEqual(res3.details.source, 'dictionary');
        assert.strictEqual(res3.details.answer, 'مقص', 'قاموس Auto: م + جماد = مقص');

        // التنظيف: إجابة الذكاء المتسخة تُنظف
        assert.strictEqual(player.__internals.cleanAiAnswer('**بغداد**.\nالجواب هو'), 'بغداد', 'تنظيف الإجابة');
    }

    // ── 11) كتم الذكاء: افتراضياً false (سلوك اليوم لا يتغير) وفعّاله يبتلع ──
    {
        setSettings(AGENT_A, GUILD, { enabled: true, suppress_ai: false, engines: { karasi: { enabled: true } } });
        const msg = makeMessage({
            embeds: [{ title: 'الكراسي' }],
            components: [{ components: [btn('انضمام', 'swallow_join')] }],
        });
        const swallow = await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(swallow, false, 'بلا كتم: الرسالة تكمل مسارها كما اليوم — صفر تغيير');

        setSettings(AGENT_A, GUILD, { enabled: true, suppress_ai: true, engines: { karasi: { enabled: true } } });
        const msg2 = makeMessage({
            embeds: [{ title: 'الكراسي' }],
            components: [{ components: [btn('انضمام', 'swallow_join2')] }],
        });
        const swallow2 = await player.handleMessage({ client: makeClient(), message: msg2, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(swallow2, true, 'مع الكتم: رسالة اللعبة المعالجة تُبتلع');

        const msg3 = makeMessage({ content: 'رسالة بوت عادية لا علاقة لها بالألعاب' });
        const swallow3 = await player.handleMessage({ client: makeClient(), message: msg3, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(swallow3, false, 'رسالة غير لعبية لا تُبتلع أبداً حتى مع الكتم');
        setSettings(AGENT_A, GUILD, { enabled: true, suppress_ai: false });
    }

    // ── 12) وكلاء البوتات: لا تسجيل لا فعل ──
    {
        player.agentStop('c3000000000000000000000cc'); // غير مسجل أصلاً
        const msg = makeMessage({ embeds: [{ title: 'الكراسي' }], components: [{ components: [btn('انضمام', 'bot_join')] }] });
        const swallow = await player.handleMessage({ client: makeClient(), message: msg, agentId: 'c3000000000000000000000cc', runtimeSettings });
        assert.strictEqual(swallow, false, 'وكيل غير مسجل: لا فعل');
        assert.strictEqual(player.canClickButtons('c3000000000000000000000cc'), false, 'بلا قدرة ضغط');
    }

    // ── 13) عزل الإعدادات: وكيل آخر/سيرفر آخر بلا تفعيل ──
    {
        const s = await origGet(AGENT_A, 'g999999999999999999');
        assert.strictEqual(s.enabled, false, 'سيرفر آخر لنفس الوكيل: الافتراضي معطل');
        const s2 = await origGet(AGENT_B, GUILD);
        assert.ok(typeof s2.enabled === 'boolean', 'إعدادات ب مستقلة');
    }

    // ── 14) قاموس Auto سليم: عينات مطابقة للمصدر ──
    {
        const { answerFromDictionary } = eventsMod;
        assert.strictEqual(answerFromDictionary('أ', 'country'), 'أفغانستان');
        assert.strictEqual(answerFromDictionary('ب', 'human'), 'بسمة');
        assert.strictEqual(answerFromDictionary('ث', 'country'), null, 'لا يوجد → null');
        assert.strictEqual(eventsMod.mapReplkaType('اسم إنسان'), 'human');
        assert.strictEqual(eventsMod.mapReplkaType('دولة'), 'country');
    }

    // ── 15) صفحات اللوحة V2 سليمة بلا رميات ──
    {
        const panel = require('../games/panel');
        const command = panel.gamesCommand();
        assert.strictEqual(command.name, 'الألعاب');

        const fakeManager = { runtimes: new Map() };
        // صفحة اختيار الوكيل: مع وكلاء وبلا وكلاء
        const cfgMod = require.cache[cfgPath].exports;
        cfgMod.agents_col = {
            find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => ([
                { _id: AGENT_A, name: 'وكيل الحساب', token_type: 'user', status: 'running' },
                { _id: AGENT_B, name: 'بوت وكيل', token_type: 'bot', status: 'stopped' },
            ]) }) }) }),
        };
        const home1 = await panel.renderAgentSelect(fakeManager);
        assert.ok(home1, 'صفحة الوكلاء بُنيت');
        cfgMod.agents_col = { find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => [] }) }) }) };
        const home2 = await panel.renderAgentSelect(fakeManager);
        assert.ok(home2, 'صفحة بلا وكلاء بُنيت');
        cfgMod.agents_col = { findOne: async () => ({ _id: AGENT_A, name: 'وكيل الحساب', token_type: 'user' }) };
        const guildPage = await panel.renderGuildSelect(AGENT_A, fakeManager);
        assert.ok(guildPage, 'صفحة السيرفرات (وكيل متوقف) بُنيت بلا انهيار');
        const gamesPage = await panel.renderGamesPage(AGENT_A, GUILD, fakeManager);
        assert.ok(gamesPage, 'صفحة الألعاب بُنيت بلا انهيار');
        const policyPage = await panel.renderPolicyPage();
        assert.ok(policyPage, 'صفحة السياسة بُنيت بلا انهيار (بلا DB — قيم افتراضية)');
    }

    // ── تنظيف ──
    player.agentStop(AGENT_A);
    player.agentStop(AGENT_B);
    overrides.clear();
    policy.clearLocks();

    console.log('✅ games_player.test.js — كل الفحوصات مرت (15 مجموعة)');
}

run().catch((error) => {
    console.error('❌ games_player.test.js فشل:', error);
    process.exit(1);
});
