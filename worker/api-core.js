/* ============================================================
   神人榜 · API 核心逻辑（Cloudflare D1）
   被两个入口共用：
     - worker/index.js               Workers + 静态资源
     - functions/api/[[path]].js     Pages Functions（备选方案）

   GET  /api/entries            公开：已通过审核的记录
   POST /api/entries            公开：提交（需班级暗号）
   POST /api/admin/login        校验管理员口令
   GET  /api/admin/entries      管理员：按状态取记录
   POST /api/admin/action       管理员：通过 / 驳回 / 删除
   ============================================================ */

const RATE_WINDOW_MS = 30 * 1000;

// 分类标签：四班 / 其他班 / 老师
const CATEGORIES = ["四班", "其他班", "老师"];
const DEFAULT_CATEGORY = "四班";

function normalizeCategory(value) {
  const c = String(value == null ? "" : value).trim();
  return CATEGORIES.includes(c) ? c : DEFAULT_CATEGORY;
}

// 首次打开 /api/setup 时执行，自动建表；可重复执行，不会影响已有数据
const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, name TEXT NOT NULL, author TEXT NOT NULL, deeds TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, reviewed_at INTEGER, ip_hash TEXT, category TEXT NOT NULL DEFAULT '四班')",
  "CREATE INDEX IF NOT EXISTS idx_entries_status ON entries (status, created_at DESC)",
  "CREATE TABLE IF NOT EXISTS rate (ip TEXT PRIMARY KEY, at INTEGER NOT NULL)"
];

export async function handleApi(request, env) {
  try {
    if (!env.DB) {
      return fail(env, "还没绑定数据库：Settings → Bindings 里加一个 D1 database，变量名填 DB", 500);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    const method = request.method.toUpperCase();

    // 一键建表 + 老库补字段：浏览器打开 /api/setup 即可，可重复执行
    if (path === "/setup") {
      await env.DB.batch(SCHEMA_STATEMENTS.map((sql) => env.DB.prepare(sql)));

      let addedColumn = false;
      try {
        const info = await env.DB.prepare("PRAGMA table_info(entries)").all();
        const cols = (info.results || []).map((row) => row.name);
        if (cols.length && !cols.includes("category")) {
          await env.DB.prepare("ALTER TABLE entries ADD COLUMN category TEXT NOT NULL DEFAULT '四班'").run();
          addedColumn = true;
        }
      } catch (e) {
        console.error("[shenren-api] 补列失败", e);
      }

      const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const names = (tables.results || [])
        .map((row) => row.name)
        .filter((n) => n === "entries" || n === "rate");
      return ok(env, { message: "数据库已就绪", tables: names, addedCategory: addedColumn });
    }

    if (path === "/entries") {
      if (method === "POST") return await submit(request, env);
      return await listApproved(env);
    }

    if (path === "/admin/login") {
      if (method !== "POST") return fail(env, "方法不允许", 405);
      const body = await readJSON(request);
      if (!env.ADMIN_CODE) return fail(env, "还没配置管理员口令（ADMIN_CODE）", 500);
      if (!safeEqual(body.password || "", env.ADMIN_CODE)) return fail(env, "口令不正确", 401);
      return ok(env, {});
    }

    if (path === "/admin/entries" || path === "/admin/action") {
      if (!env.ADMIN_CODE) return fail(env, "还没配置管理员口令（ADMIN_CODE）", 500);
      if (!safeEqual(request.headers.get("x-admin-key") || "", env.ADMIN_CODE)) {
        return fail(env, "口令已失效，请重新登录", 401);
      }
      if (path === "/admin/entries") {
        return await adminList(env, url.searchParams.get("status") || "all");
      }
      if (method !== "POST") return fail(env, "方法不允许", 405);
      return await adminAct(env, await readJSON(request));
    }

    return fail(env, "接口不存在", 404);
  } catch (err) {
    const message = String((err && err.message) || "");
    if (/no such table/i.test(message)) {
      return fail(env, "数据库还没建表：用浏览器打开本站的 /api/setup 就会自动建好", 500);
    }
    console.error("[shenren-api]", err && err.stack ? err.stack : err);
    return fail(env, "服务器开小差了，稍后再试", 500);
  }
}

/* ---------------- 路由实现 ---------------- */

async function listApproved(env) {
  const { results } = await env.DB
    .prepare("SELECT * FROM entries WHERE status = ? ORDER BY created_at DESC LIMIT 300")
    .bind("approved")
    .all();

  return ok(env, { entries: (results || []).map(toClient) });
}

async function submit(request, env) {
  if (!env.CLASS_CODE) return fail(env, "还没配置班级暗号（CLASS_CODE）", 500);

  const body = await readJSON(request);

  if (!safeEqual(body.code || "", env.CLASS_CODE)) return fail(env, "班级暗号不正确", 403);

  const name = cleanText(body.name, 16);
  const author = cleanText(body.author, 16);
  const deeds = parseDeeds(body.deeds);
  const category = normalizeCategory(body.category);

  if (!name || !author) return fail(env, "名字和作者都要填");
  if (!deeds.length) return fail(env, "至少写一条事迹");
  if (hasBadWord(env, name + " " + author + " " + deeds.join(" "))) {
    return fail(env, "内容里有不太合适的词，改一改再提交吧");
  }

  const ipHash = await hashIp(request, env);

  if (await isRateLimited(env, ipHash)) return fail(env, "提交太快了，歇 30 秒再来", 429);

  const id = "sn_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const now = Date.now();

  await env.DB
    .prepare("INSERT INTO entries (id, name, author, deeds, status, created_at, ip_hash, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, name, author, JSON.stringify(deeds), "pending", now, ipHash, category)
    .run();

  return ok(env, {
    entry: { id, name, author, deeds, status: "pending", category, createdAt: new Date(now).toISOString() }
  });
}

async function adminList(env, status) {
  const stmt = status && status !== "all"
    ? env.DB.prepare("SELECT * FROM entries WHERE status = ? ORDER BY created_at DESC LIMIT 500").bind(status)
    : env.DB.prepare("SELECT * FROM entries ORDER BY created_at DESC LIMIT 500");

  const { results } = await stmt.all();
  return ok(env, { entries: (results || []).map(toClient) });
}

async function adminAct(env, body) {
  const action = body.action;
  const id = body.id;
  if (!id) return fail(env, "缺少记录 id");

  if (action === "delete") {
    await env.DB.prepare("DELETE FROM entries WHERE id = ?").bind(id).run();
    return ok(env, {});
  }

  if (action !== "approve" && action !== "reject") return fail(env, "未知操作");

  await env.DB
    .prepare("UPDATE entries SET status = ?, reviewed_at = ? WHERE id = ?")
    .bind(action === "approve" ? "approved" : "rejected", Date.now(), id)
    .run();

  return ok(env, {});
}

/* ---------------- 工具 ---------------- */

function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-admin-key",
    "Access-Control-Max-Age": "86400"
  };
}

