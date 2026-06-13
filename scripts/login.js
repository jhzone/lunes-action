// scripts/login.js
// === 使用 playwright-extra + stealth 插件绕过 Cloudflare Turnstile ===
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import { randomInt } from 'crypto';

// ═══════════════════════════════════════════════════════
// 关键：注册 stealth 插件（深度伪造浏览器指纹，绕过 Cloudflare Turnstile）
// ═══════════════════════════════════════════════════════
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

// ─── 启动浏览器（playwright-extra + stealth 插件已自动注入反检测脚本） ──

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

// ─── 主流程 ───────────────────────────────────────────

async function main() {
  const username = envOrThrow('LUNES_USERNAME');
  const password = envOrThrow('LUNES_PASSWORD');

  const screenshot = (name) => `./${name}.png`;

  const browser = await launchBrowser();
  const context = await createContext(browser);
  const page = await context.newPage();

  try {
    // ═══ 步骤 1：打开登录页 ═══
    log('步骤1', '正在打开登录页面...');
    await page.goto(LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });

    // 给 Cloudflare Turnstile 足够时间完成自动验证
    log('步骤1', '等待页面加载 & Cloudflare 自动验证...');
    await delay(5000, 8000);
    log('步骤1', `当前 URL: ${page.url()}`);

    // ═══ 步骤 2：检测是否被 Cloudflare 拦截 ═══
    log('步骤2', '检查是否存在 Cloudflare 验证...');
    const cfSelectors = [
      'text=/Verify you are human/i',
      'text=/需要验证/i',
      'text=/安全检查/i',
      'text=/review the security/i',
      'text=/Just a moment/i',
      'text=/Checking your browser/i',
      '#challenge-stage',
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="turnstile"]',
      'div[class*="cf-"]',
    ];

    let cfDetected = false;
    let cfReason = '';

    for (const sel of cfSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count({ timeout: 2000 })) {
          cfDetected = true;
          cfReason = sel;
          break;
        }
      } catch { /* selector may not match */ }
    }

    const title = await page.title().catch(() => '');
    if (/Just a moment|Attention Required/i.test(title)) {
      cfDetected = true;
      cfReason = `页面标题包含验证提示: "${title}"`;
    }

    if (cfDetected) {
      log('步骤2', `❌ 检测到 Cloudflare 验证！原因: ${cfReason}`);
      const sp = screenshot('01-cloudflare-block');
      try { await page.screenshot({ path: sp, fullPage: true }); } catch (e) { log('截图失败', e.message); }
      await notifyTelegram({
        ok: false,
        stage: 'Cloudflare拦截',
        msg: `检测到人机验证: ${cfReason}`,
        screenshotPath: sp
      });
      process.exitCode = 2;
      return;
    }
    log('步骤2', '✅ 未检测到 Cloudflare 验证');

    // ═══ 步骤 3：输入用户名密码 ═══
    log('步骤3', '等待登录表单...');
    const userInput = page.locator('input[name="username"], input[type="email"], input#username, input#email').first();
    const passInput = page.locator('input[name="password"], input[type="password"], input#password').first();

    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    await passInput.waitFor({ state: 'visible', timeout: 30_000 });

    // 模拟人类逐字符输入
    await userInput.click();
    await delay(200, 500);

    for (const ch of username) {
      await userInput.press(ch, { delay: randomInt(50, 150) });
    }
    await delay(400, 800);

    await passInput.click();
    await delay(200, 500);

    for (const ch of password) {
      await passInput.press(ch, { delay: randomInt(50, 150) });
    }
    await delay(300, 700);

    log('步骤3', '用户名和密码已输入');

    // ═══ 步骤 4：截图 + 点击登录 ═══
    const loginBtn = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("登录"), button:has-text("Sign in"), input[type="submit"]').first();
    await loginBtn.waitFor({ state: 'visible', timeout: 15_000 });

    const spBefore = screenshot('02-before-submit');
    try { await page.screenshot({ path: spBefore, fullPage: true }); } catch (e) { log('截图失败', e.message); }

    await delay(800, 2000);

    // 点击登录并等待 URL 跳转
    log('步骤4', '点击登录按钮并等待跳转...');
    let navigatedAway = false;
    try {
      await Promise.all([
        page.waitForURL(url => !url.toString().includes('/auth/login'), { timeout: 30_000 }),
        loginBtn.click({ timeout: 10_000 })
      ]);
      navigatedAway = true;
      log('步骤4', '✅ 页面已离开登录页');
    } catch (e) {
      log('步骤4', `URL 跳转等待超时: ${e.message}`);
    }

    // 等待可能的 Cloudflare Turnstile 二次验证完成
    await delay(5000, 8000);

    // 检查点击后是否弹出 Turnstile
    const postClickTitle = await page.title().catch(() => '');
    if (/Just a moment|Attention Required|challenge/i.test(postClickTitle)) {
      log('步骤4', '❌ 提交后触发 Cloudflare Turnstile！尝试等待自动通过...');
      // 给 stealth 插件更多时间自动处理 Turnstile
      await delay(10000, 15000);
      const title2 = await page.title().catch(() => '');
      if (/Just a moment|Attention Required|challenge/i.test(title2)) {
        log('步骤4', '❌ Turnstile 仍未通过');
        const sp = screenshot('04-cf-after-submit');
        try { await page.screenshot({ path: sp, fullPage: true }); } catch (e) { log('截图失败', e.message); }
        await notifyTelegram({
          ok: false,
          stage: 'Cloudflare拦截(登录后)',
          msg: `提交后 Turnstile 验证未通过，页面标题: "${title2}"`,
          screenshotPath: sp
        });
        process.exitCode = 2;
        return;
      }
      log('步骤4', '✅ Turnstile 已自动通过');
    }

    // ═══ 步骤 5：验证登录结果 ═══
    const spAfter = screenshot('03-after-submit');
    try { await page.screenshot({ path: spAfter, fullPage: true }); } catch (e) { log('步骤5截图失败', e.message); }

    const url = page.url();
    log('步骤5', `当前 URL: ${url}`);
    log('步骤5', `页面标题: ${await page.title().catch(() => 'unknown')}`);

    const isOnLoginPage = /\/auth\/login/i.test(url);

    const successUrlPatterns = [
      /\/dashboard/i, /\/server/i, /\/servers/i, /\/home/i,
      /\/admin/i, /\/console/i, /\/panel/i, /\/account/i, /\/overview/i,
    ];
    const urlIndicatesSuccess = successUrlPatterns.some(p => p.test(url));

    const successTextSelectors = [
      'text=/Dashboard/i', 'text=/Logout/i', 'text=/Sign out/i',
      'text=/控制台/i', 'text=/面板/i', 'text=/Servers/i',
      'text=/server/i', 'text=/Overview/i', 'text=/Welcome/i', 'text=/Account/i',
    ];

    let successCount = 0;
    const matchedText = [];
    for (const sel of successTextSelectors) {
      try {
        const count = await page.locator(sel).first().count({ timeout: 2000 });
        if (count > 0) { successCount++; matchedText.push(sel); }
      } catch { /* ignore */ }
    }
    log('步骤5', `匹配成功标识: ${successCount} 个 → ${matchedText.join(', ') || '无'}`);

    const loginSuccess = urlIndicatesSuccess || (!isOnLoginPage && navigatedAway) || successCount >= 1;

    if (!loginSuccess) {
      let errorMsg = '';
      const errorMsgNode = page.locator('text=/Invalid|incorrect|错误|失败|无效|wrong|not found/i');
      try {
        const hasError = await errorMsgNode.count();
        if (hasError > 0) errorMsg = await errorMsgNode.first().innerText().catch(() => '');
      } catch { /* ignore */ }

      let bodyText = '';
      try {
        bodyText = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).substring(0, 500);
      } catch { /* ignore */ }

      log('步骤5', `❌ 登录判定失败，页面片段: ${bodyText}`);

      await notifyTelegram({
        ok: false,
        stage: '登录失败',
        msg: errorMsg
          ? `疑似失败（${errorMsg.trim()}）URL: ${url}`
          : `未匹配成功标识。URL: ${url}，匹配: ${matchedText.join(', ') || '无'}`,
        screenshotPath: spAfter
      });
      process.exitCode = 1;
      return;
    }

    log('步骤5', `✅ 登录成功！当前 URL: ${url}`);

    await notifyTelegram({
      ok: true,
      stage: '登录成功',
      msg: `当前 URL：${url}`,
      screenshotPath: spAfter
    });

    // ── 进入服务器详情 ──
    log('步骤6', '正在进入服务器详情页...');
    const serverLink = page.locator('a[href="/server/5202fe13"]');
    try {
      await serverLink.waitFor({ state: 'visible', timeout: 20_000 });
      await delay(500, 1000);
      await serverLink.click({ timeout: 10_000 });
    } catch {
      log('步骤6', '⚠️ 未找到服务器链接 a[href="/server/5202fe13"]，跳过服务器操作');
      process.exitCode = 0;
      return;
    }

    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    await delay(1000, 2000);

    const spServer = screenshot('04-server-page');
    try { await page.screenshot({ path: spServer, fullPage: true }); } catch (e) { log('截图失败', e.message); }
    await notifyTelegram({
      ok: true,
      stage: '进入服务器页面',
      msg: '已成功打开服务器详情',
      screenshotPath: spServer
    });

    // ── 点击 Console 菜单 ──
    log('步骤7', '点击 Console 菜单...');
    const consoleMenu = page.locator('a[href="/server/5202fe13"].active');
    try {
      await consoleMenu.waitFor({ state: 'visible', timeout: 15_000 });
      await delay(300, 700);
      await consoleMenu.click({ timeout: 5_000 });
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    } catch {
      log('步骤7', '⚠️ 未找到 Console 菜单，尝试其他选择器...');
      const altConsole = page.locator('button:has-text("Console"), a:has-text("Console"), [data-testid="console"]').first();
      if (await altConsole.count({ timeout: 3000 })) {
        await altConsole.click();
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      } else {
        log('步骤7', '⚠️ 无法找到 Console 入口');
      }
    }

    await delay(1500, 3000);

    // ── 点击 Restart 按钮 ──
    log('步骤8', '点击 Restart 按钮...');
    const restartBtn = page.locator('button:has-text("Restart")');
    try {
      await restartBtn.waitFor({ state: 'visible', timeout: 15_000 });
      await delay(500, 1000);
      await restartBtn.click();
      await notifyTelegram({
        ok: true,
        stage: '点击 Restart',
        msg: 'VPS 正在重启'
      });
    } catch {
      log('步骤8', '⚠️ 未找到 Restart 按钮');
      await notifyTelegram({
        ok: true,
        stage: 'Restart 未找到',
        msg: '页面中未发现 Restart 按钮'
      });
    }

    await delay(8000, 12000);

    // ── 输入命令 ──
    log('步骤9', '在 Console 中输入命令...');
    const commandInput = page.locator('input[placeholder="Type a command..."]');
    try {
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
    try { await page.screenshot({ path: spCommand, fullPage: true }); } catch (e) { log('截图失败', e.message); }
    await notifyTelegram({
      ok: true,
      stage: '命令执行完成',
      msg: 'restart 流程已完成',
      screenshotPath: spCommand
    });

    log('完成', '🎉 所有操作已完成');
    process.exitCode = 0;

  } catch (e) {
    log('异常', e?.message || String(e));
    const sp = screenshot('99-error');
    try { await page.screenshot({ path: sp, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({
      ok: false,
      stage: '异常',
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
