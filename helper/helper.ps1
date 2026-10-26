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
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    // The League game window (not the client): "League of Legends (TM) Client", class RiotWindowClass.
    public static string GameWindow() {
        IntPtr h = FindWindow("RiotWindowClass", null);
        if (h == IntPtr.Zero) h = FindWindow(null, "League of Legends (TM) Client");
        if (h == IntPtr.Zero || !IsWindowVisible(h)) return "";
        if (IsIconic(h)) return "min";
        RECT r; if (!GetWindowRect(h, out r)) return "";
        return r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top);
    }
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    // Tab held down while the League game window is in front (the scoreboard key). Only reads the
    // key state; the game still gets the key as normal.
    public static bool TabInGame() {
        IntPtr g = FindWindow("RiotWindowClass", null);
        if (g == IntPtr.Zero || GetForegroundWindow() != g) return false;
        return (GetAsyncKeyState(0x09) & 0x8000) != 0;
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
interface IMMDevice {
    int Activate(ref Guid id, int clsCtx, IntPtr p, out IAudioEndpointVolume aev);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore props);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    int GetState(out int state);
}
[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection { int GetCount(out uint count); int Item(uint index, out IMMDevice device); }
[StructLayout(LayoutKind.Sequential)] struct PROPERTYKEY { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit, Size = 24)] struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr ptr; }
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore {
    int GetCount(out uint count);
    int GetAt(uint index, out PROPERTYKEY key);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
}
// Undocumented but long-standing Windows interface for setting the default device
// (the same one SoundSwitch and AudioDeviceCmdlets use).
[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPolicyConfig {
    int _1(); int _2(); int _3(); int _4(); int _5(); int _6(); int _7(); int _8(); int _9(); int _10();
    int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string deviceId, int role);
}
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClientCom { }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }

