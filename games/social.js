/**
 * games/social.js — التفاعل الاجتماعي أثناء اللعب (v7.15)
 * ═══════════════════════════════════════════════════════════
 * «يكون شخص حقيقي يلعب» — بطلب المالك:
 *   - يراقب الشات: لو تكلموا عنه (ذكر اسمه بلا منشن) يرد
 *   - عند طرده: يعقب على الطرد (سؤال المسبب: لماذا؟)
 *   - عند فوزه/خسارته: كلمة قصيرة
 *   - لو طُرد «صديق» (كلّمه أو ذكر اسمه بالجلسة): يمزح
 *   - وليس دائماً يتكلم: احتمالات + تبريد + سقف للجلسة
 *     — «ان لم يتكلم شخص لا اتكلم انا» (الكلام التلقائي محصور
 *       بذِكر اسمه، والأحداث وحدها تكسر الصمت)
 *
 * حدود الأمان (صفر كسر):
 *   - الافتراضي معطل كلياً: settings.social.enabled === false → صفر إرسال
 *   - لا يعمل إلا داخل جلسة لعب حية (sessions.js)
 *   - المنشن المباشر @هو لا يُلتقط هنا — مسار المحادثة الرئيسي يتكفل
 *     به كما اليوم (بلا ردود مزدوجة أبداً)
 *   - كل شيء fire-and-forget: فشل الذكاء أو الإرسال لا يمس أي مسار
 *   - بلا ذكاء: جمل احتياطية عربية جاهزة (نفس فلسفة قاموس ريبلكا)
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const sessions = require('./sessions');
const store = require('./store');
const { getProviderOrFallback } = require('../providers');

// 🎲 احتمالات الكلام — «ليس دائماً يتكلم»
const CHANCES = {
    kicked       : 0.90, // طرده هو — يكاد دائماً يعقب
    win          : 0.60,
    loss         : 0.70,
    friend_kicked: 0.50, // طُرد صديق — يمزح أحياناً
    name_drop    : 0.85, // ذكروا اسمه — يرد غالباً
};

// ⏳ التبريد والسقوف — بلا إزعاج
const SESSION_MAX_SOCIAL = 6;        // أقصى كلام في الجلسة الواحدة
const COOLDOWN_BASE_MS   = 60_000;   // بين كل كلمة وكلمة: دقيقة + عشوائية
const COOLDOWN_JITTER_MS = 60_000;
const USER_REPLY_COOLDOWN = 45_000;  // لا يزعج نفس الشخص كل ثانية

const AI_TIMEOUT_MS = 8000;
const MAX_LEN = 140;

// ⏱️ التأخير البشري قبل الكلام — قابل للضبط من الاختبارات فقط
const TIMING = { minDelay: 600, maxDelay: 1500 };

// 💬 جمل احتياطية — عندما يفشل الذكاء (أو بلا مزود)
const CANNED = {
    kicked: [
        'ليش طردتوني أنا 😭',
        'إيه هالظلم والا كيف',
        'طيب خلاص، الجاية أنا أول من يطردكم',
        'أول مرة ألعب معكم وأطلع مظلوم',
    ],
    win: [
        'أخيراً 🏆',
        'سهلة هذي اللعبة والله',
        'الجمهور كان حاضر 😎',
    ],
    loss: [
        'المرة الجاية أحدهم',
        'حظ أوفر 😅',
        'قربت من الفوز بس',
    ],
    friend_kicked: [
        'ههههه لا يهمك، الجاية الثأر لك',
        'أنجزمت عليه والله 😂',
        'اجتمعوا على واحد بس 😂',
    ],
    name_drop: [
        'سجلت اسمي؟ 😄',
        'أنا مشغول ألعب، وش عندكم؟',
        'قلتوا شيء عني؟',
        'أنا موجود لا تشيلون هم',
    ],
};

function pick(list) {
    return list[Math.floor(Math.random() * list.length)] || null;
}

function chance(p) {
    return Math.random() < p;
}

// ════════════════════════════════════════════════════════════
//  بوابة موحدة — كل شيء يمر من هنا
// ════════════════════════════════════════════════════════════

function socialEnabled(settings) {
    return Boolean(settings && settings.enabled && settings.social && settings.social.enabled);
}

function canSpeak(session, { userId = null } = {}) {
    if (!session) return false;
    if (session.socialCount >= SESSION_MAX_SOCIAL) return false;
    if (Date.now() < (session.socialCooldownUntil || 0)) return false;
    if (userId) {
        const last = session.lastMentionReply.get(String(userId)) || 0;
        if (Date.now() - last < USER_REPLY_COOLDOWN) return false;
    }
    return true;
}

function reserve(session, { userId = null } = {}) {
    session.socialCount += 1;
    session.socialCooldownUntil = Date.now() + COOLDOWN_BASE_MS + Math.floor(Math.random() * COOLDOWN_JITTER_MS);
    if (userId) session.lastMentionReply.set(String(userId), Date.now());
}

// ════════════════════════════════════════════════════════════
//  توليد الكلام — ذكاء أولاً ثم الجمل الجاهزة
// ════════════════════════════════════════════════════════════

function cleanComment(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    const firstLine = text.split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
    const clean = firstLine
        .replace(/[*_`~#]/g, '')
        .replace(/^\d+[.)]\s*/, '')
        .trim()
        .slice(0, MAX_LEN);
    if (!clean) return null;
    if (/ذكاء اصطناعي|robot|نموذج لغوي/i.test(clean)) return null; // انحراف الشخصية → جملة جاهزة
    return clean;
}

