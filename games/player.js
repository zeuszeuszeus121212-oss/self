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
const sessions = require('./sessions');
const social = require('./social');
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

// عبارات النتيجة — منقولة من Auto engineRuntime (مع توسيع طُرد/انطرد والفائز)
const WIN_PHRASES = ['فاز باللعبة', 'فاز', 'الفائز'];
const LOSS_PHRASES = ['خسرت', 'خسر', 'تم طرد', 'طُرد', 'انطرد', 'تم قتل']; // 🕰️ تم قتل = موت في المافيا (v7.16)

// 🛰️ بلاغ المالك (v7.15): «جاري البحث عن لاعبين خارجيين للانضمام...» تُسجل كخسارة!
// رسائل اللوبي/البحث ليست نتائج أبداً — مهما ذُكر اسمنا فيها
const LOBBY_MARKERS = [
    'جاري البحث عن لاعبين', 'البحث عن لاعبين', 'انتظار اللاعبين',
    'للانضمام إلى اللعبة', 'للانضمام الي اللعبة', 'انضم الآن',
];

// صيغ شرطية/مستقبلية — «إذا خسرت ستفقد» ليست خسارة! (تُطابق بالسطر)
const HYPOTHETICAL_MARKERS = [
    'يخسر', 'ستخسر', 'اذا خسر', 'إذا خسر', 'لن تخسر',
    'اذا فاز', 'إذا فاز', 'سيفوز', 'يفوز', 'سيطردها', 'سيطرده',
];

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
    sessions.endAllForAgent(id); // 🎮 جلسات اللعب تُغلق كلياً (v7.15)
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

/**
 * أسطر الرسالة مع الحفاظ على الحدود — بخلاف textFromMessage المسطّح،
 * كل حقل/عنوان إيمبد يبدأ سطراً جديداً حتى لا تختلط قائمة اللاعبين
 * بشروط الجائزة في حقل مجاور (سبب الخسائر المزيفة).
 */
function linesFromMessage(message) {
    const lines = [];
    if (message.content) for (const line of String(message.content).split('\n')) lines.push(line);
    if (Array.isArray(message.embeds)) {
        for (const embed of message.embeds) {
            if (embed.title) lines.push(String(embed.title));
            if (embed.description) for (const line of String(embed.description).split('\n')) lines.push(line);
            if (Array.isArray(embed.fields)) {
                for (const field of embed.fields) {
                    if (field.name) lines.push(String(field.name));
                    if (field.value) for (const line of String(field.value).split('\n')) lines.push(line);
                }
            }
            if (embed.footer && embed.footer.text) lines.push(String(embed.footer.text));
            if (embed.author && embed.author.name) lines.push(String(embed.author.name));
        }
    }
    return lines.map(line => line.trim()).filter(Boolean);
}

/** هل منشن الوكيل هو أول منشن يلي العبارة؟ (المطرود/الفائز يُذكر مباشرة بعد العبارة)
 *  تُتخطى علامات الترقيم والفواصل فقط — لا يُتخطى منشن لاعب آخر (تم طرد <غيرنا> ≠ نحن) */
function firstMentionAfterIsMe(line, lower, phraseEnd, identifiers) {
    const after = lower.slice(phraseEnd, phraseEnd + 80);
    // تخطي الفواصل والترقيم فقط (نقاط/نقطتان/شرطة/نجوم...) — التوقف عند أول حرف أو منشن
    const skipped = after.match(/^[^\p{L}\p{N}<]*/u);
    const rest = after.slice(skipped ? skipped[0].length : 0);
    const match = rest.match(/^<@!?(\d+)>/);
    if (!match) return false;
    return identifiers.includes(`<@${match[1]}>`) || identifiers.includes(`<@!${match[1]}>`);
}

/** هل ذُكر معرفنا نصياً قبل العبارة (نافذة 40 حرفاً)؟ — للفوز: «<منشن> فاز باللعبة» */
function identifierBeforePhrase(lower, phraseStart, identifiers) {
    const before = lower.slice(Math.max(0, phraseStart - 40), phraseStart);
    return identifiers.some(id => before.includes(id));
}

/**
 * 🏆 قائمة الفائزين تتضمننا؟ (v7.17 — بلاغ المالك: «يحسب انه البوت الذي فاز
 * وليس هو من فاز») — كانت تتطلب mentionsMe، لكن منشنات الإيمبد لا تدخل
 * message.mentions أصلاً فكانت قوائم الفائزين في الإيمبد تضيع.
 * الآن: نفحص ما بعد العبارة لمنشننا صراحةً (أو معرفنا بحدود أرقام) —
 * بلا اعتماد على mentionsMe إطلاقاً.
 */
