/* 地球online 配置文件导入 / 导出（Task C1：导出）
 *
 * 与「备份导出」（earthonline-<日期>.json，全量数据）的区别：
 *   配置文件只包含用户自定义定义与设置偏好，用于跨设备恢复使用习惯；
 *   绝不包含日常任务、记录、决策历史等业务数据，也不含任何数据库
 *   基础设施字段（writer / bizRev / migration 等）。
 *
 * 边界（经源码核对，C1 范围修订后）：
 *   - 纳入：pens / tags / suggestions / scenes（definitions 表四类定义，按 id 原样、
 *     按当前显示顺序导出）、plugins（仅 id + enabled，name/desc 由代码内置定义提供）、
 *     settings 白名单（resetHour / theme / showDone / remind / goals /
 *     libFilter / randFilter / uiScale / tasksFold / foodItems / focusItems / mealSlots）。
 *   - 排除：settings 内的状态字段 remindDismissed（提醒关闭记录）、
 *     foodLog（吃过记录，属业务数据）、focusSeedV（设备侧预设补回标记）；
 *     顶层全部业务字段（tasks / schedule / plans / notes / marks / meals 等记录类）一律不进入。
 *   - 已有 id 原样导出，绝不重生成 / 改写（业务记录按 id 引用这些定义）。
 *
 * 数据来源（Task C1 §五）：
 *   - idb 模式：readExportSource()（core.js，单只读事务反解库内已持久化数据），
 *     不读可能还含未保存改动的内容；读取失败则不生成文件。
 *   - legacy 模式：直接取全局 S。
 *
 * 导入侧（解析 / 校验 / 预览 diff / 合并）在后续任务中追加到本模块。 */
