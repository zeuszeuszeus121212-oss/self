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
 * 11) انحدار v7.14.1: أمر /الألعاب يرسل اللوحة فعلاً بعد التأجيل — لا تعليق
 *     تحميل أبداً (حتى عند فشل القاعدة: لوحة خطأ بدل الصمت).
 * 12) بلاغات المالك v7.15: الخسارة المزيفة (لوبي/شرطية/طرد غيرنا)، زر حقيبتي،
 *     معالج دور الروليت المفقود، والقفل المُقيّد بالوكيل صاحب النتيجة.
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

    // ── 2) السجل: 4 محركات كما في Auto + مافيا (v7.16) ──
    {
        const ids = engines.engineIds().sort();
        assert.deepStrictEqual(ids, ['karasi', 'mafia', 'replka', 'roulette', 'zar'], 'المحركات الخمسة (مافيا أُضيفت v7.16)');
        const names = engines.getEngines().map(e => e.displayName);
        for (const expected of ['زر', 'روليت', 'كراسي', 'ريبلكا', 'مافيا']) assert(names.includes(expected), `اسم المحرك ${expected}`);
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

    // ── 16) انحدار v7.14.1: أمر /الألعاب يرسل اللوحة فعلاً — لا تعليق تحميل أبداً ──
    // (الخطأ الأصلي: deferReply ثم return بلا إرسال — الأمر يظل «يحمل» إلى الأبد)
    {
        const panel = require('../games/panel');
        const fakeManager = { runtimes: new Map() };
        const cfgMod = require.cache[cfgPath].exports;

        const makeCommandInteraction = (sink) => ({
            isChatInputCommand: () => true,
            isModalSubmit: () => false,
            isStringSelectMenu: () => false,
            isButton: () => false,
            isChannelSelectMenu: () => false,
            commandName: 'الألعاب',
            customId: null,
            replied: false,
            deferred: false,
            deferReply: async () => { sink.defer += 1; },
            editReply: async (payload) => { sink.edits += 1; sink.payload = payload; },
            reply: async (payload) => { sink.replies += 1; sink.payload = payload; },
        });

        // الحالة السليمة: وكلاء موجودون → اللوحة تُرسل (تأجيل + تعديل بقائمة اختيار الوكيل)
        cfgMod.agents_col = {
            find: () => ({ sort: () => ({ limit: () => ({ toArray: async () => ([
                { _id: AGENT_A, name: 'وكيل الحساب', token_type: 'user', status: 'running' },
            ]) }) }) }),
        };
        const sink1 = { defer: 0, edits: 0, replies: 0, payload: null };
        const handled1 = await panel.handleGamesInteraction(makeCommandInteraction(sink1), fakeManager);
        assert.strictEqual(handled1, true, 'الأمر يعرف نفسه ويقطع التوجيه');
        assert.strictEqual(sink1.defer, 1, 'تأجيل فوري (حماية مهلة ديسكورد 3 ثوان)');
        assert.strictEqual(sink1.edits, 1, 'اللوحة أُرسلت فعلاً بعد التأجيل — لا تعليق تحميل');
        assert.ok(sink1.payload, 'الحمولة موجودة');
        assert.strictEqual(sink1.payload.flags, 32768, 'علم Components V2 حاضر (1<<15)');
        assert.ok(Array.isArray(sink1.payload.components) && sink1.payload.components.length > 0, 'مكونات V2 مُرسلة');
        assert.ok(JSON.stringify(sink1.payload).includes('agent_select'), 'الصفحة الأولى (اختيار الوكيل) هي ما وصل للمالك');

        // حالة الفشل: قاعدة البيانات ترمي → لوحة خطأ حمراء تُرسل بدل التعليق
        cfgMod.agents_col = { find: () => { throw new Error('DB down'); } };
        const sink2 = { defer: 0, edits: 0, replies: 0, payload: null };
        await panel.handleGamesInteraction(makeCommandInteraction(sink2), fakeManager);
        assert.strictEqual(sink2.edits, 1, 'حتى عند فشل القاعدة: لوحة خطأ تُرسل — لا تحميل أبدي');
        assert.ok(String(sink2.payload && JSON.stringify(sink2.payload)).includes('DB down'), 'رسالة الخطأ ظاهرة للمالك');

        // الأمر الغريب: ليس لنا → يُترك للوحة المدير (لا تدخل ولا اعتراض)
        const stranger = makeCommandInteraction({ defer: 0, edits: 0, replies: 0, payload: null });
        stranger.commandName = 'رصد';
        const handled3 = await panel.handleGamesInteraction(stranger, fakeManager);
        assert.strictEqual(handled3, false, 'أوامر غيرنا تمر للوحة المدير كما هي');
    }

    // ── 17) بلاغ المالك: «جاري البحث عن لاعبين خارجيين...» تُسجّل خسارة مزيفة ──
    // (كان الكود يطابق «خسرت» substring في شرط الجائزة «إذا خسرت ستفقد» + منشن
    //  قائمة اللاعبين → خسارة وهمية. الآن: لوبي مرفوض + شرطية مرفوضة + حدود الأسطر)
    {
        const { outcomeFromMessage } = player.__internals;
        const client = makeClient();
        const me = `<@${AGENT_USER_ID}>`;

        // الرسالة الحرفية من البلاغ — كان يُسجّل خسارة
        const lobbyMsg = makeMessage({
            content: '🛰️ جاري البحث عن لاعبين خارجيين للانضمام إلى اللعبة...',
            embeds: [{
                title: 'روليت',
                description: `اللاعبون الحاليون:\n${me} <@555000111222333001>`,
                fields: [{ name: '⚠️ المخاطرة', value: 'إذا خسرت ستفقد 100 نقطة من رصيدك' }],
            }],
        });
        assert.strictEqual(outcomeFromMessage(lobbyMsg, client), null, 'رسالة البحث عن لاعبين ليست خسارة أبداً');
        const lossesBefore = store.statsFor(AGENT_A, GUILD).losses;
        await player.handleMessage({ client, message: lobbyMsg, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(store.statsFor(AGENT_A, GUILD).losses, lossesBefore, 'صفر خسائر مزيفة عبر خط الأنابيب كاملاً');

        // شرطية بلا علامة لوبي: «إذا خسرت» في حقل مستقل — ليست نتيجة
        const conditionalMsg = makeMessage({
            embeds: [{
                title: 'روليت',
                description: `اللاعبون: ${me}`,
                fields: [{ name: 'الجائزة', value: 'إذا خسرت ستفقد نقاطك' }],
            }],
        });
        assert.strictEqual(outcomeFromMessage(conditionalMsg, client), null, '«إذا خسرت ستفقد» شرط وليس نتيجة');

        // طرد لاعب آخر وإن ذُكرنا في السطر نفسه — المطرود هو من يلي العبارة مباشرة
        const otherKick = makeMessage({
            content: `تم طرد <@555000111222333001> — المتبقون: ${me}`,
        });
        assert.strictEqual(outcomeFromMessage(otherKick, client), null, 'طرد غيرنا ليس خسارتنا حتى في سطرنا');

        // فوز لاعب آخر لا يُسجل لنا
        const otherWin = makeMessage({ content: '🏆 فاز <@555000111222333001> باللعبة!' });
        assert.strictEqual(outcomeFromMessage(otherWin, client), null, 'فوز غيرنا ليس فوزنا');
    }

    // ── 18) النتائج الصحيحة تُسجَّل بدقة ──
    {
        const { outcomeFromMessage } = player.__internals;
        const client = makeClient();
        const me = `<@${AGENT_USER_ID}>`;

        const kick = outcomeFromMessage(makeMessage({ content: `💀 تم طرد ${me} من اللعبة!` }), client);
        assert.ok(kick && kick.result === 'loss' && kick.kind === 'kick', 'طردنا = خسارة من نوع طرد');

        const win1 = outcomeFromMessage(makeMessage({ content: `🏆 فاز ${me} باللعبة!` }), client);
        assert.ok(win1 && win1.result === 'win', 'فوزنا (منشن قبل العبارة)');

        const win2 = outcomeFromMessage(makeMessage({ content: `# 👑 - ${me} فاز باللعبة!` }), client);
        assert.ok(win2 && win2.result === 'win', 'فوزنا (نمط الاختبار القديم يعمل بعد التحديث)');

        const win3 = outcomeFromMessage(makeMessage({ content: `الفائز: ${me} 🎉` }), client);
        assert.ok(win3 && win3.result === 'win', '«الفائز: نحن» يُسجل فوزاً');

        // مخاطبة بلا منشن نصي: «تم طردك» + message.mentions.has
        const secondPerson = makeMessage({ content: 'تم طردك من اللعبة!' });
        secondPerson.mentions = { has: (id) => id === AGENT_USER_ID };
        const loss2 = outcomeFromMessage(secondPerson, client);
        assert.ok(loss2 && loss2.result === 'loss' && loss2.kind === 'kick', '«تم طردك» تخاطبنا = طرد');
    }

    // ── 19) بلاغ المالك: بوت البادئة «.» — كان يضغط «حقيبتي» بدل زر الدخول ──
    {
        setSettings(AGENT_A, GUILD, { enabled: true, engines: { roulette: { enabled: true } } });
        // زر الانضمام الصريح يتقدم دائماً وإن كانت حقيبتي خضراء وأول الترتيب
        for (let i = 0; i < 4; i++) {
            const msg = makeMessage({
                content: '.روليت — لوحة اللعبة',
                components: [{ components: [btn('حقيبتي', 'bag_join', { style: 3 }), btn('انضمام', 'join_btn', { style: 3 })] }],
            });
            await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
            assert.deepStrictEqual(msg.__clicks, ['join_btn'], 'زر الانضمام الصريح يتقدم على حقيبتي');
        }
        // بلا اسم انضمام: حقيبتي مستبعدة حتى لو خضراء — الضغطة من المقاعد فقط
        for (let i = 0; i < 6; i++) {
            const msg = makeMessage({
                content: '.روليت — لوحة اللعبة',
                components: [{ components: [btn('حقيبتي', 'bag2', { style: 3 }), btn('5', 'seat5'), btn('9', 'seat9')] }],
            });
            await player.handleMessage({ client: makeClient(), message: msg, agentId: AGENT_A, runtimeSettings });
            assert.ok(['seat5', 'seat9'].includes(msg.__clicks[0]), `حقيبتي لا تنضغط أبداً — كانت ${msg.__clicks[0]}`);
        }
        // وحدة الاختيار مباشرة
        const pick = eventsMod.pickJoinButton;
        assert.strictEqual(pick([btn('انضمام', 'j'), btn('دخول', 'd')]).customId, 'j', 'أول زر انضمام يفوز');
        assert.strictEqual(pick([btn('متجر', 's'), btn('اخرج', 'x')]), null, 'كلها واجهة → لا اختيار');
        assert.strictEqual(pick([]), null, 'بلا أزرار → لا اختيار');
    }

    // ── 20) بلاغ المالك: «عندما يأتي دوره لا يضغط اي شيء» — معالج الدور المفقود ──
    // (roulettePlay كان موجوداً في Auto وحناقطعن في v7.14 — الآن منقول + بوابة جلسة)
    {
        const sessionsMod = require('../games/sessions');
        sessionsMod.__reset(); // انضمامات المجموعات السابقة فتحت جلسات — نبدأ نظيفين
        const sim = eventsMod.HUMAN_SIM;
        const savedSim = { ...sim };
        sim.skip = 0; sim.minDelay = 5; sim.maxDelay = 10; sim.extraProb = 0;

        // بلا جلسة انضمام حية → لا ضغط خارج أي لعبة (أكثر أماناً من Auto نفسه)
        const turnNoSession = makeMessage({
            content: `<@${AGENT_USER_ID}> دورك! اختر لاعباً لطرده`,
            components: [{ components: [btn('خالد', 'p_khaled'), btn('سامي', 'p_sami'), btn('انسحب', 'withdraw'), btn('حقيبتي', 'bag3')] }],
        });
        await player.handleMessage({ client: makeClient(), message: turnNoSession, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(turnNoSession.__clicks.length, 0, 'بلا جلسة: لا ضغط');

        // انضمام فعلي → جلسة حية
        const joinMsg = makeMessage({
            content: '🎡 روليت — اختر رقمك للدخول',
            components: [{ components: [btn('انضمام', 'turn_join')] }],
        });
        await player.handleMessage({ client: makeClient(), message: joinMsg, agentId: AGENT_A, runtimeSettings });
        assert.ok(sessionsMod.getSession(AGENT_A, GUILD), 'الانضمام فتح جلسة حية');

        // الدور عليه → يضغط لاعباً فقط (لا انسحاب ولا حقيبتي)
        const turnMsg = makeMessage({
            content: `<@${AGENT_USER_ID}> دورك! اختر لاعباً لطرده`,
            components: [{ components: [btn('خالد', 'p_khaled'), btn('سامي', 'p_sami'), btn('انسحب', 'withdraw'), btn('حقيبتي', 'bag3')] }],
        });
        await player.handleMessage({ client: makeClient(), message: turnMsg, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(turnMsg.__clicks.length, 1, 'الدور: ضغطة واحدة');
        assert.ok(['p_khaled', 'p_sami'].includes(turnMsg.__clicks[0]), `الضغط على لاعب فقط — كانت ${turnMsg.__clicks[0]}`);

        // تخطي الدور (محاكاة بشرية 1%) — صامت: بلا ضغط ولا إحصائية والجلسة باقية
        sim.skip = 1;
        const turnSkip = makeMessage({
            id: 'mskip1',
            content: `<@${AGENT_USER_ID}> دورك!`,
            components: [{ components: [btn('خالد', 'p_k2')] }],
        });
        await player.handleMessage({ client: makeClient(), message: turnSkip, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(turnSkip.__clicks.length, 0, 'التخطي: صفر ضغط');
        assert.ok(sessionsMod.getSession(AGENT_A, GUILD), 'التخطي لا يغلق الجلسة');
        Object.assign(sim, savedSim);
    }

    // ── 21) القفل المُقيّد: خسارة وكيل لا تحرر أقفال غيره (كان clearLocks يحرر الكل) ──
    {
        await policy.setOverlapLock(true);
        setSettings(AGENT_B, GUILD, { enabled: true, engines: { roulette: { enabled: true } } });
        const lockMsgB = makeMessage({
            content: '🎡 روليت — دخول',
            components: [{ components: [btn('انضمام', 'scoped_join_b')] }],
        });
        await player.handleMessage({ client: makeClient(), message: lockMsgB, agentId: AGENT_B, runtimeSettings });
        assert.ok(policy.getLocks().some(l => l.agentId === AGENT_B), 'ب يمسك قفل روليت');

        // أ يسجل خسارة/طرد — قفل ب يجب أن يبقى
        setSettings(AGENT_A, GUILD, { enabled: true, engines: { roulette: { enabled: true } } });
        const lossMsgA = makeMessage({ content: `💀 تم طرد <@${AGENT_USER_ID}> من اللعبة` });
        await player.handleMessage({ client: makeClient(), message: lossMsgA, agentId: AGENT_A, runtimeSettings });
        assert.ok(policy.getLocks().some(l => l.agentId === AGENT_B), 'خسارة أ لا تحرر قفل ب');

        // خسارة ب تحرر قفلها وحده
        const lossMsgB = makeMessage({ content: `💀 تم طرد <@${AGENT_USER_ID}> من اللعبة` });
        await player.handleMessage({ client: makeClient(), message: lossMsgB, agentId: AGENT_B, runtimeSettings });
        assert.strictEqual(policy.getLocks().length, 0, 'خسارة ب تحرر قفلها فقط');
        await policy.setOverlapLock(false);
    }

    // ── تنظيف ──
    player.agentStop(AGENT_A);
    player.agentStop(AGENT_B);
    overrides.clear();
    policy.clearLocks();

    console.log('✅ games_player.test.js — كل الفحوصات مرت (21 مجموعة)');
}

run().catch((error) => {
    console.error('❌ games_player.test.js فشل:', error);
    process.exit(1);
});
