'use strict';

const { ObjectId } = require('mongodb');
const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    ChannelType,
} = require('discord.js');

const DASH_PREFIX = 'dash';
const PAGE_SIZE = 25;

const { getProviderOrFallback, listProviders, extractProviderConfig } = require('./providers');
const secrets = require('./secrets');
const knowledge = require('./knowledge');
const usage = require('./usage');
const proactive = require('./proactive');
const { is_text_attachment, fetchTextAttachment } = require('./utils');

// 📚 حالة رفع ملفات المعرفة: `${guildId}:${userId}` → { agentId, expiresAt }
const pendingKnowledgeUploads = new Map();
const KNOWLEDGE_UPLOAD_WINDOW_MS = 3 * 60 * 1000;
const KNOWLEDGE_MAX_FILE_BYTES = 1_000_000;

/** تسميات عربية لحقول الأسرار — لأزرار الكشف */
const SECRET_LABELS = Object.freeze({
    discord_token : 'توكن ديسكورد',
    deepseek_token: 'توكن DeepSeek',
    qwen_token    : 'توكن Qwen',
    openai_api_key: 'مفتاح OpenAI',
});

const COLORS = Object.freeze({
    primary: 0x5865F2,
    success: 0x57F287,
    danger : 0xED4245,
    warning: 0xFEE75C,
    info   : 0x3498DB,
    dark   : 0x2B2D31,
    live   : 0x9B59B6,
});

const ICONS = Object.freeze({
    panel: '🧭', agents: '👥', add: '➕', settings: '⚙️', notifications: '🔔', logs: '📜', stats: '📊', system: '🖥️',
    running: '🟢', stopped: '⚫', failed: '🔴', starting: '🟡', restarting: '🔄', bot: '🤖', user: '👤', back: '↩️', refresh: '🔄',
});

const DASHBOARD_COMMAND_ROUTES = Object.freeze({
    panel: 'home',
    'لوحة': 'home',
    'الوكلاء': 'agents',
    'انشاء-وكيل': 'create',
    'الاعدادات': 'settings',
    'الاشعارات': 'notifications',
    'السجلات': 'logs',
    'الاحصائيات': 'stats',
    'النظام': 'system',
    'تشغيل-يدوي': 'manual_run',
});

// ---------- حالة بناء الجدولة ----------
const scheduleBuilders = new Map(); // userId -> { agentId, guildId, step, frequency, days_count, slots:[] }

function dashboardCommands() {
    return [
        new SlashCommandBuilder().setName('panel').setDescription('Open the Disor AI Agents Control Center'),
        new SlashCommandBuilder().setName('لوحة').setDescription('فتح مركز تحكم وكلاء الذكاء الاصطناعي'),
        new SlashCommandBuilder().setName('الوكلاء').setDescription('فتح صفحة إدارة الوكلاء من لوحة التحكم'),
        new SlashCommandBuilder().setName('انشاء-وكيل').setDescription('فتح معالج إنشاء وكيل جديد من لوحة التحكم'),
        new SlashCommandBuilder().setName('الاعدادات').setDescription('فتح إعدادات منصة الوكلاء'),
        new SlashCommandBuilder().setName('الاشعارات').setDescription('فتح إعدادات إشعارات الوكلاء'),
        new SlashCommandBuilder().setName('السجلات').setDescription('فتح سجلات وتايملاين النظام'),
        new SlashCommandBuilder().setName('الاحصائيات').setDescription('فتح إحصائيات الوكلاء'),
        new SlashCommandBuilder().setName('النظام').setDescription('فتح حالة النظام والتشغيل'),
        new SlashCommandBuilder()
            .setName('تشغيل-يدوي')
            .setDescription('تشغيل عدد من الفعاليات يدوياً الآن')
            .addIntegerOption(opt =>
                opt.setName('count')
                    .setDescription('عدد الفعاليات')
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(25))
            .addStringOption(opt =>
                opt.setName('mode')
                    .setDescription('وضع الكردت')
                    .setRequired(true)
                    .addChoices(
                        { name: 'مع كردت', value: 'credits' },
                        { name: 'بدون كردت', value: 'no_credits' }
                    )),
    ];
}

function dashboardCommandRoute(commandName) {
    return DASHBOARD_COMMAND_ROUTES[String(commandName || '')] || null;
}

function isDashboardCommand(commandName) {
    return Boolean(dashboardCommandRoute(commandName));
}

function fmtDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function trim(text, max = 90) {
    const value = String(text || '');
    return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function tokenTypeLabel(agent) {
    return String(agent?.token_type || 'bot').toLowerCase() === 'user' ? 'User Account' : 'Bot Token';
}

function statusIcon(status) {
    const s = String(status || 'stopped').toLowerCase();
    if (s === 'running') return ICONS.running;
    if (s === 'failed') return ICONS.failed;
    if (s === 'starting') return ICONS.starting;
    if (s === 'restarting') return ICONS.restarting;
    return ICONS.stopped;
}

function agentIcon(agent) {
    return String(agent?.token_type || 'bot').toLowerCase() === 'user' ? ICONS.user : ICONS.bot;
}

function embed(title, description, color = COLORS.primary) {
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(description || '—')
        .setTimestamp()
        .setFooter({ text: 'Disor Control Center • Dashboard-grade management' });
}

function linesBlock(lines) {
    return ['━━━━━━━━━━━━━━━━━━━━', ...lines.filter(Boolean), '━━━━━━━━━━━━━━━━━━━━'].join('\n');
}

function button(id, label, style = ButtonStyle.Secondary, emoji, disabled = false) {
    const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style).setDisabled(disabled);
    if (emoji) b.setEmoji(emoji);
    return b;
}

function rowsFromButtons(buttons) {
    const rows = [];
    for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
    return rows;
}

async function managerSettings(guildId) {
    const cfg = require('./config');
    return cfg.settings_col.findOne({ scope: 'manager', guild_id: String(guildId || 'global') });
}

async function updateManagerSettings(guildId, patch) {
    const cfg = require('./config');
    await cfg.settings_col.updateOne(
        { scope: 'manager', guild_id: String(guildId || 'global') },
        { $set: { ...patch, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } },
        { upsert: true },
    );
}

async function hasDashboardAccess(interaction) {
    const cfg = require('./config');
    if (String(interaction.user.id) === String(cfg.BOT_OWNER_ID)) return true;
    const settings = interaction.guildId ? await managerSettings(interaction.guildId).catch(() => null) : null;
    const roleId = settings?.admin_role_id;
    if (!roleId || !interaction.member?.roles) return false;
    if (interaction.member.roles.cache?.has(roleId)) return true;
    return Array.isArray(interaction.member.roles) && interaction.member.roles.includes(roleId);
}

async function requireAccess(interaction) {
    if (await hasDashboardAccess(interaction)) return true;
    await interaction.reply({ embeds: [embed('⛔ صلاحية مرفوضة', linesBlock(['هذه لوحة إدارة مركزية ولا يمكن استخدامها إلا بواسطة المالك أو رتبة الإدارة المحددة.']), COLORS.danger)] }).catch(() => {});
    return false;
}

async function overview(manager) {
    const cfg = require('./config');
    const agents = await cfg.agents_col.find({}).sort({ created_at: -1 }).toArray();
    const logs = await cfg.logs_col.find({}).sort({ created_at: -1 }).limit(8).toArray();
    const counts = { total: agents.length, running: 0, stopped: 0, failed: 0, transitional: 0, bots: 0, users: 0 };
    for (const a of agents) {
        const s = String(a.status || 'stopped');
        if (s === 'running') counts.running++;
        else if (s === 'failed') counts.failed++;
        else if (['starting', 'stopping', 'restarting'].includes(s)) counts.transitional++;
        else counts.stopped++;
        if (String(a.token_type || 'bot') === 'user') counts.users++; else counts.bots++;
    }
    return { agents, logs, counts, activeRuntimeCount: manager.runtimes.size };
}

async function renderHome(manager, interaction) {
    const data = await overview(manager);
    const settings = interaction.guildId ? await managerSettings(interaction.guildId).catch(() => null) : null;
    const emb = embed(`${ICONS.panel} Disor AI Agents Control Center`, linesBlock([
        '**منصة SaaS داخل Discord لإدارة وكلاء الذكاء الاصطناعي.**',
        '',
        `${ICONS.agents} **الوكلاء:** ${data.counts.total} | ${ICONS.running} يعمل: ${data.counts.running} | ${ICONS.stopped} متوقف: ${data.counts.stopped} | ${ICONS.failed} فشل: ${data.counts.failed}`,
        `${ICONS.bot} **Bot Tokens:** ${data.counts.bots}  •  ${ICONS.user} **User Accounts:** ${data.counts.users}`,
        `${ICONS.system} **Runtimes نشطة:** ${data.activeRuntimeCount}`,
        `${ICONS.notifications} **قناة الإشعارات:** ${settings?.notification_channel_id ? `<#${settings.notification_channel_id}>` : 'غير محددة'}`,
        `${ICONS.settings} **رتبة الإدارة:** ${settings?.admin_role_id ? `<@&${settings.admin_role_id}>` : 'المالك فقط'}`,
        '',
        '**اختر قسمًا من الأسفل. كل شاشة تعمل كصفحة داخل تطبيق، لا كأمر نصي.**',
    ]), COLORS.live);
    const buttons = [
        button(`${DASH_PREFIX}:agents:0`, 'الوكلاء', ButtonStyle.Primary, ICONS.agents),
        button(`${DASH_PREFIX}:create`, 'إنشاء وكيل', ButtonStyle.Success, ICONS.add),
        button(`${DASH_PREFIX}:settings`, 'الإعدادات', ButtonStyle.Secondary, ICONS.settings),
        button(`${DASH_PREFIX}:notifications`, 'الإشعارات', ButtonStyle.Secondary, ICONS.notifications),
        button(`${DASH_PREFIX}:logs:0`, 'السجلات', ButtonStyle.Secondary, ICONS.logs),
        button(`${DASH_PREFIX}:stats`, 'الإحصائيات', ButtonStyle.Secondary, ICONS.stats),
        button(`${DASH_PREFIX}:system`, 'حالة النظام', ButtonStyle.Secondary, ICONS.system),
        button(`${DASH_PREFIX}:home`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
    ];
    return { embeds: [emb], components: rowsFromButtons(buttons) };
}

function agentOption(agent) {
    const id = String(agent._id);
    const providerObj = getProviderOrFallback(agent.provider);
    return {
        label: trim(`${statusIcon(agent.status)} ${agent.name || id}`, 100),
        value: id,
        description: trim(`${providerObj.emoji} ${providerObj.label} • ${tokenTypeLabel(agent)} • ${agent.status || 'stopped'}`, 100),
        emoji: String(agent.token_type || 'bot') === 'user' ? ICONS.user : ICONS.bot,
    };
}

async function renderAgents(manager, page = 0) {
    const cfg = require('./config');
    const total = await cfg.agents_col.countDocuments();
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
    const agents = await cfg.agents_col.find({}).sort({ updated_at: -1, created_at: -1 }).skip(safePage * PAGE_SIZE).limit(PAGE_SIZE).toArray();
    const emb = embed(`${ICONS.agents} الوكلاء`, linesBlock([
        '**اختر وكيلاً من القائمة لإدارة صفحة كاملة خاصة به.**',
        'لا تظهر معرفات MongoDB في الواجهة؛ الاختيار يتم بالاسم والحالة فقط.',
        '',
        `العدد الإجمالي: **${total}**`,
        `الصفحة: **${safePage + 1}/${pages}**`,
    ]), COLORS.info);
    const components = [];
    if (agents.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${DASH_PREFIX}:agent_select`)
                .setPlaceholder('اختر وكيلًا لإدارته')
                .addOptions(agents.map(agentOption)),
        ));
    }
    components.push(...rowsFromButtons([
        button(`${DASH_PREFIX}:home`, 'الرئيسية', ButtonStyle.Secondary, ICONS.back),
        button(`${DASH_PREFIX}:agents:${safePage - 1}`, 'السابق', ButtonStyle.Secondary, '⬅️', safePage <= 0),
        button(`${DASH_PREFIX}:agents:${safePage + 1}`, 'التالي', ButtonStyle.Secondary, '➡️', safePage >= pages - 1),
        button(`${DASH_PREFIX}:create`, 'إنشاء وكيل', ButtonStyle.Success, ICONS.add),
        button(`${DASH_PREFIX}:agents:${safePage}`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
    ]));
    return { embeds: [emb], components };
}

async function renderAgent(manager, agentId) {
    const cfg = require('./config');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    if (!agent) return { embeds: [embed('❌ الوكيل غير موجود', linesBlock(['قد يكون الوكيل حُذف أو لم يعد متاحًا.']), COLORS.danger)], components: rowsFromButtons([button(`${DASH_PREFIX}:agents:0`, 'عودة للوكلاء', ButtonStyle.Secondary, ICONS.back)]) };
    const id = String(agent._id);
    const running = manager.runtimes.has(id);
    const status = agent.status || (running ? 'running' : 'stopped');
    // 🔐 نسخة مفكوكة الأسرار للعرض والتحقق (العرض النهائي يقنّع الأسرار)
    const agentPlain = secrets.decryptAgentDoc(agent);
    const providerObj = getProviderOrFallback(agent.provider);
    const providerReady = providerObj.validate(extractProviderConfig(agentPlain)).ok;
    const emb = embed(`${agentIcon(agent)} ${agent.name || 'Agent'}`, linesBlock([
        `📌 **النوع:** ${tokenTypeLabel(agent)}`,
        `${providerObj.emoji} **المزود:** ${providerObj.label} — ${providerReady ? 'جاهز ✅' : 'ناقص ❌'}`,
        `↳ ${providerObj.describe(extractProviderConfig(agentPlain))}`,
        `${statusIcon(status)} **الحالة:** ${status}`,
        `🧩 **Runtime:** ${running ? 'متصل ونشط' : 'غير نشط'}`,
        `🎭 **الشخصية:** ${agent.personality ? trim(agent.personality, 120) : 'افتراضية'}`,
        `🔔 **قناة إشعارات الوكيل:** ${agent.notification_channel_id ? `<#${agent.notification_channel_id}>` : 'غير محددة'}`,
        `🕒 **آخر تحديث:** ${fmtDate(agent.updated_at)}`,
        `🧾 **آخر سبب حالة:** ${agent.status_reason || '—'}`,
        '',
        '**كل الإجراءات تتم من Manager Runtime فقط.**',
    ]), status === 'failed' ? COLORS.danger : running ? COLORS.success : COLORS.dark);
    const isRunning = status === 'running' || running;
    const isBusy = ['starting', 'stopping', 'restarting'].includes(status);
    // POW خاص بمزود DeepSeek فقط (تحدي إثبات عمل لـ chat.deepseek.com)
    // وكلاء Qwen / OpenAI لا يستخدمون POW — لا داعي لإظهار الزر لهم
    const isDeepSeekAgent = providerObj.id === 'deepseek';
    const actions = [
        button(`${DASH_PREFIX}:agent:${id}:start`, 'تشغيل', ButtonStyle.Success, '▶️', isRunning || isBusy),
        button(`${DASH_PREFIX}:agent:${id}:stop`, 'إيقاف', ButtonStyle.Danger, '⏹️', !isRunning || isBusy),
        button(`${DASH_PREFIX}:agent:${id}:restart`, 'إعادة تشغيل', ButtonStyle.Primary, '🔄', isBusy),
        button(`${DASH_PREFIX}:agent:${id}:settings`, 'الإعدادات', ButtonStyle.Primary, '⚙️'),
        button(`${DASH_PREFIX}:agent:${id}:edit`, 'تعديل', ButtonStyle.Secondary, '✏️'),
        button(`${DASH_PREFIX}:agent:${id}:aiprovider`, 'المزود', ButtonStyle.Secondary, '🧠'),
        button(`${DASH_PREFIX}:agent:${id}:channels`, 'القنوات', ButtonStyle.Secondary, '📡'),
        button(`${DASH_PREFIX}:agent:${id}:conversations`, 'المحادثات', ButtonStyle.Secondary, '💬'),
        button(`${DASH_PREFIX}:agent:${id}:knowledge`, 'المعرفة', ButtonStyle.Secondary, '📚'),
        button(`${DASH_PREFIX}:agent:${id}:usage:7`, 'الإحصائيات', ButtonStyle.Secondary, '📊'),
        button(`${DASH_PREFIX}:agent:${id}:proactive`, 'الاستباقية', ButtonStyle.Secondary, '🎯'),
        ...(isDeepSeekAgent ? [button(`${DASH_PREFIX}:agent:${id}:provider`, 'مزود POW', ButtonStyle.Secondary, '⚡')] : []),
        button(`${DASH_PREFIX}:agent:${id}:account`, 'الحساب والفعاليات', ButtonStyle.Secondary, '👤'),
        button(`${DASH_PREFIX}:agent:${id}:notify`, 'الإشعارات', ButtonStyle.Secondary, '🔔'),
        button(`${DASH_PREFIX}:agent:${id}:logs:0`, 'Timeline', ButtonStyle.Secondary, '📜'),
        button(`${DASH_PREFIX}:agent:${id}:delete_confirm`, 'حذف', ButtonStyle.Danger, '🗑️'),
        button(`${DASH_PREFIX}:agents:0`, 'عودة', ButtonStyle.Secondary, ICONS.back),
        button(`${DASH_PREFIX}:agent:${id}:view`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
    ];
    return { embeds: [emb], components: rowsFromButtons(actions) };
}

function createTypeView() {
    const emb = embed('➕ إنشاء وكيل — Wizard', linesBlock([
        '**الخطوة 1 من 3: اختر نوع الوكيل.**',
        `${ICONS.bot} Bot Token: يمكنه عرض واجهة Dashboard كواجهة فقط، والتنفيذ يبقى في Manager.`,
        `${ICONS.user} User Account: Runtime فقط بدون Slash/Application Commands.`,
        '',
        '**الخطوة التالية:** اختيار مزود الذكاء الاصطناعي (DeepSeek / Qwen / OpenAI) 🧠',
    ]), COLORS.success);
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${DASH_PREFIX}:create_type`)
            .setPlaceholder('اختر نوع الوكيل')
            .addOptions([
                { label: 'Bot Token', value: 'bot', description: 'واجهة UI اختيارية + Runtime AI', emoji: ICONS.bot },
                { label: 'User Account', value: 'user', description: 'Runtime فقط بدون Commands', emoji: ICONS.user },
            ]),
    );
    return { embeds: [emb], components: [row, ...rowsFromButtons([button(`${DASH_PREFIX}:home`, 'إلغاء والعودة', ButtonStyle.Secondary, ICONS.back)])] };
}

