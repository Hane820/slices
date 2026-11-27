/* cloud-backup.js — 云端备份最小闭环（只上传，不恢复、不同步）
   边界：
   - 只读取已提交数据：idb 模式复用 core.js 的 readExportSource()（只读事务重水合）；
     legacy 模式读取已经写入 localStorage 的 S。不读取未保存候选状态。
   - 触发来自 save() 的成功出口；本模块不调用 save()、不改业务队列。
   - 生产构建与本地页面使用同一个 Worker URL；不存任何 JWT / Cookie / AUD。 */
(function(){
  var DEV_ENDPOINT = 'https://earthonline-backup.1317746169.workers.dev';
  function defaultEndpoint(){
    try {
      if(typeof location !== 'undefined' && /^https?:$/.test(location.protocol) && location.origin) return location.origin;
    } catch(e){}
    return DEV_ENDPOINT;
  }
  var STATE_KEY = 'earthonline-cloud-backup-v1';
  var LEASE_KEY = 'earthonline-cloud-backup-lease';
  var ENDPOINT_KEY = 'earthonline-cloud-backup-endpoint';
  var DEBOUNCE_MS = 3000;
  var RETRY_MS = 8000;
  var HEARTBEAT_MS = 60000;
  var LEASE_MS = 30000;
  var TAB_ID = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  var listeners = [];
  var listenersAttached = false;
  /* 空间门禁：只认身份模块的已落定记录，明确 space==='local'（= 将来的 user 空间）
     且绑定正式库时才允许云端备份。游客（含认领旧库的 guest）一律视为禁止，
     判定异常也 fail-closed。这是行为层门禁，不依赖任何 UI 文案或按钮状态。 */
  function guestBlocked(){
    try {
      if(!window.OLIdentity || typeof OLIdentity.record !== 'function') return true;
      var r = OLIdentity.record();
      if(!r) return true;                          /* 无记录 = 默认游客 */
      if(r.space !== 'local') return true;
      return r.dbName !== 'earthonline';
    } catch (e) { return true; }
  }
  /* 身份指纹：用于识别一次异步上传期间身份是否被切换（guest↔user / 换库） */
  function identityKey(){
    try {
      if(!window.OLIdentity || typeof OLIdentity.record !== 'function') return 'none';
      var r = OLIdentity.record();
      return r ? (r.space + '|' + r.dbName) : 'none';
    } catch (e) { return 'none'; }
  }
  function sameIdentity(owner){
    return identityKey() === owner && !guestBlocked();
  }
  var state = {
    pending: false, seq: 0, dirtyAt: 0,
    lastSuccessAt: null, lastError: '', lastFailureAt: 0,
    serverHasBackup: null, serverUploadedAt: null, statusError: ''
  };
  var uploading = false;
  var timer = null;
  var retries = 0;
  var heartbeat = null;

  function endpoint(){
    try { var v = localStorage.getItem(ENDPOINT_KEY); if(v && /^https?:\/\//.test(v)) return v.replace(/\/$/, ''); }
    catch(e){}
    return defaultEndpoint();
  }
  function readState(){
    try {
      var raw = localStorage.getItem(STATE_KEY);
      if(!raw) return;
      var s = JSON.parse(raw);
      if(!s || typeof s !== 'object') return;
      state.pending = !!s.pending;
      state.seq = typeof s.seq === 'number' ? s.seq : 0;
      state.dirtyAt = typeof s.dirtyAt === 'number' ? s.dirtyAt : 0;
      state.lastSuccessAt = typeof s.lastSuccessAt === 'string' ? s.lastSuccessAt : null;
      state.lastError = typeof s.lastError === 'string' ? s.lastError : '';
      state.lastFailureAt = typeof s.lastFailureAt === 'number' ? s.lastFailureAt : 0;
    } catch(e){}
  }
  function persist(){
    try { localStorage.setItem(STATE_KEY, JSON.stringify({
      pending:state.pending, seq:state.seq, dirtyAt:state.dirtyAt,
      lastSuccessAt:state.lastSuccessAt, lastError:state.lastError, lastFailureAt:state.lastFailureAt
    })); } catch(e){}
  }
  function emit(){
    var snap = snapshot();
    for(var i=0;i<listeners.length;i++){
      try { listeners[i](snap); } catch(e){}
    }
    try { window.dispatchEvent(new CustomEvent('earthonline-cloud-backup', { detail:snap })); } catch(e){}
  }
  function snapshot(){
    /* 游客：对外快照里不存在待备份 / 失败 / 上传中。即使 localStorage 里
       残留过旧身份的状态，也不让任何 UI 把它当成游客的备份状态展示。 */
    if(guestBlocked()){
      return {
        status:'disabled', enabled:false,
        pending:false, uploading:false,
        lastSuccessAt:null, lastError:'', statusError:'',
        serverHasBackup:null, serverUploadedAt:null
      };
    }
    return {
      status: uploading ? 'uploading' : (state.pending ? 'pending' : (state.lastSuccessAt ? 'synced' : (state.serverHasBackup ? 'server-only' : 'none'))),
      enabled:true,
      pending:state.pending, uploading:uploading,
      lastSuccessAt:state.lastSuccessAt,
      lastError:state.lastError, statusError:state.statusError,
      serverHasBackup:state.serverHasBackup, serverUploadedAt:state.serverUploadedAt
    };
  }
  function clearTimer(){ if(timer){ clearTimeout(timer); timer = null; } }
  function schedule(delay){
    clearTimer();
    timer = setTimeout(function(){ timer = null; run('auto'); }, delay);
  }

  /* 多标签页：30 秒租约，避免两个页面同时上传；旧租约过期后允许接管 */
  function acquireLease(){
    try {
      var raw = localStorage.getItem(LEASE_KEY);
      if(raw){
        var lease = JSON.parse(raw);
        if(lease && lease.tabId && lease.tabId !== TAB_ID &&
           (Date.now() - (lease.at || 0)) < LEASE_MS) return false;
      }
      localStorage.setItem(LEASE_KEY, JSON.stringify({ tabId:TAB_ID, at:Date.now() }));
      return true;
    } catch(e){ return true; }
  }
  function releaseLease(){
    try {
      var raw = localStorage.getItem(LEASE_KEY);
      var lease = raw ? JSON.parse(raw) : null;
      if(lease && lease.tabId === TAB_ID) localStorage.removeItem(LEASE_KEY);
    } catch(e){}
  }

  function committedData(done){
    if(typeof window.readExportSource === 'function' &&
       typeof window.bizWriteBlocked === 'function' && window.bizWriteBlocked()){
      /* 与完整 JSON 导出同一条已验证的安全只读通道 */
      window.readExportSource(done, function(msg){ done(null, msg); });
      return;
    }
    try { done(JSON.parse(JSON.stringify(window.S || {}))); }
    catch(e){ done(null, '读取本地数据失败'); }
  }

  function parseResponse(res){
    return res.text().then(function(text){
      var body = null;
      try { body = JSON.parse(text); } catch(e){}
      return { ok:res.ok && body && body.ok === true, res:res, body:body };
    });
  }

  function run(reason){
    /* 身份级门禁：旧身份排下的定时任务、切换后遗留的重试，都在这里作废。
       不能只靠 markDirty/backupNow 入口判断——timer 可能在切换之后才触发。 */
    if(guestBlocked()) return false;
    if(uploading) return false;               /* 单飞：同一页面绝不并发上传 */
    if(!state.pending && reason !== 'manual') return false;
    if(!acquireLease()) { schedule(RETRY_MS); return false; }
    var ownerAtStart = identityKey();
    uploading = true;
    var seqAtStart = state.seq;
    emit();
    committedData(function(data, err){
      if(!sameIdentity(ownerAtStart)){
        /* 读取数据期间身份已切换：丢弃这一轮，不改任何状态、不排下一轮 */
        uploading = false; releaseLease(); emit(); return;
      }
      if(!data || typeof data !== 'object'){
        uploading = false; releaseLease(); fail(err || '读取本地数据失败'); emit(); return;
      }
      var payload;
      try { payload = window.buildBackupPayload(data); }
      catch(e){
        uploading = false; releaseLease(); fail('生成备份失败'); emit(); return;
      }
      var init = {
        method:'PUT', credentials:'include',
        headers:{ 'Content-Type':'application/json' },
        body: JSON.stringify(payload)
      };
      fetch(endpoint() + '/api/backup', init)
        .then(parseResponse)
        .then(function(r){
          /* 上传期间切回游客 / 换库：响应结果不属于当前身份，不得写状态或再排队。
             请求本身已发出无法撤回，但不会污染新身份的状态机。 */
          if(!sameIdentity(ownerAtStart)){ uploading = false; releaseLease(); emit(); return; }
          if(!r.ok){
            var msg = (r.body && (r.body.message || r.body.error)) || ('HTTP ' + r.res.status);
            var err = new Error(msg);
            /* 按服务端机器可读码分类：只有明确 Session 失效才降级；
               403 / CSRF / Access 拦截 / 网络 / 5xx 都保留 user + pending。 */
            err.authResult = { status:r.res.status, body:r.body || {}, error:(r.body && r.body.error) || '' };
            err.authClass = classifyAuthFailure(err.authResult);
            throw err;
          }
          var at = (r.body && r.body.stored && r.body.stored.uploadedAt) || new Date().toISOString();
          state.lastSuccessAt = at;
          state.lastError = ''; state.lastFailureAt = 0;
          retries = 0;
          /* 上传期间有新提交：保守保留待备份，下轮上传最新完整备份 */
          if(state.seq === seqAtStart) state.pending = false;
          persist();
          uploading = false; releaseLease(); emit();
          if(state.pending && !guestBlocked()) schedule(DEBOUNCE_MS);
        })
        .catch(function(e){
          if(!sameIdentity(ownerAtStart)){ uploading = false; releaseLease(); emit(); return; }
          uploading = false; releaseLease(); fail((e && e.message) || '上传失败'); emit();
          var cls = e && e.authClass;
          if(cls === 'session-invalid') handleAuthFailure(e.authResult);
          /* 认证/授权类失败（401/403 无论分类）都不快速重试，避免反复撞 Access/验签；
             只有网络/5xx 等可恢复故障延迟重试一次。是否降级与是否重试是两个独立判断。 */
          var authStatus = e && e.authResult && e.authResult.status;
          var noRetry = cls === 'session-invalid' || cls === 'auth-denied' ||
            authStatus === 401 || authStatus === 403;
          if(retries < 1 && !noRetry){ retries++; schedule(RETRY_MS); }
        });
    });
    return true;
  }

  /* 认证失败分类统一走 auth.js；auth.js 未加载的隔离环境里只认机器码
     code='session-invalid' / reason='no-valid-session'，其余一律保留 user。 */
  function classifyAuthFailure(r){
    if(window.OLAuth && typeof OLAuth.classifyAuthFailure === 'function'){
      return OLAuth.classifyAuthFailure(r);
    }
    var body = (r && r.body) || {};
    if(body.code === 'session-invalid') return 'session-invalid';
    if(body.error === 'no-session' || (body.error === 'unauthorized' && body.reason === 'no-valid-session')) return 'session-invalid';
    if((r && r.status) === 0) return 'transient';
    if(r && r.status >= 500) return 'transient';
    return 'auth-denied';
  }

  /* 仅当确认应用 Session 失效才降级；把响应交给 auth.js 再核对一次，双重保险 */
  function handleAuthFailure(result){
    if(window.OLAuth && typeof OLAuth.markSessionInvalid === 'function'){
      try { OLAuth.markSessionInvalid(result); } catch(e){}
    }
  }

  function fail(message){
    state.pending = true;                     /* 失败绝不丢弃待备份状态 */
    state.lastError = String(message || '上传失败').slice(0, 200);
    state.lastFailureAt = Date.now();
    persist();
  }

  function refreshStatus(){
    if(guestBlocked()) return Promise.resolve(null);   /* 游客：连状态都不查 */
    var owner = identityKey();
    return fetch(endpoint() + '/api/backup/status', { method:'GET', credentials:'include' })
      .then(parseResponse)
      .then(function(r){
        if(!sameIdentity(owner)) return snapshot();     /* 期间切换身份：不写状态 */
        if(!r.ok){
          var statusErr = new Error((r.body && (r.body.message || r.body.error)) || ('HTTP ' + r.res.status));
          statusErr.authResult = { status:r.res.status, body:r.body || {}, error:(r.body && r.body.error) || '' };
          statusErr.authClass = classifyAuthFailure(statusErr.authResult);
          throw statusErr;
        }
        state.serverHasBackup = !!r.body.hasBackup;
        state.serverUploadedAt = r.body.uploadedAt || null;
        state.statusError = '';
        emit();
        return snapshot();
      })
      .catch(function(e){
        if(!sameIdentity(owner)) return snapshot();
        if(e && e.authClass === 'session-invalid') handleAuthFailure(e.authResult);
        state.statusError = (e && e.message) || '云端状态读取失败';
        emit();
        return snapshot();
      });
  }

  function markDirty(source){
    if(guestBlocked()) return;                /* 游客：不记待备份、不排上传 */
    state.pending = true;
    state.seq++;
    state.dirtyAt = Date.now();
    persist();
    emit();
    schedule(DEBOUNCE_MS);                    /* 最后一次成功提交后 3 秒合并上传 */
  }

  function backupNow(){
    /* 手动与自动共用同一队列：上传中重复点击不再改序号，避免成功后误以为有新提交 */
    if(guestBlocked()) return false;          /* 游客：手动也拒绝，不给任何上传入口 */
    if(uploading) return false;
    state.pending = true; state.seq++; state.dirtyAt = Date.now(); persist();
    clearTimer();
    return run('manual');
  }

  function stopTimers(){
    clearTimer();
    if(heartbeat){ clearInterval(heartbeat); heartbeat = null; }
  }

  /* user（local）空间的自动备份启动：只有身份已落定且绑定正式库才进来。
     启动补传依赖 localStorage 里持久化的 pending/seq，刷新页面不会丢任务。 */
  function startUser(){
    if(guestBlocked()) return false;
    readState();
    refreshStatus();
    if(state.pending) schedule(1500);
    if(heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(function(){
      if(!guestBlocked() && state.pending && !uploading) run('retry');
    }, HEARTBEAT_MS);
    emit();
    return true;
  }

  function attachListeners(){
    if(listenersAttached) return;
    listenersAttached = true;
    window.addEventListener('online', function(){ if(!guestBlocked() && state.pending) schedule(1000); });
    window.addEventListener('storage', function(e){
      if(guestBlocked()) return;                /* 游客标签页不因别的标签页写状态而启动上传 */
      if(!e || e.key === STATE_KEY){ readState(); emit(); }
      if(state.pending && !uploading && !timer) schedule(RETRY_MS);
    });
  }

  /* 身份切换的唯一入口：先停旧身份的定时任务，再按当前已确认身份决定是否启动。
     guest → user：这里才启动 user 备份；user → guest：定时器全停，in-flight 结果
     由 run() 的 identityKey 校验丢弃，不会把游客数据写成待上传。 */
  function syncIdentity(){
    stopTimers();
    retries = 0;
    if(guestBlocked()){ emit(); return false; }
    return startUser();
  }

  function init(){
    /* 只挂监听、广播一次当前快照；不在这里直接启动上传。
       启动层（boot.js finishBoot）确认身份与业务数据初始化完成后调用 syncIdentity()：
       guest 是 no-op，user 才真正启动自动备份。 */
    attachListeners();
    emit();
  }

  window.OLCloudBackup = {
    init:init, markDirty:markDirty, backupNow:backupNow, refreshStatus:refreshStatus,
    syncIdentity:syncIdentity, snapshot:snapshot, subscribe:function(fn){
      if(typeof fn === 'function') listeners.push(fn);
      return function(){ var i = listeners.indexOf(fn); if(i >= 0) listeners.splice(i, 1); };
    }
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
