/**
 * tools/agent.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * استخراج JSON + حلقة الوكيل runAgent
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');
const axios = require('axios');

const { ChannelType, AttachmentBuilder } = require('discord.js');
const { isTextChannel, isUserRuntime } = require('../discordAdapter');

const {
    _err,
    findChannel, findGuild,
    toolAllowedForAccess, executeAllowedForAccess,
} = require('../utils');

const { getProviderOrFallback, extractProviderConfig, buildFallbackChain } = require('../providers');
const webTools = require('./webTools');
const memory   = require('../memory');
const reminders = require('../reminders');
const knowledge = require('../knowledge');
const usage = require('../usage');

const { buildSystem } = require('./systemPrompt');

const {
    toolGetChannels,
    toolGetCategories,
    toolGetRoles,
    toolGetMembers,
    toolServerInfo,
    toolListAllGuilds,
    toolGetMessages,
    toolGetAuditLog,
    toolGetInvites,
    toolGetEmojis,
    toolGetStickers,
    toolGetBans,
    toolGetPinnedMessages,
    toolGetVoiceStates,
    toolSearchMessages,
    toolModerationOverview,
    toolRecentJoins,
    toolInactiveMembers,
    toolRoleMembers,
    toolChannelPermissions,
    toolGetWebhooks,
    toolGetScheduledEvents,
    toolGetThreads,
    toolGetNitroBoosters,
    toolGetBotList,
    toolGetMemberInfo,
    toolGetBotCommands,
    toolAnalyzeBot,
    toolServerBlueprint,
    toolPermissionAudit,
    toolChannelActivity,
    toolAgentConfigAudit,
} = require('./readTools');

const { executeAction } = require('./executeAction');

// ══════════════════════════════════════════════════════════════
//  JSON EXTRACTION — استخراج JSON من النصوص
// ══════════════════════════════════════════════════════════════

function extractJsonObjects(text) {
    const objects = [];

    const codeBlockRegex = /```json\s*([\s\S]*?)```/g;
    let match;
    while ((match = codeBlockRegex.exec(text)) !== null) {
        const block = match[1].trim();
        try {
            const obj = JSON.parse(block);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                objects.push(obj);
            }
        } catch (_) {
            const nestedRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
            let nm;
            while ((nm = nestedRegex.exec(block)) !== null) {
                try {
                    const o = JSON.parse(nm[0]);
                    if (o && typeof o === 'object') objects.push(o);
                } catch (_) {}
            }
        }
    }

    const cleaned = text.replace(/```json\s*[\s\S]*?```/g, '');
    const objRegex = /\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g;
    let om;
    while ((om = objRegex.exec(cleaned)) !== null) {
        try {
            const obj = JSON.parse(om[0]);
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                const str = JSON.stringify(obj);
                if (!objects.some(o => JSON.stringify(o) === str)) {
                    objects.push(obj);
                }
            }
        } catch (_) {}
    }

    return objects;
}

// ══════════════════════════════════════════════════════════════
//  FALSE SUCCESS DETECTION — ذكي وسياقي
// ══════════════════════════════════════════════════════════════

// كلمات تدل على أن المستخدم طلب إجراءً إدارياً فعلياً (وليس مجرد سؤال أو شرح)
const ADMIN_ACTION_REQUEST_RE = /(غير|حول|عدل|امسح|احذف|أنشئ|اسحب|أعط|ركّل|بند|فك|نظف|أرشف|انسخ|أرسل|منشن|ثبت|افتح|اقفل)/i;

// كلمات تدل على أن النموذج يدّعي النجاح دون استخدام أداة
const FALSE_SUCCESS_RE = /(تم\s|✅|نفذت|خلصت|سويت|غيرت|حذفت|أنشأت|أضفت|عدلت|أرسلت|ركّلت|بندت|فكّيت|أعطيت|سحبت)/i;

/**
 * يفحص ما إذا كان يجب تفعيل الـ guard لمنع الادعاء الكاذب.
 * @param {string} raw - رد النموذج
 * @param {string} userMsg - رسالة المستخدم الأصلية
 * @returns {boolean}
 */
function shouldTriggerFalseSuccessGuard(raw, userMsg) {
    // 1. هل النص يحوي كلمة نجاح كاذبة؟
    if (!FALSE_SUCCESS_RE.test(raw)) return false;
    
    // 2. هل طلب المستخدم الأصلي يوحي بأنه يريد إجراءً إدارياً فعلياً؟
    if (!ADMIN_ACTION_REQUEST_RE.test(userMsg)) return false;
    
    // 3. تحقق إضافي: إذا كان النص يحوي علامات استفهام أو كلمات استفسار، فهو شرح على الأغلب.
    if (/[?؟]/.test(raw) || /(شرح|مثال|يعني|المقصود|طريقة|كيف)/i.test(raw)) return false;

    return true;
}

