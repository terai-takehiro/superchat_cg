'use strict';

// Windows の通知領域（タスクトレイ）にアイコンを出す。
// ネイティブモジュールを使わず、Windows 標準の PowerShell（.NET の NotifyIcon）で実現する。
// アプリ本体が終了するとアイコンも自動で消える。
const { spawn } = require('child_process');

const q = (s) => String(s).replace(/'/g, "''"); // PowerShell の単一引用符エスケープ

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
  return child;
}

function trayScript({ url, exePath, logPath, notice, pid = process.pid }) {
  return `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$url = '${q(url)}'
$parentId = ${pid}
$icon = New-Object System.Windows.Forms.NotifyIcon
try { $icon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon('${q(exePath)}') } catch { $icon.Icon = [System.Drawing.SystemIcons]::Application }
$icon.Text = 'スーパーチャットCG（' + $url + '）'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('操作画面を開く')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ Start-Process $url })
$menu.Items.Add('設定を開く').add_Click({ Start-Process ($url + 'settings') })
$menu.Items.Add('ログを開く').add_Click({ Start-Process notepad.exe '${q(logPath)}' })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$menu.Items.Add('終了').add_Click({
  $icon.Visible = $false
  try { Stop-Process -Id $parentId -Force } catch {}
  [System.Windows.Forms.Application]::Exit()
})
$icon.ContextMenuStrip = $menu
$icon.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Start-Process $url } })
$icon.Visible = $true
$icon.ShowBalloonTip(6000, 'スーパーチャットCG', '${q(notice)}', [System.Windows.Forms.ToolTipIcon]::Info)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({ if (-not (Get-Process -Id $parentId -ErrorAction SilentlyContinue)) { $icon.Visible = $false; [System.Windows.Forms.Application]::Exit() } })
$timer.Start()
[System.Windows.Forms.Application]::Run()
$icon.Dispose()
`;
}

function startTray(opts) {
  if (process.platform !== 'win32') return null;
  return runPowerShell(trayScript(opts));
}

// 起動できなかったときなど、ウィンドウがない状態でも利用者に知らせる
function showMessage(text, title = 'スーパーチャットCG') {
  if (process.platform !== 'win32') return;
  runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
[void][System.Windows.Forms.MessageBox]::Show('${q(text)}', '${q(title)}', 'OK', 'Warning')
`);
}

module.exports = { startTray, showMessage, trayScript };
