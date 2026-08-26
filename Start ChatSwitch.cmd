@echo off
setlocal
cd /d "%~dp0"
set "CHATSWITCH_STORE_ROOT=%~dp0chatswitch-data"
set "CHATSWITCH_SKILL_SOURCES=%USERPROFILE%\.agents\skills;%USERPROFILE%\.codex\skills"
set "APP_PROFILE=%~dp0chatswitch-profile"
rem Existing encrypted credentials are bound to the Chromium profile that created them.
if not exist "%CHATSWITCH_STORE_ROOT%\credentials.json" if exist "%~dp0share-master-data\credentials.json" set "CHATSWITCH_STORE_ROOT=%~dp0share-master-data"
if not exist "%APP_PROFILE%\Local State" if exist "%~dp0share-master-profile\Local State" set "APP_PROFILE=%~dp0share-master-profile"
set "PACKAGED_DIR=%~dp0release\chatswitch-current\win-unpacked"
if not exist "%PACKAGED_DIR%\resources\app.asar" set "PACKAGED_DIR=%~dp0release\chatswitch-unpacked"
if not exist "%PACKAGED_DIR%\resources\app.asar" set "PACKAGED_DIR=%~dp0release\chatswitch-unpacked\win-unpacked"
set "PACKAGED_APP=%PACKAGED_DIR%\ChatSwitch.exe"

if exist "%~dp0node_modules\electron\dist\electron.exe" goto source
if not exist "%PACKAGED_APP%" goto unavailable
if not exist "%PACKAGED_DIR%\resources\app.asar" goto unavailable
if not exist "%PACKAGED_DIR%\resources.pak" goto unavailable
start "" "%PACKAGED_APP%" --user-data-dir="%APP_PROFILE%"
goto done

:source
call npm run build:icon >nul
if errorlevel 1 exit /b 1
call npm run build:renderer >nul
if errorlevel 1 exit /b 1
start "" "%~dp0node_modules\electron\dist\electron.exe" --user-data-dir="%APP_PROFILE%" .
goto done

:unavailable
echo ChatSwitch runtime is unavailable. Install dependencies or rebuild the packaged application.
exit /b 1

:done
endlocal
