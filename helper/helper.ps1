# FJBC Notch — Windows helper.
# Runs hidden in Windows PowerShell 5.1 (it has the WinRT bridge PowerShell 7 lacks).
# Talks to the app over stdin/stdout, one JSON object per line. Nothing here touches the network.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Off

Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;

public static class NotchPump {
    public static ConcurrentQueue<string> Queue = new ConcurrentQueue<string>();
    public static volatile bool Closed = false;
    public static void Start() {
        var t = new Thread(() => {
            try {
                var r = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
                string line;
                while ((line = r.ReadLine()) != null) Queue.Enqueue(line);
            } catch { }
            Closed = true;
        });
        t.IsBackground = true;
        t.Start();
    }
}

public static class NotchNative {
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
    public static void PressWin() {
        keybd_event(0x5B, 0, 0, UIntPtr.Zero);
        keybd_event(0x5B, 0, 2, UIntPtr.Zero);
    }
    public static void BroadcastTheme() {
        UIntPtr r;
        SendMessageTimeout((IntPtr)0xffff, 0x1A, UIntPtr.Zero, "ImmersiveColorSet", 2, 200, out r);
    }
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
    int _a(); int _b(); int _c(); int _d();
    int SetMasterVolumeLevelScalar(float level, Guid ctx);
    int _e();
    int GetMasterVolumeLevelScalar(out float level);
    int _f(); int _g(); int _h(); int _i();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx);
    int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr p, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int _a(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

public static class NotchAudio {
    static IAudioEndpointVolume Vol() {
        var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
        IMMDevice dev; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
        IAudioEndpointVolume v; var id = typeof(IAudioEndpointVolume).GUID;
        Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, IntPtr.Zero, out v));
        return v;
    }
    public static float GetLevel() { float l; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out l)); return l; }
    public static void SetLevel(float l) { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, l)), Guid.Empty)); }
    public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
    public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Vol().SetMute(m, Guid.Empty)); }
}
'@

$script:out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding $false))
$script:out.AutoFlush = $true

function Emit($type, $data) {
    $o = [ordered]@{ t = $type; data = $data }
    $script:out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6))
}
function Log($msg) { Emit 'log' "$msg" }

# ------------------------------------------------------------------ WinRT plumbing
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType=WindowsRuntime]
$null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType=WindowsRuntime]

$script:asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($op, [Type]$type) {
    $task = $script:asTaskOp.MakeGenericMethod($type).Invoke($null, @($op))
    if ($task.Wait(4000)) { return $task.Result }
    return $null
}

# ------------------------------------------------------------------ media (Windows media controls: Spotify, browsers, most players)
$script:mgr = $null
$script:lastMediaSig = ''
$script:lastArtKey = ''

function Get-Session {
    if (-not $script:mgr) {
        $script:mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    }
    if (-not $script:mgr) { return $null }
    $best = $null
    foreach ($s in $script:mgr.GetSessions()) {
        if ($s.GetPlaybackInfo().PlaybackStatus -eq 'Playing') { return $s }
    }
    return $script:mgr.GetCurrentSession()
}

function Poll-Media {
    $s = Get-Session
    if (-not $s) {
        if ($script:lastMediaSig -ne 'none') { $script:lastMediaSig = 'none'; Emit 'media' $null }
        return
    }
    $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if (-not $props -or -not $props.Title) {
        if ($script:lastMediaSig -ne 'none') { $script:lastMediaSig = 'none'; Emit 'media' $null }
        return
    }
    $tl = $s.GetTimelineProperties()
    $pb = $s.GetPlaybackInfo()
    $dur = ($tl.EndTime - $tl.StartTime).TotalMilliseconds
    $data = [ordered]@{
        title     = $props.Title
        artist    = $props.Artist
        album     = $props.AlbumTitle
        app       = $s.SourceAppUserModelId
        playing   = ($pb.PlaybackStatus -eq 'Playing')
        posMs     = [math]::Round($tl.Position.TotalMilliseconds)
        durMs     = [math]::Round($dur)
        updatedAt = $tl.LastUpdatedTime.ToUnixTimeMilliseconds()
        canPrev   = $pb.Controls.IsPreviousEnabled
        canNext   = $pb.Controls.IsNextEnabled
    }
    $sig = "$($data.title)|$($data.artist)|$($data.playing)|$($data.updatedAt)|$($data.durMs)"
    if ($sig -ne $script:lastMediaSig) { $script:lastMediaSig = $sig; Emit 'media' $data }

    # Album art. Players often fill in the thumbnail a moment after the title,
    # so keep trying for ~10 seconds before telling the app there is none.
    $artKey = "$($data.artist)|$($data.title)"
    if ($artKey -ne $script:lastArtKey) {
        $script:lastArtKey = $artKey
        $script:artTries = 0
        $script:artDone = $false
    }
    if (-not $script:artDone) {
        $script:artTries++
        $src = Read-Thumbnail $props
        if ($src) {
            $script:artDone = $true
            Emit 'art' ([ordered]@{ key = $artKey; src = $src; final = $true })
        } elseif ($script:artTries -ge 8) {
            $script:artDone = $true
            Emit 'art' ([ordered]@{ key = $artKey; src = $null; final = $true })
        }
    }
}

