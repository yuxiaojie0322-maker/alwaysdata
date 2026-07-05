const CONFIG = {
  LOGIN_URL:  "https://admin.alwaysdata.com/login/?next=/",
  SITE_URL:   "https://admin.alwaysdata.com/site/",
  HOME_URL:   "https://admin.alwaysdata.com/",
  KV_KEY:     "accounts",
  STATS_KEY:  "stats",
  ADMIN_PATH: "/admin",
};

export default {
  async fetch(request, env, ctx) {
    return handleRequest(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleCron(env, event.cron));
  },
};

function getAdminToken(env) {
  return env.ADMIN_TOKEN || "";
}

function verifyToken(request, env) {
  const token = getAdminToken(env);
  if (!token) return false;
  const url = new URL(request.url);
  return (
    url.searchParams.get("token") === token ||
    request.headers.get("X-Admin-Token") === token
  );
}

async function handleRequest(request, env) {
  const url  = new URL(request.url);
  const path = url.pathname;

  // 管理页面
  if (path === CONFIG.ADMIN_PATH || path === CONFIG.ADMIN_PATH + "/") {
    if (!verifyToken(request, env)) return renderLoginPage();
    return renderAdminPage(url.searchParams.get("token"));
  }

  // API 路由
  if (path.startsWith("/api/")) {
    if (!verifyToken(request, env))
      return jsonResponse({ error: "Unauthorized" }, 401);
    return handleAPI(request, env, path);
  }

  // 单个执行
  if (path === "/run") {
    if (!verifyToken(request, env))
      return jsonResponse({ error: "Unauthorized" }, 401);
    const index  = parseInt(url.searchParams.get("index") || "0");
    const result = await runSingleAccount(env, index);
    await updateStats(env, result.success ? "success" : "fail");
    return jsonResponse(result);
  }

  // 全部执行（API 直接调用，注意子请求限制）
  if (path === "/run-all") {
    if (!verifyToken(request, env))
      return jsonResponse({ error: "Unauthorized" }, 401);
    const result = await runAllAccounts(env);
    await sendTelegramReport(env, result.results, "API批量执行");
    return jsonResponse(result);
  }

  // 汇总通知接口（前端批量完成后调用）
  if (path === "/notify" && request.method === "POST") {
    if (!verifyToken(request, env))
      return jsonResponse({ error: "Unauthorized" }, 401);
    const { results } = await request.json();
    if (!results || !Array.isArray(results)) {
      return jsonResponse({ error: "Invalid results" }, 400);
    }
    await sendTelegramReport(env, results, "批量执行");
    return jsonResponse({ success: true });
  }

  // 默认跳转管理页
  return Response.redirect(`${url.origin}${CONFIG.ADMIN_PATH}`, 302);
}

