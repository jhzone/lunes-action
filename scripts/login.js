// scripts/login.js
// === playwright-extra + stealth + Turnstile 等待策略 ===
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
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
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
  if (!v) throw new Error(`环境变量 ${name} 未设置，请在 GitHub Secrets 中配置`);
  return v;
}

// ─── 浏览器 ────────────────────────────────────────────

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080', '--start-maximized',
      '--use-gl=swiftshader', '--enable-webgl',
      '--disable-infobars', '--disable-extensions',
      '--lang=en-US,en', '--accept-lang=en-US,en;q=0.9',
    ]
  });
}

async function createContext(browser) {
  return browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
    permissions: ['geolocation'],
    geolocation: { latitude: 31.2304, longitude: 121.4737 },
  });
}

// ─── Turnstile 等待 — 核心！ ──────────────────────────

/**
 * 等待 Turnstile 验证完成（token 可用 + 按钮 enabled）
 * 返回 { passed, token, duration }
 */
async function waitForTurnstile(page, timeoutMs = 30000) {
  const startTime = Date.now();
  log('Turnstile', '等待 Turnstile 自动验证完成...');

  // 方法A: 轮询 window.turnstile.getResponse() 获取 token
  try {
    const token = await page.waitForFunction(() => {
      if (typeof window.turnstile === 'undefined') return false;
      try {
        const t = window.turnstile.getResponse?.();
        return t && t.length > 0 ? t : false;
      } catch { return false; }
    }, { timeout: timeoutMs, polling: 1000 }).catch(() => null);

    if (token) {
      const elapsed = Date.now() - startTime;
      log('Turnstile', `✅ Token 已获取 (${elapsed}ms): ${(await token.jsonValue()).substring(0, 20)}...`);
      return { passed: true, token: await token.jsonValue(), duration: elapsed };
    }
  } catch { /* 继续尝试其他方法 */ }

  // 方法B: 等待 cf-turnstile-response hidden input 有值
  try {
    const hasValue = await page.waitForFunction(() => {
      const input = document.querySelector('[name="cf-turnstile-response"], input[name*="turnstile"]');
      return input && input.value && input.value.length > 0;
    }, { timeout: 10000, polling: 500 }).catch(() => null);

    if (hasValue) {
      const elapsed = Date.now() - startTime;
      log('Turnstile', `✅ Hidden input 有值 (${elapsed}ms)`);
      return { passed: true, token: 'hidden-input', duration: elapsed };
    }
  } catch { /* ignore */ }

  // 方法C: 等待按钮从 disabled 变为 enabled（最可靠）
  log('Turnstile', 'Token 未获取到，等待按钮变为可点击...');
  try {
    await page.waitForFunction(() => {
      const btns = document.querySelectorAll('button[type="submit"], button:has-text("Login"), button:has-text("登录")');
      for (const b of btns) {
        if (!b.disabled && b.offsetParent !== null) return true;
      }
      return false;
    }, { timeout: Math.max(timeoutMs - (Date.now() - startTime), 5000), polling: 500 });

    const elapsed = Date.now() - startTime;
    log('Turnstile', `✅ 按钮已变为 enabled (${elapsed}ms)`);
    return { passed: true, token: null, duration: elapsed };
  } catch (e) {
    log('Turnstile', `⚠️ 按钮仍未 enabled: ${e.message}`);
  }

  const elapsed = Date.now() - startTime;
  log('Turnstile', `❌ 等待超时 (${elapsed}ms)`);
  return { passed: false, token: null, duration: elapsed };
}

/**
 * 检查提交按钮状态（用于诊断）
 */
