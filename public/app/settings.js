/* settings.js — 设置 */
/* ==================== 设置 ==================== */
function renderSettings(){
  // 标记池
  var pp = $('penPool');
  pp.innerHTML = '';
  S.pens.forEach(function(p){
    var pill = el('div','pill');
    var dot = el('span','dotc');
    dot.style.background = rgba(p.color,.6);
    dot.textContent = p.emoji || '';
    pill.appendChild(dot);
    pill.appendChild(el('span', null, p.name || '未命名'));
    var x = el('button','x','×');
    x.addEventListener('click', function(ev){
      ev.stopPropagation();
      if(S.pens.length <= 1){ toastCfg('lastMarkerProtected'); return; }
      confirmBox('删掉「' + (p.name||'未命名') + '」？', '用过这个标记的日期会变回空白。', function(){
        S.pens = S.pens.filter(function(y){ return y.id !== p.id; });
        for(var k in S.marks){ S.marks[k].items = (S.marks[k].items || []).filter(function(it){ return it.penId !== p.id; }); if(!S.marks[k].items.length) delete S.marks[k]; }
        save(function(){ toastCfg('markerDeleted'); }); renderSettings();
      });
    });
    pill.appendChild(x);
    pill.addEventListener('click', function(){ openPenEdit(p); });
    pp.appendChild(pill);
  });
  var addP = el('button','pill add',U('common.action.newMarker'));
  addP.addEventListener('click', function(){ openPenEdit(null); });
  pp.appendChild(addP);

  // 标签池
  var tp = $('tagPool');
  tp.innerHTML = '';
  S.tags.forEach(function(t){
    var pill = el('div','pill');
    pill.appendChild(el('span', null, t.name));
    var x = el('button','x','×');
    x.addEventListener('click', function(ev){
      ev.stopPropagation();
      confirmBox('删除标签「' + t.name + '」？', '之前的打卡记录会一起消失。', function(){
        S.tags = S.tags.filter(function(y){ return y.id !== t.id; });
        S.tagLogs = S.tagLogs.filter(function(l){ return l.tagId !== t.id; });
        save(function(){ toastCfg('tagDeleted'); }); renderSettings();
      });
    });
    pill.appendChild(x);
    pill.addEventListener('click', function(){
      openModal({
        title:'改标签名', sub:'', input:true, value:t.name, placeholder:'标签名', okText:'保存',
        onOk:function(v){ t.name = v; save(function(){ toastCfg('tagRenamed'); }); renderSettings(); }
      });
    });
    tp.appendChild(pill);
  });
  var addT = el('button','pill add',U('common.action.newTag'));
  addT.addEventListener('click', function(){
    openModal({
      title:'新建标签', sub:'点一下记一次，用来数频率', input:true, placeholder:'比如「晒了太阳」', okText:'加上',
      onOk:function(v){
        S.tags.push({ id: uid('tag'), name:v });
        save(function(){ toastCfg('tagAdded'); }); renderSettings(); renderTagsRow();
      }
    });
  });
  tp.appendChild(addT);

  // 插件：统一按 S.plugins 渲染；以后加插件只要在 defaultPlugins 里补一条
  var gl = $('pluginSet');
  gl.innerHTML = '';
  S.plugins.forEach(function(p){
    var r = el('div','row');
    var m = el('div','row-main');
    m.appendChild(el('div','row-t', p.name));
    m.appendChild(el('div','row-s', p.desc || ''));
    r.appendChild(m);
    var sw = el('button','sw' + (p.enabled ? ' on' : ''));
    sw.title = p.enabled ? '关掉' : '打开';
    r.appendChild(sw);
    r.addEventListener('click', function(){
      p.enabled = !p.enabled;
      save(function(){ toastCfg(p.enabled ? 'pluginOn' : 'pluginOff', { name: p.name }); });
      renderSettings();
      renderToday();
      if(typeof renderDecideShell === 'function') renderDecideShell();
    });
    gl.appendChild(r);
  });

  // 其它
  var ob = $('otherSet');
  ob.innerHTML = '';
  var rr = el('div','row');
  var rrm = el('div','row-main');
  rrm.appendChild(el('div','row-t',U('settings.daycut.title')));
  rrm.appendChild(el('div','row-s',U('settings.daycut.subtitle')));
  rr.appendChild(rrm);
  rr.appendChild(el('div','row-a', '凌晨 ' + S.settings.resetHour + ':00'));
  rr.addEventListener('click', function(){
    askNumber('几点算新的一天（0-6 点）', S.settings.resetHour, 0, 6, function(v){
      S.settings.resetHour = v; save(function(){ toastCfg('resetHourSaved'); }); renderSettings(); renderToday();
    });
  });
  ob.appendChild(rr);

  // 外观：固定橘子汽水配色，没有主题切换；只保留全局字号
  var lb = $('lookSet');
  lb.innerHTML = '';
  var lrow = el('div','row');
  var lrm = el('div','row-main');
  lrm.appendChild(el('div','row-t',U('settings.font.title')));
  lrm.appendChild(el('div','row-s',U('settings.font.subtitle')));
  lrow.appendChild(lrm);
  var lval = el('div','row-a', Math.round((S.settings.uiScale || 1.12) * 100) + '%');
  lrow.appendChild(lval);
  lb.appendChild(lrow);
  var slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0.9'; slider.max = '1.5'; slider.step = '0.02';
  slider.value = String(S.settings.uiScale || 1.12);
  slider.style.cssText = 'width:100%;margin:10px 0 4px;accent-color:var(--sage);cursor:pointer';
  slider.addEventListener('input', function(){
    var v = Math.round(parseFloat(slider.value) * 100) / 100;
    S.settings.uiScale = v;
    applyUiScale();
    lval.textContent = Math.round(v * 100) + '%';
  });
  slider.addEventListener('change', function(){ save(function(){ toastCfg('fontScaleSaved'); }, { highFrequency:true }); });
  lb.appendChild(slider);

  // 数据
  var db = $('dataSet');
  db.innerHTML = '';
  function dataRow(label, sub, fn){
    var r = el('div','row');
    var m = el('div','row-main');
    m.appendChild(el('div','row-t', label));
    if(sub) m.appendChild(el('div','row-s', sub));
    r.appendChild(m);
    r.appendChild(el('div','row-a','›'));
    r.addEventListener('click', fn);
    db.appendChild(r);
  }
  dataRow(U('settings.data.exportPdf.title'), U('settings.data.exportPdf.subtitle'), openPdfPanel);
  dataRow(U('settings.data.exportBackup.title'), U('settings.data.exportBackup.subtitle'), exportJSON);
  dataRow(U('settings.data.exportTable.title'), U('settings.data.exportTable.subtitle'), exportTable);
  dataRow(U('settings.data.exportConfig.title'), U('settings.data.exportConfig.subtitle'), exportConfig);
  dataRow(U('settings.data.importConfig.title'), U('settings.data.importConfig.subtitle'), importConfig);
  dataRow(U('settings.data.restoreBackup.title'), U('settings.data.restoreBackup.subtitle'), importJSON);
  dataRow(U('settings.data.clearAll.title'), U('settings.data.clearAll.subtitle'), function(){
    if(bizWriteBlocked()){ bizWriteBlockedNotice(); return; }   /* idb 模式：入口拦截，S 不被清空 */
    confirmBox('清空全部数据？', '所有待办、标记、记录、训练都会消失，而且找不回来。', function(){
      S = defaults();
      normalize();
      save(); renderAll(); toastCfg('allDataCleared');
    });
  });
  renderCloudSet();
  renderGuestSet();
}

