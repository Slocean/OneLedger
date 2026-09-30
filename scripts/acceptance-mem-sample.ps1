# 规模测试内存峰值采样：运行 cargo ignored 测试期间每 200ms 采样 oneledger 测试进程工作集。
$jobs = @()
$test = Start-Process -FilePath "cargo" -ArgumentList "test","--offline","--lib","--","--ignored","--nocapture","scope_merge_scale" -WorkingDirectory "E:\Project\OneLedger\src-tauri" -NoNewWindow -PassThru -RedirectStandardOutput "E:\Project\OneLedger\.tmp-scale-out.txt" -RedirectStandardError "E:\Project\OneLedger\.tmp-scale-err.txt"
$peak = 0
$peakName = ""
while (-not $test.HasExited) {
  Start-Sleep -Milliseconds 200
  $procs = Get-Process | Where-Object { $_.Name -like "oneledger*" }
  foreach ($p in $procs) {
    if ($p.WorkingSet64 -gt $peak) { $peak = $p.WorkingSet64; $peakName = $p.Name }
  }
}
Write-Output ("exit=" + $test.ExitCode)
Write-Output ("peak_ws_mb=" + [math]::Round($peak / 1MB, 1) + " (" + $peakName + ")")
