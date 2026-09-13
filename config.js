/**
 * config.js — Disor Bot v7.0 "Ironclad"
 * ═══════════════════════════════════════════════════════════
 * إعدادات البيئة، اتصال MongoDB، وكائنات الذاكرة المؤقتة (RAM Cache)
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

// ⚠️ أول require — حقن webcrypto للبيئات القديمة (Node < 19)
// درايفر mongodb 7.x يستخدم globalThis.crypto مباشرة وينهار بدونه
require('./polyfills');

const dotenv = require('dotenv');
dotenv.config();

// ══════════════════════════════════════════════════════════════
//  ENV — متغيرات البيئة
// ══════════════════════════════════════════════════════════════
const MONGODB_URI        = process.env.MONGODB_URI;
const DISCORD_TOKEN      = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || process.env.TOKEN;
const USER_TOKEN         = process.env.USER_TOKEN;
const DEEPSEEK_TOKEN     = process.env.DEEPSEEK_TOKEN;

const BOT_OWNER_ID       = BigInt(process.env.BOT_OWNER_ID || '656783724662226963');
const CONTROL_ROLE_NAME  = process.env.CONTROL_ROLE || '';

const RAILWAY_URL          = process.env.RAILWAY_URL        || 'https://pow.up.railway.app';
const POW_PROXY_TELEGRAM   = process.env.POW_PROXY_TELEGRAM || 'https://immunize-quintet-trimmer.ngrok-free.dev';
const DEFAULT_POW_PROVIDER = process.env.DEFAULT_POW_PROVIDER || 'railway';

// أقصى عدد قنوات نشطة لكل سيرفر
const MAX_CHANNELS_PER_GUILD = 5;

// ══════════════════════════════════════════════════════════════
//  Attachment Handling — إعدادات معالجة المرفقات
// ══════════════════════════════════════════════════════════════
const MAX_ATTACHMENT_BYTES = 1_000_000; // 1 ميغابايت

/** امتدادات الملفات النصية المدعومة */
const TEXT_EXTENSIONS = new Set([
    '.py', '.js', '.ts', '.html', '.css', '.json', '.txt', '.md',
    '.sql', '.java', '.c', '.cpp', '.rb', '.go', '.rs', '.swift',
    '.kt', '.php', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.sh',
    '.bat', '.ps1', '.log', '.csv', '.tsv', '.r', '.lua', '.pl',
    '.scala', '.dart', '.jsx', '.tsx', '.tf', '.bicep', '.cmake',
    '.graphql', '.gql', '.proto', '.prisma', '.razor', '.blade',
    '.twig', '.liquid', '.haml', '.pug', '.mustache', '.handlebars',
    '.ejs', '.njk', '.styl', '.less', '.scss', '.sass', '.coffee',
    '.dockerignore', '.editorconfig', '.eslintrc', '.prettierrc',
    '.babelrc', '.npmrc', '.yarnrc', '.bazel', '.toml', '.lock',
    '.env', '.gitignore', '.dockerfile', '.makefile', '.ipynb',
    '.vue', '.svelte', '.astro', '.elm', '.ex', '.exs', '.erl',
    '.clj', '.fs', '.fsx', '.hrl', '.rpy', '.gd',
]);

/** أنواع المحتوى النصي المدعومة */
const TEXT_CONTENT_TYPES = new Set([
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
]);

// ══════════════════════════════════════════════════════════════
//  MongoDB — اتصال قاعدة البيانات
// ══════════════════════════════════════════════════════════════
const { MongoClient } = require('mongodb');

const mongoClient = MONGODB_URI ? new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
}) : null;

// متغيرات المجموعات — سيتم تعيينها بعد الاتصال
let db           = null;
let sessions_col = null; // جلسات القنوات (per-channel)
let settings_col = null; // إعدادات السيرفر
let channels_col = null; // القنوات المسموحة
let agents_col   = null; // إعدادات الوكلاء
let logs_col     = null; // سجلات الوكلاء
let memories_col = null; // 🧠 الذاكرة طويلة المدى للوكلاء
let reminders_col = null; // ⏰ تذكيرات الوكلاء
let knowledge_col = null; // 📚 قاعدة المعرفة (المستوى 2)
let usage_col = null; // 📊 تتبع استخدام الوكلاء (المستوى 2)
let providers_col = null; // 🗄️ المزودون المحفوظون (2.5 — إضافة مزود مرة واحدة واختياره عند إنشاء الوكلاء)

