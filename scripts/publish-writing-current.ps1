param(
  [Parameter(Mandatory = $true)]
  [string]$MarkdownPath,

  # 显式确认参数：仅用于自动化测试。生产配置不要传。
  [ValidateSet('Yes', 'No')]
  [string]$ConfirmAnswer,

  [string]$PublishBranch = 'main'
)

$ErrorActionPreference = 'Stop'

function Fail([string]$message) { throw $message }

function Run-NpmStep {
  param([string]$Name, [string]$Arguments)
  Write-Output ""
  Write-Output "==> $Name : npm $Arguments"
  $oldPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & cmd.exe /c "npm $Arguments"
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPref
  }
  if ($exitCode -ne 0) { Fail "$Name failed with exit code $exitCode" }
}

# Native git commands may write warnings to stderr. Keep ErrorActionPreference
# from turning those warnings into terminating errors inside this script.
function Invoke-Git {
  param([string[]]$GitArgs, [switch]$Capture)
  $oldPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Capture) { $output = @(& git @GitArgs) }
    else { & git @GitArgs; $output = @() }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPref
  }
  return [pscustomobject]@{ Output = $output; ExitCode = $exitCode }
}

function Get-ChangeDiff {
  param([string]$OldText, [string]$NewText)
  $oldTemp = Join-Path ([IO.Path]::GetTempPath()) ("ol-publish-old-" + [guid]::NewGuid().ToString('N') + ".txt")
  $newTemp = Join-Path ([IO.Path]::GetTempPath()) ("ol-publish-new-" + [guid]::NewGuid().ToString('N') + ".txt")
  $utf8NoBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($oldTemp, $OldText, $utf8NoBom)
  [IO.File]::WriteAllText($newTemp, $NewText, $utf8NoBom)
  $lines = @()
  $oldPref = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $lines = @(& git diff --no-index --no-color -- $oldTemp $newTemp)
  } finally {
    $ErrorActionPreference = $oldPref
    Remove-Item -LiteralPath $oldTemp -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $newTemp -Force -ErrorAction SilentlyContinue
  }
  if ($lines.Count -eq 0) { return '(no textual difference)' }
  $joined = $lines -join "`n"
  $joined = $joined -replace [regex]::Escape($oldTemp), 'before'
  $joined = $joined -replace [regex]::Escape($newTemp), 'after'
  return $joined
}

# ---------- 1. 输入与路径检查 ----------
if (-not (Test-Path -LiteralPath $MarkdownPath -PathType Leaf)) { Fail "File not found: $MarkdownPath" }
if ($MarkdownPath -notmatch '\.(md|mdx)$') { Fail "Not a Markdown file: $MarkdownPath" }

$root = Split-Path -Parent $PSScriptRoot
$contentFull = [IO.Path]::GetFullPath((Join-Path $root 'src\content\writing')).TrimEnd('\')
$resolved = Resolve-Path -LiteralPath $MarkdownPath -ErrorAction Stop
$full = [IO.Path]::GetFullPath($resolved.ProviderPath)
$prefix = $contentFull + '\'
if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
  Fail "File is not under writing content directory: $contentFull"
}
$relative = $full.Substring($prefix.Length)
if ($relative -match '(^|[\\/])\.[^\\/]+([\\/]|$)') {
  Fail "Hidden paths cannot be published as articles: $relative"
}
if ($relative -notmatch '\.(md|mdx)$') { Fail "Not a Markdown file: $full" }

$relativeTarget = 'src/content/writing/' + ($relative -replace '\\', '/')

# ---------- 2. 读取原文与 Frontmatter 检查 ----------
$originalBytes = [IO.File]::ReadAllBytes($full)
$originalText = [Text.Encoding]::UTF8.GetString($originalBytes)
$hadBom = $originalText.StartsWith([char]0xFEFF)
if ($hadBom) { $originalText = $originalText.Substring(1) }
if ([string]::IsNullOrWhiteSpace($originalText)) { Fail "File is empty: $full" }

$match = [regex]::Match($originalText, '(?s)^---[ \t]*\r?\n(?<fm>.*?)\r?\n---[ \t]*(?:\r?\n)?(?<body>.*)$')
if (-not $match.Success) { Fail "Missing or malformed YAML frontmatter: $full" }
$frontmatter = $match.Groups['fm'].Value
$body = $match.Groups['body'].Value