async function checkButtonState(page) {
  try {
    const info = await page.evaluate(() => {
      const btns = document.querySelectorAll('button[type="submit"]');
      const results = [];
      for (const b of btns) {
        results.push({
          text: b.innerText?.trim() || b.textContent?.trim() || '',
          disabled: b.disabled,
          visible: b.offsetParent !== null,
          className: b.className,
        });
      }
      return { buttons: results, hasTurnstile: typeof window.turnstile !== 'undefined' };
    });
    log('按钮状态', JSON.stringify(info));
    return info;
  } catch (e) {
    log('按钮状态检查失败', e.message);
    return null;
  }
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
    log('步骤1', '打开登录页面...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // 等待页面充分加载 — 包括 Turnstile 脚本初始化和自动非交互式验证
    log('步骤1', '等待页面加载 & Turnstile 初始化...');
    await delay(5000, 8000);
    log('步骤1', `当前 URL: ${page.url()}`);

    // 检查全页拦截
    const title1 = await page.title().catch(() => '');
    if (/Just a moment|Attention Required/i.test(title1)) {
      log('步骤1', '❌ Cloudflare 全页拦截');
      await delay(15000, 20000);
      if (/Just a moment|Attention Required/i.test(await page.title().catch(() => ''))) {
        await notifyTelegram({ ok: false, stage: 'Cloudflare拦截', msg: '全页拦截未解除' });
        process.exitCode = 2;
        return;
      }
    }
    log('步骤1', '✅ 页面正常');

    // ═══ 步骤 2：第一次 Turnstile 等待 — 页面加载后 ═══
    await checkButtonState(page);
    const tsResult1 = await waitForTurnstile(page, 20000);
    log('步骤2', `Turnstile 初次等待: ${tsResult1.passed ? '通过' : '未通过'}`);

    // ═══ 步骤 3：输入用户名密码 ═══
    log('步骤3', '等待登录表单...');
    const userInput = page.locator('input[name="username"], input[type="email"], input#username').first();
    const passInput = page.locator('input[name="password"], input[type="password"], input#password').first();
    await userInput.waitFor({ state: 'visible', timeout: 30_000 });
    await passInput.waitFor({ state: 'visible', timeout: 30_000 });

    // 清空 + 逐字符输入
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

    // ═══ 步骤 4：等待 Turnstile 完成 + 按钮变为 enabled ═══
    log('步骤4', '等待 Turnstile 自动验证 & 按钮解锁...');

    // 输入文字后 Turnstile 可能重新评估，再等一次
    await checkButtonState(page);
    const tsResult2 = await waitForTurnstile(page, 30000);

    if (!tsResult2.passed) {
      // Turnstile 未通过 — 截图诊断
      const sp = screenshot('04-button-disabled');
      try { await page.screenshot({ path: sp, fullPage: true }); } catch { /* ignore */ }
      await checkButtonState(page);
      log('步骤4', '❌ Turnstile 验证未通过，按钮仍 disabled');
      await notifyTelegram({
        ok: false, stage: 'Turnstile未通过',
        msg: '按钮仍被禁用，Turnstile 验证可能被 headless 模式阻拦',
        screenshotPath: sp
      });
      process.exitCode = 2;
      return;
    }

    log('步骤4', '✅ Turnstile 已通过，按钮已解锁');

    // 截图表单
    const spBefore = screenshot('02-before-submit');
    try { await page.screenshot({ path: spBefore, fullPage: true }); } catch { /* ignore */ }

    // ═══ 步骤 5：点击登录 ═══
    log('步骤5', '点击登录按钮...');
    const loginBtn = page.locator('button[type="submit"]:not([disabled])').first();

    try {
      await loginBtn.waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      // fallback: 使用更宽泛的选择器
      log('步骤5', '主选择器未找到 enabled 按钮，尝试备用选择器...');
    }

    let loginClicked = false;
    // 使用更稳健的点击方式
    const allBtns = [
      page.locator('button[type="submit"]:not([disabled])').first(),
      page.locator('button:has-text("LOGIN"):not([disabled])').first(),
      page.locator('button:has-text("Login"):not([disabled])').first(),
    ];

    for (const btn of allBtns) {
      try {
        const cnt = await btn.count({ timeout: 2000 }).catch(() => 0);
        if (cnt > 0) {
          const isDisabled = await btn.isDisabled().catch(() => true);
          if (!isDisabled) {
            log('步骤5', `找到可点击按钮，开始点击...`);
            await Promise.all([
              page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {}),
              btn.click({ timeout: 5000 })
            ]);
            loginClicked = true;
            break;
          }
        }
      } catch { /* 尝试下一个 */ }
    }

    // 如果 still 按钮被 disabled，尝试 JS 强制启用并提交
    if (!loginClicked) {
      log('步骤5', '所有按钮仍 disabled，尝试 JS 强制提交...');
      try {
        const result = await page.evaluate(() => {
          // 先强制启用按钮
          const btn = document.querySelector('button[type="submit"]');
          if (btn) btn.disabled = false;

          // 尝试触发 Turnstile callback
          if (typeof window.turnstile !== 'undefined' && window.___turnstileCallbacks) {
            // 有些站点会在 Turnstile 成功时调用 callback 来启用按钮
          }

          // 直接提交表单
          const form = document.querySelector('form');
          if (form) {
            form.submit();
            return 'form-submitted';
          }
          return 'no-form';
        });
        log('步骤5', `JS 提交结果: ${result}`);
      } catch (e) {
        log('步骤5', `JS 提交失败: ${e.message}`);
      }
    }

    await delay(5000, 8000);

    // ═══ 步骤 6：验证登录结果 ═══
    const url = page.url();
    const pageTitle = await page.title().catch(() => 'unknown');
    log('步骤6', `URL: ${url}, 标题: ${pageTitle}`);

    const spAfter = screenshot('03-after-login');
    try { await page.screenshot({ path: spAfter, fullPage: true }); } catch { /* ignore */ }

    const isOnLoginPage = /\/auth\/login/i.test(url);
    const successPatterns = [/\/dashboard/i, /\/server/i, /\/servers/i, /\/home/i, /\/admin/i, /\/console/i, /\/panel/i, /\/account/i, /\/overview/i];
    const urlSuccess = successPatterns.some(p => p.test(url));

    const textSelectors = [
      'text=/Dashboard/i', 'text=/Logout/i', 'text=/Sign out/i', 'text=/Log Out/i',
      'text=/控制台/i', 'text=/面板/i', 'text=/Servers/i', 'text=/server/i',
      'text=/Overview/i', 'text=/Welcome/i', 'text=/Account/i',
    ];
    let matchCount = 0;
    for (const sel of textSelectors) {
      try {
        if (await page.locator(sel).first().count({ timeout: 2000 }) > 0) matchCount++;
      } catch { /* ignore */ }
    }

    const loginSuccess = urlSuccess || !isOnLoginPage || matchCount >= 1;

    if (!loginSuccess) {
      let bodyText = '';
      try { bodyText = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).substring(0, 400); } catch { /* ignore */ }
      log('步骤6', `❌ 登录失败，页面片段: ${bodyText}`);
      await notifyTelegram({
        ok: false, stage: '登录失败',
        msg: `URL: ${url}，仍在登录页: ${isOnLoginPage}`,
        screenshotPath: spAfter
      });
      process.exitCode = 1;
      return;
    }

    log('步骤6', `✅ 登录成功！URL: ${url}`);
    await notifyTelegram({ ok: true, stage: '登录成功', msg: `URL: ${url}`, screenshotPath: spAfter });

    // ═══ 后续操作 ═══
    log('步骤7', '进入服务器详情页...');
    try {
      const serverLink = page.locator('a[href="/server/5202fe13"]');
      await serverLink.waitFor({ state: 'visible', timeout: 20_000 });
      await delay(500, 1000);
      await serverLink.click({ timeout: 10_000 });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await delay(1000, 2000);

      const spServer = screenshot('04-server-page');
      try { await page.screenshot({ path: spServer, fullPage: true }); } catch { /* ignore */ }
      await notifyTelegram({ ok: true, stage: '服务器页面', msg: '已打开', screenshotPath: spServer });
    } catch {
      log('步骤7', '⚠️ 未找到服务器链接，流程结束');
      process.exitCode = 0;
      return;
    }

    // Console
    log('步骤8', 'Console...');
    try {
      const consoleMenu = page.locator('button:has-text("Console"), a:has-text("Console")').first();
      if (await consoleMenu.count({ timeout: 5000 }) > 0) {
        await consoleMenu.click();
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      }
    } catch { log('步骤8', '⚠️ Console 未找到'); }
    await delay(1500, 3000);

    // Restart
    log('步骤9', 'Restart...');
    try {
      const restartBtn = page.locator('button:has-text("Restart")');
      await restartBtn.waitFor({ state: 'visible', timeout: 15000 });
      await restartBtn.click();
      await notifyTelegram({ ok: true, stage: 'Restart', msg: 'VPS 重启中' });
    } catch { log('步骤9', '⚠️ Restart 未找到'); }

    await delay(8000, 12000);

    // 命令
    log('步骤10', '输入命令...');
    try {
      const cmdInput = page.locator('input[placeholder="Type a command..."]');
      await cmdInput.waitFor({ state: 'visible', timeout: 20_000 });
      await cmdInput.fill('working properly');
      await cmdInput.press('Enter');
    } catch { log('步骤10', '⚠️ 命令行未找到'); }

    await delay(4000, 6000);
    const spCmd = screenshot('05-done');
    try { await page.screenshot({ path: spCmd, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: true, stage: '完成', msg: '流程结束', screenshotPath: spCmd });

    log('完成', '🎉');
    process.exitCode = 0;

  } catch (e) {
    log('异常', e?.message || String(e));
    const sp = screenshot('99-error');
    try { await page.screenshot({ path: sp, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: false, stage: '异常', msg: e?.message || String(e), screenshotPath: fs.existsSync(sp) ? sp : undefined });
    process.exitCode = 1;
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();
