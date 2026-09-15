/**
 * games/events.js — معالجات ألعاب الوكلاء (v7.14)
 * ═══════════════════════════════════════════════════════════
 * نقل حرفي (port) لكل معالجات مستودع Auto — tokensHandler/*:
 *
 *   Zar/events/zarPlay.js        → zarPlay        (messageUpdate)
 *   Zar/events/zarPlayUpdate.js  → zarPlayUpdate  (messageUpdate)
 *   Karasi/events/karasiJoin.js  → karasiJoin     (messageCreate)
 *   Karasi/events/karasiPlay.js  → karasiPlay     (messageUpdate)
 *   Replka/events/replkaJoin.js  → replkaJoin     (messageCreate)
 *   Replka/events/replkaPlay.js  → replkaPlay     (messageCreate)
 *   Roulette/events/rouletteJoin.js → rouletteJoin (messageCreate)
 *   + نسختا «الانضمام المميز» (premium join) معطلتان افتراضياً
 *     (في Auto تنقران أي زر بعد ذكر اسم اللعبة — خطرة على وكيل
 *      يشارك المحادثة، فصارت خياراً لكل محرك: premium_join)
 *
 * كل معالج: { engineId, name, eventType, gameName, trigger, execute(message, client, ctx) }
 * ترجع {handled:true, type, result, gameName, message, details} كما في Auto.
 * الضغط نفسه message.clickButton(customId) — متاح على حسابات المستخدم
 * (discord.js-selfbot-v13) فقط.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

// ════════════════════════════════════════════════════════════
//  أدوات مشتركة (نفس مساعدات Auto)
// ════════════════════════════════════════════════════════════

function textFromMessage(message) {
    const parts = [];
    if (message.content) parts.push(message.content);
    if (Array.isArray(message.embeds)) {
        for (const embed of message.embeds) {
            if (embed.title) parts.push(embed.title);
            if (embed.description) parts.push(embed.description);
            if (Array.isArray(embed.fields)) {
                for (const field of embed.fields) {
                    if (field.name) parts.push(field.name);
                    if (field.value) parts.push(field.value);
                }
            }
            if (embed.footer && embed.footer.text) parts.push(embed.footer.text);
            if (embed.author && embed.author.name) parts.push(embed.author.name);
        }
    }
    return parts.join(' ');
}

function isGreenButton(button) {
    const style = button && button.style;
    const styleText = String(style || '').toUpperCase();
    return style === 3 || styleText === 'SUCCESS' || styleText === 'GREEN';
}

// 🚫 أزرار واجهة لا علاقة لها بالانضمام/اللعب أبداً (v7.15 — بلاغ المالك:
// كان يضغط «حقيبتي» في بوت البادئة «.» بدل زر الدخول)
const UI_BUTTON_BLACKLIST = [
    'اخرج', 'انسحب', 'متجر', 'حقيبتي', 'محفظتي', 'الحقيبة', 'المحفظة',
    'معلومات', 'قوانين', 'القوانين', 'رصيد', 'نقاط', 'نقاطي', 'مساعدة',
    'تذكير', 'إحصائيات', 'احصائيات', 'حسابي', 'ملفي', 'الرئيسية', 'تحديث',
    'طرد مرتين', 'حالة', 'الترتيب', 'قائمة', 'شراء',
];

// ✅ أسماء انضمام صريحة — أولوية قصوى عندما توجد
const JOIN_LABELS = ['انضمام', 'انضم', 'الانضمام', 'دخول', 'الدخول', 'ادخل', 'اللعب', 'لعب'];

function isUiButton(button) {
    const label = String((button && button.label) || '');
    return UI_BUTTON_BLACKLIST.some(word => label.includes(word));
}

function isJoinLabeled(button) {
    const label = String((button && button.label) || '');
    return JOIN_LABELS.some(word => label.includes(word));
}

/**
 * اختيار زر الدخول الذكي (v7.15):
 *  1) زر باسم انضمام صريح → فوراً (لا تخمين)
 *  2) زر أخضر (SUCCESS) — عشوائي بين الخضر (تمويه محفوظ)
 *  3) أول زر متاح خارج القائمة السوداء (نمط Auto: أول زر = الدخول غالباً)
 */
