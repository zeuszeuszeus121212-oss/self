/**
 * bot.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * Manager Runtime: المصدر الوحيد للحقيقة لإدارة وكلاء الذكاء الاصطناعي.
 * يشغل Dashboard احترافية داخل Discord ويدير lifecycle/runtime/database/logs.
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { ObjectId } = require('mongodb');
const { Client, GatewayIntentBits, Partials, REST, Routes } = require('discord.js');
const { DISCORD_TOKEN, connectMongo } = require('./config');
const { startAgentRuntime } = require('./agentRuntime');
const { dashboardCommands, handleDashboardInteraction, embed, linesBlock, COLORS } = require('./managerDashboard');

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
    const settings = guildId
        ? await cfg.settings_col.findOne({ scope: 'manager', guild_id: String(guildId) }).catch(() => null)
        : null;
    if (settings?.notification_channel_id) return settings.notification_channel_id;
    const globalSettings = await cfg.settings_col.findOne({ scope: 'manager', guild_id: 'global' }).catch(() => null);
    return globalSettings?.notification_channel_id || null;
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
    await channel.send({ embeds: [payload] }).catch((error) => console.error('[Notify]', error.message));
    return true;
}

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
            handleManagementInteraction: async (interaction) => handleDashboardInteraction(interaction, module.exports),
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
 * إنشاء وكيل جديد — يدعم المزودين المتعددين.
 * @param {object} opts
 *   - provider: 'deepseek' | 'qwen' | 'openai' (افتراضي deepseek للتوافق القديم)
 *   - providerConfig: { deepseek_token } | { qwen_token, qwen_model } | { openai_base_url, openai_api_key, openai_model }
 *   التوافق القديم: استدعاء بـ deepseek_token مباشرة يعمل كما هو.
 */
async function createAgent({ name, discord_token, deepseek_token, personality = '', token_type = 'bot', provider = null, providerConfig = {} }) {
    const cfg = require('./config');
    const { getProviderOrFallback } = require('./providers');

    // تحديد المزود: صريح، أو استنتاج من deepseek_token (توافق قديم)
    const providerId = provider ? String(provider).toLowerCase() : (deepseek_token ? 'deepseek' : 'deepseek');
    const providerObj = getProviderOrFallback(providerId);

    // دمج إعدادات المزود: providerConfig أولاً ثم الحقول القديمة مباشرة
    const mergedProviderConfig = { ...providerConfig };
    if (deepseek_token && !mergedProviderConfig.deepseek_token) mergedProviderConfig.deepseek_token = deepseek_token;

    // التحقق من اكتمال إعدادات المزود المختار
    const validation = providerObj.validate(mergedProviderConfig);
    if (!validation.ok) {
        throw new Error(`إعدادات مزود ${providerObj.label} ناقصة: ${validation.missing.join(', ')}`);
    }

    const doc = {
        name,
        discord_token,
        personality,
        token_type,
        provider       : providerObj.id,
        ...mergedProviderConfig, // حقول المزود تُخزن بحقولها الخاصة (deepseek_token / qwen_token / openai_base_url ...)
        status         : LIFECYCLE.STOPPED,
        created_at     : new Date(),
        updated_at     : new Date(),
    };
    const res = await cfg.agents_col.insertOne(doc);
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
    });
    managerClient.on('interactionCreate', async (interaction) => {
        try {
            await handleDashboardInteraction(interaction, module.exports);
        } catch (error) {
            console.error('[Dashboard Error]', error);
            const payload = { embeds: [embed('⚠️ خطأ في Dashboard', linesBlock([error.message || String(error)]), COLORS.danger)] };
            if (interaction.replied || interaction.deferred) await interaction.followUp(payload).catch(() => {});
            else await interaction.reply(payload).catch(() => {});
        }
    });
    managerClient.on('error', (error) => logAgent('manager', 'error', error.message || String(error)));
    await managerClient.login(DISCORD_TOKEN);
    return managerClient;
}

async function bootAgents() {
    await connectMongo();
    await retireLegacyDefaultAgents();
    await startManagerBot();
    const cfg = require('./config');
    const agents = await cfg.agents_col.find({ status: LIFECYCLE.RUNNING, legacy: { $ne: true } }).toArray();
    for (const agent of agents) startAgent(agent);
    console.log(`✅ Agent manager ready — running ${agents.length} agents`);

    // ⬅️ بدء نظام الجدولة الذكي
    const { startScheduleTimers } = require('./accountAgent');
    startScheduleTimers(module.exports);
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
    bootAgents,
    get managerClient() { return managerClient; },
};

if (require.main === module) {
    bootAgents().catch((err) => {
        console.error('❌ فشل تشغيل مدير الوكلاء:', err);
        process.exit(1);
    });
}