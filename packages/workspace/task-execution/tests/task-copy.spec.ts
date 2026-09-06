import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyTaskChangeSet,
  createTaskChangeSet,
  prepareTaskCopy,
  readTaskChangeSet,
  type TaskChangeSet,
  type TaskCopy,
  type TaskCopyLimits,
} from '../src/task-copy.ts'

const roots: string[] = []
const limits: TaskCopyLimits = { maxEntries: 100, maxBytes: 1_000_000, excludedNames: ['node_modules'] }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-task-copy-'))
  roots.push(root)
  const source = join(root, 'project')
  const storage = join(root, 'private')
  await mkdir(source)
  await mkdir(storage, { mode: 0o700 })
  return { root, source, storage }
}

function reference(copy: TaskCopy, changes: TaskChangeSet) {
  return {
    root: copy.root,
    original: copy.original,
    manifestSha256: copy.manifestSha256,
    changes: { sha256: changes.sha256, count: changes.changes.length, state: 'pending-review' as const },
  }
}

async function replaceManifest(copy: TaskCopy, value: unknown) {
  const bytes = Buffer.from(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
  await chmod(join(copy.root, 'manifest.json'), 0o600)
  await writeFile(join(copy.root, 'manifest.json'), bytes)
  return { ...copy, manifestSha256: createHash('sha256').update(bytes).digest('hex') }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe.skipIf(process.platform !== 'linux')('task copy preparation', () => {
  it('retains binary baseline bytes and modes independently from executor edits', async () => {
    const { source, storage } = await fixture()
    await mkdir(join(source, 'src'))
    const bytes = Buffer.from([0, 255, 1, 128])
    await writeFile(join(source, 'src', 'binary'), bytes)
    await chmod(join(source, 'src', 'binary'), 0o751)
    const copy = await prepareTaskCopy(source, storage, limits)
    expect(copy.files).toEqual([{
      path: 'src/binary', size: bytes.length, mode: 0o751,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }])
    expect((await stat(copy.root)).mode & 0o777).toBe(0o700)
    expect((await stat(join(copy.root, 'baseline/src/binary'))).mode & 0o777).toBe(0o400)
    await writeFile(join(copy.workspace, 'src/binary'), 'changed')
    expect(await readFile(join(source, 'src/binary'))).toEqual(bytes)
    expect(await readFile(join(copy.root, 'baseline/src/binary'))).toEqual(bytes)
    const manifest = await readFile(join(copy.root, 'manifest.json'), 'utf8')
    expect(JSON.parse(manifest)).toMatchObject({ version: 2, original: source, files: copy.files })
    expect(copy.manifestSha256).toBe(createHash('sha256').update(manifest).digest('hex'))
  })

  it('does not share hard-linked source inodes with either private copy', async () => {
    const { root, source, storage } = await fixture()
    const outside = join(root, 'outside')
    await writeFile(outside, 'unchanged')
    await link(outside, join(source, 'linked'))
    const copy = await prepareTaskCopy(source, storage, limits)
    await writeFile(join(copy.workspace, 'linked'), 'edited')
    expect(await readFile(outside, 'utf8')).toBe('unchanged')
    expect((await stat(join(copy.workspace, 'linked'))).ino).not.toBe((await stat(outside)).ino)
    expect((await stat(join(copy.root, 'baseline/linked'))).ino).not.toBe((await stat(outside)).ino)
  })

  it('omits credential/configuration entries and records each omission', async () => {
    const { source, storage } = await fixture()
    for (const name of ['.env', '.env.local', '.npmrc']) await writeFile(join(source, name), 'secret')
    for (const name of ['.git', '.pi', '.codex', '.openclaw', 'node_modules']) {
      await mkdir(join(source, name))
      await writeFile(join(source, name, 'credential'), 'secret')
    }
    const copy = await prepareTaskCopy(source, storage, limits)
    expect(copy.files).toEqual([])
    expect(copy.excluded).toEqual(['.codex', '.env', '.env.local', '.git', '.npmrc', '.openclaw', '.pi', 'node_modules'])
    expect(await readdir(copy.workspace)).toEqual([])
  })

  it.each(['file', 'directory'])('rejects a %s symlink and removes the partial snapshot', async (kind) => {
    const { root, source, storage } = await fixture()
    const target = join(root, 'outside')
    if (kind === 'directory') await mkdir(target)
    else await writeFile(target, 'private')
    await symlink(target, join(source, 'linked'))
    await expect(prepareTaskCopy(source, storage, limits)).rejects.toMatchObject({ code: 'ELOOP' })
    expect(await readdir(storage)).toEqual([])
  })

  it('rejects FIFOs without waiting for a writer', async () => {
    const { source, storage } = await fixture()
    execFileSync('mkfifo', [join(source, 'fifo')])
    await expect(prepareTaskCopy(source, storage, limits)).rejects.toThrow('only regular files')
    expect(await readdir(storage)).toEqual([])
  })

  it.each(['bytes', 'entries'])('enforces the %s budget and removes the partial snapshot', async (budget) => {
    const { source, storage } = await fixture()
    await writeFile(join(source, 'file'), 'oversized')
    await expect(prepareTaskCopy(source, storage, {
      ...limits, ...(budget === 'bytes' ? { maxBytes: 2 } : { maxEntries: 0 }),
    })).rejects.toThrow('limit')
    expect(await readdir(storage)).toEqual([])
  })

  it('counts excluded entries toward the manifest budget', async () => {
    const { source, storage } = await fixture()
    await writeFile(join(source, '.env'), 'secret')
    await expect(prepareTaskCopy(source, storage, { ...limits, maxEntries: 0 })).rejects.toThrow('entry limit')
    expect(await readdir(storage)).toEqual([])
  })

  it('rejects overlapping project and storage roots in both directions', async () => {
    const { source, storage } = await fixture()
    const nested = join(source, 'private')
    await mkdir(nested, { mode: 0o700 })
    await expect(prepareTaskCopy(source, nested, limits)).rejects.toThrow('must not overlap')
    const nestedProject = join(storage, 'project')
    await mkdir(nestedProject)
    await expect(prepareTaskCopy(nestedProject, storage, limits)).rejects.toThrow('must not overlap')
    await expect(prepareTaskCopy(source, source, limits)).rejects.toThrow('must not overlap')
  })

  it('rejects storage readable by other users', async () => {
    const { source, storage } = await fixture()
    await chmod(storage, 0o755)
    await expect(prepareTaskCopy(source, storage, limits)).rejects.toThrow('private owner-only')
  })

  it('removes an aborted snapshot before returning', async () => {
    const { source, storage } = await fixture()
    await writeFile(join(source, 'file'), 'data')
    const controller = new AbortController()
    const pending = prepareTaskCopy(source, storage, limits, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(await readdir(storage)).toEqual([])
    await expect(prepareTaskCopy(source, storage, limits, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('binds exact text changes and applies them only to an unchanged original', async () => {
    const { source, storage } = await fixture()
    await mkdir(join(source, 'old'))
    await writeFile(join(source, 'keep'), 'before\n')
    await writeFile(join(source, 'old/remove'), 'remove\n')
    const copy = await prepareTaskCopy(source, storage, limits)
    await writeFile(join(copy.workspace, 'keep'), 'after\n')
    await rm(join(copy.workspace, 'old/remove'))
    await rmdir(join(copy.workspace, 'old'))
    await mkdir(join(copy.workspace, 'new'))
    await writeFile(join(copy.workspace, 'new/create'), 'created\n')

    const changes = await createTaskChangeSet(copy, 10_000)
    expect(changes.changes.map(change => [change.path, change.kind, change.before?.type, change.after?.type])).toEqual([
      ['keep', 'modify', 'file', 'file'],
      ['new', 'create', undefined, 'directory'],
      ['new/create', 'create', undefined, 'file'],
      ['old', 'delete', 'directory', undefined],
      ['old/remove', 'delete', 'file', undefined],
    ])
    const reference = {
      root: copy.root,
      original: copy.original,
      manifestSha256: copy.manifestSha256,
      changes: { sha256: changes.sha256, count: changes.changes.length, state: 'pending-review' as const },
    }
    await expect(readTaskChangeSet(reference, storage, 10_000)).resolves.toEqual(changes)
    await applyTaskChangeSet(reference, storage, 10_000)
    expect(await readFile(join(source, 'keep'), 'utf8')).toBe('after\n')
    expect(await readFile(join(source, 'new/create'), 'utf8')).toBe('created\n')
    await expect(stat(join(source, 'old'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves conflicting original content and rejects unreviewable staged entries', async () => {
    const { source, storage } = await fixture()
    await writeFile(join(source, 'file'), 'baseline')
    const copy = await prepareTaskCopy(source, storage, limits)
    await writeFile(join(copy.workspace, 'file'), 'staged')
    const changes = await createTaskChangeSet(copy, 100)
    const reference = {
      root: copy.root,
      original: copy.original,
      manifestSha256: copy.manifestSha256,
      changes: { sha256: changes.sha256, count: 1, state: 'pending-review' as const },
    }
    await writeFile(join(source, 'file'), 'user edit')
    await expect(applyTaskChangeSet(reference, storage, 100)).rejects.toThrow('changed after task preparation')
    expect(await readFile(join(source, 'file'), 'utf8')).toBe('user edit')

    await writeFile(join(copy.workspace, 'file'), Buffer.from([0xff]))
    await expect(createTaskChangeSet(copy, 100)).rejects.toThrow('not UTF-8')
  })

  it('rejects missing, replaced, and stale retained review data', async () => {
    const { source, storage } = await fixture()
    await writeFile(join(source, 'file'), 'before')
    const copy = await prepareTaskCopy(source, storage, limits)
    await expect(readTaskChangeSet({
      root: copy.root, original: copy.original, manifestSha256: copy.manifestSha256,
    }, storage, 100)).rejects.toThrow('no staged changes')
    await writeFile(join(copy.workspace, 'file'), 'after')
    const changes = await createTaskChangeSet(copy, 100)
    const retainedPath = join(copy.root, 'changes.json')
    const retained = await readFile(retainedPath)
    await chmod(retainedPath, 0o600)
    await writeFile(retainedPath, '{}')
    await expect(readTaskChangeSet(reference(copy, changes), storage, 100)).rejects.toThrow('durable digest')
    await writeFile(retainedPath, retained)
    await writeFile(join(copy.workspace, 'file'), 'later')
    await expect(readTaskChangeSet(reference(copy, changes), storage, 100)).rejects.toThrow('changed after review')
    await expect(createTaskChangeSet(copy, 100)).rejects.toMatchObject({ code: 'EEXIST' })
  })

  it('validates every retained manifest field before using private paths', async () => {
    const { source, storage } = await fixture()
    await mkdir(join(source, 'dir'))
    await writeFile(join(source, 'file'), 'value')
    const copy = await prepareTaskCopy(source, storage, limits)
    const valid = JSON.parse(await readFile(join(copy.root, 'manifest.json'), 'utf8')) as Record<string, unknown>
    const invalid: Array<[string, unknown]> = [
      ['invalid JSON', '{'],
      ['manifest is invalid', null],
      ['manifest is invalid', { ...valid, version: 1 }],
      ['limits are invalid', { ...valid, limits: { maxEntries: 0, maxBytes: 1, excludedNames: [] } }],
      ['entries are invalid', { ...valid, files: null }],
      ['file entry is invalid', { ...valid, files: [{ path: '../file', mode: 0o600, size: 1, sha256: '0'.repeat(64) }] }],
      ['directory entry is invalid', { ...valid, directories: [{ path: '/dir', mode: 0o700 }] }],
      ['repeats path', { ...valid, directories: [{ path: 'dir', mode: 0o700 }, { path: 'dir', mode: 0o700 }] }],
    ]
    for (const [message, manifest] of invalid) {
      const changed = await replaceManifest(copy, manifest)
      await expect(readTaskChangeSet({
        root: changed.root, original: changed.original, manifestSha256: changed.manifestSha256,
        changes: { sha256: '0'.repeat(64), count: 0, state: 'pending-review' },
      }, storage, 100)).rejects.toThrow(message)
    }
    const misplaced = await replaceManifest(copy, { ...valid, workspace: source })
    await expect(readTaskChangeSet({
      root: misplaced.root, original: misplaced.original, manifestSha256: misplaced.manifestSha256,
      changes: { sha256: '0'.repeat(64), count: 0, state: 'pending-review' },
    }, storage, 100)).rejects.toThrow('durable location')
  })

  it('rejects invalid private storage references and oversized private files', async () => {
    const { root, source, storage } = await fixture()
    await writeFile(join(source, 'file'), 'value')
    const copy = await prepareTaskCopy(source, storage, limits)
    const staged = { sha256: '0'.repeat(64), count: 0, state: 'pending-review' as const }
    await chmod(copy.root, 0o755)
    await expect(readTaskChangeSet({ ...copy, changes: staged }, storage, 100)).rejects.toThrow('private owner-only')
    await chmod(copy.root, 0o700)

    const outside = join(root, 'outside-copy')
    await mkdir(outside, { mode: 0o700 })
    await expect(readTaskChangeSet({
      root: outside, original: copy.original, manifestSha256: copy.manifestSha256, changes: staged,
    }, storage, 100)).rejects.toThrow('outside configured private storage')

    const alias = join(storage, 'alias')
    await symlink(copy.root, alias)
    await expect(readTaskChangeSet({
      root: alias, original: copy.original, manifestSha256: copy.manifestSha256, changes: staged,
    }, storage, 100)).rejects.toThrow('outside configured private storage')

    await chmod(join(copy.root, 'manifest.json'), 0o600)
    await truncate(join(copy.root, 'manifest.json'), 64 * 1024 * 1024 + 1)
    await expect(readTaskChangeSet({ ...copy, changes: staged }, storage, 100)).rejects.toThrow('invalid or oversized')
  })

  it('rejects unbounded, binary, protected, and type-changing staged trees', async () => {
    const first = await fixture()
    await writeFile(join(first.source, 'file'), 'small')
    const limited = await prepareTaskCopy(first.source, first.storage, { ...limits, maxBytes: 5 })
    await writeFile(join(limited.workspace, 'file'), 'too large')
    await expect(createTaskChangeSet(limited, 100)).rejects.toThrow('byte limit')

    const second = await fixture()
    await writeFile(join(second.source, 'file'), 'text')
    const copy = await prepareTaskCopy(second.source, second.storage, limits)
    await rm(join(copy.workspace, 'file'))
    await mkdir(join(copy.workspace, 'file'))
    await expect(createTaskChangeSet(copy, 100)).rejects.toThrow('changes entry type')
    await rm(join(copy.workspace, 'file'), { recursive: true })
    await writeFile(join(copy.workspace, '.env'), 'secret')
    await expect(createTaskChangeSet(copy, 100)).rejects.toThrow('protected path')
    await rm(join(copy.workspace, '.env'))
    execFileSync('mkfifo', [join(copy.workspace, 'fifo')])
    await expect(createTaskChangeSet(copy, 100)).rejects.toThrow('unsupported entry')
  })

  it('enforces exact review bytes and rejects NUL text', async () => {
    const { source, storage } = await fixture()
    await writeFile(join(source, 'file'), 'before')
    const copy = await prepareTaskCopy(source, storage, limits)
    await writeFile(join(copy.workspace, 'file'), 'after')
    await expect(createTaskChangeSet(copy, 5)).rejects.toThrow('exact-review byte limit')
    await writeFile(join(copy.workspace, 'file'), 'a\0b')
    await expect(createTaskChangeSet(copy, 100)).rejects.toThrow('contains NUL')
  })

  it('rejects changed baselines, excess staged entries, and bad manifest fingerprints', async () => {
    const first = await fixture()
    await writeFile(join(first.source, 'same'), 'same')
    await writeFile(join(first.source, 'changed'), 'before')
    const copy = await prepareTaskCopy(first.source, first.storage, limits)
    await writeFile(join(copy.workspace, 'changed'), 'after')
    await chmod(join(copy.root, 'baseline/changed'), 0o600)
    await writeFile(join(copy.root, 'baseline/changed'), 'tampered')
    await expect(createTaskChangeSet(copy, 100)).rejects.toThrow('baseline file')

    const second = await fixture()
    const limited = await prepareTaskCopy(second.source, second.storage, { ...limits, maxEntries: 1 })
    await writeFile(join(limited.workspace, 'one'), '1')
    await writeFile(join(limited.workspace, 'two'), '2')
    await expect(createTaskChangeSet(limited, 100)).rejects.toThrow('entry limit')

    const third = await fixture()
    await writeFile(join(third.source, 'same'), 'same')
    const unchanged = await prepareTaskCopy(third.source, third.storage, limits)
    const set = await createTaskChangeSet(unchanged, 100)
    expect(set.changes).toEqual([])
    await expect(readTaskChangeSet({
      ...reference(unchanged, set), manifestSha256: '0'.repeat(64),
    }, third.storage, 100)).rejects.toThrow('manifest does not match')

    const fourth = await fixture()
    await writeFile(join(fourth.source, 'a'), 'before')
    await writeFile(join(fourth.source, 'b'), 'before')
    const peers = await prepareTaskCopy(fourth.source, fourth.storage, limits)
    await writeFile(join(peers.workspace, 'a'), 'after')
    await writeFile(join(peers.workspace, 'b'), 'after')
    const peerSet = await createTaskChangeSet(peers, 100)
    expect(peerSet.changes).toHaveLength(2)
    await applyTaskChangeSet(reference(peers, peerSet), fourth.storage, 100)
  })

  it('rejects original creations, removals, modes, types, hard links, and parent replacements', async () => {
    const created = await fixture()
    const createCopy = await prepareTaskCopy(created.source, created.storage, limits)
    await writeFile(join(createCopy.workspace, 'new'), 'staged')
    const createSet = await createTaskChangeSet(createCopy, 100)
    await writeFile(join(created.source, 'new'), 'user')
    await expect(applyTaskChangeSet(reference(createCopy, createSet), created.storage, 100)).rejects.toThrow('was created')

    const existing = await fixture()
    await mkdir(join(existing.source, 'dir'))
    await writeFile(join(existing.source, 'dir/file'), 'before')
    const copy = await prepareTaskCopy(existing.source, existing.storage, limits)
    await writeFile(join(copy.workspace, 'dir/file'), 'after')
    const set = await createTaskChangeSet(copy, 100)
    await rm(join(existing.source, 'dir/file'))
    await expect(applyTaskChangeSet(reference(copy, set), existing.storage, 100)).rejects.toThrow('changed after task preparation')

    await writeFile(join(existing.source, 'dir/file'), 'before')
    await chmod(join(existing.source, 'dir/file'), 0o400)
    await expect(applyTaskChangeSet(reference(copy, set), existing.storage, 100)).rejects.toThrow('permissions changed')
    await chmod(join(existing.source, 'dir/file'), 0o644)
    await link(join(existing.source, 'dir/file'), join(existing.root, 'alias'))
    await expect(applyTaskChangeSet(reference(copy, set), existing.storage, 100)).rejects.toThrow('multiple hard links')
    await rm(join(existing.root, 'alias'))
    await rm(join(existing.source, 'dir/file'))
    await mkdir(join(existing.source, 'dir/file'))
    await expect(applyTaskChangeSet(reference(copy, set), existing.storage, 100)).rejects.toThrow('changed type')
    await rm(join(existing.source, 'dir'), { recursive: true })
    await writeFile(join(existing.source, 'dir'), 'parent file')
    await expect(applyTaskChangeSet(reference(copy, set), existing.storage, 100)).rejects.toThrow('parent')
  })

  it('rolls back every completed operation when a later directory removal conflicts', async () => {
    const { source, storage } = await fixture()
    await writeFile(join(source, 'modify'), 'before')
    await writeFile(join(source, 'delete'), 'restore me')
    await mkdir(join(source, 'mode'), { mode: 0o755 })
    await mkdir(join(source, 'doomed/child'), { recursive: true })
    const copy = await prepareTaskCopy(source, storage, limits)
    await writeFile(join(copy.workspace, 'modify'), 'after')
    await rm(join(copy.workspace, 'delete'))
    await chmod(join(copy.workspace, 'mode'), 0o700)
    await mkdir(join(copy.workspace, 'created'))
    await writeFile(join(copy.workspace, 'created/file'), 'new')
    await rm(join(copy.workspace, 'doomed'), { recursive: true })
    const changes = await createTaskChangeSet(copy, 1000)
    await writeFile(join(source, 'doomed/conflict'), 'user')

    await expect(applyTaskChangeSet(reference(copy, changes), storage, 1000)).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    expect(await readFile(join(source, 'modify'), 'utf8')).toBe('before')
    expect(await readFile(join(source, 'delete'), 'utf8')).toBe('restore me')
    expect((await stat(join(source, 'mode'))).mode & 0o777).toBe(0o755)
    await expect(stat(join(source, 'created'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await stat(join(source, 'doomed/child'))).isDirectory()).toBe(true)
    expect(await readFile(join(source, 'doomed/conflict'), 'utf8')).toBe('user')
  })

  it('rejects a project moved away from its approved canonical path', async () => {
    const { root, source, storage } = await fixture()
    await writeFile(join(source, 'file'), 'before')
    const copy = await prepareTaskCopy(source, storage, limits)
    await writeFile(join(copy.workspace, 'file'), 'after')
    const changes = await createTaskChangeSet(copy, 100)
    const moved = join(root, 'moved')
    await rename(source, moved)
    await symlink(moved, source)
    await expect(applyTaskChangeSet(reference(copy, changes), storage, 100)).rejects.toThrow('approved location')
  })
})
