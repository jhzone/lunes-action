// scripts/login.js
// === HTTP 层登录 — 绕过前端 JS，直接 POST + set-cookie ===
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import { randomInt } from 'crypto';

chromium.use(StealthPlugin());

const LOGIN_URL = 'https://ctrl.lunes.host/auth/login';
const BASE = 'https://ctrl.lunes.host';

const delay = (min = 300, max = 800) => new Promise(r => setTimeout(r, randomInt(min, max)));
function log(label, detail) { console.log(`[${new Date().toISOString()}] ${label}`, detail ?? ''); }

async function notifyTelegram({ ok, stage, msg, screenshotPath }) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    const text = [
      `🔔 Lunes 自动操作：${ok ? '✅ 成功' : '❌ 失败'}`,
      `阶段：${stage}`,
      msg ? `信息：${msg}` : '',
      `时间：${new Date().toISOString()}`
    ].filter(Boolean).join('\n');
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true })
    });
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const form = new FormData();
      form.append('chat_id', chatId);
      form.append('caption', `Lunes 截图（${stage}）`);
      form.append('photo', new Blob([fs.readFileSync(screenshotPath)]), 'screenshot.png');
      await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    }
  } catch (e) { /* ignore */ }
}

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`环境变量 ${name} 未设置`);
  return v;
}

async function launchBrowser() {
  return chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080', '--use-gl=swiftshader', '--enable-webgl',
      '--disable-infobars', '--disable-extensions',
      '--lang=en-US,en', '--accept-lang=en-US,en;q=0.9',
    ]
  });
}

async function createContext(browser) {
  return browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'Asia/Shanghai',
    permissions: ['geolocation'],
    geolocation: { latitude: 31.2304, longitude: 121.4737 },
  });
}

