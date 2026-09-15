/**
 * bot.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * الملف الرئيسي: إنشاء Client، أحداث ready/messageCreate،
 * أوامر Slash، وبدء التشغيل
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { ObjectId } = require('mongodb');

// ══════════════════════════════════════════════════════════════
//  استيراد المكتبات والوحدات
// ══════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const {
    Client,
    GatewayIntentBits,
    Partials,
    SlashCommandBuilder,
    REST,
    Routes,
    ChannelType,
    InteractionType,
    ApplicationCommandOptionType,
    ApplicationCommandType,
} = require('discord.js');
const axios = require('axios');
const errorReporter = require('./errorReporter'); // 🕶️ وجه البوكر — خصوصية الأخطاء + قناة الإشعارات

// استيراد ملفات المشروع
const {
    USER_TOKEN,
    BOT_OWNER_ID,
    MAX_CHANNELS_PER_GUILD,
    MAX_ATTACHMENT_BYTES,
    TEXT_EXTENSIONS,
    TEXT_CONTENT_TYPES,
    connectMongo,
    channel_sessions,
    allowed_channels_cache,
    sessionLock,
    db, // not used directly but needed for initial connect
} = require('./config');

const {
    _err,
    _ok,
    is_text_attachment,
    fetchTextAttachment,
    get_allowed_channels,
    add_allowed_channel,
    remove_allowed_channel,
    db_load_channel_session,
    db_save_channel_session,
    db_reset_channel_session,
    db_list_channel_sessions,
    get_control_role,
    set_control_role,
    get_pow_provider,
    set_pow_provider,
    findChannel,
    findCategory,
    findRole,
    findMember,
    findGuild,
    getAccessLevel,
    isBotOwner,
    looks_like_internal_prompt_request,
    buildBotContext,
    parsePersonalityCommand,
    validatePersonalityUpload,
    clampPersonalityText,
    PERSONALITY_MAX_CHARS,
} = require('./utils');

const {
    runAgent,
} = require('./tools');

// 🎭 قائمة انتظار الرسائل — واحد واحد بس: الأول يُرد ثم الثاني (v7.9)
// 🛠️ v7.12: agentChannelKey — قائمة كل وكيل مستقلة حتى لو تشارك وكيلاان نفس القناة
const { enqueueChannelTask, agentChannelKey } = require('./channelQueue');
// 🛡️ v7.13 «بلا أدمن» — فحص القدرة على الرد قبل استهلاك الـ AI + ساعة توقف القائمة
const {
    checkReplyAbility,
    isMissingPermissionsError,
    withTaskTimeout,
    buildPermissionDiagLines,
    PERM_LABELS_AR,
    DEFAULT_TASK_TIMEOUT_MS,
} = require('./permissions');
// 🌐 حسابات Qwen التلقائية لكل سيرفر (v7.9)
const qwenAccounts = require('./qwenAccounts');
// 🛰️ سجل السيرفرات والنشاط — العلم التام للمالك (v7.9)
const guildRegistry = require('./guildRegistry');
// 🧷 ذاكرة القناة الدائمة — تنجو من تبديل المزود/المفتاح (v7.11)
const channelHistory = require('./channelHistory');
// 🎮 محرك لعب الوكلاء — نقل نظام Auto كاملاً (v7.14 — معطل افتراضياً صفر كسر)
const gamesPlayer = require('./games/player');

const {
    createDiscordClient,
    normalizeTokenType,
    isTextChannel,
} = require('./discordAdapter');

// 🔒 ملاحظة العزل: managerDashboard يُستورد هنا فقط لـ isDashboardCommand
// (لكشف بقايا أوامر اللوحة ورفضها محايداً) — لا يُسجّل أي أمر لوحة على بوت الوكيل.
const { isDashboardCommand } = require('./managerDashboard');
// 🎨 نظام التصميم الموحد — رسائل الوكيل أيضاً حاويات V2 لا إيمبدات
const { v2Payload, V2_EPHEMERAL_FLAGS } = require('./ui');
const { getAccountSettings, updateAccountSettings, forwardMessage, handleAccountInteraction, handleControlReply, trackGameMessage, startEvent, runEventSeries, rememberActivity, maybeAutoEvent, maybeScheduledEvent, humanizeDisplayName } = require('./accountAgent');
const { getProviderOrFallback, isValidProvider, listProviders, extractProviderConfig, extractAllProviderConfigs } = require('./providers');
const remindersModule = require('./reminders');
const { startReminderEngine } = remindersModule;
const reminder_SCAN_MS = remindersModule.SCAN_INTERVAL_MS;
const memory = require('./memory');
const secrets = require('./secrets');
const proactive = require('./proactive');
const usage = require('./usage');

// ══════════════════════════════════════════════════════════════
//  🎨 نظام التصميم الموحد — لكل ردومات الوكيل (embeds أنيقة ومتسقة)
// ══════════════════════════════════════════════════════════════
const AGENT_COLORS = Object.freeze({
    primary: 0x9B59B6,  // بنفسجي هوية الوكيل
    success: 0x57F287,
    danger : 0xED4245,
    warning: 0xFEE75C,
    info   : 0x3498DB,
});

/**
 * بناء رسالة موحدة للوكيل — Components V2 بنفس الهوية البصرية في كل الأوامر
 * (حاوية بشريط لوني + ترويسة + جسم + توقيع سفلي — لا إيمبدات مسطحة)
 * @param {object} opts {title, description, color, botName, footer}
 */
function agentEmbed({ title, description = '', color = AGENT_COLORS.primary, botName = 'Agent', footer = null }) {
    const ui = require('./ui');
    return ui.container({
        accent: color,
        title,
        body: description,
        footer: footer || `${botName} • Disor Platform`,
    });
}

/** دليل الأوامر الكامل — مصنف ومصمم موحداً (حاويتان V2 في رسالة واحدة) */
function buildHelpEmbeds(botName, extra = {}) {
    const footerTxt = `${botName} • Disor Agent Platform`;
    const ui = require('./ui');
    const e1 = ui.container({
        accent: AGENT_COLORS.primary,
        title: `📖 دليل ${botName} — 1/2`,
        body:
            'أنا وكيل ذكاء اصطناعي كامل داخل ديسكورد — أتحادث، أنفذ مهام إدارية، أبحث في الإنترنت، أتذكر، وأذكّرك.\n\n' +
            '**💬 التحدث معي**\n' +
            'منشنني `@` أو رد على رسالة مني — لا حاجة لأي أمر.\n' +
            '**/محادثة-جديدة** — صفّر محادثة قناة أو غيّر وضعها (عادي/خبير + تفكير عميق)\n' +
            '**/عرض-المحادثات** — المحادثات المحفوظة للقنوات\n\n' +
            '**🌐 قدراتي الذكية (للجميع)**\n' +
            'اكتب طلبك في المحادثة مباشرة، مثلاً:\n' +
            '• «ابحث لي عن أحسن لابتوب لعام 2025 واقرأ أول نتيجة» ← بحث ويب + قراءة صفحات\n' +
            '• «تذكر أنني أعمل مبرمجاً» / «ماذا تذكر عني؟» / «انسي ذلك» ← ذاكرة شخصية دائمة\n' +
            '• «ذكرني بعد 30 دقيقة» / «ذكّرني كل يوم 8 مساءً» ← تذكيرات حقيقية تصلك في وقتها\n' +
            '• «من الأكثر نشاطاً هذا الأسبوع؟» ثم «امسح رسائله» ← قراءة السيرفر ثم تنفيذ (للأدمن)\n\n' +
            '**🧠 الذاكرة الدائمة — كيف تعمل فعلاً؟**\n' +
            '• عندك مع كل وكيل ذاكرة خاصة **مقسمة حسب هويتك** — لا يرى أحد ذكرياتك غيرك.\n' +
            '• تُخزن في قاعدة البيانات (وليس في المحادثة) — تنجو من تصفير المحادثات وتعطّل البوت.\n' +
            '• **حقن تلقائي:** قبل كل رسالة تكلمني فيها، أهم 12 ذكرى عنك تُضاف لسياقي تلقائياً — فتفترض أنني أتذكر حتى لو لم تستدعِ شيئاً.\n' +
            '• **أدواتي:** `remember` (أحفظ)، `recall` (أستدعي بالبحث)، `forget_memory` (أنسى). الاستخدام: قل لي «تذكر أن…» وأنا أحفظ بنفسي.\n' +
            '• التكرار لا يُكرر الحفظ (dedup)، والحد 200 ذكرى لكل مستخدم، والقديم الأقل تفاعلاً يُحذف تلقائياً.',
        footer: footerTxt,
    });

    const e2 = ui.container({
        accent: AGENT_COLORS.info,
        title: `📡 دليل ${botName} — 2/2 (أوامر الأدمن)`,
        body:
            '**📡 قنوات المحادثة**\n' +
            '**/قناة-محادثة** — أضف قناة أتكلم فيها (الحد الأقصى 5)\n' +
            '**/قنوات-مسموحة** — القنوات النشطة حالياً\n' +
            '**/حذف-قناة** — أزل قناة من قائمتي\n\n' +
            '**🧠 الذكاء الاصطناعي**\n' +
            '**/المزود** — اعرض أو بدّل مزودي (🐋 DeepSeek / 🌐 Qwen / ⚙️ OpenAI / ✨ Gemini)\n' +
            '**/اختبار-المزود** — اختبار اتصال حقيقي مع مزودي الحالي\n' +
            '**/مزود-باو** — إعدادات POW (خاص بـ DeepSeek فقط)\n\n' +
            '**⚙️ القدرات والميزات والإحصائيات**\n' +
            '**/الميزات** — قدراتي: التفكير العميق + البحث المدمج (قدرات النموذج نفسه) + قراءة الروابط\n' +
            '**/الاحصائيات** — إحصائيات استخدامي آخر 7 أيام (رسائل/أدوات/مزودون)\n\n' +
            '**📎 رفع شخصية من ملف**\n' +
            'من لوحة التحكم (/panel): زر «شخصية من ملف» في صفحة الإعدادات → أرسل الملف `.txt`/`.md` في القناة خلال 3 دقائق → يصبح هو الشخصية.\n' +
            'أو: منشنني + اكتب `شخصية` + أرفق الملف في نفس الرسالة (≤ 1MB و20000 حرف).\n\n' +
            '**⚙️ الصلاحيات والإدارة**\n' +
            '**/رتبة-التحكم** — حدد رتبة من يستطيع إدارتي\n' +
            '**/الرتبة-الحالية** — اعرض رتبة التحكم\n\n' +
            '**🎮 الحساب الحقيقي والفعاليات**\n' +
            '**/ابدأ-فعالية** — شغّل فعالية أو سلسلة فوراً\n' +
            '**/فعاليات-وضع** — تلقائي أو يدوي\n' +
            '**/حساب-خاص** / **/حساب-منشن** / **/حساب-تسليمات** — قنوات تحويل الحساب الحقيقي\n' +
            '**/حساب-قناة-فعاليات** / **/حساب-رول-فعاليات** — إعدادات فعاليات الحساب\n\n' +
            '> للوحة تحكم كاملة (إنشاء وكلاء، الإعدادات، المعرفة، الاستباقية، الإحصائيات) استخدم /panel من بوت المدير',
        footer: footerTxt,
    });
    return [e1, e2];
}

