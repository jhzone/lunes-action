// scripts/login.js
// === 提取完整表单数据 + fetch POST 登录 ===
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
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
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
    // ═══ 1. 打开登录页 ═══
    log('步骤1', '打开登录页...');
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

    // ═══ 2. 提取表单全部字段 + 真正的 action URL ═══
    log('步骤2', '提取表单元数据...');

    const formMeta = await page.evaluate(() => {
      const form = document.querySelector('form');
      if (!form) return { error: '未找到表单' };

      const action = form.action || window.location.href;
      const method = (form.method || 'POST').toUpperCase();

      // 提取所有 input 字段（包括 hidden）
      const fields = [];
      const inputs = form.querySelectorAll('input');
      inputs.forEach(inp => {
        fields.push({
          name: inp.name,
          type: inp.type,
          value: inp.value || '',
          placeholder: inp.placeholder || '',
        });
      });

      return { action, method, fields };
    });

    log('步骤2', `表单: ${formMeta.method} ${formMeta.action}`);
    log('步骤2', `字段: ${formMeta.fields?.map(f => `${f.name}(${f.type})`).join(', ') || '无'}`);

    if (formMeta.error) {
      log('步骤2', `❌ ${formMeta.error}`);
      process.exitCode = 1; return;
    }

    // ═══ 3. 构造并发送登录请求 ═══
    log('步骤3', '发送登录 POST...');

    const loginResult = await page.evaluate(async (args) => {
      const { formAction, formMethod, fields, user, pass } = args;

      // 构造 body — 使用实际表单字段名
      const body = new URLSearchParams();

      for (const field of fields) {
        if (field.name === 'username' || field.name === 'email' || field.name === 'user') {
          body.append(field.name, user);
        } else if (field.name === 'password' || field.name === 'pass') {
          body.append(field.name, pass);
        } else if (field.name && field.name !== '') {
          body.append(field.name, field.value);
        }
      }

      // 如果没有找到 username/password 字段，手动添加
      if (!body.has('username') && !body.has('email') && !body.has('user')) {
        body.append('username', user);
      }
      if (!body.has('password') && !body.has('pass')) {
        body.append('password', pass);
      }

      const loginUrl = formAction || (window.location.origin + '/auth/login');

      const resp = await fetch(loginUrl, {
        method: formMethod || 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'text/html,application/xhtml+xml,*/*',
        },
        body: body.toString(),
        redirect: 'manual',
      });

      return {
        status: resp.status,
        location: resp.headers.get('location') || '',
        url: resp.url,
        bodyKeys: Array.from(body.keys()),
      };
    }, {
      formAction: formMeta.action,
      formMethod: formMeta.method,
      fields: formMeta.fields,
      user: username,
      pass: password
    });

    log('步骤3', `响应: status=${loginResult.status}, fields=${loginResult.bodyKeys.join(',')}`);
    log('步骤3', `location: "${loginResult.location}"`);

    // ═══ 4. 根据响应导航 ═══
    if (loginResult.status >= 300 && loginResult.status < 400 && loginResult.location) {
      log('步骤4', `✅ 重定向 → ${loginResult.location}`);
      const target = loginResult.location.startsWith('http')
        ? loginResult.location
        : BASE + (loginResult.location.startsWith('/') ? '' : '/') + loginResult.location;
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    } else if (loginResult.status === 200) {
      log('步骤4', '返回 200，导航到 /');
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    } else {
      log('步骤4', `状态码 ${loginResult.status}，检查页面...`);
      // 可能 500 是 CSRF 失败，尝试先导航 login URL 看 session 是否生效
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    }

    await delay(3000, 5000);

    // ═══ 5. 验证登录 ═══
    const url = page.url();
    const pageTitle = await page.title().catch(() => '?');
    log('步骤5', `URL: ${url}, 标题: ${pageTitle}`);

    const isOnLoginPage = /\/auth\/login/i.test(url);
    const successPatterns = [/\/dashboard/i, /\/server/i, /\/servers/i, /\/home/i, /\/admin/i, /\/console/i, /\/panel/i, /\/account/i, /\/overview/i, /\/nodes/i, /\/locations/i];
    const urlSuccess = successPatterns.some(p => p.test(url));

    const spAfter = screenshot('03-after-login');
    try { await page.screenshot({ path: spAfter, fullPage: true }); } catch { /* ignore */ }

    if (isOnLoginPage && !urlSuccess) {
      let snippet = '';
      try { snippet = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).substring(0, 300); } catch { /* ignore */ }
      log('步骤5', `❌ 仍在登录页。片段: ${snippet}`);
      await notifyTelegram({
        ok: false, stage: '登录失败',
        msg: `status=${loginResult.status}, URL=${url}`,
        screenshotPath: spAfter
      });
      process.exitCode = 1;
      return;
    }

    log('步骤5', '✅ 登录成功！');
    await notifyTelegram({ ok: true, stage: '登录成功', msg: `URL: ${url}`, screenshotPath: spAfter });

    // ═══ 后续操作 ═══
    log('步骤6', '进入服务器页');
    try {
      const link = page.locator('a[href="/server/5202fe13"]');
      await link.waitFor({ state: 'visible', timeout: 20_000 });
      await link.click();
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await delay(1000, 2000);
    } catch {
      log('步骤6', '⚠️ 未找到服务器链接，结束');
      process.exitCode = 0; return;
    }

    const spServer = screenshot('04-server-page');
    try { await page.screenshot({ path: spServer, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: true, stage: '服务器页面', msg: '已打开', screenshotPath: spServer });

    log('步骤7', 'Console');
    try {
      const con = page.locator('button:has-text("Console"), a:has-text("Console")').first();
      if (await con.count({ timeout: 5000 }) > 0) {
        await con.click();
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
      }
    } catch { log('步骤7', '⚠️'); }
    await delay(1500, 3000);

    log('步骤8', 'Restart');
    try {
      const restart = page.locator('button:has-text("Restart")');
      await restart.waitFor({ state: 'visible', timeout: 15_000 });
      await restart.click();
      await notifyTelegram({ ok: true, stage: 'Restart', msg: 'VPS 重启中' });
    } catch { log('步骤8', '⚠️ Restart 未找到'); }
    await delay(8000, 12000);

    log('步骤9', '命令');
    try {
      const cmd = page.locator('input[placeholder="Type a command..."]');
      await cmd.waitFor({ state: 'visible', timeout: 20_000 });
      await cmd.fill('working properly');
      await cmd.press('Enter');
    } catch { log('步骤9', '⚠️'); }
    await delay(4000, 6000);

    const spDone = screenshot('05-done');
    try { await page.screenshot({ path: spDone, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: true, stage: '完成', msg: '🎉', screenshotPath: spDone });
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