function winnersLineIncludesMe(line, lower, phraseEnd, identifiers) {
    const rest = lower.slice(phraseEnd);
    return identifiers.some((id) => {
        if (id.startsWith('<@')) return rest.includes(id); // صيغة منشن حرفية
        // معرف خام — بحدود أرقام حتى لا يطابق جزءاً من معرف أطول
        const re = new RegExp(`(^|\\D)${id}($|\\D)`);
        return re.test(rest);
    });
}

function outcomeFromMessage(message, client) {
    if (!message || !message.author || !message.author.bot) return null;
    if (message.id && processedOutcomeMessages.has(message.id)) return null;

    const rawText = eventsMod.textFromMessage(message);
    if (!rawText) return null;
    const lowerText = rawText.toLowerCase();

    // ① رسائل اللوبي/البحث عن لاعبين ليست نتائج أبداً (بلاغ المالك v7.15)
    if (LOBBY_MARKERS.some(marker => lowerText.includes(marker))) return null;

    // ② بوابة الهوية: الرسالة تخاطبنا أو تذكرنا (منشن حقيقي أو نص)
    const identifiers = playerIdentifiers(client);
    const mentionsMe = Boolean(client?.user?.id)
        && typeof message.mentions?.has === 'function'
        && message.mentions.has(client.user.id);
    if (!mentionsMe && (identifiers.length === 0 || !identifiers.some(identifier => lowerText.includes(identifier)))) return null;

    // ③ فحص سطراً سطراً — النتيجة تعني «الوكيل» في نفس السطر، بلا صيغ شرطية
    for (const line of linesFromMessage(message)) {
        const lower = line.toLowerCase();
        if (HYPOTHETICAL_MARKERS.some(marker => lower.includes(marker))) continue;

        for (const phrase of WIN_PHRASES) {
            let idx = lower.indexOf(phrase);
            while (idx !== -1) {
                const phraseEnd = idx + phrase.length;
                const hit = firstMentionAfterIsMe(line, lower, phraseEnd, identifiers)
                    || identifierBeforePhrase(lower, idx, identifiers)
                    || (mentionsMe && (lower.includes('فزت') || lower.includes('فوزك')))
                    // 🏆 إعلان الفائزين في المافيا (v7.17): قائمة منشنات في نفس
                    // السطر فيها اسمنا تكفي — تعمل حتى لو كانت في إيمبد
                    // (منشنات الإيمبد لا تصل message.mentions — كان يضيع الفوز)
                    || (phrase === 'الفائز' && winnersLineIncludesMe(line, lower, phraseEnd, identifiers));
                if (hit) {
                    rememberProcessedOutcome(message.id);
                    return {
                        result: 'win', kind: 'win', level: 'success',
                        reason: `أُعلن فوزنا فعلاً (عبارة «${phrase}» واسم الوكيل في نفس السطر)`,
                    };
                }
                idx = lower.indexOf(phrase, phraseEnd);
            }
        }

        for (const phrase of LOSS_PHRASES) {
            let idx = lower.indexOf(phrase);
            while (idx !== -1) {
                const phraseEnd = idx + phrase.length;
                // الطرد/القتل: من يُذكر مباشرة بعد العبارة هو المصاب — لا يكفي ذكرنا في السطر
                const hit = firstMentionAfterIsMe(line, lower, phraseEnd, identifiers)
                    || (mentionsMe && (lower.includes('طردك') || lower.includes('طُردك') || lower.includes('قتلك') || lower.includes('خسرت') || lower.includes('خسارتك')));
                if (hit) {
                    const isKick = lower.includes('طرد') || lower.includes('طُرد') || lower.includes('انطرد');
                    const isKilled = lower.includes('قتل');
                    rememberProcessedOutcome(message.id);
                    return {
                        result: 'loss',
                        kind: isKick ? 'kick' : (isKilled ? 'killed' : 'loss'),
                        level: 'warning',
                        // 🧾 v7.17: نص لا لبس فيه — هو من قُتل/طُرد، وليس البوت
                        reason: isKilled ? 'أُعلن قتلنا في المافيا (اسمنا منشن بعد «تم قتل»)'
                            : isKick ? 'أُعلن طردنا من اللعبة (اسمنا منشن بعد العبارة)'
                            : `أُعلنت خسارتنا (عبارة «${phrase}»)`,
                    };
                }
                idx = lower.indexOf(phrase, phraseEnd);
            }
        }
    }
    return null;
}

