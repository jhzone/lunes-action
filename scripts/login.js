// scripts/login.js
// === 使用 playwright-extra + stealth 插件 + Turnstile 交互策略 ===
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import { randomInt } from 'crypto';

chromium.use(StealthPlugin());

const LOGIN_URL = 'https://ctrl.lunes.host/auth/login';

// ─── 工具函数 ─────────────────────────────────────────

const delay = (min = 300, max = 800) =>
  new Promise(r => setTimeout(r, randomInt(min, max)));

function log(label, detail) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${label}`, detail ?? '');
}

// ─── Telegram 通知 ────────────────────────────────────

async function notifyTelegram({ ok, stage, msg, screenshotPath }) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.log('[WARN] TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_ID 未设置，跳过通知');
      return;
    }

    const text = [
      `🔔 Lunes 自动操作：${ok ? '✅ 成功' : '❌ 失败'}`,
      `阶段：${stage}`,
      msg ? `信息：${msg}` : '',
      `时间：${new Date().toISOString()}`
    ].filter(Boolean).join('\n');

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      })
    });

    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const photoUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', `Lunes 自动操作截图（${stage}）`);
      form.append('photo', new Blob([fs.readFileSync(screenshotPath)]), 'screenshot.png');
      await fetch(photoUrl, { method: 'POST', body: form });
    }
  } catch (e) {
    console.log('[WARN] Telegram 通知失败：', e.message);
  }
}

// ─── 环境变量检查 ─────────────────────────────────────

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`环境变量 ${name} 未设置，请在 GitHub Secrets 中配置（Settings → Secrets and variables → Actions）`);
  return v;
}

// ─── 启动浏览器 ───────────────────────────────────────

async function launchBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      '--start-maximized',
      '--use-gl=swiftshader',
      '--enable-webgl',
      '--disable-infobars',
      '--disable-extensions',
      '--lang=en-US,en',
      '--accept-lang=en-US,en;q=0.9',
    ]
  });
  return browser;
}

async function createContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    permissions: ['geolocation'],
    geolocation: { latitude: 31.2304, longitude: 121.4737 },
  });
  return context;
}

// ─── Turnstile 检测与交互 ─────────────────────────────

/** 检测页面中是否存在 Turnstile widget，返回详细信息 */
async function detectTurnstile(page) {
  const info = { found: false, type: '', detail: '' };

  // 检查 iframe（Cloudflare Turnstile 使用 iframe 嵌入）
  const turnstileIframe = page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
  const iframeCount = await turnstileIframe.count().catch(() => 0);
  if (iframeCount > 0) {
    info.found = true;
    info.type = 'iframe';
    info.detail = `找到 ${iframeCount} 个 Turnstile iframe`;
    return info;
  }

  // 检查 cf-turnstile div（Turnstile 的容器）
  const cfTurnstile = page.locator('.cf-turnstile, [data-sitekey], div[id^="cf-chl"], div[id^="cf-turnstile"]');
  const divCount = await cfTurnstile.count().catch(() => 0);
  if (divCount > 0) {
    info.found = true;
    info.type = 'div';
    info.detail = `找到 ${divCount} 个 cf-turnstile 容器`;
    return info;
  }

  // 通过 page.evaluate 检查 window.turnstile 对象
  try {
    const hasTurnstileObj = await page.evaluate(() => {
      return typeof window.turnstile !== 'undefined';
    });
    if (hasTurnstileObj) {
      info.found = true;
      info.type = 'api';
      info.detail = '检测到 window.turnstile API';
      return info;
    }
  } catch { /* ignore */ }

  return info;
}

/** 尝试与 Turnstile 交互（点击 iframe 触发验证）*/
async function interactWithTurnstile(page) {
  log('Turnstile', '尝试与 Turnstile 交互...');

  // 尝试点击 Turnstile iframe 内的 checkbox
  const iframe = page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').first();
  const iframeCount = await iframe.count().catch(() => 0);

  if (iframeCount > 0) {
    try {
      // 切换到 iframe 内部点击 checkbox
      const frame = page.frameLocator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]').first();
      const checkbox = frame.locator('#checkbox, .checkbox, [role="checkbox"], input[type="checkbox"]').first();
      if (await checkbox.count({ timeout: 3000 }).catch(() => 0) > 0) {
        await checkbox.click({ timeout: 5000 }).catch(() => {});
        log('Turnstile', '已点击 Turnstile checkbox');
        return true;
      }

      // 如果找不到 checkbox，尝试点击 body 激活
      const body = frame.locator('body').first();
      if (await body.count({ timeout: 3000 }).catch(() => 0) > 0) {
        await body.click({ timeout: 5000 }).catch(() => {});
        log('Turnstile', '已点击 Turnstile iframe body');
        return true;
      }
    } catch (e) {
      log('Turnstile', `iframe 交互失败: ${e.message}`);
    }
  }

  // 尝试直接点击页面上的 cf-turnstile 容器
  const cfDiv = page.locator('.cf-turnstile').first();
  if (await cfDiv.count({ timeout: 2000 }).catch(() => 0) > 0) {
    try {
      await cfDiv.click({ timeout: 5000 }).catch(() => {});
      log('Turnstile', '已点击 .cf-turnstile 容器');
      return true;
    } catch (e) {
      log('Turnstile', `cf-turnstile 点击失败: ${e.message}`);
    }
  }

  return false;
}

// ─── 主流程 ───────────────────────────────────────────

async function main() {
  const username = envOrThrow('LUNES_USERNAME');
  const password = envOrThrow('LUNES_PASSWORD');

  const screenshot = (name) => `./${name}.png`;

  const browser = await launchBrowser();
  const context = await createContext(browser);
  const page = await context.newPage();

  // 监听网络请求，捕获登录 API 响应
  const loginResponses = [];
  page.on('response', (resp) => {
    const url = resp.url();
    if (/auth\/login|sessions|authenticate|signin/i.test(url) && resp.status() >= 200 && resp.status() < 500) {
      loginResponses.push({ url, status: resp.status(), ok: resp.ok() });
      log('网络', `登录相关响应: ${resp.status()} ${url}`);
    }
  });

  try {
    // ═══ 步骤 1：打开登录页 + 等待 Turnstile ═══
    log('步骤1', '正在打开登录页面...');
    await page.goto(LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });

    // 等待 Turnstile 自动验证完成
    log('步骤1', '等待页面加载 & Turnstile 自动验证...');
    await delay(5000, 8000);

    // 检测 Turnstile
    const tsInfo = await detectTurnstile(page);
    log('步骤1', `Turnstile 检测: ${tsInfo.detail || '未检测到'}`);

    if (tsInfo.found) {
      log('步骤1', '发现 Turnstile，尝试交互...');
      await interactWithTurnstile(page);
      // 给 Turnstile 时间完成验证
      await delay(8000, 12000);

      // 再次检测是否已通过
      const tsInfo2 = await detectTurnstile(page);
      log('步骤1', `交互后 Turnstile 状态: ${tsInfo2.detail || '未检测到（可能已通过）'}`);
    }

    log('步骤1', `当前 URL: ${page.url()}`);

    // ═══ 步骤 2：检测 Cloudflare 全页拦截 ═══
    const title = await page.title().catch(() => '');
    if (/Just a moment|Attention Required/i.test(title)) {
      log('步骤2', '❌ 全页 Cloudflare 拦截，尝试等待...');
      await delay(15000, 20000);
      const title2 = await page.title().catch(() => '');
      if (/Just a moment|Attention Required/i.test(title2)) {
        const sp = screenshot('01-cloudflare-block');
        try { await page.screenshot({ path: sp, fullPage: true }); } catch { /* ignore */ }
        await notifyTelegram({
          ok: false, stage: 'Cloudflare拦截',
          msg: `全页拦截: "${title2}"`, screenshotPath: sp
        });
        process.exitCode = 2;
        return;
      }
    }
    log('步骤2', '✅ 页面可正常访问');

    // ═══ 步骤 3：输入用户名密码 ═══
    log('步骤3', '等待登录表单...');
    const userInput = page.locator('input[name="username"], input[type="email"], input#username, input#email').first();
    const passInput = page.locator('input[name="password"], input[type="password"], input#password').first();

    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    await passInput.waitFor({ state: 'visible', timeout: 30_000 });

    // 先清空输入框（可能有预填值）
    await userInput.click();
    await userInput.fill('');
    await delay(200, 500);

    for (const ch of username) {
      await userInput.press(ch, { delay: randomInt(50, 150) });
    }
    await delay(400, 800);

    await passInput.click();
    await passInput.fill('');
    await delay(200, 500);

    for (const ch of password) {
      await passInput.press(ch, { delay: randomInt(50, 150) });
    }
    await delay(300, 700);

    log('步骤3', '用户名和密码已输入');

    // ═══ 步骤 4：再次检测 Turnstile + 截图 + 多种方式提交 ═══
    // 输入完成后，Turnstile widget 可能已激活
    const tsInfo3 = await detectTurnstile(page);
    log('步骤4', `输入后 Turnstile: ${tsInfo3.detail || '未检测到'}`);

    if (tsInfo3.found) {
      log('步骤4', '尝试点击 Turnstile 完成验证...');
      await interactWithTurnstile(page);
      await delay(5000, 10000);
    }

    const spBefore = screenshot('02-before-submit');
    try { await page.screenshot({ path: spBefore, fullPage: true }); } catch (e) { log('截图失败', e.message); }

    // 方法1：先尝试 Enter 键提交（从密码框按 Enter）
    log('步骤4', '方法1: 在密码框中按 Enter 提交...');
    await passInput.click();
    await delay(300, 600);

    let navigatedAway = false;
    try {
      await Promise.all([
        page.waitForURL(url => !url.toString().includes('/auth/login'), { timeout: 15_000 }),
        passInput.press('Enter')
      ]);
      navigatedAway = true;
      log('步骤4', '✅ Enter 提交成功，页面已跳转');
    } catch (e) {
      log('步骤4', `Enter 提交未跳转: ${e.message}`);
    }

    // 方法2：如果 Enter 没跳转，尝试点击按钮
    if (!navigatedAway) {
      log('步骤4', '方法2: 点击登录按钮...');
      const loginBtn = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("登录"), button:has-text("Sign in"), input[type="submit"]').first();

      try {
        await loginBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await Promise.all([
          page.waitForURL(url => !url.toString().includes('/auth/login'), { timeout: 20_000 }),
          loginBtn.click({ timeout: 10_000 })
        ]);
        navigatedAway = true;
        log('步骤4', '✅ 按钮点击提交成功，页面已跳转');
      } catch (e) {
        log('步骤4', `按钮点击也未跳转: ${e.message}`);
      }
    }

    // 方法3：直接用 JS 提交表单
    if (!navigatedAway) {
      log('步骤4', '方法3: 尝试通过 JS 直接提交表单...');
      try {
        await page.evaluate(() => {
          const form = document.querySelector('form');
          if (form) {
            // 尝试绕过 Turnstile 直接触发 submit
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        });
        await delay(5000, 8000);
        const url = page.url();
        if (!url.includes('/auth/login')) {
          navigatedAway = true;
          log('步骤4', '✅ JS 表单提交成功');
        }
      } catch (e) {
        log('步骤4', `JS 提交失败: ${e.message}`);
      }
    }

    // 等待最终状态稳定
    if (!navigatedAway) {
      await delay(5000, 8000);
    }

    // 检查登录 API 响应
    if (loginResponses.length > 0) {
      const lastResp = loginResponses[loginResponses.length - 1];
      log('步骤4', `登录 API 响应: ${lastResp.status} ${lastResp.url}`);
    }

    // ═══ 步骤 5：验证登录结果 ═══
    const url = page.url();
    const pageTitle = await page.title().catch(() => 'unknown');
    log('步骤5', `最终 URL: ${url}`);
    log('步骤5', `页面标题: ${pageTitle}`);

    const spAfter = screenshot('03-after-submit');
    try { await page.screenshot({ path: spAfter, fullPage: true }); } catch (e) { log('截图失败', e.message); }

    const isOnLoginPage = /\/auth\/login/i.test(url);

    // 宽泛的成功 URL 模式
    const successUrlPatterns = [
      /\/dashboard/i, /\/server/i, /\/servers/i, /\/home/i,
      /\/admin/i, /\/console/i, /\/panel/i, /\/account/i, /\/overview/i,
    ];
    const urlIndicatesSuccess = successUrlPatterns.some(p => p.test(url));

    // 宽泛的成功文字
    const successTextSelectors = [
      'text=/Dashboard/i', 'text=/Logout/i', 'text=/Sign out/i',
      'text=/控制台/i', 'text=/面板/i', 'text=/Servers/i',
      'text=/server/i', 'text=/Overview/i', 'text=/Welcome/i',
      'text=/Account/i', 'text=/Log Out/i', 'text=/logout/i',
      'text=/admin/i',
    ];

    let successCount = 0;
    const matchedText = [];
    for (const sel of successTextSelectors) {
      try {
        const count = await page.locator(sel).first().count({ timeout: 2000 });
        if (count > 0) { successCount++; matchedText.push(sel); }
      } catch { /* ignore */ }
    }

    // 检查是否有成功的 API 响应
    const hasSuccessApi = loginResponses.some(r => r.ok && r.status >= 200 && r.status < 400);

    log('步骤5', `匹配成功标识: ${successCount} → ${matchedText.join(', ') || '无'}`);
    log('步骤5', `URL判断成功: ${urlIndicatesSuccess}, API成功: ${hasSuccessApi}, 离开登录页: ${navigatedAway}`);

    // 宽松判定：三者满足任意一个
    const loginSuccess = urlIndicatesSuccess || (!isOnLoginPage && navigatedAway) || successCount >= 1 || (hasSuccessApi && !isOnLoginPage);

    if (!loginSuccess) {
      let bodyText = '';
      try {
        bodyText = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).substring(0, 500);
      } catch { /* ignore */ }

      log('步骤5', `❌ 登录失败，页面片段: ${bodyText}`);

      await notifyTelegram({
        ok: false,
        stage: '登录失败',
        msg: `未匹配成功标识。URL: ${url}，API响应: ${loginResponses.length ? loginResponses[loginResponses.length - 1].status : '无'}`,
        screenshotPath: spAfter
      });
      process.exitCode = 1;
      return;
    }

    log('步骤5', `✅ 登录成功！URL: ${url}`);
    await notifyTelegram({
      ok: true, stage: '登录成功', msg: `URL: ${url}`, screenshotPath: spAfter
    });

    // ═══ 步骤 6-9：后续服务器操作 ═══
    log('步骤6', '正在进入服务器详情页...');
    const serverLink = page.locator('a[href="/server/5202fe13"]');
    try {
      await serverLink.waitFor({ state: 'visible', timeout: 20_000 });
      await delay(500, 1000);
      await serverLink.click({ timeout: 10_000 });
    } catch {
      log('步骤6', '⚠️ 未找到服务器链接，跳过');
      process.exitCode = 0;
      return;
    }

    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await delay(1000, 2000);

    const spServer = screenshot('04-server-page');
    try { await page.screenshot({ path: spServer, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: true, stage: '进入服务器页面', msg: '已打开服务器详情', screenshotPath: spServer });

    // Console 菜单
    log('步骤7', '点击 Console 菜单...');
    try {
      const consoleMenu = page.locator('a[href="/server/5202fe13"].active, button:has-text("Console"), a:has-text("Console")').first();
      await consoleMenu.waitFor({ state: 'visible', timeout: 15_000 });
      await delay(300, 700);
      await consoleMenu.click({ timeout: 5_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    } catch {
      log('步骤7', '⚠️ 无法找到 Console 入口');
    }

    await delay(1500, 3000);

    // Restart
    log('步骤8', '点击 Restart 按钮...');
    try {
      const restartBtn = page.locator('button:has-text("Restart")');
      await restartBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await delay(500, 1000);
      await restartBtn.click();
      await notifyTelegram({ ok: true, stage: '点击 Restart', msg: 'VPS 正在重启' });
    } catch {
      log('步骤8', '⚠️ 未找到 Restart 按钮');
    }

    await delay(8000, 12000);

    // 命令
    log('步骤9', '在 Console 中输入命令...');
    try {
      const commandInput = page.locator('input[placeholder="Type a command..."]');
      await commandInput.waitFor({ state: 'visible', timeout: 20_000 });
      await delay(200, 500);
      await commandInput.fill('working properly');
      await delay(300, 700);
      await commandInput.press('Enter');
    } catch {
      log('步骤9', '⚠️ 未找到命令行输入框');
    }

    await delay(4000, 6000);

    const spCommand = screenshot('05-command-executed');
    try { await page.screenshot({ path: spCommand, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: true, stage: '命令执行完成', msg: '流程已完成', screenshotPath: spCommand });

    log('完成', '🎉 所有操作已完成');
    process.exitCode = 0;

  } catch (e) {
    log('异常', e?.message || String(e));
    const sp = screenshot('99-error');
    try { await page.screenshot({ path: sp, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({
      ok: false, stage: '异常',
      msg: e?.message || String(e),
      screenshotPath: fs.existsSync(sp) ? sp : undefined
    });
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();