// ══════════════════════════════════════════════════════════════
//  MEDIA ATTACHMENT HANDLER — إرسال المرفقات إلى القناة
// ══════════════════════════════════════════════════════════════

/**
 * يرسل مرفقات AttachmentBuilder إلى القناة ويعيد true إذا نجح
 * @param {import('discord.js').TextChannel} ch
 * @param {import('discord.js').AttachmentBuilder[]} attachments
 * @returns {Promise<boolean>}
 */
async function _sendAttachments(ch, attachments) {
    if (!ch || !attachments || !attachments.length) return false;
    try {
        await ch.send({ files: attachments });
        return true;
    } catch (e) {
        console.error('[Agent] فشل إرسال المرفقات:', e.message);
        return false;
    }
}

/**
 * تنزيل ملف (صورة مولّدة) إلى مجلد مؤقت لإرساله في ديسكورد
 * @param {string} url
 * @returns {Promise<string>} مسار الملف المؤقت
 */
async function _downloadToTmp(url) {
    const safe = String(url || '');
    const extMatch = safe.match(/\.(png|jpe?g|webp|gif)(?:\?|$)/i);
    const ext = extMatch ? `.${extMatch[1].toLowerCase().replace('jpeg', 'jpg')}` : '.png';
    const resp = await axios.get(safe, {
        responseType: 'arraybuffer',
        timeout: 120_000,
        maxContentLength: 15 * 1024 * 1024,
        validateStatus: () => true,
    });
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status} أثناء تنزيل الصورة`);
    const tmpPath = path.join(os.tmpdir(), `disor_img_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(resp.data));
    return tmpPath;
}

// ══════════════════════════════════════════════════════════════
//  AGENT LOOP — حلقة الوكيل
// ══════════════════════════════════════════════════════════════

const MAX_STEPS = 24;
const MAX_FALSE_SUCCESS_ATTEMPTS = 1; // محاولة تصحيح واحدة فقط

// ══════════════════════════════════════════════════════════════
//  💬 أدوات وضع «المحادثة» — الأدوات الأساسية الممتعة فقط
//  ذاكرة + تذكيرات + قراءة (معلومات السيرفر/العضو/الرسائل).
//  كل ما عداه محجوب في هذا الوضع — ولا أدوات إدارة/تنفيذ/ويب إطلاقاً،
//  والبرومبت يمنع النموذج من ذكر وجود أدوات أصلاً (استخدام صامت).
// ══════════════════════════════════════════════════════════════
const CHAT_MODE_TOOLS = Object.freeze([
    // 🧠 الذاكرة (محصورة بمستخدم الطلب)
    'remember', 'recall', 'forget_memory',
    // ⏰ التذكيرات (محصورة بمستخدم الطلب)
    'set_reminder', 'list_reminders', 'cancel_reminder',
    // 👀 قراءة السيرفر والناس والرسائل — أدوات القراءة فقط
    'server_info', 'get_member_info',
    'get_messages', 'search_messages', 'get_pinned_messages',
    'get_channels',
]);