function agentRuntimeCommands() {
    // 🔒 غير مُسجّلة على بوتات الوكلاء (عزل أمني v7.7.0) — تبقى التعريفات
    // فقط كتوثيق للأسماء التي قد ترد من بقايا تسجيل قديم على مستوى سيرفر،
    // ومعالجاتها في interactionCreate محصورة بأدمن الوكيل نفسه.
    // التسجيل الفعلي: agentBotCommands() — أمر /شرح فقط.
    const channelOption = (option) => option
        .setName('قناة')
        .setDescription('اكتب أو اختر قناة نصية')
        .setRequired(true)
        .setAutocomplete(true);

    return [
        new SlashCommandBuilder()
            .setName('اوامر')
            .setDescription('📖 دليل الأوامر والقدرات الكاملة لهذا الوكيل'),
        new SlashCommandBuilder()
            .setName('مساعدة')
            .setDescription('📖 نفس دليل الأوامر — مصنف ومفصل'),
        new SlashCommandBuilder()
            .setName('قناة-محادثة')
            .setDescription('➕ إضافة قناة أتكلم فيها (أدمن)')
            .addStringOption(channelOption),
        new SlashCommandBuilder()
            .setName('قنوات-مسموحة')
            .setDescription('📡 عرض قنوات المحادثة المفعلة (أدمن)'),
        new SlashCommandBuilder()
            .setName('حذف-قناة')
            .setDescription('➖ حذف قناة من قنوات محادثتي (أدمن)')
            .addStringOption(channelOption),
        new SlashCommandBuilder()
            .setName('محادثة-جديدة')
            .setDescription('🔄 بدء/تصفير محادثة قناة (وضع + تفكير)')
            .addStringOption(option => option
                .setName('قناة')
                .setDescription('القناة، واتركها فارغة لاستخدام القناة الحالية')
                .setRequired(false)
                .setAutocomplete(true))
            .addStringOption(option => option
                .setName('وضع')
                .setDescription('وضع المحادثة')
                .setRequired(false)
                .addChoices(
                    { name: 'عادي', value: 'default' },
                    { name: 'خبير', value: 'expert' },
                ))
            .addStringOption(option => option
                .setName('تفكير')
                .setDescription('تفعيل التفكير')
                .setRequired(false)
                .addChoices(
                    { name: 'مغلق', value: 'off' },
                    { name: 'مفعل', value: 'on' },
                )),
        new SlashCommandBuilder()
            .setName('عرض-المحادثات')
            .setDescription('💬 عرض محادثات القنوات المحفوظة'),
        new SlashCommandBuilder()
            .setName('حذف-محادثة')
            .setDescription('🗑️ حذف/تصفير محادثة قناة')
            .addStringOption(channelOption),
        new SlashCommandBuilder()
            .setName('رتبة-التحكم')
            .setDescription('🛡️ تحديد رتبة من يستطيع إدارتي (أدمن)')
            .addStringOption(option => option
                .setName('role')
                .setDescription('اسم الرتبة، أو اتركه فارغًا لإزالة القيد')
                .setRequired(false)),
        new SlashCommandBuilder()
            .setName('الرتبة-الحالية')
            .setDescription('🛡️ عرض رتبة التحكم الحالية'),
        new SlashCommandBuilder()
            .setName('حساب-خاص')
            .setDescription('تحديد قناة تحويل رسائل الخاص للحساب الحقيقي')
            .addStringOption(channelOption),
        new SlashCommandBuilder()
            .setName('حساب-منشن')
            .setDescription('تحديد قناة تحويل المنشن/الردود للحساب الحقيقي')
            .addStringOption(channelOption),
        new SlashCommandBuilder()
            .setName('حساب-تسليمات')
            .setDescription('تحديد قناة تسليم نتائج الألعاب للحساب الحقيقي')
            .addStringOption(channelOption),
        new SlashCommandBuilder()
            .setName('حساب-قناة-فعاليات')
            .setDescription('تحديد قناة الفعاليات التلقائية للحساب الحقيقي')
            .addStringOption(channelOption),
        new SlashCommandBuilder()
            .setName('حساب-رول-فعاليات')
            .setDescription('تحديد رول منشن الفعاليات للحساب الحقيقي')
            .addStringOption(option => option.setName('role').setDescription('اسم/ID الرتبة').setRequired(true)),
        new SlashCommandBuilder()
            .setName('فعاليات-وضع')
            .setDescription('تبديل وضع فعاليات الحساب الحقيقي')
            .addStringOption(option => option
                .setName('mode')
                .setDescription('الوضع')
                .setRequired(true)
                .addChoices({ name: 'تلقائي', value: 'auto' }, { name: 'يدوي', value: 'manual' })),
        new SlashCommandBuilder()
            .setName('ابدأ-فعالية')
            .setDescription('بدء فعالية أو سلسلة فعاليات عبر الحساب الحقيقي')
            .addStringOption(option => option.setName('game').setDescription('اسم اللعبة').setRequired(false))
            .addIntegerOption(option => option.setName('عدد').setDescription('عدد الفعاليات المتتالية').setRequired(false).setMinValue(1).setMaxValue(50))
            .addIntegerOption(option => option.setName('دقائق').setDescription('مدة التشغيل بالدقائق بدلاً من العدد أو معه').setRequired(false).setMinValue(1).setMaxValue(600)),
        new SlashCommandBuilder()
            .setName('مزود-باو')
            .setDescription('تحديد مزود POW لهذا الوكيل')
            .addStringOption(option => option
                .setName('provider')
                .setDescription('المزود')
                .setRequired(true)
                .addChoices(
                    { name: 'railway', value: 'railway' },
                    { name: 'telegram', value: 'telegram' },
                )),
        new SlashCommandBuilder()
            .setName('المزود')
            .setDescription('عرض أو تبديل مزود الذكاء الاصطناعي لهذا الوكيل (DeepSeek / Qwen / OpenAI)')
            .addStringOption(option => option
                .setName('الاسم')
                .setDescription('اسم المزود الجديد (اتركه فارغاً للعرض فقط)')
                .setRequired(false)
                .addChoices(
                    { name: 'deepseek — الأصلي', value: 'deepseek' },
                    { name: 'qwen — عبر chat.qwen.ai', value: 'qwen' },
                    { name: 'openai — أي مزود متوافق مع OpenAI', value: 'openai' },
                )),
        new SlashCommandBuilder()
            .setName('اختبار-المزود')
            .setDescription('اختبار اتصال حقيقي مع مزود الذكاء الاصطناعي لهذا الوكيل'),

        new SlashCommandBuilder()
            .setName('الميزات')
            .setDescription('⚙️ عرض قدرات هذا الوكيل (تفكير/بحث مدمج/روابط) أو تبديل إحداها')
            .addStringOption(option => option
                .setName('التبديل')
                .setDescription('الميزة المطلوب تبديلها')
                .setRequired(false)
                .addChoices(
                    { name: 'thinking — التفكير العميق (قدرة النموذج)', value: 'thinking' },
                    { name: 'search — البحث المدمج (قدرة النموذج)', value: 'search' },
                    { name: 'read_url — قراءة الروابط', value: 'read_url' },
                )),

        new SlashCommandBuilder()
            .setName('الاحصائيات')
            .setDescription('📊 إحصائيات استخدام هذا الوكيل (رسائل/أدوات/مزودون)'),
    ];
}

function uniqueCommands(commands) {
    const seen = new Set();
    return commands.filter((cmd) => {
        const name = cmd.name;
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
    });
}

// ══════════════════════════════════════════════════════════════
//  🔒 عزل بوتات الوكلاء — أمر واحد فقط: /شرح
//  بوت الوكيل لا يستورد أي أوامر إطلاقاً (لا لوحة المدير، لا أوامر
//  الوكيل). لوحة إدارة الوكلاء تعمل من بوت المدير الرئيسي حصراً —
//  من يملك توكن بوت وكيل لا يستطيع رؤية أي شيء إداري أصلاً.
// ══════════════════════════════════════════════════════════════
function agentBotCommands() {
    return [
        new SlashCommandBuilder()
            .setName('شرح')
            .setDescription('من أنا؟ — بطاقة تعريفية بهذا البوت'),
    ];
}

/**
 * 🪪 بطاقة /شرح — Components V2 احترافية
 * تعريف البوت: ذكاء اصطناعي مصمم للتفاعل مع أعضاء السيرفر وترفيههم،
 * مطوّر بواسطة زيوس. تُعرض على كل بوت وكيل منشأ.
 * 🛡️ v7.13: diagLines اختيارية — فحص صلاحياتي الحقيقي في قناة الأمر
 * (الأدمن غير مطلوب — يكفي الحد الأدنى) بدل صمت غامض بدون أدمن.
 * @param {string} botName اسم البوت الظاهر
 * @param {string[]|null} [diagLines=null] أسطر التشخيص من buildPermissionDiagLines
 */
function buildIntroPayload(botName, diagLines = null) {
    const ui = require('./ui');
    const name = String(botName || 'هذا البوت');
    const extra = Array.isArray(diagLines) && diagLines.length
        ? ['', '─'.repeat(12), '', ...diagLines]
        : [];
    const card = ui.container({
        accent: ui.ACCENTS.primary,
        title: `✨ ${name}`,
        body: [
            '**ذكاء اصطناعي مصمم للتفاعل مع أعضاء السيرفر** — يحاور، يساعد، يسلي، ويضيف روحاً حقيقية للمجتمع.',
            '',
            'تحدث معه بشكل طبيعي: منشنه في أي قناة أو راسله خاصاً، وسيرد عليك بذكاء وبشخصيته الخاصة.',
            ...extra,
            '',
            `> 🛠️ مطوّر بواسطة **زيوس** <@656783724662226963>`,
        ].join('\n'),
        footer: 'تطوير زيوس — Disor',
    });
    return v2Payload(card);
}

