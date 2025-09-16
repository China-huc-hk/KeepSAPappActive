@echo off
setlocal enabledelayedexpansion

:: Set window title
title SAP Config Generator v1.0.0

:: Clear screen and show header
cls
echo.
echo ================================================================================
echo                     SAP Application Config Generator
echo                              Version: v1.0.0
echo.
echo              Project: https://github.com/hcllmsx/KeepSAPappActive
echo ================================================================================
echo.

:: Ask for number of apps
:ask_app_count
set /p app_count="Enter number of applications to configure: "
if "!app_count!"=="" (
    echo Please enter a valid number!
    goto ask_app_count
)
echo !app_count!| findstr /r "^[0-9][0-9]*$" >nul
if errorlevel 1 (
    echo Please enter a valid number!
    goto ask_app_count
)
if !app_count! lss 1 (
    echo Number must be greater than 0!
    goto ask_app_count
)

echo.
:: Ask for identification method
:ask_identification_method
echo Please select application identification method:
echo 1. By GUID
echo 2. By Name, Organization and Space
set /p id_method="Please choose (1 or 2): "
if "!id_method!"=="1" (
    set use_guid=true
    echo Selected: By GUID
) else if "!id_method!"=="2" (
    set use_guid=false
    echo Selected: By Name, Organization and Space
) else (
    echo Please enter valid option 1 or 2!
    goto ask_identification_method
)

echo.
echo Starting to collect application configuration...
echo.

:: Initialize JSON content
set json_content=[

:: Loop to collect each app info
for /l %%i in (1,1,!app_count!) do (
    call :collect_app_info %%i
)

:: Complete JSON array
set json_content=!json_content!]

echo.
echo ================================================================================
echo All application information has been collected!
echo ================================================================================
echo.
pause

:: Get current timestamp for filename (minutes and seconds only)
for /f "tokens=1-3 delims=:." %%a in ('echo %time%') do (
    set hh=%%a
    set min=%%b
    set sec=%%c
)

:: Clean up time format
set min=!min: =0!
set sec=!sec: =0!

:: Generate filename with minutes and seconds only
set filename=apps-config-!min!!sec!.txt

:: Save JSON to file
echo !json_content! > "!filename!"

echo.
echo ================================================================================
echo Configuration file saved as: !filename!
echo ================================================================================
echo.
echo Configuration generation completed! Press any key to exit...
pause >nul
goto :eof

:: Function to collect app information
:collect_app_info
set current_app=%1
echo ------------------------ Application !current_app! Configuration ------------------------

:: Set default APP_ID and reset app_id variable
set default_app_id=app!current_app!
set app_id=
set /p app_id="Enter APP_ID (press Enter for default !default_app_id!): "
if "!app_id!"=="" set app_id=!default_app_id!

:: Choose region
:ask_region
echo.
echo Please select application region:
echo 1. Singapore
echo 2. United States
set /p region="Please choose (1 or 2): "
if "!region!"=="1" (
    set cf_api=https://api.cf.ap21.hana.ondemand.com
    set uaa_url=https://uaa.cf.ap21.hana.ondemand.com
    echo Selected: Singapore region
) else if "!region!"=="2" (
    set cf_api=https://api.cf.us10-001.hana.ondemand.com
    set uaa_url=https://uaa.cf.us10-001.hana.ondemand.com
    echo Selected: United States region
) else (
    echo Please enter valid option 1 or 2!
    goto ask_region
)

:: Ask for SAP username
echo.
:ask_username
set /p cf_username="Enter SAP username (CF_USERNAME): "
if "!cf_username!"=="" (
    echo SAP username cannot be empty!
    goto ask_username
)

:: Ask for SAP password
:ask_password
set /p cf_password="Enter SAP password (CF_PASSWORD): "
if "!cf_password!"=="" (
    echo SAP password cannot be empty!
    goto ask_password
)

:: Ask for different info based on identification method
if "!use_guid!"=="true" (
    :: GUID method
    :ask_guid
    set /p app_guid="Enter application GUID (APP_GUID): "
    if "!app_guid!"=="" (
        echo Application GUID cannot be empty!
        goto ask_guid
    )
    set additional_fields=,    "APP_GUID": "!app_guid!"
) else (
    :: Name/Org/Space method
    :ask_app_name
    set /p app_name="Enter application name (APP_NAME): "
    if "!app_name!"=="" (
        echo Application name cannot be empty!
        goto ask_app_name
    )
    
    :ask_org_name
    set /p org_name="Enter organization name (ORG_NAME): "
    if "!org_name!"=="" (
        echo Organization name cannot be empty!
        goto ask_org_name
    )
    
    :ask_space_name
    set /p space_name="Enter space name (SPACE_NAME): "
    if "!space_name!"=="" (
        echo Space name cannot be empty!
        goto ask_space_name
    )
    
    set additional_fields=,    "APP_NAME": "!app_name!",    "ORG_NAME": "!org_name!",    "SPACE_NAME": "!space_name!"
)

:: Ask for health check URL (optional)
echo.
set ping_url=
set temp_ping_url=
echo Enter health check URL (APP_PING_URL, press Enter to skip):
set /p temp_ping_url=
if "!temp_ping_url!"=="" (
    set ping_url_field=
) else (
    set ping_url_field=,    "APP_PING_URL": "!temp_ping_url!"
)

:: Build JSON object
if !current_app! == 1 (
    set json_content=!json_content!  {
) else (
    set json_content=!json_content!,  {
)

set json_content=!json_content!    "APP_ID": "!app_id!",    "CF_API": "!cf_api!",    "UAA_URL": "!uaa_url!",    "CF_USERNAME": "!cf_username!",    "CF_PASSWORD": "!cf_password!"!additional_fields!!ping_url_field!  }

echo.
echo Application !current_app! configuration completed!
echo.

goto :eof