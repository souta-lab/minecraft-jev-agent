#define _GNU_SOURCE
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>
#include <wchar.h>
#include <sys/uio.h>
#include <sys/stat.h>
#include <sys/un.h>
#ifdef __linux__
#include <linux/socket.h>
#endif

typedef int (*connect_fn)(int, const struct sockaddr *, socklen_t);
typedef ssize_t (*sendto_fn)(int, const void *, size_t, int, const struct sockaddr *, socklen_t);
typedef ssize_t (*sendmsg_fn)(int, const struct msghdr *, int);
typedef ssize_t (*send_fn)(int, const void *, size_t, int);
typedef ssize_t (*write_fn)(int, const void *, size_t);
typedef ssize_t (*writev_fn)(int, const struct iovec *, int);
typedef int (*getpeername_fn)(int, struct sockaddr *, socklen_t *);
typedef int (*getsockopt_fn)(int, int, int, void *, socklen_t *);
typedef int (*sendmmsg_fn)(int, struct mmsghdr *, unsigned int, int);

static connect_fn next_connect;
static sendto_fn next_sendto;
static sendmsg_fn next_sendmsg;
static send_fn next_send;
static write_fn next_write;
static writev_fn next_writev;
static getpeername_fn next_getpeername;
static getsockopt_fn next_getsockopt;
static sendmmsg_fn next_sendmmsg;
static int audit_fd = -1;
static const char *tool_sha;
static const char *source_sha;
static const char *library_sha;
static const char *policy_sha;

static uint64_t monotonic_ns(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
  return ((uint64_t)ts.tv_sec * 1000000000ULL) + (uint64_t)ts.tv_nsec;
}

static void utc_now(char out[32]) {
  struct timespec ts;
  struct tm tm;
  if (clock_gettime(CLOCK_REALTIME, &ts) != 0 || gmtime_r(&ts.tv_sec, &tm) == NULL) {
    memcpy(out, "unknown", sizeof("unknown"));
    return;
  }
  (void)strftime(out, 24, "%Y-%m-%dT%H:%M:%S", &tm);
  size_t used = strlen(out);
  (void)snprintf(out + used, 32 - used, ".%09ldZ", ts.tv_nsec);
}

static void json_string(char *out, size_t cap, const char *value) {
  size_t used = 0;
  if (cap == 0) return;
  out[used++] = '"';
  if (value != NULL) {
    for (const unsigned char *p = (const unsigned char *)value; *p != '\0' && used + 2 < cap; ++p) {
      if (*p == '"' || *p == '\\') {
        out[used++] = '\\';
        out[used++] = (char)*p;
      } else if (*p >= 0x20) {
        out[used++] = (char)*p;
      }
    }
  }
  out[used++] = '"';
  out[used] = '\0';
}

static void fail_stop(void) {
  static const char message[] = "vtr-egress-guard: audit write failed; process stopped\n";
  (void)syscall(SYS_write, STDERR_FILENO, message, sizeof(message) - 1);
  (void)syscall(SYS_exit_group, 126);
  __builtin_unreachable();
}

static int audit_line(const char *event, const char *operation, int family,
                      const char *endpoint, const char *reason) {
  if (audit_fd < 0) return 0;
  char utc[32];
  char endpoint_json[512];
  char reason_json[256];
  utc_now(utc);
  json_string(endpoint_json, sizeof(endpoint_json), endpoint);
  json_string(reason_json, sizeof(reason_json), reason);

  char row[2048];
  int length = snprintf(
      row, sizeof(row),
      "{\"schema\":\"vtr-no-llm-egress-audit/v1\",\"event\":\"%s\",\"utc\":\"%s\",\"monotonicClock\":\"CLOCK_MONOTONIC\",\"monotonicNs\":\"%llu\",\"pid\":%ld,\"tid\":%ld,\"operation\":\"%s\",\"family\":%d,\"endpoint\":%s,\"reason\":%s,\"toolSha256\":\"%s\",\"sourceSha256\":\"%s\",\"librarySha256\":\"%s\",\"policySha256\":\"%s\"}\n",
      event, utc, (unsigned long long)monotonic_ns(), (long)getpid(),
      (long)syscall(SYS_gettid), operation != NULL ? operation : "startup",
      family, endpoint_json, reason_json, tool_sha != NULL ? tool_sha : "unknown",
      source_sha != NULL ? source_sha : "unknown",
      library_sha != NULL ? library_sha : "unknown",
      policy_sha != NULL ? policy_sha : "unknown");
  if (length <= 0 || (size_t)length >= sizeof(row)) return 0;
  /* A single O_APPEND write is one record; use the syscall to avoid interposition recursion. */
  if (syscall(SYS_write, audit_fd, row, (size_t)length) != length) return 0;
  if (syscall(SYS_fdatasync, audit_fd) != 0) return 0;
  return 1;
}

