@echo off
setlocal
cd /d "%~dp0"
python backend\desktop.py
if errorlevel 1 pause
