Add-Type -AssemblyName System.Drawing
$outDir = Join-Path $PSScriptRoot "..\desktop\icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(255, 20, 17, 13))
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 196, 163, 90))
$font = New-Object System.Drawing.Font "Arial", 72, [System.Drawing.FontStyle]::Bold
$g.DrawString("OL", $font, $brush, 18, 68)
$png = Join-Path $outDir "icon.png"
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$iconHandle = $bmp.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($iconHandle)
$ico = Join-Path $outDir "icon.ico"
$fs = [System.IO.File]::Create($ico)
$icon.Save($fs)
$fs.Close()
$g.Dispose()
$bmp.Dispose()
Write-Output $ico