/* 认证错误码 → 界面文案（沿用文案中心；Toast 配置中心不改动）
   文案中心禁止动态 key，所以错误码逐一落到静态 U(key)：分支与错误码一一对应，
   未知 code 仍落到原来的默认文案，返回值的文本与迁移前完全一致。 */
function authErrorText(code){
  switch(code){
    case 'bad-email': return U('settings.auth.error.badEmail');
    case 'bad-input': return U('settings.auth.error.badInput');
    case 'rate-limited': return U('settings.auth.error.rateLimited');
    case 'code-invalid': return U('settings.auth.error.codeInvalid');
    case 'code-expired': return U('settings.auth.error.codeExpired');
    case 'code-consumed': return U('settings.auth.error.codeConsumed');
    case 'too-many-attempts': return U('settings.auth.error.tooManyAttempts');
    case 'email-unconfigured': return U('settings.auth.error.emailUnconfigured');
    case 'email-send-failed': return U('settings.auth.error.emailSendFailed');
    case 'network-error':
    case 'offline': return U('settings.auth.error.network');
    case 'auth-unavailable': return U('settings.auth.error.unavailable');
    case 'no-session': return U('settings.auth.error.noSession');
    case 'account-disabled': return U('settings.auth.error.accountDisabled');
    default: return U('settings.auth.error.default');
  }
}