function pickJoinButton(allButtons) {
    const enabled = (allButtons || []).filter(button => button && button.customId && !button.disabled);
    if (enabled.length === 0) return null;
    const joinLabeled = enabled.filter(isJoinLabeled);
    if (joinLabeled.length > 0) return joinLabeled[0];
    const greens = enabled.filter(button => isGreenButton(button) && !isUiButton(button));
    if (greens.length > 0) return greens[Math.floor(Math.random() * greens.length)];
    const candidates = enabled.filter(button => !isUiButton(button));
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
}

function collectButtons(message) {
    if (!message.components || message.components.length === 0) return [];
    return message.components.flatMap(row => row.components || [])
        .filter(button => button && button.customId && !button.disabled);
}

// 🧑 محاكاة البشر لدور الروليت — الأرقام المنقولة حرفياً من Auto roulettePlay
// (قابلة للضبط من الاختبارات فقط — ليس واجهة عامة)
const HUMAN_SIM = {
    skip     : 0.01,   // احتمال تخطي الدور (تردد بشري)
    minDelay : 800,
    maxDelay : 2500,
    extraProb: 0.10,   // احتمال تأخير أطول (تشتت/كتابة)
    extraMin : 3000,
    extraMax : 6000,
};

async function clickWithHumanDelay(message, button, minDelay = 1000, maxDelay = 2000) {
    // 🎲 التمويه البشري — نفس أرقام Auto: عشوائي بين 1000 و 2000ms
    const delayMs = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    await message.clickButton(button.customId);
    return { label: button.label || null, delayMs };
}

// ════════════════════════════════════════════════════════════
//  قاموس ريبلكا — منقول حرفياً من Auto replkaPlay.js
// ════════════════════════════════════════════════════════════

