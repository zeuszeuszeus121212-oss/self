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

const sessions = require('./sessions');
const social = require('./social');
const mafia = require('./mafia');
const brain = require('./brain'); // 🧠 v7.21 — العقل يقرر بنفسه كإنسان

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

/** مطابقة زر باسمه (قرار الذكاء يعيد اسم الزر — نلصقه بالزر الحقيقي) */
function matchButtonLabel(allButtons, label) {
    const want = sessions.normalizeName(label);
    if (!want) return null;
    return (allButtons || []).find(b => sessions.normalizeName(String(b.label || '')) === want) || null;
}

function collectButtons(message) {
    if (!message.components || message.components.length === 0) return [];
    return message.components.flatMap(row => row.components || [])
        .filter(button => button && button.customId && !button.disabled);
}

// 🧑 توقيت بشري لدور الروليت — تأخير طبيعي فقط.
// 🚫 v7.21 حُذف skip العشوائي (بلاغ المالك: «كله كاذب... انا أردت الذكاء
// الاصطناعي نفسه» — تخطي الدور عشوائياً وليس بقرار الذكاء = تمثيل مزيّف).
const HUMAN_SIM = {
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
    try {
        await message.clickButton(button.customId);
    } catch (error) {
        // 🐞 v7.20 (بلاغ المالك: «وليت بعض الأحيان دخل»): فشل نقرة واحدة كان
        // يُسقط المعالج كله بلا انضمام ولا إعادة محاولة — الزر قد يتأخر تحديثه
        // لحظة. محاولة ثانية بعد 700ms — وإن فشلت ينتشر الخطأ ليُسجل مرئياً.
        await new Promise(resolve => setTimeout(resolve, 700));
        await message.clickButton(button.customId);
    }
    return { label: button.label || null, delayMs };
}

// ════════════════════════════════════════════════════════════
//  🚫 v7.21 حُذف قاموس ريبلكا المبرمج كلياً (بلاغ المالك الحرفي:
//  «كله كاذب... انا أردت الذكاء الاصطناعي نفسه لكنك عملت تعليقات
//  وهمية؟ احذفهم!») — 33 إجابة جاهزة كانت تجيب بدل عقل الوكيل.
//  الإجابة من الذكاء حصراً — فشله = لا إجابة + تبليغ مرئي.
// ════════════════════════════════════════════════════════════

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
            if (!message.content.includes('لديك') || !message.content.includes('لإرسال')) return { handled: false }; // 🧠 v7.21: صيغة عامة — أي مهلة

            const matches = message.content.match(/\*\*(.*?)\*\*/g);
            if (!matches) return { handled: false };

            const results = matches.map(match => match.replace(/\*\*/g, ''));
            const category = results[1];
            const letter = results[2];
            if (!category || !letter) return { handled: false };

            // 🚫 v7.21: الذكاء حصراً (بلاغ المالك: «انا أردت الذكاء الاصطناعي نفسه»)
            // — حُذف القاموس المبرمج نهائياً؛ فشل الذكاء = لا إجابة + تبليغ مرئي
            let answer = null;
            const askAi = typeof ctx.answerWithAi === 'function' && ctx.settings && ctx.settings.ai_answers !== false;
            if (askAi) {
                answer = await ctx.answerWithAi({ category, letter }).catch(() => null);
            }
            if (!answer) {
                social.notifyAiFail(ctx.agentId, 'إجابة ريبلكا', `لا إجابة من الذكاء (${category} — ${letter})`);
                return { handled: false };
            }

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
                message: 'أجاب بعقله على سؤال ريبلكا',
                details: { category, letter, answer, source: 'ai' },
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
            // 🐞 v7.20 (بلاغ المالك: «لاه لا يلعب لا يستطيع الطرد اصلا»): الفحص كان
            // على message.content فقط — منشن داخل الإيمبد لا يُرى أبداً فلا يلعب
            // حتى عندما ينضم! الآن النص الكامل (محتوى + كل أجزاء الإيمبد).
            const fullTurnText = textFromMessage(message);
            if (!fullTurnText.includes(`<@${myId}>`) && !fullTurnText.includes(`<@!${myId}>`)) {
                return { handled: false };
            }

            // 🛡️ بوابة الجلسة الحية — انضم أولاً وإلا لا حركة (كما في Auto بلا هذه البوابة
            // لأن حساباته مكرّسة، لكن وكيلنا يشارك القناة فنشدّد)
            const sessions = require('./sessions');
            const live = sessions.touchSession(ctx.agentId, message.guild.id);
            if (!live) return { handled: false };

            // 🎯 استهداف — الوضع الذكي (v7.16 بلاغ المالك: «وضع الذكاء الاصطناعي
            // هو من يختار يطرد ووضع تلقائي وهو الحالي من النظام»):
            // mode === 'ai'  → الذكاء يختار الضحية بالسياق (فشل الذكاء → عشوائي)
            // mode === 'auto' → عشوائي بين اللاعبين المتاحين (نمط Auto كما كان)
            const allButtons2 = message.components.flatMap(row => row.components || []);
            const playable = allButtons2.filter(button => {
                if (!button || button.disabled || !button.customId) return false;
                const label = button.label || '';
                if (label.includes('انسحب') || label.includes('طرد مرتين')) return false;
                if (isUiButton(button)) return false;
                return true;
            });
            if (playable.length === 0) return { handled: false };

            let targetButton = null;
            let strategySource = 'random';
            // 🧠 v7.18: القرار دائماً بعقل الوكيل — العشوائي احتياط فشل فقط
            // (كان مقيّداً بوضع «ذكي» فيبدو التلقائي كأنه لا يختار)
            targetButton = await mafia.decideKick({
                runtimeSettings: ctx.runtimeSettings,
                agentName: ctx.agentName,
                session: live,
                candidates: playable,
            }).catch(() => null);
            if (targetButton) strategySource = 'ai';
            if (!targetButton) {
                targetButton = playable[Math.floor(Math.random() * playable.length)];
            }
            const strategyLog = strategySource === 'ai'
                ? `⚔️ [هجوم ذكي] استهداف لاعب: [${targetButton.label || 'بدون اسم'}]`
                : `⚔️ [هجوم] استهداف لاعب: [${targetButton.label || 'بدون اسم'}]`;

            // 🔁 توقيت بشري — أرقام Auto حرفياً (800-2500ms + 10% تأخير أطول)
            // 🚫 v7.21: حُذف skip العشوائي — تخطي الدور بغير قرار الذكاء = تمثيل مزيّف
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
                details: { buttonLabel: targetButton.label || null, delayMs: delay, playableCount: playable.length, source: strategySource },
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
//  🕵️ المافيا (v7.16) — بلاغ المالك: «اريد اكون مافيا... يلعن حظوظة
//  ان كان مواطن... يترجى ان لا يتم قتله... يقول احميني... يندب القاتل
//  و توعد باخذ حقه... يراقب ان هذا الشخص لم يتكلم طوال الجولة فيشك فيه»
//
//  كل معالج: باب جلسة حية (إلا اللوبي الذي ينشئها) + كلام اجتماعي
//  بالاحتمالات (قاعدة صمت المافيا داخل social.effectiveChance).
// ════════════════════════════════════════════════════════════

