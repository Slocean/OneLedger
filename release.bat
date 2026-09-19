@echo off
REM 本地触发 GitHub 打包发版（不需要 gh）
REM   release.bat
REM   release.bat 0.2.0
cd /d "%~dp0"
node scripts/trigger-release.mjs %*
if errorlevel 1 pause