// ===== API 处理函数 =====
async function handleAPI(request, env, path) {
  // 获取账号列表（可见的，前10个）
  if (path === "/api/accounts" && request.method === "GET") {
    const accounts = await getAccounts(env);
    return jsonResponse({
      accounts: accounts.map((a, i) => ({
        index:    i,
        email:    a.email,
        password: maskPassword(a.password),
      })),
      count: accounts.length,
    });
  }

  // 添加账号（限制不超过10个）
  if (path === "/api/accounts/add" && request.method === "POST") {
    const { email, password } = await request.json();
    if (!email || !password)
      return jsonResponse({ error: "Email and password required" }, 400);
    return jsonResponse(await addAccount(env, email.trim(), password.trim()));
  }

  // 删除账号
  if (path === "/api/accounts/delete" && request.method === "POST") {
    const { index } = await request.json();
    if (index === undefined)
      return jsonResponse({ error: "Index required" }, 400);
    return jsonResponse(await deleteAccount(env, parseInt(index)));
  }

  // 获取累计统计
  if (path === "/api/stats" && request.method === "GET") {
    const stats = await getStats(env);
    return jsonResponse(stats);
  }

  // Telegram 通知测试
  if (path === "/api/tg-test" && request.method === "GET") {
    const ok = await sendTelegram(
      env,
      "🔔 *Alwaysdata Keep Alive*\n\nTelegram 通知测试成功 ✅"
    );
    return jsonResponse({
      success: ok,
      message: ok ? "发送成功" : "发送失败，请检查 TG_BOT_TOKEN / TG_CHAT_ID",
    });
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// ===== Cron 定时任务：一次性执行所有可见账号 =====
async function handleCron(env, cronExpression) {
  console.log(`Cron: ${cronExpression} @ ${new Date().toISOString()}`);

  const accounts = await getAccounts(env);
  if (accounts.length === 0) {
    console.log("No accounts configured");
    return;
  }

  console.log(`Starting full run for ${accounts.length} accounts...`);
  const results = [];

  for (let i = 0; i < accounts.length; i++) {
    const { email, password } = accounts[i];
    const r = await loginAndKeepAlive(env, email, password, i);
    results.push(r);
    await updateStats(env, r.success ? "success" : "fail");

    // 账号之间间隔 2 秒
    if (i < accounts.length - 1) {
      await sleep(2000);
    }
  }

  await sendTelegramReport(env, results, "定时任务");
  console.log(`Cron done. ${results.filter(r => r.success).length}/${accounts.length} success`);
}

// ===== 单个执行 =====
async function runSingleAccount(env, index) {
  const accounts = await getAccounts(env);
  if (index >= accounts.length)
    return { success: false, error: `Index ${index} not found` };
  const { email, password } = accounts[index];
  return loginAndKeepAlive(env, email, password, index);
}

// ===== 全部执行（API 调用，注意子请求限制） =====
async function runAllAccounts(env) {
  const accounts = await getAccounts(env);
  const results  = [];

  for (let i = 0; i < accounts.length; i++) {
    const { email, password } = accounts[i];
    const r = await loginAndKeepAlive(env, email, password, i);
    results.push(r);
    await updateStats(env, r.success ? "success" : "fail");

    // 每个账号间隔 1 秒，尽量平缓
    if (i < accounts.length - 1) {
      await sleep(1000);
    }
  }

  return { results, total: accounts.length };
}

// ===== 核心保活流程 =====
async function loginAndKeepAlive(env, email, password, index) {
  const t0 = Date.now();
  try {
    console.log(`[${email}] Fetching login page...`);
    const pgResp = await fetch(CONFIG.LOGIN_URL, {
      headers: buildBrowserHeaders(),
      redirect: "follow",
    });
    if (!pgResp.ok) throw new Error(`Login page: ${pgResp.status}`);

    const pgHtml    = await pgResp.text();
    const csrfMatch = pgHtml.match(/name="csrfmiddlewaretoken"\s+value="([^"]+)"/);
    if (!csrfMatch) throw new Error("CSRF token not found");

    const csrfToken   = csrfMatch[1];
    const pageCookies = extractCookies(pgResp.headers);

    const loginResp = await fetch(CONFIG.LOGIN_URL, {
      method: "POST",
      headers: {
        ...buildBrowserHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Origin":  "https://admin.alwaysdata.com",
        "Referer": CONFIG.LOGIN_URL,
        "Cookie":  buildCookieHeader(pageCookies),
      },
      body: new URLSearchParams({
        csrfmiddlewaretoken: csrfToken,
        login:    email,
        password: password,
        alive:    "on",
      }).toString(),
      redirect: "manual",
    });

    if (loginResp.status !== 302) {
      const body = await loginResp.text();
      if (body.includes("Please enter a correct") || body.includes("invalid"))
        throw new Error("Invalid credentials");
      if (loginResp.status !== 200)
        throw new Error(`Login status: ${loginResp.status}`);
    }

    const allCookies = { ...pageCookies, ...extractCookies(loginResp.headers) };
    if (!allCookies.sessionid) throw new Error("No sessionid — login failed");

    const siteResp = await fetch(CONFIG.SITE_URL, {
      headers: {
        ...buildBrowserHeaders(),
        "Referer": CONFIG.HOME_URL,
        "Cookie":  buildCookieHeader(allCookies),
      },
      redirect: "follow",
    });

    let foundDomain = null;
    if (siteResp.ok) {
      const siteHtml = await siteResp.text();
      const matches  = [...siteHtml.matchAll(
        /href="(http:\/\/[a-zA-Z0-9-]+\.alwaysdata\.net)[^"]*"/g
      )];
      const domains = [...new Set(matches.map(m => m[1]))];
      if (domains.length > 0) {
        foundDomain = domains[0];
        try {
          const dr = await fetch(domains[0], {
            headers: buildBrowserHeaders(),
            redirect: "follow",
            signal:  AbortSignal.timeout(10000),
          });
          console.log(`[${email}] ${domains[0]} → ${dr.status}`);
        } catch (e) {
          console.log(`[${email}] Ping error: ${e.message}`);
        }
      }
    }

    const elapsed = Date.now() - t0;
    return { success: true, email, elapsed, domain: foundDomain };

  } catch (error) {
    const elapsed = Date.now() - t0;
    return { success: false, email, elapsed, error: error.message, domain: null };
  }
}