// 🚫 v7.21 حُذف «حارس التصويت» نهائياً (سؤال المالك الحرفي: «ولماذا يوجد حارس
// تصويت اصلا؟») — قوائم كلمات مبرمجة كانت ترفض رسائل أو تسمح لها بدل عقل الوكيل.
// من اليوم: النص الحرفي يُمرَّر للذكاء وهو يقرر كإنسان — انضم أو صوّت أو تجاهل.

// رسائل التصويت — استبعاد رسالة النقاش التي تحمل «للتحقق بين»
const VOTE_TEXT = /اختيار\s*شخص\s*لطرد|للتصويت\s*على\s*طرد|تصويت\s*على\s*طرد|اختر\s*شخصا\s*لطرد|طرد\s*من\s*اللعبة/;

// 🗳️ v7.19 — بلاغ المالك: «لا يستطيع اللعب مثلا تصويت على طرد في جولة التصويت»:
// الكشف كان مقفولاً على خمس صيغ حرفية — أي صياغة غير متوقعة من بوت اللعبة
// = لا تصويت أبداً. الآن: الكلمات المفتاحية العامة للطرد/التصويت تكفي
// (وتتطلب مرشحين حقيقيين على الأزرار قبل التحرّك)
const VOTE_HINT = /(طرد|تصويت|أصوت|اصوت|صوتوا|صوّتوا|أصوات|اصوات|صوتك|اقتصاص|محاكمة|إعدام|إعدام|حكم على)/;

function looksLikeVote(text) {
    const n = sessions.normalizeName(text);
    if (!n) return false;
    if (n.includes(sessions.normalizeName('للتحقق بين اللاعبين'))) return false; // النقاش ليس تصويتاً
    if (VOTE_TEXT.test(n)) return true;
    return VOTE_HINT.test(n);
}

/**
 * 🗳️ v7.19 — قراءة عدّاد التصويت من أسماء الأزرار بعد التعديل:
 * «خالد (2)» / «خالد - 2» / «خالد: 2» / «خالد ٢» — الأرقام العربية مدعومة.
 * هذا سبب «لا يعرف من صوت على من» — العدّاد كان يضيع نصاً خاماً.
 */
