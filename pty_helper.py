#!/usr/bin/env python3
"""
PTY helper - creates a real pseudo-terminal for a command
and bridges it to stdin/stdout so Node.js can communicate via pipes.
"""
import sys, os, pty, select, signal, struct, fcntl, termios, errno

def set_nonblock(fd):
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

def main():
    if len(sys.argv) < 2:
        print("Usage: pty_helper.py <command> [args...]", file=sys.stderr)
        sys.exit(1)

    # Create PTY pair
    master_fd, slave_fd = pty.openpty()

    # Set initial terminal size
    winsize = struct.pack('HHHH', 40, 100, 0, 0)  # rows, cols
    fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

    pid = os.fork()
    if pid == 0:
        # Child process
        os.close(master_fd)
        os.setsid()

        # Set slave as controlling terminal
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

        # Redirect stdio to slave PTY
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)

        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'
        os.environ['FORCE_COLOR'] = '1'

        # Execute the command
        os.execvp(sys.argv[1], sys.argv[1:])
    else:
        # Parent process
        os.close(slave_fd)
        set_nonblock(master_fd)
        set_nonblock(sys.stdin.fileno())

        stdin_fd = sys.stdin.fileno()
        stdout_fd = sys.stdout.fileno()

        # Flush stdout in binary mode
        sys.stdout = os.fdopen(stdout_fd, 'wb', 0)

        try:
            while True:
                try:
                    fds = [master_fd, stdin_fd]
                    rfds, _, _ = select.select(fds, [], [], 0.1)
                except (select.error, ValueError):
                    break

                if master_fd in rfds:
                    try:
                        data = os.read(master_fd, 65536)
                        if not data:
                            break
                        sys.stdout.write(data)
                    except OSError as e:
                        if e.errno == errno.EIO:
                            break
                        if e.errno != errno.EAGAIN:
                            break

                if stdin_fd in rfds:
                    try:
                        data = os.read(stdin_fd, 65536)
                        if not data:
                            break
                        os.write(master_fd, data)
                    except OSError as e:
                        if e.errno == errno.EIO:
                            break
                        if e.errno != errno.EAGAIN:
                            break

                # Check if child is still alive
                try:
                    rpid, status = os.waitpid(pid, os.WNOHANG)
                    if rpid != 0:
                        # Drain remaining output
                        try:
                            while True:
                                data = os.read(master_fd, 65536)
                                if not data:
                                    break
                                sys.stdout.write(data)
                        except OSError:
                            pass
                        break
                except ChildProcessError:
                    break

        except KeyboardInterrupt:
            pass
        finally:
            os.close(master_fd)
            try:
                os.kill(pid, signal.SIGTERM)
                os.waitpid(pid, 0)
            except (ProcessLookupError, ChildProcessError):
                pass

        sys.exit(0)

if __name__ == '__main__':
    main()
