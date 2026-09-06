/** Private project snapshots, exact change review, and conflict-checked apply. */

import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { TaskCopyReference } from '@deepseek-ai/dsh-task-control'

/** Deployment limits for one project snapshot. */
export interface TaskCopyLimits {
  /** Maximum directory entries visited, including excluded entries. */
  readonly maxEntries: number
  /** Maximum total file bytes retained in one snapshot. */
  readonly maxBytes: number
  /** Directory or file basenames omitted at every depth, in addition to protected names. */
  readonly excludedNames: readonly string[]
}

/** Original file bytes and permissions recorded before execution. */
export interface TaskCopyFile {
  /** Project-relative path using the host's separator. */
  readonly path: string
  /** SHA-256 of the baseline bytes. */
  readonly sha256: string
  /** Original permission bits, excluding special mode bits. */
  readonly mode: number
  /** Baseline byte length. */
  readonly size: number
}

/** Original directory permissions recorded before execution. */
export interface TaskCopyDirectory {
  /** Project-relative path using the host's separator. */
  readonly path: string
  /** Original permission bits, excluding special mode bits. */
  readonly mode: number
}

/** Prepared private directories; callers retain the root until review or discard. */
export interface TaskCopy {
  /** Private root containing workspace, baseline, and manifests. */
  readonly root: string
  /** Writable executor directory, separate from the baseline. */
  readonly workspace: string
  /** Canonical original project location. */
  readonly original: string
  /** SHA-256 of the exact manifest bytes to bind into the durable task record. */
  readonly manifestSha256: string
  /** Immutable baseline file metadata. */
  readonly files: readonly TaskCopyFile[]
  /** Immutable baseline directory metadata. */
  readonly directories: readonly TaskCopyDirectory[]
  /** Project-relative entries deliberately excluded from this snapshot. */
  readonly excluded: readonly string[]
  /** Limits and configured exclusions that govern later change derivation. */
  readonly limits: TaskCopyLimits
}

/** One exact file or directory state displayed before apply. */
export interface TaskChangeSide {
  /** Entry type. */
  readonly type: 'file' | 'directory'
  /** Permission bits, excluding special mode bits. */
  readonly mode: number
  /** Exact UTF-8 contents for a file. */
  readonly text?: string | undefined
  /** SHA-256 of exact file bytes. */
  readonly sha256?: string | undefined
  /** Exact file byte length. */
  readonly size?: number | undefined
}

/** One exact staged project change. */
export interface TaskChange {
  /** Project-relative path. */
  readonly path: string
  /** Operation applied to the original project after approval. */
  readonly kind: 'create' | 'modify' | 'delete'
  /** Baseline state for modifications and deletions. */
  readonly before?: TaskChangeSide | undefined
  /** Staged state for creations and modifications. */
  readonly after?: TaskChangeSide | undefined
}

/** Exact, digest-bound change set returned to the local dashboard. */
export interface TaskChangeSet {
  /** SHA-256 of the exact private change-set manifest bytes. */
  readonly sha256: string
  /** Exact ordered changes. */
  readonly changes: readonly TaskChange[]
}

interface ScannedTree {
  readonly files: ReadonlyMap<string, TaskCopyFile>
  readonly directories: ReadonlyMap<string, TaskCopyDirectory>
}

interface StoredTaskCopy extends Omit<TaskCopy, 'manifestSha256'> {
  readonly version: 2
}

const protectedNames = new Set(['.git', '.pi', '.codex', '.openclaw', '.ssh', '.aws', '.azure', '.npmrc', '.netrc'])
const CHANGE_SET_NAME = 'changes.json'
const MANIFEST_NAME = 'manifest.json'
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024