// ℹ️ مؤشر «يكتب...» (Typing) أُزيل بناءً على طلب المالك — الوكيل يرد مباشرة
// بدون تظاهر بالكتابة.

function resolveChannelValue(guild, value) {
    const raw = String(value || '').trim();
    const id = raw.match(/^<#?(\d{15,25})>$/)?.[1] || raw;
    let channel = guild.channels.cache.get(id);
    if (!channel) {
        const lowered = raw.replace(/^#/, '').toLowerCase();
        channel = guild.channels.cache.find(c => c.name?.toLowerCase() === lowered && isTextChannel(c));
    }
    return channel && isTextChannel(channel) ? channel : null;
}

// ══════════════════════════════════════════════════════════════
//  إنشاء Client
// ══════════════════════════════════════════════════════════════
async function startAgentRuntime(agentConfig) {
const agentId = String(agentConfig._id || agentConfig.id || 'default');

// 🔐 فك تشفير الأسرار (توكن ديسكورد + توكنات المزودين) — pass-through للنص القديم
agentConfig = secrets.decryptAgentDoc(agentConfig);
const agentName = agentConfig.name || agentId;
const tokenType = normalizeTokenType(agentConfig.token_type || agentConfig.tokenType || 'bot');
const discordToken = agentConfig.discord_token || agentConfig.discordToken;

// ══════════════════════════════════════════════════════════════
//  نظام المزودين — تحديد مزود الذكاء الاصطناعي لهذا الوكيل
//  التوافق القديم: وكلاء بدون حقل provider يعاملون كـ DeepSeek (كما كان)
// ══════════════════════════════════════════════════════════════
const providerId = isValidProvider(agentConfig.provider) ? String(agentConfig.provider).toLowerCase() : 'deepseek';
const provider = getProviderOrFallback(providerId);
if (!isValidProvider(agentConfig.provider) && agentConfig.provider) {
    console.warn(`⚠️ [${agentId}] مزود غير معروف "${agentConfig.provider}" — التراجع إلى DeepSeek`);
}

// إعدادات runtime قابلة للتحديث الحي عبر /المزود (كائن واحد يُمرر بالمرجع)
const runtimeSettings = {
    agentId,
    agentName , // 🕶️ اسم الوكيل الودود — يظهر في تقارير الأخطاء لقناة الإشعارات
    kind        : agentConfig.kind === 'chat' ? 'chat' : 'agent', // 💬 محادثة خالصة / 🤖 وكيل بأدوات
    personality : agentConfig.personality || '',
    provider    : providerId,
    providerConfig : extractProviderConfig(agentConfig),
    // 🔄 سلسلة Fallback — البدائل تُستخدم فقط عند فشل الأساسي
    fallback_enabled : Boolean(agentConfig.fallback_enabled),
    fallback_chain   : Array.isArray(agentConfig.fallback_chain) ? agentConfig.fallback_chain.map(String) : [],
    fallback_configs : extractAllProviderConfigs(agentConfig),
    // ⚙️ ميزات الوكيل القابلة للتعطيل — توافق قديم: بلا إعداد = مفعّلة
    // (read_url قابل للتعطيل — البحث نفسه مسؤولية النموذج المدمج، web_search حُذفت في v7.4)
    features : {
        read_url : agentConfig.features?.read_url !== false,
    },
    // 🧠 قدرات النموذج الأصلية (2.5-B): تفكير عميق + بحث مدمج — تُفعّل من الإعدادات أو /الميزات
    capabilities : {
        thinking : agentConfig.capabilities?.thinking === true,
        search   : agentConfig.capabilities?.search === true,
    },
    // 🤖 الاستباقية — إصغاء قنوات بالكلمات المفتاحية (توافق قديم: بلا إعداد = معطلة)
    proactive_enabled  : Boolean(agentConfig.proactive_enabled),
    proactive_channels : Array.isArray(agentConfig.proactive_channels) ? agentConfig.proactive_channels : [],
};
const proactiveCooldowns = new Map(); // `${guildId}:${channelId}` → آخر إطلاق (ms)

// ══════════════════════════════════════════════════════════════
//  📎 رفع شخصية من ملف — منطق مشترك لكل أنواع الوكلاء (المستوى 2)
// ══════════════════════════════════════════════════════════════
async function handlePersonalityUploadMessage(message) {
    // إزالة منشن هذا الوكيل من النص
    const content = String(message.content || '')
        .replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '')
        .trim();

    // ليس أمر شخصية؟ ليس لنا — يكمل لمسار المحادثة العادي
    if (!parsePersonalityCommand(content)) return false;

    const accessLevel = getAccessLevel(message.member);
    const attachments = Array.from(message.attachments.values()).map(a => ({
        name: a.name, size: a.size, contentType: a.contentType, url: a.url,
    }));

    const v = validatePersonalityUpload({ content, attachments, accessLevel });
    if (!v.ok) {
        await message.reply(v.error);
        return true; // الأمر لنا لكنه فاشل — لا تكمل للمحادثة
    }

    const text = await fetchTextAttachment(v.attachment.url);
    const personality = clampPersonalityText(text);
    if (!personality) {
        await message.reply('❌ الملف فارغ أو غير قابل للقراءة.');
        return true;
    }

    // تحديث قاعدة البيانات + الـ runtime الحي فوراً
    const cfg = require('./config');
    if (!cfg.agents_col || !ObjectId.isValid(String(agentId))) {
        await message.reply('❌ قاعدة البيانات غير متصلة — لا يمكن الحفظ.');
        return true;
    }
    await cfg.agents_col.updateOne(
        { _id: new ObjectId(agentId) },
        { $set: { personality, updated_at: new Date() } },
    );
    runtimeSettings.personality = personality;

    try {
        await cfg.logs_col?.insertOne?.({
            agent_id: agentId,
            type: 'personality_upload',
            message: 'تم تحديث شخصية الوكيل من ملف مرفوع',
            extra: { source: v.attachment.name, chars: personality.length, by: message.author.id },
            created_at: new Date(),
        });
    } catch (_) {}

    const preview = personality.length > 300 ? `${personality.slice(0, 300)}…` : personality;
    const emb = agentEmbed({
        title: '✅ تم تحديث شخصيتي من الملف',
        description: linesBlock([
            `📎 **المصدر:** ${v.attachment.name}`,
            `📏 **الطول:** ${personality.length} حرف (الحد ${PERSONALITY_MAX_CHARS})`,
            '',
            '**معاينة:**',
            `> ${preview.split('\n').join('\n> ')}`,
            '',
            'الشخصية الجديدة تعمل الآن فوراً بدون إعادة تشغيل.',
        ]),
        color: AGENT_COLORS.success,
        botName: client.user.displayName || client.user.username,
    });
    await message.reply(v2Payload(emb));
    return true;
}

// لقطة من وثيقة الوكيل عند الإقلاع — تُستخدم للتحقق من إعدادات المزودين الآخرين
const agentConfigSnapshot = { ...agentConfig };

// التحقق من اكتمال إعدادات المزود (السلوك القديم محفوظ لـ DeepSeek)
const validation = provider.validate(runtimeSettings.providerConfig);
if (!validation.ok) {
    // رسالة قابلة للتنفيذ: أين يكمل المالك بياناته بالضبط (نافذة أو ملف للقيم الطويلة)
    throw new Error(
        `إعدادات مزود ${provider.label} ناقصة: ${validation.missing.join(', ')}. ` +
        'أكملها من لوحة التحكم: صفحة الوكيل ← الإعدادات ← «بيانات المزود»، ' +
        'أو أرسل القيمة الطويلة كملف من زر «الكوكيز من ملف».'
    );
}

if (!discordToken) throw new Error('discord_token مفقود لهذا الوكيل');
const channel_sessions = new Map();
const allowed_channels_cache = new Map();
const sessionLock = new (require('./config').SimpleLock)();
let intentionalStop = false;
const client = createDiscordClient(tokenType);
client.__agentTokenType = tokenType;
client.__agentId = agentId;

// ══════════════════════════════════════════════════════════════
//  حدث READY
// ══════════════════════════════════════════════════════════════
client.once('ready', async () => {

    const botName = client.user.displayName || client.user.username;
    console.log(`✅ ${botName} (${client.user.id}) ready`);
    console.log(`📡 Guilds (${client.guilds.cache.size}): ${client.guilds.cache.map(g => g.name).join(', ')}`);

    if (agentConfig.onReady) await agentConfig.onReady();

    // 🛰️ v7.12 — هوية بوت ديسكورد لهذا الوكيل تُحفظ على وثيقة الوكيل —
    // /الرصد يحتاجها ليعرف سيرفرات هذا الوكيل تحديداً (apps.id في سجل الرصد)
    // حتى وهو متوقف. fire-and-forget: فشلها لا يعطل الإقلاع أبداً.
    try {
        const cfgMod = require('./config');
        if (cfgMod.agents_col && client.user?.id) {
            await cfgMod.agents_col.updateOne(
                { _id: new ObjectId(String(agentId)) },
                { $set: { discord_bot_id: String(client.user.id), discord_bot_name: client.user.username || '' } },
            ).catch(() => {});
        }
    } catch (_) {}

    // 🛰️ RAQEEB — ترحيل صامت: سيرفرات هذا الوكيل الحالية تُسجل عند الإقلاع
    // (السيرفرات القديمة قبل تفعيل الرصد لم تصل منها guildCreate أبداً)
    try {
        await guildRegistry.backfillGuilds(client);
    } catch (e) {
        console.error('[Raqeeb] فشل ترحيل سيرفرات الوكيل:', e.message);
    }

    // ⏰ محرك تذكيرات هذا الوكيل — يرسل عبر عميل الوكيل نفسه
    try {
        const reminderEngine = startReminderEngine({ agentId, client });
        client.__reminderEngine = reminderEngine;
        console.log(`⏰ محرك التذكيرات يعمل لـ ${agentId} (مسح كل ${Math.round(reminder_SCAN_MS / 1000)} ث)`);
    } catch (e) {
        console.error(`❌ فشل بدء محرك التذكيرات لـ ${agentId}:`, e.message);
    }

    // 🎮 محرك الألعاب — تسجيل الوكيل وإطلاق حلقات زر المفعّلة (v7.14)
    // fire-and-forget: فشلها لا يعطل الإقلاع أبداً — والافتراضي معطل كلياً
    try {
        await gamesPlayer.agentReady({
            client,
            agentId,
            agentName: botName,
            tokenType,
            kind: runtimeSettings.kind,
        }).catch((e) => console.error('[GamePlayer] agentReady:', e.message));
    } catch (_) {}

    // تسجيل أوامر السلاش للبوتات فقط؛ حسابات user لا تدعم application commands
    if (tokenType !== 'bot') return;

    try {
        // 🔒 عزل أمني صارم: بوت الوكيل يسجل أمراً واحداً فقط (/شرح).
        // لا لوحة المدير ولا أوامر الوكيل — استبدال القائمة كاملة يمسح حتى
        // الأوامر القديمة المسجلة سابقاً على هذا التطبيق. الإدارة كاملة
        // تُدار من بوت المدير الرئيسي فقط (bot.js).
        const commands = uniqueCommands(agentBotCommands());

        const rest = new REST({ version: '10' }).setToken(discordToken);

        console.log('⏳ جاري تسجيل أمر /شرح لبوت الوكيل...');
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands.map(cmd => cmd.toJSON()) },
        );
        console.log('✅ Agent bot isolated — only /شرح registered');
    } catch (err) {
        console.error('❌ فشل تسجيل أوامر السلاش:', err);
    }
});

