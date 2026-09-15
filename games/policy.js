/**
 * games/policy.js — سياسة الألعاب العامة (v7.14)
 * ═══════════════════════════════════════════════════════════
 * نقل حرفي لمنطق gamePolicyService من مستودع Auto مع تكييف
 * طبقة التخزين: mongoose → mongo driver عبر config.game_policy_col.
 *
 * ماذا تحمي السياسة؟ (كما في Auto بالضبط)
 *  - السيرفرات المسموحة (عام / لكل محرك / لتعيينات الوكيل)
 *  - البوتات المسموحة لكل محرك (فلتر بوتات قابل للطفية)
 *  - أقفال التداخل: لا حسابان يلعبان نفس اللعبة في نفس السيرفر
 *
 * الهوية هنا agentId بدل token (في منصتنا الوكيل هو الحساب).
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

const { getEngines } = require('./engines');

const DEFAULT_KEY = 'default';
const activeLocks = new Map(); // key → lock (كما في Auto — ذاكرة عملية)

function mapToObject(value) {
    if (!value) return {};
    if (value instanceof Map) return Object.fromEntries(value);
    return { ...value };
}

function uniqueList(items) {
    return [...new Set((Array.isArray(items) ? items : String(items || '').split(/[\s,\n]+/))
        .map(item => String(item || '').trim())
        .filter(Boolean))];
}

function defaultBotFilters(value) {
    return getEngines().reduce((filters, engine) => {
        // انحراف موثق عن Auto: الفلتر الافتراضي معطل — في Auto الحسابات مكرّسة
        // للألعاب ويجب إدراج بوتاتها أولاً، أما وكلاؤنا فيشاركون المحادثة
        // والمالك يريد «اكتب -مافيا فيلعب فوراً» دون تهيئة معرفات البوتات.
        // التشديد متاح من اللوحة (فلتر لكل محرك + قائمة بوتات مسموحة).
        filters[engine.id] = value && value[engine.id] !== undefined ? Boolean(value[engine.id]) : false;
        return filters;
    }, {});
}

function normalize(doc) {
    const base = doc || {};
    return {
        key               : base.key || DEFAULT_KEY,
        overlapLockEnabled: Boolean(base.overlapLockEnabled),
        engineOverlapLocks: mapToObject(base.engineOverlapLocks),
        allowedServers    : uniqueList(base.allowedServers || []),
        engineAllowedServers: mapToObject(base.engineAllowedServers),
        engineAllowedBots : mapToObject(base.engineAllowedBots),
        engineBotFilters  : defaultBotFilters(base.engineBotFilters),
        updatedAt         : base.updatedAt,
    };
}

async function ensureCol() {
    const cfg = require('../config');
    if (!cfg.game_policy_col) throw new Error('game_policy_col غير متصلة — MongoDB غير مهيأ');
    return cfg.game_policy_col;
}

async function getPolicy() {
    const col = await ensureCol();
    const doc = await col.findOneAndUpdate(
        { key: DEFAULT_KEY },
        { $setOnInsert: { key: DEFAULT_KEY, engineBotFilters: defaultBotFilters({}), updatedAt: new Date() } },
        { returnDocument: 'after', upsert: true },
    );
    return normalize(doc);
}

async function setOverlapLock(enabled, engineId) {
    const col = await ensureCol();
    const $set = { updatedAt: new Date() };
    if (engineId) $set[`engineOverlapLocks.${engineId}`] = Boolean(enabled);
    else $set.overlapLockEnabled = Boolean(enabled);
    const doc = await col.findOneAndUpdate({ key: DEFAULT_KEY }, { $set }, { returnDocument: 'after', upsert: true });
    return normalize(doc);
}

async function setAllowedServers(scope, ids, engineId) {
    const col = await ensureCol();
    const $set = { updatedAt: new Date() };
    if (scope === 'general') $set.allowedServers = uniqueList(ids);
    else if (scope === 'engine') $set[`engineAllowedServers.${engineId}`] = uniqueList(ids);
    else throw new Error('نطاق سيرفرات غير مدعوم');
    const doc = await col.findOneAndUpdate({ key: DEFAULT_KEY }, { $set }, { returnDocument: 'after', upsert: true });
    return normalize(doc);
}

async function setAllowedBots(engineId, ids) {
    const col = await ensureCol();
    const doc = await col.findOneAndUpdate(
        { key: DEFAULT_KEY },
        { $set: { [`engineAllowedBots.${engineId}`]: uniqueList(ids), updatedAt: new Date() } },
        { returnDocument: 'after', upsert: true },
    );
    return normalize(doc);
}

function isBotFilterEnabled(policy, engineId) {
    const value = policy.engineBotFilters && policy.engineBotFilters[engineId];
    return value === undefined ? true : Boolean(value);
}

async function setBotFilterEnabled(engineId, enabled) {
    const col = await ensureCol();
    const doc = await col.findOneAndUpdate(
        { key: DEFAULT_KEY },
        { $set: { [`engineBotFilters.${engineId}`]: Boolean(enabled), updatedAt: new Date() } },
        { returnDocument: 'after', upsert: true },
    );
    return normalize(doc);
}

async function toggleBotFilter(engineId) {
    const policy = await getPolicy();
    const next = !isBotFilterEnabled(policy, engineId);
    const updated = await setBotFilterEnabled(engineId, next);
    return { policy: updated, enabled: next };
}

function getEngineList(map, engineId) {
    const item = map && map[engineId];
    return uniqueList(item || []);
}

/** أولوية القائمة كما في Auto: تعيين الوكيل ← محرك ← عام — فارغة = كله مسموح */
function serverListFor(policy, accountAssignments, engineId) {
    const agentList = uniqueList(accountAssignments || []);
    if (agentList.length > 0) return agentList;
    const engineList = getEngineList(policy.engineAllowedServers, engineId);
    if (engineList.length > 0) return engineList;
    return uniqueList(policy.allowedServers || []);
}

