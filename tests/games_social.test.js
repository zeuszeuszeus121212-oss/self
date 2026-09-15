/**
 * tests/games_social.test.js — التفاعل الاجتماعي أثناء اللعب (v7.15)
 * ═══════════════════════════════════════════════════════════
 * يحمي سلوك «شخص حقيقي يلعب» بطلب المالك:
 *  1) صفر كسر: الافتراضي معطل → صفر إرسال مهما حدث
 *  2) طُرد هو → يعقّب بالذكاء (السؤال عن السبب) — عبر خط الأنابيب كاملاً
 *  3) التبريد: لا كلام متتالٍ — حد واحد لكل فترة
 *  4) بلا ذكاء → الجمل العربية الجاهزة (نمط قاموس ريبلكا)
 *  5) ذكروه بلا منشن → يرد؛ منشنوه مباشرة → لا يتدخل (المحادثة الرئيسية تتكفل)
 *  6) بلا جلسة لعب حية → صمت كامل
 *  7) طُرد صديق الجلسة → مزحة؛ وطُرد غربي → صمت
 *  8) سقف الجلسة (6 كلمات) — بعده صمت كلي
 *  9) عزل الوكلاء: إعدادات وكيل لا تسرب كلاماً لوكيل آخر
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const assert = require('assert');
const path = require('path');

// ---------- حقن config ومزود وهمي قبل أي تتطلب ----------

const cfgPath = require.resolve(path.join(__dirname, '..', 'config.js'));
const providersPath = require.resolve(path.join(__dirname, '..', 'providers', 'index.js'));

// 🧠 مزود وهمي — نتحكم بردّه وسقوطه لكل اختبار
const fakeProvider = { chat: async () => ({ fullText: 'هههه رد الذكاء الوهمي' }) };
require.cache[providersPath] = {
    id: providersPath, filename: providersPath, loaded: true,
    exports: { getProviderOrFallback: () => fakeProvider },
};

require.cache[cfgPath] = {
    id: cfgPath, filename: cfgPath, loaded: true,
    exports: {
        game_players_col: { __mock: true },
        game_policy_col: { findOneAndUpdate: async () => ({}) },
        logs_col: null,
        SimpleLock: class { async acquire(fn) { return fn(); } },
    },
};

const store = require('../games/store');
const sessions = require('../games/sessions');
const social = require('../games/social');
const policy = require('../games/policy');
const player = require('../games/player');

const AGENT_A = 'a1000000000000000000000aa';
const AGENT_B = 'b2000000000000000000000bb';
const GUILD = 'g111111111111111111';
const CHANNEL = 'c222222222222222222';
const AGENT_USER_ID = '999000111222333444';
const AGENT_NAME = 'وكيل أ';
const FRIEND_ID = '555000111222333001';
const STRANGER_ID = '777000111222333002';

// ⏱️ توقيت فوري + احتمالات مؤكدة — اختبارات حتمية
const hooks = social.__testHooks();
hooks.TIMING.minDelay = 1;
hooks.TIMING.maxDelay = 2;
for (const key of Object.keys(hooks.CHANCES)) hooks.CHANCES[key] = 1.0;

// ---------- إعدادات بالذاكرة (نمط games_player.test.js) ----------

const overrides = new Map();
const origGet = store.getGameSettings;
store.getGameSettings = async (agentId, guildId) => {
    const key = `${String(agentId)}:${String(guildId)}`;
    if (overrides.has(key)) return overrides.get(key);
    return origGet(agentId, guildId);
};

function setSettings(agentId, patch) {
    overrides.set(`${String(agentId)}:${GUILD}`, { ...store.defaultSettings(), ...patch });
}

function makeClient() {
    const sent = [];
    return {
        __selfbotRuntime: true,
        user: { id: AGENT_USER_ID },
        guilds: { cache: new Map([[GUILD, { id: GUILD, name: 'سيرفر الاختبار' }]]) },
        channels: { fetch: async (id) => ({ id, send: async (c) => ({ content: c }) }) },
        __sent: sent,
    };
}

function makeMessage(overridesMsg = {}) {
    return {
        id: overridesMsg.id || `m${Math.random().toString(36).slice(2)}`,
        guild: { id: GUILD, name: 'سيرفر الاختبار' },
        channel: { id: CHANNEL, send: async () => {} },
        author: { id: '1508592252220477651', bot: true },
        content: '',
        embeds: [],
        components: [],
        mentions: { has: () => false },
        ...overridesMsg,
    };
}

/** رسالة بقناة تلتقط الإرسال في client.__sent */
function msgCapturing(client, overridesMsg = {}) {
    return makeMessage({ ...overridesMsg, channel: { id: CHANNEL, send: async (c) => { client.__sent.push(c); return { content: c }; } } });
}