// ===== KV 统计 =====
async function getStats(env) {
  const raw = (await env.ALWAYSDATA_KV.get(CONFIG.STATS_KEY)) || '{"success":0,"fail":0}';
  try { return JSON.parse(raw); } catch { return { success: 0, fail: 0 }; }
}

async function updateStats(env, type) {
  const stats = await getStats(env);
  if (type === "success") stats.success++;
  else stats.fail++;
  await env.ALWAYSDATA_KV.put(CONFIG.STATS_KEY, JSON.stringify(stats));
}

// ===== Telegram 通知 =====
async function sendTelegramReport(env, results, trigger = "定时任务") {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  const lines = ["*保活报告*\n"];
  for (const r of results) {
    if (r.success) {
      lines.push(`账号：\`${r.email}\``);
      if (r.domain) lines.push(`域名：${r.domain}`);
      lines.push(`✅ 保活成功\n`);
    } else {
      lines.push(`账号：\`${r.email}\``);
      lines.push(`❌ ${r.error || "未知错误"}\n`);
    }
  }
  lines.push(`_Alwaysdata Keep Alive_`);
  await sendTelegram(env, lines.join("\n"));
}

async function sendTelegram(env, text) {
  const token  = env.TG_BOT_TOKEN;
  const chatId = env.TG_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id:    chatId,
          text:       text,
          parse_mode: "Markdown",
        }),
      }
    );
    const data = await resp.json();
    if (!data.ok) { console.error("TG:", data.description); return false; }
    return true;
  } catch (e) {
    console.error("TG send failed:", e.message);
    return false;
  }
}

// ===== 账号 KV 操作（防呆版） =====
async function getRawAccounts(env) {
  const raw  = (await env.ALWAYSDATA_KV.get(CONFIG.KV_KEY)) || "";
  const list = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const sep = t.indexOf("-----");
    if (sep === -1) continue;
    const email    = t.slice(0, sep).trim();
    const password = t.slice(sep + 5).trim();
    if (email && password) list.push({ email, password });
  }
  return list;
}

// 可见列表（最多10个）
async function getAccounts(env) {
  const accounts = await getRawAccounts(env);
  return accounts.slice(0, 10);
}

async function saveAccounts(env, accounts) {
  await env.ALWAYSDATA_KV.put(
    CONFIG.KV_KEY,
    accounts.map(a => `${a.email}-----${a.password}`).join("\n")
  );
}

