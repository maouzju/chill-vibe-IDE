import assert from 'node:assert/strict'
import test from 'node:test'

import { readNativeHangMinidump } from '../electron/minidump-reader'

// The freeze reports have always stalled at the same wall: the renderer's main
// thread is blocked outside JS, and reading the resulting minidump requires
// WinDbg/cdb, which is not installed on this machine. So the dump existed (once
// crash collection was enabled) but still answered nothing.
//
// Full symbolised unwinding needs a symbol server. Module attribution does not:
// mapping each address on the blocked thread's stack back to the module that
// owns it already separates "stuck inside the GPU driver" from "stuck inside
// Chromium" from "waiting on a kernel call" — which is exactly the fork every
// investigation has failed to take. These tests pin that reader against a
// synthetic dump so it needs no fixture binary.

const mdmpSignature = 0x504d444d
const moduleListStream = 4
const threadListStream = 3

// Build a minimal but structurally real x64 minidump.
const buildSyntheticMinidump = () => {
  const chunks: Buffer[] = []
  let cursor = 0
  const append = (buffer: Buffer) => {
    const rva = cursor
    chunks.push(buffer)
    cursor += buffer.length
    return rva
  }
  const appendString = (value: string) => {
    const encoded = Buffer.from(value, 'utf16le')
    const buffer = Buffer.alloc(4 + encoded.length + 2)
    buffer.writeUInt32LE(encoded.length, 0)
    encoded.copy(buffer, 4)
    return append(buffer)
  }

  const header = Buffer.alloc(32)
  header.writeUInt32LE(mdmpSignature, 0)
  header.writeUInt32LE(2, 8)
  append(header)

  const directory = Buffer.alloc(24)
  const directoryRva = 32
  header.writeUInt32LE(directoryRva, 12)
  append(directory)

  const electronName = appendString('C:\\app\\electron.exe')
  const driverName = appendString('C:\\Windows\\System32\\nvoglv64.dll')

  const electronBase = 0x140000000n
  const driverBase = 0x7ff800000000n

  const moduleList = Buffer.alloc(4 + 108 * 2)
  moduleList.writeUInt32LE(2, 0)
  moduleList.writeBigUInt64LE(electronBase, 4)
  moduleList.writeUInt32LE(0x1000000, 12)
  moduleList.writeUInt32LE(electronName, 24)
  moduleList.writeBigUInt64LE(driverBase, 112)
  moduleList.writeUInt32LE(0x200000, 120)
  moduleList.writeUInt32LE(driverName, 132)
  const moduleListRva = append(moduleList)

  // Stack memory: two plausible return addresses among noise.
  const stackStart = 0x1000n
  const stack = Buffer.alloc(64)
  stack.writeBigUInt64LE(electronBase + 0x500n, 8)
  stack.writeBigUInt64LE(driverBase + 0x900n, 24)
  const stackRva = append(stack)

  // Windows x64 CONTEXT: RSP is at 152 and RIP is at 248. A 16-byte
  // offset error makes every real dump report zero/native noise instead of
  // the renderer thread that actually froze.
  const context = Buffer.alloc(1232)
  context.writeBigUInt64LE(stackStart, 152)
  context.writeBigUInt64LE(driverBase + 0x1234n, 248)
  const contextRva = append(context)

  const threadList = Buffer.alloc(4 + 48)
  threadList.writeUInt32LE(1, 0)
  threadList.writeUInt32LE(4321, 4)
  threadList.writeBigUInt64LE(stackStart, 28)
  threadList.writeUInt32LE(stack.length, 36)
  threadList.writeUInt32LE(stackRva, 40)
  threadList.writeUInt32LE(contextRva, 48)
  const threadListRva = append(threadList)

  header.writeUInt32LE(2, 8)
  directory.writeUInt32LE(moduleListStream, 0)
  directory.writeUInt32LE(moduleList.length, 4)
  directory.writeUInt32LE(moduleListRva, 8)
  directory.writeUInt32LE(threadListStream, 12)
  directory.writeUInt32LE(threadList.length, 16)
  directory.writeUInt32LE(threadListRva, 20)

  return Buffer.concat(chunks)
}

test('a minidump yields the loaded modules', () => {
  const report = readNativeHangMinidump(buildSyntheticMinidump())
  assert.equal(report.modules.length, 2)
  assert.deepEqual(
    report.modules.map((entry) => entry.name),
    ['electron.exe', 'nvoglv64.dll'],
  )
})

test('the blocked instruction pointer is attributed to its owning module', () => {
  const report = readNativeHangMinidump(buildSyntheticMinidump())
  const [thread] = report.threads
  assert.equal(thread.threadId, 4321)
  // This single line is the answer every freeze report has been missing.
  assert.equal(thread.instructionPointer, 'nvoglv64.dll+0x1234')
})

test('stack scanning recovers the module chain without symbols', () => {
  const report = readNativeHangMinidump(buildSyntheticMinidump())
  assert.deepEqual(report.threads[0].stackModules, [
    'electron.exe+0x500',
    'nvoglv64.dll+0x900',
  ])
})

test('a thread stuck in a graphics driver is flagged as a native GPU hang', () => {
  const report = readNativeHangMinidump(buildSyntheticMinidump())
  assert.equal(report.threads[0].suspectedNativeOwner, 'gpu-driver')
})

test('a non-minidump buffer is rejected rather than silently misparsed', () => {
  assert.throws(() => readNativeHangMinidump(Buffer.from('not a dump at all')), /minidump/i)
})