/* 真实邮箱验证码登录：发送成功 ≠ 登录成功；只有服务端 Session 验证成功后才切身份 */
function openLoginSheet(){
  if(!window.OLAuth){
    openModal({ title:U('settings.auth.login.moduleUnavailable'), message:U('settings.auth.login.moduleNotLoaded'), okText:U('common.action.gotIt') });
    return;
  }
  var body = openSheet(
    '<div class="shd"><div class="shd-t">登录 / 开启云端备份</div>' +
    '<div class="shd-s">用邮箱验证码登录。验证成功后才会进入用户空间；游客数据不会被自动上传或合并。</div></div>' +
    '<div class="pv-sec">邮箱</div>' +
    '<input class="inp" id="authEmail" type="email" maxlength="254" placeholder="you@example.com">' +
    '<button class="btn p" id="authSend" style="margin-top:10px">发送验证码</button>' +
    '<div id="authStep2" style="display:none">' +
      '<div class="pv-sec">验证码</div>' +
      '<input class="inp" id="authCode" inputmode="numeric" maxlength="6" placeholder="6 位数字">' +
      '<button class="btn p" id="authVerify" style="margin-top:10px">登录</button>' +
    '</div>' +
    '<div class="row-s" id="authMsg" style="margin-top:10px"></div>' +
    '<button class="btn g" id="authCancel" style="margin-top:10px">取消</button>'
  );
  function q(id){ return body.querySelector('#' + id); }
  function say(t){ var m = q('authMsg'); if(m) m.textContent = t || ''; }

  q('authCancel').addEventListener('click', closeSheet);

  var sendBtn = q('authSend');
  sendBtn.addEventListener('click', function(){
    var email = q('authEmail').value.trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ say(authErrorText('bad-email')); return; }
    sendBtn.disabled = true; say(U('settings.auth.login.sending'));
    OLAuth.requestCode(email).then(function(r){
      sendBtn.disabled = false;
      if(!r.ok){ say(authErrorText(r.error)); return; }
      /* 只进入第二步，绝不提前切换身份 */
      q('authStep2').style.display = 'block';
      say(U('settings.auth.login.codeSent'));
    });
  });

  var verifyBtn = q('authVerify');
  verifyBtn.addEventListener('click', function(){
    var email = q('authEmail').value.trim();
    var code = q('authCode').value.trim();
    if(!/^\d{6}$/.test(code)){ say(authErrorText('code-invalid')); return; }
    verifyBtn.disabled = true; say(U('settings.auth.login.verifying'));
    OLAuth.verifyCode(email, code).then(function(r){
      verifyBtn.disabled = false;
      if(!r.ok){ say(authErrorText(r.error)); return; }
      /* 再读一次服务端身份；失败仍保留 guest */
      return OLAuth.session().then(function(sr){
        var su = sr && sr.body && sr.body.user;
        if(!sr.ok || !su || !su.id){ say(authErrorText(sr && sr.error ? sr.error : 'no-session')); return; }
        var entered = OLIdentity.enterUser({
          userId: su.id,
          email: su.emailMasked || '',
          source: 'auth-session'
        });
        if(!entered.ok){ say(U('settings.auth.login.identityWriteFailed')); return; }
        if(window.OLCloudBackup && typeof OLCloudBackup.syncIdentity === 'function') OLCloudBackup.syncIdentity();
        closeSheet();
        location.reload();
      });
    });
  });
}

/* 退出登录：服务端撤销成功后才切回 guest；失败 / 超时保持 user 状态 */
function logoutUser(){
  if(!window.OLAuth){
    openModal({ title:U('settings.auth.logout.failed'), message:U('settings.auth.logout.moduleNotLoaded'), okText:U('common.action.gotIt') });
    return;
  }
  OLAuth.logout().then(function(r){
    if(!r.ok){
      openModal({
        title: U('settings.auth.logout.failed'),
        message: U('settings.auth.logout.sessionNotRevoked'),
        okText: U('common.action.gotIt')
      });
      return;
    }
    OLIdentity.demoteToGuest('logout');
    if(window.OLCloudBackup && typeof OLCloudBackup.syncIdentity === 'function') OLCloudBackup.syncIdentity();
    location.reload();
  });
}

/* 空间区：显示当前真实身份（guest / user=local），按身份给出对应说明。
   当前版本尚未接入账号系统：登录入口如实标注「未开放」，不伪造登录态，
   也不因为展示这个入口而读写任何账号或云端数据。 */
function renderGuestSet(){
  var box = $('guestSet');
  if(!box || !window.OLIdentity) return;
  box.innerHTML = '';

  var rec = typeof OLIdentity.record === 'function' ? OLIdentity.record() : null;
  var guest = !rec || rec.space === 'guest';

  function infoRow(title, sub, tail, onClick){
    var row = el('div','row');
    var main = el('div','row-main');
    main.appendChild(el('div','row-t', title));
    if(sub) main.appendChild(el('div','row-s', sub));
    row.appendChild(main);
    if(tail) row.appendChild(el('div','row-a', tail));
    if(typeof onClick === 'function') row.addEventListener('click', onClick);
    box.appendChild(row);
    return row;
  }

  if(guest){
    infoRow(U('settings.space.guest.current'), U('settings.space.guest.subtitle'), '●');
    infoRow(U('settings.space.guest.data'), U('settings.space.guest.dataSubtitle'));
    infoRow(U('settings.space.login.title'),
      U('settings.space.login.subtitle'),
      U('settings.space.login.action'), openLoginSheet);

    var reset = el('div','row');
    var rm = el('div','row-main');
    rm.appendChild(el('div','row-t', U('settings.space.guest.reset')));
    rm.appendChild(el('div','row-s', U('settings.space.guest.resetSubtitle')));
    reset.appendChild(rm);
    reset.appendChild(el('div','row-a','›'));
    reset.addEventListener('click', function(){
      confirmBox('重置游客数据？',
        '游客空间里的增删改都会消失，然后恢复成初始演示内容。登录用户的数据完全不受影响。',
        function(){
          if(!window.OLGuest){ toastCfg('guestSpaceUnavailable'); return; }
          OLGuest.clear().then(function(r){
            if(r && r.ok){ location.reload(); return; }
            toastCfg('guestClearFailed');
          }, function(){ toastCfg('guestClearFailed'); });
        });
    });
    box.appendChild(reset);
    return;
  }

  /* local = 将来的 user 空间。当前没有登录入口能创建它，只有历史记录会走到这里；
     账号信息尚未接入，不显示、不编造任何账号。 */
  var rec = OLIdentity.record() || {};
  infoRow(U('settings.space.user.current'), U('settings.space.user.subtitle'), '●');
  infoRow(U('settings.space.user.account'), rec.email || U('settings.space.user.accountUnavailable'));
  infoRow(U('settings.space.user.cloudBackup'), U('settings.space.user.cloudEnabled'), U('settings.space.user.cloudEnabledTag'));
  infoRow(U('settings.space.user.logout'), U('settings.space.user.logoutSubtitle'), U('settings.space.user.logoutAction'), logoutUser);
}