static int check_destination(const struct sockaddr *addr, socklen_t length,
                             char endpoint[384], int *family_out) {
  if (family_out != NULL) *family_out = addr != NULL && length >= sizeof(sa_family_t) ? addr->sa_family : -1;
  if (addr == NULL || length < sizeof(sa_family_t)) {
    (void)snprintf(endpoint, 384, "<missing-or-short-sockaddr>");
    return 0;
  }

  if (addr->sa_family == AF_UNIX) {
    (void)snprintf(endpoint, 384, "unix");
    return 1;
  }

  if (addr->sa_family == AF_INET) {
    if (length < sizeof(struct sockaddr_in)) {
      (void)snprintf(endpoint, 384, "<short-af-inet-sockaddr>");
      return 0;
    }
    const struct sockaddr_in *sin = (const struct sockaddr_in *)addr;
    char ip[INET_ADDRSTRLEN] = "?";
    (void)inet_ntop(AF_INET, &sin->sin_addr, ip, sizeof(ip));
    (void)snprintf(endpoint, 384, "%s:%u", ip, (unsigned)ntohs(sin->sin_port));
    return (ntohl(sin->sin_addr.s_addr) & 0xff000000U) == 0x7f000000U;
  }

  if (addr->sa_family == AF_INET6) {
    if (length < sizeof(struct sockaddr_in6)) {
      (void)snprintf(endpoint, 384, "<short-af-inet6-sockaddr>");
      return 0;
    }
    const struct sockaddr_in6 *sin6 = (const struct sockaddr_in6 *)addr;
    char ip[INET6_ADDRSTRLEN] = "?";
    (void)inet_ntop(AF_INET6, &sin6->sin6_addr, ip, sizeof(ip));
    if (sin6->sin6_scope_id != 0)
      (void)snprintf(endpoint, 384, "[%s%%%u]:%u", ip, sin6->sin6_scope_id,
                     (unsigned)ntohs(sin6->sin6_port));
    else
      (void)snprintf(endpoint, 384, "[%s]:%u", ip, (unsigned)ntohs(sin6->sin6_port));
    return IN6_IS_ADDR_LOOPBACK(&sin6->sin6_addr);
  }

  (void)snprintf(endpoint, 384, "<address-family-%d>", addr->sa_family);
  return 0;
}

static int check_peer(int fd, char endpoint[384], int *family_out) {
  struct sockaddr_storage peer;
  socklen_t peer_len = sizeof(peer);
  memset(&peer, 0, sizeof(peer));
  if (next_getpeername == NULL || next_getpeername(fd, (struct sockaddr *)&peer, &peer_len) != 0) {
    int domain = -1;
    socklen_t domain_len = sizeof(domain);
    if (next_getsockopt != NULL
        && next_getsockopt(fd, SOL_SOCKET, SO_DOMAIN, &domain, &domain_len) == 0) {
      if (family_out != NULL) *family_out = domain;
      (void)snprintf(endpoint, 384, "<unconnected-socket-family-%d>", domain);
      /* A destination-free send on an unconnected IP socket cannot select an external peer. */
      return domain == AF_UNIX || domain == AF_INET || domain == AF_INET6;
    }
    /* Non-socket descriptors (pipes, terminal, files) do not emit IP packets. */
    if (family_out != NULL) *family_out = -1;
    (void)snprintf(endpoint, 384, "<no-connected-peer>");
    return 1;
  }
  return check_destination((const struct sockaddr *)&peer, peer_len, endpoint, family_out);
}

static ssize_t deny(const char *operation, int family, const char *endpoint) {
  if (!audit_line("blocked_egress", operation, family, endpoint, "non-loopback-or-unsupported-destination")) fail_stop();
  errno = EACCES;
  return -1;
}

static int deny_connect(const char *operation, int family, const char *endpoint) {
  if (!audit_line("blocked_egress", operation, family, endpoint, "non-loopback-or-unsupported-destination")) fail_stop();
  errno = EACCES;
  return -1;
}