// ══════════════════════════════════════════════════════════════
//  حدث INTERACTION (للأوامر + Autocomplete)
// ══════════════════════════════════════════════════════════════
client.on('interactionCreate', async (interaction) => {
    const runtimeContext = runtimeSettings;
    if (interaction.customId?.startsWith?.('acct:')) {
        if (await handleAccountInteraction(client, interaction, runtimeContext).catch((e) => { console.error('[Account Interaction]', e); return false; })) return;
    }
    // ── Autocomplete ──
    if (interaction.isAutocomplete()) {
        if (!interaction.guild) return;
        const focused = interaction.options.getFocused(true);
        if (focused.name === 'قناة') {
            const guild = interaction.guild;
            const current = focused.value.toLowerCase();
            const choices = guild.channels.cache
                .filter(ch => isTextChannel(ch) && ch.name.toLowerCase().includes(current))
                .first(25)
                .map(ch => ({ name: `#${ch.name}`, value: ch.id }));
            await interaction.respond(choices);
        }
        return;
    }

    // ── 🔒 بقايا لوحة المدير — رفض محايد ──
    // بوت الوكيل لا يعرض لوحة المدير إطلاقاً. لو وصل تفاعل dash: (بقايا
    // أوامر قديمة مسجلة على مستوى سيرفر مثلاً) يُرفض برسالة محايدة —
    // ولا يُمرر أي شيء إلى نظام إدارة الوكلاء مهما كان.
    if ((interaction.isChatInputCommand() && isDashboardCommand(interaction.commandName))
        || (interaction.customId && interaction.customId.startsWith('dash:'))) {
        const neutralPayload = v2Payload((() => {
            const ui = require('./ui');
            return ui.container({
                accent: ui.ACCENTS.warning,
                title: 'غير متاح هنا',
                body: 'هذا البوت رفيق محادثة فقط — الإدارة تتم من بوت المدير الرئيسي.',
            });
        })());
        const ephemeral = { ...neutralPayload, flags: V2_EPHEMERAL_FLAGS };
        if (interaction.replied || interaction.deferred) await interaction.followUp(ephemeral).catch(() => {});
        else await interaction.reply(ephemeral).catch(() => {});
        return;
    }

    // لا توجد أوامر إدارة محلية داخل Agent Runtime.
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const guild = interaction.guild;
    const member = interaction.member;

    // 🛡️ حارس موحد للصلاحيات — الإصلاح الجذري لأمر «حدث خطأ أثناء معالجة الأمر»:
    // في الخاص (أو غياب member) كان `member.permissions` ينهار مباشرة على كل الأوامر المحمية.
    // الآن: أدمن السيرفر أو مالك البوت — وإلا رسالة واضحة بدل انهيار صامت.
    const isAdmin = Boolean(
        (guild && member?.permissions?.has?.('Administrator')) || isBotOwner(interaction.user?.id),
    );
    const denyAdmin = async () => {
        await interaction.reply({
            content: guild
                ? '⛔ هذا الأمر للأدمن فقط.'
                : '⛔ هذا الأمر للأدمن فقط — استخدمه داخل سيرفر، أو كن مالك البوت.',
        }).catch(() => {});
    };

    try {

        // أوامر إدارة الوكلاء نُقلت بالكامل إلى Manager Dashboard.

        // 🪪 أمر الوكيل الوحيد المسجل: /شرح — بطاقة تعريفية V2 + فحص صلاحيات حي (v7.13)
        if (commandName === 'شرح') {
            const botName = client.user.displayName || client.user.username;
            // 🛡️ تشخيص حقيقي: هل أستطيع الرد هنا؟ الأدمن غير مطلوب — الحد الأدنى فقط.
            let diagLines = null;
            if (tokenType === 'bot' && interaction.guild) {
                const me = interaction.guild.members?.me
                    || interaction.guild.members.cache.get(client.user.id)
                    || null;
                const chPerms = me && interaction.channel && typeof interaction.channel.permissionsFor === 'function'
                    ? interaction.channel.permissionsFor(me)
                    : null;
                diagLines = buildPermissionDiagLines(chPerms);
            }
            await interaction.reply(buildIntroPayload(botName, diagLines)).catch(() => {});
            return;
        }

        if (commandName === 'اوامر' || commandName === 'مساعدة') {
            const botName = client.user.displayName || client.user.username;
            const [c1, c2] = buildHelpEmbeds(botName);
            await interaction.reply(v2Payload(c1, c2)).catch(async () => {
                await interaction.reply(v2Payload(c1, c2));
            });
        }

        else if (commandName === 'قناة-محادثة') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            const chanValue = interaction.options.getString('قناة', true);
            const ch = resolveChannelValue(guild, chanValue);
            if (!ch) {
                await interaction.reply({ content: '❌ ما لقيت القناة.' });
                return;
            }
            const added = await add_allowed_channel(guild.id, ch.id, agentId, allowed_channels_cache);
            if (!added) {
                await interaction.reply({
                    content: `⛔ وصلت للحد الأقصى (${MAX_CHANNELS_PER_GUILD} قنوات). احذف قناة أولاً بـ /حذف-قناة.`,
                });
                return;
            }
            await interaction.reply({
                content: `✅ تم إضافة **#${ch.name}** للقنوات النشطة.\nالبوت سيستجيب الآن في هذه القناة.`,
            });
        }

        else if (commandName === 'قنوات-مسموحة') {
            const ids = await get_allowed_channels(guild.id, agentId, allowed_channels_cache);
            if (!ids.length) {
                await interaction.reply({
                    content: `📭 لا توجد قنوات مضافة بعد. استخدم **/قناة-محادثة** لإضافة قنوات (حد أقصى ${MAX_CHANNELS_PER_GUILD}).`,
                });
                return;
            }
            const lines = [`# القنوات النشطة (${ids.length}/${MAX_CHANNELS_PER_GUILD})\n`];
            for (const cid of ids) {
                const ch = guild.channels.cache.get(cid);
                lines.push(`- ${ch ? '#' + ch.name : '~~محذوفة~~'} (\`${cid}\`)`);
            }
            await interaction.reply({ content: lines.join('\n') });
        }

        else if (commandName === 'حذف-قناة') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            const chanValue = interaction.options.getString('قناة', true);
            const ch = resolveChannelValue(guild, chanValue);
            if (!ch) {
                await interaction.reply({ content: '❌ ما لقيت القناة.' });
                return;
            }
            const ids = await get_allowed_channels(guild.id, agentId, allowed_channels_cache);
            if (!ids.includes(ch.id)) {
                await interaction.reply({ content: `❌ **#${ch.name}** غير موجودة في القائمة.` });
                return;
            }
            await remove_allowed_channel(guild.id, ch.id, agentId, allowed_channels_cache);
            await interaction.reply({ content: `✅ تم حذف **#${ch.name}** من قنوات البوت.` });
        }

        else if (commandName === 'محادثة-جديدة') {
            const guildId = guild.id;
            const chanValue = interaction.options.getString('قناة') || interaction.channelId;
            const chObj = resolveChannelValue(guild, chanValue) || guild.channels.cache.get(chanValue);
            const targetChanId = chObj?.id || chanValue;
            // التحقق من وجود القناة
            if (!chObj) {
                await interaction.reply({ content: '❌ القناة غير موجودة.' });
                return;
            }

            const mode = interaction.options.getString('وضع') || 'default';
            const thinking = (interaction.options.getString('تفكير') || 'off') === 'on';

            // إعادة تعيين جلسة القناة في RAM و DB + ذاكرة القناة الدائمة
            const key = `${guildId}_${targetChanId}`;
            await sessionLock.acquire(() => {
                channel_sessions.set(key, {
                    session_id: null,
                    parent_message_id: null,
                    mode: mode,
                    thinking: thinking,
                });
            });
            await db_reset_channel_session(guildId, targetChanId, agentId);
            // 🧷 تصفير ذاكرة القناة الدائمة أيضاً — بداية حوار نظيف فعلاً
            await channelHistory.clearChannel({ agentId, guildId, channelId: targetChanId }).catch(() => {});

            const chName = chObj.name || `ID:${targetChanId}`;
            const modeLabel = mode === 'expert' ? '🧠 خبير' : '🗨️ عادي';
            const thinkLbl = thinking ? '🔍 مفعّل' : '⚡ غير مفعّل';
            await interaction.reply({
                content: `✅ **تم إعادة تعيين محادثة #${chName}**\nالموديل: **${modeLabel}** | التفكير: **${thinkLbl}**`,
            });
        }

        else if (commandName === 'عرض-المحادثات') {
            const sessions = await db_list_channel_sessions(guild.id, agentId);
            if (!sessions.length) {
                await interaction.reply({ content: '📭 لا توجد محادثات محفوظة لهذا الوكيل بعد.' });
                return;
            }
            const lines = ['# محادثات الوكيل المحفوظة\n'];
            for (const session of sessions) {
                const ch = guild.channels.cache.get(String(session.channel_id));
                const updated = session.updated_at ? new Date(session.updated_at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
                lines.push(`- ${ch ? '#' + ch.name : 'قناة محذوفة'} (\`${session.channel_id}\`) — الوضع: **${session.mode || 'default'}** — التفكير: **${session.thinking ? 'مفعل' : 'مغلق'}** — آخر تحديث: ${updated}`);
            }
            await interaction.reply({ content: lines.join('\n') });
        }

        else if (commandName === 'حذف-محادثة') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            const chanValue = interaction.options.getString('قناة', true);
            const ch = resolveChannelValue(guild, chanValue);
            if (!ch) {
                await interaction.reply({ content: '❌ ما لقيت القناة.' });
                return;
            }
            await sessionLock.acquire(() => channel_sessions.delete(`${guild.id}_${ch.id}`));
            await db_reset_channel_session(guild.id, ch.id, agentId);
            await channelHistory.clearChannel({ agentId, guildId: guild.id, channelId: ch.id }).catch(() => {}); // 🧷 ذاكرة القناة تُصفّر معها
            await interaction.reply({ content: `✅ تم حذف/تصفير محادثة **#${ch.name}** لهذا الوكيل.` });
        }

        else if (commandName === 'رتبة-التحكم') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            const roleName = interaction.options.getString('role') || '';
            await set_control_role(guild.id, roleName, agentId);
            if (roleName) {
                await interaction.reply({ content: `✅ رتبة التحكم: **${roleName}**` });
            } else {
                await interaction.reply({ content: '✅ تم إزالة قيد الرتبة — الكل يقدر يستخدم البوت.' });
            }
        }

        else if (commandName === 'الرتبة-الحالية') {
            const role = await get_control_role(guild.id, agentId);
            if (role) {
                await interaction.reply({ content: `🔒 رتبة التحكم: **${role}**` });
            } else {
                await interaction.reply({ content: '🔓 لا يوجد قيد — الكل يقدر يستخدم البوت.' });
            }
        }


        else if (['حساب-خاص', 'حساب-منشن', 'حساب-تسليمات', 'حساب-قناة-فعاليات'].includes(commandName)) {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            const chanValue = interaction.options.getString('قناة', true);
            const ch = resolveChannelValue(guild, chanValue);
            if (!ch) {
                await interaction.reply({ content: '❌ ما لقيت القناة.' });
                return;
            }
            const keyMap = { 'حساب-خاص': 'dm_channel_id', 'حساب-منشن': 'mention_channel_id', 'حساب-تسليمات': 'deliveries_channel_id', 'حساب-قناة-فعاليات': 'event_channel_id' };
            await updateAccountSettings(agentId, guild.id, { [keyMap[commandName]]: ch.id });
            await interaction.reply({ content: `✅ تم تحديد **#${ch.name}** لإعداد **${commandName}** للحساب الحقيقي.` });
        }

        else if (commandName === 'حساب-رول-فعاليات') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            const roleQ = interaction.options.getString('role', true);
            const role = findRole(guild, roleQ);
            if (!role) {
                await interaction.reply({ content: '❌ ما لقيت الرتبة.' });
                return;
            }
            await updateAccountSettings(agentId, guild.id, { event_role_id: role.id });
            await interaction.reply({ content: `✅ تم تحديد رول الفعاليات: <@&${role.id}>` });
        }

        else if (commandName === 'فعاليات-وضع') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            const mode = interaction.options.getString('mode', true);
            await updateAccountSettings(agentId, guild.id, { mode });
            await interaction.reply({ content: `✅ وضع الفعاليات الآن: **${mode === 'auto' ? 'تلقائي' : 'يدوي'}**` });
        }

        else if (commandName === 'ابدأ-فعالية') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            await interaction.deferReply({ ephemeral: true }).catch(() => {});
            const count = interaction.options.getInteger('عدد') || null;
            const minutes = interaction.options.getInteger('دقائق') || null;
            const result = await runEventSeries(client, guild, interaction.channel, runtimeSettings, { gameName: interaction.options.getString('game'), count: count || 1, minutes: minutes || 0, first: true });
            const names = result.results.map(g => g.name).join('، ') || '—';
            await interaction.editReply({ content: `${result.ok ? '✅' : '⚠️'} ${result.msg} الألعاب: **${names}**.` }).catch(() => {});
        }

        else if (commandName === 'مزود-باو') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            // POW خاص بـ DeepSeek — وكلاء Qwen / OpenAI لا يحتاجونه إطلاقاً
            if (runtimeSettings.provider !== 'deepseek') {
                await interaction.reply({ content: `ℹ️ مزود POW خاص بمزود DeepSeek فقط — هذا الوكيل يعمل على **${getProviderOrFallback(runtimeSettings.provider).label}** ولا يحتاج POW.` });
                return;
            }
            const provider = interaction.options.getString('provider', true);
            await set_pow_provider(guild.id, provider, agentId);
            await interaction.reply({ content: `✅ تم تبديل مزود POW إلى **${provider}**` });
        }

        else if (commandName === 'المزود') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            const targetId = interaction.options.getString('الاسم');

            // ── عرض الحالة الحالية (بدون معامل) ──
            if (!targetId) {
                const current = getProviderOrFallback(runtimeSettings.provider);
                const lines = ['# 🧠 مزود الذكاء الاصطناعي لهذا الوكيل\n'];
                lines.push(`**الحالي:** ${current.emoji} ${current.label} (\`${current.id}\`)`);
                lines.push(`**الحالة:** ${current.describe(runtimeSettings.providerConfig)}`);
                lines.push('');
                lines.push('**المزودون المتاحون:**');
                for (const p of listProviders()) {
                    const cfg = extractProviderConfig({ ...agentConfigSnapshot || {}, provider: p.id });
                    const ready = p.validate(cfg).ok ? '✅ جاهز' : '⚠️ يحتاج إعدادات';
                    lines.push(`- ${p.emoji} **${p.label}** (\`${p.id}\`) — ${ready}`);
                }
                lines.push('');
                lines.push('> للتبديل: `/المزود الاسم:<المزود>` — يجب أن تكون إعدادات المزود الجديد محفوظة للوكيل (من لوحة التحكم أو المعالج).');
                await interaction.reply({ content: lines.join('\n') });
                return;
            }

            // ── تبديل المزود ──
            if (!isValidProvider(targetId)) {
                await interaction.reply({ content: `❌ مزود غير معروف: \`${targetId}\`` });
                return;
            }
            const target = getProviderOrFallback(targetId);
            if (targetId === runtimeSettings.provider) {
                await interaction.reply({ content: `ℹ️ المزود الحالي هو أصلاً ${target.emoji} **${target.label}**` });
                return;
            }

            // التحقق من توفر إعدادات المزود الجديد في قاعدة البيانات
            // 🔓 التبديل حر دائماً — النواقص لا تحجب، فقط تُنبّه ويُعلَّم الوكيل ناقص الإعدادات
            // حتى يكمل المالك بياناته من اللوحة (كان الحجب هنا يجعل التبديل مستحيلاً تماماً)
            const cfg = require('./config');
            const agentDoc = await cfg.agents_col.findOne({ _id: new (require('mongodb').ObjectId)(agentId) }).catch(() => null);
            const targetCfg = extractProviderConfig({ ...(agentDoc || agentConfigSnapshot || {}), provider: targetId });
            const targetValidation = target.validate(targetCfg);
            const incompleteNote = targetValidation.ok
                ? ''
                : `\n⚠️ **بيانات ${target.label} ناقصة** (\`${targetValidation.missing.join(', ')}\`) — لن يرد الوكيل حتى تكملها من لوحة التحكم: صفحة الوكيل ← «الإعدادات» ← «بيانات المزود»، أو زر «قيمة السر من ملف» للقيم الطويلة.`;

            // تحديث قاعدة البيانات + الذاكرة الحية (+ تعليم الوكيل ناقص الإعدادات إن لزم)
            await cfg.agents_col.updateOne(
                { _id: new (require('mongodb').ObjectId)(agentId) },
                {
                    $set: {
                        provider: targetId,
                        config_incomplete: !targetValidation.ok,
                        missing_provider_fields: targetValidation.ok ? [] : targetValidation.missing,
                        updated_at: new Date(),
                    },
                },
            );
            runtimeSettings.provider = targetId;
            runtimeSettings.providerConfig = targetCfg;

            // جلسات المزود القديم لا تصلح للمزود الجديد — تصفير حي.
            // 🧷 v7.11: ذاكرة القناة الدائمة لا تُمس — الحوار يكمل من حيث توقف
            // على المزود الجديد عبر الحقن التلقائي لآخر أحداث القناة.
            channel_sessions.clear();

            await interaction.reply({
                content: `✅ تم تبديل مزود الذكاء الاصطناعي إلى ${target.emoji} **${target.label}**\n` +
                    `${target.describe(targetCfg)}\n` +
                    `🧷 ذاكرة القنوات محفوظة بالكامل — الحوار يكمل من حيث توقف على المزود الجديد بدون أي نسيان.` +
                    incompleteNote,
            });
        }

        else if (commandName === 'اختبار-المزود') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            await interaction.deferReply({ ephemeral: true }).catch(() => {});
            const current = getProviderOrFallback(runtimeSettings.provider);
            try {
                const msg = await current.testConnection(runtimeSettings.providerConfig);
                await interaction.editReply({ content: `${current.emoji} **${current.label}**\n${msg}` }).catch(() => {});
            } catch (e) {
                await interaction.editReply({ content: `${current.emoji} **${current.label}**\n❌ فشل الاختبار: ${e.message}` }).catch(() => {});
            }
        }

        else if (commandName === 'الميزات') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            const target = interaction.options.getString('التبديل');
            const caps = runtimeSettings.capabilities || {};
            const feats = runtimeSettings.features || {};

            // ── تبديل إحدى الميزات/القدرات ──
            if (target) {
                const cfg = require('./config');
                let kind = null, newValue = false, label = '';
                if (target === 'thinking' || target === 'search') {
                    kind = 'capabilities';
                    const capabilities = { ...(caps), [target]: !(caps[target] === true) };
                    newValue = capabilities[target];
                    runtimeSettings.capabilities = capabilities;
                    label = target === 'thinking' ? 'التفكير العميق (قدرة النموذج)' : 'البحث المدمج (قدرة النموذج)';
                    try {
                        const doc = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
                        const merged = { ...(doc?.capabilities || {}), [target]: newValue };
                        await cfg.agents_col.updateOne(
                            { _id: new ObjectId(agentId) },
                            { $set: { capabilities: merged, updated_at: new Date() } },
                        );
                    } catch (_) {}
                } else if (target === 'read_url') {
                    kind = 'features';
                    const features = { ...(feats), read_url: feats.read_url !== false ? false : true };
                    newValue = features.read_url;
                    runtimeSettings.features = features;
                    label = 'قراءة الروابط (read_url)';
                    try {
                        const doc = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
                        const merged = { ...(doc?.features || {}), read_url: newValue };
                        await cfg.agents_col.updateOne(
                            { _id: new ObjectId(agentId) },
                            { $set: { features: merged, updated_at: new Date() } },
                        );
                    } catch (_) {}
                } else {
                    await interaction.reply({ content: '❌ ميزة غير معروفة. الخيارات: thinking / search / read_url' });
                    return;
                }

                await interaction.reply(v2Payload(agentEmbed({
                        title: newValue ? `🟢 ${label} مفعّلة الآن` : `🔴 ${label} معطّلة الآن`,
                        description: newValue
                            ? 'التغيير يعمل فوراً بدون إعادة تشغيل، ويُحفظ في اللوحة.'
                            : 'التغيير يعمل فوراً بدون إعادة تشغيل، ويُحفظ في اللوحة.',
                        color: newValue ? AGENT_COLORS.success : AGENT_COLORS.warning,
                        botName,
                    })));
                return;
            }

            // ── عرض الحالة ──
            const lines = [
                `${(caps.thinking === true) ? '🟢' : '🔴'} **التفكير العميق** (thinking) — قدرة النموذج الأصلية`,
                `${(caps.thinking === true) ? 'النموذج يفكر بعمق قبل كل رد (Qwen: thinking_enabled — DeepSeek: thinking_enabled — OpenAI: reasoning_effort).' : 'الردود مباشرة بدون تفكير عميق.'}`,
                '',
                `${(caps.search === true) ? '🟢' : '🔴'} **البحث المدمج** (search) — قدرة النموذج الأصلية`,
                `${(caps.search === true) ? 'النموذج يبحث في الإنترنت بواجهته الخاصة عند الحاجة — الأحدث والأدق، بلا أدوات بحث خارجية.' : 'النموذج يعتمد على معرفته الداخلية فقط.'}`,
                '',
                `${(feats.read_url !== false) ? '🟢' : '🔴'} **قراءة الروابط** (read_url) — أداة داخلية`,
                `${(feats.read_url !== false) ? 'يقرأ صفحات الروابط التي ترسلها له مباشرة.' : 'قراءة الروابط معطّلة — البحث والقراءة على النموذج نفسه.'}`,
                '',
                '> للتبديل: `/الميزات التبديل:<thinking|search|read_url>`',
                '> يُطبق التبديل فوراً بدون إعادة تشغيل — ويُحفظ في اللوحة.',
            ];
            const anyOn = (caps.thinking === true) || (caps.search === true) || (feats.read_url !== false);
            await interaction.reply(v2Payload(agentEmbed({
                    title: '⚙️ ميزات وقدرات هذا الوكيل',
                    description: linesBlock(lines),
                    color: anyOn ? AGENT_COLORS.success : AGENT_COLORS.warning,
                    botName,
                })));
        }

        else if (commandName === 'الاحصائيات') {
            if (!isAdmin) {
                await denyAdmin();
                return;
            }
            await interaction.deferReply({ ephemeral: true }).catch(() => {});
            const rows = await usage.getAgentUsage(agentId, 7).catch(() => []);
            const s = usage.summarize(rows);
            const providersLine = Object.keys(s.provider_calls).length
                ? Object.entries(s.provider_calls).map(([pid, n]) => `${pid}: **${n}**`).join(' — ')
                : '—';
            const toolsLine = s.top_tools.length
                ? s.top_tools.map(([t, n], i) => `${i + 1}. \`${t}\` — **${n}**`).join('\n')
                : '—';
            await interaction.editReply(v2Payload(agentEmbed({
                    title: '📊 إحصائيات آخر 7 أيام',
                    description: linesBlock([
                        `💬 **الرسائل المُعالجة:** ${s.messages}`,
                        `🔧 **استدعاءات الأدوات:** ${s.tool_calls}`,
                        `🌐 **استدعاءات الويب:** ${s.web_calls}`,
                        `🧠 **استدعاءات المزودين:** ${Object.values(s.provider_calls).reduce((a, b) => a + b, 0)}`,
                        providersLine !== '—' ? `↳ ${providersLine}` : null,
                        `🔄 **تبديلات Fallback:** ${s.fallbacks}`,
                        `❌ **الأخطاء:** ${s.errors}`,
                        `⏰ **التذكيرات المُرسلة:** ${s.reminders}`,
                        '',
                        '**أكثر الأدوات استخداماً:**',
                        toolsLine,
                        '',
                        '**الرسائل اليومية:**',
                        usage.renderBars(s.per_day),
                    ]),
                    botName,
                }))).catch(() => {});
        }

    } catch (error) {
        console.error(`[Slash Error] ${commandName}:`, error);
        // 🕶️ بلا تفاصيل تقنية في القناة — سطر محايد فقط، والتقرير الكامل لقناة الإشعارات
        errorReporter.reportAgentError({
            agentId,
            agentName,
            agentKind : runtimeSettings.kind,
            client,
            source    : 'slash',
            guild     : interaction.guild || null,
            channel   : interaction.channel || null,
            user      : interaction.user ? { id: interaction.user.id, username: interaction.user.username || '' } : null,
            error,
            context   : `أمر /${commandName}`,
        }).catch(() => {});
        try {
            const neutral = '⚠️ صار خلل بسيط أثناء تنفيذ الأمر — جرب مرة ثانية.';
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: neutral });
            } else {
                await interaction.followUp({ content: neutral });
            }
        } catch (_) {}
    }
});

