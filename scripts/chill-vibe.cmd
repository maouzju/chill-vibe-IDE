@echo off
setlocal
:: Chill Vibe IDE - kill existing instances and launch dev mode
:: Place this in the Start Menu for quick access.

cd /d "%~dp0.."
powershell -ExecutionPolicy Bypass -File "scripts\restart-runtime.ps1"
