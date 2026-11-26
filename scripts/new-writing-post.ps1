param(
  # 文章标题。省略时弹出输入框；自动化测试请显式传入。
  [string]$Title,

  # 默认写入 Astro writing 目录；测试时可指向隔离目录。
  [string]$ContentDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'src\content\writing'),

  # 测试时不要拉起 Obsidian。
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'

function Fail([string]$message) { throw $message }

$contentFull = [IO.Path]::GetFullPath($ContentDir).TrimEnd('\')
if (-not (Test-Path -LiteralPath $contentFull -PathType Container)) {
  Fail "Writing content directory not found: $contentFull"
}

if ([string]::IsNullOrWhiteSpace($Title)) {
  try {
    Add-Type -AssemblyName Microsoft.VisualBasic
    $Title = [Microsoft.VisualBasic.Interaction]::InputBox(
      '请输入文章标题（将直接作为 writing 目录下的 Markdown 文件名）：',
      '新建博客文章',
      '')
  } catch {
    Fail 'Title is required, but the input dialog is unavailable. Pass -Title explicitly.'
  }
}
if ([string]::IsNullOrWhiteSpace($Title)) { Fail 'Title must not be empty' }
$Title = $Title.Trim()

$slug = $Title -replace '[\r\n]+', '-'
$slug = $slug -replace '[\\/:*?"<>|%#]+', '-'
$slug = $slug -replace '\s+', '-'
$slug = $slug.Trim([char[]]@('-', '.', ' '))
if ([string]::IsNullOrWhiteSpace($slug)) {
  $slug = 'post-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
}
if ($slug.Length -gt 120) {
  $slug = $slug.Substring(0, 120).Trim([char[]]@('-', '.', ' '))
}

$dateText = Get-Date -Format 'yyyy-MM-dd'
$baseName = $slug
$candidate = Join-Path $contentFull ($baseName + '.md')
$suffix = 2
while (Test-Path -LiteralPath $candidate) {
  $candidate = Join-Path $contentFull ("$baseName-$suffix.md")
  $suffix++
}

$escapedTitle = $Title.Replace('\', '\\').Replace('"', '\"')
$lines = @(
  '---',
  ('title: "{0}"' -f $escapedTitle),
  ('pubDate: "{0}"' -f $dateText),
  'draft: true',
  '---',
  '',
  ''
)
$text = $lines -join "`n"

[IO.File]::WriteAllText($candidate, $text, (New-Object Text.UTF8Encoding($false)))

if (-not $NoOpen) {
  try {
    $uri = 'obsidian://open?path=' + [uri]::EscapeDataString($candidate)
    Start-Process $uri
  } catch {
    Write-Warning "Article created, but Obsidian could not be opened automatically: $_"
  }
}

Write-Output "Created: $candidate"
