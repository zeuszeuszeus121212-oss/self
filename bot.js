/**
 * bot.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * Manager Runtime: المصدر الوحيد للحقيقة لإدارة وكلاء الذكاء الاصطناعي.
 * يشغل Dashboard احترافية داخل Discord ويدير lifecycle/runtime/database/logs.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

// ⚠️ أول require على الإطلاق — حقن webcrypto للبيئات القديمة (Node < 19)
// بدون هذا ينهار اتصال MongoDB: "crypto is not defined" داخل درايفر mongodb 7.x
require('./polyfills');

const { ObjectId } = require('mongodb');
const { Client, GatewayIntentBits, Partials, REST, Routes } = require('discord.js');
const { DISCORD_TOKEN, connectMongo } = require('./config');
const { startAgentRuntime } = require('./agentRuntime');
const { dashboardCommands, handleDashboardInteraction, embed, linesBlock, COLORS, handleKnowledgeUploadMessage, handlePersonalityUploadMessage, handleSecretUploadMessage } = require('./managerDashboard');
const { v2Payload, V2_EPHEMERAL_FLAGS } = require('./ui');
const secrets = require('./secrets');

const LIFECYCLE = Object.freeze({
    STARTING   : 'starting',
    RUNNING    : 'running',
    STOPPING   : 'stopping',
    STOPPED    : 'stopped',
    RESTARTING : 'restarting',
    FAILED     : 'failed',
});

const runtimes = new Map();
const reconnectTimers = new Map();
let managerClient = null;

// ══════════════════════════════════════════════════════════════
//  🔒 حارس لوحة المدير — القاعدة الذهبية للعزل الأمني
//  لوحة إدارة الوكلاء تعمل من بوت المدير الرئيسي حصراً. أي تفاعل
//  قادم من عميل آخر (بوت وكيل مثلاً) يُرفض برسالة محايدة — حتى لو
//  سُجلت أوامر اللوحة على تطبيقه بطريقة ما (بقايا تسجيل قديم مثلاً).
//  @param {object} opts { managerUserId: ()=>string|null, delegate: async (interaction)=>void }
// ══════════════════════════════════════════════════════════════
function makeManagementProxy({ managerUserId, delegate }) {
    return async function handleManagementInteraction(interaction) {
        const expectedId = typeof managerUserId === 'function' ? managerUserId() : managerUserId;
        const senderId = interaction?.client?.user?.id;
        if (!expectedId || !senderId || String(senderId) !== String(expectedId)) {
            const ui = require('./ui');
            const payload = {
                flags: ui.V2_EPHEMERAL_FLAGS,
                components: [ui.container({
                    accent: ui.ACCENTS.warning,
                    title: 'غير متاح هنا',
                    body: 'هذا البوت رفيق محادثة فقط — الإدارة تتم من بوت المدير الرئيسي.',
                })],
            };
            if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
            else await interaction.reply(payload).catch(() => {});
            return false; // مرفوض — لم تُنفذ أي إدارة
        }
        await delegate(interaction);
        return true;
    };
}

function createManagerClient() {
    return new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMembers,
        ],
        partials: [Partials.Message, Partials.Channel, Partials.Reaction],
    });
}

async function getNotificationChannel(agentId, guildId = null) {
    const cfg = require('./config');
    const agent = agentId && ObjectId.isValid(String(agentId))
        ? await cfg.agents_col.findOne({ _id: new ObjectId(agentId) }).catch(() => null)
        : null;
    if (agent?.notification_channel_id) return agent.notification_channel_id;
    // 🌍 العالمية أولاً — قناة واحدة تستقبل كل شيء من كل السيرفرات (طلب المالك:
    // «أريد إشعار كلما تحدث شخص مع البوت في أي سيرفر» — ليست إعداد سيرفر واحد فقط)
    const globalSettings = await cfg.settings_col.findOne({ scope: 'manager', guild_id: 'global' }).catch(() => null);
    if (globalSettings?.notification_channel_id) return globalSettings.notification_channel_id;
    // إعداد السيرفر المحدد — تراث التوافق القديم فقط (اختياري لكل سيرفر)
    const settings = guildId
        ? await cfg.settings_col.findOne({ scope: 'manager', guild_id: String(guildId) }).catch(() => null)
        : null;
    return settings?.notification_channel_id || null;
}

async function notify({ type = 'runtime', agentId = null, title = 'Runtime Event', message = '', level = 'info', guildId = null, extra = {} }) {
    if (!managerClient) return false;
    const channelId = await getNotificationChannel(agentId, guildId);
    if (!channelId) return false;
    const channel = await managerClient.channels.fetch(channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') return false;
    const color = level === 'error' ? COLORS.danger : level === 'warning' ? COLORS.warning : level === 'success' ? COLORS.success : COLORS.info;
    const payload = embed(title, linesBlock([
        message,
        agentId ? `الوكيل: **${agentId}**` : null,
        `النوع: **${type}**`,
        extra.reason ? `السبب: ${extra.reason}` : null,
    ]), color);
    // 🎨 الإشعارات أيضاً على Components V2 — لا إيمبدات في المنصة كلها
    await channel.send(v2Payload(payload)).catch((error) => console.error('[Notify]', error.message));
    return true;
}

// 🕶️ حقن المُخبِر — أخطاء الوكلاء الحقيقية (المفصلة) تصل قناة الإشعارات عبر المدير،
// بينما القنوات العامة ترى اعتذاراً بشرياً محايداً فقط (سياسة وجه البوكر)
require('./errorReporter').setManagerNotifier(notify);

// 🛰️ RAQEEB + 🌐 حسابات Qwen — إشعارات المالك عبر نفس قناة الإشعارات (v7.9)
require('./guildRegistry').setNotifier(notify);
require('./qwenAccounts').setNotifier(notify);

async function logAgent(agentId, type, message, extra = {}) {
    const cfg = require('./config');
    try {
        await cfg.logs_col.insertOne({
            agent_id  : String(agentId),
            type,
            message,
            extra,
            created_at: new Date(),
        });
        const important = new Set(['starting', 'running', 'stopping', 'stopped', 'restarting', 'failed', 'error', 'delete', 'create', 'reconnect_scheduled', 'disconnect']);
        if (important.has(String(type))) {
            await notify({
                type,
                agentId,
                title: `${type === 'failed' || type === 'error' ? '🔴' : type === 'running' ? '🟢' : '📡'} ${message}`,
                message,
                level: type === 'failed' || type === 'error' ? 'error' : type === 'stopped' || type === 'reconnect_scheduled' ? 'warning' : 'info',
                extra,
            });
        }
    } catch (e) {
        console.error(`[AgentLog ${agentId}]`, e.message);
    }
}

async function setAgentStatus(agentId, status, extra = {}) {
    const cfg = require('./config');
    await cfg.agents_col.updateOne(
        { _id: new ObjectId(agentId) },
        { $set: { status, status_reason: extra.reason || '', last_activity_at: new Date(), updated_at: new Date() } },
    );
}

async function cleanupRuntime(agentId) {
    const id = String(agentId);
    const timer = reconnectTimers.get(id);
    if (timer) {
        clearTimeout(timer);
        reconnectTimers.delete(id);
    }
    const runtime = runtimes.get(id);
    if (runtime) {
        try {
            runtime.stop();
        } catch (_) {}
        runtimes.delete(id);
    }
}

async function scheduleReconnect(agentId, reason = 'unexpected disconnect') {
    const id = String(agentId);
    if (reconnectTimers.has(id)) return;
    await logAgent(id, 'reconnect_scheduled', reason, { reason });
    const timer = setTimeout(async () => {
        reconnectTimers.delete(id);
        const cfg = require('./config');
        const agent = await cfg.agents_col.findOne({ _id: new ObjectId(id) });
        if (!agent || agent.status === LIFECYCLE.STOPPED || agent.status === LIFECYCLE.STOPPING) return;
        await restartAgent(id, reason);
    }, 10_000);
    reconnectTimers.set(id, timer);
}

async function startAgent(agent) {
    const id = String(agent._id || agent.id || 'default');
    if (runtimes.has(id)) return runtimes.get(id);
    try {
        await setAgentStatus(id, LIFECYCLE.STARTING);
        await logAgent(id, 'starting', 'بدء تشغيل الوكيل');
        const runtime = await startAgentRuntime({
            ...agent,
            onReady: async () => {
                await setAgentStatus(id, LIFECYCLE.RUNNING);
                await logAgent(id, 'running', 'تم اتصال الوكيل');
            },
            onError: async (err) => {
                await logAgent(id, 'error', err?.message || String(err));
            },
            onUnexpectedDisconnect: async (reason) => {
                await logAgent(id, 'disconnect', reason || 'انقطع اتصال الوكيل', { reason });
                await scheduleReconnect(id, reason);
            },
            handleManagementInteraction: makeManagementProxy({
                managerUserId: () => managerClient?.user?.id,
                delegate: async (interaction) => handleDashboardInteraction(interaction, module.exports),
            }),
        });
        runtimes.set(id, runtime);
        return runtime;
    } catch (e) {
        await cleanupRuntime(id);
        await setAgentStatus(id, LIFECYCLE.FAILED, { reason: e.message });
        await logAgent(id, 'failed', e.message, { stack: e.stack });
        console.error(`[Agent ${id}] start failed:`, e);
        return null;
    }
}

async function stopAgent(agentId) {
    const id = String(agentId);
    try {
        await setAgentStatus(id, LIFECYCLE.STOPPING);
        await logAgent(id, 'stopping', 'بدء إيقاف الوكيل');
        await cleanupRuntime(id);
        await setAgentStatus(id, LIFECYCLE.STOPPED);
        await logAgent(id, 'stopped', 'تم إيقاف الوكيل');
        return true;
    } catch (e) {
        await setAgentStatus(id, LIFECYCLE.FAILED, { reason: e.message });
        await logAgent(id, 'failed', e.message, { stack: e.stack });
        return false;
    }
}

async function restartAgent(agentId, reason = 'restart requested') {
    const id = String(agentId);
    const cfg = require('./config');
    try {
        await setAgentStatus(id, LIFECYCLE.RESTARTING, { reason });
        await logAgent(id, 'restarting', reason, { reason });
        await cleanupRuntime(id);
        const fresh = await cfg.agents_col.findOne({ _id: new ObjectId(id) });
        if (!fresh) throw new Error('الوكيل غير موجود');
        return await startAgent({ ...fresh, status: LIFECYCLE.RUNNING });
    } catch (e) {
        await cleanupRuntime(id);
        await setAgentStatus(id, LIFECYCLE.FAILED, { reason: e.message });
        await logAgent(id, 'failed', e.message, { stack: e.stack });
        return null;
    }
}

async function retireLegacyDefaultAgents() {
    const cfg = require('./config');
    await cfg.agents_col.updateMany(
        { legacy: true },
        { $set: { status: LIFECYCLE.STOPPED, status_reason: 'Legacy env agent disabled; manager bot is control-only', updated_at: new Date() } },
    );
}

/**
 * إنشاء وكيل جديد — يدعم المزودين المتعددين ونوعي التشغيل.
 * @param {object} opts
 *   - kind: 'agent' (وكيل بأدوات كاملة — الافتراضي) | 'chat' (محادثة خالصة بلا أي أدوات)
 *   - provider: 'deepseek' | 'qwen' | 'openai' | 'gemini' (افتراضي deepseek للتوافق القديم)
 *   - providerConfig: { deepseek_token } | { qwen_token } | { openai_* } | { gemini_cookies }
 *   - allowIncomplete: عندما true لا يفشل الإنشاء إن نقصت بيانات المزود —
 *     يُنشأ الوكيل بعلم config_incomplete ويُكمل بياناته لاحقاً من صفحة الإعدادات
 *     أو بإرسالها كملف (الكوكيز الطويلة مثلاً). الافتراضي false (سلوك صارم).
 *   التوافق القديم: استدعاء بـ deepseek_token مباشرة يعمل كما هو.
 */
