for (;;) {
    $process = Start-Process cmd.exe -ArgumentList '/c npx localtunnel --port 3000 --subdomain calgentic-tracker-99' -NoNewWindow -PassThru -RedirectStandardOutput 'lt.log'
    Start-Sleep -Seconds 8
    $logContent = Get-Content -Path 'lt.log' -Raw -ErrorAction SilentlyContinue
    if ($logContent -match 'calgentic-tracker-99') {
        Write-Host 'Tunnel successfully connected!'
        $process.WaitForExit()
    } else {
        Write-Host 'Subdomain busy. Retrying...'
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -Path 'lt.log' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 10
}
