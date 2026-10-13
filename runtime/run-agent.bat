@echo off
rem Double-click to run the Dragonfly agent (tournament + Testing games) with automatic restarts.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-agent.ps1" %*
pause