/**
 * الخطوة 2 من 3: اختيار مزود الذكاء الاصطناعي.
 * كل مزود له واجهة وإعدادات مختلفة تماماً في الخطوة التالية.
 */
function createProviderView(type) {
    const emb = embed('➕ إنشاء وكيل — Wizard', linesBlock([
        '**الخطوة 2 من 3: اختر مزود الذكاء الاصطناعي.**',
        '',
        ...listProviders().map(p => `${p.emoji} **${p.label}** — ${p.description}`),
        '',
        'حسب اختيارك ستظهر نافذة بإعدادات مختلفة تماماً لكل مزود.',
        'نوع الوكيل المختار: **' + (type === 'user' ? 'User Account' : 'Bot Token') + '**',
    ]), COLORS.success);
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${DASH_PREFIX}:create_provider:${type}`)
            .setPlaceholder('اختر مزود الذكاء الاصطناعي')
            .addOptions(listProviders().map(p => ({
                label       : p.label,
                value       : p.id,
                description : trim(p.description, 100),
                emoji       : p.emoji,
            }))),
    );
    return { embeds: [emb], components: [row, ...rowsFromButtons([
        button(`${DASH_PREFIX}:create`, 'رجوع لنوع الوكيل', ButtonStyle.Secondary, ICONS.back),
        button(`${DASH_PREFIX}:home`, 'إلغاء', ButtonStyle.Secondary, '❌'),
    ])] };
}

/**
 * نافذة إنشاء الوكيل — تتغير بالكامل حسب المزود المختار.
 * كل مزود يعرّف حقوله في providers/<id>.js (modalFields).
 */
function createAgentModal(type, providerId = 'deepseek') {
    const providerObj = getProviderOrFallback(providerId);
    const typeLabel = type === 'user' ? 'User Account Runtime' : 'Bot Agent';
    const modal = new ModalBuilder()
        .setCustomId(`${DASH_PREFIX}:create_modal:${type}:${providerObj.id}`)
        .setTitle(trim(`إنشاء ${typeLabel} — ${providerObj.label}`, 45));

    // الحقول الثابتة المشتركة
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('اسم الوكيل').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('discord_token').setLabel(type === 'user' ? 'User Token' : 'Discord Bot Token').setStyle(TextInputStyle.Short).setRequired(true)),
    );

    // حقول المزود — تختلف بالكامل من مزود لآخر
    // (حد ديسكورد 5 صفوف: اسم + توكن ديسكورد + حتى 3 حقول مزود)
    const providerRows = providerObj.modalFields.slice(0, 3).map(field => new ActionRowBuilder().addComponents(
        new TextInputBuilder()
            .setCustomId(field.id)
            .setLabel(trim(field.label, 45))
            .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
            .setRequired(Boolean(field.required))
            .setMaxLength(field.maxLength || 300),
    ));
    for (const row of providerRows) modal.addComponents(row);

    // الشخصية: فقط إذا بقي مكان ضمن حد 5 صفوف
    if (2 + providerObj.modalFields.length < 5) {
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId('personality').setLabel('الشخصية / Personality').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500),
        ));
    }
    return modal;
}

function safeModalValue(value, max) {
    return String(value || '').slice(0, max);
}

function conversationCreateModal(agentId) {
    const modal = new ModalBuilder().setCustomId(`${DASH_PREFIX}:conversation_create_modal:${agentId}`).setTitle('إنشاء محادثة وكيل');
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('channel_id').setLabel('ID القناة').setStyle(TextInputStyle.Short).setRequired(true)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mode').setLabel('الوضع: default أو expert').setStyle(TextInputStyle.Short).setRequired(false).setValue('default')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('thinking').setLabel('التفكير: on أو off').setStyle(TextInputStyle.Short).setRequired(false).setValue('off')),
    );
    return modal;
}

function accountRunModal(agentId) {
    const modal = new ModalBuilder().setCustomId(`${DASH_PREFIX}:account_run_modal:${agentId}`).setTitle('إعدادات تشغيل الفعاليات');
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('manual_default_count').setLabel('عدد اليدوي الافتراضي').setStyle(TextInputStyle.Short).setRequired(false).setValue('1')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('auto_run_count').setLabel('عدد التلقائي عند الخمول').setStyle(TextInputStyle.Short).setRequired(false).setValue('3')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('auto_run_minutes').setLabel('مدة التلقائي بالدقائق (0 لتعطيلها)').setStyle(TextInputStyle.Short).setRequired(false).setValue('0')),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('schedule_slots').setLabel('جدول UTC مثل 20:00-22:00#5,23:00-23:30#2').setStyle(TextInputStyle.Paragraph).setRequired(false)),
    );
    return modal;
}

/**
 * نافذة تعديل الوكيل — حقول المزود تتطلب حسب مزود الوكيل نفسه.
 * حقول بيانات الاعتماد تبقى فارغة (اختيارية) ولا تُستبدل إلا بإدخال جديد.
 */
function editAgentModal(agent) {
    const providerObj = getProviderOrFallback(agent.provider);
    const modal = new ModalBuilder().setCustomId(`${DASH_PREFIX}:edit_modal:${agent._id}`).setTitle(trim(`تعديل الوكيل — ${providerObj.label}`, 45));

    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('اسم الوكيل').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80).setValue(safeModalValue(agent.name, 80))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('personality').setLabel('الشخصية').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500).setValue(safeModalValue(agent.personality, 1500))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('discord_token').setLabel('Discord Token جديد (اختياري)').setStyle(TextInputStyle.Short).setRequired(false)),
    );

    // حقول المزود الخاصة — حتى 3 حقول ضمن حد ديسكورد
    const knownValues = {
        deepseek_token : '',
        qwen_token     : '',
        qwen_model     : safeModalValue(agent.qwen_model, 100),
        openai_base_url: safeModalValue(agent.openai_base_url, 300),
        openai_api_key : '',
        openai_model   : safeModalValue(agent.openai_model, 100),
    };
    for (const field of providerObj.modalFields.slice(0, 3)) {
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId(field.id)
                .setLabel(trim(`${field.label} (اتركه فارغاً للإبقاء)`, 45))
                .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(field.maxLength || 300)
                .setValue(knownValues[field.id] || ''),
        ));
    }
    return modal;
}

async function renderNotifications(agentId = null, guildId = null) {
    const cfg = require('./config');
    const settings = guildId ? await managerSettings(guildId).catch(() => null) : null;
    const agent = agentId ? await cfg.agents_col.findOne({ _id: new ObjectId(agentId) }) : null;
    const emb = embed('🔔 الإشعارات', linesBlock([
        '**إدارة مسارات الإشعارات المهمة.**',
        `📡 القناة العامة: ${settings?.notification_channel_id ? `<#${settings.notification_channel_id}>` : 'غير محددة'}`,
        agent ? `🤖 الوكيل: **${agent.name}**` : null,
        agent ? `🔔 قناة الوكيل: ${agent.notification_channel_id ? `<#${agent.notification_channel_id}>` : 'غير محددة'}` : null,
        '',
        'الأحداث: تشغيل، توقف، Restart، فشل، Disconnect، Reconnect، أخطاء Runtime، وتعديلات إدارية.',
    ]), COLORS.info);
    const components = [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(agent ? `${DASH_PREFIX}:agent:${agentId}:notify_channel` : `${DASH_PREFIX}:notify_global_channel`)
                .setPlaceholder(agent ? 'اختر قناة إشعارات لهذا الوكيل' : 'اختر قناة الإشعارات العامة')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
        ...rowsFromButtons([
            button(agent ? `${DASH_PREFIX}:agent:${agentId}:view` : `${DASH_PREFIX}:home`, 'عودة', ButtonStyle.Secondary, ICONS.back),
            button(`${DASH_PREFIX}:notify_test`, 'إرسال اختبار', ButtonStyle.Primary, '🧪'),
        ]),
    ];
    return { embeds: [emb], components };
}

async function renderSettings(guildId) {
    const settings = guildId ? await managerSettings(guildId).catch(() => null) : null;
    const emb = embed('⚙️ إعدادات المنصة', linesBlock([
        '**إعدادات Dashboard وRuntime من مكان واحد.**',
        `🛡️ رتبة الإدارة: ${settings?.admin_role_id ? `<@&${settings.admin_role_id}>` : 'المالك فقط'}`,
        `🔔 قناة الإشعارات العامة: ${settings?.notification_channel_id ? `<#${settings.notification_channel_id}>` : 'غير محددة'}`,
        `🔁 إعادة الاتصال: مفعلة عبر Manager Lifecycle`,
        `🧾 التسجيل: مفعّل في agent_logs`,
    ]), COLORS.dark);
    return { embeds: [emb], components: [
        new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:settings_admin_role`).setPlaceholder('اختر رتبة الإدارة للوحة')),
        ...rowsFromButtons([
            button(`${DASH_PREFIX}:notifications`, 'قناة الإشعارات', ButtonStyle.Secondary, ICONS.notifications),
            button(`${DASH_PREFIX}:home`, 'الرئيسية', ButtonStyle.Secondary, ICONS.back),
        ]),
    ] };
}

async function renderLogs(agentId = null, page = 0) {
    const cfg = require('./config');
    const query = agentId ? { agent_id: String(agentId) } : {};
    const total = await cfg.logs_col.countDocuments(query);
    const pages = Math.max(1, Math.ceil(total / 10));
    const safePage = Math.min(Math.max(Number(page) || 0, 0), pages - 1);
    const logs = await cfg.logs_col.find(query).sort({ created_at: -1 }).skip(safePage * 10).limit(10).toArray();
    const rows = logs.length ? logs.map((log) => `• **${fmtDate(log.created_at)}** — **${log.type}** — ${trim(log.message, 120)}`) : ['لا توجد سجلات بعد.'];
    const emb = embed(agentId ? '📜 Timeline الوكيل' : '📜 Timeline النظام', linesBlock([
        `الصفحة: **${safePage + 1}/${pages}**`,
        '',
        ...rows,
    ]), COLORS.dark);
    const back = agentId ? `${DASH_PREFIX}:agent:${agentId}:view` : `${DASH_PREFIX}:home`;
    return { embeds: [emb], components: rowsFromButtons([
        button(back, 'عودة', ButtonStyle.Secondary, ICONS.back),
        button(agentId ? `${DASH_PREFIX}:agent:${agentId}:logs:${safePage - 1}` : `${DASH_PREFIX}:logs:${safePage - 1}`, 'السابق', ButtonStyle.Secondary, '⬅️', safePage <= 0),
        button(agentId ? `${DASH_PREFIX}:agent:${agentId}:logs:${safePage + 1}` : `${DASH_PREFIX}:logs:${safePage + 1}`, 'التالي', ButtonStyle.Secondary, '➡️', safePage >= pages - 1),
    ]) };
}

