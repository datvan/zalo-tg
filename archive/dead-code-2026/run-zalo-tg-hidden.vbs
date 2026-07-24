Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = "C:\Users\Admin\.openclaw\workspace-main\repos\zalo-tg-hardened"
cmd = Chr(34) & "C:\Users\Admin\AppData\Roaming\crawbot\nodejs\node.exe" & Chr(34) & " " & Chr(34) & "scripts\supervisor-zalo-tg.mjs" & Chr(34) & " >> " & Chr(34) & "C:\Users\Admin\.openclaw\workspace-main\repos\zalo-tg-hardened\logs\zalo-tg-hidden-launch.log" & Chr(34) & " 2>&1"
shell.Run cmd, 0, False
