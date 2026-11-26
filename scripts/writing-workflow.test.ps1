$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$results = New-Object 'System.Collections.Generic.List[object]'

function Add-Result {
  param([string]$Name, [bool]$Passed, [string]$Detail)
  $results.Add([pscustomobject]@{ Name = $Name; Passed = $Passed; Detail = $Detail }) | Out-Null
  $mark = if ($Passed) { 'PASS' } else { 'FAIL' }
  Write-Host "$mark  $Name :: $Detail"
}

function Get-FreePort {
  $listener = New-Object System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Loopback, 0)
  $listener.Server.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
  $listener.Start()
  $port = [int]$listener.LocalEndpoint.Port
  $listener.Stop()
  return $port
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $tree = New-Object 'System.Collections.Generic.List[int]'
  $tree.Add($ProcessId)
  for ($i = 0; $i -lt $tree.Count; $i++) {
    foreach ($proc in $all) {
      if ($proc.ParentProcessId -eq $tree[$i]) { $tree.Add([int]$proc.ProcessId) }
    }
  }
  foreach ($target in ($tree | Select-Object -Unique)) {
    Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
  }
}

function New-Sandbox {
  $root = Join-Path ([IO.Path]::GetTempPath()) ('ol-writing-flow-' + [guid]::NewGuid().ToString('N'))
  $dirs = @(
    (Join-Path $root 'scripts'),
    (Join-Path $root 'src\content\writing'),
    (Join-Path $root 'bin'),
    (Join-Path $root 'pids'),
    (Join-Path $root 'remote.git')
  )
  foreach ($dir in $dirs) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

  foreach ($name in @('preview-writing-draft.ps1', 'new-writing-post.ps1', 'publish-writing-current.ps1')) {
    Copy-Item -LiteralPath (Join-Path $repoRoot "scripts\$name") -Destination (Join-Path $root "scripts\$name")
  }
  Copy-Item -LiteralPath (Join-Path $repoRoot '.gitignore') -Destination (Join-Path $root '.gitignore')

  $npmStub = @'
@echo off
echo %* >> "%~dp0npm_calls.txt"
echo %* | find /i "run dev" >nul
if not errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0npm-dev-stub.ps1" %*
  exit /b %errorlevel%
)
echo %* | find /i "build" >nul
if not errorlevel 1 (
  echo BUILD_CALLED > "%~dp0build_called.txt"
  if exist "%~dp0fail_build.flag" exit /b 1
)
exit /b 0
'@
  $npmStub | Set-Content -LiteralPath (Join-Path $root 'bin\npm.cmd') -Encoding ASCII

  $devStub = @'
param([string[]]$AstArgs)
$env:OL_PREVIEW_WRITING_ID | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'preview_env.txt') -Encoding UTF8
$port = 4321
$allArgs = (@($AstArgs) + @($args)) -join ' '
if ($allArgs -match '--port\s+(\d+)') { $port = [int]$Matches[1] }
"port=$port" | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'stub_port.txt') -Encoding ASCII
$listener = New-Object System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Loopback, $port)
$listener.Server.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
try {
  $listener.Start()
} catch {
  ($_ | Out-String) | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'stub_error.txt') -Encoding UTF8
  exit 1
}
Start-Sleep -Seconds 8
$listener.Stop()
'@
  $devStub | Set-Content -LiteralPath (Join-Path $root 'bin\npm-dev-stub.ps1') -Encoding ASCII

  Push-Location $root
  try {
    & git init --bare (Join-Path $root 'remote.git') | Out-Null
    & git init -b main | Out-Null
    & git config user.email 'test@example.com'
    & git config user.name 'Test'
    & git add .gitignore | Out-Null
    & git commit -m init | Out-Null
    & git remote add origin (Join-Path $root 'remote.git')
    & git push -u origin HEAD:main | Out-Null
  } finally { Pop-Location }
  return $root
}