async function renderStats(manager) {
    const data = await overview(manager);
    // 📊 ملخص الاستخدام الفعلي لكل الوكلاء (آخر 7 أيام)
    const cfg = require('./config');
    let usageLine = 'لا بيانات استخدام بعد.';
    try {
        const agents = await cfg.agents_col.find({}, { projection: { _id: 1 } }).limit(100).toArray();
        const totals = { messages: 0, tool_calls: 0, errors: 0, fallbacks: 0 };
        for (const a of agents) {
            const rows = await usage.getAgentUsage(String(a._id), 7).catch(() => []);
            const s = usage.summarize(rows);
            totals.messages += s.messages;
            totals.tool_calls += s.tool_calls;
            totals.errors += s.errors;
            totals.fallbacks += s.fallbacks;
        }
        usageLine = `آخر 7 أيام لكل الوكلاء: 💬 ${totals.messages} رسالة — 🔧 ${totals.tool_calls} أداة — 🔄 ${totals.fallbacks} fallback — ❌ ${totals.errors} خطأ`;
    } catch (_) {}
    const emb = embed('📊 الإحصائيات', linesBlock([
        `👥 إجمالي الوكلاء: **${data.counts.total}**`,
        `${ICONS.running} يعمل: **${data.counts.running}**`,
        `${ICONS.stopped} متوقف: **${data.counts.stopped}**`,
        `${ICONS.failed} فاشل: **${data.counts.failed}**`,
        `🧩 Runtimes نشطة: **${data.activeRuntimeCount}**`,
        `${ICONS.bot} Bot Tokens: **${data.counts.bots}**`,
        `${ICONS.user} User Accounts: **${data.counts.users}**`,
        '',
        usageLine,
        'إحصائيات مفصلة لكل وكيل: صفحة الوكيل ← زر «الإحصائيات» 📊',
    ]), COLORS.info);
    return { embeds: [emb], components: rowsFromButtons([button(`${DASH_PREFIX}:home`, 'الرئيسية', ButtonStyle.Secondary, ICONS.back), button(`${DASH_PREFIX}:stats`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh)]) };
}

async function renderSystem(manager) {
    const cfg = require('./config');
    const emb = embed('🖥️ حالة النظام', linesBlock([
        `Node.js: **${process.version}**`,
        `MongoDB URI: **${cfg.MONGODB_URI ? 'محدد' : 'غير محدد'}**`,
        `Manager Bot Token: **${cfg.DISCORD_TOKEN ? 'محدد' : 'غير محدد'}**`,
        `Legacy USER_TOKEN: **${cfg.USER_TOKEN ? 'محدد' : 'غير محدد'}**`,
        `Runtimes: **${manager.runtimes.size}**`,
        `Uptime: **${Math.floor(process.uptime())}s**`,
    ]), COLORS.dark);
    return { embeds: [emb], components: rowsFromButtons([button(`${DASH_PREFIX}:home`, 'الرئيسية', ButtonStyle.Secondary, ICONS.back), button(`${DASH_PREFIX}:system`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh)]) };
}

async function updateInteraction(interaction, payload) {
    if (interaction.isChatInputCommand()) return interaction.reply(payload);
    if (interaction.isStringSelectMenu() || interaction.isButton() || interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu()) return interaction.update(payload);
    return interaction.reply(payload);
}

// ---------- واجهة بناء الجدولة ----------
function scheduleSlotToLabel(slot, index) {
    const to12 = (h, m) => {
        const period = h >= 12 ? 'م' : 'ص';
        const hour12 = h % 12 || 12;
        return `${hour12}:${String(m).padStart(2,'0')} ${period}`;
    };
    if (slot.type === 'range') {
        return `${index+1}. ${to12(slot.start.hour, slot.start.minute)} - ${to12(slot.end.hour, slot.end.minute)} (نطاق زمني)`;
    } else {
        return `${index+1}. ${to12(slot.start.hour, slot.start.minute)} / ${slot.count} فعاليات`;
    }
}

function renderScheduleBuilder(state) {
    const slotList = state.slots.length
        ? state.slots.map((s, i) => scheduleSlotToLabel(s, i)).join('\n')
        : 'لم تُضف أي فترات بعد.';
    const freqLabel = state.frequency === 'once' ? 'اليوم فقط' : state.frequency === 'daily' ? 'يومي' : `${state.days_count} أيام`;
    const emb = embed('🗓️ تكوين الجدولة', linesBlock([
        `الوكيل: قيد التكوين`,
        `التكرار: **${freqLabel}**`,
        '',
        '**الفترات الزمنية:**',
        slotList,
        '',
        'استخدم الأزرار أدناه لإضافة فترات (نطاق زمني أو عدد فعاليات) ثم احفظ.',
    ]), COLORS.info);
    const components = [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:schedule_set_freq`).setPlaceholder('اختر التكرار').addOptions([
                { label: 'اليوم فقط', value: 'once' },
                { label: 'يومي', value: 'daily' },
                { label: 'عدد أيام', value: 'days' },
            ]),
        ),
        ...rowsFromButtons([
            button(`${DASH_PREFIX}:schedule_add_range`, 'نطاق زمني', ButtonStyle.Primary, '⏰'),
            button(`${DASH_PREFIX}:schedule_add_count`, 'عدد فعاليات', ButtonStyle.Primary, '🔢'),
            button(`${DASH_PREFIX}:schedule_remove`, 'حذف فترة', ButtonStyle.Danger, '🗑️', state.slots.length === 0),
            button(`${DASH_PREFIX}:schedule_save`, '💾 حفظ', ButtonStyle.Success),
            button(`${DASH_PREFIX}:schedule_cancel`, 'إلغاء', ButtonStyle.Secondary),
        ]),
    ];
    return { embeds: [emb], components };
}

function hourSelect(customId, placeholder) {
    const options = [];
    for (let h = 0; h < 24; h++) {
        const period = h >= 12 ? 'م' : 'ص';
        const hour12 = h % 12 || 12;
        options.push({ label: `${hour12}:00 ${period}`, value: String(h) });
    }
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions(options.slice(0,25))
    );
}

function minuteSelect(customId, placeholder) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).addOptions([
            { label: '00', value: '0' }, { label: '15', value: '15' }, { label: '30', value: '30' }, { label: '45', value: '45' }
        ])
    );
}

async function handleScheduleInteraction(interaction, manager) {
    const id = interaction.customId;
    const parts = id.split(':');
    const userId = interaction.user.id;

    if (id.startsWith(`${DASH_PREFIX}:schedule_start:`)) {
        const agentId = parts[2];
        scheduleBuilders.set(userId, { agentId, guildId: interaction.guildId, step: 'main', frequency: 'daily', days_count: 1, slots: [] });
        await interaction.update(renderScheduleBuilder(scheduleBuilders.get(userId)));
        return true;
    }

    if (!scheduleBuilders.has(userId)) return false;
    const state = scheduleBuilders.get(userId);

    if (id === `${DASH_PREFIX}:schedule_set_freq`) {
        const val = interaction.values[0];
        if (val === 'once' || val === 'daily') {
            state.frequency = val;
            await interaction.update(renderScheduleBuilder(state));
        } else if (val === 'days') {
            state.step = 'days_count';
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:schedule_days_count`).setPlaceholder('اختر عدد الأيام').addOptions(
                    Array.from({length:30}, (_,i) => ({ label: `${i+1} أيام`, value: String(i+1) }))
                )
            );
            await interaction.update({ embeds: [embed('🗓️ عدد الأيام', 'اختر عدد الأيام التي تبدأ من اليوم.')], components: [row, ...rowsFromButtons([button(`${DASH_PREFIX}:schedule_back`, 'رجوع', ButtonStyle.Secondary)])] });
        }
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_days_count`) {
        state.days_count = parseInt(interaction.values[0], 10);
        state.frequency = 'days';
        state.step = 'main';
        await interaction.update(renderScheduleBuilder(state));
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_back`) {
        state.step = 'main';
        await interaction.update(renderScheduleBuilder(state));
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_add_range`) {
        state.step = 'range_start_hour';
        await interaction.update({ embeds: [embed('⏰ نطاق زمني - ساعة البداية', 'اختر ساعة البداية (نظام 12 ساعة).')], components: [hourSelect(`${DASH_PREFIX}:schedule_range_start_hour`, 'ساعة البداية'), ...rowsFromButtons([button(`${DASH_PREFIX}:schedule_back`, 'رجوع', ButtonStyle.Secondary)])] });
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_range_start_hour`) {
        const hour = parseInt(interaction.values[0], 10);
        state.tempSlot = { type: 'range', start: { hour } };
        state.step = 'range_start_minute';
        await interaction.update({ embeds: [embed('⏰ نطاق زمني - دقيقة البداية', 'اختر دقيقة البداية.')], components: [minuteSelect(`${DASH_PREFIX}:schedule_range_start_min`, 'دقيقة البداية'), ...rowsFromButtons([button(`${DASH_PREFIX}:schedule_back`, 'رجوع', ButtonStyle.Secondary)])] });
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_range_start_min`) {
        state.tempSlot.start.minute = parseInt(interaction.values[0], 10);
        state.step = 'range_end_hour';
        await interaction.update({ embeds: [embed('⏰ نطاق زمني - ساعة النهاية', 'اختر ساعة النهاية.')], components: [hourSelect(`${DASH_PREFIX}:schedule_range_end_hour`, 'ساعة النهاية'), ...rowsFromButtons([button(`${DASH_PREFIX}:schedule_back`, 'رجوع', ButtonStyle.Secondary)])] });
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_range_end_hour`) {
        const hour = parseInt(interaction.values[0], 10);
        state.tempSlot.end = { hour };
        state.step = 'range_end_minute';
        await interaction.update({ embeds: [embed('⏰ نطاق زمني - دقيقة النهاية', 'اختر دقيقة النهاية.')], components: [minuteSelect(`${DASH_PREFIX}:schedule_range_end_min`, 'دقيقة النهاية'), ...rowsFromButtons([button(`${DASH_PREFIX}:schedule_back`, 'رجوع', ButtonStyle.Secondary)])] });
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_range_end_min`) {
        state.tempSlot.end.minute = parseInt(interaction.values[0], 10);
        state.slots.push(state.tempSlot);
        delete state.tempSlot;
        state.step = 'main';
        await interaction.update(renderScheduleBuilder(state));
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_add_count`) {
        state.step = 'count_start_hour';
        await interaction.update({ embeds: [embed('🔢 عدد فعاليات - ساعة البداية', 'اختر ساعة بدء الفعاليات.')], components: [hourSelect(`${DASH_PREFIX}:schedule_count_start_hour`, 'ساعة البداية'), ...rowsFromButtons([button(`${DASH_PREFIX}:schedule_back`, 'رجوع', ButtonStyle.Secondary)])] });
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_count_start_hour`) {
        const hour = parseInt(interaction.values[0], 10);
        state.tempSlot = { type: 'count', start: { hour } };
        state.step = 'count_start_minute';
        await interaction.update({ embeds: [embed('🔢 عدد فعاليات - دقيقة البداية', 'اختر دقيقة البداية.')], components: [minuteSelect(`${DASH_PREFIX}:schedule_count_start_min`, 'دقيقة البداية'), ...rowsFromButtons([button(`${DASH_PREFIX}:schedule_back`, 'رجوع', ButtonStyle.Secondary)])] });
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_count_start_min`) {
        state.tempSlot.start.minute = parseInt(interaction.values[0], 10);
        state.step = 'count_value';
        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:schedule_count_value`).setPlaceholder('اختر عدد الفعاليات').addOptions(
                Array.from({length:25}, (_,i) => ({ label: `${i+1}`, value: String(i+1) }))
            )
        );
        await interaction.update({ embeds: [embed('🔢 عدد فعاليات - العدد', 'اختر عدد الفعاليات.')], components: [row, ...rowsFromButtons([button(`${DASH_PREFIX}:schedule_back`, 'رجوع', ButtonStyle.Secondary)])] });
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_count_value`) {
        state.tempSlot.count = parseInt(interaction.values[0], 10);
        state.slots.push(state.tempSlot);
        delete state.tempSlot;
        state.step = 'main';
        await interaction.update(renderScheduleBuilder(state));
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_remove`) {
        if (state.slots.length === 0) return true;
        const options = state.slots.map((s, i) => ({ label: scheduleSlotToLabel(s, i).slice(0,100), value: String(i) }));
        const row = new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:schedule_remove_select`).setPlaceholder('اختر فترة للحذف').addOptions(options)
        );
        await interaction.update({ embeds: [embed('🗑️ حذف فترة', 'اختر الفترة التي تريد حذفها.')], components: [row, ...rowsFromButtons([button(`${DASH_PREFIX}:schedule_back`, 'رجوع', ButtonStyle.Secondary)])] });
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_remove_select`) {
        const idx = parseInt(interaction.values[0], 10);
        state.slots.splice(idx, 1);
        state.step = 'main';
        await interaction.update(renderScheduleBuilder(state));
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_save`) {
        const { updateAccountSettings } = require('./accountAgent');
        await updateAccountSettings(state.agentId, state.guildId, {
            schedule_config: {
                frequency: state.frequency,
                days_count: state.days_count,
                slots: state.slots,
            }
        });
        scheduleBuilders.delete(userId);
        await interaction.update(await renderAccountAdvanced(state.agentId, state.guildId));
        return true;
    }

    if (id === `${DASH_PREFIX}:schedule_cancel`) {
        scheduleBuilders.delete(userId);
        await interaction.update(await renderAccountAdvanced(state.agentId, state.guildId));
        return true;
    }

    return false;
}

