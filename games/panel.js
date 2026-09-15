/**
 * games/panel.js — لوحة تحكم لعب الوكلاء (v7.14)
 * ═══════════════════════════════════════════════════════════
 * نظام تحكم على نمط مستودع Auto (لوحة + تشغيل/إيقاف لكل محرك +
 * سياسة سيرفرات/بوتات) — مبنية بتصميم المنصة (Components V2)
 * وبنفس تجربة /الرصد: اختر الوكيل ← اختر السيرفر ← صفحة الألعاب.
 *
 * تعمل من بوت المدير الرئيسي حصراً (نفس عزل لوحة المدير الأمني).
 * المسارات:
 *   /الألعاب                                → اختيار وكيل
 *   games:agent_select                      → (قائمة) اختيار وكيل
 *   games:agent:<agentId>                   → اختيار سيرفر لهذا الوكيل
 *   games:guild:<agentId>:<guildId>         → صفحة الألعاب للسيرفر
 *   games:toggle / games:engine:<id>        → تبديل التفعيل
 *   games:zar_ch / games:zar_cmd            → قناة وأمر حلقة زر
 *   games:ai_toggle / games:suppress_toggle → خيارات الرد الذكي
 *   games:premium:<engineId>                → الانضمام المميز (معطل افتراضياً)
 *   games:policy + gmodal:*                 → صفحة السياسة العامة
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { ObjectId } = require('mongodb');
const {
    SlashCommandBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
} = require('discord.js');
const ui = require('../ui');
const engines = require('./engines');
const policy = require('./policy');
const store = require('./store');
const player = require('./player');
const sessions = require('./sessions');

const PREFIX = 'games';
const MODAL_PREFIX = 'gmodal';

const cut = (value, max) => String(value || '').slice(0, max);

// ════════════════════════════════════════════════════════════
//  الأمر
// ════════════════════════════════════════════════════════════

function gamesCommand() {
    return new SlashCommandBuilder()
        .setName('الألعاب')
        .setDescription('🎮 لوحة لعب الوكلاء: فعّل الوكيل لينضم لألعاب البوتات (كراسي/ريبلكا/روليت/زر) ويلعب بنفسه');
}

// ════════════════════════════════════════════════════════════
//  الصفحة 1: اختيار الوكيل
// ════════════════════════════════════════════════════════════

async function renderAgentSelect(manager) {
    const cfg = require('../config');
    const agents = await cfg.agents_col.find({}).sort({ name: 1 }).limit(25).toArray();

    if (!agents.length) {
        return ui.v2Payload(ui.container({
            accent: ui.ACCENTS.dark,
            title: '🎮 الألعاب — لا يوجد وكلاء',
            body: 'أنشئ وكيلاً أولاً من لوحة التحكم، ثم فعّل له اللعب من هنا.',
            rows: [new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`${PREFIX}:close`).setLabel('إغلاق').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
            )],
        }));
    }

    const options = agents.map((agent) => {
        const isUser = String(agent.token_type || 'bot') === 'user';
        const running = String(agent.status || '') === 'running';
        const desc = `${isUser ? '👤 حساب مستخدم — يقدر يضغط الأزرار' : '🤖 بوت — اللعب يتطلب حساب مستخدم'} • ${running ? 'يعمل الآن' : 'متوقف'}`;
        return {
            label: cut(agent.name || String(agent._id), 100),
            value: String(agent._id),
            description: cut(desc, 100),
            emoji: isUser ? '👤' : '🤖',
        };
    });

    const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${PREFIX}:agent_select`)
            .setPlaceholder('🎮 اختر الوكيل الذي تريد ضبط ألعابه')
            .addOptions(options),
    );

    return ui.v2Payload(ui.container({
        accent: ui.ACCENTS.live,
        title: '🎮 الألعاب — اختر الوكيل',
        body: [
            '**هنا تُشعل قدرة الوكيل على لعب ألعاب البوتات:** أي شخص يبدأ لعبة (كراسي، ريبلكا، روليت، زر…) ويضغط الوكيل زر الدخول ويلعب مع اللاعبين.',
            '',
            `> 👤 **اللعب يعمل على وكلاء الحسابات** (user token) — هم وحدهم القادرون على الضغط على أزرار بوت آخر، تماماً كما في مشروع Auto.`,
            '> 🤖 وكلاء البوتات تظهر صفحاتهم لكن المحركات لن تُشغَّل عليهم.',
            '',
            `الوكلاء المتاحون: **${agents.length}**`,
        ].join('\n'),
        rows: [selectRow, new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`${PREFIX}:close`).setLabel('إغلاق').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
        )],
        footer: 'أمر المالك — يظهر لمن يملك بوت المدير فقط',
    }));
}

// ════════════════════════════════════════════════════════════
//  الصفحة 2: اختيار السيرفر لوكيل محدد
// ════════════════════════════════════════════════════════════

async function renderGuildSelect(agentId, manager) {
    const cfg = require('../config');
    const agent = ObjectId.isValid(String(agentId))
        ? await cfg.agents_col.findOne({ _id: new ObjectId(String(agentId)) })
        : null;

    const backRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}:home`).setLabel('تغيير الوكيل').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
    );

    if (!agent) {
        return ui.v2Payload(ui.container({
            accent: ui.ACCENTS.danger,
            title: '🎮 الألعاب — الوكيل غير موجود',
            body: 'ربما حُذف — اختر وكيلاً آخر.',
            rows: [backRow],
        }));
    }

    const runtime = manager?.runtimes?.get?.(String(agentId));
    const client = runtime?.client;
    const guilds = client?.guilds?.cache ? [...client.guilds.cache.values()] : [];

    if (!guilds.length) {
        return ui.v2Payload(ui.container({
            accent: ui.ACCENTS.warning,
            title: `🎮 ألعاب «${agent.name}» — لا سيرفرات حية`,
            body: [
                `الوكيل **${runtime ? 'متوقف عن العمل الآن' : 'غير متصل'}** — لا أستطيع قراءة سيرفراته.`,
                '',
                'شغّل الوكيل من لوحة التحكم ثم عد هنا.',
            ].join('\n'),
            rows: [backRow],
        }));
    }

    const options = guilds.slice(0, 25).map((guild) => ({
        label: cut(guild.name, 100),
        value: guild.id,
        description: cut(`${guild.memberCount || '؟'} عضو`, 100),
        emoji: '🏰',
    }));

    const selectRow = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`${PREFIX}:guild_select:${agentId}`)
            .setPlaceholder('🏰 اختر السيرفر الذي سيلعب فيه هذا الوكيل')
            .addOptions(options),
    );

    const isUser = String(agent.token_type || 'bot') === 'user';
    return ui.v2Payload(ui.container({
        accent: ui.ACCENTS.info,
        title: `🎮 ألعاب «${agent.name}» — اختر السيرفر`,
        body: [
            `**الوكيل:** ${agent.name} ${isUser ? '(👤 حساب مستخدم — اللعب متاح)' : '(🤖 بوت — شغّل المحركات لن يفعل شيئاً حتى يكون حساب مستخدم)'}`,
            '',
            'لكل سيرفر إعدادات لعب مستقلة: أي المحركات تعمل، قناة حلقة زر، الإحصائيات.',
        ].join('\n'),
        rows: [selectRow, backRow],
    }));
}

// ════════════════════════════════════════════════════════════
//  الصفحة 3: صفحة الألعاب للسيرفر
// ════════════════════════════════════════════════════════════

async function renderGamesPage(agentId, guildId, manager) {
    const cfg = require('../config');
    const agent = ObjectId.isValid(String(agentId))
        ? await cfg.agents_col.findOne({ _id: new ObjectId(String(agentId)) })
        : null;
    if (!agent) {
        return ui.v2Payload(ui.container({ accent: ui.ACCENTS.danger, title: '🎮 الوكيل غير موجود', body: 'اختر وكيلاً آخر.', rows: [backHomeRow()] }));
    }

    const settings = await store.getGameSettings(agentId, guildId);
    const stats = store.statsFor(agentId, guildId);
    const recent = store.getRecentEvents(agentId);
    const loops = player.getZarLoops(agentId).filter(loop => loop.guildId === String(guildId));
    const canClick = player.canClickButtons(agentId);
    const isUser = String(agent.token_type || 'bot') === 'user';

    const engineLines = engines.getEngines().map((engine) => {
        const es = settings.engines[engine.id] || {};
        const state = es.enabled ? '✅ يعمل' : '❌ موقف';
        const premium = engine.id === 'karasi' || engine.id === 'replka'
            ? ` • انضمام مميز: ${es.premium_join ? '✅' : '⛔'}`
            : '';
        const delay = Number(es.delay || 0) ? ` • تأخير ${es.delay}ث` : '';
        // 🧠 وضع القرار — مافيا وروليت فقط (v7.16 بلاغ المالك:
        // «واحد يتحكم فيه الوكيل... والآخر يكون تلقائي» — v7.18: الوكيل يقرر
        // بعقله في الوضعين؛ الفرق: الاجتماعي يتكلم كاملاً والتلقائي يلعب بصمت
        const mode = engine.id === 'mafia' || engine.id === 'roulette'
            ? ` • الوضع: ${es.mode === 'social' || es.mode === 'ai' ? '🫧 اجتماعي (يلعب ويتفاعل بالكلام)' : '🤫 تلقائي (يلعب ويقرر بصمت)'}`
            : '';
        return `- ${engine.icon} **${engine.displayName}** — ${state}${premium}${delay}${mode}\n  > ${engine.description}`;
    });

    const body = [
        `**الوكيل:** ${agent.name} ${isUser ? '(👤 حساب مستخدم)' : '(🤖 بوت — المحركات لن تضغط أزراراً!)'}`,
        `**السيرفر:** ${guildId}`,
        '',
        `### المفتاح الرئيسي: ${settings.enabled ? '🟢 اللعب مفعّل' : '🔴 اللعب معطل كلياً'}`,
        !settings.enabled ? '> فعّله من الزر أدناه — بدون تفعيل لا يلتقط الوكيل أي لعبة ولا يتحرك.' : '',
        '',
        '## المحركات',
        ...engineLines,
        '',
        '## حلقة زر التلقائية',
        `- القناة: ${settings.channel_id ? `<#${settings.channel_id}>` : '**غير محددة** (اختر قناة ليبدأ إرسال الأمر)'} `,
        `- الأمر: \`${settings.zar_command}\``,
        `- الحلقة الآن: ${loops.length ? `🟢 جارية (أُرسل قبل ${Math.round((Date.now() - loops[0].sentAt) / 60000)} د)` : '⚫ متوقفة'}`,
        '',
        '## خيارات الرد',
        `- 🧠 إجابة ريبلكا بالذكاء أولاً: **${settings.ai_answers ? 'مفعّلة (القاموس احتياط)' : 'قاموس فقط'}**`,
        `- 🔇 كتم ردود الذكاء على رسائل الألعاب: **${settings.suppress_ai ? 'مكتوم' : 'عادي (كما كان دائماً)'}**`,
        `- 🫧 التفاعل الاجتماعي أثناء اللعب: **${settings.social?.enabled ? 'مفعّل (يعقّب على الطرد والفوز ويرد على من يذكر اسمه)' : 'معطل (صمت كامل)'}**`,
        '',
        '## إحصائيات هذه الجلسة',
        `- 🚪 انضمامات: **${stats.joins}** • 🎮 حركات: **${stats.plays}** • 🏆 فوز: **${stats.wins}** • 💀 خسارة: **${stats.losses}** • ⚠️ أخطاء: **${stats.errors}**`,
        recent.length ? `\n**آخر الأحداث:**\n${recent.slice(0, 6).map(e => `- ${e.text}`).join('\n')}` : '',
        // 🧠 v7.17: «لا اعرف انه الان يلعب» — الجلسة الحية ظاهرة للمالك هنا
        (() => {
            const live = sessions.getSession(agentId, guildId);
            if (!live) return '';
            const mins = Math.max(0, Math.round((Date.now() - live.joinedAt) / 60000));
            const mafiaBit = (live.engineId === 'mafia' || live.mafia.role)
                ? ` • الدور: ${live.mafia.role || 'غير معروف'} • المرحلة: ${live.mafia.phase}`
                : '';
            return `\n## 🟢 الجلسة الحية: يلعب الآن\n- اللعبة: **${live.gameName || live.engineId || '؟'}** منذ ~${mins} د • اللاعبون المرئيون: ${live.mafia.players.size || live.players.size}${mafiaBit}`;
        })(),
    ].filter(Boolean).join('\n');

    // صف الأزرار 1: الرئيسي + أزرار المحركات
    // 🐞 v7.16.1: كان الصف يحشو كل المحركات مع زر التشغيل في صف واحد —
    // أربعة محركات = 5 مكونات (بالضبط الحد) — لكن مافيا جعلتها 6
    // → ديسكورد يرفض الصفحة كلياً (Invalid Form Body) عند اختيار السيرفر
    // والخطأ كان يُبتلع بصمت. الآن: التقسيم تلقائي — أي عدد محركات يعمل.
    const toggleButton = new ButtonBuilder()
        .setCustomId(`${PREFIX}:toggle:${agentId}:${guildId}`)
        .setLabel(settings.enabled ? 'إيقاف اللعب كلياً' : 'تشغيل اللعب')
        .setStyle(settings.enabled ? ButtonStyle.Danger : ButtonStyle.Success)
        .setEmoji(settings.enabled ? '⏹️' : '▶️');
    const engineButtons = engines.getEngines().map((engine) => new ButtonBuilder()
        .setCustomId(`${PREFIX}:engine:${engine.id}:${agentId}:${guildId}`)
        .setLabel(`${engine.displayName} ${settings.engines[engine.id]?.enabled ? '⏹️' : '▶️'}`)
        .setStyle(settings.engines[engine.id]?.enabled ? ButtonStyle.Secondary : ButtonStyle.Success));

    const controlRows = [
        new ActionRowBuilder().addComponents(toggleButton, ...engineButtons.slice(0, 4)),
    ];
    for (let i = 4; i < engineButtons.length; i += 5) {
        controlRows.push(new ActionRowBuilder().addComponents(...engineButtons.slice(i, i + 5)));
    }

    // صف 2: قناة زر + أمر زر
    const zarRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}:zar_cmd:${agentId}:${guildId}`)
            .setLabel('أمر الحلقة').setStyle(ButtonStyle.Secondary).setEmoji('⌨️'),
        new ButtonBuilder().setCustomId(`${PREFIX}:ai_toggle:${agentId}:${guildId}`)
            .setLabel(settings.ai_answers ? 'الذكاء في ريبلكا: مفعّل' : 'الذكاء في ريبلكا: قاموس فقط')
            .setStyle(ButtonStyle.Primary).setEmoji('🧠'),
        new ButtonBuilder().setCustomId(`${PREFIX}:suppress_toggle:${agentId}:${guildId}`)
            .setLabel(settings.suppress_ai ? 'كتم الذكاء: مفعّل' : 'كتم الذكاء: معطل')
            .setStyle(ButtonStyle.Secondary).setEmoji('🔇'),
        new ButtonBuilder().setCustomId(`${PREFIX}:social_toggle:${agentId}:${guildId}`)
            .setLabel(settings.social?.enabled ? 'التفاعل الاجتماعي: مفعّل' : 'التفاعل الاجتماعي: معطل')
            .setStyle(settings.social?.enabled ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🫧'),
    );

    // صف 2.5: الانضمام المميز (كراسي/ريبلكا) — معطل افتراضياً لأنه ينقر أي زر بعد ذكر اسم اللعبة
    const premiumRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}:premium:karasi:${agentId}:${guildId}`)
            .setLabel(`انضمام مميز (كراسي): ${settings.engines.karasi?.premium_join ? 'مفعّل' : 'معطل'}`)
            .setStyle(settings.engines.karasi?.premium_join ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('⚡'),
        new ButtonBuilder().setCustomId(`${PREFIX}:premium:replka:${agentId}:${guildId}`)
            .setLabel(`انضمام مميز (ريبلكا): ${settings.engines.replka?.premium_join ? 'مفعّل' : 'معطل'}`)
            .setStyle(settings.engines.replka?.premium_join ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('⚡'),
    );

    // صف 2.6: وضع اللعب (v7.18) — الوكيل يقرر بعقله في الوضعين؛
    // الاجتماعي يتفاعل بالكلام كاملاً والتلقائي يلعب بصمت (ردود موقعه فقط)
    const modeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}:mode:mafia:${agentId}:${guildId}`)
            .setLabel(`وضع المافيا: ${settings.engines.mafia?.mode === 'social' || settings.engines.mafia?.mode === 'ai' ? '🫧 اجتماعي' : '🤫 تلقائي'}`)
            .setStyle(settings.engines.mafia?.mode === 'social' || settings.engines.mafia?.mode === 'ai' ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🕵️'),
        new ButtonBuilder().setCustomId(`${PREFIX}:mode:roulette:${agentId}:${guildId}`)
            .setLabel(`وضع الروليت: ${settings.engines.roulette?.mode === 'social' || settings.engines.roulette?.mode === 'ai' ? '🫧 اجتماعي' : '🤫 تلقائي'}`)
            .setStyle(settings.engines.roulette?.mode === 'social' || settings.engines.roulette?.mode === 'ai' ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🎡'),
    );

    // قناة حلقة زر — ChannelSelect
    const channelRow = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
            .setCustomId(`${PREFIX}:zar_ch:${agentId}:${guildId}`)
            .setPlaceholder('🎰 قناة حلقة زر التلقائية (يُرسل فيها الأمر ويُنتظر الفوز)')
            .addChannelTypes(ChannelType.GuildText)
            .setMinValues(0)
            .setMaxValues(1),
    );

    const rowNav = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}:policy`).setLabel('السياسة العامة').setStyle(ButtonStyle.Secondary).setEmoji('🛡️'),
        new ButtonBuilder().setCustomId(`${PREFIX}:refresh:${agentId}:${guildId}`).setLabel('تحديث').setStyle(ButtonStyle.Primary).setEmoji('🔄'),
        new ButtonBuilder().setCustomId(`${PREFIX}:agent:${agentId}`).setLabel('تغيير السيرفر').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
        new ButtonBuilder().setCustomId(`${PREFIX}:home`).setLabel('تغيير الوكيل').setStyle(ButtonStyle.Secondary).setEmoji('🏠'),
    );

    return ui.v2Payload(ui.container({
        accent: settings.enabled ? ui.ACCENTS.success : ui.ACCENTS.dark,
        title: '🎮 مركز ألعاب الوكيل',
        body,
        rows: [...controlRows, zarRow, premiumRow, modeRow, channelRow, rowNav],
        footer: `الضغط على أزرار بوت آخر ممكن لحسابات المستخدم فقط — ${canClick ? 'هذا الوكيل قادر ✅' : 'هذا الوكيل لا يملك القدرة الآن'}`,
    }));
}

function backHomeRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}:home`).setLabel('تغيير الوكيل').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
    );
}

// ════════════════════════════════════════════════════════════
//  صفحة السياسة العامة (نمط Auto game-policy + whitelist)
// ════════════════════════════════════════════════════════════

async function renderPolicyPage() {
    const p = await policy.getPolicy();
    const engineLines = engines.getEngines().map((engine) => {
        const filterOn = policy.isBotFilterEnabled(p, engine.id);
        const bots = (p.engineAllowedBots?.[engine.id] || []);
        const servers = (p.engineAllowedServers?.[engine.id] || []);
        const lock = policy.isOverlapLockEnabled(p, engine.id);
        return [
            `### ${engine.icon} ${engine.displayName}`,
            `- فلتر البوتات: **${filterOn ? 'مفعّل (فقط البوتات المدرجة)' : 'معطل (أي بوت يُقبل)'}**`,
            `- بوتات مسموحة: ${bots.length ? bots.map(b => `<@${b}> (\`${b}\`)`).join(' ، ') : '**لا أحد** ⚠️ (فعّل طي الفلتر أو أضف بوتات)'}`,
            `- سيرفرات خاصة: ${servers.length ? servers.map(s => `\`${s}\``).join(' ، ') : '— (يرث العام)'} `,
            `- قفل التداخل: **${lock ? '🔒 لا حسابان يلعبان معاً' : '🔓 حر'}**`,
        ].join('\n');
    });

    const rows = engines.getEngines().map((engine) => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}:pol_bots:${engine.id}`)
            .setLabel(`بوتات ${engine.displayName}`).setStyle(ButtonStyle.Secondary).setEmoji('🤖'),
        new ButtonBuilder().setCustomId(`${PREFIX}:pol_filter:${engine.id}`)
            .setLabel(`فلتر ${engine.displayName}: ${policy.isBotFilterEnabled(p, engine.id) ? 'مفعّل' : 'معطل'}`)
            .setStyle(policy.isBotFilterEnabled(p, engine.id) ? ButtonStyle.Success : ButtonStyle.Secondary).setEmoji('🧹'),
        new ButtonBuilder().setCustomId(`${PREFIX}:pol_lock_eng:${engine.id}`)
            .setLabel(`قفل ${engine.displayName}: ${policy.isOverlapLockEnabled(p, engine.id) ? 'مقفول' : 'حر'}`)
            .setStyle(policy.isOverlapLockEnabled(p, engine.id) ? ButtonStyle.Danger : ButtonStyle.Secondary).setEmoji('🔒'),
    ));

    rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${PREFIX}:pol_servers`)
            .setLabel('سيرفرات عامة مسموحة').setStyle(ButtonStyle.Secondary).setEmoji('🏰'),
        new ButtonBuilder().setCustomId(`${PREFIX}:pol_lock`)
            .setLabel(`القفل العام: ${p.overlapLockEnabled ? 'مقفول' : 'حر'}`)
            .setStyle(p.overlapLockEnabled ? ButtonStyle.Danger : ButtonStyle.Secondary).setEmoji('🔒'),
        new ButtonBuilder().setCustomId(`${PREFIX}:home`).setLabel('رجوع').setStyle(ButtonStyle.Primary).setEmoji('↩️'),
    ));

    return ui.v2Payload(ui.container({
        accent: ui.ACCENTS.warning,
        title: '🛡️ سياسة الألعاب العامة (لكل الوكلاء)',
        body: [
            '**هذه القواعد تحمي حساباتك:** من أي بوت يُقبل اللعب؟ في أي سيرفرات؟ وهل يُسمح بحسابين يلعبان نفس اللعبة في نفس السيرفر؟',
            '',
            `- السيرفرات العامة: ${p.allowedServers.length ? p.allowedServers.map(s => `\`${s}\``).join(' ، ') : '**كل السيرفرات** (بلا قيد)'}`,
            '',
            ...engineLines,
            '',
            '> 💡 القفل يمنع «تداخل» حسابين في نفس الجولة — كما في Auto تماماً.',
        ].join('\n'),
        rows,
        footer: 'قوائم البوتات والسيرفرات تُدخل كمعرفات مفصولة بمسافة أو فاصلة',
    }));
}

// ════════════════════════════════════════════════════════════
//  النوافذ (Modals)
// ════════════════════════════════════════════════════════════

function zarCommandModal(agentId, guildId, current) {
    return new ModalBuilder()
        .setCustomId(`${MODAL_PREFIX}:zar_cmd:${agentId}:${guildId}`)
        .setTitle('أمر حلقة زر')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('command')
                .setLabel('الأمر الذي يُرسل لبدء الدورة (مثل -روليت)')
                .setStyle(TextInputStyle.Short)
                .setValue(String(current || '-روليت').slice(0, 45))
                .setRequired(true),
        ));
}

function botIdsModal(engineId) {
    const engine = engines.getEngine(engineId);
    return new ModalBuilder()
        .setCustomId(`${MODAL_PREFIX}:pol_bots:${engineId}`)
        .setTitle(`بوتات مسموحة — ${engine ? engine.displayName : engineId}`)
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('ids')
                .setLabel('معرفات البوتات مفصولة بمسافة (فارغ = لا أحد)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('مثال: 1508592252220477651 1006332825571692544')
                .setRequired(false)
                .setValue(''),
        ));
}

function serversModal() {
    return new ModalBuilder()
        .setCustomId(`${MODAL_PREFIX}:pol_servers`)
        .setTitle('السيرفرات العامة المسموحة')
        .addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('ids')
                .setLabel('معرفات السيرفرات مفصولة بمسافة (فارغ = الكل)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('اتركه فارغاً للسماح بكل السيرفرات')
                .setRequired(false)
                .setValue(''),
        ));
}

// ════════════════════════════════════════════════════════════
//  الموجّه الرئيسي
// ════════════════════════════════════════════════════════════

async function update(interaction, payload) {
    const attempt = (interaction.replied || interaction.deferred)
        ? interaction.editReply(payload)
        : interaction.update(payload);
    try {
        await attempt;
    } catch (updateError) {
        // 🐞 v7.16.1: كان .catch(() => {}) يبتلع رفض ديسكورد بصمت — المالك
        // يرى «فشل التفاعل» بلا أي أثر في اللوق (مثل صف 6 مكونات المرفوض).
        // الآن: الفشل يُسجل دائماً، وإن بقي التفاعل بلا إقرار نُرسل لوحة خطأ
        // مرئية بدل الصمت.
        console.error('[Games Panel] فشل تحديث اللوحة:', updateError);
        if (!interaction.replied && !interaction.deferred) {
            const fallback = ui.v2Payload(ui.container({
                accent: ui.ACCENTS.danger,
                title: '🎮 خطأ في لوحة الألعاب',
                body: `\`${updateError?.message || String(updateError)}\``,
                rows: [backHomeRow()],
            }));
            await interaction.update(fallback).catch(() => {});
        }
    }
}

async function handleGamesInteraction(interaction, manager) {
    // ما لنا فيه — اتركه للوحة المدير
    const isCommand = interaction.isChatInputCommand?.() && interaction.commandName === 'الألعاب';
    const cid = interaction.customId || '';
    const isOurs = cid.startsWith(`${PREFIX}:`) || cid.startsWith(`${MODAL_PREFIX}:`);
    if (!isCommand && !isOurs) return false;

    try {
        // ── الأمر الأساسي ──
        if (isCommand) {
            // 🐞 v7.14.1: كان deferReply ثم return مباشرة — اللوحة تُبنى ولا تُرسل أبداً
            // (الأمر يظل «يحمل» إلى الأبد كما أبلغ المالك). الآن: تأجيل فوري (حماية مهلة
            // ديسكورد 3 ثوان) ثم إرسال صفحة اختيار الوكيل — نفس نمط /الرصد المجرّب.
            if (!interaction.replied && !interaction.deferred) {
                await interaction.deferReply().catch(() => {});
            }
            try {
                const payload = await renderAgentSelect(manager);
                await interaction.editReply(payload).catch(() => {});
            } catch (renderError) {
                console.error('[Games Panel] فشل بناء صفحة الألعاب:', renderError);
                const payload = ui.v2Payload(ui.container({
                    accent: ui.ACCENTS.danger,
                    title: '🎮 خطأ في لوحة الألعاب',
                    body: `\`${renderError?.message || String(renderError)}\``,
                    rows: [backHomeRow()],
                }));
                await interaction.editReply(payload).catch(() => {});
            }
            return true;
        }

        // ── النوافذ (Modal Submit) ──
        if (interaction.isModalSubmit?.()) {
            if (cid.startsWith(`${MODAL_PREFIX}:zar_cmd:`)) {
                const [, , agentId, guildId] = cid.split(':');
                const command = interaction.fields.getTextInputValue('command');
                await store.updateGameSettings(agentId, guildId, { zar_command: command });
                await player.refreshAgentLoops(agentId);
                await update(interaction, await renderGamesPage(agentId, guildId, manager));
                return true;
            }
            if (cid.startsWith(`${MODAL_PREFIX}:pol_bots:`)) {
                const engineId = cid.split(':')[2];
                const raw = interaction.fields.getTextInputValue('ids');
                await policy.setAllowedBots(engineId, raw || []);
                await update(interaction, await renderPolicyPage());
                return true;
            }
            if (cid.startsWith(`${MODAL_PREFIX}:pol_servers`)) {
                const raw = interaction.fields.getTextInputValue('ids');
                await policy.setAllowedServers('general', raw || []);
                await update(interaction, await renderPolicyPage());
                return true;
            }
            return true;
        }

        // ── القوائم والأزرار ──
        const parts = cid.split(':');

        if (parts[1] === 'agent_select') {
            const agentId = interaction.values?.[0];
            if (!agentId) return true;
            await update(interaction, await renderGuildSelect(agentId, manager));
            return true;
        }

        if (parts[1] === 'home') {
            await update(interaction, await renderAgentSelect(manager));
            return true;
        }

        if (parts[1] === 'close') {
            await interaction.deferUpdate().catch(() => {});
            await interaction.deleteReply().catch(() => {});
            return true;
        }

        if (parts[1] === 'agent') {
            await update(interaction, await renderGuildSelect(parts[2], manager));
            return true;
        }

        if (parts[1] === 'guild_select') {
            const agentId = parts[2];
            const guildId = interaction.values?.[0];
            if (!guildId) return true;
            await update(interaction, await renderGamesPage(agentId, guildId, manager));
            return true;
        }

        if (parts[1] === 'refresh') {
            await player.refreshAgentLoops(parts[2]);
            await update(interaction, await renderGamesPage(parts[2], parts[3], manager));
            return true;
        }

        if (parts[1] === 'toggle') {
            const [, , agentId, guildId] = parts;
            const settings = await store.getGameSettings(agentId, guildId);
            const next = !settings.enabled;
            await store.updateGameSettings(agentId, guildId, { enabled: next });
            await store.logGameEvent(agentId, guildId, { type: 'toggle', enabled: next });
            await store.pushRecentEvent(agentId, { kind: 'toggle', text: next ? '🟢 فُعّل اللعب في هذا السيرفر' : '🔴 أُوقف اللعب في هذا السيرفر' });
            await player.refreshAgentLoops(agentId);
            await update(interaction, await renderGamesPage(agentId, guildId, manager));
            return true;
        }

        if (parts[1] === 'engine') {
            const engineId = parts[2];
            const agentId = parts[3];
            const guildId = parts[4];
            const engine = engines.getEngine(engineId);
            if (!engine) return true;
            const settings = await store.getGameSettings(agentId, guildId);
            const next = !(settings.engines[engineId]?.enabled);
            await store.updateGameSettings(agentId, guildId, { engines: { [engineId]: { enabled: next } } });
            await store.pushRecentEvent(agentId, { kind: 'engine', text: `${engine.icon} ${next ? '▶️' : '⏹️'} ${engine.displayName} ${next ? 'اشتغل' : 'توقف'}` });
            await player.refreshAgentLoops(agentId);
            await update(interaction, await renderGamesPage(agentId, guildId, manager));
            return true;
        }

        if (parts[1] === 'zar_ch') {
            const agentId = parts[2];
            const guildId = parts[3];
            const channelId = interaction.values?.[0] || null;
            await store.updateGameSettings(agentId, guildId, { channel_id: channelId });
            await player.refreshAgentLoops(agentId);
            await update(interaction, await renderGamesPage(agentId, guildId, manager));
            return true;
        }

        if (parts[1] === 'zar_cmd') {
            const agentId = parts[2];
            const guildId = parts[3];
            const settings = await store.getGameSettings(agentId, guildId);
            await interaction.showModal(zarCommandModal(agentId, guildId, settings.zar_command));
            return true;
        }

        if (parts[1] === 'ai_toggle') {
            const agentId = parts[2];
            const guildId = parts[3];
            const settings = await store.getGameSettings(agentId, guildId);
            await store.updateGameSettings(agentId, guildId, { ai_answers: !settings.ai_answers });
            await update(interaction, await renderGamesPage(agentId, guildId, manager));
            return true;
        }

        if (parts[1] === 'suppress_toggle') {
            const agentId = parts[2];
            const guildId = parts[3];
            const settings = await store.getGameSettings(agentId, guildId);
            await store.updateGameSettings(agentId, guildId, { suppress_ai: !settings.suppress_ai });
            await update(interaction, await renderGamesPage(agentId, guildId, manager));
            return true;
        }

        if (parts[1] === 'social_toggle') {
            const agentId = parts[2];
            const guildId = parts[3];
            const settings = await store.getGameSettings(agentId, guildId);
            const next = !(settings.social && settings.social.enabled);
            await store.updateGameSettings(agentId, guildId, { social: { enabled: next } });
            await store.pushRecentEvent(agentId, { kind: 'social', text: next ? '🫧 فُعّل التفاعل الاجتماعي أثناء اللعب' : '🫧 أُوقف التفاعل الاجتماعي' });
            await update(interaction, await renderGamesPage(agentId, guildId, manager));
            return true;
        }

        if (parts[1] === 'premium') {
            const engineId = parts[2];
            const agentId = parts[3];
            const guildId = parts[4];
            const settings = await store.getGameSettings(agentId, guildId);
            const current = Boolean(settings.engines[engineId]?.premium_join);
            await store.updateGameSettings(agentId, guildId, { engines: { [engineId]: { premium_join: !current } } });
            await update(interaction, await renderGamesPage(agentId, guildId, manager));
            return true;
        }

        // 🧠 تبديل وضع القرار ذكي/تلقائي (v7.16) — مافيا وروليت
        if (parts[1] === 'mode') {
            const engineId = parts[2];
            const agentId = parts[3];
            const guildId = parts[4];
            if (!['mafia', 'roulette'].includes(engineId)) return true;
            const settings = await store.getGameSettings(agentId, guildId);
            // 🧠 v7.18: اجتماعي ↔ تلقائي — القرار بعقل الوكيل في الوضعين،
            // والفرق الكلام: اجتماعي كامل / تلقائي ردود موقعه فقط
            const isSocial = settings.engines[engineId]?.mode === 'social' || settings.engines[engineId]?.mode === 'ai';
            const next = isSocial ? 'auto' : 'social';
            await store.updateGameSettings(agentId, guildId, { engines: { [engineId]: { mode: next } } });
            await store.pushRecentEvent(agentId, { kind: 'engine', text: next === 'social' ? `🫧 فُعّل الوضع الاجتماعي (${engineId === 'mafia' ? 'مافيا' : 'روليت'}) — يلعب ويتفاعل بالكلام` : `🤫 عاد الوضع التلقائي (${engineId === 'mafia' ? 'مافيا' : 'روليت'}) — يلعب ويقرر بصمت` });
            await update(interaction, await renderGamesPage(agentId, guildId, manager));
            return true;
        }

        if (parts[1] === 'policy') {
            await update(interaction, await renderPolicyPage());
            return true;
        }

        if (parts[1] === 'pol_bots') {
            await interaction.showModal(botIdsModal(parts[2]));
            return true;
        }

        if (parts[1] === 'pol_filter') {
            await policy.toggleBotFilter(parts[2]);
            await update(interaction, await renderPolicyPage());
            return true;
        }

        if (parts[1] === 'pol_lock') {
            const p = await policy.getPolicy();
            await policy.setOverlapLock(!p.overlapLockEnabled);
            await update(interaction, await renderPolicyPage());
            return true;
        }

        if (parts[1] === 'pol_lock_eng') {
            const engineId = parts[2];
            const p = await policy.getPolicy();
            await policy.setOverlapLock(!policy.isOverlapLockEnabled(p, engineId), engineId);
            await update(interaction, await renderPolicyPage());
            return true;
        }

        if (parts[1] === 'pol_servers') {
            await interaction.showModal(serversModal());
            return true;
        }

        return true;
    } catch (error) {
        console.error('[Games Panel]', error);
        try {
            const payload = ui.v2Payload(ui.container({
                accent: ui.ACCENTS.danger,
                title: '🎮 خطأ في لوحة الألعاب',
                body: `\`${error?.message || String(error)}\``,
                rows: [backHomeRow()],
            }));
            await update(interaction, payload);
        } catch (_) {}
        return true;
    }
}

module.exports = { gamesCommand, handleGamesInteraction, renderGamesPage, renderAgentSelect, renderGuildSelect, renderPolicyPage };