function Read-Text {
  param([string]$Path)
  return [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
}

function Get-CommitFiles {
  param([string]$Root)
  Push-Location $Root
  try {
    $raw = (@(& git show --name-only --format= HEAD) -join "`n")
  } finally { Pop-Location }
  return @($raw -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-CommitCount {
  param([string]$Root)
  Push-Location $Root
  try { return (& git rev-list --count HEAD).Trim() }
  finally { Pop-Location }
}

function Invoke-NewPost {
  param([string]$Root, [string]$Title)
  $env:PATH = "$Root\bin;$env:PATH"
  $script = Join-Path $Root 'scripts\new-writing-post.ps1'
  $out = & $script -Title $Title -ContentDir (Join-Path $Root 'src\content\writing') -NoOpen 2>&1 | Out-String
  return $out
}

function Invoke-Publish {
  param([string]$Root, [string]$Article, [string]$Answer)
  $env:PATH = "$Root\bin;$env:PATH"
  $env:SITE_URL = 'https://Hane820.github.io'
  $env:BASE_PATH = '/slices'
  $script = Join-Path $Root 'scripts\publish-writing-current.ps1'
  $err = $null
  $oldPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & $script -MarkdownPath $Article -ConfirmAnswer $Answer 2>&1 | Out-String
  } catch {
    $err = $_.Exception.Message
    $out = ($_ | Out-String)
  } finally {
    $ErrorActionPreference = $oldPref
  }
  return [pscustomobject]@{ Output = $out; Error = $err }
}

function Invoke-Preview {
  param([string]$Root, [string]$Article, [string]$Mode)
  $env:PATH = "$Root\bin;$env:PATH"
  $env:BASE_PATH = '/slices'
  $script = Join-Path $Root 'scripts\preview-writing-draft.ps1'
  $writing = Join-Path $Root 'src\content\writing'
  $prefix = $writing.TrimEnd('\') + '\'
  if ($Article.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    $id = $Article.Substring($prefix.Length)
    $id = ($id -replace '\\', '/') -replace '\.(md|mdx)$', ''
  } else {
    $id = 'outside'
  }
  $port = Get-FreePort
  $pidRoot = Join-Path $Root 'pids'
  $pidFile = Join-Path $pidRoot "ol-writing-preview-$port.pid"
  $envFile = Join-Path $Root 'bin\preview_env.txt'
  if (Test-Path -LiteralPath $envFile) { Remove-Item -LiteralPath $envFile -Force }
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue

  $listener = $null
  if ($Mode -eq 'reuse') {
    @($PID, $id) | Set-Content -LiteralPath $pidFile -Encoding UTF8
    $listener = New-Object System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Loopback, $port)
    $listener.Server.SetSocketOption([System.Net.Sockets.SocketOptionLevel]::Socket, [System.Net.Sockets.SocketOptionName]::ReuseAddress, $true)
    $listener.Start()
  }

  $err = $null
  $oldPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Mode -eq 'reuse') {
      $out = & $script -MarkdownPath $Article -NoBrowser -PidRoot $pidRoot -Port $port 2>&1 | Out-String
    } else {
      $out = & $script -MarkdownPath $Article -NoBrowser -PidRoot $pidRoot 2>&1 | Out-String
    }
  } catch {
    $err = $_.Exception.Message
    $out = ($_ | Out-String)
  } finally {
    $ErrorActionPreference = $oldPref
    if ($listener) { $listener.Stop() }
    if ($Mode -eq 'start') {
      foreach ($pf in @(Get-ChildItem -LiteralPath $pidRoot -Filter '*.pid' -File -ErrorAction SilentlyContinue)) {
        $lines = @(Get-Content -LiteralPath $pf.FullName)
        $oldPid = 0
        if ([int]::TryParse($lines[0], [ref]$oldPid)) { Stop-ProcessTree $oldPid }
        Remove-Item -LiteralPath $pf.FullName -Force -ErrorAction SilentlyContinue
      }
    }
  }
  return [pscustomobject]@{
    Output = $out
    Error  = $err
    Port   = $port
    Id     = $id
    Env    = if (Test-Path -LiteralPath $envFile) { (Get-Content -LiteralPath $envFile -Raw).Trim() } else { '' }
  }
}

$validArticle = @'
---
title: "测试文章"
pubDate: 2026-11-25
draft: true
---

这是正文。
'@

# 1. 新建文章直接落在 Vault/writing 目录，默认 draft:true
$r = New-Sandbox
$null = Invoke-NewPost -Root $r -Title 'README 测试文章'
$created = @(Get-ChildItem -LiteralPath (Join-Path $r 'src\content\writing') -Filter '*.md' -File)
$createdText = if ($created.Count -eq 1) { Read-Text $created[0].FullName } else { '' }
$outsideCopy = @(Get-ChildItem -LiteralPath $r -Recurse -Filter 'README*.md' -File | Where-Object { $_.FullName -notlike (Join-Path $r 'src\content\writing\*') })
Add-Result '新建文章直接写入 writing' (($created.Count -eq 1) -and ($createdText -match 'draft: true') -and ($createdText -match 'title: "README 测试文章"') -and ($outsideCopy.Count -eq 0)) "count=$($created.Count) draftTrue=$($createdText -match 'draft: true') outsideCopies=$($outsideCopy.Count)"

