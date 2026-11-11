# A small always-on-top window that asks one question: Yes, No, or your own words.
# It plays an alarm when it opens and every few minutes after, flashes in the taskbar and comes back to the front.
# With no answer it closes after -Minutes. It prints one line: yes | no | text:<words> | none
param(
  [Parameter(Mandatory = $true)][string]$Question,
  [string]$Title = "deputy needs your answer",
  [int]$Minutes = 10,
  [int]$RemindEveryMinutes = 2
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DeputyFlash {
  [StructLayout(LayoutKind.Sequential)]
  public struct FLASHWINFO { public uint cbSize; public IntPtr hwnd; public uint dwFlags; public uint uCount; public uint dwTimeout; }
  [DllImport("user32.dll")] public static extern bool FlashWindowEx(ref FLASHWINFO pwfi);
  public static void Window(IntPtr h) {
    FLASHWINFO f = new FLASHWINFO();
    f.cbSize = (uint)Marshal.SizeOf(f); f.hwnd = h; f.dwFlags = 3 | 12; f.uCount = 5; f.dwTimeout = 0;
    FlashWindowEx(ref f);
  }
}
"@

# A sound file, because the Windows sound scheme is often switched off.
$alarm = Join-Path $env:WINDIR 'Media/Alarm01.wav'
function Play-Reminder {
  if (Test-Path $alarm) { (New-Object Media.SoundPlayer $alarm).Play() } else { [System.Media.SystemSounds]::Exclamation.Play() }
}

$script:answer = "none"
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.TopMost = $true
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.Width = 560
$form.Height = 300
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$label = New-Object System.Windows.Forms.Label
$label.Text = $Question
$label.Left = 16; $label.Top = 14; $label.Width = 512; $label.Height = 110
$form.Controls.Add($label)

$box = New-Object System.Windows.Forms.TextBox
$box.Left = 16; $box.Top = 132; $box.Width = 512; $box.Height = 28
$form.Controls.Add($box)

$left = New-Object System.Windows.Forms.Label
$left.Left = 16; $left.Top = 214; $left.Width = 300; $left.ForeColor = [System.Drawing.Color]::Gray
$form.Controls.Add($left)

function Add-Button($text, $x, $value) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.Left = $x; $b.Top = 172; $b.Width = 120; $b.Height = 32
  $b.Tag = $value
  $b.Add_Click({ param($s, $e) $script:answer = $s.Tag; $form.Close() }.GetNewClosure())
  $form.Controls.Add($b)
}
Add-Button "Yes" 16 "yes"
Add-Button "No" 144 "no"
$submit = New-Object System.Windows.Forms.Button
$submit.Text = "Send my answer"; $submit.Left = 344; $submit.Top = 172; $submit.Width = 184; $submit.Height = 32
$submit.Add_Click({ if ($box.Text.Trim()) { $script:answer = "text:" + $box.Text.Trim(); $form.Close() } })
$form.Controls.Add($submit)
$form.AcceptButton = $submit

$deadline = (Get-Date).AddMinutes($Minutes)
$script:nextRemind = Get-Date
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.Add_Tick({
  $now = Get-Date
  $rest = [int][Math]::Ceiling(($deadline - $now).TotalMinutes)
  $left.Text = "Closes in $rest min without an answer"
  if ($now -ge $deadline) { $script:answer = "none"; $form.Close(); return }
  if ($now -ge $script:nextRemind) {
    $script:nextRemind = $now.AddMinutes($RemindEveryMinutes)
    Play-Reminder
    $form.TopMost = $false; $form.TopMost = $true
    $form.Activate()
    [DeputyFlash]::Window($form.Handle)
  }
})
$form.Add_Shown({ $timer.Start(); $box.Focus() })
[void]$form.ShowDialog()
$timer.Stop()
Write-Output $script:answer