const REPLKA_DATA = {
    'أ': { human: 'أيوب',    animal: 'أسد',    plant: 'أناناس', object: 'أريكه',  country: 'أفغانستان' },
    'ب': { human: 'بسمة',    animal: 'بطة',    plant: 'برقوق',  object: 'باب',    country: 'بولندا' },
    'ت': { human: 'تامر',    animal: 'تمساح',  plant: 'تفاح',   object: 'تاج',    country: 'تونس' },
    'ث': { human: 'ثري',     animal: 'ثعلب',   plant: 'ثوم',    object: 'ثياب',   country: 'لا يوجد' },
    'ح': { human: 'حاتم',    animal: 'حوت',    plant: 'حرنكش',  object: 'حبر',    country: 'لا يوجد' },
    'ج': { human: 'جمال',    animal: 'جمل',    plant: 'جرجير',  object: 'جسر',    country: 'جورجيا' },
    'خ': { human: 'خالد',    animal: 'خروف',   plant: 'خس',     object: 'خاتم',   country: 'لا يوجد' },
    'د': { human: 'داليا',   animal: 'دب',     plant: 'دراق',   object: 'دبوس',   country: 'دنمارك' },
    'ذ': { human: 'ذبيان',   animal: 'ذباب',   plant: 'ذرة',    object: 'ذهب',    country: 'لا يوجد' },
    'ر': { human: 'رامي',    animal: 'راكون',  plant: 'رمان',   object: 'رمل',    country: 'رومانيا' },
    'ز': { human: 'زين',     animal: 'زرافة',  plant: 'زنجبيل', object: 'زجاجة',  country: 'زامبيا' },
    'س': { human: 'سامح',    animal: 'سنجاب',  plant: 'سمسم',   object: 'سيارة',  country: 'سوريا' },
    'ش': { human: 'شريف',    animal: 'شبل',    plant: 'شمام',   object: 'شباك',   country: 'شيلي' },
    'ص': { human: 'صابر',    animal: 'صرصور',  plant: 'صنوبر',  object: 'صندوق',  country: 'صومال' },
    'ض': { human: 'ضياء',    animal: 'ضبع',    plant: 'ضرم',    object: 'ضرس',    country: 'لا يوجد' },
    'ط': { human: 'طاهر',    animal: 'طاووس',  plant: 'طماطم',  object: 'طاولة',  country: 'لا يوجد' },
    'ظ': { human: 'ظاهر',    animal: 'ظبي',    plant: 'ظيان',   object: 'ظرف',    country: 'لا يوجد' },
    'ع': { human: 'عادل',    animal: 'عصفور',  plant: 'عنب',    object: 'علبة',   country: 'عمان' },
    'غ': { human: 'غيث',     animal: 'غراب',   plant: 'غدير',   object: 'غرفة',   country: 'غينيا' },
    'ف': { human: 'فارس',    animal: 'فهد',    plant: 'فراولة', object: 'فرن',    country: 'فلسطين' },
    'ق': { human: 'قاسم',    animal: 'قطة',    plant: 'قرنبيط', object: 'قلعة',   country: 'قطر' },
    'ك': { human: 'كامل',    animal: 'كلب',    plant: 'كيوي',   object: 'كتاب',   country: 'كوريا' },
    'ل': { human: 'لارا',    animal: 'لاما',   plant: 'ليمون',  object: 'لعبة',   country: 'لبنان' },
    'م': { human: 'مرام',    animal: 'ماعز',   plant: 'موز',    object: 'مقص',    country: 'مصر' },
    'ن': { human: 'ناصر',    animal: 'نمر',    plant: 'نعناع',  object: 'نظارة',  country: 'نيجيريا' },
    'ه': { human: 'هيثم',    animal: 'هدهد',   plant: 'هليون',  object: 'هاتف',   country: 'هولندا' },
    'و': { human: 'وسام',    animal: 'وطواط',  plant: 'ورس',    object: 'ورقة',   country: 'لا يوجد' },
    'ي': { human: 'ياسر',    animal: 'يعسوب',  plant: 'يانسون', object: 'يخت',    country: 'يمن' },
};

function mapReplkaType(arabicType) {
    switch (arabicType) {
        case 'اسم إنسان': return 'human';
        case 'حيوان':     return 'animal';
        case 'نبات':      return 'plant';
        case 'جماد':      return 'object';
        case 'دولة':      return 'country';
        default:          return null;
    }
}

function answerFromDictionary(letter, type) {
    const entry = REPLKA_DATA[letter];
    if (!entry) return null;
    const answer = entry[type];
    if (!answer || answer === 'لا يوجد') return null;
    return answer;
}

// ════════════════════════════════════════════════════════════
//  المعالجات — المنقول الحرفي
// ════════════════════════════════════════════════════════════

