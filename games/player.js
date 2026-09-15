/**
 * games/player.js — محرك لعب الوكلاء (v7.14)
 * ═══════════════════════════════════════════════════════════
 * نقل مفهوم engineRuntime من مستودع Auto إلى بنية المنصة:
 * في Auto كل حساب يستلم عميل selfbot خاص به. هنا العميل مشترك
 * (عميل الوكيل نفسه) فتُلحق أحداث اللعب بخط أنابيب منفصل تماماً
 * عن مسار المحادثة — والافتراضي معطل كلياً (صفر كسر).
 *
 * خط الأنابيب لكل رسالة بوت (فقط عندما تفعيل اللعب صريح):
 *   بوابات الإعدادات ← فلتر بوتات/سيرفرات السياسة ← قفل التداخل ←
 *   مطابقة معالجات الأحداث ← الضغط الفعلي ← إحصائيات وسجل وإشعار ←
 *   كشف فوز/خسارة الحساب (نفس عبارات Auto) ← تحرير الأقفال
 *
 * حلقة زر التلقائية (zar): إرسال الأمر عند البدء + إعادة الإرسال عند
 * رسالة «فاز باللعبة» — لكن بلا مستمعات متشعبة على العميل المشترك:
 * إعادة الإرسال تُدار من هذا الخط مباشرة.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const engines = require('./engines');
const policy = require('./policy');
const store = require('./store');
const eventsMod = require('./events');
const { getProviderOrFallback } = require('../providers');

// هوية الوكلاء الحية — يملؤها agentReady
const agents = new Map(); // agentId → { client, tokenType, agentName, kind }

// حلقة زر الجارية: `${agentId}:${guildId}` → { channelId, command, sentAt }
const zarLoops = new Map();

// مؤقت التأخير المعلّق لكل حلقة (منع تكدس إعادة الإرسال)
const zarResendTimers = new Map();

// منع معالجة نفس رسالة النتيجة مرتين (نمط Auto processedOutcomeMessages)
const processedOutcomeMessages = new Set();
const MAX_PROCESSED_OUTCOME = 1000;

// عبارات النتيجة — منقولة حرفياً من Auto engineRuntime
const WIN_PHRASES = ['فاز باللعبة', 'فاز'];
const LOSS_PHRASES = ['خسرت', 'خسر', 'تم طرد'];

// 🕶️ المُخبِر — يُحقن من bot.js مثل guildRegistry/qwenAccounts
let notifier = null;
function setNotifier(fn) { notifier = typeof fn === 'function' ? fn : null; }

async function notifyGameEvent(event) {
    if (!notifier) return false;
    try {
        return await notifier({
            type: 'game_player',
            agentId: event.agentId || null,
            title: event.title || '🎮 حدث لعب',
            message: event.message || '',
            level: event.level || 'info',
            guildId: event.guildId || null,
            extra: event.extra || {},
        });
    } catch (_) { return false; }
}

function rememberProcessedOutcome(messageId) {
    if (!messageId) return;
    processedOutcomeMessages.add(messageId);
    if (processedOutcomeMessages.size > MAX_PROCESSED_OUTCOME) {
        const oldest = processedOutcomeMessages.values().next().value;
        processedOutcomeMessages.delete(oldest);
    }
}

// ════════════════════════════════════════════════════════════
//  تسجيل الوكلاء + دورة الحياة
// ════════════════════════════════════════════════════════════

/** يُستدعى من agentRuntime ready — تسجيل + إطلاق حلقات زر المفعّلة */
async function agentReady({ client, agentId, agentName, tokenType, kind }) {
    agents.set(String(agentId), { client, tokenType, agentName: agentName || String(agentId), kind: kind || null });
    // حلقات زر تُطلق فقط لحسابات المستخدم (clickButton غير موجود في عملاء البوتات)
    if (tokenType === 'user' && client?.guilds?.cache) {
        for (const [guildId] of client.guilds.cache) {
            try { await maybeStartZarLoop(agentId, client, guildId, { announce: false }); } catch (_) {}
        }
    }
}