// ══════════════════════════════════════════════════════════════
//  حدث MESSAGE — الرد على الرسائل
// ══════════════════════════════════════════════════════════════
client.on('messageCreate', async (message) => {
    // تجاهل رسائل الحساب نفسه
    if (message.author.id === client.user.id) return;

    const runtimeContext = runtimeSettings;
    if (await handleControlReply(client, message, runtimeContext).catch(() => false)) return;

    // رسائل الخاص للحساب الحقيقي تُحوّل إلى قناة التحكم المحددة.
    if (!message.guild) {
        // 🕵️ v7.16: الرسائل السرية للمافيا (اختيار ضحية/حماية) تصل على الخاص —
        // نمررها على محرك الألعاب أولاً (لا شيء يعمل إلا بجلسة مافيا حية من
        // نفس البوت). ملاحظة: لا نبتلع التحويل أبداً — المالك يرى الدور السري.
        await gamesPlayer.handleMessage({ client, message, agentId, runtimeSettings })
            .catch((e) => { console.error('[GamePlayer] DM handleMessage:', e?.message); return false; });
        if (tokenType === 'user') {
            for (const guild of client.guilds.cache.values()) {
                const settings = await getAccountSettings(agentId, guild.id);
                if (settings.dm_channel_id) {
                    await forwardMessage(client, message, settings.dm_channel_id, 'dm');
                    break;
                }
            }
        }
        return;
    }

    rememberActivity(agentId, message);
    await trackGameMessage(client, message, runtimeContext).catch(() => false);
    await maybeAutoEvent(client, message, runtimeContext).catch(() => false);
    await maybeScheduledEvent(client, message, runtimeContext).catch(() => false);

    // 🎮 محرك الألعاب (v7.14) — يعمل قبل منطق المنشن تماماً:
    // رسائل الألعاب تأتي من بوتات اللعبة وليست منشنات، والافتراضي معطل
    // فيرجع false فوراً بلا أي تغيير على السلوك. يرجع true فقط عندما
    // فعّل المالك «كتم الذكاء» وتمت معالجة رسالة لعبة فعلاً.
    const gameSwallow = await gamesPlayer.handleMessage({
        client, message, agentId, runtimeSettings,
    }).catch((e) => { console.error('[GamePlayer] handleMessage:', e?.message); return false; });
    if (gameSwallow) return;

    // التحقق من منشن البوت أو الرد على رسالته.
    const isMention = message.mentions.has(client.user.id) && !message.mentions.everyone;
    const isReplyToBot = message.reference
        && message.reference.messageId
        && (await message.fetchReference().catch(() => null))?.author?.id === client.user.id;

    // ═══════════════════════════════════════════════════
    //  📎 رفع شخصية من ملف — منشن + «شخصية» + مرفق نصي (أدمن/مالك فقط)
    // ═══════════════════════════════════════════════════
    if ((isMention || isReplyToBot) && message.attachments.size > 0) {
        const handled = await handlePersonalityUploadMessage(message).catch((e) => {
            console.error('[Personality Upload]', e.message);
            return false;
        });
        if (handled) return;
    }

    // ═══════════════════════════════════════════════════
    //  🤖 الاستباقية — رسالة غير موجّهة لي في قناة أُصغي فيها؟
    // ═══════════════════════════════════════════════════
    let proactiveHit = null;
    if (!isMention && !isReplyToBot) {
        if (runtimeSettings.proactive_enabled && runtimeSettings.proactive_channels.length) {
            proactiveHit = proactive.matchProactive({
                entries   : runtimeSettings.proactive_channels,
                channelId : message.channel.id,
                content   : message.content,
                isBot     : message.author.bot,
                isDm      : !message.guild,
                cooldowns : proactiveCooldowns,
                guildId   : message.guild?.id || '',
            });
        }
        if (!proactiveHit) return;
    }

    if (tokenType === 'user') {
        const settings = await getAccountSettings(agentId, message.guild.id);
        if (settings.mention_channel_id) await forwardMessage(client, message, settings.mention_channel_id, 'mention');
    }

    // التحقق من أن القناة ضمن المسموحات — الاستباقية تستثنى (قائمة الإصغاء إذنها المستقل)
    if (!proactiveHit) {
        const allowedIds = await get_allowed_channels(message.guild.id, agentId, allowed_channels_cache);
        if (!allowedIds.includes(message.channel.id)) {
            return;
        }
    }

    // ══════════════════════════════════════════════════════════════
    //  🛡️ v7.13 «بلا أدمن» — فحص القدرة على الرد قبل أي شيء
    //  شكوى المالك: وكلاء بلا رتبة أدمن يضعون إيموجي فقط ولا يردون.
    //  الجذر: لو كانت «إرسال الرسائل» مفقودة في القناة كان الرد يُولَّد
    //  بالذكاء الاصطناعي أولاً ثم يرمي 50013 — فيرى الناس إيموجي فقط.
    //  الآن: نفحص قبل استهلاك الـ AI إطلاقاً — ولا يشترط أدمن أبداً،
    //  يكفي الحد الأدنى (عرض القناة + إرسال الرسائل). الحسابات الحقيقية
    //  (user token) لا تُفحص — فهي تعمل بصلاحيات الحساب البشري نفسه.
    // ══════════════════════════════════════════════════════════════
    if (tokenType === 'bot') {
        const botMember = message.guild.members?.me
            || message.guild.members.cache.get(client.user.id)
            || null;
        const chPerms = botMember && typeof message.channel.permissionsFor === 'function'
            ? message.channel.permissionsFor(botMember)
            : null;
        const ability = checkReplyAbility({ perms: chPerms, hasBotMember: Boolean(botMember) });
        if (!ability.ok) {
            const missingNames = ability.missing.map((p) => `«${PERM_LABELS_AR[p] || p}»`).join(' و ');
            try { await message.react('🔇'); } catch (_) {}
            errorReporter.reportAgentError({
                agentId,
                agentName,
                agentKind : runtimeSettings.kind,
                client,
                source    : 'permissions',
                guild     : message.guild,
                channel   : message.channel,
                user      : { id: message.author.id, username: message.author.username || '' },
                error     : new Error(`البوت صامت في #${message.channel.name || '—'} — صلاحيات ناقصة: ${missingNames}`),
                context   : `لم تُستهلك أي خدمات ذكاء اصطناعي. الإصلاح (الأدمن غير مطلوب): إعدادات القناة ← صلاحيات الأدوار ← امنح رتبة البوت ${missingNames}، أو أضف رتبة بصلاحيات الإرسال للبوت.`,
            }).catch(() => {});
            return; // صمت مقصود مع إشارة واضحة — بلا هدر وبلا انسداد للقائمة
        }
    }

    // استخراج النص وإزالة منشن البوت
    let content = message.content;
    content = content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();

    // إضافة معلومات المنشنات الأخرى
    const otherMentions = message.mentions.users.filter(u => u.id !== client.user.id);
    if (otherMentions.size > 0) {
        const lines = ['\n[أعضاء تم منشنتهم في هذي الرسالة]'];
        for (const [id, user] of otherMentions) {
            const mem = message.guild.members.cache.get(id);
            const disp = mem ? mem.displayName : user.displayName;
            lines.push(`  - <@${id}> ← الاسم: ${disp} | اليوزرنيم: @${user.username} | الـ ID: ${id}`);
        }
        content += '\n' + lines.join('\n');
    }

    // معالجة المرفقات
    const attachedImages = []; // 🖼️ صور للرؤية (Qwen/OpenAI يرونها، Gemini/DeepSeek نصي)
    if (message.attachments.size > 0) {
        for (const [, att] of message.attachments) {
            if (att.contentType && String(att.contentType).startsWith('image/')) {
                attachedImages.push({ name: att.name, url: att.url, contentType: att.contentType });
                continue;
            }
            if (is_text_attachment(att)) {
                try {
                    const text = await fetchTextAttachment(att.url);
                    const ext = path.extname(att.name).replace('.', '') || '';
                    content += `\n[ملف: ${att.name}]\n\`\`\`${ext}\n${text}\n\`\`\``;
                } catch (e) {
                    content += `\n[ملف: ${att.name}] (خطأ: ${e.message})`;
                }
            } else {
                content += `\n[ملف غير نصي: ${att.name}]`;
            }
        }
    }

    if (!content.trim()) {
        await message.reply('وين أساعدك؟ 😄');
        return;
    }

    // 🤖 ملاحظة الاستباقية داخل السياق — الوكيل يعلم أن الرسالة جاءت من الإصغاء
    if (proactiveHit) {
        content = `[رسالة التُقطت بالاستباقية — تطابق الكلمة المفتاحية: "${proactiveHit.keyword}"]\n${content}`;
    }

    // حماية التعليمات الداخلية
    if (looks_like_internal_prompt_request(content)) {
        await message.reply('⛔ لا أستطيع عرض التعليمات الداخلية.');
        return;
    }

    // 🎭 قائمة انتظار القناة — «واحد واحد بس!» (طلب المالك — v7.9)
    // لو شخصين تكلما معي بنفس الوقت: أرد على الأول كاملاً ثم أجي للثاني بالترتيب.
    // رسالة المُنتظر تحصل على 👀 فقط — دلالة: «شفتك، إنت بالانتظار».
    // 🛠️ v7.12: المفتاح يبدأ بهويتي أنا (الوكيل) — لو كان وكيلاان في نفس القناة
    // فلكل منهما قائمته المستقلة، ولا ينتظر أحدهما رد الآخر أبداً.
    const chQueueKey = agentChannelKey(agentId, message.guild.id, message.channel.id);

    // تحديد مستوى صلاحية المرسل
    const accessLevel = getAccessLevel(message.member);

    // بناء معلومات المستخدم
    const author = message.author;
    const member = message.member;
    const nick = member?.nickname || null;
    const displayName = nick || author.globalName || author.username;
    const userInfo = (
        `[معلومات المستخدم]\n` +
        `  النكنيم في السيرفر : ${nick || '—'}\n` +
        `  الاسم العالمي      : ${author.globalName || '—'}\n` +
        `  اليوزرنيم          : @${author.username}\n` +
        `  الـ ID             : ${author.id}\n` +
        `  ناديه بـ           : ${displayName}\n` +
        `  كتب في             : #${message.channel.name}\n`
    );

    // بناء سياق البوت + 🧠 حقن ذكريات المستخدم تلقائياً
    let botContext = await buildBotContext(client, message.guild, message.channel, agentId, allowed_channels_cache);
    try {
        const memCtx = await memory.buildMemoryContext({ agentId, guildId: message.guild.id, userId: author.id });
        if (memCtx) botContext = `${botContext}\n\n${memCtx}`;
    } catch (_) {}

    // 🧷 الحفظ التلقائي الحتمي — «تذكر أنني...» يُحفظ فوراً من النظام نفسه
    // حتى لو لم يستدعِ النموذج أداة remember (ضمان عمل الذاكرة — v7.11)
    memory.maybeAutoCapture({ agentId, guildId: message.guild.id, userId: author.id, text: content })
        .catch(() => {});

    // 🎭 ما يلي (ساعة الرمل + الجلسة + runAgent + الرد) داخل قائمة القناة — بالترتيب الصارم
    const queued = enqueueChannelTask(chQueueKey, async () => {
        // بدأت دورتي — أزل 👀 (لو كانت علامة انتظار) وأظهر ⏳
        try {
            await message.reactions.cache.get('👀')?.users.remove(client.user.id).catch(() => {});
            await message.react('⏳');
        } catch (_) {}

        // جلسة القناة (per-channel) — داخل القائمة لضمان ترتيب القراءة والكتابة
        const chKey = `${message.guild.id}_${message.channel.id}`;
        let cs;
        await sessionLock.acquire(async () => {
            if (!channel_sessions.has(chKey)) {
                const loaded = await db_load_channel_session(message.guild.id, message.channel.id, agentId);
                if (loaded) {
                    channel_sessions.set(chKey, loaded);
                } else {
                    channel_sessions.set(chKey, {
                        session_id: null,
                        parent_message_id: null,
                        mode: 'default',
                        thinking: false,
                    });
                }
            }
            cs = channel_sessions.get(chKey);
        });

        const botName = tokenType === 'user' ? humanizeDisplayName(client.user.displayName || client.user.username) : (client.user.displayName || client.user.username);
        const mode = cs.mode || 'default';
        // 🧠 التفكير: جلسة القناة (محادثة-جديدة تفكير:on) أولوية، وقدرة الوكيل هي الافتراضي
        const thinking = Boolean(cs.thinking) || Boolean(runtimeSettings.capabilities?.thinking);

        try {
            // 📊 تتبع الاستخدام — رسالة مستخدم مُعالجة
            usage.track(agentId, message.guild.id, 'message').catch(() => {});

            // ⏱️ v7.13 ساعة توقف صارمة — مهمة عالقة (مزود لا يستجيب/شبكة ميتة)
            // لا تحتجز قائمة القناة أبداً: بعد المهلة تُحرر القائمة للرسائل
            // التالية فوراً + إيموجي ⏰ + تقرير للمالك. العمل المتأخر قد يكمل
            // بالخلفية (رد متأخر أفضل من صمت أبدي).
            const outcome = await withTaskTimeout(
                () => runAgent(
                    message.guild,
                    message.channel,
                    content,
                    userInfo,
                    botContext,
                    botName,
                    cs.session_id,
                    cs.parent_message_id,
                    message.guild.id,
                    mode,
                    thinking,
                    accessLevel,
                    client,
                    runtimeSettings,
                    {
                        userId: author.id,
                        username: author.username,
                        channelId: message.channel.id,
                        images: attachedImages, // 🖼️ صور الرسالة — تُرفع OSS لـ Qwen / image_url لـ OpenAI
                    },
                ),
                DEFAULT_TASK_TIMEOUT_MS,
            );

            if (outcome.timedOut) {
                try {
                    await message.reactions.cache.get('⏳')?.users.remove(client.user.id).catch(() => {});
                    await message.react('⏰');
                } catch (_) {}
                errorReporter.reportAgentError({
                    agentId,
                    agentName,
                    agentKind : runtimeSettings.kind,
                    client,
                    source    : 'timeout',
                    guild     : message.guild,
                    channel   : message.channel,
                    user      : { id: author.id, username: author.username || '' },
                    error     : new Error(`تجاوز توليد الرد الحد الزمني (${Math.round(DEFAULT_TASK_TIMEOUT_MS / 1000)} ثانية) — آخر من كلّمه: @${author.username}`),
                    context   : 'قائمة الانتظار حُررت تلقائياً — الرسائل التالية لن تبقى معلّقة بـ 👀. إن تكرر مع مزود بعينه فتأكد من حالته.',
                }).catch(() => {});
                return;
            }

            const result = outcome.result;

            // تحديث الجلسة في RAM و DB
            await sessionLock.acquire(() => {
                const current = channel_sessions.get(chKey) || {};
                current.session_id = result.newSid;
                current.parent_message_id = result.newPmid;
                channel_sessions.set(chKey, current);
            });
            if (result.newSid) {
                await db_save_channel_session(
                    message.guild.id,
                    message.channel.id,
                    result.newSid,
                    result.newPmid,
                    mode,
                    thinking,
                    agentId,
                );
            }

            // ═══════════════════════════════════════════════════
            //  🙈 حرية التجاهل — النموذج اختار عدم الرد بشخصيته (v7.11)
            //  لا يُرسل أي رد إطلاقاً — فقط إيموجي صامت على رسالة المستخدم
            //  يدل على أن النموذج رأى الرسالة وقرر ألا يرد عليها.
            // ═══════════════════════════════════════════════════
            if (result.ignored) {
                // 🧷 سجل الرسالة المتجاهلة في ذاكرة القناة (بصمة: تجاهلتُها عمداً)
                channelHistory.appendMessage({
                    agentId,
                    guildId: message.guild.id,
                    channelId: message.channel.id,
                    role: 'user',
                    content,
                    userId: author.id,
                    username: displayName,
                    ignored: true,
                }).catch(() => {});

                guildRegistry.recordActivity({
                    agentId,
                    agentName,
                    guildId    : message.guild.id,
                    guildName  : message.guild.name,
                    channelId  : message.channel.id,
                    channelName: message.channel.name,
                    userId     : author.id,
                    username   : author.username,
                }).catch(() => {});

                try {
                    await message.react('🙈');
                    await message.reactions.cache.get('⏳')?.users.remove(client.user.id).catch(() => {});
                } catch (_) {}
                return;
            }

            // 🧷 ذاكرة القناة الدائمة — رسالة المستخدم تُسجل قبل الرد
            await channelHistory.appendMessage({
                agentId,
                guildId: message.guild.id,
                channelId: message.channel.id,
                role: 'user',
                content,
                userId: author.id,
                username: displayName,
            }).catch(() => {});

            // 😄 تفاعل الإيموجي — لمسة بشرية (قد يكون الرد كله إيموجي بلا نص)
            if (Array.isArray(result.react) && result.react.length) {
                for (const em of result.react) {
                    await message.react(em).catch(() => {});
                }
            }

            const replyText = result.reply || '';
            const chunks = [];
            for (let i = 0; i < replyText.length; i += 1990) {
                chunks.push(replyText.slice(i, i + 1990));
            }

            const files = (result.filesToSend || []).map(fp => ({ attachment: fp, name: path.basename(fp) }));

            // 🧍 إيقاع بشري طبيعي (v7.11): وقت قراءة لرسالتك + وقت كتابة للرد —
            // بلا typing وهمي، فقط فاصل زمني طبيعي بين وصولك وردّه كأنه إنسان.
            if (chunks.length) {
                const jitter = (v) => Math.round(v * (0.75 + Math.random() * 0.5));
                const readingMs = Math.min(2000, jitter(content.length * 10));
                const typingMs = Math.min(4500, jitter((replyText.length || 40) * 8));
                const delay = Math.min(7000, 500 + readingMs + typingMs);
                await new Promise(r => setTimeout(r, delay));
            }

            if (chunks.length > 0) {
                // إرسال الجزء الأول مع الملفات إن وجدت
                const firstMsgOpts = { content: chunks[0] };
                if (files.length > 0) firstMsgOpts.files = files;
                await message.reply(firstMsgOpts);

                // باقي الأجزاء
                for (let i = 1; i < chunks.length; i++) {
                    await message.channel.send(chunks[i]);
                }

                // 🧷 ذاكرة القناة الدائمة — رد الوكيل يُسجل بعد إرساله فعلاً
                channelHistory.appendMessage({
                    agentId,
                    guildId: message.guild.id,
                    channelId: message.channel.id,
                    role: 'assistant',
                    content: replyText,
                    userId: null,
                    username: botName,
                }).catch(() => {});
            } else if (files.length > 0) {
                await message.reply({ files });
            }

            // تنظيف الملفات المؤقتة
            if (result.filesToSend) {
                for (const fp of result.filesToSend) {
                    try {
                        fs.unlinkSync(fp);
                    } catch (_) {}
                }
            }

            try {
                await message.react('☑️');
                await message.reactions.cache.get('⏳')?.users.remove(client.user.id).catch(() => {});
            } catch (_) {}

            // 🛰️ RAQEEB — نبضة نشاط للمالك: من/أين/متى (بلا محتوى الرسائل)
            guildRegistry.recordActivity({
                agentId,
                agentName,
                guildId    : message.guild.id,
                guildName  : message.guild.name,
                channelId  : message.channel.id,
                channelName: message.channel.name,
                userId     : author.id,
                username   : author.username,
            }).catch(() => {});

        } catch (error) {
            console.error('[Agent Error]', error);

            // 🛡️ v7.13 — لو فشل الإرسال نفسه بصلاحيات ناقصة (50013 Missing
            // Permissions) فالناس سيرون إيموجي فقط مهما حاولنا: التشخيص يجب
            // أن يصل للمالك بحلٍّ واضح (الأدمن غير مطلوب — يكفي الإرسال).
            const permFail = isMissingPermissionsError(error);

            // 🕶️ وجه البوكر: القناة العامة ترى اعتذاراً بشرياً فقط — بلا أي تفاصيل تقنية.
            // التقرير الكامل (التشخيص + الأثر + الموقع) يذهب لقناة الإشعارات.
            errorReporter.reportAgentError({
                agentId,
                agentName,
                agentKind : runtimeSettings.kind,
                client,
                source    : permFail ? 'permissions' : 'unexpected',
                guild     : message.guild || null,
                channel   : message.channel || null,
                user      : message.author ? { id: message.author.id, username: message.author.username || '' } : null,
                error,
                context   : permFail
                    ? 'اكتُشف بعد توليد الرد: البوت فقد صلاحية «إرسال الرسائل» في القناة. الإصلاح (الأدمن غير مطلوب): امنح رتبة البوت «إرسال الرسائل» + «عرض القناة» في إعدادات القناة.'
                    : '',
            }).catch(() => {});

            try {
                await message.reply(errorReporter.randomPublicFace());
            } catch (_) {}
            try {
                await message.react(permFail ? '🔐' : '❌');
                await message.reactions.cache.get('⏳')?.users.remove(client.user.id).catch(() => {});
            } catch (_) {}
        }
    });

    // علّم رسالة المُنتظر بـ 👀 فقط — لو كان في عمل قائم قبله في نفس القناة
    if (queued.wasBusy) {
        try { await message.react('👀'); } catch (_) {}
    }
});

