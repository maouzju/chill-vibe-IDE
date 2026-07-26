// Symbol-free minidump reader.
//
// Enabling crash collection gives every freeze a minidump carrying the native
// stack of the blocked renderer thread — but reading it normally requires
// WinDbg/cdb plus Electron's symbol server, neither of which is present on the
// machines where the freeze actually happens. That gap is why the dumps would
// have gone unread.
//
// Full symbolised unwinding is not needed to make progress. Attributing each
// address on the blocked thread's stack to the module that owns it already
// answers the question every investigation has failed to answer: is the main
// thread stuck inside the GPU driver, inside Chromium, or waiting on the
// kernel? This reader does exactly that, in pure JS, with no external tooling.

const mdmpSignature = 0x504d444d
const moduleListStreamType = 4
const threadListStreamType = 3
const moduleEntrySize = 108
const threadEntrySize = 48
// Offsets inside the x64 CONTEXT record.
const contextRspOffset = 168
const contextRipOffset = 264
const maxStackModules = 24

export type MinidumpModule = {
  name: string
  base: bigint
  size: number
}

export type SuspectedNativeOwner = 'gpu-driver' | 'kernel-wait' | 'chromium' | 'unknown'

export type MinidumpThreadReport = {
  threadId: number
  // "module.dll+0xoffset", or a bare address when it belongs to no known module.
  instructionPointer: string
  stackModules: string[]
  suspectedNativeOwner: SuspectedNativeOwner
}

export type NativeHangMinidumpReport = {
  modules: MinidumpModule[]
  threads: MinidumpThreadReport[]
}

// Graphics drivers and the graphics runtime — a main thread parked in here can
// never be explained by renderer-side JS.
const gpuModulePattern =
  /^(nvoglv|nvd3dum|nvwgf2um|ig[dfx]|amdvlk|atidx|d3d1[01]|dxgi|dxcore|opengl32|vulkan-1|libglesv2|libegl|d3dcompiler)/i
const kernelWaitPattern = /^(ntdll|kernelbase|kernel32|win32u|user32|synchronization)/i
const chromiumPattern = /^(electron|chrome_?(child|elf)?|libcef)/i

const readMinidumpString = (buffer: Buffer, rva: number): string => {
  const byteLength = buffer.readUInt32LE(rva)
  return buffer.toString('utf16le', rva + 4, rva + 4 + byteLength)
}

const baseName = (modulePath: string): string => modulePath.split(/[\\/]/).pop() ?? modulePath

const classifyModule = (name: string): SuspectedNativeOwner => {
  if (gpuModulePattern.test(name)) {
    return 'gpu-driver'
  }
  if (kernelWaitPattern.test(name)) {
    return 'kernel-wait'
  }
  if (chromiumPattern.test(name)) {
    return 'chromium'
  }
  return 'unknown'
}

export const readNativeHangMinidump = (buffer: Buffer): NativeHangMinidumpReport => {
  if (buffer.length < 32 || buffer.readUInt32LE(0) !== mdmpSignature) {
    throw new Error('not a minidump: missing MDMP signature')
  }

  const streamCount = buffer.readUInt32LE(8)
  const directoryRva = buffer.readUInt32LE(12)
  const streams = new Map<number, { size: number; rva: number }>()
  for (let index = 0; index < streamCount; index += 1) {
    const entry = directoryRva + index * 12
    streams.set(buffer.readUInt32LE(entry), {
      size: buffer.readUInt32LE(entry + 4),
      rva: buffer.readUInt32LE(entry + 8),
    })
  }

  const modules: MinidumpModule[] = []
  const moduleList = streams.get(moduleListStreamType)
  if (moduleList) {
    const count = buffer.readUInt32LE(moduleList.rva)
    for (let index = 0; index < count; index += 1) {
      const entry = moduleList.rva + 4 + index * moduleEntrySize
      modules.push({
        base: buffer.readBigUInt64LE(entry),
        size: buffer.readUInt32LE(entry + 8),
        name: baseName(readMinidumpString(buffer, buffer.readUInt32LE(entry + 20))),
      })
    }
  }

  const findModule = (address: bigint): MinidumpModule | undefined =>
    modules.find((entry) => address >= entry.base && address < entry.base + BigInt(entry.size))

  const describe = (address: bigint): string => {
    const owner = findModule(address)
    return owner ? `${owner.name}+0x${(address - owner.base).toString(16)}` : `0x${address.toString(16)}`
  }

  const threads: MinidumpThreadReport[] = []
  const threadList = streams.get(threadListStreamType)
  if (threadList) {
    const count = buffer.readUInt32LE(threadList.rva)
    for (let index = 0; index < count; index += 1) {
      const entry = threadList.rva + 4 + index * threadEntrySize
      const stackStart = buffer.readBigUInt64LE(entry + 24)
      const stackSize = buffer.readUInt32LE(entry + 32)
      const stackRva = buffer.readUInt32LE(entry + 36)
      const contextRva = buffer.readUInt32LE(entry + 44)

      const instructionAddress = buffer.readBigUInt64LE(contextRva + contextRipOffset)
      const stackPointer = buffer.readBigUInt64LE(contextRva + contextRspOffset)

      // Symbol-free stack scanning: every stack slot that lands inside a loaded
      // module is a plausible return address. Consecutive duplicates are folded
      // so a spin loop does not fill the whole chain with one frame.
      const stackModules: string[] = []
      const startOffset = Number(stackPointer - stackStart)
      for (
        let offset = Math.max(0, startOffset);
        offset + 8 <= stackSize && stackModules.length < maxStackModules;
        offset += 8
      ) {
        const candidate = buffer.readBigUInt64LE(stackRva + offset)
        if (!findModule(candidate)) {
          continue
        }
        const label = describe(candidate)
        if (stackModules[stackModules.length - 1] !== label) {
          stackModules.push(label)
        }
      }

      // Blame the instruction pointer first; fall back to the innermost stack
      // frame when the pointer itself belongs to no loaded module.
      const ipModule = findModule(instructionAddress)
      const fallbackName = stackModules[0]?.split('+')[0] ?? ''
      threads.push({
        threadId: buffer.readUInt32LE(entry),
        instructionPointer: describe(instructionAddress),
        stackModules,
        suspectedNativeOwner: ipModule
          ? classifyModule(ipModule.name)
          : classifyModule(fallbackName),
      })
    }
  }

  return { modules, threads }
}