async function main() {
  const username = envOrThrow('LUNES_USERNAME');
  const password = envOrThrow('LUNES_PASSWORD');
  const screenshot = (name) => `./${name}.png`;

  const browser = await launchBrowser();
  const context = await createContext(browser);
  const page = await context.newPage();

  try {
    // ═══ 1. 先访问登录页，获取 CSRF token 和初始 cookie ═══
    log('步骤1', '访问登录页获取 CSRF token...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60_000 });
    await delay(3000, 5000);

    const title1 = await page.title().catch(() => '');
    if (/Just a moment|Attention Required/i.test(title1)) {
      log('步骤1', 'Cloudflare 拦截，等待...');
      await delay(20000, 25000);
      if (/Just a moment|Attention Required/i.test(await page.title().catch(() => ''))) {
        await notifyTelegram({ ok: false, stage: 'Cloudflare', msg: '拦截未解除' });
        process.exitCode = 2; return;
      }
    }

    // ═══ 2. 通过 page.evaluate 发送 fetch POST 登录 ═══
    log('步骤2', '通过 HTTP POST 登录...');

    const loginResult = await page.evaluate(async (user, pass, baseUrl) => {
      // 获取 CSRF token
      const csrfMeta = document.querySelector('meta[name="csrf-token"]');
      const csrfInput = document.querySelector('input[name="_token"]');
      const csrfToken = csrfMeta?.content || csrfInput?.value || '';

      // 构造 form body
      const body = new URLSearchParams();
      body.append('_token', csrfToken);
      body.append('username', user);    // Pterodactyl 用 'username'
      body.append('password', pass);
      body.append('email', user);       // 备用: 有些用 'email'

      const resp = await fetch(baseUrl + '/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,*/*',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-TOKEN': csrfToken,
        },
        body: body.toString(),
        redirect: 'manual',   // 不让 fetch 自动跟随重定向
      });

      return {
        status: resp.status,
        location: resp.headers.get('location') || '',
        setCookie: resp.headers.get('set-cookie') || '',
        redirected: resp.redirected,
        url: resp.url,
      };
    }, username, password, BASE);

    log('步骤2', `登录响应: status=${loginResult.status}, location="${loginResult.location}"`);

    // ═══ 3. 根据响应处理 ═══
    // Pterodactyl 登录成功通常返回 302 → /
    if (loginResult.status === 302 || loginResult.status === 301 || loginResult.status === 303) {
      log('步骤3', `✅ 服务端返回重定向 → ${loginResult.location}`);
      const target = loginResult.location.startsWith('http')
        ? loginResult.location
        : BASE + (loginResult.location.startsWith('/') ? '' : '/') + loginResult.location;
      log('步骤3', `导航到: ${target}`);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    } else if (loginResult.status === 200) {
      // 可能登录失败（返回登录页）
      log('步骤3', '⚠️ POST 返回 200，尝试直接导航到 /...');
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    } else {
      log('步骤3', `意外的响应码: ${loginResult.status}，尝试导航到 /`);
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    }

    await delay(3000, 5000);

    // ═══ 4. 验证是否登录成功 ═══
    const url = page.url();
    const pageTitle = await page.title().catch(() => '?');
    log('步骤4', `当前 URL: ${url}`);
    log('步骤4', `页面标题: ${pageTitle}`);

    const isOnLoginPage = /\/auth\/login/i.test(url);
    const successPatterns = [/\/dashboard/i, /\/server/i, /\/servers/i, /\/home/i, /\/admin/i, /\/console/i, /\/panel/i, /\/account/i, /\/overview/i, /\/nodes/i, /\/locations/i];
    const urlSuccess = successPatterns.some(p => p.test(url));

    const spAfter = screenshot('03-after-login');
    try { await page.screenshot({ path: spAfter, fullPage: true }); } catch { /* ignore */ }

    if (isOnLoginPage && !urlSuccess) {
      // 检查页面中是否有 "Invalid credentials" 等错误
      let errorText = '';
      try {
        errorText = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).substring(0, 300);
      } catch { /* ignore */ }
      log('步骤4', `❌ 登录失败。页面内容: ${errorText}`);
      await notifyTelegram({
        ok: false, stage: '登录失败',
        msg: `HTTP status=${loginResult.status}, URL=${url}, 页面: ${errorText}`,
        screenshotPath: spAfter
      });
      process.exitCode = 1;
      return;
    }

    log('步骤4', `✅ 登录成功！`);
    await notifyTelegram({ ok: true, stage: '登录成功', msg: `URL: ${url}`, screenshotPath: spAfter });

    // ═══ 5-9: 后续操作 ═══
    log('步骤5', '进入服务器页');
    try {
      const link = page.locator('a[href="/server/5202fe13"]');
      await link.waitFor({ state: 'visible', timeout: 20_000 });
      await link.click();
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await delay(1000, 2000);
    } catch {
      log('步骤5', '⚠️ 未找到服务器链接，结束');
      process.exitCode = 0; return;
    }

    const spServer = screenshot('04-server-page');
    try { await page.screenshot({ path: spServer, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: true, stage: '服务器页面', msg: '已打开', screenshotPath: spServer });

    log('步骤6', 'Console');
    try {
      const con = page.locator('button:has-text("Console"), a:has-text("Console")').first();
      if (await con.count({ timeout: 5000 }) > 0) {
        await con.click();
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      }
    } catch { log('步骤6', '⚠️ Console 未找到'); }
    await delay(1500, 3000);

    log('步骤7', 'Restart');
    try {
      const restart = page.locator('button:has-text("Restart")');
      await restart.waitFor({ state: 'visible', timeout: 15_000 });
      await restart.click();
      await notifyTelegram({ ok: true, stage: 'Restart', msg: 'VPS 重启中' });
    } catch { log('步骤7', '⚠️ Restart 未找到'); }
    await delay(8000, 12000);

    log('步骤8', '输入命令');
    try {
      const cmd = page.locator('input[placeholder="Type a command..."]');
      await cmd.waitFor({ state: 'visible', timeout: 20_000 });
      await cmd.fill('working properly');
      await cmd.press('Enter');
    } catch { log('步骤8', '⚠️ 命令行未找到'); }
    await delay(4000, 6000);

    const spDone = screenshot('05-done');
    try { await page.screenshot({ path: spDone, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: true, stage: '完成', msg: '🎉', screenshotPath: spDone });
    log('完成', '🎉');
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
