/**
 * games/social.js — التفاعل الاجتماعي أثناء اللعب (v7.18)
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
    killed       : 0.70, // قتله المافيا (بلاغ المالك v7.16)
    friend_kicked: 0.50, // طُرد صديق — يمزح أحياناً
    mourn_ally   : 0.65, // قُتل صديقه على يد المافيا — يندب ويوعد بالثأر
    name_drop    : 0.85, // ذكروا اسمه — يرد غالباً
    // 🕵️ كلام المافيا (v7.16)
    role_react   : 0.80, // رؤية توزيع الأدوار — يتمنى مافيا / يلعن حظه
    beg          : 0.55, // ليل القتل — يرجى ألا يُقتل
    ask_protect  : 0.50, // دور الطبيب — «احميني»
    suspect      : 0.45, // نقاش النهار — رأي في المشتبه به
    // 🛰️ اللوبي (v7.18 — بلاغ المالك: «يستطيع أن يعمل رد على رسالة اللوبي ام لا»)
    lobby_react  : 0.60, // بعد الانضمام — يرد على رسالة اللوبي نفسها أحياناً
};

// 🤫 الوضع التلقائي (v7.18): يلعب ويقرر بعقله لكن كلامه محدود بردود فعل
// موقعه هو فقط (دوره/موته/فوزه/خسارته/طرده) — الفرق الحقيقي عن الاجتماعي
const AUTO_MINIMAL_KINDS = new Set(['role_react', 'kicked', 'killed', 'win', 'loss']);

// ⏳ التبريد والسقوف — بلا إزعاج
const SESSION_MAX_SOCIAL = 6;        // أقصى كلام في الجلسة الواحدة
const COOLDOWN_BASE_MS   = 60_000;   // بين كل كلمة وكلمة: دقيقة + عشوائية
const COOLDOWN_JITTER_MS = 60_000;
const USER_REPLY_COOLDOWN = 45_000;  // لا يزعج نفس الشخص كل ثانية

const AI_TIMEOUT_MS = 8000;
const MAX_LEN = 140;

// 🧠 تبليغ فشل الذكاء — مرة كل 3 دقائق لكل وكيل (بلاغ المالك v7.17:
// «الاثنان لا يتفاعلون» — كان السقوط للجمل الجاهزة/العشوائي صامتاً كلياً)
const AI_FAIL_NOTIFY_MS = 3 * 60_000;
const aiFailLast = new Map(); // agentId → ts
function notifyAiFail(agentId, where, reason) {
    try {
        const now = Date.now();
        const last = aiFailLast.get(String(agentId)) || 0;
        if (now - last < AI_FAIL_NOTIFY_MS) return;
        aiFailLast.set(String(agentId), now);
        console.warn(`[Games AI] فشل استشارة الذكاء (${where}): ${reason}`);
        store.pushRecentEvent(String(agentId), { kind: 'ai', text: `🧠 استشارة الذكاء فشلت (${where}) — السبب: ${String(reason || 'غير معروف').slice(0, 80)} — سقط للحل الاحتياطي` }).catch(() => {});
    } catch (_) {}
}

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
    killed: [
        'قتلتموني والمجلس كله شاهد 😭',
        'أنا قلت لكم مافيا فينا، ما سمعتم 😑',
        'روحوا ادفنوني بس الجاية القصة تنقلب',
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
    mourn_ally: [
        'دمه عليكم يا مافيا… راح آخذ حقي 🩸',
        'قتلتم صاحبي؟ الراحة راح تدفعون ثمنها',
        'الله يرحمه… والمافيا راح تعرف مين أنا',
    ],
    name_drop: [
        'سجلت اسمي؟ 😄',
        'أنا مشغول ألعب، وش عندكم؟',
        'قلتوا شيء عني؟',
        'أنا موجود لا تشيلون هم',
    ],
    // 🕵️ أدوار المافيا — رد الفعل على توزيع الرتب
    role_mafia: [
        'مافيا؟ الليلة فيها دم 🔪',
        'أخيراً مافيا… خلكوا حذرين الليلة 😈',
        'أنا مافيا، أحد ينتبه؟ هههه',
    ],
    role_doctor: [
        'دكتور الليلة 💊 مين يستحق الحماية؟',
        'طبيب… قلبي مع المواطنين الليلة',
    ],
    role_detective: [
        'محقق؟ بكشفكم كلكم 🔍',
        'عيني عليكم من الليلة، يا مافيا',
    ],
    role_citizen: [
        'مواطن مرة ثانية؟ حظي زفت 😭',
        'اللعبة هذي تعرف إنني مواطن دايماً',
        'أبغى أصير مافيا، ليش دايماً مواطن!',
    ],
    role_generic: [
        'أبغى مافيا الليلة، اللي يوزع الرتب يرحمي 🙏',
        'توزيع الأدوار… يا رب مافيا',
        'خلّيني مافيا هالمرة وأنا أضمن اللعبة',
    ],
    // 🌙 الليل
    beg: [
        'أرجوكم لا تقتلوني، أنا بريء 😭',
        'يا مافيا رحمكم الله، خذوا غيري',
        'أنا والله مو فاهم ليش أنا، لا تقتلوني 🥲',
        'الله لا يقتلني الليلة، عندي أصدقاء أحبهم',
    ],
    // 🛰️ اللوبي (v7.18)
    lobby_react: [
        'حلو، كنت بالانتظار 😎',
        'جاهزين؟ أنا معكم',
        'دخلت، لا تطردوني أول واحد 😅',
        'هذي الجولة لي، انتبهوا',
    ],
    ask_protect: [
        'دكتور احميني والله محتاجك 💊',
        'يا طبيب لا تنساني الليلة، احميني',
        'أنا وثيقك يا دكتور، احميني ولا تخيّني',
        'الطبيب احميني… حسيته أهذّر عليّ 😅',
    ],
    suspect: [
        'أشك الصامتين… المافيا ما تتكلم 😒',
        'اللي ساكت من أول الجولة، وش سرّك؟',
        'حسيته قاعد يسمّع ويطلع مافيا، أخاف منه',
        'رأيي: راقبوا اللي ما قال كلمة، أنا أشكه',
    ],
};

function pick(list) {
    return list[Math.floor(Math.random() * list.length)] || null;
}

function chance(p) {
    return Math.random() < p;
}

/**
 * 🕵️ قاعدة صمت المافيا (بلاغ المالك): «المافيا يميل نوعاً ما لعدم التكلم»
 * إذا صار الوكيل مافيا فالكلام الاجتماعي (الترجي/الشك/طلب الحماية)
 * يتقلص جداً — والاحتمالات الأخرى تبقى كما هي.
 */
