const pad = n => String(n).padStart(2, "0");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const json = (o, c = 200) => new Response(JSON.stringify(o), { status: c, headers: { "content-type": "application/json" } });

// 辅助函数保持不变
async function cfGET(u, t) {
  const r = await fetch(u, { headers: { authorization: `Bearer ${t}` } });
  const x = await r.text();
  if (!r.ok) throw new Error(`CF GET ${r.status} ${u}: ${x.slice(0, 200)}`);
  return x ? JSON.parse(x) : {};
}

async function cfPOST(u, t, p) {
  const r = await fetch(u, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: p ? JSON.stringify(p) : null });
  const x = await r.text();
  if (!r.ok) throw new Error(`CF POST ${r.status} ${u}: ${x.slice(0, 200)}`);
  return x ? JSON.parse(x) : {};
}

async function getUAAToken(uaaUrl, username, password) {
  const u = uaaUrl.replace(/\/+$/, "");
  const a = "Basic " + btoa("cf:");
  const b = new URLSearchParams();
  b.set("grant_type", "password");
  b.set("username", username);
  b.set("password", password);
  b.set("response_type", "token");
  const r = await fetch(`${u}/oauth/token`, { method: "POST", headers: { authorization: a, "content-type": "application/x-www-form-urlencoded" }, body: b });
  const x = await r.text();
  if (!r.ok) throw new Error(`UAA token error: ${r.status} ${x}`);
  return JSON.parse(x).access_token;
}

async function getAppState(api, tok, gid) {
  const r = await cfGET(`${api}/v3/apps/${gid}`, tok);
  return r?.state || "UNKNOWN";
}

async function getWebProcessGuid(api, tok, gid) {
  const r = await cfGET(`${api}/v3/apps/${gid}/processes`, tok);
  const w = r?.resources?.find(p => p?.type === "web") || r?.resources?.[0];
  if (!w) throw new Error("No process found on app");
  return w.guid;
}

async function getProcessStats(api, tok, pid) {
  return cfGET(`${api}/v3/processes/${pid}/stats`, tok);
}

async function resolveAppGuid(envConfig, tok, api) {
  if (envConfig.APP_GUID) return envConfig.APP_GUID;
  const org = await cfGET(`${api}/v3/organizations?names=${encodeURIComponent(envConfig.ORG_NAME)}`, tok);
  if (!org?.resources?.length) throw new Error("ORG_NAME not found");
  const og = org.resources[0].guid;
  const sp = await cfGET(`${api}/v3/spaces?names=${encodeURIComponent(envConfig.SPACE_NAME)}&organization_guids=${og}`, tok);
  if (!sp?.resources?.length) throw new Error("SPACE_NAME not found");
  const sg = sp.resources[0].guid;
  const apps = await cfGET(`${api}/v3/apps?names=${encodeURIComponent(envConfig.APP_NAME)}&space_guids=${sg}`, tok);
  if (!apps?.resources?.length) throw new Error("APP_NAME not found");
  return apps.resources[0].guid;
}

async function waitAppStarted(api, tok, gid) {
  let d = 2000, s = "";
  for (let i = 0; i < 8; i++) {
    await sleep(d);
    s = await getAppState(api, tok, gid);
    console.log("[app-state-check]", i, s);
    if (s === "STARTED") break;
    d = Math.min(d * 1.6, 15000);
  }
  if (s !== "STARTED") throw new Error(`App not STARTED in time, state=${s}`);
}

async function waitProcessInstancesRunning(api, tok, pid) {
  let d = 2000;
  for (let i = 0; i < 10; i++) {
    const st = await getProcessStats(api, tok, pid);
    const ins = st?.resources || [];
    const states = ins.map(it => it?.state);
    console.log("[proc-stats]", states.join(",") || "no-instances");
    if (states.some(s => s === "RUNNING")) return;
    await sleep(d);
    d = Math.min(d * 1.6, 15000);
  }
  throw new Error("Process instances not RUNNING in time");
}

// 修改后的确保应用运行函数，支持特定应用配置
async function ensureRunning(envConfig, kvStore, { reason = "unknown", force = false, appId = "" } = {}) {
  console.log("[trigger]", reason, appId, new Date().toISOString());
  const ymd = new Date().toISOString().slice(0, 10);
  const lockKey = `start-success-lock:${appId}:${ymd}`;
  
  if (!force) {
    const ex = await kvStore.get(lockKey).catch(() => null);
    if (ex) { console.log("[lock] success-lock exists, skip", lockKey); return; }
  } else {
    console.log("[lock] force=1, ignore success-lock");
  }
  
  const api = envConfig.CF_API.replace(/\/+$/, "");
  const tok = await getUAAToken(envConfig.UAA_URL, envConfig.CF_USERNAME, envConfig.CF_PASSWORD);
  const gid = await resolveAppGuid(envConfig, tok, api);
  const pid = await getWebProcessGuid(api, tok, gid);
  const pre = await getProcessStats(api, tok, pid);
  const st = (pre?.resources || []).map(it => it?.state);
  console.log("[proc-before]", st.join(",") || "no-instances");
  
  if (st.some(s => s === "RUNNING")) {
    console.log("[decision] already RUNNING → nothing to do");
    return;
  }
  
  let appState = await getAppState(api, tok, gid);
  console.log("[app-state-before]", appState);
  
  if (appState !== "STARTED") {
    await cfPOST(`${api}/v3/apps/${gid}/actions/start`, tok);
    console.log("[action] app start requested");
  }
  
  await waitAppStarted(api, tok, gid);
  await waitProcessInstancesRunning(api, tok, pid);
  
  await kvStore.put(lockKey, "1", { expirationTtl: 3540 });
  console.log("[lock] set", lockKey);
  
  // 记录启动成功时间
  const logKey = `start-log:${envConfig.APP_ID || appId}`;
  try {
    const existingLogs = await kvStore.get(logKey, 'json') || [];
    const newLogs = [new Date().toISOString(), ...existingLogs.slice(0, 6)]; // 保留最近7条记录
    await kvStore.put(logKey, JSON.stringify(newLogs));
    console.log("[start-log] recorded", logKey);
  } catch (logError) {
    console.error("[start-log] error:", logError.message);
  }
}

