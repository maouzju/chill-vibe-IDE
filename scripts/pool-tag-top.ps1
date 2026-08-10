# 取证脚本：列出内核分页/非分页池占用最高的 tag。
# 用途：Committed Bytes 远高于所有进程私有内存之和时，差额通常在内核池里；
# poolmon.exe 属于 WDK，本机没有，所以直接走 NtQuerySystemInformation(SystemPoolTagInformation=22)。
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PoolTagQuery {
    [DllImport("ntdll.dll")]
    public static extern int NtQuerySystemInformation(int SystemInformationClass, IntPtr SystemInformation, int SystemInformationLength, out int ReturnLength);

    [StructLayout(LayoutKind.Sequential)]
    public struct PoolTagInfo {
        public uint Tag;
        public uint PagedAllocs;
        public uint PagedFrees;
        public UIntPtr PagedUsed;
        public uint NonPagedAllocs;
        public uint NonPagedFrees;
        public UIntPtr NonPagedUsed;
    }
}
'@

$SystemPoolTagInformation = 22
$size = 1MB
$buffer = [IntPtr]::Zero
try {
    while ($true) {
        $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
        $returned = 0
        $status = [PoolTagQuery]::NtQuerySystemInformation($SystemPoolTagInformation, $buffer, $size, [ref]$returned)
        if ($status -eq 0) { break }
        [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
        $buffer = [IntPtr]::Zero
        # STATUS_INFO_LENGTH_MISMATCH (0xC0000004) -> 扩容重试
        if ($status -ne -1073741820) { throw "NtQuerySystemInformation 失败: 0x$($status.ToString('X8'))" }
        $size *= 4
    }

    $count = [Runtime.InteropServices.Marshal]::ReadInt32($buffer)
    $entrySize = [Runtime.InteropServices.Marshal]::SizeOf([type][PoolTagQuery+PoolTagInfo])
    $rows = @()
    for ($i = 0; $i -lt $count; $i++) {
        $ptr = [IntPtr]($buffer.ToInt64() + [IntPtr]::Size + ($i * $entrySize))
        $e = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][PoolTagQuery+PoolTagInfo])
        $tag = -join (0..3 | ForEach-Object {
            $b = ($e.Tag -shr ($_ * 8)) -band 0xFF
            if ($b -ge 32 -and $b -lt 127) { [char]$b } else { '.' }
        })
        $rows += [pscustomobject]@{
            Tag        = $tag
            PagedMB    = [math]::Round($e.PagedUsed.ToUInt64() / 1MB, 1)
            NonPagedMB = [math]::Round($e.NonPagedUsed.ToUInt64() / 1MB, 1)
            LiveAllocs = [int64]$e.PagedAllocs - [int64]$e.PagedFrees
        }
    }

    "总 tag 数: $count"
    "分页池合计 GB: $([math]::Round((($rows | Measure-Object PagedMB -Sum).Sum) / 1024, 2))"
    "非分页池合计 GB: $([math]::Round((($rows | Measure-Object NonPagedMB -Sum).Sum) / 1024, 2))"
    ""
    "=== 分页池 Top 15 ==="
    $rows | Sort-Object PagedMB -Descending | Select-Object -First 15 | Format-Table -AutoSize
    "=== 非分页池 Top 10 ==="
    $rows | Sort-Object NonPagedMB -Descending | Select-Object -First 10 | Format-Table -AutoSize
} finally {
    if ($buffer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
}
