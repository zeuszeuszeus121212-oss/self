/**
 * games/mafia.js — قرارات المافيا والرسائل السرية (v7.18)
 * ═══════════════════════════════════════════════════════════
 * بلاغ المالك: «الرسائل تأتي لو كان مافيا او طبيب تكون فقط مرئية
 * للحساب وحده بمعنى مخفية» — اختيار ضحية المافيا وحماية الطبيب
 * يصلان على الخاص أو كرسالة مخفية (ephemeral) بأزرار أسماء اللاعبين.
 *
 * ماذا يفعل هذا الملف؟
 *   1) التعرف على الرسائل السرية بصيغ كثيرة (المالك: «اجعلها باحتمالات
 *      كثيرة لأنني متعاجز اجلبها لك») — قوائم كلمات متسامحة لا جملة واحدة
 *   2) استخراج دور الوكيل من الرسالة السرية (مافيا/طبيب/محقق/مواطن)
 *   3) اختيار الهدف:
 *      - الوضع الذكي (engines.mafia.mode === 'ai'): الذكاء يقرر بالسياق
 *        (الصامتون مشتبه بهم، الأصدقاء يُحمون، المخطِر يُقتل) — بلاغ
 *        «اريد وضعن للمافيا واحد يتحكم فيه الوكيل... والآخر تلقائي»
 *      - الوضع التلقائي (الافتراضي): عشوائي — نفس سلوك بقية المحركات
 *   4) الضغط بتأخير بشري — لا نقرات خاطفة آلية
 *
 * حدود الأمان (صفر كسر):
 *   - لا شيء يعمل إلا داخل جلسة مافيا حية من بوت اللعبة نفسه
 *   - رسائل الخاص لبوت غريب → false فوراً (لا نقر أي شيء أبداً)
 *   - فشل الذكاء → عشوائي (لا توقف الدور أبداً)
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const sessions = require('./sessions');
const social = require('./social');
const { getProviderOrFallback } = require('../providers');

const AI_TIMEOUT_MS = 6500;

// ════════════════════════════════════════════════════════════
//  التعرف على الصيغ — «باحتمالات كثيرة» كما طلب المالك
// ════════════════════════════════════════════════════════════

/**
 * 🐞 v7.18 — نص الرسالة السرية الكامل: كانت تُقرأ content + title/desc فقط
 * وحقول الإيمبد (fields) كانت مستثناة — بطاقة الدور داخل حقل إيمبد لا تُكتشف
 * فيبقى الدور مجهولاً والعقلة تخمّن «مواطن» وهو مافيا (بلاغ المالك الحرفي).
 */