/** يُستدعى من stop() — تنظيف كامل بلا أثر */
function agentStop(agentId) {
    const id = String(agentId);
    agents.delete(id);
    for (const key of [...zarLoops.keys()]) if (key.startsWith(`${id}:`)) zarLoops.delete(key);
    for (const key of [...zarResendTimers.keys()]) {
        if (key.startsWith(`${id}:`)) { clearTimeout(zarResendTimers.get(key)); zarResendTimers.delete(key); }
    }
    policy.releaseLocksForAgent(id);
    store.invalidateAgent(id);
    store.resetSessionStats(id);
}

/** يُستدعى من اللوحة بعد تغيير إعدادات — إعادة مزامنة حلقات زر الوكيل */
async function refreshAgentLoops(agentId) {
    const agent = agents.get(String(agentId));
    if (!agent || agent.tokenType !== 'user' || !agent.client?.guilds?.cache) return;
    for (const [guildId] of agent.client.guilds.cache) {
        try {
            const settings = await store.getGameSettings(agentId, guildId);
            const key = `${String(agentId)}:${String(guildId)}`;
            const loop = zarLoops.get(key);
            const shouldRun = settings.enabled && settings.engines?.zar?.enabled && settings.channel_id;
            if (shouldRun && (!loop || loop.channelId !== settings.channel_id || loop.command !== settings.zar_command)) {
                await maybeStartZarLoop(agentId, agent.client, guildId, { announce: Boolean(loop) });
            } else if (!shouldRun && loop) {
                zarLoops.delete(key);
                const timer = zarResendTimers.get(key);
                if (timer) { clearTimeout(timer); zarResendTimers.delete(key); }
                await store.pushRecentEvent(agentId, { kind: 'loop', text: `⏹️ أُوقفت حلقة زر في ${guildId}` });
            }
        } catch (_) {}
    }
}

// ════════════════════════════════════════════════════════════
//  حلقة زر التلقائية — المنقولة من Zar/events/zarStart.js
// ════════════════════════════════════════════════════════════

async function maybeStartZarLoop(agentId, client, guildId, { announce = false } = {}) {
    const settings = await store.getGameSettings(agentId, guildId);
    if (!settings.enabled || !settings.engines?.zar?.enabled || !settings.channel_id) return false;

    const channel = await client.channels?.fetch?.(settings.channel_id).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return false;

    const key = `${String(agentId)}:${String(guildId)}`;
    const command = settings.zar_command || '-روليت';

    // تأخير المحرك (نمط Auto: settings.delay بالثواني)
    const delaySec = Number(settings.engines?.zar?.delay || 0);
    const send = async () => {
        await channel.send(command).catch(() => {});
        zarLoops.set(key, { channelId: settings.channel_id, command, sentAt: Date.now(), guildId: String(guildId) });
        store.incrementStats(agentId, guildId, 'plays');
        await store.pushRecentEvent(agentId, { kind: 'zar', text: `🎰 أُرسل أمر الدورة «${command}» في <#${settings.channel_id}>` });
        await store.logGameEvent(agentId, guildId, { type: 'game_join', gameName: 'زر', result: 'loop_start', channel_id: settings.channel_id, command });
        if (announce) {
            await notifyGameEvent({ agentId, guildId, title: '🎰 حلقة زر بدأت', message: `أُرسل «${command}» في <#${settings.channel_id}>`, level: 'info' });
        }
    };

    if (delaySec > 0) setTimeout(() => { send().catch(() => {}); }, Math.min(delaySec, 60) * 1000);
    else await send();
    return true;
}

/** إعادة إرسال أمر زر عند رسالة فوز — بديل المستمع المتشعب في Auto */
async function handleZarWinResend({ agentId, client, message, settings }) {
    const key = `${String(agentId)}:${String(message.guild.id)}`;
    const loop = zarLoops.get(key);
    if (!loop) return false;
    if (message.channel.id !== loop.channelId) return false;
    if (!message.content || !message.content.includes('فاز باللعبة')) return false;

    // منع تكدس المؤقتات — إعادة إرسال واحدة لكل رسالة فوز
    if (zarResendTimers.has(key)) return true;
    const timer = setTimeout(async () => {
        zarResendTimers.delete(key);
        try {
            const channel = await client.channels?.fetch?.(loop.channelId).catch(() => null);
            if (channel && typeof channel.send === 'function') {
                await channel.send(loop.command);
                store.incrementStats(agentId, message.guild.id, 'plays');
                await store.pushRecentEvent(agentId, { kind: 'zar', text: `🔄 أُعيد إرسال «${loop.command}» بعد فوز` });
            }
        } catch (_) {}
    }, 1500);
    zarResendTimers.set(key, timer);
    return true;
}

