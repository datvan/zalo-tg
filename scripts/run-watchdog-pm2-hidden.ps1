$ErrorActionPreference = 'Stop'

$root = 'C:\Users\Admin\.openclaw\workspace-main\repos\zalo-tg-hardened'
$node = 'C:\Users\Admin\AppData\Roaming\crawbot\nodejs\node.exe'
$script = Join-Path $root 'scripts\watchdog-zalo-tg-pm2.mjs'

$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $node
$psi.Arguments = "`"$script`""
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden

$p = [System.Diagnostics.Process]::Start($psi)
$p.WaitForExit()
exit $p.ExitCode
