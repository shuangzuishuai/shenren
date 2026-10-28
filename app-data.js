/* ============================================================
   神人榜 · 数据层
   对上提供同一套异步接口，对下有两套实现：
     - local : 浏览器 localStorage（无需服务器，先跑通流程）
     - cloud : CloudBase 云函数 HTTP 接口（真正的云端存储）
   页面只依赖 ShenrenAPI，不关心数据从哪来。
   ============================================================ */
(function (global) {
  "use strict";

  var cfg = global.SHENREN_CONFIG || {};
  var MODE = cfg.mode === "cloud" ? "cloud" : "local";
  var API_BASE = String(cfg.apiBase || "").replace(/\/+$/, "");

  var KEY_V2 = "shenren.entries.v2";
  var KEY_V1 = "shenren.entries.v1";
  var KEY_ADMIN = "shenren.admin.key";

  /* ---------------- 基础工具 ---------------- */

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }

  function uid() {
    return "sn_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function clean(str, max) {
    return String(str == null ? "" : str).replace(/\s+/g, " ").trim().slice(0, max);
  }

  function toDeeds(input) {
    var arr = Array.isArray(input) ? input : String(input || "").split(/\r?\n/);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var t = String(arr[i] || "").replace(/^[-*·•]\s*/, "").replace(/\s+/g, " ").trim();
      if (t) out.push(t.slice(0, 160));
      if (out.length >= 12) break;
    }
    return out;
  }

  function toEntry(raw) {
    if (!raw || typeof raw !== "object") return null;
    var name = clean(raw.name, 16);
    var author = clean(raw.author, 16);
    var deeds = toDeeds(raw.deeds);
    if (!name || !author || !deeds.length) return null;

    var d = raw.createdAt ? new Date(raw.createdAt) : new Date();
    if (isNaN(d.getTime())) d = new Date();

    var status = raw.status;
    if (status !== "approved" && status !== "rejected") status = "pending";

    return {
      id: String(raw._id || raw.id || uid()),
      name: name,
      author: author,
      deeds: deeds,
      status: status,
      createdAt: d.toISOString(),
      reviewedAt: raw.reviewedAt ? new Date(raw.reviewedAt).toISOString() : null
    };
  }

  function sortDesc(list) {
    return list.slice().sort(function (a, b) {
      return new Date(b.createdAt) - new Date(a.createdAt);
    });
  }

  function escapeHTML(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.getFullYear() + "." + pad2(d.getMonth() + 1) + "." + pad2(d.getDate());
  }

  function fmtShort(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return pad2(d.getMonth() + 1) + "." + pad2(d.getDate()) + " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  /* ---------------- 本地存储实现 ---------------- */

  var storageOK = (function () {
    try {
      localStorage.setItem("__shenren__", "1");
      localStorage.removeItem("__shenren__");
      return true;
    } catch (e) {
      return false;
    }
  })();

  var memory = [];

  function readLocal() {
    if (!storageOK) return memory.slice();
    try {
      var txt = localStorage.getItem(KEY_V2);
      var arr = txt ? JSON.parse(txt) : [];
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function writeLocal(list) {
    if (!storageOK) { memory = list; return; }
    try {
      localStorage.setItem(KEY_V2, JSON.stringify(list));
    } catch (e) {
      memory = list;
    }
  }

  // 老版本（无审核）数据自动迁移：一律视为已通过
  function migrate() {
    if (!storageOK) return;
    try {
      if (localStorage.getItem(KEY_V2)) return;
      var old = localStorage.getItem(KEY_V1);
      if (!old) return;
      var arr = JSON.parse(old) || [];
      var migrated = arr.map(function (e) {
        var x = toEntry(e);
        if (x) { x.status = "approved"; x.reviewedAt = x.createdAt; }
        return x;
      }).filter(Boolean);
      if (migrated.length) {
        writeLocal(migrated);
        localStorage.removeItem(KEY_V1);
      }
    } catch (e) { /* ignore */ }
  }

  function localAll() {
    migrate();
    return readLocal().map(toEntry).filter(Boolean);
  }

  function localSession() {
    try { return sessionStorage.getItem(KEY_ADMIN) || ""; } catch (e) { return ""; }
  }

  var local = {
    list: function () {
      return Promise.resolve(sortDesc(localAll().filter(function (e) { return e.status === "approved"; })));
    },

    submit: function (payload) {
      if (String(payload.code || "") !== String(cfg.localClassCode || "")) {
        return Promise.reject(new Error("班级暗号不正确"));
      }
      var entry = toEntry(payload);
      if (!entry) return Promise.reject(new Error("名字、事迹、作者都要填"));

      entry.status = "pending";
      var all = localAll();
      all.unshift(entry);
      writeLocal(all);
      return Promise.resolve({ ok: true, entry: entry });
    },

    adminLogin: function (password) {
      if (String(password || "") !== String(cfg.localAdminPassword || "")) {
        return Promise.resolve({ ok: false, error: "口令不正确" });
      }
      try { sessionStorage.setItem(KEY_ADMIN, "1"); } catch (e) { /* ignore */ }
      return Promise.resolve({ ok: true });
    },

    adminHas: function () { return !!localSession(); },

    adminLogout: function () {
      try { sessionStorage.removeItem(KEY_ADMIN); } catch (e) { /* ignore */ }
    },

    adminList: function (status) {
      var all = localAll();
      if (status && status !== "all") {
        all = all.filter(function (e) { return e.status === status; });
      }
      return Promise.resolve(sortDesc(all));
    },

    adminAct: function (action, id) {
      var all = localAll();
      var i = -1;
      for (var k = 0; k < all.length; k++) {
        if (all[k].id === id) { i = k; break; }
      }
      if (i < 0) return Promise.resolve({ ok: false, error: "记录不存在" });

      if (action === "approve") {
        all[i].status = "approved";
        all[i].reviewedAt = new Date().toISOString();
      } else if (action === "reject") {
        all[i].status = "rejected";
        all[i].reviewedAt = new Date().toISOString();
      } else if (action === "delete") {
        all.splice(i, 1);
      } else {
        return Promise.resolve({ ok: false, error: "未知操作" });
      }

      writeLocal(all);
      return Promise.resolve({ ok: true });
    }
  };

  /* ---------------- 云端实现（CloudBase 云函数） ---------------- */

  function adminKey() {
    try { return sessionStorage.getItem(KEY_ADMIN) || ""; } catch (e) { return ""; }
  }

  function apiFetch(path, options) {
    options = options || {};
    if (!API_BASE) {
      return Promise.reject(new Error("还没有配置云端接口地址，请检查 config.js 里的 apiBase"));
    }
    var headers = { "Content-Type": "application/json" };
    var key = adminKey();
    if (key) headers["x-admin-key"] = key;

    return fetch(API_BASE + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      mode: "cors",
      cache: "no-store"
    }).then(function (res) {
      return res.text().then(function (text) {
        var data;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!data) throw new Error("服务返回异常（HTTP " + res.status + "）");
        if (!res.ok || data.ok === false) throw new Error(data.error || ("请求失败（HTTP " + res.status + "）"));
        return data;
      });
    }, function () {
      throw new Error("网络连接失败，请稍后重试");
    });
  }

  var cloud = {
    list: function () {
      return apiFetch("/entries").then(function (data) {
        return (data.entries || []).map(function (e) {
          var x = toEntry(e);
          if (x) x.status = "approved";
          return x;
        }).filter(Boolean);
      });
    },

    submit: function (payload) {
      return apiFetch("/entries", {
        method: "POST",
        body: { name: payload.name, deeds: payload.deeds, author: payload.author, code: payload.code }
      }).then(function (data) {
        return { ok: true, entry: toEntry(data.entry) || {} };
      });
    },

    adminLogin: function (password) {
      return apiFetch("/admin/login", { method: "POST", body: { password: password } })
        .then(function () {
          try { sessionStorage.setItem(KEY_ADMIN, password); } catch (e) { /* ignore */ }
          return { ok: true };
        });
    },

    adminHas: function () { return !!adminKey(); },

    adminLogout: function () {
      try { sessionStorage.removeItem(KEY_ADMIN); } catch (e) { /* ignore */ }
    },

    adminList: function (status) {
      return apiFetch("/admin/entries?status=" + encodeURIComponent(status || "all"))
        .then(function (data) {
          return (data.entries || []).map(function (e) {
            var x = toEntry(e);
            if (x && e.status) x.status = e.status;
            return x;
          }).filter(Boolean);
        });
    },

    adminAct: function (action, id) {
      return apiFetch("/admin/action", { method: "POST", body: { action: action, id: id } })
        .then(function () { return { ok: true }; });
    }
  };

  /* ---------------- 对外暴露 ---------------- */

  var impl = MODE === "cloud" ? cloud : local;

  global.ShenrenAPI = {
    mode: MODE,
    // 本地模式没有 localStorage 时，数据只存在内存里
    persistent: MODE === "cloud" ? true : storageOK,
    list: impl.list,
    submit: impl.submit,
    admin: {
      login: impl.adminLogin,
      has: impl.adminHas,
      logout: impl.adminLogout,
      list: impl.adminList,
      act: impl.adminAct
    }
  };

  global.ShenrenUtil = {
    escapeHTML: escapeHTML,
    fmtDate: fmtDate,
    fmtShort: fmtShort,
    pad2: pad2,
    toDeeds: toDeeds
  };
})(window);
