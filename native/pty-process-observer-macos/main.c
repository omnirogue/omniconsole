#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/event.h>
#include <sys/proc_info.h>
#include <sys/sysctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

// FD 3 is private host IPC; terminal/provider output never enters this observer.
static const int receipt_fd = 3;
static struct proc_bsdinfo root_identity, shell_identity;
static char shell_path[PROC_PIDPATHINFO_MAXSIZE];

static int read_identity(pid_t pid, struct proc_bsdinfo *info) {
  // sysctl exposes owned login's birth; libproc refuses its setuid supervisor.
  struct kinfo_proc process;
  size_t size = sizeof(process);
  int query[] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  if (sysctl(query, 4, &process, &size, NULL, 0) != 0 || size != sizeof(process)
    || process.kp_proc.p_pid != pid || process.kp_proc.p_starttime.tv_sec <= 0) return 0;
  memset(info, 0, sizeof(*info));
  info->pbi_pid = process.kp_proc.p_pid;
  info->pbi_ppid = process.kp_eproc.e_ppid;
  info->pbi_uid = process.kp_eproc.e_ucred.cr_uid;
  info->pbi_ruid = process.kp_eproc.e_pcred.p_ruid;
  info->pbi_pgid = process.kp_eproc.e_pgid;
  info->e_tdev = process.kp_eproc.e_tdev;
  info->pbi_start_tvsec = process.kp_proc.p_starttime.tv_sec;
  info->pbi_start_tvusec = process.kp_proc.p_starttime.tv_usec;
  strlcpy(info->pbi_comm, process.kp_proc.p_comm, sizeof(info->pbi_comm));
  return 1;
}

static int same_identity(const struct proc_bsdinfo *a, const struct proc_bsdinfo *b) {
  return a->pbi_pid == b->pbi_pid && a->pbi_start_tvsec == b->pbi_start_tvsec
    && a->pbi_start_tvusec == b->pbi_start_tvusec;
}

static uint64_t birth_ms(const struct proc_bsdinfo *info) {
  return info->pbi_start_tvsec * 1000 + info->pbi_start_tvusec / 1000;
}

static int path_matches(pid_t pid, const char *expected) {
  char actual[PROC_PIDPATHINFO_MAXSIZE], resolved[PATH_MAX];
  return proc_pidpath(pid, actual, sizeof(actual)) > 0
    && realpath(actual, resolved) && strcmp(resolved, expected) == 0;
}

static int verify_identity(int held) {
  struct proc_bsdinfo root, shell;
  if (!read_identity(shell_identity.pbi_pid, &shell) || !same_identity(&shell, &shell_identity)) return 0;
  if (!held) return 1;
  if (!read_identity(root_identity.pbi_pid, &root) || !same_identity(&root, &root_identity)
    || shell.pbi_ppid != root.pbi_pid || shell.pbi_uid != getuid()
    || root.pbi_ruid != getuid() || shell.pbi_ruid != getuid()
    || shell.pbi_pgid != shell_identity.pbi_pgid
    || shell.e_tdev != shell_identity.e_tdev) return 0;
  return path_matches(shell.pbi_pid, shell_path);
}

static int fail(const char *reason) {
  dprintf(receipt_fd, "{\"event\":\"unverifiable\",\"reason\":\"%s\"}\n", reason);
  return 1;
}

static pid_t parse_pid(const char *value) {
  char *end;
  errno = 0;
  long parsed = strtol(value, &end, 10);
  return !errno && *value && !*end && parsed > 0 && parsed <= INT_MAX ? (pid_t)parsed : 0;
}

