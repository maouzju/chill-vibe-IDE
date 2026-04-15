@echo off
setlocal

cd /d "%~dp0.."
node "scripts\build-timestamped-release.mjs" %*