function secretText(message) {
    if (!message) return '';
    const parts = [];
    if (message.content) parts.push(String(message.content));
    if (Array.isArray(message.embeds)) {
        for (const embed of message.embeds) {
            if (embed.title) parts.push(String(embed.title));
            if (embed.description) parts.push(String(embed.description));
            if (Array.isArray(embed.fields)) {
                for (const field of embed.fields) {
                    if (field.name) parts.push(String(field.name));
                    if (field.value) parts.push(String(field.value));
                }
            }
            if (embed.footer && embed.footer.text) parts.push(String(embed.footer.text));
            if (embed.author && embed.author.name) parts.push(String(embed.author.name));
        }
    }
    // Components V2 — نص الأقسام إن وُجد (مميزات نصية داخل TextDisplay)
    try {
        if (Array.isArray(message.components)) {
            for (const comp of message.components) {
                const json = typeof comp.toJSON === 'function' ? comp.toJSON() : comp;
                if (json && typeof json.content === 'string') parts.push(json.content);
            }
        }
    } catch (_) {}
    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// صيغ اختيار ضحية القتل (رسالة المافيا السرية)
const KILL_MARKERS = [
    'اختار شخصا', 'اختر شخصا', 'اختيار شخص', 'اختار لاعبا', 'اختر لاعبا',
    'اختيار لاعب', 'حدد شخصا', 'حدد ضحية', 'اختر ضحية', 'اختار ضحية',
    'لاغتياله', 'لاغتياله', 'اغتيال', 'إغتيال', 'لقتله', 'ليقتل', 'يقتل',
    'لقتل شخص', 'عملية القتل', 'انتظر المافيا',
];

// صيغ اختيار محميّ الطبيب (رسالة الطبيب السرية)
const SAVE_MARKERS = [
    'لحمايته', 'لحمايتها', 'لحماية', 'احميه', 'أحميه', 'يحمي', 'تحمي',
    'اختار شخصا لحمايته', 'اختر شخصا لحمايته', 'اختيار شخص لحمايته',
    'حماية شخص', 'انتظر الطبيب', 'دور الطبيب', 'علاج',
    // 🐞 v7.19: «اختر شخصاً لحمايته» — التاء تنكسر مطابقة «حمايه» بعد التسوية
    // فكانت التفرقة تُرجع قتل — العقلة تستشير بذهنية مافيا وهو طبيب
    'لحمايته', 'حمايته', 'حمايتها', 'يحميه', 'يحميها',
];

// صيغ الأدوار — «دورك: مافيا» أو ذكر الدور في الرسالة السرية
const ROLE_PATTERNS = [
    { role: 'mafia',     words: ['مافيا', 'القاتل', 'قتلة', 'الجراح'] },
    { role: 'doctor',    words: ['طبيب', 'الدكتور', 'دكتور', 'المعالج'] },
    { role: 'detective', words: ['محقق', 'المحقق', 'مدعي', 'التحقق', 'العين'] },
    { role: 'citizen',   words: ['مواطن', 'مواطنه', 'مدني', 'عادي'] },
];

// أسماء أزرار لا تُختار كبش فداء أبداً (واجهة أو وفاة أو أنا)
const TARGET_EXCLUDES = [
    'ميت', 'خارج', 'طرد', 'موت', 'قالب', 'مشاهدة', 'الغاء', 'إلغاء', 'المشاهدون',
    // واجهة البوتات — بلاغ المالك: لا «حقيبتي» في أي قرار
    'حقيبة', 'حقيبتي', 'محفظة', 'محفظتي', 'متجر', 'رصيد', 'نقاط', 'معلومات', 'قوانين', 'مساعدة',
    // 🐞 v7.19: زر «تحديث/refresh» يُضغط بلا معنى — كان مرشحاً كضحية
    'تحديث', 'refresh',
];

function normalize(text) {
    return sessions.normalizeName(text);
}

function matchesAny(text, markers) {
    const n = normalize(text);
    return markers.some(marker => n.includes(normalize(marker)));
}

/** هل الرسالة سرية؟ — خاص (بلا سيرفر) أو مخفية (ephemeral flags 64) */
function isSecretMessage(message) {
    if (!message) return false;
    if (!message.guild) return true; // الخاص
    // ephemeral: discord.js flags object أو رقم خام
    try {
        if (typeof message.flags?.has === 'function' && message.flags.has('EPHEMERAL')) return true;
        const raw = Number(message.flags?.bitfield !== undefined ? message.flags.bitfield : message.flags);
        if ((raw & 64) !== 0) return true;
    } catch (_) {}
    return false;
}

/** نوع الاختيار من نص الرسالة — 'kill' | 'save' | null
 *  🐞 v7.19: التفرقة كانت تُرجع قتل لبطاقة الطبيب «اختر شخصاً لحمايته»
 *  (كلا النوعين يطابق — والبحث عن «حماية» لا يجد «حمايته») */
function detectChoiceKind(text) {
    if (!text) return null;
    const n = normalize(text);
    const kill = KILL_MARKERS.some(marker => n.includes(normalize(marker)));
    const save = SAVE_MARKERS.some(marker => n.includes(normalize(marker)));
    // الحماية تتفوق عند الالتباس («انتظر الطبيب» قبل «اختار»)
    if (save && !kill) return 'save';
    if (kill && !save) return 'kill';
    if (kill && save) return /حمي|حماي|علاج/.test(n) ? 'save' : 'kill';
    return null;
}

/** دور الوكيل من نص الرسالة السرية */
function detectRole(text) {
    if (!text) return null;
    const n = normalize(text);
    for (const { role, words } of ROLE_PATTERNS) {
        if (words.some(word => n.includes(normalize(word)))) return role;
    }
    return null;
}

// ════════════════════════════════════════════════════════════
//  الأزرار والمرشحون
// ════════════════════════════════════════════════════════════

function collectChoiceButtons(message) {
    if (!message.components || message.components.length === 0) return [];
    return message.components.flatMap(row => (row && row.components) || [])
        .filter(button => button && button.customId && !button.disabled && button.type !== 3);
}

/** مرشحون صالحون — بلا واجهة/موتى/الوكيل نفسه */
function candidateButtons(allButtons, { agentName = null } = {}) {
    const myName = normalize(agentName || '');
    return allButtons.filter(button => {
        const label = normalize(button.label || '');
        if (!label) return false;
        if (TARGET_EXCLUDES.some(word => label.includes(normalize(word)))) return false;
        if (myName && label === myName) return false; // لا تقتل/تحمي نفسك بأمرنا — البوت يستثنيها أصلاً
        return true;
    });
}

function pickRandom(candidates) {
    if (!candidates || candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

/** اربط اسمًا ردّه الذكاء بأحد الأزرار — مطابقة متسامحة */
function matchButtonByName(candidates, name) {
    const want = normalize(name || '');
    if (!want || want.length < 2) return null;
    return candidates.find(button => normalize(button.label || '') === want)
        || candidates.find(button => normalize(button.label || '').includes(want))
        || candidates.find(button => want.includes(normalize(button.label || '')))
        || null;
}

async function humanClick(message, button, { minDelay = 900, maxDelay = 1800 } = {}) {
    const delayMs = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    await message.clickButton(button.customId);
    return { label: button.label || null, delayMs };
}

// ════════════════════════════════════════════════════════════
//  الذكاء — قرار الهدف بالسياق (الوضع الذكي فقط)
// ════════════════════════════════════════════════════════════

const ROLE_AR = { mafia: 'مافيا 🔪', doctor: 'طبيب 💊', detective: 'محقق 🔍', citizen: 'مواطن 🙂' };

function buildDecisionPrompt({ kind, agentName, role, session, candidates, rawText = null }) {
    const roleText = ROLE_AR[role] || 'غير معروف بعد';
    // 🧠 v7.19 — هدف التصويت حسب الدور (بلاغ المالك: «طرد اذا كان مافيا»):
    // المافيا كان يُسأل «صوّت على من تشك أنه مافيا» — يعني يصوّت على زملائه!
    let objective;
    if (kind === 'kill') {
        objective = 'أنت المافيا: اختر الضحية الأخطر — المخطِر الذي يكشفكم، ولا تختر صديقاً لك';
    } else if (kind === 'save') {
        objective = 'أنت الطبيب: اختر من يستحق الحماية — صديقك أو الأكثر فائدة للمواطنين أو نفسك إن أمكن';
    } else if (role === 'mafia') {
        objective =
            'أنت مافيا وتصوّت الآن على طرد شخص — هدفك إسقاط مواطن بريء (وليس زميلاً لك إطلاقاً)، ' +
            'والتزم رأي الأغلبية حتى لا تنكشف، وتبرّر تصويتك بشيء عام (صمته أو كلامه) دون ذكر أنك مافيا';
    } else if (role === 'doctor') {
        objective = 'أنت الطبيب وتصوّت على طرد شخص تشك أنه مافيا — ركّازك من ظنّته مافيا من مراحل الليل';
    } else if (role === 'detective') {
        objective = 'أنت المحقق وتصوّت على طرد شخص — إن كنت تحققت من أحد فادفع نحو المافيا الحقيقي';
    } else {
        objective = 'أنت تصوت على طرد شخص تشك أنه مافيا — الصامت طوال الجولة مشتبه به، ولا تصوت على نفسك';
    }
    const playerLines = candidates.map(button => {
        const name = String(button.label || '؟');
        const known = [...(session?.mafia?.players || new Map()).values()]
            .find(p => sessions.normalizeName(p.name) === sessions.normalizeName(name));
        const talks = known ? (known.talks || 0) : null;
        const alive = known ? (known.alive ? 'حي' : 'ميت') : null;
        const friend = [...(session?.friends || new Set())].some(id => {
            const p = session?.mafia?.players?.get(id);
            return p && sessions.normalizeName(p.name) === sessions.normalizeName(name);
        });
        // 🩸 v7.19: زميل المافيا يظهر للعقل — لا يصوّت عليه ولا يقتله
        const ally = [...(session?.mafia?.allies || new Set())].some(id => {
            const p = session?.mafia?.players?.get(id);
            return p && sessions.normalizeName(p.name) === sessions.normalizeName(name);
        });
        const bits = [name];
        if (talks !== null) bits.push(`تكلم ${talks} مرة`);
        if (alive) bits.push(alive);
        if (friend) bits.push('صديق لك');
        if (ally) bits.push('زميلك في المافيا — لا تختاره أبداً');
        return `  • ${bits.join(' — ')}`;
    }).join('\n');
    // 🗳️ v7.19: لوحة الأصوات الحالية — يرى من ترجّحت كفته قبل أن يقرر
    let tallyLine = '';
    if (session?.mafia?.voteCounts?.size) {
        const tally = [...session.mafia.voteCounts.entries()]
            .map(([name, count]) => `${name} (${count})`).join('، ');
        tallyLine = `\nلوحة الأصوات الحالية في هذه الجولة: ${tally}\n`;
    }
    // 🩸 v7.19: زملاؤه المافيا
    let alliesLine = '';
    if (session?.mafia?.allies?.size) {
        const allyNames = [...session.mafia.allies]
            .map(id => session?.mafia?.players?.get(id)?.name || id);
        alliesLine = `\nزملاؤك في المافيا: ${allyNames.join('، ')} — لا تقتلهم ولا تصوّت عليهم ولا تكشفهم\n`;
    }
    return (
        `أنت تلعب لعبة مافيا في ديسكورد باسم «${agentName}» ودورك: ${roleText}.\n` +
        (rawText ? `رسالة اللعبة التي وصلتك الآن حرفياً: «${String(rawText).slice(0, 400)}»\n` : '') +
        `${objective}\n` +
        tallyLine +
        alliesLine +
        `\nالخيارات المتاحة (الأزرار):\n${playerLines || '  • لا أحد'}\n\n` +
        `سياق الجلسة:\n${sessions.contextSummary(session) || '- لا معلومات بعد'}\n\n` +
        'اكتب اسم الشخص الذي تختاره فقط — الاسم كما هو في القائمة أعلاه بدون أي كلام إضافي.'
    );
}

async function aiPick(runtimeSettings, ctx) {
    try {
        const providerObj = getProviderOrFallback(runtimeSettings?.provider);
        if (!providerObj || typeof providerObj.chat !== 'function') {
            social.notifyAiFail(runtimeSettings?.agentId, 'قرار المافيا', 'لا مزود متاح');
            return null;
        }
        const prompt = buildDecisionPrompt(ctx);
        const result = await Promise.race([
            providerObj.chat({ prompt, config: runtimeSettings?.providerConfig, agentId: runtimeSettings?.agentId }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ai_timeout')), AI_TIMEOUT_MS)),
        ]);
        const raw = result && (result.fullText || result.reply || result.text);
        if (!raw) {
            social.notifyAiFail(runtimeSettings?.agentId, 'قرار المافيا', 'رد فارغ من المزود');
            return null;
        }
        return String(raw).split('\n').map(l => l.trim()).filter(Boolean)[0] || null;
    } catch (error) {
        // 🧠 v7.17: أي فشل → عشوائي (الدور لا يتوقف) لكن الفشل يصبح مرئياً للمالك
        social.notifyAiFail(runtimeSettings?.agentId, 'قرار المافيا', error?.message || String(error));
        return null;
    }
}

/** قرار التصويت — نفس الآلية بعنوان مختلف (يستعمله معالج التصويت) */
async function decideVote({ runtimeSettings, agentName, role, session, candidates, rawText = null }) {
    const picked = await aiPick(runtimeSettings, { kind: 'vote', agentName, role, session, candidates, rawText });
    return picked ? matchButtonByName(candidates, picked) : null;
}

/** قرار الروليت — من يُطرد؟ (بلاغ المالك v7.16:
 *  «وضع الذكاء الاصطناعي هو من يختار يطرد ووضع تلقائي وهو الحالي من النظام») */
async function decideKick({ runtimeSettings, agentName, session, candidates }) {
    try {
        const providerObj = getProviderOrFallback(runtimeSettings?.provider);
        if (!providerObj || typeof providerObj.chat !== 'function') {
            social.notifyAiFail(runtimeSettings?.agentId, 'طرد الروليت', 'لا مزود متاح');
            return null;
        }
        const names = candidates.map(b => String(b.label || '؟')).filter(l => l && l !== '؟');
        if (names.length === 0) return null;
        const prompt =
            `أنت تلعب لعبة روليت ديسكورد باسم «${agentName}» ودورك الآن: اختر لاعباً واحداً لطرده من الجولة.\n` +
            `اللاعبون المتاحون: ${names.join('، ')}\n` +
            `سياق الجلسة:\n${sessions.contextSummary(session) || '- لا معلومات بعد'}\n\n` +
            'اكتب اسم اللاعب الذي تطرده فقط — الاسم كما هو بدون أي كلام إضافي.';
        const result = await Promise.race([
            providerObj.chat({ prompt, config: runtimeSettings?.providerConfig, agentId: runtimeSettings?.agentId }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('ai_timeout')), AI_TIMEOUT_MS)),
        ]);
        const raw = result && (result.fullText || result.reply || result.text);
        return raw ? matchButtonByName(candidates, String(raw).split('\n').map(l => l.trim()).filter(Boolean)[0]) : null;
    } catch (error) {
        social.notifyAiFail(runtimeSettings?.agentId, 'طرد الروليت', error?.message || String(error));
        return null; // أي فشل → العشوائي (النظام الحالي)
    }
}

/** قرار القتل/الحماية — يستعمله معالج الرسائل السرية */
async function decideChoice({ runtimeSettings, agentName, role, session, candidates, kind, rawText = null }) {
    const picked = await aiPick(runtimeSettings, { kind, agentName, role, session, candidates, rawText });
    return picked ? matchButtonByName(candidates, picked) : null;
}

// ════════════════════════════════════════════════════════════
//  المعالج الرئيسي — رسالة سرية (خاص/مخفية) من بوت المافيا
// ════════════════════════════════════════════════════════════

/**
 * عالج رسالة سرية أو بطاقة اختيار. ترجع null إذا لم تكن لنا (ليست مافيا/لا جلسة/لا صيغة)
 * أو نتيجة { handled, kind, result, choice, source, role, ... }.
 * تُستدعى من ثلاثة مسارات:
 *   - الخاص (player.js مباشرة)
 *   - المخفية داخل القناة (events.js mafiaSecret)
 *   - 🆕 v7.19: البطاقة الظاهرة بالقناة (allowVisible) — معالجا ليل القتل/الطبيب
 *     كانا يستهلكان الرسالة بـ break فلا أحد يختار أبداً إن كانت البطاقة مرئية
 */
async function handleSecretMessage({ client, message, agentId, runtimeSettings, settings, agentName, session: presetSession, guildId: presetGuildId, allowVisible = false }) {
    if (!message || !message.author || !message.author.bot) return null;
    if (!client?.user?.id) return null;
    if (!settings?.engines?.mafia?.enabled) return null;
    if (!allowVisible && !isSecretMessage(message)) return null;

    // 🐞 v7.18: النص الكامل يشمل حقول الإيمبد (كانت مستثناة فتضيع بطاقة الدور)
    const text = secretText(message);

    // جلسة مافيا حية من بوت اللعبة نفسه — وإلا لا شيء (لا نقر أزرار أبحاث غريبة)
    let guildId = null;
    let session = presetSession || null;
    if (!session) {
        const found = sessions.findMafiaSessionByBot(agentId, message.author.id);
        if (!found) return null;
        guildId = found.guildId;
        session = found.session;
    } else {
        guildId = presetGuildId || message.guild?.id || null;
    }

    // ⚰️ v7.19: قُتلنا؟ لا حركات سرية بعد اليوم — نلعب بصمت متفرجين
    if (session.mafia.meDead) return null;

    // 🆕 v7.19 — حارس المسار الظاهر: رسالة بلا أزرار = إعلان طور عامة
    // («جاري انتظار المافيا...») وليست بطاقة لنا — لا تدخل الوعي ولا تُغير
    // الدور أبداً (كانت تُسجّل الدور من كلمة «مافيا» في إعلان الطور!)
    const visibleCandidates = allowVisible
        ? candidateButtons(collectChoiceButtons(message), { agentName })
        : null;
    if (allowVisible && (!visibleCandidates || visibleCandidates.length === 0)) return null;

    // 📥 الصندوق الحي (v7.18): الرسالة السرية نفسها حرفياً لعقل الوكيل —
    // «رساله الاختيار يتم إرسالها للوكيل مع الخيارات» — والخيارات الآن فعلاً (v7.19)
    const optionsLine = sessions.optionsLineFromComponents(message.components);
    sessions.pushInbox(agentId, guildId, {
        id: message.id || null,
        kind: 'secret',
        text: `رسالة سرية من بوت اللعبة: ${text.slice(0, 400)}${optionsLine ? ` — ${optionsLine}` : ''}`,
    });

    // الدور قد يأتي في أي رسالة سرية — سجّله فوراً
    const role = detectRole(text);
    if (role) {
        const hadRole = session.mafia.role;
        sessions.mafiaSetRole(agentId, guildId, role);
        session.mafia.role = role;

        // 🩸 v7.19: زملاؤه في المافيا من بطاقة الدور — «ومن معه» (بلاغ المالك)
        if (role === 'mafia' && /زميل|زملاء|شريك|فريق|معك/.test(text)) {
            const ids = new Set();
            const re = /<@!?(\d{5,25})>/g;
            let m;
            const full = `${message.content || ''}\n${text}`;
            while ((m = re.exec(full)) !== null) ids.add(m[1]);
            ids.delete(String(client.user.id)); // الوكيل نفسه ليس زميله
            if (ids.size) {
                sessions.mafiaAddAllies(agentId, guildId, [...ids]);
                sessions.pushEvent(agentId, guildId, `عرفت زملاءك في المافيا: ${ids.size} لاعب`);
            }
        }

        // 🧠 v7.18: بطاقة الدور تصل وعيه + رد فعل حقيقي بكيفه في قناة اللعبة
        // (المالك: «توزيع الأدوار يتم ارسال رسالة توزيع الأدوار للوكيل يبدي رد فعل اولا بكيفه»)
        if (!hadRole || hadRole !== role) {
            sessions.pushEvent(agentId, guildId, `عرفت دورك: ${ROLE_AR[role] || role}`);
            if (guildId && client?.channels?.fetch) {
                const gameChannel = await client.channels.fetch(session.channelId).catch(() => null);
                if (gameChannel && typeof gameChannel.send === 'function') {
                    social.maybeSpeak({
                        settings, session, kind: `role_${role}`,
                        probability: social.effectiveChance(session, 'role_react', social.CHANCES.role_react),
                        client, channel: gameChannel, agentId, guildId,
                        eventLine: `وصلتك بطاقة دورك السرية: أنت ${ROLE_AR[role] || role}${role === 'mafia' ? ' — حاول ألا تكشف نفسك أبداً' : ''}`,
                        runtimeSettings, agentName, session,
                    });
                }
            }
        }
    }

    const kind = detectChoiceKind(text);
    if (!kind) {
        // رسالة دور بلا أزرار (مثل «دورك هو: مواطن») — ملاحظة صامتة
        if (role) {
            return { handled: true, silent: true, type: 'game_play', result: 'role_note', gameName: 'مافيا', role, message: `عُرف الدور: ${ROLE_AR[role] || role}` };
        }
        return null;
    }

    // 🆕 v7.19 — حارس التوافق (المسار الظاهر فقط): بطاقة القتل لطبيب/مواطن معروف؟
    // ليست لنا — بطاقات القناة الظاهرة قد يراها الجميع ولا نحرك إلا لدورنا
    if (allowVisible && session.mafia.role) {
        const expected = session.mafia.role === 'mafia' ? 'kill'
            : session.mafia.role === 'doctor' ? 'save' : 'none';
        if (expected === 'none' || expected !== kind) return null;
    }

    // الأزرار: مرشحون صالحون فقط
    const allButtons = collectChoiceButtons(message);
    const candidates = candidateButtons(allButtons, { agentName });
    if (candidates.length === 0) return null;

    // 🧠 v7.18: القرار دائماً بعقل الوكيل في الوضعين — «لا يختار هو اصلا من يقتل
    // او على من يصوت» كان بسبب: التلقائي عشوائي حرفياً والذكي يسقط عشوائياً بصمت.
    // العشوائي الآن احتياط فشل فقط.
    let target = await decideChoice({
        runtimeSettings, agentName, role: session.mafia.role, session, candidates, kind, rawText: text,
    });
    let source = target ? 'ai' : 'random';
    if (!target) target = pickRandom(candidates);
    if (!target) return null;

    const clicked = await humanClick(message, target).catch(() => null);
    if (!clicked) return null;

    // 🧠 الوعي — حركتنا السرية تسجل في سجل ما يحصل
    sessions.pushEvent(agentId, guildId, kind === 'kill'
        ? `اختار سراً ضحية المافيا: ${target.label || '؟'} (${source === 'ai' ? 'قرار الذكاء' : 'عشوائي احتياطي'})`
        : `اختار سراً من يُحمى: ${target.label || '؟'} (${source === 'ai' ? 'قرار الذكاء' : 'عشوائي احتياطي'})`);

    return {
        handled: true,
        type: 'game_play',
        result: 'secret_choice',
        gameName: 'مافيا',
        message: kind === 'kill'
            ? `🔪 اختار هو نفسه ضحية المافيا: ${target.label || '؟'}`
            : `💊 اختار هو نفسه من يُحمى: ${target.label || '؟'}`,
        details: { kind, role: session.mafia.role, target: target.label || null, source, mode: settings.engines?.mafia?.mode || 'auto', candidates: candidates.length, dm: !message.guild },
    };
}

module.exports = {
    isSecretMessage,
    detectChoiceKind,
    detectRole,
    secretText,
    collectChoiceButtons,
    candidateButtons,
    matchButtonByName,
    handleSecretMessage,
    decideVote,
    decideChoice,
    decideKick,
    aiPick,
    pickRandom,
    humanClick,
    ROLE_AR,
    KILL_MARKERS,
    SAVE_MARKERS,
    TARGET_EXCLUDES,
};