const EVENTS = [

    // ── زر: الضغط على الزر الأخضر عند تحديث رسالة «اضغط على الزر» ──
    // المنقول من: Zar/events/zarPlayUpdate.js
    {
        engineId: 'zar',
        name: 'zarPlayUpdate',
        trigger: 'messageUpdate',
        eventType: 'game_play',
        gameName: 'زر',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            if (!message.components || message.components.length === 0) return { handled: false };
            if (!message.content || !message.content.includes('اضغط على الزر')) return { handled: false };

            const allButtons = collectButtons(message);
            if (allButtons.length === 0) return { handled: false };

            const greenButton = allButtons.find(isGreenButton);
            if (!greenButton) return { handled: false };

            await message.clickButton(greenButton.customId);
            return {
                handled: true,
                type: 'game_play',
                result: 'play',
                gameName: 'زر',
                message: 'تم الضغط على الزر الأخضر في لعبة زر.',
                details: { buttonLabel: greenButton.label || null, buttonsCount: allButtons.length },
            };
        },
    },

    // ── زر: المسار الدقيق (نص زر أو ≥ 12 زراً + زر أخضر وحيد) ──
    // المنقول من: Zar/events/zarPlay.js
    {
        engineId: 'zar',
        name: 'zarPlay',
        trigger: 'messageUpdate',
        eventType: 'game_play',
        gameName: 'زر',
        async execute(message, client, ctx) {
            if (!message || !message.author || !message.author.bot) return { handled: false };
            const settings = ctx.settings || {};
            const zarChannel = settings.channel_id;
            if (zarChannel && message.channel && message.channel.id !== zarChannel) return { handled: false };

            const buttons = collectButtons(message);
            if (buttons.length === 0) return { handled: false };

            const text = textFromMessage(message);
            const hasZarText = text.includes('زر') || text.toLowerCase().includes('zar') || buttons.length >= 12;
            if (!hasZarText) return { handled: false };

            const greenButtons = buttons.filter(isGreenButton);
            if (greenButtons.length !== 1) return { handled: false };

            const targetButton = greenButtons[0];
            await message.clickButton(targetButton.customId);
            return {
                handled: true,
                type: 'game_play',
                result: 'play',
                gameName: 'زر',
                message: 'تم اكتشاف الزر الأخضر من رسالة Zar والضغط عليه.',
                details: { buttonLabel: targetButton.label || null, buttonStyle: targetButton.style, buttonsCount: buttons.length },
            };
        },
    },

    // ── كراسي: دخول اللوبي — إيمبد يحتوي «كراسي» + أول زر في الصف الأول ──
    // المنقول من: Karasi/events/karasiJoin.js
    {
        engineId: 'karasi',
        name: 'karasiJoin',
        trigger: 'messageCreate',
        eventType: 'game_join',
        gameName: 'كراسي',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            if (!message.embeds || message.embeds.length === 0) return { handled: false };

            const embed = message.embeds[0];
            const embedTexts = [];
            if (embed.title) embedTexts.push(embed.title);
            if (embed.description) embedTexts.push(embed.description);
            if (embed.fields) {
                for (const field of embed.fields) {
                    if (field.name) embedTexts.push(field.name);
                    if (field.value) embedTexts.push(field.value);
                }
            }
            if (embed.footer && embed.footer.text) embedTexts.push(embed.footer.text);
            if (embed.author && embed.author.name) embedTexts.push(embed.author.name);

            const hasGameName = embedTexts.some(text => text.includes('كراسي') || text.includes('الكراسي'));
            if (!hasGameName) return { handled: false };

            const components = message.components;
            if (!components || components.length === 0) return { handled: false };

            const jb = components[0].components[0];
            if (!jb) return { handled: false };

            await message.clickButton(jb.customId);
            return {
                handled: true,
                type: 'game_join',
                result: 'join',
                gameName: 'كراسي',
                message: 'تم دخول لعبة كراسي.',
            };
        },
    },

    // ── كراسي: جولة السحب — «اضغط على الزر» + زر عشوائي فوراً ──
    // المنقول من: Karasi/events/karasiPlay.js
    {
        engineId: 'karasi',
        name: 'karasiPlay',
        trigger: 'messageUpdate',
        eventType: 'game_play',
        gameName: 'كراسي',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            if (!message.components || message.components.length === 0) return { handled: false };
            if (!message.content || !message.content.includes('اضغط على الزر')) return { handled: false };

            const rows = message.components.filter(row => row && row.components && row.components.length > 0);
            if (rows.length === 0) return { handled: false };

            const randomRow = rows[Math.floor(Math.random() * rows.length)];
            const enabled = randomRow.components.filter(btn => btn && btn.customId && !btn.disabled);
            if (enabled.length === 0) return { handled: false };

            const rb = enabled[Math.floor(Math.random() * enabled.length)];
            await message.clickButton(rb.customId);
            return {
                handled: true,
                type: 'game_play',
                result: 'play',
                gameName: 'كراسي',
                message: 'بدأ الحساب التفاعل داخل جولة كراسي.',
                details: { buttonLabel: rb.label || null },
            };
        },
    },

    // ── ريبلكا: دخول اللوبي — إيمبد بعنوان «ريبلكا» بالضبط + أول زر ──
    // المنقول من: Replka/events/replkaJoin.js
    {
        engineId: 'replka',
        name: 'replkaJoin',
        trigger: 'messageCreate',
        eventType: 'game_join',
        gameName: 'ريبلكا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            if (!message.embeds || message.embeds.length === 0) return { handled: false };

            const embed = message.embeds[0];
            if (embed.title !== 'ريبلكا') return { handled: false };

            const components = message.components;
            if (!components || components.length === 0) return { handled: false };

            const jb = components[0].components[0];
            if (!jb) return { handled: false };

            await message.clickButton(jb.customId);
            return {
                handled: true,
                type: 'game_join',
                result: 'join',
                gameName: 'ريبلكا',
                message: 'تم دخول لعبة ريبلكا.',
            };
        },
    },

    // ── ريبلكا: سؤال الفئة والحرف — «<منشن> لديك **15 ثانية** لإرسال كلمة من فئة **X** تبدأ بـ **Y**» ──
    // المنقول من: Replka/events/replkaPlay.js — مع إضافة: إجابة ذكية اختيارية قبل القاموس
    {
        engineId: 'replka',
        name: 'replkaPlay',
        trigger: 'messageCreate',
        eventType: 'game_play',
        gameName: 'ريبلكا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            if (!message.content || !message.content.startsWith(`<@${client.user.id}>`)) return { handled: false };
            if (!message.content.includes('لديك **15 ثانية** لإرسال')) return { handled: false };

            const matches = message.content.match(/\*\*(.*?)\*\*/g);
            if (!matches) return { handled: false };

            const results = matches.map(match => match.replace(/\*\*/g, ''));
            const type = mapReplkaType(results[1]);
            const letter = results[2];
            if (!type || !letter) return { handled: false };

            // 🧠 الإجابة: الذكاء أولاً (إن سُمح) ثم القاموس المنقول حرفياً
            let answer = null;
            let source = null;
            const askAi = typeof ctx.answerWithAi === 'function' && ctx.settings && ctx.settings.ai_answers !== false;
            if (askAi) {
                answer = await ctx.answerWithAi({ category: results[1], letter }).catch(() => null);
                if (answer) source = 'ai';
            }
            if (!answer) {
                answer = answerFromDictionary(letter, type);
                if (answer) source = 'dictionary';
            }
            if (!answer) return { handled: false };

            // ⏱️ التوقيت البشري المنقول حرفياً: (طول الكلمة × 325) + 825ms
            const time = (answer.length * 325) + 825;
            if (typeof message.channel.sendTyping === 'function') {
                await message.channel.sendTyping().catch(() => {});
            }
            setTimeout(async () => {
                await message.channel.send(answer).catch(() => {});
            }, time);

            return {
                handled: true,
                type: 'game_play',
                result: 'play',
                gameName: 'ريبلكا',
                message: 'بدأ الحساب التفاعل داخل جولة ريبلكا.',
                details: { category: type, letter, answer, source },
            };
        },
    },

    // ── روليت: دور اللعب — «<منشن الوكيل>» + أزرار اللاعبين → استهداف عشوائي ──
    // المنقول من: Roulette/events/roulettePlay.js (كان مفقوداً في v7.14 —
    // لهذا كان الوكيل لا يضغط شيئاً عندما يحين دوره!) + بوابة جلسة حية (أكثر
    // أماناً من Auto لأن وكيلنا يشارك المحادثة — لا ضغط خارج لعبة انضم إليها)
    {
        engineId: 'roulette',
        name: 'roulettePlay',
        trigger: 'messageCreate',
        eventType: 'game_play',
        gameName: 'روليت',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            if (!message.components || message.components.length === 0) return { handled: false };

            const myId = client.user && client.user.id;
            if (!myId) return { handled: false };
            // الدور الحقيقي: الرسالة موجّهة للوكيل بذاتها (منشن في المحتوى)
            if (!message.content.includes(`<@${myId}>`) && !message.content.includes(`<@!${myId}>`)) {
                return { handled: false };
            }

            // 🛡️ بوابة الجلسة الحية — انضم أولاً وإلا لا حركة (كما في Auto بلا هذه البوابة
            // لأن حساباته مكرّسة، لكن وكيلنا يشارك القناة فنشدّد)
            const sessions = require('./sessions');
            const live = sessions.touchSession(ctx.agentId, message.guild.id);
            if (!live) return { handled: false };

            // الأزرار القابلة للعب — استبعاد انسحاب/واجهة (منقول من Auto + قائمتنا)
            const allButtons = message.components.flatMap(row => row.components || []);
            const playable = allButtons.filter(button => {
                if (!button || button.disabled || !button.customId) return false;
                const label = button.label || '';
                if (label.includes('انسحب') || label.includes('طرد مرتين')) return false;
                if (isUiButton(button)) return false;
                return true;
            });
            if (playable.length === 0) return { handled: false };

            // 🎯 استهداف عشوائي بين اللاعبين المتاحين (نسخة الوكيل الواحد من سلم Auto:
            // الغرباء أولاً — بلا حسابات شقيقة في المنصة أصلاً)
            const targetButton = playable[Math.floor(Math.random() * playable.length)];
            const strategyLog = `⚔️ [هجوم] استهداف لاعب: [${targetButton.label || 'بدون اسم'}]`;

            // 🔁 محاكاة بشرية — أرقام Auto حرفياً (800-2500ms + 10% تأخير أطول + 1% تخطي)
            if (Math.random() < HUMAN_SIM.skip) {
                return { handled: true, silent: true, result: 'skip', gameName: 'روليت', type: 'game_play', message: 'تخطي الدور (محاكاة بشرية)' };
            }
            let delay = Math.floor(Math.random() * (HUMAN_SIM.maxDelay - HUMAN_SIM.minDelay + 1)) + HUMAN_SIM.minDelay;
            if (Math.random() < HUMAN_SIM.extraProb) {
                delay += Math.floor(Math.random() * (HUMAN_SIM.extraMax - HUMAN_SIM.extraMin + 1)) + HUMAN_SIM.extraMin;
            }
            await new Promise(resolve => setTimeout(resolve, delay));
            await message.clickButton(targetButton.customId).catch(() => {});

            return {
                handled: true,
                type: 'game_play',
                result: 'play',
                gameName: 'روليت',
                message: strategyLog,
                details: { buttonLabel: targetButton.label || null, delayMs: delay, playableCount: playable.length },
            };
        },
    },

    // ── روليت: دخول اللوبي — إيمبد «روليت/العجلة» + زر دخول ذكي بتأخير بشري ──
    // المنقول من: Roulette/events/rouletteJoin.js — مع اختيار الأزرار الذكي (v7.15)
    {
        engineId: 'roulette',
        name: 'rouletteJoin',
        trigger: 'messageCreate',
        eventType: 'game_join',
        gameName: 'روليت',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };

            const myId = client.user && client.user.id;
            // رسالة موجّهة للوكيل (دوره) → ليست لوبي دخول — معالج الدور يتكفل بها
            if (myId && message.content && (message.content.includes(`<@${myId}>`) || message.content.includes(`<@!${myId}>`))) {
                return { handled: false };
            }

            const allTexts = [];
            if (message.content) allTexts.push(message.content);
            if (message.embeds && message.embeds.length > 0) {
                const embed = message.embeds[0];
                const embedData = embed.data || embed;
                if (embedData.title) allTexts.push(embedData.title);
                if (embedData.description) allTexts.push(embedData.description);
            }

            const hasGameName = allTexts.some(text => text.includes('روليت') || text.includes('العجلة'));
            if (!hasGameName) return { handled: false };

            if (!message.components || message.components.length === 0) return { handled: false };

            const allButtons = message.components.flatMap(row => row.components || []);
            const targetButton = pickJoinButton(allButtons);
            if (!targetButton) return { handled: false };

            const clicked = await clickWithHumanDelay(message, targetButton);
            return {
                handled: true,
                type: 'game_join',
                result: 'join',
                gameName: 'روليت',
                message: `تم الدخول بالزر: ${targetButton.label}`,
                details: { buttonLabel: clicked.label, delayMs: clicked.delayMs, availableCount: allButtons.length },
            };
        },
    },
];

