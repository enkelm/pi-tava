/** Native descriptor-checked SSH text snapshots and atomic replacement, never SFTP overwrite/CAS. */
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { decodeText, MAX_EDIT_BYTES, textRevision } from "./file-edits.ts";
import { HttpError, describe } from "./errors.ts";
import type { WorkspaceBackend } from "./workspace-backend.ts";

export type RemoteEditAuthorization = {
    backend: WorkspaceBackend;
    /** Canonical namespace paths, freshly authorized by the caller (including its original alias). */
    root: string;
    file: string;
    offline: boolean;
};

export class RemoteEditCapabilityError extends HttpError {
    constructor(message: string) {
        super(409, `Native SSH text editing is unavailable: ${message}`);
    }
}

// This is fixed trusted source, not a project helper. -I excludes cwd, PYTHONPATH and user site startup.
// Content travels through a private SFTP file or bounded stdout, never a large argv element.
const SCRIPT = String.raw`
import base64, hashlib, json, os, stat, sys, uuid
CAP = 512 * 1024
class EditError(Exception):
    def __init__(self, kind, message): self.kind, self.message = kind, message

def conflict(message='The file changed or cannot be edited safely. Reload it before saving.'):
    raise EditError('conflict', message)

def signature(s):
    return [str(x) for x in [s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_mode, s.st_nlink, s.st_uid, s.st_gid]]

def identity(a, b): return a[:2] == b[:2]
def digest(b): return hashlib.sha256(b).hexdigest()
def regular(s): return stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= CAP

def content(fd):
    chunks, offset = [], 0
    while offset <= CAP:
        b = os.pread(fd, min(65536, CAP + 1 - offset), offset)
        if not b: break
        chunks.append(b); offset += len(b)
    data = b''.join(chunks)
    if len(data) > CAP or b'\0' in data: conflict()
    try: data.decode('utf-8', 'strict')
    except UnicodeError: conflict('The file must be complete UTF-8 text without NUL characters.')
    return data

def opened(name, directory=None):
    named = os.stat(name, dir_fd=directory, follow_symlinks=False)
    if not regular(named): conflict()
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
    try:
        before = os.fstat(fd)
        if signature(named) != signature(before) or not regular(before): conflict()
        data = content(fd)
        if signature(before) != signature(os.fstat(fd)): conflict()
        return fd, before, data
    except BaseException:
        os.close(fd); raise

def directory(path):
    if os.path.realpath(path) != path: conflict()
    named = os.lstat(path)
    if not stat.S_ISDIR(named.st_mode): conflict()
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    if not identity(signature(named), signature(os.fstat(fd))):
        os.close(fd); conflict()
    return fd, signature(named)

def paths(req):
    root, file = req['root'], req['file']
    if not os.path.isabs(root) or not os.path.isabs(file): conflict()
    if os.path.realpath(root) != root or os.path.realpath(file) != file: conflict()
    if os.path.commonpath([root, file]) != root or root == file: conflict()
    rootfd, rootsig = directory(root)
    try:
        parent = os.path.dirname(file)
        parentfd, parentsig = directory(parent)
        return rootfd, rootsig, parentfd, parentsig, parent, os.path.basename(file)
    except BaseException:
        os.close(rootfd); raise

def safe_unlink(parent, fd, parentsig, name, sig):
    try:
        if os.path.realpath(parent) == parent and identity(parentsig, signature(os.lstat(parent))) and identity(parentsig, signature(os.fstat(fd))) and sig == signature(os.stat(name, dir_fd=fd, follow_symlinks=False)):
            os.unlink(name, dir_fd=fd)
    except OSError: pass

def write_all(fd, data):
    offset = 0
    while offset < len(data):
        n = os.write(fd, data[offset:])
        if n <= 0: raise OSError('Short native file write')
        offset += n

def check_paths(req, rootsig, parent, parentsig, parentfd):
    if os.path.realpath(req['root']) != req['root'] or os.path.realpath(req['file']) != req['file'] or os.path.realpath(parent) != parent:
        conflict()
    if not identity(rootsig, signature(os.lstat(req['root']))) or not identity(parentsig, signature(os.lstat(parent))) or not identity(parentsig, signature(os.fstat(parentfd))): conflict()

def inspect(req):
    rootfd, rootsig, parentfd, parentsig, parent, name = paths(req)
    fd = None
    try:
        fd, before, data = opened(name, parentfd)
        check_paths(req, rootsig, parent, parentsig, parentfd)
        if signature(before) != signature(os.stat(name, dir_fd=parentfd, follow_symlinks=False)) or signature(before) != signature(os.fstat(fd)): conflict()
        return {'path': req['file'], 'revision': digest(data), 'bytes': base64.b64encode(data).decode('ascii')}
    finally:
        if fd is not None: os.close(fd)
        os.close(parentfd); os.close(rootfd)

def prepare(req):
    stagefd, stagesig = directory(req['stage'])
    sourcefd = oldfd = parentfd = rootfd = tempfd = snapshotfd = None
    sourceinfo = snapshotinfo = tempinfo = None
    tempname = None
    parent = None
    success = False
    try:
        ss = os.fstat(stagefd)
        if ss.st_uid != os.geteuid() or stat.S_IMODE(ss.st_mode) != 0o700: conflict()
        sourcefd, sourceinfo, replacement = opened('replacement', stagefd)
        if digest(replacement) != req['newRevision']: conflict()
        rootfd, rootsig, parentfd, parentsig, parent, name = paths(req)
        oldfd, before, original = opened(name, parentfd)
        if digest(original) != req['revision']: conflict()
        snapshotfd = os.open('original', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stagefd)
        snapshotinfo = os.fstat(snapshotfd)
        write_all(snapshotfd, original); os.fsync(snapshotfd)
        snapshotinfo = os.fstat(snapshotfd)
        tempname = '.pi-edit-' + uuid.uuid4().hex + '.tmp'
        tempfd = os.open(tempname, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parentfd)
        tempinfo = os.fstat(tempfd)
        write_all(tempfd, replacement)
        if tempinfo.st_uid != before.st_uid or tempinfo.st_gid != before.st_gid:
            os.fchown(tempfd, before.st_uid, before.st_gid)
        os.fchmod(tempfd, stat.S_IMODE(before.st_mode)); os.fsync(tempfd)
        tempinfo = os.fstat(tempfd)
        check_paths(req, rootsig, parent, parentsig, parentfd)
        if signature(before) != signature(os.fstat(oldfd)) or signature(before) != signature(os.stat(name, dir_fd=parentfd, follow_symlinks=False)): conflict()
        token = dict(req)
        token.update({'rootInfo': rootsig, 'parentInfo': parentsig, 'stageInfo': stagesig, 'sourceInfo': signature(sourceinfo), 'snapshotInfo': signature(snapshotinfo), 'tempInfo': signature(tempinfo), 'originalInfo': signature(before), 'temp': tempname})
        success = True
        return token
    finally:
        if not success:
            if tempfd is not None: tempinfo = os.fstat(tempfd)
            if snapshotfd is not None: snapshotinfo = os.fstat(snapshotfd)
            if tempinfo is not None and parentfd is not None:
                safe_unlink(parent, parentfd, parentsig, tempname, signature(tempinfo))
            if snapshotinfo is not None:
                safe_unlink(req['stage'], stagefd, stagesig, 'original', signature(snapshotinfo))
            if sourceinfo is not None:
                safe_unlink(req['stage'], stagefd, stagesig, 'replacement', signature(sourceinfo))
        for fd in [sourcefd, oldfd, tempfd, snapshotfd, parentfd, rootfd, stagefd]:
            if fd is not None: os.close(fd)
        if not success:
            try:
                if os.path.realpath(req['stage']) == req['stage'] and identity(stagesig, signature(os.lstat(req['stage']))): os.rmdir(req['stage'])
            except OSError: pass

def finish(token, commit):
    rootfd = parentfd = stagefd = oldfd = sourcefd = snapshotfd = tempfd = None
    renamed = False
    try:
        rootfd, rootsig, parentfd, parentsig, parent, name = paths(token)
        if not identity(rootsig, token['rootInfo']) or not identity(parentsig, token['parentInfo']): conflict()
        stagefd, stagesig = directory(token['stage'])
        if not identity(stagesig, token['stageInfo']): conflict()
        if not commit: return {}
        oldfd, before, original = opened(name, parentfd)
        sourcefd, sourceinfo, replacement = opened('replacement', stagefd)
        snapshotfd, snapshotinfo, snapshot = opened('original', stagefd)
        tempfd, tempinfo, temporary = opened(token['temp'], parentfd)
        checks = [(before, token['originalInfo']), (sourceinfo, token['sourceInfo']), (snapshotinfo, token['snapshotInfo']), (tempinfo, token['tempInfo'])]
        if any(signature(a) != b for a, b in checks): conflict()
        if original != snapshot or digest(original) != token['revision'] or temporary != replacement or digest(replacement) != token['newRevision']: conflict()
        if tempinfo.st_mode != before.st_mode or tempinfo.st_uid != before.st_uid or tempinfo.st_gid != before.st_gid: conflict()
        check_paths(token, rootsig, parent, parentsig, parentfd)
        for fd, info in [(oldfd, before), (sourcefd, sourceinfo), (snapshotfd, snapshotinfo), (tempfd, tempinfo)]:
            if signature(os.fstat(fd)) != signature(info): conflict()
        for item, info, fd in [(name, before, parentfd), (token['temp'], tempinfo, parentfd), ('replacement', sourceinfo, stagefd), ('original', snapshotinfo, stagefd)]:
            if signature(os.stat(item, dir_fd=fd, follow_symlinks=False)) != signature(info): conflict()
        # Descriptor-relative atomic replacement is best-effort against an external final rename race,
        # not an OS compare-and-swap. No await or host roundtrip occurs inside these final native checks.
        os.rename(token['temp'], name, src_dir_fd=parentfd, dst_dir_fd=parentfd)
        renamed = True
        return {'revision': token['newRevision']}
    finally:
        if parentfd is not None and not renamed:
            safe_unlink(os.path.dirname(token['file']), parentfd, token['parentInfo'], token['temp'], token['tempInfo'])
        if stagefd is not None:
            safe_unlink(token['stage'], stagefd, token['stageInfo'], 'replacement', token['sourceInfo'])
            safe_unlink(token['stage'], stagefd, token['stageInfo'], 'original', token['snapshotInfo'])
        for fd in [oldfd, sourcefd, snapshotfd, tempfd, rootfd, parentfd, stagefd]:
            if fd is not None:
                try: os.close(fd)
                except OSError: pass
        try:
            if os.path.realpath(token['stage']) == token['stage'] and identity(token['stageInfo'], signature(os.lstat(token['stage']))): os.rmdir(token['stage'])
        except OSError: pass

try:
    if os.name != 'posix' or not all(hasattr(os, name) for name in ['O_NOFOLLOW', 'O_DIRECTORY', 'pread', 'fchown', 'fchmod']) or not {os.open, os.stat, os.unlink, os.rename}.issubset(os.supports_dir_fd) or os.stat not in os.supports_follow_symlinks:
        raise EditError('capability', 'Python lacks required no-follow descriptor operations.')
    if len(sys.argv) != 3 or len(sys.argv[2].encode('utf-8')) > 65536: conflict()
    request = json.loads(sys.argv[2])
    phase = sys.argv[1]
    if phase == 'inspect': result = inspect(request)
    elif phase == 'prepare': result = prepare(request)
    elif phase in ['finalize', 'abort']: result = finish(request, phase == 'finalize')
    else: conflict()
    print(json.dumps({'ok': True, 'value': result}, separators=(',', ':')))
except EditError as e:
    print(json.dumps({'ok': False, 'kind': e.kind, 'message': e.message}))
except (OSError, ValueError, KeyError, TypeError) as e:
    print(json.dumps({'ok': False, 'kind': 'conflict', 'message': 'Native file inspection/save failed: ' + str(e)}))
`;