async function createAgent({ name, discord_token, deepseek_token, personality = '', token_type = 'bot', kind = 'agent', provider = null, providerConfig = {}, allowIncomplete = false }) {
    const cfg = require('./config');
    const { getProviderOrFallback } = require('./providers');

    // تحديد المزود: صريح، أو استنتاج من deepseek_token (توافق قديم)
    const providerId = provider ? String(provider).toLowerCase() : (deepseek_token ? 'deepseek' : 'deepseek');
    const providerObj = getProviderOrFallback(providerId);

    // دمج إعدادات المزود: providerConfig أولاً ثم الحقول القديمة مباشرة
    const mergedProviderConfig = { ...providerConfig };
    if (deepseek_token && !mergedProviderConfig.deepseek_token) mergedProviderConfig.deepseek_token = deepseek_token;

    // التحقق من اكتمال إعدادات المزود المختار
    // 📎 النوافذ تقول «أو من ملف لاحقاً» — فلا يجوز أن يفشل الإنشاء ب«المفتاح مفقود»
    // عندما يترك المستخدم الحقل فارغاً عن قصد ليُرسل القيمة كملف بعد الإنشاء.
    const validation = providerObj.validate(mergedProviderConfig);
    const incomplete = !validation.ok;
    if (incomplete && !allowIncomplete) {
        throw new Error(`إعدادات مزود ${providerObj.label} ناقصة: ${validation.missing.join(', ')}`);
    }

    const doc = {
        name,
        discord_token,
        personality,
        token_type,
        kind           : String(kind).toLowerCase() === 'chat' ? 'chat' : 'agent', // 💬 محادثة خالصة / 🤖 وكيل
        provider       : providerObj.id,
        ...mergedProviderConfig, // حقول المزود تُخزن بحقولها الخاصة (deepseek_token / qwen_token / openai_base_url ...)
        config_incomplete        : incomplete,
        missing_provider_fields  : incomplete ? validation.missing : [],
        status         : LIFECYCLE.STOPPED,
        created_at     : new Date(),
        updated_at     : new Date(),
    };
    // 🔐 تشفير الأسرار قبل الحفظ (passthrough كامل إن لم يُضبط ENCRYPTION_KEY)
    secrets.encryptSecretsInPatch(doc);
    const res = await cfg.agents_col.insertOne(doc);
    // نُعيد نسخة مفكوكة الأسرار حتى يستلم المستدعي وثيقة صالحة للاستخدام الفوري
    return { ...doc, _id: res.insertedId };
}

