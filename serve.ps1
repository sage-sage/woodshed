# Woodshed local server: serves this folder on http://localhost:8642/ using only what ships with Windows.
# The browser only allows guitar input on localhost (or https), which is why Woodshed is served instead of opened
# as a file. Started by "Start Woodshed.cmd". Close the window to stop it.
param([int]$Port = 8642)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
# Compare against the folder WITH a trailing separator, so a sibling such as "woodshed-amp" does not count as inside.
$sep = [System.IO.Path]::DirectorySeparatorChar
$rootPrefix = $root.TrimEnd($sep) + $sep
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'
  '.ico' = 'image/x-icon'; '.wav' = 'audio/wav'; '.mp3' = 'audio/mpeg'; '.txt' = 'text/plain; charset=utf-8'
  '.woff2' = 'font/woff2'; '.zip' = 'application/zip'
}
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } catch {
  Write-Host "Port $Port is already in use. Woodshed may already be running: opening it." -ForegroundColor Yellow
  Start-Process "http://localhost:$Port/"
  exit 0
}
Write-Host "Woodshed is running at http://localhost:$Port/  (close this window to stop it)" -ForegroundColor Green
if (-not $env:WOODSHED_NO_BROWSER) { Start-Process "http://localhost:$Port/" }

function Send-Response($stream, [int]$code, [string]$status, [string]$type, [byte[]]$body) {
  $head = "HTTP/1.1 $code $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`n" +
          "Cache-Control: no-cache`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  if ($body.Length) { $stream.Write($body, 0, $body.Length) }
}

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $stream = $client.GetStream()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 8192, $true)
    $line = $reader.ReadLine()
    while (($h = $reader.ReadLine()) -ne $null -and $h -ne '') { }
    if (-not $line -or $line -notmatch '^(GET|HEAD) (\S+) HTTP') {
      Send-Response $stream 405 'Method Not Allowed' 'text/plain' ([byte[]]@())
      continue
    }
    $isHead = $Matches[1] -eq 'HEAD'
    $path = [System.Uri]::UnescapeDataString(($Matches[2] -split '[?#]')[0])
    if ($path -eq '/' -or $path -eq '') { $path = '/index.html' }
    $full = [System.IO.Path]::GetFullPath((Join-Path $root ($path.TrimStart('/') -replace '/', '\')))
    if (-not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
      Send-Response $stream 404 'Not Found' 'text/plain' ([System.Text.Encoding]::UTF8.GetBytes('Not found'))
      continue
    }
    $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
    $type = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
    if ($isHead) {
      $len = (Get-Item -LiteralPath $full).Length
      $hb = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: $type`r`nContent-Length: $len`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n")
      $stream.Write($hb, 0, $hb.Length)
      continue
    }
    Send-Response $stream 200 'OK' $type ([System.IO.File]::ReadAllBytes($full))
  } catch {
    # A browser closing a connection early is normal; keep serving.
  } finally {
    $client.Close()
  }
}
