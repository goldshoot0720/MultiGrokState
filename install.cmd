@echo off
setlocal enabledelayedexpansion

REM ===================================================================
REM  MultiGrokState installer for Windows CMD
REM  Use this when PowerShell is unavailable.
REM
REM  Usage:
REM    curl -fsSL https://raw.githubusercontent.com/goldshoot0720/MultiGrokState/main/install.cmd -o install.cmd && install.cmd && del install.cmd
REM ===================================================================

set "REPO=goldshoot0720/MultiGrokState"
set "BRANCH=main"
set "INSTALL_DIR=%USERPROFILE%\.multigrokstate"
set "GROK_HOME_DIR=%USERPROFILE%\.grok"

REM Allow overrides via arguments: install.cmd [installDir]
if not "%~1"=="" set "INSTALL_DIR=%~1"

echo.
echo   MultiGrokState installer
echo   ------------------------
echo.

REM --- Prerequisites ---------------------------------------------------

where node >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo   Node.js 18+ is required but 'node' was not found on PATH. >&2
    echo   Install it from https://nodejs.org and re-run this script. >&2
    exit /b 1
)

for /f "tokens=*" %%v in ('node --version') do set "NODE_VER=%%v"
set "NODE_VER=!NODE_VER:v=!"
for /f "tokens=1 delims=." %%m in ("!NODE_VER!") do set "NODE_MAJOR=%%m"
if !NODE_MAJOR! LSS 18 (
    echo   Node.js 18+ is required ^(found v!NODE_VER!^). >&2
    exit /b 1
)
echo   [ok] node v!NODE_VER!

where npm >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo   npm was not found on PATH ^(it ships with Node.js^). >&2
    exit /b 1
)
echo   [ok] npm available

where git >nul 2>&1
if !ERRORLEVEL! neq 0 (
    echo   git is required but was not found on PATH. >&2
    echo   Install it from https://git-scm.com and re-run this script. >&2
    exit /b 1
)
echo   [ok] git available

REM --- Fetch source ----------------------------------------------------

if exist "!INSTALL_DIR!\package.json" (
    echo.
    echo   Already installed at !INSTALL_DIR! — updating...
    if exist "!INSTALL_DIR!\.git" (
        git -C "!INSTALL_DIR!" fetch --depth 1 origin !BRANCH! >nul 2>&1
        if !ERRORLEVEL! equ 0 (
            git -C "!INSTALL_DIR!" checkout -q FETCH_HEAD >nul 2>&1
            echo   [ok] source updated
        ) else (
            echo   [!!] update failed, reinstalling from scratch
            rmdir /s /q "!INSTALL_DIR!"
        )
    ) else (
        rmdir /s /q "!INSTALL_DIR!"
    )
)

if not exist "!INSTALL_DIR!\package.json" (
    echo   Downloading source to !INSTALL_DIR!...
    if exist "!INSTALL_DIR!" rmdir /s /q "!INSTALL_DIR!"
    git clone --depth 1 --branch !BRANCH! "https://github.com/!REPO!.git" "!INSTALL_DIR!" >nul 2>&1
    if !ERRORLEVEL! neq 0 (
        echo   Failed to clone https://github.com/!REPO!.git >&2
        echo   Check the repository name and your network connection. >&2
        exit /b 1
    )
    echo   [ok] source downloaded
)

REM --- Dependencies ----------------------------------------------------

echo   Installing dependencies ^(chalk^)...
pushd "!INSTALL_DIR!"
call npm install --no-audit --no-fund --loglevel=error >nul 2>&1
set "NPM_EXIT=!ERRORLEVEL!"
popd

if !NPM_EXIT! neq 0 (
    echo   npm install failed ^(exit code !NPM_EXIT!^) >&2
    exit /b 1
)
echo   [ok] dependencies installed

REM --- Register command ------------------------------------------------

echo   Registering the 'MultiGrokState' command...
pushd "!INSTALL_DIR!"
call npm link --no-audit --no-fund --loglevel=error >nul 2>&1
set "LINK_EXIT=!ERRORLEVEL!"
popd

if !LINK_EXIT! neq 0 (
    echo   [!!] npm link failed — you can still run: node "!INSTALL_DIR!\bin\gs.js"
) else (
    echo   [ok] command registered
)

REM --- Verify ----------------------------------------------------------

echo   Verifying installation...
node "!INSTALL_DIR!\bin\gs.js" where >nul 2>&1
if !ERRORLEVEL! equ 0 (
    echo   [ok] smoke test passed
) else (
    echo   [!!] smoke test returned a non-zero exit code
)

REM --- Done ------------------------------------------------------------

echo.
echo   Installation complete!
echo.
echo   Next steps
echo     MultiGrokState              # show help
echo     MultiGrokState login work   # sign in and archive the account
echo     MultiGrokState list --usage # accounts + live quota
echo.
echo   Install dir : !INSTALL_DIR!
echo   Account dir : !GROK_HOME_DIR!\accounts

if not exist "!GROK_HOME_DIR!\bin\grok.exe" (
    echo.
    echo   [!!] Grok CLI not found at !GROK_HOME_DIR!\bin\grok.exe
    echo        Install it first: https://x.ai/cli
)

echo.
endlocal
exit /b 0