// ---------- معالج التفاعلات الرئيسي ----------
async function handleDashboardInteraction(interaction, manager) {
    const commandRoute = interaction.isChatInputCommand?.() ? dashboardCommandRoute(interaction.commandName) : null;
    const commandOk = Boolean(commandRoute);
    const componentOk = interaction.customId && interaction.customId.startsWith(`${DASH_PREFIX}:`);
    if (!commandOk && !componentOk) return false;
    if (!await requireAccess(interaction)) return true;

    if (interaction.customId && interaction.customId.startsWith(`${DASH_PREFIX}:schedule_`)) {
        return handleScheduleInteraction(interaction, manager);
    }

    if (commandOk) {
        if (commandRoute === 'manual_run') {
            const cfg = require('./config');
            const count = interaction.options.getInteger('count', true);
            const mode = interaction.options.getString('mode', true); // 'credits' أو 'no_credits'
            const agents = await cfg.agents_col.find({}).sort({ name: 1 }).limit(25).toArray();
            if (!agents.length) {
                await interaction.reply({ embeds: [embed('❌ لا يوجد وكلاء', linesBlock(['لا يوجد وكلاء في قاعدة البيانات.']), COLORS.danger)], ephemeral: true });
                return true;
            }
            const emb = embed('🔧 تشغيل يدوي', linesBlock([
                '**اختر الوكيل الذي تريد تشغيل الفعاليات له.**',
                `عدد الفعاليات المطلوبة: **${count}**`,
                `الوضع: **${mode === 'no_credits' ? 'بدون كردت (أول فعالية فقط 5m)' : 'مع كردت'}**`,
            ]), COLORS.info);
            const row = new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`${DASH_PREFIX}:manual_run_select:${count}:${mode}`)
                    .setPlaceholder('اختر الوكيل')
                    .addOptions(agents.map(agentOption)),
            );
            await interaction.reply({ embeds: [emb], components: [row] });
            return true;
        }

        if (commandRoute === 'agents') return updateInteraction(interaction, await renderAgents(manager, 0));
        if (commandRoute === 'create') return updateInteraction(interaction, createTypeView());
        if (commandRoute === 'settings') return updateInteraction(interaction, await renderSettings(interaction.guildId));
        if (commandRoute === 'notifications') return updateInteraction(interaction, await renderNotifications(null, interaction.guildId));
        if (commandRoute === 'logs') return updateInteraction(interaction, await renderLogs(null, 0));
        if (commandRoute === 'stats') return updateInteraction(interaction, await renderStats(manager));
        if (commandRoute === 'system') return updateInteraction(interaction, await renderSystem(manager));
        return updateInteraction(interaction, await renderHome(manager, interaction));
    }

    const id = interaction.customId;
    const parts = id.split(':');

    if (id.startsWith(`${DASH_PREFIX}:manual_run_select:`)) {
        // التقسيم الصحيح: dash:manual_run_select:COUNT:MODE
        const partsManual = id.split(':');
        const count = parseInt(partsManual[2], 10);
        const mode = partsManual[3] || 'credits';
        const agentId = interaction.values[0];
        const noCredits = mode === 'no_credits';

        const cfg = require('./config');
        const { startEvent, WIN_RE, manualRunNoCredits } = require('./accountAgent');
        const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
        if (!agent) {
            await interaction.update({ embeds: [embed('❌ وكيل غير صالح', linesBlock(['الوكيل المختار لم يعد موجوداً.']), COLORS.danger)], components: [] });
            return true;
        }
        const runtime = manager.runtimes.get(String(agentId));
        if (!runtime || !runtime.client) {
            await interaction.update({ embeds: [embed('❌ الوكيل غير نشط', linesBlock(['يجب أن يكون الوكيل في حالة تشغيل (Runtime نشط) لتنفيذ الفعاليات.']), COLORS.danger)], components: [] });
            return true;
        }

        const { getAccountSettings } = require('./accountAgent');
        const settings = await getAccountSettings(agentId, interaction.guildId);
        const channelId = settings.event_channel_id || interaction.channelId;
        
        const agentGuild = runtime.client.guilds.cache.get(interaction.guildId) 
                        || await runtime.client.guilds.fetch(interaction.guildId).catch(() => null);
        const agentChannel = agentGuild?.channels.cache.get(channelId) 
                        || await runtime.client.channels.fetch(channelId).catch(() => null);

        if (!agentChannel || !agentChannel.send) {
            await interaction.update({ embeds: [embed('❌ قناة غير صالحة', linesBlock(['قناة الفعاليات غير موجودة أو لا يمكن للوكيل رؤيتها/الكتابة فيها.']), COLORS.danger)], components: [] });
            return true;
        }

        // منع توجيه النتائج إلى قناة التسليمات
        const noCreditsKey = `${agentId}:${interaction.guildId}`;
        if (noCredits) {
            manualRunNoCredits.set(noCreditsKey, true);
        }

        await interaction.update({ embeds: [embed('⏳ جاري تشغيل الفعاليات', linesBlock([`الوكيل: **${agent.name || agentId}**`, `عدد الفعاليات: **${count}**`, `الوضع: **${noCredits ? 'بدون كردت' : 'مع كردت'}**`, 'سيتم إرسال الفعالية التالية بعد ظهور نتيجة الفعالية السابقة.']), COLORS.info)], components: [] });

        try {
            let completed = 0;
            for (let i = 0; i < count; i++) {
                const game = await startEvent(runtime.client, agentGuild, agentChannel, runtime, null, i === 0, noCredits);
                try {
                    await agentChannel.awaitMessages({
                        filter: m => m.author.bot && WIN_RE.test(m.content),
                        max: 1,
                        time: 300_000,
                        errors: ['time']
                    });
                } catch (e) {}
                completed++;
            }
            await interaction.followUp({ embeds: [embed('✅ اكتملت الفعاليات', linesBlock([`تم تشغيل **${completed}** فعالية بنجاح عبر الوكيل **${agent.name || agentId}**`]), COLORS.success)], ephemeral: true });
        } catch (err) {
            await interaction.followUp({ embeds: [embed('❌ خطأ', linesBlock([`حدث خطأ أثناء تشغيل الفعاليات: ${err.message}`]), COLORS.danger)], ephemeral: true });
        } finally {
            if (noCredits) {
                manualRunNoCredits.delete(noCreditsKey);
            }
        }
        return true;
    }

    if (interaction.isStringSelectMenu() && id === `${DASH_PREFIX}:create_type`) {
        // الخطوة 2: اختيار مزود الذكاء الاصطناعي (واجهة كل مزود تختلف في النافذة التالية)
        await interaction.update(createProviderView(interaction.values[0]));
        return true;
    }
    if (interaction.isStringSelectMenu() && id.startsWith(`${DASH_PREFIX}:create_provider:`)) {
        const type = parts[2] === 'user' ? 'user' : 'bot';
        // ⚠️ المزود المختار يأتي من قيم القائمة المنسدلة (interaction.values[0])
        // وليس من customId — customId يحمل نوع الوكيل فقط (dash:create_provider:<type>)
        const selectedProviderId = (Array.isArray(interaction.values) && interaction.values[0]) || 'deepseek';
        await interaction.showModal(createAgentModal(type, selectedProviderId));
        return true;
    }
    if (interaction.isStringSelectMenu() && id === `${DASH_PREFIX}:agent_select`) {
        await interaction.update(await renderAgent(manager, interaction.values[0]));
        return true;
    }
    if (interaction.isChannelSelectMenu() && id === `${DASH_PREFIX}:notify_global_channel`) {
        await updateManagerSettings(interaction.guildId, { notification_channel_id: interaction.values[0] });
        await interaction.update(await renderNotifications(null, interaction.guildId));
        return true;
    }
    if (interaction.isRoleSelectMenu() && id === `${DASH_PREFIX}:settings_admin_role`) {
        await updateManagerSettings(interaction.guildId, { admin_role_id: interaction.values[0] });
        await interaction.update(await renderSettings(interaction.guildId));
        return true;
    }

    if (interaction.isModalSubmit() && id.startsWith(`${DASH_PREFIX}:create_modal:`)) {
        // الصيغة: dash:create_modal:<type>:<provider> — التوافق القديم: بدون مزود = deepseek
        const type = parts[2] === 'user' ? 'user' : 'bot';
        const providerObj = getProviderOrFallback(parts[3] || 'deepseek');

        // جمع إعدادات المزود من الحقول الخاصة به فقط
        const providerConfig = {};
        for (const field of providerObj.modalFields) {
            try {
                const v = interaction.fields.getTextInputValue(field.id);
                if (v && String(v).trim() !== '') providerConfig[field.id] = String(v).trim();
            } catch (_) { /* حقل اختياري غير مُدخل */ }
        }
        let personality = '';
        try { personality = interaction.fields.getTextInputValue('personality') || ''; } catch (_) {}

        const agent = await manager.createAgent({
            name: interaction.fields.getTextInputValue('name'),
            discord_token: interaction.fields.getTextInputValue('discord_token'),
            personality,
            token_type: type,
            provider: providerObj.id,
            providerConfig,
        });
        await manager.logAgent(String(agent._id), 'create', `تم إنشاء وكيل من Dashboard بمزود ${providerObj.label}`, { token_type: type, provider: providerObj.id });
        await interaction.reply(await renderAgent(manager, String(agent._id)));
        return true;
    }

    if (interaction.isModalSubmit() && id.startsWith(`${DASH_PREFIX}:edit_modal:`)) {
        const agentId = parts[2];
        const cfg = require('./config');
        const agentDoc = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
        if (!agentDoc) return updateInteraction(interaction, await renderAgent(manager, agentId));

        // حقول المزود الخاصة بوكيله هو — لا حقول مزودين آخرين
        const providerObj = getProviderOrFallback(agentDoc.provider);
        const collectible = ['name', 'personality', 'discord_token', ...providerObj.modalFields.map(f => f.id)];
        const $set = { updated_at: new Date() };
        for (const key of collectible) {
            let val = null;
            try { val = interaction.fields.getTextInputValue(key); } catch (_) {}
            if (val && String(val).trim() !== '') $set[key] = String(val).trim();
        }
        // 🔐 الأسرار تُشفّر قبل الحفظ (passthrough بلا مفتاح)
        secrets.encryptSecretsInPatch($set);
        await cfg.agents_col.updateOne({ _id: new ObjectId(agentId) }, { $set });

        // تحديث حي للإعدادات إن كان الوكيل يعمل الآن
        const liveRuntime = manager?.runtimes?.get?.(String(agentId));
        if (liveRuntime?.runtimeSettings) {
            if ($set.personality !== undefined) liveRuntime.runtimeSettings.personality = $set.personality;
            const { extractProviderConfig: extractCfg } = require('./providers');
            const fresh = secrets.decryptAgentDoc(await cfg.agents_col.findOne({ _id: new ObjectId(agentId) }));
            liveRuntime.runtimeSettings.providerConfig = extractCfg(fresh);
        }

        await manager.logAgent(agentId, 'update', 'تم تعديل إعدادات الوكيل من Dashboard', { fields: Object.keys($set).filter(k => k !== 'updated_at') });
        await interaction.reply(await renderAgent(manager, agentId));
        return true;
    }

    // ── ⚙️ نوافذ التعديل المجزأة (صفحة الإعدادات) ──

    if (interaction.isModalSubmit() && id.startsWith(`${DASH_PREFIX}:edit_identity_modal:`)) {
        const agentId = parts[2];
        const cfg = require('./config');
        const agentDoc = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
        if (!agentDoc) return updateInteraction(interaction, await renderAgent(manager, agentId));
        const $set = { updated_at: new Date() };
        try {
            const name = interaction.fields.getTextInputValue('name');
            if (name && String(name).trim()) $set.name = String(name).trim();
        } catch (_) {}
        try {
            const personality = interaction.fields.getTextInputValue('personality');
            if (personality !== undefined && String(personality).trim() !== '') $set.personality = String(personality).trim();
        } catch (_) {}
        await cfg.agents_col.updateOne({ _id: new ObjectId(agentId) }, { $set });
        const liveRuntime = manager?.runtimes?.get?.(String(agentId));
        if (liveRuntime?.runtimeSettings) {
            if ($set.personality !== undefined) liveRuntime.runtimeSettings.personality = $set.personality;
        }
        await manager.logAgent(agentId, 'update', 'تم تعديل هوية الوكيل (الاسم/الشخصية) من صفحة الإعدادات', { fields: Object.keys($set).filter(k => k !== 'updated_at') });
        await interaction.reply(await renderAgentSettings(agentId, interaction.guildId));
        return true;
    }

    if (interaction.isModalSubmit() && id.startsWith(`${DASH_PREFIX}:edit_token_modal:`)) {
        const agentId = parts[2];
        const cfg = require('./config');
        const agentDoc = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
        if (!agentDoc) return updateInteraction(interaction, await renderAgent(manager, agentId));
        let newToken = '';
        try { newToken = interaction.fields.getTextInputValue('discord_token') || ''; } catch (_) {}
        newToken = String(newToken).trim();
        if (!newToken) {
            return updateInteraction(interaction, await renderAgentSettings(agentId, interaction.guildId));
        }
        // 🔐 تشفير التوكن قبل الحفظ
        await cfg.agents_col.updateOne(
            { _id: new ObjectId(agentId) },
            { $set: { discord_token: secrets.encryptSecret(newToken), updated_at: new Date() } },
        );
        await manager.logAgent(agentId, 'update', 'تم تغيير توكن ديسكورد من صفحة الإعدادات', {});
        // التوكن الجديد يحتاج إعادة اتصال — إعادة تشغيل تلقائية إن كان يعمل
        if (manager?.runtimes?.has?.(String(agentId))) {
            await interaction.reply(await renderAgentSettings(agentId, interaction.guildId));
            await interaction.followUp({ content: '🔄 تم حفظ التوكن — جاري إعادة تشغيل الوكيل للاتصال به…', ephemeral: true }).catch(() => {});
            manager.restartAgent(String(agentId), 'discord token changed from settings').catch(() => {});
            return true;
        }
        await interaction.reply(await renderAgentSettings(agentId, interaction.guildId));
        return true;
    }

    if (interaction.isModalSubmit() && id.startsWith(`${DASH_PREFIX}:edit_creds_modal:`)) {
        const agentId = parts[2];
        const cfg = require('./config');
        const agentDoc = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
        if (!agentDoc) return updateInteraction(interaction, await renderAgent(manager, agentId));
        const providerObj = getProviderOrFallback(agentDoc.provider);
        const $set = { updated_at: new Date() };
        for (const field of providerObj.modalFields) {
            let val = null;
            try { val = interaction.fields.getTextInputValue(field.id); } catch (_) {}
            if (val && String(val).trim() !== '') $set[field.id] = String(val).trim();
        }
        // 🔐 الأسرار تُشفّر قبل الحفظ
        secrets.encryptSecretsInPatch($set);
        await cfg.agents_col.updateOne({ _id: new ObjectId(agentId) }, { $set });

        // تحديث حي لإعدادات المزود الحالية
        const liveRuntime = manager?.runtimes?.get?.(String(agentId));
        if (liveRuntime?.runtimeSettings) {
            const { extractProviderConfig: extractCfg } = require('./providers');
            const fresh = secrets.decryptAgentDoc(await cfg.agents_col.findOne({ _id: new ObjectId(agentId) }));
            liveRuntime.runtimeSettings.providerConfig = extractCfg(fresh);
            liveRuntime.runtimeSettings.fallback_configs = require('./providers').extractAllProviderConfigs(fresh);
        }
        await manager.logAgent(agentId, 'update', `تم تحديث بيانات مزود ${providerObj.label} من صفحة الإعدادات`, { fields: Object.keys($set).filter(k => k !== 'updated_at') });
        await interaction.reply(await renderAgentSettings(agentId, interaction.guildId));
        return true;
    }

    if (interaction.isModalSubmit() && id.startsWith(`${DASH_PREFIX}:proactive_modal:`)) {
        // الصيغة: dash:proactive_modal:<agentId>:<channelId>
        const agentId = parts[2];
        const channelId = parts[3];
        const cfg = require('./config');
        const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
        if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));

        const keywordsRaw = interaction.fields.getTextInputValue('keywords');
        const keywords = proactive.cleanKeywords(keywordsRaw);
        const cooldown = proactive.clampCooldown(interaction.fields.getTextInputValue('cooldown'));
        if (!keywords.length) {
            return updateInteraction(interaction, await renderAgentProactive(agentId, interaction.guildId, 'أدخل كلمة مفتاحية واحدة على الأقل (حرفان أو أكثر).'));
        }
        const entries = Array.isArray(agent.proactive_channels) ? [...agent.proactive_channels] : [];
        const existingIdx = entries.findIndex(e => String(e?.channel_id) === String(channelId));
        const entry = { channel_id: String(channelId), keywords, cooldown_minutes: cooldown };
        if (existingIdx >= 0) entries[existingIdx] = entry; else entries.push(entry);
        if (entries.length > 10) entries.length = 10; // حد أقصى 10 قنوات مُصغاة

        await cfg.agents_col.updateOne(
            { _id: new ObjectId(agentId) },
            { $set: { proactive_channels: entries, updated_at: new Date() } },
        );
        const liveRuntime = manager?.runtimes?.get?.(String(agentId));
        if (liveRuntime?.runtimeSettings) {
            liveRuntime.runtimeSettings.proactive_channels = entries;
        }
        await manager.logAgent(agentId, 'proactive_update', `إصغاء قناة ${channelId}: ${keywords.join('، ')} (تهدئة ${cooldown} د)`, { entry });
        await interaction.reply(await renderAgentProactive(agentId, interaction.guildId));
        return true;
    }

    if (interaction.isModalSubmit() && id.startsWith(`${DASH_PREFIX}:conversation_create_modal:`)) {
        const agentId = parts[2];
        const { db_save_channel_session } = require('./utils');
        const channelId = interaction.fields.getTextInputValue('channel_id').replace(/\D/g, '');
        const modeRaw = interaction.fields.getTextInputValue('mode') || 'default';
        const mode = modeRaw.toLowerCase().includes('expert') ? 'expert' : 'default';
        const thinkingRaw = interaction.fields.getTextInputValue('thinking') || 'off';
        const thinking = /^on|true|yes|1|مفعل/i.test(thinkingRaw);
        if (!channelId) {
            await interaction.reply({ content: '❌ اكتب ID قناة صحيح.', ephemeral: true });
            return true;
        }
        await db_save_channel_session(interaction.guildId, channelId, null, null, mode, thinking, agentId);
        const runtime = manager?.runtimes?.get?.(String(agentId));
        runtime?.channel_sessions?.set?.(`${interaction.guildId}_${channelId}`, { session_id: null, parent_message_id: null, mode, thinking });
        await manager.logAgent(agentId, 'conversation_create', 'تم إنشاء محادثة قناة من Dashboard', { channel_id: channelId, mode, thinking });
        await interaction.reply(await renderAgentConversations(agentId, interaction.guildId));
        return true;
    }

    if (interaction.isModalSubmit() && id.startsWith(`${DASH_PREFIX}:account_run_modal:`)) {
        const agentId = parts[2];
        const { updateAccountSettings } = require('./accountAgent');
        const patch = {
            manual_default_count: Number(interaction.fields.getTextInputValue('manual_default_count') || 1),
            auto_run_count: Number(interaction.fields.getTextInputValue('auto_run_count') || 3),
            auto_run_minutes: Number(interaction.fields.getTextInputValue('auto_run_minutes') || 0),
            schedule_slots: String(interaction.fields.getTextInputValue('schedule_slots') || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 6),
        };
        await updateAccountSettings(agentId, interaction.guildId, patch);
        await manager.logAgent(agentId, 'account_settings', 'تم تحديث تشغيل وسلاسل وجدولة الفعاليات', patch);
        await interaction.reply(await renderAccountAdvanced(agentId, interaction.guildId));
        return true;
    }

    if (parts[1] === 'home') return updateInteraction(interaction, await renderHome(manager, interaction));
    if (parts[1] === 'agents') return updateInteraction(interaction, await renderAgents(manager, parts[2]));
    if (parts[1] === 'create') return updateInteraction(interaction, createTypeView());
    if (parts[1] === 'settings') return updateInteraction(interaction, await renderSettings(interaction.guildId));
    if (parts[1] === 'notifications') return updateInteraction(interaction, await renderNotifications(null, interaction.guildId));
    if (parts[1] === 'logs') return updateInteraction(interaction, await renderLogs(null, parts[2]));
    if (parts[1] === 'stats') return updateInteraction(interaction, await renderStats(manager));
    if (parts[1] === 'system') return updateInteraction(interaction, await renderSystem(manager));
    if (parts[1] === 'notify_test') {
        await manager.notify({ type: 'test', agentId: 'manager', title: '🧪 اختبار الإشعارات', message: 'تم إرسال اختبار من لوحة التحكم.', guildId: interaction.guildId });
        return updateInteraction(interaction, await renderNotifications(null, interaction.guildId));
    }

    if (parts[1] === 'agent') {
        const agentId = parts[2];
        const action = parts[3];
        const cfg = require('./config');
        if (interaction.isChannelSelectMenu() && ['acct_dm','acct_mention','acct_event','acct_deliveries'].includes(action)) {
            const { updateAccountSettings } = require('./accountAgent');
            const map = { acct_dm: 'dm_channel_id', acct_mention: 'mention_channel_id', acct_event: 'event_channel_id', acct_deliveries: 'deliveries_channel_id' };
            await updateAccountSettings(agentId, interaction.guildId, { [map[action]]: interaction.values[0] });
            await manager.logAgent(agentId, 'account_settings', 'تم تحديث إعدادات الحساب الحقيقي من Dashboard', { field: map[action], value: interaction.values[0] });
            return interaction.update(await renderAccountSettings(agentId, interaction.guildId));
        }
        if (interaction.isRoleSelectMenu() && action === 'acct_role') {
            const { updateAccountSettings } = require('./accountAgent');
            await updateAccountSettings(agentId, interaction.guildId, { event_role_id: interaction.values[0] });
            await manager.logAgent(agentId, 'account_settings', 'تم تحديث رول فعاليات الحساب الحقيقي', { role_id: interaction.values[0] });
            return interaction.update(await renderAccountAdvanced(agentId, interaction.guildId));
        }
        if (interaction.isStringSelectMenu() && action === 'acct_mode') {
            const { updateAccountSettings } = require('./accountAgent');
            await updateAccountSettings(agentId, interaction.guildId, { mode: interaction.values[0] });
            await manager.logAgent(agentId, 'account_settings', 'تم تحديث وضع فعاليات الحساب الحقيقي', { mode: interaction.values[0] });
            return interaction.update(await renderAccountAdvanced(agentId, interaction.guildId));
        }
        if (interaction.isChannelSelectMenu() && action === 'notify_channel') {
            await cfg.agents_col.updateOne({ _id: new ObjectId(agentId) }, { $set: { notification_channel_id: interaction.values[0], updated_at: new Date() } });
            await manager.logAgent(agentId, 'notification_channel', 'تم تحديث قناة إشعارات الوكيل');
            return interaction.update(await renderNotifications(agentId, interaction.guildId));
        }
        if (interaction.isChannelSelectMenu() && action === 'channel_add') {
            const { add_allowed_channel, get_allowed_channels } = require('./utils');
            const added = await add_allowed_channel(interaction.guildId, interaction.values[0], agentId);
            const ids = await get_allowed_channels(interaction.guildId, agentId);
            syncRuntimeAllowedChannels(manager, agentId, interaction.guildId, ids);
            await manager.logAgent(agentId, added ? 'channel_add' : 'channel_add_limit', added ? 'تمت إضافة قناة محادثة من Dashboard' : 'فشل إضافة قناة محادثة بسبب الحد الأقصى', { channel_id: interaction.values[0] });
            return interaction.update(await renderAgentChannels(agentId, interaction.guildId, added ? null : 'وصل الوكيل للحد الأقصى للقنوات، احذف قناة ثم حاول مجددًا.'));
        }
        if (interaction.isStringSelectMenu() && action === 'channel_remove') {
            const { remove_allowed_channel, get_allowed_channels } = require('./utils');
            await remove_allowed_channel(interaction.guildId, interaction.values[0], agentId);
            const ids = await get_allowed_channels(interaction.guildId, agentId);
            syncRuntimeAllowedChannels(manager, agentId, interaction.guildId, ids);
            await manager.logAgent(agentId, 'channel_remove', 'تم حذف قناة محادثة من Dashboard', { channel_id: interaction.values[0] });
            return interaction.update(await renderAgentChannels(agentId, interaction.guildId));
        }
        if (interaction.isStringSelectMenu() && action === 'provider_set') {
            const { set_pow_provider } = require('./utils');
            await set_pow_provider(interaction.guildId, interaction.values[0], agentId);
            await manager.logAgent(agentId, 'provider_update', 'تم تحديث مزود POW للوكيل من Dashboard', { provider: interaction.values[0] });
            return interaction.update(await renderAgentProvider(agentId, interaction.guildId));
        }
        if (interaction.isStringSelectMenu() && action === 'aiprovider_set') {
            // تبديل مزود الذكاء الاصطناعي — لا يمس إعدادات المزودين الآخرين
            const agent = secrets.decryptAgentDoc(await cfg.agents_col.findOne({ _id: new ObjectId(agentId) }));
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            const newProviderId = interaction.values[0];
            const targetP = getProviderOrFallback(newProviderId);
            const targetCfg = extractProviderConfig({ ...agent, provider: newProviderId });
            const v = targetP.validate(targetCfg);
            if (!v.ok) {
                const emb = embed('❌ لا يمكن التبديل إلى ' + targetP.label, linesBlock([
                    `إعدادات المزود ناقصة لهذا الوكيل: **${v.missing.join(', ')}**`,
                    '',
                    'احفظ إعدادات المزود أولاً من زر **تعديل** في صفحة الوكيل،',
                    'أو أنشئ الوكيل من جديد باختيار هذا المزود في المعالج.',
                ]), COLORS.danger);
                return interaction.update({ embeds: [emb], components: rowsFromButtons([
                    button(`${DASH_PREFIX}:agent:${agentId}:aiprovider`, 'عودة', ButtonStyle.Secondary, ICONS.back),
                ]) });
            }
            await cfg.agents_col.updateOne(
                { _id: new ObjectId(agentId) },
                { $set: { provider: targetP.id, updated_at: new Date() } },
            );
            // تحديث حي للـ Runtime بدون إعادة تشغيل
            const liveRuntime = manager?.runtimes?.get?.(String(agentId));
            if (liveRuntime?.runtimeSettings) {
                liveRuntime.runtimeSettings.provider = targetP.id;
                liveRuntime.runtimeSettings.providerConfig = targetCfg;
            }
            liveRuntime?.channel_sessions?.clear?.(); // جلسات المزود القديم لا تصلح للجديد
            await manager.logAgent(agentId, 'ai_provider_update', `تم تبديل مزود الذكاء الاصطناعي إلى ${targetP.label}`, { provider: targetP.id });
            return interaction.update(await renderAgentAIProvider(agentId, interaction.guildId));
        }
        if (interaction.isStringSelectMenu() && action === 'aiprovider_fb_set') {
            // إضافة/إزالة مزود من سلسلة Fallback — لا يمس إعدادات المزودين
            const agent = secrets.decryptAgentDoc(await cfg.agents_col.findOne({ _id: new ObjectId(agentId) }));
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            const [op, pid] = String(interaction.values[0]).split(':');
            const targetP = getProviderOrFallback(pid);
            const chain = Array.isArray(agent.fallback_chain) ? [...agent.fallback_chain] : [];
            if (op === 'add') {
                if (targetP.id === agent.provider) {
                    return interaction.update({ embeds: [embed('ℹ️ لا يمكن', linesBlock([`**${targetP.label}** هو المزود الأساسي نفسه — اختر مزوداً آخر كبديل.`]), COLORS.warning)], components: [] });
                }
                if (!chain.includes(targetP.id)) chain.push(targetP.id);
            } else if (op === 'remove') {
                const idx = chain.indexOf(targetP.id);
                if (idx !== -1) chain.splice(idx, 1);
            }
            await cfg.agents_col.updateOne(
                { _id: new ObjectId(agentId) },
                { $set: { fallback_chain: chain, updated_at: new Date() } },
            );
            // تحديث حي للـ Runtime
            const liveRuntime = manager?.runtimes?.get?.(String(agentId));
            if (liveRuntime?.runtimeSettings) {
                liveRuntime.runtimeSettings.fallback_chain = chain;
                liveRuntime.runtimeSettings.fallback_configs = extractAllProviderConfigs({ ...agent, fallback_chain: chain });
            }
            await manager.logAgent(agentId, 'fallback_update', `${op === 'add' ? 'إضافة' : 'إزالة'} ${targetP.label} ${op === 'add' ? 'إلى' : 'من'} سلسلة Fallback`, { chain });
            return interaction.update(await renderAgentAIProvider(agentId, interaction.guildId));
        }
        if (action === 'aiprovider_fb_toggle') {
            // تفعيل/تعطيل سلسلة Fallback بالكامل
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            const newValue = !agent.fallback_enabled;
            await cfg.agents_col.updateOne(
                { _id: new ObjectId(agentId) },
                { $set: { fallback_enabled: newValue, updated_at: new Date() } },
            );
            const liveRuntime = manager?.runtimes?.get?.(String(agentId));
            if (liveRuntime?.runtimeSettings) {
                liveRuntime.runtimeSettings.fallback_enabled = newValue;
            }
            await manager.logAgent(agentId, 'fallback_update', `سلسلة Fallback: ${newValue ? 'تفعيل' : 'تعطيل'}`, { enabled: newValue });
            return interaction.update(await renderAgentAIProvider(agentId, interaction.guildId));
        }
        if (action === 'aiprovider_test') {
            // اختبار اتصال حقيقي مع مزود الوكيل الحالي — بكلمة سر مفكوكة
            const agent = secrets.decryptAgentDoc(await cfg.agents_col.findOne({ _id: new ObjectId(agentId) }));
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            const providerObj = getProviderOrFallback(agent.provider);
            const page = await renderAgentAIProvider(agentId, interaction.guildId);
            await interaction.update(page);
            try {
                const msg = await providerObj.testConnection(extractProviderConfig(agent));
                await interaction.followUp({ content: `🧪 **اختبار ${providerObj.label}**\n${msg}`, ephemeral: true });
            } catch (e) {
                await interaction.followUp({ content: `🧪 **اختبار ${providerObj.label}**\n❌ ${e.message}`, ephemeral: true });
            }
            return true;
        }
        if (interaction.isStringSelectMenu() && action === 'conversation_delete') {
            const { db_reset_channel_session } = require('./utils');
            await db_reset_channel_session(interaction.guildId, interaction.values[0], agentId);
            const runtime = manager?.runtimes?.get?.(String(agentId));
            runtime?.channel_sessions?.delete?.(`${interaction.guildId}_${interaction.values[0]}`);
            await manager.logAgent(agentId, 'conversation_delete', 'تم حذف محادثة قناة من Dashboard', { channel_id: interaction.values[0] });
            return interaction.update(await renderAgentConversations(agentId, interaction.guildId));
        }
        if (action === 'view') return updateInteraction(interaction, await renderAgent(manager, agentId));
        if (action === 'settings') return updateInteraction(interaction, await renderAgentSettings(agentId, interaction.guildId));
        if (action === 'knowledge') return updateInteraction(interaction, await renderAgentKnowledge(agentId, interaction.guildId));
        if (action === 'usage') return updateInteraction(interaction, await renderAgentUsage(agentId, parts[4]));
        if (action === 'proactive') return updateInteraction(interaction, await renderAgentProactive(agentId, interaction.guildId));
        if (action === 'logs') return updateInteraction(interaction, await renderLogs(agentId, parts[4]));
        if (action === 'notify') return updateInteraction(interaction, await renderNotifications(agentId, interaction.guildId));
        if (action === 'channels') return updateInteraction(interaction, await renderAgentChannels(agentId, interaction.guildId));
        if (action === 'conversations') return updateInteraction(interaction, await renderAgentConversations(agentId, interaction.guildId));
        if (action === 'provider') {
            // حماية: POW خاص بـ DeepSeek — إن كان الوكيل على مزود آخر نعيده لصفحته
            const agentForPow = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (agentForPow && getProviderOrFallback(agentForPow.provider).id !== 'deepseek') {
                return updateInteraction(interaction, await renderAgent(manager, agentId));
            }
            return updateInteraction(interaction, await renderAgentProvider(agentId, interaction.guildId));
        }
        if (action === 'aiprovider') return updateInteraction(interaction, await renderAgentAIProvider(agentId, interaction.guildId));
        if (action === 'account') return updateInteraction(interaction, await renderAccountSettings(agentId, interaction.guildId));
        if (action === 'account_adv') return updateInteraction(interaction, await renderAccountAdvanced(agentId, interaction.guildId));
        if (action === 'conversation_create') { await interaction.showModal(conversationCreateModal(agentId)); return true; }
        if (action === 'account_run') {
            await interaction.showModal(accountRunModal(agentId));
            return true;
        }
        if (action === 'edit') {
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            await interaction.showModal(editAgentModal(agent));
            return true;
        }
        if (action === 'edit_identity') {
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            await interaction.showModal(editIdentityModal(agent));
            return true;
        }
        if (action === 'edit_token') {
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            await interaction.showModal(editDiscordTokenModal(agent));
            return true;
        }
        if (action === 'edit_creds') {
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            await interaction.showModal(editProviderCredsModal(agent));
            return true;
        }
        if (action === 'reveal') {
            // 🔓 كشف سر محدد — رسالة ephemeral لا يراها غير طالبها
            const field = String(parts[4] || '');
            if (!secrets.SECRET_FIELDS.includes(field)) {
                return updateInteraction(interaction, await renderAgentSettings(agentId, interaction.guildId));
            }
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (!agent || !agent[field]) {
                return updateInteraction(interaction, await renderAgentSettings(agentId, interaction.guildId));
            }
            const value = secrets.decryptSecret(agent[field]);
            const shown = value === null ? '🔒 غير قابل للفك — مفتاح ENCRYPTION_KEY الحالي لا يطابق ما شُفّر به.' : `\`${value}\``;
            await interaction.reply({
                content: `🔓 **${SECRET_LABELS[field] || field}** (لك وحدك — لا تشاركه):\n${shown}`,
                ephemeral: true,
            }).catch(() => {});
            return true;
        }
        if (action === 'features_toggle') {
            // ⚙️ تبديل ميزة — web_search حالياً
            const feature = String(parts[4] || '');
            if (feature !== 'web_search') {
                return updateInteraction(interaction, await renderAgentSettings(agentId, interaction.guildId));
            }
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            const features = { ...(agent.features || {}) };
            const newValue = features.web_search === false; // false → true (تفعيل)، true/undefined → false
            features.web_search = newValue;
            await cfg.agents_col.updateOne(
                { _id: new ObjectId(agentId) },
                { $set: { features, updated_at: new Date() } },
            );
            const liveRuntime = manager?.runtimes?.get?.(String(agentId));
            if (liveRuntime?.runtimeSettings) {
                liveRuntime.runtimeSettings.features = features;
            }
            await manager.logAgent(agentId, 'features_update', `web_search: ${newValue ? 'تفعيل' : 'تعطيل'}`, { features });
            return updateInteraction(interaction, await renderAgentSettings(agentId, interaction.guildId));
        }
        if (action === 'knowledge_upload_start') {
            // فتح نافذة رفع ملفات المعرفة — 3 دقائق
            // تنظيف النوافذ المنتهية أولاً (لا تراكم)
            for (const [k, v] of pendingKnowledgeUploads) {
                if (Date.now() > v.expiresAt) pendingKnowledgeUploads.delete(k);
            }
            const key = `${interaction.guildId}:${interaction.user.id}`;
            pendingKnowledgeUploads.set(key, {
                agentId  : String(agentId),
                expiresAt: Date.now() + KNOWLEDGE_UPLOAD_WINDOW_MS,
            });
            const emb = embed('📎 جاري رفع ملفات المعرفة', linesBlock([
                `أرسل الآن ملفاتك النصية في هذه القناة (<#${interaction.channelId}>).`,
                '',
                '**الشروط:**',
                '• امتدادات نصية: .txt .md .json .csv وغيرها من صيغ النصوص',
                '• كل ملف ≤ 1MB',
                '• لديك **3 دقائق** من الآن',
                '',
                'سيُستبدل محتوى أي ملف بنفس الاسم، وسيُقطّع ويُفهرس تلقائياً.',
            ]), COLORS.success);
            return updateInteraction(interaction, { embeds: [emb], components: rowsFromButtons([
                button(`${DASH_PREFIX}:agent:${agentId}:knowledge`, 'إلغاء والعودة', ButtonStyle.Secondary, ICONS.back),
            ]) });
        }
        if (interaction.isStringSelectMenu() && action === 'knowledge_delete') {
            const source = interaction.values[0];
            const r = await knowledge.deleteSource(agentId, source);
            await manager.logAgent(agentId, 'knowledge_delete', `حذف مصدر المعرفة: ${source}`, { deleted: r.deleted });
            return updateInteraction(interaction, await renderAgentKnowledge(agentId, interaction.guildId, r.deleted ? `حُذف «${source}» (${r.deleted} قطعة).` : 'لا شيء حُذف.'));
        }
        if (action === 'knowledge_clear') {
            const emb = embed('⚠️ مسح قاعدة المعرفة', linesBlock(['سيُحذف كل مستندات المعرفة لهذا الوكيل نهائياً.', 'لا يمكن التراجع.']), COLORS.warning);
            return updateInteraction(interaction, { embeds: [emb], components: rowsFromButtons([
                button(`${DASH_PREFIX}:agent:${agentId}:knowledge_clear_confirm`, 'تأكيد المسح', ButtonStyle.Danger, '🧹'),
                button(`${DASH_PREFIX}:agent:${agentId}:knowledge`, 'إلغاء', ButtonStyle.Secondary, '❌'),
            ]) });
        }
        if (action === 'knowledge_clear_confirm') {
            const r = await knowledge.clearKnowledge(agentId);
            await manager.logAgent(agentId, 'knowledge_clear', `مسح قاعدة المعرفة (${r.deleted} قطعة)`, {});
            return updateInteraction(interaction, await renderAgentKnowledge(agentId, interaction.guildId, r.deleted ? `مُسحت ${r.deleted} قطعة.` : 'كانت فارغة أصلاً.'));
        }
        if (action === 'proactive_toggle') {
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            const newValue = !agent.proactive_enabled;
            await cfg.agents_col.updateOne(
                { _id: new ObjectId(agentId) },
                { $set: { proactive_enabled: newValue, updated_at: new Date() } },
            );
            const liveRuntime = manager?.runtimes?.get?.(String(agentId));
            if (liveRuntime?.runtimeSettings) {
                liveRuntime.runtimeSettings.proactive_enabled = newValue;
            }
            await manager.logAgent(agentId, 'proactive_update', `الاستباقية: ${newValue ? 'تفعيل' : 'تعطيل'}`, { enabled: newValue });
            return updateInteraction(interaction, await renderAgentProactive(agentId, interaction.guildId));
        }
        if (interaction.isChannelSelectMenu() && action === 'proactive_channel_add') {
            await interaction.showModal(proactiveEntryModal(agentId, interaction.values[0]));
            return true;
        }
        if (interaction.isStringSelectMenu() && action === 'proactive_remove') {
            const channelId = interaction.values[0];
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (!agent) return updateInteraction(interaction, await renderAgent(manager, agentId));
            const entries = (Array.isArray(agent.proactive_channels) ? agent.proactive_channels : [])
                .filter(e => String(e?.channel_id) !== String(channelId));
            await cfg.agents_col.updateOne(
                { _id: new ObjectId(agentId) },
                { $set: { proactive_channels: entries, updated_at: new Date() } },
            );
            const liveRuntime = manager?.runtimes?.get?.(String(agentId));
            if (liveRuntime?.runtimeSettings) {
                liveRuntime.runtimeSettings.proactive_channels = entries;
            }
            await manager.logAgent(agentId, 'proactive_update', `إيقاف إصغاء قناة ${channelId}`, {});
            return updateInteraction(interaction, await renderAgentProactive(agentId, interaction.guildId));
        }
        if (action === 'start') {
            const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
            if (agent) await manager.startAgent(agent);
            return updateInteraction(interaction, await renderAgent(manager, agentId));
        }
        if (action === 'stop') {
            await manager.stopAgent(agentId);
            return updateInteraction(interaction, await renderAgent(manager, agentId));
        }
        if (action === 'restart') {
            await manager.restartAgent(agentId, 'Dashboard restart');
            return updateInteraction(interaction, await renderAgent(manager, agentId));
        }
        if (action === 'delete_confirm') {
            const emb = embed('⚠️ تأكيد حذف الوكيل', linesBlock(['هذا الإجراء سيوقف Runtime ثم يحذف الوكيل من قاعدة البيانات.', 'لا يمكن التراجع عنه.']), COLORS.warning);
            return updateInteraction(interaction, { embeds: [emb], components: rowsFromButtons([
                button(`${DASH_PREFIX}:agent:${agentId}:delete`, 'تأكيد الحذف', ButtonStyle.Danger, '🗑️'),
                button(`${DASH_PREFIX}:agent:${agentId}:view`, 'إلغاء', ButtonStyle.Secondary, '❌'),
            ]) });
        }
        if (action === 'delete') {
            await manager.deleteAgent(agentId);
            return updateInteraction(interaction, await renderAgents(manager, 0));
        }
    }

    return false;
}

