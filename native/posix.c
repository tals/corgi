#define _GNU_SOURCE
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdint.h>
#include <signal.h>
#include <sys/wait.h>
#include <string.h>
#include <stdlib.h>
#include <dirent.h>
#include <limits.h>
#include <poll.h>
#include <pwd.h>
#ifdef __APPLE__
#include <util.h>
#else
#include <pty.h>
#endif
// Fixed-size ABI: no JS knowledge of platform-specific ancillary/termios layouts.
int probe_pair(int *fds) { if(socketpair(AF_UNIX, SOCK_STREAM, 0, fds)) return -1; for(int i=0;i<2;i++) fcntl(fds[i],F_SETFD,FD_CLOEXEC); return 0; }
int probe_pty(int *fds) {
    struct winsize ws = {.ws_row=40, .ws_col=120};
    if (openpty(&fds[0], &fds[1], 0, 0, &ws)) return -1;
    for (int i=0;i<2;i++) fcntl(fds[i], F_SETFD, FD_CLOEXEC);
    fcntl(fds[0], F_SETFL, O_NONBLOCK);
    return 0;
}
int probe_nonblock(int fd) { return fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK); }
int probe_close(int fd) { return close(fd); }
int probe_read(int fd, void *data, int cap) {
    int n=read(fd,data,cap);
    return n<0 ? -errno : n;
}
int probe_peek(int fd, void *data, int cap) { int n=recv(fd,data,cap,MSG_PEEK);return n<0?-errno:n; }
int probe_isatty(int fd) { return isatty(fd); }
int probe_write(int fd, const void *data, int len) {
    int n=write(fd,data,len);
    return n<0 ? -errno : n;
}
int probe_resize(int fd, int cols, int rows) {
    struct winsize ws={.ws_row=rows,.ws_col=cols};
    return ioctl(fd,TIOCSWINSZ,&ws);
}
/* Columns, rows, then the window's pixels across and down (0 when unknown). */
int probe_winsize_pixels(int fd, uint16_t *size) {
    struct winsize ws;
    if(ioctl(fd,TIOCGWINSZ,&ws)) return -errno;
    size[0]=ws.ws_col;size[1]=ws.ws_row;size[2]=ws.ws_xpixel;size[3]=ws.ws_ypixel;return 0;
}
int probe_winsize(int fd, uint16_t *size) {
    struct winsize ws;
    if(ioctl(fd,TIOCGWINSZ,&ws)) return -errno;
    size[0]=ws.ws_col;size[1]=ws.ws_row;return 0;
}
// Test fixture only: children execute async-signal-safe libc calls, never JS.
int probe_fixture_children(int *pids) {
    pid_t exited=fork();
    if(exited==0)_exit(0);
    if(exited<0)return -errno;
    siginfo_t status;
    if(waitid(P_PID,exited,&status,WEXITED|WNOWAIT))return -errno;
    pid_t running=fork();
    if(running==0){for(;;)pause();}
    if(running<0){waitpid(exited,0,0);return -errno;}
    pids[0]=exited;pids[1]=running;return 0;
}
int probe_wait_child(int pid) { return waitpid(pid,0,0); }
int probe_fixture_exit(int code) {
    pid_t pid=fork();
    if(pid==0)_exit(code);
    if(pid<0)return -errno;
    siginfo_t status;
    if(waitid(P_PID,pid,&status,WEXITED|WNOWAIT))return -errno;
    return pid;
}
int probe_foreground(int fd) { return tcgetpgrp(fd); }
int probe_getpgrp(void) { return getpgrp(); }
int probe_dup_above(int fd, int minimum) { return fcntl(fd,F_DUPFD_CLOEXEC,minimum); }
// The account's login shell, from Directory Services, NSS or /etc/passwd.
int probe_login_shell(char *buffer, int cap) {
    struct passwd *user=getpwuid(getuid());
    if(!user||!user->pw_shell) return -ENOENT;
    size_t len=strlen(user->pw_shell);
    if(len>=(size_t)cap) return -ENAMETOOLONG;
    memcpy(buffer,user->pw_shell,len);
    return (int)len;
}
int probe_send(int sock, const int *fds, int count) {
    if (count<1 || count>64) return -1;
    char payload='F';
    struct iovec io={.iov_base=&payload,.iov_len=1};
    union { struct cmsghdr align; char bytes[CMSG_SPACE(64*sizeof(int))]; } control={0};
    struct msghdr msg={.msg_iov=&io,.msg_iovlen=1,.msg_control=control.bytes,.msg_controllen=CMSG_SPACE(count*sizeof(int))};
    struct cmsghdr *header=CMSG_FIRSTHDR(&msg);
    header->cmsg_level=SOL_SOCKET;header->cmsg_type=SCM_RIGHTS;header->cmsg_len=CMSG_LEN(count*sizeof(int));
    memcpy(CMSG_DATA(header),fds,count*sizeof(int));
    return sendmsg(sock,&msg,MSG_NOSIGNAL)==1 ? 0 : -errno;
}
int probe_recv(int sock, int *fds, int cap) {
    char payload;
    struct iovec io={.iov_base=&payload,.iov_len=1};
    union { struct cmsghdr align; char bytes[CMSG_SPACE(64*sizeof(int))]; } control={0};
    struct msghdr msg={.msg_iov=&io,.msg_iovlen=1,.msg_control=control.bytes,.msg_controllen=sizeof(control.bytes)};
    if(recvmsg(sock,&msg,0)!=1) return -errno;
    if(msg.msg_flags & MSG_CTRUNC) return -1;
    struct cmsghdr *header=CMSG_FIRSTHDR(&msg);
    if(!header || header->cmsg_level!=SOL_SOCKET || header->cmsg_type!=SCM_RIGHTS) return -1;
    int count=(header->cmsg_len-CMSG_LEN(0))/sizeof(int);
    int *received=(int*)CMSG_DATA(header);
    if(count>cap) { for(int i=0;i<count;i++) close(received[i]); return -1; }
    memcpy(fds,received,count*sizeof(int));
    for(int i=0;i<count;i++) fcntl(fds[i],F_SETFD,FD_CLOEXEC);
    return count;
}
#include <sys/un.h>
int probe_connect(const char *path) {
    int fd=socket(AF_UNIX,SOCK_STREAM,0);
    if(fd<0)return -errno;
    fcntl(fd,F_SETFD,FD_CLOEXEC);
    struct sockaddr_un addr={.sun_family=AF_UNIX};
    if(strlen(path)>=sizeof(addr.sun_path)){close(fd);return -ENAMETOOLONG;}
    strcpy(addr.sun_path,path);
    if(connect(fd,(struct sockaddr*)&addr,sizeof(addr))){int e=errno;close(fd);return -e;}
    return fd;
}
int probe_listen(const char *path) {
    int fd=socket(AF_UNIX,SOCK_STREAM,0);
    if(fd<0) return -errno;
    fcntl(fd,F_SETFD,FD_CLOEXEC);
    struct sockaddr_un addr={.sun_family=AF_UNIX};
    if(strlen(path)>=sizeof(addr.sun_path)) { close(fd); return -1; }
    strcpy(addr.sun_path,path);
    if(bind(fd,(struct sockaddr*)&addr,sizeof(addr)) || listen(fd,8)) { int e=errno; close(fd); return -e; }
    return fd;
}
int probe_accept(int fd) { int peer=accept(fd,0,0); if(peer>=0) fcntl(peer,F_SETFD,FD_CLOEXEC); return peer; }
int probe_pipe(int *fds) { if(pipe(fds)) return -errno; for(int i=0;i<2;i++) fcntl(fds[i],F_SETFD,FD_CLOEXEC); return 0; }
#include <sys/resource.h>
#include <stdio.h>
#ifdef __APPLE__
#include <mach/mach.h>
#endif
long probe_rss_kib(void) {
#ifdef __APPLE__
    mach_task_basic_info_data_t info;
    mach_msg_type_number_t count=MACH_TASK_BASIC_INFO_COUNT;
    if(task_info(mach_task_self(),MACH_TASK_BASIC_INFO,(task_info_t)&info,&count)!=KERN_SUCCESS) return -1;
    return info.resident_size/1024;
#else
    // ru_maxrss can retain the spawning parent's pre-exec peak on Linux.
    FILE *file=fopen("/proc/self/statm","r");
    if(!file) return -1;
    unsigned long virtual_pages, resident_pages;
    int count=fscanf(file,"%lu %lu",&virtual_pages,&resident_pages);
    fclose(file);
    return count==2 ? (long)(resident_pages*(unsigned long)sysconf(_SC_PAGESIZE)/1024) : -1;
#endif
}

