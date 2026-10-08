#define _GNU_SOURCE
#ifdef __APPLE__
#include <sys/event.h>
#else
#include <sys/epoll.h>
#include <sys/eventfd.h>
#endif
#include <sys/socket.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>
#include <termios.h>
#include <time.h>
#include <fcntl.h>
#include <sys/file.h>

// The thread reports readiness only; JS owns every application byte.
struct fd_loop {
    int epoll, wake, notify;
    pthread_t thread;
    atomic_int stop;
    atomic_uint_fast64_t waits, events;
};
struct notification { uint32_t token, events; };

static void *run(void *context) {
    struct fd_loop *loop = context;
#ifdef __APPLE__
    pthread_setname_np("corgi-fd-ready");
    struct kevent events[64];
#else
    pthread_setname_np(pthread_self(), "corgi-fd-ready");
    struct epoll_event events[64];
#endif
    while (!atomic_load(&loop->stop)) {
        atomic_fetch_add(&loop->waits, 1);
#ifdef __APPLE__
        int count = kevent(loop->epoll, NULL, 0, events, 64, NULL);
#else
        int count = epoll_wait(loop->epoll, events, 64, -1);
#endif
        if (count < 0) { if (errno == EINTR) continue; break; }
        for (int i = 0; i < count; i++) {
#ifdef __APPLE__
            uint32_t token = (uint32_t)(uintptr_t)events[i].udata;
            uint32_t ready = (events[i].filter == EVFILT_READ ? 1 : 4) |
                (events[i].flags & EV_EOF ? 16 : 0) | (events[i].flags & EV_ERROR ? 8 : 0);
#else
            uint32_t token = events[i].data.u32, ready = events[i].events;
#endif
            if (!token || atomic_load(&loop->stop)) return NULL;
            atomic_fetch_add(&loop->events, 1);
            struct notification event = {token, ready};
            const char *data = (const char *)&event;
            size_t offset = 0;
            while (offset < sizeof(event)) {
                ssize_t n = send(loop->notify, data + offset, sizeof(event) - offset, MSG_NOSIGNAL);
                if (n < 0 && errno == EINTR) continue;
                if (n <= 0) return NULL;
                offset += n;
            }
        }
    }
    return NULL;
}

void *fd_loop_new(int *receiver) {
    struct fd_loop *loop = calloc(1, sizeof(*loop));
    if (!loop) return NULL;
    loop->epoll = loop->wake = loop->notify = -1;
    int pair[2] = {-1, -1};
#ifdef __APPLE__
    loop->epoll = kqueue();
    if (loop->epoll < 0 || socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) goto fail;
    fcntl(loop->epoll, F_SETFD, FD_CLOEXEC);
    fcntl(pair[0], F_SETFD, FD_CLOEXEC); fcntl(pair[1], F_SETFD, FD_CLOEXEC);
    struct kevent event;
    EV_SET(&event, 0, EVFILT_USER, EV_ADD | EV_CLEAR, 0, 0, NULL);
    if (kevent(loop->epoll, &event, 1, NULL, 0, NULL)) goto fail;
#else
    loop->epoll = epoll_create1(EPOLL_CLOEXEC);
    loop->wake = eventfd(0, EFD_CLOEXEC);
    if (loop->epoll < 0 || loop->wake < 0 || socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)) goto fail;
    struct epoll_event event = {.events = EPOLLIN, .data.u32 = 0};
    if (epoll_ctl(loop->epoll, EPOLL_CTL_ADD, loop->wake, &event)) goto fail;
#endif
    loop->notify = pair[1];
    if (pthread_create(&loop->thread, NULL, run, loop)) goto fail;
    *receiver = pair[0];
    return loop;
fail:
    if (pair[0] >= 0) close(pair[0]);
    if (pair[1] >= 0) close(pair[1]);
    if (loop->epoll >= 0) close(loop->epoll);
    if (loop->wake >= 0) close(loop->wake);
    free(loop);
    return NULL;
}

int fd_loop_arm(void *context, int fd, uint32_t token, uint32_t interests) {
    struct fd_loop *loop = context;
#ifdef __APPLE__
    const int filters[] = {EVFILT_READ, EVFILT_WRITE};
    const unsigned bits[] = {1, 4};
    for (int i = 0; i < 2; i++) {
        struct kevent event;
        int wanted = (interests & bits[i]) != 0;
        EV_SET(&event, fd, filters[i], wanted ? EV_ADD | EV_ONESHOT : EV_DELETE, 0, 0, (void *)(uintptr_t)token);
        if (kevent(loop->epoll, &event, 1, NULL, 0, NULL) && !(errno == ENOENT && !wanted)) return -errno;
    }
    return 0;
#else
    if (!interests) {
        if (epoll_ctl(loop->epoll, EPOLL_CTL_DEL, fd, NULL) && errno != ENOENT) return -errno;
        return 0;
    }
    struct epoll_event event = {.events = interests | EPOLLONESHOT, .data.u32 = token};
    if (!epoll_ctl(loop->epoll, EPOLL_CTL_MOD, fd, &event)) return 0;
    if (errno != ENOENT) return -errno;
    return epoll_ctl(loop->epoll, EPOLL_CTL_ADD, fd, &event) ? -errno : 0;
#endif
}

void fd_loop_stats(void *context, uint64_t *out) {
    struct fd_loop *loop = context;
    out[0] = atomic_load(&loop->waits);
    out[1] = atomic_load(&loop->events);
}

void fd_loop_free(void *context) {
    struct fd_loop *loop = context;
    atomic_store(&loop->stop, 1);
#ifdef __APPLE__
    struct kevent event;
    EV_SET(&event, 0, EVFILT_USER, 0, NOTE_TRIGGER, 0, NULL);
    while (kevent(loop->epoll, &event, 1, NULL, 0, NULL) < 0 && errno == EINTR) {}
#else
    uint64_t one = 1;
    while (write(loop->wake, &one, sizeof(one)) < 0 && errno == EINTR) {}
#endif
    // Also releases a reporter blocked by an unread notification socket.
    shutdown(loop->notify, SHUT_RDWR);
    pthread_join(loop->thread, NULL);
    close(loop->notify);
    if (loop->wake >= 0) close(loop->wake);
    close(loop->epoll);
    free(loop);
}

int fd_raw(int fd) {
    struct termios attr;
    if (tcgetattr(fd, &attr)) return -errno;
    cfmakeraw(&attr);
    return tcsetattr(fd, TCSANOW, &attr) ? -errno : 0;
}

uint64_t fd_cpu_ns(void) {
    struct timespec value;
    clock_gettime(CLOCK_PROCESS_CPUTIME_ID, &value);
    return (uint64_t)value.tv_sec * 1000000000ULL + value.tv_nsec;
}

int fd_cloexec(int fd) { return fcntl(fd, F_SETFD, FD_CLOEXEC); }
int fd_try_lock(int fd) { return flock(fd, LOCK_EX | LOCK_NB) ? -errno : 0; }