async function renderAccountSettings(agentId, guildId) {
    const cfg = require('./config');
    const { getAccountSettings, summarizeMemory } = require('./accountAgent');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    const settings = guildId ? await getAccountSettings(agentId, guildId).catch(() => ({})) : {};
    const mem = guildId ? await summarizeMemory(agentId, guildId, 6).catch(() => []) : [];
    const games = (settings.games || []).map(g => `${g.command} ← ${g.name} (${g.bot_id})`).slice(0, 9);
    const memLines = mem.length ? mem.map(x => `• ${fmtDate(x.at)} — ${x.kind}: ${x.game || x.bot_id || x.message_id || '—'}`) : ['لا توجد ذاكرة فعاليات بعد.'];
    const emb = embed('👤 إعدادات الحساب الحقيقي والفعاليات', linesBlock([
        `الوكيل: **${agent?.name || 'غير معروف'}**`,
        `النوع: **${tokenTypeLabel(agent)}**`,
        `📩 قناة الخاص: ${settings.dm_channel_id ? `<#${settings.dm_channel_id}>` : 'غير محددة'}`,
        `🔔 قناة المنشن/الردود: ${settings.mention_channel_id ? `<#${settings.mention_channel_id}>` : 'غير محددة'}`,
        `🎮 قناة الفعاليات: ${settings.event_channel_id ? `<#${settings.event_channel_id}>` : 'القناة الحالية عند الأمر'}`,
        `📦 قناة التسليمات: ${settings.deliveries_channel_id ? `<#${settings.deliveries_channel_id}>` : 'غير محددة'}`,
        `🟢 رول منشن الفعاليات: ${settings.event_role_id ? `<@&${settings.event_role_id}>` : 'غير محدد'}`,
        `⚙️ الوضع: **${settings.mode === 'auto' ? 'تلقائي' : settings.mode === 'schedule' ? 'جدولة' : 'يدوي'}**`,
        `🔁 اليدوي الافتراضي: **${settings.manual_default_count || 1}** فعالية`,
        `🤖 التلقائي عند الخمول: **${settings.auto_run_count || 3}** فعالية / **${settings.auto_run_minutes || 0}** دقيقة`,
        `⏱️ انتظار اللوبي: **${Math.round(Number(settings.event_wait_ms || 40000) / 1000)}s**`,
        '',
        '**الألعاب الافتراضية حسب ID البوت والبريفكس:**',
        ...games,
        '',
        '**آخر ذاكرة:**',
        ...memLines,
    ]), COLORS.live);
    return { embeds: [emb], components: [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:agent:${agentId}:acct_dm`).setPlaceholder('حدد قناة تحويل الخاص').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:agent:${agentId}:acct_mention`).setPlaceholder('حدد قناة المنشن/الردود').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:agent:${agentId}:acct_event`).setPlaceholder('حدد قناة الفعاليات').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:agent:${agentId}:acct_deliveries`).setPlaceholder('حدد قناة التسليمات').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
        ...rowsFromButtons([
            button(`${DASH_PREFIX}:agent:${agentId}:account_adv`, 'الرول والوضع', ButtonStyle.Primary, '⚙️'),
            button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back),
            button(`${DASH_PREFIX}:agent:${agentId}:account`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
        ]),
    ] };
}

