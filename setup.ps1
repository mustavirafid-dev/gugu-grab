# setup.ps1 - one-time installer for Gugu Grab.
# Finds a Python that has yt-dlp, optionally starts the helper with Windows,
# then launches it so the user can pick their download folder.

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Test-Interpreter([string]$exe) {
    if ([string]::IsNullOrWhiteSpace($exe)) { return $false }
    if ($exe -match 'WindowsApps') { return $false }
    if (-not (Test-Path -LiteralPath $exe)) { return $false }
    & $exe -c "import sys" 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Test-Ytdlp([string]$exe) {
    & $exe -c "import yt_dlp" 2>&1 | Out-Null
    return ($LASTEXITCODE -eq 0)
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   Gugu Grab  -  setup" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ---- 1. find Python -------------------------------------------------------
$candidates = @()

$cached = Join-Path $here 'python-path.txt'
if (Test-Path -LiteralPath $cached) {
    $candidates += (Get-Content -LiteralPath $cached -ErrorAction SilentlyContinue | Select-Object -First 1)
}

foreach ($root in @(
    (Join-Path $env:USERPROFILE '.workbuddy-ai\binaries\python'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python')
)) {
    if (Test-Path -LiteralPath $root) {
        $candidates += Get-ChildItem -LiteralPath $root -Recurse -Filter 'python.exe' `
                        -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName
    }
}

foreach ($name in @('py', 'python', 'python3')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -notmatch 'WindowsApps') { $candidates += $cmd.Source }
}

$py = $null
$needsInstall = $false
foreach ($c in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (-not (Test-Interpreter $c)) { continue }
    if (Test-Ytdlp $c) { $py = $c; $needsInstall = $false; break }
    if (-not $py) { $py = $c; $needsInstall = $true }
}

if (-not $py) {
    Write-Host "  Python is not installed." -ForegroundColor Red
    Write-Host ""
    Write-Host "  Install it once, then run this setup again:"
    Write-Host "    https://www.python.org/downloads/" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  IMPORTANT: tick 'Add python.exe to PATH' on the first screen." -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "  python   $py"

if ($needsInstall) {
    Write-Host "  yt-dlp   installing..." -ForegroundColor Yellow
    & $py -m pip install --quiet --upgrade yt-dlp
    if (-not (Test-Ytdlp $py)) {
        Write-Host "  Could not install yt-dlp. Run manually:" -ForegroundColor Red
        Write-Host "    `"$py`" -m pip install -U yt-dlp"
        Read-Host "Press Enter to close"
        exit 1
    }
}
$ver = (& $py -c "import yt_dlp;print(yt_dlp.version.__version__)" 2>&1) -join ''
Write-Host "  yt-dlp   $ver"
Set-Content -LiteralPath $cached -Value $py -Encoding ASCII

# ---- 2. ffmpeg ------------------------------------------------------------
$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ff) {
    Write-Host ""
    Write-Host "  ffmpeg is missing - MP3 conversion will not work." -ForegroundColor Yellow
    Write-Host "  Install it with:" -ForegroundColor Yellow
    Write-Host "     winget install Gyan.FFmpeg" -ForegroundColor White
    Write-Host "  then run setup again."
    Write-Host ""
} else {
    Write-Host "  ffmpeg   $($ff.Source)"
}

# ---- 3. optional autostart ------------------------------------------------
Write-Host ""
$answer = Read-Host "  Start the helper automatically when Windows starts? (y/n)"
if ($answer -match '^(y|yes)$') {
    $pythonw = Join-Path (Split-Path -Parent $py) 'pythonw.exe'
    if (-not (Test-Path -LiteralPath $pythonw)) { $pythonw = $py }

    $startup = [Environment]::GetFolderPath('Startup')
    $lnk = Join-Path $startup 'Gugu Grab helper.lnk'
    try {
        $ws = New-Object -ComObject WScript.Shell
        $sc = $ws.CreateShortcut($lnk)
        $sc.TargetPath = $pythonw
        $sc.Arguments = '"' + (Join-Path $here 'helper.py') + '"'
        $sc.WorkingDirectory = $here
        $sc.WindowStyle = 7
        $sc.Description = 'Gugu Grab local download helper'
        $sc.Save()
        Write-Host "  autostart  added" -ForegroundColor Green
        Write-Host "             $lnk"
    } catch {
        Write-Host "  could not create the startup shortcut: $($_.Exception.Message)" -ForegroundColor Yellow
        Write-Host "  You can just run start-helper.bat each time instead."
    }
} else {
    Write-Host "  autostart  skipped - use start-helper.bat when you want to download"
}

# ---- 4. install the extension --------------------------------------------
Write-Host ""
Write-Host "------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "  Last step - add the button to your browser" -ForegroundColor Cyan
Write-Host "------------------------------------------------------------" -ForegroundColor Cyan
Write-Host ""
Write-Host "   1. Open   chrome://extensions"
Write-Host "   2. Turn on 'Developer mode' (top right)"
Write-Host "   3. Click 'Load unpacked'"
Write-Host "   4. Choose this folder:"
Write-Host ""
Write-Host "        $(Join-Path $here 'extension')" -ForegroundColor White
Write-Host ""
Write-Host "   5. Open any YouTube video and click MP3"
Write-Host ""

$go = Read-Host "  Open chrome://extensions for you now? (y/n)"
if ($go -match '^(y|yes)$') {
    try { Start-Process "chrome://extensions" } catch { }
}

# ---- 5. start the helper so the folder picker appears ---------------------
Write-Host ""
Write-Host "  Starting the helper..." -ForegroundColor Green
Write-Host "  A browser tab will open where you pick your download folder."
Write-Host ""
& $py (Join-Path $here 'helper.py')

Write-Host ""
Write-Host "  Helper stopped. Run start-helper.bat to start it again."
Read-Host "Press Enter to close"
