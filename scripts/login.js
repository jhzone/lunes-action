// scripts/login.js
// === 简洁版：std Playwright 填表 + 点击 + 等待 API 响应 ===
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import fs from 'fs';
import { randomInt } from 'crypto';

chromium.use(StealthPlugin());

const LOGIN_URL = 'https://ctrl.lunes.host/auth/login';
const delay = (a, b) => new Promise(r => setTimeout(r, randomInt(a, b)));
function log(label, detail) { console.log(`[${new Date().toISOString()}] ${label}`, detail ?? ''); }

async function notifyTelegram({ ok, stage, msg, screenshotPath }) {
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `🔔 ${ok ? '✅' : '❌'} ${stage}\n${msg || ''}\n${new Date().toISOString()}`, disable_web_page_preview: true })
    });
    if (screenshotPath && fs.existsSync(screenshotPath)) {
      const fd = new FormData();
      fd.append('chat_id', chatId); fd.append('caption', stage);
      fd.append('photo', new Blob([fs.readFileSync(screenshotPath)]), 'screenshot.png');
      await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: fd });
    }
  } catch { /* ignore */ }
}

function envOrThrow(name) {
  const v = process.env[name];
  if (!v) throw new Error(`环境变量 ${name} 未设置`);
  return v;
}

async function main() {
  const username = envOrThrow('LUNES_USERNAME');
  const password = envOrThrow('LUNES_PASSWORD');
  const ss = (n) => `./${n}.png`;

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled', '--window-size=1920,1080',
      '--use-gl=swiftshader', '--enable-webgl', '--disable-infobars', '--disable-extensions',
      '--lang=en-US,en', '--accept-lang=en-US,en;q=0.9']
  });
  const ctx = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-US', timezoneId: 'Asia/Shanghai',
    permissions: ['geolocation'], geolocation: { latitude: 31.2304, longitude: 121.4737 },
  });
  const page = await ctx.newPage();

  try {
    // ═══ 1. 打开登录页 ═══
    log('1', '打开登录页');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 60_000 });
    await delay(5000, 8000);

    const t = await page.title().catch(() => '');
    if (/Just a moment|Attention Required/i.test(t)) {
      log('1', 'Cloudflare 拦截，等待...');
      await delay(20000, 25000);
      if (/Just a moment|Attention Required/i.test(await page.title().catch(() => ''))) {
        await notifyTelegram({ ok: false, stage: 'Cloudflare', msg: '拦截未解除' });
        process.exitCode = 2; return;
      }
    }
    log('1', `✅ 页面就绪: ${page.url()}`);

    // ═══ 2. 填表 ═══
    log('2', '填表');
    const u = page.locator('input[name="username"]');
    const p = page.locator('input[name="password"]');
    await u.waitFor({ state: 'visible', timeout: 20_000 });
    await p.waitFor({ state: 'visible', timeout: 20_000 });

    await u.click(); await u.fill('');
    for (const ch of username) await u.press(ch, { delay: randomInt(50, 120) });
    await delay(300, 600);

    await p.click(); await p.fill('');
    for (const ch of password) await p.press(ch, { delay: randomInt(50, 120) });
    await delay(300, 600);
    log('2', '✅ 已输入');

    // ═══ 3. 点击 + 等待 API 响应 ═══
    const btn = page.locator('button[type="submit"]');
    await btn.waitFor({ state: 'visible', timeout: 10_000 });

    const sp = ss('02-before');
    try { await page.screenshot({ path: sp, fullPage: true }); } catch { /* ignore */ }

    log('3', '点击登录...');

    // 同时等待 API 响应 和 URL 变化
    const apiPromise = page.waitForResponse(
      r => r.url().includes('/auth/login') && r.request().method() === 'POST',
      { timeout: 20_000 }
    ).catch(() => null);

    const navPromise = page.waitForURL(
      u => !u.includes('/auth/login'),
      { timeout: 20_000 }
    ).catch(() => null);

    await btn.click({ timeout: 5000 }).catch(() => log('3', 'click 失败'));

    const apiResp = await apiPromise;
    if (apiResp) log('3', `API: ${apiResp.status()} ${apiResp.url()}`);

    const navResult = await navPromise;
    if (navResult) log('3', '✅ URL 已跳转');

    await delay(3000, 5000);

    // ═══ 4. 验证 ═══
    const url = page.url();
    const title = await page.title().catch(() => '?');
    log('4', `URL: ${url}, 标题: ${title}`);

    const sp2 = ss('03-after');
    try { await page.screenshot({ path: sp2, fullPage: true }); } catch { /* ignore */ }

    if (/\/auth\/login/i.test(url)) {
      let body = '';
      try { body = (await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).substring(0, 300); } catch { /* ignore */ }
      log('4', `❌ 仍在登录页: ${body}`);
      await notifyTelegram({ ok: false, stage: '登录失败', msg: `URL: ${url}`, screenshotPath: sp2 });
      process.exitCode = 1; return;
    }

    log('4', '✅ 登录成功');
    await notifyTelegram({ ok: true, stage: '登录成功', msg: `URL: ${url}`, screenshotPath: sp2 });

    // ═══ 后续操作 ═══
    log('5', '服务器页');
    try {
      await page.locator('a[href="/server/5202fe13"]').waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator('a[href="/server/5202fe13"]').click();
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
    } catch { log('5', '⚠️ 未找到服务器链接'); process.exitCode = 0; return; }

    const sp3 = ss('04-server');
    try { await page.screenshot({ path: sp3, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: true, stage: '服务器页面', msg: '已打开', screenshotPath: sp3 });

    log('6', 'Console');
    try { await page.locator('button:has-text("Console"), a:has-text("Console")').first().click({ timeout: 5000 }); } catch { /* ignore */ }
    await delay(2000, 4000);

    log('7', 'Restart');
    try { await page.locator('button:has-text("Restart")').click({ timeout: 15000 }); await notifyTelegram({ ok: true, stage: 'Restart', msg: 'VPS 重启中' }); } catch { /* ignore */ }
    await delay(8000, 12000);

    log('8', '命令');
    try {
      await page.locator('input[placeholder="Type a command..."]').waitFor({ state: 'visible', timeout: 20_000 });
      await page.locator('input[placeholder="Type a command..."]').fill('working properly');
      await page.keyboard.press('Enter');
    } catch { /* ignore */ }
    await delay(4000, 6000);

    const sp4 = ss('05-done');
    try { await page.screenshot({ path: sp4, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: true, stage: '完成', msg: '🎉', screenshotPath: sp4 });
    process.exitCode = 0;

  } catch (e) {
    log('异常', e?.message);
    const sp = ss('99-error');
    try { await page.screenshot({ path: sp, fullPage: true }); } catch { /* ignore */ }
    await notifyTelegram({ ok: false, stage: '异常', msg: e?.message, screenshotPath: fs.existsSync(sp) ? sp : undefined });
    process.exitCode = 1;
  } finally { await ctx.close(); await browser.close(); }
}

await main();