# 2. .obsidian 被 Git 忽略，正常 Markdown 不被忽略
$r = New-Sandbox
$obsDir = Join-Path $r 'src\content\writing\.obsidian'
New-Item -ItemType Directory -Force -Path (Join-Path $obsDir 'templates') | Out-Null
'app.json' | Set-Content -LiteralPath (Join-Path $obsDir 'app.json') -Encoding UTF8
'template' | Set-Content -LiteralPath (Join-Path $obsDir 'templates\new-post.md') -Encoding UTF8
'normal' | Set-Content -LiteralPath (Join-Path $r 'src\content\writing\regular.md') -Encoding UTF8
Push-Location $r
& git check-ignore -q 'src/content/writing/.obsidian/app.json'
$ignoredObs = ($LASTEXITCODE -eq 0)
& git check-ignore -q 'src/content/writing/.obsidian/templates/new-post.md'
$ignoredTpl = ($LASTEXITCODE -eq 0)
& git check-ignore -q 'src/content/writing/regular.md'
$ignoredNormal = ($LASTEXITCODE -eq 0)
Pop-Location
Add-Result '.obsidian 忽略且文章不忽略' ($ignoredObs -and $ignoredTpl -and (-not $ignoredNormal)) "obs=$ignoredObs tpl=$ignoredTpl normalIgnored=$ignoredNormal"

# 3. Astro glob 识别普通/嵌套 Markdown，不识别 .obsidian 模板
$module = 'file:///' + (($repoRoot -replace '\\', '/').TrimEnd('/')) + '/node_modules/tinyglobby/dist/index.mjs'
$nodeCode = "import {glob} from '$module'; const files=await glob('**/*.{md,mdx}',{cwd:process.env.OL_TEST_WRITING,expandDirectories:false}); console.log(JSON.stringify(files.sort()));"
$env:OL_TEST_WRITING = (Join-Path $r 'src\content\writing').Replace('\', '/')
New-Item -ItemType Directory -Force -Path (Join-Path $r 'src\content\writing\nested') | Out-Null
'nested' | Set-Content -LiteralPath (Join-Path $r 'src\content\writing\nested\deep.md') -Encoding UTF8
$globOut = (& node --input-type=module -e $nodeCode 2>&1 | Out-String).Trim()
$globOk = ($globOut -match 'regular\.md') -and ($globOut -match 'nested/deep\.md') -and ($globOut -notmatch '\.obsidian')
Add-Result '模板不进入 Astro 内容集合' $globOk "glob=$globOut"

# 4. 预览复用时直接操作 writing 中草稿，且不修改原文件
$r = New-Sandbox
$article = Join-Path $r 'src\content\writing\draft.md'
$validArticle | Set-Content -LiteralPath $article -Encoding UTF8
$before = (Get-FileHash -LiteralPath $article -Algorithm SHA256).Hash
$p = Invoke-Preview -Root $r -Article $article -Mode 'reuse'
$after = (Get-FileHash -LiteralPath $article -Algorithm SHA256).Hash
$urlOk = $p.Output -match '/slices/writing/2026/11/draft/'
Add-Result '预览 writing 草稿且不改文件' (($urlOk) -and ($before -eq $after) -and (-not $p.Error)) "url=$urlOk unchanged=$($before -eq $after) err=$($p.Error) out=$($p.Output.Trim())"

# 5. 预览启动服务时传入 OL_PREVIEW_WRITING_ID
$r = New-Sandbox
$article = Join-Path $r 'src\content\writing\draft.md'
$validArticle | Set-Content -LiteralPath $article -Encoding UTF8
$p = Invoke-Preview -Root $r -Article $article -Mode 'start'
Add-Result '预览仅放行当前草稿 ID' (($p.Env -eq 'draft') -and ($p.Output -match '/slices/writing/2026/11/draft/')) "env=$($p.Env) out=$($p.Output.Trim())"

# 6. 预览拒绝 writing 目录外文件与隐藏路径
$r = New-Sandbox
$outside = Join-Path $r 'outside.md'
$validArticle | Set-Content -LiteralPath $outside -Encoding UTF8
$p1 = Invoke-Preview -Root $r -Article $outside -Mode 'reuse'
$hidden = Join-Path $r 'src\content\writing\.obsidian\hidden.md'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $hidden) | Out-Null
$validArticle | Set-Content -LiteralPath $hidden -Encoding UTF8
$p2 = Invoke-Preview -Root $r -Article $hidden -Mode 'reuse'
Add-Result '预览拒绝越界与隐藏路径' (($p1.Error -match 'not under writing') -and ($p2.Error -match 'Hidden paths')) "outside=$($p1.Error) hidden=$($p2.Error)"