// 定时检查所有应用
async function runAllAppsInSchedule(env, kvStore) {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  
  // 在UTC时间23点到1点（北京时间7点到9点）期间每2分钟检查一次
  // 北京时间 = UTC时间 + 8小时
  if ((utcH === 23 || utcH === 0 || utcH === 1) && utcM % 2 === 0) {
    console.log(`[cron] hit ${pad(utcH)}:${pad(utcM)} UTC (北京时间 ${pad((utcH + 8) % 24)}:${pad(utcM)}) → checking all apps`);
    
    // 并行检查所有应用
    const appsArray = getAllApps(env);
    const appPromises = appsArray.map(async (appConfig, index) => {
      try {
        await ensureRunning(appConfig, kvStore, { reason: "cron", appId: appConfig.APP_ID || `app-${index}` });
      } catch (error) {
        console.error(`[cron-error] app ${index}:`, error.message);
      }
    });
    
    await Promise.allSettled(appPromises);
  } else {
    console.log(`[cron] skip at ${pad(utcH)}:${pad(utcM)} UTC (北京时间 ${pad((utcH + 8) % 24)}:${pad(utcM)})`);
  }
}

// 获取应用配置
function getAppConfig(env, appId) {
  let appsArray;
  
  // 处理APPS环境变量可能是字符串的情况
  if (typeof env.APPS === 'string') {
    try {
      appsArray = JSON.parse(env.APPS);
    } catch (e) {
      throw new Error("APPS environment variable is not valid JSON: " + e.message);
    }
  } else if (Array.isArray(env.APPS)) {
    appsArray = env.APPS;
  } else {
    throw new Error("APPS environment variable not configured properly");
  }
  
  if (!Array.isArray(appsArray)) {
    throw new Error("APPS environment variable must be a JSON array");
  }
  
  if (appId) {
    const app = appsArray.find(a => a.APP_ID === appId);
    if (!app) throw new Error(`App with ID ${appId} not found`);
    return app;
  }
  
  // 如果没有指定appId，返回第一个应用（向后兼容）
  return appsArray[0];
}

// 获取所有应用配置（用于/apps接口）
function getAllApps(env) {
  if (typeof env.APPS === 'string') {
    try {
      return JSON.parse(env.APPS);
    } catch (e) {
      throw new Error("APPS environment variable is not valid JSON: " + e.message);
    }
  } else if (Array.isArray(env.APPS)) {
    return env.APPS;
  } else {
    throw new Error("APPS environment variable not configured properly");
  }
}