async function processOutcome({ agentId, client, message, settings }) {
    const outcome = outcomeFromMessage(message, client);
    if (!outcome) return null;
    const guildId = message.guild.id;
    const agentName = (agents.get(String(agentId)) || {}).agentName || String(agentId);

    // 🐞 v7.15: كان clearLocks() يحرر أقفال كل الوكلاء على المنصة —
    // الآن تحرير مُقيّد بأقفال هذا الوكيل وحده
    policy.releaseLocksForAgent(String(agentId));
    sessions.endSession(agentId, guildId); // الجولة انتهت — الجلسة تُغلق
    store.incrementStats(agentId, guildId, outcome.result === 'win' ? 'wins' : 'losses');
    // 🧾 v7.17: نصوص لا لبس فيها — الفائز/المقتول هو الوكيل نفسه وليس البوت
    const resultText = outcome.result === 'win'
        ? `🏆 الوكيل «${agentName}» فاز فعلاً في ${message.guild.name}`
        : outcome.kind === 'killed'
            ? `💀 الوكيل «${agentName}» قُتل في المافيا (${message.guild.name})`
            : outcome.kind === 'kick'
                ? `💀 الوكيل «${agentName}» طُرد من اللعبة (${message.guild.name})`
                : `💀 الوكيل «${agentName}» خسر في ${message.guild.name}`;
    await store.pushRecentEvent(agentId, { kind: 'result', text: `${resultText} — ${outcome.reason}` });
    await store.logGameEvent(agentId, guildId, { type: 'game_result', result: outcome.result, kind: outcome.kind, reason: outcome.reason, message_id: message.id });
    await notifyGameEvent({
        agentId,
        agentName,
        guildId,
        title: outcome.result === 'win' ? '🏆 فوز الوكيل نفسه' : outcome.kind === 'killed' ? '💀 قُتل الوكيل في المافيا' : outcome.kind === 'kick' ? '💀 طُرد الوكيل من اللعبة' : '💀 خسارة الوكيل',
        message: `**«${agentName}»** — ${outcome.reason}`,
        level: outcome.result === 'win' ? 'success' : 'warning',
        extra: { reason: outcome.reason },
    });
    return outcome;
}

// ════════════════════════════════════════════════════════════
//  رسائل الخاص — الرسائل السرية للمافيا فقط (v7.16)
//  بلاغ المالك: «الرسائل تأتي لو كان مافيا او طبيب تكون فقط مرئية
//  للحساب وحده بمعنى مخفيه» — اختيار ضحية/حماية يصل على الخاص من بوت
//  اللعبة نفسه. أي خاص آخر → false فوراً (صفر تدخل في الخاص).
// ════════════════════════════════════════════════════════════