async function renderAccountAdvanced(agentId, guildId) {
    const cfg = require('./config');
    const { getAccountSettings } = require('./accountAgent');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    const settings = guildId ? await getAccountSettings(agentId, guildId).catch(() => ({})) : {};
    const emb = embed('⚙️ إعدادات متقدمة للحساب والفعاليات', linesBlock([
        `الوكيل: **${agent?.name || 'غير معروف'}**`,
        `🟢 رول منشن الفعاليات: ${settings.event_role_id ? `<@&${settings.event_role_id}>` : 'غير محدد'}`,
        `⚙️ الوضع الحالي: **${settings.mode === 'auto' ? 'تلقائي' : settings.mode === 'schedule' ? 'جدولة متقدمة' : 'يدوي'}**`,
        `🔁 اليدوي الافتراضي: **${settings.manual_default_count || 1}**`,
        `🤖 التلقائي: **${settings.auto_run_count || 3}** فعاليات / **${settings.auto_run_minutes || 0}** دقيقة`,
        `🗓️ الجدولة: ${settings.schedule_config?.slots?.length ? 'مُعدّة' : 'غير مُعدّة'}`,
        `📣 أول فعالية: **${settings.first_event_announces_everyone ? '@everyone' : 'رول الفعاليات'}**`,
        `⏱️ انتظار اللوبي: **${Math.round(Number(settings.event_wait_ms || 40000) / 1000)}s**`,
        '',
        'تم فصل هذه الصفحة حتى لا تتجاوز واجهة Discord حد 5 صفوف Components.',
    ]), COLORS.live);
    return { embeds: [emb], components: [
        new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:agent:${agentId}:acct_role`).setPlaceholder('حدد رول منشن الفعاليات'),
        ),
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder().setCustomId(`${DASH_PREFIX}:agent:${agentId}:acct_mode`).setPlaceholder('اختر وضع الفعاليات').addOptions([
                { label: 'يدوي', value: 'manual', description: 'لا يبدأ فعاليات إلا بأمر منك' },
                { label: 'تلقائي', value: 'auto', description: 'يراقب الخمول ويبدأ فعاليات لتنشيط السيرفر' },
                { label: 'جدولة (متقدمة)', value: 'schedule', description: 'يشغل الفعاليات حسب الجدول المُعد' },
            ]),
        ),
        ...rowsFromButtons([
            button(`${DASH_PREFIX}:agent:${agentId}:account`, 'رجوع للحساب', ButtonStyle.Secondary, ICONS.back),
            button(`${DASH_PREFIX}:schedule_start:${agentId}`, '🗓️ تكوين الجدولة', ButtonStyle.Primary),
            button(`${DASH_PREFIX}:agent:${agentId}:account_adv`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
        ]),
    ] };
}

async function renderAgentProvider(agentId, guildId) {
    const cfg = require('./config');
    const { get_pow_provider } = require('./utils');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    const provider = guildId ? await get_pow_provider(guildId, agentId).catch(() => 'railway') : 'railway';
    const emb = embed('⚡ مزود POW للوكيل', linesBlock([
        `الوكيل: **${agent?.name || 'غير معروف'}**`,
        `السيرفر الحالي: **${guildId || 'غير متاح'}**`,
        `المزود الحالي: **${provider}**`,
        '',
        'هذا الإعداد خاص بهذا الوكيل، وليس Manager Bot.',
    ]), COLORS.info);
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${DASH_PREFIX}:agent:${agentId}:provider_set`)
            .setPlaceholder('اختر مزود POW لهذا الوكيل')
            .addOptions([
                { label: 'railway', value: 'railway', description: 'استخدام مزود Railway' },
                { label: 'telegram', value: 'telegram', description: 'استخدام مزود Telegram proxy' },
            ]),
    );
    return { embeds: [emb], components: [row, ...rowsFromButtons([button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back), button(`${DASH_PREFIX}:agent:${agentId}:provider`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh)])] };
}

