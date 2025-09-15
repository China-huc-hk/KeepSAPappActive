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
  
  if (envConfig.APP_PING_URL) {
    try {
      await fetch(envConfig.APP_PING_URL, { method: "GET" });
      console.log("[ping] ok");
    } catch (e) {
      console.log("[ping] fail", e?.message || e);
    }
  }
  
  await kvStore.put(lockKey, "1", { expirationTtl: 3600 });
  console.log("[lock] set", lockKey);
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
    
    try {
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
          appName: app.APP_NAME,
          hasGuid: !!app.APP_GUID,
          hasPingUrl: !!app.APP_PING_URL
        }));
        
        return json({ ok: true, apps: apps, total: apps.length });
      }
      
      return new Response("Multi-SAP App Worker is running. Use /apps to list configured applications.");
      
    } catch (err) {
      console.error("[error]", u.pathname, err?.message || err);
      return json({ ok: false, error: String(err), path: u.pathname }, 500);
    }
  }
};