const runtimeSettings = { provider: 'deepseek', providerConfig: {}, kind: 'agent', personality: 'لاعب مرح سريع البديهة' };

/** انتظر اكتمال كلام fire-and-forget */
const settle = (ms = 60) => new Promise(r => setTimeout(r, ms));

async function run() {
    player.agentReady({ client: makeClient(), agentId: AGENT_A, agentName: AGENT_NAME, tokenType: 'user', kind: 'agent' });
    player.agentReady({ client: makeClient(), agentId: AGENT_B, agentName: 'وكيل ب', tokenType: 'user', kind: 'agent' });

    // ═══ 1) صفر كسر: الافتراضي معطل — طرد كامل بلا أي كلمة ═══
    {
        sessions.__reset();
        setSettings(AGENT_A, { enabled: true }); // social.enabled غائب = false افتراضياً
        sessions.startSession(AGENT_A, GUILD, { gameName: 'روليت' });
        const client = makeClient();
        client.channels.fetch = async () => null; // لو أرسل لكان فشل — لكن يجب ألا يحاول
        const kickMsg = makeMessage({ content: `💀 تم طرد <@${AGENT_USER_ID}> من اللعبة!` });
        await player.handleMessage({ client, message: kickMsg, agentId: AGENT_A, runtimeSettings });
        await settle();
        assert.strictEqual(client.__sent.length, 0, 'الافتراضي: صفر إرسال اجتماعي — صفر كسر');
    }

    // ═══ 2) طُرد هو → تعليق بالذكاء عبر خط الأنابيب كاملاً ═══
    {
        sessions.__reset();
        setSettings(AGENT_A, { enabled: true, social: { enabled: true } });
        sessions.startSession(AGENT_A, GUILD, { gameName: 'روليت' });
        const liveSession = sessions.getSession(AGENT_A, GUILD); // تُغلق مع النتيجة — نحتفظ بمرجعها
        const client = makeClient();
        const kickMsg = msgCapturing(client, { content: `💀 تم طرد <@${AGENT_USER_ID}> من اللعبة!` });
        const outcome = await player.handleMessage({ client, message: kickMsg, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(outcome, false, 'رسائل الألعاب لا تُبتلع (suppress معطل)');
        await settle();
        assert.strictEqual(client.__sent.length, 1, 'الطرد أثار تعليقاً واحداً');
        assert.strictEqual(client.__sent[0], 'هههه رد الذكاء الوهمي', 'الكلام جاء من الذكاء (المزود الوهمي)');
        assert.strictEqual(liveSession.socialCount, 1, 'عدّاد الكلام تحرك');
        assert.strictEqual(sessions.getSession(AGENT_A, GUILD), null, 'الجولة انتهت — الجلسة أُغلقت مع النتيجة');
    }

    // ═══ 3) التبريد: لا كلمتين متتاليتين على نفس الجلسة ═══
    {
        sessions.__reset();
        sessions.startSession(AGENT_A, GUILD, { gameName: 'روليت' });
        const liveSession = sessions.getSession(AGENT_A, GUILD);
        const client = makeClient();
        const socialOn = { enabled: true, social: { enabled: true } };
        const outcome = { result: 'loss', kind: 'kick', level: 'warning', reason: 'تم طرد' };
        const base = { client, agentId: AGENT_A, runtimeSettings, agentName: AGENT_NAME, settings: socialOn, session: liveSession };

        await social.observeBotMessage({ ...base, message: msgCapturing(client, { id: 'k1', content: `تم طرد <@${AGENT_USER_ID}>` }), outcome });
        await settle();
        assert.strictEqual(client.__sent.length, 1, 'أول طرد: كلمة واحدة');

        await social.observeBotMessage({ ...base, message: msgCapturing(client, { id: 'k2', content: `تم طرد <@${AGENT_USER_ID}>` }), outcome });
        await settle();
        assert.strictEqual(client.__sent.length, 1, 'التبريد منع الكلام المتتالي');

        liveSession.socialCooldownUntil = 0; // انتهى التبريد اصطناعياً
        await social.observeBotMessage({ ...base, message: msgCapturing(client, { id: 'k3', content: `تم طرد <@${AGENT_USER_ID}>` }), outcome });
        await settle();
        assert.strictEqual(client.__sent.length, 2, 'بعد انتهاء التبريد يعود التعليق');
    }

    // ═══ 4) بلا ذكاء → الجمل الجاهزة العربية ═══
    {
        sessions.__reset();
        sessions.startSession(AGENT_A, GUILD, { gameName: 'روليت' });
        const originalChat = fakeProvider.chat;
        fakeProvider.chat = async () => { throw new Error('provider down'); };
        const client = makeClient();
        const outcome = { result: 'loss', kind: 'kick', level: 'warning', reason: 'تم طرد' };
        await social.observeBotMessage({
            client, message: msgCapturing(client, { content: `تم طرد <@${AGENT_USER_ID}>` }),
            agentId: AGENT_A, runtimeSettings, agentName: AGENT_NAME,
            settings: { enabled: true, social: { enabled: true } }, outcome,
        });
        await settle();
        fakeProvider.chat = originalChat;
        assert.strictEqual(client.__sent.length, 1, 'سقط للجملة الجاهزة');
        assert.ok(hooks.CANNED.kicked.includes(client.__sent[0]), `الجملة من قائمة الطرد — كانت: ${client.__sent[0]}`);
    }

    // ═══ 5) ذكروه بلا منشن → يرد؛ ومنشن مباشر → لا يتدخل ═══
    {
        sessions.__reset();
        setSettings(AGENT_A, { enabled: true, social: { enabled: true } });
        sessions.startSession(AGENT_A, GUILD, { gameName: 'روليت' });
        const client = makeClient();

        // ذكر الاسم نصياً بلا @ → رد اجتماعي
        const nameDrop = msgCapturing(client, {
            author: { id: FRIEND_ID, bot: false, username: 'صديق' },
            content: `يا ${AGENT_NAME} وش رأيكم بهذي الجولة؟`,
        });
        const swallow = await player.handleMessage({ client, message: nameDrop, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(swallow, false, 'رسالة الإنسان تكمل مسارها دائماً');
        await settle();
        assert.strictEqual(client.__sent.length, 1, 'ذكروا اسمه → رد');
        assert.ok(sessions.getSession(AGENT_A, GUILD).friends.has(FRIEND_ID), 'من ذكر اسمه صار صديق الجلسة');

        // منشن مباشر @هو → لا كلام اجتماعي (المحادثة الرئيسية تتكفل به)
        const direct = msgCapturing(client, {
            author: { id: STRANGER_ID, bot: false, username: 'غريب' },
            content: `<@${AGENT_USER_ID}> مرحبا`,
            mentions: { has: (id) => id === AGENT_USER_ID },
        });
        await player.handleMessage({ client, message: direct, agentId: AGENT_A, runtimeSettings });
        await settle();
        assert.strictEqual(client.__sent.length, 1, 'المنشن المباشر لا يمر من الاجتماعي — بلا ازدواج ردود');
        assert.ok(sessions.getSession(AGENT_A, GUILD).friends.has(STRANGER_ID), 'ومع ذلك صار صديقاً');
    }

    // ═══ 6) بلا جلسة لعب حية → صمت كامل ═══
    {
        sessions.__reset();
        setSettings(AGENT_A, { enabled: true, social: { enabled: true } });
        const client = makeClient();
        const nameDrop = msgCapturing(client, {
            author: { id: FRIEND_ID, bot: false, username: 'صديق' },
            content: `يا ${AGENT_NAME}`,
        });
        await player.handleMessage({ client, message: nameDrop, agentId: AGENT_A, runtimeSettings });
        await settle();
        assert.strictEqual(client.__sent.length, 0, 'بلا جلسة: لا كلام حتى لو ذُكر الاسم');
    }

    // ═══ 7) طُرد صديق → مزحة؛ طُرد غربي → صمت ═══
    {
        sessions.__reset();
        setSettings(AGENT_A, { enabled: true, social: { enabled: true } });
        const client = makeClient();

        // الصديق يُسجّل بمنشن مباشر (يضيفه بلا كلام — بلا استهلاك تبريد)
        sessions.startSession(AGENT_A, GUILD, { gameName: 'روليت' });
        const friendMention = msgCapturing(client, {
            author: { id: FRIEND_ID, bot: false, username: 'صديقي' },
            content: `<@${AGENT_USER_ID}> مللنا`,
            mentions: { has: (id) => id === AGENT_USER_ID },
        });
        await player.handleMessage({ client, message: friendMention, agentId: AGENT_A, runtimeSettings });
        assert.strictEqual(client.__sent.length, 0, 'المنشن المباشر لا يُكلم اجتماعياً');
        const session = sessions.getSession(AGENT_A, GUILD);
        session.socialCooldownUntil = 0; // نظّف التبريد من أي أثر سابق

        // طُرد الصديق → مزحة
        const friendKick = msgCapturing(client, { content: `💀 تم طرد <@${FRIEND_ID}> من اللعبة!` });
        await player.handleMessage({ client, message: friendKick, agentId: AGENT_A, runtimeSettings });
        await settle();
        assert.strictEqual(client.__sent.length, 1, 'طُرد صديقي → مزحة');

        // الآن الغربي: جلسة جديدة + طرد غريب → صمت
        sessions.__reset();
        setSettings(AGENT_B, { enabled: true, social: { enabled: true } });
        sessions.startSession(AGENT_B, GUILD, { gameName: 'روليت' });
        const clientB = makeClient();
        const strangerKick = msgCapturing(clientB, { content: `💀 تم طرد <@${FRIEND_ID}> من اللعبة!` });
        await player.handleMessage({ client: clientB, message: strangerKick, agentId: AGENT_B, runtimeSettings });
        await settle();
        assert.strictEqual(clientB.__sent.length, 0, 'طُرد غربي لا يعرفه → صمت');
    }

    // ═══ 8) سقف الجلسة: 6 كلمات ثم صمت ═══
    {
        sessions.__reset();
        sessions.startSession(AGENT_A, GUILD, { gameName: 'روليت' });
        const session = sessions.getSession(AGENT_A, GUILD);
        session.socialCount = 6; // بلغ السقف
        const client = makeClient();
        client.channels.fetch = async (id) => ({ id, send: async (c) => { client.__sent.push(c); return { content: c }; } });
        const outcome = { result: 'loss', kind: 'kick', level: 'warning', reason: 'تم طرد' };
        await social.observeBotMessage({
            client, message: makeMessage({ content: `تم طرد <@${AGENT_USER_ID}>` }),
            agentId: AGENT_A, runtimeSettings, agentName: AGENT_NAME,
            settings: { enabled: true, social: { enabled: true } }, outcome,
        });
        await settle();
        assert.strictEqual(client.__sent.length, 0, 'سقف 6 كلمات للجلسة ثم صمت كلي');
    }

    // ═══ 9) عزل الإعدادات: تفعيل أ لا يجعل ب يتكلم ═══
    {
        sessions.__reset();
        setSettings(AGENT_A, { enabled: true, social: { enabled: true } });
        // ب مفعّل اللعب لكن بلا social
        setSettings(AGENT_B, { enabled: true });
        sessions.startSession(AGENT_B, GUILD, { gameName: 'روليت' });
        const clientB = makeClient();
        clientB.channels.fetch = async (id) => ({ id, send: async (c) => { clientB.__sent.push(c); return { content: c }; } });
        const outcome = { result: 'loss', kind: 'kick', level: 'warning', reason: 'تم طرد' };
        await social.observeBotMessage({
            client: clientB, message: makeMessage({ content: `تم طرد <@${AGENT_USER_ID}>` }),
            agentId: AGENT_B, runtimeSettings, agentName: 'وكيل ب',
            settings: { enabled: true }, outcome, // settings ب الحقيقية: بلا social
        });
        await settle();
        assert.strictEqual(clientB.__sent.length, 0, 'ب بلا social → صمت حتى لو تفعّل أ');
    }

    // ═══ 10) الإعدادات تُحفظ وتُقرأ (store: social.enabled patch) ═══
    {
        overrides.clear(); // إزالة طبقة الاختبارات السابقة — نقرأ من DB الوهمي مباشرة
        // ذاكرة وهمية للمجموعة
        const docs = new Map();
        require.cache[cfgPath].exports.game_players_col = {
            findOne: async ({ agent_id, guild_id }) => docs.get(`${agent_id}:${guild_id}`) || null,
            updateOne: async ({ agent_id, guild_id }, update) => {
                const key = `${agent_id}:${guild_id}`;
                const doc = docs.get(key) || { agent_id, guild_id };
                for (const [k, v] of Object.entries(update.$set || {})) {
                    if (k.startsWith('social.')) {
                        doc.social = doc.social || {};
                        doc.social[k.split('.')[1]] = v;
                    } else {
                        doc[k] = v;
                    }
                }
                docs.set(key, doc);
            },
        };
        store.invalidateAgent(AGENT_A);
        await store.updateGameSettings(AGENT_A, GUILD, { social: { enabled: true } });
        const saved = await store.getGameSettings(AGENT_A, GUILD);
        assert.strictEqual(saved.social.enabled, true, 'social.enabled حُفظ في القاعدة');
        assert.strictEqual(saved.enabled, false, 'المفتاح الرئيسي ما زال الافتراضي — التفاعل وحده لا يشغل اللعب');
    }

    // ═══ تنظيف ═══
    player.agentStop(AGENT_A);
    player.agentStop(AGENT_B);
    overrides.clear();
    sessions.__reset();
    policy.clearLocks();

    console.log('✅ games_social.test.js — كل الفحوصات مرت (10 مجموعات)');
}

run().catch((error) => {
    console.error('❌ games_social.test.js فشل:', error);
    process.exit(1);
});