/* 云端备份区：按身份区分展示。
   guest：只有一句状态说明，没有状态数字、没有失败信息、没有「立即备份」按钮；
   user ：自动备份已启用 + 状态 + 最近成功时间 +（确有失败时）失败信息 + 刷新入口。
   真正的权限门禁在 cloud-backup 的调用层，这里只是如实呈现。 */
function renderCloudSet(){
  var box = $('cloudSet');
  if(!box || !window.OLCloudBackup) return;
  box.innerHTML = '';

  function line(title, sub){
    var row = el('div','row');
    var main = el('div','row-main');
    main.appendChild(el('div','row-t', title));
    if(sub) main.appendChild(el('div','row-s', sub));
    row.appendChild(main);
    box.appendChild(row);
    return row;
  }

  var guest = !window.OLIdentity || OLIdentity.isGuest();
  if(guest){
    line(U('settings.cloud.guest.title'),
         U('settings.cloud.guest.subtitle'));
    return;
  }

  var st = OLCloudBackup.snapshot();
  if(!st.enabled){
    /* 身份在渲染瞬间变化（例如刚切回游客）：按未启用处理，不显示任何上传状态 */
    line(U('settings.cloud.guest.title'),
         U('settings.cloud.guest.subtitle'));
    return;
  }

  var labels = {
    uploading:'正在上传', pending:'待备份', synced:'已同步备份',
    'server-only':'云端已有备份（本机未确认）', none:'未备份', disabled:'未启用'
  };

  line(U('settings.cloud.user.autoTitle'), U('settings.cloud.user.autoSubtitle'));

  var row = el('div','row');
  var main = el('div','row-main');
  main.appendChild(el('div','row-t',U('settings.cloud.user.statusTitle')));
  main.appendChild(el('div','row-s',labels[st.status] || st.status));
  row.appendChild(main);
  row.appendChild(el('div','row-a',st.uploading ? '…' : '›'));
  box.appendChild(row);

  var time = el('div','row');
  var tm = el('div','row-main');
  tm.appendChild(el('div','row-t',U('settings.cloud.user.lastSuccessTitle')));
  tm.appendChild(el('div','row-s',st.lastSuccessAt
    ? new Date(st.lastSuccessAt).toLocaleString('zh-CN')
    : (st.serverUploadedAt ? '云端有备份，但本机还没确认上传成功' : '还没有成功上传过')));
  time.appendChild(tm);
  box.appendChild(time);

  /* 失败信息只在确实发生过失败时出现；游客分支永远不会走到这里 */
  if(st.lastError){
    var er = el('div','row');
    var em = el('div','row-main');
    em.appendChild(el('div','row-t',U('settings.cloud.user.lastErrorTitle')));
    em.appendChild(el('div','row-s',st.lastError + '；待备份数据已保留'));
    er.appendChild(em);
    box.appendChild(er);
  }

  var acts = el('div','row');
  var refresh = el('button','btn g sm',U('settings.cloud.user.refresh'));
  refresh.type = 'button';
  refresh.addEventListener('click', function(){ OLCloudBackup.refreshStatus(); });
  var now = el('button','btn p sm',U('settings.cloud.user.backupNow'));
  now.type = 'button';
  now.disabled = !!st.uploading;
  now.addEventListener('click', function(){
    if(!OLCloudBackup.backupNow()) toastCfg('backupUploadBusy');
  });
  acts.appendChild(refresh);
  acts.appendChild(now);
  box.appendChild(acts);

  var note = el('div','row-s',U('settings.cloud.user.note'));
  note.style.marginTop = '10px';
  box.appendChild(note);
}

function askNumber(title, cur, min, max, cb){
  openModal({
    title: title, sub: min + ' 到 ' + max + ' 之间', input:true, value:String(cur), numeric:true, okText:'保存',
    onOk:function(v){
      var n = parseInt(v, 10);
      if(isNaN(n) || n < min || n > max){ toastCfg('numberOutOfRange', { min: min, max: max }); return; }
      cb(n);
    }
  });
}