function effectiveChance(session, kind, base) {
    let p = Number(base);
    if (!Number.isFinite(p) || p <= 0) return 0;
    if (session && session.mafia && session.mafia.role === 'mafia'
        && ['beg', 'ask_protect', 'suspect', 'name_drop', 'role_react'].includes(kind)) {
        p *= 0.12; // المافيا يكاد يصمت
    }
    return Math.min(p, 1);
}

// ════════════════════════════════════════════════════════════
//  بوابة موحدة — كل شيء يمر من هنا
// ════════════════════════════════════════════════════════════

function socialEnabled(settings) {
    return Boolean(settings && settings.enabled && settings.social && settings.social.enabled);
}

/**
 * 🧠 بوابة الكلام الحقيقية (v7.18 — بلاغ المالك: «وضع التلقائي او الاجتماعي
 * لا يوجد اختلاف بيهم»): الفرق صار حقيقياً —
 *   • الاجتماعي (mode 'social' أو 'ai' القديم): يلعب ويتفاعل بالكلام كاملاً
 *   • التلقائي (mode 'auto'): يلعب ويقرر بعقله نفسه لكن كلامه محدود بردود
 *     فعل موقعه هو فقط (دوره/موته/فوزه/طرده) — صمت على الشات والتعليقات
 *   • زر 🫧 التفاعل الاجتماعي يفعّل الكلام الكامل بغض النظر عن الوضع
 */
function speechMode(settings, session) {
    if (!settings || !settings.enabled) return 'none';
    if (settings.social && settings.social.enabled) return 'full';
    const engineId = session && session.engineId;
    const mode = engineId && settings.engines && settings.engines[engineId]
        ? settings.engines[engineId].mode : null;
    if (mode === 'social' || mode === 'ai') return 'full';   // 'ai' توافق قديم
    if (mode === 'auto') return 'minimal';
    return 'none';
}