type Binding = RemoteEditAuthorization;
type Prepared = Record<string, unknown> & {
    root: string;
    file: string;
    stage: string;
    revision: string;
    newRevision: string;
    temp: string;
};
const pending = new Map<string, Promise<void>>();

function conflict(): HttpError {
    return new HttpError(
        409,
        "The SSH file, folder or request authority changed. Reload it before saving.",
    );
}

async function binding(authorization: RemoteEditAuthorization): Promise<Binding> {
    if (!authorization.backend.remote) {
        throw new RemoteEditCapabilityError(
            "a remote destination-bound backend is required; no local fallback.",
        );
    }

    const { backend } = authorization;
    const root = await backend.canonical(authorization.root);
    const file = await backend.canonical(authorization.file);
    const relative = backend.paths.relative(root, file);

    if (
        !relative ||
        relative === ".." ||
        relative.startsWith("../") ||
        backend.paths.isAbsolute(relative)
    ) {
        throw conflict();
    }

    backend.checkAccess();

    return { ...authorization, root, file };
}

async function native(
    binding: Binding,
    phase: string,
    request: unknown,
    readOnly: boolean,
): Promise<unknown> {
    const input = JSON.stringify(request);

    if (Buffer.byteLength(input) > 64 * 1024) {
        throw conflict();
    }

    let stdout = "";
    let stderr = "";
    let result;

    try {
        result = getOrThrow(
            await binding.backend.exec(
                ["python3", "-I", "-c", SCRIPT, phase, input],
                {
                    timeout: 30,
                    inheritEnv: false,
                    onOutput(text, _context, info) {
                        if (info.skipped !== undefined) {
                            throw new Error(
                                "Native SSH edit protocol output was omitted; outcome may be uncertain.",
                            );
                        }

                        if (info.stream === "stdout") {
                            stdout += text;

                            if (Buffer.byteLength(stdout) > MAX_EDIT_BYTES * 2 + 64 * 1024) {
                                throw new Error(
                                    "Native SSH edit protocol exceeded its output bound.",
                                );
                            }
                        } else {
                            stderr = (stderr + text).slice(-8192);
                        }
                    },
                },
                { offline: binding.offline },
                readOnly,
            ),
        );
    } catch (error) {
        if (/confinement|sandbox|not found|ENOENT/.test(describe(error))) {
            throw new RemoteEditCapabilityError(describe(error));
        }

        throw new HttpError(
            409,
            `Native SSH edit ${phase} interrupted; outcome may be unknown. No automatic retry. ${describe(error)}`,
        );
    }

    if (result.exitCode !== 0) {
        if (
            result.exitCode === 127 ||
            /not found|sandbox|confinement|supported target-native/.test(stderr)
        ) {
            throw new RemoteEditCapabilityError(
                stderr || "Python3 is not installed on the target.",
            );
        }

        throw new HttpError(
            409,
            `Native SSH edit ${phase} exited ${result.exitCode}; no automatic retry. ${stderr}`,
        );
    }

    let response;

    try {
        response = JSON.parse(stdout);
    } catch {
        throw new HttpError(
            409,
            `Invalid native SSH edit ${phase} response; outcome may be unknown. No automatic retry.`,
        );
    }

    if (response?.ok !== true) {
        if (response?.kind === "capability") {
            throw new RemoteEditCapabilityError(String(response.message));
        }

        throw new HttpError(409, String(response?.message ?? "Native SSH edit failed."));
    }

    return response.value;
}

