# Builds dist/latency-catch-up-v<version>.zip for upload to the Chrome Web Store.
# Usage: powershell -ExecutionPolicy Bypass -File package.ps1
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$ext = Join-Path $root 'extension'
$version = (Get-Content (Join-Path $ext 'manifest.json') -Raw | ConvertFrom-Json).version
$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist "latency-catch-up-v$version.zip"
if (Test-Path $out) { Remove-Item $out }

# Windows' bundled tar writes forward-slash paths; Compress-Archive on PowerShell 5.1 can write
# backslashes, which the Web Store rejects. manifest.json must sit at the zip root.
& tar.exe -a -c -f $out -C $ext manifest.json content icons popup shared
if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }

Write-Host "Packaged $out ($([math]::Round((Get-Item $out).Length / 1KB, 1)) KB)"
