Set WshShell = CreateObject("WScript.Shell")
script = "C:\Users\Admin\.openclaw\workspace-main\repos\zalo-tg-hardened\scripts\run-watchdog-pm2-hidden.ps1"
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & script & """"
result = WshShell.Run(cmd, 0, True)
WScript.Quit result