(function (global) {
  'use strict';

  var CONFIG_APP = 'earthonline-config';
  var CONFIG_FORMAT_VERSION = 1;
  /* 兼容别名：早期测试引用 FORMAT_VERSION。 */
  var FORMAT_VERSION = CONFIG_FORMAT_VERSION;
  /* 来源元信息里的结构版本：配置文件自己的常量，不读库内 meta.schemaVersion
     （库结构版本属基础设施，不随配置文件走）。 */
  var SOURCE_SCHEMA_VERSION = 1;

  /* settings 白名单：用户偏好与自定义内容。顺序即输出键序（便于 diff 阅读）。
     mealSlots 是用户自定义的餐次清单，内容与顺序都要保留。 */
  var SETTINGS_KEYS = [
    'resetHour', 'theme', 'showDone', 'remind',
    'libFilter', 'randFilter', 'uiScale', 'tasksFold', 'goals',
    'focusItems', 'foodItems', 'mealSlots'
  ];

  function clone(v) {
    if (v === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(v)); }
    catch (e) { return undefined; }
  }

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /* 定义数组：只接受数组元素里的普通对象，深拷贝后原样导出（含 id）。
     结构异常（不是数组 / 元素不是对象）降级为跳过，不抛错、不改输入。 */
  function pickList(v) {
    if (!Array.isArray(v)) return [];
    var out = [];
    for (var i = 0; i < v.length; i++) {
      var it = v[i];
      if (!isPlainObject(it)) continue;
      var c = clone(it);
      if (isPlainObject(c)) out.push(c);
    }
    return out;
  }

  /* settings：只取白名单键。白名单内的 goals / foodItems / focusItems 深拷贝。 */
  function pickSettings(settings) {
    var out = {};
    if (!isPlainObject(settings)) return out;
    for (var i = 0; i < SETTINGS_KEYS.length; i++) {
      var k = SETTINGS_KEYS[i];
      if (settings[k] !== undefined) out[k] = clone(settings[k]);
    }
    return out;
  }

  /* 插件：只迁移 enabled 开关。插件的 id 集合与 name/desc 由代码内置定义决定，
     不随文件走；未知 id 原样保留 id + enabled，由导入侧负责校验。 */
  function pickPlugins(plugins) {
    var out = [];
    if (!Array.isArray(plugins)) return out;
    for (var i = 0; i < plugins.length; i++) {
      var p = plugins[i];
      if (p && typeof p.id === 'string' && p.id) {
        out.push({ id: p.id, enabled: !!p.enabled });
      }
    }
    return out;
  }

  /* 纯函数：从 S 形对象抽取配置子集。data 来自
     - idb 模式：readExportSource()（单只读事务反解的 S 形对象，库内已持久化数据）；
     - legacy 模式：全局 S。
     任何缺失字段降级为空数组 / 空对象，不抛错、不改 data。
     scenes 与 pens/tags/suggestions 一样原样保留（含 id / sys / enabled / order），
     数组顺序即当前显示顺序（idb 归档时已按 order 还原、legacy S 由 normalize 保序）。 */
  function buildConfigPayload(data) {
    if (!isPlainObject(data)) return null;
    return {
      pens: pickList(data.pens),
      tags: pickList(data.tags),
      suggestions: pickList(data.suggestions),
      scenes: pickList(data.scenes),
      plugins: pickPlugins(data.plugins),
      settings: pickSettings(data.settings)
    };
  }

  /* 完整文件信封：格式标识 + 版本号 + 导出时间 + 来源元信息。
     formatVersion 是配置文件自己的格式版本，与备份文件的 version 无关。
     source.schemaVersion 是配置文件来源元信息常量（不读库内 meta.schemaVersion）。
     formatVersion 升级策略：小版本向后兼容读取；大版本在导入侧写迁移器。 */
  function buildConfigFile(data, exportedAt) {
    var payload = buildConfigPayload(data);
    if (!payload) return null;
    return {
      app: CONFIG_APP,
      formatVersion: CONFIG_FORMAT_VERSION,
      exportedAt: typeof exportedAt === 'string' ? exportedAt : new Date().toISOString(),
      source: {
        dataVersion: (data && typeof data.v === 'number') ? data.v : null,
        schemaVersion: SOURCE_SCHEMA_VERSION
      },
      config: payload
    };
  }

  /* ==================== 导入（Task C2） ====================
     三个纯函数：parseConfigFile（校验+规范化）→ previewConfigImport（合并预览）
     → applyResolutions（应用用户逐条冲突裁决）。不读全局 S、不写库、不调 save()。
     提交侧在 core.js：把 applyResolutions 的结果套进 S 再走一次 save()（单事务 CAS）。 */

  /* 大文件保护：超过这个字符数的文件直接拒绝，避免解析 / 克隆占爆内存。 */
  var MAX_IMPORT_CHARS = 2 * 1024 * 1024;

  /* 配置里的用户定义列表（与 C1 导出键一致）。 */
  var LIST_KEYS = ['pens', 'tags', 'suggestions', 'scenes'];

  /* 键序无关的内容比较（数组保持顺序）。同内容 → 自动跳过。 */
  function canonJSON(v) {
    if (Array.isArray(v)) return '[' + v.map(canonJSON).join(',') + ']';
    if (isPlainObject(v)) {
      var ks = Object.keys(v).sort();
      var parts = [];
      for (var i = 0; i < ks.length; i++) parts.push(JSON.stringify(ks[i]) + ':' + canonJSON(v[ks[i]]));
      return '{' + parts.join(',') + '}';
    }
    return JSON.stringify(v);
  }

  function importFail(reason, message) {
    return { ok: false, reason: reason, message: message };
  }

  /* 拒绝任何位置出现的 __proto__ 键（防原型污染；constructor/prototype 作为
     JSON 自有属性无污染风险，但也按异常字段一并拒绝，宁可保守）。 */
  function findProtoKey(v, depth) {
    if (depth > 12) return null;
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length; i++) {
        var hit = findProtoKey(v[i], depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    if (isPlainObject(v)) {
      var ks = Object.keys(v);
      for (var j = 0; j < ks.length; j++) {
        var k = ks[j];
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') return k;
        var sub = findProtoKey(v[k], depth + 1);
        if (sub) return sub;
      }
    }
    return null;
  }

  function validId(v) { return typeof v === 'string' && !!v.trim(); }

  /* 定义列表校验：数组、元素是普通对象、都有非空字符串 id、无重复 id。
     返回 null（通过）或失败原因。 */
  function checkDefList(arr, label) {
    if (!Array.isArray(arr)) return label + ' 必须是列表';
    var seen = {};
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!isPlainObject(it)) return label + ' 第 ' + (i + 1) + ' 项格式不对';
      if (!validId(it.id)) return label + ' 第 ' + (i + 1) + ' 项缺少 id';
      if (seen[it.id]) return label + ' 里有重复 id：' + it.id;
      seen[it.id] = true;
    }
    return null;
  }

  function checkSettings(st) {
    if (!isPlainObject(st)) return 'settings 必须是对象';
    var known = {};
    for (var i = 0; i < SETTINGS_KEYS.length; i++) known[SETTINGS_KEYS[i]] = true;
    var ks = Object.keys(st);
    for (var j = 0; j < ks.length; j++) {
      if (!known[ks[j]]) return 'settings 不认识字段：' + ks[j];
    }
    var numKeys = ['resetHour', 'uiScale'];
    for (var a = 0; a < numKeys.length; a++) {
      var nk = numKeys[a];
      if (nk in st && (typeof st[nk] !== 'number' || !isFinite(st[nk]))) return 'settings.' + nk + ' 必须是数字';
    }
    if ('resetHour' in st && (st.resetHour < 0 || st.resetHour > 6 || st.resetHour !== Math.floor(st.resetHour))) {
      return 'settings.resetHour 要在 0 到 6 之间';
    }
    var strKeys = ['theme', 'libFilter', 'randFilter'];
    for (var b = 0; b < strKeys.length; b++) {
      var sk = strKeys[b];
      if (sk in st && typeof st[sk] !== 'string') return 'settings.' + sk + ' 必须是文字';
    }
    var boolKeys = ['showDone', 'remind', 'tasksFold'];
    for (var c = 0; c < boolKeys.length; c++) {
      var bk = boolKeys[c];
      if (bk in st && typeof st[bk] !== 'boolean') return 'settings.' + bk + ' 必须是开/关';
    }
    if ('goals' in st) {
      if (!isPlainObject(st.goals)) return 'settings.goals 必须是对象';
      var gks = Object.keys(st.goals);
      for (var d = 0; d < gks.length; d++) {
        if (typeof st.goals[gks[d]] !== 'number' || !isFinite(st.goals[gks[d]])) return 'settings.goals 的值必须是数字';
      }
    }
    var itemKeys = ['focusItems', 'foodItems'];
    for (var e = 0; e < itemKeys.length; e++) {
      var ik = itemKeys[e];
      if (ik in st) {
        if (!Array.isArray(st[ik])) return 'settings.' + ik + ' 必须是列表';
        var seen = {};
        for (var f = 0; f < st[ik].length; f++) {
          var it = st[ik][f];
          if (!isPlainObject(it)) return 'settings.' + ik + ' 第 ' + (f + 1) + ' 项格式不对';
          if (!validId(it.id)) return 'settings.' + ik + ' 第 ' + (f + 1) + ' 项缺少 id';
          if (seen[it.id]) return 'settings.' + ik + ' 里有重复 id：' + it.id;
          seen[it.id] = true;
        }
      }
    }
    if ('mealSlots' in st) {
      if (!Array.isArray(st.mealSlots)) return 'settings.mealSlots 必须是列表';
      for (var g = 0; g < st.mealSlots.length; g++) {
        if (typeof st.mealSlots[g] !== 'string') return 'settings.mealSlots 必须都是文字';
      }
    }
    return null;
  }

  /* 解析并校验配置文件文本。opts.pluginIds（可选）：应用已注册的插件 id 列表，
     提供时未注册的插件 id 直接拒绝整个文件。任何校验不过 → ok:false，绝不部分接受。 */
  function parseConfigFile(text, opts) {
    if (typeof text !== 'string' || !text.trim()) return importFail('file-empty', '文件是空的');
    if (text.length > MAX_IMPORT_CHARS) return importFail('file-too-large', '文件太大（上限约 2MB），已拒绝');
    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return importFail('json-invalid', '不是合法的 JSON 文件'); }
    if (!isPlainObject(parsed)) return importFail('envelope-invalid', '文件结构不对');
    var pk = findProtoKey(parsed, 0);
    if (pk) return importFail('proto-key', '文件含有异常字段（' + pk + '），已拒绝');
    if (parsed.app !== CONFIG_APP) return importFail('app-mismatch', '这不是地球online的配置文件');
    if (parsed.formatVersion !== CONFIG_FORMAT_VERSION) {
      return importFail('version-unsupported', '配置文件版本不支持（' + String(parsed.formatVersion) + '）');
    }
    if ('exportedAt' in parsed && typeof parsed.exportedAt !== 'string') {
      return importFail('exported-at-invalid', '导出时间字段不对');
    }
    if (!isPlainObject(parsed.source)) return importFail('source-invalid', '缺少来源信息（source）');
    if ('dataVersion' in parsed.source && typeof parsed.source.dataVersion !== 'number' && parsed.source.dataVersion !== null) {
      return importFail('source-invalid', '来源数据版本不对');
    }
    var cfg = parsed.config;
    if (!isPlainObject(cfg)) return importFail('config-invalid', '缺少配置内容（config）');
    var need = ['pens', 'tags', 'suggestions', 'scenes', 'plugins', 'settings'];
    var ck = Object.keys(cfg).sort();
    var want = need.slice().sort();
    if (ck.length !== want.length) return importFail('config-invalid', 'config 字段集合不对');
    for (var i = 0; i < want.length; i++) {
      if (ck[i] !== want[i]) return importFail('config-invalid', 'config 字段集合不对（多了或少了：' + ck[i] + '）');
    }
    for (var j = 0; j < LIST_KEYS.length; j++) {
      var lk = LIST_KEYS[j];
      var err = checkDefList(cfg[lk], { pens: '笔', tags: '标签', suggestions: '决策库', scenes: '情况' }[lk]);
      if (err) return importFail('list-invalid', err);
    }
    if (!Array.isArray(cfg.plugins)) return importFail('list-invalid', 'plugins 必须是列表');
    var pseen = {};
    for (var m = 0; m < cfg.plugins.length; m++) {
      var p = cfg.plugins[m];
      if (!isPlainObject(p) || !validId(p.id) || typeof p.enabled !== 'boolean') {
        return importFail('plugin-invalid', 'plugins 第 ' + (m + 1) + ' 项格式不对（需要 id 和开/关）');
      }
      if (pseen[p.id]) return importFail('plugin-invalid', 'plugins 里有重复 id：' + p.id);
      pseen[p.id] = true;
      if (opts && Array.isArray(opts.pluginIds) && opts.pluginIds.indexOf(p.id) < 0) {
        return importFail('plugin-unknown', '插件「' + p.id + '」在当前应用里不存在，已拒绝整个文件');
      }
    }
    var serr = checkSettings(cfg.settings);
    if (serr) return importFail('settings-invalid', serr);
    /* 深拷贝一份返回，与解析结果脱钩 */
    var clone;
    try { clone = JSON.parse(JSON.stringify({ file: { app: parsed.app, formatVersion: parsed.formatVersion, exportedAt: parsed.exportedAt || null, source: parsed.source, config: cfg } })); }
    catch (e2) { return importFail('json-invalid', '文件内容无法处理'); }
    return { ok: true, file: clone.file };
  }

  /* 单条定义的人类可读摘要（预览冲突行用）。 */
  function configItemSummary(kind, item) {
    if (!isPlainObject(item)) return '（空）';
    if (kind === 'pen') {
      var s = (item.emoji ? item.emoji + ' ' : '') + (item.name || '');
      if (item.color) s += ' · ' + item.color;
      return s || item.id;
    }
    if (kind === 'tag') return item.name || item.id;
    if (kind === 'suggestion') {
      var t = item.name || '';
      if (item.cat) t += ' · ' + item.cat;
      if (item.duration) t += ' · ' + Math.round(item.duration / 60) + '分钟';
      if (Array.isArray(item.tags) && item.tags.length) t += ' · ' + item.tags.length + '个标签';
      return t || item.id;
    }
    if (kind === 'scene') {
      return (item.name || item.id) + (item.sys ? '（系统）' : '') + (item.enabled === false ? '（停用）' : '');
    }
    if (kind === 'focusItem') {
      var g = item.goal && typeof item.goal === 'object' ? (item.goal.value + (item.goal.unit || '')) : '';
      return (item.text || item.id) + (g ? ' · ' + g : '');
    }
    if (kind === 'foodItem') {
      return (item.name || item.id) + (Array.isArray(item.slots) && item.slots.length ? ' · ' + item.slots.join('/') : '');
    }
    return item.id;
  }

  /* 按 id 合并一类列表。返回 {merged, added:[], conflicts:[], same:[], kept:[]}。
     merged：本机列表原序 + 文件新增按文件顺序追加（冲突/相同项保持本机位置与本机内容）。
     ignoreKeys（可选）：参与「内容是否相同」比较时忽略的键（浅层）。
     典型用法：scenes 忽略 order —— 显示顺序由合并后的数组下标决定，文件里的 order
     只是导出时的位置快照，不该因为它不同就把内容相同的项判成冲突。 */
  function withoutKeys(it, ignoreKeys) {
    if (!ignoreKeys || !ignoreKeys.length || !isPlainObject(it)) return it;
    var c = JSON.parse(JSON.stringify(it));
    for (var i = 0; i < ignoreKeys.length; i++) delete c[ignoreKeys[i]];
    return c;
  }
  function mergeByIdList(localArr, fileArr, kind, ignoreKeys) {
    var localMap = {};
    var merged = [];
    var added = [], conflicts = [], same = [], kept = [];
    var i, it;
    for (i = 0; i < localArr.length; i++) {
      it = localArr[i];
      localMap[it.id] = true;
      merged.push(it);
      kept.push(it.id);
    }
    var fileOnly = [];
    for (i = 0; i < fileArr.length; i++) {
      it = fileArr[i];
      if (!localMap[it.id]) { fileOnly.push(it); continue; }
      var localIt = null;
      for (var j = 0; j < localArr.length; j++) if (localArr[j].id === it.id) { localIt = localArr[j]; break; }
      if (canonJSON(withoutKeys(localIt, ignoreKeys)) === canonJSON(withoutKeys(it, ignoreKeys))) same.push(it.id);
      else conflicts.push({ key: kind + ':' + it.id, kind: kind, id: it.id, local: localIt, incoming: it });
    }
    for (i = 0; i < fileOnly.length; i++) {
      merged.push(fileOnly[i]);
      added.push(fileOnly[i].id);
    }
    return { merged: merged, added: added, conflicts: conflicts, same: same, kept: kept };
  }

  /* 把冲突裁决应用进合并结果：choices[key] === 'incoming' 才换成导入版本。
     冲突项保持本机位置；scenes 合并后统一按数组下标重排 order。 */
  var KIND_TO_LIST = {
    pen: 'pens', tag: 'tags', suggestion: 'suggestions', scene: 'scenes',
    focusItem: 'settings.focusItems', foodItem: 'settings.foodItems'
  };

  function listOf(merged, kind) {
    var path = KIND_TO_LIST[kind];
    if (!path) return null;
    var parts = path.split('.');
    var cur = merged;
    for (var i = 0; i < parts.length; i++) {
      if (!isPlainObject(cur) && !Array.isArray(cur)) return null;
      cur = cur[parts[i]];
    }
    return Array.isArray(cur) ? cur : null;
  }

  function applyResolutions(preview, choices) {
    var src = preview && preview.merged;
    if (!isPlainObject(src)) return null;
    var merged;
    try { merged = JSON.parse(JSON.stringify(src)); }
    catch (e) { return null; }
    var ch = (choices && typeof choices === 'object') ? choices : {};
    var applied = 0;
    var conflicts = (preview.conflicts || []).slice();
    for (var c = 0; c < conflicts.length; c++) {
      var cf = conflicts[c];
      var wantIncoming = ch[cf.key] === 'incoming';
      var arr = listOf(merged, cf.kind);
      if (!arr) continue;
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].id === cf.id) {
          arr[i] = JSON.parse(JSON.stringify(wantIncoming ? cf.incoming : cf.local));
          if (wantIncoming) applied++;
          break;
        }
      }
    }
    /* scenes：裁决后统一按显示顺序重排 order（顺序=数组下标，与产品语义一致） */
    if (Array.isArray(merged.scenes)) {
      for (var s = 0; s < merged.scenes.length; s++) merged.scenes[s].order = s;
    }
    return { merged: merged, appliedIncoming: applied };
  }

  /* 合并预览。local / file 都是 buildConfigPayload 形状（白名单子集）。
     规则（Task C2 §四）：
       - 标量设置：文件提供即覆盖，值相同算跳过；文件没提供的保持本机。
       - goals：按键覆盖（文件提供的键覆盖本机，没提供的键保留本机）。
       - focusItems / foodItems：按 id 合并（新增 / 相同跳过 / 不同进冲突 / 本机独有保留）。
       - mealSlots：文件提供即整体替换（内容 + 顺序），不做逐项合并。
       - pens / tags / suggestions / scenes：按 id 合并，规则同上；新增追加到本机列表末尾。
       - scenes 合并后按数组下标重排 order，绝不被字典序破坏。
       - plugins：两边都有 → 只改 enabled；文件独有 → 追加（解析阶段已校验已注册）。 */
  function previewConfigImport(local, file, opts) {
    if (!isPlainObject(local) || !isPlainObject(file)) return null;
    var conflicts = [];
    var stats = { add: 0, conflict: 0, same: 0, keepLocal: 0 };
    var merged = {};

    var listKinds = [
      { key: 'pens', kind: 'pen' }, { key: 'tags', kind: 'tag' },
      { key: 'suggestions', kind: 'suggestion' },
      /* scenes：内容比较忽略 order（顺序语义 = 合并后数组下标，见 mergeByIdList 注释） */
      { key: 'scenes', kind: 'scene', ignoreKeys: ['order'] }
    ];
    for (var i = 0; i < listKinds.length; i++) {
      var lk = listKinds[i];
      var r = mergeByIdList(Array.isArray(local[lk.key]) ? local[lk.key] : [],
        Array.isArray(file[lk.key]) ? file[lk.key] : [], lk.kind, lk.ignoreKeys);
      merged[lk.key] = r.merged;
      stats.add += r.added.length;
      stats.same += r.same.length;
      stats.keepLocal += r.kept.length - r.same.length - (r.conflicts.length);
      conflicts = conflicts.concat(r.conflicts);
    }
    /* scenes：显示顺序 = 合并后数组下标 */
    if (Array.isArray(merged.scenes)) {
      for (var s = 0; s < merged.scenes.length; s++) merged.scenes[s].order = s;
    }

    /* plugins：两边都有只改 enabled；文件独有追加 {id, enabled}。
       统计口径：与导入前的本机状态比较（不能拿合并后的值再比，否则恒等 → 计数恒 0）。
       pluginDetails：逐项明细供预览展示——updates 是已有插件开关翻转（本机名 + 原状态/新状态），
       adds 是本机没有的已注册插件（名字由调用方通过 opts.pluginNames 提供注册表名称）。 */
    var localPlugins = Array.isArray(local.plugins) ? local.plugins : [];
    var filePlugins = Array.isArray(file.plugins) ? file.plugins : [];
    var mergedPlugins = [];
    var pluginUpdates = 0, pluginAdds = 0;
    var pluginDetails = { updates: [], adds: [] };
    for (var p = 0; p < localPlugins.length; p++) {
      var lp = localPlugins[p];
      var np = isPlainObject(lp) ? JSON.parse(JSON.stringify(lp)) : lp;
      for (var q = 0; q < filePlugins.length; q++) {
        if (filePlugins[q].id === np.id) { np.enabled = filePlugins[q].enabled; break; }
      }
      mergedPlugins.push(np);
    }
    function pluginNameOf(lp, fp) {
      if (isPlainObject(lp) && typeof lp.name === 'string' && lp.name) return lp.name;
      var names = (opts && isPlainObject(opts.pluginNames)) ? opts.pluginNames : null;
      return (names && typeof names[fp.id] === 'string') ? names[fp.id] : null;
    }
    for (var q2 = 0; q2 < filePlugins.length; q2++) {
      var fp = filePlugins[q2];
      var lpHit = null;
      for (var q3 = 0; q3 < localPlugins.length; q3++) if (localPlugins[q3].id === fp.id) { lpHit = localPlugins[q3]; break; }
      if (lpHit) {
        if (lpHit.enabled !== fp.enabled) {
          pluginUpdates++;
          pluginDetails.updates.push({ id: fp.id, name: pluginNameOf(lpHit, fp), from: !!lpHit.enabled, to: !!fp.enabled });
        }
      } else {
        mergedPlugins.push({ id: fp.id, enabled: fp.enabled });
        pluginAdds++;
        pluginDetails.adds.push({ id: fp.id, name: pluginNameOf(null, fp), enabled: !!fp.enabled });
      }
    }
    merged.plugins = mergedPlugins;
    stats.pluginUpdates = pluginUpdates;
    stats.pluginAdds = pluginAdds;
    stats.pluginDetails = pluginDetails;

    /* settings */
    var ls = isPlainObject(local.settings) ? local.settings : {};
    var fs = isPlainObject(file.settings) ? file.settings : {};
    var mergedSettings = {};
    var settingsChanged = [];
    for (var k in fs) {
      mergedSettings[k] = fs[k];
      if (k === 'goals') {
        var mg = isPlainObject(ls.goals) ? JSON.parse(JSON.stringify(ls.goals)) : {};
        var gks = Object.keys(fs.goals || {});
        for (var g = 0; g < gks.length; g++) mg[gks[g]] = fs.goals[gks[g]];
        mergedSettings[k] = mg;
        if (canonJSON(mg) !== canonJSON(ls.goals)) settingsChanged.push(k);
        continue;
      }
      if (k === 'focusItems' || k === 'foodItems') {
        var kind = k === 'focusItems' ? 'focusItem' : 'foodItem';
        var rr = mergeByIdList(Array.isArray(ls[k]) ? ls[k] : [], fs[k], kind);
        mergedSettings[k] = rr.merged;
        stats.add += rr.added.length;
        stats.same += rr.same.length;
        stats.keepLocal += Math.max(0, rr.kept.length - rr.same.length - rr.conflicts.length);
        conflicts = conflicts.concat(rr.conflicts);
        continue;
      }
      if (canonJSON(fs[k]) !== canonJSON(ls[k])) settingsChanged.push(k);
    }
    merged.settings = mergedSettings;
    stats.settingsChanged = settingsChanged;

    stats.conflict = conflicts.length;
    stats.nothingToDo = stats.add === 0 && conflicts.length === 0 && settingsChanged.length === 0 &&
      pluginUpdates === 0 && pluginAdds === 0;
    conflicts.forEach(function (cf) { cf.label = configItemSummary(cf.kind, cf.local); });
    return {
      ok: true,
      stats: stats,
      conflicts: conflicts,
      conflictKeys: conflicts.map(function (cf) { return cf.key; }),
      merged: merged
    };
  }


  /* 预览 + 冲突裁决下，这次导入是否真的会改本机配置。
     冲突全部保留本机且没有新增/设置变更/插件变化 → false（无可导入变更，
     UI 禁用确认、不提交、bizRev 不动）；任一冲突选了导入版或有其他实际变化 → true。 */
  function previewHasEffectiveChange(preview, choices) {
    if (!preview || !isPlainObject(preview.stats)) return false;
    var s = preview.stats;
    if (s.add > 0 || s.pluginUpdates > 0 || s.pluginAdds > 0) return true;
    if (Array.isArray(s.settingsChanged) && s.settingsChanged.length) return true;
    var ch = (choices && typeof choices === 'object') ? choices : {};
    var cfs = Array.isArray(preview.conflicts) ? preview.conflicts : [];
    for (var i = 0; i < cfs.length; i++) if (ch[cfs[i].key] === 'incoming') return true;
    return false;
  }

  function notice(msg) {
    if (typeof global.toast === 'function') { try { global.toast(msg); return; } catch (e) {} }
    if (global.console && global.console.warn) global.console.warn(msg);
  }

  function configFileName() {
    /* 业务日期：todayReal() 在 today.js（后加载）；单独引用本模块时退回自然日。 */
    var d;
    try { d = (typeof global.todayReal === 'function') ? global.todayReal() : new Date().toISOString().slice(0, 10); }
    catch (e) { d = new Date().toISOString().slice(0, 10); }
    return 'earthonline-config-' + d + '.json';
  }

  /* 生成并下载配置文件。
     失败安全：构建失败 / 序列化失败 / 下载环境不可用 → 不产生文件，只提示。
     只读：不读全局 S、不写任何存储、不调用 save()、不改传入对象。 */
  function writeConfigFile(data) {
    var payload = null;
    try { payload = buildConfigFile(data, new Date().toISOString()); }
    catch (e) { payload = null; }
    if (!payload) { notice('导出失败：数据不可读，未生成配置文件'); return false; }

    var text = null;
    try { text = JSON.stringify(payload, null, 2); }
    catch (e) { text = null; }
    if (!text) { notice('导出失败：无法生成配置文件'); return false; }

    try {
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = configFileName();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    } catch (e) {
      notice('导出失败：浏览器不支持下载，未生成配置文件');
      return false;
    }
    notice('已导出配置文件');
    return true;
  }

  /* idb 模式：导出必须等于 IndexedDB 里已持久化的数据，不能夹带内存中未保存的改动。
     读取通道 readExportSource()（core.js）失败时绝不退回内存 S，也不生成文件。 */
  function exportConfigFromIdb() {
    if (typeof global.readExportSource !== 'function') {
      notice('导出失败：读取本地库不可用，未生成配置文件');
      return false;
    }
    global.readExportSource(writeConfigFile, function (msg) {
      notice('导出失败：' + msg + '，未生成配置文件');
    });
    return true;
  }

  /* 入口：与写入闸门共用同一个 idb 模式判定，避免两处判定漂移。
     legacy 模式直接从 S 构造（保持既有双模式兼容）。 */
  function exportConfig() {
    if (typeof global.bizWriteBlocked === 'function' && global.bizWriteBlocked()) {
      return exportConfigFromIdb();
    }
    return writeConfigFile(global.S);
  }

  global.OLConfigIO = {
    CONFIG_APP: CONFIG_APP,
    CONFIG_FORMAT_VERSION: CONFIG_FORMAT_VERSION,
    FORMAT_VERSION: FORMAT_VERSION,
    SOURCE_SCHEMA_VERSION: SOURCE_SCHEMA_VERSION,
    MAX_IMPORT_CHARS: MAX_IMPORT_CHARS,
    SETTINGS_KEYS: SETTINGS_KEYS,
    buildConfigPayload: buildConfigPayload,
    buildConfigFile: buildConfigFile,
    configFileName: configFileName,
    writeConfigFile: writeConfigFile,
    exportConfig: exportConfig,
    exportConfigFromIdb: exportConfigFromIdb,
    parseConfigFile: parseConfigFile,
    previewConfigImport: previewConfigImport,
    previewHasEffectiveChange: previewHasEffectiveChange,
    applyResolutions: applyResolutions,
    canonJSON: canonJSON,
    configItemSummary: configItemSummary
  };

  /* 设置页按钮（settings.js）按既有导出函数风格直接调用全局 exportConfig。
     只新增这一个入口，不额外扩散全局变量。 */
  global.exportConfig = exportConfig;
})(window);