/**
 * صفحة مزود الذكاء الاصطناعي للوكيل — عرض/تبديل/اختبار + سلسلة Fallback.
 * منفصلة تماماً عن صفحة مزود POW (أمور مختلفة تماماً).
 */
async function renderAgentAIProvider(agentId, guildId) {
    const cfg = require('./config');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    if (!agent) return { embeds: [embed('❌ الوكيل غير موجود', linesBlock(['قد يكون الوكيل حُذف.']), COLORS.danger)], components: [] };
    const current = getProviderOrFallback(agent.provider);
    const fbEnabled = Boolean(agent.fallback_enabled);
    const fbChain = Array.isArray(agent.fallback_chain) ? agent.fallback_chain : [];
    const fbLine = fbEnabled
        ? (fbChain.length
            ? `مفعّلة ✅ — الترتيب: ${fbChain.map(pid => `${getProviderOrFallback(pid).emoji} ${getProviderOrFallback(pid).label}`).join(' → ')}`
            : 'مفعّلة لكن السلسلة فارغة — أضف مزوداً بديلاً أدناه')
        : 'معطلة — فشل المزود يعني رسالة خطأ (السلوك الكلاسيكي)';

    const emb = embed('🧠 مزود الذكاء الاصطناعي للوكيل', linesBlock([
        `الوكيل: **${agent.name || 'غير معروف'}**`,
        `المزود الحالي: ${current.emoji} **${current.label}**`,
        `الحالة: ${current.validate(extractProviderConfig(agent)).ok ? 'جاهز ✅' : 'ناقص ❌'}`,
        `↳ ${current.describe(extractProviderConfig(agent))}`,
        '',
        '**المزودون المتاحون:**',
        ...listProviders().map(p => `${p.emoji} **${p.label}** — ${p.id === current.id ? 'الحالي' : (p.validate(extractProviderConfig({ ...agent, provider: p.id })).ok ? 'جاهز للتبديل' : 'يحتاج إعدادات')}`),
        '',
        `**🔄 سلسلة Fallback:** ${fbLine}`,
        'عند فشل المزود الأساسي يُجرَّب البديل التالي تلقائياً لنفس الطلب — بشرط أن تكون إعداداته محفوظة.',
        '',
        'التبديل لا يمس إعدادات المزودين الآخرين المحفوظة، ويُطبق حياً بدون إعادة تشغيل.',
        'جلسات المحادثات القديمة تُصفّر عند التبديل (كل مزود له جلساته الخاصة).',
    ]), COLORS.info);
    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${DASH_PREFIX}:agent:${agentId}:aiprovider_set`)
            .setPlaceholder('اختر مزود الذكاء الاصطناعي')
            .addOptions(listProviders().map(p => ({
                label      : `${p.label}${p.id === current.id ? ' (الحالي)' : ''}`,
                value      : p.id,
                description: trim(p.description, 100),
                emoji      : p.emoji,
            }))),
    );
    // صف إدارة Fallback: إضافة/إزالة مزود من السلسلة
    const fbRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${DASH_PREFIX}:agent:${agentId}:aiprovider_fb_set`)
            .setPlaceholder('إضافة أو إزالة مزود من سلسلة Fallback')
            .addOptions(listProviders()
                .filter(p => p.id !== current.id)
                .map(p => ({
                    label      : `${fbChain.includes(p.id) ? '➖ إزالة' : '➕ إضافة'} ${p.label}`,
                    value      : `${fbChain.includes(p.id) ? 'remove' : 'add'}:${p.id}`,
                    description: p.validate(extractProviderConfig({ ...agent, provider: p.id })).ok ? 'إعداداته محفوظة — جاهز' : 'يحتاج حفظ إعداداته أولاً (من نافذة تعديل الوكيل)',
                    emoji      : p.emoji,
                }))),
    );
    return { embeds: [emb], components: [row, fbRow, ...rowsFromButtons([
        button(`${DASH_PREFIX}:agent:${agentId}:aiprovider_fb_toggle`, fbEnabled ? 'تعطيل Fallback' : 'تفعيل Fallback', fbEnabled ? ButtonStyle.Danger : ButtonStyle.Success, '🔄'),
        button(`${DASH_PREFIX}:agent:${agentId}:aiprovider_test`, 'اختبار الاتصال', ButtonStyle.Primary, '🧪'),
        button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back),
        button(`${DASH_PREFIX}:agent:${agentId}:aiprovider`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
    ])] };
}

// ═══════════════════════════════════════════════════════════
//  ⚙️ صفحة إعدادات الوكيل — عرض كل الإعدادات + كشف آمن + تعديل مجزأ
// ═══════════════════════════════════════════════════════════

function notFoundAgentPage(agentId) {
    return {
        embeds: [embed('❌ الوكيل غير موجود', linesBlock(['قد يكون الوكيل حُذف أو لم يعد متاحًا.']), COLORS.danger)],
        components: rowsFromButtons([button(`${DASH_PREFIX}:agents:0`, 'عودة للوكلاء', ButtonStyle.Secondary, ICONS.back)]),
    };
}

async function renderAgentSettings(agentId, guildId) {
    const cfg = require('./config');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    if (!agent) return notFoundAgentPage(agentId);

    const agentPlain = secrets.decryptAgentDoc(agent);
    const providerObj = getProviderOrFallback(agent.provider);
    const pCfg = extractProviderConfig(agentPlain);
    const pValidation = providerObj.validate(pCfg);
    const features = agent.features || {};
    const webOn = features.web_search !== false;
    const personalityLen = (agent.personality || '').length;

    // حقول المزود — الأسرار مقنّعة، البقية ظاهرة
    const providerLines = providerObj.modalFields.map((f) => {
        const v = pCfg[f.id];
        const isSecret = secrets.SECRET_FIELDS.includes(f.id);
        return `• **${f.label}:** ${v ? (isSecret ? secrets.maskSecret(v) : String(v)) : 'غير محدد ❌'}`;
    });

    const emb = embed('⚙️ إعدادات الوكيل — ' + (agent.name || 'Agent'), linesBlock([
        `📌 **الاسم:** ${agent.name || '—'}`,
        `🧩 **النوع:** ${tokenTypeLabel(agent)}`,
        `${providerObj.emoji} **المزود:** ${providerObj.label} (\`${providerObj.id}\`) — ${pValidation.ok ? 'جاهز ✅' : `ناقص: ${pValidation.missing.join(', ')}`}`,
        ...providerLines,
        `🎫 **توكن ديسكورد:** ${agent.discord_token ? secrets.maskSecret(agentPlain.discord_token || agent.discord_token) : 'غير محدد ❌'}`,
        `🎭 **الشخصية:** ${personalityLen ? `${personalityLen} حرف (نص/ملف)` : 'افتراضية'}`,
        `⚙️ **web_search:** ${webOn ? '🟢 مفعّل — البحث والقراءة من الإنترنت' : '🔴 معطّل — يعتمد على بحث النموذج المدمج'}`,
        '',
        '**🔒 الأسرار مخفية دائماً** — زر «كشف» يعرض القيمة في رسالة خاصة بك فقط (Ephemeral).',
        '📎 لتغيير الشخصية من ملف: منشن الوكيل في أي قناة + اكتب **شخصية** + أرفق ملف `.txt`/`.md` (≤ 1MB و20000 حرف).',
        'كل تعديل يُحفظ في قاعدة البيانات ويُطبق حياً بدون إعادة تشغيل.',
    ]), COLORS.info);

    // أزرار الكشف — فقط للأسرار المحفوظة فعلاً
    const revealButtons = secrets.SECRET_FIELDS
        .filter(f => agent[f])
        .map(f => button(`${DASH_PREFIX}:agent:${agentId}:reveal:${f}`, `كشف ${SECRET_LABELS[f] || f}`, ButtonStyle.Secondary, '🔓'))
        .slice(0, 5);

    const components = [];
    if (revealButtons.length) components.push(...rowsFromButtons(revealButtons));
    components.push(...rowsFromButtons([
        button(`${DASH_PREFIX}:agent:${agentId}:edit_identity`, 'الاسم والشخصية', ButtonStyle.Primary, '✏️'),
        button(`${DASH_PREFIX}:agent:${agentId}:edit_token`, 'توكن ديسكورد', ButtonStyle.Secondary, '🎫'),
        button(`${DASH_PREFIX}:agent:${agentId}:edit_creds`, 'بيانات المزود', ButtonStyle.Secondary, '🧠'),
    ]));
    components.push(...rowsFromButtons([
        button(`${DASH_PREFIX}:agent:${agentId}:features_toggle:web_search`, webOn ? 'تعطيل web_search' : 'تفعيل web_search', webOn ? ButtonStyle.Danger : ButtonStyle.Success, '🌐'),
        button(`${DASH_PREFIX}:agent:${agentId}:settings`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
        button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back),
    ]));
    return { embeds: [emb], components };
}

// ── نوافذ التعديل المجزأة ──

function editIdentityModal(agent) {
    const modal = new ModalBuilder().setCustomId(`${DASH_PREFIX}:edit_identity_modal:${agent._id}`).setTitle(trim('الاسم والشخصية', 45));
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('name').setLabel('اسم الوكيل').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(80).setValue(safeModalValue(agent.name, 80))),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('personality').setLabel('الشخصية (نص مباشر — أو استخدم ملفاً)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500).setValue(safeModalValue(agent.personality, 1500))),
    );
    return modal;
}

function editDiscordTokenModal(agent) {
    const modal = new ModalBuilder().setCustomId(`${DASH_PREFIX}:edit_token_modal:${agent._id}`).setTitle(trim('توكن ديسكورد الجديد', 45));
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('discord_token').setLabel('التوكن الجديد (اتركه فارغاً للإبقاء)').setStyle(TextInputStyle.Short).setRequired(false)),
    );
    return modal;
}

function editProviderCredsModal(agent) {
    const providerObj = getProviderOrFallback(agent.provider);
    const agentPlain = secrets.decryptAgentDoc(agent);
    const modal = new ModalBuilder().setCustomId(`${DASH_PREFIX}:edit_creds_modal:${agent._id}`).setTitle(trim(`بيانات ${providerObj.label}`, 45));
    const knownValues = {
        deepseek_token : '',
        qwen_token     : '',
        qwen_model     : safeModalValue(agentPlain.qwen_model, 100),
        openai_base_url: safeModalValue(agentPlain.openai_base_url, 300),
        openai_api_key : '',
        openai_model   : safeModalValue(agentPlain.openai_model, 100),
    };
    for (const field of providerObj.modalFields.slice(0, 4)) {
        const isSecret = secrets.SECRET_FIELDS.includes(field.id);
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId(field.id)
                .setLabel(trim(isSecret ? `${field.label} (فارغ = إبقاء)` : field.label, 45))
                .setStyle(field.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(field.maxLength || 300)
                .setValue(knownValues[field.id] || ''),
        ));
    }
    return modal;
}

// ═══════════════════════════════════════════════════════════
//  📚 صفحة قاعدة المعرفة RAG — رفع ملفات + حذف مصادر
// ═══════════════════════════════════════════════════════════

