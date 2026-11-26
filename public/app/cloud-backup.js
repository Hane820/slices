/* cloud-backup.js — 云端备份最小闭环（只上传，不恢复、不同步）
   边界：
   - 只读取已提交数据：idb 模式复用 core.js 的 readExportSource()（只读事务重水合）；
     legacy 模式读取已经写入 localStorage 的 S。不读取未保存候选状态。
   - 触发来自 save() 的成功出口；本模块不调用 save()、不改业务队列。
   - 生产构建与本地页面使用同一个 Worker URL；不存任何 JWT / Cookie / AUD。 */
(function(){
  var DEFAULT_ENDPOINT = 'https://earthonline-backup.1317746169.workers.dev';
  var STATE_KEY = 'earthonline-cloud-backup-v1';
  var LEASE_KEY = 'earthonline-cloud-backup-lease';
  var ENDPOINT_KEY = 'earthonline-cloud-backup-endpoint';
  var DEBOUNCE_MS = 3000;
  var RETRY_MS = 8000;
  var HEARTBEAT_MS = 60000;
  var LEASE_MS = 30000;
  var TAB_ID = 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  var listeners = [];
  /* 游客空间不参与云端备份：门禁放在这里（真实调用层），而不是靠设置页隐藏按钮。
     命中后 init / markDirty / backupNow / refreshStatus 全部短路，
     不读也不写 STATE_KEY / LEASE_KEY，不发任何请求、不碰 R2 与正式备份 pointer。 */
  function guestBlocked(){
    try { return !!(window.OLIdentity && typeof OLIdentity.isGuest === 'function' && OLIdentity.isGuest()); }
    catch (e) { return true; }        /* 判定不了就按游客处理：宁可不备份，也不误传 */
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
    return DEFAULT_ENDPOINT;
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
    return {
      status: uploading ? 'uploading' : (state.pending ? 'pending' : (state.lastSuccessAt ? 'synced' : (state.serverHasBackup ? 'server-only' : 'none'))),
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
    if(uploading) return false;               /* 单飞：同一页面绝不并发上传 */
    if(!state.pending && reason !== 'manual') return false;
    if(!acquireLease()) { schedule(RETRY_MS); return false; }
    uploading = true;
    var seqAtStart = state.seq;
    emit();
    committedData(function(data, err){
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
          if(!r.ok){
            var msg = (r.body && (r.body.message || r.body.error)) || ('HTTP ' + r.res.status);
            throw new Error(msg);
          }
          var at = (r.body && r.body.stored && r.body.stored.uploadedAt) || new Date().toISOString();
          state.lastSuccessAt = at;
          state.lastError = ''; state.lastFailureAt = 0;
          retries = 0;
          /* 上传期间有新提交：保守保留待备份，下轮上传最新完整备份 */
          if(state.seq === seqAtStart) state.pending = false;
          persist();
          uploading = false; releaseLease(); emit();
          if(state.pending) schedule(DEBOUNCE_MS);
        })
        .catch(function(e){
          uploading = false; releaseLease(); fail((e && e.message) || '上传失败'); emit();
          if(retries < 1){ retries++; schedule(RETRY_MS); }   /* 只延迟重试一次，避免无限快速重试 */
        });
    });
    return true;
  }

  function fail(message){
    state.pending = true;                     /* 失败绝不丢弃待备份状态 */
    state.lastError = String(message || '上传失败').slice(0, 200);
    state.lastFailureAt = Date.now();
    persist();
  }

  function refreshStatus(){
    if(guestBlocked()) return Promise.resolve(null);   /* 游客：连状态都不查 */
    return fetch(endpoint() + '/api/backup/status', { method:'GET', credentials:'include' })
      .then(parseResponse)
      .then(function(r){
        if(!r.ok) throw new Error((r.body && (r.body.message || r.body.error)) || ('HTTP ' + r.res.status));
        state.serverHasBackup = !!r.body.hasBackup;
        state.serverUploadedAt = r.body.uploadedAt || null;
        state.statusError = '';
        emit();
        return snapshot();
      })
      .catch(function(e){
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

  function init(){
    /* 游客：不读数、不挂心跳、不监听 online/storage —— 连"待备份"状态都不存在 */
    if(guestBlocked()){ emit(); return; }
    readState();
    refreshStatus();
    if(state.pending) schedule(1500);         /* 启动补传：不因刷新误判已备份 */
    clearInterval(heartbeat);
    heartbeat = setInterval(function(){ if(state.pending && !uploading) run('retry'); }, HEARTBEAT_MS);
    window.addEventListener('online', function(){ if(state.pending) schedule(1000); });
    window.addEventListener('storage', function(e){
      if(!e || e.key === STATE_KEY){ readState(); emit(); }
      if(state.pending && !uploading && !timer) schedule(RETRY_MS);
    });
    emit();
  }

  window.OLCloudBackup = {
    init:init, markDirty:markDirty, backupNow:backupNow, refreshStatus:refreshStatus,
    snapshot:snapshot, subscribe:function(fn){
      if(typeof fn === 'function') listeners.push(fn);
      return function(){ var i = listeners.indexOf(fn); if(i >= 0) listeners.splice(i, 1); };
    }
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
