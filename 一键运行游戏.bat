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
call :open_game
exit /b 0

:start_game
if not defined NODE_EXE (
  echo Could not find Node.js 24+. Install Node.js or restore the bundled Codex runtime.
  pause
  exit /b 1
)

echo Starting DSH Game Hub...
start "DSH Game Hub" /D "%~dp0" "%NODE_EXE%" --env-file-if-exists=.env --experimental-strip-types src/server.ts

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

:open_game
echo Game server is ready. Opening the game page.
start "" "%GAME_URL%"
exit /b 0

:check_game
curl.exe -fsS --max-time 2 "%GAME_URL%/healthz" >nul 2>&1
exit /b %errorlevel%
