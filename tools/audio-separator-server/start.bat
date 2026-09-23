@echo off
REM One-command launcher for the audio-separator stem service on Windows.
REM
REM   tools\audio-separator-server\start.bat
REM
REM Creates the venv on first run, installs requirements, starts the API on
REM port 8920, and prints the env vars to paste into Render. For a public URL
REM install cloudflared and run:  cloudflared tunnel --url http://127.0.0.1:8920

setlocal enabledelayedexpansion
cd /d "%~dp0"

set PORT=8920
if not "%SEPARATOR_PORT%"=="" set PORT=%SEPARATOR_PORT%

where python >nul 2>nul
if errorlevel 1 (
  echo ✗ Python 3.10+ is required. Install from https://www.python.org/downloads/
  echo   and tick "Add python.exe to PATH" during setup.
  pause
  exit /b 1
)

if not exist venv (
  echo → creating virtualenv ^(first run^)
  python -m venv venv
)
call venv\Scripts\activate.bat

python -c "import fastapi" >nul 2>nul
if errorlevel 1 (
  echo → installing dependencies ^(first run downloads the CPU torch build, several GB^)
  pip install --disable-pip-version-check -r requirements.txt
)

if "%SEPARATOR_API_KEY%"=="" (
  for /f %%K in ('python -c "import secrets; print(secrets.token_urlsafe(24))"') do set SEPARATOR_API_KEY=%%K
  echo → generated an API key for this session: !SEPARATOR_API_KEY!
  echo   ^(set SEPARATOR_API_KEY yourself to keep it stable across restarts^)
)

echo → starting the stem service on port %PORT%
start "stems-api" /b python -m uvicorn app:app --host 0.0.0.0 --port %PORT%

timeout /t 3 /nobreak >nul
curl -fsS -m 5 -H "Authorization: Bearer %SEPARATOR_API_KEY%" http://127.0.0.1:%PORT%/health >nul 2>nul
if errorlevel 1 (
  echo ! the API did not answer yet — check the python window for errors
) else (
  echo ✓ local API ready: http://127.0.0.1:%PORT%/health
)

echo.
echo ════════════════════════════════════════════════════════════
echo   Paste these into Render → Environment:
echo
echo   AUDIO_SEPARATION_PROVIDER = audio_separator
echo   AUDIO_SEPARATOR_URL       = YOUR-PUBLIC-URL
echo   AUDIO_SEPARATOR_API_KEY   = %SEPARATOR_API_KEY%
echo
echo   For YOUR-PUBLIC-URL, install cloudflared then run:
echo     cloudflared tunnel --url http://127.0.0.1:%PORT%
echo   and copy the https://xxxx.trycloudflare.com it prints.
echo ════════════════════════════════════════════════════════════
echo.
echo Keep this window open. Close it to stop the service.
pause
