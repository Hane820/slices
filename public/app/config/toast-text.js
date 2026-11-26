/* toast-text.js — 地球online Toast 提示配置中心（唯一可编辑文件）
 *
 * ============================== 怎么用 ==============================
 * 打开本文件 → 找到那条提示（每条上方有中文注释写明页面和触发条件）→
 * 改右边引号里的文字 / enabled / type / duration → 保存 → 刷新页面生效。
 * 不需要改任何业务代码。
 *
 * 每条配置的字段：
 *   enabled  true=显示这条提示；false=完全不弹（静默）。
 *   type     提示类型，决定外观：
 *            "success" 绿色 + 对勾图标（操作成功）
 *            "info"    深色（普通信息，默认外观）
 *            "warning" 琥珀色 + 警示图标（需要注意 / 输入有误）
 *            "error"   红色 + 叉图标（失败 / 数据风险）
 *   text     显示文案。{name} {minutes} 这类花括号是变量占位符——
 *            运行时由页面填入实际值，可以挪位置，但不要删掉或改名。
 *   duration 显示时长（毫秒）。带按钮的提示建议 6000 以上，给足阅读和点击时间。
 *
 * 注意：
 *   - 左边英文 key 是程序识别用的，不要改。
 *   - 关闭（enabled:false）只适合「界面本身已经能看出结果」的提示；
 *     所有失败、数据风险、校验拦截、带按钮的提示默认全开，别关。
 *   - 改坏了结构（少了逗号 / 引号不配对）会导致整组提示失效，
 *     刷新后如果一条提示都不弹，先检查刚改的那几行。
 */
