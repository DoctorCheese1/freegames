@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto missing
if exist node_modules\discord.js\package.json goto run
call npm install
if errorlevel 1 goto failed
:run
if not exist .env copy .env.example .env >nul
node run.mjs
pause
exit /b
:missing
echo Install Node.js 24.17 or newer from https://nodejs.org then retry.
pause
exit /b 1
:failed
echo Dependency installation failed. Check the messages above.
pause
exit /b 1