async function deleteAgent(agentId) {
    await cleanupRuntime(agentId);
    const cfg = require('./config');
    await cfg.agents_col.deleteOne({ _id: new ObjectId(agentId) });
    await logAgent(agentId, 'delete', 'تم حذف الوكيل');
}

async function registerDashboardCommands(client, token) {
    if (!token || !client.user?.id) return;
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationCommands(client.user.id), { body: dashboardCommands().map(cmd => cmd.toJSON()) });
    console.log('✅ Manager dashboard commands synced');
}

async function startManagerBot() {
    if (!DISCORD_TOKEN) {
        console.warn('⚠️ DISCORD_TOKEN غير محدد؛ سيتم تشغيل Manager بدون Discord Dashboard.');
        return null;
    }
    managerClient = createManagerClient();
    managerClient.once('ready', async () => {
        console.log(`✅ Manager Bot ready as ${managerClient.user.tag}`);
        await registerDashboardCommands(managerClient, DISCORD_TOKEN).catch((error) => console.error('❌ فشل تسجيل أوامر Dashboard:', error));
        // 🛰️ RAQEEB — ترحيل صامت لسيرفرات المدير الحالية (القديمة قبل تفعيل الرصد)
        await require('./guildRegistry').backfillGuilds(managerClient).catch((e) => console.error('[Raqeeb] فشل الترحيل:', e.message));
    });
    managerClient.on('interactionCreate', async (interaction) => {
        try {
            await handleDashboardInteraction(interaction, module.exports);
        } catch (error) {
            console.error('[Dashboard Error]', error);
            // 🎨 رسائل الخطأ على Components V2 — حاوية بشريط أحمر لا إيمبد
            const payload = v2Payload(embed('خطأ في Dashboard', linesBlock([
                error.message || String(error),
            ]), COLORS.danger));
            if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
            else await interaction.reply(payload).catch(() => {});
        }
    });
    managerClient.on('error', (error) => logAgent('manager', 'error', error.message || String(error)));
    // 📚 التقاط ملفات قاعدة المعرفة المرسلة من صاحب رفع معلّق (من صفحة المعرفة باللوحة)
    // 📎 التقاط ملف الشخصية المرسل من صاحب رفع معلّق (من زر «شخصية من ملف» في صفحة الإعدادات)
    managerClient.on('messageCreate', async (message) => {
        try {
            if (await handleKnowledgeUploadMessage(message, module.exports)) return;
        } catch (e) {
            console.error('[Knowledge Upload]', e.message);
        }
        try {
            await handlePersonalityUploadMessage(message, module.exports);
        } catch (e) {
            console.error('[Personality Upload]', e.message);
        }
        // 🍪 التقاط أسرار المزودين المرسلة كملف/لصق من صاحب رفع معلّق (كوكيز Gemini الأطول من 4000 حرف)
        try {
            await handleSecretUploadMessage(message, module.exports);
        } catch (e) {
            console.error('[Secret Upload]', e.message);
        }
    });
    await managerClient.login(DISCORD_TOKEN);
    return managerClient;
}

