# 取证脚本：枚举全系统句柄，按进程统计 Token 对象句柄数。
# 用途：分页池 `Toke` 标签异常膨胀时，先确认这些令牌是否挂在某个进程的句柄表里
# （挂着 = 用户态泄漏，能杀进程回收；不挂 = 纯内核引用泄漏，只能重启）。
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class HandleQuery {
    [DllImport("ntdll.dll")]
    public static extern int NtQuerySystemInformation(int SystemInformationClass, IntPtr SystemInformation, int SystemInformationLength, out int ReturnLength);

    // SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX (x64)
    [StructLayout(LayoutKind.Sequential)]
    public struct HandleEntryEx {
        public IntPtr Object;
        public IntPtr UniqueProcessId;
        public IntPtr HandleValue;
        public uint GrantedAccess;
        public ushort CreatorBackTraceIndex;
        public ushort ObjectTypeIndex;
        public uint HandleAttributes;
        public uint Reserved;
    }
}
'@

$SystemExtendedHandleInformation = 64
$size = 32MB
$buffer = [IntPtr]::Zero
try {
    while ($true) {
        $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
        $returned = 0
        $status = [HandleQuery]::NtQuerySystemInformation($SystemExtendedHandleInformation, $buffer, $size, [ref]$returned)
        if ($status -eq 0) { break }
        [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
        $buffer = [IntPtr]::Zero
        if ($status -ne -1073741820) { throw "NtQuerySystemInformation 失败: 0x$($status.ToString('X8'))" }
        $size *= 2
        if ($size -gt 1GB) { throw '句柄表超过 1GB，放弃' }
    }

    $count = [Runtime.InteropServices.Marshal]::ReadInt64($buffer)
    "全系统句柄总数: $count"

    $entrySize = [Runtime.InteropServices.Marshal]::SizeOf([type][HandleQuery+HandleEntryEx])
    $base = $buffer.ToInt64() + 16  # NumberOfHandles(8) + Reserved(8)

    # 先统计各 ObjectTypeIndex 的数量，Token 类型索引随版本变化，取最可疑的用数量排序呈现
    $byType = @{}
    $byProcType = @{}
    for ($i = 0; $i -lt $count; $i++) {
        $ptr = [IntPtr]($base + ($i * $entrySize))
        $e = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][HandleQuery+HandleEntryEx])
        $t = [int]$e.ObjectTypeIndex
        $p = [int64]$e.UniqueProcessId
        $byType[$t] = 1 + [int]$byType[$t]
        $key = "$p|$t"
        $byProcType[$key] = 1 + [int]$byProcType[$key]
    }

    ""
    "=== 按对象类型索引统计 Top 10 ==="
    $byType.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 10 |
        ForEach-Object { "  TypeIndex $($_.Key): $($_.Value)" }

    ""
    "=== 句柄最多的进程 Top 15 ==="
    $procNames = @{}
    Get-Process | ForEach-Object { $procNames[[int64]$_.Id] = $_.ProcessName }
    $byProc = @{}
    foreach ($k in $byProcType.Keys) {
        $p = [int64]($k -split '\|')[0]
        $byProc[$p] = [int]$byProc[$p] + $byProcType[$k]
    }
    $byProc.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 15 |
        ForEach-Object {
            $n = if ($procNames.ContainsKey($_.Key)) { $procNames[$_.Key] } else { '?' }
            "  PID $($_.Key) $n : $($_.Value)"
        }
} finally {
    if ($buffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
}