// ════════════════════════════════════════════════════════════
//  الإجابة الذكية لريبلكا — قبل القاموس (إن سمح الإعداد ai_answers)
// ════════════════════════════════════════════════════════════

function cleanAiAnswer(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const firstLine = text.split('\n').map(line => line.trim()).filter(Boolean)[0] || '';
    const word = firstLine
        .replace(/[*_`~#>-]/g, '')
        .replace(/[.،,;!؟?]+$/g, '')
        .trim();
    if (!word || word.length > 30 || word === 'لا يوجد') return null;
    return word;
}

async function answerWithAi(runtimeSettings, { category, letter }) {
    try {
        const providerObj = getProviderOrFallback(runtimeSettings?.provider);
        if (!providerObj || typeof providerObj.chat !== 'function') return null;
        const prompt =
            `أنت لاعب خبير في لعبة ريبلكا العربية. السؤال: أعطني كلمة واحدة من فئة «${category}» تبدأ بالحرف «${letter}».\n` +
            'أجب بالكلمة العربية وحدها فقط — بدون شرح وبدون علامات ترقيم وبدون أي كلام آخر.';
        const result = await Promise.race([
            providerObj.chat({ prompt, config: runtimeSettings.providerConfig }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ai_timeout')), 7000)),
        ]);
        return cleanAiAnswer(result && (result.fullText || result.reply || result.text));
    } catch (_) {
        return null; // أي فشل → القاموس يتولى (دائماً)
    }
}

// ════════════════════════════════════════════════════════════
//  كشف نتيجة الحساب (فوز/خسارة) — المنقول من engineRuntime outcome
// ════════════════════════════════════════════════════════════

function playerIdentifiers(client) {
    const id = client?.user?.id;
    return [id ? `<@${id}>` : null, id ? `<@!${id}>` : null, id ? String(id) : null]
        .filter(Boolean).map(item => item.toLowerCase());
}

function outcomeFromMessage(message, client, policyDoc) {
    if (!message || !message.author || !message.author.bot) return null;
    if (message.id && processedOutcomeMessages.has(message.id)) return null;

    const text = eventsMod.textFromMessage(message).toLowerCase();
    if (!text) return null;

    // الفلتر: البوتات المسموحة للنتائج — نمرر أي محرك يعمل (تقريب عملي لنمط Auto)
    const identifiers = playerIdentifiers(client);
    if (identifiers.length === 0 || !identifiers.some(identifier => text.includes(identifier))) return null;

    const winPhrase = WIN_PHRASES.find(phrase => text.includes(phrase));
    if (winPhrase) {
        rememberProcessedOutcome(message.id);
        return { result: 'win', level: 'success', reason: `رسالة بوت تحتوي: ${winPhrase}` };
    }

    const lossPhrase = LOSS_PHRASES.find(phrase => text.includes(phrase));
    if (lossPhrase) {
        rememberProcessedOutcome(message.id);
        return { result: 'loss', level: 'warning', reason: `رسالة بوت تحتوي: ${lossPhrase}` };
    }
    return null;
}

async function processOutcome({ agentId, client, message, settings }) {
    const outcome = outcomeFromMessage(message, client);
    if (!outcome) return false;
    const guildId = message.guild.id;

    policy.clearLocks(); // نهاية جولة = تحرير أقفال هذا الوكيل (بساطة آمنة: الأقفال للجولات القصيرة)
    store.incrementStats(agentId, guildId, outcome.result === 'win' ? 'wins' : 'losses');
    await store.pushRecentEvent(agentId, {
        kind: 'result',
        text: outcome.result === 'win'
            ? `🏆 فوز في ${message.guild.name} — ${outcome.reason}`
            : `💀 خسارة في ${message.guild.name} — ${outcome.reason}`,
    });
    await store.logGameEvent(agentId, guildId, { type: 'game_result', result: outcome.result, reason: outcome.reason, message_id: message.id });
    await notifyGameEvent({
        agentId,
        guildId,
        title: outcome.result === 'win' ? '🏆 فوز في لعبة' : '💀 خسارة في لعبة',
        message: `**${store.statsFor(agentId, guildId).wins} فوز / ${store.statsFor(agentId, guildId).losses} خسارة** هذه الجلسة`,
        level: outcome.result === 'win' ? 'success' : 'warning',
        extra: { reason: outcome.reason },
    });
    return true;
}

// ════════════════════════════════════════════════════════════
//  خط الأنابيب الرئيسي
// ════════════════════════════════════════════════════════════

/**
 * معالجة رسالة (messageCreate) — تُستدعى من agentRuntime بعد maybeScheduledEvent.
 * @returns {boolean} true فقط عندما suppress_ai مفعّل وتمت معالجة رسالة لعبة —
 *                    عندها يتخطى مسار المحادثة الرسالة. الافتراضي false دائماً.
 */
async function handleMessage({ client, message, agentId, runtimeSettings }) {
    try {
        if (!message?.guild || !message.author) return false;
        if (!message.author.bot) return false; // رسائل الألعاب من بوتات فقط
        if (message.author.id === client?.user?.id) return false;
        const agent = agents.get(String(agentId));
        if (!agent) return false;

        const settings = await store.getGameSettings(agentId, message.guild.id);
        // ⚡ المسار السريع — اللعب معطل: صفر تأثير على السلوك الحالي
        if (!settings.enabled) return false;

        const guildId = message.guild.id;
        let handledAny = false;

        // 1) إعادة إرسال زر عند فوز (حلقة zar)
        try { await handleZarWinResend({ agentId, client, message, settings }); } catch (_) {}

        // 2) مطابقة معالجات messageCreate
        const activeEvents = eventsMod.eventsForTrigger('messageCreate');
        for (const event of activeEvents) {
            try {
                const engineSettings = settings.engines?.[event.engineId];
                if (!engineSettings?.enabled) continue;
                if (event.premium && !engineSettings.premium_join) continue;

                // بوابة السياسة: البوت مسموح لهذا المحرك؟
                const policyDoc = await policy.getPolicy();
                if (!policy.isBotAllowed(policyDoc, event.engineId, message.author.id)) continue;
                // بوابة السياسة: السيرفر مسموح؟
                if (!policy.isServerAllowed(policyDoc, null, event.engineId, message.guild.id)) continue;

                // قفل التداخل (نمط Auto): لا حسابان يلعبان نفس اللعبة بنفس السيرفر
                const lock = policy.acquireLock({
                    policy: policyDoc,
                    engineId: event.engineId,
                    serverId: message.guild.id,
                    gameName: event.gameName,
                    agentId: String(agentId),
                    agentName: agent.agentName,
                });
                if (!lock.acquired) continue;

                let result;
                try {
                    result = await event.execute(message, client, {
                        agentId,
                        settings,
                        engineSettings,
                        answerWithAi: (q) => answerWithAi(runtimeSettings, q),
                    });
                } catch (eventError) {
                    store.incrementStats(agentId, guildId, 'errors');
                    policy.releaseLock(lock.key, String(agentId));
                    await store.logGameEvent(agentId, guildId, { type: 'error', engine: event.engineId, error: eventError?.message || String(eventError) });
                    continue;
                }

                if (!result || result.handled === false) {
                    if (lock.key) policy.releaseLock(lock.key, String(agentId));
                    continue;
                }

                // نجاح — إحصائيات وسجل وإشعار
                handledAny = true;
                store.incrementStats(agentId, guildId, result.type === 'game_join' ? 'joins' : 'plays');
                await store.pushRecentEvent(agentId, { kind: result.type, text: `${engines.getEngine(event.engineId)?.icon || '🎮'} ${result.message || event.gameName}` });
                await store.logGameEvent(agentId, guildId, {
                    type: result.type, engine: event.engineId, gameName: result.gameName,
                    result: result.result, details: result.details || {},
                    message_id: message.id, bot_id: message.author.id,
                });
                await notifyGameEvent({
                    agentId, guildId,
                    title: result.type === 'game_join' ? '🎮 انضمام للعبة' : '🎮 حركة لعب',
                    message: `**${result.gameName}** — ${result.message || ''}`,
                    level: 'info',
                    extra: { engine: event.engineId, bot_id: message.author.id },
                });
                // القفل يبقى حتى نتيجة الجولة (كما في Auto: game_result يحرر)
                break; // رسالة واحدة = معالج واحد
            } catch (_) { /* معالج واحد لا يُسقط البقية */ }
        }

        // 3) كشف نتيجة فوز/خسارة (بغض النظر عن المعالجات)
        try { await processOutcome({ agentId, client, message, settings }); } catch (_) {}

        return handledAny && settings.suppress_ai === true;
    } catch (_) {
        return false; // أي خطأ: الرسالة تكمل مسارها الطبيعي — لا كسر أبداً
    }
}

/**
 * معالجة تحديث رسالة (messageUpdate) — أحداث اللعب في Auto تعتمد عليها
 * (زر الأخضر يظهر بتحديث الرسالة وليس بإنشائها).
 */
async function handleMessageUpdate({ client, message, agentId, runtimeSettings }) {
    try {
        if (!message?.guild || !message.author) return false;
        if (!message.author.bot) return false;
        if (message.author.id === client?.user?.id) return false;
        const agent = agents.get(String(agentId));
        if (!agent) return false;

        const settings = await store.getGameSettings(agentId, message.guild.id);
        if (!settings.enabled) return false;

        const guildId = message.guild.id;
        let handledAny = false;

        const activeEvents = eventsMod.eventsForTrigger('messageUpdate');
        for (const event of activeEvents) {
            try {
                const engineSettings = settings.engines?.[event.engineId];
                if (!engineSettings?.enabled) continue;

                const policyDoc = await policy.getPolicy();
                if (!policy.isBotAllowed(policyDoc, event.engineId, message.author.id)) continue;
                if (!policy.isServerAllowed(policyDoc, null, event.engineId, message.guild.id)) continue;

                const lock = policy.acquireLock({
                    policy: policyDoc,
                    engineId: event.engineId,
                    serverId: message.guild.id,
                    gameName: event.gameName,
                    agentId: String(agentId),
                    agentName: agent.agentName,
                });
                if (!lock.acquired) continue;

                let result;
                try {
                    result = await event.execute(message, client, { agentId, settings, engineSettings });
                } catch (eventError) {
                    store.incrementStats(agentId, guildId, 'errors');
                    policy.releaseLock(lock.key, String(agentId));
                    await store.logGameEvent(agentId, guildId, { type: 'error', engine: event.engineId, error: eventError?.message || String(eventError) });
                    continue;
                }

                if (!result || result.handled === false) {
                    if (lock.key) policy.releaseLock(lock.key, String(agentId));
                    continue;
                }

                handledAny = true;
                store.incrementStats(agentId, guildId, result.type === 'game_join' ? 'joins' : 'plays');
                await store.pushRecentEvent(agentId, { kind: result.type, text: `${engines.getEngine(event.engineId)?.icon || '🎮'} ${result.message || event.gameName}` });
                await store.logGameEvent(agentId, guildId, {
                    type: result.type, engine: event.engineId, gameName: result.gameName,
                    result: result.result, details: result.details || {},
                    message_id: message.id, bot_id: message.author.id,
                });
                break;
            } catch (_) { /* معالج واحد لا يُسقط البقية */ }
        }

        return handledAny && settings.suppress_ai === true;
    } catch (_) {
        return false;
    }
}

/** هل يستطيع هذا الوكيل الضغط على الأزرار؟ (حسابات المستخدم فقط) */
function canClickButtons(agentId) {
    const agent = agents.get(String(agentId));
    return Boolean(agent && agent.tokenType === 'user' && agent.client?.__selfbotRuntime);
}

function getAgentInfo(agentId) {
    const agent = agents.get(String(agentId));
    return agent ? { agentId: String(agentId), tokenType: agent.tokenType, agentName: agent.agentName, kind: agent.kind, connected: true } : null;
}

function getZarLoops(agentId) {
    const out = [];
    for (const [key, loop] of zarLoops.entries()) {
        if (key.startsWith(`${String(agentId)}:`)) out.push({ guildId: loop.guildId, ...loop });
    }
    return out;
}

module.exports = {
    setNotifier,
    agentReady,
    agentStop,
    refreshAgentLoops,
    handleMessage,
    handleMessageUpdate,
    canClickButtons,
    getAgentInfo,
    getZarLoops,
    // لأغراض الاختبار
    __internals: {
        agents, zarLoops, processedOutcomeMessages,
        cleanAiAnswer, outcomeFromMessage, answerWithAi,
    },
};