async function bootAgents() {
    await connectMongo();
    await retireLegacyDefaultAgents();
    // 🔐 ترحيل شفاف: تشفير كل التوكنات النصية القديمة (idempotent — بلا مفتاح يتخطى)
    const cfg0 = require('./config');
    await secrets.migrateAgentTokensEncryption(cfg0.agents_col).catch(() => {});
    await startManagerBot();
    const cfg = require('./config');
    const agents = await cfg.agents_col.find({ status: LIFECYCLE.RUNNING, legacy: { $ne: true } }).toArray();
    for (const agent of agents) startAgent(agent);
    console.log(`✅ Agent manager ready — running ${agents.length} agents`);

    // ⬅️ بدء نظام الجدولة الذكي
    const { startScheduleTimers } = require('./accountAgent');
    startScheduleTimers(module.exports);

    // 🛰️ RAQEEB — قصّ سجل النشاط دورياً (v7.9)
    require('./guildRegistry').startRegistryTimers();
    // 🌐 حسابات Qwen التلقائية — مجدول التجديد (v7.9)
    require('./qwenAccounts').startQwenAccountTimers();

    // ⏰ محرك تذكيرات احتياطي من المدير (v7.11 — طلب المالك):
    // تذكير وكيل متوقف/فاشل لا يموت معه — المدير يرسله مكانه
    // (فلتر shouldHandle يستثني الوكلاء الذين يعمل محركهم الخاص الآن)
    try {
        const { startReminderEngine } = require('./reminders');
        const managerReminderEngine = startReminderEngine({
            client: managerClient,
            shouldHandle: (aid) => {
                const r = runtimes.get(String(aid));
                return !r; // لا يوجد runtime حي لهذا الوكيل — التذكير مسؤولية المدير
            },
        });
        module.exports.__managerReminderEngine = managerReminderEngine;
        console.log('⏰ محرك تذكيرات المدير الاحتياطي يعمل (يغطي الوكلاء المتوقفين)');
    } catch (e) {
        console.error('❌ فشل بدء محرك تذكيرات المدير الاحتياطي:', e.message);
    }
}

module.exports = {
    LIFECYCLE,
    runtimes,
    startAgent,
    stopAgent,
    restartAgent,
    createAgent,
    deleteAgent,
    setAgentStatus,
    logAgent,
    notify,
    getNotificationChannel,
    bootAgents,
    makeManagementProxy,
    get managerClient() { return managerClient; },
};

if (require.main === module) {
    bootAgents().catch((err) => {
        console.error('❌ فشل تشغيل مدير الوكلاء:', err);
        process.exit(1);
    });
}