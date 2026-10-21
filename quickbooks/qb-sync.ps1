<#
DUA Route Planner - QuickBooks Desktop helper.

Every minute it reads the invoices dated today through the next 6 days from the QuickBooks
company file that is open on this PC, and sends them to the route planner. The planner checks
each invoice's client for that day and puts new orders onto a truck.

Put this file and qb-settings.json (from the planner: Settings > QuickBooks Desktop) in one
folder, for example C:\DUA-QuickBooks, then open PowerShell in that folder and run:

  powershell -ExecutionPolicy Bypass -File .\qb-sync.ps1 -Test        show what it finds, send nothing
  powershell -ExecutionPolicy Bypass -File .\qb-sync.ps1 -Install     run it now and at every Windows sign-in
  powershell -ExecutionPolicy Bypass -File .\qb-sync.ps1 -Uninstall   stop running it at sign-in

The first time, QuickBooks asks whether to let "DUA Route Planner" read the company file:
choose "Yes, always" (log in to QuickBooks as Admin for that first time). Progress and problems are written to qb-sync.log in the same folder.
Only invoices are read; nothing in QuickBooks is ever changed.
#>
param(
  [switch]$Test,
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Once,
  [int]$Days = 7,
  [string]$ResponseFile = ''   # for testing: read this qbXML answer instead of asking QuickBooks
)

$ErrorActionPreference = 'Stop'
$AppName = 'DUA Route Planner'
$Folder = Split-Path -Parent $MyInvocation.MyCommand.Path
$SettingsFile = Join-Path $Folder 'qb-settings.json'
$LogFile = Join-Path $Folder 'qb-sync.log'
$HeartbeatMinutes = 5   # send even when nothing changed, so the planner knows the helper is running

# Google needs TLS 1.2, which older Windows PowerShell doesn't use by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Write-Log([string]$text) {
  $line = '{0}  {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text
  Write-Host $line
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 1MB) {
      $keep = Get-Content $LogFile -Tail 2000
      Set-Content -Path $LogFile -Value $keep -Encoding UTF8
    }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch { }
}

# ---------- Start at sign-in ----------

function Get-StartupLink { Join-Path ([Environment]::GetFolderPath('Startup')) 'DUA QuickBooks helper.lnk' }

if ($Install) {
  if (-not (Test-Path $SettingsFile)) { throw "qb-settings.json is missing. Download it from the planner (Settings > QuickBooks Desktop) into $Folder" }
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Get-StartupLink))
  $link.TargetPath = Join-Path $PSHOME 'powershell.exe'
  $link.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $PSCommandPath
  $link.WorkingDirectory = $Folder
  $link.WindowStyle = 7
  $link.Save()
  Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList $link.Arguments -WindowStyle Hidden
  Write-Host "Installed. It is running now and will start each time you sign in to Windows."
  Write-Host "Check $LogFile to see what it sends."
  return
}