(function(){
  var C = {};

  /* ---------- 内部引擎：业务代码不需要动这里 ---------- */
  function fmt(tpl, vars){
    if(typeof tpl !== 'string') return '';
    if(!vars) return tpl;
    return tpl.replace(/\{([A-Za-z0-9_]+)\}/g, function(_, k){
      var v = vars[k];
      if(v === null || v === undefined) return '';
      if(typeof v === 'object') return '';            /* 防 [object Object] */
      return String(v);
    });
  }
  function resolve(key, vars){
    var e = C[key];
    if(!e || e.enabled === false) return null;         /* 关闭的提示静默跳过 */
    var ty = e.type; if(ty !== 'success' && ty !== 'warning' && ty !== 'error') ty = 'info';
    var dur = (typeof e.duration === 'number' && e.duration > 0) ? e.duration : 0;
    return { text: fmt(e.text, vars), type: ty, duration: dur };
  }

  window.OLToastConfig = { items: C, fmt: fmt, resolve: resolve };

  /* ==================== 以下为全部提示配置 ==================== */

  /* ========== 启动 / 全局 ========== */

  /* 今日页 · 灵光一闪 · 触发：点保存、记录写入成功后（伴随闪光飞向导航的动画） */
  C.flashSaved = { enabled:true, type:"info", text:"记好了，时间轴里能看到", duration:2200 };

  /* 设置页 · 标签池 · 触发：新建标签保存成功后 */
  C.tagAdded = { enabled:true, type:"success", text:"标签已加上", duration:2200 };

  /* 手账快捷入口 / 今日页 · 任务便签 · 触发：保存时内容为空，未写入 */
  C.contentEmpty = { enabled:true, type:"warning", text:"点击此处填写", duration:3500 };

  /* 启动 · 旧版数据迁移 · 触发：检测到旧版数据并完成迁移 */
  C.legacyMigrated = { enabled:true, type:"success", text:"已导入", duration:3000 };

  /* 启动 · 首次使用 · 触发：全新档案，还没有任何记录 */
  C.firstUseHint = { enabled:true, type:"info", text:"从小事做起", duration:3000 };

  /* 启动 · 发现未保存副本 · 触发：启动时发现上次会话的未保存修改
     默认开启理由：重要数据决策，必须让用户选择 */
  C.unsavedSnapshotFound = { enabled:true, type:"warning", text:"本页有未保存的修改，已保留副本，没有自动覆盖最新数据", duration:8000 };

  /* 启动 · 副本合并 · 触发：用户选择恢复修改且合并提交成功 */
  C.unsavedMerged = { enabled:true, type:"success", text:"修改已合并并提交", duration:2200 };

  /* ========== 全局 · 保存 / 导入导出 ========== */

  /* 任意页面 · 保存 · 触发：写入闸未就绪，改动没有保存 */
  C.saveUnavailable = { enabled:true, type:"error", text:"保存不可用：这次改动不会保存", duration:6000 };

  /* 任意页面 · 保存 · 触发：队列保存失败，可重试 / 放弃 */
  C.saveFailed = { enabled:true, type:"error", text:"没保存成功{message}，改动还在内存里", duration:8000 };

  /* 通用记录弹层 · 触发：时长必填但填了 0 或没填 */
  C.minutesRequired = { enabled:true, type:"warning", text:"时长", duration:3500 };

  /* 设置页 · 导出备份 · 触发：备份 JSON 文件生成成功 */
  C.backupExported = { enabled:true, type:"success", text:"已导出备份", duration:2200 };

  /* 设置页 · 导出备份 · 触发：读取本地库失败，未生成文件 */
  C.backupExportFailed = { enabled:true, type:"error", text:"导出失败：{message}，未生成备份", duration:6000 };

  /* 设置页 · 导入配置 · 触发：配置模块未加载就点了导入 */
  C.importModuleMissing = { enabled:true, type:"error", text:"导入失败：配置模块未加载", duration:6000 };

  /* 设置页 · 导入配置 · 触发：文件超过约 2MB 上限 */
  C.importTooLarge = { enabled:true, type:"error", text:"导入失败：文件太大（上限约 2MB），已拒绝", duration:6000 };

  /* 设置页 · 导入配置 · 触发：文件读取失败（FileReader 出错） */
  C.importFileUnreadable = { enabled:true, type:"error", text:"导入失败：文件无法读取", duration:6000 };

  /* 设置页 · 导入配置 · 触发：文件解析 / 读取失败，本机无改动 */
  C.importFailed = { enabled:true, type:"error", text:"导入失败：{message}，本机没有任何改动", duration:6000 };

  /* 设置页 · 导入配置 · 触发：存在未处理的恢复副本，导入被拦截 */
  C.importBlockedBySnapshot = { enabled:true, type:"warning", text:"导入失败：有一份未处理的恢复副本，先在顶部横幅里处理它", duration:6000 };

  /* 设置页 · 导入配置 · 触发：预览计算失败，本机无改动 */
  C.importPreviewFailed = { enabled:true, type:"error", text:"导入失败：预览计算失败，本机没有任何改动", duration:6000 };

  /* 设置页 · 导入配置确认 · 触发：还有冲突条目未做选择就点确认 */
  C.importConflictsUnresolved = { enabled:true, type:"warning", text:"还有冲突没选好，每一条都要选", duration:3500 };

  /* 设置页 · 导入配置确认 · 触发：文件与本机一致，无变更可导入 */
  C.importNothingToDo = { enabled:true, type:"info", text:"没有要导入的变更，本机没有任何改动", duration:3000 };

  /* 设置页 · 导入配置确认 · 触发：合并结果异常，未写入 */
  C.importMergeInvalid = { enabled:true, type:"error", text:"导入失败：合并结果异常", duration:6000 };

  /* 设置页 · 导入配置 · 触发：legacy 模式导入并保存成功 */
  C.configImported = { enabled:true, type:"success", text:"配置已导入", duration:2200 };

  /* 设置页 · 导入配置 · 触发：legacy 保存未入队，请重试 */
  C.importSaveRetry = { enabled:true, type:"error", text:"导入没存上，再试一次", duration:6000 };

  /* 设置页 · 导入配置确认 · 触发：队列忙或写入未接线，确认被拦截 */
  C.saveQueueBusy = { enabled:true, type:"warning", text:"当前保存还没就绪（队列忙或写入未接线），稍后再确认", duration:3500 };

  /* 设置页 · 导入配置确认 · 触发：读不到当前版本号，无法安全提交 */
  C.importRevUnreadable = { enabled:true, type:"error", text:"导入失败：读不到当前版本号，请重试", duration:6000 };

  /* 设置页 · 导入配置确认 · 触发：预览过期后重算失败 */
  C.importRecalcFailed = { enabled:true, type:"error", text:"导入失败：重算预览失败", duration:6000 };

  /* 设置页 · 导入配置确认 · 触发：数据在预览期间变化，已自动重算 */
  C.importPreviewStale = { enabled:true, type:"warning", text:"本机数据在这期间有变化，预览已重算，请再确认一次", duration:6000 };

  /* 设置页 · 导入配置确认 · 触发：重算预览抛错，带具体原因 */
  C.importRecalcFailedMsg = { enabled:true, type:"error", text:"重算预览失败：{message}", duration:6000 };

  /* 设置页 · 导入配置 · 触发：idb 模式导入并提交成功 */
  C.configImportedSaved = { enabled:true, type:"success", text:"配置已导入并保存", duration:2200 };

  /* 设置页 · 导入配置 · 触发：队列拒绝提交，导入未落库 */
  C.importCommitRejected = { enabled:true, type:"error", text:"导入没存上（队列拒绝了这次提交）", duration:6000 };

  /* 设置页 · 导出表格 · 触发：整理记录时出错，未生成文件 */
  C.tableBuildFailed = { enabled:true, type:"error", text:"导出失败：整理记录时出错，未生成表格", duration:6000 };

  /* 设置页 · 导出表格 · 触发：CSV 表格生成成功 */
  C.tableExported = { enabled:true, type:"success", text:"已导出表格", duration:2200 };

  /* 设置页 · 导出表格 · 触发：读取本地库失败，未生成文件 */
  C.tableExportFailed = { enabled:true, type:"error", text:"导出失败：{message}，未生成表格", duration:6000 };

  /* 设置页 · 从备份恢复 · 触发：备份文件读取失败 */
  C.backupFileUnreadable = { enabled:true, type:"error", text:"这个文件读不出来", duration:6000 };

  /* 设置页 · 从备份恢复 · 触发：文件结构不像本应用备份 */
  C.notBackupFile = { enabled:true, type:"error", text:"请检查文件格式", duration:6000 };

  /* 设置页 · 从备份恢复 · 触发：备份恢复并保存成功 */
  C.backupRestored = { enabled:true, type:"success", text:"已恢复", duration:2200 };

  /* 设置页 · PDF 导出 · 触发：开始日期晚于结束日期 */
  C.dateRangeInvalid = { enabled:true, type:"warning", text:"开始日期要在结束日期前面", duration:3500 };

  /* ========== 决策页 ========== */

  /* 决策页 · 待办清单 · 触发：把清单项加入今日待办 */
  C.taskAddedToday = { enabled:true, type:"success", text:"已加入今日待办", duration:2200 };

  /* 决策页 · 番茄钟 · 触发：倒计时结束 */
  C.pomoTimeUp = { enabled:true, type:"warning", text:"时间到 · {name}", duration:6000 };

  /* 决策页 · 番茄钟 · 触发：全屏 API 不可用，自动改用大窗口 */
  C.fullscreenFallback = { enabled:true, type:"info", text:"全屏无法使用，已换成大窗口", duration:2200 };

  /* 决策页 · 番茄钟 · 触发：一段专注计时完成 */
  C.pomoSegmentDone = { enabled:true, type:"success", text:"这一段做完了", duration:2200 };

  /* 决策页 · 完成待办 · 触发：点完成且当前就在决策页 */
  C.taskCheckedHere = { enabled:true, type:"success", text:"「{name}」已打钩", duration:2200 };

  /* 决策页 · 完成待办 · 触发：点完成但当前不在决策页，提示回今日查看 */
  C.taskCheckedBack = { enabled:true, type:"info", text:"「{name}」已打钩，回今日能看到", duration:3000 };

  /* 决策页 · 番茄钟 · 触发：用户取消一段计时 */
  C.pomoCancelled = { enabled:true, type:"info", text:"已取消", duration:2200 };

  /* 决策页 · 番茄钟 · 触发：点「现在开始」启动计时 */
  C.pomoStarted = { enabled:true, type:"info", text:"开始计时 {time}", duration:2200 };

  /* 决策页 · 抽待办 · 触发：待办池为空，无法抽取 */
  C.todoPoolEmpty = { enabled:true, type:"info", text:"清单里没有可抽的，先加几条待办", duration:3000 };

  /* 决策页 · 建议库编辑 · 触发：删除一条建议（弹层关闭即反馈）
     默认关闭理由：列表行已消失，界面变化明确，无需额外提示 */
  C.suggestionDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* 决策页 · 建议库编辑 · 触发：保存时名称为空 */
  C.suggestionNameRequired = { enabled:true, type:"warning", text:"记录待办", duration:3500 };

  /* 决策页 · 建议库编辑 · 触发：编辑保存（弹层关闭即反馈）
     默认关闭理由：弹层关闭且列表已更新，无需额外提示 */
  C.suggestionSaved = { enabled:false, type:"success", text:"已保存", duration:2200 };

  /* 决策页 · 吃什么 · 触发：插件未开启时进入吃什么 */
  C.foodPluginDisabled = { enabled:true, type:"info", text:"未开启饮食决策", duration:3000 };

  /* 决策页 · 吃什么 · 触发：菜单库为空 */
  C.foodMenuEmpty = { enabled:true, type:"info", text:"菜单还是空的，先加两道", duration:3000 };

  /* 决策页 · 吃什么 · 触发：当前饭点没有可抽的菜 */
  C.foodSlotNoItem = { enabled:true, type:"info", text:"这个饭点没有能抽的，去决策页加两道", duration:3000 };

  /* 决策页 · 吃什么 · 触发：确认吃某道菜并写入记录 */
  C.foodEaten = { enabled:true, type:"success", text:"记下了：{name}", duration:2200 };

  /* 决策页 · 吃什么 · 触发：选了今天已记过的菜 */
  C.foodDuplicate = { enabled:true, type:"warning", text:"已记录：{name}", duration:3500 };

  /* 决策页 · 吃什么 · 触发：打开某道菜的随机抽取开关 */
  C.foodRandomOn = { enabled:true, type:"info", text:"「{name}」参与随机了", duration:2200 };

  /* 决策页 · 吃什么 · 触发：关闭某道菜的随机抽取开关 */
  C.foodRandomOff = { enabled:true, type:"info", text:"「{name}」不参与随机了", duration:2200 };

  /* 决策页 · 菜单编辑 · 触发：删除一道菜（弹层关闭即反馈）
     默认关闭理由：列表行已消失，无需额外提示 */
  C.foodItemDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* 决策页 · 菜单编辑 · 触发：保存时菜名为空 */
  C.foodNameRequired = { enabled:true, type:"warning", text:"记录饮食", duration:3500 };

  /* 决策页 · 菜单编辑 · 触发：编辑保存（弹层关闭即反馈）
     默认关闭理由：弹层关闭且菜单已更新，无需额外提示 */
  C.foodItemSaved = { enabled:false, type:"success", text:"已保存", duration:2200 };

  /* ========== 饮食插件 ========== */

  /* 饮食记录 · 触发：删除一条进食记录（界面即反馈）
     默认关闭理由：记录行已消失，无需额外提示 */
  C.dietLogDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* 饮食记录 · 复制上一餐 · 触发：还没有可复制的一餐 */
  C.dietNoCopySource = { enabled:true, type:"info", text:"还没有可复制的一餐", duration:2200 };

  /* 饮食记录 · 复制上一餐 · 触发：上一餐食物已填入表单 */
  C.dietCopyFilled = { enabled:true, type:"info", text:"已记录", duration:2200 };

  /* 饮食记录 · 新增 · 触发：食物名重复且份量为空时的提醒 */
  C.dietFoodDuplicateLong = { enabled:true, type:"warning", text:"此处写入饮食，份量可空", duration:3500 };

  /* 饮食记录 · 新增 · 触发：记录保存成功 */
  C.dietLogged = { enabled:true, type:"success", text:"记下了", duration:2200 };

  /* 饮食记录 · 翻天 · 触发：已在最新一天 */
  C.dietAlreadyLatest = { enabled:true, type:"info", text:"已经是最新的那天了", duration:2200 };

  /* 饮食记录 · 编辑 · 触发：编辑时食物名重复 */
  C.dietFoodDuplicateEdit = { enabled:true, type:"warning", text:"此处填写饮食", duration:3500 };

  /* 饮食记录 · 编辑 · 触发：编辑保存（界面即反馈）
     默认关闭理由：记录已更新，无需额外提示 */
  C.dietEdited = { enabled:false, type:"success", text:"改好了", duration:2200 };

  /* 设置页 · 餐次管理 · 触发：新建餐次名为空 */
  C.mealSlotNameRequired = { enabled:true, type:"warning", text:"写入内容", duration:3500 };

  /* 设置页 · 餐次管理 · 触发：餐次名重复 */
  C.mealSlotDuplicate = { enabled:true, type:"warning", text:"已经有这个餐次了", duration:3500 };

  /* 设置页 · 餐次管理 · 触发：餐次超过 8 个上限 */
  C.mealSlotLimit = { enabled:true, type:"warning", text:"餐次最多 8 个", duration:3500 };

  /* ========== 记录页 ========== */

  /* 记录页 · 月历标记 · 触发：一天最多 3 个标记 */
  C.markLimitReached = { enabled:true, type:"warning", text:"一天最多 3 个标记", duration:3500 };

  /* 记录页 / 设置页 · 标记编辑 · 触发：标记编辑保存（弹层关闭即反馈）
     默认关闭理由：弹层关闭且标记已更新，无需额外提示 */
  C.markerSaved = { enabled:false, type:"success", text:"已保存", duration:2200 };

  /* 记录页 · 月历 · 触发：擦掉某天的标记 */
  C.markerCleared = { enabled:true, type:"info", text:"标记擦掉了", duration:2200 };

  /* 记录页 · 重点记录 · 触发：删除一条记录（界面即反馈）
     默认关闭理由：记录行已消失，无需额外提示 */
  C.recordEntryDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* 记录页 · 训练 · 触发：保存一条训练记录 */
  C.workoutSaved = { enabled:true, type:"success", text:"记下了 {minutes} 分钟", duration:2200 };

  /* ========== 设置页 ========== */

  /* 设置页 · 休息日 · 触发：标记今天为休息日 */
  C.remindRestOn = { enabled:true, type:"info", text:"恢复提醒", duration:3000 };

  /* 设置页 · 休息日 · 触发：取消休息日标记 */
  C.remindRestOff = { enabled:true, type:"info", text:"好好休息", duration:3000 };

  /* 设置页 / 记录页 · 标记 · 触发：只剩一个标记时尝试删除 */
  C.lastMarkerProtected = { enabled:true, type:"warning", text:"至少留一个标记", duration:3500 };

  /* 设置页 · 标记池 · 触发：删除标记（列表即反馈）
     默认关闭理由：标记已从列表消失，无需额外提示 */
  C.markerDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* 设置页 · 标签池 · 触发：删除标签（列表即反馈）
     默认关闭理由：标签已从列表消失，无需额外提示 */
  C.tagDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* 设置页 · 标签池 · 触发：标签改名保存（行内即反馈）
     默认关闭理由：名字已在行内更新，无需额外提示 */
  C.tagRenamed = { enabled:false, type:"success", text:"改好了", duration:2200 };

  /* 设置页 · 插件开关 · 触发：打开插件（开关状态可视）
     默认关闭理由：开关翻转本身即反馈，无需额外提示 */
  C.pluginOn = { enabled:false, type:"info", text:"「{name}」打开了", duration:2200 };

  /* 设置页 · 插件开关 · 触发：关闭插件（开关状态可视）
     默认关闭理由：开关翻转本身即反馈，无需额外提示 */
  C.pluginOff = { enabled:false, type:"info", text:"「{name}」关掉了", duration:2200 };

  /* 设置页 · 休息时间 · 触发：修改「几点算新的一天」（行内即反馈）
     默认关闭理由：行内数值已更新，无需额外提示 */
  C.resetHourSaved = { enabled:false, type:"success", text:"改好了", duration:2200 };

  /* 设置页 · 主题色 · 触发：切换主题并保存成功 */
  C.themeChanged = { enabled:true, type:"info", text:"换成「{name}」了", duration:2200 };

  /* 设置页 · 字号 · 触发：拖动字号滑杆（滑杆即视）
     默认关闭理由：滑杆位置即反馈，无需额外提示 */
  C.fontScaleSaved = { enabled:false, type:"info", text:"设置成功", duration:2200 };

  /* 设置页 · 清空数据 · 触发：全部数据已清空（重大不可逆） */
  C.allDataCleared = { enabled:true, type:"success", text:"已经清空了", duration:3000 };

  /* 设置页 · 云端备份 · 触发：已有上传在进行中，忽略重复点击 */
  C.backupUploadBusy = { enabled:true, type:"info", text:"已有上传在进行中", duration:2200 };

  /* 设置页 · 数字输入 · 触发：输入超出允许范围 */
  C.numberOutOfRange = { enabled:true, type:"warning", text:"填 {min} 到 {max} 之间的数字", duration:3500 };

  /* 设置页 · 标记编辑 · 触发：保存时名字为空 */
  C.markerNameRequired = { enabled:true, type:"warning", text:"给它起个名字", duration:3500 };

  /* 设置页 · 重点选项 · 触发：新增选项名为空 */
  C.optionNameRequired = { enabled:true, type:"warning", text:"写入选项", duration:3500 };

  /* 设置页 · 重点选项 · 触发：选项名重复 */
  C.optionDuplicate = { enabled:true, type:"warning", text:"已经有这个选项了", duration:3500 };

  /* 设置页 · 今日重点 · 触发：保存时名字为空 */
  C.focusNameRequired = { enabled:true, type:"warning", text:"写入内容", duration:3500 };

  /* 设置页 · 今日重点 · 触发：多选模式没有任何选项 */
  C.focusNeedsOption = { enabled:true, type:"warning", text:"多选至少要有一个选项", duration:3500 };

  /* 设置页 · 今日重点 · 触发：目标数字不大于 0 */
  C.focusGoalInvalid = { enabled:true, type:"warning", text:"目标写个大于 0 的数", duration:3500 };

  /* 设置页 · 今日重点 · 触发：自定义单位名为空 */
  C.focusUnitRequired = { enabled:true, type:"warning", text:"设置单位", duration:3500 };

  /* 设置页 · 今日重点 · 触发：新建重点（弹层关闭即反馈）
     默认关闭理由：弹层关闭且列表已更新，无需额外提示 */
  C.focusAdded = { enabled:false, type:"success", text:"已加入", duration:2200 };

  /* 设置页 · 今日重点 · 触发：编辑重点（弹层关闭即反馈）
     默认关闭理由：弹层关闭且列表已更新，无需额外提示 */
  C.focusSaved = { enabled:false, type:"success", text:"改好了", duration:2200 };

  /* 设置页 · 今日重点 · 触发：删除重点，提供撤销 */
  C.focusDeleted = { enabled:true, type:"warning", text:"已删除「{name}」", duration:8000 };

  /* 设置页 · 今日重点 · 触发：撤销删除成功 */
  C.focusRestored = { enabled:true, type:"success", text:"已恢复", duration:2200 };

  /* 设置页 · 情境排序 · 触发：拖拽排序完成（顺序即视）
     默认关闭理由：顺序变化直接可见，无需额外提示 */
  C.scenesReordered = { enabled:false, type:"success", text:"顺序调好了", duration:2200 };

  /* 设置页 · 情境编辑 · 触发：保存时名称为空 */
  C.sceneNameRequired = { enabled:true, type:"warning", text:"写入内容", duration:3500 };

  /* 设置页 · 情境编辑 · 触发：新建情境成功 */
  C.sceneAdded = { enabled:true, type:"success", text:"已加入", duration:2200 };

  /* 设置页 · 情境编辑 · 触发：编辑情境（弹层关闭即反馈）
     默认关闭理由：弹层关闭且列表已更新，无需额外提示 */
  C.sceneSaved = { enabled:false, type:"success", text:"改好了", duration:2200 };

  /* 设置页 · 情境编辑 · 触发：删除情境（列表即反馈）
     默认关闭理由：情境已从列表消失，无需额外提示 */
  C.sceneDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* ========== 今日页 ========== */

  /* 今日页 · 重点区 · 触发：还没有重点条目时的提示 */
  C.focusEmptyHint = { enabled:true, type:"info", text:"这里还没有条目", duration:2200 };

  /* 今日页 · 待办组 · 触发：取消整组勾选 */
  C.taskGroupCancelled = { enabled:true, type:"success", text:"这一组已取消", duration:2200 };

  /* 今日页 · 待办组 · 触发：整组全部勾完 */
  C.taskGroupAllDone = { enabled:true, type:"success", text:"这一组都勾完了", duration:2200 };

  /* 今日页 · 待办 · 触发：加入每天重复清单 */
  C.taskAddedRoutine = { enabled:true, type:"success", text:"已加入每天重复", duration:2200 };

  /* 今日页 · 待办 · 触发：加入今天清单 */
  C.taskAddedTodayList = { enabled:true, type:"success", text:"已加入今天", duration:2200 };

  /* 今日页 · 待办 · 触发：推到明天（列表即反馈）
     默认关闭理由：任务已从今日列表消失、出现在明天，无需额外提示 */
  C.taskPostponed = { enabled:false, type:"success", text:"推到明天了", duration:2200 };

  /* 今日页 · 待办 · 触发：今天跳过这条 */
  C.taskSkippedToday = { enabled:true, type:"info", text:"今日跳过", duration:2200 };

  /* 今日页 · 待办编辑 · 触发：删除任务（弹层关闭即反馈）
     默认关闭理由：任务已从列表消失，无需额外提示 */
  C.taskDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* 今日页 · 待办编辑 · 触发：编辑保存（弹层关闭即反馈）
     默认关闭理由：弹层关闭且列表已更新，无需额外提示 */
  C.taskEdited = { enabled:false, type:"success", text:"改好了", duration:2200 };

  /* 今日页 · 重点 +1 · 触发：点 +1 记一次，提供撤销 */
  C.focusPlusOne = { enabled:true, type:"info", text:"{name} 记了 1 {unit}", duration:8000 };

  /* 今日页 · 重点记录 · 触发：删除一条重点记录（界面即反馈）
     默认关闭理由：记录已消失，无需额外提示 */
  C.itemLogDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* 今日页 · 重点 / 训练 / 学习 · 触发：保存一条带时长的记录 */
  C.focusSavedMinutes = { enabled:true, type:"success", text:"记了 {minutes} {unit}", duration:2200 };

  /* 今日页 · 计划 · 触发：删除计划（列表即反馈）
     默认关闭理由：计划已从列表消失，无需额外提示 */
  C.planDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* 今日页 · 计划编辑 · 触发：保存时内容为空 */
  C.planTextRequired = { enabled:true, type:"warning", text:"记录任务", duration:3500 };

  /* 今日页 · 计划 · 触发：新增带日期的未来计划 */
  C.planAdded = { enabled:true, type:"info", text:"已添加至 {date}", duration:2200 };

  /* 今日页 · 计划 · 触发：勾选计划完成（勾选即视）
     默认关闭理由：勾选状态直接可见，无需额外提示 */
  C.planDone = { enabled:false, type:"success", text:"已完成", duration:2200 };

  /* 今日页 · 计划 · 触发：取消勾选（勾选即视）
     默认关闭理由：勾选状态直接可见，无需额外提示 */
  C.planUndone = { enabled:false, type:"success", text:"放回来了", duration:2200 };

  /* 今日页 · 计划编辑 · 触发：编辑保存（弹层关闭即反馈）
     默认关闭理由：弹层关闭且列表已更新，无需额外提示 */
  C.planEdited = { enabled:false, type:"success", text:"改好了", duration:2200 };

  /* 今日页 · 灵光一闪 · 触发：删除一条灵光（界面即反馈）
     默认关闭理由：条目已从列表消失，无需额外提示 */
  C.ideaDeleted = { enabled:false, type:"success", text:"已删除", duration:2200 };

  /* 今日页 · 灵光一闪 · 触发：保存时内容为空 */
  C.ideaTextRequired = { enabled:true, type:"warning", text:"记录内容", duration:3500 };

  /* 今日页 · 灵光一闪 · 触发：编辑保存（弹层关闭即反馈）
     默认关闭理由：弹层关闭且列表已更新，无需额外提示 */
  C.ideaSaved = { enabled:false, type:"success", text:"已保存", duration:2200 };

  /* 今日页 · 便签备注 · 触发：便签写了内容并保存 */
  C.noteSaved = { enabled:true, type:"info", text:"已记下", duration:2200 };

  /* 今日页 · 便签备注 · 触发：便签内容清空 */
  C.noteCleared = { enabled:true, type:"info", text:"清空了", duration:2200 };

})();