$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]

function Read-Thumbnail($props) {
    if (-not $props.Thumbnail) { return $null }
    $ras = $null
    try {
        $ras = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    } catch { Log "art open: $($_.Exception.Message)"; return $null }
    if (-not $ras) { return $null }
    $size = [uint64]$ras.Size
    if ($size -eq 0 -or $size -gt 8MB) { return $null }
    $bytes = $null
    # 1) Plain WinRT: DataReader
    try {
        $reader = [Windows.Storage.Streams.DataReader]::new($ras.GetInputStreamAt(0))
        $loaded = Await ($reader.LoadAsync([uint32]$size)) ([uint32])
        if ($loaded -gt 0) {
            $bytes = New-Object byte[] $loaded
            $reader.ReadBytes($bytes)
        }
        $reader.Dispose()
    } catch { Log "art reader: $($_.Exception.Message)"; $bytes = $null }
    # 2) .NET bridge
    if (-not $bytes) {
        try {
            $ras.Seek(0)
            $net = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($ras)
            $ms = New-Object System.IO.MemoryStream
            $net.CopyTo($ms)
            $bytes = $ms.ToArray()
            $net.Dispose(); $ms.Dispose()
        } catch { Log "art stream: $($_.Exception.Message)"; $bytes = $null }
    }
    try { $ras.Dispose() } catch { }
    if (-not $bytes -or $bytes.Length -lt 64) { return $null }
    $ct = 'image/jpeg'
    if ($bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $ct = 'image/png' }
    elseif ($bytes[0] -eq 0x52 -and $bytes[1] -eq 0x49) { $ct = 'image/webp' }
    elseif ($bytes[0] -eq 0x42 -and $bytes[1] -eq 0x4D) { $ct = 'image/bmp' }
    return "data:$ct;base64," + [Convert]::ToBase64String($bytes)
}

function Media-Command($a) {
    $s = Get-Session
    if (-not $s) { return }
    switch ($a) {
        'toggle' { $null = Await ($s.TryTogglePlayPauseAsync()) ([bool]) }
        'next' { $null = Await ($s.TrySkipNextAsync()) ([bool]) }
        'prev' { $null = Await ($s.TrySkipPreviousAsync()) ([bool]) }
    }
}

# ------------------------------------------------------------------ radios (Wi-Fi, Bluetooth)
$script:radioAccess = $null
$script:lastRadios = ''

function Get-RadioList {
    if (-not $script:radioAccess) {
        $script:radioAccess = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
    }
    return Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
}

function Poll-Radios {
    $list = Get-RadioList
    $wifi = $null; $bt = $null
    foreach ($r in $list) {
        if ($r.Kind -eq 'WiFi' -and $null -eq $wifi) { $wifi = ($r.State -eq 'On') }
        if ($r.Kind -eq 'Bluetooth' -and $null -eq $bt) { $bt = ($r.State -eq 'On') }
    }
    $d = [ordered]@{ wifi = $wifi; bt = $bt; access = "$($script:radioAccess)" }
    $sig = "$wifi|$bt|$($script:radioAccess)"
    if ($sig -ne $script:lastRadios) { $script:lastRadios = $sig; Emit 'radios' $d }
}

function Toggle-Radio($kind) {
    $want = if ($kind -eq 'bt') { 'Bluetooth' } else { 'WiFi' }
    foreach ($r in (Get-RadioList)) {
        if ($r.Kind -eq $want) {
            $new = if ($r.State -eq 'On') { [Windows.Devices.Radios.RadioState]::Off } else { [Windows.Devices.Radios.RadioState]::On }
            $null = Await ($r.SetStateAsync($new)) ([Windows.Devices.Radios.RadioAccessStatus])
            break
        }
    }
}

# ------------------------------------------------------------------ volume, brightness, dark mode
$script:lastVol = ''
function Poll-Volume {
    $lvl = [math]::Round([NotchAudio]::GetLevel() * 100)
    $mute = [NotchAudio]::GetMute()
    $sig = "$lvl|$mute"
    if ($sig -ne $script:lastVol) { $script:lastVol = $sig; Emit 'volume' ([ordered]@{ level = $lvl; muted = $mute }) }
}

$script:brightSupported = $true
$script:lastBright = ''
function Poll-Brightness {
    if (-not $script:brightSupported) { return }
    try {
        $b = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
        $lvl = [int]$b.CurrentBrightness
    } catch {
        $script:brightSupported = $false
        Emit 'brightness' ([ordered]@{ supported = $false })
        return
    }
    if ("$lvl" -ne $script:lastBright) { $script:lastBright = "$lvl"; Emit 'brightness' ([ordered]@{ supported = $true; level = $lvl }) }
}
function Set-Brightness($level) {
    if (-not $script:brightSupported) { return }
    $level = [math]::Max(0, [math]::Min(100, [int]$level))
    $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1
    $null = Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]0; Brightness = [byte]$level }
}