export default {
  async scheduled(e, env, ctx) {
    ctx.waitUntil(runAllAppsInSchedule(env, env.START_LOCK));
  },
  
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    
    // 密码验证函数
    function verifyPassword(request) {
      const password = env.FRONTEND_PWD || "moran-+-MIMA"; // 使用FRONTEND_PWD环境变量或默认密码
      
      const authHeader = request.headers.get('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7) === password;
      }
      
      const urlPassword = u.searchParams.get('password');
      return urlPassword === password;
    }
    
    try {
      // 提供前端页面
      if (u.pathname === "/" || u.pathname === "/index.html") {
        return new Response(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel="icon" href="data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBzdGFuZGFsb25lPSJubyI/PjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+PHN2ZyB0PSIxNzU4MjgzMDYyNjE1IiBjbGFzcz0iaWNvbiIgdmlld0JveD0iMCAwIDEwMjQgMTAyNCIgdmVyc2lvbj0iMS4xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHAtaWQ9IjEwMTgxIiB4bWxuczp4bGluaz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94bGluayIgd2lkdGg9IjI1NiIgaGVpZ2h0PSIyNTYiPjxwYXRoIGQ9Ik0wIDBtNTEyIDBsMCAwcTUxMiAwIDUxMiA1MTJsMCAwcTAgNTEyLTUxMiA1MTJsMCAwcS01MTIgMC01MTItNTEybDAgMHEwLTUxMiA1MTItNTEyWiIgZmlsbD0iIzI0RDNCMyIgcC1pZD0iMTAxODIiPjwvcGF0aD48cGF0aCBkPSJNNTE0LjI0NzgwNSAxOTkuODA0ODc4QzM0MC44NTQ2MzQgMTk5LjgwNDg3OCAxOTkuODA0ODc4IDM0MC42NTQ4MjkgMTk5LjgwNDg3OCA1MTMuOTM1NjEgMTk5LjgwNDg3OCA2ODcuMjI4ODc4IDM0MC43NTQ3MzIgODI4LjA2NjM0MSA1MTQuMjQ3ODA1IDgyOC4wNjYzNDFjMTczLjQ5MzA3MyAwIDMxNC40NDI5MjctMTQwLjgzNzQ2MyAzMTQuNDQyOTI3LTMxNC4xMzA3MzFTNjg3Ljc0MDg3OCAxOTkuODA0ODc4IDUxNC4yNDc4MDUgMTk5LjgwNDg3OHogbTM1LjI0MDU4NSA1NjMuMTYyNTM3di00OC43NjQ4NzhjMC0xOC45MTkwMjQtMTYuMjM0MTQ2LTMyLjQ1NTgwNS0zMi41NTU3MDctMzIuNDU1ODA1LTE5LjAwNjQzOSAwLTMyLjU0MzIyIDEzLjUzNjc4LTMyLjU0MzIyIDMyLjQ1NTgwNXY0OC43NjQ4NzhjLTExMy44ODg3OC0xMy41MzY3OC0yMDMuMjY0LTEwMi45MTItMjE2LjkxMzE3LTIxMy44OTExMjJoNDYuMDkyNDg3YzE2LjIzNDE0NiAwIDI5Ljg3MDgyOS0xNi4yMzQxNDYgMjkuODcwODMtMzIuNDU1ODA1IDAtMTguOTA2NTM3LTEzLjUzNjc4LTMyLjQ0MzMxNy0yOS44NzA4My0zMi40NDMzMTdoLTQ4Ljc2NDg3OGMxMy41MzY3OC0xMTMuNzYzOTAyIDEwNS43MDkyNjgtMjAzLjA1MTcwNyAyMTYuOTAwNjgzLTIxNi41ODg0ODh2NDMuMjk1MjE5YzAgMTYuMjM0MTQ2IDEzLjUzNjc4IDMyLjQ1NTgwNSAzMi41NDMyMiAzMi40NTU4MDUgMTYuMjM0MTQ2IDAgMzIuNTQzMjItMTYuMjM0MTQ2IDMyLjU0MzIxOS0zMi40NTU4MDV2LTQzLjI5NTIxOWMxMTEuMTkxNDE1IDEzLjUzNjc4IDIwMC41NzkxMjIgMTAyLjkyNDQ4OCAyMTYuOTEzMTcxIDIxMy45MDM2MWgtNDguNzg5ODU0Yy0xNi4yMjE2NTkgMC0yOS44NDU4NTQgMTMuNTM2NzgtMjkuODQ1ODUzIDMyLjQ0MzMxNyAwIDE2LjIzNDE0NiAxMy41MjQyOTMgMzIuNDQzMzE3IDI5Ljg0NTg1MyAzMi40NDMzMTdoNDguNzc3MzY2Yy0xMy41MzY3OCAxMTAuOTkxNjEtMTAzLjAyNDM5IDIwMC4zNjY4MjktMjE0LjEwMzQxNCAyMTYuNTg4NDg4aC0wLjA5OTkwM3ogbS0xMy41MzY3OC0zMDguNjQ4NTg2bC0xNDYuNDMyLTY3LjY4MzkwMiA2NS4xMTE0MTQgMTQ4LjkwNDU4NWM4LjE1NDUzNyAxMy41MzY3OCAyNC4zNzYxOTUgMzIuNDQzMzE3IDQwLjU5Nzg1NCAzNy45MTI5NzZsMTQ2LjQzMiA2Ny42ODM5MDItNjcuNzgzODA1LTE0OC45MDQ1ODVjLTUuMzY5NzU2LTEzLjUzNjc4LTIxLjcwMzgwNS0zMi40NDMzMTctMzcuOTI1NDYzLTM3LjkxMjk3NnogbS0yLjY4NDg3OCA3OC41MjMzMTdjLTEwLjg2NDM5IDguMTY3MDI0LTI3LjA3MzU2MSA4LjE2NzAyNC0zNS4yNDA1ODYgMC0xMC44NTE5MDItMTAuODM5NDE1LTEwLjg1MTkwMi0yNy4wNjEwNzMgMC0zNy45MTI5NzUgOC4xNjcwMjQtOC4xNjcwMjQgMjQuMzg4NjgzLTguMTY3MDI0IDM1LjI0MDU4NiAwIDEwLjgzOTQxNSAxMC44Mzk0MTUgMTAuODM5NDE1IDI3LjA3MzU2MSAwIDM3LjkxMjk3NXoiIGZpbGw9IiNGRkZGRkYiIHAtaWQ9IjEwMTgzIj48L3BhdGg+PC9zdmc+" type="image/svg+xml">
    <title>SAP应用保活管理</title>
    <style>
        :root {
            --primary: #007bff;
            --success: #28a745;
            --warning: #ffc107;
            --danger: #dc3545;
            --info: #17a2b8;
            --light: #f8f9fa;
            --dark: #343a40;
        }
        
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f5f5f5;
            padding: 20px;
        }
        
        .container {
            max-width: 1200px;
            margin: 0 auto;
        }
        
        header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 1px solid #eee;
        }
        
        h1 {
            color: var(--dark);
            margin-bottom: 10px;
        }
        
        .status-bar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            background: var(--light);
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
        }
        
        .app-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .app-card {
            background: white;
            border: 1px solid #ddd;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
            transition: transform 0.2s ease;
        }
        
        .app-card:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0,0,0,0.15);
        }
        
        .app-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
        }
        
        .app-name {
            font-size: 1.2em;
            font-weight: bold;
            color: var(--dark);
        }
        
        .app-id {
            font-size: 0.9em;
            color: #666;
            background: var(--light);
            padding: 2px 8px;
            border-radius: 12px;
        }
        
        .status-container {
            text-align: center;
            margin: 15px 0;
        }
        
        .status {
            display: inline-block;
            padding: 8px 20px;
            border-radius: 25px;
            font-size: 0.9em;
            font-weight: 600;
            min-width: 100px;
            text-align: center;
        }
        
        .status-started { background: var(--success); color: white; }
        .status-running { background: var(--success); color: white; }
        .status-stopped { background: var(--danger); color: white; }
        .status-starting { background: var(--warning); color: black; }
        .status-unknown { background: transparent; color: #666; }
        
        /* 状态行渐变背景 */
        .status-container.started {
            background: linear-gradient(
                90deg,
                rgba(173, 255, 173, 0.1) 0%,    
                rgba(173, 255, 173, 0.8) 20%,  
                rgba(173, 255, 173, 1) 50%,    
                rgba(173, 255, 173, 0.8) 80%,  
                rgba(173, 255, 173, 0.1) 100%  
            );
            padding: 7px 0;
            margin: 7px -20px;
            border-radius: 0;
        }
        
        .status-container.stopped {
            background: linear-gradient(
                90deg,
                rgba(255, 105, 105, 0.1) 0%,  
                rgba(255, 105, 105, 0.8) 20%,
                rgba(255, 105, 105, 1) 50%,   
                rgba(255, 105, 105, 0.8) 80%,  
                rgba(255, 105, 105, 0.1) 100%  
            );
            padding: 10px 0;
            margin: 10px -20px;
            border-radius: 0;
        }
        
        /* 修改STARTED状态的文字颜色和大小 */
        .status-container.started .status {
            color: #2c7400 !important;
            font-weight: bold;
            font-size: 1.4em;
        }
        
        /* 修改STOPPED状态的文字大小 */
        .status-container.stopped .status {
            font-size: 1.4em;
        }
        
        /* 更明显的动画效果 - 波浪流动 */
        @keyframes waveFlow {
            0% {
                background-position: 0% 50%;
            }
            50% {
                background-position: 100% 50%;
            }
            100% {
                background-position: 0% 50%;
            }
        }
        
        .status-container.started,
        .status-container.stopped {
            background-size: 200% 100%;
            animation: waveFlow 4s ease-in-out infinite;
        }
        
        /* 渐变流动动画 */
        @keyframes gradientFlowStarted {
            0% {
                background: linear-gradient(
                    90deg,
                    rgba(173, 255, 173, 0.1) 0%,    
                    rgba(173, 255, 173, 0.8) 20%,  
                    rgba(173, 255, 173, 1) 50%,    
                    rgba(173, 255, 173, 0.8) 80%,  
                    rgba(173, 255, 173, 0.1) 100%  
                );
            }
            50% {
                background: linear-gradient(
                    90deg,
                    rgba(173, 255, 173, 0.2) 0%,    
                    rgba(173, 255, 173, 0.9) 20%,  
                    rgba(173, 255, 173, 1) 50%,    
                    rgba(173, 255, 173, 0.9) 80%,  
                    rgba(173, 255, 173, 0.2) 100%  
                );
            }
            100% {
                background: linear-gradient(
                    90deg,
                    rgba(173, 255, 173, 0.1) 0%,    
                    rgba(173, 255, 173, 0.8) 20%,  
                    rgba(173, 255, 173, 1) 50%,    
                    rgba(173, 255, 173, 0.8) 80%,  
                    rgba(173, 255, 173, 0.1) 100%  
                );
            }
        }
        
        @keyframes gradientFlowStopped {
            0% {
                background: linear-gradient(
                    90deg,
                    rgba(255, 105, 105, 0.1) 0%,  
                    rgba(255, 105, 105, 0.8) 20%,
                    rgba(255, 105, 105, 1) 50%,   
                    rgba(255, 105, 105, 0.8) 80%,  
                    rgba(255, 105, 105, 0.1) 100%  
                );
            }
            50% {
                background: linear-gradient(
                    90deg,
                    rgba(255, 105, 105, 0.2) 0%,  
                    rgba(255, 105, 105, 0.9) 20%,
                    rgba(255, 105, 105, 1) 50%,   
                    rgba(255, 105, 105, 0.9) 80%,  
                    rgba(255, 105, 105, 0.2) 100%  
                );
            }
            100% {
                background: linear-gradient(
                    90deg,
                    rgba(255, 105, 105, 0.1) 0%,  
                    rgba(255, 105, 105, 0.8) 20%,
                    rgba(255, 105, 105, 1) 50%,   
                    rgba(255, 105, 105, 0.8) 80%,  
                    rgba(255, 105, 105, 0.1) 100%  
                );
            }
        }
        
        /* 确保状态文字在渐变背景上清晰可见 */
        .status-container.started .status,
        .status-container.stopped .status {
            background: transparent !important;
            position: relative;
            z-index: 2;
        }
        
        /* 确保状态容器和实例容器居中 */
        .status-container, .instances {
            text-align: center;
            margin: 15px 0;
        }
        
        /* 确保按钮容器居中 */
        .actions {
            display: flex;
            gap: 10px;
            margin-top: 20px;
            justify-content: center;
        }
        
        /* 实例状态小圆点样式 */
        .instance-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 10px;
        }
        
        .instance-running { background: var(--success); }
        .instance-down { background: var(--danger); }
        .instance-crashed { background: var(--warning); }
        .instance-other { background: #6c757d; }
        
        .instances {
            margin: 15px 0;
            text-align: center;
        }
        
        .instance {
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 8px 0;
            font-size: 0.9em;
        }
        
        .instance-dot {
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 10px;
        }
        
        .instance-running { background: var(--success); }
        .instance-down { background: var(--danger); }
        .instance-crashed { background: var(--warning); }
        .instance-other { background: #6c757d; }
        
        .actions {
            display: flex;
            gap: 10px;
            margin-top: 20px;
            justify-content: center;
        }
        
        button {
            padding: 8px 16px;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-weight: 500;
            transition: all 0.2s ease;
        }
        
        button:disabled {
            opacity: 0.4;
            cursor: not-allowed;
            transform: none !important;
        }
        
        .btn-start:disabled {
            background: #6c757d !important;
            color: white !important;
        }
        
        .btn-stop:disabled {
            background: #6c757d !important;
            color: white !important;
        }
        
        .btn-unlock:disabled {
            background: #6c757d !important;
            color: white !important;
        }
        
        .btn-refresh:disabled {
            background: #6c757d !important;
            color: white !important;
        }
        
        .btn-start { background: var(--success); color: white; }
        .btn-stop { background: var(--danger); color: white; }
        .btn-refresh { background: var(--info); color: white; }
        .btn-unlock { background: var(--warning); color: black; }
        
        button:hover:not(:disabled) {
            opacity: 0.9;
            transform: translateY(-1px);
        }
        
        .loading {
            display: inline-block;
            width: 16px;
            height: 16px;
            border: 2px solid #f3f3f3;
            border-top: 2px solid var(--primary);
            border-radius: 50%;
            animation: spin 1s linear infinite;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .error {
            background: #ffebee;
            color: #c62828;
            padding: 10px;
            border-radius: 4px;
            margin: 10px 0;
            border-left: 4px solid #c62828;
        }
        
        .success {
            background: #e8f5e8;
            color: #2e7d32;
            padding: 10px;
            border-radius: 4px;
            margin: 10px 0;
            border-left: 4px solid #2e7d32;
        }
        
        .last-updated {
            text-align: center;
            color: #666;
            font-size: 0.9em;
            margin-top: 20px;
        }
        
        .start-logs {
            margin-top: 15px;
            padding-top: 15px;
            border-top: 1px solid #eee;
        }
        
        .logs-header {
            font-weight: 600;
            color: #555;
            margin-bottom: 8px;
            font-size: 0.9em;
        }
        
        .logs-content {
            font-size: 0.85em;
            color: #666;
            line-height: 1.4;
        }
        
        .log-entry {
            margin: 3px 0;
            padding-left: 12px;
            position: relative;
        }
        
        .log-entry::before {
            content: "•";
            position: absolute;
            left: 0;
            color: #888;
        }
        
        .log-entry:first-child {
            color: #2e7d32;
            font-weight: 500;
        }
        
        /* 新增底部消息容器样式，仅移动端显示 */
        #message-area-bottom {
            display: none;
        }
        @media (max-width: 768px) {
            #message-area-bottom {
                display: block;
                position: fixed;
                left: 0;
                right: 0;
                bottom: 0;
                z-index: 9999;
                padding: 0 10px 10px 10px;
                pointer-events: none;
            }
            #message-area-bottom > div {
                pointer-events: auto;
                max-width: 96vw;
                margin: 0 auto;
            }
        }
        
        /* 移动设备响应式样式 */
        @media (max-width: 768px) {
            .app-grid {
                grid-template-columns: 1fr;
            }
            
            .status-bar {
                flex-direction: column;
                align-items: stretch;
                gap: 12px;
                padding: 15px;
            }
            
            .status-bar > div {
                text-align: center;
            }
            
            .password-section {
                display: flex;
                flex-direction: row;
                gap: 8px;
                align-items: center;
                justify-content: center;
            }
            
            #password-input {
                flex: 1;
                min-width: 120px;
                max-width: 200px;
            }
            
            #refresh-all {
                width: 100%;
                max-width: 280px;
                margin: 0 auto;
            }
            
            .app-header {
                display: flex;
                flex-direction: column;
                gap: 6px;
                margin-bottom: 12px;
            }
            
            .app-name {
                text-align: left;
                font-size: 1.1em;
                line-height: 1.2;
            }
            
            .app-id {
                text-align: right;
                font-size: 0.85em;
                margin-top: 0;
                line-height: 1.2;
            }
            
            .status-container {
                margin: 10px -15px;
            }
            
            .status-container.started,
            .status-container.stopped {
                padding: 8px 0;
            }
            
            .actions {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 8px;
                margin-top: 15px;
            }
            
            .actions button {
                width: 100%;
                min-width: auto;
                max-width: none;
                padding: 8px 12px;
            }
        }
        
        /* 更小的移动设备 */
        @media (max-width: 480px) {
            
            .status-bar {
                padding: 12px;
                gap: 10px;
            }
            
            .password-section {
                flex-direction: column;
                gap: 6px;
            }
            
            #password-input {
                width: 100%;
                max-width: 180px;
            }
            
            .app-card {
                padding: 12px;
            }
            
            .app-header {
                gap: 4px;
            }
            
            .app-name {
                font-size: 1em;
            }
            
            .app-id {
                font-size: 0.8em;
            }
            
            .actions {
                gap: 6px;
            }
            
            .actions button {
                padding: 6px 10px;
                font-size: 0.9em;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>SAP应用保活管理系统</h1>
            <p><a href="https://github.com/hcllmsx/KeepSAPappActive" target="_blank" style="color: #007bff; text-decoration: none;">项目地址：KeepSAPappActive</a></p>
        </header>
        
        <div class="status-bar">
            <div>
                <strong>Worker状态:</strong> 
                <span id="worker-status">运行中</span>
            </div>
            <div>
                <strong>最后更新:</strong> 
                <span id="last-update">--:--:--</span>
            </div>
            <div class="password-section">
                <input type="text" id="password-input" placeholder="输入操作密码" style="padding: 8px; border: 1px solid #ddd; border-radius: 4px; margin-right: 10px;">
                <button id="set-password" class="btn-refresh" style="background-color: #bc80ba; color: white;" title="关闭网页后需要再次输入密码并进行暂存">暂存密码</button>
            </div>
            <button id="refresh-all" class="btn-refresh">刷新所有状态</button>
        </div>
        
        <div id="message-area"></div>
        <!-- 新增底部消息容器，仅移动端显示 -->
        <div id="message-area-bottom"></div>
        
        <div class="app-grid" id="apps-container">
            <div class="loading-placeholder">加载中...</div>
        </div>
        
        <div class="last-updated">
            系统时间: <span id="system-time">--:--:--</span>
        </div>

    </div>

    <script>
        class SAPAppManager {
            constructor() {
                this.apps = [];
                this.baseUrl = window.location.origin;
                this.password = '';
                this.init();
            }
            
            async init() {
                await this.loadApps();
                this.startAutoRefresh();
                this.setupEventListeners();
                this.updateSystemTime();
            }
            
            // 带密码验证的fetch请求
            async fetchWithAuth(url, options = {}) {
                if (this.password) {
                    const urlObj = new URL(url);
                    urlObj.searchParams.set('password', this.password);
                    url = urlObj.toString();
                }
                return fetch(url, options);
            }
            
            async loadApps() {
                try {
                    const response = await this.fetchWithAuth(\`\${this.baseUrl}/apps\`);
                    const data = await response.json();
                    
                    if (data.ok) {
                        this.apps = data.apps;
                        this.renderApps();
                    } else if (data.error === '密码验证失败') {
                        this.showError('密码验证失败，请设置正确密码');
                    } else {
                        this.showError('获取应用列表失败');
                    }
                } catch (error) {
                    this.showError('网络错误: ' + error.message);
                }
            }
            
            async getAppState(appId) {
                try {
                    const response = await this.fetchWithAuth(\`\${this.baseUrl}/state?appId=\${encodeURIComponent(appId)}\`);
                    return await response.json();
                } catch (error) {
                    console.error('获取应用状态失败:', error);
                    return null;
                }
            }
            
            async startApp(appId, force = false) {
                const card = document.getElementById(\`app-\${appId}\`);
                if (!card) return;
                
                const startBtn = card.querySelector('.btn-start');
                const originalText = startBtn.innerHTML;
                startBtn.innerHTML = '<div class="loading"></div>';
                startBtn.disabled = true;
                
                try {
                    const url = \`\${this.baseUrl}/start?appId=\${encodeURIComponent(appId)}\${force ? '&force=1' : ''}\`;
                    const response = await this.fetchWithAuth(url);
                    const data = await response.json();
                    
                    if (data.ok) {
                        this.showSuccess(\`应用 \${appId} 启动请求已发送\`);
                        // 等待一段时间后刷新状态
                        setTimeout(() => this.refreshAppState(appId), 3000);
                    } else if (data.error === '密码验证失败') {
                        this.showError('密码验证失败，请设置正确密码');
                    } else {
                        this.showError(\`启动应用 \${appId} 失败\`);
                    }
                } catch (error) {
                    this.showError('启动请求失败: ' + error.message);
                } finally {
                    startBtn.innerHTML = originalText;
                    startBtn.disabled = false;
                }
            }
            
            async stopApp(appId) {
                const card = document.getElementById(\`app-\${appId}\`);
                if (!card) return;
                
                const stopBtn = card.querySelector('.btn-stop');
                const originalText = stopBtn.innerHTML;
                stopBtn.innerHTML = '<div class="loading"></div>';
                stopBtn.disabled = true;
                
                try {
                    const response = await this.fetchWithAuth(\`\${this.baseUrl}/stop?appId=\${encodeURIComponent(appId)}\`);
                    const data = await response.json();
                    
                    if (data.ok) {
                        this.showSuccess(\`应用 \${appId} 停止请求已发送\`);
                        // 等待一段时间后刷新状态
                        setTimeout(() => this.refreshAppState(appId), 3000);
                    } else if (data.error === '密码验证失败') {
                        this.showError('密码验证失败，请设置正确密码');
                    } else {
                        this.showError(\`停止应用 \${appId} 失败\`);
                    }
                } catch (error) {
                    this.showError('停止请求失败: ' + error.message);
                } finally {
                    stopBtn.innerHTML = originalText;
                    stopBtn.disabled = false;
                }
            }
            
            async unlockApp(appId) {
                const card = document.getElementById(\`app-\${appId}\`);
                if (!card) return;
                
                const unlockBtn = card.querySelector('.btn-unlock');
                const originalText = unlockBtn.innerHTML;
                unlockBtn.innerHTML = '<div class="loading"></div>';
                unlockBtn.disabled = true;
                
                try {
                    const response = await this.fetchWithAuth(\`\${this.baseUrl}/unlock?appId=\${encodeURIComponent(appId)}\`);
                    const data = await response.json();
                    
                    if (data.ok) {
                        this.showSuccess(\`应用 \${appId} 已解锁\`);
                    } else if (data.error === '密码验证失败') {
                        this.showError('密码验证失败，请设置正确密码');
                    } else {
                        this.showError(\`解锁应用 \${appId} 失败\`);
                    }
                } catch (error) {
                    this.showError('解锁请求失败: ' + error.message);
                } finally {
                    unlockBtn.innerHTML = originalText;
                    unlockBtn.disabled = false;
                }
            }
            
            async refreshAppState(appId) {
                const card = document.getElementById(\`app-\${appId}\`);
                if (card) {
                    const refreshBtn = card.querySelector('.btn-refresh');
                    const originalText = refreshBtn.innerHTML;
                    refreshBtn.innerHTML = '<div class="loading"></div>';
                    
                    const state = await this.getAppState(appId);
                    if (state && state.ok) {
                        this.updateAppCard(appId, state);
                    }
                    
                    // 同时加载启动记录
                    await this.loadStartLogs(appId);
                    
                    refreshBtn.innerHTML = originalText;
                }
            }
            
            renderApps() {
                const container = document.getElementById('apps-container');
                container.innerHTML = '';
                
                if (this.apps.length === 0) {
                    container.innerHTML = '<div class="error">未配置任何应用</div>';
                    return;
                }
                
                this.apps.forEach(app => {
                    const card = document.createElement('div');
                    card.className = 'app-card';
                    card.id = \`app-\${app.appId}\`;
                    card.innerHTML = this.getAppCardHTML(app);
                    container.appendChild(card);
                });
                
                // 初始加载所有应用状态和启动记录
                this.apps.forEach(app => {
                    this.refreshAppState(app.appId);
                    this.loadStartLogs(app.appId);
                });
            }
            
            getAppCardHTML(app) {
                return \`
                    <div class="app-header">
                        <div class="app-name">\${app.appName || '未命名应用'}</div>
                        <div class="app-id">\${app.appId}</div>
                    </div>
                    
                    <div class="status-container">
                        <span class="status status-unknown">加载中...</span>
                    </div>
                    
                    <div class="instances">
                        <div>实例状态: 加载中...</div>
                    </div>
                    
                    <div class="actions">
                        <button class="btn-start" onclick="appManager.startApp('\${app.appId}')">启动</button>
                        <button class="btn-stop" onclick="appManager.stopApp('\${app.appId}')">停止</button>
                        <button class="btn-refresh" onclick="appManager.refreshAppState('\${app.appId}')">刷新</button>
                        <button class="btn-unlock" onclick="appManager.unlockApp('\${app.appId}')">解锁</button>
                    </div>
                    
                    <div class="start-logs" id="logs-\${app.appId}">
                        <div class="logs-header">最近启动记录:</div>
                        <div class="logs-content">加载中...</div>
                    </div>
                \`;
            }
            
            updateAppCard(appId, state) {
                const card = document.getElementById(\`app-\${appId}\`);
                if (!card) return;
                
                // 更新应用状态
                const statusEl = card.querySelector('.status');
                const statusContainer = card.querySelector('.status-container');
                const appState = state.appState?.toLowerCase() || 'unknown';
                // 将"started"映射到"started"类，而不是"running"
                const statusClass = appState === 'started' ? 'started' : appState;
                statusEl.className = \`status status-\${statusClass}\`;
                statusEl.textContent = state.appState || 'UNKNOWN';
                
                // 更新状态容器的背景渐变
                statusContainer.className = 'status-container';
                if (appState === 'started') {
                    statusContainer.classList.add('started');
                } else if (appState === 'stopped') {
                    statusContainer.classList.add('stopped');
                }
                
                // 更新实例状态
                const instancesEl = card.querySelector('.instances');
                if (state.instances && state.instances.length > 0) {
                    instancesEl.innerHTML = state.instances.map(instance => \`
                        <div class="instance">
                            <div class="instance-dot instance-\${instance.state?.toLowerCase() || 'other'}"></div>
                            实例 \${instance.index}: \${instance.state || 'UNKNOWN'}
                        </div>
                    \`).join('');
                } else {
                    instancesEl.innerHTML = '<div>无运行实例</div>';
                }
                
                // 更新按钮状态
                this.updateButtonStates(appId, state.appState);
                
                // 更新最后更新时间
                this.updateLastUpdated();
            }
            
            updateButtonStates(appId, appState) {
                const card = document.getElementById(\`app-\${appId}\`);
                if (!card) return;
                
                const startBtn = card.querySelector('.btn-start');
                const stopBtn = card.querySelector('.btn-stop');
                
                // 根据应用状态启用/禁用按钮
                if (appState === 'STARTED' || appState === 'RUNNING') {
                    startBtn.disabled = true;
                    stopBtn.disabled = false;
                } else if (appState === 'STOPPED') {
                    startBtn.disabled = false;
                    stopBtn.disabled = true;
                } else {
                    // 未知状态时都启用
                    startBtn.disabled = false;
                    stopBtn.disabled = false;
                }
            }
            
            showError(message) {
                this.showMessage(message, 'error');
            }
            
            showSuccess(message) {
                this.showMessage(message, 'success');
            }
            
            showMessage(message, type) {
                // 判断是否为移动端
                const isMobile = window.innerWidth <= 768;
                const messageArea = isMobile
                    ? document.getElementById('message-area-bottom')
                    : document.getElementById('message-area');
                const messageEl = document.createElement('div');
                messageEl.className = type;
                messageEl.textContent = message;
                messageArea.appendChild(messageEl);

                // 5秒后自动消失
                setTimeout(() => {
                    messageEl.remove();
                }, 5000);
            }
            
            updateLastUpdated() {
                const now = new Date();
                const timeStr = now.toLocaleTimeString('zh-CN');
                document.getElementById('last-update').textContent = timeStr;
            }
            
            updateSystemTime() {
                const now = new Date();
                const timeStr = now.toLocaleString('zh-CN');
                document.getElementById('system-time').textContent = timeStr;
                
                // 每秒更新一次系统时间
                setTimeout(() => this.updateSystemTime(), 1000);
            }
            
            async loadStartLogs(appId) {
                try {
                    const response = await this.fetchWithAuth(\`\${this.baseUrl}/start-logs?appId=\${encodeURIComponent(appId)}&limit=7\`);
                    const data = await response.json();
                    
                    const logsContainer = document.getElementById(\`logs-\${appId}\`)?.querySelector('.logs-content');
                    if (!logsContainer) return;
                    
                    if (data.ok && data.logs.length > 0) {
                        logsContainer.innerHTML = data.logs.map((log, index) => {
                            const date = new Date(log);
                            const now = new Date();
                            const isToday = date.toDateString() === now.toDateString();
                            const isYesterday = new Date(now.setDate(now.getDate() - 1)).toDateString() === date.toDateString();
                            
                            let timeText;
                            if (isToday) {
                                timeText = \`今天 \${date.toLocaleTimeString('zh-CN')}\`;
                            } else if (isYesterday) {
                                timeText = \`昨天 \${date.toLocaleTimeString('zh-CN')}\`;
                            } else {
                                timeText = \`\${date.getMonth() + 1}月\${date.getDate()}日 \${date.toLocaleTimeString('zh-CN')}\`;
                            }
                            
                            return \`<div class="log-entry">\${timeText}</div>\`;
                        }).join('');
                    } else {
                        logsContainer.innerHTML = '<div class="log-entry">暂无记录</div>';
                    }
                } catch (error) {
                    console.error('加载启动记录失败:', error);
                    const logsContainer = document.getElementById(\`logs-\${appId}\`)?.querySelector('.logs-content');
                    if (logsContainer) {
                        logsContainer.innerHTML = '<div class="log-entry">加载失败</div>';
                    }
                }
            }
            
            startAutoRefresh() {
                // 每30秒自动刷新所有应用状态
                setInterval(() => {
                    this.apps.forEach(app => this.refreshAppState(app.appId));
                }, 30000);
            }
            
            setupEventListeners() {
                document.getElementById('refresh-all').addEventListener('click', () => {
                    this.apps.forEach(app => this.refreshAppState(app.appId));
                    this.showSuccess('正在刷新所有应用状态...');
                });
                
                document.getElementById('set-password').addEventListener('click', () => {
                    const passwordInput = document.getElementById('password-input');
                    this.password = passwordInput.value;
                    passwordInput.value = '';
                    this.showSuccess('密码已设置');
                    
                    // 重新加载应用状态
                    this.apps.forEach(app => this.refreshAppState(app.appId));
                });
            }
        }
        
        // 初始化应用管理器
        const appManager = new SAPAppManager();
    </script>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      
      // 获取所有应用状态
      if (u.pathname === "/state") {
        const appId = u.searchParams.get("appId");
        const appConfig = getAppConfig(env, appId);
        const t = await getUAAToken(appConfig.UAA_URL, appConfig.CF_USERNAME, appConfig.CF_PASSWORD);
        const a = appConfig.CF_API.replace(/\/+$/, "");
        const g = await resolveAppGuid(appConfig, t, a);
        const s = await getAppState(a, t, g);
        const p = await getWebProcessGuid(a, t, g).catch(() => null);
        const st = p ? await getProcessStats(a, t, p) : null;
        
        return json({
          ok: true,
          appId: appConfig.APP_ID,
          appGuid: g,
          appState: s,
          instances: (st?.resources || []).map(it => ({ index: it?.index, state: it?.state }))
        });
      }
      
      // 启动指定应用
      if (u.pathname === "/start") {
        const appId = u.searchParams.get("appId");
        const force = u.searchParams.get("force") === "1";
        const appConfig = getAppConfig(env, appId);
        
        ctx.waitUntil(ensureRunning(appConfig, env.START_LOCK, {
          reason: "manual",
          force: force,
          appId: appConfig.APP_ID || appId
        }));
        
        return json({ ok: true, msg: "start requested", appId: appConfig.APP_ID, force: force });
      }
      
      // 停止指定应用
      if (u.pathname === "/stop") {
        if (!verifyPassword(req)) {
          return json({ ok: false, error: "密码验证失败" }, 401);
        }
        
        const appId = u.searchParams.get("appId");
        const appConfig = getAppConfig(env, appId);
        const t = await getUAAToken(appConfig.UAA_URL, appConfig.CF_USERNAME, appConfig.CF_PASSWORD);
        const a = appConfig.CF_API.replace(/\/+$/, "");
        const g = await resolveAppGuid(appConfig, t, a);
        
        await cfPOST(`${a}/v3/apps/${g}/actions/stop`, t);
        return json({ ok: true, msg: "stop requested", appId: appConfig.APP_ID });
      }
      
      // 诊断接口
      if (u.pathname === "/diag") {
        const appId = u.searchParams.get("appId");
        const appConfig = getAppConfig(env, appId);
        const t = await getUAAToken(appConfig.UAA_URL, appConfig.CF_USERNAME, appConfig.CF_PASSWORD);
        const a = appConfig.CF_API.replace(/\/+$/, "");
        
        return json({
          ok: true,
          appId: appConfig.APP_ID,
          token_len: t?.length || 0,
          api: a,
          totalApps: env.APPS ? env.APPS.length : 0
        });
      }
      
      // 解锁指定应用
      if (u.pathname === "/unlock") {
        if (!verifyPassword(req)) {
          return json({ ok: false, error: "密码验证失败" }, 401);
        }
        
        const appId = u.searchParams.get("appId");
        const appConfig = getAppConfig(env, appId);
        const y = new Date().toISOString().slice(0, 10);
        const k = `start-success-lock:${appConfig.APP_ID || appId}:${y}`;
        
        await env.START_LOCK.delete(k);
        return json({ ok: true, deleted: k, appId: appConfig.APP_ID });
      }
      
      // 列出所有应用
      if (u.pathname === "/apps") {
        const appsArray = getAllApps(env);
        const apps = appsArray.map((app, index) => ({
          appId: app.APP_ID || `app-${index}`,
          appName: app.APP_NAME || '未命名应用',
          hasGuid: !!app.APP_GUID
        }));
        
        return json({ ok: true, apps: apps, total: apps.length });
      }
      
      // 获取启动记录
      if (u.pathname === "/start-logs") {
        const appId = u.searchParams.get("appId");
        const limit = parseInt(u.searchParams.get("limit")) || 7;
        
        if (!appId) {
          return json({ ok: false, error: "appId parameter required" }, 400);
        }
        
        const logKey = `start-log:${appId}`;
        const logs = await env.START_LOCK.get(logKey, 'json') || [];
        const limitedLogs = logs.slice(0, limit);
        
        return json({ 
          ok: true, 
          appId: appId,
          logs: limitedLogs,
          total: logs.length
        });
      }
      
      return new Response("Multi-SAP App Worker is running. Use /apps to list configured applications.");
      
    } catch (err) {
      console.error("[error]", u.pathname, err?.message || err);
      return json({ ok: false, error: String(err), path: u.pathname }, 500);
    }
  }
};