if ($Uninstall) {
  if (Test-Path (Get-StartupLink)) { Remove-Item (Get-StartupLink) }
  Get-CimInstance Win32_Process -Filter "Name like 'powershell%'" |
    Where-Object { $_.CommandLine -like "*qb-sync.ps1*" -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host "Removed. The helper no longer runs at sign-in."
  return
}

# ---------- QuickBooks ----------

function Invoke-QuickBooks([string]$request) {
  if ($ResponseFile) { return [IO.File]::ReadAllText($ResponseFile) }
  $rp = New-Object -ComObject QBXMLRP2.RequestProcessor
  try {
    $rp.OpenConnection2('', $AppName, 1)   # 1 = QuickBooks Desktop on this PC
    $ticket = $rp.BeginSession('', 2)      # '' = the company file that is open; 2 = single- or multi-user
    try { return $rp.ProcessRequest($ticket, $request) }
    finally { $rp.EndSession($ticket) }
  } finally {
    try { $rp.CloseConnection() } catch { }
    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($rp)
  }
}

# Street lines of a QuickBooks address plus "City, ST 12345". The first lines are often the
# customer's or a contact's name, so lines with a number in them are taken as the street.
function Format-Address($a) {
  if (-not $a) { return '' }
  $lines = @($a.Addr1, $a.Addr2, $a.Addr3, $a.Addr4, $a.Addr5) | Where-Object { $_ -and $_.Trim() } | ForEach-Object { $_.Trim() }
  $street = @($lines | Where-Object { $_ -match '\d' })
  if ($street.Count) { $lines = $street }
  $stateZip = (@($a.State, $a.PostalCode) | Where-Object { $_ }) -join ' '
  $city = (@($a.City, $stateZip) | Where-Object { $_ }) -join ', '
  return (@($lines) + @($city) | Where-Object { $_ }) -join ', '
}

function Get-Invoices([string]$from, [string]$to) {
  $request = @"
<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="13.0"?>
<QBXML>
  <QBXMLMsgsRq onError="stopOnError">
    <InvoiceQueryRq requestID="1">
      <TxnDateRangeFilter>
        <FromTxnDate>$from</FromTxnDate>
        <ToTxnDate>$to</ToTxnDate>
      </TxnDateRangeFilter>
      <IncludeLineItems>false</IncludeLineItems>
    </InvoiceQueryRq>
  </QBXMLMsgsRq>
</QBXML>
"@
  [xml]$doc = Invoke-QuickBooks $request
  $rs = $doc.QBXML.QBXMLMsgsRs.InvoiceQueryRs
  # 0 = found some, 1 = found none
  if ($rs.statusCode -ne '0' -and $rs.statusCode -ne '1') { throw "QuickBooks said: $($rs.statusMessage) (code $($rs.statusCode))" }
  $list = New-Object System.Collections.ArrayList
  foreach ($inv in @($rs.InvoiceRet)) {
    if (-not $inv) { continue }
    $address = Format-Address $inv.ShipAddress
    if (-not ($inv.ShipAddress.City -or $inv.ShipAddress.Addr2)) { $address = Format-Address $inv.BillAddress }
    $memo = [string]$inv.Memo
    $subtotal = 0.0
    [void][double]::TryParse([string]$inv.Subtotal, [Globalization.NumberStyles]::Any, [Globalization.CultureInfo]::InvariantCulture, [ref]$subtotal)
    [void]$list.Add([ordered]@{
      id      = [string]$inv.TxnID
      ref     = [string]$inv.RefNumber
      date    = [string]$inv.TxnDate
      cid     = [string]$inv.CustomerRef.ListID
      cname   = [string]$inv.CustomerRef.FullName
      address = $address
      # QuickBooks keeps voided invoices with a zero amount and "VOID" in the memo.
      voided  = ($memo -like 'VOID*') -and ($subtotal -eq 0)
    })
  }
  return ,$list
}

# ---------- Planner ----------

function Send-Invoices($settings, [string]$from, [string]$to, $invoices) {
  $body = [ordered]@{ action = 'qbPush'; key = $settings.key; from = $from; to = $to; invoices = @($invoices) } | ConvertTo-Json -Depth 5 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($body)
  # The planner's Google server answers a POST with a redirect to the result, which this follows.
  $answer = Invoke-RestMethod -Uri $settings.server -Method Post -Body $bytes -ContentType 'text/plain; charset=utf-8' -TimeoutSec 60
  if ($answer.error) { throw "The planner said: $($answer.error)" }
}

# ---------- Main loop ----------

# Windows PowerShell 64-bit can't load the 32-bit QuickBooks connector on some PCs: run 32-bit then.
if (-not $ResponseFile -and [Environment]::Is64BitProcess) {
  try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject((New-Object -ComObject QBXMLRP2.RequestProcessor)) }
  catch {
    $ps32 = Join-Path $env:WINDIR 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
    if (Test-Path $ps32) {
      $passOn = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
      foreach ($p in $PSBoundParameters.GetEnumerator()) {
        if ($p.Value -is [switch]) { if ($p.Value) { $passOn += "-$($p.Key)" } } else { $passOn += "-$($p.Key)"; $passOn += "$($p.Value)" }
      }
      & $ps32 @passOn
      return
    }
    throw 'The QuickBooks SDK is not installed on this PC (QBXMLRP2 is missing). See the README.'
  }
}

$settings = $null
if (Test-Path $SettingsFile) { $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json }
elseif (-not $Test) { throw "qb-settings.json is missing. Download it from the planner (Settings > QuickBooks Desktop) into $Folder" }

# Only one copy runs at a time.
$mutex = New-Object Threading.Mutex($false, 'Local\DUA-QuickBooks-helper')
if (-not $Test -and -not $mutex.WaitOne(0)) { Write-Host 'The helper is already running.'; return }

$lastSent = ''
$lastTime = [DateTime]::MinValue
$lastProblem = ''
Write-Log "Started. Reading invoices for $Days days from today."
while ($true) {
  try {
    $from = (Get-Date).ToString('yyyy-MM-dd')
    $to = (Get-Date).AddDays($Days - 1).ToString('yyyy-MM-dd')
    $invoices = Get-Invoices $from $to
    if ($Test) {
      Write-Host ("{0} invoice(s) dated {1} to {2}:" -f $invoices.Count, $from, $to)
      $invoices | ForEach-Object { [pscustomobject]$_ } | Format-Table date, ref, cname, address, voided -AutoSize | Out-String -Width 200 | Write-Host
      Write-Host 'Test only: nothing was sent.'
      break
    }
    $snapshot = ($invoices | ConvertTo-Json -Depth 5 -Compress)
    if ($snapshot -ne $lastSent -or ((Get-Date) - $lastTime).TotalMinutes -ge $HeartbeatMinutes) {
      Send-Invoices $settings $from $to $invoices
      if ($snapshot -ne $lastSent) { Write-Log ("Sent {0} invoice(s) dated {1} to {2}." -f $invoices.Count, $from, $to) }
      $lastSent = $snapshot
      $lastTime = Get-Date
    }
    $lastProblem = ''
  } catch {
    $problem = $_.Exception.Message
    if ($problem -match 'BeginSession|Could not start QuickBooks|company file') { $problem = "QuickBooks isn't open (or no company file is open). Trying again in a minute. ($problem)" }
    if ($problem -ne $lastProblem) { Write-Log "Problem: $problem" }   # log each new problem once
    $lastProblem = $problem
    if ($Test) { break }
  }
  if ($Once) { break }
  Start-Sleep -Seconds 60
}