$script:themeKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize'
$script:lastDark = ''
function Poll-Dark {
    $light = (Get-ItemProperty -Path $script:themeKey -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme
    $on = ($light -eq 0)
    if ("$on" -ne $script:lastDark) { $script:lastDark = "$on"; Emit 'dark' ([ordered]@{ on = $on }) }
}
function Toggle-Dark {
    $light = (Get-ItemProperty -Path $script:themeKey -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme
    $new = if ($light -eq 0) { 1 } else { 0 }
    Set-ItemProperty -Path $script:themeKey -Name AppsUseLightTheme -Value $new -Type DWord
    Set-ItemProperty -Path $script:themeKey -Name SystemUsesLightTheme -Value $new -Type DWord
    [NotchNative]::BroadcastTheme()
}

# ------------------------------------------------------------------ apps opening and closing
$script:apps = @{}
$script:ignore = @('ApplicationFrameHost', 'TextInputHost', 'explorer', 'SearchHost', 'StartMenuExperienceHost',
    'ShellExperienceHost', 'LockApp', 'SystemSettingsBroker', 'FJBC Notch', 'powershell', 'conhost', 'dwm', 'Widgets')

function Poll-Apps {
    $now = @{}
    foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle })) {
        if ($script:ignore -contains $p.ProcessName) { continue }
        $now[$p.Id] = $p
    }
    $opened = @(); $closed = @()
    foreach ($id in $now.Keys) {
        if (-not $script:apps.ContainsKey($id)) {
            $p = $now[$id]
            $name = $p.ProcessName; $path = $null
            try { $path = $p.Path } catch { }
            try { if ($p.Description) { $name = $p.Description } } catch { }
            $script:apps[$id] = [ordered]@{ name = $name; path = $path; proc = $p.ProcessName }
            $opened += , $script:apps[$id]
        }
    }
    foreach ($id in @($script:apps.Keys)) {
        if (-not $now.ContainsKey($id)) {
            $a = $script:apps[$id]
            $script:apps.Remove($id)
            # Only report a close when no other window of the same program is still open.
            $still = $false
            foreach ($v in $script:apps.Values) { if ($v.proc -eq $a.proc) { $still = $true; break } }
            if (-not $still) { $closed += , $a }
        }
    }
    if ($opened.Count -or $closed.Count -or -not $script:appsSent) {
        $script:appsSent = $true
        Emit 'apps' ([ordered]@{ opened = $opened; closed = $closed })
    }
}

# ------------------------------------------------------------------ commands from the app
$script:open = $false
$script:due = @{}

function Handle-Command($line) {
    $c = $line | ConvertFrom-Json
    switch ($c.c) {
        'mode' {
            $new = [bool]$c.open
            if ($new -ne $script:open) { $script:open = $new; $script:due = @{} }
        }
        'media' { Media-Command $c.a; $script:due['media'] = 0 }
        'radio' { Toggle-Radio $c.kind; $script:lastRadios = ''; $script:due['radios'] = 0 }
        'vol' {
            if ($null -ne $c.mute) { [NotchAudio]::SetMute(-not [NotchAudio]::GetMute()) }
            if ($null -ne $c.delta) { [NotchAudio]::SetLevel([NotchAudio]::GetLevel() + ([double]$c.delta / 100)); if ([NotchAudio]::GetMute()) { [NotchAudio]::SetMute($false) } }
            $script:due['volume'] = 0
        }
        'bright' {
            if ($null -ne $c.set) { Set-Brightness $c.set }
            elseif ($null -ne $c.delta) { Set-Brightness ([int]$script:lastBright + [int]$c.delta) }
            $script:lastBright = ''; $script:due['bright'] = 0
        }
        'dark' { Toggle-Dark; $script:due['dark'] = 0 }
        'start' { [NotchNative]::PressWin() }
    }
}

function Every($name, [int]$ms, [scriptblock]$fn) {
    $now = [Environment]::TickCount
    if (-not $script:due.ContainsKey($name) -or $now -ge $script:due[$name]) {
        $script:due[$name] = $now + $ms
        try { & $fn } catch { Log "$name : $($_.Exception.Message)" }
    }
}

[NotchPump]::Start()

while (-not [NotchPump]::Closed) {
    $line = $null
    while ([NotchPump]::Queue.TryDequeue([ref]$line)) {
        try { Handle-Command $line } catch { Log "command: $($_.Exception.Message)" }
    }
    if ($script:open) {
        Every 'media' 1000 { Poll-Media }
        Every 'volume' 1000 { Poll-Volume }
        Every 'radios' 4000 { Poll-Radios }
        Every 'bright' 4000 { Poll-Brightness }
        Every 'dark' 5000 { Poll-Dark }
        Every 'apps' 2000 { Poll-Apps }
    } else {
        Every 'media' 1500 { Poll-Media }
        Every 'volume' 5000 { Poll-Volume }
        Every 'radios' 20000 { Poll-Radios }
        Every 'dark' 20000 { Poll-Dark }
        Every 'apps' 2500 { Poll-Apps }
    }
    Start-Sleep -Milliseconds 200
}