#ifdef __APPLE__
#include <libproc.h>
#include <sys/sysctl.h>
#include <mach/mach_time.h>
#endif
// Process-group inventory; the provider policy stays in TypeScript.
int probe_group_pids(int pgid, int *pids, int cap) {
#ifdef __APPLE__
    int bytes=proc_listpids(PROC_PGRP_ONLY,(uint32_t)pgid,pids,cap*(int)sizeof(int));
    return bytes<0?-errno:bytes/(int)sizeof(int);
#elif defined(__linux__)
    if (pgid <= 0 || cap < 0) return -EINVAL;
    DIR *directory = opendir("/proc");
    if (!directory) return -errno;
    int count = 0;
    struct dirent *entry;
    while (count < cap && (entry = readdir(directory))) {
        char *end;
        long pid = strtol(entry->d_name, &end, 10);
        if (*end || pid <= 0 || pid > INT_MAX) continue;
        if (getpgid((pid_t)pid) == pgid)
            pids[count++] = (int)pid;
    }
    closedir(directory);
    return count;
#else
    (void)pgid;(void)pids;(void)cap;return -ENOSYS;
#endif
}
// Numeric output: parent PID, process group, start microseconds, CPU ns, footprint.
int probe_process_job(int pid, int *values) {
#ifdef __APPLE__
    struct proc_bsdinfo bsd;
    if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&bsd,sizeof(bsd))!=sizeof(bsd)) return -1;
    values[0]=bsd.pbi_ppid; values[1]=bsd.pbi_pgid; values[2]=bsd.e_tpgid;
    return 0;