/** Bytes and SHA come from one native opened descriptor, never a newer hash on an earlier SFTP preview. */
export async function inspectRemoteFileEdit(
    authorization: RemoteEditAuthorization,
): Promise<{ path: string; revision: string; bytes: Buffer }> {
    const bound = await binding(authorization);
    const value = (await native(
        bound,
        "inspect",
        { root: bound.root, file: bound.file },
        true,
    )) as { path?: unknown; revision?: unknown; bytes?: unknown };

    if (
        value?.path !== bound.file ||
        typeof value.bytes !== "string" ||
        typeof value.revision !== "string"
    ) {
        throw conflict();
    }

    const bytes = Buffer.from(value.bytes, "base64");

    if (
        bytes.length > MAX_EDIT_BYTES ||
        bytes.toString("base64") !== value.bytes ||
        decodeText(bytes) === undefined ||
        textRevision(bytes) !== value.revision
    ) {
        throw conflict();
    }

    bound.backend.checkAccess();

    return { path: bound.file, revision: value.revision, bytes };
}

/** Serialize the entire prepare/reauthorize/finalize lifecycle across threads and path aliases. */
export async function saveRemoteFileEdit(
    input: { bytes: Buffer; revision: string },
    authorize: () => Promise<RemoteEditAuthorization>,
): Promise<{ revision: string }> {
    const bytes = Buffer.from(input.bytes);

    if (
        bytes.length > MAX_EDIT_BYTES ||
        decodeText(bytes) === undefined ||
        !/^[a-f0-9]{64}$/.test(input.revision)
    ) {
        throw conflict();
    }

    const initial = await binding(await authorize());
    const key = JSON.stringify([initial.backend.id, initial.file]);
    const previous = pending.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const tail = previous.then(() => held);

    pending.set(key, tail);
    await previous;
    let prepared: Prepared | undefined;
    let current = initial;

    const reauthorize = async () => {
        // The callback does its final live driver/busy/token/writer checks after its own async
        // path resolution. Do not add another filesystem await between those checks and finalize.
        const next = await authorize();

        if (
            next.backend.id !== initial.backend.id ||
            next.file !== initial.file ||
            next.root !== initial.root ||
            next.offline !== initial.offline
        ) {
            throw conflict();
        }

        next.backend.checkAccess(true);
        current = next;
    };

    try {
        await reauthorize();
        const before = await inspectRemoteFileEdit(current);

        if (before.revision !== input.revision) {
            throw conflict();
        }

        const stage = getOrThrow(
            await current.backend.env.createTempDir("pi-file-edit-", current.backend.context),
        );

        getOrThrow(
            await current.backend.env.writeFile(
                current.backend.paths.join(stage, "replacement"),
                bytes,
                current.backend.context,
            ),
        );
        const request = {
            root: current.root,
            file: current.file,
            stage: await current.backend.canonical(stage),
            revision: input.revision,
            newRevision: textRevision(bytes),
        };
        const value = (await native(current, "prepare", request, false)) as Prepared;

        if (
            value?.root !== request.root ||
            value.file !== request.file ||
            value.stage !== request.stage ||
            value.revision !== request.revision ||
            value.newRevision !== request.newRevision ||
            !/^\.pi-edit-[a-f0-9]{32}\.tmp$/.test(value.temp)
        ) {
            throw conflict();
        }

        // Pin a detached JSON snapshot, not an object mutable by an asynchronous caller.
        prepared = JSON.parse(JSON.stringify(value));
        await reauthorize();
        const result = (await native(current, "finalize", prepared, false)) as {
            revision?: unknown;
        };

        if (result?.revision !== request.newRevision) {
            throw conflict();
        }

        prepared = undefined;

        return { revision: request.newRevision };
    } finally {
        if (prepared !== undefined) {
            // A denied/unknown finalize is never replayed. Abort only removes the pinned temp inodes;
            // authorization/transport failure may leave private staging for manual cleanup.
            await native(current, "abort", prepared, false).catch(() => {});
        }

        release();

        if (pending.get(key) === tail) {
            pending.delete(key);
        }
    }
}
