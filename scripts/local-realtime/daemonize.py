#!/usr/bin/env python3
"""把子进程彻底脱离当前终端/沙箱会话，避免父进程退出后被一起杀掉。"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: daemonize.py <logfile> <cmd> [args...]", file=sys.stderr)
        sys.exit(2)
    log_path = Path(sys.argv[1]).resolve()
    cmd = sys.argv[2:]
    workdir = Path.cwd()
    for a in cmd:
        if a.endswith(".py"):
            workdir = Path(a).resolve().parent
            break

    # double-fork
    if os.fork() > 0:
        sys.exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)

    os.chdir(workdir)
    os.umask(0)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.close(fd)
    os.close(devnull)
    os.execv(cmd[0], cmd)


if __name__ == "__main__":
    main()