function openPenEdit(existing){
  var draft = existing
    ? { color: existing.color, emoji: existing.emoji || '', name: existing.name }
    : { color: COLORS[0], emoji: '', name: '' };   /* 新建默认无符号，可随时点选 */
  var body = openSheet(
    '<div class="shd"><div class="shd-t">' + (existing ? '改这个标记' : '新建一个标记') + '</div>' +
    '<div class="shd-s">下面的预览就是它在月历上的样子。</div></div>' +
    '<div class="pv-cell"><span class="pv-emo" id="pvEmo"></span><span class="pv-swipe" id="pvSwipe"></span><span class="pv-name" id="pvName"></span></div>' +
    '<div class="pv-sec">颜色</div><div class="swatches" id="swW"></div>' +
    '<div class="pv-sec">符号（可选）</div><div class="emos" id="emW"></div>' +
    '<div class="pv-sec">名字</div><input class="inp" id="penN" maxlength="6" placeholder="比如「有点累」" value="' + esc(draft.name) + '">' +
    '<div class="acts">' + (existing ? '<button class="btn d fx" id="penDel">删除</button>' : '') +
      '<button class="btn g" id="penNo">取消</button><button class="btn p" id="penOk">保存</button></div>'
  );
  /* 实时预览：模拟月历格子——色道压底、符号在上方、名字居中；无符号=纯色道 */
  function pv(){
    body.querySelector('#pvSwipe').style.background = draft.color;
    var emo = body.querySelector('#pvEmo');
    emo.textContent = draft.emoji || '';
    emo.style.display = draft.emoji ? 'block' : 'none';
    var name = body.querySelector('#penN').value.trim();
    body.querySelector('#pvName').textContent = name || (existing ? existing.name : '名字');
  }
  function drawSw(){
    var w = body.querySelector('#swW');
    w.innerHTML = '';
    COLORS.forEach(function(c){
      var sel = c === draft.color;
      var d = el('div','sw-c' + (sel ? ' sel' : ''));
      d.style.background = c;
      if(sel) d.style.boxShadow = '0 0 0 3px ' + rgba(c, .3);   /* 选中：2px 描边 + 浅色外圈 */
      d.addEventListener('click', function(){ draft.color = c; drawSw(); pv(); });
      w.appendChild(d);
    });
  }
  function drawEm(){
    var w = body.querySelector('#emW');
    w.innerHTML = '';
    /* 首位「无符号」：虚线圆圈 */
    var none = el('div','em none' + (draft.emoji ? '' : ' sel'));
    none.title = '无符号';
    none.addEventListener('click', function(){ draft.emoji = ''; drawEm(); pv(); });
    w.appendChild(none);
    EMOJIS.forEach(function(e){
      var d = el('div','em' + (e === draft.emoji ? ' sel' : ''), e);
      d.addEventListener('click', function(){ draft.emoji = e; drawEm(); pv(); });
      w.appendChild(d);
    });
  }
  var nameInp = body.querySelector('#penN');
  var okBtn = body.querySelector('#penOk');
  function syncOk(){ okBtn.disabled = !nameInp.value.trim(); }
  nameInp.addEventListener('input', function(){ syncOk(); pv(); });
  drawSw(); drawEm(); pv(); syncOk();
  body.querySelector('#penNo').addEventListener('click', closeSheet);
  if(existing){
    body.querySelector('#penDel').addEventListener('click', function(){
      if(S.pens.length <= 1){ toastCfg('lastMarkerProtected'); return; }
      confirmBox('删掉这个标记？', '用过它的日期会变回空白。', function(){
        S.pens = S.pens.filter(function(y){ return y.id !== existing.id; });
        for(var k in S.marks){ S.marks[k].items = (S.marks[k].items || []).filter(function(it){ return it.penId !== existing.id; }); if(!S.marks[k].items.length) delete S.marks[k]; }
        save(function(){ toastCfg('markerDeleted'); }); closeSheet(); renderSettings();
      });
    });
  }
  body.querySelector('#penOk').addEventListener('click', function(){
    var n = nameInp.value.trim();
    if(!n){ toastCfg('markerNameRequired'); return; }
    if(existing){
      existing.color = draft.color; existing.emoji = draft.emoji; existing.name = n;
    }else{
      S.pens.push({ id: uid('p'), color: draft.color, emoji: draft.emoji, name: n });
    }
    save(function(){ toastCfg('markerSaved'); }); closeSheet(); renderSettings();
  });
}


/* 今日重点的入口已移到首页（每张卡下的半圆书签 + 末尾新建卡），
   这里只保留编辑面板本身，不再渲染设置页列表。 */