// ══════════════════════════════════════════════════════════════
//  🎮 أحداث اللعب تعتمد على messageUpdate (v7.14):
//  زر الأخضر في زر/كراسي يظهر بتحديث رسالة البوت وليس بإنشائها —
//  نفس ما يعتمده مستودع Auto بالضبط. بلا تأثير على مسار المحادثة.
// ══════════════════════════════════════════════════════════════
client.on('messageUpdate', async (oldMessage, newMessage) => {
    try {
        const message = newMessage && typeof newMessage === 'object' ? newMessage : null;
        if (!message || !message.guild) return;
        await gamesPlayer.handleMessageUpdate({ client, message, agentId, runtimeSettings });
    } catch (_) {}
});


client.on('error', (err) => {
    console.error(`[Agent ${agentId}] Discord error:`, err);
    if (agentConfig.onError) agentConfig.onError(err);
});

// ══════════════════════════════════════════════════════════════
//  🛰️ RAQEEB — العلم التام للمالك (v7.9)
//  عند إضافة البوت لسيرفر: تسجيل من أضافه ومتى + إنشاء حساب
//  Qwen تلقائي خاص بذلك السيرفر + إشعار فوري لقناة الإشعارات.
// ══════════════════════════════════════════════════════════════
client.on('guildCreate', async (guild) => {
    try {
        await guildRegistry.recordGuildJoin(guild, client);
    } catch (e) {
        console.error('[Raqeeb] فشل تسجيل انضمام السيرفر:', e.message);
    }
    try {
        const acc = await qwenAccounts.ensureGuildAccount(guild.id, { reason: 'guild_join' });
        if (acc && !acc.ok) console.warn(`[QwenAccounts] حساب سيرفر ${guild.id}: ${acc.error || 'قيد التفعيل'}`);
    } catch (e) {
        console.error('[QwenAccounts] فشل إنشاء حساب السيرفر:', e.message);
    }
});