// ════════════════════════════════════════════════════════════
//  نسختا «الانضمام المميز» — منقولتان كاملتان لكن معطلتان افتراضياً
//  (Karasi/premiumJoin + Replka/premiumJoin): عند أي رسالة تحوي اسم
//  اللعبة تفحص آخر 10 رسائل وتنقر أزرار أي بوت. في Auto تعمل دائماً —
//  هنا خيار premium_join لكل محرك لأن وكيلنا يشارك المحادثة العادية.
// ════════════════════════════════════════════════════════════

function premiumJoinEvent({ engineId, gameName, keyword }) {
    return {
        engineId,
        name: `${engineId}PremiumJoin`,
        trigger: 'messageCreate',
        eventType: 'game_join',
        gameName,
        premium: true, // يعمل فقط عندما premium_join: true في إعدادات المحرك
        async execute(message, client, ctx) {
            if (!message.content || !message.content.includes(keyword)) return { handled: false };

            const collect = async (msg) => {
                const button = msg.components?.[0]?.components?.[0];
                if (button && button.type === 'BUTTON') {
                    await msg.clickButton(button.customId);
                    return true;
                }
                return false;
            };

            // 1) انتظار رسالة لوبي قادمة خلال 5 ثوان (كما في Auto)
            let joined = false;
            const collector = message.channel.createMessageCollector
                ? message.channel.createMessageCollector({ filter: (msg) => msg.author && msg.author.bot && msg.components && msg.components.length > 0, time: 5000 })
                : null;
            if (collector) {
                collector.on('collect', async (msg) => {
                    if (await collect(msg)) {
                        joined = true;
                        collector.stop();
                    }
                });
            }

            // 2) فحص آخر 10 رسائل فوراً (كما في Auto)
            const messages = await message.channel.messages.fetch({ limit: 10 }).catch(() => null);
            if (messages) {
                for (const msg of messages.values()) {
                    if (msg.author && msg.author.bot && msg.components && msg.components.length > 0) {
                        if (await collect(msg)) { joined = true; break; }
                    }
                }
            }

            if (!joined) return { handled: false };
            return {
                handled: true,
                type: 'game_join',
                result: 'join',
                gameName,
                message: `تم دخول لعبة ${gameName} من رسالة مميزة.`,
                details: { premium: true },
            };
        },
    };
}

EVENTS.push(premiumJoinEvent({ engineId: 'karasi', gameName: 'كراسي', keyword: 'كراسي' }));
EVENTS.push(premiumJoinEvent({ engineId: 'replka', gameName: 'ريبلكا', keyword: 'ريبلكا' }));

function eventsForTrigger(trigger) {
    return EVENTS.filter(event => event.trigger === trigger);
}

module.exports = {
    EVENTS,
    eventsForTrigger,
    textFromMessage,
    isGreenButton,
    isUiButton,
    isJoinLabeled,
    pickJoinButton,
    collectButtons,
    HUMAN_SIM,
    REPLKA_DATA,
    mapReplkaType,
    answerFromDictionary,
};