/* 一条重点的完整编辑：名字 / 输入方式（多选 chips / 自填文本）/ 每天目标（数字 + 单位，可不设） */
function openFocusEdit(it, isNew){
  var mode = (it && it.mode === 'multi') ? 'multi' : 'text';
  var opts = (it && it.mode === 'multi' && Array.isArray(it.options)) ? it.options.slice() : [];
  var lbl = it ? (it.label || '') : '';
  var phv = it ? (it.ph || '') : '';
  /* 目标状态：noGoal = 不设；unit 是当前单位，custom = 用的是自定义单位 */
  var hasGoal = it ? focusHasGoal(it) : true;
  var noGoal = !hasGoal;
  var unit = it ? focusUnit(it) : '分钟';
  var custom = FOCUS_UNITS.indexOf(unit) < 0;
  var goalVal = (it && it.goal && +it.goal.value > 0) ? +it.goal.value : 30;
  var html = '<div class="shd"><div class="shd-t">' + (isNew ? '加一条重点' : '改这条重点') + '</div>' +
    '<div class="shd-s">点首页这张卡记一次：计时类填分钟，计数类点一下 +1。</div></div>' +
    '<div class="field"><div class="field-l">名字</div><input class="inp" id="fxName" maxlength="20" placeholder="喝水 / 拉伸 / 背单词" value="' + esc(it ? it.text : '') + '"></div>' +
    '<div class="field"><div class="field-l">输入方式</div><div class="chips" id="fxMode">' +
      '<button class="chip' + (mode === 'multi' ? ' on' : '') + '" data-m="multi">多选</button>' +
      '<button class="chip' + (mode === 'text' ? ' on' : '') + '" data-m="text">自填</button>' +
    '</div></div>' +
    '<div id="fxModeBox"></div>' +
    '<div class="field"><div class="field-l">每天目标</div>' +
      '<div class="fx-goal-row">' +
        '<div class="fx-goal-main" id="fxGoalBox">' +
          '<input class="fx-num" id="fxGoal" type="number" inputmode="decimal" step="any" min="0" placeholder="—" value="' + fmtNum(goalVal) + '">' +
          '<span class="fx-unit"><select class="chip fx-unit-sel" id="fxUnitSel">' +
            FOCUS_UNITS.map(function(u){ return '<option value="' + u + '">' + u + '</option>'; }).join('') +
            '<option value="自定义">自定义</option>' +
          '</select></span>' +
          '<input class="fx-num fx-num-custom" id="fxUnitCustom" maxlength="4" placeholder="单位">' +
        '</div>' +
        '<button class="chip ghost fx-no-goal" id="fxNoGoal">不设目标</button>' +
      '</div>' +
    '</div>' +
    '<div class="acts"><button class="btn g" id="fxNo">取消</button><button class="btn p" id="fxOk">保存</button></div>' +
    (isNew ? '' : '<button class="fx-del" id="fxDel">删除此条目</button>');

  var body = openSheet(html);

  /* 模式专属配置区：multi = 选项编辑；text = 字段名 + 占位提示 */
  function renderModeBox(){
    var box = body.querySelector('#fxModeBox');
    if(mode === 'multi'){
      box.innerHTML = '<div class="field"><div class="field-l">选项（至少 1 个，点一下删掉）</div>' +
        '<div class="chips" id="fxOpts">' +
          opts.map(function(o, i){
            return '<button class="chip" data-i="' + i + '">' + esc(o) + '<span class="opt-x">×</span></button>';
          }).join('') +
        '</div>' +
        '<div class="opt-add"><input class="inp" id="fxOptIn" maxlength="8" placeholder="加一个选项，比如 跑步"><button class="btn g" id="fxOptAdd">加上</button></div>' +
      '</div>';
      box.querySelectorAll('#fxOpts .chip').forEach(function(c){
        c.addEventListener('click', function(){
          opts.splice(parseInt(c.dataset.i, 10), 1);
          renderModeBox();
        });
      });
      box.querySelector('#fxOptAdd').addEventListener('click', function(){
        var v = box.querySelector('#fxOptIn').value.trim();
        if(!v){ toastCfg('optionNameRequired'); return; }
        if(opts.indexOf(v) >= 0){ toastCfg('optionDuplicate'); return; }
        opts.push(v);
        renderModeBox();
        var again = box.querySelector('#fxOptIn');
        if(again) again.focus();
      });
    }else{
      box.innerHTML = '<div class="field"><div class="field-l">字段名</div><input class="inp" id="fxLbl" maxlength="8" placeholder="比如 学了什么" value="' + esc(lbl) + '"></div>' +
        '<div class="field"><div class="field-l">占位提示</div><input class="inp" id="fxPh" maxlength="24" placeholder="输入框里的灰色提示，比如 高数 / 单词…" value="' + esc(phv) + '"></div>';
      body.querySelector('#fxLbl').addEventListener('input', function(){ lbl = this.value; });
      body.querySelector('#fxPh').addEventListener('input', function(){ phv = this.value; });
    }
  }
  renderModeBox();

  /* 每天目标：数字 + 单位下拉 + 不设目标，固定一行；切换只淡入淡出，不改行高 */
  var goalBox = body.querySelector('#fxGoalBox');
  var goalInp = body.querySelector('#fxGoal');
  var unitSel = body.querySelector('#fxUnitSel');
  var customInp = body.querySelector('#fxUnitCustom');
  var noBtn = body.querySelector('#fxNoGoal');
  var okBtn = body.querySelector('#fxOk');

  function goalValid(){
    if(noGoal) return { ok:true };
    var v = parseFloat(goalInp.value);
    var u = custom ? String(customInp.value || '').trim().slice(0, 4) : unitSel.value;
    if(!(v > 0)) return { ok:false, bad:'num' };
    if(!u) return { ok:false, bad:'unit' };
    return { ok:true };
  }
  function refreshOk(){
    var st = goalValid();
    okBtn.disabled = !st.ok;
    goalInp.classList.toggle('err', st.bad === 'num');
    customInp.classList.toggle('err', st.bad === 'unit');
  }
  function syncGoal(){
    unitSel.value = custom ? '自定义' : (FOCUS_UNITS.indexOf(unit) >= 0 ? unit : '分钟');
    goalBox.classList.toggle('off', noGoal);
    noBtn.classList.toggle('on', noGoal);
    customInp.classList.toggle('on', !noGoal && custom);
    customInp.value = custom ? (unit || '') : '';
    refreshOk();
  }

  unitSel.addEventListener('change', function(){
    noGoal = false;
    if(unitSel.value === '自定义'){
      custom = true;
      if(FOCUS_UNITS.indexOf(unit) >= 0) unit = '';
      syncGoal();
      customInp.focus();
    }else{
      custom = false;
      unit = unitSel.value;
      syncGoal();
    }
  });
  customInp.addEventListener('input', function(){
    unit = this.value.trim().slice(0, 4);
    refreshOk();
  });
  goalInp.addEventListener('input', refreshOk);
  noBtn.addEventListener('click', function(){
    noGoal = !noGoal;
    if(!noGoal && !unit) unit = '分钟';
    syncGoal();
  });
  syncGoal();

  /* 切换输入方式：有已填配置时先二次确认 */
  body.querySelectorAll('#fxMode .chip').forEach(function(c){
    c.addEventListener('click', function(){
      var m = c.dataset.m;
      if(m === mode) return;
      var dirty = (mode === 'multi') ? opts.length > 0 : !!(lbl.trim() || phv.trim());
      function doSwitch(){
        mode = m;
        if(mode === 'multi'){ opts = []; } else { lbl = ''; phv = ''; }
        body.querySelectorAll('#fxMode .chip').forEach(function(x){
          x.classList.toggle('on', x.dataset.m === mode);
        });
        renderModeBox();
      }
      if(dirty){
        confirmBox('切换输入方式？', '会清掉已填的' + (mode === 'multi' ? '选项' : '字段设置') + '。', doSwitch, { okText: '确定切换' });
      }else{
        doSwitch();
      }
    });
  });

  body.querySelector('#fxNo').addEventListener('click', closeSheet);
  body.querySelector('#fxOk').addEventListener('click', function(){
    var name = body.querySelector('#fxName').value.trim();
    if(!name){ toastCfg('focusNameRequired'); return; }
    if(mode === 'multi' && !opts.length){ toastCfg('focusNeedsOption'); return; }
    var gu = String(unit || '').trim().slice(0, 4);
    var goal = null;
    if(!noGoal){
      var gv = parseFloat(goalInp.value);
      if(!(gv > 0)){ goalInp.classList.add('err'); goalInp.focus(); toastCfg('focusGoalInvalid'); return; }
      if(!gu){ customInp.classList.add('err'); customInp.focus(); toastCfg('focusUnitRequired'); return; }
      goal = { value: Math.round(gv * 100) / 100, unit: gu };
    }
    var fields = (mode === 'multi')
      ? { mode:'multi', options: opts.slice(), label:'', ph:'' }
      : { mode:'text', options:[], label: lbl.trim(), ph: phv.trim() };
    if(isNew){
      S.settings.focusItems.push({ id: uid('fi'), text: name, goal: goal, unit: gu || '分钟', mode: fields.mode, options: fields.options, label: fields.label, ph: fields.ph });
    }else{
      it.text = name; it.goal = goal; it.unit = gu || '分钟';
      it.mode = fields.mode; it.options = fields.options; it.label = fields.label; it.ph = fields.ph;
    }
    save(function(){ toastCfg(isNew ? 'focusAdded' : 'focusSaved'); }); closeSheet(); renderGoals(); renderRemind();
    if(currentPage === 'pRecords') renderProject();
  });
  if(!isNew){
    body.querySelector('#fxDel').addEventListener('click', function(){
      var pos = S.settings.focusItems.indexOf(it);
      confirmBox('删除这条重点？', '删除「' + it.text + '」？此操作不可撤销。', function(){
        closeSheet();
        S.settings.focusItems = S.settings.focusItems.filter(function(x){ return x !== it; });
        save(function(){
          toastCfg('focusDeleted', { name: it.text }, '撤销', function(){
            S.settings.focusItems.splice(Math.min(pos, S.settings.focusItems.length), 0, it);
            save(function(){ toastCfg('focusRestored'); }); renderGoals();
            if(currentPage === 'pRecords') renderProject();
          });
        });
        renderGoals();
        if(currentPage === 'pRecords') renderProject();
      }, { okText: '确认删除' });
    });
  }
}