async function handleDmMessage({ client, message, agentId, runtimeSettings }) {
    try {
        if (!message.author || !message.author.bot) return false;
        const mafiaMod = require('./mafia');
        if (!mafiaMod.isSecretMessage(message)) return false;

        // باب سريع: جلسة مافيا حية من نفس البوت؟ وإلا لا شيء
        const found = sessions.findMafiaSessionByBot(agentId, message.author.id);
        if (!found) return false;

        const settings = await store.getGameSettings(agentId, found.guildId);
        if (!settings.enabled || !settings.engines?.mafia?.enabled) return false;

        const agent = agents.get(String(agentId));
        const result = await mafiaMod.handleSecretMessage({
            client, message, agentId,
            runtimeSettings, settings,
            agentName: agent ? agent.agentName : null,
            session: found.session,
            guildId: found.guildId,
        });
        if (!result || !result.handled) return false;

        sessions.touchSession(agentId, found.guildId);
        if (result.silent !== true) {
            store.incrementStats(agentId, found.guildId, 'plays');
            await store.pushRecentEvent(agentId, { kind: 'game_play', text: `🕵️ ${result.message || 'حركة سرية في المافيا'}` });
            await store.logGameEvent(agentId, found.guildId, {
                type: result.type, engine: 'mafia', gameName: 'مافيا',
                result: result.result, details: result.details || {}, dm: true,
            });
            await notifyGameEvent({
                agentId, guildId: found.guildId,
                title: '🕵️ حركة سرية في المافيا (الخاص)',
                message: `**${result.message || ''}**`,
                level: 'info',
                extra: { engine: 'mafia', dm: true, details: result.details || {} },
            });
        }
        return true;
    } catch (_) {
        return false; // أي خطأ في الخاص لا يمس أي مسار
    }
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
        if (!message?.author) return false;
        if (message.author.id === client?.user?.id) return false;

        // 🕵️ رسالة على الخاص — فقط الرسائل السرية للمافيا (v7.16)، وإلا false فوراً
        if (!message.guild) {
            return await handleDmMessage({ client, message, agentId, runtimeSettings });
        }

        const agent = agents.get(String(agentId));
        if (!agent) return false;

        const settings = await store.getGameSettings(agentId, message.guild.id);
        // ⚡ المسار السريع — اللعب معطل: صفر تأثير على السلوك الحالي
        if (!settings.enabled) return false;

        // 💬 رسالة بشرية → مراقبة اجتماعية فقط (v7.15) — لا تغير مسار الرسالة
        // أبداً: المنشن المباشر يبقى للمحادثة الرئيسية، والمراقبة تسجل الكلام
        // وتتبع الأصدقاء وترد محتملاً عند ذكر اسم الوكيل فقط
        if (!message.author.bot) {
            try {
                await social.handleChatMessage({ client, message, agentId, runtimeSettings, agentName: agent.agentName, settings });
            } catch (_) {}
            return false;
        }

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
                        // 🕵️ المافيا (v7.16): الكلام الاجتماعي وقرارات الذكاء يحتاجان هويتهما
                        runtimeSettings,
                        agentName: agent.agentName,
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

                // نجاح — جلسة حية + إحصائيات وسجل وإشعار (النتائج الصامتة كتخطي الدور
                // تبقي الجلسة والقفل بلا إحصائيات ولا إزعاج)
                if (result.type === 'game_join') {
                    sessions.startSession(agentId, guildId, {
                        engineId: event.engineId,
                        channelId: message.channel.id,
                        botId: message.author.id,
                        gameName: event.gameName,
                        guildName: message.guild.name,
                    });
                    // 🕵️ لاعبو لوبي المافيا — «يعرف من يلعب معه بالضبط وكذلك العدد»
                    if (Array.isArray(result.details?.players) && result.details.players.length) {
                        sessions.mafiaSetPlayers(agentId, guildId, result.details.players);
                    }
                    // 🧠 v7.17: «رسالة اللوبي نفسها يتم إرسالها للوكيل» — النص الحقيقي يُخزّن في الجلسة
                    if (result.details?.lobbyText) {
                        sessions.setLobbyText(agentId, guildId, result.details.lobbyText);
                    }
                    const lobbyPlayers = Array.isArray(result.details?.players) ? result.details.players.length : 0;
                    sessions.pushEvent(agentId, guildId, lobbyPlayers
                        ? `دخلنا اللوبي — اللاعبون معي: ${lobbyPlayers}`
                        : 'دخلنا اللوبي');
                } else {
                    sessions.touchSession(agentId, guildId);
                }
                if (result.silent !== true) {
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
                }
                // القفل يبقى حتى نتيجة الجولة (كما في Auto: game_result يحرر)
                break; // رسالة واحدة = معالج واحد
            } catch (_) { /* معالج واحد لا يُسقط البقية */ }
        }

        // 3) كشف نتيجة فوز/خسارة (بغض النظر عن المعالجات) — يرجع النتيجة أو null
        let outcome = null;
        let sessionBeforeOutcome = null;
        try {
            // الجلسة تُلتقط قبل أن تُغلقها النتيجة — تعليق الطرد/الخسارة يحتاج سياقها
            sessionBeforeOutcome = sessions.getSession(agentId, message.guild.id);
            outcome = await processOutcome({ agentId, client, message, settings });
        } catch (_) {}

        // 🫧 التفاعل الاجتماعي — مراقبة رسالة البوت: نتيجتنا (تعليق) أو طرد صديق (مزحة)
        try {
            await social.observeBotMessage({
                client, message, agentId, runtimeSettings, agentName: agent.agentName,
                settings, outcome, session: sessionBeforeOutcome,
            });
        } catch (_) {}

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
                    result = await event.execute(message, client, { agentId, settings, engineSettings, runtimeSettings, agentName: agent.agentName });
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

                sessions.touchSession(agentId, message.guild.id);
                if (result.silent !== true) {
                    handledAny = true;
                    store.incrementStats(agentId, guildId, result.type === 'game_join' ? 'joins' : 'plays');
                    await store.pushRecentEvent(agentId, { kind: result.type, text: `${engines.getEngine(event.engineId)?.icon || '🎮'} ${result.message || event.gameName}` });
                    await store.logGameEvent(agentId, guildId, {
                        type: result.type, engine: event.engineId, gameName: result.gameName,
                        result: result.result, details: result.details || {},
                        message_id: message.id, bot_id: message.author.id,
                    });
                }
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
    // 🧠 v7.17: سياق «أنا ألعب الآن» للمحادثة الرئيسية — يستعمله agentRuntime
    buildLiveGameContext: ({ agentId, guildId }) => {
        try { return sessions.buildLiveGameContext({ agentId, guildId }); } catch (_) { return null; }
    },
    // لأغراض الاختبار
    __internals: {
        agents, zarLoops, processedOutcomeMessages,
        cleanAiAnswer, outcomeFromMessage, answerWithAi,
        linesFromMessage, winnersLineIncludesMe,
    },
};