// Per-app sound output (what Settings > Sound > Volume mixer does per app). Windows exposes it through
// an internal, undocumented interface (the same one EarTrumpet uses); its ID changed in Windows 10 21H2.
[ComImport, Guid("ab3d4648-e242-459f-b02f-541c70306324"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
interface IAudioPolicyConfigNew {
    int _a1(); int _a2(); int _a3(); int _a4(); int _a5(); int _a6(); int _a7(); int _a8(); int _a9(); int _a10();
    int _a11(); int _a12(); int _a13(); int _a14(); int _a15(); int _a16(); int _a17(); int _a18(); int _a19();
    [PreserveSig] int SetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, IntPtr deviceId);
    [PreserveSig] int GetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, out IntPtr deviceId);
    [PreserveSig] int ClearAllPersistedApplicationDefaultEndpoints();
}
[ComImport, Guid("2a59116d-6c4f-45e0-a74f-707e3fef9258"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
interface IAudioPolicyConfigOld {
    int _a1(); int _a2(); int _a3(); int _a4(); int _a5(); int _a6(); int _a7(); int _a8(); int _a9(); int _a10();
    int _a11(); int _a12(); int _a13(); int _a14(); int _a15(); int _a16(); int _a17(); int _a18(); int _a19();
    [PreserveSig] int SetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, IntPtr deviceId);
    [PreserveSig] int GetPersistedDefaultAudioEndpoint(uint processId, int flow, int role, out IntPtr deviceId);
    [PreserveSig] int ClearAllPersistedApplicationDefaultEndpoints();
}
// Audio sessions: which processes are actually playing sound (only those accept a per-app output).
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceAny { int Activate(ref Guid id, int clsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2 { int _c1(); int _c2(); int GetSessionEnumerator(out IAudioSessionEnumerator e); }
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator { int GetCount(out int n); int GetSession(int i, out IAudioSessionControl2 s); }
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2 {
    int _s1(); int _s2(); int _s3(); int _s4(); int _s5(); int _s6(); int _s7(); int _s8(); int _s9(); int _s10(); int _s11();
    int GetProcessId(out uint pid);
}
public static class NotchSessions {
    public static uint[] Pids() {
        var list = new System.Collections.Generic.List<uint>();
        var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
        IMMDeviceCollection col;
        if (e.EnumAudioEndpoints(0, 1, out col) != 0) return list.ToArray();
        uint n; col.GetCount(out n);
        var iid = typeof(IAudioSessionManager2).GUID;
        for (uint i = 0; i < n; i++) {
            try {
                IMMDevice d; if (col.Item(i, out d) != 0) continue;
                object o; if (((IMMDeviceAny)(object)d).Activate(ref iid, 23, IntPtr.Zero, out o) != 0) continue;
                IAudioSessionEnumerator se; if (((IAudioSessionManager2)o).GetSessionEnumerator(out se) != 0) continue;
                int c; se.GetCount(out c);
                for (int k = 0; k < c; k++) { IAudioSessionControl2 sc; if (se.GetSession(k, out sc) != 0) continue; uint pid; if (sc.GetProcessId(out pid) == 0 && pid != 0 && !list.Contains(pid)) list.Add(pid); }
            } catch { }
        }
        return list.ToArray();
    }
}
public static class NotchAppAudio {
    [DllImport("combase.dll", PreserveSig = false)] static extern void RoGetActivationFactory(IntPtr classId, [In] ref Guid iid, [MarshalAs(UnmanagedType.IInspectable)] out object factory);
    [DllImport("combase.dll", PreserveSig = false)] static extern void WindowsCreateString([MarshalAs(UnmanagedType.LPWStr)] string s, int len, out IntPtr hstr);
    [DllImport("combase.dll", PreserveSig = false)] static extern void WindowsDeleteString(IntPtr hstr);
    [DllImport("combase.dll")] static extern IntPtr WindowsGetStringRawBuffer(IntPtr hstr, out uint len);
    const string RENDER = "#{e6327cad-dcec-4949-ae8a-991e976a79d2}";
    static object factory;
    static object Factory() {
        if (factory != null) return factory;
        IntPtr cls; WindowsCreateString("Windows.Media.Internal.AudioPolicyConfig", 40, out cls);
        try {
            foreach (var iid in new[] { typeof(IAudioPolicyConfigNew).GUID, typeof(IAudioPolicyConfigOld).GUID }) {
                try { var g = iid; object f; RoGetActivationFactory(cls, ref g, out f); if (f != null) { factory = f; return f; } } catch { }
            }
        } finally { WindowsDeleteString(cls); }
        throw new InvalidOperationException("per-app audio is not available on this Windows");
    }
    // deviceId "" puts the app back on the PC's own output
    public static void Set(uint pid, string deviceId) {
        var f = Factory();
        IntPtr h = IntPtr.Zero;
        if (!string.IsNullOrEmpty(deviceId)) { string full = @"\\?\SWD#MMDEVAPI#" + deviceId + RENDER; WindowsCreateString(full, full.Length, out h); }
        try {
            int bad = 0;
            for (int role = 0; role < 2; role++) {   // console and multimedia
                int hr = f is IAudioPolicyConfigNew ? ((IAudioPolicyConfigNew)f).SetPersistedDefaultAudioEndpoint(pid, 0, role, h) : ((IAudioPolicyConfigOld)f).SetPersistedDefaultAudioEndpoint(pid, 0, role, h);
                if (hr != 0) bad = hr;
            }
            if (bad != 0) throw new InvalidOperationException("0x" + bad.ToString("X8"));
        } finally { if (h != IntPtr.Zero) WindowsDeleteString(h); }
    }
    public static string Get(uint pid) {
        var f = Factory();
        IntPtr h;
        int hr = f is IAudioPolicyConfigNew ? ((IAudioPolicyConfigNew)f).GetPersistedDefaultAudioEndpoint(pid, 0, 1, out h) : ((IAudioPolicyConfigOld)f).GetPersistedDefaultAudioEndpoint(pid, 0, 1, out h);
        if (hr != 0 || h == IntPtr.Zero) return "";
        uint len; string s = Marshal.PtrToStringUni(WindowsGetStringRawBuffer(h, out len), (int)len);
        WindowsDeleteString(h);
        int a = s.IndexOf("MMDEVAPI#"), b = s.LastIndexOf("#{");
        return a >= 0 && b > a ? s.Substring(a + 9, b - a - 9) : "";
    }
}

public static class NotchAudio {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pv);
    static string FriendlyName(IMMDevice d) {
        IPropertyStore ps;
        if (d.OpenPropertyStore(0, out ps) != 0) return "";
        var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
        PROPVARIANT pv;
        if (ps.GetValue(ref key, out pv) != 0) return "";
        string name = pv.vt == 31 ? Marshal.PtrToStringUni(pv.ptr) : "";
        PropVariantClear(ref pv);
        return name ?? "";
    }
    // Active playback devices as "id<TAB>name<TAB>1 if default" lines.
    public static string[] ListOutputs() {
        var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
        string def = "";
        IMMDevice dd;
        if (e.GetDefaultAudioEndpoint(0, 1, out dd) == 0) dd.GetId(out def);
        IMMDeviceCollection col;
        Marshal.ThrowExceptionForHR(e.EnumAudioEndpoints(0, 1, out col));
        uint n; col.GetCount(out n);
        var list = new System.Collections.Generic.List<string>();
        for (uint i = 0; i < n; i++) {
            IMMDevice d; if (col.Item(i, out d) != 0) continue;
            string id; d.GetId(out id);
            list.Add(id + "\t" + FriendlyName(d) + "\t" + (id == def ? "1" : "0"));
        }
        return list.ToArray();
    }
    public static void SetDefaultOutput(string id) {
        var pc = (IPolicyConfig)(new PolicyConfigClientCom());
        for (int role = 0; role < 3; role++) Marshal.ThrowExceptionForHR(pc.SetDefaultEndpoint(id, role));
    }
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
    if ($script:mediaApp -ne $s.SourceAppUserModelId) { $script:mediaApp = $s.SourceAppUserModelId; $script:lastOutputs = '' }
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

# ------------------------------------------------------------------ sound output devices
$script:lastOutputs = ''
# The processes of the app that's playing music (from the media session's app id).
function Get-MusicPids {
    $a = "$script:mediaApp"
    if (-not $a) { return @() }
    $names = @()
    if ($a -match '([^\\/!]+)\.exe$') { $names += $Matches[1] }
    $map = @{ 'chrome' = 'chrome'; 'msedge' = 'msedge'; 'firefox' = 'firefox'; 'opera' = 'opera'; 'brave' = 'brave'; 'spotify' = 'Spotify'; 'vivaldi' = 'vivaldi'; 'tidal' = 'TIDAL'; 'deezer' = 'Deezer'; 'applemusic' = 'AppleMusic'; 'itunes' = 'iTunes'; 'vlc' = 'vlc'; 'foobar' = 'foobar2000'; 'zune' = 'Microsoft.Media.Player' }
    foreach ($k in $map.Keys) { if ($a -match $k) { $names += $map[$k] } }
    $ids = @()
    foreach ($n in ($names | Select-Object -Unique)) { $ids += @(Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) }
    if (-not $ids -and $a -match '^([^_!]+)_') {
        $pkg = $Matches[1]
        $ids += @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -like "*$pkg*" } | ForEach-Object { $_.Id })
    }
    return @($ids | Select-Object -Unique)
}
# Only the music app's processes that have a sound session accept a per-app output (Spotify and
# browsers run many processes; the others answer "invalid argument").
function Get-MusicAudioPids {
    $ids = @(Get-MusicPids)
    if (-not $ids) { return @() }
    $sess = @()
    try { $sess = @([NotchSessions]::Pids()) } catch { Log "appout sessions: $($_.Exception.Message)" }
    $hit = @($ids | Where-Object { $sess -contains [uint32]$_ })
    if ($hit) { return $hit }
    return $ids
}
$script:appOutErr = ''
function Set-AppOutput($deviceId) {
    $script:appOutErr = ''
    $ids = @(Get-MusicAudioPids)
    if (-not $ids) { Log "appout: no process for '$script:mediaApp'"; $script:appOutErr = 'Start the music first'; return }
    $ok = 0; $last = ''
    foreach ($p in $ids) { try { [NotchAppAudio]::Set([uint32]$p, $deviceId); $ok++ } catch { $last = $_.Exception.InnerException.Message; if (-not $last) { $last = $_.Exception.Message } } }
    if (-not $ok) { Log "appout: Windows refused for $($ids.Count) process(es): $last"; $script:appOutErr = 'Windows didn''t accept it, play some music first and try again' }
    else { $script:appOutWant = $deviceId }
}

function Poll-Outputs {
    $devs = @()
    foreach ($line in [NotchAudio]::ListOutputs()) {
        $f = $line -split "`t"
        $devs += , ([ordered]@{ id = $f[0]; name = $f[1]; default = ($f[2] -eq '1') })
    }
    # where the music app's sound goes ('' = same as the PC)
    $app = ''; $appOut = ''; $appOk = $true
    $ids = Get-MusicPids
    if ($ids) {
        $app = "$script:mediaApp"
        try { foreach ($p in @(Get-MusicAudioPids)) { $o = [NotchAppAudio]::Get([uint32]$p); if ($o) { $appOut = $o; break } } } catch { $appOk = $false }
    }
    $err = "$script:appOutErr"
    $sig = (($devs | ForEach-Object { "$($_.id)|$($_.default)" }) -join ';') + "|$app|$appOut|$appOk|$err"
    if ($sig -ne $script:lastOutputs) { $script:lastOutputs = $sig; Emit 'outputs' ([ordered]@{ devices = $devs; app = $app; appOut = $appOut; appOk = $appOk; appErr = $err }) }
}

# ------------------------------------------------------------------ League of Legends client (its local API port and key)
$script:lastLcu = $null
function Poll-League {
    $info = $null
    $p = Get-CimInstance -ClassName Win32_Process -Filter "Name='LeagueClientUx.exe'" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($p -and $p.CommandLine) {
        $port = [regex]::Match($p.CommandLine, '--app-port=(\d+)').Groups[1].Value
        $token = [regex]::Match($p.CommandLine, '--remoting-auth-token=([\w-]+)').Groups[1].Value
        if ($port -and $token) { $info = "$port|$token" }
    }
    # the game window, for the in-game overlay
    $gw = ''
    try { $gw = [NotchNative]::GameWindow() } catch { }
    if ($gw -ne $script:lastGameWin) {
        $script:lastGameWin = $gw
        if ($gw -and $gw -ne 'min') { $g = $gw -split ','; Emit 'lolwin' ([ordered]@{ x = [int]$g[0]; y = [int]$g[1]; w = [int]$g[2]; h = [int]$g[3] }) }
        else { Emit 'lolwin' ([ordered]@{ none = $true; minimized = ($gw -eq 'min') }) }
    }
    if ($info -ne $script:lastLcu) {
        $script:lastLcu = $info
        if ($info) { $f = $info -split '\|'; Emit 'lcu' ([ordered]@{ port = [int]$f[0]; token = $f[1] }) }
        else { Emit 'lcu' $null }
    }
}

# ------------------------------------------------------------------ apps opening and closing
$script:apps = @{}
$script:ignore = @('ApplicationFrameHost', 'TextInputHost', 'explorer', 'SearchHost', 'StartMenuExperienceHost',
    'ShellExperienceHost', 'LockApp', 'SystemSettingsBroker', 'FJBC Notch', 'WALL-E', 'powershell', 'conhost', 'dwm', 'Widgets')

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
            if ($null -ne $c.set) { [NotchAudio]::SetLevel([math]::Min(1, [math]::Max(0, [double]$c.set / 100))); if ([NotchAudio]::GetMute()) { [NotchAudio]::SetMute($false) } }
            if ($null -ne $c.delta) { [NotchAudio]::SetLevel([NotchAudio]::GetLevel() + ([double]$c.delta / 100)); if ([NotchAudio]::GetMute()) { [NotchAudio]::SetMute($false) } }
            $script:due['volume'] = 0
        }
        'bright' {
            if ($null -ne $c.set) { Set-Brightness $c.set }
            elseif ($null -ne $c.delta) { Set-Brightness ([int]$script:lastBright + [int]$c.delta) }
            $script:lastBright = ''; $script:due['bright'] = 0
        }
        'dark' { Toggle-Dark; $script:due['dark'] = 0 }
        'outputs' { $script:lastOutputs = ''; $script:due['outputs'] = 0 }
        'appout' { Set-AppOutput ([string]$c.id); $script:lastOutputs = ''; $script:due['outputs'] = 0 }
        'setoutput' { [NotchAudio]::SetDefaultOutput([string]$c.id); $script:lastOutputs = ''; $script:due['outputs'] = 0; $script:lastVol = ''; $script:due['volume'] = 0 }
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
        Every 'outputs' 5000 { Poll-Outputs }
        Every 'league' 5000 { Poll-League }
    } else {
        Every 'media' 1500 { Poll-Media }
        Every 'volume' 5000 { Poll-Volume }
        Every 'radios' 20000 { Poll-Radios }
        Every 'dark' 20000 { Poll-Dark }
        Every 'apps' 2500 { Poll-Apps }
        Every 'outputs' 30000 { Poll-Outputs }
        Every 'league' 8000 { Poll-League }
    }
    # While a League game is up, watch the Tab key (for the item overlay) a few times a second.
    $inGame = $script:lastGameWin -and $script:lastGameWin -ne 'min'
    if ($inGame) {
        $tab = $false
        try { $tab = [NotchNative]::TabInGame() } catch { }
        if ($tab -ne $script:lastTab) { $script:lastTab = $tab; Emit 'tab' $tab }
        Start-Sleep -Milliseconds 60
    } else {
        if ($script:lastTab) { $script:lastTab = $false; Emit 'tab' $false }
        Start-Sleep -Milliseconds 200
    }
}
