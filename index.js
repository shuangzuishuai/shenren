/* ============================================================
   Worker 入口（Workers + 静态资源）
   - /api/* 交给 api-core 处理
   - 其他请求交给静态资源绑定 ASSETS（index.html / styles.css …）
   ============================================================ */

import { handleApi } from "./api-core.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }
};
