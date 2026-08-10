Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class LsaProbe {
    // PULONG is 32-bit; declaring it as ulong corrupts the stack and returns garbage counts.
    // Keep this C# block ASCII-only: Add-Type writes it to a temp .cs with an encoding that
    // mangles non-ASCII comments and swallows the attribute line that follows them.
    [DllImport("Secur32.dll", SetLastError = true)]
    public static extern uint LsaEnumerateLogonSessions(out uint LogonSessionCount, out IntPtr LogonSessionList);

    [DllImport("Secur32.dll")]
    public static extern uint LsaFreeReturnBuffer(IntPtr Buffer);

    [StructLayout(LayoutKind.Sequential)]
    public struct LUID { public uint LowPart; public int HighPart; }

    [DllImport("Secur32.dll", SetLastError = true)]
    public static extern uint LsaGetLogonSessionData(IntPtr LuidPtr, out IntPtr ppLogonSessionData);

    [StructLayout(LayoutKind.Sequential)]
    public struct LSA_UNICODE_STRING {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct SECURITY_LOGON_SESSION_DATA {
        public uint Size;
        public LUID LogonId;
        public LSA_UNICODE_STRING UserName;
        public LSA_UNICODE_STRING LogonDomain;
        public LSA_UNICODE_STRING AuthenticationPackage;
        public uint LogonType;
        public uint Session;
        public IntPtr Sid;
        public long LogonTime;
        public LSA_UNICODE_STRING LogonServer;
        public LSA_UNICODE_STRING DnsDomainName;
        public LSA_UNICODE_STRING Upn;
    }
}
'@

$count = [uint32]0
$list = [IntPtr]::Zero
$status = [LsaProbe]::LsaEnumerateLogonSessions([ref]$count, [ref]$list)
if ($status -ne 0) { throw "LsaEnumerateLogonSessions failed: 0x$($status.ToString('X8'))" }

"logon session count: $count"

$luidSize = [Runtime.InteropServices.Marshal]::SizeOf([type][LsaProbe+LUID])
$sample = [Math]::Min([int]$count, 4000)
$byType = @{}
$byPkg = @{}
$byUser = @{}

$toStr = {
    param($s)
    if ($s.Length -eq 0 -or $s.Buffer -eq [IntPtr]::Zero) { return '' }
    [Runtime.InteropServices.Marshal]::PtrToStringUni($s.Buffer, $s.Length / 2)
}

for ($i = 0; $i -lt $sample; $i++) {
    $luidPtr = [IntPtr]($list.ToInt64() + ($i * $luidSize))
    $dataPtr = [IntPtr]::Zero
    if ([LsaProbe]::LsaGetLogonSessionData($luidPtr, [ref]$dataPtr) -ne 0) { continue }
    if ($dataPtr -eq [IntPtr]::Zero) { continue }
    try {
        $d = [Runtime.InteropServices.Marshal]::PtrToStructure($dataPtr, [type][LsaProbe+SECURITY_LOGON_SESSION_DATA])
        $t = [int]$d.LogonType
        $byType[$t] = 1 + [int]$byType[$t]
        $pkg = & $toStr $d.AuthenticationPackage
        $byPkg[$pkg] = 1 + [int]$byPkg[$pkg]
        $user = (& $toStr $d.LogonDomain) + '\' + (& $toStr $d.UserName)
        $byUser[$user] = 1 + [int]$byUser[$user]
    } finally {
        [void][LsaProbe]::LsaFreeReturnBuffer($dataPtr)
    }
}

"sampled: $sample"
""
"=== by LogonType ==="
$byType.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 10 |
    ForEach-Object { "  type $($_.Key): $($_.Value)" }
""
"=== by AuthenticationPackage ==="
$byPkg.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 10 |
    ForEach-Object { "  $($_.Key): $($_.Value)" }
""
"=== by Account ==="
$byUser.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 10 |
    ForEach-Object { "  $($_.Key): $($_.Value)" }

[void][LsaProbe]::LsaFreeReturnBuffer($list)