function isServerAllowed(policy, agentServers, engineId, serverId) {
    const list = serverListFor(policy, agentServers, engineId);
    if (list.length === 0) return true;
    return Boolean(serverId && list.includes(String(serverId)));
}

function isBotAllowed(policy, engineId, botId) {
    if (!isBotFilterEnabled(policy, engineId)) return true;
    const list = getEngineList(policy.engineAllowedBots, engineId);
    if (list.length === 0) return false;
    return Boolean(botId && list.includes(String(botId)));
}

function isOverlapLockEnabled(policy, engineId) {
    const engineValue = policy.engineOverlapLocks && policy.engineOverlapLocks[engineId];
    if (engineValue !== undefined) return Boolean(engineValue);
    return Boolean(policy.overlapLockEnabled);
}

function lockKey(engineId, serverId, gameName) {
    return `${engineId}:${serverId || 'unknown'}:${gameName || engineId}`;
}

/** نفس منطق Auto: نفس الحساب يعيد القفل، حساب آخر يُرفض */
function acquireLock({ policy, engineId, serverId, gameName, agentId, agentName }) {
    if (!isOverlapLockEnabled(policy, engineId)) return { acquired: true, locked: false };
    const key = lockKey(engineId, serverId, gameName);
    const existing = activeLocks.get(key);
    if (existing && existing.agentId !== agentId) return { acquired: false, locked: true, owner: existing, key };
    const lock = { key, engineId, serverId, gameName, agentId, agentName, acquiredAt: new Date() };
    activeLocks.set(key, lock);
    return { acquired: true, locked: true, owner: lock, key };
}

function releaseLock(key, agentId) {
    const lock = activeLocks.get(key);
    if (!lock || (agentId && lock.agentId !== agentId)) return false;
    activeLocks.delete(key);
    return true;
}

function releaseLocksForAgent(agentId, engineId) {
    let released = 0;
    for (const [key, lock] of activeLocks.entries()) {
        if (lock.agentId === agentId && (!engineId || lock.engineId === engineId)) {
            activeLocks.delete(key);
            released += 1;
        }
    }
    return released;
}

function releaseLockFromEvent(event) {
    const key = lockKey(event.engineId, event.serverId, event.gameName);
    const lock = activeLocks.get(key);
    if (lock && lock.agentId === event.agentId) {
        activeLocks.delete(key);
        return true;
    }
    return false;
}

function getLocks() {
    return [...activeLocks.values()];
}

function clearLocks(engineId) {
    let cleared = 0;
    for (const [key, lock] of activeLocks.entries()) {
        if (!engineId || lock.engineId === engineId) {
            activeLocks.delete(key);
            cleared += 1;
        }
    }
    return cleared;
}

/**
 * 🩺 v7.20 — سياسة افتراضية آمنة (fail-open مرئي):
 * كان player.js يستدعي getPolicy() داخل try المعالج — إذا تعطلت القاعدة
 * كان الخطأ يُبتلع فيُتخطى **كل** معالجات **كل** الألعاب بصمت تام
 * (بلاغ المالك الحرفي: «أصبح لا يدخل اي لعبة اصلا»). الآن عند تعطل
 * المتجر نُعيد سياسة متسامحة (كل الفلاتر مفتوحة — نفس الافتراضي)
 * بدل حجب اللعب كله، والتشخيص يُعلن التعطل مرئياً.
 */
function defaultPolicy() {
    return normalize({ key: DEFAULT_KEY, updatedAt: new Date() });
}

module.exports = {
    getPolicy,
    defaultPolicy,
    setOverlapLock,
    setAllowedServers,
    setAllowedBots,
    setBotFilterEnabled,
    toggleBotFilter,
    uniqueList,
    serverListFor,
    isServerAllowed,
    isBotAllowed,
    isBotFilterEnabled,
    isOverlapLockEnabled,
    acquireLock,
    releaseLock,
    releaseLocksForAgent,
    releaseLockFromEvent,
    getLocks,
    clearLocks,
};