function contains(root: string, candidate: string): boolean {
  const part = relative(root, candidate)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`))
}

function blockedName(name: string, excludedNames: ReadonlySet<string>): boolean {
  return protectedNames.has(name) || name === '.env' || name.startsWith('.env.') || excludedNames.has(name)
}

/**
 * Snapshot regular project files without following symlinks or sharing file inodes.
 * Linux directory descriptors keep traversal anchored if source names change during copying.
 * Failed snapshots are removed; successful snapshots remain caller-owned.
 * @param source - Existing project directory.
 * @param storageRoot - Private existing directory outside the project and its ancestors.
 * @param limits - Validated deployment limits and basename exclusions.
 * @param signal - Cancellation that removes any partially prepared snapshot.
 * @returns Prepared executor workspace and retained baseline metadata.
 */
export async function prepareTaskCopy(
  source: string,
  storageRoot: string,
  limits: TaskCopyLimits,
  signal?: AbortSignal,
): Promise<TaskCopy> {
  signal?.throwIfAborted()
  /* v8 ignore next -- Linux-only descriptor traversal cannot run on another platform. */
  if (process.platform !== 'linux') throw new Error('task copies require Linux descriptor-relative filesystem access')
  const original = await realpath(source)
  const storage = await realpath(storageRoot)
  if (contains(original, storage) || contains(storage, original)) throw new Error('task storage and project directories must not overlap')
  await requirePrivateDirectory(storage, 'task storage')
  const root = await mkdtemp(join(storage, 'task-'))
  const workspace = join(root, 'workspace')
  const baseline = join(root, 'baseline')
  const files: TaskCopyFile[] = []
  const directories: TaskCopyDirectory[] = []
  const excluded: string[] = []
  let bytes = 0
  let entries = 0
  const excludedNames = new Set(limits.excludedNames)

  const visit = async (directory: FileHandle, prefix: string): Promise<void> => {
    const anchor = `/proc/self/fd/${String(directory.fd)}`
    for (const name of await sortedDirectoryNames(anchor)) {
      signal?.throwIfAborted()
      entries += 1
      if (entries > limits.maxEntries) throw new Error('task copy exceeds its entry limit')
      const path = prefix === '' ? name : join(prefix, name)
      if (blockedName(name, excludedNames)) {
        excluded.push(path)
        continue
      }
      const input = await open(join(anchor, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = await input.stat({ bigint: true })
        if (before.isDirectory()) {
          const mode = Number(before.mode & 0o777n)
          await mkdir(join(workspace, path), { mode: 0o700 })
          await mkdir(join(baseline, path), { mode: 0o700 })
          await visit(input, path)
          await chmod(join(workspace, path), mode)
          await chmod(join(baseline, path), 0o700)
          directories.push({ path, mode })
          continue
        }
        if (!before.isFile()) throw new Error('task copies accept only regular files and directories')
        if (before.size > BigInt(limits.maxBytes - bytes)) throw new Error('task copy exceeds its byte limit')
        const destination = join(workspace, path)
        const output = await open(destination, 'wx', 0o600)
        const hash = createHash('sha256')
        let size = 0
        try {
          for await (const chunk of input.createReadStream({ autoClose: false })) {
            signal?.throwIfAborted()
            const data = chunk as Buffer
            bytes += data.length
            size += data.length
            /* v8 ignore next -- The pre-read size check covers stable files; this catches concurrent growth. */
            if (bytes > limits.maxBytes) throw new Error('task copy exceeds its byte limit')
            hash.update(data)
            await output.writeFile(data)
          }
        } finally {
          await output.close()
        }
        const after = await input.stat({ bigint: true })
        /* v8 ignore next 3 -- Requires a concurrent source mutation during one descriptor-anchored read. */
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
          throw new Error('project file changed while preparing its task copy')
        }
        const mode = Number(before.mode & 0o777n)
        await copyFile(destination, join(baseline, path), constants.COPYFILE_EXCL)
        await chmod(join(baseline, path), 0o400)
        await chmod(destination, mode)
        files.push({ path, sha256: hash.digest('hex'), mode, size })
      } finally {
        await input.close()
      }
    }
  }

  try {
    await mkdir(workspace, { mode: 0o700 })
    await mkdir(baseline, { mode: 0o700 })
    const directory = await open(original, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await visit(directory, '')
    } finally {
      await directory.close()
    }
    signal?.throwIfAborted()
    files.sort(comparePath)
    directories.sort(comparePath)
    excluded.sort()
    const stored: StoredTaskCopy = { version: 2, root, workspace, original, files, directories, excluded, limits }
    const manifest = encode(stored)
    await writeFile(join(root, MANIFEST_NAME), manifest, { mode: 0o400, flag: 'wx' })
    return { ...stored, manifestSha256: sha256(manifest) }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

/**
 * Derive and retain the exact bounded UTF-8 changes produced by a stopped executor.
 * Binary changes, protected names, special files, and review data over the configured bound reject.
 * @param copy - Prepared snapshot retained for the task.
 * @param reviewLimitBytes - Maximum combined before/after bytes exposed for review.
 * @returns Digest-bound exact change set.
 */
export async function createTaskChangeSet(copy: TaskCopy, reviewLimitBytes: number): Promise<TaskChangeSet> {
  const derived = await deriveTaskChangeSet(copy, reviewLimitBytes)
  await writeFile(join(copy.root, CHANGE_SET_NAME), derived.bytes, { mode: 0o400, flag: 'wx' })
  return { sha256: sha256(derived.bytes), changes: derived.changes }
}

/**
 * Read a retained exact change set and prove the baseline manifest and staged workspace still match it.
 * @param reference - Durable snapshot and change-set fingerprints.
 * @param storageRoot - Configured private task-copy root.
 * @param reviewLimitBytes - Maximum combined review bytes accepted by this deployment.
 * @returns Verified exact changes for dashboard display or apply.
 */
export async function readTaskChangeSet(
  reference: TaskCopyReference,
  storageRoot: string,
  reviewLimitBytes: number,
): Promise<TaskChangeSet> {
  const expected = reference.changes?.sha256
  if (expected === undefined) throw new Error('task has no staged changes to review')
  const copy = await loadTaskCopy(reference, storageRoot)
  const retained = await readBounded(join(copy.root, CHANGE_SET_NAME), reviewManifestLimit(reviewLimitBytes, copy.limits.maxEntries))
  if (sha256(retained) !== expected) throw new Error('retained task changes do not match the durable digest')
  const derived = await deriveTaskChangeSet(copy, reviewLimitBytes)
  if (!retained.equals(derived.bytes)) throw new Error('staged task workspace changed after review data was recorded')
  return { sha256: expected, changes: derived.changes }
}

/**
 * Apply one verified change set to its canonical original project.
 * Every affected baseline entry must still match before any project mutation; conflicts reject.
 * Best-effort rollback restores already changed entries when a later operation fails.
 * @param reference - Durable snapshot and exact change-set fingerprints.
 * @param storageRoot - Configured private task-copy root.
 * @param reviewLimitBytes - Maximum combined review bytes accepted by this deployment.
 * @returns Warning when project changes succeeded but obsolete backup cleanup failed.
 */
export async function applyTaskChangeSet(
  reference: TaskCopyReference,
  storageRoot: string,
  reviewLimitBytes: number,
): Promise<string | undefined> {
  const set = await readTaskChangeSet(reference, storageRoot, reviewLimitBytes)
  await validateOriginal(reference.original, set.changes)
  const applied: AppliedChange[] = []
  try {
    for (const change of orderedForApply(set.changes)) {
      await applyChange(reference.original, change, applied)
    }
  } catch (error) {
    const rollbackFailures: unknown[] = []
    for (const operation of [...applied].reverse()) {
      try {
        await rollbackChange(operation)
      /* v8 ignore next 3 -- Requires an external filesystem mutation during synchronous rollback. */
      } catch (rollbackError) {
        /* v8 ignore next -- See concurrent rollback mutation rationale above. */
        rollbackFailures.push(rollbackError)
      }
    }
    /* v8 ignore next -- See guarded rollback failure above. */
    if (rollbackFailures.length > 0) throw new AggregateError([error, ...rollbackFailures], 'project apply and rollback both failed')
    throw error
  }
  const cleanup = await Promise.allSettled(applied.flatMap(operation => operation.backup === undefined ? [] : [unlink(operation.backup)]))
  const failures = cleanup.filter(result => result.status === 'rejected')
  /* v8 ignore next -- Backup unlink failure requires an external permission or mount change during apply. */
  return failures.length === 0 ? undefined : `exact changes applied; ${String(failures.length)} obsolete backup file(s) could not be removed`
}

interface DerivedChangeSet {
  readonly bytes: Buffer
  readonly changes: readonly TaskChange[]
}

async function deriveTaskChangeSet(copy: TaskCopy, reviewLimitBytes: number): Promise<DerivedChangeSet> {
  const blocked = new Set(copy.limits.excludedNames)
  const current = await scanTree(copy.workspace, copy.limits, blocked)
  const baselineFiles = new Map(copy.files.map(file => [file.path, file]))
  const baselineDirectories = new Map(copy.directories.map(directory => [directory.path, directory]))
  const paths = new Set([...baselineDirectories.keys(), ...current.directories.keys(), ...baselineFiles.keys(), ...current.files.keys()])
  const changes: TaskChange[] = []
  let reviewBytes = 0

  for (const path of [...paths].sort()) {
    const beforeDirectory = baselineDirectories.get(path)
    const afterDirectory = current.directories.get(path)
    const beforeFile = baselineFiles.get(path)
    const afterFile = current.files.get(path)
    const before = beforeFile ?? beforeDirectory
    const after = afterFile ?? afterDirectory
    if ((beforeDirectory !== undefined && afterFile !== undefined) || (beforeFile !== undefined && afterDirectory !== undefined)) {
      throw new Error(`task change '${path}' changes entry type and cannot be applied safely`)
    }
    if (beforeDirectory !== undefined && afterDirectory !== undefined && beforeDirectory.mode === afterDirectory.mode) continue
    if (beforeFile !== undefined && afterFile !== undefined
      && beforeFile.sha256 === afterFile.sha256 && beforeFile.mode === afterFile.mode) continue

    const beforeSide = before === undefined ? undefined : await side(copy, 'baseline', before, beforeFile !== undefined, reviewLimitBytes - reviewBytes)
    reviewBytes += beforeSide?.size ?? 0
    const afterSide = after === undefined ? undefined : await side(copy, 'workspace', after, afterFile !== undefined, reviewLimitBytes - reviewBytes)
    reviewBytes += afterSide?.size ?? 0
    changes.push({
      path,
      kind: before === undefined ? 'create' : after === undefined ? 'delete' : 'modify',
      ...(beforeSide === undefined ? {} : { before: beforeSide }),
      ...(afterSide === undefined ? {} : { after: afterSide }),
    })
  }
  const stored = { version: 1, baselineSha256: copy.manifestSha256, changes }
  return { bytes: encode(stored), changes }
}

async function side(
  copy: TaskCopy,
  tree: 'baseline' | 'workspace',
  entry: TaskCopyFile | TaskCopyDirectory,
  file: boolean,
  remainingBytes: number,
): Promise<TaskChangeSide> {
  if (!file) return { type: 'directory', mode: entry.mode }
  const value = entry as TaskCopyFile
  if (value.size > remainingBytes) throw new Error('task changes exceed the exact-review byte limit')
  const bytes = await readFile(join(copy.root, tree, value.path))
  if (bytes.length !== value.size || sha256(bytes) !== value.sha256) throw new Error(`task ${tree} file '${value.path}' changed during review`)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error(`task change '${value.path}' is not UTF-8 text and cannot be reviewed exactly`)
  }
  if (text.includes('\0')) throw new Error(`task change '${value.path}' contains NUL and cannot be reviewed exactly`)
  return { type: 'file', mode: value.mode, text, sha256: value.sha256, size: value.size }
}

async function sortedDirectoryNames(anchor: string): Promise<string[]> {
  const names: string[] = []
  for await (const entry of await opendir(anchor)) names.push(entry.name)
  return names.sort()
}

async function scanTree(root: string, limits: TaskCopyLimits, excludedNames: ReadonlySet<string>): Promise<ScannedTree> {
  const files = new Map<string, TaskCopyFile>()
  const directories = new Map<string, TaskCopyDirectory>()
  let entries = 0
  let bytes = 0
  const visit = async (directory: FileHandle, prefix: string): Promise<void> => {
    const anchor = `/proc/self/fd/${String(directory.fd)}`
    for (const name of await sortedDirectoryNames(anchor)) {
      entries += 1
      if (entries > limits.maxEntries) throw new Error('staged task workspace exceeds its entry limit')
      const path = prefix === '' ? name : join(prefix, name)
      if (blockedName(name, excludedNames)) throw new Error(`staged task workspace contains protected path '${path}'`)
      const input = await open(join(anchor, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const before = await input.stat({ bigint: true })
        const mode = Number(before.mode & 0o777n)
        if (before.isDirectory()) {
          directories.set(path, { path, mode })
          await visit(input, path)
          continue
        }
        if (!before.isFile()) throw new Error(`staged task workspace contains unsupported entry '${path}'`)
        if (before.size > BigInt(limits.maxBytes - bytes)) throw new Error('staged task workspace exceeds its byte limit')
        const hash = createHash('sha256')
        let size = 0
        for await (const chunk of input.createReadStream({ autoClose: false })) {
          const data = chunk as Buffer
          bytes += data.length
          size += data.length
          /* v8 ignore next -- The pre-read size check covers stable files; this catches concurrent growth. */
          if (bytes > limits.maxBytes) throw new Error('staged task workspace exceeds its byte limit')
          hash.update(data)
        }
        const after = await input.stat({ bigint: true })
        /* v8 ignore next 3 -- Requires a concurrent staged-file mutation during one descriptor-anchored read. */
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
          throw new Error(`staged task file '${path}' changed during review`)
        }
        files.set(path, { path, mode, size, sha256: hash.digest('hex') })
      } finally {
        await input.close()
      }
    }
  }
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await visit(directory, '')
  } finally {
    await directory.close()
  }
  return { files, directories }
}

async function loadTaskCopy(reference: TaskCopyReference, storageRoot: string): Promise<TaskCopy> {
  const storage = await realpath(storageRoot)
  await requirePrivateDirectory(storage, 'task storage')
  const root = await realpath(reference.root)
  if (dirname(root) !== storage || root !== reference.root) throw new Error('task copy is outside configured private storage')
  await requirePrivateDirectory(root, 'task copy')
  const manifest = await readBounded(join(root, MANIFEST_NAME), MAX_MANIFEST_BYTES)
  if (sha256(manifest) !== reference.manifestSha256) throw new Error('task copy manifest does not match the durable digest')
  const parsed = parseTaskCopy(manifest)
  if (parsed.root !== root || parsed.workspace !== join(root, 'workspace') || parsed.original !== reference.original) {
    throw new Error('task copy manifest does not match its durable location')
  }
  return { ...parsed, manifestSha256: reference.manifestSha256 }
}

function parseTaskCopy(bytes: Buffer): StoredTaskCopy {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    throw new Error('task copy manifest is invalid JSON')
  }
  const root = record(value)
  if (root.version !== 2 || typeof root.root !== 'string' || typeof root.workspace !== 'string' || typeof root.original !== 'string') {
    throw new Error('task copy manifest is invalid')
  }
  const limits = record(root.limits)
  if (!positiveInteger(limits.maxEntries) || !positiveInteger(limits.maxBytes) || !stringList(limits.excludedNames)) {
    throw new Error('task copy manifest limits are invalid')
  }
  if (!Array.isArray(root.files) || !Array.isArray(root.directories) || !stringList(root.excluded)) {
    throw new Error('task copy manifest entries are invalid')
  }
  const files = root.files.map(parseFile)
  const directories = root.directories.map(parseDirectory)
  requireUniquePaths([...files, ...directories])
  return {
    version: 2,
    root: root.root,
    workspace: root.workspace,
    original: root.original,
    files,
    directories,
    excluded: root.excluded,
    limits: { maxEntries: limits.maxEntries, maxBytes: limits.maxBytes, excludedNames: limits.excludedNames },
  }
}

function parseFile(value: unknown): TaskCopyFile {
  const item = record(value)
  if (!safeRelativePath(item.path) || !integerMode(item.mode) || !nonnegativeInteger(item.size)
    || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) {
    throw new Error('task copy file entry is invalid')
  }
  return { path: item.path, mode: item.mode, size: item.size, sha256: item.sha256 }
}

function parseDirectory(value: unknown): TaskCopyDirectory {
  const item = record(value)
  if (!safeRelativePath(item.path) || !integerMode(item.mode)) throw new Error('task copy directory entry is invalid')
  return { path: item.path, mode: item.mode }
}

function safeRelativePath(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && !isAbsolute(value)
    && value !== '..' && !value.startsWith(`..${sep}`) && !value.split(sep).includes('')
}

function requireUniquePaths(entries: readonly { readonly path: string }[]): void {
  const paths = new Set<string>()
  for (const entry of entries) {
    if (paths.has(entry.path)) throw new Error(`task copy manifest repeats path '${entry.path}'`)
    paths.add(entry.path)
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('task copy manifest is invalid')
  return value as Record<string, unknown>
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function integerMode(value: unknown): value is number {
  return nonnegativeInteger(value) && value <= 0o777
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

interface AppliedChange {
  readonly root: string
  readonly change: TaskChange
  readonly target: string
  backup?: string
  created?: boolean
  priorMode?: number
}

function orderedForApply(changes: readonly TaskChange[]): readonly TaskChange[] {
  const rank = (change: TaskChange): number => {
    if (change.after?.type === 'directory' && change.kind === 'create') return 0
    if (change.after?.type === 'file') return 1
    if (change.kind === 'delete' && change.before?.type === 'file') return 2
    if (change.after?.type === 'directory') return 3
    return 4
  }
  return [...changes].sort((left, right) => {
    const rankDifference = rank(left) - rank(right)
    if (rankDifference !== 0) return rankDifference
    const depthDifference = rank(left) === 4
      ? right.path.split(sep).length - left.path.split(sep).length
      : left.path.split(sep).length - right.path.split(sep).length
    if (depthDifference !== 0) return depthDifference
    return left.path.localeCompare(right.path)
  })
}

async function validateOriginal(root: string, changes: readonly TaskChange[]): Promise<void> {
  if (await realpath(root) !== root) throw new Error('registered project path no longer resolves to its approved location')
  for (const change of changes) await requireCurrent(root, change.path, change.before)
}

async function requireCurrent(root: string, path: string, expected: TaskChangeSide | undefined): Promise<void> {
  if (expected !== undefined) await requireExistingParents(root, dirname(path))
  const target = join(root, path)
  let status
  try {
    status = await lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && expected === undefined) return
    throw new Error(`project path '${path}' changed after task preparation`, { cause: error })
  }
  if (expected === undefined) throw new Error(`project path '${path}' was created after task preparation`)
  if (status.isSymbolicLink() || (expected.type === 'file' ? !status.isFile() : !status.isDirectory())) {
    throw new Error(`project path '${path}' changed type after task preparation`)
  }
  const mode = status.mode & 0o777
  if (mode !== expected.mode) throw new Error(`project path '${path}' permissions changed after task preparation`)
  if (expected.type === 'file') {
    if (status.nlink !== 1) throw new Error(`project path '${path}' has multiple hard links and cannot be replaced safely`)
    const bytes = await readFile(target)
    if (bytes.length !== expected.size || sha256(bytes) !== expected.sha256) {
      throw new Error(`project file '${path}' changed after task preparation`)
    }
  }
}

async function applyChange(root: string, change: TaskChange, applied: AppliedChange[]): Promise<void> {
  await requireCurrent(root, change.path, change.before)
  const target = join(root, change.path)
  const operation: AppliedChange = { root, change, target }
  const after = change.after
  if (after?.type === 'directory') {
    if (change.kind === 'create') {
      await requireExistingParents(root, dirname(change.path))
      await mkdir(target, { mode: after.mode })
      await chmod(target, after.mode)
      operation.created = true
    } else {
      /* v8 ignore next -- Derived directory modifications always carry their directory baseline. */
      if (change.before?.type !== 'directory') throw new Error(`task directory change '${change.path}' has no directory baseline`)
      operation.priorMode = change.before.mode
      await chmod(target, after.mode)
    }
    applied.push(operation)
    return
  }
  if (after?.type === 'file') {
    await requireExistingParents(root, dirname(change.path))
    const temporary = join(dirname(target), `.dsh-command-center-${randomBytes(12).toString('hex')}`)
    await writeFile(temporary, after.text as string, { mode: 0o600, flag: 'wx' })
    await chmod(temporary, after.mode)
    try {
      if (change.kind === 'create') {
        await linkNoReplace(temporary, target)
        operation.created = true
        applied.push(operation)
      } else {
        const backup = join(root, `.dsh-command-center-backup-${randomBytes(12).toString('hex')}`)
        await rename(target, backup)
        operation.backup = backup
        applied.push(operation)
        await requireCurrent(root, relative(root, backup), change.before)
        await linkNoReplace(temporary, target)
      }
    } finally {
      await rm(temporary, { force: true })
    }
    return
  }
  if (change.before?.type === 'file') {
    const backup = join(root, `.dsh-command-center-backup-${randomBytes(12).toString('hex')}`)
    await rename(target, backup)
    operation.backup = backup
    applied.push(operation)
    await requireCurrent(root, relative(root, backup), change.before)
    return
  }
  /* v8 ignore else -- A locally derived deletion without a file baseline has a directory baseline. */
  if (change.before?.type === 'directory') {
    await rmdir(target)
    operation.created = false
    applied.push(operation)
    return
  }
  /* v8 ignore next -- Exact changes are derived locally with at least one side. */
  throw new Error(`task change '${change.path}' has no before or after state`)
}

async function linkNoReplace(source: string, target: string): Promise<void> {
  try {
    await lstat(target)
    /* v8 ignore next -- Requires an external path creation after the preceding validation. */
    throw new Error(`project path '${target}' appeared during apply`)
  } catch (error) {
    /* v8 ignore next -- Non-ENOENT failures require an external path mutation after validation. */
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await link(source, target)
}

async function rollbackChange(operation: AppliedChange): Promise<void> {
  const { change, root, target } = operation
  if (change.after?.type === 'directory') {
    if (operation.created === true) await rmdir(target)
    else await chmod(target, operation.priorMode as number)
    return
  }
  if (change.after?.type === 'file' && !await missing(target)) {
    await requireCurrent(root, change.path, change.after)
    await unlink(target)
  }
  if (operation.backup !== undefined) {
    /* v8 ignore next -- Requires an external path creation during synchronous rollback. */
    if (!await missing(target)) throw new Error(`cannot restore '${change.path}' because another entry occupies it`)
    await rename(operation.backup, target)
    return
  }
  if (change.before?.type === 'directory' && change.after === undefined) {
    await mkdir(target, { mode: change.before.mode })
    await chmod(target, change.before.mode)
  }
}

async function requireExistingParents(root: string, relativeDirectory: string): Promise<void> {
  if (relativeDirectory === '.' || relativeDirectory === '') return
  let current = root
  for (const part of relativeDirectory.split(sep)) {
    current = join(current, part)
    const status = await lstat(current)
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`project parent '${relative(root, current)}' is not a real directory`)
  }
}

async function requirePrivateDirectory(path: string, subject: string): Promise<void> {
  const status = await lstat(path)
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0 || status.uid !== process.getuid?.()) {
    throw new Error(`${subject} must be a private owner-only directory`)
  }
}

async function readBounded(path: string, maxBytes: number): Promise<Buffer> {
  const status = await lstat(path)
  if (!status.isFile() || status.isSymbolicLink() || status.size > maxBytes) throw new Error(`private task file '${path}' is invalid or oversized`)
  return await readFile(path)
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    /* v8 ignore else -- Callers pass validated paths; other lstat failures require an external change. */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    /* v8 ignore next -- See guarded lstat branch above. */
    throw error
  }
}

function reviewManifestLimit(reviewLimitBytes: number, maxEntries: number): number {
  return Math.min(MAX_MANIFEST_BYTES, reviewLimitBytes * 2 + maxEntries * 1024)
}

function comparePath(left: { readonly path: string }, right: { readonly path: string }): number {
  return left.path.localeCompare(right.path)
}

function encode(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`)
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