async function addAccount(env, email, password) {
  const all = await getRawAccounts(env);
  if (all.find(a => a.email.toLowerCase() === email.toLowerCase()))
    return { error: `${email} already exists` };
  if (all.length >= 10) {
    return { error: "⚠️ 账号数量已达上限（10个），请部署新的 Worker 或删除现有账号" };
  }
  all.push({ email, password });
  await saveAccounts(env, all);
  return { success: true, message: `${email} added`, count: all.length };
}

async function deleteAccount(env, index) {
  const visible = await getAccounts(env);
  if (index < 0 || index >= visible.length)
    return { error: `Invalid index: ${index}` };
  const { email } = visible[index];
  const all = await getRawAccounts(env);
  const newAll = all.filter(a => a.email.toLowerCase() !== email.toLowerCase());
  if (newAll.length === all.length) {
    return { error: "Account not found in full list" };
  }
  await saveAccounts(env, newAll);
  return { success: true, message: `${email} deleted`, count: newAll.length };
}

// ===== 工具函数 =====
function buildBrowserHeaders() {
  return {
    "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control":   "no-cache",
  };
}

function extractCookies(headers) {
  const cookies = {};
  const rawList = headers.getAll
    ? headers.getAll("set-cookie")
    : [headers.get("set-cookie")].filter(Boolean);
  for (const h of rawList) {
    if (!h) continue;
    const [nv] = h.split(";");
    const eqIdx = nv.indexOf("=");
    if (eqIdx > 0) cookies[nv.slice(0, eqIdx).trim()] = nv.slice(eqIdx + 1).trim();
  }
  return cookies;
}

function buildCookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
}