function json(env, payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: Object.assign({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }, cors(env))
  });
}

function ok(env, data) {
  return json(env, Object.assign({ ok: true }, data), 200);
}

function fail(env, message, status) {
  return json(env, { ok: false, error: message }, status || 400);
}

async function readJSON(request) {
  try {
    return (await request.json()) || {};
  } catch (e) {
    return {};
  }
}

function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

function cleanText(value, max) {
  return String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function parseDeeds(input) {
  const arr = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
  const out = [];
  for (const raw of arr) {
    const t = cleanText(String(raw || "").replace(/^[-*·•]\s*/, ""), 600);
    if (t) out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

function hasBadWord(env, text) {
  const words = String(env.BAD_WORDS || "傻逼,操你,狗日,滚蛋,去死")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w.toLowerCase()));
}

async function hashIp(request, env) {
  const raw = request.headers.get("CF-Connecting-IP") || "";
  const data = new TextEncoder().encode(raw + (env.IP_SALT || "shenren-salt"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isRateLimited(env, ipHash) {
  try {
    const row = await env.DB.prepare("SELECT at FROM rate WHERE ip = ?").bind(ipHash).first();
    const now = Date.now();

    if (row) {
      if (now - Number(row.at) < RATE_WINDOW_MS) return true;
      await env.DB.prepare("UPDATE rate SET at = ? WHERE ip = ?").bind(now, ipHash).run();
    } else {
      await env.DB.prepare("INSERT INTO rate (ip, at) VALUES (?, ?)").bind(ipHash, now).run();
    }
    return false;
  } catch (e) {
    // 限流表出错时不阻断正常提交
    return false;
  }
}

function toClient(row) {
  let deeds = [];
  try {
    deeds = JSON.parse(row.deeds || "[]");
  } catch (e) {
    deeds = String(row.deeds || "").split("\n").filter(Boolean);
  }

  return {
    id: row.id,
    name: row.name,
    author: row.author,
    deeds,
    status: row.status,
    category: normalizeCategory(row.category),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    reviewedAt: row.reviewed_at ? new Date(Number(row.reviewed_at)).toISOString() : null
  };
}
