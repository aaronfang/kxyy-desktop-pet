#!/usr/bin/env python3
"""把子进程彻底脱离当前终端/沙箱会话，避免父进程退出后被一起杀掉。"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# 仅允许在本仓库范围内脱离终端启动脚本，避免被当成任意命令执行/任意路径写入的跳板。
REPO_ROOT = Path(__file__).resolve().parents[2]


def _validate(log_path: Path, cmd: list[str]) -> Path:
    if not cmd:
        print("daemonize.py: 缺少要执行的命令", file=sys.stderr)
        sys.exit(2)
    # 解释器必须是真实存在的可执行文件。
    exe = Path(cmd[0])
    if not exe.is_file() or not os.access(str(exe), os.X_OK):
        print(f"daemonize.py: 解释器不可执行：{cmd[0]}", file=sys.stderr)
        sys.exit(2)
    # 目标脚本（.py）必须位于本仓库内，禁止越界执行。
    script = next((a for a in cmd[1:] if a.endswith(".py")), None)
    if script is not None:
        sp = Path(script).resolve()
        if not sp.is_file():
            print(f"daemonize.py: 找不到脚本：{script}", file=sys.stderr)
            sys.exit(2)
        try:
            sp.relative_to(REPO_ROOT)
        except ValueError:
            print(f"daemonize.py: 拒绝执行仓库外脚本：{sp}", file=sys.stderr)
            sys.exit(2)
        workdir = sp.parent
    else:
        workdir = Path.cwd()
    # 日志只允许写到仓库内或用户主目录下，避免任意路径写入。
    lp = log_path.resolve()
    allowed = (REPO_ROOT, Path.home().resolve())
    if not any(str(lp).startswith(str(base)) for base in allowed):
        print(f"daemonize.py: 拒绝写入越界日志路径：{lp}", file=sys.stderr)
        sys.exit(2)
    return workdir


def main() -> None:
    if len(sys.argv) < 3:
        print("usage: daemonize.py <logfile> <cmd> [args...]", file=sys.stderr)
        sys.exit(2)
    log_path = Path(sys.argv[1]).resolve()
    cmd = sys.argv[2:]
    workdir = _validate(log_path, cmd)

    # double-fork
    if os.fork() > 0:
        sys.exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)

    os.chdir(workdir)
    os.umask(0o022)
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
