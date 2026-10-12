param([switch]$PackOnly, [string]$DshCli)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
Push-Location $root
try {
  & npm.cmd ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
  & npm.cmd test
  if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
  & npm.cmd pack --pack-destination $dist
  if ($LASTEXITCODE -ne 0) { throw 'Packaging failed.' }
} finally { Pop-Location }
$version = (Get-Content -Raw -LiteralPath (Join-Path $root 'package.json') | ConvertFrom-Json).version
$package = Join-Path $dist "dsh-ntr-zcode-$version.tgz"
if ($PackOnly) { Write-Host "Package: $package"; return }
if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
  throw "Close DeepSeek Harness before installing. Package: $package"
}
if (-not $DshCli) {
  $DshCli = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
}
if (-not (Test-Path -LiteralPath $DshCli)) { throw 'DSH CLI not found. Supply -DshCli with its path.' }
& $DshCli plugin --profile desktop add $package
if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed.' }
Write-Host 'Installed. Reopen DSH; remote access remains off by default.'
