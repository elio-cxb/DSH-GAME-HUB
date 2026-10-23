@echo off
setlocal

rem Relaunch in a persistent CMD window so errors remain visible after double-click.
if /i not "%~1"=="__keep_open" (
  start "Game invite test" cmd.exe /k ""%~f0" __keep_open"
  exit /b
)
shift
title Game invite test
cd /d "%~dp0"
if errorlevel 1 goto bad_directory

set "NODE_EXE="
for /f "delims=" %%N in ('where.exe node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE_EXE goto no_node

echo Using Node.js: "%NODE_EXE%"
echo Submitting one test invitation to the DSH bridge...
"%NODE_EXE%" scripts\invite-test.mjs
if errorlevel 1 goto invite_failed

echo.
echo Test invitation submitted. This window will stay open until you press a key.
pause
exit

:bad_directory
echo Could not switch to the Game Hub folder: "%~dp0"
goto stop_with_error

:no_node
echo Could not find Node.js. Install Node.js or restore the bundled Codex runtime.
goto stop_with_error

:invite_failed
echo.
echo The invite script returned an error. Check the message above.
echo Confirm that DSH and the bridge are running and the local .env is configured.

:stop_with_error
echo.
pause
exit
