/* auth/email.js — 可替换的邮件适配层
 *
 * 规则：
 *   - 生产未配置驱动时必须明确失败（email-unconfigured），绝不假装发送成功；
 *   - 任何日志都不输出验证码明文；
 *   - 测试替身必须显式开启 ALLOW_TEST_EMAIL=true，且只存在于测试 env，
 *     生产代码里没有固定验证码、万能码或硬编码邮箱。
 */
function authFail(code, message, status) {
  return Object.assign(new Error(message), { code: code, status: status || 503 });
}

export async function sendLoginCode(env, message) {
  var to = message && message.to;
  if (typeof to !== 'string' || !to) throw authFail('email-invalid', '收件地址无效', 400);

  /* 仅供自动化测试注入：生产环境不会设置 ALLOW_TEST_EMAIL */
  if (env && env.ALLOW_TEST_EMAIL === 'true' && typeof env.__mailSender === 'function') {
    await env.__mailSender({ to: to, subject: '地球online 登录验证码', code: message.code, expiresAt: message.expiresAt });
    return { ok: true, driver: 'test' };
  }

  var driver = env && env.EMAIL_DRIVER ? env.EMAIL_DRIVER : 'none';
  if (driver === 'console') {
    /* 本地开发替身：只提示"有一封待发邮件"，验证码不写日志 */
    console.log('[auth] mail stub queued to=' + to + ' (code withheld)');
    return { ok: true, driver: 'console' };
  }
  if (driver !== 'http') throw authFail('email-unconfigured', '邮件服务未配置', 503);

  var url = env.MAIL_API_URL;
  var key = env.MAIL_API_KEY;
  if (typeof url !== 'string' || !/^https:\/\//.test(url) || !key) {
    throw authFail('email-unconfigured', '邮件服务配置不完整', 503);
  }
  var response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key
      },
      body: JSON.stringify({
        to: to,
        from: env.MAIL_FROM || 'noreply@slices0flife.me',
        subject: '地球online 登录验证码',
        text: '你的登录验证码是 ' + message.code + '，10 分钟内有效。若不是你本人操作请忽略。'
      })
    });
  } catch (e) {
    throw authFail('email-send-failed', '邮件发送失败', 503);
  }
  if (!response.ok) throw authFail('email-send-failed', '邮件发送失败', 503);
  return { ok: true, driver: 'http' };
}