async function aiComment(runtimeSettings, { agentName, eventLine, session }) {
    try {
        const providerObj = getProviderOrFallback(runtimeSettings?.provider);
        if (!providerObj || typeof providerObj.chat !== 'function') return null;
        const personality = String(runtimeSettings?.personality || '').trim().slice(0, 300);
        const prompt =
            `أنت تلعب لعبة ديسكورد باسم «${agentName}» داخل قناة عربية.\n` +
            (personality ? `شخصيتك: ${personality}\n` : 'أسلوبك: لاعب ودود عفوي.\n') +
            `\nما حدث الآن: ${eventLine}\n` +
            `سياق القناة:\n${sessions.contextSummary(session) || '- لا كلام بعد'}\n\n` +
            'اكتب سطراً واحداً قصيراً جداً (3 إلى 12 كلمة) تقوله في الشات الآن: عامي عربي طبيعي يناسب الموقف.\n' +
            'قواعد صارمة: سطر واحد فقط، بلا markdown، بلا قوائم، بلا ذكر أنك بوت أو ذكاء اصطناعي.';
        const result = await Promise.race([
            providerObj.chat({ prompt, config: runtimeSettings?.providerConfig }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ai_timeout')), AI_TIMEOUT_MS)),
        ]);
        return cleanComment(result && (result.fullText || result.reply || result.text));
    } catch (_) {
        return null; // أي فشل → الجمل الجاهزة (دائماً)
    }
}

/** الإرسال الفعلي — fire-and-forget بلا أي تأثير على خط الأنابيب */
async function speak({ client, channel, agentId, guildId, kind, eventLine, runtimeSettings, agentName, session, mentionLabel = null }) {
    let text = await aiComment(runtimeSettings, {
        agentName,
        eventLine: mentionLabel ? `${eventLine} (${mentionLabel})` : eventLine,
        session,
    });
    if (!text) text = pick(CANNED[kind] || CANNED.loss);
    if (!text) return false;
    // تأخير بشري صغير قبل الكلام — لا ردود خاطفة آلية
    await new Promise(r => setTimeout(r, TIMING.minDelay + Math.floor(Math.random() * (TIMING.maxDelay - TIMING.minDelay))));
    try {
        await channel.send(text.slice(0, MAX_LEN));
    } catch (_) {
        return false;
    }
    store.incrementStats(agentId, guildId, 'plays');
    await store.pushRecentEvent(agentId, { kind: 'social', text: `🫧 تعليق اجتماعي (${kind}): ${text.slice(0, 60)}` });
    await store.logGameEvent(agentId, guildId, { type: 'social_comment', social_kind: kind, text });
    return true;
}

/** قرار + حجز التبريد قبل التوليد (يمنع تكرار الكلام المتزامن) */
function maybeSpeak(ctx) {
    const { settings, session, kind, userId = null, probability } = ctx;
    if (!socialEnabled(settings)) return false;
    if (!canSpeak(session, { userId })) return false;
    if (!chance(probability)) return false;
    reserve(session, { userId });
    void speak(ctx).catch(() => {}); // fire-and-forget — لا يمنع ولا يُسقط شيئاً
    return true;
}

// ════════════════════════════════════════════════════════════
//  النقاط العامة — تُستدعى من player.js فقط
// ════════════════════════════════════════════════════════════

/**
 * رسالة بشرية في القناة — مراقبة فقط:
 * تسجيل الكلام + تتبع الأصدقاء + رد محتمل على ذكر الاسم (بلا منشن).
 * ترجع false دائماً — رسالة الإنسان تكمل مسارها الطبيعي أبداً.
 */
async function handleChatMessage({ client, message, agentId, runtimeSettings, agentName, settings }) {
    try {
        if (!message?.guild || !message.author || message.author.bot) return false;
        if (message.author.id === client?.user?.id) return false;
        if (!socialEnabled(settings)) return false;

        const guildId = message.guild.id;
        const session = sessions.touchSession(agentId, guildId);
        if (!session) return false; // بلا جلسة لعب حية — صفر تدخل

        const name = message.member?.displayName || message.author.username || 'لاعب';
        sessions.pushChatLine(agentId, guildId, { name, text: message.content });

        // المنشن المباشر @هو → مسار المحادثة الرئيسي (كما اليوم) — لكنه صديق
        const isDirectMention = typeof message.mentions?.has === 'function' && message.mentions.has(client?.user?.id);
        if (isDirectMention) {
            sessions.addFriend(agentId, guildId, message.author.id);
            return false;
        }

        // ذكر الاسم بلا منشن → ذكرته عنه → يرد غالباً
        const cleanName = String(agentName || '').trim();
        if (cleanName.length >= 3 && message.content && message.content.toLowerCase().includes(cleanName.toLowerCase())) {
            sessions.addFriend(agentId, guildId, message.author.id);
            maybeSpeak({
                settings, session, kind: 'name_drop', userId: message.author.id,
                probability: CHANCES.name_drop,
                client, channel: message.channel, agentId, guildId,
                eventLine: `لاعب اسمه «${name}» ذكر اسمك «${cleanName}» في الشات`,
                runtimeSettings, agentName, session,
            });
        }
        return false;
    } catch (_) {
        return false;
    }
}

const KICK_LINE = /تم\s*طرد|طُرد|انطرد|انطرح/;

/**
 * رسالة بوت لعب — مراقبة النتائج الاجتماعية:
 *  - نتيجة الوكيل نفسه (فوز/خسارة/طرد) → تعليق محتمل
 *  - طرد «صديق» من الجلسة → مزحة محتملة
 * تُستدعى فقط عندما اللعب مفعّل — والافتراضي (social.enabled=false) صفر إرسال.
 * @param {object|null} session جلسة مُلتقطة مسبقاً (قبل أن تغلقها النتيجة) —
 *                              تعليق الطرد يحدث بعد إغلاق الجلسة فيجب تمريرها
 */
async function observeBotMessage({ client, message, agentId, runtimeSettings, agentName, settings, outcome = null, session = null }) {
    try {
        if (!message?.guild || !message.author || !message.author.bot) return false;
        if (message.author.id === client?.user?.id) return false;
        if (!socialEnabled(settings)) return false;

        const guildId = message.guild.id;
        session = session || sessions.touchSession(agentId, guildId);
        if (!session) return false;

        const lines = String(message.content || '').split('\n').map(l => l.trim()).filter(Boolean);
        // 1) طرد شخص آخر — هل هو صديق؟
        for (const line of lines) {
            if (!KICK_LINE.test(line)) continue;
            const mentionMatch = line.match(/<@!?(\d+)>/);
            const kickedId = mentionMatch ? mentionMatch[1] : null;
            if (kickedId) sessions.addKicked(agentId, guildId, kickedId);
            if (kickedId && outcome === null && session.friends.has(kickedId)) {
                maybeSpeak({
                    settings, session, kind: 'friend_kicked',
                    probability: CHANCES.friend_kicked,
                    client, channel: message.channel, agentId, guildId,
                    eventLine: 'طردوا صديقاً لك من اللعبة',
                    mentionLabel: kickedId ? `<@${kickedId}>` : null,
                    runtimeSettings, agentName, session,
                });
                return true;
            }
        }

        // 2) نتيجة الوكيل نفسه — التعليق
        if (outcome && outcome.result) {
            const kind = outcome.kind === 'kick' ? 'kicked'
                : outcome.result === 'win' ? 'win' : 'loss';
            const probability = kind === 'kicked' ? CHANCES.kicked
                : kind === 'win' ? CHANCES.win : CHANCES.loss;
            const eventLine = kind === 'kicked' ? 'طردوك الآن من اللعبة — عبّر عن استغرابك واسأل السبب'
                : kind === 'win' ? 'فزت بالجولة'
                : 'خسرت الجولة';
            maybeSpeak({
                settings, session, kind, probability,
                client, channel: message.channel, agentId, guildId,
                eventLine, runtimeSettings, agentName, session,
            });
            return true;
        }
        return false;
    } catch (_) {
        return false;
    }
}

/** للاختبار */
function __testHooks() {
    return { CHANCES, CANNED, canSpeak, reserve, cleanComment, TIMING };
}

module.exports = {
    handleChatMessage,
    observeBotMessage,
    __testHooks,
};