/* ==================== 决策情况（自定义） ====================
   S.scenes：稳定 id，顺序即决策页显示顺序（order 随数组下标刷新）。
   内置情境是系统项——不可删除、缺失自动补回，可改名/停用；
   删除自定义情况不级联删除历史决策记录（记录存的是 id，展示也不查这里）。
   全部改动走 save() 串行队列，不碰其他业务数据。 */
function sceneMove(id, dir, onDone){
  if(!Array.isArray(S.scenes)) return;
  var i = -1;
  S.scenes.forEach(function(sc, j){ if(sc && sc.id === id) i = j; });
  var j = i + dir;
  if(i < 0 || j < 0 || j >= S.scenes.length) return;
  var t = S.scenes[i]; S.scenes[i] = S.scenes[j]; S.scenes[j] = t;
  normalize();
  save(function(){ toastCfg('scenesReordered'); });
  renderSettings();
  if(typeof renderScenes === 'function') renderScenes();
  if(typeof onDone === 'function') onDone();
}
function openSceneEdit(id, onDone){
  var isNew = !id;
  var sc = isNew ? null : byId(S.scenes, id);
  if(!isNew && !sc) return;
  var body = openSheet(
    '<div class="shd"><div class="shd-t">' + (isNew ? '新建一个情况' : '编辑情况') + '</div>' +
    '<div class="shd-s">' + (isNew ? '会出现在决策页「你现在是什么情况」里，建议库里也能绑到它。' : (sc.sys ? '系统自带：不能删，可以改名或停用。' : '自己加的情况，可以改、删、调顺序。')) + '</div></div>' +
    '<div class="field"><div class="field-l">名称</div><input class="inp" id="scN" maxlength="12" value="' + esc(sc ? sc.name : '') + '" placeholder="比如：等项目"></div>' +
    '<div class="field"><div class="field-l">一句话说明（可空）</div><input class="inp" id="scD" maxlength="30" value="' + esc(sc ? sc.desc : '') + '" placeholder="卡片下方的小字"></div>' +
    (!isNew ? '<div class="row" style="border-top:none"><div class="row-main"><div class="row-t">在决策页显示</div><div class="row-s">停用只是不出现，绑定的建议和记录都在</div></div><div class="row-a"><button class="sw' + (sc.enabled ? ' on' : '') + '" id="scE"></button></div></div>' : '') +
    '<div class="acts">' + (!isNew && !sc.sys ? '<button class="btn d fx" id="scDel">删除</button>' : '') +
      '<button class="btn g" id="scNo">取消</button><button class="btn p" id="scOk">保存</button></div>'
  );
  var enabled = sc ? sc.enabled !== false : true;
  var sw = body.querySelector('#scE');
  if(sw) sw.addEventListener('click', function(){ enabled = !enabled; sw.classList.toggle('on', enabled); });
  body.querySelector('#scNo').addEventListener('click', closeSheet);
  body.querySelector('#scOk').addEventListener('click', function(){
    var name = body.querySelector('#scN').value.trim();
    var desc = body.querySelector('#scD').value.trim();
    if(!name){ toastCfg('sceneNameRequired'); return; }
    if(isNew){
      S.scenes.push({ id: uid('sc'), name: name, desc: desc, sys: false, enabled: true });
      normalize();
      save(function(){ toastCfg('sceneAdded'); });
    } else {
      sc.name = name; sc.desc = desc; sc.enabled = enabled;
      normalize();
      save(function(){ toastCfg('sceneSaved'); });
    }
    closeSheet();
    renderSettings();
    if(typeof renderScenes === 'function') renderScenes();
  if(typeof onDone === 'function') onDone();
  });
  var delBtn = body.querySelector('#scDel');
  if(delBtn) delBtn.addEventListener('click', function(){
    confirmBox('删除「' + sc.name + '」？', '只删这个情况本身：过去的决策记录和绑定的建议都不受影响。', function(){
      /* 只清建议里对这个情况的引用（建议本身保留）；历史决策记录存的是 id，原样保留 */
      S.suggestions.forEach(function(sg){
        if(Array.isArray(sg.scenes) && sg.scenes.indexOf(sc.id) >= 0){
          sg.scenes = sg.scenes.filter(function(k){ return k !== sc.id; });
        }
      });
      S.scenes = S.scenes.filter(function(x){ return x.id !== sc.id; });
      normalize();
      save(function(){ toastCfg('sceneDeleted'); });
      closeSheet();
      renderSettings();
      if(typeof renderScenes === 'function') renderScenes();
  if(typeof onDone === 'function') onDone();
    });
  });
}

/* 云端备份状态变化（自动/手动/跨标签页）时刷新设置页区域 */
window.addEventListener('earthonline-cloud-backup', function(){
  if($('cloudSet')) renderCloudSet();
});