const ARABIC_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };
function toWesternDigits(text) {
    return String(text || '').replace(/[٠-٩]/g, d => ARABIC_DIGITS[d] || d);
}
function parseVoteLabel(label) {
    const clean = toWesternDigits(String(label || '')).replace(/[*_`~|]/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return null;
    const m = clean.match(/^(.+?)\s*[\(\[\{\-—–:]\s*(\d{1,3})\s*[\)\]\}]?$/) || clean.match(/^(.+?)\s+(\d{1,3})$/);
    if (!m) return { name: clean, count: null };
    const name = m[1].trim();
    if (!name || name.length < 2) return null;
    return { name, count: Number(m[2]) || 0 };
}

/** سجّل أصوات رسالة التصويت الحالية في ذاكرة الجلسة + سجل الوعي */
function recordVoteTally(agentId, guildId, message) {
    const allButtons = collectButtons(message);
    let updated = 0;
    const seen = new Set();
    for (const button of allButtons) {
        const parsed = parseVoteLabel(button.label || '');
        if (!parsed || !parsed.name || seen.has(parsed.name)) continue;
        seen.add(parsed.name);
        sessions.mafiaSetVote(agentId, guildId, parsed.name, parsed.count === null ? undefined : parsed.count);
        updated += 1;
    }
    if (updated) {
        const session = sessions.getSession(agentId, guildId);
        if (session?.mafia?.voteCounts?.size) {
            const tally = [...session.mafia.voteCounts.entries()]
                .map(([name, count]) => `${name} (${count})`).join('، ');
            sessions.pushEvent(agentId, guildId, `لوحة الأصوات الآن: ${tally}`);
        }
    }
    return updated;
}

// منع تصويت مزدوج لنفس رسالة التصويت (تتعدّل العدّاد فيرسل messageUpdate)
const votedMessages = new Set();
const MAX_VOTED = 500;

function rememberVoted(messageId) {
    if (!messageId) return;
    votedMessages.add(messageId);
    if (votedMessages.size > MAX_VOTED) {
        const oldest = votedMessages.values().next().value;
        votedMessages.delete(oldest);
    }
}

function mafiaSession(ctx, message) {
    const session = sessions.touchSession(ctx.agentId, message.guild.id);
    if (!session || session.engineId !== 'mafia') return null;
    return session;
}

function collectMentions(message) {
    try {
        const users = message.mentions?.users;
        if (!users) return [];
        return [...users.values()].map(user => ({
            id: String(user.id),
            name: user.globalName || user.username || String(user.id),
        }));
    } catch (_) {
        return [];
    }
}

/**
 * 🐞 v7.18 — لاعبو اللوبي الحقيقيون بأسمائهم: كان الاعتماد على
 * message.mentions وحدها، ومنشنات الإيمبد لا تدخل فيها أصلاً (نفس جذر
 * «يحسب انه البوت الذي فاز») — فكانت أسماء اللاعبين في الجولة تضيع كلياً
 * (بلاغ المالك: «لا يتم ارسال اسماء اللاعبين في الجولة»). الآن نمسح نص
 * الرسالة كاملاً (content + كل أجزاء الإيمبد) بـ regex ونحلل الأسماء.
 */
async function extractPlayerMentions(message) {
    try {
        const ids = new Set();
        // 1) المنشنات الرسمية (content) — المصدر الأصلي
        try {
            for (const u of (message.mentions?.users?.values?.() || [])) ids.add(String(u.id));
            for (const mem of (message.mentions?.members?.values?.() || [])) ids.add(String(mem.id ?? mem.user?.id));
        } catch (_) {}
        // 2) 🐞 منشنات الإيمبد — لا تصل message.mentions أصلاً (نفس جذر
        // «يحسب انه البوت الذي فاز») — نمسح نص الرسالة كاملاً بـ regex
        const fullText = `${textFromMessage(message)}\n${String(message.content || '')}`;
        const re = /<@!?(\d{5,25})>/g;
        let m;
        while ((m = re.exec(fullText)) !== null) ids.add(m[1]);
        if (!ids.size) return [];
        const out = [];
        for (const id of ids) {
            let name = null;
            const mentioned = message.mentions?.users?.get(id)
                || message.mentions?.members?.get(id)?.user;
            if (mentioned) name = mentioned.globalName || mentioned.username;
            if (!name && message.guild?.members?.fetch) {
                const member = await message.guild.members.fetch(id).catch(() => null);
                if (member) name = member.displayName || member.user?.username || null;
            }
            if (!name) {
                const cached = message.client?.users?.cache?.get(id);
                if (cached) name = cached.globalName || cached.username;
            }
            if (name) out.push({ id, name });
        }
        return out;
    } catch (_) {
        return [];
    }
}

/** اسم أزرار التصويت → سجلهم لاعبين (يقرأهم الذكاء لاحقاً) */
function registerNamePlayers(session, buttons) {
    for (const button of buttons || []) {
        const label = String(button.label || '').trim();
        if (!label || label.length < 2) continue;
        const exists = [...session.mafia.players.values()]
            .some(p => sessions.normalizeName(p.name) === sessions.normalizeName(label));
        if (!exists) {
            const pseudoId = `name:${sessions.normalizeName(label)}`;
            session.mafia.players.set(pseudoId, { name: label, talks: 0, alive: true });
            session.players.add(pseudoId);
        }
    }
}

const MAFIA_EVENTS = [

    // ── لوبي المافيا: «يعرف من يلعب معه بالضبط وكذلك العدد» (بلاغ المالك) ──
    {
        engineId: 'mafia',
        name: 'mafiaJoin',
        trigger: 'messageCreate',
        eventType: 'game_join',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            const myId = client.user && client.user.id;
            const text = [message.content, ...(message.embeds || []).map(e => [e.title, e.description].filter(Boolean).join(' '))].filter(Boolean).join(' ');
            if (!text || !text.includes('مافيا')) return { handled: false };
            // رسالة موجّهة للوكيل (دور/نتيجة) ليست لوبي
            if (myId && (text.includes(`<@${myId}>`) || text.includes(`<@!${myId}>`))) return { handled: false };

            // 🧼 v7.20: حارس الجلسة الحية حُذف — المُميّز الهيكلي (زر الانضمام
            // الصريح) يكفي وحده: اللوبي له زر انضمام فيُقبل حتى لو سبقتنا جولة
            // قديمة (تُستبدل)، ورسائل التصويت بلا زر انضمام فلا تُفهم لوبياً أبداً.

            // نصوص المراحل ليست لوبي — 🩺 v7.20: إلا إذا كان بيسمها زر انضمام صريح
            // (الإشارة الهيكلية تتقدم على اللفظية — زر «انضمام» يعني لوبي دائماً)

            const allButtons = collectButtons(message);
            if (allButtons.length === 0) return { handled: false };
            const explicitJoinBtn = allButtons.find(isJoinLabeled);

            // 🧠 v7.21 (بلاغ المالك: «طلبت فقط أن يتم تمرير له رسائل الالعاب ويستطيع
            // هو التصرف والتعليق والكلام ويعرف اللعبة وكأنه بشري»):
            //  • زر انضمام صريح → لوبي واضح، انضمام فوري هيكلياً (سرعة سباق اللوبيات)
            //  • بلا زر انضمام → النص + الأزرار تُمرَّر للذكاء وهو يقرر بنفسه:
            //    لوبي فينضم / تصويت فيتجاهله هنا (معالج التصويت يتكفل) / مرحلة فيتجاهل
            //  • فشل الذكاء → لا ضغط أعمى (لا تخمين مزيّف) — والتشخيص المرئي يعلن السبب
            let targetButton = explicitJoinBtn || null;
            let decision = null;
            if (!targetButton) {
                decision = await brain.decide({
                    runtimeSettings: ctx.runtimeSettings,
                    agentName: ctx.agentName,
                    scene: { text, buttons: allButtons.map(b => ({ label: b.label })), hint: 'رسالة من بوت المافيا — هل هذا لوبي تنضم إليه أم شيء آخر؟' },
                });
                if (!decision || decision.act === 'none') return { handled: false };
                if (decision.act === 'join' || decision.act === 'click') {
                    const chosen = decision.button
                        ? (matchButtonLabel(allButtons, decision.button) || pickJoinButton(allButtons))
                        : pickJoinButton(allButtons);
                    if (!chosen) return { handled: false };
                    targetButton = chosen;
                } else {
                    return { handled: false };
                }
            }

            const clicked = await clickWithHumanDelay(message, targetButton);
            // 🗣️ v7.21: تعليق قرار الذكاء نفسه (say) — نصه حرفياً بلا توليد ثانٍ
            if (decision && decision.say) {
                void social.sendText({ client, channel: message.channel, agentId: ctx.agentId,
                    guildId: message.guild.id, text: decision.say, kind: 'join_say' }).catch(() => {});
            }
            // 🐞 v7.18: الأسماء من الإيمبد نفسه — لا من message.mentions فقط
            const players = await extractPlayerMentions(message);
            return {
                handled: true,
                type: 'game_join',
                result: 'join',
                gameName: 'مافيا',
                message: `تم دخول لعبة المافيا بالزر: ${targetButton.label}`,
                details: {
                    buttonLabel: clicked.label,
                    delayMs: clicked.delayMs,
                    players,
                    // 🧠 v7.18: معرف اللوبي — نتبع تعديله حين ينضم باقي اللاعبين
                    lobbyMessageId: message.id || null,
                    // 🧠 «رسالة اللوبي نفسها يتم إرسالها للوكيل ومع الأعضاء عضو عضو وعددهم»
                    lobbyText: text.slice(0, 900),
                },
            };
        },
    },

    // ── 🧠 v7.18: تعديل رسالة اللوبي — اللاعبون ينضمون بعد انضمامنا فتُعدّل
    // رسالة اللوبي بقائمة موسعة. بلا هذا المعالج كانت قائمة الأسماء تُجمَد على
    // من كان موجوداً لحظة ضغطنا فقط (بلاغ المالك: «لا يتم ارسال اسماء اللاعبين في الجولة»)
    {
        engineId: 'mafia',
        name: 'mafiaLobbyUpdate',
        trigger: 'messageUpdate',
        eventType: 'game_play',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            const session = mafiaSession(ctx, message);
            if (!session) return { handled: false };
            if (!session.lobbyMessageId || String(session.lobbyMessageId) !== String(message.id)) return { handled: false };

            const players = await extractPlayerMentions(message);
            if (!players.length) return { handled: true, silent: true, result: 'lobby_update', type: 'game_play', gameName: 'مافيا', message: 'تحديث اللوبي — لا منشنات بعد', details: {} };

            const before = session.mafia.players.size;
            sessions.mafiaSetPlayers(ctx.agentId, message.guild.id, players);
            const lobbyText = textFromMessage(message);
            if (lobbyText) sessions.setLobbyText(ctx.agentId, message.guild.id, lobbyText);
            const added = session.mafia.players.size - before;
            if (added > 0) {
                sessions.pushEvent(ctx.agentId, message.guild.id,
                    `تحديث اللوبي: انضم ${added} لاعباً جديداً — المجموع الآن ${session.mafia.players.size}`);
            }

            return {
                handled: true,
                silent: true,
                result: 'lobby_update',
                type: 'game_play',
                gameName: 'مافيا',
                message: `تحديث اللوبي — اللاعبون الآن ${session.mafia.players.size}`,
                details: { players: players.map(p => p.name) },
            };
        },
    },

    // ── توزيع الرتب: «يقول مثلا اريد اكون مافيا او يلعن حظوظة ان كان مواطن» ──
    {
        engineId: 'mafia',
        name: 'mafiaRoles',
        trigger: 'messageCreate',
        eventType: 'game_play',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            const text = textFromMessage(message);
            if (!text.includes('توزيع الرتب') && !text.includes('تم توزيع') && !text.includes('ستبدأ الجولة')) return { handled: false };
            const session = mafiaSession(ctx, message);
            if (!session) return { handled: false };

            sessions.mafiaSetPhase(ctx.agentId, message.guild.id, 'roles');
            // 🧠 الوعي (v7.17)
            sessions.pushEvent(ctx.agentId, message.guild.id, 'بدأ توزيع الرتب — الجولة الأولى قادمة');

            // رد الفعل على الدور — صمت المافيا ينطبق على التمني أيضاً
            const role = session.mafia.role;
            const kind = role ? `role_${role}` : 'role_generic';
            const eventLine = role === 'mafia' ? 'صار دورك مافيا وانت متحمس'
                : role === 'citizen' ? 'صار دورك مواطن وتلعن حظك'
                : role === 'doctor' ? 'صار دورك طبيب المافيا'
                : role === 'detective' ? 'صار دورك محقق المافيا'
                : 'تم توزيع الأدوار — تمنّى أن تكون مافيا';
            social.maybeSpeak({
                settings: ctx.settings, session, kind,
                probability: social.effectiveChance(session, 'role_react', social.CHANCES.role_react),
                client, channel: message.channel, agentId: ctx.agentId, guildId: message.guild.id,
                eventLine,
                runtimeSettings: ctx.runtimeSettings, agentName: ctx.agentName, session,
            });

            return { handled: true, silent: true, result: 'phase', gameName: 'مافيا', type: 'game_play', message: 'توزيع الرتب — بدأت المافيا', details: { role: role || null } };
        },
    },

    // ── ليل القتل: «🔪 جاري انتظار المافيا لاختيار شخص لقتله» → يرجى ألا يُقتل ──
    {
        engineId: 'mafia',
        name: 'mafiaNightKill',
        trigger: 'messageCreate',
        eventType: 'game_play',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            const text = textFromMessage(message);
            const isNight = (text.includes('انتظار المافيا') || text.includes('دور المافيا'))
                && (text.includes('قتله') || text.includes('يقتل') || text.includes('قتل شخص'));
            if (!isNight) return { handled: false };
            const session = mafiaSession(ctx, message);
            if (!session) return { handled: false };

            sessions.mafiaSetPhase(ctx.agentId, message.guild.id, 'night_kill');
            // 🧠 الوعي (v7.17)
            sessions.pushEvent(ctx.agentId, message.guild.id, 'الليل: المافيا ستختار ضحية');

            // 🗳️ v7.19: البطاقة الظاهرة بالقناة مع أزرار اختيار؟ نختار فعلاً —
            // كان معالج الطور يستهلك الرسالة بـ break فلا أحد يختار أبداً
            // («طرد اذا كان مافيا» — بلاغ المالك: لا يختار هو اصلا)
            let choiceResult = null;
            try {
                choiceResult = await mafia.handleSecretMessage({
                    client, message, agentId: ctx.agentId,
                    runtimeSettings: ctx.runtimeSettings,
                    settings: ctx.settings,
                    agentName: ctx.agentName,
                    session, guildId: message.guild.id,
                    allowVisible: true,
                });
            } catch (_) { choiceResult = null; }
            if (choiceResult && choiceResult.handled) return choiceResult;

            // المافيا لا ترجى أثناء دورها — هي من يقتل
            if (session.mafia.role !== 'mafia') {
                social.maybeSpeak({
                    settings: ctx.settings, session, kind: 'beg',
                    probability: social.effectiveChance(session, 'beg', social.CHANCES.beg),
                    client, channel: message.channel, agentId: ctx.agentId, guildId: message.guild.id,
                    eventLine: 'المافيا ستختار ضحية الليلة — رجاء ألا تكون أنت الضحية',
                    runtimeSettings: ctx.runtimeSettings, agentName: ctx.agentName, session,
                });
            }

            return { handled: true, silent: true, result: 'phase', gameName: 'مافيا', type: 'game_play', message: 'ليل القتل — المافيا تختار', details: {} };
        },
    },

    // ── دور الطبيب: «💊 جاري انتظار الطبيب لاختيار شخص لحمايته» → «احميني؟» ──
    {
        engineId: 'mafia',
        name: 'mafiaNightSave',
        trigger: 'messageCreate',
        eventType: 'game_play',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            const text = textFromMessage(message);
            const isSave = (text.includes('انتظار الطبيب') || text.includes('دور الطبيب'))
                && (text.includes('حمايته') || text.includes('حماية') || text.includes('يحمي'));
            if (!isSave) return { handled: false };
            const session = mafiaSession(ctx, message);
            if (!session) return { handled: false };

            sessions.mafiaSetPhase(ctx.agentId, message.guild.id, 'night_save');
            // 🧠 الوعي (v7.17)
            sessions.pushEvent(ctx.agentId, message.guild.id, 'الليل: الطبيب سيختار من يحميه');

            // 🗳️ v7.19: بطاقة الطبيب الظاهرة بالقناة مع أزرار؟ نختار فعلاً (نفس جذر المافيا)
            let saveChoiceResult = null;
            try {
                saveChoiceResult = await mafia.handleSecretMessage({
                    client, message, agentId: ctx.agentId,
                    runtimeSettings: ctx.runtimeSettings,
                    settings: ctx.settings,
                    agentName: ctx.agentName,
                    session, guildId: message.guild.id,
                    allowVisible: true,
                });
            } catch (_) { saveChoiceResult = null; }
            if (saveChoiceResult && saveChoiceResult.handled) return saveChoiceResult;

            // الطبيب هو من يختار — لا يطلب حماية لنفسه
            if (session.mafia.role !== 'doctor') {
                social.maybeSpeak({
                    settings: ctx.settings, session, kind: 'ask_protect',
                    probability: social.effectiveChance(session, 'ask_protect', social.CHANCES.ask_protect),
                    client, channel: message.channel, agentId: ctx.agentId, guildId: message.guild.id,
                    eventLine: 'الطبيب سيختار من يحميه الليلة — اطلب الحماية أو اشك في لاعب',
                    runtimeSettings: ctx.runtimeSettings, agentName: ctx.agentName, session,
                });
            }

            return { handled: true, silent: true, result: 'phase', gameName: 'مافيا', type: 'game_play', message: 'ليل الحماية — الطبيب يختار', details: {} };
        },
    },

    // ── إعلان القتل: «⚰️ نجحت عملية المافيا وتم قتل <@X> وهذا الشخص كان مواطن» ──
    // الميكانيكا فقط (تسجيل القتيل) — الندبة/التعليق في social.observeBotMessage
    {
        engineId: 'mafia',
        name: 'mafiaKillAnnounce',
        trigger: 'messageCreate',
        eventType: 'game_play',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            const text = textFromMessage(message);
            const isKill = /تم\s*قتل/.test(text) && (text.includes('مافيا') || text.includes('نجحت'));
            if (!isKill) return { handled: false };
            const session = mafiaSession(ctx, message);
            if (!session) return { handled: false };

            sessions.mafiaSetPhase(ctx.agentId, message.guild.id, 'day');
            const match = text.match(/<@!?(\d+)>/);
            const victimId = match ? match[1] : null;
            if (victimId) sessions.mafiaMarkDead(ctx.agentId, message.guild.id, victimId);
            // ⚰️ v7.19: القتيل هو الوكيل نفسه؟ خارج اللعبة — لا تصويت ولا حركات بعد اليوم
            if (victimId && String(session.me?.id || '') === String(victimId)) {
                sessions.mafiaMarkMeDead(ctx.agentId, message.guild.id);
                sessions.pushEvent(ctx.agentId, message.guild.id, 'قتلتك المافيا — أنت متفرج الآن');
            }
            // 🧠 الوعي (v7.17) — باسم القتيل إن عرفناه
            const victimPlayer = victimId ? session.mafia.players.get(victimId) : null;
            sessions.pushEvent(ctx.agentId, message.guild.id,
                `قتلت المافيا ${victimPlayer ? `«${victimPlayer.name}»` : (victimId ? `لاعباً (${victimId})` : 'لاعباً')}`);

            return { handled: true, silent: true, result: 'phase', gameName: 'مافيا', type: 'game_play', message: 'إعلان قتيل المافيا', details: { victimId } };
        },
    },

    // ── نقاش النهار: «🔍 لديكم 15 ثانية للتحقق بين اللاعبين...» → رأي وشكّ ──
    {
        engineId: 'mafia',
        name: 'mafiaDiscuss',
        trigger: 'messageCreate',
        eventType: 'game_play',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            const text = textFromMessage(message);
            const isDiscuss = text.includes('للتحقق بين اللاعبين')
                || (text.includes('التحقق') && text.includes('المافيا') && text.includes('ثانية'));
            if (!isDiscuss) return { handled: false };
            const session = mafiaSession(ctx, message);
            if (!session) return { handled: false };

            sessions.mafiaSetPhase(ctx.agentId, message.guild.id, 'day_discuss');
            // 🧠 الوعي (v7.17)
            sessions.pushEvent(ctx.agentId, message.guild.id, 'نقاش النهار: بدأ التحقق والشك بين اللاعبين');

            // «يراقب ان هذا الشخص لم يتكلم طوال الجولة فيشك فيه»
            const silentPlayers = [...session.mafia.players.values()]
                .filter(p => p.alive && (p.talks || 0) === 0)
                .map(p => p.name);
            const eventLine = silentPlayers.length
                ? `نقاش النهار — هؤلاء صامتون طوال الجولة: ${silentPlayers.slice(0, 3).join('، ')} — اشك بهم واعطِ رأيك`
                : 'نقاش النهار — شارك رأيك: من تشك أنه مافيا؟';
            social.maybeSpeak({
                settings: ctx.settings, session, kind: 'suspect',
                probability: social.effectiveChance(session, 'suspect', social.CHANCES.suspect),
                client, channel: message.channel, agentId: ctx.agentId, guildId: message.guild.id,
                eventLine,
                runtimeSettings: ctx.runtimeSettings, agentName: ctx.agentName, session,
            });

            return { handled: true, silent: true, result: 'phase', gameName: 'مافيا', type: 'game_play', message: 'نقاش النهار', details: { silentPlayers: silentPlayers.length } };
        },
    },

    // ── التصويت: «لديكم X ثانية لاختيار شخص لطرده» + أزرار أسماء اللاعبين ──
    // «يجب على الوكيل الضغط على زر اللاعب الذي يشك انه مافيا» — وضع ذكي/تلقائي
    // 🗳️ v7.19: الكشف موسّع (looksLikeVote) — أي صياغة تصويت من بوت اللعبة تعمل
    {
        engineId: 'mafia',
        name: 'mafiaVote',
        trigger: 'messageCreate',
        eventType: 'game_play',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            if (!message.components || message.components.length === 0) return { handled: false };
            const text = textFromMessage(message);
            if (!looksLikeVote(text)) return { handled: false };
            const session = mafiaSession(ctx, message);
            if (!session) return { handled: false };
            // ⚰️ v7.19: قُتلنا؟ متفرجون — لا تصويت (لكن الأصوات تُراقب لاحقاً)
            if (session.mafia.meDead) {
                sessions.mafiaSetVoteMessage(ctx.agentId, message.guild.id, message.id);
                recordVoteTally(ctx.agentId, message.guild.id, message);
                return { handled: true, silent: true, result: 'vote_watch', type: 'game_play', gameName: 'مافيا', message: 'جولة تصويت — أنت متفرج (ميت)', details: {} };
            }
            rememberVoted(message.id);
            sessions.mafiaSetVoteMessage(ctx.agentId, message.guild.id, message.id);

            sessions.mafiaSetPhase(ctx.agentId, message.guild.id, 'day_vote');
            recordVoteTally(ctx.agentId, message.guild.id, message);

            const allButtons = collectButtons(message);
            const candidates = mafia.candidateButtons(allButtons, { agentName: ctx.agentName });
            // الكشف الموسّع يتطلب مرشحين حقيقيين (≥2) حتى لا يتحرك على أي رسالة فيها طرد
            const exactMatch = VOTE_TEXT.test(sessions.normalizeName(text));
            if (candidates.length === 0 || (!exactMatch && candidates.length < 2)) return { handled: false };
            registerNamePlayers(session, candidates);

            // القرار: دائماً بعقل الوكيل (v7.18 — «لا يختار هو اصلا من يقتل او
            // على من يصوت» كانت بسبب: التلقائي عشوائي حرفياً) — العشوائي احتياط فشل فقط
            let target = await mafia.decideVote({
                runtimeSettings: ctx.runtimeSettings,
                agentName: ctx.agentName,
                role: session.mafia.role,
                session,
                candidates,
                rawText: text,
            });
            let source = target ? 'ai' : 'random';
            if (!target) target = mafia.pickRandom(candidates);
            if (!target) return { handled: false };

            // تأخير بشري — قصير في الوضع الذكي لأن مهلة التصويت 15ث والذكاء يستهلك منها
            const clicked = await mafia.humanClick(message, target, { minDelay: 900, maxDelay: 1800 }).catch(() => null);
            if (!clicked) return { handled: false };

            // 🧠 الوعي — صوّتنا على أحد
            sessions.pushEvent(ctx.agentId, message.guild.id, `صوّت على طرد «${target.label || '؟'}» (${source === 'ai' ? 'قرار الذكاء' : 'عشوائي احتياطي'})`);

            // 🗣️ v7.19: الإعلان في الوضع الاجتماعي — المالك يرى أنه يلعب فعلاً
            // («انا عامله اجتماعي لكنه لا يستطيع اللعب») — التلقائي يبقى صامتاً
            try {
                social.maybeVoteAnnounce({
                    client, channel: message.channel,
                    agentId: ctx.agentId, guildId: message.guild.id,
                    settings: ctx.settings, session,
                    target: target.label || '؟',
                    runtimeSettings: ctx.runtimeSettings, agentName: ctx.agentName,
                });
            } catch (_) {}

            return {
                handled: true,
                type: 'game_play',
                result: 'vote',
                gameName: 'مافيا',
                message: `🗳️ صوّت هو نفسه على طرد: ${target.label || '؟'}`,
                details: { target: target.label || null, source, mode: ctx.engineSettings?.mode || 'auto' },
            };
        },
    },

    // ── 🗳️ v7.19: عدّاد التصويت يتعدل (messageUpdate) — من صوت على من؟ ──
    // كان العدّاد يضيع نصاً خاماً بلا أزرار — الآن يُقرأ كأصوات حقيقية:
    // «أحمد (2)، خالد (1)» تصل عقله في كل قرار وكلام وسؤال
    {
        engineId: 'mafia',
        name: 'mafiaVoteTally',
        trigger: 'messageUpdate',
        eventType: 'game_play',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            const session = mafiaSession(ctx, message);
            if (!session) return { handled: false };
            if (!session.mafia.voteMessageId || String(session.mafia.voteMessageId) !== String(message.id)) return { handled: false };
            const updated = recordVoteTally(ctx.agentId, message.guild.id, message);
            return {
                handled: true,
                silent: true,
                result: 'vote_tally',
                type: 'game_play',
                gameName: 'مافيا',
                message: `لوحة الأصوات اتحدثت (${updated} مرشحاً)`,
                details: { updated },
            };
        },
    },

    // ── التصويت عبر تعديل الرسالة (العدّاد يتعدل) — الازدواج ممنوع بالتذكير ──
    {
        engineId: 'mafia',
        name: 'mafiaVoteUpdate',
        trigger: 'messageUpdate',
        eventType: 'game_play',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            if (votedMessages.has(message.id)) return { handled: false };
            if (!message.components || message.components.length === 0) return { handled: false };
            const text = textFromMessage(message);
            if (!looksLikeVote(text)) return { handled: false };
            const session = mafiaSession(ctx, message);
            if (!session) return { handled: false };

            // نفس منطق mafiaVote — نعيد استعماله بالاستدعاء المباشر
            const voteEvent = MAFIA_EVENTS.find(e => e.name === 'mafiaVote');
            return voteEvent.execute(message, client, ctx);
        },
    },

    // ── الرسائل السرية داخل القناة (مخفية ephemeral): اختيار ضحية/حماية ──
    // رسائل الخاص تُعالج مباشرة من player.js (لا تمر هنا)
    {
        engineId: 'mafia',
        name: 'mafiaSecret',
        trigger: 'messageCreate',
        eventType: 'game_play',
        gameName: 'مافيا',
        async execute(message, client, ctx) {
            if (!message.author || !message.author.bot) return { handled: false };
            if (message.guild && !mafia.isSecretMessage(message)) return { handled: false };
            if (!message.guild) return { handled: false }; // الخاص مساره في player.js
            const result = await mafia.handleSecretMessage({
                client, message, agentId: ctx.agentId,
                runtimeSettings: ctx.runtimeSettings,
                settings: ctx.settings,
                agentName: ctx.agentName,
            });
            return result || { handled: false };
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

// 🕵️ معالجات المافيا — في النهاية حتى لا تلمس أي محرك قديم (صفر كسر)
EVENTS.push(...MAFIA_EVENTS);

// ════════════════════════════════════════════════════════════
//  🧠 v7.21 — أي لعبة أخرى: بلاغ المالك الحرفي
//  «طلبت فقط أن يتم تمرير له رسائل الالعاب ويستطيع هو التصرف
//   والتعليق والكلام ويعرف اللعبة وكأنه بشري هل هذا صعب؟»
//  أي رسالة بوت فيها أزرار لا يفهمها معالج معروف → تُمرَّر لعقل
//  الوكيل حرفياً فيقرر كإنسان: ينضم / يضغط / يتجاهل + يقول سطره.
//  • الألعاب المعروفة (كراسي/روليت/مافيا/ريبلكا) لها معالجاتها —
//    لا نتدخل فيها (نحترم تعطيل كل محرك على حدة)
//  • فشل الذكاء → زر انضمام صريح/أخضر فقط (سرعة سباق اللوبي)،
//    وإلا لا ضغط أعمى — والتشخيص المرئي يعلن ما حدث
// ════════════════════════════════════════════════════════════
EVENTS.push({
    engineId: 'universal',
    name: 'universalLobby',
    trigger: 'messageCreate',
    eventType: 'game_join',
    gameName: 'لعبة',
    async execute(message, client, ctx) {
        if (!message.author || !message.author.bot) return { handled: false };
        const myId = client.user && client.user.id;

        const text = textFromMessage(message);
        if (!text || !String(text).trim()) return { handled: false };
        // رسالة موجّهة للوكيل (دوره/نتيجته) → معالجات الدور تتكفل
        if (myId && (text.includes(`<@${myId}>`) || text.includes(`<@!${myId}>`))) return { handled: false };

        const allButtons = collectButtons(message);
        if (allButtons.length === 0) return { handled: false };

        // الألعاب المعروفة لها محركاتها — لو محركها معطل فتعطيله متعمد: لا نتخطاه هنا
        const knownGame = ['كراسي', 'الكراسي', 'روليت', 'العجلة', 'مافيا', 'ريبلكا']
            .find(word => text.includes(word));
        if (knownGame) return { handled: false };

        const session = sessions.getSession(ctx.agentId, message.guild.id);
        const decision = await brain.decide({
            runtimeSettings: ctx.runtimeSettings,
            agentName: ctx.agentName,
            session,
            scene: {
                text,
                buttons: allButtons.map(b => ({ label: b.label })),
                hint: session
                    ? `أنت الآن داخل جلسة «${session.gameName || 'لعبة'}» — رسالة جديدة من بوت مختلف`
                    : 'رسالة من بوت لعبة — لوبي انضمام محتمل لأي لعبة',
            },
        });

        const gameTitle = (message.embeds && message.embeds[0] && message.embeds[0].title) || 'لعبة';

        if (decision && (decision.act === 'join' || decision.act === 'click')) {
            const chosen = decision.button
                ? (matchButtonLabel(allButtons, decision.button) || pickJoinButton(allButtons))
                : pickJoinButton(allButtons);
            if (!chosen) return { handled: false };
            const clicked = await clickWithHumanDelay(message, chosen);
            if (decision.say) {
                void social.sendText({ client, channel: message.channel, agentId: ctx.agentId,
                    guildId: message.guild.id, text: decision.say, kind: 'universal_say' }).catch(() => {});
            }
            return {
                handled: true,
                type: 'game_join',
                result: 'join',
                gameName: gameTitle,
                message: `انضم بقرار عقله إلى «${gameTitle}» بالزر: ${clicked.label || '؟'}`,
                details: { buttonLabel: clicked.label, delayMs: clicked.delayMs, source: 'ai', decision: decision.act },
            };
        }

        if (decision && decision.act === 'none') {
            return { handled: false, silent: true, result: 'ai_skip', details: { reason: 'قرار الذكاء: تجاهل' } };
        }

        // فشل الذكاء — سرعة سباق اللوبي: زر انضمام صريح أو أخضر فقط، بلا تخمين أعمى
        const fallback = allButtons.find(b => isJoinLabeled(b) || isGreenButton(b));
        if (!fallback) return { handled: false };
        const clicked = await clickWithHumanDelay(message, fallback);
        return {
            handled: true,
            type: 'game_join',
            result: 'join',
            gameName: gameTitle,
            message: `انضم (احتياط هيكلي بعد فشل الذكاء) إلى «${gameTitle}» بالزر: ${clicked.label || '؟'}`,
            details: { buttonLabel: clicked.label, delayMs: clicked.delayMs, source: 'fallback' },
        };
    },
});

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
    // 🗳️ التصويت (v7.19) — لأغراض الاختبار
    looksLikeVote,
    parseVoteLabel,
    recordVoteTally,
    // 🕵️ المافيا (v7.16) — لأغراض الاختبار
    __mafiaHooks: { votedMessages, VOTE_TEXT, rememberVoted, MAFIA_EVENTS, registerNamePlayers, collectMentions, matchButtonLabel },
};