# 7. 合法文章发布：原地修改、只提交当前文件、推送到隔离 remote
$r = New-Sandbox
$article = Join-Path $r 'src\content\writing\article.md'
$validArticle | Set-Content -LiteralPath $article -Encoding UTF8
$o = Invoke-Publish -Root $r -Article $article -Answer 'Yes'
$text = Read-Text $article
$files = @(Get-CommitFiles $r)
$count = Get-CommitCount $r
Push-Location $r
$remoteHead = (@(& git ls-remote origin refs/heads/main) | Select-Object -First 1)
$localHead = (& git rev-parse HEAD).Trim()
Pop-Location
$calls = if (Test-Path -LiteralPath (Join-Path $r 'bin\npm_calls.txt')) { Read-Text (Join-Path $r 'bin\npm_calls.txt') } else { '' }
$noOtherMd = @(Get-ChildItem -LiteralPath $r -Recurse -Filter '*.md' -File | Where-Object { $_.FullName -ne $article -and $_.FullName -notlike (Join-Path $r 'remote.git\*') }).Count -eq 0
Add-Result '合法文章原地发布' (($count -eq '2') -and ($remoteHead.StartsWith($localHead)) -and ($text -match 'draft: false') -and ($files.Count -eq 1) -and ($files[0] -eq 'src/content/writing/article.md') -and ($calls -match 'validate:content') -and ($calls -match 'run check') -and ($calls -match 'run build') -and $noOtherMd) "commits=$count files=$($files -join ',') pushed=$($remoteHead.StartsWith($localHead)) noCopy=$noOtherMd err=$($o.Error) out=$($o.Output.Trim())"

