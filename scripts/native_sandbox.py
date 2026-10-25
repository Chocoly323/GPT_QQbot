"""Rootless outer sandbox for the unmodified native Codex CLI and its tools.
Landlock scopes filesystem and TCP access; credentials stay in a separate proxy.
"""
import ctypes, os, sys, json, resource
libc = ctypes.CDLL(None, use_errno=True)
if os.uname().machine not in ('x86_64', 'aarch64') or libc.syscall(444, 0, 0, 1) < 6:
    raise RuntimeError('Landlock ABI 6 or newer is required')
policy = json.loads(sys.argv[1])
class Ruleset(ctypes.Structure):
    _fields_ = [('fs', ctypes.c_uint64), ('net', ctypes.c_uint64), ('scoped', ctypes.c_uint64)]
class PathRule(ctypes.Structure):
    _pack_ = 1
    _fields_ = [('access', ctypes.c_uint64), ('parent', ctypes.c_int32)]
class NetRule(ctypes.Structure):
    _fields_ = [('access', ctypes.c_uint64), ('port', ctypes.c_uint64)]
all_fs = (1 << 15) - 1
rules = Ruleset(all_fs, 3, 3)  # scope abstract Unix sockets and cross-sandbox signals
fd = libc.syscall(444, ctypes.byref(rules), ctypes.sizeof(rules), 0)
if fd < 0: raise OSError(ctypes.get_errno(), 'Landlock create')
for path, writable in policy['paths']:
    if not os.path.exists(path): continue
    f = os.open(path, os.O_PATH | os.O_CLOEXEC)
    try:
        access = all_fs if writable else (1 | 4 | (8 if os.path.isdir(path) else 0))
        if path == '/dev/null': access = 2 | 4
        rule = PathRule(access, f)
        if libc.syscall(445, fd, 1, ctypes.byref(rule), 0): raise OSError(ctypes.get_errno(), 'Landlock path rule')
    finally: os.close(f)
net = NetRule(2, policy['port'])
if libc.syscall(445, fd, 2, ctypes.byref(net), 0): raise OSError(ctypes.get_errno(), 'Landlock network rule')
sec = ctypes.CDLL('libseccomp.so.2')
if libc.prctl(38, 1, 0, 0, 0): raise RuntimeError('no_new_privs')
if libc.syscall(446, fd, 0): raise OSError(ctypes.get_errno(), 'Landlock enforce')
os.close(fd)
sec.seccomp_init.argtypes = [ctypes.c_uint32]
sec.seccomp_init.restype = ctypes.c_void_p
sec.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
sec.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
sec.seccomp_load.argtypes = [ctypes.c_void_p]
sec.seccomp_release.argtypes = [ctypes.c_void_p]
ctx = sec.seccomp_init(0x7fff0000)
if not ctx: raise RuntimeError('seccomp init')
for name in ('ptrace', 'process_vm_readv', 'process_vm_writev', 'pidfd_getfd', 'mount', 'umount2', 'setns', 'unshare', 'bpf', 'io_uring_setup', 'open_by_handle_at'):
    num = sec.seccomp_syscall_resolve_name(name.encode())
    if num >= 0 and sec.seccomp_rule_add(ctx, 0x50001, num, 0): raise RuntimeError('seccomp rule')
if sec.seccomp_load(ctx): raise RuntimeError('seccomp load')
sec.seccomp_release(ctx)
# Permit socket() only for TCP streams. This also blocks access to host Unix
# control sockets and UDP, which Landlock's TCP port rules do not cover.
class Filter(ctypes.Structure):
    _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte), ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint)]
class Program(ctypes.Structure):
    _fields_ = [('length', ctypes.c_ushort), ('filter', ctypes.POINTER(Filter))]
socket_nr = 41 if os.uname().machine == 'x86_64' else 198
instructions = [(0x20,0,0,0), (0x15,0,7,socket_nr), (0x20,0,0,16),
                (0x15,1,0,2), (0x15,0,3,10), (0x20,0,0,24),
                (0x54,0,0,15), (0x15,1,0,1), (0x06,0,0,0x50001),
                (0x06,0,0,0x7fff0000)]
filters = (Filter * len(instructions))(*(Filter(*row) for row in instructions))
program = Program(len(instructions), filters)
if libc.prctl(22, 2, ctypes.byref(program), 0, 0): raise RuntimeError('socket filter')
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024**2, 64 * 1024**2))
os.execv(sys.argv[2], sys.argv[2:])