$titleMatches = @([regex]::Matches($frontmatter, '(?m)^title:[ \t]*(?<v>.+?)[ \t]*$'))
if ($titleMatches.Count -ne 1) { Fail "Frontmatter must contain exactly one title: $full" }
$title = $titleMatches[0].Groups['v'].Value.Trim().Trim('"', "'")
if ([string]::IsNullOrWhiteSpace($title)) { Fail 'title must not be empty' }

$datePattern = '(?m)^pubDate:[ \t]*(?:"(?<dq>\d{4}-\d{2}-\d{2})"|''(?<sq>\d{4}-\d{2}-\d{2})''|(?<bare>\d{4}-\d{2}-\d{2}))[ \t]*$'
$dateMatches = @([regex]::Matches($frontmatter, $datePattern))
if ($dateMatches.Count -ne 1) { Fail "Frontmatter must contain exactly one pubDate in YYYY-MM-DD: $full" }
$dateGroup = $dateMatches[0].Groups['dq']
if (-not $dateGroup.Success) { $dateGroup = $dateMatches[0].Groups['sq'] }
if (-not $dateGroup.Success) { $dateGroup = $dateMatches[0].Groups['bare'] }
$dateText = $dateGroup.Value
try {
  $pubDate = [datetime]::ParseExact($dateText, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
} catch {
  Fail "pubDate must be a real calendar date: $dateText"
}

$draftMatches = @([regex]::Matches($frontmatter, '(?m)^draft:[ \t]*(?<v>.+?)[ \t]*$'))
if ($draftMatches.Count -gt 1) { Fail "Frontmatter must not contain multiple draft fields: $full" }
$currentDraft = $true
if ($draftMatches.Count -eq 1) {
  $draftValue = $draftMatches[0].Groups['v'].Value.Trim()
  if ($draftValue -eq 'false') { $currentDraft = $false }
  elseif ($draftValue -eq 'true') { $currentDraft = $true }
  else { Fail 'draft must be exactly true or false (unquoted, lowercase)' }
}

if (-not $currentDraft) {
  Write-Output "Article is already published (draft: false): $relativeTarget"
  Write-Output 'No file change, commit, or push was performed.'
  return
}

# ---------- 3. 生成 draft:false 的新内容（仍在内存中） ----------
$newline = if ($originalText.Contains("`r`n")) { "`r`n" } else { "`n" }
if ($draftMatches.Count -eq 1) {
  $newFrontmatter = [regex]::Replace($frontmatter, '(?m)^draft:[ \t]*.+?[ \t]*$', 'draft: false')
} else {
  $frontmatterLines = @($frontmatter -split '\r?\n')
  $newFrontmatter = ($frontmatterLines + 'draft: false') -join $newline
}
$newText = '---' + $newline + $newFrontmatter + $newline + '---' + $newline + $body
$changeDiff = Get-ChangeDiff -OldText $originalText -NewText $newText

$slug = [IO.Path]::GetFileNameWithoutExtension($full)
$articlePath = '/writing/{0}/{1:00}/{2}/' -f $pubDate.Year, $pubDate.Month, $slug
$base = $env:BASE_PATH
if ([string]::IsNullOrWhiteSpace($base)) { $base = '/' }
$base = '/' + $base.Trim('/')
if ($base -eq '/') { $base = '' }
$siteOrigin = $env:SITE_URL
if ([string]::IsNullOrWhiteSpace($siteOrigin)) { $siteOrigin = 'https://Hane820.github.io' }
$siteOrigin = $siteOrigin.TrimEnd('/')
$articleUrl = "$siteOrigin$base$articlePath"

$commitSubject = 'post: ' + (($title -replace '[\r\n]+', ' ').Trim())

# ---------- 4. Git 预检：索引必须干净，分支/remote 必须正确 ----------
Push-Location $root
try {
  $branchResult = Invoke-Git -Capture -GitArgs @('rev-parse', '--abbrev-ref', 'HEAD')
  $branch = $branchResult.Output[0].Trim()
  if ($branch -ne $PublishBranch) { Fail "Current branch '$branch' is not the publish branch '$PublishBranch'" }
  $remotesResult = Invoke-Git -Capture -GitArgs @('remote')
  $remotes = @($remotesResult.Output)
  if ($remotes -notcontains 'origin') { Fail "Git remote 'origin' is not configured" }
  $indexResult = Invoke-Git -GitArgs @('diff', '--cached', '--quiet')
  if ($indexResult.ExitCode -ne 0) {
    Fail 'Git index already has staged changes from another task; refusing to publish.'
  }

  $restoreNeeded = $false
  $leaveState = $false
  try {
    # ---------- 5. 写入目标并运行全部检查 ----------
    if ($hadBom) { $outputEncoding = New-Object Text.UTF8Encoding($true) }
    else { $outputEncoding = New-Object Text.UTF8Encoding($false) }
    [IO.File]::WriteAllText($full, $newText, $outputEncoding)
    $restoreNeeded = $true

    Run-NpmStep 'Content validation' 'run validate:content'
    Run-NpmStep 'Type check' 'run check'
    Run-NpmStep 'Production build' 'run build'

    # ---------- 6. 明确人工确认，默认 No ----------
    $message = @(
      '博客发布确认',
      '',
      "文件       : $relativeTarget",
      "标题       : $title",
      "pubDate    : $dateText",
      'draft      : true -> false',
      "URL        : $articleUrl",
      '',
      '变更差异：',
      $changeDiff,
      '',
      '将只执行：',
      "  git add -- $relativeTarget",
      "  git commit -m `"$commitSubject`"",
      "  git push origin $PublishBranch",
      '',
      '其他未提交文件不会被纳入本次提交。默认选择为“否”。'
    ) -join "`n"

    if ($PSBoundParameters.ContainsKey('ConfirmAnswer')) {
      $confirmed = ($ConfirmAnswer -eq 'Yes')
    } else {
      $confirmed = $false
      try {
        Add-Type -AssemblyName System.Windows.Forms
        $answer = [System.Windows.Forms.MessageBox]::Show(
          $message, '确认发布当前文章', [System.Windows.Forms.MessageBoxButtons]::YesNo,
          [System.Windows.Forms.MessageBoxIcon]::Question,
          [System.Windows.Forms.MessageBoxDefaultButton]::Button2)
        $confirmed = ($answer -eq [System.Windows.Forms.DialogResult]::Yes)
      } catch {
        Write-Warning "Confirmation dialog unavailable; failing closed. $_"
        $confirmed = $false
      }
    }

    if (-not $confirmed) {
      Write-Output 'Publish cancelled by user. No commit or push was performed. Original article content will be restored.'
      return
    }

    # ---------- 7. 精确暂存、校验暂存区、提交、推送 ----------
    $addResult = Invoke-Git -GitArgs @('add', '--', $relativeTarget)
    if ($addResult.ExitCode -ne 0) { Fail 'git add failed' }

    $stagedResult = Invoke-Git -Capture -GitArgs @('diff', '--cached', '--name-only')
    $staged = @($stagedResult.Output)
    if ($staged.Count -ne 1 -or $staged[0] -ne $relativeTarget) {
      $leaveState = $true
      Fail "Unexpected staged files: $($staged -join ', '). No reset was performed; inspect the index manually."
    }

    $commitResult = Invoke-Git -GitArgs @('commit', '-m', $commitSubject)
    if ($commitResult.ExitCode -ne 0) {
      $leaveState = $true
      Fail 'git commit failed; no reset was performed. Inspect the staged article manually.'
    }
    $hashResult = Invoke-Git -Capture -GitArgs @('rev-parse', 'HEAD')
    $commitHash = $hashResult.Output[0].Trim()
    # 从此处起提交已存在：即使 push 失败，也必须保留文章新内容和 commit。
    $restoreNeeded = $false

    $pushResult = Invoke-Git -GitArgs @('push', 'origin', $PublishBranch)
    $pushExit = $pushResult.ExitCode

    if ($pushExit -eq 0) {
      Write-Output ""
      Write-Output "Published: $title"
      Write-Output "Commit   : $commitHash"
      Write-Output "Branch   : $PublishBranch"
      Write-Output "URL      : $articleUrl"
      Write-Output 'Note     : GitHub Actions deployment status must be checked separately.'
    } else {
      $remoteHead = ''
      try {
        $remoteResult = Invoke-Git -Capture -GitArgs @('ls-remote', 'origin', "refs/heads/$PublishBranch")
        $remoteHead = @($remoteResult.Output) | Select-Object -First 1
      } catch {}
      if ($remoteHead -and $remoteHead.StartsWith($commitHash)) {
        Write-Output "Push command failed, but remote already contains commit $commitHash. Treat as published."
      } else {
        Write-Warning "git push failed with exit code $pushExit. Commit $commitHash is kept locally."
        Write-Warning "Safe retry: cd `"$root`"; git push origin $PublishBranch"
        Fail 'git push failed; commit kept locally. No reset or force push was performed.'
      }
    }
  } finally {
    if ($restoreNeeded -and -not $leaveState) {
      [IO.File]::WriteAllBytes($full, $originalBytes)
      Write-Output 'Original article content restored.'
    }
  }
} finally {
  Pop-Location
}
