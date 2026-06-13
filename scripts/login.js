// scripts/login.js
// === 反 Cloudflare 检测的 Playwright 自动登录脚本 ===
import { chromium } from 'playwright';
import fs from 'fs';
import { randomInt } from 'crypto';

const LOGIN_URL = 'https://ctrl.lunes.host/auth/login';

// ─── 工具函数 ─────────────────────────────────────────

/** 随机延迟 (ms)，模拟人类操作间隔 */
const delay = (min = 300, max = 800) =>
  new Promise(r => setTimeout(r, randomInt(min, max)));

/** 可选 Telemetry – 不跑飞 */
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
  if (!v) throw new Error(`环境变量 ${name} 未设置`);
  return v;
}

// ─── 反 Cloudflare 检测的核心配置 ──────────────────────

/**
 * 在页面加载前注入脚本，抹掉自动化痕迹
 * Cloudflare Turnstile 会检查 navigator.webdriver、chrome.runtime 等属性
 */
const STEALTH_INIT_SCRIPT = `
  // 隐藏 webdriver 标记（Playwright/Puppeteer 的特征）
  Object.defineProperty(navigator, 'webdriver', { get: () => false });

  // 伪造 chrome.runtime（让页面以为这是正常 Chrome）
  window.chrome = {
    runtime: {},
    loadTimes: function() {},
    csi: function() {},
    app: {}
  };

  // 伪造权限查询（防止通过 Permissions API 检测自动化）
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);

  // 覆盖 plugins / mimeTypes 长度（headless 通常为空）
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5]
  });
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en']
  });

  // 重写 headless 检测常用的 iframe 方式
  const iframe = document.createElement('iframe');
  iframe.style.display = 'none';
  document.body.appendChild(iframe);
  const contentWindow = iframe.contentWindow;
  if (contentWindow) {
    Object.defineProperty(contentWindow.navigator, 'webdriver', { get: () => false });
  }
`;

/** 启动反检测浏览器 */
async function launchAntiDetectionBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      // ── 基础 ──
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',

      // ── 反检测参数 ──
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-site-isolation-trials',

      // 隐藏 headless 信号
      '--window-size=1920,1080',
      '--start-maximized',

      // 模拟真实 GPU
      '--use-gl=swiftshader',
      '--enable-webgl',

      // 通用 UA 伪装（JS 层面还会覆盖）
      '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',

      // 减少 "Chrome is being controlled by automated software" 信息栏
      '--disable-infobars',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',

      // 语言/地区
      '--lang=en-US,en',
      '--accept-lang=en-US,en;q=0.9',
    ]
  });
  return browser;
}

/** 创建带反检测的新上下文 */
async function createAntiDetectionContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    permissions: ['geolocation'],
    geolocation: { latitude: 31.2304, longitude: 121.4737 },  // 上海
  });

  // 每个新页面都会注入反检测脚本
  await context.addInitScript(STEALTH_INIT_SCRIPT);

  return context;
}

// ─── 主流程 ───────────────────────────────────────────

async function main() {
  const username = envOrThrow('LUNES_USERNAME');
  const password = envOrThrow('LUNES_PASSWORD');

  const screenshot = (name) => `./${name}.png`;

  const browser = await launchAntiDetectionBrowser();
  const context = await createAntiDetectionContext(browser);
  const page = await context.newPage();

  try {
    // ═══ 步骤 1：打开登录页 ═══
    log('步骤1', '正在打开登录页面...');
    await page.goto(LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000
    });

    // 等待页面充分渲染（Cloudflare Turnstile 可能在 document 就绪后动态加载）
    await delay(2000, 4000);
    log('步骤1', `当前 URL: ${page.url()}`);

    // ═══ 步骤 2：检测 Cloudflare 人机验证 ═══
    log('步骤2', '检查是否存在 Cloudflare 验证...');
    const cfSelectors = [
      'text=/Verify you are human/i',
      'text=/需要验证/i',
      'text=/安全检查/i',
      'text=/review the security/i',
      'text=/Just a moment/i',                    // Cloudflare Waiting Room
      'text=/Checking your browser/i',
      '#challenge-stage',                         // Cloudflare Turnstile
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="turnstile"]',
      'div[class*="cf-"]',                        // Cloudflare wrapper
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

    // 也可通过页面标题 + URL 辅助判断
    const title = await page.title().catch(() => '');
    if (/Just a moment|Attention Required/i.test(title)) {
      cfDetected = true;
      cfReason = `页面标题包含验证提示: "${title}"`;
    }

    if (cfDetected) {
      log('步骤2', `❌ 检测到 Cloudflare 验证！原因: ${cfReason}`);
      const sp = screenshot('01-cloudflare-block');
      await page.screenshot({ path: sp, fullPage: true });
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
    const userInput = page.locator('input[name="username"]');
    const passInput = page.locator('input[name="password"]');

    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    await passInput.waitFor({ state: 'visible', timeout: 30_000 });

    // 模拟人类逐字符输入（反检测关键！）
    await userInput.click();
    await delay(200, 500);

    // 逐个字符输入用户名
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

    // ═══ 步骤 4：点击登录 ═══
    const loginBtn = page.locator('button[type="submit"]');
    await loginBtn.waitFor({ state: 'visible', timeout: 15_000 });

    const spBefore = screenshot('02-before-submit');
    await page.screenshot({ path: spBefore, fullPage: true });

    // 等待一小段随机时间（模拟人类阅读页面）
    await delay(800, 2000);

    await loginBtn.click({ timeout: 10_000 });
    log('步骤4', '已点击登录按钮');

    // 等待网络空闲或超时
    try {
      await page.waitForLoadState('networkidle', { timeout: 30_000 });
    } catch {
      log('步骤4', 'networkidle 超时，继续执行');
    }

    await delay(2000, 4000);

    // ═══ 步骤 5：验证登录结果 ═══
    const spAfter = screenshot('03-after-submit');
    await page.screenshot({ path: spAfter, fullPage: true });

    const url = page.url();
    const isOnLoginPage = /\/auth\/login/i.test(url);
    const successElements = [
      'text=/Dashboard/i',
      'text=/Logout/i',
      'text=/Sign out/i',
      'text=/控制台/i',
      'text=/面板/i',
      'text=/Servers/i',
      'text=/server/i',
    ];

    let successCount = 0;
    for (const sel of successElements) {
      try {
        const count = await page.locator(sel).first().count({ timeout: 2000 });
        if (count > 0) successCount++;
      } catch { /* ignore */ }
    }

    const loginSuccess = !isOnLoginPage || successCount > 0;

    if (!loginSuccess) {
      // 登录失败处理
      const errorMsgNode = page.locator('text=/Invalid|incorrect|错误|失败|无效/i');
      const hasError = await errorMsgNode.count();
      const errorMsg = hasError
        ? await errorMsgNode.first().innerText().catch(() => '') : '';

      await notifyTelegram({
        ok: false,
        stage: '登录失败',
        msg: errorMsg
          ? `疑似失败（${errorMsg.trim()}）`
          : `仍在登录页，当前 URL: ${url}`,
        screenshotPath: spAfter
      });
      process.exitCode = 1;
      return;
    }

    log('步骤5', `✅ 登录成功！当前 URL: ${url}`);

    // ═══ 步骤 6：通知登录成功 + 后续操作 ═══
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
    await page.screenshot({ path: spServer, fullPage: true });
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
      // 尝试其他可能的 Console 按钮
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
        msg: '页面中未发现 Restart 按钮，可能服务器已重启或界面不同'
      });
    }

    // 等待 VPS 重启
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
    await page.screenshot({ path: spCommand, fullPage: true });
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