#else
    (void)pid;(void)values;return -ENOSYS;
#endif
}
int64_t probe_process_args(int pid, char *buffer, size_t cap) {
#ifdef __APPLE__
    int mib[]={CTL_KERN,KERN_PROCARGS2,pid};
    size_t size=cap;
    if(sysctl(mib,3,buffer,&size,0,0))return -1;
    return (int64_t)size;
#else
    (void)pid;(void)buffer;(void)cap;return -ENOSYS;
#endif
}
int probe_macos_process(int pid, uint64_t *values, char *cwd, char *exe, char *args, int cap) {
#ifdef __APPLE__
    int flags=0;
    struct proc_bsdinfo bsd;
    if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&bsd,sizeof(bsd))==sizeof(bsd)) {
        values[0]=bsd.pbi_ppid; values[1]=bsd.pbi_pgid;
        values[2]=bsd.pbi_start_tvsec*1000000ULL+bsd.pbi_start_tvusec; flags|=1;
    }
    struct rusage_info_v2 usage;
    mach_timebase_info_data_t timebase;
    if(!proc_pid_rusage(pid,RUSAGE_INFO_V2,(rusage_info_t*)&usage) && !mach_timebase_info(&timebase)) {
        values[3]=(uint64_t)((__uint128_t)(usage.ri_user_time+usage.ri_system_time)*timebase.numer/timebase.denom);
        values[4]=usage.ri_phys_footprint; flags|=2;
    }
    struct proc_vnodepathinfo path;
    if(proc_pidinfo(pid,PROC_PIDVNODEPATHINFO,0,&path,sizeof(path))==sizeof(path)) {
        size_t len=strlen(path.pvi_cdir.vip_path);
        if(len<(size_t)cap) { memcpy(cwd,path.pvi_cdir.vip_path,len+1); flags|=4; }
    }
    if(proc_pidpath(pid,exe,cap>PROC_PIDPATHINFO_MAXSIZE ? PROC_PIDPATHINFO_MAXSIZE : cap)>0) flags|=8;
    int mib[]={CTL_KERN,KERN_PROCARGS2,pid}; size_t size=cap;
    if(!sysctl(mib,3,args,&size,0,0)) flags|=16;
    return flags;
#else
    (void)pid;(void)values;(void)cwd;(void)exe;(void)args;(void)cap;
    return 0;
#endif
}
/* Whether fd takes output now, waiting up to `ms` (0 polls once). */
int probe_writable(int fd, int ms) {
    struct pollfd p = { .fd = fd, .events = POLLOUT, .revents = 0 };
    return poll(&p, 1, ms) > 0 && (p.revents & POLLOUT) != 0;
}