/** هل يُسمح له بنوع كلام معيّن؟ — التلقائي يكتم الشات ويرد فقط على موقعه
 *  (ردود الدور role_* مسموحة في التلقائي أيضاً — رد الفعل على بطاقة الدور
 *  جزء من اللعب نفسه كما طلب المالك: «يبدي رد فعل اولا بكيفه») */
function speechGate(settings, session, kind) {
    const mode = speechMode(settings, session);
    if (mode === 'full') return true;
    if (mode === 'minimal') {
        const k = String(kind || '');
        return AUTO_MINIMAL_KINDS.has(k) || k.startsWith('role_');
    }
    return false;
}

/** توافق قديم (v7.17) — زر 🫧 أو وضع اجتماعي/ذكي */
function speechAllowed(settings, session) {
    return speechMode(settings, session) !== 'none';
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
        if (!providerObj || typeof providerObj.chat !== 'function') {
            notifyAiFail(runtimeSettings?.agentId || session?.botId, 'كلام اجتماعي', 'لا مزود متاح');
            return null;
        }
        const personality = String(runtimeSettings?.personality || '').trim().slice(0, 300);
        const prompt =
            `أنت تلعب لعبة ديسكورد باسم «${agentName}» داخل قناة عربية.\n` +
            (personality ? `شخصيتك: ${personality}\n` : 'أسلوبك: لاعب ودود عفوي.\n') +
            `\nما حدث الآن: ${eventLine}\n` +
            `سياق القناة:\n${sessions.contextSummary(session) || '- لا كلام بعد'}\n\n` +
            'اكتب سطراً واحداً قصيراً جداً (3 إلى 12 كلمة) تقوله في الشات الآن: عامي عربي طبيعي يناسب الموقف.\n' +
            'قواعد صارمة: سطر واحد فقط، بلا markdown، بلا قوائم، بلا ذكر أنك بوت أو ذكاء اصطناعي.';
        const result = await Promise.race([
            providerObj.chat({ prompt, config: runtimeSettings?.providerConfig, agentId: runtimeSettings?.agentId }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ai_timeout')), AI_TIMEOUT_MS)),
        ]);
        return cleanComment(result && (result.fullText || result.reply || result.text));
    } catch (error) {
        // 🧠 v7.17: أي فشل → الجمل الجاهزة، لكن الفشل نفسه يصبح مرئياً للمالك
        notifyAiFail(runtimeSettings?.agentId, 'كلام اجتماعي', error?.message || String(error));
        return null;
    }
}

/** الإرسال الفعلي — fire-and-forget بلا أي تأثير على خط الأنابيب
 *  🛰️ v7.18: replyToMessageId — يرد على رسالة اللوبي نفسها لا رسالة جديدة */
async function speak({ client, channel, agentId, guildId, kind, eventLine, runtimeSettings, agentName, session, mentionLabel = null, replyToMessageId = null }) {
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
        if (replyToMessageId) {
            await channel.send({ content: text.slice(0, MAX_LEN), reply: { messageReference: replyToMessageId } });
        } else {
            await channel.send(text.slice(0, MAX_LEN));
        }
    } catch (_) {
        try { await channel.send(text.slice(0, MAX_LEN)); } catch (_) { return false; }
    }
    store.incrementStats(agentId, guildId, 'plays');
    await store.pushRecentEvent(agentId, { kind: 'social', text: `🫧 تعليق اجتماعي (${kind}): ${text.slice(0, 60)}` });
    await store.logGameEvent(agentId, guildId, { type: 'social_comment', social_kind: kind, text });
    return true;
}

/** قرار + حجز التبريد قبل التوليد (يمنع تكرار الكلام المتزامن)
 *  probability تُمرَّر عبر effectiveChance من الاستدعاءات — هنا لا تلمس */