function maskPassword(pwd) {
  if (!pwd || pwd.length <= 3) return "***";
  return pwd[0] + "*".repeat(Math.min(pwd.length - 2, 6)) + pwd.slice(-1);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ===== 登录页 =====
function renderLoginPage() {
  return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>保活管理 · 登录</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);
      min-height:100vh;display:flex;align-items:center;justify-content:center;
    }
    .box{
      background:rgba(255,255,255,.06);backdrop-filter:blur(12px);
      border:1px solid rgba(255,255,255,.12);border-radius:16px;
      padding:40px;width:360px;box-shadow:0 20px 60px rgba(0,0,0,.5);
    }
    h1{color:#fff;font-size:20px;text-align:center;margin-bottom:6px}
    p{color:rgba(255,255,255,.4);font-size:12px;text-align:center;margin-bottom:28px}
    input{
      width:100%;padding:12px 16px;
      background:rgba(255,255,255,.08);
      border:1px solid rgba(255,255,255,.15);
      border-radius:8px;color:#fff;font-size:14px;
      margin-bottom:14px;outline:none;transition:border-color .2s;
    }
    input:focus{border-color:#4f8ef7}
    input::placeholder{color:rgba(255,255,255,.3)}
    button{
      width:100%;padding:12px;
      background:linear-gradient(135deg,#4f8ef7,#6c47ff);
      border:none;border-radius:8px;color:#fff;
      font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s;
    }
    button:hover{opacity:.88}
    .err{
      background:rgba(255,80,80,.15);border:1px solid rgba(255,80,80,.3);
      border-radius:8px;padding:10px;color:#ff8080;font-size:13px;
      margin-bottom:14px;display:none;text-align:center;
    }
  </style>
</head>
<body>
<div class="box">
  <h1>🔐 保活管理系统</h1>
  <p>Alwaysdata Keep-Alive Manager</p>
  <div class="err" id="err">密码错误，请重试</div>
  <input type="password" id="tk" placeholder="请输入管理密码"
         onkeydown="if(event.key==='Enter')login()">
  <button onclick="login()">登 录</button>
</div>
<script>
  document.getElementById('tk').focus();
  async function login(){
    const t = document.getElementById('tk').value.trim();
    if(!t) return;
    const r = await fetch('/api/accounts?token='+encodeURIComponent(t));
    if(r.status===401){
      document.getElementById('err').style.display='block';
      document.getElementById('tk').value='';
      document.getElementById('tk').focus();
    } else {
      location.href='/admin?token='+encodeURIComponent(t);
    }
  }
</script>
</body>
</html>`, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}

// ===== 管理页 =====
function renderAdminPage(token) {
  return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Alwaysdata 保活管理</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{
      --bg:#0b0d14;--card:#151822;--border:#242836;
      --text:#e3e5e9;--muted:#777d8c;
      --primary:#5b8af7;--success:#34c759;
      --danger:#ff4d4f;--warning:#ff9f43;
    }
    body{
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:var(--bg);color:var(--text);min-height:100vh;
    }

    .header{
      background:var(--card);border-bottom:1px solid var(--border);
      padding:16px 28px;display:flex;align-items:center;
      justify-content:space-between;position:sticky;top:0;z-index:100;
      backdrop-filter:blur(12px);
    }
    .header h1{font-size:19px;font-weight:700;letter-spacing:0.3px}
    .header .sub{color:var(--muted);font-size:12px;margin-top:3px}

    .wrap{max-width:680px;margin:28px auto;padding:0 20px;}

    .card{
      background:var(--card);border:1px solid var(--border);
      border-radius:16px;padding:22px;margin-bottom:20px;
      box-shadow:0 4px 24px rgba(0,0,0,0.25);
    }
    .card:last-child{margin-bottom:0}
    .ct{
      font-size:13px;font-weight:600;color:var(--muted);
      text-transform:uppercase;letter-spacing:0.6px;margin-bottom:16px;
      display:flex;align-items:center;gap:8px;
    }

    input{
      width:100%;background:var(--bg);border:1px solid var(--border);
      border-radius:10px;color:var(--text);padding:12px 14px;
      font-size:14px;outline:none;transition:border-color .2s, box-shadow .2s;
      margin-bottom:12px;
    }
    input:focus{border-color:var(--primary);box-shadow:0 0 0 3px rgba(91,138,247,0.15)}

    .btn{
      padding:10px 18px;border:none;border-radius:10px;
      font-size:13px;font-weight:600;cursor:pointer;
      transition:all .15s;white-space:nowrap;
      display:inline-flex;align-items:center;gap:6px;
    }
    .btn:hover{filter:brightness(1.15);transform:translateY(-1px)}
    .btn:active{transform:translateY(0)}
    .btn-full{width:100%;justify-content:center}
    .btn-p{background:var(--primary);color:#fff}
    .btn-d{background:var(--danger);color:#fff}
    .btn-s{background:var(--success);color:#fff}
    .btn-g{background:transparent;border:1px solid var(--border);color:var(--text)}
    .btn-w{background:var(--warning);color:#fff}
    .btn-sm{padding:6px 12px;font-size:12px;border-radius:8px}

    .stats{
      display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px;
    }
    .stat{
      background:linear-gradient(145deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
      border:1px solid var(--border);border-radius:14px;
      padding:14px 10px;text-align:center;
    }
    .stat-v{font-size:22px;font-weight:700;margin-bottom:4px}
    .stat-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:0.5px}

    .acc-list{display:flex;flex-direction:column;gap:8px;margin-top:6px}
    .acc{
      display:flex;align-items:center;
      background:var(--bg);border:1px solid var(--border);
      border-radius:12px;padding:12px 14px;gap:12px;
      transition:border-color .2s, background .2s;
    }
    .acc:hover{border-color:var(--primary);background:rgba(91,138,247,0.04)}
    .acc-idx{
      font-size:11px;color:var(--muted);font-weight:600;
      min-width:24px;text-align:center;background:rgba(255,255,255,0.04);
      border-radius:6px;padding:4px 0;
    }
    .acc-info{flex:1;min-width:0}
    .acc-email{
      font-size:14px;font-weight:500;
      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
    }
    .acc-pass{font-size:12px;color:var(--muted);font-family:monospace;margin-top:2px}
    .acc-acts{display:flex;gap:8px;flex-shrink:0}

    .acc-status{
      display:inline-flex;align-items:center;gap:4px;
      padding:4px 10px;border-radius:20px;
      font-size:12px;font-weight:600;white-space:nowrap;
      background:rgba(255,255,255,0.04);
    }
    .acc-status.ok{color:var(--success);background:rgba(52,199,89,0.1)}
    .acc-status.fail{color:var(--danger);background:rgba(255,77,79,0.1)}
    .acc-status.running{color:var(--primary);animation:pulse 1.2s infinite}

    @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}

    #toast{
      position:fixed;bottom:24px;right:24px;
      padding:12px 20px;border-radius:12px;
      font-size:14px;font-weight:500;
      z-index:999;display:none;
      backdrop-filter:blur(12px);box-shadow:0 8px 24px rgba(0,0,0,0.5);
      animation:si .3s ease;
    }
    @keyframes si{
      from{transform:translateX(80px);opacity:0}
      to{transform:translateX(0);opacity:1}
    }
    .ts{background:var(--success);color:#fff}
    .te{background:var(--danger);color:#fff}
    .ti{background:var(--primary);color:#fff}
    .tw{background:var(--warning);color:#fff}

    .empty{text-align:center;color:var(--muted);padding:32px 20px;font-size:14px}
    .badge{
      display:inline-flex;align-items:center;
      padding:3px 12px;border-radius:20px;
      font-size:11px;font-weight:600;
      background:rgba(91,138,247,0.15);color:var(--primary);
    }
  </style>
</head>
<body>

<div class="header">
  <div>
    <h1>🚀 Alwaysdata 保活管理</h1>
    <div class="sub">最多10个账号 · 定时15天全量执行</div>
  </div>
  <button class="btn btn-w" onclick="executeSequentially()">▶ 批量执行</button>
</div>

<div class="wrap">
  <div class="card">
    <div class="ct">➕ 添加账号</div>
    <input type="email" id="add-email" placeholder="邮箱地址"
           onkeydown="if(event.key==='Enter')document.getElementById('add-pwd').focus()">
    <input type="password" id="add-pwd" placeholder="密码"
           onkeydown="if(event.key==='Enter')addAccount()">
    <button class="btn btn-p btn-full" onclick="addAccount()">添加账号</button>
  </div>

  <div class="card">
    <div class="ct">
      👥 账号列表
      <span class="badge" id="acc-count">0</span>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-v" id="s-total" style="color:var(--primary)">-</div>
        <div class="stat-l">总账号</div>
      </div>
      <div class="stat">
        <div class="stat-v" id="s-ok" style="color:var(--success)">-</div>
        <div class="stat-l">累计成功</div>
      </div>
      <div class="stat">
        <div class="stat-v" id="s-fail" style="color:var(--danger)">-</div>
        <div class="stat-l">累计失败</div>
      </div>
    </div>

    <div class="acc-list" id="acc-list">
      <div class="empty">加载中...</div>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
const TOKEN = ${JSON.stringify(token)};

function api(path, method = 'GET', body = null) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(path + sep + 'token=' + encodeURIComponent(TOKEN), {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: body ? JSON.stringify(body) : null,
  }).then(r => r.json());
}

let _tid;
function toast(msg, type = 'i') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 't' + type;
  el.style.display = 'block';
  clearTimeout(_tid);
  _tid = setTimeout(() => el.style.display = 'none', 3500);
}

async function loadAccounts() {
  const d = await api('/api/accounts');
  const list = d.accounts || [];
  document.getElementById('s-total').textContent = list.length;
  document.getElementById('acc-count').textContent = list.length;
  const el = document.getElementById('acc-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty">暂无账号，请添加</div>';
    return;
  }
  el.innerHTML = list.map(a => \`
    <div class="acc" id="acc-\${a.index}">
      <div class="acc-idx">\${a.index}</div>
      <div class="acc-info">
        <div class="acc-email" title="\${a.email}">\${a.email}</div>
        <div class="acc-pass">\${a.password}</div>
      </div>
      <span class="acc-status" id="status-\${a.index}">-</span>
      <div class="acc-acts">
        <button class="btn btn-s btn-sm"
          onclick="runOne(\${a.index}, '\${a.email}')">▶</button>
        <button class="btn btn-d btn-sm"
          onclick="delAcc(\${a.index}, '\${a.email}')">删除</button>
      </div>
    </div>
  \`).join('');
}

async function addAccount() {
  const email = document.getElementById('add-email').value.trim();
  const pwd   = document.getElementById('add-pwd').value.trim();
  if (!email || !pwd) { toast('请填写邮箱和密码', 'e'); return; }
  const r = await api('/api/accounts/add', 'POST', { email, password: pwd });
  if (r.error) { toast(r.error, 'e'); return; }
  toast('✅ ' + r.message, 's');
  document.getElementById('add-email').value = '';
  document.getElementById('add-pwd').value = '';
  loadAccounts();
}

async function delAcc(index, email) {
  if (!confirm('确认删除账号：' + email + '？')) return;
  const r = await api('/api/accounts/delete', 'POST', { index });
  if (r.error) { toast(r.error, 'e'); return; }
  toast('✅ 已删除 ' + email, 's');
  loadAccounts();
}

function setAccountStatus(index, result) {
  const el = document.getElementById('status-' + index);
  if (!el) return;
  if (result === 'running') {
    el.innerHTML = '⏳';
    el.className = 'acc-status running';
  } else if (result.success) {
    el.innerHTML = '✅ ' + (result.elapsed ? result.elapsed + 'ms' : '');
    el.className = 'acc-status ok';
  } else {
    el.innerHTML = '❌ ' + (result.error || '失败');
    el.className = 'acc-status fail';
  }
}

async function runOne(index, email) {
  setAccountStatus(index, 'running');
  try {
    const r = await fetch('/run?index=' + index + '&token=' + encodeURIComponent(TOKEN))
      .then(r => r.json());
    setAccountStatus(index, r);
    if (r.success) toast('✅ ' + email + ' 成功 ' + r.elapsed + 'ms', 's');
    else toast('❌ ' + email + '：' + (r.error || '未知错误'), 'e');
    loadStats();
  } catch (e) {
    setAccountStatus(index, { success: false, error: '网络错误' });
    toast('❌ ' + email + '：网络错误', 'e');
  }
}

async function executeSequentially() {
  const d = await api('/api/accounts');
  const list = d.accounts || [];
  if (!list.length) { toast('没有账号可执行', 'e'); return; }
  toast('开始批量执行 ' + list.length + ' 个账号...', 'i');
  document.querySelectorAll('.acc-status').forEach(el => {
    el.textContent = '-';
    el.className = 'acc-status';
  });

  const allResults = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    setAccountStatus(a.index, 'running');
    try {
      const r = await fetch('/run?index=' + a.index + '&token=' + encodeURIComponent(TOKEN))
        .then(r => r.json());
      setAccountStatus(a.index, r);
      allResults.push(r);
    } catch (e) {
      const failResult = { success: false, email: a.email, error: '网络错误' };
      setAccountStatus(a.index, failResult);
      allResults.push(failResult);
    }
    if (i < list.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  try {
    await fetch('/notify?token=' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
      body: JSON.stringify({ results: allResults })
    });
  } catch (e) {}

  const okCount = allResults.filter(r => r.success).length;
  toast('✅ 批量执行完成 ' + okCount + '/' + allResults.length + ' 成功，已发送通知', 's');
  loadStats();
}

async function loadStats() {
  try {
    const stats = await api('/api/stats');
    document.getElementById('s-ok').textContent = stats.success || 0;
    document.getElementById('s-fail').textContent = stats.fail || 0;
  } catch (e) {}
}

loadAccounts();
loadStats();
</script>
</body>
</html>`, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
}