# 8-11. Frontmatter 失败路径
$cases = @(
  @{ Name = '缺少 title'; Frontmatter = "---`npubDate: 2026-11-25`ndraft: true`n---`n正文"; Pattern = 'title' },
  @{ Name = '缺少 pubDate'; Frontmatter = "---`ntitle: 测试`ndraft: true`n---`n正文"; Pattern = 'pubDate' },
  @{ Name = '非法日期'; Frontmatter = "---`ntitle: 测试`npubDate: 2026-13-40`ndraft: true`n---`n正文"; Pattern = 'real calendar date' },
  @{ Name = '非法 draft 值'; Frontmatter = "---`ntitle: 测试`npubDate: 2026-11-25`ndraft: `"false`"`n---`n正文"; Pattern = 'draft must be' }
)
foreach ($case in $cases) {
  $r = New-Sandbox
  $article = Join-Path $r 'src\content\writing\article.md'
  $case.Frontmatter | Set-Content -LiteralPath $article -Encoding UTF8
  $original = Read-Text $article
  $o = Invoke-Publish -Root $r -Article $article -Answer 'Yes'
  $unchanged = ((Read-Text $article) -eq $original)
  Add-Result $case.Name (($o.Error -match $case.Pattern) -and ((Get-CommitCount $r) -eq '1') -and $unchanged) "commits=$(Get-CommitCount $r) unchanged=$unchanged err=$($o.Error)"
}

# 12. 构建失败恢复原文，不提交不推送
$r = New-Sandbox
$article = Join-Path $r 'src\content\writing\article.md'
$validArticle | Set-Content -LiteralPath $article -Encoding UTF8
$original = Read-Text $article
'fail' | Set-Content -LiteralPath (Join-Path $r 'bin\fail_build.flag') -Encoding ASCII
$o = Invoke-Publish -Root $r -Article $article -Answer 'Yes'
Add-Result '构建失败恢复原文' (((Read-Text $article) -eq $original) -and ((Get-CommitCount $r) -eq '1') -and ($o.Error -match 'Production build failed')) "restored=$((Read-Text $article) -eq $original) commits=$(Get-CommitCount $r) err=$($o.Error)"

# 13. 用户拒绝确认：恢复原文，不提交
$r = New-Sandbox
$article = Join-Path $r 'src\content\writing\article.md'
$validArticle | Set-Content -LiteralPath $article -Encoding UTF8
$original = Read-Text $article
$o = Invoke-Publish -Root $r -Article $article -Answer 'No'
Add-Result '用户拒绝不提交' (((Read-Text $article) -eq $original) -and ((Get-CommitCount $r) -eq '1') -and ($o.Output -match 'cancelled')) "restored=$((Read-Text $article) -eq $original) commits=$(Get-CommitCount $r)"

# 14. 其他未提交文件不进入 commit
$r = New-Sandbox
$article = Join-Path $r 'src\content\writing\article.md'
$validArticle | Set-Content -LiteralPath $article -Encoding UTF8
'other' | Set-Content -LiteralPath (Join-Path $r 'other.txt') -Encoding UTF8
$o = Invoke-Publish -Root $r -Article $article -Answer 'Yes'
$files = @(Get-CommitFiles $r)
$otherStillDirty = $false
Push-Location $r
$status = (& git status --porcelain) -join "`n"
$otherStillDirty = $status -match 'other\.txt'
Pop-Location
Add-Result '其他文件不进入提交' (($files.Count -eq 1) -and ($files[0] -eq 'src/content/writing/article.md') -and $otherStillDirty) "files=$($files -join ',') otherDirty=$otherStillDirty"

# 15. 暂存区已有其他文件：安全退出
$r = New-Sandbox
$article = Join-Path $r 'src\content\writing\article.md'
$validArticle | Set-Content -LiteralPath $article -Encoding UTF8
'staged' | Set-Content -LiteralPath (Join-Path $r 'staged.txt') -Encoding UTF8
Push-Location $r
& git add staged.txt
Pop-Location
$original = Read-Text $article
$o = Invoke-Publish -Root $r -Article $article -Answer 'Yes'
Add-Result '暂存区不干净时安全退出' (($o.Error -match 'Git index already has staged changes') -and ((Read-Text $article) -eq $original) -and ((Get-CommitCount $r) -eq '1')) "commits=$(Get-CommitCount $r) unchanged=$((Read-Text $article) -eq $original)"

# 16. Push 失败保留 commit 与文章状态
$r = New-Sandbox
$article = Join-Path $r 'src\content\writing\article.md'
$validArticle | Set-Content -LiteralPath $article -Encoding UTF8
Push-Location $r
& git remote set-url origin (Join-Path $r 'missing.git')
Pop-Location
$o = Invoke-Publish -Root $r -Article $article -Answer 'Yes'
Add-Result 'Push 失败保留 commit' (((Get-CommitCount $r) -eq '2') -and ($o.Error -match 'git push failed') -and ((Read-Text $article) -match 'draft: false')) "commits=$(Get-CommitCount $r) err=$($o.Error)"

# 17. 重复发布不产生无意义 commit
$r = New-Sandbox
$article = Join-Path $r 'src\content\writing\article.md'
$validArticle | Set-Content -LiteralPath $article -Encoding UTF8
$null = Invoke-Publish -Root $r -Article $article -Answer 'Yes'
$o = Invoke-Publish -Root $r -Article $article -Answer 'Yes'
Add-Result '重复发布不新增 commit' (((Get-CommitCount $r) -eq '2') -and ($o.Output -match 'already published')) "commits=$(Get-CommitCount $r)"

# 18. 发布拒绝 writing 目录外文件
$r = New-Sandbox
$outside = Join-Path $r 'outside.md'
$validArticle | Set-Content -LiteralPath $outside -Encoding UTF8
$o = Invoke-Publish -Root $r -Article $outside -Answer 'Yes'
Add-Result '发布拒绝越界路径' ($o.Error -match 'not under writing content directory') "err=$($o.Error)"

Write-Host ""
$failed = @($results | Where-Object { -not $_.Passed })
Write-Host "TOTAL=$($results.Count) PASS=$($results.Count - $failed.Count) FAIL=$($failed.Count)"
if ($failed.Count -gt 0) { exit 1 }