async function renderAgentKnowledge(agentId, guildId, notice = null) {
    const cfg = require('./config');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    if (!agent) return notFoundAgentPage(agentId);
    const sources = await knowledge.listSources(agentId).catch(() => []);
    const stats = await knowledge.knowledgeStats(agentId).catch(() => ({ ok: false, chunks: 0, sources: 0 }));

    const emb = embed('📚 قاعدة المعرفة — ' + (agent.name || 'Agent'), linesBlock([
        `📄 **المصادر:** ${stats.sources || sources.length} — **القطع:** ${stats.chunks || 0}`,
        '',
        ...(sources.length
            ? sources.map(s => `• **${s.source}** — ${s.chunks} قطعة، ${s.chars} حرف`)
            : ['لا توجد مستندات بعد. ارفع ملفاتك النصية لتصبح الوكيل خبيراً بها.']),
        notice ? `\n⚠️ ${notice}` : null,
        '',
        '**كيف يرفع؟** اضغط «إضافة ملفات» ثم أرسل الملفات (.txt/.md/.json/أكواد…) في هذه القناة خلال 3 دقائق (كل ملف ≤ 1MB).',
        '**كيف يستخدمها الوكيل؟** تلقائياً عبر أداتي search_knowledge وlist_knowledge (للأدمن/المالك).',
    ]), COLORS.info);

    const components = [];
    if (sources.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${DASH_PREFIX}:agent:${agentId}:knowledge_delete`)
                .setPlaceholder('اختر مصدراً لحذفه')
                .addOptions(sources.slice(0, 25).map(s => ({
                    label: `🗑️ ${s.source}`.slice(0, 100),
                    value: s.source,
                    description: `${s.chunks} قطعة — حذف نهائي`,
                }))),
        ));
        components.push(...rowsFromButtons([button(`${DASH_PREFIX}:agent:${agentId}:knowledge_clear`, 'مسح المعرفة كلها', ButtonStyle.Danger, '🧹')]));
    }
    components.push(...rowsFromButtons([
        button(`${DASH_PREFIX}:agent:${agentId}:knowledge_upload_start`, 'إضافة ملفات', ButtonStyle.Success, '📎'),
        button(`${DASH_PREFIX}:agent:${agentId}:knowledge`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
        button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back),
    ]));
    return { embeds: [emb], components };
}

/**
 * التقاط ملفات المعرفة المرسلة من صاحب رفع معلّق — تُستدعى من bot.js على رسائل Manager.
 * @returns {Promise<boolean>} هل تمت المعالجة (الرسالة كانت رفعاً)
 */
async function handleKnowledgeUploadMessage(message, manager) {
    if (!message?.guild || !message.author || message.author.bot) return false;
    const key = `${message.guild.id}:${message.author.id}`;
    const pending = pendingKnowledgeUploads.get(key);
    if (!pending) return false;
    if (Date.now() > pending.expiresAt) {
        pendingKnowledgeUploads.delete(key);
        return false;
    }

    const attachments = Array.from(message.attachments.values());
    const textAtts = attachments.filter(a => is_text_attachment(a));
    if (!textAtts.length) return false; // رسالة عادية بلا ملفات — تجاهل

    const results = [];
    for (const att of textAtts) {
        if ((att.size || 0) > KNOWLEDGE_MAX_FILE_BYTES) {
            results.push({ name: att.name, ok: false, error: `الحجم ${Math.round((att.size || 0) / 1024)}KB يتجاوز 1MB` });
            continue;
        }
        try {
            const text = await fetchTextAttachment(att.url);
            const r = await knowledge.ingestDocument({
                agentId : pending.agentId,
                guildId : message.guild.id,
                source  : att.name || 'مستند',
                text,
            });
            results.push({ name: att.name, ok: r.ok, chunks: r.chunks, error: r.error });
        } catch (e) {
            results.push({ name: att.name, ok: false, error: e.message });
        }
    }

    const okCount = results.filter(r => r.ok).length;
    const emb = embed(
        okCount === results.length ? '📚 تمت إضافة الملفات للمعرفة' : '⚠️ إضافة المعرفة — بعضها فشل',
        linesBlock([
            ...results.map(r => r.ok
                ? `✅ **${r.name}** — ${r.chunks} قطعة`
                : `❌ **${r.name}** — ${r.error}`),
            '',
            okCount > 0 ? 'الوكيل يستطيع البحث فيها الآن عبر search_knowledge.' : 'أعد المحاولة بملفات نصية صحيحة.',
            `⏳ نافذة الرفع تبقى مفتوحة حتى \`${new Date(pending.expiresAt).toISOString().slice(11, 16)} UTC\` أو حتى إغلاق الصفحة.`,
        ]),
        okCount === results.length ? COLORS.success : COLORS.warning,
    );
    await message.reply({ embeds: [emb] }).catch(() => {});
    await manager?.logAgent?.(pending.agentId, 'knowledge_upload', `رفع معرفة: ${results.map(r => `${r.name}${r.ok ? ' ✓' : ' ✗'}`).join('، ')}`, { results }).catch(() => {});
    return true;
}

// ═══════════════════════════════════════════════════════════
//  📊 صفحة إحصائيات الوكيل
// ═══════════════════════════════════════════════════════════

async function renderAgentUsage(agentId, days = 7) {
    const cfg = require('./config');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    if (!agent) return notFoundAgentPage(agentId);
    const d = [1, 7, 30].includes(Number(days)) ? Number(days) : 7;

    const rows = await usage.getAgentUsage(agentId, d).catch(() => []);
    const s = usage.summarize(rows);
    const providersLine = Object.keys(s.provider_calls).length
        ? Object.entries(s.provider_calls).map(([pid, n]) => `${pid}: **${n}**`).join(' — ')
        : '—';
    const toolsLine = s.top_tools.length
        ? s.top_tools.map(([t, n], i) => `${i + 1}. \`${t}\` — **${n}**`).join('\n')
        : '—';

    const emb = embed(`📊 إحصائيات ${agent.name || 'Agent'} — آخر ${d} يوم`, linesBlock([
        `💬 **الرسائل المُعالجة:** ${s.messages}`,
        `🔧 **استدعاءات الأدوات:** ${s.tool_calls}`,
        `🌐 **استدعاءات الويب:** ${s.web_calls}`,
        `🧠 **استدعاءات المزودين:** ${Object.values(s.provider_calls).reduce((a, b) => a + b, 0)}${providersLine !== '—' ? ` (${providersLine})` : ''}`,
        `🔄 **تبديلات Fallback:** ${s.fallbacks}`,
        `❌ **الأخطاء:** ${s.errors}`,
        `⏰ **التذكيرات المُرسلة:** ${s.reminders}`,
        `🔍 **بحث المعرفة:** ${s.knowledge_hits}`,
        '',
        '**أكثر الأدوات استخداماً:**',
        toolsLine,
        '',
        '**الرسائل اليومية:**',
        usage.renderBars(s.per_day),
    ]), COLORS.info);

    return {
        embeds: [emb],
        components: rowsFromButtons([
            button(`${DASH_PREFIX}:agent:${agentId}:usage:1`, 'اليوم', ButtonStyle.Secondary, '📅', d === 1),
            button(`${DASH_PREFIX}:agent:${agentId}:usage:7`, '7 أيام', ButtonStyle.Secondary, '🗓️', d === 7),
            button(`${DASH_PREFIX}:agent:${agentId}:usage:30`, '30 يوم', ButtonStyle.Secondary, '📆', d === 30),
            button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back),
        ]),
    };
}

// ═══════════════════════════════════════════════════════════
//  🤖 صفحة الاستباقية — إصغاء قنوات بالكلمات المفتاحية
// ═══════════════════════════════════════════════════════════

async function renderAgentProactive(agentId, guildId, notice = null) {
    const cfg = require('./config');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    if (!agent) return notFoundAgentPage(agentId);
    const enabled = Boolean(agent.proactive_enabled);
    const entries = proactive.sanitizeEntries(agent.proactive_channels);

    const emb = embed('🤖 الاستباقية — ' + (agent.name || 'Agent'), linesBlock([
        `**الحالة:** ${enabled ? '🟢 مفعّلة' : '🔴 معطّلة'}`,
        '',
        ...(entries.length
            ? ['**القنوات المُصغاة:**', ...entries.map(e =>
                `• <#${e.channel_id}> — كلمات: \`${e.keywords.join('`, `')}\` — تهدئة: ${e.cooldown_minutes} د`)]
            : ['لا قنوات مُصغاة بعد.']),
        notice ? `\n⚠️ ${notice}` : null,
        '',
        'الرسالة تُعالج حتى بدون منشن إذا: كانت في قناة مُصغاة + احتوت كلمة مفتاحية + انتهت التهدئة.',
        'التهدئة لكل قناة (1–720 دقيقة) تحميك من الإزعاج — والاستباقية لا تعمل إلا بعد تفعيلها.',
    ]), COLORS.info);

    const components = [];
    components.push(new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId(`${DASH_PREFIX}:agent:${agentId}:proactive_channel_add`)
            .setPlaceholder('اختر قناة للإصغاء إليها')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ));
    if (entries.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${DASH_PREFIX}:agent:${agentId}:proactive_remove`)
                .setPlaceholder('اختر قناة لإيقاف الإصغاء')
                .addOptions(entries.map(e => ({
                    label: `قناة ${e.channel_id}`.slice(0, 100),
                    value: e.channel_id,
                    description: `كلمات: ${e.keywords.join(', ')}`.slice(0, 100),
                }))),
        ));
    }
    components.push(...rowsFromButtons([
        button(`${DASH_PREFIX}:agent:${agentId}:proactive_toggle`, enabled ? 'تعطيل الاستباقية' : 'تفعيل الاستباقية', enabled ? ButtonStyle.Danger : ButtonStyle.Success, '🤖'),
        button(`${DASH_PREFIX}:agent:${agentId}:proactive`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh),
        button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back),
    ]));
    return { embeds: [emb], components };
}

function proactiveEntryModal(agentId, channelId) {
    const modal = new ModalBuilder().setCustomId(`${DASH_PREFIX}:proactive_modal:${agentId}:${channelId}`).setTitle('إصغاء القناة');
    modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('keywords').setLabel('كلمات مفتاحية مفصولة بفاصلة').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cooldown').setLabel('التهدئة بالدقائق (1-720، افتراضي 10)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4)),
    );
    return modal;
}

async function renderAgentConversations(agentId, guildId) {
    const cfg = require('./config');
    const { db_list_channel_sessions } = require('./utils');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    const sessions = guildId ? await db_list_channel_sessions(guildId, agentId).catch(() => []) : [];
    const rows = sessions.length ? sessions.map((session) => {
        const channelId = String(session.channel_id);
        const updated = fmtDate(session.updated_at || session.created_at);
        return `• <#${channelId}> — الوضع: **${session.mode || 'default'}** — التفكير: **${session.thinking ? 'مفعل' : 'مغلق'}** — ${updated}`;
    }) : ['لا توجد محادثات محفوظة لهذا الوكيل في هذا السيرفر.'];
    const emb = embed('💬 محادثات الوكيل', linesBlock([
        `الوكيل: **${agent?.name || 'غير معروف'}**`,
        `السيرفر الحالي: **${guildId || 'غير متاح'}**`,
        `عدد المحادثات: **${sessions.length}**`,
        '',
        ...rows,
    ]), COLORS.info);
    const components = [];
    if (sessions.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${DASH_PREFIX}:agent:${agentId}:conversation_delete`)
                .setPlaceholder('اختر محادثة لحذفها/تصفيرها')
                .addOptions(sessions.slice(0, 25).map((session) => {
                    const channelId = String(session.channel_id);
                    return { label: `محادثة ${channelId}`.slice(0, 100), value: channelId, description: 'حذف جلسة هذه القناة' };
                })),
        ));
    }
    components.push(...rowsFromButtons([button(`${DASH_PREFIX}:agent:${agentId}:conversation_create`, 'إنشاء محادثة', ButtonStyle.Success, '➕'), button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back), button(`${DASH_PREFIX}:agent:${agentId}:conversations`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh)]));
    return { embeds: [emb], components };
}

function syncRuntimeAllowedChannels(manager, agentId, guildId, ids) {
    const runtime = manager?.runtimes?.get?.(String(agentId));
    if (!runtime?.allowed_channels_cache || !guildId) return;
    runtime.allowed_channels_cache.set(`${String(agentId)}:${String(guildId)}`, ids.map(String));
}

async function renderAgentChannels(agentId, guildId, notice = null) {
    const cfg = require('./config');
    const { get_allowed_channels } = require('./utils');
    const agent = await cfg.agents_col.findOne({ _id: new ObjectId(agentId) });
    const ids = guildId ? await get_allowed_channels(guildId, agentId).catch(() => []) : [];
    const emb = embed('📡 قنوات الوكيل', linesBlock([
        `الوكيل: **${agent?.name || 'غير معروف'}**`,
        `السيرفر الحالي: **${guildId || 'غير متاح'}**`,
        `القنوات المسموحة: **${ids.length}**`,
        notice ? `⚠️ ${notice}` : null,
        '',
        ...(ids.length ? ids.map(id => `• <#${id}>`) : ['لا توجد قنوات مضافة لهذا الوكيل في هذا السيرفر.']),
        '',
        'استخدم Channel Select لإضافة قناة، أو قائمة الحذف لإزالة قناة بدون كتابة أي معرف.',
    ]), COLORS.info);
    const components = [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(`${DASH_PREFIX}:agent:${agentId}:channel_add`)
                .setPlaceholder('اختر قناة لإضافتها إلى قنوات المحادثة')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    ];
    if (ids.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(`${DASH_PREFIX}:agent:${agentId}:channel_remove`)
                .setPlaceholder('اختر قناة لإزالتها')
                .addOptions(ids.slice(0, 25).map(id => ({ label: `قناة ${id}`.slice(0, 100), value: id, description: 'إزالة من القنوات المسموحة' }))),
        ));
    }
    components.push(...rowsFromButtons([button(`${DASH_PREFIX}:agent:${agentId}:view`, 'عودة للوكيل', ButtonStyle.Secondary, ICONS.back), button(`${DASH_PREFIX}:agent:${agentId}:channels`, 'تحديث', ButtonStyle.Secondary, ICONS.refresh)]));
    return { embeds: [emb], components };
}

module.exports = {
    dashboardCommands,
    dashboardCommandRoute,
    isDashboardCommand,
    handleDashboardInteraction,
    handleKnowledgeUploadMessage,
    renderHome,
    renderAgent,
    renderAgentSettings,
    renderAgentKnowledge,
    renderAgentUsage,
    renderAgentProactive,
    COLORS,
    embed,
    linesBlock,
};