int main(int argc, char **argv) {
  if (argc != 4) return fail("arguments_invalid");
  pid_t root_pid = parse_pid(argv[1]), shell_pid = parse_pid(argv[2]);
  if (!root_pid || !shell_pid || root_pid == shell_pid || !realpath(argv[3], shell_path))
    return fail("arguments_invalid");
  if (!read_identity(root_pid, &root_identity)) return fail("root_birth_unverifiable");
  if (!read_identity(shell_pid, &shell_identity)) return fail("shell_birth_unverifiable");
  if (strcmp(root_identity.pbi_comm, "login") != 0) return fail("root_path_unverifiable");
  if (shell_identity.e_tdev == UINT32_MAX || shell_identity.e_tdev != root_identity.e_tdev)
    return fail("terminal_identity_unverifiable");
  if (!verify_identity(1)) return fail("shell_identity_unverifiable");
  signal(SIGPIPE, SIG_IGN);
  int queue = kqueue();
  if (queue < 0) return fail("kqueue_unavailable");
  struct kevent changes[2];
  EV_SET(&changes[0], shell_pid, EVFILT_PROC, EV_ADD | EV_ENABLE | EV_CLEAR,
    NOTE_EXIT | NOTE_EXITSTATUS, 0, NULL);
  EV_SET(&changes[1], STDIN_FILENO, EVFILT_READ, EV_ADD | EV_ENABLE, 0, 0, NULL);
  if (kevent(queue, changes, 2, NULL, 0, NULL) < 0 || !verify_identity(1))
    return fail("observer_not_armed");
  if (dprintf(receipt_fd,
    "{\"event\":\"armed\",\"pid\":%d,\"processStartTimeMs\":%llu,"
    "\"ptyRootPid\":%d,\"ptyRootProcessStartTimeMs\":%llu}\n",
    shell_pid, (unsigned long long)birth_ms(&shell_identity), root_pid,
    (unsigned long long)birth_ms(&root_identity)) < 0) return 1;

  char input[256];
  size_t used = 0;
  for (;;) {
    struct kevent events[2];
    int count = kevent(queue, NULL, 0, events, 2, NULL);
    if (count < 0) {
      if (errno == EINTR) continue;
      return fail("observer_failed");
    }
    for (int i = 0; i < count; i++) {
      if (events[i].flags & EV_ERROR) return fail("observer_failed");
      if (events[i].filter != EVFILT_PROC) continue;
      if (events[i].ident != (uintptr_t)shell_pid
        || !(events[i].fflags & NOTE_EXIT) || !(events[i].fflags & NOTE_EXITSTATUS))
        return fail("exit_status_unverifiable");
      int status = (int)events[i].data;
      struct timespec observed;
      if (clock_gettime(CLOCK_REALTIME, &observed) != 0
        || (!WIFEXITED(status) && !WIFSIGNALED(status))) return fail("exit_status_unverifiable");
      dprintf(receipt_fd,
        "{\"event\":\"exited\",\"pid\":%d,\"processStartTimeMs\":%llu,"
        "\"waitStatus\":%d,\"exitCode\":%d,\"signal\":%d,\"observedAtMs\":%llu}\n",
        shell_pid, (unsigned long long)birth_ms(&shell_identity), status,
        WIFEXITED(status) ? WEXITSTATUS(status) : -1,
        WIFSIGNALED(status) ? WTERMSIG(status) : 0,
        (unsigned long long)observed.tv_sec * 1000 + observed.tv_nsec / 1000000);
      return 0;
    }
    for (int i = 0; i < count; i++) {
      if (events[i].filter != EVFILT_READ) continue;
      ssize_t size = read(STDIN_FILENO, input + used, sizeof(input) - used - 1);
      if (size <= 0) return 0;
      used += size;
      input[used] = '\0';
      char *newline;
      while ((newline = strchr(input, '\n'))) {
        *newline = '\0';
        int held = strcmp(input, "verify-held") == 0;
        if (!held && strcmp(input, "check") != 0) return fail("command_invalid");
        // A racing table miss cannot discard the kqueue's pending physical exit.
        if (dprintf(receipt_fd, "{\"event\":\"checked\",\"verified\":%s}\n",
          verify_identity(held) ? "true" : "false") < 0) return 1;
        size_t consumed = newline - input + 1;
        memmove(input, input + consumed, used - consumed);
        used -= consumed;
        input[used] = '\0';
      }
      if (used == sizeof(input) - 1) return fail("command_invalid");
    }
  }
}
