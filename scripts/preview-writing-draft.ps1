param(
  [Parameter(Mandatory = $true)]
  [string]$MarkdownPath,
  [switch]$NoBrowser,
  # 仅用于隔离测试；生产调用不要传。
  [string]$PidRoot = [IO.Path]::GetTempPath(),
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$contentDir = [IO.Path]::GetFullPath((Join-Path $root 'src\content\writing')).TrimEnd('\')
$tempRoot = [IO.Path]::GetFullPath($PidRoot)
if (-not (Test-Path -LiteralPath $tempRoot -PathType Container)) {
  throw "Pid root not found: $tempRoot"
}

function Fail([string]$message) { throw $message }

# Resolve and validate the file location.
if (-not (Test-Path -LiteralPath $MarkdownPath -PathType Leaf)) { Fail "File not found: $MarkdownPath" }
$resolved = Resolve-Path -LiteralPath $MarkdownPath -ErrorAction Stop
$full = [IO.Path]::GetFullPath($resolved.ProviderPath)
$prefix = $contentDir + '\'
if (-not $full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
  Fail "File is not under writing content directory: $contentDir"
}
$relative = $full.Substring($prefix.Length)
if ($relative -match '(^|[\\/])\.[^\\/]+([\\/]|$)') {
  Fail "Hidden paths cannot be previewed as articles: $relative"
}
if ($relative -notmatch '\.(md|mdx)$') { Fail "Not a Markdown file: $full" }
$id = ($relative -replace '\\','/') -replace '\.(md|mdx)$',''
if ($id -match '[\\/]\.\.') { Fail "Invalid content id: $id" }

# Validate frontmatter without touching the file.
$text = Get-Content -LiteralPath $full -Raw -Encoding UTF8
if ($text -notmatch '(?s)^---\s*\r?\n(.*?)\r?\n---') { Fail "Missing YAML frontmatter: $full" }
$frontmatter = $matches[1]
if ($frontmatter -notmatch '(?m)^title:\s*\S') { Fail "Missing title in frontmatter: $full" }
if ($frontmatter -notmatch '(?m)^pubDate:\s*"?(?<date>\d{4}-\d{2}-\d{2})"?(?:\s|$)') { Fail "Missing or invalid pubDate in frontmatter: $full" }
$dateText = $matches['date']
$date = [datetime]::ParseExact($dateText, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$slug = [IO.Path]::GetFileNameWithoutExtension($full)

# Build the public URL. BASE_PATH matches astro.config.mjs.
$base = $env:BASE_PATH
if ([string]::IsNullOrWhiteSpace($base)) { $base = '/' }
$base = '/' + $base.Trim('/')
if ($base -eq '/') { $base = '' }
$articlePath = '/writing/{0}/{1:00}/{2}/' -f $date.Year, $date.Month, $slug

function Test-LocalPort([int]$p) {
  $client = New-Object Net.Sockets.TcpClient
  try { $client.Connect('127.0.0.1', $p); return $true }
  catch { return $false }
  finally { $client.Close() }
}

function Stop-PreviewProcess([int]$processId, [string]$pidFile, [int]$port) {
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $tree = New-Object 'System.Collections.Generic.List[int]'
  $tree.Add($processId)
  for ($i = 0; $i -lt $tree.Count; $i++) {
    foreach ($proc in $all) {
      if ($proc.ParentProcessId -eq $tree[$i]) { $tree.Add([int]$proc.ProcessId) }
    }
  }
  # Astro dev may detach its server process from the npm/cmd tree; also kill by port.
  foreach ($connection in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
    $tree.Add([int]$connection.OwningProcess)
  }
  foreach ($target in ($tree | Select-Object -Unique)) {
    Stop-Process -Id $target -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path -LiteralPath $pidFile) {
    [IO.File]::Delete($pidFile)
  }
}

# Reuse an existing service only when it was started by this script for the same article.
$port = 0
$candidates = if ($Port -gt 0) { @($Port) } else { 4321..4330 }
foreach ($candidate in $candidates) {
  $pidFile = Join-Path $tempRoot "ol-writing-preview-$candidate.pid"
  $listening = Test-LocalPort $candidate
  $owned = $false
  if (Test-Path -LiteralPath $pidFile) {
    $lines = @(Get-Content -LiteralPath $pidFile)
    if ($lines.Count -ge 2) {
      $oldPid = 0
      if ([int]::TryParse($lines[0], [ref]$oldPid) -and (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) {
        if ($lines[1] -eq $id) {
          if ($listening) { $port = $candidate; $reused = $true; break }
          Stop-PreviewProcess $oldPid $pidFile $candidate
          $listening = $false
        } else {
          Stop-PreviewProcess $oldPid $pidFile $candidate
          $listening = $false
        }
      } else {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
      }
    }
  }
  if (-not $listening) { $port = $candidate; $reused = $false; break }
}
if ($port -eq 0) {
  if ($Port -gt 0) { Fail "Preview port $Port is occupied by another service." }
  Fail 'All preview ports 4321-4330 are occupied. Please stop the conflicting service.'
}

if (-not $reused) {
  $env:OL_PREVIEW_WRITING_ID = $id
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = 'cmd.exe'
  $psi.Arguments = '/c "npm run dev -- --host 127.0.0.1 --port ' + $port + '"'
  $psi.WorkingDirectory = $root
  $psi.UseShellExecute = $false
  $psi.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $proc = [Diagnostics.Process]::Start($psi)
  @($proc.Id, $id) | Set-Content -LiteralPath $pidFile -Encoding UTF8

  $ready = $false
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-LocalPort $port) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { Fail "Preview server did not start on port $port" }
}

$url = "http://127.0.0.1:$port$base$articlePath"
Write-Output "Preview: $url"
if (-not $NoBrowser) { Start-Process $url }
