@echo off
title Inventory App Launcher
echo Starting Inventory App...
cd /d "c:\Coding\inventory-app"

:: Check if node_modules exists, if not run install
if not exist "node_modules" (
    echo First time run? Installing dependencies...
    call npm install
)

:: Build the app to ensure it's fresh (optional, can be removed for speed)
if not exist "dist" (
    echo Building app...
    call npm run build
)

:: Show the Local IP address so user knows what to type on iPad
echo.
echo --- NETWORK ACCESS ---
echo To access from an iPad on the same Wi-Fi, find your computer's IP address.
echo Usually it looks like: http://192.168.1.XXX:4173
echo.

:: Start the browser
start "" "http://localhost:4173"

:: Start the server
echo Serving app at http://localhost:4173...
echo Close this window to stop the server.
call npm run preview
pause
