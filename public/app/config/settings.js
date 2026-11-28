/* config/settings.js — 设置页 */
/* 改右边的文字即可；左边是定位用的原文，不要改。 */
(function(){
  var T = window.OLText;
  if(!T || typeof T.register !== "function") return;

  T.register('settings', {
    '+ 新标签': '+ 新标签',
    '+ 新标记': '+ 新标记',
    '一个 JSON 文件，包含全部记录': '一个 JSON 文件，包含全部记录',
    '不可恢复，请先导出': '不可恢复，请先导出',
    '今日重点条目': '今日重点条目',
    '从备份恢复': '从备份恢复',
    '会先给你看摘要，再决定合并还是替换': '会先给你看摘要，再决定合并还是替换',
    '先给你看预览和冲突，确认后才会写进来': '先给你看预览和冲突，确认后才会写进来',
    '几点算新的一天': '几点算新的一天',
    '字号': '字号',
    '导入配置文件': '导入配置文件',
    '导出 PDF 记录': '导出 PDF 记录',
    '导出备份': '导出备份',
    '导出表格': '导出表格',
    '导出配置文件': '导出配置文件',
    '把记录按日期排成一张表，Excel / WPS 能打开': '把记录按日期排成一张表，Excel / WPS 能打开',
    '拖到喜欢的大小就行，全 App 一起变': '拖到喜欢的大小就行，全 App 一起变',
    '月历 + 时间轴 + 小结，打印或存成 PDF': '月历 + 时间轴 + 小结，打印或存成 PDF',
    '每天重复的清单在这个时间清零': '每天重复的清单在这个时间清零',
    '清空全部数据': '清空全部数据',
    '点右上角「+ 新建」加一个': '点右上角「+ 新建」加一个',
    '笔 / 标签 / 决策库 / 偏好设置，不含日常记录，换设备导入用': '笔 / 标签 / 决策库 / 偏好设置，不含日常记录，换设备导入用',
    '还没有情况': '还没有情况',
    '还没有条目，点右上角加一条。': '还没有条目，点右上角加一条。',
    '首页一行三张；「健身」「学习」是默认预设，可改可删': '首页一行三张；「健身」「学习」是默认预设，可改可删',
    '＋ 加一条': '＋ 加一条',
  });

  /* ===== 英文语义 key · 设置页（第一批迁移：index.html 静态文案） ===== */
  T.register('settings', {
    'settings.page.title': '设置',
    'settings.page.subtitle': '东西都只在这台设备上。',
    'settings.section.pens': '我的标记',
    'settings.hint.pens': '点标记改名字和颜色，点 × 删掉。',
    'settings.section.tags': '标签',
    'settings.section.look': '外观',
    'settings.section.plugins': '插件',
    'settings.hint.plugins': '关掉只是不在首页出现，记过的都还在。',
    'settings.section.other': '其它',
    'settings.section.cloud': '云端备份',
    'settings.section.space': '空间',
    'settings.section.data': '数据',
    'settings.hint.data': '数据只存在这个浏览器里。清缓存、换设备或误删都可能丢掉，建议偶尔导出一次备份。',
  });

  /* ===== 英文语义 key · 设置页（第二批迁移：JS 渲染文案；Auth 登录/空间/备份文案保留 OLT，待 Auth 批次统一处理） ===== */
  T.register('settings', {
    'settings.daycut.title': '几点算新的一天',
    'settings.daycut.subtitle': '每天重复的清单在这个时间清零',
    'settings.font.title': '字号',
    'settings.font.subtitle': '拖到喜欢的大小就行，全 App 一起变',
    'settings.data.exportPdf.title': '导出 PDF 记录',
    'settings.data.exportPdf.subtitle': '月历 + 时间轴 + 小结，打印或存成 PDF',
    'settings.data.exportBackup.title': '导出备份',
    'settings.data.exportBackup.subtitle': '一个 JSON 文件，包含全部记录',
    'settings.data.exportTable.title': '导出表格',
    'settings.data.exportTable.subtitle': '把记录按日期排成一张表，Excel / WPS 能打开',
    'settings.data.exportConfig.title': '导出配置文件',
    'settings.data.exportConfig.subtitle': '笔 / 标签 / 决策库 / 偏好设置，不含日常记录，换设备导入用',
    'settings.data.importConfig.title': '导入配置文件',
    'settings.data.importConfig.subtitle': '先给你看预览和冲突，确认后才会写进来',
    'settings.data.restoreBackup.title': '从备份恢复',
    'settings.data.restoreBackup.subtitle': '会先给你看摘要，再决定合并还是替换',
    'settings.data.clearAll.title': '清空全部数据',
    'settings.data.clearAll.subtitle': '不可恢复，请先导出',

  });

  /* ===== 英文语义 key · 设置页（第三批迁移：Auth 登录/空间/云端备份 JS 文案） =====
     Auth 区域原文此前未注册中文 legacy key，OLT 查不到即原样返回；
     迁移为语义 key 后显示文字不变，业务行为不变。 */
  T.register('settings', {
    'settings.auth.error.badEmail': '邮箱格式不对',
    'settings.auth.error.badInput': '输入格式不对',
    'settings.auth.error.rateLimited': '发送过于频繁，请稍后再试',
    'settings.auth.error.codeInvalid': '验证码不对，请再试一次',
    'settings.auth.error.codeExpired': '验证码过期了，请重新发送',
    'settings.auth.error.codeConsumed': '验证码已使用，请重新发送',
    'settings.auth.error.tooManyAttempts': '尝试次数过多，请重新发送验证码',
    'settings.auth.error.emailUnconfigured': '邮件服务尚未配置，暂时无法登录',
    'settings.auth.error.emailSendFailed': '验证码发送失败，请稍后重试',
    'settings.auth.error.network': '网络中断，请重试',
    'settings.auth.error.unavailable': '认证服务暂不可用',
    'settings.auth.error.noSession': '登录状态已失效，请重新登录',
    'settings.auth.error.accountDisabled': '账号不可用',
    'settings.auth.error.default': '登录失败，请稍后重试',

    'settings.auth.login.moduleUnavailable': '登录暂不可用',
    'settings.auth.login.moduleNotLoaded': '认证模块未加载，请稍后重试。',
    'settings.auth.login.sending': '正在发送验证码…',
    'settings.auth.login.codeSent': '验证码已发送，10 分钟内有效。',
    'settings.auth.login.verifying': '正在验证…',
    'settings.auth.login.identityWriteFailed': '本机身份写入失败，请重试',

    'settings.auth.logout.failed': '退出失败',
    'settings.auth.logout.moduleNotLoaded': '认证模块未加载，仍保持当前登录状态。',
    'settings.auth.logout.sessionNotRevoked': '服务端会话尚未撤销，仍保持当前登录状态。请检查网络后重试。',

    'settings.space.guest.current': '当前空间：游客空间',
    'settings.space.guest.subtitle': '数据只保存在这台设备；不需要注册或登录，也不会上传云端。',
    'settings.space.guest.data': '游客数据',
    'settings.space.guest.dataSubtitle': '关掉页面后仍然留在本机；换设备、清缓存或删浏览器数据可能丢失。',
    'settings.space.login.title': '登录 / 开启云端备份',
    'settings.space.login.subtitle': '用应用自己的邮箱验证码登录；验证成功后才进入用户空间。游客数据不会自动上传或合并。',
    'settings.space.login.action': '登录',
    'settings.space.guest.reset': '重置游客数据',
    'settings.space.guest.resetSubtitle': '只删游客空间里的记录并恢复初始演示内容；不影响任何登录用户的数据。',

    'settings.space.user.current': '当前空间：用户空间',
    'settings.space.user.subtitle': '数据保存在本机，并自动备份到云端。',
    'settings.space.user.account': '登录账号',
    'settings.space.user.accountUnavailable': '账号信息暂不可用',
    'settings.space.user.cloudBackup': '云端备份',
    'settings.space.user.cloudEnabled': '已启用（自动）。',
    'settings.space.user.cloudEnabledTag': '已启用',
    'settings.space.user.logout': '退出登录',
    'settings.space.user.logoutSubtitle': '撤销服务端会话后回到游客空间；本机用户数据保留，不清空、不自动合并。',
    'settings.space.user.logoutAction': '退出',

    'settings.cloud.guest.title': '当前为游客空间，云端备份尚未启用。',
    'settings.cloud.guest.subtitle': '登录后可开启自动云端备份。游客数据不会上传，也不会产生备份失败状态。',
    'settings.cloud.user.autoTitle': '自动云端备份',
    'settings.cloud.user.autoSubtitle': '已启用：本地保存成功后自动合并上传，不需要手动点击。',
    'settings.cloud.user.statusTitle': '当前备份状态',
    'settings.cloud.user.lastSuccessTitle': '最近成功备份时间',
    'settings.cloud.user.lastErrorTitle': '最近一次上传失败',
    'settings.cloud.user.refresh': '刷新云端状态',
    'settings.cloud.user.backupNow': '立即备份',
    'settings.cloud.user.note': '云端备份用于数据保护和跨设备恢复，不提供实时双向同步；只保存最新一份备份。',
  });
})();