/**
 * يقوم بالاتصال بـ MongoDB وتهيئة المتغيرات
 */
async function connectMongo() {
    try {
        if (!mongoClient) throw new Error('MONGODB_URI not set');
        await mongoClient.connect();
        db           = mongoClient.db('disor_db');
        sessions_col = db.collection('chat_sessions');
        settings_col = db.collection('settings');
        channels_col = db.collection('allowed_channels');
        agents_col   = db.collection('agents');
        logs_col     = db.collection('agent_logs');
        memories_col = db.collection('agent_memories');
        reminders_col = db.collection('agent_reminders');
        knowledge_col = db.collection('agent_knowledge');
        usage_col = db.collection('agent_usage');
        providers_col = db.collection('ai_providers');
        console.log('✅ MongoDB متصل بنجاح');
    } catch (err) {
        console.error('❌ فشل الاتصال بـ MongoDB:', err.message);
        throw err;
    }
}

// ══════════════════════════════════════════════════════════════
//  RAM Cache — ذاكرة التخزين المؤقت
// ══════════════════════════════════════════════════════════════

/**
 * جلسات القنوات في الذاكرة
 * المفتاح: `${guild_id}_${channel_id}`
 * القيمة: { session_id, parent_message_id, mode, thinking }
 * @type {Map<string, {session_id: string|null, parent_message_id: string|null, mode: string, thinking: boolean}>}
 */
const channel_sessions = new Map();

/**
 * كاش القنوات المسموحة
 * المفتاح: guild_id (string)
 * القيمة: مصفوفة من channel_ids (strings)
 * @type {Map<string, string[]>}
 */
const allowed_channels_cache = new Map();

// ══════════════════════════════════════════════════════════════
//  Session Lock — قفل غير متزامن بسيط
// ══════════════════════════════════════════════════════════════

/**
 * قفل بسيط لمنع التعارض عند الوصول المتزامن لجلسات القنوات
 * يعمل كـ queue من الوعود (Promises)
 */
class SimpleLock {
    constructor() {
        this._queue = Promise.resolve();
    }

    /**
     * ينفّذ دالة داخل القفل (متسلسلة وليست متزامنة)
     * @param {Function} fn - الدالة المراد تنفيذها داخل القفل
     * @returns {Promise<any>}
     */
    async acquire(fn) {
        const result = this._queue.then(() => fn());
        // نجدد الـ queue بحيث لا تنكسر عند خطأ
        this._queue = result.catch(() => {});
        return result;
    }
}

const sessionLock = new SimpleLock();

// ══════════════════════════════════════════════════════════════
//  Exports — تصدير جميع الثوابت والمتغيرات
// ══════════════════════════════════════════════════════════════
module.exports = {
    // ENV
    MONGODB_URI,
    DISCORD_TOKEN,
    USER_TOKEN,
    DEEPSEEK_TOKEN,
    BOT_OWNER_ID,
    CONTROL_ROLE_NAME,
    RAILWAY_URL,
    POW_PROXY_TELEGRAM,
    DEFAULT_POW_PROVIDER,

    // Constants
    MAX_CHANNELS_PER_GUILD,
    MAX_ATTACHMENT_BYTES,
    TEXT_EXTENSIONS,
    TEXT_CONTENT_TYPES,

    // MongoDB
    mongoClient,
    connectMongo,
    get db()           { return db; },
    get sessions_col() { return sessions_col; },
    get settings_col() { return settings_col; },
    get channels_col() { return channels_col; },
    get agents_col()   { return agents_col; },
    get logs_col()     { return logs_col; },
    get memories_col() { return memories_col; },
    get reminders_col() { return reminders_col; },
    get knowledge_col() { return knowledge_col; },
    get usage_col() { return usage_col; },
    get providers_col() { return providers_col; },

    // RAM Cache
    channel_sessions,
    allowed_channels_cache,

    // Lock
    sessionLock,
    SimpleLock,
};