function maybeSpeak(ctx) {
    const { settings, session, kind, userId = null, probability } = ctx;
    // 🧠 v7.18: البوابة الجديدة — التلقائي يكتم كل الكلام إلا ردود موقعه هو
    if (!speechGate(settings, session, kind)) return false;
    if (session && !canSpeak(session, { userId })) return false;
    if (!chance(probability)) return false;
    if (session) reserve(session, { userId });
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

        const guildId = message.guild.id;
        const session = sessions.touchSession(agentId, guildId);
        if (!session) return false; // بلا جلسة لعب حية — صفر تدخل

        // 🕵️ عدّاد الكلام يعمل دائماً داخل جلسة حية (سبب الشك في الصامتين)
        // 🐞 v7.17: كان بعد بوابة socialEnabled — يعني بلا زر 🫧 العدّاد ميت
        // والذكاء لا يرى الصامتين أبداً — الآن أول شيء بعد الجلسة
        sessions.bumpTalk(agentId, guildId, message.author.id);

        if (!speechAllowed(settings, session)) return false;
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
// ⚰️ قتل المافيا — يُعامل كطرد اجتماعياً (ندبة/تعليق) (v7.16)
const KILL_LINE = /تم\s*قتل|قتلت|نجحت\s*عملية/;

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

        const guildId = message.guild.id;
        session = session || sessions.touchSession(agentId, guildId);
        if (!session) return false;
        if (!speechAllowed(settings, session)) return false;

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
                    probability: effectiveChance(session, 'friend_kicked', CHANCES.friend_kicked),
                    client, channel: message.channel, agentId, guildId,
                    eventLine: 'طردوا صديقاً لك من اللعبة',
                    mentionLabel: kickedId ? `<@${kickedId}>` : null,
                    runtimeSettings, agentName, session,
                });
                return true;
            }
        }

        // 1.5) ⚰️ قتل المافيا — قتيل صديق → ندبة ووعد بالثأر (بلاغ المالك:
        //      «عندما يتم قتل شخص متحالف معه يندب القاتل و توعد باخذ حقه»)
        for (const line of lines) {
            if (!KILL_LINE.test(line)) continue;
            const mentionMatch = line.match(/<@!?(\d+)>/);
            const victimId = mentionMatch ? mentionMatch[1] : null;
            if (victimId) sessions.mafiaMarkDead(agentId, guildId, victimId); // سجّل القتيل دائماً
            if (victimId && outcome === null && session.friends.has(victimId)) {
                maybeSpeak({
                    settings, session, kind: 'mourn_ally',
                    probability: effectiveChance(session, 'mourn_ally', CHANCES.mourn_ally),
                    client, channel: message.channel, agentId, guildId,
                    eventLine: 'قتلت المافيا صديقاً متحالفاً لك — ندّب القاتل ووعد بأخذ حقك',
                    mentionLabel: victimId ? `<@${victimId}>` : null,
                    runtimeSettings, agentName, session,
                });
                return true;
            }
        }

        // 2) نتيجة الوكيل نفسه — التعليق
        if (outcome && outcome.result) {
            const kind = outcome.kind === 'kick' ? 'kicked'
                : outcome.kind === 'killed' ? 'killed'
                : outcome.result === 'win' ? 'win' : 'loss';
            const probability = effectiveChance(session, kind,
                kind === 'kicked' ? CHANCES.kicked
                : kind === 'killed' ? CHANCES.killed
                : kind === 'win' ? CHANCES.win : CHANCES.loss);
            const eventLine = kind === 'kicked' ? 'طردوك الآن من اللعبة — عبّر عن استغرابك واسأل السبب'
                : kind === 'killed' ? 'قتلتك المافيا الليلة — تعلّق على موتك بالسخرية'
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
    return { CHANCES, CANNED, canSpeak, reserve, cleanComment, TIMING, effectiveChance };
}

module.exports = {
    handleChatMessage,
    observeBotMessage,
    maybeSpeak,        // 🕵️ معالجات المافيا في events.js تستعملها مباشرة (v7.16)
    speak,             // 🛰️ v7.18: رد اللوبي يستدعيها مباشرة بعد بوابة speechGate
    effectiveChance,
    CHANCES,           // الاحتمالات الأساسية (الاستدعاءات تمررها عبر effectiveChance)
    speechAllowed,     // 🧠 توافق v7.17: زر 🫧 أو وضع اجتماعي/ذكي
    speechGate,        // 🧠 v7.18: بوابة النوع — التلقائي يكتم إلا ردود موقعه
    speechMode,        // 🧠 v7.18: 'full' | 'minimal' | 'none'
    AUTO_MINIMAL_KINDS,
    notifyAiFail,      // تبليغ فشل الذكاء المرئي — تستعمله mafia.js أيضاً
    __testHooks,
};
