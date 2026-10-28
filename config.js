/* ============================================================
   神人榜 · 环境配置
   改这个文件就能切换「本地模式 / 云端模式」，其他文件不用动。

   本地模式（默认）：
     数据存在你浏览器里，适合先试玩、或离线使用。

   云端模式：
     1. 先按 DEPLOY-CLOUDFLARE.md（或 DEPLOY.md 走腾讯云）部署好后端
     2. 把 mode 改成 "cloud"
     3. 把 apiBase 填成接口地址：
        - Cloudflare Pages（推荐，同域名）："/api"
        - 腾讯云 CloudBase：https://xxxx.service.tcloudbase.com/api（结尾不带斜杠）

   注意：本地模式下的暗号和管理员口令都写在前端，
         只能防手滑，防不了懂技术的人；
         真正的校验发生在云函数里（云端模式）。
   ============================================================ */
window.SHENREN_CONFIG = {
  // "local" 或 "cloud"
  mode: "local",

  // 云端模式的接口地址，例如：
  // "https://shenren-1g2h3j4k.service.tcloudbase.com/api"
  apiBase: "",

  // 本地模式用的班级暗号（云端模式下不用这个，改云函数环境变量）
  localClassCode: "shenren2026",

  // 本地模式的管理员口令
  localAdminPassword: "admin2026"
};