__attribute__((constructor)) static void guard_init(void) {
  next_connect = (connect_fn)dlsym(RTLD_NEXT, "connect");
  next_sendto = (sendto_fn)dlsym(RTLD_NEXT, "sendto");
  next_sendmsg = (sendmsg_fn)dlsym(RTLD_NEXT, "sendmsg");
  next_send = (send_fn)dlsym(RTLD_NEXT, "send");
  next_write = (write_fn)dlsym(RTLD_NEXT, "write");
  next_writev = (writev_fn)dlsym(RTLD_NEXT, "writev");
  next_getpeername = (getpeername_fn)dlsym(RTLD_NEXT, "getpeername");
  next_getsockopt = (getsockopt_fn)dlsym(RTLD_NEXT, "getsockopt");
  next_sendmmsg = (sendmmsg_fn)dlsym(RTLD_NEXT, "sendmmsg");

  const char *fd_text = getenv("VTR_EGRESS_AUDIT_FD");
  if (fd_text != NULL) {
    char *end = NULL;
    long parsed = strtol(fd_text, &end, 10);
    if (end != fd_text && *end == '\0' && parsed >= 0 && parsed <= INT32_MAX) {
      int flags = fcntl((int)parsed, F_GETFL);
      struct stat statbuf;
      if (flags >= 0 && (flags & O_APPEND) != 0 && (flags & O_ACCMODE) != O_RDONLY
          && fstat((int)parsed, &statbuf) == 0 && S_ISREG(statbuf.st_mode))
        audit_fd = (int)parsed;
    }
  }
  tool_sha = getenv("VTR_EGRESS_TOOL_SHA256");
  source_sha = getenv("VTR_EGRESS_SOURCE_SHA256");
  library_sha = getenv("VTR_EGRESS_LIBRARY_SHA256");
  policy_sha = getenv("VTR_EGRESS_POLICY_SHA256");
  int hooks_ready = next_connect != NULL && next_sendto != NULL && next_sendmsg != NULL
      && next_send != NULL && next_write != NULL && next_writev != NULL
      && next_getpeername != NULL && next_getsockopt != NULL && next_sendmmsg != NULL;
  const char *load_reason = audit_fd < 0 ? "audit-fd-unavailable"
      : (hooks_ready ? "preload-active" : "hook-resolution-failed");
  if (!audit_line("guard_loaded", "startup", -1, "", load_reason)) fail_stop();
  if (!hooks_ready) fail_stop();
}

int connect(int fd, const struct sockaddr *addr, socklen_t length) {
  int family = -1;
  char endpoint[384];
  if (!check_destination(addr, length, endpoint, &family))
    return deny_connect("connect", family, endpoint);
  if (next_connect == NULL) { errno = ENOSYS; return -1; }
  return next_connect(fd, addr, length);
}

ssize_t sendto(int fd, const void *buf, size_t length, int flags,
               const struct sockaddr *dest, socklen_t dest_len) {
  char endpoint[384];
  int family = -1;
  if (dest != NULL) {
    if (!check_destination(dest, dest_len, endpoint, &family)) return deny("sendto", family, endpoint);
  } else if (!check_peer(fd, endpoint, &family)) {
    return deny("sendto", family, endpoint);
  }
  if (next_sendto == NULL) { errno = ENOSYS; return -1; }
  return next_sendto(fd, buf, length, flags, dest, dest_len);
}

ssize_t sendmsg(int fd, const struct msghdr *msg, int flags) {
  char endpoint[384];
  int family = -1;
  if (msg != NULL && msg->msg_name != NULL) {
    if (!check_destination((const struct sockaddr *)msg->msg_name, msg->msg_namelen, endpoint, &family))
      return deny("sendmsg", family, endpoint);
  } else if (!check_peer(fd, endpoint, &family)) {
    return deny("sendmsg", family, endpoint);
  }
  if (next_sendmsg == NULL) { errno = ENOSYS; return -1; }
  return next_sendmsg(fd, msg, flags);
}

ssize_t send(int fd, const void *buf, size_t length, int flags) {
  char endpoint[384];
  int family = -1;
  if (!check_peer(fd, endpoint, &family)) return deny("send", family, endpoint);
  if (next_send == NULL) { errno = ENOSYS; return -1; }
  return next_send(fd, buf, length, flags);
}

ssize_t write(int fd, const void *buf, size_t length) {
  char endpoint[384];
  int family = -1;
  if (!check_peer(fd, endpoint, &family)) return deny("write", family, endpoint);
  if (next_write == NULL) { errno = ENOSYS; return -1; }
  return next_write(fd, buf, length);
}

ssize_t writev(int fd, const struct iovec *iov, int iovcnt) {
  char endpoint[384];
  int family = -1;
  if (!check_peer(fd, endpoint, &family)) return deny("writev", family, endpoint);
  if (next_writev == NULL) { errno = ENOSYS; return -1; }
  return next_writev(fd, iov, iovcnt);
}

int sendmmsg(int fd, struct mmsghdr *messages, unsigned int count, int flags) {
  if (messages == NULL) { errno = EFAULT; return -1; }
  for (unsigned int i = 0; i < count; ++i) {
    struct msghdr *msg = &messages[i].msg_hdr;
    char endpoint[384];
    int family = -1;
    int allowed = msg->msg_name != NULL
        ? check_destination((const struct sockaddr *)msg->msg_name, msg->msg_namelen, endpoint, &family)
        : check_peer(fd, endpoint, &family);
    if (!allowed) return (int)deny("sendmmsg", family, endpoint);
  }
  if (next_sendmmsg == NULL) { errno = ENOSYS; return -1; }
  return next_sendmmsg(fd, messages, count, flags);
}
