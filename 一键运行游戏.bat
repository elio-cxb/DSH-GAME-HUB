@echo off
setlocal
REM When adding games, keep this launcher and the desktop shortcut workflow in sync.
cd /d "%~dp0"
set "GAME_URL=http://127.0.0.1:8787"
set "NODE_EXE="
for /f "delims=" %%N in ('where.exe node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

call :check_game
if errorlevel 1 goto start_game
echo Game server is already running. Restarting it to load the current project files.

:start_game
if not defined NODE_EXE (
  echo Could not find Node.js 24+. Install Node.js or restore the bundled Codex runtime.
  pause
  exit /b 1
)

call :stop_game
if errorlevel 1 goto stop_failed
timeout /t 2 /nobreak >nul

echo Starting DSH Game Hub...
start "DSH Game Hub" /D "%~dp0" "%NODE_EXE%" --env-file-if-exists=.env --experimental-strip-types "%~dp0src\server.ts"

set "WAIT_COUNT=0"
:wait_game
timeout /t 1 /nobreak >nul
call :check_game
if not errorlevel 1 call :open_game
if not errorlevel 1 exit /b 0
set /a WAIT_COUNT+=1
if %WAIT_COUNT% GEQ 30 goto startup_failed
goto wait_game

:startup_failed
echo The game server did not become ready within 30 seconds. Check the DSH Game Hub console.
pause
exit /b 1

:stop_failed
echo Could not safely stop the process on port 8787. No new Game Hub was started.
echo If Windows asked for permission, approve the prompt and run this shortcut again.
pause
exit /b 1

:open_game
echo Game server is ready. Opening the game page.
start "" "%GAME_URL%"
exit /b 0

:check_game
curl.exe -fsS --max-time 2 "%GAME_URL%/healthz" >nul 2>&1
exit /b %errorlevel%

:stop_game
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ids=@(Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); foreach($id in $ids){$p=Get-Process -Id $id -ErrorAction SilentlyContinue; if(-not $p){continue}; if($p.ProcessName -ne 'node'){Write-Error ('Port 8787 is owned by '+$p.ProcessName+'; refusing to stop it.'); exit 3}; try{Stop-Process -Id $id -ErrorAction Stop} catch {$childArgs='-NoProfile -ExecutionPolicy Bypass -Command try { Stop-Process -Id '+$id+' -Force -ErrorAction Stop; exit 0 } catch { exit 1 }'; $e=Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList $childArgs; if($e.ExitCode -ne 0){exit 4}}}; $deadline=(Get-Date).AddSeconds(10); while(Get-NetTCPConnection -State Listen -LocalPort 8787 -ErrorAction SilentlyContinue){if((Get-Date) -gt $deadline){Write-Error 'Port 8787 did not release after stopping GameHub.'; exit 5}; Start-Sleep -Milliseconds 250}; exit 0"
exit /b %errorlevel%