client.on('guildDelete', async (guild) => {
    try {
        await guildRegistry.recordGuildLeave(guild);
    } catch (e) {
        console.error('[Raqeeb] فشل تسجيل مغادرة السيرفر:', e.message);
    }
});

client.on('shardDisconnect', (event) => {
    if (!intentionalStop && agentConfig.onUnexpectedDisconnect) {
        agentConfig.onUnexpectedDisconnect(`shardDisconnect ${event?.code || ''} ${event?.reason || ''}`.trim());
    }
});

client.on('invalidated', () => {
    if (!intentionalStop && agentConfig.onUnexpectedDisconnect) {
        agentConfig.onUnexpectedDisconnect('session invalidated');
    }
});

    await client.login(discordToken);
    return {
        id: agentId,
        name: agentName,
        tokenType,
        client,
        // إعدادات المزود الحية — تُحدّث من لوحة التحكم بدون إعادة تشغيل
        runtimeSettings,
        channel_sessions,
        allowed_channels_cache,
        refreshAllowedChannels: async (guildId) => {
            const ids = await get_allowed_channels(guildId, agentId, allowed_channels_cache);
            allowed_channels_cache.set(`${agentId}:${String(guildId)}`, ids.map(String));
            return ids;
        },
        stop: () => {
            intentionalStop = true;
            try { client.__reminderEngine?.stop?.(); } catch (_) {} // ⏰ إيقاف محرك التذكيرات
            try { gamesPlayer.agentStop(agentId); } catch (_) {} // 🎮 تنظيف محرك الألعاب (v7.14)
            channel_sessions.clear();
            allowed_channels_cache.clear();
            client.removeAllListeners();
            client.destroy();
        },
    };
}

// 🔒 تصدير أغراض الاختبار: قائمة أوامر بوت الوكيل المعزولة + بطاقة /شرح
module.exports = { startAgentRuntime, agentBotCommands, buildIntroPayload };