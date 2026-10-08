"""Starts one program for the runner, as the program's own user.

The runner (runner.py) runs as root with only the capabilities to change
user and group, and threads; this runs single-threaded in a fresh process
so that dropping privileges happens before anything of the program does:

    python3 launcher.py run <language> <job dir>     (the code on stdin)
    python3 launcher.py clean                         (after every program)

`run` gives up root for the program's user, sets the limits, makes the job
directory, writes the code there and replaces itself with bash or python3.
`clean`, as the same user, kills every process that user still has and
removes everything it left behind (files, System V shared memory,
semaphores and message queues, POSIX message queues), so nothing of one
program is there for the next, which may be another token's.

With PCP_SANDBOX_SAME_USER=1 (tests and development only) nothing changes
user: `clean` then removes the job directory alone.
"""

import ctypes
import os
import resource
import shutil
import signal
import sys

PROGRAM_UID = int(os.environ.get("PCP_SANDBOX_UID", "2000"))
SAME_USER = os.environ.get("PCP_SANDBOX_SAME_USER") == "1"
WORK = os.environ.get("PCP_SANDBOX_WORK", "/work")
# Places a program can write: the job directories, and the shared
# temporary ones a library may use regardless of TMPDIR. /dev/mqueue lists
# the POSIX message queues of the container's IPC namespace as files, and
# unlinking one removes the queue (it is there where the runtime mounts it).
SCRATCH = [WORK, "/tmp", "/dev/shm", "/var/tmp", "/dev/mqueue"]

# System V objects live in the container's IPC namespace, not in a file
# system, and outlive the processes that made them: the table that lists
# each kind, the column that names one, and the call that removes it.
SYSV = [
    ("/proc/sysvipc/shm", "shmid", "shmctl"),
    ("/proc/sysvipc/sem", "semid", "semctl"),
    ("/proc/sysvipc/msg", "msqid", "msgctl"),
]
IPC_RMID = 0

LIMITS = {
    resource.RLIMIT_CPU: 60,
    resource.RLIMIT_AS: 1024 * 1024 * 1024,
    resource.RLIMIT_FSIZE: 64 * 1024 * 1024,
    resource.RLIMIT_NOFILE: 256,
    resource.RLIMIT_NPROC: 128,
    resource.RLIMIT_CORE: 0,
}


def become_program_user():
    if SAME_USER:
        return
    os.setgroups([])
    os.setgid(PROGRAM_UID)
    os.setuid(PROGRAM_UID)
    if os.getuid() == 0 or os.geteuid() == 0:
        raise SystemExit("launcher: could not give up root")


def run(language, job_dir):
    code = sys.stdin.buffer.read()
    become_program_user()

    for limit, value in LIMITS.items():
        # The user's processes are counted together: only the program's own
        # user can be held to a number of them.
        if SAME_USER and limit == resource.RLIMIT_NPROC:
            continue
        soft, hard = resource.getrlimit(limit)
        cap = value if hard == resource.RLIM_INFINITY else min(value, hard)
        resource.setrlimit(limit, (cap, cap))

    # The kernel kills the program, not the runner, when memory runs out.
    try:
        with open("/proc/self/oom_score_adj", "w") as adj:
            adj.write("1000")
    except OSError:
        pass

    os.makedirs(job_dir, mode=0o700)
    os.chdir(job_dir)
    name = "program.py" if language == "python" else "program.sh"
    with open(name, "wb") as program:
        program.write(code)

    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(devnull)

    if language == "python":
        os.execvp("python3", ["python3", "-u", name])
    os.execvp("bash", ["bash", "--noprofile", "--norc", name])


def remove(path):
    try:
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path, ignore_errors=True)
        else:
            os.unlink(path)
    except OSError:
        pass


def remove_sysv_ipc():
    """Removes every System V shared memory segment, semaphore set and
    message queue the program's user made or owns. Its creator can always
    remove one, even after changing its owner, and `clean` runs as that
    user, so no capability is needed."""
    libc = ctypes.CDLL(None, use_errno=True)
    for table, id_column, call in SYSV:
        try:
            with open(table) as lines:
                header = lines.readline().split()
                rows = [line.split() for line in lines]
            id_at, uid_at, cuid_at = (
                header.index(id_column),
                header.index("uid"),
                header.index("cuid"),
            )
        except (OSError, ValueError):
            continue
        for row in rows:
            try:
                owners = (int(row[uid_at]), int(row[cuid_at]))
                if PROGRAM_UID not in owners:
                    continue
                identifier = int(row[id_at])
            except (IndexError, ValueError):
                continue
            # semctl takes the semaphore number between the two; ignored for
            # IPC_RMID.
            if call == "semctl":
                libc.semctl(identifier, 0, IPC_RMID)
            else:
                getattr(libc, call)(identifier, IPC_RMID, None)


def clean(job_dir):
    if SAME_USER:
        remove(job_dir)
        return

    become_program_user()
    # Every process of the program's user, wherever it went; this one is
    # spared by the kernel.
    try:
        os.kill(-1, signal.SIGKILL)
    except ProcessLookupError:
        pass

    for place in SCRATCH:
        try:
            entries = os.listdir(place)
        except OSError:
            continue
        for entry in entries:
            path = os.path.join(place, entry)
            try:
                if os.lstat(path).st_uid == PROGRAM_UID:
                    remove(path)
            except OSError:
                pass

    remove_sysv_ipc()


def main():
    if len(sys.argv) == 4 and sys.argv[1] == "run":
        run(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 3 and sys.argv[1] == "clean":
        clean(sys.argv[2])
    else:
        raise SystemExit("usage: launcher.py run <language> <dir> | clean <dir>")


if __name__ == "__main__":
    main()