async function runAgent(
    guild, channel, userMsg, userInfo, botContext, botName,
    sessionId, parentMessageId, guildId,
    mode = 'default', thinking = false, accessLevel = 'member',
    client,
    runtime = {},
    requester = {}, // {userId, username, channelId} — هوية طالب الطلب (للذاكرة والتذكيرات)
) {
    // 🧠 قدرات النموذج الأصلية (تفكير/بحث مدمج) — قدرة الوكيل هي الافتراضي،
    // وتفكير جلسة القناة (محادثة-جديدة تفكير:on) يظل الأعلى أولوية
    const effThinking = Boolean(thinking) || Boolean(runtime.capabilities?.thinking);
    const nativeSearch = Boolean(runtime.capabilities?.search);

    // 💬🤖 نوع الوكيل: 'chat' = حوار خالص بلا أدوات (لا يعلم بها أصلاً)، 'agent' = الوكيل الكامل
    const agentKind = runtime.kind === 'chat' ? 'chat' : 'agent';

    const system    = buildSystem(botName, mode, effThinking, accessLevel, runtime.personality || '', runtime.features || {}, runtime.capabilities || {}, agentKind);

    // ── ⚙️ ميزات الوكيل القابلة للتعطيل (توافق قديم: بلا إعداد = مفعّلة) ──
    // web_search حُذفت نهائياً في v7.4 — البحث مسؤولية النموذج نفسه (بحثه المدمج)
    const readUrlEnabled = runtime.features ? runtime.features.read_url !== false : true;

    // ── 📊 تتبع الاستخدام — لا يعطل شيئاً أبداً ──
    const track = (kind, meta) => { try { usage.track(runtime.agentId || 'default', guildId, kind, meta).catch(() => {}); } catch (_) {} };

    // ── نظام المزودين + سلسلة Fallback ──
    // [0] الأساسي دائماً — البدائل فقط عند تفعيل fallback وتوفر إعداداتها كاملة
    const chain     = buildFallbackChain(runtime);
    let chainIdx    = 0;
    const provider     = chain[0].obj;
    const providerConf = chain[0].config;

    let curSid      = sessionId;
    let curPmid     = parentMessageId;
    let curPrompt   = (
        `${system}\n\n` +
        `[مستوى صلاحية المستخدم داخل البوت: ${accessLevel}]\n\n` +
        `${botContext}\n\n${userInfo}\n\nUser: ${userMsg}`
    );
    
    let falseSuccessCount = 0; // عداد لكسر الحلقة اللانهائية

    // 💬 وضع المحادثة: نفس حلقة الوكيل لكن بأدوات أساسية مقيدة فقط
    // (CHAT_MODE_TOOLS) — لا تنفيذ إداري ولا ويب ولا ملفات ولا معرفة.
    const chatMode = agentKind === 'chat';

    // 📁 ملفات الإرسال المتراكمة عبر كل خطوات الحلقة (صور مولدة، ملفات نصية...)
    const filesToSend = [];

    for (let step = 0; step < MAX_STEPS; step++) {
        const activeProvider = chain[chainIdx];
        console.log(`[Agent ${step + 1}/${MAX_STEPS}] provider=${activeProvider.id}${chainIdx > 0 ? ' (fallback)' : ''} mode=${mode} thinking=${thinking} access=${accessLevel}`);

        let raw;
        try {
            const aiResult = await activeProvider.obj.chat({
                prompt           : curPrompt,
                guildId,
                sessionId        : curSid,
                parentMessageId  : curPmid,
                mode,
                thinking         : effThinking,
                // 🔍 البحث المدمج للنموذج (قدرة الوكيل) — لكل مزود طريقته
                search           : nativeSearch,
                // 🖼️ صور مرفقة من رسالة المستخدم (رؤية النموذج — يدعمها Qwen وOpenAI)
                images           : Array.isArray(requester.images) ? requester.images : [],
                config           : activeProvider.config,
                agentId          : runtime.agentId || 'default',
            });
            raw     = aiResult.fullText;
            curSid  = aiResult.sessionId;
            curPmid = aiResult.newParentMessageId;
        } catch (e) {
            // ── Fallback تلقائي: جرّب المزود التالي في السلسلة ──
            if (chainIdx < chain.length - 1) {
                const failed = activeProvider;
                chainIdx++;
                const next = chain[chainIdx];
                console.warn(`⚠️ [Fallback] فشل ${failed.obj.label} (${String(e.message).slice(0, 120)}) — التحويل إلى ${next.obj.label}`);
                track('fallback', { from: failed.obj.id, to: next.obj.id });
                // جلسات كل مزود مستقلة — نبدأ جلسة جديدة لدى البديل
                curSid  = null;
                curPmid = null;
                step--; // إعادة نفس الخطوة على البديل (لا تستهلك محاولة)
                continue;
            }
            track('error', { provider: activeProvider.id });
            return {
                reply      : `⚠️ خطأ في الاتصال بالنموذج (${activeProvider.label}): ${e.message}`,
                newSid     : curSid,
                newPmid    : curPmid,
                filesToSend: [],
            };
        }

        // 📊 نجاح استدعاء مزود
        track('provider', { provider: activeProvider.id });

        console.log(`  raw: ${raw.slice(0, 300)}`);

        const jsonObjects    = extractJsonObjects(raw);
        const allResults     = [];
        // ملاحظة: filesToSend مرفوعة لنطاق runAgent كاملاً — الملفات (صور مولدة/ملفات)
        // المجموعة في أي خطوة تُرسل مع الرد النهائي ولو جاء لاحقاً
        let finalReplyText   = null;

        for (const obj of jsonObjects) {
            if (obj.reply && !obj.tool && !obj.file && !obj.action) {
                finalReplyText = obj.reply;
                continue;
            }

            if (obj.file && typeof obj.file === 'object' && obj.file.name && obj.file.content) {
                const safeName = path.basename(obj.file.name) || 'output.txt';
                try {
                    const tmpPath = path.join(os.tmpdir(), `disor_${Date.now()}_${safeName}`);
                    fs.writeFileSync(tmpPath, String(obj.file.content), 'utf8');
                    filesToSend.push(tmpPath);
                    allResults.push(`[FILE_CREATED: ${safeName}]`);
                    if (obj.reply) finalReplyText = obj.reply;
                } catch (e) {
                    allResults.push(`[FILE_ERROR: ${e.message}]`);
                }
                continue;
            }

            if (obj.tool === 'file') {
                const p = obj.params || {};
                if (p.name && p.content) {
                    const safeName = path.basename(p.name) || 'output.txt';
                    try {
                        const tmpPath = path.join(os.tmpdir(), `disor_${Date.now()}_${safeName}`);
                        fs.writeFileSync(tmpPath, String(p.content), 'utf8');
                        filesToSend.push(tmpPath);
                        allResults.push(`[FILE_CREATED: ${safeName}]`);
                        if (obj.reply) finalReplyText = obj.reply;
                    } catch (e) {
                        allResults.push(`[FILE_ERROR: ${e.message}]`);
                    }
                }
                continue;
            }

            const tool   = obj.tool || '';
            const params = (typeof obj.params === 'object' && obj.params) ? obj.params : {};

            if (tool === 'execute') {
                const actionName = obj.action || '';
                track('tool', { tool: actionName });
                // 💬 وضع المحادثة: لا تنفيذ إطلاقاً — حجب محايد بلا ذكر أدوات/نظام
                if (chatMode) {
                    const result = _err('هذا النوع من الإجراءات غير متاح هنا — أكمل بالحوار فقط.');
                    allResults.push(`[TOOL_RESULT: ${actionName}]\n${JSON.stringify(result, null, 2)}`);
                    continue;
                }
                const { allowed, reason } = executeAllowedForAccess(actionName, accessLevel, params);
                let result;
                if (!allowed) {
                    result = _err(reason);
                } else {
                    result = await executeAction(guild, channel, actionName, params, client);
                    
                    // ── إرسال المرفقات إذا وجدت (للصور والوسائط) ─ـ
                    if (result && result.__attachments && Array.isArray(result.__attachments)) {
                        await _sendAttachments(channel, result.__attachments);
                    }
                }
                allResults.push(`[TOOL_RESULT: ${actionName}]\n${JSON.stringify(result, null, 2)}`);
                continue;
            }

            const readTools = [
                'get_channels', 'get_categories', 'get_roles', 'get_members', 'server_info', 'list_all_guilds',
                'get_messages', 'get_audit_log', 'get_invites', 'get_emojis', 'get_stickers', 'get_bans',
                'get_pinned_messages', 'get_voice_states', 'search_messages',
                'moderation_overview', 'recent_joins', 'inactive_members', 'role_members', 'channel_permissions',
                'get_webhooks', 'get_scheduled_events', 'get_threads', 'get_nitro_boosters',
                'get_bot_list', 'get_member_info', 'get_bot_commands', 'analyze_bot',
                'server_blueprint', 'permission_audit', 'channel_activity', 'agent_config_audit',
                // الأدوات الجديدة (مرفقات)
                'get_server_icon', 'get_server_banner', 'send_image',
                // 🌐 حواس خارج ديسكورد — قراءة الروابط فقط (البحث للنموذج نفسه)
                'read_url',
                // 📁 إنشاء ملفات وإرفاقها في القناة
                'create_file',
                // 🎨 توليد الصور (مدعوم مع مزود Qwen)
                'generate_image',
                // 🧠 الذاكرة طويلة المدى (مخصصة لمستخدم الطلب فقط)
                'remember', 'recall', 'forget_memory',
                // ⏰ التذكيرات (مخصصة لمستخدم الطلب فقط)
                'set_reminder', 'list_reminders', 'cancel_reminder',
                // 📚 قاعدة المعرفة RAG (أدمن/مالك فقط)
                'search_knowledge', 'list_knowledge',
            ];

            if (readTools.includes(tool)) {
                // 💬 وضع المحادثة: القائمة البيضاء فقط — كل ما عداها محجوب محايد
                if (chatMode && !CHAT_MODE_TOOLS.includes(tool)) {
                    const result = _err('هذه الأداة غير متاحة في هذا الوكيل — أكمل بالحوار فقط.');
                    allResults.push(`[TOOL_RESULT: ${tool}]\n${JSON.stringify(result)}`);
                    continue;
                }
                if (!toolAllowedForAccess(tool, accessLevel)) {
                    // رسالة محايدة للنموذج — لا ذكر للصلاحيات أو المستويات
                    const result = _err('هذه الأداة غير متاحة في المحادثة العادية.');
                    allResults.push(`[TOOL_RESULT: ${tool}]\n${JSON.stringify(result)}`);
                    continue;
                }

                let targetGuild = guild;
                if (params.target_guild) {
                    if (accessLevel !== 'owner') {
                        const result = _err('⛔ الأدمن يستطيع قراءة السيرفر الحالي فقط.');
                        allResults.push(`[TOOL_RESULT: ${tool}]\n${JSON.stringify(result)}`);
                        continue;
                    }
                    const foundG = await findGuild(client, String(params.target_guild));
                    if (foundG) {
                        targetGuild = foundG;
                    } else {
                        const result = _err(`ما لقيت سيرفر: ${params.target_guild}`);
                        allResults.push(`[TOOL_RESULT: ${tool}]\n${JSON.stringify(result)}`);
                        continue;
                    }
                }

                let result;
                try {
                    const getTargetCh = async () => {
                        if (params.channel) {
                            const found = await findChannel(targetGuild, String(params.channel));
                            if (found && isTextChannel(found)) return found;
                        }
                        return channel;
                    };

                    switch (tool) {
                        case 'get_channels':
                            result = toolGetChannels(targetGuild); break;
                        case 'get_categories':
                            result = toolGetCategories(targetGuild); break;
                        case 'get_roles':
                            result = toolGetRoles(targetGuild); break;
                        case 'get_members':
                            result = await toolGetMembers(targetGuild, params.query || null, params); break;
                        case 'server_info':
                            result = toolServerInfo(targetGuild); break;
                        case 'list_all_guilds':
                            result = toolListAllGuilds(client); break;
                        case 'get_messages':
                            result = await toolGetMessages(await getTargetCh(), Number(params.limit || 100), params.member_id || null); break;
                        case 'get_audit_log':
                            result = await toolGetAuditLog(targetGuild, Number(params.limit || 20), params.action || null); break;
                        case 'get_invites':
                            result = await toolGetInvites(targetGuild); break;
                        case 'get_emojis':
                            result = toolGetEmojis(targetGuild); break;
                        case 'get_stickers':
                            result = toolGetStickers(targetGuild); break;
                        case 'get_bans':
                            result = await toolGetBans(targetGuild, Number(params.limit || 100)); break;
                        case 'get_pinned_messages':
                            result = await toolGetPinnedMessages(await getTargetCh()); break;
                        case 'get_voice_states':
                            result = toolGetVoiceStates(targetGuild); break;
                        case 'search_messages':
                            result = await toolSearchMessages(await getTargetCh(), params.query || '', Number(params.limit || 200)); break;
                        case 'moderation_overview':
                            result = toolModerationOverview(targetGuild, client); break;
                        case 'recent_joins':
                            result = toolRecentJoins(targetGuild, Number(params.limit || 20)); break;
                        case 'inactive_members':
                            result = toolInactiveMembers(targetGuild, Number(params.days || 30), Number(params.limit || 50)); break;
                        case 'role_members':
                            result = await toolRoleMembers(targetGuild, params.role || '', Number(params.limit || 100)); break;
                        case 'channel_permissions':
                            result = toolChannelPermissions(targetGuild, params.channel || null); break;
                        case 'get_webhooks':
                            result = await toolGetWebhooks(targetGuild); break;
                        case 'get_scheduled_events':
                            result = await toolGetScheduledEvents(targetGuild); break;
                        case 'get_threads':
                            result = await toolGetThreads(targetGuild, params.channel || null); break;
                        case 'get_nitro_boosters':
                            result = toolGetNitroBoosters(targetGuild); break;
                        case 'get_bot_list':
                            result = toolGetBotList(targetGuild); break;
                        case 'get_member_info':
                            result = await toolGetMemberInfo(targetGuild, String(params.member || '')); break;
                        case 'get_bot_commands':
                            result = await toolGetBotCommands(targetGuild, String(params.bot || params.bot_id || ''), await getTargetCh(), Number(params.limit || 300)); break;
                        case 'analyze_bot':
                            result = await toolAnalyzeBot(targetGuild, String(params.bot || params.bot_id || ''), await getTargetCh()); break;
                        case 'server_blueprint':
                            result = toolServerBlueprint(targetGuild); break;
                        case 'permission_audit':
                            result = toolPermissionAudit(targetGuild); break;
                        case 'channel_activity':
                            result = await toolChannelActivity(targetGuild, Number(params.limit_per_channel || 50)); break;
                        case 'agent_config_audit':
                            result = await toolAgentConfigAudit(targetGuild, runtime.agentId || 'default'); break;

                        // ═══════════════════════════════════════════
                        //  🌐 قراءة الروابط — عبر webTools (ليست بحثاً؛
                        //  البحث مسؤولية النموذج نفسه عبر قدراته)
                        // ═══════════════════════════════════════════
                        case 'read_url': {
                            if (!readUrlEnabled) {
                                result = _err('🌐 أداة قراءة صفحات الويب معطّلة من إعدادات هذا الوكيل — أخبر المستخدم أن يمكّنها من إعدادات الوكيل (الميزات).');
                                break;
                            }
                            const u = String(params.url || params.link || '').trim();
                            if (!u) {
                                result = _err('حدد الرابط: {"url": "https://..."}');
                            } else {
                                const r = await webTools.readUrl({ url: u });
                                result = r.ok
                                    ? { ok: true, url: r.url, title: r.title || undefined, type: r.type, content: r.content, truncated: r.truncated || false }
                                    : _err(r.error || 'فشل جلب الصفحة');
                                track('web');
                            }
                            break;
                        }

                        // ═══════════════════════════════════════════
                        //  📁 إنشاء ملف وإرفاقه في القناة — يصل مع الرد النهائي
                        //  (الأسماء البديلة القديمة file / tool=file ما زالت مدعومة)
                        // ═══════════════════════════════════════════
                        case 'create_file': {
                            const fname = String(params.filename || params.name || params.file_name || '').trim();
                            const body = params.content ?? params.text ?? params.data;
                            if (!fname || body === undefined || body === null || String(body) === '') {
                                result = _err('حدد اسم الملف ومحتواه: {"filename": "report.txt", "content": "نص الملف الكامل"}');
                                break;
                            }
                            const safeName = (path.basename(fname).replace(/[^\w.\-\u0600-\u06FF ()]/g, '_').slice(0, 100)) || 'file.txt';
                            const bytes = Buffer.byteLength(String(body), 'utf8');
                            if (bytes > 8 * 1024 * 1024) {
                                result = _err(`المحتوى أكبر من 8MB (${bytes} بايت) — قسّمه على عدة ملفات أصغر.`);
                                break;
                            }
                            try {
                                const tmpPath = path.join(os.tmpdir(), `disor_file_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeName}`);
                                fs.writeFileSync(tmpPath, String(body), 'utf8');
                                filesToSend.push(tmpPath);
                                result = {
                                    ok: true,
                                    filename: safeName,
                                    bytes,
                                    note: 'سيُرفق الملف تلقائياً مع ردك النهائي — لا تقل للمستخدم أن الملف أُرسل قبل أن تكتب الرد النهائي فعلاً.',
                                };
                            } catch (e) {
                                result = _err(`فشل إنشاء الملف: ${String(e.message).slice(0, 200)}`);
                            }
                            break;
                        }

                        // ═══════════════════════════════════════════
                        //  🎨 توليد الصور — يدعمه مزود Qwen حالياً
                        //  (chat_type=t2i عبر chat.qwen.ai)
                        // ═══════════════════════════════════════════
                        case 'generate_image': {
                            const gp = String(params.prompt || params.description || params.text || params.q || '').trim();
                            if (!gp) {
                                result = _err('حدد وصف الصورة: {"prompt": "وصف مفصل للصورة"}');
                                break;
                            }
                            if (typeof activeProvider.obj.generateImage !== 'function') {
                                result = _err(`🎨 مزود ${activeProvider.obj.label} لا يدعم توليد الصور — متاح مع مزود Qwen حالياً. أخبر المستخدم بتبديل مزود الوكيل أو وصف الصورة نصياً.`);
                                break;
                            }
                            try {
                                const r = await activeProvider.obj.generateImage({
                                    prompt : gp,
                                    size   : String(params.size || '1:1'),
                                    config : activeProvider.config,
                                    agentId: runtime.agentId || 'default',
                                });
                                if (!r || !r.ok || !Array.isArray(r.urls) || !r.urls.length) {
                                    result = _err((r && r.error) || 'لم يتم توليد أي صورة — حاول مجدداً بوصف أوضح');
                                    break;
                                }
                                // نحاول تنزيل أول صورة وإرسالها كملف؛ عند الفشل نعيد الرابط للنموذج
                                let savedPath = null;
                                try { savedPath = await _downloadToTmp(r.urls[0]); } catch (_) {}
                                if (savedPath) {
                                    filesToSend.push(savedPath);
                                    result = { ok: true, count: r.urls.length, urls: r.urls, sent: true };
                                } else {
                                    result = { ok: true, count: r.urls.length, urls: r.urls, sent: false, note: 'لم يكتمل التنزيل — شارك الرابط مع المستخدم نصياً' };
                                }
                            } catch (e) {
                                result = _err(`فشل توليد الصورة: ${String(e.message).slice(0, 200)}`);
                            }
                            break;
                        }

                        // ═══════════════════════════════════════════
                        //  📚 قاعدة المعرفة RAG — مستندات الوكيل الخاصة
                        //  للأدمن/المالك فقط (ليست في MEMBER_SAFE_TOOLS)
                        // ═══════════════════════════════════════════
                        case 'search_knowledge': {
                            const q = String(params.query || params.q || '').trim();
                            if (!q) {
                                result = _err('حدد الاستعلام: {"query": "..."} — واختيارياً {"source": "اسم الملف"}');
                            } else {
                                const r = await knowledge.searchKnowledge({
                                    agentId : runtime.agentId || 'default',
                                    query   : q,
                                    limit   : Number(params.limit || 6),
                                    source  : params.source ? String(params.source) : null,
                                });
                                result = r.ok
                                    ? { ok: true, count: r.results.length, results: r.results.map(x => ({ source: x.source, chunk: x.chunk_index, content: x.content })) }
                                    : _err(r.error || 'فشل البحث في المعرفة');
                                if (r.ok) track('knowledge');
                            }
                            break;
                        }
                        case 'list_knowledge': {
                            const srcs = await knowledge.listSources(runtime.agentId || 'default');
                            result = { ok: true, count: srcs.length, sources: srcs };
                            break;
                        }

                        // ═══════════════════════════════════════════
                        //  🧠 الذاكرة — مخصصة لمستخدم الطلب نفسه
                        // ═══════════════════════════════════════════
                        case 'remember': {
                            const content = String(params.content || params.text || params.fact || '').trim();
                            if (!content) {
                                result = _err('حدد ما تريد حفظه: {"content": "..."}');
                            } else if (!requester.userId) {
                                result = _err('لا يمكن تحديد هوية المستخدم هنا');
                            } else {
                                result = await memory.rememberFact({
                                    agentId : runtime.agentId || 'default',
                                    guildId,
                                    userId  : requester.userId,
                                    content,
                                    kind    : String(params.kind || 'fact'),
                                    tags    : Array.isArray(params.tags) ? params.tags : [],
                                });
                            }
                            break;
                        }
                        case 'recall': {
                            if (!requester.userId) {
                                result = _err('لا يمكن تحديد هوية المستخدم هنا');
                            } else {
                                const r = await memory.recallFacts({
                                    agentId : runtime.agentId || 'default',
                                    userId  : requester.userId,
                                    query   : String(params.query || params.q || ''),
                                    limit   : Number(params.limit || 8),
                                });
                                result = r.ok
                                    ? { ok: true, count: r.results.length, memories: r.results.map(m => ({ id: m.id, content: m.content, kind: m.kind })) }
                                    : _err(r.error || 'فشل استدعاء الذكريات');
                            }
                            break;
                        }
                        case 'forget_memory': {
                            if (!requester.userId) {
                                result = _err('لا يمكن تحديد هوية المستخدم هنا');
                            } else {
                                result = await memory.forgetFacts({
                                    agentId : runtime.agentId || 'default',
                                    userId  : requester.userId, // النسيان محصور بذكريات المستخدم نفسه — دائماً
                                    id      : params.id ? String(params.id) : null,
                                    query   : String(params.query || ''),
                                    all     : Boolean(params.all),
                                });
                            }
                            break;
                        }

                        // ═══════════════════════════════════════════
                        //  ⏰ التذكيرات — مخصصة لمستخدم الطلب نفسه
                        // ═══════════════════════════════════════════
                        case 'set_reminder': {
                            if (!requester.userId || !requester.channelId) {
                                result = _err('لا يمكن تحديد هوية المستخدم أو القناة هنا');
                            } else {
                                result = await reminders.createReminder({
                                    agentId  : runtime.agentId || 'default',
                                    guildId,
                                    channelId: requester.channelId,
                                    userId   : requester.userId,
                                    username : requester.username || '',
                                    text     : String(params.text || params.content || params.message || ''),
                                    when     : {
                                        in_minutes  : params.in_minutes ?? params.minutes ?? undefined,
                                        at_iso      : params.at_iso ?? params.at ?? undefined,
                                        daily_hhmm  : params.daily_hhmm ?? params.daily ?? undefined,
                                        weekly_day  : params.weekly_day ?? params.weekday ?? undefined,
                                        weekly_hhmm : params.weekly_hhmm ?? undefined,
                                    },
                                });
                            }
                            break;
                        }
                        case 'list_reminders': {
                            if (!requester.userId) {
                                result = _err('لا يمكن تحديد هوية المستخدم هنا');
                            } else {
                                result = await reminders.listReminders({ agentId: runtime.agentId || 'default', userId: requester.userId });
                            }
                            break;
                        }
                        case 'cancel_reminder': {
                            if (!requester.userId) {
                                result = _err('لا يمكن تحديد هوية المستخدم هنا');
                            } else if (!params.id) {
                                result = _err('حدد معرف التذكير من list_reminders: {"id": "..."}');
                            } else {
                                result = await reminders.cancelReminder({ agentId: runtime.agentId || 'default', userId: requester.userId, id: String(params.id) });
                            }
                            break;
                        }
                        // الأدوات الجديدة
                        case 'get_server_icon':
                        case 'get_server_banner':
                        case 'send_image':
                            result = await executeAction(targetGuild, channel, tool, params, client);
                            // إرسال المرفقات فوراً
                            if (result && result.__attachments && Array.isArray(result.__attachments)) {
                                await _sendAttachments(channel, result.__attachments);
                            }
                            break;
                        default:
                            result = _err(`أداة غير مُنفَّذة: ${tool}`);
                    }
                } catch (e) {
                    console.error(`[Tool error] ${tool}:`, e);
                    result = _err(`❌ خطأ في تنفيذ الأداة ${tool}: ${String(e.message).slice(0, 200)}`);
                }

                // 📊 تتبع استدعاء الأداة
                track('tool', { tool });

                allResults.push(`[TOOL_RESULT: ${tool}]\n${JSON.stringify(result, null, 2)}`);
                continue;
            }

            allResults.push(`[UNKNOWN_TOOL: ${tool}]`);
        }

        if (finalReplyText) {
            return {
                reply      : finalReplyText,
                newSid     : curSid,
                newPmid    : curPmid,
                filesToSend: filesToSend,
            };
        }

        if (!allResults.length) {
            // Guard ذكي: يتحقق من سياق الطلب قبل تفعيل كشف الكذب
            if (shouldTriggerFalseSuccessGuard(raw, userMsg) && falseSuccessCount <= MAX_FALSE_SUCCESS_ATTEMPTS) {
                falseSuccessCount++;
                curPrompt = chatMode
                    ? `لاحظت أنك كتبت رداً يوحي بأنك فعلت شيئاً أو حصلت على معلومة، لكنك لم تستدعِ أي أداة فعلياً. ` +
                      `إذا كنت تحتاج معلومة فاستدعِ الأداة المناسبة فوراً عبر \`\`\`json، وإلا فأجب نصاً بحوار طبيعي. لا تدّعِ شيئاً لم يحدث.`
                    : `لاحظت أنك كتبت رداً يوحي بتنفيذ إجراء إداري (تغيير/حذف/إنشاء) لكنك لم تستدعِ أي أداة فعلياً. ` +
                      `أنت لا تملك أي قدرة على تنفيذ أي شيء إداري بدون استدعاء أداة execute أو أداة قراءة أولاً. ` +
                      `أعد المحاولة الآن: استدعِ الأداة المناسبة عبر \`\`\`json فوراً. لا ترد نصياً بأنك نفذت شيئاً لم تنفذه.`;
                continue;
            }

            return {
                reply      : raw,
                newSid     : curSid,
                newPmid    : curPmid,
                filesToSend: filesToSend,
            };
        }

        const combined = allResults.join('\n');
        curPrompt      = `نتائج الأوامر:\n${combined}\n\nاستمر في التنفيذ أو قدم الرد النهائي.`;
    }

    return {
        reply      : '⚠️ وصلت للحد الأعلى من خطوات الأدوات. نفذت ما استطعت، وإذا بقي جزء من الطلب أعد إرساله لأكمل من آخر نتيجة.',
        newSid     : curSid,
        newPmid    : curPmid,
        filesToSend: [],
    };
}

module.exports = {
    extractJsonObjects,
    runAgent,
    CHAT_MODE_TOOLS,
};