@echo off
setlocal

set "ECOMET_MCP_BINARY=%~dp0bin\win32-x64\ecomet-mcp.exe"

if not exist "%ECOMET_MCP_BINARY%" (
    1>&2 echo [e-comet-local-bridge] ECOMET_MCP_BINARY_MISSING: reinstall the e-Comet plugin.
    exit /b 3
)

"%ECOMET_MCP_BINARY%"
exit /b %ERRORLEVEL%
